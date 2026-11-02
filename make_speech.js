/* 把公众演讲语料拼成 site/data-speech.js
   输入: _src/speech/speech.jsonl  (build_speech.py 产出)
   输出: site/data-speech.js       (window.SPEECH)
   零依赖，Node 18+。

   和股东大会语料（data-talk.js）的区别：
     - talk  = 股东大会现场问答，英文字幕中译 → 只能转述
     - speech= 大学演讲 / 电视与媒体专访，中文译本或现场记录
   两条都带 fid 字段：verbatim 可逐字引用，notes 只能转述。
   场合（venue）必须留在每条里 —— 用户得知道这句话是 1998 年在佛罗里达
   对着 MBA 学生说的，还是 2023 年股东大会上说的，这两者的分量不一样。
*/
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const SRC = path.join(ROOT, '_src', 'speech', 'speech.jsonl');
const STATS = path.join(ROOT, '_src', 'speech', 'stats.json');

if (!fs.existsSync(SRC)) {
  console.error('缺 ' + SRC + ' —— 先跑 python build_speech.py');
  process.exit(1);
}
const rows = fs.readFileSync(SRC, 'utf8').split('\n')
  .filter(Boolean).map(l => JSON.parse(l));
const stats = fs.existsSync(STATS) ? JSON.parse(fs.readFileSync(STATS, 'utf8')) : {};

/* 问答配对：巴菲特那段往前找最近的一段别人说的话当提问。
   跨场合不配（/2023 股东大会/ 的下一段提问不能拿去配 2017 北大）。 */
const segs = [];
for (let i = 0; i < rows.length; i++) {
  const r = rows[i];
  if (r.who !== 'buffett') continue;
  let ask = '';
  for (let j = i - 1; j >= 0 && i - j <= 3; j--) {
    const p = rows[j];
    if (p.file !== r.file) break;
    if (p.who === 'buffett') continue;
    ask = p.text;
    break;
  }
  const t = String(r.text || '').replace(/\s+/g, ' ').trim();
  if (t.length < 24) continue;      /* 太短的碎片检索不到也引用不了 */
  segs.push({
    y: r.y,
    venue: r.venue,
    fid: r.fid,                      /* verbatim=逐字稿 / notes=笔记转述 */
    ask: ask.replace(/\s+/g, ' ').trim().slice(0, 300),
    ans: t,
    src: r.file,
    i: r.i,
  });
}
segs.sort((a, b) => a.y - b.y || (a.venue < b.venue ? -1 : 1) || a.i - b.i);

const meta = {
  src: stats.source || 'gengjiawen/buffett-chinese（公众演讲/访谈/大学问答，中文）',
  note: '大学演讲与媒体专访；fid=notes 的是凭笔记整理的转述，不可逐字引用',
  built: new Date().toISOString().slice(0, 10),
  years: stats.years || [...new Set(segs.map(s => s.y))].sort(),
  venues: stats.venues || [...new Set(segs.map(s => s.venue))].sort(),
  files: stats.files || 0,
  segs: segs.length,
  chars: segs.reduce((s, x) => s + x.ans.length, 0),
  by_fidelity: {
    verbatim: segs.filter(s => s.fid === 'verbatim').length,
    notes: segs.filter(s => s.fid === 'notes').length,
  },
  with_ask: segs.filter(s => s.ask).length,
};

const js = '/* 自动生成，勿手改。生成器：make_speech.js（源：build_speech.py） */\n' +
  'window.SPEECH = ' + JSON.stringify({ meta, segs }) + ';\n';
fs.writeFileSync(path.join(ROOT, 'site', 'data-speech.js'), js);

console.log(`site/data-speech.js  段 ${segs.length}  字 ${meta.chars}`);
console.log(`  逐字 ${meta.by_fidelity.verbatim} / 笔记 ${meta.by_fidelity.notes}；带提问 ${meta.with_ask}`);
console.log(`  年份 ${meta.years[0]}-${meta.years[meta.years.length - 1]}；场合 ${meta.venues.length} 个`);
console.log(`  体积 ${(js.length / 1024).toFixed(0)} KB`);
