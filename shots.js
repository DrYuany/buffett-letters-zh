/* 截图：node shots.js [宽] [路由1] [路由2] ...
   不带参数则截默认一组路由 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9341;
const BASE = process.argv.includes('--file')
  ? pathToFileURL(path.join(__dirname, 'site', 'index.html')).href
  : 'http://127.0.0.1:8099/index.html';
const W = +(process.argv.find(a => /^\d+$/.test(a)) || 1440);
const CLI_ROUTES = process.argv.filter(a => a.startsWith('#/'));
/* 想看页面底部某个块（页脚、校验条）时，用 SHOT_SCROLL=<选择器> 把它滚到视口中间再截 */
const SCROLL_SEL = process.env.SHOT_SCROLL || '';
const routes = CLI_ROUTES.length ? CLI_ROUTES
  : JSON.parse(fs.readFileSync(path.join(__dirname, '_shot_routes.json'), 'utf8'));

let ws, msgId = 0; const pending = new Map();
function send(m, p = {}, s) {
  return new Promise((res, rej) => {
    const id = ++msgId; pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method: m, params: p, sessionId: s }));
  });
}
async function connect() {
  let t = null;
  for (let i = 0; i < 60; i++) {
    try { const a = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      t = a.find(x => x.type === 'page'); if (t) break; } catch (e) {}
    await new Promise(r => setTimeout(r, 400));
  }
  ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = e => { const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(JSON.parse(JSON.stringify(m.result))); } };
}
(async () => {
  const ch = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + path.join(os.tmpdir(), 'wbshot' + Date.now()),
    `--window-size=${W},1000`, BASE], { stdio: 'ignore' });
  process.on('exit', () => { try { ch.kill(); } catch (e) {} });
  await connect();
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  await send('Page.enable', {}, sessionId);
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: 1000, deviceScaleFactor: 1, mobile: false }, sessionId);
  await send('Page.navigate', { url: BASE }, sessionId);
  await new Promise(r => setTimeout(r, 9000));
  await send('Runtime.evaluate', { expression: "document.documentElement.style.scrollBehavior='auto'" }, sessionId);

  fs.mkdirSync('shots', { recursive: true });
  for (const r of routes) {
    await send('Runtime.evaluate', { expression: `location.hash=${JSON.stringify(r)}; render();` }, sessionId);
    await new Promise(x => setTimeout(x, 700));
    if (SCROLL_SEL) {
      await send('Runtime.evaluate', {
        expression: `(function(){var e=document.querySelector(${JSON.stringify(SCROLL_SEL)});
          if(e) e.scrollIntoView({block:'center'});})()` }, sessionId);
      await new Promise(x => setTimeout(x, 500));
    }
    const { data } = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
    const name = 'shots/' + W + '_' + String(routes.indexOf(r)).padStart(2, '0') + '.png';
    fs.writeFileSync(name, Buffer.from(data, 'base64'));
    console.log('✓', name);
  }
  try { ch.kill(); } catch (e) {}
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
