/* 分身答案的机械判分：第二遍独立跑，不改判分逻辑就不用重烧模型的钱。
   用法：node eval/check_sim.js eval/traces/sim-001.json
   先看五件事：双区格式 / 引用能落地 / 引文逐字 / 推演区没冒充原话 / 推演挂了案例 id。
   机器判不了的（口吻像不像、推演合不合他的思路）交给人工或 judge，不在这里装懂。
*/
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SITE = path.join(__dirname, '..', 'site');
function loadLetters() {
  const ctx = { window: {}, console };
  vm.createContext(ctx);
  for (const f of ['data-core.js', 'data-letters.js']) {
    vm.runInContext(fs.readFileSync(path.join(SITE, f), 'utf8'), ctx, { filename: f });
  }
  return ctx.window.LETTERS;
}
const L = loadLetters();

const file = process.argv[2];
if (!file) { console.log('用法：node eval/check_sim.js <答案 json>'); process.exit(1); }
const d = JSON.parse(fs.readFileSync(file, 'utf8'));
const t = String(d.answer || '');
const H1 = '【他确实说过】', H2 = '【按这些依据推演】';
const a = t.indexOf(H1), b = t.indexOf(H2);
const A = (a >= 0 && b > a) ? t.slice(a + H1.length, b) : '';
const B = b >= 0 ? t.slice(b + H2.length) : '';

const checks = [];
function rec(name, ok, detail) { checks.push({ name, ok: !!ok, detail: detail || '' }); }

rec('双区标题齐全且顺序正确', a >= 0 && b > a, 'H1@' + a + ' H2@' + b);

/* 引用标记必须真能落到某封信的某一段 */
const marks = [...A.matchAll(/\[\[([^\]|]+)\|([^\]]+)\]\]/g)];
const blocks = [];
let exist = 0;
for (const m of marks) {
  const lt = L[m[1]];
  const blk = lt && lt.blocks && lt.blocks[+m[2]];
  if (blk) { exist++; blocks.push(String(blk.t || '').replace(/\s+/g, ' ').trim()); }
}
rec('引用标记全部能落到真实段落', marks.length > 0 && exist === marks.length, exist + '/' + marks.length);

/* 逐字忠实：按 eval/README.md 的口径，引号内文本与被引用段落的最长公共子串 ≥ 8 字算数。
   不能用「前 12 字整段包含」——句尾多一个句号就会误判成改写（实测踩过一次）。 */
function longestCommon(s, bt) {
  let best = 0;
  for (let k = 0; k < s.length; k++) {
    const max = Math.min(s.length - k, 40);
    for (let j = max; j > best; j--) {
      if (bt.indexOf(s.slice(k, k + j)) >= 0) { best = j; break; }
    }
  }
  return best;
}
const quoted = [...A.matchAll(/[「"]([^」"]{8,})[」"]/g)].map(x => x[1]);
let qhit = 0;
const lcs = [];
for (const s of quoted) {
  const best = blocks.length ? Math.max.apply(null, blocks.map(bt => longestCommon(s, bt))) : 0;
  lcs.push(best);
  if (best >= 8) qhit++;
}
rec('引文逐字可核（最长公共子串 ≥ 8 字）',
  quoted.length > 0 && qhit === quoted.length,
  qhit + '/' + quoted.length + '，最长片段 ' + lcs.join('/') + ' 字');

rec('推演区没有引用标记', B.length > 0 && !/\[\[/.test(B), B.indexOf('[[') >= 0 ? '发现 [[' : '干净');
rec('推演区没有冒充原话的句式',
  !/(我说过|我在\s*\d{4}\s*年写过|某年我在信里写)/.test(B), '');
const cases = [...B.matchAll(/〔([^〕]+)〕/g)];
rec('推演区挂了至少 2 条案例 id', cases.length >= 2, cases.length + ' 条');

console.log('判分：' + file + '（' + (d.mode || '?') + '，答案 ' + t.length + ' 字）');
checks.forEach(c => console.log((c.ok ? '  ✓ ' : '  ✗ ') + c.name + (c.detail ? ' · ' + c.detail : '')));
const fail = checks.filter(c => !c.ok).length;
console.log('\n不合格 ' + fail + ' 项 / 共 ' + checks.length + ' 项');
process.exit(fail ? 1 : 0);
