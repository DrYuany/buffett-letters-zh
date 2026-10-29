/* 真实浏览器点击回归：CDP 驱动 Chrome，逐个元素 el.click() 并校验落地结果。
   与 clicktest.js 的区别：clicktest 用自建 DOM 引擎，这里用真浏览器，能抓到
   "引擎里通过、浏览器里点不动" 的那类问题（事件没绑、被遮挡、handler 抛错等）。

   判定口径（避免把"点了本来就不该变"误判成失败）：
     1. 先向上找真正持有 onclick 的祖先，或包着它的 <a href>
     2. 找不到 → 失败：看着能点（cursor:pointer）但没绑任何处理器
     3. 找到 <a> → 目标路由与当前不同就必须真的跳转；相同则算通过（自链）
     4. 找到 onclick → 临时包一层探测它有没有被触发；没触发 = 失败
        触发了但页面没变化，视为状态已相同的空操作，算通过 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9333;
const LIMIT = +(process.argv[2] || 25);      // 普通路由每页最多测多少个可点元素
const FULL = +(process.argv[3] || 260);      // 代表性路由的深测上限
const BASE = process.argv[4] || 'http://127.0.0.1:8099/index.html';

/* ---------- CDP 客户端 ---------- */
let ws, msgId = 0;
const pending = new Map();
const events = [];

function send(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
}

async function connect() {
  const listUrl = `http://127.0.0.1:${PORT}/json/list`;
  let target = null;
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(listUrl);
      const arr = await r.json();
      target = arr.find(t => t.type === 'page');
      if (target) break;
    } catch (e) { /* 还没起来 */ }
    await new Promise(r => setTimeout(r, 400));
  }
  if (!target) throw new Error('拿不到 page target');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    } else if (m.method) events.push(m);
  };
}

async function evaluate(expr, sessionId) {
  const r = await send('Runtime.evaluate', {
    expression: `(async()=>{ ${expr} })()`,
    awaitPromise: true, returnByValue: true
  }, sessionId);
  if (r.exceptionDetails) {
    throw new Error('页面内异常: ' + String(r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text).slice(0, 300));
  }
  return r.result.value;
}

/* ---------- 页面内脚本 ---------- */
const P_ROUTES = `
  const idx = ['#/', '#/score', '#/concept', '#/corr', '#/rules', '#/decide', '#/ents'];
  const cos = CORE.companies.map(c => c.name);
  const cps = CORE.concepts.map(c => c.name);
  const all = idx.slice();
  cos.forEach(n => all.push('#/co/' + encodeURIComponent(n)));
  cps.forEach(n => all.push('#/c/' + encodeURIComponent(n)));
  CORE.people.forEach(p => all.push('#/e/people/' + encodeURIComponent(p.name)));
  for (let y = 1956; y <= 2025; y++) all.push('#/y/' + y);
  CORE.letters.forEach((l, i) => { if (i % 6 === 0) all.push('#/l/' + encodeURIComponent(l.id)); });
  all.push('#/l/' + encodeURIComponent('1988 巴菲特致股东信'));
  const deep = idx.concat([
    '#/l/' + encodeURIComponent('1988 巴菲特致股东信'),
    '#/l/' + encodeURIComponent('1957 巴菲特致合伙人信'),
    '#/l/' + encodeURIComponent('2024 巴菲特致股东信'),
    '#/y/1988', '#/y/2000'
  ]);
  cos.slice(0, 6).forEach(n => deep.push('#/co/' + encodeURIComponent(n)));
  deep.push('#/co/' + encodeURIComponent('富国银行'), '#/co/' + encodeURIComponent('可口可乐'));
  cps.slice(0, 6).forEach(n => deep.push('#/c/' + encodeURIComponent(n)));
  deep.push('#/c/' + encodeURIComponent('护城河'), '#/c/' + encodeURIComponent('内在价值'));
  CORE.people.slice(0, 4).forEach(p => deep.push('#/e/people/' + encodeURIComponent(p.name)));
  return { all: all, deep: deep };
`;

const P_CLICK = `
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const route = __ROUTE__;
  const LIMIT = __LIMIT__;
  const fails = []; let clicks = 0;

  function setRoute(h){ if (location.hash !== h) location.hash = h; render(); }
  function appLen(){ const a = document.getElementById('app'); return a ? a.innerHTML.length : -1; }
  /* 只收"用户真的能点到"的元素：排除禁用按钮、pointer-events:none、
     以及标记为不可点的年份。这类元素点了没反应是设计如此，不是 bug。 */
  function collect(){
    const out = [];
    for (const el of document.querySelectorAll('#app *')) {
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') continue;
      if (el.disabled || (el.closest && el.closest('[disabled]'))) continue;
      let cs = null; try { cs = getComputedStyle(el); } catch (e) {}
      if (!cs) continue;
      if (cs.pointerEvents === 'none') continue;
      if (el.classList && el.classList.contains('noyr')) continue;
      if (cs.cursor === 'pointer' || (el.tagName === 'A' && el.getAttribute('href'))) out.push(el);
    }
    return out;
  }
  function actionable(el){
    let e = el;
    while (e && e !== document.body) {
      if (typeof e.onclick === 'function') return { kind: 'onclick', node: e };
      if (e.tagName === 'A' && e.getAttribute('href')) return { kind: 'a', target: e.getAttribute('href') };
      if (e.tagName === 'BUTTON') return { kind: 'button', node: e };
      e = e.parentElement;
    }
    return null;
  }
  function desc(el){
    return el.tagName.toLowerCase() +
      (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\\s+/).slice(0,2).join('.') : '') +
      (el.getAttribute && el.getAttribute('href') ? '[href=' + el.getAttribute('href').slice(0,40) + ']' : '') +
      (el.dataset && el.dataset.jump ? '[jump=' + el.dataset.jump.slice(0,40) + ']' : '') +
      ' « ' + String(el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 30);
  }
  function dirty(t){
    if (!t || t.trim().length < 50) return '落地页空白';
    const m = t.match(/undefined|\\[object Object\\]|NaN/);
    if (m) return '落地页含脏值 ' + m[0];
    return null;
  }

  /* 清掉跨渲染残留的 UI 状态，否则上一轮的点击会让这一轮的 DOM 变短、索引错位 */
  function resetState(){
    try { picks = {}; } catch (e) {}
    try { ruleQ = ''; } catch (e) {}
    try { coQ = ''; } catch (e) {}
    try { showEn = false; } catch (e) {}
  }
  resetState();
  setRoute(route); await sleep(50);
  const total = collect().length;
  const n = Math.min(total, LIMIT);

  for (let i = 0; i < n; i++) {
    resetState();
    setRoute(route); await sleep(25);
    const el = collect()[i];
    if (!el) { fails.push(['#' + i, '元素在重渲染后消失']); continue; }
    const d = desc(el);
    const act = actionable(el);
    if (!act) { fails.push([d, '看着能点但没绑处理器']); clicks++; continue; }

    const before = { hash: location.hash };
    let fired = false, restore = null;
    if (act.kind === 'onclick' || act.kind === 'button') {
      const node = act.node, orig = node.onclick;
      restore = function(){ node.onclick = orig; };
      node.onclick = function(){ fired = true; return orig.apply(this, arguments); };
    }
    try { el.click(); } catch (e) { if (restore) restore(); fails.push([d, 'click 抛错: ' + e.message]); continue; }
    await sleep(70);
    if (restore) restore();
    clicks++;

    const after = { hash: location.hash };
    if (act.kind === 'a') {
      const want = act.target.slice(1).split('?')[0];
      const cur0 = String(before.hash).slice(1).split('?')[0];
      if (want === cur0) continue;
      const got = String(after.hash).slice(1).split('?')[0];
      if (got !== want) { fails.push([d, '链接未到位: 应到 ' + want + ' 实际 ' + got]); continue; }
      const b = dirty((document.getElementById('app') || {}).innerText || '');
      if (b) { fails.push([d, b]); continue; }
    } else {
      if (!fired) { fails.push([d, '处理器没被触发（点了没反应）']); continue; }
      const b = dirty((document.getElementById('app') || {}).innerText || '');
      if (b) { fails.push([d, b]); continue; }
    }
  }
  return { route: route, total: total, tested: clicks, fails: fails };
`;

const P_SIDEBAR = `
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const fails = []; let n = 0;
  const links = Array.from(document.querySelectorAll('#snav a[href]'));
  for (const a of links) {
    const href = a.getAttribute('href');
    const want = href.slice(1).split('?')[0];
    if (location.hash !== href) location.hash = href;
    render();
    await sleep(30);
    n++;
    const got = String(location.hash || '#/').slice(1).split('?')[0];
    const t = (document.getElementById('app') || {}).innerText || '';
    if (got !== want) { fails.push([href, '导航未到位: 得到 ' + got]); continue; }
    if (t.trim().length < 50) { fails.push([href, '落地页空白']); continue; }
    if (/undefined|\\[object Object\\]/.test(t)) { fails.push([href, '落地页含脏值']); continue; }
  }
  return { total: links.length, tested: n, fails: fails };
`;

const P_TEXT = `
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const out = {};
  for (const h of __ROUTES__) {
    if (location.hash !== h) location.hash = h;
    render(); await sleep(25);
    const a = document.getElementById('app');
    out[h] = a ? a.innerText : '';
  }
  return out;
`;

(async function main() {
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + path.join(os.tmpdir(), 'wbcdp' + Date.now()),
    '--window-size=1440,900', BASE
  ], { stdio: 'ignore' });
  const cleanup = () => { try { chrome.kill(); } catch (e) {} };
  process.on('exit', cleanup);

  await connect();
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  await send('Page.enable', {}, sessionId);
  await send('Page.navigate', { url: BASE }, sessionId);
  await new Promise(r => setTimeout(r, 9000));

  const ready = await evaluate(`return { core: typeof CORE, app: ((document.getElementById('app')||{}).innerHTML||'').length };`, sessionId);
  console.log('页面状态:', JSON.stringify(ready));
  if (ready.app < 500) { console.log('✗ 首屏没渲染出来'); cleanup(); process.exit(1); }

  const grand = { clicks: 0, pages: 0, fails: [] };

  const sb = await evaluate(P_SIDEBAR, sessionId);
  console.log('\n=== 侧栏导航 ===');
  console.log('链接 ' + sb.total + ' 个，已测 ' + sb.tested + '，失败 ' + sb.fails.length);
  sb.fails.slice(0, 30).forEach(f => console.log('  ✗ ' + f[0] + '  ' + f[1]));
  grand.clicks += sb.tested; grand.pages++;
  grand.fails.push(...sb.fails.map(f => ['侧栏 ' + f[0], f[1]]));

  const { all, deep } = await evaluate(P_ROUTES, sessionId);
  console.log('\n=== 页面内点击 ===');
  console.log('普通路由 ' + all.length + ' 个 ×上限 ' + LIMIT + '；深测路由 ' + deep.length + ' 个 ×上限 ' + FULL);

  const plan = all.map(r => [r, deep.indexOf(r) >= 0 ? FULL : LIMIT]);
  for (let i = 0; i < plan.length; i++) {
    const r = plan[i][0], lim = plan[i][1];
    let res;
    try {
      res = await evaluate(P_CLICK.replace('__ROUTE__', JSON.stringify(r)).replace('__LIMIT__', String(lim)), sessionId);
    } catch (e) {
      console.log('  ! ' + r + ' 执行异常: ' + e.message.slice(0, 150));
      grand.fails.push([r, '执行异常: ' + e.message.slice(0, 100)]);
      continue;
    }
    grand.clicks += res.tested; grand.pages++;
    if (res.fails.length) {
      console.log('  ✗ ' + r + '  ' + res.fails.length + '/' + res.total);
      res.fails.slice(0, 8).forEach(f => console.log('      · ' + f[0] + '\n        → ' + f[1]));
      grand.fails.push(...res.fails.map(f => [r + ' » ' + f[0], f[1]]));
    }
    if ((i + 1) % 25 === 0) console.log('  … 进度 ' + (i + 1) + '/' + plan.length + '，累计 ' + grand.clicks + ' 次点击，失败 ' + grand.fails.length);
  }

  console.log('\n=== 导出渲染文本（供乱码/错别字检查）===');
  const texts = await evaluate(P_TEXT.replace('__ROUTES__', JSON.stringify(all)), sessionId);
  fs.writeFileSync('_rendered_text.json', JSON.stringify(texts), 'utf8');
  console.log('已导出 ' + Object.keys(texts).length + ' 页');

  console.log('\n========== 汇总 ==========');
  console.log('覆盖页面 ' + grand.pages + ' 个');
  console.log('实际点击 ' + grand.clicks + ' 次');
  console.log('失败 ' + grand.fails.length + ' 项');
  if (grand.fails.length) {
    console.log('\n--- 失败明细 ---');
    grand.fails.slice(0, 60).forEach(f => console.log('  ✗ ' + f[0] + '\n      ' + f[1]));
    fs.writeFileSync('_browser_fails.json', JSON.stringify(grand.fails, null, 1), 'utf8');
  } else console.log('全部通过');
  cleanup();
  process.exit(grand.fails.length ? 2 : 0);
})().catch(e => { console.error('驱动层错误:', e); process.exit(1); });
