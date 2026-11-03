/* 考据类标注集评分脚本：读 eval/cases-annotation.jsonl，对每道题跑对应检索，
 * 算 recall@k / MRR。这是后面参数扫描和「要不要向量检索」的客观尺子。
 *
 *   用法：
 *     node eval/score_annotation.js --run-id smoke         算全部标注 case
 *     node eval/score_annotation.js --k 4,6                指定 k（默认 4,6）
 *     node eval/score_annotation.js --only ann-001,ann-002 只跑部分
 *
 * 三路检索与线上同源：
 *   - 信件 searchDocs：不 require('./agent.js')（会启动服务），改用 vm 切片法，
 *     把 agent.js 切到「工具」标记之前那段跑一遍，导出 searchDocs / DOCS / C / L。
 *   - 会议 require('../meeting').search(q,{k})，结果含 {ans,...}
 *   - 演讲 require('../speech').search(q,{k})，结果含 {ans,...}
 *
 * 命中判定：gold 的 probe（正文里一段有辨识度的子串）出现在 top-k 某条结果的
 *   正文里即命中一次（信件取 t，会议/演讲取 ans）。loc 只给人看，机器不用。
 *
 * 输出 eval/results/annotation-<run-id>.json。
 */
const fs = require('fs'), path = require('path'), vm = require('vm');

const ROOT = path.join(__dirname, '..');
const FILE = path.join(__dirname, 'cases-annotation.jsonl');
const RES_DIR = path.join(__dirname, 'results');

function arg(n, d) { const i = process.argv.indexOf('--' + n); return i >= 0 ? (process.argv[i + 1] || d) : d; }
const RUN_ID = arg('run-id', 'default');
const KS = arg('k', '4,6').split(',').map(s => +String(s).trim()).filter(n => Number.isFinite(n) && n > 0);
const ONLY = new Set(arg('only', '').split(',').map(s => String(s).trim()).filter(Boolean));

/* ---------------- 语料（与 agent/score.js 同源） ---------------- */

/* 信件检索：切片加载 agent.js 里那段真代码，不另写一份，免得测的不是真代码。
 * 切片里的 require('./meeting'|'./speech'|...) 相对本脚本（eval/）解析会失败，
 * 触发 agent.js 里一串「未找到××语料」的 catch 提示——那些模块我们用不到，
 * 数据本身是齐的，所以给切片一个静音 console，只保留 loadData 的真实报错。 */
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
const { DOCS, searchDocs, C, L } = loadLetter();
const M = require('../meeting');
const S = require('../speech');

/* 正文取法：probe 命中只看正文（letter 用 t，meeting/speech 用 ans）。 */
function runSearch(c, k) {
  if (c.corpus === 'letter') return searchDocs(c.question, { k }).map(d => d.t || '');
  if (c.corpus === 'meeting') return M.search(c.question, { k }).map(x => x.ans || '');
  if (c.corpus === 'speech') return S.search(c.question, { k }).map(x => x.ans || '');
  throw new Error('未知 corpus：' + c.corpus + '（id=' + c.id + '）');
}

/* probe 是否在对应语料里存在过（只做预警，不判分）：标错了 probe 就搜不到。 */
function probeExists(c, probe) {
  if (c.corpus === 'letter') return DOCS.some(d => d.t.indexOf(probe) >= 0);
  if (c.corpus === 'meeting') return M.SEGS.some(x => (x.ans || '').indexOf(probe) >= 0);
  if (c.corpus === 'speech') return S.SEGS.some(x => (x.ans || '').indexOf(probe) >= 0);
  return false;
}

/* ---------------- 单条 case 评分 ---------------- */
function scoreCase(c) {
  const gold = c.gold || [];
  const out = {
    id: c.id, corpus: c.corpus, question: c.question, n_gold: gold.length,
    probes: gold.map(g => ({ loc: g.loc, probe: g.probe,
      exists: probeExists(c, g.probe), ranks: {} })),
    per_k: {},
  };
  for (const k of KS) {
    const texts = runSearch(c, k);
    let hits = 0, mrrSum = 0;
    out.probes.forEach(p => {
      let rank = 0;
      for (let i = 0; i < texts.length; i++) {
        if (texts[i].indexOf(p.probe) >= 0) { rank = i + 1; break; }
      }
      p.ranks[k] = rank;
      if (rank > 0) hits++;
      mrrSum += rank ? 1 / rank : 0;
    });
    const denom = Math.min(k, gold.length);
    out.per_k[k] = {
      recall: denom ? +(hits / denom).toFixed(4) : null,
      mrr: gold.length ? +(mrrSum / gold.length).toFixed(4) : null,
      hits,
    };
  }
  /* 对外主报一个 MRR：用最大的 k 算（k 越大越有机会让 probe 落在真实排名上）。 */
  const kmax = Math.max.apply(null, KS);
  out.mrr = out.per_k[kmax] ? out.per_k[kmax].mrr : null;
  return out;
}

/* ---------------- 主流程 ---------------- */
function main() {
  if (!fs.existsSync(FILE)) {
    console.log('标注文件不存在：' + FILE);
    console.log('（没有考据标注集，无可评分，退出）');
    return 0;
  }
  const lines = fs.readFileSync(FILE, 'utf8').split('\n').map(l => l.trim()).filter(Boolean);
  if (!lines.length) {
    console.log('标注文件为空：' + FILE);
    return 0;
  }
  const cases = [];
  for (const line of lines) {
    try { cases.push(JSON.parse(line)); }
    catch (e) { console.log('（跳过无法解析的行：' + line.slice(0, 60) + '…）'); }
  }
  const sel = cases.filter(c => ONLY.size === 0 || ONLY.has(c.id));
  console.log('语料：信件 ' + DOCS.length + ' 段（' + C.meta.letters + ' 封）· 会议 ' +
    (M.META ? M.META.segs : 0) + ' 段 · 演讲 ' + S.SEGS.length + ' 段');
  console.log('run_id = ' + RUN_ID + ' · k = ' + KS.join(',') +
    ' · 标注 ' + cases.length + ' 条' + (ONLY.size ? '，只跑 ' + sel.length + ' 条' : ''));

  const items = sel.map(scoreCase);

  /* 打印每条 case 一行 */
  console.log('');
  for (const it of items) {
    const cols = KS.map(k => 'r@' + k + '=' + (it.per_k[k].recall === null ? '—' : it.per_k[k].recall.toFixed(3)));
    console.log(('  ' + it.id + ' [' + it.corpus + ']').padEnd(20) +
      cols.join('  ') + '   MRR=' + (it.mrr === null ? '—' : it.mrr.toFixed(3)) +
      '   ' + String(it.question || '').slice(0, 24));
  }

  /* probe 预警：标了语料里根本不存在的 probe */
  for (const it of items) {
    for (const p of it.probes) {
      if (!p.exists) console.log('  ⚠ ' + it.id + ' 的 probe「' + p.probe + '」在 ' + it.corpus + ' 语料里不存在，可能标错了');
    }
  }

  /* 汇总 */
  const avg = (arr, fn) => {
    const v = arr.map(fn).filter(x => typeof x === 'number');
    return v.length ? +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(4) : null;
  };
  const group = (arr) => {
    const g = { n: arr.length };
    for (const k of KS) {
      g['recall' + k] = avg(arr, it => it.per_k[k].recall);
    }
    g.mrr = avg(arr, it => it.mrr);
    return g;
  };
  const byCorpus = {};
  for (const it of items) (byCorpus[it.corpus] = byCorpus[it.corpus] || []).push(it);
  const summary = { all: group(items), by_corpus: {} };
  for (const c in byCorpus) summary.by_corpus[c] = group(byCorpus[c]);

  console.log('');
  const fmtG = (label, g) => {
    const cols = KS.map(k => 'recall@' + k + ' ' + pct(g['recall' + k]));
    console.log('  ' + label.padEnd(12) + cols.join(' · ') +
      '   MRR ' + (g.mrr === null ? '—' : g.mrr.toFixed(3)) + '   (n=' + g.n + ')');
  };
  fmtG('全部', summary.all);
  for (const c in summary.by_corpus) fmtG(c, summary.by_corpus[c]);

  const out = { run_id: RUN_ID, ts: Date.now(), k: KS, n_cases: cases.length,
    n_scored: items.length, items, summary };
  fs.mkdirSync(RES_DIR, { recursive: true });
  const fp = path.join(RES_DIR, 'annotation-' + RUN_ID + '.json');
  fs.writeFileSync(fp, JSON.stringify(out, null, 1), 'utf8');
  console.log('');
  console.log('结果 → ' + fp);
  return 0;
}

function pct(x) { return x === null ? '—' : (x * 100).toFixed(1) + '%'; }

process.exitCode = main();
