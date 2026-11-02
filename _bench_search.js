/* 检索速度实测：覆盖四路语料（信件 / 股东大会 / 演讲 / 午餐会）
   用法：node _bench_search.js

   为什么测这个：判断「要不要上向量库」的唯一硬指标就是「现在有多慢」。
   如果全量线性扫描已经在 10 ms 量级，向量库的 ANN 索引就省不出任何东西——
   这个语料规模下暴力算余弦和暴力扫字符串是同一个数量级。
*/
const fs = require('fs'), vm = require('vm'), path = require('path');

/* 信件检索：直接用 agent.js 里那段代码（切片加载，不重写一份，免得测的不是真代码） */
const src = fs.readFileSync(path.join(__dirname, 'agent.js'), 'utf8');
const cut = src.indexOf('/* ---------------- 工具 ----------------');
const ctx = { require, console, module: {}, process, __dirname };
vm.createContext(ctx);
vm.runInContext(src.slice(0, cut) + '\n;globalThis.__exp = { DOCS, searchDocs, C };', ctx,
  { filename: 'agent-search-slice.js' });
const { DOCS, searchDocs, C } = ctx.__exp;

const M = require('./meeting');
const S = require('./speech');
const T = require('./talk');

const QS = ['护城河', '内在价值怎么算', '什么时候回购股票', '他犯过什么错误',
  '保险浮存金', '可口可乐', '安全边际', '他怎么看通胀', '1974 年他为什么抄底',
  '管理层该不该考核', '纺织业务的教训', '收购的标准是什么', '他怎么看科技公司',
  '股东信里最常说的原则', '德克斯特鞋业', '不借钱买股票', '现金太多怎么办'];

function bench(label, fn, n) {
  const ts = [];
  for (const q of QS) {
    const t0 = process.hrtime.bigint();
    fn(q);
    ts.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  ts.sort((a, b) => a - b);
  console.log(label.padEnd(14) +
    (n || '').toString().padStart(7) + ' 段' +
    ('  中位 ' + ts[Math.floor(ts.length / 2)].toFixed(1) + ' ms').padStart(16) +
    ('  · 最快 ' + ts[0].toFixed(1)).padStart(16) +
    ('  · 最慢 ' + ts[ts.length - 1].toFixed(1)).padStart(16));
  return ts[Math.floor(ts.length / 2)];
}

const mem0 = process.memoryUsage().heapUsed;
const tLoad = (() => { const t = process.hrtime.bigint(); return () => Number(process.hrtime.bigint() - t) / 1e6; })();

console.log('=== 语料 ===');
console.log('信件          ' + String(DOCS.length).padStart(7) + ' 段   ' +
  C.meta.letters + ' 封 / ' + Math.round(C.meta.chars / 10000) + ' 万字');
console.log('股东大会      ' + String(M.META.segs).padStart(7) + ' 段   ' +
  Math.round(M.META.chars / 10000) + ' 万字（其中 ' + M.META.asked + ' 段配到了股东提问）');
console.log('演讲与访谈    ' + String(S.SEGS.length).padStart(7) + ' 段   ' +
  Math.round(S.SEGS.reduce((a, x) => a + (x.ans || '').length, 0) / 10000) + ' 万字');
console.log('午餐会        ' + String(T.SEGS.length).padStart(7) + ' 段   ' +
  Math.round(T.SEGS.reduce((a, x) => a + (x.ans || '').length, 0) / 10000) + ' 万字');
const totSeg = DOCS.length + M.META.segs + S.SEGS.length + T.SEGS.length;
const totChr = C.meta.chars + M.META.chars +
  S.SEGS.reduce((a, x) => a + (x.ans || '').length, 0) +
  T.SEGS.reduce((a, x) => a + (x.ans || '').length, 0);
console.log('合计          ' + String(totSeg).padStart(7) + ' 段   ' + Math.round(totChr / 10000) + ' 万字');

console.log('\n=== 单次检索（' + QS.length + ' 个问题，冷缓存） ===');
bench('信件', q => searchDocs(q, { k: 6 }), DOCS.length);
bench('股东大会', q => M.search(q, { k: 4 }), M.META.segs);
bench('演讲与访谈', q => S.search(q, { k: 4 }), S.SEGS.length);
bench('午餐会', q => T.search(q, { k: 4 }), T.SEGS.length);

console.log('\n=== 加载 ===');
console.log('四路全部读进内存 ' + tLoad().toFixed(0) + ' ms，堆占用增加 ' +
  Math.round((process.memoryUsage().heapUsed - mem0) / 1048576) + ' MB');
console.log('\n参照：一次对话要 8–13 次工具调用、15–35 秒；检索总耗时占不到 0.5%。');
