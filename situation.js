/* 情形匹配：把「今天发生的一件事」对到历史上结构相近的旧判断。
   零依赖，两条用法：
     node situation.js "今天某白酒龙头业绩暴雷，股价跌停"      命令行试跑
     const { match } = require('./situation');  match(q, {k:5})  给 agent.js 当工具用

   检索沿用项目约定：中文 n-gram + tf-idf 字面粗召回，再用情形槽位命中数加权，
   不上向量库。返回的历史案例都带 quote_locs，能点回原信某一段。
*/
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadCases() {
  const ctx = { window: {}, console };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'site', 'data-cases.js'), 'utf8'), ctx);
  return ctx.window.CASES;
}
const DATA = loadCases();
const CASES = DATA.cases;
const SLOT_RULES = DATA.meta.slot_rules;

const TSTOP = '的了吗呢吧啊呀么怎你您我他她它这那有是会就要能可以什么为如何请告诉一下说说讲讲看想觉得把被让给对从到和与跟更最很太都也还又再就才只请您多少几个';
function terms(q) {
  const out = [], seen = {};
  const add = (g, w) => { if (!g || seen[g]) return; seen[g] = 1; out.push({ g, w }); };
  String(q).replace(/[^\u4e00-\u9fa5A-Za-z0-9]+/g, ' ').split(/\s+/).forEach(run => {
    if (!run) return;
    if (/^[A-Za-z0-9]+$/.test(run)) { add(run.toLowerCase(), 2); return; }
    const n = run.length;
    if (n >= 2 && n <= 8) add(run, 3);
    for (let i = 0; i + 2 <= n; i++) {
      const bg = run.slice(i, i + 2);
      if (TSTOP.indexOf(bg[0]) < 0 && TSTOP.indexOf(bg[1]) < 0) add(bg, 1.2);
    }
    for (let j = 0; j + 3 <= n; j++) {
      const tg = run.slice(j, j + 3);
      if (TSTOP.indexOf(tg[0]) < 0 && TSTOP.indexOf(tg[2]) < 0) add(tg, 2);
    }
  });
  return out;
}

function textOf(c) {
  return [c.situation, c.judgment, c.outcome, c.lesson, (c.tags || []).join(' '), c.entity].join(' ');
}
const TEXTS = CASES.map(textOf);

function slotsOfQuery(q) {
  const out = [];
  for (const [name, words] of SLOT_RULES) {
    for (const w of words) if (q.indexOf(w) >= 0) { out.push(name); break; }
  }
  return out;
}

const KIND_W = { scorecard: 1.3, rule: 0.8, correction: 1.1 };

/* 情形的方向：市场恐慌（冷）与市场亢奋（热）是相反的两类事。
   字面检索分不清方向，召回一堆「低估时买」来回答「高位该怎么办」会误导分身，
   所以显式算出来并标成反向对照，交给 prompt 层去处理。 */
function polarity(slots) {
  const has = a => a.some(x => slots.indexOf(x) >= 0);
  const hot = has(['市场过热']), cold = has(['市场大跌']);
  if (hot && !cold) return 1;
  if (cold && !hot) return -1;
  return 0;
}

function match(query, opts) {
  opts = opts || {};
  const k = opts.k || 5;
  const q = String(query || '');
  const ts = terms(q);
  const qs = slotsOfQuery(q);
  const qpol = polarity(qs);
  const N = CASES.length;
  const df = {};
  for (const tm of ts) {
    const g = tm.g;
    if (df[g] != null) continue;
    let n = 0;
    for (let i = 0; i < N; i++) if (TEXTS[i].indexOf(g) >= 0) n++;
    df[g] = n;
  }
  const out = [];
  for (let i = 0; i < N; i++) {
    const c = CASES[i], t = TEXTS[i];
    let s = 0;
    for (const tm of ts) {
      const p = t.indexOf(tm.g);
      if (p < 0) continue;
      const idf = Math.log(1 + N / (df[tm.g] + 1));
      let cnt = 0, at = p;
      while (at >= 0 && cnt < 4) { cnt++; at = t.indexOf(tm.g, at + tm.g.length); }
      s += idf * tm.w * (1 + Math.log(cnt));
    }
    s = s / (1 + Math.log(1 + t.length / 150));
    const hit = (c.slots || []).filter(x => qs.indexOf(x) >= 0);
    s += hit.length * 3.2;
    /* 一个情形格子都没对上，多半只是字面撞词，不是真的情形相似 */
    if (qs.length && !hit.length) s *= 0.4;
    const opposite = qpol !== 0 && polarity(c.slots || []) !== 0 && polarity(c.slots || []) !== qpol;
    if (opposite) s *= 0.7;
    s *= KIND_W[c.kind] || 1;
    if (c.quote_locs.length) s += 0.15;
    if (s <= 0) continue;
    out.push({
      id: c.id, y: c.y, kind: c.kind, score: +s.toFixed(3), slots_hit: hit, opposite,
      situation: c.situation, judgment: c.judgment.slice(0, 170),
      verbatim: c.judgment_verbatim, loc: c.quote_locs[0] || null,
      outcome: (c.outcome || '').slice(0, 100), verdict: c.verdict || ''
    });
  }
  out.sort((a, b) => b.score - a.score);
  return { slots: qs, polarity: qpol, total: N, top: out.slice(0, k) };
}

module.exports = { match, CASES, DATA };

if (require.main === module) {
  const args = process.argv.slice(2);
  const ki = args.indexOf('--k');
  const k = ki >= 0 ? +args[ki + 1] || 5 : 5;
  const q = ki >= 0 ? args.filter((a, i) => i !== ki && i !== ki + 1).join(' ') : args.join(' ');
  if (!q) { console.log('用法：node situation.js "今天发生的一件事" [--k 5]'); process.exit(0); }
  const r = match(q, { k });
  console.log('事件：' + q);
  console.log('情形卡（机器初值）：' + (r.slots.join(' · ') || '（没抽到，需人工补）'));
  console.log('在 ' + r.total + ' 条历史判断里匹配，前 ' + r.top.length + ' 条：\n');
  r.top.forEach((x, i) => {
    console.log('[' + (i + 1) + '] ' + x.id + ' · ' + x.y + ' 年 · ' + x.kind + ' · 分 ' + x.score +
      ' · 槽位命中：' + (x.slots_hit.join('/') || '无') + (x.opposite ? ' · [反向对照]' : ''));
    if (x.situation) console.log('    当时：' + x.situation.slice(0, 90));
    if (x.judgment) console.log('    他说：' + x.judgment.slice(0, 110));
    console.log('    出处：' + (x.loc ? x.loc.l + ' 第 ' + x.loc.b + ' 段' : '未定位') +
      (x.verbatim ? '（逐字可引）' : '（仅作情形材料，不得逐字引用）'));
    if (x.outcome) console.log('    后来：' + x.outcome.slice(0, 90));
    console.log('');
  });
}
