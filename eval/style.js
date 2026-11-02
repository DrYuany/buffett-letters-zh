/* 第一把尺子：文风像不像
 *
 *   node eval/style.js                 # 默认 8 个题目 × 3 种配置
 *   node eval/style.js --n 4           # 少跑几条
 *   node eval/style.js --judge 0       # 只算距离比，不叫模型盲判（省钱）
 *
 * 两个指标，缺一不可：
 *
 *   A 距离比（确定性，零主观）
 *     把真信件段落切成字二元组、建 tf-idf 质心，算每个段落到质心的余弦距离。
 *     再算生成段落同样的距离。比值 = 生成/真实。
 *     1.0 表示"和他的语料在字面分布上分不出来"，>1 表示比真段落更像外人。
 *     这个指标不需要模型、不会自我偏好，但只看到用词，看不到论证方式。
 *
 *   B 成对盲判（模型判，但有位置偏差）
 *     真段落 + 生成段落随机排序，问判官"哪一段更可能出自这批致股东信"。
 *     同一对换序再问一次，两次都选中同一段才算赢 —— 消掉"总选第一个"的偏好。
 *     判官用它自己没写过的模型不行（同一个模型会偏爱自己的输出），
 *     所以这里用 pro 判 flash 的产出，并在报告里写明。
 *
 * 只测"表达层"：调的是线上同一个 systemPrompt（require 进来的），但绕开工具循环，
 * 因为工具会往答案里塞 [[信|段]] 引用标记和两区标题 —— 那些结构一眼就能认出来，
 * 判官会去判格式而不是判文风。
 */
const fs = require('fs');
const path = require('path');
const A = require('../agent.js');

const ROOT = path.join(__dirname, '..');
const KEY = fs.readFileSync(path.join(ROOT, '_agent.key'), 'utf8').trim();
const API = 'https://api.deepseek.com/chat/completions';
const RES = path.join(__dirname, 'results');
fs.mkdirSync(RES, { recursive: true });

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const N = Number(arg('n', 8));
const DO_JUDGE = arg('judge', '1') !== '0';

/* ---------- 真语料：信件段落 ---------- */
const L = A.L;
const real = [];
Object.keys(L).forEach(id => {
  const lt = L[id];
  (lt.blocks || []).forEach(b => {
    const t = (b.t || '').replace(/\s+/g, ' ').trim();
    if (b.k === 'h' || b.k === 'h2') return;
    if (t.length < 120 || t.length > 300) return;
    if (!/[。！？…”」』]$/.test(t)) return;
    if (/^[（(]\s*\d+\s*[)）]/.test(t)) return;
    if (/^[A-Za-z0-9 ,.'"()\-]+$/.test(t)) return;      // 纯英文表格行不算
    real.push({ id, b: b.b, y: lt.year, t });
  });
});
/* 分层抽样：按年代均匀取，免得全是 80 年代 */
real.sort((a, b) => a.y - b.y);
const picked = [];
const step = Math.max(1, Math.floor(real.length / 220));
for (let i = 0; i < real.length; i += step) picked.push(real[i]);

/* ---------- 字面距离 ---------- */
const tok = s => {
  const out = [];
  const t = String(s).replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, ' ');
  t.split(/\s+/).forEach(run => {
    if (!run) return;
    if (/^[A-Za-z0-9]+$/.test(run)) { out.push(run.toLowerCase()); return; }
    for (let i = 0; i + 2 <= run.length; i++) out.push(run.slice(i, i + 2));
  });
  return out;
};
const DF = {};
picked.forEach(p => new Set(tok(p.t)).forEach(g => { DF[g] = (DF[g] || 0) + 1; }));
const N_REAL = picked.length;
const weight = g => Math.log(1 + N_REAL / ((DF[g] || 0) + 1));

function vec(t) {
  const tf = {};
  tok(t).forEach(g => { tf[g] = (tf[g] || 0) + 1; });
  const v = {};
  let norm = 0;
  Object.keys(tf).forEach(g => {
    const w = (1 + Math.log(tf[g])) * weight(g);
    v[g] = w; norm += w * w;
  });
  norm = Math.sqrt(norm) || 1;
  Object.keys(v).forEach(g => { v[g] /= norm; });
  return v;
}
const VECS = picked.map(p => vec(p.t));
const centroid = {};
VECS.forEach(v => Object.keys(v).forEach(g => { centroid[g] = (centroid[g] || 0) + v[g] / VECS.length; }));
let cn = 0;
Object.keys(centroid).forEach(g => { cn += centroid[g] * centroid[g]; });
cn = Math.sqrt(cn) || 1;
Object.keys(centroid).forEach(g => { centroid[g] /= cn; });

const cos = (a, b) => {
  let s = 0;
  Object.keys(a).forEach(g => { if (b[g]) s += a[g] * b[g]; });
  return s;
};
const dist = t => 1 - cos(vec(t), centroid);
const realDist = picked.map(p => dist(p.t));
const mean = a => a.reduce((x, y) => x + y, 0) / (a.length || 1);

/* ---------- 可直接量的三个量表 ----------
   字面距离只看到用词，看不到"句子多长""有没有把读者拉进来"。
   这三样都能直接数，不需要判官，也不受判官偏好影响。 */
const CNCH = /[\u4e00-\u9fa5]/g;
const splitSent = t => String(t).split(/(?<=[。！？!?])/).map(s => s.trim()).filter(Boolean);
function shape(t) {
  const ss = splitSent(t);
  const lens = ss.map(s => (s.match(CNCH) || []).length).filter(n => n > 0).sort((a, b) => a - b);
  const oral = ss.filter(s => /(你看|你想想|说白了|其实|根本|我见过|不知道|你想想看)/.test(s)).length;
  return {
    sentMed: lens.length ? lens[Math.floor(lens.length / 2)] : 0,
    sents: ss.length,
    oralRate: ss.length ? +(oral / ss.length * 100).toFixed(0) : 0,
  };
}
const aggregate = texts => {
  const s = texts.map(shape);
  return {
    sentMed: +(mean(s.map(x => x.sentMed))).toFixed(1),
    sents: +(mean(s.map(x => x.sents))).toFixed(1),
    oralRate: +(mean(s.map(x => x.oralRate))).toFixed(0),
  };
};
const REAL_SHAPE = aggregate(picked.slice(0, 200).map(p => p.t));

/* 第二个参照：他自己说话的形态（股东会问答中译）。
   只拿信件当基准会误判 —— 信件是书面语，句长 39 字、口语标记 2%；
   股东会问答是口语，句长 24 字、口语标记四成。生成落在两者之间才算对，
   落在哪一侧取决于问的是什么：问「信里写过什么」该偏书信端，问「你怎么想」该偏说话端。
   两个基准都给，就不至于把「偏口语」误读成「过头」。 */
let TALK_SHAPE = null;
try {
  const vm = require('vm');
  const ctx = { window: {} };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'site/data-talk.js'), 'utf8'), ctx);
  const segs = (ctx.window.TALK.segs || []).map(s => s.ans).filter(Boolean);
  TALK_SHAPE = Object.assign(aggregate(segs), { n: segs.length });
} catch (e) { /* 口语语料没生成就跳过，不影响信件端测量 */ }

/* ---------- 校准：两条对照写法 ----------
   没有对照，比值 1.08 是高是低没法解释。
   研报腔应该明显更远，口语腔应该接近真段落 —— 如果这两条分不开，尺子就不能用。 */
const CTRL = {
  '研报腔': '综上所述，零售行业正处于结构性调整的关键阶段。从基本面来看，同店销售增速的下滑反映出消费动能的边际走弱，而成本端的优化空间已经相对有限。我们认为，在当前估值水平下，该标的的风险收益比并不具备显著吸引力，建议投资者保持谨慎，密切关注后续季度的经营数据披露以及管理层的战略调整举措。总体而言，行业竞争格局的演变仍需进一步观察。',
  '口语腔': '你看，零售这行当有个麻烦：你今天想到的办法，明天隔壁就学会了。我见过太多这样的例子，头几年风风光光，后来突然就不行了。为什么？因为顾客没有忠诚这回事，谁便宜谁方便就去谁那儿。所以我不太敢说自己看得懂一家零售店十年后会怎样。这不是谦虚，是真不知道。',
};


const TOPICS = [
  '为什么大多数人做不好投资？',
  '一家好公司突然变便宜了，这件事本身说明什么？',
  '怎么判断一个管理者值不值得信任？',
  '为什么你宁可要波动的 15%，也不要平滑的 12%？',
  '普通人该不该每天看股价？',
  '什么生意你一辈子都不会碰，为什么？',
  '钱多到一定程度之后，投资变难了还是变容易了？',
  '如果你只有三十岁、只有十万块，你会怎么开始？',
];
const ASK = q => `（这一问不用查资料，也不要分区、不要引用标记。就用你平常说话的方式，一段话回答，250 字以内。问题：${q}）`;

async function gen(sysPrompt, q) {
  const r = await fetch(API, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-flash',
      messages: [{ role: 'system', content: sysPrompt }, { role: 'user', content: ASK(q) }],
      temperature: 0.7, max_tokens: 600, stream: false,
    }),
  });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text()).slice(0, 120));
  const j = await r.json();
  return (j.choices[0].message.content || '').replace(/\[\[[^\]]*\]\]/g, '').replace(/〔[^〕]*〕/g, '').trim();
}

async function judge(pair) {
  const sys = '你是一个文体鉴定员。你会看到两段中文，其中一段摘自一批真实的致股东信，另一段是模仿者写的。只从用词、句长、语气、论证方式判断，不要因为提到具体年份或公司就下结论。只输出 A 或 B，不要解释。';
  const u = `A：${pair[0]}\n\nB：${pair[1]}\n\n哪一段更可能是真实的那批信里的一段？只回 A 或 B。`;
  /* max_tokens 给 8 是不够的：pro 是推理模型，先想再答，8 个 token 全被推理吃掉，
     content 返回空串，解析成"选了 B" —— 结果恒为 0 认出。踩过一次，记在这儿。
     400 也不总够（长文本推理更费），所以空了就加预算重试，不要静默当成 B。 */
  let t = '';
  const budgets = [400, 900, 1500, 1500];
  for (let i = 0; i < budgets.length; i++) {
    if (i) await new Promise(r => setTimeout(r, 1200 * i));
    const r = await fetch(API, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v4-pro',
        messages: [{ role: 'system', content: sys }, { role: 'user', content: u }],
        temperature: 0, max_tokens: budgets[i], stream: false,
      }),
    });
    const j = await r.json();
    const msg = j.choices[0].message || {};
    t = (msg.content || '').trim().toUpperCase();
    if (/[AB]/.test(t)) break;
    /* content 空但推理里有结论：从推理尾巴里捞，比丢掉这一次好 */
    const rc = (msg.reasoning_content || '').trim().toUpperCase();
    const tail = rc.match(/[^A-Z]([AB])[^A-Z]?\s*$/);
    if (tail) { t = tail[1]; break; }
  }
  const m = t.match(/[AB]/);
  if (!m) return null;            /* 弃判：单独计数，不悄悄当成选了某一边 */
  return m[0] === 'A' ? 0 : 1;
}

(async () => {
  const configs = [
    { name: 'voice+name', opts: {} },
    { name: 'no-voice', opts: { noVoice: true } },
    { name: 'anon', opts: { anon: true } },
  ];
  const out = { ts: new Date().toISOString(), n: Math.min(N, TOPICS.length), realN: picked.length, configs: {} };

  console.log(`真语料段落 ${picked.length} 段，真实距离均值 ${mean(realDist).toFixed(4)}`);
  console.log(`真段落形态（信件，书面端）：句长中位 ${REAL_SHAPE.sentMed} 字 / 每段 ${REAL_SHAPE.sents} 句 / 口语标记 ${REAL_SHAPE.oralRate}%`);
  if (TALK_SHAPE) console.log(`真段落形态（股东会问答，说话端）：句长中位 ${TALK_SHAPE.sentMed} 字 / 每段 ${TALK_SHAPE.sents} 句 / 口语标记 ${TALK_SHAPE.oralRate}%（n=${TALK_SHAPE.n}）`);
  out.realShape = REAL_SHAPE;
  out.talkShape = TALK_SHAPE;
  out.controls = {};
  console.log('校准（这两条分不开，下面的数就不用看了）：');
  Object.entries(CTRL).forEach(([k, t]) => {
    const r = +(dist(t) / mean(realDist)).toFixed(2);
    const sh = shape(t);
    out.controls[k] = { ratio: r, sentMed: sh.sentMed, oralRate: sh.oralRate };
    console.log(`  ${k}  比值 ${r}  句长 ${sh.sentMed} 字  口语标记 ${sh.oralRate}%`);
  });

  /* 判官校准：拿对照写法去问，它必须认得出真段落。
     认不出的判官，后面所有「认出率」都是噪声（0% 会被误读成"太像了"）。 */
  if (DO_JUDGE) {
    out.judgeCal = {};
    for (const [k, t] of Object.entries(CTRL)) {
      let w = 0, n = 0, skipped = 0;
      for (let i = 0; i < 2; i++) {
        const ref = picked[Math.floor(Math.random() * picked.length)].t;
        const a = i ? [t, ref] : [ref, t];
        const p1 = await judge(a), p2 = await judge([a[1], a[0]]);
        if (p1 === null || p2 === null) { skipped++; continue; }
        const i1 = p1 === 0 ? 0 : 1, i2 = p2 === 0 ? 1 : 0;
        n++;
        if (i1 === i2 && (i1 === 0 ? a[0] : a[1]) === ref) w++;
      }
      out.judgeCal[k] = +(w / n * 100).toFixed(0);
      console.log(`  判官对「${k}」的认出率 ${out.judgeCal[k]}%（应接近 100%）`);
    }
  }
  console.log(`\n题目 ${out.n} 个，配置 ${configs.length} 种\n`);

  for (const cf of configs) {
    const sys = A.systemPrompt([], 'simulate', Object.assign({ asOf: '' }, cf.opts));
    const texts = [];
    for (const q of TOPICS.slice(0, out.n)) {
      try { texts.push(await gen(sys, q)); }
      catch (e) { console.log('  生成失败：' + e.message); }
    }
    const ds = texts.map(dist);
    const ratio = mean(ds) / mean(realDist);

    let win = 0, total = 0, skipped = 0;
    if (DO_JUDGE) {
      for (let i = 0; i < texts.length; i++) {
        const ref = picked[Math.floor(Math.random() * picked.length)].t;
        /* 随机决定谁在 A，同一对换序再问一次 */
        const flip = Math.random() < 0.5;
        const a = flip ? [texts[i], ref] : [ref, texts[i]];
        const p1 = await judge(a);
        const p2 = await judge([a[1], a[0]]);
        if (p1 === null || p2 === null) { skipped++; continue; }
        const idxFirst = p1 === 0 ? 0 : 1;
        const idxSecond = p2 === 0 ? 1 : 0;   // 换序后，"第一段"对应原第二段
        total++;
        if (idxFirst === idxSecond) {
          const chosen = idxFirst === 0 ? a[0] : a[1];
          if (chosen === ref) win++;          // 判官选中真段落 = 它认出来了（我们要的是低分）
        }
      }
    }
    const sh = aggregate(texts);
    out.configs[cf.name] = {
      dist_mean: +mean(ds).toFixed(4),
      ratio: +ratio.toFixed(3),
      shape: sh,
      judge_identified_real: total ? +(win / total * 100).toFixed(1) : null,
      judge_n: total,
      judge_skipped: skipped,
      samples: texts.slice(0, 2),
    };
    console.log(`${cf.name.padEnd(11)} 比值 ${ratio.toFixed(2)}  句长 ${sh.sentMed} 字  每段 ${sh.sents} 句  口语标记 ${sh.oralRate}%` +
      (total ? `  盲判认出率 ${(win / total * 100).toFixed(0)}%（${win}/${total}）` : ''));
  }

  /* 基线口径：比值 1.0 = 无法区分；盲判 50% = 无法区分。两个都往 1.0 / 50% 走才对。 */
  const file = path.join(RES, 'style-' + Date.now().toString(36) + '.json');
  fs.writeFileSync(file, JSON.stringify(out, null, 1), 'utf8');
  console.log('\n写入 ' + path.relative(ROOT, file));
  console.log('读法：比值越接近 1.00 越像；盲判认出率越接近 50% 越像。');
})();
