/* 窄屏抽屉态专项：点汉堡 -> 展开 -> 真实点击链接 -> 验证跳转 + 抽屉关闭 + scrim 移除 */
const { spawn } = require('child_process');
const os = require('os'), path = require('path');
const { pathToFileURL } = require('url');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9338;
const BASE = process.argv.includes('--file')
  ? pathToFileURL(path.join(__dirname, 'site', 'index.html')).href
  : 'http://127.0.0.1:8099/index.html';
/* 宽度可用 W=390 之类覆盖：手机竖屏的抽屉行为和 760 并不一样 */
const W = +(process.env.W || 760), H = +(process.env.H || 800);

let ws, id = 0; const pending = new Map();
function send(m, p = {}) { return new Promise((res, rej) => { const i = ++id; pending.set(i, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); }); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception || {}).description || r.exceptionDetails.text);
  return r.result.value;
}
async function realClick(x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await sleep(20);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(30);
}
/* 保证抽屉打开，返回目标链接的屏幕坐标（把链接滚进视口） */
async function openAndGet(gid, idx) {
  return ev(`(async()=>{
    const sb=document.getElementById('sidebar');
    if (!sb.classList.contains('open')){ document.getElementById('hamb').click(); await new Promise(r=>setTimeout(r,350)); }
    const t=document.querySelector('.nav-group-title[data-g="${gid}"]');
    const g=document.getElementById('g_${gid}');
    if(t && g && !g.classList.contains('open')) t.click();
    const a=g.querySelectorAll('.nav-link')[${idx}];
    a.scrollIntoView({block:'center'});
    await new Promise(r=>setTimeout(r,60));
    const r=a.getBoundingClientRect();
    return {x: Math.round(r.x+40), y: Math.round(r.y+r.height/2), sbx: Math.round(document.getElementById('sidebar').getBoundingClientRect().x),
            hit: (document.elementFromPoint(Math.round(r.x+40), Math.round(r.y+r.height/2))||{}).className||'null'};
  })()`);
}

(async () => {
  const ch = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--remote-debugging-port=' + PORT,
    '--window-size=' + W + ',' + H, '--user-data-dir=' + path.join(os.tmpdir(), 'wbd' + Date.now()), BASE], { stdio: 'ignore' });
  let t = null;
  for (let i = 0; i < 60 && !t; i++) {
    try { const a = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); t = a.find(x => x.type === 'page'); } catch (e) {}
    if (!t) await sleep(400);
  }
  ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise(r => { ws.onopen = r; });
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } };
  await sleep(9000);

  /* 每条都写死期望的路由前缀：之前拿分组 id 拼前缀，索引组里的
     记分牌 / 规则库永远对不上，属于测试自己的误判 */
  const cases = [
    ['idx', 2, '公司记分牌', '#/score'],
    ['berk', 3, '某封股东信', '#/l/'],
    ['company', 0, '某公司', '#/co/'],
    ['concept', 0, '某概念', '#/c/'],
    ['people', 0, '某人物', '#/e/people/'],
    ['idx', 5, '规则库', '#/rules']
  ];
  const out = [];
  for (const [gid, idx, label, expect] of cases) {
    const p = await openAndGet(gid, idx);
    await realClick(p.x, p.y);
    await sleep(200);
    const st = await ev(`({
      hash: location.hash,
      len: document.getElementById('app').innerText.length,
      head: document.getElementById('app').innerText.slice(0,40).replace(/\\n/g,' '),
      drawerOpen: document.getElementById('sidebar').classList.contains('open'),
      scrimOn: document.getElementById('scrim').classList.contains('on')
    })`);
    out.push({ label, gid, pos: p, result: st,
      /* 跳转成功还不够：抽屉必须自己收回去，遮罩也要撤掉，否则人会卡在半开的菜单里 */
      ok: st.hash.indexOf(expect) >= 0 && st.len > 60 && !st.drawerOpen && !st.scrimOn });
  }
  console.log(JSON.stringify(out, null, 1));
  try { ch.kill(); } catch (e) {}
  process.exit(0);
})();
