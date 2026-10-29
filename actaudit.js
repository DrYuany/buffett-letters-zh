/* 无 href 的可点元素专项：真实鼠标点击，校验"点了有没有发生预期的事"
   覆盖 .yr / .pcard / .ax / .snip / .ent / .opt / .nav-group-title
        / [data-jump] 整块可点条目 / 阅读页上下一篇 / 搜索下拉
   用法：node actaudit.js --file   或   node actaudit.js [BASE]
*/
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9355;
const FILE_URL = pathToFileURL(path.join(__dirname, 'site', 'index.html')).href;
const BASE = process.argv.includes('--file') ? FILE_URL : (process.argv[2] || 'http://127.0.0.1:8099/index.html');

let ws, msgId = 0; const pending = new Map();
function send(m, p = {}, s) {
  return new Promise((res, rej) => {
    const id = ++msgId; pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method: m, params: p, sessionId: s }));
  });
}
async function connect() {
  let t = null;
  for (let i = 0; i < 80; i++) {
    try { const a = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      t = a.find(x => x.type === 'page'); if (t) break; } catch (e) {}
    await new Promise(r => setTimeout(r, 400));
  }
  if (!t) throw new Error('no target');
  ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = e => { const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } };
}
async function ev(expr, s) {
  const r = await send('Runtime.evaluate', { expression: `(async()=>{ ${expr} })()`, awaitPromise: true, returnByValue: true }, s);
  if (r.exceptionDetails) throw new Error('页面异常: ' + String(r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text).slice(0, 240));
  return r.result.value;
}

/* 在页面里：定位第 i 个匹配元素，滚进视口，返回中心点与遮挡信息 */
const GEO = `
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const sel = __SEL__, idx = __IDX__;
  const els = Array.from(document.querySelectorAll(sel)).filter(e => {
    const cs = getComputedStyle(e);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    const r = e.getBoundingClientRect();
    return r.width > 2 && r.height > 2;
  });
  if (idx >= els.length) return { skip: 'only ' + els.length };
  const el = els[idx];
  el.scrollIntoView({ block: 'center' });
  await sleep(25);
  const rects = el.getClientRects();
  const r = (rects && rects.length) ? rects[0] : el.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) return { skip: 'out of view' };
  const top = document.elementFromPoint(cx, cy);
  let occ = null;
  if (top !== el && !el.contains(top) && !(top && top.contains(el))) occ = top ? top.tagName.toLowerCase() + '.' + String(top.className||'').trim().split(/\\s+/)[0] : 'null';
  return { x: cx, y: cy, occ: occ, total: els.length,
           jump: el.getAttribute('data-jump'),
           text: (el.innerText||'').replace(/\\s+/g,' ').trim().slice(0,26) };
`;

(async function () {
  const ch = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + path.join(os.tmpdir(), 'wbact' + Date.now()),
    '--window-size=1440,900', BASE], { stdio: 'ignore' });
  process.on('exit', () => { try { ch.kill(); } catch (e) {} });
  await connect();
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  await send('Page.enable', {}, sessionId);
  await send('Page.navigate', { url: BASE }, sessionId);
  await new Promise(r => setTimeout(r, 9000));
  await ev(`document.documentElement.style.scrollBehavior='auto'; return 1;`, sessionId);

  const cases = [
    { name: '年份格 .yr', page: '#/', sel: '.yr', n: 8, expect: 'hash:/y/' },
    { name: '路径卡 .pcard', page: '#/', sel: '.pcard', n: 5, expect: 'hash:#' },
    { name: '概念云 .ctag', page: '#/', sel: '.ctag', n: 6, expect: 'hash:#' },
    { name: '人物卡 .person-card', page: '#/', sel: '.person-card', n: 4, expect: 'hash:#' },
    { name: '正文实体 .ent', page: '#/l/' + encodeURIComponent('1988 巴菲特致股东信'), sel: '.ent', n: 8, expect: 'hash:/e/' },
    { name: '摘录块 .snip', page: '#/e/people/芒格', sel: '.snip', n: 4, expect: 'hash:/l/' },
    { name: '年份轴 .ax', page: '#/co/可口可乐', sel: '.ax.on', n: 4, expect: 'scroll' },
    { name: '决策选项 .opt', page: '#/decide', sel: '.opt[data-d]', n: 8, expect: 'reveal' },
    { name: '侧栏分组 .nav-group-title', page: '#/', sel: '#snav .nav-group-title', n: 7, expect: 'expand' },
    /* 整块可点的条目：记事本的 data-jump 属性就是它该去的地址，点完必须一字不差地落在那里 */
    { name: '规则条目 .rule', page: '#/rules', sel: '.rule[data-jump]', n: 5, expect: 'jumpattr' },
    { name: '认错条目 .ci', page: '#/corr', sel: '.ci[data-jump]', n: 5, expect: 'jumpattr' },
    { name: '原话摘引 .quote', page: '#/c/护城河', sel: '.quote[data-jump]', n: 4, expect: 'jumpattr' },
    { name: '分期 .period', page: '#/c/复利', sel: '.period[data-jump]', n: 3, expect: 'jumpattr' },
    /* 阅读页上下篇：button 没有 href，最容易漏测 */
    { name: '上一篇 #t-up', page: '#/l/' + encodeURIComponent('1988 巴菲特致股东信'), sel: '#t-up', n: 1, expect: 'nav' },
    { name: '下一篇 #t-dn', page: '#/l/' + encodeURIComponent('1988 巴菲特致股东信'), sel: '#t-dn', n: 1, expect: 'nav' },
    { name: '搜索结果', page: '#/', sel: null, n: 0, expect: 'search' }
  ];

  const fails = []; let clicks = 0;

  for (const c of cases) {
    if (!c.sel) continue;
    await ev(`if(location.hash!==${JSON.stringify(c.page)})location.hash=${JSON.stringify(c.page)}; render(); await new Promise(r=>setTimeout(r,120)); return 1;`, sessionId);
    // 先取总数
    const total = await ev(`
      const els=[...document.querySelectorAll(${JSON.stringify(c.sel)})].filter(e=>{
        const cs=getComputedStyle(e); if(cs.display==='none'||cs.visibility==='hidden')return false;
        const r=e.getBoundingClientRect(); return r.width>2&&r.height>2;});
      return els.length;`, sessionId);
    const take = Math.min(total, c.n);
    let ok = 0;
    for (let i = 0; i < take; i++) {
      // 每个元素都重渲染一次，保证索引稳定
      await ev(`try{picks={};}catch(e){}
        if(location.hash!==${JSON.stringify(c.page)})location.hash=${JSON.stringify(c.page)};
        render(); await new Promise(r=>setTimeout(r,60)); return 1;`, sessionId);
      const geo = await ev(GEO.replace('__SEL__', JSON.stringify(c.sel)).replace('__IDX__', String(i)), sessionId);
      if (geo.skip) continue;
      if (geo.occ) { fails.push([c.name, i, '被 ' + geo.occ + ' 遮挡', geo.text]); continue; }

      const before = await ev(`return { h: location.hash, y: window.scrollY,
        open: document.querySelectorAll('#snav .nav-group-items.open').length,
        rev: document.querySelectorAll('.reveal').length };`, sessionId);

      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: geo.x, y: geo.y }, sessionId);
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: geo.x, y: geo.y, button: 'left', clickCount: 1 }, sessionId);
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: geo.x, y: geo.y, button: 'left', clickCount: 1 }, sessionId);
      await new Promise(r => setTimeout(r, 120));
      clicks++;

      const after = await ev(`return { h: location.hash, y: window.scrollY,
        open: document.querySelectorAll('#snav .nav-group-items.open').length,
        rev: document.querySelectorAll('.reveal').length,
        len: (document.getElementById('app')||{}).innerText.trim().length };`, sessionId);

      let good = false;
      if (c.expect === 'hash:/y/') good = /^#\/y\/\d/.test(after.h);
      else if (c.expect === 'hash:#') good = after.h !== before.h;
      else if (c.expect === 'hash:/e/') good = /^#\/e\//.test(after.h);
      else if (c.expect === 'hash:/l/') good = /^#\/l\//.test(after.h);
      else if (c.expect === 'scroll') good = after.y !== before.y;
      else if (c.expect === 'reveal') good = after.rev > before.rev;
      else if (c.expect === 'expand') good = after.open !== before.open;
      else if (c.expect === 'jumpattr') good = !!geo.jump && after.h === geo.jump;
      else if (c.expect === 'nav') good = /^#\/l\//.test(after.h) && after.h !== before.h;
      if (good) ok++;
      else fails.push([c.name, i, '点击无效果', '「' + geo.text + '」 ' + before.h + ' → ' + after.h]);
    }
    console.log((ok === take ? '✓' : '✗') + ' ' + c.name + '  ' + ok + '/' + take + ' 生效');
  }

  /* 搜索框：输入后点第一条结果 */
  await ev(`location.hash='#/'; render(); await new Promise(r=>setTimeout(r,120)); return 1;`, sessionId);
  const sq = await ev(`
    const q=document.getElementById('q'); q.value='可口'; 
    q.dispatchEvent(new Event('input',{bubbles:true}));
    await new Promise(r=>setTimeout(r,400));
    const box=document.getElementById('qres');
    return { n: box.querySelectorAll('a.sr-item').length, all: !!box.querySelector('a.sr-all') };`, sessionId);
  console.log('搜索下拉：结果 ' + sq.n + ' 条，全部结果入口 ' + (sq.all ? '有' : '无'));
  if (sq.n) {
    const g2 = await ev(`
      const a=document.querySelector('#qres a.sr-item');
      a.scrollIntoView({block:'center'}); await new Promise(r=>setTimeout(r,20));
      const r=a.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2};`, sessionId);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: g2.x, y: g2.y }, sessionId);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: g2.x, y: g2.y, button: 'left', clickCount: 1 }, sessionId);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: g2.x, y: g2.y, button: 'left', clickCount: 1 }, sessionId);
    await new Promise(r => setTimeout(r, 200));
    const h = await ev(`return location.hash;`, sessionId);
    console.log('点第一条搜索结果 → ' + h + (h.length > 2 ? ' ✓' : ' ✗'));
    clicks++;
    if (h.length <= 2) fails.push(['搜索下拉', 0, '点结果未跳转', h]);
  }

  console.log('\n无 href 元素真实点击 ' + clicks + ' 次，失败 ' + fails.length);
  fails.slice(0, 40).forEach(f => console.log('  ✗ ' + f[0] + ' #' + f[1] + '  ' + f[2] + ' ' + (f[3] || '')));
  fs.writeFileSync('_actaudit.json', JSON.stringify(fails, null, 1), 'utf8');
  try { ch.kill(); } catch (e) {}
  process.exit(fails.length ? 2 : 0);
})().catch(e => { console.error('驱动层错误:', e); process.exit(1); });
