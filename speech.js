/* 公众演讲语料：大学演讲 + 媒体专访（1985-2025，中文）
   - 数据来自 site/data-speech.js（make_speech.js 生成）
   - 检索沿用项目约定：中文 n-gram + tf-idf 字面粗召回，不上向量库
   - 每条带 venue（场合）和 fid（可信度）：
       fid=verbatim 逐字稿，可以逐字引用
       fid=notes    凭笔记整理的转述，只能转述，不得逐字引用

   用法：
     node speech.js "怎么看科技股"          命令行试
     const S = require('./speech'); S.search(q, {k:4})
*/
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function load() {
  const file = path.join(__dirname, 'site', 'data-speech.js');
  if (!fs.existsSync(file)) return { meta: null, segs: [] };
  const ctx = { window: {}, console };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: 'data-speech.js' });
  return ctx.window.SPEECH || { meta: null, segs: [] };
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
const TEXT = SEGS.map(s => (s.venue || '') + ' ' + (s.ask || '') + ' ' + (s.ans || ''));
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
  const yr = opts.year || 0;
  const ts = terms(q);
  if (!ts.length || !SEGS.length) return [];
  const N = SEGS.length, scored = [];
  for (let i = 0; i < N; i++) {
    const s0 = SEGS[i];
    if (yr && s0.y > yr) continue;          /* 截断年份回测用：不说后来才知道的话 */
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

/* 风格样本：挑"答得不长、带口语标记、有具体物件"的。
   演讲比股东大会问答更讲究完整段落，所以下限放宽到 120 字。 */
function styleSamples(k) {
  const marks = /(你看|我是说|说白了|老实说|怎么说呢|你想想|对吧|其实|根本|没法|不知道|我错了|我们买|我们卖)/;
  const pool = SEGS.filter(s => s.fid === 'verbatim' && s.ans.length > 120 && s.ans.length < 300 && marks.test(s.ans));
  const out = [], seen = new Set();
  for (const s of pool) {
    const key = s.ans.slice(0, 12);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= (k || 3)) break;
  }
  return out;
}

/* 场合清单：给工具用，让分身能说清"我这是在哪儿说的" */
function venues() {
  return (DATA.meta && DATA.meta.venues) || [...new Set(SEGS.map(s => s.venue))].sort();
}

module.exports = { search, styleSamples, venues, SEGS, META: DATA.meta };

if (require.main === module) {
  const q = process.argv[2] || '怎么看科技股';
  search(q, { k: 3 }).forEach((x, i) => {
    console.log(`[${i + 1}] ${x.y} ${x.venue} [${x.fid}] 分 ${x.score}`);
    if (x.ask) console.log('  问：' + x.ask.slice(0, 100));
    console.log('  答：' + x.ans.slice(0, 240) + '\n');
  });
  console.log('语料段数', SEGS.length);
}
