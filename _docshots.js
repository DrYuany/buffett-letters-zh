/* 给 README 生成截图素材。
   走本地 Agent 服务（http://127.0.0.1:8099），这样对话页能拍到「已连接本地 Agent」的真实状态。
   用法：node _docshots.js            —— 拍全部
        node _docshots.js talk        —— 只拍名字里含 talk 的那几张 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9377;
const BASE = 'http://127.0.0.1:8099/index.html';
const OUT = path.join(__dirname, 'docs', 'screenshots');
const FILTER = process.argv[2] || '';

/* name / 宽 / 路由 / 滚动到哪个选择器 / 是否要等 agent 答完 */
const SHOTS = [
  { n: '01-home-hero', w: 1440, r: '#/', scroll: '' },
  { n: '02-home-lunch', w: 1440, r: '#/', scroll: '.talk-banner' },
  { n: '03-home-paths', w: 1440, r: '#/', scroll: '.paths' },
  { n: '04-talk-empty', w: 1440, r: '#/talk', scroll: '' },
  { n: '05-talk-answer', w: 1440, r: '#/talk?q=' + encodeURIComponent('回购股票在他看来什么时候是对的？'),
    scroll: '', waitAnswer: true, answerEnd: true },
  /* 同一问的另一张：从头看，能拍到连接状态标签和「它翻了哪些东西」的步骤清单 */
  { n: '05b-talk-steps', w: 1440, r: '#/talk?q=' + encodeURIComponent('回购股票在他看来什么时候是对的？'),
    scroll: '.tp-steps', waitAnswer: true },
  { n: '06-letter-read', w: 1440, r: '#/l/' + encodeURIComponent('1988 巴菲特致股东信'), scroll: '' },
  { n: '07-concept', w: 1440, r: '#/c/' + encodeURIComponent('内在价值'), scroll: '' },
  { n: '08-company', w: 1440, r: '#/co/' + encodeURIComponent('可口可乐'), scroll: '' },
  { n: '09-corrections', w: 1440, r: '#/corr', scroll: '' },
  { n: '10-decide', w: 1440, r: '#/decide', scroll: '' },
  { n: '11-letters', w: 1440, r: '#/letters', scroll: '' },
  { n: '12-mobile-home', w: 390, r: '#/', scroll: '.talk-banner' },
  { n: '13-mobile-talk', w: 390, r: '#/talk?q=' + encodeURIComponent('什么是安全边际？'),
    scroll: '', waitAnswer: true, answerEnd: true },
];

let ws, msgId = 0; const pending = new Map();
function send(m, p = {}, s) {
  return new Promise((res, rej) => {
    const id = ++msgId; pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method: m, params: p, sessionId: s }));
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function connect() {
  let t = null;
  for (let i = 0; i < 80; i++) {
    try {
      const a = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      t = a.find(x => x.type === 'page'); if (t) break;
    } catch (e) {}
    await sleep(400);
  }
  if (!t) throw new Error('Chrome 调试端口没起来');
  ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
    }
  };
}
async function ev(expr, s) {
  const r = await send('Runtime.evaluate', { expression: `(async()=>{ ${expr} })()`, awaitPromise: true, returnByValue: true }, s);
  if (r.exceptionDetails) throw new Error('页面异常: ' + String(r.exceptionDetails.exception && r.exceptionDetails.exception.description).slice(0, 200));
  return r.result.value;
}

(async () => {
  const list = SHOTS.filter(s => !FILTER || s.n.indexOf(FILTER) >= 0);
  fs.mkdirSync(OUT, { recursive: true });
  const ch = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + path.join(os.tmpdir(), 'wbdoc' + Date.now()),
    '--window-size=1440,1000', BASE], { stdio: 'ignore' });
  process.on('exit', () => { try { ch.kill(); } catch (e) {} });
  await connect();
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  await send('Page.enable', {}, sessionId);

  for (const s of list) {
    await send('Emulation.setDeviceMetricsOverride',
      { width: s.w, height: 1000, deviceScaleFactor: 1, mobile: false }, sessionId);
    await send('Page.navigate', { url: BASE + s.r }, sessionId);
    await sleep(s.waitAnswer ? 11000 : 9000);
    await ev(`document.documentElement.style.scrollBehavior='auto'; return 1;`, sessionId);

    if (s.waitAnswer) {
      /* agent 是流式的，等它把话说完（busy 落回 false），最多 3 分钟 */
      for (let i = 0; i < 180; i++) {
        const busy = await ev(`return !!(typeof TALK !== 'undefined' && TALK.busy);`, sessionId);
        if (!busy) break;
        await sleep(1000);
      }
      await sleep(1200);
      if (s.answerEnd) {
        await ev(`
          const bs = document.querySelectorAll('.msg.b .bubble');
          const last = bs[bs.length - 1];
          if (last) last.scrollIntoView({ block: 'end' });
          return 1;`, sessionId);
        await sleep(600);
      }
    }
    if (s.scroll) {
      await ev(`const e = document.querySelector(${JSON.stringify(s.scroll)});
        if (e) e.scrollIntoView({ block: 'center' }); return 1;`, sessionId);
      await sleep(600);
    }
    const { data } = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
    const file = path.join(OUT, s.n + '.png');
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    console.log('✓', file, (fs.statSync(file).size / 1024).toFixed(0) + 'KB');
  }
  try { ch.kill(); } catch (e) {}
  process.exit(0);
})().catch(e => { console.error(e.message || e); process.exit(1); });
