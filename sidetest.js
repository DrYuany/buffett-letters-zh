/* 真实 Chrome：专测左侧栏 —— 用真实鼠标坐标点击（能抓出遮挡），全量测所有链接 */
const { spawn } = require('child_process');
const os = require('os'), path = require('path');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9337;
const BASE = process.argv[2] || 'http://127.0.0.1:8099/index.html';
const W = +(process.argv[3] || 1440);
const H = +(process.argv[4] || 900);

let ws, id = 0; const pending = new Map();
function send(m, p = {}, s) { return new Promise((res, rej) => { const i = ++id; pending.set(i, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: i, method: m, params: p, sessionId: s })); }); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception || {}).description || r.exceptionDetails.text);
  return r.result.value;
}
/* 真实鼠标：按下 + 松开，坐标是页面 CSS 像素 */
async function realClick(x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
  await sleep(20);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await sleep(20);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(30);
}

(async () => {
  const ch = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
    '--remote-debugging-port=' + PORT, '--window-size=' + W + ',' + H,
    '--user-data-dir=' + path.join(os.tmpdir(), 'wbtest' + Date.now()), BASE], { stdio: 'ignore' });
  let t = null;
  for (let i = 0; i < 60 && !t; i++) {
    try { const a = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); t = a.find(x => x.type === 'page'); } catch (e) {}
    if (!t) await sleep(400);
  }
  ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise(r => { ws.onopen = r; });
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } };
  await sleep(9000);

  const rep = {};
  rep.viewport = await ev('({w: innerWidth, h: innerHeight})');
  rep.bootGone = await ev('!document.getElementById("boot")');
  rep.sidebarRect = await ev('(()=>{const r=document.getElementById("sidebar").getBoundingClientRect();return {x:Math.round(r.x),w:Math.round(r.width),h:Math.round(r.height)};})()');
  rep.hamburgerVisible = await ev('(()=>{const b=document.getElementById("hamb");return getComputedStyle(b).display!=="none";})()');

  /* 遮挡检测：侧栏正中垂直一排点，看命中的是谁 */
  rep.hitTest = await ev(`(()=>{
    const sr = document.getElementById('sidebar').getBoundingClientRect();
    const out=[];
    for (const y of [120,180,240,300,360,440,520,600]) {
      const el = document.elementFromPoint(sr.x + sr.width/2, y);
      out.push(y+':'+(el? el.tagName+'.'+String(el.className).split(' ')[0] : 'null'));
    }
    return out;
  })()`);

  /* 若侧栏是抽屉（窄屏），先真实点汉堡打开 */
  if (rep.sidebarRect.x < -10) {
    await realClick(30, 30);
    await sleep(400);
    rep.afterHamburger = await ev('(()=>{const r=document.getElementById("sidebar").getBoundingClientRect();return {x:Math.round(r.x), open:document.getElementById("sidebar").classList.contains("open")};})()');
  }

  /* 逐个分组：真实鼠标点标题展开，再真实鼠标点里面每一条链接 */
  const groups = ['idx', 'partner', 'berk', 'special', 'concept', 'company', 'people'];
  const fails = [];
  let clicked = 0;

  for (const gid of groups) {
    // 展开
    const opened = await ev(`(()=>{
      const t=document.querySelector('.nav-group-title[data-g="${gid}"]'); if(!t) return null;
      const g=document.getElementById('g_${gid}'); if(!g) return null;
      if(!g.classList.contains('open')) t.click();
      const r=t.getBoundingClientRect();
      return {y: r.y + r.height/2, x: r.x + 40, n: g.querySelectorAll('.nav-link').length,
              open: g.classList.contains('open')};
    })()`);
    if (!opened) { fails.push(gid + ':分组缺失'); continue; }

    const links = await ev(`(()=>{
      const g=document.getElementById('g_${gid}');
      return [...g.querySelectorAll('.nav-link')].map((a,i)=>{
        const r=a.getBoundingClientRect();
        return {i, href:a.getAttribute('href'), text:a.textContent, y: r.y + r.height/2, x: r.x + 40, vis: r.height>0};
      });
    })()`);

    for (const lk of links) {
      // 侧栏可能很长，超出视口的先滚进视口
      const pos = await ev(`(()=>{
        const g=document.getElementById('g_${gid}');
        const a=g.querySelectorAll('.nav-link')[${lk.i}];
        a.scrollIntoView({block:'center'});
        const r=a.getBoundingClientRect();
        return {x: r.x + Math.min(60, r.width/2), y: r.y + r.height/2, inView: r.y>0 && r.y<innerHeight};
      })()`);
      if (!pos.inView) continue;

      const hit = await ev(`(()=>{const el=document.elementFromPoint(${pos.x}, ${pos.y}); return el? el.tagName+'.'+String(el.className).split(' ')[0]+'|'+(el.textContent||'').slice(0,12) : 'null';})()`);
      const beforeHash = await ev('location.hash');
      await realClick(pos.x, pos.y);
      await sleep(120);
      const after = await ev(`(()=>{
        const app=document.getElementById('app');
        const txt=app.innerText||'';
        return {hash: location.hash, len: txt.length, head: txt.slice(0,44).replace(/\\n/g,' '),
                active: (document.querySelector('#snav .nav-link.active')||{}).textContent || ''};
      })()`);
      clicked++;
      const okHash = after.hash && after.hash !== '#/' || lk.href === '#/';
      const ok = after.hash === lk.href && after.len > 40 && !/undefined|NaN|\[object Object\]/.test(await ev('document.getElementById("app").innerText'));
      if (!ok) fails.push(`${gid}[${lk.i}] ${lk.text} | href=${lk.href} | 命中=${hit} | 点击后 hash=${after.hash} | 内容长度=${after.len} | ${after.head}`);
    }
  }

  rep.clicked = clicked;
  rep.fails = fails;
  rep.failCount = fails.length;
  console.log(JSON.stringify(rep, null, 1));
  try { ch.kill(); } catch (e) {}
  process.exit(0);
})();
