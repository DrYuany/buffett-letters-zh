/* 把股东大会问答精选成中文语料 -> site/data-talk.js
   用法: node translate_talk.js [--limit 360]
   断点续跑: 已译的缓存在 _src/talk/zh-cache.json,重跑只补缺的。

   为什么不整库翻译: 9,598 段 / 105 万词,全译既贵又没必要 ——
   我们要的不是"所有他说过的话",而是"他说话的几种典型动作"(答不了 / 打比方 / 承认错 / 拉回原则)。
   所以按 quotability + 长度 + 是否带提问 + 年份分层抽样。
*/
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const KEY = fs.readFileSync(path.join(ROOT, '_agent.key'), 'utf8').trim();
const API = 'https://api.deepseek.com/chat/completions';
const CACHE = path.join(ROOT, '_src', 'talk', 'zh-cache.json');

const argLimit = (() => {
  const i = process.argv.indexOf('--limit');
  return i > 0 ? Number(process.argv[i + 1]) : 360;
})();

const rows = fs.readFileSync(path.join(ROOT, '_src', 'talk', 'meetings.jsonl'), 'utf8')
  .trim().split('\n').map(l => JSON.parse(l))
  .filter(r => r.who === 'buffett');

const wc = t => (t.match(/[A-Za-z0-9$%.,'-]+/g) || []).length;

/* 四类动作,各给权重。目的是让语料覆盖"人格的不同侧面",而不是只收金句。 */
const HEDGE = /\b(I don['\u2019]?t know|we don['\u2019]?t know|no idea|haven['\u2019]?t the faintest)\b/i;
const ANALOGY = /\b(it['\u2019]s like|think of it as|imagine|analogy|just like)\b/i;
const ADMIT = /\b(I was (wrong|dumb|stupid)|my (mistake|error)|I['\u2019]ve been wrong)\b/i;
const PRINCIPLE = /\b(the key (thing|point)|the basic (idea|principle)|what matters is|the important thing)\b/i;

function score(r) {
  const n = wc(r.t);
  if (n < 35 || n > 320) return null;                 // 太短没信息,太长译不动
  let s = (r.q || 0) * 0.6;
  if (r.qn >= 0) s += 1.5;                            // 有提问才有对话感
  if (HEDGE.test(r.t)) s += 2.4;                      // 说"不知道"——边界人格
  if (ANALOGY.test(r.t)) s += 1.8;                    // 打比方——最像他的表达
  if (ADMIT.test(r.t)) s += 2.6;                      // 认错——最稀缺
  if (PRINCIPLE.test(r.t)) s += 1.2;
  if (n >= 60 && n <= 180) s += 0.8;                  // 一段话的体量
  return { s, n };
}

/* 年份分层:每年最多 16 条,保证口吻的历时变化也在样本里 */
const byYear = {};
for (const r of rows) {
  const x = score(r);
  if (!x) continue;
  (byYear[r.y] = byYear[r.y] || []).push({ ...r, _s: x.s, _n: x.n });
}
let picked = [];
for (const y of Object.keys(byYear).sort()) {
  const list = byYear[y].sort((a, b) => b._s - a._s);
  const seen = new Set();
  for (const r of list) {
    const fp = r.t.slice(0, 50);
    if (seen.has(fp)) continue;
    seen.add(fp);
    picked.push(r);
    if (picked.filter(p => p.y === +y).length >= 16) break;
  }
}
picked.sort((a, b) => b._s - a._s);
picked = picked.slice(0, argLimit);
picked.sort((a, b) => a.y - b.y || a.at - b.at);

const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, 'utf8')) : {};
const key = r => `${r.y}|${r.line}`;

function prompt(batch) {
  const items = batch.map(r => ({
    id: key(r),
    ask: r.ask ? r.ask.slice(0, 220) : '',
    ans: r.t,
  }));
  return `下面是一位 90 多岁美国投资人在股东大会上的问答片段(英文转写)。请把它们译成中文。

要求:
1. 译的是"他当场怎么说",不是"他写了什么"。保留口语:短句、停顿感、口语连接词("你看""我是说""说白了"这类可以自然出现,但不要过量)。
2. 不要翻译成书面报告腔。不要用"综上所述""值得关注的是"这种词。
3. 比喻要保留原样,不要改成中国成语。
4. 数字、年份、公司名、人名照原样(公司名保留英文)。
5. 如果原文有省略号或句子不完整,译文也保持不完整,不要替它补全。
6. 每条译文控制在原文信息量内,不增不减。

输出严格 JSON 数组,不要 markdown 代码块,不要解释:
[{"id":"年份|行号","ask_cn":"提问的中文(没有提问就给空字符串)","ans_cn":"回答的中文"}]

注意:下面 items 里的字段名是 ask / ans,那是待译内容;你输出的字段名必须是 ask_cn / ans_cn,不要照抄输入字段名。

待译:
${JSON.stringify(items)}`;
}

async function callLLM(batch, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(API, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'deepseek-chat',
          messages: [{ role: 'user', content: prompt(batch) }],
          temperature: 0.2,
          max_tokens: 4000,
        }),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text()).slice(0, 120));
      const j = await r.json();
      let txt = j.choices[0].message.content.trim();
      txt = txt.replace(/^```(json)?/, '').replace(/```$/, '').trim();
      const arr = JSON.parse(txt);
      if (!Array.isArray(arr)) throw new Error('not array');
      return arr;
    } catch (e) {
      if (i === tries - 1) throw e;
      await new Promise(res => setTimeout(res, 1200 * (i + 1)));
    }
  }
}

(async () => {
  const todo = picked.filter(r => !cache[key(r)]);
  console.log(`选中 ${picked.length} 条,已译 ${picked.length - todo.length},待译 ${todo.length}`);
  const B = 4;
  const byId = {};
  picked.forEach(r => { byId[key(r)] = r; });
  const isZh = s => /[\u4e00-\u9fa5]/.test(s) && (s.match(/[\u4e00-\u9fa5]/g) || []).length >= 8;
  let done = 0;
  for (let i = 0; i < todo.length; i += B) {
    const batch = todo.slice(i, i + B);
    const arr = await callLLM(batch);
    let got = 0;
    for (const it of arr) {
      if (!it) continue;
      const id = it.id || it.k;
      const ans = it.ans_cn || it.ans || it.text || it.cn;
      const ask = it.ask_cn || it.ask || '';
      if (!id || !ans) continue;
      if (id === key(byId[id] || {})) { /* id 合法 */ } else if (!byId[id]) continue;
      /* 关键校验:真译成中文了吗?防止模型把英文原文抄回来 */
      if (!isZh(String(ans))) continue;
      if (byId[id] && String(ans).trim() === byId[id].t.trim()) continue;
      cache[id] = { ask_cn: isZh(String(ask)) ? String(ask) : '', ans_cn: String(ans) };
      got++;
    }
    done += got;
    fs.writeFileSync(CACHE, JSON.stringify(cache));
    if (i % (B * 10) === 0 || i + B >= todo.length) {
      console.log(`  处理 ${Math.min(i + B, todo.length)}/${todo.length},本轮入库 ${got},累计 ${Object.keys(cache).length}`);
    }
  }
  console.log('缓存写入', Object.keys(cache).length, '条');
})();
