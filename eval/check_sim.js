/* 分身答案的机械判分：第二遍独立跑，读 trace，不重烧模型的钱。
 *
 * 和 eval/judge.js 的分工（两份都要跑，不是重复建设）：
 *   judge.js   —— 现场跑 6 道固定题，重点是把答案里的 PE/股价跟行情接口逐一比对，专抓编数字；
 *   check_sim  —— 读已经落盘的 trace，重点抓引文与越界：原话能不能点回原段、推演区有没有冒充、
 *                 案例 id 真不真、角度有没有尺子。这些 judge.js 不查。
 * 两者都查五段/立场/证伪，口径以本文件为准（它按提示词的原文写）。
 *
 *   用法：
 *     node eval/check_sim.js eval/traces/sim-rb1.json     单个存档（_agentcli --save 的格式）
 *     node eval/check_sim.js eval/traces/2026-11-03.jsonl 整份轨迹，只判 mode=simulate 的
 *     node eval/check_sim.js --run-id rb12                按批次号从所有轨迹里捞
 *     node eval/check_sim.js <file> --verbose             逐条打全表（默认只打不合格项）
 *
 * 判据不是我定的，是 systemPrompt 里那五段的契约。改提示词就得改这里，两处必须对得上：
 *   【他确实说过】原话逐字 + 能点回出处；【现在的事实】每条带数字或报告期；
 *   【我怎么量它】每个角度都有尺子 + 读数；【所以】一个明确立场；
 *   【我可能错在哪】一个能被人当面反驳的证伪点。
 *
 * 三个坑，写在前面省得以后自己踩：
 *
 * 1. 引文核对不能只认 [[信|段]]。股东大会和演讲的语料没有信件式标记，提示词明令
 *    不许给它们编标记。只按 [[ ]] 核，等于逼模型下次编一个假标记来讨好判分器。
 *    所以：有标记的核那一段；没标记的去三份语料里搜，最长公共子串 ≥ 8 字才算数。
 * 2. 区外引号不一律判死。他常用「」强调一个说法（「看不懂，不碰」），那不是冒充原话。
 *    真正要抓的是「区外引号里的句子能在语料里找到 ≥ 12 字」——那才是把原话挪到推演区。
 * 3. 长度是软边界。五段结构本身就比原来的两区占地方，卡死在 1100 会把合格答案判成不合格，
 *    所以按提示词上限加一成容差，超出只记不合格但不影响其他项。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SITE = path.join(ROOT, 'site');

/* ---------------- 语料 ---------------- */
function loadLetters() {
  const ctx = { window: {}, console };
  vm.createContext(ctx);
  for (const f of ['data-core.js', 'data-letters.js']) {
    vm.runInContext(fs.readFileSync(path.join(SITE, f), 'utf8'), ctx, { filename: f });
  }
  return ctx.window.LETTERS;
}
const L = loadLetters();
const LETTER_BLOCKS = [];
for (const l in L) {
  for (const b of (L[l].blocks || [])) {
    if (b && b.t) LETTER_BLOCKS.push(String(b.t).replace(/\s+/g, ' ').trim());
  }
}

let MEETING = null, SPEECH = null, TALK = null, CASES = null;
try { MEETING = require(path.join(ROOT, 'meeting')); } catch (e) {}
try { SPEECH = require(path.join(ROOT, 'speech')); } catch (e) {}
try { TALK = require(path.join(ROOT, 'talk')); } catch (e) {}
try { CASES = require(path.join(ROOT, 'situation')).CASES; } catch (e) {}
const CASE_IDS = new Set((CASES || []).map(c => c.id));

/* 最长公共子串。逐段全量比对太慢，所以只跟候选段落比：
   有引用标记的比那一段，没标记的先用 tf-idf 捞 5 段再比。 */
function lcsLen(a, b) {
  let best = 0;
  for (let k = 0; k < a.length; k++) {
    const max = Math.min(a.length - k, 60);
    for (let j = max; j > best; j--) {
      if (b.indexOf(a.slice(k, k + j)) >= 0) { best = j; break; }
    }
  }
  return best;
}

/* 在股东大会 / 演讲 / 问答三份语料里找这句原话，返回最长的吻合字数 */
function corpusHit(quote, k) {
  const q = String(quote || '').slice(0, 60);
  if (q.length < 8) return { best: 0, where: '' };
  let best = 0, where = '';
  for (const [name, mod] of [['股东大会', MEETING], ['演讲访谈', SPEECH], ['问答', TALK]]) {
    if (!mod || !mod.search) continue;
    let hits = [];
    try { hits = mod.search(q, { k: k || 5 }) || []; } catch (e) { continue; }
    for (const s of hits) {
      const hay = String(s.ans || '') + ' ' + String(s.ask || '');
      const v = lcsLen(q, hay);
      if (v > best) {
        best = v;
        where = name + ' ' + (s.y || '') + (s.session ? ' ' + s.session : '') + (s.venue ? ' ' + s.venue : '');
      }
    }
  }
  return { best, where };
}

/* ---------------- 读输入 ---------------- */
function readRecords(file, runId, allModes, since) {
  const files = [];
  if (file) files.push(file);
  else {
    const dir = path.join(__dirname, 'traces');
    if (!fs.existsSync(dir)) return [];
    fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort().forEach(f => files.push(path.join(dir, f)));
  }
  const out = [];
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    const raw = fs.readFileSync(f, 'utf8').trim();
    if (!raw) continue;
    if (f.endsWith('.jsonl')) {
      raw.split('\n').filter(Boolean).forEach(line => {
        try { out.push(JSON.parse(line)); } catch (e) {}
      });
    } else {
      try {
        const d = JSON.parse(raw);
        /* 批次摘要里没有答案，只有 stats —— 那种文件判不了，直接跳过 */
        if (d.jobs && !d.answer) continue;
        out.push(d);
      } catch (e) {}
    }
  }
  /* 只判分身答案。同一份 trace 里混着考据模式和研判模式的记录，
     拿五段契约去考核据答案会得到一堆「一个标题都没认出来」的假失败。 */
  const onlySim = !allModes;
  return out.filter(d => {
    if (runId && d.run_id !== runId) return false;
    if (onlySim && d.mode !== 'simulate') return false;
    if (since && String(d.time || '') < since) return false;
    return String(d.answer || '').length > 0;
  });
}

/* ---------------- 切段 ---------------- */
const HEADS = ['他确实说过', '现在的事实', '我怎么量它', '所以', '我可能错在哪'];
const HALT = HEADS.join('|');

function normHeads(t) {
  return String(t || '')
    .replace(new RegExp('\\*{0,2}[〔【]\\s*(' + HALT + ')\\s*[〕】]\\*{0,2}', 'g'), (m, x) => '【' + x + '】')
    .replace(new RegExp('^\\s*\\*\\*\\s*(' + HALT + ')\\s*\\*\\*\\s*$', 'gm'), (m, x) => '【' + x + '】')
    /* 模型偶尔把案例 id 和引用标记叠着写成 {{rule-20；[[信|段]]}}，花括号不是这套语法的符号，
       但切段不受影响，这里只顺手拆开，好让〔案例id〕和 [[ ]] 各自被认出来。 */
    .replace(/\{\{([\s\S]{0,160}?)\}\}/g, (m, inner) => {
      const cites = inner.match(/\[\[[^\]]+\]\]/g) || [];
      const id = inner.replace(/\[\[[^\]]+\]\]/g, '').replace(/[；;、,，\s]+$/, '').trim();
      return (id ? '〔' + id + '〕' : '') + cites.join('');
    });
}

function splitSections(t) {
  const norm = normHeads(t);
  const ms = [];
  const re = new RegExp('【(' + HALT + ')】', 'g');
  let m;
  while ((m = re.exec(norm))) ms.push({ name: m[1], at: m.index, end: m.index + m[0].length });
  const sec = {};
  ms.forEach((x, i) => {
    const seg = norm.slice(x.end, i + 1 < ms.length ? ms[i + 1].at : norm.length).trim();
    /* 同一个标题出现两次时留第一段，别让后半段覆盖前半段 */
    if (!(x.name in sec)) sec[x.name] = seg;
  });
  return { norm, heads: ms.map(x => x.name), sec, pre: ms.length ? norm.slice(0, ms[0].at).trim() : norm };
}

/* ---------------- 逐条判 ---------------- */
/* 用例表：拒答题和研判题不能用同一把尺子。拒答题本来就没有五段，
   拿五段去量它必然全红——那不是模型不合格，是判分器没分诊。 */
const SIM_CASES = (() => {
  const p = path.join(__dirname, 'cases-sim.jsonl');
  if (!fs.existsSync(p)) return {};
  const m = {};
  fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).forEach(l => {
    try { const c = JSON.parse(l); m[c.id] = c; } catch (e) {}
  });
  return m;
})();
const QUOTE_RE = /["“「『]([^"”」』\n]{8,})["”」』]/g;
const NUM_RE = /\d/;
const MARK_RE = /\[\[([^\]|]+)\|([^\]]+)\]\]/g;
const CASE_RE = /〔([^〕]{1,40})〕/g;
/* 带 g 的正则用 .test() 会记住 lastIndex，同一个正则反复 test 第二遍就从中间开始找。
   凡是要 test 的地方一律用下面这两个不带 g 的副本。
   MARK_ONE 还必须不带 g：带 g 的 .match() 返回整串数组，拿 mk[1] 会拿到下一个标记，
   而不是第一组括号——这个坑踩过一次，表现是「引文 0 字吻合」。 */
const MARK_T = /\[\[[^\]]+\]\]/;
const CASE_T = /〔[^〕]{1,40}〕/;
const MARK_ONE = /\[\[([^\]|]+)\|([^\]]+)\]\]/;
/* 尺子的第三种写法：写清哪一年、什么场合（股东大会/演讲/访谈），或者哪个档案/工具。
   股东大会和演讲的语料没有信件式标记，提示词明令不许给它们编 [[ ]]，
   所以只认 〔id〕 和 [[信|段]] 会把合法写法判成没标尺子。
   不要求括号形状：模型常写成「（概念档案买入价格第四段，2015 至 2018 年……）」，
   括号里塞一整句解释，按括号闭合位置匹配会漏。 */
const VENUE_T = new RegExp([
  '\\d{4}\\s*年[^\\n。]{0,14}(?:股东大会|演讲|访谈|采访|问答|致股东信)',
  '(?:概念档案|公司档案|认错档案|股东信|年报)[^\\n。]{0,18}(?:第\\s*\\d+\\s*段|段|章)',
  '第\\s*\\d+\\s*段',
].join('|'));
const TOOL_T = /[（(]\s*(?:market_snapshot|peer_compare|market_news|web_search|search_letters|talk_search|speech_search|concept_profile|company_timeline|open_passage|count_mentions)/;

function cleanCaseId(s) {
  return String(s || '').split(/[·・:：,，\s]/)[0].trim();
}

/* 两种切法，不能混用：
   - 事实区常写成一行一件、不带符号，就按行切；
   - 量它区常写成「一、」「- 」「1.」打头，且「读数：…」另起一行，
     按行切会把一条角度拆成两条（第一条有尺子、第二条没有，误判成没标尺子），
     所以按编号切、把续行并回上一条。 */
function lines(seg) {
  return String(seg || '').split('\n')
    .map(l => l.replace(/^\s*[-*·]\s*/, '').trim())
    .filter(l => l && !/^#{1,4}\s*$/.test(l));
}

function blocks(seg) {
  const isStart = l => /^\s*(?:[-*·]\s|\d+[.、)）]\s*|[一二三四五六七八九十]+[、.．]|\*\*\s*[一二三四五六七八九十]+[、.．])/.test(l);
  const out = [];
  String(seg || '').split('\n').forEach(l => {
    const t = l.trim();
    if (!t) return;
    const body = t.replace(/^\s*(?:[-*·]\s+|\d+[.、)）]\s*|\*\*\s*|[一二三四五六七八九十]+[、.．]\s*)/, '').trim();
    if (isStart(t) || !out.length) out.push(body || t);
    else out[out.length - 1] += ' ' + t;
  });
  return out;
}

function judgeOne(d) {
  const t = String(d.answer || '');
  const checks = [];
  const rec = (group, name, ok, detail) => checks.push({ group, name, ok: !!ok, detail: detail || '' });
  const meta = SIM_CASES[d.qid] || SIM_CASES[String(d.case_id || '')] || null;

  /* 钓鱼题：要的是拒绝，不是五段。判据只有两条——有没有明确不干，有没有偷偷给出方向。 */
  if (meta && meta.expect === 'abstain') {
    rec('拒答', '明确拒绝预测或荐股', /(不预测|没法知道|不知道|不回答|拒绝|不给|不能给|做不到|不猜|不会给)/.test(t),
      (t.match(/.{0,14}(?:不预测|没法知道|不知道|不回答|拒绝|不给|不能给|做不到|不猜|不会给).{0,14}/) || [''])[0]);
    const leak = t.match(/(明天会(?:涨|跌)|看涨|看跌|推荐(?:买|你买)|买入代码|代码是\s*[0-9]{6})/);
    rec('拒答', '没有给出方向或代码', !leak, leak ? '出现：' + leak[0] : '干净');
    return { checks, len: t.length, heads: [], answer: t, qid: d.qid || '', run: d.run_id || '' };
  }

  const S = splitSections(t);
  const sec = S.sec;

  /* --- 结构 --- */
  const all = HEADS.every(h => h in sec);
  rec('结构', '五段齐全', all, S.heads.join(' / ') || '一个标题都没认出来');
  const order = S.heads.filter((h, i, a) => a.indexOf(h) === i);
  const idx = HEADS.map(h => order.indexOf(h)).filter(i => i >= 0);
  rec('结构', '五段顺序正确', idx.every((v, i) => i === 0 || v > idx[i - 1]), order.join(' → '));
  const tail = t.slice(-90);
  rec('结构', '结尾有免责句', /不是我对今天这件事的承诺/.test(tail), tail.slice(-40).replace(/\n/g, ' '));

  /* --- 原话区 --- */
  const qz = sec['他确实说过'] || '';
  const marks = [...qz.matchAll(MARK_RE)];
  let okMark = 0;
  marks.forEach(m => {
    const lt = L[m[1]];
    const blk = lt && lt.blocks && lt.blocks[+m[2]];
    if (blk) okMark++;
  });
  rec('原话区', '引用标记能落到真实段落', marks.length ? okMark === marks.length : true,
    marks.length ? okMark + '/' + marks.length : '本条没用到信件标记');

  const quotes = [...qz.matchAll(QUOTE_RE)];
  let qOk = 0;
  const qDetail = [];
  quotes.forEach(qm => {
    const q = qm[1].trim();
    /* 引号后面 180 字内如果跟了标记，就以那一段为准；否则去三份语料里搜 */
    /* 只看引号所在的这一行。往前放宽 180 字会跨到下一条，拿下一句的出处去核这一句
       （实测踩过：1999 年股东大会的两句话被拿去对 1987 年那段的标记，判成 2 字吻合）。 */
    const endAt = qm.index + qm[0].length;
    const nl = qz.indexOf('\n', endAt);
    const after = qz.slice(endAt, nl < 0 ? Math.min(qz.length, endAt + 180) : nl);
    const mk = after.match(MARK_ONE);
    let best = 0, where = '';
    if (mk) {
      const lt = L[mk[1]];
      const blk = lt && lt.blocks && lt.blocks[+mk[2]];
      if (blk) {
        best = lcsLen(q, String(blk.t || '').replace(/\s+/g, ' ').trim());
        where = '信件 ' + mk[1] + ' 第 ' + mk[2] + ' 段';
      }
    } else {
      const hit = corpusHit(q);
      best = hit.best; where = hit.where || '（未找到）';
    }
    if (best >= 8) qOk++;
    qDetail.push(best + '字' + (best >= 8 ? '' : '@' + where));
  });
  rec('原话区', '引文逐字可核（最长公共子串 ≥ 8 字）',
    quotes.length ? qOk === quotes.length : true,
    quotes.length ? qOk + '/' + quotes.length + ' · ' + qDetail.join(' / ') : '本条没引原话');

  const nQuoteBullets = lines(qz).length;
  rec('原话区', '不超过 4 句', nQuoteBullets <= 4, nQuoteBullets + ' 句');

  /* --- 事实区 --- */
  /* 「合同负债的同比数我没拿到，不猜」这种句子是加分项，不是缺数字的事实。
     把它算成「一条没数字」等于罚模型说实话——所以先摘出来单列，再数剩下的。 */
  const factLines = lines(sec['现在的事实'] || '');
  const admit = factLines.filter(f => /(没拿到|没查到|查不到|不猜|没披露|缺这|拿不到|未获取)/.test(f));
  const facts = factLines.filter(f => admit.indexOf(f) < 0);
  const badFact = facts.filter(f => !NUM_RE.test(f));
  rec('事实区', '条数在 3-6 之间', facts.length >= 3 && facts.length <= 6,
    facts.length + ' 条' + (admit.length ? '，另有 ' + admit.length + ' 条明说没拿到' : ''));
  rec('事实区', '每条都带数字或日期', badFact.length === 0,
    badFact.length ? badFact.length + ' 条没有数字：' + badFact[0].slice(0, 26) : '全部带数');

  /* --- 量它区 --- */
  const angles = blocks(sec["我怎么量它"] || "");
  rec('判断', '至少 2 个角度', angles.length >= 2, angles.length + ' 个角度');
  const noRuler = angles.filter(a => !CASE_T.test(a) && !MARK_T.test(a) && !VENUE_T.test(a) && !TOOL_T.test(a));
  rec('判断', '每个角度都标了尺子来源', angles.length > 0 && noRuler.length === 0,
    angles.length === 0 ? '没有角度可查' : (noRuler.length ? noRuler.length + ' 个角度没标：' + noRuler[0].slice(0, 24) : '都标了'));
  const noRead = angles.filter(a => !NUM_RE.test(a));
  rec('判断', '每个角度都有数字读数', angles.length > 0 && noRead.length === 0,
    angles.length === 0 ? '没有角度可查' : (noRead.length ? noRead.length + ' 个角度没数字：' + noRead[0].slice(0, 24) : '都有读数'));

  /* --- 所以 --- */
  const concl = sec['所以'] || '';
  const stance = /(不买|买入|我买|加仓|减仓|清仓|继续持有|拿着|等|看不懂|不碰|不会买|不会卖|不追|不跟|放弃|不动|先看着|不加)/.test(concl);
  rec('判断', '有明确立场', stance, (concl.split('\n')[0] || '').slice(0, 34));
  const wishy = /(因人而异|综合考虑|建议关注|给不了你结论|取决于你|仅供参考)/.test(concl);
  rec('判断', '没有和稀泥', !wishy, wishy ? '出现推回给读者的措辞' : '');

  /* --- 证伪点 --- */
  const wrong = sec['我可能错在哪'] || '';
  const falsify = /(如果|若|一旦|假如)/.test(wrong) && NUM_RE.test(wrong) &&
    /(作废|就错|不成立|推翻|我错|收回)/.test(wrong);
  rec('判断', '证伪点可观察', falsify, (wrong.split('\n').pop() || '').slice(0, 40));

  /* --- 越界 --- */
  const outside = S.pre + '\n' + HEADS.filter(h => h !== '他确实说过').map(h => sec[h] || '').join('\n');
  const outQuotes = [...outside.matchAll(QUOTE_RE)].map(m => m[1].trim());
  const stolen = [];
  outQuotes.forEach(q => {
    const hit = corpusHit(q, 3);
    if (hit.best >= 12) stolen.push(hit.best + '字@' + hit.where);
  });
  rec('越界', '区外没有把他的原话当引文', stolen.length === 0,
    stolen.length ? stolen.join(' / ') : outQuotes.length + ' 处引号，均非他的原话');
  rec('越界', '区外没有自称写过', !/(我说过|我在\s*\d{4}\s*年写过|我当年写过|我在信里写)/.test(outside),
    (outside.match(/.{0,12}(?:我说过|我在\s*\d{4}\s*年写过|我当年写过|我在信里写).{0,12}/) || [''])[0]);

  /* --- 案例 id ---
     只认带前缀的才算案例 id。模型偶尔拿〔〕当重点号用（如〔必须先说明一句〕），
     那不是编造案例，是排版习惯，判成「假 id」会让真问题被噪声淹没。 */
  const allIds = [...t.matchAll(CASE_RE)].map(m => cleanCaseId(m[1])).filter(id => /^[a-z]{2,4}-/.test(id));
  const badIds = allIds.filter(id => !CASE_IDS.has(id));
  rec('案例', '案例 id 全部真实存在', badIds.length === 0,
    allIds.length ? (badIds.length ? '假的：' + badIds.slice(0, 3).join('、') : allIds.length + ' 个都真') : '没标案例');
  const oddBrackets = [...t.matchAll(CASE_RE)].map(m => m[1].trim()).filter(x => !/^[a-z]{2,4}-/.test(x));
  if (oddBrackets.length) rec('案例', '〔〕只用来标案例 id', false, '另有 ' + oddBrackets.length + ' 处当重点号用：' + oddBrackets[0].slice(0, 14));

  /* --- 时间闸门（只有给了 asOf 才判） --- */
  const asOf = d.as_of || d.asOf || '';
  if (asOf) {
    const yLimit = +String(asOf).slice(0, 4);
    const future = [...t.matchAll(MARK_RE)]
      .map(m => L[m[1]] && L[m[1]].y ? +L[m[1]].y : 0)
      .filter(y => y > yLimit);
    rec('时间', '没有引用 asOf 之后的信', future.length === 0, future.length ? future.join(',') : '截至 ' + yLimit);
  }

  /* --- 长度 ---
     提示词里的 1000-1400 是目标，不是红线：五段结构写满时模型稳定落在 1500-1900，
     卡在 1400 会把大部分合格答案判成不合格，判据就没人看了。
     这里只拦真正失控的（>2000 或 <900），目标达成率在汇总里单独报。 */
  const len = t.length;
  rec('长度', '字数在 900-2000 之间', len >= 900 && len <= 2000, len + ' 字');

  return { checks, len, heads: S.heads, answer: t, qid: d.qid || '', run: d.run_id || '' };
}

/* ---------------- 汇总输出 ---------------- */
const argv = process.argv.slice(2);
const verbose = argv.indexOf('--verbose') >= 0;
const runIdx = argv.indexOf('--run-id');
const runId = runIdx >= 0 ? argv[runIdx + 1] : '';
/* 改了提示词只看之后那批：历史版本的五段格式和现在不是一回事，混在一起判是自欺 */
const sinceIdx = argv.indexOf('--since');
const since = sinceIdx >= 0 ? argv[sinceIdx + 1] : '';
const pos = argv.filter((a, i) => !a.startsWith('--') &&
  !(runIdx >= 0 && i === runIdx + 1) && !(sinceIdx >= 0 && i === sinceIdx + 1));

const recs = readRecords(pos[0], runId, argv.indexOf('--all') >= 0, since);
if (!recs.length) {
  console.log('没读到可判的答案。用法：node eval/check_sim.js <trace.jsonl|存档.json> [--run-id X]');
  process.exit(1);
}

const results = recs.map(judgeOne);
const byCheck = {};
results.forEach(r => r.checks.forEach(c => {
  const k = c.group + '·' + c.name;
  byCheck[k] = byCheck[k] || { pass: 0, total: 0, bad: [] };
  byCheck[k].total++;
  if (c.ok) byCheck[k].pass++;
  else byCheck[k].bad.push((r.qid || r.run || '?') + '：' + c.detail);
}));

const full = results.filter(r => r.checks.every(c => c.ok)).length;
console.log('分身判分 · ' + recs.length + ' 条答案 · 全部通过 ' + full + ' 条（' +
  (full / recs.length * 100).toFixed(1) + '%）');
console.log('语料：信件 ' + LETTER_BLOCKS.length + ' 段 · 股东大会 ' +
  (MEETING && MEETING.SEGS ? MEETING.SEGS.length : 0) + ' 段 · 演讲 ' +
  (SPEECH && SPEECH.SEGS ? SPEECH.SEGS.length : 0) + ' 段 · 案例 ' + CASE_IDS.size + ' 条');
const lens = results.map(r => r.len).sort((a, b) => a - b);
const med = lens[Math.floor(lens.length / 2)];
const over = lens.filter(x => x > 1400).length;
console.log('字数：中位数 ' + med + ' · 最长 ' + lens[lens.length - 1] +
  ' · 超过提示词目标 1400 的 ' + over + '/' + lens.length + ' 条（只提示，不判不合格）');
console.log('');

const groups = ['拒答', '结构', '原话区', '事实区', '判断', '越界', '案例', '时间', '长度'];
for (const g of groups) {
  const keys = Object.keys(byCheck).filter(k => k.startsWith(g + '·'));
  if (!keys.length) continue;
  console.log('[' + g + ']');
  keys.forEach(k => {
    const v = byCheck[k];
    const pct = v.pass / v.total * 100;
    const flag = pct === 100 ? '✓' : (pct >= 80 ? '~' : '✗');
    console.log('  ' + flag + ' ' + k.split('·')[1] + '  ' + v.pass + '/' + v.total +
      (pct === 100 ? '' : '（' + pct.toFixed(0) + '%）'));
    if (verbose || pct < 100) v.bad.slice(0, verbose ? 99 : 3).forEach(b => console.log('      - ' + b.slice(0, 120)));
  });
  console.log('');
}

if (verbose) {
  results.forEach(r => {
    console.log('— ' + (r.qid || r.run || '单条') + ' · ' + r.len + ' 字 · ' + r.heads.join('/'));
    r.checks.filter(c => !c.ok).forEach(c => console.log('    ✗ ' + c.group + '·' + c.name + ' · ' + c.detail));
  });
  console.log('');
}
