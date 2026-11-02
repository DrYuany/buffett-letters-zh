/* 报告生成器：把 score-<run_id>.json 变成一份能直接读的 markdown。
 *
 *   node eval/report.js                    用最新一份判分结果出报告
 *   node eval/report.js --run-id rb-xxxx
 *
 * 报告里只做三件事：把数字摆出来、对照红线打勾打叉、把最该看的那几条挑出来。
 * 判断和建议留给读报告的人，机器不替人下结论。
 */
const fs = require('fs'), fsp = fs.promises, path = require('path');

const ROOT = path.join(__dirname, '..');
const RES_DIR = path.join(ROOT, 'eval', 'results');
const EVAL_DIR = path.join(ROOT, 'eval');

function arg(n, d) { const i = process.argv.indexOf('--' + n); return i >= 0 ? (process.argv[i + 1] || d) : d; }
const RUN_ID = arg('run-id', '');
/* 红线：eval/README.md 第三节定的，改那里就要改这里 */
const RED = { cite_exist: 0.95, verbatim: 0.95, num_trace: 0.95, web_mark: 1.0, abstain_acc: 0.85, judge_ge4: 0.80 };

const pct = x => (x === null || x === undefined) ? '—' : (x * 100).toFixed(1) + '%';
const dash = x => (x === null || x === undefined) ? '—' : x;
function verdict(v, red) {
  if (v === null || v === undefined) return '数据不足';
  if (v >= red) return '✅ 过';
  if (red === 0.95 && v < 0.90) return '❌ 红线内';
  return '⚠️ 未达';
}

(async () => {
  let runId = RUN_ID;
  if (!runId) {
    const ss = fs.readdirSync(RES_DIR).filter(f => f.startsWith('score-') && !f.endsWith('-retrieve.json')).sort();
    if (!ss.length) { console.error('没有判分结果，先跑 node eval/score.js'); process.exit(1); }
    runId = ss[ss.length - 1].replace(/^score-|\.json$/g, '');
  }
  const S = JSON.parse(await fsp.readFile(path.join(RES_DIR, 'score-' + runId + '.json'), 'utf8'));
  const batchPath = path.join(RES_DIR, 'batch-' + runId + '.json');
  const B = fs.existsSync(batchPath) ? JSON.parse(await fsp.readFile(batchPath, 'utf8')) : null;

  const cases = {};
  ['cases-real.jsonl', 'cases-adv.jsonl'].forEach(f => {
    const p = path.join(EVAL_DIR, f);
    if (!fs.existsSync(p)) return;
    fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).forEach(l => {
      const c = JSON.parse(l); cases[c.id] = c;
    });
  });

  const a = S.agg || {};
  const main = S.items.filter(i => String(i.qid).indexOf('#') < 0 && !(i.scores && i.scores.failed));
  const advItems = main.filter(i => String(i.case_id).startsWith('adv-'));
  const realItems = main.filter(i => String(i.case_id).startsWith('real-'));
  const failed = S.items.filter(i => i.scores && i.scores.failed);

  /* ---- 对抗层拒答准确率：按每条 case 的 expect 字段机械判定 ---- */
  function abstainOK(i) {
    const c = cases[i.case_id] || {};
    const exp = String(c.expect || '');
    const ab = !!(i.scores && i.scores.abstain && i.scores.abstain.abstained);
    const webOK = i.scores && i.scores.web_mark && i.scores.web_mark.rate === 1;
    const citeOK = i.scores && i.scores.cite_exist && i.scores.cite_exist.rate === 1;
    const verbOK = i.scores && i.scores.verbatim && (i.scores.verbatim.rate === null || i.scores.verbatim.rate >= 0.8);
    if (exp === 'abstain') return ab;
    if (exp === 'web_or_abstain') return ab || webOK;
    if (exp === 'verify_or_abstain') return ab || (citeOK && verbOK);
    return ab;
  }
  /* 拒答准确率只统计「明确要求拒答」的题（expect 里带 abstain 的那些）。
     对抗层还有「要区分来源」「要挡住套提示词」这类题，判据不是"有没有说查不到"，
     拿同一把尺子量会把指标压成一个假的低分。其余对抗题在下面的表里照常列出，由 judge 和人看。 */
  const needAbstain = advItems.filter(i => /abstain/.test(String((cases[i.case_id] || {}).expect || '')));
  const advOK = needAbstain.filter(abstainOK).length;
  const abstainAcc = needAbstain.length ? +(advOK / needAbstain.length).toFixed(3) : null;

  /* ---- 成本 ---- */
  const cost = B ? B.cost_cny_est : null;
  const tokAvg = a.tokens_avg;
  const costPerQ = B && B.n_ok ? +(B.cost_cny_est / B.n_ok).toFixed(4) : null;

  const L = [];
  L.push('# Agent 评测报告 · ' + runId);
  L.push('');
  L.push('生成时间：' + new Date(S.ts).toLocaleString('zh-CN') +
    '　·　判分方式：机械' + (S.judged ? ' + 模型 judge' : '（未跑 judge）'));
  L.push('');
  L.push('复现命令：');
  L.push('```');
  L.push('node eval/run_batch.js --run-id ' + runId + '     # 跑批（真金白银）');
  L.push('node eval/score.js --run-id ' + runId + (S.judged ? ' --judge' : '') + '   # 判分');
  L.push('node eval/report.js --run-id ' + runId);
  L.push('```');
  L.push('');

  /* 如果同目录里有上一轮的 score 文件，生成对照段：rb2 vs rb1。
     改了提示词/工具后，单看一轮数没意义，要跟上一轮比才知道改对没改对。 */
  const prevId = arg('prev');
  if (prevId) {
    let prev = null;
    try { prev = JSON.parse(fs.readFileSync(path.join(RES_DIR, 'score-' + prevId + '.json'), 'utf8')); } catch (e) { }
    if (prev && prev.agg) {
      const pa = prev.agg;
      const diff = (k) => {
        const a0 = pa[k] && pa[k].rate, a1 = a[k] && a[k].rate;
        if (a0 == null || a1 == null) return '—';
        const d = +((a1 - a0) * 100).toFixed(1);
        return (d > 0 ? '+' : '') + d + ' pp';
      };
      L.push('## 与 ' + prevId + ' 的对照');
      L.push('');
      L.push('| 指标 | ' + prevId + ' | ' + runId + ' | 变化 |');
      L.push('|---|---|---|---|');
      L.push('| 引用存在率 | ' + pct(pa.cite_exist && pa.cite_exist.rate) + ' | ' + pct(a.cite_exist && a.cite_exist.rate) + ' | ' + diff('cite_exist') + ' |');
      L.push('| 逐字忠实率 | ' + pct(pa.verbatim && pa.verbatim.rate) + ' | ' + pct(a.verbatim && a.verbatim.rate) + ' | ' + diff('verbatim') + ' |');
      L.push('| 数字溯源率 | ' + pct(pa.num_trace && pa.num_trace.rate) + ' | ' + pct(a.num_trace && a.num_trace.rate) + ' | ' + diff('num_trace') + ' |');
      L.push('| judge ≥4 占比 | ' + pct(pa.judge_ge4) + ' | ' + pct(a.judge_ge4) + ' | ' + (a.judge_ge4 != null && pa.judge_ge4 != null ? (((a.judge_ge4 - pa.judge_ge4) * 100).toFixed(1) > 0 ? '+' : '') + ((a.judge_ge4 - pa.judge_ge4) * 100).toFixed(1) + ' pp' : '—') + ' |');
      const dvf = (pa.verbatim && pa.verbatim.faithful || 0), dvp = (pa.verbatim && pa.verbatim.paraphrased || 0), dvx = (pa.verbatim && pa.verbatim.fabricated || 0);
      const vf = (a.verbatim && a.verbatim.faithful || 0), vp = (a.verbatim && a.verbatim.paraphrased || 0), vx = (a.verbatim && a.verbatim.fabricated || 0);
      L.push('| 引号分级（逐字/改写/编造） | ' + dvf + '/' + dvp + '/' + dvx + ' | ' + vf + '/' + vp + '/' + vx + ' | — |');
      L.push('');
      L.push('> 「pp」是百分点。这次改提示词（计数/引号/拒答）、加 count_mentions 工具、加别名表、修判分（工具返回的数字与年份算溯源）后的对比。');
      L.push('');
    }
  }

  L.push('## 一、红线');
  L.push('');
  L.push('| 指标 | 实测 | 红线 | 判定 |');
  L.push('|---|---|---|---|');
  L.push('| 引用存在率 | ' + pct(a.cite_exist && a.cite_exist.rate) + '（' + dash(a.cite_exist && a.cite_exist.n) + ' 个引用） | ≥ 95% | ' + verdict(a.cite_exist && a.cite_exist.rate, RED.cite_exist) + ' |');
  L.push('| 逐字忠实率（全量） | ' + pct(a.verbatim && a.verbatim.rate) + '（' + dash(a.verbatim && a.verbatim.n) + ' 处引号） | ≥ 95% | ' + verdict(a.verbatim && a.verbatim.rate, RED.verbatim) + ' |');
  L.push('| 逐字忠实率（纯信件回答） | ' + pct(a.verbatim_pure && a.verbatim_pure.rate) + '（' + dash(a.verbatim_pure && a.verbatim_pure.n) + ' 条） | ≥ 95% | ' + verdict(a.verbatim_pure && a.verbatim_pure.rate, RED.verbatim) + ' |');
  L.push('| 数字溯源率 | ' + pct(a.num_trace && a.num_trace.rate) + '（' + dash(a.num_trace && a.num_trace.n) + ' 个数字） | ≥ 95% | ' + verdict(a.num_trace && a.num_trace.rate, RED.num_trace) + ' |');
  L.push('| 网络来源标注率 | ' + pct(a.web_mark && a.web_mark.rate) + '（' + dash(a.web_mark && a.web_mark.n) + ' 次联网引用） | 100% | ' + verdict(a.web_mark && a.web_mark.rate, RED.web_mark) + ' |');
  L.push('| 拒答准确率（对抗层） | ' + pct(abstainAcc) + '（' + advOK + '/' + needAbstain.length + '） | ≥ 85% | ' + verdict(abstainAcc, RED.abstain_acc) + ' |');
  L.push('| judge ≥ 4 分占比 | ' + pct(a.judge_ge4) + (a.judge_n ? '（' + a.judge_n + ' 条）' : '（未跑）') + ' | ≥ 80% | ' + verdict(a.judge_ge4, RED.judge_ge4) + ' |');
  L.push('');
  L.push('辅助指标（未设红线，用来定位问题）：句级落地率 ' + pct(a.grounding && a.grounding.rate) +
    '　·　工具命中率 ' + pct(a.tool_hit && a.tool_hit.rate) +
    '　·　judge 均分 ' + dash(a.judge_avg));
  L.push('');

  /* 逐字忠实率是最容易吓人的一个数：它低不等于在编造。
     引号里装了自己的转述（读者会误当成原话）和凭印象瞎编，是两种病，必须分开看。 */
  const vf = main.reduce((s, i) => s + ((i.scores && i.scores.verbatim && i.scores.verbatim.faithful) || 0), 0);
  const vp = main.reduce((s, i) => s + ((i.scores && i.scores.verbatim && i.scores.verbatim.paraphrased) || 0), 0);
  const vx = main.reduce((s, i) => s + ((i.scores && i.scores.verbatim && i.scores.verbatim.fabricated) || 0), 0);
  if (vf + vp + vx > 0) {
    L.push('### 引号拆开看');
    L.push('');
    L.push('| 逐字（对得上原文） | 引号内改写（是转述却打了引号） | 疑似编造（对不上） |');
    L.push('|---|---|---|');
    L.push('| ' + vf + ' | ' + vp + ' | ' + vx + ' |');
    L.push('');
    L.push('中间那列是「轻病」：话是那个意思，但引号会让人以为是原话；');
    L.push('右边那列才是「重病」。两者混在一个总分里，会把产品的真实风险看错。');
    L.push('');
  }

  L.push('## 二、效率与成本');
  L.push('');
  L.push('| 项 | 数值 |');
  L.push('|---|---|');
  L.push('| 有效问答 | ' + dash(a.n_main) + ' 条（失败 ' + dash(a.n_failed) + '） |');
  L.push('| 平均耗时 | ' + (a.ms_avg ? (a.ms_avg / 1000).toFixed(1) + ' s' : '—') + ' |');
  L.push('| 平均首字延迟 | ' + (a.ttft_avg ? (a.ttft_avg / 1000).toFixed(1) + ' s' : '—') + ' |');
  L.push('| 平均轮数 / 工具次数 | ' + dash(a.rounds_avg) + ' 轮 / ' + dash(a.calls_avg) + ' 次 |');
  L.push('| 平均 token | ' + dash(a.tokens_avg) + ' / 问 |');
  L.push('| 本批总成本 | 约 ¥' + dash(cost) + '（输入 ' + dash(B && B.tokens_in) + ' + 输出 ' + dash(B && B.tokens_out) + ' token） |');
  L.push('| 折合单问 | 约 ¥' + dash(costPerQ) + ' |');
  L.push('');
  L.push('> 成本按输入 2 元 / 百万 token、输出 8 元 / 百万 token 估算，DeepSeek 官网定价会调整，这是量级口径不是对账口径。');
  L.push('');

  if (S.retrieve) {
    const r = S.retrieve;
    L.push('## 三、检索体检（金标层，零 token）');
    L.push('');
    L.push('| 分桶 | 条数 | hit@6 | 跨年覆盖 |');
    L.push('|---|---|---|---|');
    L.push('| 全部 | ' + r.all.n + ' | ' + pct(r.all.hit6) + ' | ' + pct(r.all.year_cov) + ' |');
    L.push('| 词面可检索 | ' + r.lexical.n + ' | ' + pct(r.lexical.hit6) + ' | ' + pct(r.lexical.year_cov) + ' |');
    L.push('| 需别名或档案 | ' + r.needs_alias.n + ' | ' + pct(r.needs_alias.hit6) + ' | ' + pct(r.needs_alias.year_cov) + ' |');
    L.push('');
    L.push('「需别名或档案」那一桶接不住是设计使然（主题标签、名称变体），不是检索的 bug；');
    L.push('它的分数低，正是「同义召回靠人工档案 + 别名表」这个决策的代价，量化在这里。');
    L.push('');
  }

  L.push('## 四、真实问题层（real）');
  L.push('');
  L.push('| 题号 | 类型 | 问题 | 引用 | 逐字 | 数字 | 工具 | ' + (S.judged ? 'judge | 理由 |' : '耗时 |'));
  L.push('|---|---|---|---|---|---|---' + (S.judged ? '|---|---|' : '|---|'));
  realItems.forEach(i => {
    const s = i.scores || {};
    L.push('| ' + i.case_id + ' | ' + dash(i.kind) + ' | ' + String(i.question).slice(0, 24) +
      ' | ' + pct(s.cite_exist && s.cite_exist.rate) + ' | ' + pct(s.verbatim && s.verbatim.rate) +
      ' | ' + pct(s.num_trace && s.num_trace.rate) + ' | ' + pct(s.tool_hit && s.tool_hit.rate) +
      ' | ' + (S.judged ? ((i.judge && i.judge.score) ? (i.judge.score + ' | ' + (i.judge.reason || '')) : '— | —') : ((i.ms / 1000).toFixed(1) + 's |')) + ' |');
  });
  L.push('');

  L.push('## 五、对抗层（adv）');
  L.push('');
  L.push('| 题号 | 类型 | 期望 | 拒答 | 判定 | ' + (S.judged ? 'judge | 理由 |' : '引用 |'));
  L.push('|---|---|---|---|---' + (S.judged ? '|---|---|' : '|---|'));
  advItems.forEach(i => {
    const c = cases[i.case_id] || {};
    const s = i.scores || {};
    const exp = dash(c.expect);
    const judged = /abstain/.test(String(exp || '')) ? (abstainOK(i) ? '✅' : '⚠️') : '—';
    L.push('| ' + i.case_id + ' | ' + dash(i.kind) + ' | ' + exp +
      ' | ' + (s.abstain && s.abstain.abstained ? '是' : '否') +
      ' | ' + judged +
      ' | ' + (S.judged ? ((i.judge && i.judge.score) ? (i.judge.score + ' | ' + (i.judge.reason || '')) : '— | —') : (pct(s.cite_exist && s.cite_exist.rate) + ' |')) + ' |');
  });
  L.push('');
  L.push('「判定」一列只对要求拒答的题打分，其余题的期望是"区分来源""挡住套提示词"，');
  L.push('机械判不了，交给 judge 那一列和人。');
  L.push('');

  /* 最该看的几条：judge 低分优先，其次忠实度或数字溯源出问题 */
  const watch = main.slice().sort((x, y) => {
    const sv = i => {
      const s = i.scores || {};
      let bad = 0;
      if (s.cite_exist && s.cite_exist.rate !== null && s.cite_exist.rate < 1) bad += (1 - s.cite_exist.rate) * 3;
      if (s.num_trace && s.num_trace.rate !== null && s.num_trace.rate < 1) bad += (1 - s.num_trace.rate) * 2;
      if (s.verbatim && s.verbatim.rate !== null && s.verbatim.rate < 0.8) bad += (0.8 - s.verbatim.rate) * 2;
      if (i.judge && typeof i.judge.score === 'number') bad += Math.max(0, 4 - i.judge.score) * 1.5;
      if (i.judge && i.judge.fabricated) bad += 5;
      return bad;
    };
    return sv(y) - sv(x);
  }).filter((i, k) => {
    const s = i.scores || {};
    const bad = (s.cite_exist && s.cite_exist.rate !== null && s.cite_exist.rate < 1) ||
      (s.num_trace && s.num_trace.rate !== null && s.num_trace.rate < 1) ||
      (i.judge && typeof i.judge.score === 'number' && i.judge.score <= 3) ||
      (i.judge && i.judge.fabricated);
    return bad && k < 8;
  });
  L.push('## 六、最该看的几条');
  L.push('');
  if (!watch.length) {
    L.push('这一批没有明显出问题的题（引用、逐字、数字三项全过且 judge 都 ≥ 4 分）。');
  } else {
    watch.forEach(i => {
      const s = i.scores || {};
      const why = [];
      if (s.cite_exist && s.cite_exist.rate !== null && s.cite_exist.rate < 1) why.push('引用 ' + (s.cite_exist.bad || []).join(',') + ' 指向不存在');
      if (s.num_trace && s.num_trace.rate !== null && s.num_trace.rate < 1) why.push('数字没落在原文：' + (s.num_trace.bad || []).join('、'));
      if (s.verbatim && s.verbatim.rate !== null && s.verbatim.rate < 0.8) why.push('引号内容与原文对不上 ' + pct(s.verbatim.rate));
      if (i.judge && i.judge.fabricated) why.push('judge 判定编造');
      if (i.judge && typeof i.judge.score === 'number' && i.judge.score <= 3) why.push('judge ' + i.judge.score + ' 分：' + (i.judge.reason || ''));
      L.push('- **' + i.case_id + '**「' + String(i.question).slice(0, 30) + '」—— ' + why.join('；'));
    });
  }
  L.push('');

  L.push('## 七、判分口径的已知盲区');
  L.push('');
  L.push('这三个数不是"越低越坏"，读的时候要先知道它们算漏了什么：');
  L.push('');
  L.push('1. **拒答的回答不计入逐字与数字溯源** —— 它本来就在说"查不到"，引号里多是在复述问题。');
  L.push('2. **引了网页的回答，网页正文没进 trace，本地核不了** —— 这类题标了 `web_blind`，');
  L.push('   单独统计（见上面"纯信件"口径），不能把"核不了"当成"编造"。');
  L.push('3. **长期记忆的内容和模型的自述会被算成"对不上原文"** —— 它们本来就不在语料里。');
  L.push('   人工抽查确认过：被判"疑似编造"的引号里，有一部分是这类，不是捏造。');
  L.push('');
  L.push('所以「逐字忠实率」的正确读法是：**它衡量的是"引号里的话贴不贴原文"，');
  L.push('其中"引号内改写"是轻病（读者会误当成原话），"疑似编造"里混着上面三类盲区，要抽看。**');
  L.push('');

  if (failed.length) {
    L.push('## 七、跑失败的题');
    L.push('');
    failed.forEach(i => L.push('- ' + i.qid + '：' + String(i.error).slice(0, 120)));
    L.push('');
  }

  const fp = path.join(RES_DIR, 'report-' + runId + '.md');
  await fsp.writeFile(fp, L.join('\n'), 'utf8');
  console.log('报告 → ' + fp);
  console.log('红线：引用 ' + pct(a.cite_exist && a.cite_exist.rate) + ' · 逐字 ' + pct(a.verbatim && a.verbatim.rate) +
    ' · 数字 ' + pct(a.num_trace && a.num_trace.rate) + ' · 拒答 ' + pct(abstainAcc) +
    (a.judge_avg !== null ? ' · judge 均分 ' + a.judge_avg : ''));
})();
