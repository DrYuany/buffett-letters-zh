/* 生成金标评测集（cases-gold.jsonl）
   金标不用人工标注：概念档案、公司轨迹、认错档案、实体跨年出处里都自带 loc
   （哪封信、第几段），那就是标准答案。
   这层只测检索，不跑模型 —— 一条 case 一次 searchDocs，2-22 ms，零 token 成本。

   用法：node eval/gen_cases.js    （改了语料后重跑即可，编号稳定）
*/
const fs = require('fs'), vm = require('vm'), path = require('path');

/* 语料直接复用 agent.js 的那段加载与切分代码（切片到工具定义之前），
   这样 DOCS 的口径和线上检索一模一样 —— 不另写一份，免得评测测的不是真东西。 */
const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'agent.js'), 'utf8');
const ctx = { require, console, module: {}, process, __dirname: ROOT };
vm.createContext(ctx);
vm.runInContext(src.slice(0, src.indexOf('/* ---------------- 工具 ----------------')) +
  '\n;globalThis.__exp = { C, L, CT, DOCS, searchDocs };', ctx, { filename: 'agent-search-slice.js' });
const { C, CT, L, DOCS } = ctx.__exp;

/* 出处必须真的存在：档案里的 loc 可能指向被过滤掉的短段落 */
const ok = (l, b) => !!(L[l] && L[l].blocks[b]);
const key = (l, b) => l + '|' + b;

/* 同一个 q 可能从多处拿到金标（比如"可口可乐"既有实体出处又有公司轨迹），
   合并而不是覆盖 —— 金标越全，召回率才不会被低估。 */
const byQ = {};
function addCase(q, kind, gold, extra) {
  if (!q || !gold.length) return;
  let c = byQ[q];
  if (!c) {
    c = byQ[q] = { layer: 'gold', q: q, kinds: [], gold: [], expect_tools: [], src: [] };
    Object.assign(c, extra || {});
  }
  if (c.kinds.indexOf(kind) < 0) c.kinds.push(kind);
  if (c.src.indexOf(kind) < 0) c.src.push(kind);
  const seen = {};
  c.gold.forEach(g => { seen[key(g[0], g[1])] = 1; });
  gold.forEach(g => { if (ok(g[0], g[1]) && !seen[key(g[0], g[1])]) { seen[key(g[0], g[1])] = 1; c.gold.push([g[0], g[1]]); } });
  (extra && extra.expect_tools || []).forEach(t => { if (c.expect_tools.indexOf(t) < 0) c.expect_tools.push(t); });
}

/* 1. 实体跨年出处：mentions[name] = [[年份, 段号, 信件id], …] */
Object.keys(C.mentions).sort().forEach(name => {
  const ms = C.mentions[name];
  if (ms.length < 5) return;
  addCase(name, 'entity', ms.map(m => [m[2], m[1]]));
});

/* 2. 公司轨迹：timeline[].loc 是他每年提这家公司的原段落 */
Object.keys(CT.companies).sort().forEach(name => {
  const tl = CT.companies[name].timeline || [];
  if (tl.length < 3) return;
  addCase(name, 'company', tl.filter(t => t.loc).map(t => [t.loc.l, t.loc.b]));
});

/* 3. 概念档案里的原话出处 */
Object.keys(CT.concepts).sort().forEach(name => {
  const qs = (CT.concepts[name].quotes || []).filter(q => q.loc);
  if (qs.length < 2) return;
  addCase(name, 'concept', qs.map(q => [q.loc.l, q.loc.b]), { expect_tools: ['search_letters'] });
});

/* 4. 认错档案：这类题的期望路径是调 corrections 而不是硬检索。
   分组用 ent 字段（收得比正文关键词准），再补一组按类型（认错/改口/教训） */
const CORR = CT.corrections || [];
const entCount = {};
CORR.forEach(c => { const e = (c.ent || '').trim(); if (e) entCount[e] = (entCount[e] || 0) + 1; });
Object.keys(entCount).filter(e => entCount[e] >= 2).sort().forEach(e => {
  const list = CORR.filter(c => (c.ent || '').trim() === e);
  addCase('他在' + e + '上承认过的错', 'correction',
    list.filter(c => c.loc).map(c => [c.loc.l, c.loc.b]), { expect_tools: ['corrections'] });
});
const KINDQ = { error: '他犯过哪些错误', admit: '他公开承认过什么', reverse: '他后来改口过的事', lesson: '他总结过什么教训' };
Object.keys(KINDQ).sort().forEach(k => {
  const list = CORR.filter(c => c.k === k);
  if (list.length < 5) return;
  addCase(KINDQ[k], 'correction', list.filter(c => c.loc).map(c => [c.loc.l, c.loc.b]),
    { expect_tools: ['corrections'] });
});

/* 5. 跨年对比题：同一个实体问他早年和晚年的说法，金标限定年份区间 */
const SPANS = [[1956, 1969, '合伙人时期'], [1970, 1989, '七八十年代'], [1990, 2009, '九十年代到金融危机'], [2010, 2025, '近十五年']];
['内在价值', '回购', '安全边际', '保险', '收购'].forEach(name => {
  const ms = C.mentions[name] || [];
  if (ms.length < 10) return;
  SPANS.forEach(sp => {
    const gold = ms.filter(m => m[0] >= sp[0] && m[0] <= sp[1]).map(m => [m[2], m[1]]);
    if (gold.length < 2) return;
    addCase(`${sp[2]}（${sp[0]}-${sp[1]}）他怎么讲${name}？`, 'span',
      gold, { year_from: sp[0], year_to: sp[1] });
  });
});

/* 输出：按 kind + q 排序，编号稳定，改语料重跑不会整片错位 */
const cases = Object.keys(byQ).sort().map(q => byQ[q])
  .sort((a, b) => a.kinds.join().localeCompare(b.kinds.join()) || a.q.localeCompare(b.q))
  .map((c, i) => {
    const years = {};
    c.gold.forEach(g => { years[(L[g[0]] || {}).year] = 1; });
    /* 这个词在语料里到底出没出现过？
       「可口可乐」出现过 → 字面检索该命中，召回差就是检索的问题；
       「股东导向」是人工分类的主题标签，原文里没有这几个字；
       「伊藤忠商事」原文用的是简称「伊藤忠」→ 名称变体。
       后两种字面检索都召不回，得靠别名表或人工档案，不该拿它们给检索打低分，
       所以单独标出来分开统计（needs_alias）。 */
    let corpusHits = 0;
    for (const d of DOCS) if (d.t.indexOf(c.q) >= 0) corpusHits++;
    return {
      id: 'gold-' + String(i + 1).padStart(3, '0'),
      layer: 'gold',
      kinds: c.kinds,
      q: c.q,
      corpus_hits: corpusHits,
      needs_alias: corpusHits === 0,
      n_gold: c.gold.length,
      gold_years: Object.keys(years).map(Number).sort(),
      gold: c.gold,
      expect_tools: c.expect_tools.length ? c.expect_tools : ['search_letters'],
      year_from: c.year_from, year_to: c.year_to,
      src: c.src
    };
  });

const out = path.join(__dirname, 'cases-gold.jsonl');
fs.writeFileSync(out, cases.map(c => JSON.stringify(c)).join('\n') + '\n', 'utf8');

const stat = {};
cases.forEach(c => c.kinds.forEach(k => { stat[k] = (stat[k] || 0) + 1; }));
console.log('金标评测集：' + cases.length + ' 条 → ' + out);
console.log('分布：' + Object.keys(stat).map(k => k + ' ' + stat[k]).join(' · '));
console.log('金标段落合计 ' + cases.reduce((s, c) => s + c.n_gold, 0) + ' 段');
