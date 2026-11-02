/* 股东大会口语语料：检索 + 风格样本
   - 数据来自 site/data-talk.js（make_talk.js 生成）
   - 检索沿用项目约定：中文 n-gram + tf-idf 字面粗召回，不上向量库
   - 每条都是英文字幕的中译，所以对外一律标注「转述，不可逐字引用」

   用法：
     node talk.js "为什么不做预测"            命令行试
     const T = require('./talk'); T.search(q, {k:4})
*/
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function load() {
  const file = path.join(__dirname, 'site', 'data-talk.js');
  if (!fs.existsSync(file)) return { meta: null, segs: [] };
  const ctx = { window: {}, console };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: 'data-talk.js' });
  return ctx.window.TALK || { meta: null, segs: [] };
}
const DATA = load();
const SEGS = DATA.segs || [];

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
const TEXT = SEGS.map(s => (s.ask || '') + ' ' + (s.ans || ''));
const _df = {};
function df(g) {
  if (_df[g] != null) return _df[g];
  let c = 0;
  for (let i = 0; i < TEXT.length; i++) if (TEXT[i].indexOf(g) >= 0) c++;
  return (_df[g] = c);
}

function search(q, opts) {
  opts = opts || {};
  const k = opts.k || 4;
  const ts = terms(q);
  if (!ts.length || !SEGS.length) return [];
  const N = SEGS.length, scored = [];
  for (let i = 0; i < N; i++) {
    const t = TEXT[i];
    let s = 0;
    for (const tm of ts) {
      if (t.indexOf(tm.g) < 0) continue;
      const idf = Math.log(1 + N / (df(tm.g) + 1));
      s += idf * tm.w;
    }
    if (s > 0) scored.push({ i, s: s / (1 + Math.log(1 + t.length / 200)) });
  }
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, k).map(x => Object.assign({ score: +x.s.toFixed(2) }, SEGS[x.i]));
}

/* 风格样本：给提示词用。挑"有提问、答得不长、带口语标记"的几条当 few-shot 锚。
   不随机 —— 随机会抽到开会念议程那种段落，越学越像会议纪要。 */
function styleSamples(k) {
  const marks = /(你看|我是说|说白了|老实说|怎么说呢|你想想|对吧|其实|根本|没法|不知道)/;
  const pool = SEGS.filter(s => s.ask && s.ans && s.ans.length > 80 && s.ans.length < 260 && marks.test(s.ans));
  const out = [];
  const seen = new Set();
  for (const s of pool) {
    const key = s.ans.slice(0, 12);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= (k || 3)) break;
  }
  return out;
}

module.exports = { search, styleSamples, SEGS, META: DATA.meta };

if (require.main === module) {
  const q = process.argv[2] || '为什么不预测市场';
  search(q, { k: 3 }).forEach((x, i) => {
    console.log(`[${i + 1}] ${x.y} ${x.at ? '(' + x.at + 's)' : ''} 分 ${x.score}`);
    if (x.ask) console.log('  问：' + x.ask.slice(0, 100));
    console.log('  答：' + x.ans.slice(0, 220) + '\n');
  });
  console.log('语料条数', SEGS.length);
}
