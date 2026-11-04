/* lookup / chat 答案契约的机械判分：第二遍独立跑，读 trace，不重烧模型的钱。
 *
 *   为什么和 score.js（quote）/ check_sim.js（judgment）并列：
 *   四桶路由把问题分成四类，每一类的"答案长什么样"是不同的契约——
 *     quote     要逐字原文 + 引用标记（score.js 管）；
 *     judgment  要五段研判（check_sim.js 管）；
 *     lookup    要"一个数/一句事实 + 出处"，不展开、不立场、不五段（本文件管）；
 *     chat      要"自然闲聊"，不查工具、不编引用、不硬拉投资（本文件管）。
 *   拿 quote 的逐字契约去量 lookup 答案，会把"本该直接报数"判成"没引原文"，是假失败。
 *
 *   判据来自 systemPrompt 里 lookup / chat 两个分支的写法，改提示词就得同步改这里。
 *
 *   用法：
 *     node eval/check_bucket.js <trace.jsonl>               判某份轨迹里 lookup/chat 的答案
 *     node eval/check_bucket.js --run-id rb12              按批次号捞
 *     node eval/check_bucket.js --verbose                  逐条打全表（默认只打不合格项）
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/* ---------------- 读输入 ---------------- */
function readRecords(file, runId, since) {
  const files = [];
  if (file) files.push(file);
  else {
    const dir = path.join(__dirname, 'traces');
    if (!fs.existsSync(dir)) return [];
    fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort().forEach(f => files.push(path.join(dir, f)));
  }
  const out = [];
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    const raw = fs.readFileSync(f, 'utf8').trim();
    if (!raw) continue;
    raw.split('\n').filter(Boolean).forEach(line => {
      try { out.push(JSON.parse(line)); } catch (e) {}
    });
  }
  /* 只留 lookup/chat 两类：桶字段（四桶代码落的）或 case id 前缀（lk-/ch-）都认 */
  return out.filter(d => {
    if (runId && d.run_id !== runId) return false;
    if (since && String(d.time || '') < since) return false;
    const qid = String(d.qid || '');
    const bucket = String(d.bucket || '');
    const isLookup = bucket === 'lookup' || qid.startsWith('lk-');
    const isChat = bucket === 'chat' || qid.startsWith('ch-');
    if (!isLookup && !isChat) return false;
    if (!String(d.answer || '').length) return false;
    return true;
  });
}

/* 五段标题：lookup 答案里出现任何一个都说明它硬拉成了研判 */
const HEADS_RE = /【(?:我确实说过|现在的事实|我怎么量它|所以|我可能错在哪)】/;
/* 立场词：lookup 不该给买卖判断 */
const STANCE_RE = /(该不该买|值不值|值得买|建议(?:买|关注|持有)|不买|买入|加仓|减仓|还能追|看好)/;
/* 出处标记：[[quote|…]]/[[web|…]]/[[news|…]]，或者明说来源 */
const SRC_RE = /\[\[(?:quote|web|news)\|[^\]]+\]\]|来源|网络来源|东方财富|腾讯行情|蛋卷|东财/;
/* chat 不该硬拉回投资 */
const INVEST_RE = /(内在价值|护城河|安全边际|能力圈|浮存金|透视盈余|致股东信|股东大会)/;

/* ---------------- 逐条判 ---------------- */
function judgeOne(d) {
  const t = String(d.answer || '');
  const body = t.replace(/\[\[[^\]]+\]\]/g, '');
  const qid = String(d.qid || '');
  const isChat = String(d.bucket || '') === 'chat' || qid.startsWith('ch-');
  const checks = [];
  const rec = (group, name, ok, detail) => checks.push({ group, name, ok: !!ok, detail: detail || '' });

  if (isChat) {
    /* chat 契约：自然闲聊，不查工具、不编引用、不硬拉投资 */
    const calls = (d.spans || []).filter(s => s.type === 'tool').length;
    rec('chat', '零工具调用', calls === 0, calls + ' 次');
    rec('chat', '没有编引用标记', !/\[\[[^\]]+\]\]/.test(t), '');
    rec('chat', '没有硬拉回投资', !INVEST_RE.test(body), '');
    rec('chat', '长度 ≤ 300 字', body.length <= 300, body.length + ' 字');
  } else {
    /* lookup 契约：一个数/一句事实 + 出处，不展开、不立场、不五段 */
    rec('lookup', '给出数字或事实', /\d/.test(body), body.slice(0, 36));
    /* 有出处：[[quote/web/news]] 引用，或明说来源，或调了 lookup 类工具（count_mentions 返回
       「出现 N 次」没有 URL，但数字来自工具，也算有出处）。 */
    const usedLookupTool = (d.spans || []).some(s => s.type === 'tool' &&
      ['market_snapshot', 'count_mentions', 'web_search', 'open_url'].indexOf(s.name) >= 0);
    rec('lookup', '有出处标记', SRC_RE.test(t) || usedLookupTool, '');
    rec('lookup', '没有五段结构', !HEADS_RE.test(t), '');
    rec('lookup', '没有研判立场', !STANCE_RE.test(body), '');
    rec('lookup', '长度 ≤ 400 字', body.length <= 400, body.length + ' 字');
  }

  return { checks, len: body.length, bucket: isChat ? 'chat' : 'lookup', answer: t, qid: d.qid || '' };
}

/* ---------------- 汇总输出 ---------------- */
const argv = process.argv.slice(2);
const verbose = argv.indexOf('--verbose') >= 0;
const runIdx = argv.indexOf('--run-id');
const runId = runIdx >= 0 ? argv[runIdx + 1] : '';
const sinceIdx = argv.indexOf('--since');
const since = sinceIdx >= 0 ? argv[sinceIdx + 1] : '';
const pos = argv.filter((a, i) => !a.startsWith('--') &&
  !(runIdx >= 0 && i === runIdx + 1) && !(sinceIdx >= 0 && i === sinceIdx + 1));

const recs = readRecords(pos[0], runId, since);
if (!recs.length) {
  console.log('没读到可判的 lookup/chat 答案。用法：node eval/check_bucket.js <trace.jsonl> [--run-id X]');
  process.exit(1);
}

const results = recs.map(judgeOne);
const byCheck = {};
results.forEach(r => r.checks.forEach(c => {
  const k = c.group + '·' + c.name;
  byCheck[k] = byCheck[k] || { pass: 0, total: 0, bad: [] };
  byCheck[k].total++;
  if (c.ok) byCheck[k].pass++;
  else byCheck[k].bad.push((r.qid || '?') + '：' + c.detail);
}));

const nLookup = results.filter(r => r.bucket === 'lookup').length;
const nChat = results.filter(r => r.bucket === 'chat').length;
const full = results.filter(r => r.checks.every(c => c.ok)).length;
console.log('分桶答案契约 · ' + recs.length + ' 条（lookup ' + nLookup + ' · chat ' + nChat + '）' +
  ' · 全部通过 ' + full + ' 条（' + (full / recs.length * 100).toFixed(1) + '%）');
console.log('');

for (const g of ['lookup', 'chat']) {
  const keys = Object.keys(byCheck).filter(k => k.startsWith(g + '·'));
  if (!keys.length) continue;
  console.log('[' + g + ']');
  keys.forEach(k => {
    const v = byCheck[k];
    const pct = v.pass / v.total * 100;
    const flag = pct === 100 ? '✓' : (pct >= 80 ? '~' : '✗');
    console.log('  ' + flag + ' ' + k.split('·')[1] + '  ' + v.pass + '/' + v.total +
      (pct === 100 ? '' : '（' + pct.toFixed(0) + '%）'));
    if (verbose || pct < 100) v.bad.slice(0, verbose ? 99 : 3).forEach(b => console.log('      - ' + b.slice(0, 120)));
  });
  console.log('');
}

if (verbose) {
  results.forEach(r => {
    console.log('— ' + (r.qid || '单条') + ' · ' + r.bucket + ' · ' + r.len + ' 字');
    r.checks.filter(c => !c.ok).forEach(c => console.log('    ✗ ' + c.group + '·' + c.name + ' · ' + c.detail));
  });
  console.log('');
}
