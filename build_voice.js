/* 语体指纹：量出可以写进提示词的数字
   用法: node build_voice.js    →  _src/voice.json

   两个数据源分工，不能混：
     比率（多少比例的回答会说"不知道"/打比方/带数字）→ _src/talk/meetings.jsonl
        全量 9,598 段，无偏。不能用译好的 380 条算 —— 那 380 条是按"说不知道"加权抽的，
        拿它算比率会把 6% 算成 76%，写进提示词就成了让模型不停说不知道。
     句长与开头（中文里一句话多长）→ site/data-talk.js
        长度受抽样影响小，可以用。
*/
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = __dirname;
const rows = fs.readFileSync(path.join(ROOT, '_src', 'talk', 'meetings.jsonl'), 'utf8')
  .trim().split('\n').map(l => JSON.parse(l)).filter(r => r.who === 'buffett');

const ctx = { window: {}, console };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'site', 'data-talk.js'), 'utf8'), ctx);
const SEGS = (ctx.window.TALK || {}).segs || [];

const CN = /[\u4e00-\u9fa5]/g;
const cn = s => (s.match(CN) || []).length;
const sentences = t => t.split(/(?<=[。！？!?])/).map(s => s.trim()).filter(Boolean);
const median = a => (a.length ? a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0);
const pct = (a, b) => (b ? +(a / b * 100).toFixed(1) : 0);

/* ---- 无偏比率：全量英文语料 ---- */
const AP = "['\u2019]?";
const RULES = {
  '直接说不知道': new RegExp("\\b(I don" + AP + "t know|we don" + AP + "t know|no idea|haven" + AP + "t the faintest|can" + AP + "t answer)\\b", 'i'),
  '打比方': new RegExp("\\b(it" + AP + "s like|just like|think of it as|analogy|imagine)\\b", 'i'),
  '把读者拉进来': /\b(you see|you know|think about|ask yourself)\b/i,
  '承认自己会错': /\b(I was wrong|I was dumb|my mistake|I made a mistake|I['\u2019]ve been wrong)\b/i,
  '带具体数字': /\d/,
  '留余地': /\b(generally|usually|probably|roughly|sort of|kind of)\b/i,
  '先给结论再解释': /^(so|well|yeah|the answer is|the key)\b/i,
};
const counts = {};
Object.keys(RULES).forEach(k => { counts[k] = rows.filter(r => RULES[k].test(r.t)).length; });

/* ---- 中文句长：译好的语料 ---- */
const sent = [];
SEGS.forEach(s => sentences(s.ans).forEach(x => sent.push(cn(x))));
const sentLens = sent.filter(n => n > 0).sort((a, b) => a - b);
const segLens = SEGS.map(s => cn(s.ans)).sort((a, b) => a - b);
const perSeg = SEGS.map(s => sentences(s.ans).length);

const head = {};
SEGS.forEach(s => { const h = s.ans.slice(0, 2); if (h.length === 2) head[h] = (head[h] || 0) + 1; });
const topHead = Object.entries(head).sort((a, b) => b[1] - a[1]).slice(0, 6);

const p25 = sentLens[Math.floor(sentLens.length * 0.25)];
const p75 = sentLens[Math.floor(sentLens.length * 0.75)];
const rate = Object.keys(counts).reduce((o, k) => (o[k] = pct(counts[k], rows.length), o), {});

const voice = {
  built: new Date().toISOString().slice(0, 10),
  rate_src: '_src/talk/meetings.jsonl（9,598 段，全量无偏）',
  len_src: 'site/data-talk.js（380 条中译）',
  n_utt: rows.length,
  n_seg: SEGS.length,
  rate,
  sent_cn_median: median(sentLens),
  sent_cn_p25: p25,
  sent_cn_p75: p75,
  seg_cn_median: median(segLens),
  sent_per_seg_median: median(perSeg),
  top_head: topHead,
  /* 写进提示词的话全部由上面的数字生成，不手写形容词。
     第 1、2 条改过一次：原来写「到 45 字就断开」，模型执行成了「每句都短」，
     实测句长中位掉到 19 字、一段十句 —— 比他本人碎。真正要传的是分布，不是上限。 */
  rules: [
    `一句话说一件事：中位 ${median(sentLens)} 字，多数落在 ${p25}–${p75} 字。`,
    `不要为了短而拆句：一个完整意思放在一句里说完，${p75} 字以内不必断开；只有真的换了一层意思才断。`,
    `一段回答通常 ${median(perSeg)} 句、${median(segLens)} 字左右（${p25 * median(perSeg)}–${p75 * median(perSeg)} 字都正常）。不要写成五段式文章。`,
    `${rate['直接说不知道']}% 的发言里出现"不知道 / 看不出来 / 没法判断"。不知道就直接说，不要绕。`,
    `${rate['打比方']}% 的发言打比方，比喻取自棒球、桥牌、农场、汉堡这类日常事物，不取自金融术语。`,
    `${rate['带具体数字']}% 的发言里有具体数字。讲道理时尽量换成年份、金额或比率。`,
    `${rate['把读者拉进来']}% 的发言里出现"你看 / 你想想"——把读者拉进推理，而不是对他宣讲。`,
    `${rate['承认自己会错']}% 的发言主动提自己犯过的错，平铺直叙，不自责也不浪漫化。`,
    `常用开头：${topHead.map(x => '「' + x[0] + '」').join('')}。`,
  ],
};

fs.writeFileSync(path.join(ROOT, '_src', 'voice.json'), JSON.stringify(voice, null, 1), 'utf8');

console.log('语体指纹 → _src/voice.json');
console.log('  比率口径：' + rows.length + ' 段全量');
Object.entries(rate).forEach(([k, v]) => console.log('   ', k, v + '%'));
console.log('  句长中位', voice.sent_cn_median, '字（' + p25 + '–' + p75 + '）| 段长中位', voice.seg_cn_median, '字');
console.log('  高频开头', topHead.map(x => x[0]).join(' '));
