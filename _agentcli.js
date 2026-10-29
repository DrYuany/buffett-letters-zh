/* Agent 命令行试跑：node _agentcli.js "问题" [--noweb] [--flash] [--raw]
   不走前端，直接看 SSE 事件流，方便判断 agent 循环、工具、引用对不对。 */
const http = require('http');

/* argv[0] 是 node，argv[1] 是脚本自己，真正的问题在 argv[2] */
const q = process.argv.filter(a => !a.startsWith('--'))[2] || '巴菲特怎么看通货膨胀？';
const noweb = process.argv.includes('--noweb');
const flash = process.argv.includes('--flash');
const raw = process.argv.includes('--raw');

const body = JSON.stringify({
  message: q,
  session: 'cli-' + Date.now(),
  web: !noweb,
  model: flash ? 'flash' : 'pro'
});

const t0 = Date.now();
const el = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';

const req = http.request({
  host: '127.0.0.1', port: 8099, path: '/api/chat', method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
}, res => {
  if (res.statusCode !== 200) { console.log('HTTP ' + res.statusCode); res.resume(); return; }
  let buf = '', answer = '', steps = [], cites = [];
  res.on('data', c => {
    buf += c.toString();
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (line.startsWith('event: ')) { var ev = line.slice(7).trim(); continue; }
      if (!line.startsWith('data: ')) continue;
      const d = line.slice(6);
      let j; try { j = JSON.parse(d); } catch (e) { continue; }
      if (raw) console.log('[' + el() + '] ' + ev + ' ' + JSON.stringify(j).slice(0, 300));
      if (ev === 'step') { steps.push(j.text); if (!raw) console.log('  · ' + el() + '  ' + j.text); }
      if (ev === 'delta') answer += j.text;
      if (ev === 'cite') cites = cites.concat(j.sources || []);
      if (ev === 'sources') cites = j.sources || [];   // 答案收尾后按引用标记重算过的清单
      if (ev === 'error') console.log('✗ 错误：' + j.message);
      if (ev === 'done') {
        console.log('\n=== 回答（' + answer.length + ' 字，' + j.rounds + ' 轮，' + j.calls + ' 次工具，' + el() + '）===\n');
        console.log(answer);
        console.log('\n=== 来源 ' + cites.length + ' 条 ===');
        cites.forEach(c => console.log('  - ' + (c.kind === 'letter' ? c.y + ' 年 ' + c.l + ' 第 ' + c.b + ' 段' : '网页 ' + c.url)));
        if (j.usage) console.log('\ntokens: ' + JSON.stringify(j.usage));
      }
    }
  });
  res.on('end', () => console.log('\n[流结束 ' + el() + ']'));
});
req.on('error', e => { console.error('连不上本机服务：' + e.message + '（先跑 node agent.js）'); process.exit(1); });
req.end(body);
