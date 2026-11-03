/* 路由判分器：直测四桶分类（classifyBucket / triageMode）对不对，不跑整个 agent。
 *
 *   为什么要单独建：四桶路由是每次提问的必经之路，路由错了答案就错；
 *   但它本身没进评测——judgment/quote 的判分器只管答案，lookup/chat 连答案判分都没有。
 *   这个脚本是"链路评测"的第一环：意图路由。
 *
 *   两层：
 *     triageMode（正则降级，纯本地，免费）—— 永远跑。它只有 archive/simulate 两个出口，
 *       所以 lookup/chat 的探针在这里必然全错，正好把"正则兜不住四桶"量化出来。
 *     classifyBucket（LLM 分类，要 key，一次 flash 调用）—— 有 key 才跑。
 *
 *   用法：
 *     node eval/route.js               跑 regex 层（免费）；有 key 自动加跑 classifier 层
 *     node eval/route.js --regex-only  只跑 regex 层，不碰 DeepSeek
 *
 *   判据（gold）来自 cases-route.jsonl，每条人工标了期望桶。改四桶路由的判据/rubric，
 *   就得同步改这里的探针——两处必须对得上，和 check_sim 的"改提示词就改判据"是一个道理。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const ROUTE_FILE = path.join(__dirname, 'cases-route.jsonl');

/* ---------------- 抽出 agent.js 里的分类函数（与线上同一份，不另写） ---------------- */
const src = fs.readFileSync(path.join(ROOT, 'agent.js'), 'utf8');
/* 截掉底部 server.listen / module.exports，避免 vm 里真的起服务 */
const cut = src.indexOf('/* 绑定地址：本机跑只听');
const body = cut >= 0 ? src.slice(0, cut) : src;
/* 让 agent.js 里的相对 require（./market 等）解析到项目根，而不是 route.js 所在的 eval/。
   否则 vm 里 market.js 加载失败、打印一堆无关警告。启动日志静默，只留 error。 */
const realRequire = require;
const patchedRequire = p => (p && p.startsWith('./') ? realRequire(path.join(ROOT, p)) : realRequire(p));
const quiet = { log: () => {}, warn: () => {}, error: console.error.bind(console) };
const ctx = { require: patchedRequire, console: quiet, module: {}, process, __dirname: ROOT };
vm.createContext(ctx);
vm.runInContext(body + '\n;globalThis.__exp = { classifyBucket, triageMode, BUCKETS };', ctx, { filename: 'agent-slice.js' });
const { classifyBucket, triageMode, BUCKETS } = ctx.__exp;

/* triageMode 只返回 archive/simulate，映射到四桶 */
const TRIAGE_MAP = { archive: 'quote', simulate: 'judgment' };

/* ---------------- 读 key（同 run_batch.js） ---------------- */
async function readKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY.trim();
  for (const f of [path.join(ROOT, '_agent.key'), path.join(os.homedir(), '.buffett-agent.key')]) {
    try { const v = (await fs.promises.readFile(f, 'utf8')).trim(); if (v) return v; } catch (e) {}
  }
  return null;
}

function loadCases() {
  return fs.readFileSync(ROUTE_FILE, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
}

/* ---------------- 逐条判 ---------------- */
async function main() {
  const cases = loadCases();
  if (!cases.length) { console.error('没有路由探针，先写 cases-route.jsonl'); process.exit(1); }
  const regexOnly = process.argv.indexOf('--regex-only') >= 0;
  const key = regexOnly ? null : await readKey();

  /* 先统计 gold 分布，让下面的混淆矩阵能对齐桶名 */
  const bucketOrder = (BUCKETS && BUCKETS.length) ? BUCKETS.slice() : ['judgment', 'quote', 'lookup', 'chat'];
  const conf = {};
  bucketOrder.forEach(b => { conf[b] = { n: 0, hit: 0, miss: [] }; });

  let okRegex = 0, okCls = 0, nCls = 0;

  console.log('路由探针 ' + cases.length + ' 条 · regex 层' + (key ? ' + classifier 层' : '（无 key，只跑 regex）'));
  console.log('');

  for (const c of cases) {
    const g = conf[c.gold];
    if (!g) { console.log('⚠ ' + c.id + ' gold=' + c.gold + ' 不在四桶里'); continue; }
    g.n++;

    /* 层 1：triageMode（免费） */
    const triRaw = triageMode(c.q, 'archive');
    const tri = TRIAGE_MAP[triRaw] || triRaw;
    if (tri === c.gold) { g.hit++; okRegex++; }
    else g.miss.push(c.id + ' regex→' + tri + '：' + c.q);

    /* 层 2：classifyBucket（要 key） */
    if (key) {
      let cls = null, err = '';
      try { cls = await classifyBucket(c.q, 'archive', key); }
      catch (e) { cls = '（分类器失败）'; err = e.message.slice(0, 30); }
      if (cls === c.gold) okCls++;
      else console.log('✗ ' + c.id + ' 期望 ' + c.gold + ' · regex→' + tri + ' · classifier→' + cls +
        (err ? '（' + err + '）' : '') + ' · ' + c.q);
      nCls++;
    }
  }

  /* ---------------- 汇总 ---------------- */
  const pct = (n, d) => d ? (n / d * 100).toFixed(1) + '%' : '—';
  console.log('');
  console.log('================ regex 层（免费，只有 quote/judgment 两个出口） ================');
  console.log('总准确率 ' + pct(okRegex, cases.length) + '（' + okRegex + '/' + cases.length + '）');
  bucketOrder.forEach(b => {
    const g = conf[b];
    if (!g.n) return;
    console.log('  ' + b.padEnd(10) + pct(g.hit, g.n) + '（' + g.hit + '/' + g.n + '）');
  });
  if (key) {
    console.log('');
    console.log('================ classifier 层（LLM，四桶） ================');
    console.log('总准确率 ' + pct(okCls, nCls) + '（' + okCls + '/' + nCls + '）');
  }
  console.log('');
  console.log('漏判明细（regex 层，lookup/chat 的探针会在这里全军覆没——这是预期，不是 bug）：');
  bucketOrder.forEach(b => {
    const g = conf[b];
    if (g.miss.length) g.miss.forEach(m => console.log('  - ' + m));
  });
}

main().catch(e => { console.error(e); process.exit(1); });
