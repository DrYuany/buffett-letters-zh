/* eval/judge.js — 研判模式的质量检查

   为什么不用"像不像巴菲特"来判：那件事已经用盲判量过了（eval/style.js），
   而且答案再像，只要数字是编的、立场是含糊的，对读者就是负价值。

   这里只看四件能机械核对的事：
   1. 结构：五段标题在不在；
   2. 立场：【所以】里有没有买/不买/等/看不懂，有没有拿"因人而异"糊过去；
   3. 证伪：有没有"如果……就……"这种可以被现实推翻的话；
   4. 数字：正文里出现的 PE、股价，跟行情接口的实时值对不对得上（防编造）。

   第 4 条是重点。模型很会写"PE 二十倍左右"这种模糊话，也很会在记忆里
   掏一个旧数字。跑一遍实时取数比对，编没编一目了然。

   用法：
     node eval/judge.js                 跑全部 6 题
     node eval/judge.js --n 3           只跑前 3 题
     node eval/judge.js --base http://127.0.0.1:8125
*/

const fs = require('fs');
const path = require('path');
const MARKET = require('../market');

const BASE = (() => { const i = process.argv.indexOf('--base'); return i > 0 ? process.argv[i + 1] : 'http://127.0.0.1:8125'; })();
const N = (() => { const i = process.argv.indexOf('--n'); return i > 0 ? +process.argv[i + 1] : 99; })();

const CASES = [
  { id: 'maotai', q: '贵州茅台现在这个价位，你会买吗？', ent: '贵州茅台' },
  { id: 'hs300', q: '沪深300 现在这个位置算贵还是便宜？', ent: '沪深300', idx: true },
  { id: 'catl', q: '宁德时代的三季报怎么样？这个价格你怎么看？', ent: '宁德时代' },
  { id: 'baijiu', q: '白酒板块最近涨了不少，现在还能追吗？', ent: '中证白酒', idx: true },
  { id: 'bank', q: '银行股股息率这么高，是不是比存银行划算？', ent: '中证银行', idx: true },
  { id: 'byd', q: '比亚迪现在这个估值，你会买吗？', ent: '比亚迪' },
];

const HEADS = ['他确实说过', '现在的事实', '我怎么量它', '所以', '我可能错在哪'];
/* 立场词表要覆盖他会用的说法。原来只有「不买/买入/…」，
   实测「不追。这个价位我不觉得贵，但我不下单」被判成含糊 —— 答案很清楚，
   是词表太窄。宁可词表宽一点，也不要让判分器冤枉一次明确表态。 */
const STANCE = /(不追|别追|不买|买入|买|等|不碰|看不懂|持有|加仓|减仓|卖出|清仓|观望|不下手|不参与)/;
const HEDGE = /(因人而异|需要综合考虑|建议关注|视情况而定|取决于个人)/;

function parseSSE(raw) {
  const out = { ans: '', steps: [], cites: [], err: null };
  for (const block of raw.split('\n\n')) {
    const lines = block.split('\n');
    const ev = (lines.find(l => l.startsWith('event: ')) || '').slice(7).trim();
    const dl = lines.find(l => l.startsWith('data: '));
    if (!ev || !dl) continue;
    let d; try { d = JSON.parse(dl.slice(6)); } catch (e) { continue; }
    if (ev === 'delta') out.ans += d.text || '';
    else if (ev === 'reset') out.ans = '';
    else if (ev === 'step') out.steps.push(d.text || '');
    else if (ev === 'sources') out.cites = d.sources || [];
    /* 上游断流、余额不足、限流都会走这里。以前把 error 事件当没看见，
       结果是一行空白答案被记成「结构 0/5、立场含糊」，看起来像模型不会答。 */
    else if (ev === 'error') out.err = d.message || '服务端返回错误';
  }
  return out;
}

/* 评测走 byo（自带密钥）分支：烧的是站长的钱，不该占访客的 10 次免费额度。
   不传 key 就会被当成访客，跑到第 11 问直接返回「免费体验用完了」——
   那两条空答案就是这么来的，看起来像模型不会答，其实是额度墙。 */
function readKey() {
  for (const f of [path.join(__dirname, '..', '_agent.key'), path.join(require('os').homedir(), '.buffett-agent.key')]) {
    try { const v = fs.readFileSync(f, 'utf8').trim(); if (v) return v; } catch (e) {}
  }
  return null;
}
const KEY = readKey();

async function ask(q) {
  const r = await fetch(BASE + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: q, session: 'judge-' + Date.now(), mode: 'simulate', vid: 'judge-run', mindset: true, key: KEY || undefined }),
    signal: AbortSignal.timeout(240000),
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return parseSSE(await r.text());
}

/* 从正文里捞它自己说的 PE 和价格，跟实时数据比。
   注意两个天然误报：正文里还有同行 PE（"汾酒 14.4 倍"）和历史区间价
   （"区间两头是 1148.73 和 1843.73"）。这些不是当前值，不该判成编造。
   所以判据是「至少有一处跟实时数据吻合」——一处都对不上，才说明它没真查。 */
function extractClaims(ans) {
  const pe = [...ans.matchAll(/PE[^0-9]{0,6}(\d+(?:\.\d+)?)\s*倍/gi)].map(m => +m[1]);
  const px = [...ans.matchAll(/(\d{2,4}(?:\.\d{1,2})?)\s*元/g)].map(m => +m[1]);
  return { pe: [...new Set(pe)], px: [...new Set(px)] };
}
function anyClose(vals, target, tol) {
  if (target == null) return true;
  return vals.some(x => Math.abs(x - target) / target <= tol);
}

/* 拿实时数据核对正文里的 PE 和股价。答案存下来之后可以单独重算，
   改判据不用重跑问答（模型调用要花钱，也会给出不一样的话）。 */
async function checkNums(ans, ent) {
  const cl = extractClaims(ans);
  let live = null;
  try { live = await MARKET.snapshot(ent); } catch (e) {}
  let badPe = [], badPx = [];
  if (live && live.ok && live.quote) {
    const p = live.quote.pe, q = live.quote.price;
    if (p && cl.pe.length && !anyClose(cl.pe, p, 0.08)) badPe = cl.pe;
    if (q && cl.px.length && !anyClose(cl.px, q, 0.08)) badPx = cl.px;
  } else if (live && live.ok && live.eva) {
    const p = live.eva.pe;
    if (p && cl.pe.length && !anyClose(cl.pe, p, 0.15)) badPe = cl.pe;
  }
  return { badPe, badPx, claims: cl };
}

/* 标题写法归一。模型明明收到「标题照抄」，还是会写成 **他确实说过**、
   〔他确实说过〕、## 【他确实说过】。判分器只该判内容，不该因为格式扣分，
   所以先归一再看五段在不在。前端 fmtSim 里有同样一份规则。 */
function normHeads(ans) {
  const alt = HEADS.join('|');
  return String(ans || '')
    .replace(new RegExp('\\*{0,2}[〔【]\\s*(' + alt + ')\\s*[〕】]\\*{0,2}', 'g'), '【$1】')
    .replace(new RegExp('^\\s*\\*\\*\\s*(' + alt + ')\\s*\\*\\*\\s*$', 'gm'), '【$1】');
}

function split(ans) {
  ans = normHeads(ans);
  const out = {};
  const hits = [];
  for (const h of HEADS) {
    const p = ans.indexOf('【' + h + '】');
    if (p >= 0) hits.push({ h, p });
  }
  hits.sort((a, b) => a.p - b.p);
  hits.forEach((x, i) => {
    out[x.h] = ans.slice(x.p + x.h.length + 2, i + 1 < hits.length ? hits[i + 1].p : ans.length).trim();
  });
  return out;
}

/* --regate 文件：只重算判据和汇总，不重新问模型。
   结构/立场/证伪都是纯文本判断，跟数字核对一样可以从存下来的答案重算 ——
   改词表、改标题归一规则都不用再花一次钱。模型调用要真金白银，判据会一直改。 */
async function regate(file) {
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  const byId = Object.fromEntries(CASES.map(c => [c.id, c]));
  for (const r of d.rows) {
    if (r.err || !r.ans) continue;
    const c = byId[r.id];
    if (!c) continue;
    const sec = split(r.ans);
    r.heads = HEADS.filter(h => sec[h] != null).length;
    r.headsMissing = HEADS.filter(h => sec[h] == null);
    const stanceSec = sec['所以'] || '';
    r.stance = STANCE.test(stanceSec) && !HEDGE.test(stanceSec);
    r.falsify = /如果[^。]{4,60}(就|那么|说明|作废|该|会)/.test(r.ans) || /证伪/.test(r.ans);
    const { badPe, badPx } = await checkNums(r.ans, c.ent);
    r.badPe = badPe; r.badPx = badPx;
    console.log(`[${r.id}] 结构 ${r.heads}/5｜立场 ${r.stance ? '明确' : '含糊'}｜证伪 ${r.falsify ? '有' : '无'}` +
      `｜PE ${badPe.length ? '对不上 ' + badPe.join(',') : '对得上'}` +
      `｜股价 ${badPx.length ? '对不上 ' + badPx.join(',') : '对得上'}`);
  }
  const ok = d.rows.filter(r => !r.err && r.ans);
  const sum = d.sum;
  sum.n = ok.length;
  sum.heads5 = ok.filter(r => r.heads === 5).length;
  sum.stanceClear = ok.filter(r => r.stance).length;
  sum.falsify = ok.filter(r => r.falsify).length;
  sum.badNum = ok.filter(r => (r.badPe || []).length || (r.badPx || []).length).length;
  sum.factRate = ok.length ? (ok.reduce((s, r) => s + (r.factLines ? r.factWithNum / r.factLines : 0), 0) / ok.length) : 0;
  const f = path.join(__dirname, 'results', 'judge-' + Date.now() + '.json');
  fs.writeFileSync(f, JSON.stringify({ ...d, at: new Date().toISOString(), regatedFrom: file, sum, rows: d.rows }, null, 1));
  console.log(`\n五段齐全 ${sum.heads5}/${sum.n}｜立场明确 ${sum.stanceClear}/${sum.n}｜有证伪 ${sum.falsify}/${sum.n}`);
  console.log(`数字与实时数据对不上 ${sum.badNum}/${sum.n} 题（应为 0）`);
  console.log('重算结果：' + f);
}

(async () => {
  const ri = process.argv.indexOf('--regate');
  if (ri > 0) return regate(process.argv[ri + 1]);
  const rows = [];
  /* 只重跑指定几道：补跑崩掉的那两条，不用整批重来（整批是六次模型调用，真金白银） */
  const oi = process.argv.indexOf('--only');
  const ONLY = oi > 0 ? String(process.argv[oi + 1] || '').split(',').filter(Boolean) : [];
  const picked = ONLY.length ? CASES.filter(c => ONLY.indexOf(c.id) >= 0) : CASES.slice(0, N);
  for (const c of picked) {
    process.stdout.write(`\n[${c.id}] ${c.q}\n`);
    let r;
    try { r = await ask(c.q); }
    catch (e) { console.log('  请求失败：' + e.message); rows.push({ id: c.id, err: e.message }); continue; }
    if (r.err || !r.ans) {
      const msg = r.err || '模型返回了空答案';
      console.log('  请求失败：' + msg);
      rows.push({ id: c.id, err: msg });
      continue;
    }

    const sec = split(r.ans);
    const headsOk = HEADS.filter(h => sec[h] != null);
    const stanceSec = sec['所以'] || '';
    const stance = STANCE.test(stanceSec) && !HEDGE.test(stanceSec);
    const falsify = /如果[^。]{4,60}(就|那么|说明|作废|该|会)/.test(r.ans) || /证伪/.test(r.ans);
    const facts = sec['现在的事实'] || '';
    const numPerLine = facts.split('\n').filter(l => l.trim()).map(l => /\d/.test(l));
    const calls = {
      market: r.steps.filter(s => /调行情和财报/.test(s)).length,
      peer: r.steps.filter(s => /^对比 /.test(s)).length,
      news: r.steps.filter(s => /搜最近的资讯/.test(s)).length,
      case: r.steps.filter(s => /对到历史旧判断/.test(s)).length,
    };

    /* 数字核对：拿实时数据比它写的 */
    const { badPe, badPx } = await checkNums(r.ans, c.ent);

    const row = {
      id: c.id, heads: headsOk.length, headsMissing: HEADS.filter(h => sec[h] == null),
      stance, falsify,
      factLines: numPerLine.length, factWithNum: numPerLine.filter(Boolean).length,
      calls, badPe, badPx, len: r.ans.length,
      ans: r.ans,
    };
    rows.push(row);
    console.log(`  结构 ${row.heads}/5${row.headsMissing.length ? '（缺 ' + row.headsMissing.join('、') + '）' : ''}` +
      `｜立场 ${stance ? '明确' : '含糊'}` +
      `｜证伪 ${falsify ? '有' : '无'}` +
      `｜事实 ${row.factWithNum}/${row.factLines} 条带数字` +
      `｜调用 行情${calls.market} 对比${calls.peer} 资讯${calls.news} 案例${calls.case}` +
      (badPe.length ? `｜PE 对不上 ${badPe.join(',')}` : '') +
      (badPx.length ? `｜股价对不上 ${badPx.join(',')}` : ''));
  }

  const ok = rows.filter(r => !r.err);
  const sum = {
    n: ok.length,
    heads5: ok.filter(r => r.heads === 5).length,
    stanceClear: ok.filter(r => r.stance).length,
    falsify: ok.filter(r => r.falsify).length,
    calledMarket: ok.filter(r => r.calls && r.calls.market > 0).length,
    calledCase: ok.filter(r => r.calls && r.calls.case > 0).length,
    badNum: ok.filter(r => (r.badPe || []).length || (r.badPx || []).length).length,
    factRate: ok.length ? (ok.reduce((s, r) => s + (r.factLines ? r.factWithNum / r.factLines : 0), 0) / ok.length) : 0,
  };
  console.log('\n================ 汇总 ================');
  console.log(`题数 ${sum.n}`);
  console.log(`五段齐全 ${sum.heads5}/${sum.n}`);
  console.log(`立场明确 ${sum.stanceClear}/${sum.n}`);
  console.log(`有证伪点 ${sum.falsify}/${sum.n}`);
  console.log(`调了行情 ${sum.calledMarket}/${sum.n}｜调了历史案例 ${sum.calledCase}/${sum.n}`);
  console.log(`事实段带数字比例 ${(sum.factRate * 100).toFixed(0)}%`);
  console.log(`数字与实时数据对不上 ${sum.badNum} 题（应为 0）`);

  const dir = path.join(__dirname, 'results');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'judge-' + Date.now() + '.json');
  fs.writeFileSync(f, JSON.stringify({ at: new Date().toISOString(), base: BASE, sum, rows }, null, 1));
  console.log('明细：' + f);
})();
