/* 巴菲特午餐会专项：真·端到端
   两条路径都测：
     · 本地 Agent 服务在线 → 走 SSE 流式问答（工具、步骤、引用胶囊、记忆）
     · 服务不在 → 必须降级成关键词检索，并且在界面上明说是离线模式（不许假装是 AI）
   用法：node talktest.js [--file] [BASE]
   需要 agent.js 在跑（node agent.js），否则全部走离线路线。
*/
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9361;
const AGENT = 'http://127.0.0.1:8099';
const FILE_URL = pathToFileURL(path.join(__dirname, 'site', 'index.html')).href;
const BASE = process.argv.includes('--file') ? FILE_URL : (process.argv[2] || AGENT + '/index.html');
const MEM_FILE = path.join(__dirname, 'agent-memory.json');

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
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function ev(expr, s) {
  const r = await send('Runtime.evaluate', { expression: `(async()=>{ ${expr} })()`, awaitPromise: true, returnByValue: true }, s);
  if (r.exceptionDetails) throw new Error('页面异常: ' + String(r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text).slice(0, 240));
  return r.result.value;
}
async function geo(sel, idx, s) {
  return ev(`
    const els = Array.from(document.querySelectorAll(${JSON.stringify(sel)})).filter(e => {
      const cs = getComputedStyle(e); if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      const r = e.getBoundingClientRect(); return r.width > 2 && r.height > 2;
    });
    if (${idx} >= els.length) return { skip: 'only ' + els.length };
    const el = els[${idx}]; el.scrollIntoView({ block: 'center' });
    await new Promise(r => setTimeout(r, 30));
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: (el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 40) };
  `, s);
}
async function clickAt(p, s) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y }, s);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 }, s);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 }, s);
}

(async function () {
  /* 0. 先验 Agent 服务在不在，决定这一轮测哪条路 */
  let online = false, health = null;
  try {
    const r = await fetch(AGENT + '/api/health', { cache: 'no-store' });
    health = await r.json();
    online = !!(health && health.ok && health.key);
  } catch (e) {}
  console.log('本地 Agent：' + (online ? '在线（' + health.docs + ' 段语料 / ' + health.letters + ' 封信）' : '未运行 —— 本轮只测离线降级'));
  console.log('页面来源：' + BASE + '\n');

  const ch = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + path.join(os.tmpdir(), 'wbtalk' + Date.now()),
    '--window-size=1440,900', BASE], { stdio: 'ignore' });
  process.on('exit', () => { try { ch.kill(); } catch (e) {} });
  await connect();
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  await send('Page.enable', {}, sessionId);
  await send('Page.navigate', { url: BASE }, sessionId);
  await sleep(9000);
  await ev(`document.documentElement.style.scrollBehavior='auto'; return 1;`, sessionId);

  let fail = 0;
  const rec = (ok, name, detail) => { if (!ok) fail++; console.log((ok ? '✓ ' : '✗ ') + name.padEnd(24) + (detail || '')); };
  const skip = (name, why) => console.log('— ' + name.padEnd(24) + why);

  /* agent 是流式回答，等它把话说完。
     判"说完了"要看页面自己的 TALK.busy，不能看文字长度稳不稳 ——
     它在中间几轮去调工具的时候，字数也会短暂不变，那时候答还没开始写。 */
  async function waitAnswer(maxMs) {
    maxMs = maxMs || 90000;
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      await sleep(700);
      const st = await ev(`
        const bs = document.querySelectorAll('.msg.b .bubble');
        const b = bs[bs.length - 1];
        return { busy: TALK.busy, len: b ? b.innerText.length : 0, caret: !!document.querySelector('.tp-caret'),
                 cites: b ? b.querySelectorAll('.ct-cite').length : 0 };
      `, sessionId);
      if (st.busy === false && st.len > 60) return st;
    }
    return await ev(`
      const bs = document.querySelectorAll('.msg.b .bubble');
      const b = bs[bs.length - 1];
      return { len: b ? b.innerText.length : 0, caret: !!document.querySelector('.tp-caret'),
               cites: b ? b.querySelectorAll('.ct-cite').length : 0, timeout: true };
    `, sessionId);
  }

  /* 1. 首页深色入口的示例问题：点了应带着 ?q= 落到对话页并自动发问 */
  await ev(`location.hash='#/'; render(); return 1;`, sessionId);
  await sleep(250);
  const pill = await geo('.tb-q', 0, sessionId);
  await clickAt(pill, sessionId);
  await sleep(1200);
  const st0 = await ev(`
    const u = document.querySelector('.msg.u .bubble');
    return { hash: location.hash.slice(0, 46), asked: u ? u.innerText.trim() : null };
  `, sessionId);
  const ans0 = await waitAnswer();
  rec(st0.hash.indexOf('#/talk?q=') === 0 && !!st0.asked && ans0.len > 60,
    '首页示例问句', JSON.stringify(st0) + ' →答案 ' + ans0.len + ' 字');

  /* 2. 在线时界面必须写明连的是什么，不许含糊 */
  await ev(`location.hash='#/talk'; render(); return 1;`, sessionId);
  await sleep(600);
  const st1 = await ev(`
    const s = document.querySelector('.tp-state');
    return { text: s ? s.innerText.trim() : null, cls: s ? s.className : null };
  `, sessionId);
  const wantState = online ? '已连接本地 Agent' : '离线模式（关键词检索）';
  rec(st1.text === wantState, '连接状态如实标注', JSON.stringify(st1.text) + '（期望：' + wantState + '）');

  /* 3. 提问完整链路：输入 → 出答案 */
  const tin = await geo('#talk-in', 0, sessionId);
  await clickAt(tin, sessionId);
  await sleep(150);
  await send('Input.insertText', { text: online ? '他怎么判断一门生意好不好？' : '什么是安全边际？' }, sessionId);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, sessionId);
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, sessionId);
  const ans2 = await waitAnswer();
  /* 答完之后再看：步骤清单和出处清单都在最后那条气泡里 */
  const st2 = await ev(`
    const bs = document.querySelectorAll('.msg.b .bubble');
    const b = bs[bs.length - 1];
    return { n: bs.length, srcs: b ? b.querySelectorAll('.tp-srcs a').length : 0,
             steps: b ? b.querySelectorAll('.tp-steps div').length : 0,
             step1: b && b.querySelector('.tp-steps div') ? b.querySelector('.tp-steps div').innerText.trim().slice(0, 28) : null };
  `, sessionId);
  rec(ans2.len > 80, '键盘提问出答案', JSON.stringify(ans2) + ' 出处清单 ' + st2.srcs + ' 条');

  if (online) {
    /* 4. 过程要看得见：它到底翻了哪些东西，一条条列出来 */
    rec(st2.steps >= 1, '工具步骤可见', '步骤 ' + st2.steps + ' 条，第一条「' + st2.step1 + '」');

    /* 4b. 出处清单：答案末尾要列出这一答引用了哪些段落 */
    rec(st2.srcs >= 1, '末尾有出处清单', st2.srcs + ' 条');

    /* 5. 引用：答案里必须出现能点回原文的胶囊，而不是光写"1964 年说过" */
    rec(ans2.cites >= 1, '引用渲染成胶囊', '胶囊 ' + ans2.cites + ' 个');

    /* 6. 点胶囊 → 落到那一信的那一页那一段 */
    const chip = await geo('.msg.b .ct-cite[href*="#/l/"]', 0, sessionId);
    if (chip.skip) {
      rec(false, '胶囊跳原文', chip.skip);
    } else {
      await clickAt(chip, sessionId);
      await sleep(900);
      const st3 = await ev(`
        const m = location.hash.match(/^#\\/l\\/(.+?)\\?b=(\\d+)$/);
        return { hash: decodeURIComponent(location.hash), ok: !!m, target: m ? !!document.getElementById('b' + m[2]) : false };
      `, sessionId);
      rec(st3.ok && st3.target, '胶囊跳原文', JSON.stringify(st3));
      await ev(`location.hash='#/talk'; render(); return 1;`, sessionId);
      await sleep(400);
    }

    /* 7. 多轮追问：上下文要接得住（问一句不带主语的追问） */
    const tin2 = await geo('#talk-in', 0, sessionId);
    await clickAt(tin2, sessionId);
    await sleep(150);
    await send('Input.insertText', { text: '那你最看重其中哪一条？' }, sessionId);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, sessionId);
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, sessionId);
    await sleep(900);
    const ans3 = await waitAnswer();
    const st4 = await ev(`
      const us = document.querySelectorAll('.msg.u .bubble');
      return { turns: us.length, lastQ: us.length ? us[us.length-1].innerText.trim() : null };
    `, sessionId);
    rec(st4.turns >= 3 && ans3.len > 80, '多轮追问接得住', '第 ' + st4.turns + ' 轮，答案 ' + ans3.len + ' 字');

    /* 8. 记忆：让它记住一句话，检查真的写进了本机的记忆文件 */
    const readMem = () => { try { return fs.readFileSync(MEM_FILE, 'utf8'); } catch (e) { return '{"notes":[]}'; } };
    const memBefore = readMem();
    const tin3 = await geo('#talk-in', 0, sessionId);
    await clickAt(tin3, sessionId);
    await sleep(150);
    await send('Input.insertText', { text: '请记住：我在测试长期记忆功能，请用中文回答。' }, sessionId);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, sessionId);
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, sessionId);
    const ans4 = await waitAnswer(60000);
    const memAfter = readMem();
    const notes = JSON.parse(memAfter).notes || [];
    rec(notes.length > 0 && memAfter !== memBefore, '长期记忆写入本机', notes.length + ' 条：' + (notes[notes.length-1] || {}).text);

    /* 9. 遗忘按钮：点了记忆文件要清空 */
    const fg = await geo('#talk-forget', 0, sessionId);
    if (fg.skip) rec(false, '遗忘按钮', fg.skip);
    else {
      await clickAt(fg, sessionId);
      await sleep(1200);
      const notesNow = (JSON.parse(readMem()).notes || []).length;
      rec(notesNow === 0, '遗忘按钮清空记忆', '清空后 ' + notesNow + ' 条');
    }
  } else {
    skip('工具步骤可见', '需本地 Agent 在线');
    skip('引用渲染成胶囊', '需本地 Agent 在线');
    skip('胶囊跳原文', '需本地 Agent 在线');
    skip('多轮追问接得住', '需本地 Agent 在线');
    skip('长期记忆写入本机', '需本地 Agent 在线');
    skip('遗忘按钮清空记忆', '需本地 Agent 在线');
    /* 离线也不许出绝症：至少还能给出近乎的意思并附出处 */
    const stOff = await ev(`
      const b = document.querySelectorAll('.msg.b .bubble');
      const last = b[b.length-1];
      return { tq: last ? last.querySelectorAll('.tq').length : 0, links: last ? last.querySelectorAll('a').length : 0 };
    `, sessionId);
    rec(stOff.tq >= 1 && stOff.links >= 1, '离线仍有出处可点', JSON.stringify(stOff));
  }

  /* 10. 新对话 → 清空回空态 */
  await ev(`location.hash='#/talk'; render(); return 1;`, sessionId);
  await sleep(400);
  const nw = await geo('#talk-new', 0, sessionId);
  await clickAt(nw, sessionId);
  await sleep(500);
  const st5 = await ev(`return { msgs: document.querySelectorAll('.msg').length, hero: !!document.querySelector('.tp-hero') };`, sessionId);
  rec(st5.msgs === 0 && st5.hero, '新对话清空', JSON.stringify(st5));

  console.log('\n失败 ' + fail + ' 项');
  try { ch.kill(); } catch (e) {}
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
