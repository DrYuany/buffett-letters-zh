/* 全站跳转审计
   三阶段：
     A 路由健康：每个路由直接落地，查空白 / "找不到" / 脏值
     B 链接清单：每页抓所有 a[href^="#"] 与 onclick 元素，记录是否可见、是否被遮挡
     C 真实鼠标：Input.dispatchMouseEvent 打真实坐标，校验 hash 变化 + 落地页可读
   用法：node linkaudit.js [BASE] [--full]
*/
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9337;
const FILE_URL = pathToFileURL(path.join(__dirname, 'site', 'index.html')).href;
const BASE = process.argv.includes('--file') ? FILE_URL
  : (process.argv[2] && !process.argv[2].startsWith('--')) ? process.argv[2]
  : 'http://127.0.0.1:8099/index.html';
const FULL = process.argv.includes('--full');

let ws, msgId = 0;
const pending = new Map();

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
      const arr = await (await fetch(listUrl)).json();
      target = arr.find(t => t.type === 'page');
      if (target) break;
    } catch (e) {}
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
    }
  };
}
async function evaluate(expr, sessionId) {
  const r = await send('Runtime.evaluate', {
    expression: `(async()=>{ ${expr} })()`, awaitPromise: true, returnByValue: true
  }, sessionId);
  if (r.exceptionDetails) {
    throw new Error('页面内异常: ' + String(r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text).slice(0, 400));
  }
  return r.result.value;
}

/* ---------- 页面内：路由健康 ---------- */
/* ---------- 页面内：跳转助手 ----------
   踩过的坑一：连续给 location.hash 赋值，浏览器不会立刻提交上一次导航，
   紧接着 render() 读到的还是旧地址，于是"测的其实是上一页"。
   踩过的坑二：更狠的是 Chrome 会对脚本发起的同文档导航做节流，跑到 430 多个之后
   直接忽略 location.hash 赋值（实测卡死在 #/y/1985）。真实点击带用户手势，不受这个限制。
   所以审计里一律走 replaceState + render()，不排队、不限流；
   真要验证点击链路时再用真鼠标（那是 C2/D 阶段的事）。 */
const NAV = `
  /* 站点 CSS 写了 html{scroll-behavior:smooth}：scrollIntoView 会走几百毫秒动画。
     测完等 30ms 就取 rect，拿到的是滚动途中的旧坐标，elementFromPoint 于是点到
     别的东西上，报"被遮挡"。用户自己也会滚动，滚动不是缺陷，量位置就别让它动。 */
  document.documentElement.style.scrollBehavior = 'auto';
  const navTo = async (h) => {
    try { history.replaceState(null, '', h); } catch (e) { location.hash = h; }
    await new Promise(r => setTimeout(r, 0));
    render();
    return location.hash === h;
  };
`;

const P_HEALTH = `
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const out = [];
  for (const h of __ROUTES__) {
    const ok = await navTo(h);
    await sleep(6);
    const a = document.getElementById('app');
    const t = a ? a.innerText : '';
    const bad = [];
    if (!ok) bad.push('地址没能切到 ' + h);
    if (!a) bad.push('无 #app');
    else if (t.trim().length < 60) bad.push('空白(' + t.trim().length + ')');
    if (/undefined|\\[object Object\\]|NaN|找不到这个|没有这个实体/.test(t)) {
      bad.push('脏值: ' + (t.match(/undefined|\\[object Object\\]|NaN|找不到这个[^\\n]{0,6}|没有这个实体/) || [''])[0]);
    }
    out.push({ h: h, len: t.length, bad: bad, html: a ? a.innerHTML.length : 0 });
  }
  return out;
`;

/* ---------- 页面内：链接清单 ---------- */
const P_LINKS = `
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const routes = __ROUTES__;
  const all = new Set();
  let done = 0, err = '';
  const trace = [];
  for (const h of routes) {
    try {
      const ok = await navTo(h);
      await sleep(6);
      if (!ok) { err = h + ' → 地址没能切过去'; break; }
      let n = 0;
      for (const a of document.querySelectorAll('#app a[href]')) {
        const href = a.getAttribute('href');
        if (href && href[0] === '#') { all.add(href); n++; }
      }
      if (done < 12 || done % 60 === 0) trace.push(h.slice(0, 18) + ' n=' + n + ' u=' + all.size);
      done++;
    } catch (e) { err = h + ' → ' + (e && e.message); break; }
  }
  return { list: Array.from(all), done: done, err: err, trace: trace };
`;

/* ---------- 页面内：真鼠标点击 ---------- */
const P_REALCLICK = `
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const PAGE = __PAGE__;
  const href = __HREF__;
  const okPage = await navTo(PAGE);
  await sleep(10);
  if (!okPage) return { skip: '地址没能切到 ' + PAGE };
  // 该页可能有多个同 href 的链接，取第一个可见的
  let el = null;
  for (const a of document.querySelectorAll('#app a[href]')) {
    if (a.getAttribute('href') !== href) continue;
    if (!vis(a)) continue;
    el = a; break;
  }
  function vis(e) {
    const cs = getComputedStyle(e);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    const r = e.getBoundingClientRect();
    return r.width > 2 && r.height > 2;
  }
  if (!el) return { skip: '本页无可见的同名链接' };
  /* 判"遮挡"要稳：量一次就下结论会误伤 —— 刚 render 完的页面可能还在做入场
     动画/重排，30ms 时量到的位置差几像素，elementFromPoint 就落到父容器上。
     所以连量三次（30/80/80ms），三次都点不到才算真遮挡。 */
  let cx = 0, cy = 0, top = null, w = 0, h = 0;
  for (let tryN = 0; tryN < 3; tryN++) {
    el.scrollIntoView({ block: 'center' });
    await sleep(tryN === 0 ? 30 : 80);
    const rr = el.getBoundingClientRect();
    w = rr.width; h = rr.height;
    cx = rr.left + rr.width / 2; cy = rr.top + rr.height / 2;
    if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) {
      return { skip: '滚动后不在视口内 ' + Math.round(cx) + ',' + Math.round(cy) };
    }
    top = document.elementFromPoint(cx, cy);
    if (top === el || el.contains(top) || (top && top.contains(el))) { top = null; break; }
  }
  let occ = null;
  if (top) {
    /* 0×0 且落在视口左上角，只有一个解释：这个节点在测量期间被重新渲染换掉了。
       是页面在别处重绘（比如异步回调又 render 了一次），不是链接真的被盖住。 */
    if (w < 1 && h < 1) occ = '元素已被重绘（0×0，测的是旧节点）';
    else occ = top.tagName.toLowerCase() + (typeof top.className === 'string' ? '.' + top.className.trim().split(/\\s+/).slice(0,2).join('.') : '');
  }
  return { x: cx, y: cy, occ: occ, text: (el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 30) };
`;

const P_AFTER = `
  const a = document.getElementById('app');
  const t = a ? a.innerText : '';
  return { hash: location.hash, len: t.length,
    bad: /undefined|\\[object Object\\]|NaN|找不到这个|没有这个实体/.test(t) ? (t.match(/undefined|\\[object Object\\]|NaN|找不到这个[^\\n]{0,6}|没有这个实体/) || [''])[0] : null,
    sample: t.replace(/\\s+/g, ' ').slice(0, 60) };
`;

(async function main() {
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + path.join(os.tmpdir(), 'wbaudit' + Date.now()),
    '--window-size=1440,900', BASE
  ], { stdio: 'ignore' });
  const cleanup = () => { try { chrome.kill(); } catch (e) {} };
  process.on('exit', cleanup);

  await connect();
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  await send('Page.enable', {}, sessionId);
  const WARG = (process.argv.find(a => a.startsWith('--w=')) || '').slice(4);
  if (WARG) await send('Emulation.setDeviceMetricsOverride', { width: +WARG, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
  let ready = { core: 'undefined', app: 0 };
  /* 首屏没渲染出来，多半是这次导航自己没跑完（机器忙时 9 秒不够，或 Chrome 刚起
     还没就绪）。重载两次再判失败，不然整轮 446 个路由白跑。 */
  for (let attempt = 1; attempt <= 3; attempt++) {
    await send('Page.navigate', { url: BASE }, sessionId);
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 400));
      try {
        ready = await evaluate(`return { core: typeof CORE, app: ((document.getElementById('app')||{}).innerHTML||'').length };`, sessionId);
      } catch (e) { ready = { core: 'undefined', app: 0 }; }
      if (ready.app >= 500) break;
    }
    console.log('页面状态:', JSON.stringify(ready), attempt > 1 ? '(第 ' + attempt + ' 次加载)' : '');
    if (ready.app >= 500) break;
    if (attempt === 3) { console.log('✗ 首屏没渲染出来'); cleanup(); process.exit(1); }
  }
  await evaluate(`document.documentElement.style.scrollBehavior='auto'; return 1;`, sessionId);

  /* Chrome 对同一文档里的脚本导航有配额（hash 赋值、replaceState 都会被挡），
     一路跑下去会在 400 多次之后卡死，之后所有地址都切不过去。
     所以每跑 80 页就整页重载一次，把配额清零再继续。 */
  let sinceLoad = 0, reloads = 0;
  async function freshPage() {
    if (sinceLoad < 80) return;
    reloads++;
    await send('Page.navigate', { url: BASE }, sessionId);
    for (let i = 0; i < 80; i++) {
      await new Promise(r => setTimeout(r, 250));
      let ok = false;
      try { ok = await evaluate(`return ((document.getElementById('app')||{}).innerHTML||'').length > 500;`, sessionId); } catch (e) {}
      if (ok) break;
    }
    await evaluate(`document.documentElement.style.scrollBehavior='auto'; return 1;`, sessionId);
    sinceLoad = 0;
  }

  /* 1. 生成全量路由 */
  const routes = await evaluate(`
    const idx = ['#/','#/letters','#/score','#/concept','#/corr','#/rules','#/decide','#/ents','#/talk'];
    const all = idx.slice();
    CORE.letters.forEach(l => all.push('#/l/' + encodeURIComponent(l.id)));
    CORE.concepts.forEach(c => all.push('#/c/' + encodeURIComponent(c.name)));
    CORE.companies.forEach(c => all.push('#/co/' + encodeURIComponent(c.name)));
    CORE.concepts.forEach(c => all.push('#/e/concepts/' + encodeURIComponent(c.name)));
    CORE.companies.forEach(c => all.push('#/e/companies/' + encodeURIComponent(c.name)));
    CORE.people.forEach(p => all.push('#/e/people/' + encodeURIComponent(p.name)));
    for (let y = 1950; y <= 2030; y++) all.push('#/y/' + y);
    return all;
  `, sessionId);
  console.log('路由总数: ' + routes.length);

  /* 2. 路由健康 */
  console.log('\n=== A 路由健康 ===');
  const health = [];
  const CH = 45;
  for (let i = 0; i < routes.length; i += CH) {
    const chunk = routes.slice(i, i + CH);
    await freshPage();
    sinceLoad += chunk.length;
    const res = await evaluate(NAV + P_HEALTH.replace('__ROUTES__', JSON.stringify(chunk)), sessionId);
    health.push(...res);
    process.stdout.write('  ' + Math.min(i + CH, routes.length) + '/' + routes.length + '\r');
  }
  const badRoutes = health.filter(x => x.bad.length);
  console.log('');
  console.log('异常路由 ' + badRoutes.length + ' 个');
  badRoutes.slice(0, 60).forEach(x => console.log('  ✗ ' + x.h + '  len=' + x.len + '  ' + x.bad.join('; ')));

  /* 3. 链接清单（只跑有链接的页面；信件页抽 1/3 以免太慢）
        分块跑，每块 80 页、块前重载一次躲开 Chrome 的导航配额。
        每块只回传地址数组（几十 KB），不再回传逐页清单 —— 那才会被 CDP 截断。 */
  console.log('\n=== B 链接清单 ===');
  const sample = [];
  health.forEach((x, i) => {
    if (x.h.startsWith('#/l/')) { if (i % 3 === 0) sample.push(x.h); }
    else sample.push(x.h);
  });
  const hrefSet = new Set();
  const CL = 80;
  for (let i = 0; i < sample.length; i += CL) {
    const chunk = sample.slice(i, i + CL);
    await freshPage();
    sinceLoad += chunk.length;
    const res = await evaluate(NAV + P_LINKS.replace('__ROUTES__', JSON.stringify(chunk)), sessionId);
    for (const h of res.list) hrefSet.add(h);
    if (res.done !== chunk.length) console.log('  ! 第 ' + (i / CL + 1) + ' 块只跑完 ' + res.done + ' 页，中断于 ' + res.err);
    process.stdout.write('  ' + Math.min(i + CL, sample.length) + '/' + sample.length + '\r');
  }
  console.log('');
  const hrefs = Array.from(hrefSet);
  console.log('页面 ' + sample.length + ' 个，去重链接 ' + hrefs.length + ' 条（重载 ' + reloads + ' 次）');

  /* 4. 每个去重链接的落地检查（不点击，直接落地） */
  console.log('\n=== B2 链接落地 ===');
  const dead = [];
  const CB = 45;
  /* #/talk?q= 是同一路由的带参变体：落一次就自动问一次，会话越堆越长，
     后面的 C1 会把答案里的引用链接一起算进去。这里跳过，改由 talktest.js 专测。 */
  const land = hrefs.filter(h => h.indexOf('#/talk?') !== 0);
  for (let i = 0; i < land.length; i += CB) {
    const chunk = land.slice(i, i + CB);
    await freshPage();
    sinceLoad += chunk.length;
    const res = await evaluate(NAV + P_HEALTH.replace('__ROUTES__', JSON.stringify(chunk)), sessionId);
    res.forEach(x => { if (x.bad.length) dead.push(x); });
    process.stdout.write('  ' + Math.min(i + CB, land.length) + '/' + land.length + '\r');
  }
  console.log('');
  console.log('落地失败链接 ' + dead.length + ' 条');
  dead.slice(0, 60).forEach(x => console.log('  ✗ ' + x.h + '  ' + x.bad.join('; ')));

  /* 5. 全量命中测试：每条链接都滚进视口，检查中心点命中的是不是它自己。
        这一层能抓「被浮层/固定元素挡住」「宽高为 0」「跑出容器被裁掉」，
        而且不用真的跳转，所以可以把每页每条链接都测一遍。 */
  console.log('\n=== C1 全量可点性（遮挡/零尺寸） ===');
  /* 关键：链接清单和命中测试必须在同一次渲染里取，
     分两趟取会因为重渲染时序错位，测出一堆"链接不在 DOM 里"的假异常。 */
  const HITPAGE = `
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const out = [], list = [];
    const seen = new Set();
    for (const a of document.querySelectorAll('#app a[href]')) {
      const h = a.getAttribute('href');
      if (!h || h[0] !== '#' || seen.has(h)) continue;
      seen.add(h); list.push(h);
      const cs = getComputedStyle(a);
      if (cs.display === 'none' || cs.visibility === 'hidden') { out.push([h, '不可见']); continue; }
      a.scrollIntoView({ block: 'center' });
      await sleep(10);
      const r = a.getBoundingClientRect();
      if (r.width < 3 || r.height < 3) { out.push([h, '尺寸为 0: ' + Math.round(r.width) + 'x' + Math.round(r.height)]); continue; }
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) {
        out.push([h, '滚进视口后仍在视口外 ' + Math.round(cx) + ',' + Math.round(cy)]); continue;
      }
      const top = document.elementFromPoint(cx, cy);
      if (top !== a && !a.contains(top) && !(top && top.contains(a))) {
        out.push([h, '被 ' + (top ? top.tagName.toLowerCase() + '.' + String(top.className || '').trim().split(/\\s+/).slice(0,2).join('.') : 'null') + ' 遮挡']);
      }
    }
    return { list: list, bad: out };
  `;
  const hitFails = [], perPage = {};
  /* B 不再回传逐页清单，这里直接遍历同一份抽样页 */
  const pageList = sample;
  for (let i = 0; i < pageList.length; i++) {
    const pg = pageList[i];
    let res;
    await freshPage();
    sinceLoad++;
    try {
      res = await evaluate(NAV + `
        const ok = await navTo(${JSON.stringify(pg)});
        if (!ok) return { list: [], bad: [[${JSON.stringify(pg)}, '地址没能切过去']] };
        await new Promise(r => setTimeout(r, 10));
        ${HITPAGE}
      `, sessionId);
    } catch (e) {
      hitFails.push([pg, '*', '执行异常: ' + e.message.slice(0, 140)]);
      continue;
    }
    perPage[pg] = res.list;
    res.bad.forEach(f => hitFails.push([pg, f[0], f[1]]));
    if ((i + 1) % 40 === 0) console.log('  … ' + (i + 1) + '/' + pageList.length + ' 页，异常 ' + hitFails.length);
  }
  let tested = 0; for (const k in perPage) tested += perPage[k].length;
  console.log('命中测试 ' + pageList.length + ' 页 / ' + tested + ' 条链接，异常 ' + hitFails.length);
  hitFails.slice(0, 40).forEach(f => console.log('  ✗ ' + f[0] + ' » ' + f[1] + '  ' + f[2]));

  /* 6. 抽样真实点击：验证事件链真的通（处理函数触发、hash 到位、落地可读） */
  console.log('\n=== C2 抽样真实点击 ===');
  await freshPage();
  const REP = ['#/', '#/letters', '#/score', '#/concept', '#/corr', '#/rules', '#/decide', '#/ents', '#/talk'];
  const pickPages = REP.slice();
  function pickBy(re, n) {
    let c = 0;
    for (const p of pageList) { if (re.test(p)) { pickPages.push(p); if (++c >= n) break; } }
  }
  pickBy(/^#\/l\//, 6); pickBy(/^#\/y\//, 3); pickBy(/^#\/c\//, 4);
  pickBy(/^#\/co\//, 4); pickBy(/^#\/e\/people\//, 3); pickBy(/^#\/e\/concepts\//, 2);
  pickBy(/^#\/e\/companies\//, 2);
  const pairs = [];
  /* #/talk?q= 不进真实点击：落地就自动问一次，Agent 在线时一问就是二三十秒的流式回答，
     而且会把页面往下拉 —— 那是问答本身的行为，不是链接的事，由 talktest.js 专测。 */
  pickPages.forEach(p => {
    if (perPage[p]) perPage[p].forEach(h => { if (h.indexOf('#/talk?') !== 0) pairs.push([p, h]); });
  });
  console.log('抽样 ' + pickPages.length + ' 页，共 ' + pairs.length + ' 条');

  const clickFails = [];
  let clicked = 0, occluded = 0;
  for (let i = 0; i < pairs.length; i++) {
    const [p, href] = pairs[i];
    let geo;
    try {
      geo = await evaluate(NAV + P_REALCLICK.replace('__PAGE__', JSON.stringify(p)).replace('__HREF__', JSON.stringify(href)), sessionId);
    } catch (e) {
      clickFails.push([p, href, '准备点击时异常: ' + e.message.slice(0, 100), '']);
      continue;
    }
    if (geo.skip) continue;
    if (geo.occ) { occluded++; clickFails.push([p, href, '被遮挡: ' + geo.occ + ' « ' + geo.text, '']); continue; }
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: geo.x, y: geo.y }, sessionId);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: geo.x, y: geo.y, button: 'left', clickCount: 1 }, sessionId);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: geo.x, y: geo.y, button: 'left', clickCount: 1 }, sessionId);
    await new Promise(r => setTimeout(r, 60));
    clicked++;
    const after = await evaluate(P_AFTER, sessionId);
    const want = href.slice(1).split('?')[0];
    const got = String(after.hash).slice(1).split('?')[0];
    if (got !== want) { clickFails.push([p, href, '点后未到位: 到 ' + got, '「' + geo.text + '」']); continue; }
    if (after.bad) { clickFails.push([p, href, '落地脏值 ' + after.bad, '「' + geo.text + '」']); continue; }
    if (after.len < 60) { clickFails.push([p, href, '落地空白', '「' + geo.text + '」']); continue; }
    if ((i + 1) % 50 === 0) console.log('  … ' + (i + 1) + '/' + pairs.length + ' 点击，失败 ' + clickFails.length);
  }
  console.log('真实点击 ' + clicked + ' 次，失败 ' + clickFails.length + '（遮挡 ' + occluded + '）');

  /* 6. 侧栏：所有 a 的真实点击（含折叠展开） */
  console.log('\n=== D 侧栏真实点击 ===');
  await freshPage();
  const sbLinks = await evaluate(`
    const out = [];
    for (const a of document.querySelectorAll('#snav a[href]')) out.push(a.getAttribute('href'));
    return out;
  `, sessionId);
  const sbFails = [];
  for (const href of sbLinks) {
    const geo = await evaluate(`
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const href = ${JSON.stringify(href)};
      // 窄屏下侧栏是抽屉，收着的时候整块在视口外（transform 不为 none），
      // 不先点汉堡就去点坐标，会 242 条全判失败 —— 那是测试没开抽屉，不是链接坏了。
      const sb = document.getElementById('sidebar');
      if (sb && getComputedStyle(sb).transform !== 'none' && !sb.classList.contains('open')) {
        const hamb = document.getElementById('hamb');
        if (hamb) { hamb.click(); await sleep(380); }
      }
      // 先展开它所在分组
      let a = null;
      for (const x of document.querySelectorAll('#snav a[href]')) if (x.getAttribute('href') === href) { a = x; break; }
      if (!a) return { skip: '找不到' };
      const g = a.parentNode;
      if (g && g.classList && g.classList.contains('nav-group-items') && !g.classList.contains('open')) {
        g.classList.add('open');
        const t = document.querySelector('.nav-group-title[data-g="' + g.id.slice(2) + '"]');
        if (t) t.classList.add('open');
      }
      document.documentElement.style.scrollBehavior = 'auto';
      a.scrollIntoView({ block: 'center' });
      await sleep(30);
      const r = a.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) return { skip: '出界' };
      const top = document.elementFromPoint(cx, cy);
      let occ = null;
      if (top !== a && !a.contains(top) && !(top && top.contains(a))) occ = top ? top.tagName + '.' + (top.className || '') : 'null';
      return { x: cx, y: cy, occ: occ, text: a.innerText.slice(0, 24) };
    `, sessionId);
    if (geo.skip) { sbFails.push([href, geo.skip]); continue; }
    if (geo.occ) { sbFails.push([href, '被遮挡: ' + geo.occ]); continue; }
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: geo.x, y: geo.y }, sessionId);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: geo.x, y: geo.y, button: 'left', clickCount: 1 }, sessionId);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: geo.x, y: geo.y, button: 'left', clickCount: 1 }, sessionId);
    /* 点击后给 hashchange → render 留足时间，45ms 在机器忙的时候会读到上一页 */
    await new Promise(r => setTimeout(r, 110));
    const after = await evaluate(P_AFTER, sessionId);
    const want = href.slice(1).split('?')[0];
    const got = String(after.hash).slice(1).split('?')[0];
    if (got !== want) sbFails.push([href, '未到位: ' + got]);
    else if (after.len < 60) sbFails.push([href, '空白']);
    else if (after.bad) sbFails.push([href, '脏值 ' + after.bad]);
  }
  console.log('侧栏链接 ' + sbLinks.length + ' 个，失败 ' + sbFails.length);
  sbFails.slice(0, 40).forEach(f => console.log('  ✗ ' + f[0] + '  ' + f[1]));

  /* 汇总 */
  console.log('\n========== 汇总 ==========');
  console.log('路由 ' + routes.length + ' 个，异常 ' + badRoutes.length);
  console.log('去重链接 ' + hrefs.length + ' 条，落地失败 ' + dead.length);
  console.log('命中测试异常 ' + hitFails.length + ' 条');
  console.log('真实鼠标 ' + clicked + ' 次，失败 ' + clickFails.length);
  console.log('侧栏 ' + sbLinks.length + ' 次，失败 ' + sbFails.length);

  const report = { badRoutes, dead, hitFails, clickFails, sbFails };
  fs.writeFileSync('_linkaudit.json', JSON.stringify(report, null, 1), 'utf8');
  if (clickFails.length) {
    console.log('\n--- 真实点击失败明细（前 80）---');
    clickFails.slice(0, 80).forEach(f => console.log('  ✗ 页 ' + f[0] + '\n    链 ' + f[1] + '\n    ' + f[2] + ' ' + f[3]));
  }
  cleanup();
  process.exit((badRoutes.length || dead.length || hitFails.length || clickFails.length || sbFails.length) ? 2 : 0);
})().catch(e => { console.error('驱动层错误:', e); process.exit(1); });
