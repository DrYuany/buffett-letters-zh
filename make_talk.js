/* 把翻译缓存拼成 site/data-talk.js
   用法: node make_talk.js
   输入: _src/talk/meetings.jsonl + _src/talk/zh-cache.json
   输出: site/data-talk.js  window.TALK = {meta, segs}

   每条 seg 带 y / at(秒) / 行号,可以在页面上标"1998 年股东大会 1:23:45"。
   不带 letter 坐标 —— 它不是信,不能冒充原话。
*/
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const rows = fs.readFileSync(path.join(ROOT, '_src', 'talk', 'meetings.jsonl'), 'utf8')
  .trim().split('\n').map(l => JSON.parse(l));
const cache = JSON.parse(fs.readFileSync(path.join(ROOT, '_src', 'talk', 'zh-cache.json'), 'utf8'));
const stats = JSON.parse(fs.readFileSync(path.join(ROOT, '_src', 'talk', 'stats.json'), 'utf8'));

const segs = [];
for (const r of rows) {
  const c = cache[r.y + '|' + r.line];
  if (!c || !c.ans_cn) continue;
  segs.push({
    y: r.y,
    at: r.at || 0,
    ask: (c.ask_cn || '').trim(),
    ans: (c.ans_cn || '').trim(),
    kind: r.kind,
  });
}
segs.sort((a, b) => a.y - b.y || a.at - b.at);

/* 条数、年份跨度这些一律运行时算，只有统计类数字在生成时定格并注明来源 */
const meta = {
  src: 'whwhwhwhwh56/buffett-library（股东大会问答，1994-2025）',
  note: '英文字幕的中译，只能转述，不可逐字引用',
  built: new Date().toISOString().slice(0, 10),
  years: stats.years,
  utterances: stats.buffett_utterances,
  words: stats.words,
  sentWordsMedian: stats.sent_words_median,
  segments: segs.length,
};

const js = '/* 自动生成，勿手改。生成器：make_talk.js（源：build_talk.py + translate_talk.js） */\n' +
  'window.TALK = ' + JSON.stringify({ meta, segs }) + ';\n';
fs.writeFileSync(path.join(ROOT, 'site', 'data-talk.js'), js, 'utf8');

console.log('data-talk.js 写入', segs.length, '条 /',
  (fs.statSync(path.join(ROOT, 'site', 'data-talk.js')).size / 1024).toFixed(0) + 'KB');
console.log('覆盖年份', segs[0] && segs[0].y, '-', segs[segs.length - 1] && segs[segs.length - 1].y);
console.log('平均每条字数', Math.round(segs.reduce((a, s) => a + s.ans.length, 0) / segs.length));
