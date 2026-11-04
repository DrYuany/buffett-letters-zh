/* 第二把尺子：截断年份回测 —— 「思维模式」唯一的硬指标
 *
 *   node eval/backtest.js --prep          # 第一步：洗题，生成决策前简报（一次，缓存）
 *   node eval/backtest.js --n 20          # 第二步：盲问 + 判分
 *   node eval/backtest.js --n 20 --anon   # 匿名化对照（把名字抹掉再问一遍）
 *
 * 为什么必须洗题：案例库的 situation 字段是事后总结，里面直接写着「逆市加仓」「果断建仓」，
 * 等于把答案印在题面上。所以先用模型把每条改写成「决策当天能看到的事实」：
 * 行业处境、公司数据、报价、管理层，删掉他做了什么、结果如何。真实动作单独抽成 action，
 * 只用于判分，不进题面。
 *
 * 三个指标，都可复算：
 *   A 方向一致率   他把这事判成「买/不买/继续持有/放弃」，与当年真实动作比。
 *                  同时给出「永远猜买入」的基线 —— 不报基线的一致率没有意义。
 *   B 变量重合率   他关心的决策变量与当年记分卡上记的变量重合多少（Jaccard）。
 *                  这是「想的是不是同一件事」，比方向更接近「思维模式」。
 *   C 越界年份率   答案引用的年份里有多少超过 as_of。这是时间闸门的机械体检，
 *                  不靠模型判，纯字符串比对，一泄漏就现形。
 */
const fs = require('fs');
const path = require('path');
const A = require('../agent.js');

const ROOT = path.join(__dirname, '..');
const KEY = fs.readFileSync(path.join(ROOT, '_agent.key'), 'utf8').trim();
const API = 'https://api.deepseek.com/chat/completions';
const RES = path.join(__dirname, 'results');
/* 洗题缓存进版本控制（eval/ 不在 .gitignore），否则回测基线不可复现。_src/ 整体被忽略。 */
const CACHE = path.join(ROOT, 'eval', 'cases-backtest.jsonl');
const AGENT = process.env.AGENT_URL || 'http://127.0.0.1:8123';

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const has = n => process.argv.indexOf('--' + n) > 0;
const N = Number(arg('n', 20));

const C = A.SITUATION.CASES.filter(c => c.kind === 'scorecard' && c.situation && c.judgment);

async function llm(messages, maxTokens) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(API, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'deepseek-chat', messages, temperature: 0.1, max_tokens: maxTokens || 900 }),
      });
      const j = await r.json();
      return j.choices[0].message.content || '';
    } catch (e) { if (i === 2) throw e; await new Promise(x => setTimeout(x, 1500)); }
  }
}

/* ---------- 第一步：洗题 ---------- */
const ACTIONS = ['买入或加仓', '卖出或清仓', '继续持有不动', '放弃或不参与'];

async function prep() {
  const done = new Map();
  if (fs.existsSync(CACHE)) {
    fs.readFileSync(CACHE, 'utf8').trim().split('\n').filter(Boolean).forEach(l => {
      const o = JSON.parse(l); done.set(o.id, o);
    });
  }
  const todo = C.filter(c => !done.has(c.id));
  console.log(`记分卡 ${C.length} 条，已洗 ${done.size}，待洗 ${todo.length}`);
  const B = 4;
  for (let i = 0; i < todo.length; i += B) {
    const batch = todo.slice(i, i + B);
    const items = batch.map(c => ({ id: c.id, y: c.y, ent: c.entity, sit: c.situation, jd: c.judgment, out: c.outcome || '' }));
    const txt = await llm([
      { role: 'system', content: '你在为一次历史回测准备题面。任务：把「事后总结」改写成「决策当天可公开得知的事实」。' },
      {
        role: 'user', content:
          `对下面每一条，输出严格 JSON 数组，不要代码块，不要解释：\n` +
          `[{"id":"原 id","brief":"决策前简报","action":"四选一","vars":["他当时真正在权衡的变量"]}]\n\n` +
          `brief 三条硬要求：①只写决策当天能知道的事（行业处境、公司经营数据、报价、管理层、监管），` +
          `像一份当时的新闻摘要；②绝对不写他做了什么、买了没买、后来怎样、赚了还是亏了 —— 一个字都不能露；` +
          `③120-220 字，用第二人称对公司说话，让人只能凭事实自己判断。\n` +
          `action 只能取：${ACTIONS.join(' / ')}（这是事后的真实动作，只给判分用，不进 brief）。\n` +
          `vars 给 2-4 个，是他当时真正在乎的判断依据（例：护城河是否受损、价格相对内在价值、管理层是否可信、监管风险）。\n\n` +
          `条目：\n${JSON.stringify(items)}`,
      },
    ], 3000);
    const m = txt.match(/\[[\s\S]*\]/);
    if (!m) { console.log('  解析失败，跳过一批', txt.slice(0, 120)); continue; }
    let arr; try { arr = JSON.parse(m[0]); } catch (e) { console.log('  JSON 坏，跳过一批'); continue; }
    const byId = new Map(batch.map(c => [c.id, c]));
    for (const it of arr) {
      const c = byId.get(it.id); if (!c || !it.brief) continue;
      const act = ACTIONS.find(x => String(it.action || '').indexOf(x.slice(0, 2)) >= 0) || '';
      done.set(it.id, { id: c.id, y: c.y, ent: c.entity, brief: it.brief, action: act, vars: (it.vars || []).slice(0, 4), verdict: c.verdict || '', slots: c.slots || [] });
    }
    fs.writeFileSync(CACHE, [...done.values()].map(o => JSON.stringify(o)).join('\n') + '\n');
    console.log(`  ${Math.min(i + B, todo.length)}/${todo.length}`);
  }
  console.log('洗题完成：', done.size, '条 →', CACHE);
}

/* ---------- 第二步：盲问 ---------- */
async function ask(item, anon) {
  const body = JSON.stringify({
    message: `今天是 ${item.y} 年。看到这么一件事，你怎么想？\n\n${item.brief}\n\n你会怎么做？为什么？`,
    session: 'bt-' + item.id + (anon ? '-anon' : ''),
    mode: 'simulate',
    as_of: String(item.y),
    anon: !!anon,
    vid: 'eval-backtest',
  });
  const t0 = Date.now();
  const r = await fetch(AGENT + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  const txt = await r.text();
  // SSE：把 delta 拼起来，丢掉 tool 事件
  const out = txt.split('\n').filter(l => l.startsWith('data: ')).map(l => {
    try { return JSON.parse(l.slice(6)); } catch (e) { return null; }
  }).filter(Boolean);
  const ans = out.filter(o => typeof o.text === 'string').map(o => o.text).join('');
  const tools = out.filter(o => o.tool).map(o => o.tool);
  return { ans, tools, ms: Date.now() - t0, raw: txt };
}

/* ---------- 第三步：判分 ---------- */
async function grade(item, ans, anon) {
  const txt = await llm([
    {
      role: 'user', content:
        `下面是同一个人在 ${item.y} 年对同一件事的回答。请判三件事，输出严格 JSON，不要代码块：\n` +
        `{"action":"四选一","vars":["他实际用来判断的依据"],"reasons":"一句话说明"}\n` +
        `action 只能取：${ACTIONS.join(' / ')}；拿不准就给最接近的。\n` +
        `vars 给 2-4 个，用短语，例如「护城河是否受损」「价格相对内在价值」「管理层是否可信」。\n\n` +
        `事实简报：${item.brief}\n\n他的回答：\n${ans.slice(0, 2600)}`,
    },
  ], 700);
  let j = {};
  try { const m = txt.match(/\{[\s\S]*\}/); j = JSON.parse(m[0]); } catch (e) { j = {}; }
  const act = ACTIONS.find(x => String(j.action || '').indexOf(x.slice(0, 2)) >= 0) || '';
  return { action: act, vars: (j.vars || []).slice(0, 4), why: j.reasons || '' };
}

/* 越界年份：纯字符串，不靠模型判。
   分两种，不能混为一谈 ——
   A 引用越界（硬证据）：[[1989 巴菲特致股东信|12]] 这种，引用的信用了 as_of 之后的年份。
   B 正文提及（要看语境）：他的信里本来就充满对下一年的前瞻（"我们打算在 1989 年袖手旁观"、
     "如果 1991 年 10% 的贷款出问题"）。这些是当年写给当年的，不是泄漏。
     所以带假设/计划词的提及不算，只把像在陈述既成事实的挑出来给人看。 */
/* 前瞻词可能在年份前（"如果 1991 年"），也可能在后（"1989 年我打算"），
   所以判定要看年份前后各一段，只看前面会漏掉一半。到期日、行权截止日也是当年已知的。 */
const HYP = /(如果|若|假设|假如|万一|将会|将在|会|打算|准备|预期|预计|希望|可能|届时|未来|到期|之前|以前|起算)/;
function leakYears(ans, asOf, brief) {
  const cites = [...ans.matchAll(/\[\[(?:(\d{4})\s*[^\]|]*)\|(\d+)\]\]/g)]
    .map(m => +m[1]).filter(y => y > asOf && y <= 2035);
  const body = [...ans.matchAll(/(19\d{2}|20\d{2})\s*年/g)].map(m => ({ y: +m[1], at: m.index }));
  /* 把答案切成句子，先排除「引用原文」的句子：句子里带 [[信|段]] 标记的，
     里面的年份是当年信上就写着的（2011 年的信里写「2021 年 9 月 2 日之前可行权」），
     不是泄漏。只有他自己在正文里陈述的年份才计数。 */
  const sents = ans.split(/(?<=[。！？\n])/);
  const quoted = new Set();
  let off = 0;
  for (const s of sents) {
    /* 带引用标记的算引文；带「」的也算 —— 引号里就是逐字原文，标记常常掉到下一行，
       只认标记会漏判。 */
    /* 引号有四种写法：中文「」、“”，英文 "" —— 只认「」会把一半引文当成正文。 */
    if (/\[\[[^\]]+\|\d+\]\]|\[\[web\||[「」“”"]/.test(s)) for (let i = off; i < off + s.length; i++) quoted.add(i);
    off += s.length;
  }
  const assert = [];
  const briefY = new Set((String(brief || '').match(/19\d{2}|20\d{2}/g) || []).map(Number));
  for (const b of body) {
    if (b.y <= asOf || b.y > 2035) continue;
    if (quoted.has(b.at)) continue;          /* 在引文里 */
    /* 题面自己给出的年份（债券到期日、合约期限）复述不算泄漏 */
    if (briefY.has(b.y)) continue;
    const ctx = ans.slice(Math.max(0, b.at - 24), b.at + 14);
    if (HYP.test(ctx)) continue;             /* 前瞻假设 / 已知到期日，不算 */
    assert.push(b.y);
  }
  return { cite: [...new Set(cites)], assert: [...new Set(assert)] };
}

/* 变量重合：先按字面对齐（严），再叫判官按语义对齐（宽）。
   字面值会系统性低估 —— 「价格相对内在价值」和「价格相对内在价值的安全边际」在字面上是两串，
   在人脑子里是同一件事。所以结论看语义值，字面值只留作下滑对照。 */
async function semCover(truth, got) {
  if (!truth.length || !got.length) return { m: 0, cover: 0 };
  const txt = await llm([
    {
      role: 'user', content:
        `把 A、B 两串「决策变量」按意思对齐（措辞不同但指同一件事就算一项）。\n` +
        `A 是当年真实记下的：${JSON.stringify(truth)}\nB 是他的回答里判出的：${JSON.stringify(got)}\n\n` +
        `输出严格 JSON，不要代码块：{"pairs":[["A 里的项","B 里的项"]],"m":对齐上的对数}`,
    },
  ], 500);
  let j = {};
  try { const m = txt.match(/\{[\s\S]*\}/); j = JSON.parse(m[0]); } catch (e) { j = {}; }
  const m = Math.min(+j.m || (j.pairs || []).length || 0, truth.length, got.length);
  return { m, cover: +(m / truth.length).toFixed(2) };
}

const jac = (a, b) => {
  const norm = s => String(s).replace(/[\s，。、,.]/g, '');
  const A1 = a.map(norm), B1 = b.map(norm);
  let inter = 0;
  for (const x of A1) if (B1.some(y => y.indexOf(x) >= 0 || x.indexOf(y) >= 0)) inter++;
  const uni = A1.length + B1.length - inter;
  return uni ? inter / uni : 0;
};

(async () => {
  if (has('prep')) return prep();

  /* 重判模式：不重新提问，只拿存下来的答案重算指标。
     改了判分规则（比如这次的越界口径、语义重合）不该再花八分钟重跑一遍模型。 */
  const regateIdx = process.argv.indexOf('--regate');
  if (regateIdx > 0) {
    const f = process.argv[regateIdx + 1];
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    console.log(`重判 ${d.rows.length} 条（不重新提问）：${f}`);
    let coverSum = 0, coverN = 0, citeLeak = 0, assertLeak = 0;
    for (const r of d.rows) {
      r.leak = leakYears(r.ans, r.y, r.brief);
      r.sem = await semCover(r.vars, (r.got || {}).vars || []);
      if (r.sem.cover > 0) { coverSum += r.sem.cover; coverN++; }
      if (r.leak.cite.length) citeLeak++;
      if (r.leak.assert.length) assertLeak++;
      console.log(`${String(r.ent).padEnd(10)} ${r.y}  变量覆盖 ${r.sem.cover.toFixed(2)}  引用越界 ${r.leak.cite.length || '无'}  陈述越界 ${r.leak.assert.length ? r.leak.assert.join(',') : '无'}`);
    }
    d.varCover = +(coverSum / (coverN || 1)).toFixed(3);
    d.citeLeakRate = +(citeLeak / d.rows.length).toFixed(3);
    d.assertLeakRate = +(assertLeak / d.rows.length).toFixed(3);
    fs.writeFileSync(f, JSON.stringify(d, null, 1));
    console.log(`\n变量语义覆盖 ${d.varCover.toFixed(2)}（当年真正在乎的几件事，他想到了几成）`);
    console.log(`引用越界 ${(d.citeLeakRate * 100).toFixed(0)}%（硬证据，应为 0）  陈述越界 ${(d.assertLeakRate * 100).toFixed(0)}%（需人工看一眼语境）`);
    console.log(`已回写 ${f}`);
    return;
  }

  if (!fs.existsSync(CACHE)) { console.log('还没洗题，先跑：node eval/backtest.js --prep'); process.exit(1); }
  const all = fs.readFileSync(CACHE, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
    .filter(o => o.brief && o.action);
  /* 分层抽样：按年代铺开，不要全是 90 年代 */
  all.sort((a, b) => a.y - b.y);
  const step = Math.max(1, Math.floor(all.length / N));
  const items = [];
  for (let i = 0; i < all.length && items.length < N; i += step) items.push(all[i]);

  const anon = has('anon');
  const H = await fetch(AGENT + '/api/health').then(r => r.json()).catch(() => null);
  if (!H || !H.ok) { console.log(`本地 agent 没起（${AGENT}）。先跑：PORT=8123 EVAL_NO_QUOTA=1 node agent.js`); process.exit(1); }
  console.log(`题库 ${all.length} 条，抽 ${items.length} 条；服务 ${AGENT}；${anon ? '【匿名化】' : '具名'}；模型 ${H.models[0]}\n`);

  const rows = [];
  let hit = 0, baseHit = 0, citeLeak = 0, assertLeak = 0, jacSum = 0, jacN = 0, coverSum = 0, coverN = 0;
  const truthCount = {};
  all.forEach(o => { truthCount[o.action] = (truthCount[o.action] || 0) + 1; });
  const majority = Object.entries(truthCount).sort((a, b) => b[1] - a[1])[0][0];

  for (const it of items) {
    let ans = '', tools = [], ms = 0;
    try { ({ ans, tools, ms } = await ask(it, anon)); } catch (e) { console.log(`${it.ent} ${it.y} 调用失败：${e.message}`); continue; }
    if (!ans || ans.length < 60) { console.log(`${it.ent} ${it.y} 空答案，跳过`); continue; }
    const g = await grade(it, ans, anon);
    const ok = g.action === it.action;
    const base = majority === it.action;
    const jv = jac(g.vars, it.vars);
    const lk = leakYears(ans, it.y, it.brief);
    const sem = await semCover(it.vars, g.vars);
    hit += ok ? 1 : 0; baseHit += base ? 1 : 0;
    if (lk.cite.length) citeLeak++;
    if (lk.assert.length) assertLeak++;
    if (sem.cover > 0) { coverSum += sem.cover; coverN++; }
    if (g.vars.length && it.vars.length) { jacSum += jv; jacN++; }
    rows.push({ ...it, ans, tools, ms, got: g, ok, base, jac: +jv.toFixed(2), sem, leak: lk });
    console.log(`${String(it.ent).padEnd(10)} ${it.y}  真:${it.action.padEnd(8)} 判:${(g.action || '?').padEnd(8)} ${ok ? '✓' : '✗'}  变量覆盖 ${sem.cover.toFixed(2)}  引用越界 ${lk.cite.length || '无'}  陈述越界 ${lk.assert.length ? lk.assert.join(',') : '无'}  ${(ms / 1000).toFixed(0)}s`);
  }

  const n = rows.length;
  /* 题库本身偏得厉害（绝大多数真实动作是「买入」），所以裸准确率没有判别力。
     kappa 扣掉「按两边的边际分布瞎猜也能蒙对」的那部分：0 等于瞎猜，1 等于全对，负数比瞎猜还差。 */
  const kappa = (() => {
    const labels = ACTIONS;
    const po = hit / n;
    const pe = labels.reduce((s, L) => {
      const a = rows.filter(r => r.action === L).length / n;
      const b = rows.filter(r => r.got.action === L).length / n;
      return s + a * b;
    }, 0);
    return pe === 1 ? 0 : (po - pe) / (1 - pe);
  })();
  const out = {
    ts: new Date().toISOString(), n, anon,
    dirAcc: +(hit / n).toFixed(3),
    baseAcc: +(baseHit / n).toFixed(3),
    kappa: +kappa.toFixed(3),
    varJac: +(jacSum / (jacN || 1)).toFixed(3),
    varCover: +(coverSum / (coverN || 1)).toFixed(3),
    citeLeakRate: +(citeLeak / n).toFixed(3),
    assertLeakRate: +(assertLeak / n).toFixed(3),
    medianMs: rows.map(r => r.ms).sort((a, b) => a - b)[Math.floor(n / 2)],
    confusion: rows.map(r => ({ ent: r.ent, y: r.y, truth: r.action, got: r.got.action, ok: r.ok })),
    rows,
  };
  fs.mkdirSync(RES, { recursive: true });
  const f = path.join(RES, `backtest-${Date.now()}.json`);
  fs.writeFileSync(f, JSON.stringify(out, null, 1));

  console.log(`\n方向一致率 ${(out.dirAcc * 100).toFixed(0)}%（永远猜「${majority}」的基线是 ${(out.baseAcc * 100).toFixed(0)}%）`);
  console.log(`kappa ${out.kappa.toFixed(2)}（0 = 瞎猜，1 = 全对）`);
  console.log(`变量重合率 ${out.varJac.toFixed(2)}（Jaccard，1.0 表示想的是同一批变量）`);
  console.log(`变量语义覆盖 ${out.varCover.toFixed(2)}（当年真正在乎的几件事，他想到了几成）`);
  console.log(`引用越界 ${(out.citeLeakRate * 100).toFixed(0)}%（硬证据，应为 0）  陈述越界 ${(out.assertLeakRate * 100).toFixed(0)}%（前瞻假设已排除，剩下的需看一眼）`);
  console.log(`单题中位耗时 ${(out.medianMs / 1000).toFixed(0)}s`);
  console.log(`写入 ${f}`);
})();
