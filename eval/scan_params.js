/* 检索评分参数扫描：把 searchDocs 的表格块相关参数扫一遍，找「表格块排名系统性偏低」的最优解。

 * 用法：node eval/scan_params.js
 *
 * 只扫 corpus==='letter' 的考据标注 case（eval/cases-annotation.jsonl），
 * 对 tblBonus × tblNoPunct × lenCoef 三组参数跑网格，算 recall@4 / recall@6 / MRR，
 * 与 eval/score_annotation.js 同源（vm 切片加载 agent.js 里的真 searchDocs）。
 *
 * 「最佳」判定分两档：
 *   - 严格最佳：按 (recall@4 ↓, recall@6 ↓, MRR ↓) 字典序取第一。
 *   - 无回退最佳：在同等 recall@4/6 的前提下，剔除「任何一题 MRR 回退」的组合后取 MRR 最高。
 *     后者才是真正「修表格块而不劣化」的推荐值（见 agent.js 默认值）。
 */
const fs = require('fs'), path = require('path'), vm = require('vm');

const ROOT = path.join(__dirname, '..');
const FILE = path.join(__dirname, 'cases-annotation.jsonl');

/* 与 score_annotation.js 的 loadLetter() 完全一致：切到「工具」标记之前，静音 console。 */
function loadLetter() {
  const src = fs.readFileSync(path.join(ROOT, 'agent.js'), 'utf8');
  const cut = src.indexOf('/* ---------------- 工具 ----------------');
  const silent = { log() {}, error() {}, warn() {}, info() {} };
  const ctx = { require, console: silent, module: {}, process, __dirname: ROOT };
  vm.createContext(ctx);
  vm.runInContext(src.slice(0, cut) + '\n;globalThis.__exp = { DOCS, searchDocs, C, L };', ctx,
    { filename: 'agent-search-slice.js' });
  return ctx.__exp;
}
const { DOCS, searchDocs, C } = loadLetter();

const KS = [4, 6];
const EPS = 1e-6;

function loadCases() {
  return fs.readFileSync(FILE, 'utf8').split('\n')
    .map(l => l.trim()).filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } })
    .filter(c => c && c.corpus === 'letter');
}

/* 对单个 case 在给定参数下算各 k 的 recall 与 MRR（kmax 用最大的 k）。 */
function scoreCase(c, params, textsByK) {
  const gold = c.gold || [];
  const out = { id: c.id, n_gold: gold.length, per_k: {} };
  for (const k of KS) {
    const texts = textsByK[k];
    let hits = 0, mrrSum = 0;
    for (const g of gold) {
      let rank = 0;
      for (let i = 0; i < texts.length; i++) {
        if (texts[i].indexOf(g.probe) >= 0) { rank = i + 1; break; }
      }
      if (rank > 0) hits++;
      mrrSum += rank ? 1 / rank : 0;
    }
    const denom = Math.min(k, gold.length);
    out.per_k[k] = {
      recall: denom ? hits / denom : null,
      mrr: gold.length ? mrrSum / gold.length : null,
    };
  }
  const kmax = Math.max.apply(null, KS);
  out.mrr = out.per_k[kmax] ? out.per_k[kmax].mrr : null;
  return out;
}

function runSearchFor(c, params) {
  const byK = {};
  for (const k of KS) byK[k] = searchDocs(c.question, { k, ...params }).map(d => d.t || '');
  return byK;
}

function avg(arr, fn) {
  const v = arr.map(fn).filter(x => typeof x === 'number');
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

/* 跑一整组参数，返回汇总 + 每条 case 明细（items 按 id 索引）。 */
function evaluate(params, cases) {
  const items = cases.map(c => scoreCase(c, params, runSearchFor(c, params)));
  const byId = {}; items.forEach(it => { byId[it.id] = it; });
  const summary = {
    recall4: avg(items, it => it.per_k[4].recall),
    recall6: avg(items, it => it.per_k[6].recall),
    mrr: avg(items, it => it.mrr),
  };
  return { summary, items, byId };
}

/* 相对基线，该组合是否有任意一题的 recall@k 或 MRR 回退。 */
function degrades(base, cur) {
  for (const id in cur.byId) {
    const b = base.byId[id], c = cur.byId[id];
    if (!b) continue;
    for (const k of KS) {
      if (c.per_k[k].recall != null && b.per_k[k].recall != null &&
          c.per_k[k].recall < b.per_k[k].recall - EPS) return true;
    }
    if (c.mrr != null && b.mrr != null && c.mrr < b.mrr - EPS) return true;
  }
  return false;
}

function pct(x) { return x == null ? '—' : (x * 100).toFixed(1) + '%'; }
const fmtParam = p => `tblBonus=${p.tblBonus} tblNoPunct=${p.tblNoPunct} lenCoef=${p.lenCoef}`;

function main() {
  const cases = loadCases();
  if (!cases.length) { console.log('没有 letter 语料的标注 case，退出。'); return 0; }
  console.log('letter 标注 case 数：' + cases.length + '（语料 ' + DOCS.length + ' 段）');
  console.log('');

  const tblBonuses = [0, 0.35, 0.7];
  const tblNoPuncts = [false, true];
  const lenCoefs = [140, 200, 260];

  const baseline = evaluate({ tblBonus: 0, tblNoPunct: false, lenCoef: 140 }, cases);
  const rows = [];
  for (const tb of tblBonuses) for (const tn of tblNoPuncts) for (const lc of lenCoefs) {
    const params = { tblBonus: tb, tblNoPunct: tn, lenCoef: lc };
    const r = evaluate(params, cases);
    rows.push({ params, ...r.summary, degrade: degrades(baseline, r), byId: r.byId });
  }

  console.log('=== 扫描矩阵（letter 语料，' + rows.length + ' 组；★ = 无任何一题回退） ===');
  const cmp = (a, b) => (b.recall4 - a.recall4) || (b.recall6 - a.recall6) || (b.mrr - a.mrr);
  for (const r of rows.slice().sort(cmp)) {
    console.log(
      (r.degrade ? ' ' : '★') +
      ' ' + fmtParam(r.params).padEnd(40) +
      '  recall@4=' + pct(r.recall4).padStart(6) +
      '  recall@6=' + pct(r.recall6).padStart(6) +
      '  MRR=' + (r.mrr == null ? '—' : r.mrr.toFixed(3)));
  }

  const strictBest = rows.slice().sort(cmp)[0];
  const nonDegrade = rows.filter(r => !r.degrade).sort(cmp);
  const robustBest = nonDegrade[0];

  console.log('');
  console.log('=== 基线 vs 最佳 ===');
  console.log('基线（全默认）  ' + fmtParam({ tblBonus: 0, tblNoPunct: false, lenCoef: 140 }).padEnd(40) +
    ' recall@4=' + pct(baseline.summary.recall4) + ' recall@6=' + pct(baseline.summary.recall6) +
    ' MRR=' + baseline.summary.mrr.toFixed(3));
  console.log('严格最佳        ' + fmtParam(strictBest.params).padEnd(40) +
    ' recall@4=' + pct(strictBest.recall4) + ' recall@6=' + pct(strictBest.recall6) +
    ' MRR=' + strictBest.mrr.toFixed(3) + (strictBest.degrade ? '（含个别题 MRR 回退）' : ''));
  console.log('无回退最佳      ' + fmtParam(robustBest.params).padEnd(40) +
    ' recall@4=' + pct(robustBest.recall4) + ' recall@6=' + pct(robustBest.recall6) +
    ' MRR=' + robustBest.mrr.toFixed(3) + '  ← 推荐写进默认值');

  /* 逐题看：用无回退最佳对比基线，列出 recall@4 / MRR 有变化的题。 */
  console.log('');
  console.log('=== 逐题 recall@4 / MRR（基线 → 无回退最佳，只列有变化的） ===');
  for (const id in baseline.byId) {
    const b = baseline.byId[id], c = robustBest.byId[id];
    if (!c) continue;
    if (b.per_k[4].recall !== c.per_k[4].recall || Math.abs(b.mrr - c.mrr) > EPS) {
      console.log('  ' + id + '  r@4 ' + pct(b.per_k[4].recall) + ' → ' + pct(c.per_k[4].recall) +
        '   MRR ' + b.mrr.toFixed(3) + ' → ' + c.mrr.toFixed(3));
    }
  }
  const a15 = baseline.byId['ann-015'];
  if (a15) console.log('\nann-015（持仓表题）recall@4：' + pct(a15.per_k[4].recall) +
    ' → ' + pct(robustBest.byId['ann-015'].per_k[4].recall));

  console.log('');
  console.log('推荐默认值: ' + fmtParam(robustBest.params) +
    '  recall@4=' + pct(robustBest.recall4) + ' recall@6=' + pct(robustBest.recall6) +
    ' MRR=' + robustBest.mrr.toFixed(3));
  return 0;
}

process.exitCode = main();
