/* 判分器：读 trace 算分，不碰 agent。
 *
 *   用法：
 *     node eval/score.js                         算最新一批（机械判分 + 金标检索体检）
 *     node eval/score.js --run-id rb-xxxx        算指定批次
 *     node eval/score.js --judge                 额外跑模型判分（要花钱，默认不开）
 *     node eval/score.js --mode retrieve         只跑金标检索体检（零成本，3 秒）
 *
 * 为什么要和跑批分开：
 *   跑一批要真金白银，判分是纯本地计算（除了 judge）。分开放，改判分口径不用重跑批。
 *
 * 三层判分，能机械判的绝不交给模型：
 *   A 机械  引用存在 / 逐字忠实 / 数字溯源 / 网络标注 / 拒答 / 工具命中 —— 全是字符串比对
 *   B 模型  答对率、编造、来源混淆、该答却拒答 —— 只有模型能判的才交给模型
 *   C 金标  检索体检（hit@6、跨年覆盖）—— 不需要模型，零 token
 *
 * 输出 eval/results/score-<run_id>.json，报告生成器 eval/report.js 只读这一个文件。
 */
const fs = require('fs'), fsp = fs.promises, path = require('path'), vm = require('vm');

const ROOT = path.join(__dirname, '..');
const TRACE_DIR = path.join(ROOT, 'eval', 'traces');
const RES_DIR = path.join(ROOT, 'eval', 'results');

function arg(n, d) { const i = process.argv.indexOf('--' + n); return i >= 0 ? (process.argv[i + 1] || d) : d; }
const has = n => process.argv.indexOf('--' + n) >= 0;
const RUN_ID = arg('run-id', '');
const MODE = arg('mode', 'all');
const DO_JUDGE = has('judge');

/* ---------------- 语料（与 agent 同源） ---------------- */
function loadCorpus() {
  const win = {}, ctx = { window: win, console };
  vm.createContext(ctx);
  for (const f of ['data-core.js', 'data-letters.js', 'data-content.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'site', f), 'utf8'), ctx, { filename: f });
  }
  return { C: win.CORE, L: win.LETTERS, CT: win.CONTENT };
}
let _corpus = null;
const corpus = () => (_corpus || (_corpus = loadCorpus()));

function loadSearch() {
  /* 复用 agent.js 里那段检索代码，口径和线上一模一样 —— 另写一份就会测出两个答案 */
  const src = fs.readFileSync(path.join(ROOT, 'agent.js'), 'utf8');
  const ctx = { require, console, module: {}, process, __dirname: ROOT };
  vm.createContext(ctx);
  vm.runInContext(src.slice(0, src.indexOf('/* ---------------- 工具 ----------------')) +
    '\n;globalThis.__exp={searchDocs,L};', ctx, {});
  return ctx.__exp;
}

const jl = p => fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const loadCases = f => { const p = path.join(ROOT, 'eval', f); return fs.existsSync(p) ? jl(p) : []; };

/* ---------------- A 层：机械判分 ---------------- */

/* 引用标记解析：判分一律从答案原文自己解析，不依赖 trace 里那个字段。
   这样旧 trace（解析规则改之前落的）也能重判，改解析规则不用重跑批。
   「信」那一截是信件 id（形如「2018 巴菲特致股东信」），不是数字下标。 */
const CITE_RE = /\[\[([^|\]]+)\|(\d+)\]\]|\[\[web\|([^\]]+)\]\]/g;
function parseCites(text) {
  const out = []; let m;
  CITE_RE.lastIndex = 0;
  while ((m = CITE_RE.exec(text || ''))) {
    out.push(m[3] !== undefined ? { kind: 'web', url: m[3] } : { kind: 'letter', l: m[1], b: +m[2] });
  }
  return out;
}

/* 拒答判定（启发式，不是模型判断）：答案里有没有明确说"查不到"。
   只在对抗层用 —— 那层的题本来就是故意问语料里没有的东西。
   定义在 A 层最前面：逐字、数字两项判定都得先知道这一问是不是在拒答。 */
const ABSTAIN = /没(?:有)?查到|查不到|找不到|没有找到|收录范围|这 \d+ 封信里没有|语料里没有|无法确认|不能确认|没有找到相关|不在.{0,6}范围|我(?:也)?不确定|没有证据/;

/* 引用存在率：答案里每个 [[信|段]] 都能在语料里找到吗。
   这是最硬的一条 —— 编号写错一位就是指向了别的段落，读者点过去看到的是另一句话。 */
function scoreCiteExist(cites) {
  const { L } = corpus();
  let ok = 0; const bad = [];
  for (const c of cites) {
    if (c.kind === 'web') { if (c.url) ok++; else bad.push('web:空地址'); continue; }
    const lt = L[c.l];
    if (lt && lt.blocks[c.b]) ok++;
    else bad.push(c.l + '|' + c.b);
  }
  return { n: cites.length, ok: ok, bad: bad, rate: cites.length ? +(ok / cites.length).toFixed(3) : null };
}

const QUOTE_RE = /[“"「]([^”"」]{6,})[”"」]/g;
/* 逐字忠实率：答案里打了引号的话，是不是真在被引段落的原文里。
   判据是「最长公共子串」—— 引号里那句和被引用原文逐字对得上有多长。
   改一两个字不算错（模型会为了通顺微调），所以阈值取 0.8 而不是 1.0。 */
function lcsLen(a, b) {
  /* 两段都只有几百字，O(n*m) 够用；真要更快就上滚动数组，没必要 */
  const n = a.length, m = b.length;
  if (!n || !m) return 0;
  let prev = new Array(m + 1).fill(0), cur = new Array(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    const t = prev; prev = cur; cur = t; cur.fill(0);
  }
  return prev[m];
}
function scoreVerbatim(trace) {
  const { L } = corpus();
  const cited = (trace.sources || []).filter(s => s.kind === 'letter')
    .map(s => ((L[s.l] || {}).blocks || [])[s.b]).filter(Boolean).map(b => b.t || '');
  const hay = cited.join('\n');
  const body = String(trace.answer || '').replace(/\[\[[^\]]+\]\]/g, '');
  /* 两种答案不适用这条指标，硬算只会得到一个吓人又没意义的低分：
     1. 在拒答的（引号里是复述问题，不是引文）；
     2. 引了网页的（网页正文没进 trace，本地无从核验，得单独标出来由人看）。 */
  if (ABSTAIN.test(body)) return { n: 0, ok: 0, rate: null, note: '这一问在拒答，不适用' };
  const hasWeb = parseCites(trace.answer).some(c => c.kind === 'web');
  /* 分级比一个总分有用：hit≥0.8 是逐字；0.5–0.8 是引号里装了自己的转述
     （读者会当成原话，是轻病）；<0.5 基本是凭印象编的（重病）。 */
  let m, ok = 0, n = 0; const samples = [];
  let faithful = 0, paraphrased = 0, fabricated = 0;
  QUOTE_RE.lastIndex = 0;
  while ((m = QUOTE_RE.exec(body))) {
    const q = m[1].trim();
    if (q.length < 10) continue;   /* 太短的碎片（单词、标点了）算比例会失真 */
    n++;
    const r = hay ? lcsLen(q, hay) / q.length : 0;
    if (r >= 0.8) { ok++; faithful++; continue; }
    if (r >= 0.5) paraphrased++; else fabricated++;
    if (samples.length < 5) samples.push({ q: q.slice(0, 40), hit: +r.toFixed(2), grade: r >= 0.5 ? '引号内改写' : '疑似编造' });
  }
  return { n: n, ok: ok, rate: n ? +(ok / n).toFixed(3) : null,
    web_blind: hasWeb || undefined, note: hasWeb ? '含联网引用，本地原文核不了那部分' : undefined,
    faithful: faithful, paraphrased: paraphrased, fabricated: fabricated, samples: samples };
}

/* 句级落地率：引号不是人人都打，所以再粗筛一遍 —— 答案的每一句，
   有多少能在被引原文里找到 ≥10 个连续相同的字。这是"整段有多大比例是贴着原文写的"。 */
function scoreGrounding(trace) {
  const { L } = corpus();
  const cited = (trace.sources || []).filter(s => s.kind === 'letter')
    .map(s => ((L[s.l] || {}).blocks || [])[s.b]).filter(Boolean).map(b => b.t || '');
  const hay = cited.join('\n');
  if (!hay) return { n: 0, ok: 0, rate: null };
  const sents = String(trace.answer || '').replace(/\[\[[^\]]+\]\]/g, '')
    .split(/[。！？\n]/).map(s => s.trim()).filter(s => s.length >= 12);
  let ok = 0;
  for (const s of sents) if (lcsLen(s, hay) >= 10) ok++;
  return { n: sents.length, ok: ok, rate: sents.length ? +(ok / sents.length).toFixed(3) : null };
}

const NUM_RE = /(?:19|20)\d{2}(?:\s*年)?|\d+(?:\.\d+)?\s*%|\d+(?:\.\d+)?\s*(?:亿|万|倍|个百分点)(?:美元|美元|元|股)?/g;
/* 数字溯源率：答案里的每个数字，能不能在被引用段落的原文里找到。
   问题里本来就有的数字（比如"1974 年"是读者问的）不算捏造，先排除掉。 */
function scoreNumTrace(trace) {
  const { L } = corpus();
  const cited = (trace.sources || []).filter(s => s.kind === 'letter')
    .map(s => ((L[s.l] || {}).blocks || [])[s.b]).filter(Boolean).map(b => b.t || '');
  const hay = cited.join('\n');
  /* 年份和数字要分开判：说「1980 年他怎么讲」，年份来自被引用信件本身属于那一年，
     不必要求正文里正好写着「1980」四个数字 —— 按正文判会把大量正确回答误判成捏造。 */
  const srcYears = new Set((trace.sources || []).filter(s => s.kind === 'letter').map(s => s.y));
  const body = String(trace.answer || '').replace(/\[\[[^\]]+\]\]/g, '');
  /* 拒答时的年份多半是复述问题里的（"1900 年"），不算捏造 */
  if (ABSTAIN.test(body)) return { n: 0, ok: 0, bad: [], rate: null, note: '这一问在拒答，不适用' };
  const hasWeb = parseCites(trace.answer).some(c => c.kind === 'web');
  const qNums = new Set(String(trace.question || '').match(NUM_RE) || []);
  const nums = (body.match(NUM_RE) || []).map(s => s.trim());
  const uniq = [];
  nums.forEach(x => { if (qNums.has(x)) return; if (uniq.indexOf(x) < 0) uniq.push(x); });
  let ok = 0; const bad = [];
  for (const x of uniq) {
    const core = x.replace(/\s/g, '');
    const ym = core.match(/^(?:19|20)\d{2}/);
    if (ym && srcYears.has(+ym[0])) { ok++; continue; }
    if (hay && hay.replace(/\s/g, '').indexOf(core) >= 0) { ok++; continue; }
    bad.push(x);
  }
  return { n: uniq.length, ok: ok, bad: bad.slice(0, 8), rate: uniq.length ? +(ok / uniq.length).toFixed(3) : null,
    web_blind: hasWeb || undefined, note: hasWeb ? '含联网引用，本地原文核不了那部分' : undefined };
}

const WEB_MARK = /网络|网上|联网|互联网|网站|新闻报道|媒体报道|公开报道|来源[:：]|（网络|来自网络/;
/* 网络来源标注率：一旦引了网页，就必须说清这不是信里的话。
   这条红线是产品定位决定的 —— 这个 agent 的可信度全押在"他说的 vs 网上说的"分得开。 */
function scoreWebMark(trace, cites) {
  const webCites = cites.filter(c => c.kind === 'web');
  if (!webCites.length) return { n: 0, ok: 0, rate: null };
  const body = String(trace.answer || '');
  return { n: webCites.length, ok: WEB_MARK.test(body) ? webCites.length : 0,
    rate: WEB_MARK.test(body) ? 1 : 0 };
}

/* 拒答判定（启发式，不是模型判断）：答案里有没有明确说"查不到"。
   只在对抗层用 —— 那层的题本来就是故意问语料里没有的东西。 */
function scoreAbstain(trace) {
  const body = String(trace.answer || '').replace(/\[\[[^\]]+\]\]/g, '');
  return { abstained: ABSTAIN.test(body), signals: (body.match(ABSTAIN) || [])[0] || null };
}

/* 工具命中：这题期望用的工具，agent 真的用了吗。
   看的是「他想用什么」而不是「用对了没」—— 后者要人看。 */
function scoreToolHit(c, trace) {
  const want = c.expect_tools || [];
  if (!want.length) return { n: 0, ok: 0, rate: null };
  const used = (trace.spans || []).filter(s => s.type === 'tool').map(s => s.name);
  const ok = want.filter(w => used.indexOf(w) >= 0).length;
  return { n: want.length, ok: ok, rate: +(ok / want.length).toFixed(3), used: used };
}

/* ---------------- C 层：金标检索体检（零 token） ---------------- */
function scoreRetrieve() {
  const { searchDocs, L } = loadSearch();
  const cases = loadCases('cases-gold.jsonl');
  const run = set => {
    let hit = 0, yc = 0, yg = 0;
    for (const c of set) {
      const o = { k: 6 };
      if (c.year_from) o.y0 = c.year_from;
      if (c.year_to) o.y1 = c.year_to;
      const got = searchDocs(c.q, o).map(d => d.l + '|' + d.b);
      const gold = new Set(c.gold.map(g => g[0] + '|' + g[1]));
      if (got.some(x => gold.has(x))) hit++;
      const gy = new Set(c.gold.map(g => L[g[0]].year));
      const hy = new Set(got.filter(x => gold.has(x)).map(x => L[x.split('|')[0]].year));
      yc += hy.size; yg += Math.min(6, gy.size);
    }
    return { n: set.length, hit6: set.length ? +(hit / set.length).toFixed(3) : null,
      year_cov: yg ? +(yc / yg).toFixed(3) : null };
  };
  const all = run(cases);
  const lx = run(cases.filter(c => !c.needs_alias));
  const na = run(cases.filter(c => c.needs_alias));
  return { all: all, lexical: lx, needs_alias: na };
}

/* ---------------- B 层：模型判分 ---------------- */
/* judge 用非推理模型：判「这段原文撑不撑得住这句话」不需要它想五千字，
   而推理模型光思考就能吃掉全部 token 额度，答案还没开始就被截断（实测 24/38 条判不出来）。
   要换推理模型就加 --judge-model deepseek-flash，同时记得把 max_tokens 抬到 8000 以上。 */
const JUDGE_MODEL = arg('judge-model', 'deepseek-chat');
async function judgeOne(c, trace, apiKey) {
  const { L } = corpus();
  const srcs = (trace.sources || []).slice(0, 8).map(s => {
    if (s.kind === 'web') return '[网络] ' + s.url;
    const lt = L[s.l]; const b = lt && lt.blocks[s.b];
    return b ? '[' + (lt.year || '?') + '年·第' + s.b + '段] ' + String(b.t || '').slice(0, 400) : null;
  }).filter(Boolean);
  const prompt = [
    '你是问答质量的裁判。下面是：读者的问题、评判要点、agent 的回答、以及回答声称引用的原文段落。',
    '请只根据「原文段落里是否真有这个说法」来判，不要因为回答听起来合理就给高分。',
    '',
    '问题：' + c.q,
    '评判要点：' + (c.rubric || c.note || '（无额外要点，按通用标准：是否正面回答、是否有原文支撑、是否编造、是否区分了信里的原话与网络说法）'),
    '',
    '回答：' + String(trace.answer || '').replace(/\[\[[^\]]+\]\]/g, '').slice(0, 3000),
    '',
    '声称引用的原文：',
    srcs.length ? srcs.join('\n---\n') : '（这一问没有引用任何原文）',
    '',
    '只输出一行 JSON，不要解释、不要代码块：',
    '{"score":整数1到5,"fabricated":0或1,"source_confused":0或1,"abdicated":0或1,"reason":"一句话，30字以内"}',
    '',
    '评分：5=正面回答且每句关键论断都有原文支撑；4=回答到位但个别论断支撑略薄；3=沾边但不完整或出处含糊；2=答非所问或大面积没支撑；1=编造原文或张冠李戴。',
    'fabricated=1 指原文里根本没写、回答却当成他说的；source_confused=1 指把网络说法混写成信里原话；abdicated=1 指明明能答却推说查不到。',
    '',
    '重要：不是每一题都要求引用书信原文。考"边界行为"的题（如实说明自己做不到什么、拒答、挡住套提示词、处理记忆）',
    '正确的做法恰恰是不引原文而如实说明 —— 这种题不要因为"没引原文"就扣分，要看它有没有如实、有没有假装。'
  ].join('\n');
  /* max_tokens 要给足：judge 用的是会先想一遍再答的模型，思考本身也吃 token，
     给 300 的话它还没开口就被截断，content 是空的 —— 判分全废。 */
  const r = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: JUDGE_MODEL, messages: [{ role: 'user', content: prompt }],
      max_tokens: 800, temperature: 0 })
  });
  if (!r.ok) throw new Error('judge 调用失败 ' + r.status + '：' + (await r.text()).slice(0, 120));
  const j = await r.json();
  const ch0 = (j.choices || [])[0] || {};
  const txt = (ch0.message && ch0.message.content) || '';
  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('judge 没返回 JSON（finish=' + (ch0.finish_reason || '?') +
    '，正文 ' + txt.length + ' 字，思考 ' + ((ch0.message || {}).reasoning_content || '').length + ' 字）');
  let o;
  try { o = JSON.parse(m[0]); } catch (e) { throw new Error('judge JSON 解析失败：' + m[0].slice(0, 100)); }
  return { score: Math.max(1, Math.min(5, +o.score || 3)), fabricated: !!o.fabricated,
    source_confused: !!o.source_confused, abdicated: !!o.abdicated,
    reason: String(o.reason || '').slice(0, 120) };
}

/* ---------------- 主流程 ---------------- */
(async () => {
  let runId = RUN_ID;
  if (!runId) {
    if (!fs.existsSync(RES_DIR)) { console.error('没有跑批结果，先跑 node eval/run_batch.js'); process.exit(1); }
    const bs = fs.readdirSync(RES_DIR).filter(f => f.startsWith('batch-')).sort();
    if (!bs.length) { console.error('没有跑批结果，先跑 node eval/run_batch.js'); process.exit(1); }
    runId = bs[bs.length - 1].replace(/^batch-|\.json$/g, '');
  }
  console.log('run_id = ' + runId + (MODE === 'all' ? '' : ' · mode=' + MODE));

  const out = { run_id: runId, ts: Date.now(), mode: MODE, judged: false,
    retrieve: null, items: [], agg: {} };

  /* C 层：检索体检不需要任何跑批结果，什么时候都能跑 */
  if (MODE === 'all' || MODE === 'retrieve') {
    out.retrieve = scoreRetrieve();
    const r = out.retrieve;
    console.log('金标检索体检：全部 hit@6 ' + (r.all.hit6 * 100).toFixed(1) + '% · ' +
      '词面可检索 ' + r.lexical.n + ' 条 ' + (r.lexical.hit6 * 100).toFixed(1) + '% · ' +
      '需别名/档案 ' + r.needs_alias.n + ' 条 ' + (r.needs_alias.hit6 * 100).toFixed(1) + '%');
  }
  if (MODE === 'retrieve') {
    await fsp.mkdir(RES_DIR, { recursive: true });
    await fsp.writeFile(path.join(RES_DIR, 'score-' + runId + '-retrieve.json'), JSON.stringify(out, null, 1), 'utf8');
    return;
  }

  /* 收集这一批的 trace：服务端按天分文件，扫全部再按 run_id 过滤 */
  if (!fs.existsSync(TRACE_DIR)) { console.error('没有 trace，先跑 node eval/run_batch.js'); process.exit(1); }
  const files = fs.readdirSync(TRACE_DIR).filter(f => f.endsWith('.jsonl')).sort();
  const traces = [];
  for (const f of files) {
    for (const line of fs.readFileSync(path.join(TRACE_DIR, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const t = JSON.parse(line); if (t.run_id === runId) traces.push(t); } catch (e) {}
    }
  }
  /* 同一 qid 可能有多条 trace（跑批重试、分两批补齐都会留下重复）。
     取「没报错的那条里最新的一条」—— 失败的留着没用，重试成功的才算数。 */
  const byQid = {};
  traces.forEach(t => {
    const k = String(t.qid || '');
    const prev = byQid[k];
    if (!prev) { byQid[k] = t; return; }
    const better = (prev.error && !t.error) || (!prev.error && !t.error && (t.ts || 0) >= (prev.ts || 0));
    if (better) byQid[k] = t;
  });
  const uniq = Object.keys(byQid).sort().map(k => byQid[k]);
  console.log('读到 trace ' + traces.length + ' 条，去重后 ' + uniq.length + ' 条（来自 ' + files.length + ' 个文件）');

  const cases = {};
  loadCases('cases-real.jsonl').concat(loadCases('cases-adv.jsonl')).forEach(c => { cases[c.id] = c; });

  let apiKey = null;
  if (DO_JUDGE) {
    apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      for (const f of [path.join(ROOT, '_agent.key'), path.join(require('os').homedir(), '.buffett-agent.key')]) {
        try { const v = (await fsp.readFile(f, 'utf8')).trim(); if (v) { apiKey = v; break; } } catch (e) {}
      }
    }
    if (!apiKey) console.log('（没找到密钥，跳过 judge）');
  }

  for (const t of uniq) {
    const cid = String(t.qid || '').split('#')[0];
    const c = cases[cid] || {};
    const item = { qid: t.qid, case_id: cid, kind: c.kind || null, layer: t.layer || c.layer || null,
      question: t.question, error: t.error, ms: t.ms, ttft: t.ttft, rounds: t.rounds, calls: t.calls,
      tokens: t.usage ? (t.usage.prompt_tokens || 0) + (t.usage.completion_tokens || 0) : null,
      n_cites: (t.citations || []).length, n_sources: (t.sources || []).length,
      answer_len: String(t.answer || '').length,
      tools: (t.spans || []).filter(s => s.type === 'tool').map(s => s.name) };
    if (t.error) { item.scores = { failed: true }; out.items.push(item); continue; }
    const cites = parseCites(t.answer);
    item.n_cites = cites.length;
    item.scores = {
      cite_exist: scoreCiteExist(cites),
      verbatim: scoreVerbatim(t),
      grounding: scoreGrounding(t),
      num_trace: scoreNumTrace(t),
      web_mark: scoreWebMark(t, cites),
      abstain: scoreAbstain(t),
      tool_hit: scoreToolHit(c, t)
    };
    out.items.push(item);
  }

  /* 判分幂等：上次已经判出来的分数沿用，只补判失败的。判一次要钱，重判全部是浪费。
   但 judge 的提示词一改，新旧分数就不可比了 —— 那时用 --rejudge all（或指定 case）全量重判。 */
const REJUDGE = arg('rejudge', '').split(',').filter(Boolean);
  const sfp = path.join(RES_DIR, 'score-' + runId + '.json');
  const prevJudge = {};
  if (fs.existsSync(sfp)) {
    try {
      (JSON.parse(fs.readFileSync(sfp, 'utf8')).items || []).forEach(i => {
        if (i.judge && !i.judge.error) prevJudge[i.qid] = i.judge;
      });
      if (Object.keys(prevJudge).length) console.log('（沿用上次已判出的 ' + Object.keys(prevJudge).length + ' 条分数，只补判失败的）');
    } catch (e) {}
  }

  if (DO_JUDGE && apiKey) {
    console.log('');
    let n = 0;
    for (const item of out.items) {
      if (item.scores && item.scores.failed) continue;
      if (prevJudge[item.qid]) {
        const force = REJUDGE.indexOf('all') >= 0 || REJUDGE.indexOf(item.qid) >= 0 || REJUDGE.indexOf(item.case_id) >= 0;
        if (!force) { item.judge = prevJudge[item.qid]; n++; continue; }
      }
      const t = uniq.find(x => x.qid === item.qid);
      const c = cases[item.case_id] || {};
      try {
        item.judge = await judgeOne(c, t, apiKey);
        n++;
        console.log('  judge ' + item.qid.padEnd(14) + item.judge.score + ' 分 · ' + item.judge.reason);
      } catch (e) {
        item.judge = { error: e.message };
        console.log('  judge ' + item.qid.padEnd(14) + '判分失败：' + e.message.slice(0, 60));
      }
    }
    out.judged = n > 0;
  }

  /* 汇总：只统计主问题（qid 不带 # 的），repeat 的副本单独看稳定性 */
  const main = out.items.filter(i => String(i.qid).indexOf('#') < 0 && !(i.scores && i.scores.failed));
  const rateOf = (set, k) => {
    const v = set.map(i => i.scores && i.scores[k] && i.scores[k].rate).filter(x => typeof x === 'number');
    return v.length ? +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(3) : null;
  };
  const rate = k => rateOf(main, k);
  /* 分层口径：引了网页的回答，本地没有网页正文可核对，那部分引文核不了。
     把它们单列出来，才不会把「核不了」当成「编造」报成一个假的低分。 */
  const pure = main.filter(i => !(i.scores && i.scores.verbatim && i.scores.verbatim.web_blind));
  const cnt = k => {
    const v = main.map(i => i.scores && i.scores[k] && i.scores[k].n).filter(x => typeof x === 'number');
    return v.reduce((a, b) => a + b, 0);
  };
  const jr = out.items.filter(i => i.judge && typeof i.judge.score === 'number');
  out.agg = {
    n_main: main.length,
    n_failed: out.items.filter(i => i.scores && i.scores.failed).length,
    cite_exist: { rate: rate('cite_exist'), n: cnt('cite_exist') },
    verbatim: { rate: rate('verbatim'), n: cnt('verbatim') },
    grounding: { rate: rate('grounding'), n: cnt('grounding') },
    num_trace: { rate: rate('num_trace'), n: cnt('num_trace') },
    verbatim_pure: { rate: rateOf(pure, 'verbatim'), n: pure.length },
    num_trace_pure: { rate: rateOf(pure, 'num_trace'), n: pure.length },
    web_mark: { rate: rate('web_mark'), n: cnt('web_mark') },
    tool_hit: { rate: rate('tool_hit'), n: cnt('tool_hit') },
    abstain: { n: main.filter(i => i.scores && i.scores.abstain && i.scores.abstain.abstained).length },
    ms_avg: main.length ? Math.round(main.reduce((a, b) => a + (b.ms || 0), 0) / main.length) : null,
    ttft_avg: main.length ? Math.round(main.reduce((a, b) => a + (b.ttft || 0), 0) / main.length) : null,
    rounds_avg: main.length ? +(main.reduce((a, b) => a + (b.rounds || 0), 0) / main.length).toFixed(2) : null,
    calls_avg: main.length ? +(main.reduce((a, b) => a + (b.calls || 0), 0) / main.length).toFixed(2) : null,
    tokens_avg: main.length ? Math.round(main.reduce((a, b) => a + (b.tokens || 0), 0) / main.length) : null,
    judge_avg: jr.length ? +(jr.reduce((a, b) => a + b.judge.score, 0) / jr.length).toFixed(2) : null,
    judge_ge4: jr.length ? +(jr.filter(i => i.judge.score >= 4).length / jr.length).toFixed(3) : null,
    judge_fabricated: jr.filter(i => i.judge.fabricated).length,
    judge_source_confused: jr.filter(i => i.judge.source_confused).length,
    judge_abdicated: jr.filter(i => i.judge.abdicated).length,
    judge_n: jr.length
  };

  await fsp.mkdir(RES_DIR, { recursive: true });
  const fp = path.join(RES_DIR, 'score-' + runId + '.json');
  await fsp.writeFile(fp, JSON.stringify(out, null, 1), 'utf8');
  console.log('');
  console.log('引用存在率 ' + pct(out.agg.cite_exist.rate) + '（' + out.agg.cite_exist.n + ' 个引用）');
  console.log('逐字忠实率 ' + pct(out.agg.verbatim.rate) + '（' + out.agg.verbatim.n + ' 处引号）');
  console.log('句级落地率 ' + pct(out.agg.grounding.rate));
  console.log('数字溯源率 ' + pct(out.agg.num_trace.rate) + '（' + out.agg.num_trace.n + ' 个数字）');
  console.log('工具命中率 ' + pct(out.agg.tool_hit.rate));
  if (out.agg.judge_avg !== null) console.log('judge 均分 ' + out.agg.judge_avg + ' · ≥4 分占比 ' + pct(out.agg.judge_ge4));
  console.log('判分结果 → ' + fp);
  console.log('下一步： node eval/report.js --run-id ' + runId);
})();

function pct(x) { return x === null ? '—' : (x * 100).toFixed(1) + '%'; }
