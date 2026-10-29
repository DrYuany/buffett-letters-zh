const { spawn } = require('child_process');
const os = require('os'), path = require('path');
const PORT = 9388, BASE = 'http://127.0.0.1:8099/index.html';
const CHROME = 'C://Program Files\\Google\\Chrome\\Application\\chrome.exe';
let ws, id = 0; const p = new Map();
const send = (m, pa = {}, s) => new Promise((res, rej) => { const i = ++id; p.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: pa, sessionId: s })); });
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const ch = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + path.join(os.tmpdir(), 'wbfact' + Date.now()), '--window-size=1440,900', BASE], { stdio: 'ignore' });
  let t = null;
  for (let i = 0; i < 80; i++) { try { const a = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); t = a.find(x => x.type === 'page'); if (t) break; } catch (e) {} await sleep(400); }
  ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && p.has(m.id)) { const q = p.get(m.id); p.delete(m.id); m.error ? q.rej(new Error(JSON.stringify(m.error))) : q.res(m.result); } };
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  await send('Page.navigate', { url: BASE }, sessionId);
  await sleep(9000);
  const r = await send('Runtime.evaluate', { expression: `(function(){
    return JSON.stringify({
      NROUTE: NROUTE, TOTCHARS: TOTCHARS,
      letters: C.letters.length, concepts: C.concepts.length, companies: C.companies.length,
      people: C.people.length, NYEAR: NYEAR,
      years: [C.letters[0].year, C.letters[C.letters.length-1].year],
      corr: (CONTENT.corrections||[]).length,
      ct_concepts: Object.keys(CONTENT.concepts).length,
      ct_companies: Object.keys(CONTENT.companies).length,
      blocks: (function(){ var n=0; for (var k in LETTERS) n += LETTERS[k].blocks.length; return n; })(),
      hint: (document.querySelector('.changelog-hint')||{}).innerText,
      AUD: [AUD_ROUTE, AUD_HIT, AUD_CLICK]
    });
  })()`, returnByValue: true }, sessionId);
  console.log(r.result.value);
  try { ch.kill(); } catch (e) {}
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
