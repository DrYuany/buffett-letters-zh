/* 免费额度专项测试（不烧钱）：
   1. 新访客 health 应显示剩 10 次
   2. 额度用完的访客问话 → 服务端立刻拒绝（needKey），一个 token 都不花
   3. 用完后带（故意写错的）自带密钥 → 请求被转发给 DeepSeek，返回 401
      —— 能收到上游 401 就证明走的是访客的密钥，而不是站长的
   用法：node _quotatest.js   （需要 agent.js 已在 8099 跑着）
*/
const AGENT = 'http://127.0.0.1:8099';
const QFILE = require('path').join(__dirname, 'agent-quota.json');
const fs = require('fs');

let fail = 0;
const rec = (ok, name, detail) => { if (!ok) fail++; console.log((ok ? '✓ ' : '✗ ') + name.padEnd(26) + (detail || '')); };

function seed(vid, used) {
  let q = { visitors: {}, days: {} };
  try { q = JSON.parse(fs.readFileSync(QFILE, 'utf8')) || q; } catch (e) {}
  if (used == null) delete q.visitors[vid];
  else q.visitors[vid] = { used, ip: 'test', first: 't', last: 't' };
  fs.writeFileSync(QFILE, JSON.stringify(q));
}

async function sse(body) {
  const r = await fetch(AGENT + '/api/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await r.text();
  const events = {};
  text.split('\n\n').forEach(b => {
    const ev = (b.match(/event: (.+)/) || [])[1];
    const d = (b.match(/data: (.+)/) || [])[1];
    if (ev && d) events[ev] = JSON.parse(d);
  });
  return events;
}

(async () => {
  const VID = 'qt' + Date.now().toString(36);

  /* 1. 新访客：health 报 10 次 */
  seed(VID, null);
  const h = await (await fetch(AGENT + '/api/health?vid=' + VID)).json();
  rec(h.ok && h.freeLeft === 10 && h.freeTotal === 10,
    '新访客免费 10 次', 'freeLeft=' + h.freeLeft + ' freeTotal=' + h.freeTotal + ' keyMode=' + h.keyMode);

  /* 2. 额度用完、没填密钥 → 立刻拒绝，且不发 start 之后的东西 */
  seed(VID, 10);
  const h2 = await (await fetch(AGENT + '/api/health?vid=' + VID)).json();
  rec(h2.freeLeft === 0, '用完后 health 报 0', 'freeLeft=' + h2.freeLeft);
  const e2 = await sse({ message: '你好', vid: VID, session: 'qt' });
  rec(e2.error && e2.error.needKey === true, '用完拒答并提示填密钥',
    JSON.stringify(e2.error || e2).slice(0, 90));
  rec(!e2.done && !e2.sources, '拒答时没有继续跑 agent', e2.done ? '竟然跑完了' : '干净');

  /* 3. 用完后带（错的）自带密钥 → 转发给上游，401 证明用的是访客的密钥 */
  const e3 = await sse({ message: '你好', vid: VID, session: 'qt', key: 'sk-invalidkeyfortest123456' });
  rec(e3.error && /401|Unauthorized|无效/i.test(e3.error.message), '用完后自带密钥接管',
    JSON.stringify(e3.error || e3).slice(0, 90));

  /* 4. 不带访客号 → 按 IP 兜底记账，照常发免费额度（这是设计行为：
        匿名访客也能领 10 次，只是记账本换成 IP），能看见 quota 事件就算对 */
  const e4 = await sse({ message: '你好', session: 'qt2' });
  rec(e4.quota && e4.quota.keySource === 'free' && e4.quota.total === 10,
    '不带访客号按 IP 记账', JSON.stringify(e4.quota || e4.error || e4).slice(0, 90));

  /* 收尾：把测试在账本里留下的痕迹清掉（测试访客 + 按 IP 记的账） */
  try {
    const q = JSON.parse(fs.readFileSync(QFILE, 'utf8'));
    Object.keys(q.visitors || {}).forEach(v => { if (v === VID || /^ip:/.test(v)) delete q.visitors[v]; });
    fs.writeFileSync(QFILE, JSON.stringify(q));
  } catch (e) {}

  seed(VID, null);
  console.log('\n失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
