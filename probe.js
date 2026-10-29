const { spawn } = require('child_process');
const os = require('os'), path = require('path');
const { pathToFileURL } = require('url');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9334;
const FILE_URL = pathToFileURL(path.join(__dirname, 'site', 'index.html')).href;
/* --file 直开本地文件，不需要起服务器（http.server 在这台机器上老被回收） */
const BASE = process.argv.includes('--file') ? FILE_URL : 'http://127.0.0.1:8099/index.html';
const EXPR = process.argv.filter(a => a !== '--file')[2];

let ws, id = 0; const pending = new Map();
function send(m, p = {}, s) { return new Promise((res, rej) => { const i = ++id; pending.set(i, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: i, method: m, params: p, sessionId: s })); }); }

(async () => {
  const ch = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + path.join(os.tmpdir(), 'wbprobe' + Date.now()), BASE], { stdio: 'ignore' });
  const kill = () => { try { ch.kill(); } catch (e) {} };
  let t = null;
  for (let i = 0; i < 60 && !t; i++) {
    try { const a = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); t = a.find(x => x.type === 'page'); } catch (e) {}
    if (!t) await new Promise(r => setTimeout(r, 400));
  }
  ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise(r => { ws.onopen = r; });
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } };
  await new Promise(r => setTimeout(r, 8000));
  /* W=520 可以按窄屏量：之前查一个问题，宽屏和窄屏的链接数差 8 条 */
  if (process.env.W) {
    await send('Emulation.setDeviceMetricsOverride', { width: +process.env.W, height: 900, deviceScaleFactor: 1, mobile: false });
    await new Promise(r => setTimeout(r, 600));
  }
  const r = await send('Runtime.evaluate', { expression: `(async()=>{ ${EXPR} })()`, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) console.log('异常:', (r.exceptionDetails.exception || {}).description || r.exceptionDetails.text);
  else console.log(JSON.stringify(r.result.value, null, 1));
  kill(); process.exit(0);
})();
