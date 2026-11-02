/* 评测跑批：把 real / adv 两层的问题真的问一遍 agent。
 *
 *   用法：
 *     node eval/run_batch.js                      跑全部（real 27 + adv 12）
 *     node eval/run_batch.js --set adv            只跑对抗层
 *     node eval/run_batch.js --set real --limit 6 只跑前 6 条（先看看效果）
 *     node eval/run_batch.js --concurrency 4      并发 4 条（默认 3）
 *     node eval/run_batch.js --followup           连 followup 追问一起跑（默认不跑；字符串/数组都支持）
 *     node eval/run_batch.js --skip real-021      整批里排除某几条（记忆题要单独开记忆跑）
 *
 * 两个设计决定，写在这里省得以后被自己推翻：
 *
 * 1. 走 HTTP 而不是直接调 runAgent。跑批要测的就是线上那条链路（SSE、额度、工具、
 *    trace 落盘），抄近路调内部函数测出来的不是同一个东西。
 * 2. 带站长自己的密钥走 byo 分支。评测烧的是站长的钱，不该占访客的 10 次免费额度，
 *    也不该撞全站每日 150 问的上限（byo 分支不查这两个账）。
 *
 * 金标层（cases-gold）不在这里跑：它只测检索，不需要模型，零成本，在 score.js 里算。
 * 每条问答的 trace 由服务端落到 eval/traces/YYYY-MM-DD.jsonl，判分读的就是那些行 ——
 * 所以重跑批 = 真金白银，改判分逻辑千万别重跑批。
 */
const fs = require('fs'), fsp = fs.promises, path = require('path'), os = require('os');

const ROOT = path.join(__dirname, '..');
const BASE = process.env.AGENT_BASE || 'http://127.0.0.1:8099';
const RES_DIR = path.join(ROOT, 'eval', 'results');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? (process.argv[i + 1] || def) : def;
}
const has = n => process.argv.indexOf('--' + n) >= 0;

const SETS = arg('set', 'all');
const LIMIT = Number(arg('limit', 0));
const CONC = Math.max(1, Number(arg('concurrency', 3)));
const RUN_ID = arg('run-id', 'rb-' + Date.now().toString(36));
const WITH_FU = has('followup');
/* 只跑指定 case（逗号分隔），用来补齐上次崩掉的那几条，不用整批重来 */
const ONLY = arg('case', '').split(',').filter(Boolean);
/* 整批里排除几条。用来跑「全量但不含记忆题」：记忆题要单独开记忆跑，混在一起会串味 */
const SKIP = arg('skip', '').split(',').filter(Boolean);
/* 上游偶发断流（DeepSeek 会返回 terminated）导致单条失败时重试几次。
   一条题因为网络抖动就丢掉太可惜，重跑一次的钱比补样本便宜。 */
const RETRY = Number(arg('retry', 2));

/* 价格只是估算口径：DeepSeek 官网按模型定价且会调，这里按通用的输入 2 元 / 百万 token、
   输出 8 元 / 百万 token 折人民币，用来回答「一次问答大概多少钱」这个问题，不用来对账。 */
const PRICE_IN = 2 / 1e6, PRICE_OUT = 8 / 1e6;

async function readKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY.trim();
  for (const f of [path.join(ROOT, '_agent.key'), path.join(os.homedir(), '.buffett-agent.key')]) {
    try { const v = (await fsp.readFile(f, 'utf8')).trim(); if (v) return v; } catch (e) {}
  }
  return null;
}

function loadCases(file) {
  const p = path.join(ROOT, 'eval', file);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
}

/* 消费 SSE。reset 事件要照前端那样把答案清空 —— 模型在决定调工具之前吐的那半句
   「我来查查」不算答案，留着会污染逐字忠实率的判定。 */
async function askOnce(q, opts, qid, session) {
  const t0 = Date.now();
  const body = JSON.stringify({
    message: q, session: session, web: opts.web, model: 'flash',
    key: opts.key, run_id: RUN_ID, qid: qid, layer: opts.layer, vid: 'eval-' + RUN_ID
  });
  let r;
  try {
    r = await fetch(BASE + '/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: body, signal: AbortSignal.timeout(180000)
    });
  } catch (e) {
    return { qid: qid, ok: false, error: '连接失败：' + e.message, ms: Date.now() - t0 };
  }
  const dec = new TextDecoder();
  let buf = '', answer = '', err = null, usage = null, rounds = 0, calls = 0, steps = 0;
  const cites = [];
  try {
    for await (const chunk of r.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i); buf = buf.slice(i + 2);
      let type = 'message', data = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) type = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (!data) continue;
      let d = {};
      try { d = JSON.parse(data); } catch (e) { continue; }
      if (type === 'delta') answer += d.text || '';
      else if (type === 'reset') answer = '';
      else if (type === 'step') steps++;
      else if (type === 'cite') (d.sources || []).forEach(s => cites.push(s));
      else if (type === 'usage') usage = d;
      else if (type === 'done') { rounds = d.rounds || 0; calls = d.calls || 0; }
      else if (type === 'error') err = d.message;
    }
  }
  } catch (e) {
    /* 超时、连接被服务端掐断都会在这里冒出来：一条题失败不能把整批带崩，
       记成失败继续跑，最后在报告里单列。 */
    return { qid: qid, ok: false, error: '读流中断：' + e.message, ms: Date.now() - t0,
      answer: answer, usage: usage, rounds: rounds, calls: calls, steps: steps, n_cites: cites.length };
  }
  return { qid: qid, ok: !err, error: err, answer: answer, usage: usage,
    rounds: rounds, calls: calls, steps: steps, n_cites: cites.length, ms: Date.now() - t0 };
}

(async () => {
  const key = await readKey();
  if (!key) { console.error('找不到 DeepSeek 密钥（_agent.key 或 ~/.buffett-agent.key）。'); process.exit(1); }
  const h = await fetch(BASE + '/api/health').then(r => r.json()).catch(() => null);
  if (!h || !h.ok) { console.error('agent 服务没起来。先跑： node agent.js'); process.exit(1); }

  let cases = [];
  if (SETS === 'all' || SETS === 'real') cases = cases.concat(loadCases('cases-real.jsonl'));
  if (SETS === 'all' || SETS === 'adv') cases = cases.concat(loadCases('cases-adv.jsonl'));
  if (ONLY.length) cases = cases.filter(c => ONLY.indexOf(c.id) >= 0);
  if (SKIP.length) cases = cases.filter(c => SKIP.indexOf(c.id) < 0);
  if (LIMIT) cases = cases.slice(0, LIMIT);

  /* 每条 case 展开成一串任务：主问题，外加 repeat（同一问跑几次看稳不稳）
     和 followup（追问，共用 session 测多轮承接）。 */
  const jobs = [];
  for (const c of cases) {
    const n = c.repeat || 1;
    for (let k = 1; k <= n; k++) {
      jobs.push({ c: c, qid: n > 1 ? c.id + '#r' + k : c.id,
        session: RUN_ID + '-' + c.id + (n > 1 ? '-r' + k : ''), q: c.q });
    }
    /* followup 早期写成字符串，后来也有写成数组的；两种都吃，别让一道题把整批带崩 */
    const fus = Array.isArray(c.followup) ? c.followup : (c.followup ? [c.followup] : []);
    if (WITH_FU && fus.length) {
      fus.forEach((fq, i) => {
        jobs.push({ c: c, qid: c.id + '#f' + (i + 1), session: RUN_ID + '-' + c.id, q: fq, followup: i + 1 });
      });
    }
  }

  console.log('run_id = ' + RUN_ID);
  console.log('任务 ' + jobs.length + ' 条（case ' + cases.length + '）· 并发 ' + CONC +
    ' · 服务 ' + BASE + ' · keyMode ' + h.keyMode);
  console.log('');

  const out = [];
  let done = 0;
  for (let i = 0; i < jobs.length; i += CONC) {
    const slice = jobs.slice(i, i + CONC);
    const rs = await Promise.all(slice.map(async j => {
      const opts = { key: key, web: j.c.expect_web === false ? false : true, layer: j.c.layer };
      let r = null;
      for (let att = 0; att <= RETRY; att++) {
        r = await askOnce(j.q, opts, j.qid, j.session);
        if (r.ok) break;
        if (att < RETRY) await new Promise(r2 => setTimeout(r2, 3000 * (att + 1)));
      }
      return r;
    }));
    rs.forEach((r, k) => {
      done++;
      out.push(Object.assign({ case_id: slice[k].c.id, kind: slice[k].c.kind,
        followup: slice[k].followup || 0 }, r));
      const tk = (r.usage || {});
      console.log('[' + done + '/' + jobs.length + '] ' + r.qid.padEnd(14) +
        (r.ok ? ('ok ' + (r.ms / 1000).toFixed(1) + 's · ' + r.rounds + '轮/' + r.calls + '次工具 · ' +
          r.n_cites + '出处 · ' + ((tk.prompt_tokens || 0) + (tk.completion_tokens || 0)) + ' tok')
          : ('失败 ' + String(r.error).slice(0, 60))));
    });
  }

  /* 补齐模式：同一个 run_id 再跑一次时，把上次的结果并进来，只补这次跑的。
     跑批会中途崩（网络、限流、服务端出错都可能），整批重来太贵。 */
  const fp = path.join(RES_DIR, 'batch-' + RUN_ID + '.json');
  if (fs.existsSync(fp)) {
    try {
      const prev = JSON.parse(fs.readFileSync(fp, 'utf8'));
      const seen = new Set(out.map(r => r.qid));
      (prev.jobs || []).forEach(j => { if (!seen.has(j.qid)) out.push(j); });
      console.log('（并入了上次同 run_id 的 ' + (prev.jobs || []).length + ' 条结果）');
    } catch (e) {}
  }
  out.sort((a, b) => String(a.qid).localeCompare(String(b.qid)));

  const ok = out.filter(r => r.ok);
  const tokIn = ok.reduce((s, r) => s + ((r.usage || {}).prompt_tokens || 0), 0);
  const tokOut = ok.reduce((s, r) => s + ((r.usage || {}).completion_tokens || 0), 0);
  const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
  const summary = {
    run_id: RUN_ID, ts: Date.now(), sets: SETS, concurrency: CONC,
    n_jobs: out.length, n_ran: jobs.length, n_ok: ok.length, n_fail: out.length - ok.length,
    ms_avg: Math.round(avg(ok.map(r => r.ms))),
    rounds_avg: +avg(ok.map(r => r.rounds)).toFixed(2),
    calls_avg: +avg(ok.map(r => r.calls)).toFixed(2),
    cites_avg: +avg(ok.map(r => r.n_cites)).toFixed(2),
    tokens_in: tokIn, tokens_out: tokOut,
    cost_cny_est: +(tokIn * PRICE_IN + tokOut * PRICE_OUT).toFixed(3),
    price_note: '输入 2 元/百万 token、输出 8 元/百万 token，仅为估算口径，以 DeepSeek 官网为准',
    jobs: out.map(r => ({ qid: r.qid, case_id: r.case_id, kind: r.kind, followup: r.followup,
      ok: r.ok, error: r.error, ms: r.ms, rounds: r.rounds, calls: r.calls,
      n_cites: r.n_cites, usage: r.usage || null }))
  };

  await fsp.mkdir(RES_DIR, { recursive: true });
  await fsp.writeFile(fp, JSON.stringify(summary, null, 1), 'utf8');

  console.log('');
  console.log('成功 ' + summary.n_ok + ' / ' + summary.n_jobs +
    '  失败 ' + summary.n_fail);
  console.log('平均 ' + (summary.ms_avg / 1000).toFixed(1) + 's · ' + summary.rounds_avg +
    ' 轮 · ' + summary.calls_avg + ' 次工具 · ' + summary.cites_avg + ' 条出处');
  console.log('token 输入 ' + tokIn + ' / 输出 ' + tokOut +
    '  折合约 ¥' + summary.cost_cny_est + '（估算）');
  console.log('批次摘要 → ' + fp);
  console.log('trace 全部落在 eval/traces/ 里，下一步跑： node eval/score.js --run-id ' + RUN_ID);
})();
