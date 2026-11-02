/* 检索速度实测：直接用 agent.js 里那段检索代码（切片vm加载，不重写一份，免得测的不是真代码）
   用法：node _bench_search.js */
const fs = require('fs'), vm = require('vm'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, 'agent.js'), 'utf8');
/* 只取「语料加载 + 检索」那一段：到工具定义之前为止，这样不会把服务器也起起来 */
const cut = src.indexOf('/* ---------------- 工具 ----------------');
const ctx = { require, console, module: {}, process, __dirname };
vm.createContext(ctx);
/* const/let 在 vm 里是词法绑定，不会挂到上下文对象上，所以末尾补一句导出 */
vm.runInContext(src.slice(0, cut) + '\n;globalThis.__exp = { DOCS, searchDocs, C };', ctx,
  { filename: 'agent-search-slice.js' });
const { DOCS, searchDocs, C } = ctx.__exp;

const QS = ['护城河', '内在价值怎么算', '什么时候回购股票', '他犯过什么错误',
  '保险浮存金', '可口可乐', '安全边际', '他怎么看通胀', '1974 年他为什么抄底',
  '管理层该不该考核', '纺织业务的教训', '收购的标准是什么', '他怎么看科技公司',
  '股东信里最常说的原则', '德克斯特鞋业', '不借钱买股票', '现金太多怎么办'];

console.log('语料：' + DOCS.length + ' 段 / ' + C.meta.letters + ' 封信 / ' +
  Math.round(C.meta.chars / 10000) + ' 万字\n');
const ts = [];
for (const q of QS) {
  const t0 = process.hrtime.bigint();
  const r = searchDocs(q, { k: 6 });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  ts.push(ms);
  console.log((ms.toFixed(1) + ' ms').padStart(10) + '  ' +
    String(r.length).padStart(2) + ' 段命中   问：「' + q + '」' +
    (r[0] ? '  →  ' + r[0].y + ' 年第 ' + r[0].b + ' 段' : '  → 没命中'));
}
ts.sort((a, b) => a - b);
console.log('\n中位 ' + ts[Math.floor(ts.length / 2)].toFixed(0) + ' ms · 最快 ' +
  ts[0].toFixed(0) + ' ms · 最慢 ' + ts[ts.length - 1].toFixed(0) + ' ms（' + QS.length + ' 个问题，冷缓存）');
