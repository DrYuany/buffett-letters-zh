/* 定位坐标校验
   判定标准不是"逐字相同"——概念档案里的引用常经改写/压缩，逐字比会大量误报。
   用 2-gram 重叠率衡量"定位到的段落与这条引用是否讲同一件事"：
     >=55% 高置信（几乎原文）
     35-55% 可用（改写但主题一致）
     <35%  可疑（很可能跳错了地方）
*/
const fs = require('fs'), vm = require('vm');
function lv(f, n) { const s = { window: {} }; vm.createContext(s); vm.runInContext(fs.readFileSync(f, 'utf8'), s); return s.window[n]; }
const L = lv('site/data-letters.js', 'LETTERS');
const C = lv('site/data-content.js', 'CONTENT');

const WS = /\s+/g, QCH = /[\u201c\u201d\u2018\u2019"'\u300c\u300d\u300e\u300f]/g;
const norm = s => String(s).replace(QCH, '').replace(WS, '');
function blockText(b) {
  if (!b) return '';
  if (b.k === 't') return (b.head || []).join(' ') + ' ' + (b.rows || []).map(r => r.join(' ')).join(' ');
  return b.t || '';
}
function grams(s) {
  const out = new Set();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}
function overlap(a, b) {
  if (!a.length) return 1;
  const B = grams(b);
  let hit = 0;
  a.forEach(g => { if (B.has(g)) hit++; });
  return hit / a.size;
}

let total = 0, missLetter = 0, missBlock = 0;
let hi = 0, ok = 0, bad = 0;
const worst = [];
function check(label, loc, text) {
  if (!loc) return;
  total++;
  const v = L[loc.l];
  if (!v) { missLetter++; return; }
  const blk = v.blocks[loc.b];
  if (!blk) { missBlock++; return; }
  const src = norm(text || '');
  if (src.length < 10) { ok++; return; }
  const r = overlap(grams(src), norm(blockText(blk)));
  if (r >= 0.55) hi++;
  else if (r >= 0.35) ok++;
  else { bad++; if (worst.length < 10) worst.push({ label, loc, r, src: (text || '').slice(0, 40), got: blockText(blk).slice(0, 44) }); }
}

(C.corrections || []).forEach(c => check('认错 ' + c.y, c.loc, c.t));
Object.keys(C.concepts || {}).forEach(n => (C.concepts[n].quotes || []).forEach(q => check('原话 ' + n + ' ' + q.y, q.loc, q.t)));
Object.keys(C.companies || {}).forEach(n => (C.companies[n].timeline || []).forEach(t => check('时间线 ' + n + ' ' + t.y, t.loc, t.note)));
(C.rules || []).forEach(r => check('规则 ' + r.src + ' ' + r.y, r.loc, r.t));
Object.keys(C.scorecards || {}).forEach(n => (C.scorecards[n].timeline || []).forEach(t => check('卡片 ' + n + ' ' + t.y, t.loc, t.t)));

console.log('=== 定位坐标校验（2-gram 重叠）===');
console.log('带坐标条目: ' + total + '   信件缺失: ' + missLetter + '   块越界: ' + missBlock);
console.log('  高置信 >=55% : ' + hi + '  (' + (100 * hi / total).toFixed(1) + '%)');
console.log('  可用 35-55%  : ' + ok + '  (' + (100 * ok / total).toFixed(1) + '%)');
console.log('  可疑 <35%    : ' + bad + '  (' + (100 * bad / total).toFixed(1) + '%)');
console.log('  可用合计     : ' + (100 * (hi + ok) / total).toFixed(1) + '%');
if (worst.length) {
  console.log('\n最差样例:');
  worst.forEach(w => console.log('  [' + w.label + '] ' + (w.r * 100).toFixed(0) + '%  ' + w.loc.l + ' #' + w.loc.b +
    '\n     引用: ' + w.src + '\n     段落: ' + w.got));
}
