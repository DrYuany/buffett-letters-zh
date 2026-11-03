/* 从股东大会逐字记录里抽决策案例，补进档案案例库。
   跑法：node extract_meeting_cases.js           全量
         node extract_meeting_cases.js --limit 1 只跑第一批（试效果）
         node extract_meeting_cases.js --dry     只算候选段数和批次数，不调 LLM
   产出：_src/meeting/cases.json，供 extract_cases.js 并入 site/data-cases.js

   为什么只喂候选段而不是全文：18,736 段巴菲特发言全过一遍 LLM 既贵又容易凑数。
   先用信号词捞出「认错 / 不投 / 卖出 / 带具体年份金额」的那批，
   剩下的让模型精读。抽不出来就别硬抽 —— 宁缺。

   与 speech 版的差异：
     - 素材是 require('./meeting').SEGS 里 who==='buffett' 的段（约 1.87 万段）
     - 会议是逐字可引的中文译文（没有 fid=notes 的转述问题），judgment_verbatim
       只取决于抽出的 judgment 前 12 字是否真的出现在该段 ans 里
     - 去重键用 session（上午场/下午场）而非 speech 的 venue
     - 回挂坐标是 src: { kind:'meeting', y, session, ch, who }，而非 venue/fid

   铁律（和 agent 的行为底线一致）：
     - judgment 必须是段落里真有的话，不许概括、不许添油
     - 场合坐标必须留着：引用时要说清是哪一年哪一场股东大会讲的
*/
const fs = require('fs');
const path = require('path');
const M = require('./meeting');

const KEY = fs.readFileSync(path.join(__dirname, '_agent.key'), 'utf8').trim();
const API = 'https://api.deepseek.com/chat/completions';
const MODEL = 'deepseek-v4-pro';

const DEBUG = process.argv.includes('--debug');
const DRY = process.argv.includes('--dry');

const USAGE = { prompt: 0, completion: 0, calls: 0 };

/* 只抽巴菲特本人段，芒格段本轮不抽（留口子，但别混进来） */
const SEGS = M.SEGS.filter(s => s.who === 'buffett');
const SIG = {
  correction: /(我错|错了|失误|愚蠢|傻|后悔|教训|犯过|不应该|看走眼|搞砸|最差|糟糕的决定|无知|我搞错|我不该)/,
  reject: /(没买|不投|没投|错过|看不懂|放弃|不参与|拒绝|没下手|擦肩|能力圈之外|太难)/,
  sell: /(卖出|清仓|减持|割了|抛了|退出)/,
  money: /(\d+(\.\d+)?\s*(亿|万亿|百万|万美元|亿美元|美元|倍|%))/,
  year: /(19\d{2}|20\d{2})\s*年/,
};

/* 候选：认错 / 不投 / 卖出，或者同时带年份和金额（后者是"有具体物件"的料） */
const cand = SEGS.filter(s =>
  SIG.correction.test(s.ans) || SIG.reject.test(s.ans) || SIG.sell.test(s.ans) ||
  (SIG.year.test(s.ans) && SIG.money.test(s.ans)));
/* 去重：同一年同一场次内容相近的只留一条 */
const seen = new Set();
const uniq = cand.filter(s => {
  const k = s.y + '|' + s.session + '|' + s.ans.slice(0, 30);
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});

const SESSION_ZH = { Morning_Session: '上午场', Afternoon_Session: '下午场', Part_1: '第一场', Part_2_Q: '第二场' };
function sessZh(s) { return SESSION_ZH[s] || s; }

const SYS = `你是一个档案整理员，在给一位投资家建"决策案例库"。
给你若干段他在伯克希尔股东大会上说的话（已标注年份、场次、章节）。
这些是逐字记录的中文译文，可以逐字引用。
你的任务是从每段里抽出可以长期复用的判断案例。

规则（违反任何一条都不合格）：
1. judgment 必须是这段里他真的说过的话。可以截取，但不得改写、不得概括、不得添加原文没有的信息。
2. 一段最多抽 2 条；没有价值的就抽 0 条，不要凑数。
3. 三种 kind 只能选一个：
   - correction：他在承认自己错了、后悔了、看走眼了
   - scorecard：一件具体的投资决策（买了/卖了/没投某个具体的公司或行业），必须填 entity
   - rule：一条可复用的判断原则（不针对某件具体事）
4. entity 只在 scorecard 填，写具体的公司名或行业名，不要写"某公司"。
5. situation 用一句话说清当时的情形，20-40 字。
6. lesson 是给后来人的一句话，不要写成正确的废话（"要理性投资"这种不合格）。
7. 只输出 JSON 数组，不要解释，不要 markdown 代码块。

每条的字段：
{"kind":"...","y":年份数字,"entity":"...","situation":"...","judgment":"...","judgment_verbatim":true,"lesson":"...","verdict":"hit/miss/mix/","slots":["..."]}

slots 只能从这些里选，可多选：市场大跌、市场过热、并购、回购、卖出、买入、公司出问题、业绩变化、管理层变动、宏观变化、分红、估值`;

/* pro 是推理模型：先想再答，预算给小了 content 就是空串（踩过一次，记牢）。
   这里 8000 起步，空了再加到 16000 重试一次；再空就从推理尾巴里捞 JSON。
   批次也别贪大 —— 一次 6 段，输出才装得下。 */
async function call(batch) {
  const u = batch.map((s, i) =>
    `[${i}] ${s.y} 年 · ${sessZh(s.session)} · 第${s.ch + 1}章${s.title ? '（' + s.title + '）' : ''}\n` +
    (s.ask ? `（股东问：${s.ask.slice(0, 120)}）\n` : '') +
    `他说：${s.ans.slice(0, 800)}`).join('\n\n');
  let t = '';
  for (const budget of [8000, 16000]) {
    const r = await fetch(API, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'system', content: SYS }, { role: 'user', content: u }],
        temperature: 0.2, max_tokens: budget, stream: false,
      }),
    });
    const j = await r.json();
    const msg = (j.choices && j.choices[0].message) || {};
    const uu = j.usage || {};
    USAGE.prompt += uu.prompt_tokens || 0;
    USAGE.completion += uu.completion_tokens || 0;
    USAGE.calls += 1;
    t = (msg.content || '').trim();
    if (t.indexOf('[') >= 0) break;
    const rc = (msg.reasoning_content || '');
    const m = rc.match(/\[[\s\S]*\]\s*$/);      /* content 空但推理末尾有 JSON */
    if (m) { t = m[0]; break; }
  }
  t = t.replace(/^```(?:json)?/, '').replace(/```$/, '').trim();
  const a = t.indexOf('['), b = t.lastIndexOf(']');
  if (a < 0 || b < 0) {
    if (DEBUG) console.log('\n[原始返回]\n' + t.slice(0, 500));
    return [];
  }
  let arr;
  try { arr = JSON.parse(t.slice(a, b + 1)); }
  catch (e) {
    if (DEBUG) console.log('\n[解析失败]\n' + t.slice(0, 500));
    return [];
  }
  /* 模型偶尔不照字段名写：judgments / text / quote 都当正文收下 */
  return arr.map(x => {
    if (!x || typeof x !== 'object') return null;
    const jm = x.judgment || (Array.isArray(x.judgments) ? x.judgments[0] : x.judgments)
      || x.text || x.quote || x.content || '';
    return Object.assign({}, x, { judgment: String(jm || '').trim() });
  }).filter(Boolean);
}

(async () => {
  const limitArg = process.argv.indexOf('--limit');
  const limit = limitArg > 0 ? +process.argv[limitArg + 1] : 0;
  const B = 6;
  const batches = [];
  for (let i = 0; i < uniq.length; i += B) batches.push(uniq.slice(i, i + B));
  const todo = limit ? batches.slice(0, limit) : batches;
  console.log(`巴菲特段 ${SEGS.length}，信号词候选 ${uniq.length} 段，分 ${batches.length} 批，本次跑 ${todo.length} 批`);

  if (DRY) {
    console.log('--dry：只算候选和批次，不调 LLM，退出。');
    return;
  }

  const out = [];
  for (let bi = 0; bi < todo.length; bi++) {
    const items = await call(todo[bi]);
    for (const it of items) {
      if (!it || !it.judgment) continue;
      /* 回挂来源坐标：抽出来的话必须能查回是哪一场讲的 */
      const src = todo[bi].find(s => it.judgment && s.ans.indexOf(String(it.judgment).slice(0, 12)) >= 0) || todo[bi][0];
      /* 会议是逐字可引：judgment 前 12 字对得上 ans 才算 verbatim */
      const verbatim = !!it.judgment && src.ans.indexOf(String(it.judgment).slice(0, 12)) >= 0;
      out.push(Object.assign({}, it, {
        judgment_verbatim: verbatim,
        src: { kind: 'meeting', y: src.y, session: src.session, ch: src.ch, who: src.who },
      }));
    }
    process.stdout.write(`\r  第 ${bi + 1}/${todo.length} 批，累计 ${out.length} 条   `);
    if (bi < todo.length - 1) await new Promise(r => setTimeout(r, 400));
  }
  console.log();
  console.log(`  token 用量：prompt ${USAGE.prompt} / completion ${USAGE.completion}（${USAGE.calls} 次调用）`);
  const file = path.join(__dirname, '_src', 'meeting', 'cases.json');
  fs.writeFileSync(file, JSON.stringify(out, null, 1), 'utf8');
  const byKind = {};
  out.forEach(x => { byKind[x.kind] = (byKind[x.kind] || 0) + 1; });
  console.log(`产出 ${out.length} 条 -> ${file}`);
  console.log('  分类', JSON.stringify(byKind));
  out.slice(0, 5).forEach(x => console.log(`  [${x.kind}] ${x.y} ${x.entity || ''} :: ${String(x.judgment).slice(0, 60)}`));
})();
