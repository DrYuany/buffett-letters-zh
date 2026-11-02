/* 从现有档案生成「决策案例」候选，供分身检索。
   跑法：node extract_cases.js  →  产出 site/data-cases.js（window.CASES）
   零依赖，Node 18+。

   素材全部来自 site/data-content.js 已有的档案，不重新标语料：
     scorecards  = 当时怎么判断 + 逐年发生了什么 + 后来结果（结构最完整）
     rules       = 194 条带出处的判断原则
     corrections = 108 条他自己认过的错
   每条都尽量定位回原信某一段；定位不到的，标 judgment_verbatim=false，
   分身不得把它当原话逐字引用。
   slots 是机器猜的初值，auto=true 表示还没人工核过。
*/
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SITE = path.join(__dirname, 'site');

function load() {
  const ctx = { window: {}, console };
  vm.createContext(ctx);
  for (const f of ['data-core.js', 'data-letters.js', 'data-content.js']) {
    vm.runInContext(fs.readFileSync(path.join(SITE, f), 'utf8'), ctx, { filename: f });
  }
  return { C: ctx.window.CORE, L: ctx.window.LETTERS, CT: ctx.window.CONTENT };
}
const { C, L, CT } = load();

/* 情形槽位的初判词表。写进产出文件，检索端和生成端共用一份，不会两边漂移。 */
const SLOT_RULES = [
  ['市场大跌', ['暴跌', '腰斩', '崩盘', '熊市', '恐慌', '危机', '股灾', '衰退', '大跌', '跌停', '暴雷']],
  ['市场过热', ['泡沫', '狂热', '投机', '高估', '疯涨', '牛市', '高位', '亢奋', '情绪']],
  ['并购', ['收购', '并购', '合并', '换股']],
  ['回购', ['回购']],
  ['卖出', ['减持', '清仓', '卖出', '抛售', '退出']],
  ['买入', ['加仓', '买入', '建仓', '买进', '逆市']],
  ['公司出问题', ['丑闻', '造假', '欺诈', '错误', '失误', '坏账', '诉讼', '暴雷']],
  ['业绩变化', ['业绩', '盈利', '利润', '营收', '亏损', '回报率']],
  ['管理层变动', ['管理层', 'CEO', '首席', '辞职', '换帅', '接班']],
  ['宏观变化', ['利率', '通胀', '汇率', '美联储', '货币政策', '税']],
  ['分红', ['分红', '股息']],
  ['估值', ['估值', '市盈率', '内在价值', '便宜', '低估', '安全边际']]
];
function slotsOf(text) {
  const s = String(text || '');
  const out = [];
  for (const [name, words] of SLOT_RULES) {
    for (const w of words) if (s.indexOf(w) >= 0) { out.push(name); break; }
  }
  return out;
}

/* 按年份给原信段落建索引：一句话 → 哪封信第几段 */
const BY_YEAR = {};
for (const id in L) {
  const lt = L[id];
  const rows = (BY_YEAR[lt.year] = BY_YEAR[lt.year] || []);
  lt.blocks.forEach((b, bi) => {
    const t = (b.t || '').replace(/\s+/g, ' ').trim();
    if (t.length < 24) return;   /* 与 agent.js 的可检索段落口径一致 */
    rows.push({ l: id, b: bi, t: t });
  });
}
function hasBlock(l, b) { return !!(L[l] && L[l].blocks && L[l].blocks[b]); }

function resolveLoc(text, year) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (s.length < 8) return null;
  const probes = [s.slice(0, 26), s.slice(0, 15), s.slice(0, 9)];
  for (const p of probes) {
    if (p.length < 8) continue;
    for (const d of (BY_YEAR[year] || [])) {
      if (d.t.indexOf(p) >= 0) return { l: d.l, b: d.b, y: year, exact: d.t.indexOf(s) >= 0 };
    }
  }
  /* 有些档案的年份按事件记、不按信件记，同年找不到就全库兜底一次 */
  for (const p of probes.slice(0, 2)) {
    for (const y in BY_YEAR) {
      for (const d of BY_YEAR[y]) {
        if (d.t.indexOf(p) >= 0) return { l: d.l, b: d.b, y: +y, exact: d.t.indexOf(s) >= 0 };
      }
    }
  }
  return null;
}

const cases = [];

/* ① 记分卡：有「当时判断 → 逐年事实 → 后来结果」，最像一次真实决策 */
for (const name in (CT.scorecards || {})) {
  const s = CT.scorecards[name];
  const claim = s.claim || {};
  const tl = s.timeline || [];
  const y = +(claim.year || (tl[0] && tl[0].y) || 0);
  const first = tl.find(t => t.k === 'act') || tl[0] || {};
  const situation = String(first.t || s.title || '').slice(0, 180);
  const judgment = String(claim.text || '');
  const loc = resolveLoc(judgment, y);
  const srcs = Array.isArray(s.src) ? s.src : (typeof s.src === 'string' ? [s.src] : []);
  cases.push({
    id: 'sc-' + name, persona: 'buffett', kind: 'scorecard', y, entity: name,
    tags: [name].concat(srcs.filter(x => typeof x === 'string')),
    situation, judgment,
    judgment_verbatim: !!(loc && loc.exact),
    quote_locs: loc ? [{ l: loc.l, b: loc.b, y: loc.y }] : [],
    outcome: String(s.outcome || ''), lesson: String(s.lesson || ''),
    verdict: String(s.verdict || ''),
    slots: slotsOf(situation + ' ' + judgment + ' ' + (s.title || '')),
    auto: true
  });
}

/* ② 判断原则：没有具体情形，但句句是能点回原信的原话 */
(CT.rules || []).forEach((r, i) => {
  const raw = r.loc;
  const loc = raw && hasBlock(raw.l, raw.b) ? { l: raw.l, b: raw.b, y: +(r.y || 0) } : null;
  cases.push({
    id: 'rule-' + i, persona: 'buffett', kind: 'rule', y: +(r.y || 0), entity: '',
    tags: r.src ? [String(r.src)] : [],
    situation: '（原则，非具体事件）' + String(r.src || ''),
    judgment: String(r.t || ''),
    judgment_verbatim: !!loc,
    quote_locs: loc ? [loc] : [],
    outcome: '', lesson: '', verdict: '',
    slots: slotsOf(String(r.t || '') + ' ' + String(r.src || '')),
    auto: true
  });
});

/* ③ 认错：分身最不该缺的一类，防止只挑赢过的案例 */
(CT.corrections || []).forEach((c, i) => {
  const raw = c.loc;
  const loc = raw && hasBlock(raw.l, raw.b) ? { l: raw.l, b: raw.b, y: +(c.y || 0) } : null;
  cases.push({
    id: 'corr-' + i, persona: 'buffett', kind: 'correction', y: +(c.y || 0), entity: String(c.ent || ''),
    tags: c.ent ? [String(c.ent)] : [],
    situation: '（他自己认过的错）' + String(c.ent || ''),
    judgment: String(c.t || ''),
    judgment_verbatim: !!loc,
    quote_locs: loc ? [loc] : [],
    outcome: '', lesson: '', verdict: 'error',
    slots: slotsOf(String(c.t || '') + ' ' + String(c.ent || '')),
    auto: true
  });
});

/* ---- 并入公众演讲里抽出来的案例 ----
   来源：_src/speech/cases.json（extract_speech_cases.js 产出，素材是 1985-2025 的演讲与访谈）
   这些案例没有信件坐标（quote_locs 为空），但带自己的场合坐标 src.venue——
   引用时说清"1998 年在佛罗里达讲的"就够了。能不能逐字引用，看的是这份
   是逐字稿还是凭笔记整理的转述（src.fid），不是看有没有信件段落。 */
let nSpeech = 0;
const SPEECH_CASES = path.join(__dirname, '_src', 'speech', 'cases.json');
if (fs.existsSync(SPEECH_CASES)) {
  const raw = JSON.parse(fs.readFileSync(SPEECH_CASES, 'utf8'));
  const SLOT_NAMES = SLOT_RULES.map(x => x[0]);
  const seenJ = new Set(cases.map(c => String(c.judgment || '').slice(0, 20)));
  for (const x of raw) {
    const j = String(x.judgment || '').trim();
    if (j.length < 12) continue;
    const key = j.slice(0, 20);
    if (seenJ.has(key)) continue;           /* 档案里已有同款，不重复进 */
    seenJ.add(key);
    const kind = ['scorecard', 'rule', 'correction'].indexOf(x.kind) >= 0 ? x.kind : 'rule';
    cases.push({
      id: 'sp-' + kind + '-' + (++nSpeech),
      persona: 'buffett',
      kind: kind,
      y: +x.y || (x.src && x.src.y) || 0,
      entity: String(x.entity || ''),
      tags: [x.entity].filter(Boolean),
      situation: String(x.situation || ''),
      judgment: j,
      judgment_verbatim: !!x.judgment_verbatim,
      quote_locs: [],
      outcome: '',
      lesson: String(x.lesson || ''),
      verdict: String(x.verdict || ''),
      slots: (Array.isArray(x.slots) ? x.slots : []).filter(s => SLOT_NAMES.indexOf(s) >= 0),
      auto: true,
      src: x.src || null,
    });
  }
  console.log('  并入演讲案例 ' + nSpeech + ' 条（候选 ' + raw.length + ' 条，去重后）');
}

/* 「逐字可引」不能只因为有 loc 就算数：真去把那一段取出来，看这句话在不在里面。
   概述式、转述式的档案文字会被这里筛掉，分身就不可能拿它冒充原话。
   演讲案例没有信件 loc，走另一条判据：这份是逐字稿（verbatim）才许逐字引用。 */
for (const c of cases) {
  if (c.src && c.src.kind === 'speech') {
    c.judgment_verbatim = !!c.judgment_verbatim && c.src.fid === 'verbatim';
    continue;
  }
  if (!c.quote_locs.length) { c.judgment_verbatim = false; continue; }
  const loc = c.quote_locs[0];
  const blk = L[loc.l] && L[loc.l].blocks[loc.b];
  const bt = ((blk && blk.t) || '').replace(/\s+/g, ' ').trim();
  const j = String(c.judgment || '').replace(/\s+/g, ' ').trim();
  const probe = j.replace(/^[“"「『]|[”"」』]$/g, '').slice(0, 18);
  c.judgment_verbatim = probe.length >= 8 && bt.indexOf(probe) >= 0;
}

const byKind = {};
for (const c of cases) byKind[c.kind] = (byKind[c.kind] || 0) + 1;

const meta = {
  generated_at: new Date().toISOString(),
  persona: 'buffett',
  total: cases.length,
  by_kind: byKind,
  by_src: { letters: cases.length - nSpeech, speech: nSpeech },
  with_loc: cases.filter(c => c.quote_locs.length > 0).length,
  verbatim_ok: cases.filter(c => c.judgment_verbatim).length,
  slots_auto: cases.filter(c => c.auto).length,
  slot_rules: SLOT_RULES,
  note: 'slots 是机器初值（auto=true 表示未人工核）；judgment_verbatim=false 的条目不得作为逐字引用。'
};

const out = path.join(SITE, 'data-cases.js');
fs.writeFileSync(out, 'window.CASES = ' + JSON.stringify({ meta, cases }) + ';\n', 'utf8');
console.log('写出 ' + out);
console.log('  案例 ' + meta.total + ' 条：' + JSON.stringify(byKind));
console.log('  能点回原信 ' + meta.with_loc + ' 条，其中逐字可引 ' + meta.verbatim_ok + ' 条');
console.log('  机器初值待人工核 ' + meta.slots_auto + ' 条');
console.log('  原信段落 ' + Object.values(BY_YEAR).reduce((a, x) => a + x.length, 0) + ' 段 / 信件 ' + C.meta.letters + ' 封');
