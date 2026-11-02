/* 股东大会中文全文语料：1994-2026，66 场，2.7 万段
   - 数据来自 _src/meeting/meetings_zh.jsonl（build_meeting_zh.py 产出）
   - 只在服务端加载，不生成 site/data-meeting.js：
     159 万字做成页面 JS 要 4.8 MB，浏览器扛不动；而分身回答走的是服务端接口，
     全量放在 Node 里既不影响首屏，又能让检索覆盖全部年份。
   - 检索沿用项目约定：中文 n-gram + tf-idf 字面粗召回，不上向量库
   - 这是中英对照全文的中文侧，可以逐字引用（和 380 条英文字幕中译不同）

   用法：
     node meeting.js "为什么不做预测"          命令行试
     const M = require('./meeting'); M.search(q, {k:4})
*/
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '_src', 'meeting', 'meetings_zh.jsonl');
let SEGS = [];
let META = null;

function load() {
  if (!fs.existsSync(FILE)) return;
  const rows = fs.readFileSync(FILE, 'utf8').split('\n')
    .filter(Boolean).map(l => JSON.parse(l));
  /* 问答配对：不能只留 buffett 段——股东提问用的是完整的自然语言，
     正是最好的检索入口，丢掉就等于把 5.5 万段提问白扔了。
     按 (年, 场次) 分组、组内按 n 排序，他每段往前找最近的提问。
     一个提问常被切成好几段（追问、补充、主持人报编号），只取最后一段会拿到
     「如果不能，这对未来回报意味着什么？」这种残句，所以连续几段要拼起来。 */
  const byFile = {};
  for (const r of rows) (byFile[r.y + '|' + r.session] = byFile[r.y + '|' + r.session] || []).push(r);
  const all = [];
  let nAsk = 0;
  for (const k in byFile) {
    const arr = byFile[k].sort((a, b) => (a.n || 0) - (b.n || 0));
    let buf = [], lastAsk = '';
    for (const r of arr) {
      if (r.who === 'other') {
        if (r.text && r.text.length >= 8) buf.push(r.text);
        continue;
      }
      if (r.who !== 'buffett' || !r.text || r.text.length < 20) continue;
      if (buf.length) {
        lastAsk = pickAsk(buf);
        buf = [];
      }
      if (lastAsk) nAsk++;
      /* 同一个提问下他连着答几段时并成一段：转录常把开场寒暄单独切出来
         （「有趣的是你区分了爱尔兰的更多阳光」），它短、命中词少，
         长度归一化后反而排在真正的回答前面。并到上一段就压住了。 */
      const prev = all[all.length - 1];
      if (prev && lastAsk && prev.ask === lastAsk && prev.r.text.length < 60) {
        prev.r = Object.assign({}, prev.r, { text: prev.r.text + ' ' + r.text });
        continue;
      }
      all.push({ r, ask: lastAsk });
    }
  }
  SEGS = all.map(({ r, ask }) => ({
    y: r.y, session: r.session, ch: r.ch, title: r.title || '',
    ans: r.text, ask, src: 'meeting',
  }));
  META = {
    segs: SEGS.length, chars: SEGS.reduce((s, x) => s + x.ans.length, 0),
    asked: nAsk, file: FILE,
  };
}
try { load(); } catch (e) { console.log('  （股东大会中文全文未加载：' + e.message + '）'); }

/* 从连着几段「别人说的」里挑出真正的提问。
   股东大会的 other 段混着三种东西：股东的提问、主持人的开场白（「沃伦和查理
   都不知道我们要问什么」）、投票计票结果（「28,452 票赞成」）。后两种当检索
   入口会带来假阳性，所以只认带问号的句子；一个问号都没有的，只有短的才留下
   （有些提问是陈述句式：「我想知道你对比特币的看法」）。 */
function pickAsk(buf) {
  const all = buf.join(' ');
  const parts = all.split(/(?<=[。！？?])/).map(x => x.trim()).filter(Boolean);
  const qs = parts.filter(p => /[？?]/.test(p));
  if (qs.length) {
    /* 取最后两个问句：前面的多是寒暄和自我介绍 */
    const s = qs.slice(-2).join('');
    return s.length > 320 ? s.slice(-320) : s;
  }
  if (all.length > 60) return '';
  return all;
}
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
/* 检索文本分两路：正文（标题+回答）满分，提问半分。
   提问是好入口，但它是别人的话——「你认为估值太高了吗」这种句子在几百个
   股东嘴里都出现过，跟正文同权会把「可口可乐」这类题挤到无关场次去。
   长度归一化仍按正文长度算，免得长提问把段落算成「长文」而被压分。 */
const TANS = SEGS.map(s => (s.title || '') + ' ' + (s.ans || ''));
const TASK = SEGS.map(s => s.ask || '');
const TEXT = SEGS.map((s, i) => TANS[i] + ' ' + TASK[i]);
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
    if (yr && s0.y > yr) continue;          /* 截断年份回测用 */
    const ta = TANS[i], tk = TASK[i];
    let s = 0;
    for (const tm of ts) {
      const idf = Math.log(1 + N / (df(tm.g) + 1));
      if (ta.indexOf(tm.g) >= 0) s += idf * tm.w;
      else if (tk.indexOf(tm.g) >= 0) s += idf * tm.w * 0.5;
    }
    if (s > 0) scored.push({ i, s: s / (1 + Math.log(1 + ta.length / 200)) });
  }
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, k).map(x => Object.assign({ score: +x.s.toFixed(2) }, SEGS[x.i]));
}

/* 风格样本：挑答得不长、带口语标记的 */
function styleSamples(k) {
  const marks = /(你看|我是说|说白了|老实说|怎么说呢|你想想|对吧|其实|根本|没法|不知道|我错了)/;
  const pool = SEGS.filter(s => s.ans.length > 100 && s.ans.length < 280 && marks.test(s.ans));
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

module.exports = { search, styleSamples, SEGS, META };

if (require.main === module) {
  const q = process.argv[2] || '为什么不预测市场';
  console.log('语料', SEGS.length, '段', META ? META.chars + ' 字' : '');
  search(q, { k: 3 }).forEach((x, i) => {
    console.log(`[${i + 1}] ${x.y} ${x.session} 第${x.ch + 1}章 分 ${x.score}`);
    if (x.title) console.log('  章：' + x.title);
    console.log('  ' + x.ans.slice(0, 240) + '\n');
  });
}
