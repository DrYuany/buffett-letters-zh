/* 「巴菲特午餐会」Agent 服务端
   启动：node agent.js   然后浏览器打开 http://127.0.0.1:8099/index.html#/talk
   没有第三方依赖，Node 18+ 即可。

   它做三件事：
     1. 静态托管 site/（顺便把 file:// 的数据加载限制一起解决）
     2. POST /api/chat —— SSE 流式回复，前端边打字边显示
     3. 真正的 agent 循环：模型自己决定调用什么工具、查几次，最多 MAX_ROUNDS 轮，
        直到它觉得证据够了才开口。不是"先检索、再问答"的固定流水线。

   密钥只出现在本机文件 _agent.key 里，绝不进 index.html。
*/
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const vm = require('vm');
const crypto = require('crypto');
const { URL } = require('url');

const ROOT = __dirname;
const SITE = path.join(ROOT, 'site');
const PORT = Number(process.env.PORT || 8099);
/* 部署环境一定会注入 PORT。本机双击 start.bat 时不设，于是只听 127.0.0.1。 */
const DEPLOY = !!process.env.PORT;
/* 密钥可以在两个地方：项目里的 _agent.key（本机），或者用户目录下的 ~/.buffett-agent.key。
   公网部署走前者：文件不进 git（.gitignore 拦着），但会随目录一起发布到线上，
   这样访客才能享受免费额度。 */
const KEY_FILES = [path.join(ROOT, '_agent.key'), path.join(os.homedir(), '.buffett-agent.key')];
const KEY_FILE = KEY_FILES[0];
const MEM_FILE = path.join(ROOT, 'agent-memory.json');
/* 免费额度：每位访客用站长的密钥免费问 10 次，用完再填自己的密钥。
   配额记在服务端 agent-quota.json 里（不进 git），清浏览器存储也刷不掉。
   另设一道全站每日上限：万一有人写脚本批量领额度，最多烧掉 FREE_DAY_MAX 问，
   之后当天只接受访客自带密钥。 */
const QUOTA_FILE = path.join(ROOT, 'agent-quota.json');
const FREE_PER_VISITOR = 10;
const FREE_DAY_MAX = 150;
const DEEPSEEK = 'https://api.deepseek.com/chat/completions';
const MAX_ROUNDS = 6;
const MAX_TOOLCALLS = 14;

/* ---------------- 语料 ---------------- */
function loadData() {
  const win = {};
  const ctx = { window: win, console };
  vm.createContext(ctx);
  for (const f of ['data-core.js', 'data-letters.js', 'data-content.js']) {
    vm.runInContext(fs.readFileSync(path.join(SITE, f), 'utf8'), ctx, { filename: f });
  }
  return { C: win.CORE, L: win.LETTERS, CT: win.CONTENT };
}
const { C, L, CT } = loadData();

/* 分身模式的历史决策案例库。没生成 site/data-cases.js 时，考据模式照常能用。 */
let SITUATION = null;
try { SITUATION = require('./situation'); }
catch (e) { console.log('  （未找到案例库，分身模式不可用；先跑 node extract_cases.js）'); }

/* 股东大会语料，两套并存，优先用新的：
     MEETING = 1994-2026 中文全文，2.5 万段 156 万字（服务端加载，不进页面）
     TALK    = 380 条英文字幕中译的精选（页面要用，体积小）
   新的那份能逐字引用，旧的那份只能转述 —— 返回的说明文字要跟着换。 */
let MEETING = null;
try {
  MEETING = require('./meeting');
  if (!MEETING.SEGS.length) MEETING = null;
} catch (e) { /* 没生成就退回 380 条 */ }
let TALK = null;
try { TALK = require('./talk'); }
catch (e) { console.log('  （未找到口语语料，先跑 node build_talk.js / node make_talk.js）'); }
if (!MEETING && !TALK) console.log('  （两种股东大会语料都没有，先跑 python build_meeting_zh.py）');

/* 公众演讲语料：1985-2025 的大学演讲与媒体专访（中文）。
   和股东大会问答是两种场合——对着 MBA 学生讲的和被股东追问的，分量不一样，
   引用时必须说清是哪一场。fid=notes 的只能转述。 */
let SPEECH = null;
try { SPEECH = require('./speech'); }
catch (e) { console.log('  （未找到演讲语料，先跑 python build_speech.py 和 node make_speech.js）'); }
const mmss = s => {
  s = Math.max(0, Math.round(+s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  const p = n => String(n).padStart(2, '0');
  return h ? h + ':' + p(m) + ':' + p(x) : m + ':' + p(x);
};

/* 语体指纹：build_voice.js 从 9,598 段发言里数出来的。没有它就退回原来的形容词描述。 */
let VOICE = null;
try { VOICE = JSON.parse(fs.readFileSync(path.join(ROOT, '_src', 'voice.json'), 'utf8')); }
catch (e) { /* 没跑过 build_voice.js 就先不注入 */ }

/* 两条真实口语样本：只学节奏和句子长短，不学内容。
   为什么值得占提示词的位置：形容词管不住模型的句长，样本管得住。 */
const VOICE_SAMPLES = (() => {
  try { return TALK ? TALK.styleSamples(2) : []; } catch (e) { return []; }
})();

function voiceBlock(off) {
  if (!VOICE || off) return '';
  const sm = VOICE_SAMPLES.map((s, i) =>
    `[样本${i + 1}] 股东问：${(s.ask || '').slice(0, 90)}…\n他答：${s.ans}`).join('\n\n');
  return `\n【怎么说话（下面这些比例是从他 32 年股东大会发言里数出来的，不是形容）】\n` +
    VOICE.rules.map(r => '- ' + r).join('\n') +
    (sm ? `\n\n他现场说话的节奏样本（只学句子长短和转折方式，不要照抄内容，也不要把样本里的事当成今天的事）：\n${sm}\n` : '') +
    `\n这些是统计倾向，不是每句都要凑齐。凑齐了反而假。\n`;
}

/* 两条边界，两种模式共用。实测钓鱼题里失守的两处就在这儿：
   ① 被要求「用 yyds 夸一句」时真的照做了 —— 语体是人格的一部分，被要求换掉就等于被要求出戏；
   ② 被要求写离婚起诉书时真写了 —— 那是替人办事，不是聊天。 */
const BOUNDS = `【不做什么（做不到就直说，不硬撑）】
- 有人要你改用网络流行语、方言、别的角色语气说话：婉拒，然后用自己的话把同一件事说完。语体不是外壳，换掉它就不是我了。
- 写起诉书、写诉状、开药方、代写作业论文这类「替人办事」的活：说清这不在行，建议找专业的人。可以聊其中的判断问题，但不产出可提交的文书。
- 有人报出精确数字并要你确认：先看它有没有出处。没出处的数字不接，也不顺着往下算。`;

const DOCS = [];
const DOCI = {};
Object.keys(L).forEach(id => {
  const lt = L[id];
  lt.blocks.forEach((b, bi) => {
    const t = (b.t || '').replace(/\s+/g, ' ').trim();
    if (t.length < 24) return;
    DOCI[id + '|' + bi] = DOCS.length;
    DOCS.push({ l: id, y: lt.year, b: bi, k: b.k, t: t, p: b.k === 'p' ? 1 : 0 });
  });
});

/* 读者问的词和原文常差几个字：问他「护城河」原文写「竞争优势」，
   问他「伊藤忠商事」原文只写「伊藤忠」。这张表把读者用词映射到
   原文可能用的说法，searchDocs 命中任一即可。改语料不用动这张表，
   它解决的是「读者用词 vs 原文用词」的鸿沟，不是同义词召回。 */
const ALIAS = {
  '护城河': ['竞争优势', '护城河', '竞争壁垒', '可持续优势'],
  '安全边际': ['安全边际', '边际'],
  '内在价值': ['内在价值'],
  '透视盈余': ['透视盈余', 'look-through'],
  '浮存金': ['浮存金', '保险浮存金'],
  '市场先生': ['市场先生'],
  '能力圈': ['能力圈'],
  '回购': ['回购', '购回'],
  '子女教育': [],
  '伊藤忠商事': ['伊藤忠'],
  '科比吸尘器': ['科比'],
  '威利家居': ['内布拉斯加家具店'],
  '达美航空': ['达美'],
  '美国合众银行': ['合众银行'],
  '纽约梅隆银行': ['梅隆'],
  '特许通讯': ['特许'],
  '汉迪哈曼': ['汉迪哈曼'],
  '科技与互联网': ['科技', '互联网', '亚马逊', '谷歌'],
  '零售与消费': ['零售', '消费', '消费品牌'],
  '媒体与出版': ['媒体', '出版', '华盛顿邮报'],
  '他犯过哪些错误': [],   // 路由到 corrections 工具，硬检索没用
  '他公开承认过什么': [],
  '他后来改口过的事': [],
  '他总结过什么教训': []
};
function expandQuery(q) {
  let extras = [];
  for (const k in ALIAS) {
    if (q.indexOf(k) >= 0 && ALIAS[k].length) extras = extras.concat(ALIAS[k]);
  }
  return extras;
}

const TSTOP = '的了吗呢吧啊呀么怎你您我他她它这那有是会就要能可以什么为如何请告诉一下说说讲讲看想觉得把被让给对从到和与跟更最很太都也还又再就才只请您多少几个';
function terms(q) {
  const out = [], seen = {};
  const add = (g, w) => { if (!g || seen[g]) return; seen[g] = 1; out.push({ g, w }); };
  String(q).replace(/[^\u4e00-\u9fa5A-Za-z0-9]+/g, ' ').split(/\s+/).forEach(run => {
    if (!run) return;
    if (/^[A-Za-z0-9]+$/.test(run)) { add(run.toLowerCase(), 2); return; }
    const n = run.length;
    if (n >= 2 && n <= 8) add(run, 3);
    for (let i = 0; i + 2 <= n; i++) {
      const bg = run.slice(i, i + 2);
      if (TSTOP.indexOf(bg[0]) < 0 && TSTOP.indexOf(bg[1]) < 0) add(bg, 1.2);
    }
    for (let j = 0; j + 3 <= n; j++) {
      const tg = run.slice(j, j + 3);
      if (TSTOP.indexOf(tg[0]) < 0 && TSTOP.indexOf(tg[2]) < 0) add(tg, 2);
    }
  });
  return out;
}
const _dfCache = {};
function countCache(g) {
  if (_dfCache[g] != null) return _dfCache[g];
  let df = 0;
  for (let i = 0; i < DOCS.length; i++) if (DOCS[i].t.indexOf(g) !== -1) df++;
  _dfCache[g] = df;
  return df;
}
function searchDocs(q, opts) {
  opts = opts || {};
  const ts = terms(q);
  if (!ts.length) return [];
  /* 别名扩展：把读者用词对应的原文用词一并加入打分。
     只增不替，免得原文用的就是「护城河」时反而被改写。 */
  const extras = expandQuery(q);
  const extraTerms = [];
  for (const e of extras) {
    const et = terms(e);
    et.forEach(t => { if (!ts.some(x => x.g === t.g)) extraTerms.push(t); });
  }
  const allTerms = ts.concat(extraTerms);
  const N = DOCS.length, y0 = +opts.y0 || 0, y1 = +opts.y1 || 9999;
  const scored = [];
  for (let i = 0; i < N; i++) {
    const d = DOCS[i];
    if (d.y < y0 || d.y > y1) continue;
    const t = d.t;
    let s = 0;
    for (const tm of allTerms) {
      if (t.indexOf(tm.g) < 0) continue;
      let p = t.indexOf(tm.g), c = 0;
      while (p >= 0 && c < 4) { c++; p = t.indexOf(tm.g, p + tm.g.length); }
      const idf = Math.log(1 + N / (countCache(tm.g) + 1));
      s += idf * tm.w * (1 + Math.log(c));
    }
    if (s <= 0) continue;
    s = s / (1 + Math.log(1 + t.length / 140));
    if (/^[（(]\s*\d+\s*[)）]/.test(t) || !/[。！？…"」』]$/.test(t)) s *= 0.82;
    s += d.p * 0.35;
    scored.push({ i, s });
  }
  scored.sort((a, b) => b.s - a.s);
  const picks = [], per = {};
  for (const sc of scored) {
    const d = DOCS[sc.i];
    if ((per[d.l] || 0) >= 2) continue;
    per[d.l] = (per[d.l] || 0) + 1;
    picks.push(d);
    if (picks.length >= (opts.k || 6)) break;
  }
  return picks;
}
function snippet(t, qs, len) {
  len = len || 420;
  let p = -1;
  for (const raw of qs) { p = t.indexOf(raw); if (p >= 0) break; }
  if (p < 0) p = 0;
  const start = Math.max(0, p - 120);
  const end = Math.min(t.length, start + len);
  return (start > 0 ? '…' : '') + t.slice(start, end) + (end < t.length ? '…' : '');
}

/* 每封信里反复出现的实体，给 letter_outline 用 */
const LT_MENTIONS = (function () {
  const map = {};
  for (const nm in C.mentions) {
    for (const m of C.mentions[nm]) {
      (map[m[2]] = map[m[2]] || []).push(nm);
    }
  }
  for (const id in map) {
    const cnt = {};
    map[id].forEach(n => { cnt[n] = (cnt[n] || 0) + 1; });
    map[id] = Object.keys(cnt).map(n => ({ n, c: cnt[n] }));
  }
  return map;
})();

/* 时间戳用本机时间：toISOString() 给的是 UTC，
   东八区会在每天 0-8 点记成前一天的日期，翻记忆的时候看着很怪。 */
function nowStamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

/* ---------------- 长期记忆 ---------------- */
/* EVAL_NO_MEMORY=1 时返回空：评测跑批中每条问答不该读到上一条 remember 写的笔记，
   否则 real-021 让它记住"海上风电检修排程"后，real-020 的答案会莫名其妙提检修排程。 */
async function readMemory() {
  if (process.env.EVAL_NO_MEMORY === '1') return { notes: [] };
  try { return JSON.parse(await fsp.readFile(MEM_FILE, 'utf8')) || { notes: [] }; }
  catch (e) { return { notes: [] }; }
}

/* ---------------- 免费额度 ----------------
   文件长这样：{ visitors: { vid: { used, ip, first, last } }, days: { '2026-10-30': 57 } }
   全部落盘 —— 重启服务不清零，访客清浏览器缓存也没用（额度跟着 vid 走，vid 丢了
   顶多算新访客再领 10 次，但全站每日上限兜底）。 */
let _quotaSave = Promise.resolve();
async function readQuota() {
  try { return JSON.parse(await fsp.readFile(QUOTA_FILE, 'utf8')) || { visitors: {}, days: {} }; }
  catch (e) { return { visitors: {}, days: {} }; }
}
function saveQuota(q) {
  /* 串行写入：两个问题同时在跑时不能互相把对方的计数覆盖掉 */
  _quotaSave = _quotaSave.then(() => fsp.writeFile(QUOTA_FILE, JSON.stringify(q), 'utf8')).catch(() => {});
  return _quotaSave;
}
/* 访客还能免费问几问。vid 是前端生成、存在浏览器里的随机串；
   没带来的就按 IP 算。今天全站免费额度烧穿 FREE_DAY_MAX 时，对所有人都按 0 算。 */
async function freeLeft(vid) {
  const q = await readQuota();
  const today = nowStamp().slice(0, 10);
  if ((q.days[today] || 0) >= FREE_DAY_MAX) return 0;
  const v = q.visitors[vid];
  return Math.max(0, FREE_PER_VISITOR - ((v && v.used) || 0));
}
async function consumeFree(vid, ip) {
  const q = await readQuota();
  const today = nowStamp().slice(0, 10);
  const v = q.visitors[vid] || (q.visitors[vid] = { used: 0, ip: '', first: '', last: '' });
  v.used++; v.ip = ip; v.last = nowStamp();
  if (!v.first) v.first = v.last;
  q.days[today] = (q.days[today] || 0) + 1;
  /* 名册只留最近 5000 个访客，防止文件无限膨胀 */
  const ids = Object.keys(q.visitors);
  if (ids.length > 5000) {
    ids.sort((a, b) => String(q.visitors[a].last).localeCompare(String(q.visitors[b].last)));
    for (let i = 0; i < ids.length - 5000; i++) delete q.visitors[ids[i]];
  }
  for (const d in q.days) if (d < today) delete q.days[d];
  await saveQuota(q);
  return Math.max(0, FREE_PER_VISITOR - v.used);
}
/* 问失败不扣额度：钱是站长的，但账要讲理 */
async function refundFree(vid) {
  const q = await readQuota();
  const v = q.visitors[vid];
  if (!v || v.used <= 0) return;
  v.used--;
  const today = nowStamp().slice(0, 10);
  if (q.days[today]) q.days[today] = Math.max(0, q.days[today] - 1);
  await saveQuota(q);
}

/* ---------------- 工具 ---------------- */
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_letters',
      description: '在巴菲特 1956-2025 年全部信件原文里检索段落。想知道"他怎么说某个话题"就用这个。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '检索词，用他本人可能使用的说法（中文短语最好）' },
          year_from: { type: 'integer', description: '可选，限定起始年份' },
          year_to: { type: 'integer', description: '可选，限定结束年份' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'open_passage',
      description: '打开某一封信的某一段，看完整上下文（前后各一段）。检索摘要不够长时用这个。',
      parameters: {
        type: 'object',
        properties: {
          letter_id: { type: 'string', description: '信件 id，如 1988 巴菲特致股东信' },
          block: { type: 'integer', description: '段落序号' }
        },
        required: ['letter_id', 'block']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'letter_outline',
      description: '看某一年的信讲了些什么：全部小标题，以及这一年反复提到的实体。',
      parameters: { type: 'object', properties: { year: { type: 'integer', description: '年份，如 1987' } }, required: ['year'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'concept_profile',
      description: '查某个投资概念的人工档案：跨年代的认识分期与总结，以及它在原文中的出现次数与年份跨度。',
      parameters: { type: 'object', properties: { name: { type: 'string', description: '概念名，如 内在价值、安全边际、回购' } }, required: ['name'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'company_timeline',
      description: '查某家公司的人工档案：跨年轨迹记录（他每年怎么提它）。',
      parameters: { type: 'object', properties: { name: { type: 'string', description: '公司名，如 可口可乐、盖可保险' } }, required: ['name'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'corrections',
      description: '查他公开承认过的错误与教训档案。问「他犯过什么错」「最糟糕的决定」时用这个，比原文检索准。',
      parameters: { type: 'object', properties: { topic: { type: 'string', description: '可选关键词，如 纺织、德克斯特、并购' } }, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: '联网搜索。只用于信件之外的事实：2025 年以后的事、公司现状、股价、新闻、他人评论。涉及"他在信里说过什么"不要用这个。',
      parameters: { type: 'object', properties: { query: { type: 'string', description: '搜索词' } }, required: ['query'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'open_url',
      description: '打开一个网页看正文（自动去掉导航和广告），用来核实搜索到的内容。',
      parameters: { type: 'object', properties: { url: { type: 'string', description: '完整 http/https 地址' } }, required: ['url'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'match_situation',
      description: '把今天发生的一件事对到历史上结构相近的旧判断（记分卡 / 原则 / 认错）。分身模式第一件事就查这个。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '今天这件事的事实描述，只写事实，不要写你的结论' },
          k: { type: 'integer', description: '可选，要几条，默认 5' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'case_detail',
      description: '打开某一条历史案例，看完整的当时情形、他当时的判断、后来结果与教训。',
      parameters: {
        type: 'object',
        properties: { case_id: { type: 'string', description: '案例 id，如 sc-美国运通、rule-148' } },
        required: ['case_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'stance_timeline',
      description: '查他在某个主题上的立场演变：分几期、哪一年改的主意、改之前和改之后分别怎么说。问「他一直怎么看X」「他什么时候改的口」时用这个，比只按年份查原文更准。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '主题，如 科技与互联网 / 买入价格 / 保险浮空金 / 公司治理' },
          year: { type: 'integer', description: '可选，想看他这一年的立场' }
        },
        required: ['name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'talk_search',
      description: '在 1994-2026 股东大会问答里找他当面说过的话（中文全文，2.5 万段，可逐字引用）。问「他当时怎么回答股东」「他现场是怎么说的」「他在哪一年的会上说过」时用这个。这是他回答股东提问的场合，和写进给股东的信分量不同。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '要查的话题或说法' },
          k: { type: 'integer', description: '可选，默认 4 条' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'speech_search',
      description: '在 1985-2025 的大学演讲和媒体专访里找他说过的话（佛罗里达大学、斯坦福、圣母大学、北大、CNBC 专访等 21 个场合）。问「他对学生怎么说」「他在演讲里怎么讲这件事」「他接受采访时怎么说」时用这个。逐字稿可以引用，笔记转述的只能转述。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '要查的话题或说法' },
          k: { type: 'integer', description: '可选，默认 4 条' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'remember',
      description: '把关于这位读者的重要信息长期记下来（背景、关注的公司、读信的目的、约定过的偏好），下回对话还记得。',
      parameters: { type: 'object', properties: { note: { type: 'string', description: '要记住的一句话，写清楚主语' } }, required: ['note'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'count_mentions',
      description: '精确统计某个词或短语在全部信件原文里的出现次数与跨年分布。问「他提到X多少次」「X这个词出现过几十次吗」时必用这个，不要凭印象估数字。问次数之外的话题不要用它。',
      parameters: {
        type: 'object',
        properties: {
          term: { type: 'string', description: '要统计的词或短语，写他本人可能使用的中文说法' }
        },
        required: ['term']
      }
    }
  }
];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';

const CJK = /[\u4e00-\u9fa5]/;

/* Bing 在两种语言下要用两套参数：
   中文查询带 cc=CN 才给中文结果；英文查询必须换成国际版参数，
   否则同一个 IP 上拿回来的是「Windows 安全中心」「某招聘站」这种推荐页混杂物。 */
async function bingSearch(q) {
  const en = !CJK.test(q);
  const url = 'https://www.bing.com/search?q=' + encodeURIComponent(q) +
    (en ? '&setmkt=en-US&setlang=en&FORM=QBLH' : '&setlang=zh-CN&cc=CN');
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': en ? 'en-US,en;q=0.9' : 'zh-CN,zh;q=0.9' } });
  if (!r.ok) throw new Error('搜索服务返回 ' + r.status);
  const html = await r.text();
  const strip = s => String(s || '').replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n))
    .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
  const out = [], seenDomain = {};
  for (const b of html.split(/<li class="b_algo"/).slice(1, 10)) {
    const h = b.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!h) continue;
    const link = realUrl(h[1]);
    if (!/^https?:/.test(link)) continue;
    let host = '';
    try { host = new URL(link).hostname.replace(/^www\./, ''); } catch (e) { continue; }
    if (seenDomain[host]) continue;          // 同一个站点连着给三条没有意义
    seenDomain[host] = 1;
    const p = b.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    const title = strip(h[2]);
    const snip = strip(p && p[1]).slice(0, 220);
    /* 相关性：标题/域名/摘要里有没有出现查询里的实词（英文按词，中文按两字以上片段） */
    const hay = (title + ' ' + host + ' ' + snip).toLowerCase();
    const rel = relevance(q, hay);
    out.push({ title, url: link, snippet: snip, rel: rel });
    if (out.length >= 6) break;
  }
  if (!out.length) return { results: [], warn: 'Bing 这次没有返回结果，换个说法再试。' };
  const best = Math.max.apply(null, out.map(x => x.rel));
  return {
    results: out,
    warn: best === 0 ? '注意：以下结果与关键词没有任何字面对应，很可能是搜索引擎给的推荐位而不是真搜索结果。若读不出有用的东西，请换成中文关键词再搜一次，不要勉强引用。' : ''
  };
}

/* bing 的跳转链接形如 https://www.bing.com/ck/a?!&&p=..&u=a1aHR0cHM6...，
   u= 后面去掉开头的 a1 就是目标地址的 base64。 */
function realUrl(href) {
  if (/^https?:/i.test(href)) return href;
  if (href.indexOf('/ck/a') >= 0) {
    const m = href.match(/[?&]u=a1([^&]+)/);
    if (m) {
      try {
        let b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
        while (b64.length % 4) b64 += '=';
        const u = Buffer.from(b64, 'base64').toString('utf8');
        if (/^https?:/i.test(u)) return u;
      } catch (e) {}
    }
  }
  return href;
}

function relevance(q, hay) {
  let hit = 0, total = 0;
  String(q).toLowerCase().split(/[\s"']+/).forEach(tok => {
    if (tok.length < 3) return;
    total++;
    if (hay.indexOf(tok) >= 0) hit++;
  });
  if (!total) {
    /* 中文查询碎片化以后没有可用的词，改用查询里连着的汉字片段做包含判断 */
    const groups = String(q).match(/[\u4e00-\u9fa5]{2,}/g) || [];
    groups.forEach(g => { total++; if (hay.indexOf(g) >= 0) hit++; });
  }
  return total ? hit / total : 0;
}

function hostBlocked(host) {
  return /^(127\.|localhost|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1)/i.test(host);
}

async function toolCall(name, args, asOf) {
  /* 时间闸门：回测时 asOf=1998，1998 年以后的材料一律不给他看。
     这是回测能不能算数的前提 —— 让他"看见"2016 年买苹果，再问他 1998 年怎么判断，
     测出来的是作弊能力，不是判断力。 */
  const YMAX = asOf ? +String(asOf).slice(0, 4) : 9999;
  const TIME_UP = (y) => `这条材料是 ${y} 年的，超出了你现在能知道的范围（今天是 ${asOf}）。`;
  switch (name) {
    case 'search_letters': {
      const picks = searchDocs(args.query, { y0: +args.year_from || 0, y1: Math.min(+args.year_to || 9999, YMAX), k: 6 });
      if (!picks.length) return { text: '没在语料里找到和「' + args.query + '」相关的段落。换个说法试试，或者查概念档案。' };
      return {
        text: picks.map((d, i) => `[${i + 1}] ${d.y} 年 · 第 ${d.b} 段\n原文：${snippet(d.t, [args.query])}\n引用标记：[[${d.l}|${d.b}]]`).join('\n\n'),
        sources: picks.map(d => ({ kind: 'letter', l: d.l, b: d.b, y: d.y }))
      };
    }
    case 'open_passage': {
      const l = String(args.letter_id || '');
      const bi = +args.block;
      const lt = L[l];
      if (!lt || !lt.blocks[bi]) return { text: '没有找到这一段，检查 letter_id 和 block 是否正确。' };
      if (lt.year > YMAX) return { text: TIME_UP(lt.year) };
      const b0 = lt.blocks[bi];
      /* 小标题段本身没有内容。以前的实现只把「去年的业绩」这 5 个字返给模型，
         模型就凭记忆把下一段的正文补了出来 —— 2024 年信第 30 段是真实案例，
         判分器据此判了「编造」，其实原文第 31 段一字不差。这里改成：
         明确说「这是小标题」，并把这一节的正文一起带出来，引用标记直接给正文段号。 */
      if (b0.k === 'h' || b0.k === 'h2') {
        const body = []; let first = -1;
        for (let i = bi + 1; i < lt.blocks.length && body.length < 3; i++) {
          const b2 = lt.blocks[i];
          if (b2.k === 'h' || b2.k === 'h2') break;
          const t = (b2.t || '').trim();
          if (t.length < 8) continue;
          if (first < 0) first = i;
          body.push(`第 ${i} 段：${t.slice(0, 700)}`);
        }
        if (!body.length) return {
          text: `第 ${bi} 段是小标题「${(b0.t || '').trim()}」，这一节下面没有正文。不要引用这一段，也不要凭印象补内容。`,
          sources: []
        };
        return {
          text: `${lt.title || l}（${lt.year} 年）\n第 ${bi} 段是小标题「${(b0.t || '').trim()}」，不是正文。这一节的正文：\n\n` +
            body.join('\n\n') + `\n\n引用请引正文段：[[${l}|${first}]]`,
          sources: [{ kind: 'letter', l: l, b: first, y: lt.year }]
        };
      }
      const around = [];
      for (let i = Math.max(0, bi - 1); i <= Math.min(lt.blocks.length - 1, bi + 1); i++) {
        around.push(`第 ${i} 段：${(lt.blocks[i].t || '').slice(0, 700)}`);
      }
      return {
        text: `${lt.title || l}（${lt.year} 年）\n` + around.join('\n\n') + `\n\n引用标记：[[${l}|${bi}]]`,
        sources: [{ kind: 'letter', l: l, b: bi, y: lt.year }]
      };
    }
    case 'letter_outline': {
      const yr = +args.year;
      const lt = C.letters.find(x => x.year === yr);
      if (!lt) return { text: `语料里没有 ${yr} 年的信件（可用年份：${C.meta.years[0]}-${C.meta.years[1]}）。` };
      if (yr > YMAX) return { text: TIME_UP(yr) };
      const heads = [];
      (L[lt.id] || { blocks: [] }).blocks.forEach((b, i) => { if (b.k === 'h' || b.k === 'h2') heads.push(`第 ${i} 段 ${b.t}`); });
      const top = (LT_MENTIONS[lt.id] || []).sort((a, b) => b.c - a.c).slice(0, 12).map(x => x.n);
      return {
        text: `${lt.title}（${lt.year} 年，共 ${lt.n} 段）\n小标题（这些段号只是小标题、本身没有正文；要用 open_passage 打开才会给出这一节的正文）：\n${heads.slice(0, 40).join('\n') || '（这封信没有小标题）'}\n\n这一年反复提到：${top.join('、')}\n引用标记：[[${lt.id}|0]]`,
        sources: [{ kind: 'letter', l: lt.id, b: 0, y: lt.year }]
      };
    }
    case 'concept_profile': {
      if (YMAX < 9999) return { text: '这份档案把几十年的观点揉在一起，回测模式下不开放（会泄漏后面的年份）。请用 stance_timeline 并指定 year，或 search_letters 限定年份。' };
      const nm = String(args.name || '').trim();
      const spec = CT.concepts[nm];
      if (!spec) return { text: `没有「${nm}」的概念档案。可用概念：${Object.keys(CT.concepts).slice(0, 40).join('、')}` };
      const ms = C.mentions[nm] || [];
      const years = ms.map(m => m[0]);
      const head = `「${nm}」在语料里出现 ${ms.length + (C.overflow[nm] || 0)} 次` + (years.length ? `，跨 ${Math.min.apply(null, years)}-${Math.max.apply(null, years)} 年。` : '。');
      const periods = (spec.periods || []).map(p => `${p.y0}-${p.y1}（${p.name}）：${String(p.text).slice(0, 320)}`).join('\n\n');
      return { text: head + '\n\n人工档案把它分成 ' + (spec.periods || []).length + ' 段：\n\n' + periods, sources: [] };
    }
    case 'company_timeline': {
      if (YMAX < 9999) return { text: '公司轨迹含后期记录，回测模式下不开放。请用 search_letters 限定年份。' };
      const nm = String(args.name || '').trim();
      const spec = CT.companies[nm];
      if (!spec) return { text: `没有「${nm}」的公司档案。可用公司：${Object.keys(CT.companies).slice(0, 40).join('、')}` };
      const tl = spec.timeline || [];
      const lines = tl.slice(0, 14).map(t => `${t.y} 年：${String(t.note).slice(0, 170)}  引用标记：[[${t.loc.l}|${t.loc.b}]]`);
      const picks = tl.filter(t => t.loc).slice(0, 14).map(t => ({ kind: 'letter', l: t.loc.l, b: t.loc.b, y: +t.y }));
      return { text: `「${nm}」档案里有 ${tl.length} 条跨年记录：\n` + lines.join('\n') + (tl.length > 14 ? `\n（还有 ${tl.length - 14} 条）` : ''), sources: picks };
    }
    case 'corrections': {
      const kw = String(args.topic || '').trim();
      let list = CT.corrections || [];
      if (kw) list = list.filter(c => (c.t + (c.ent || '')).indexOf(kw) >= 0);
      list = list.filter(c => c.y <= YMAX);
      const weight = c => {
        let s = 0;
        if (/最(大|糟|严重|惨)/.test(c.t)) s += 3;
        if (/德克斯特|纺织|通用再保险/.test(c.t)) s += 2;
        if (c.k === 'error') s += 1;
        return s * 10 + Math.max(0, c.y - 1980) / 10;
      };
      list = list.slice().sort((a, b) => weight(b) - weight(a) || b.y - a.y).slice(0, 6);
      if (!list.length) return { text: '这个话题在认错档案里没找到对应条目。' };
      return {
        text: list.map(c => `${c.y} 年（${c.k}）：${c.t}\n引用标记：[[${c.loc.l}|${c.loc.b}]]`).join('\n\n'),
        sources: list.filter(c => c.loc).map(c => ({ kind: 'letter', l: c.loc.l, b: c.loc.b, y: c.y }))
      };
    }
    case 'web_search': {
      if (YMAX < 9999) return { text: '回测模式下不能联网：一联网就会看到今天以后的事。' };
      const sres = await bingSearch(String(args.query || ''));
      const res = sres.results;
      if (!res.length) return { text: sres.warn || '这次搜索没搜到结果，换个说法再试。' };
      const body = res.map((r, i) => `[网页${i + 1}] ${r.title}\n${r.url}\n${r.snippet}\n引用标记：[[web|${r.url}]]`).join('\n\n');
      return {
        text: (sres.warn ? sres.warn + '\n\n' : '') + body,
        sources: res.map(r => ({ kind: 'web', title: r.title, url: r.url }))
      };
    }
    case 'open_url': {
      const u = String(args.url || '');
      let h;
      try { h = new URL(u); } catch (e) { return { text: '这个网址不合法：' + u }; }
      if (!/^https?:$/.test(h.protocol)) return { text: '只支持 http/https 地址。' };
      if (hostBlocked(h.hostname)) return { text: '出于安全考虑，不读取本机或内网地址。' };
      const r = await fetch(u, { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' }, redirect: 'follow' });
      if (!r.ok) return { text: '打开失败，页面返回 ' + r.status };
      const buf = Buffer.from(await r.arrayBuffer());
      /* 中文站点不少还在用 GBK，按 utf-8 解出来会一片乱码，先看页面自己声明的编码 */
      const head = buf.slice(0, 1200).toString('latin1');
      const cm = head.match(/charset=["']?\s*([\w-]+)/i);
      let charset = (cm && cm[1] || '').toLowerCase();
      if (charset === 'gb2312' || charset === 'gbk' || charset === 'gb18030') charset = 'gbk';
      let html;
      try { html = new TextDecoder(charset || 'utf-8').decode(buf); }
      catch (e) { html = buf.toString('utf8'); }
      html = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
      let txt = html.replace(/<[^>]+>/g, '\n')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n));
      txt = txt.replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
      const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || ['', ''])[1].trim();
      return { text: `标题：${title}\n\n正文前 4000 字：\n${txt.slice(0, 4000)}`, sources: [{ kind: 'web', title: h.hostname, url: u }] };
    }
    case 'stance_timeline': {
      const want = String(args.name || '').trim();
      if (!want) return { text: '要给一个主题。' };
      const names = Object.keys(CT.concepts);
      /* 先精确、再包含、最后退到键名互相包含 —— 他嘴里的词和档案标题常常差一个字 */
      let key = names.find(n => n === want)
        || names.find(n => n.indexOf(want) >= 0 || want.indexOf(n) >= 0);
      if (!key) key = names.find(n => {
        const cs = want.split('');
        return cs.filter(c => n.indexOf(c) >= 0).length >= Math.min(3, cs.length);
      });
      if (!key) return { text: '概念档案里没有「' + want + '」。可查的主题有：' + names.slice(0, 24).join('、') + ' 等。' };
      const cf = CT.concepts[key];
      const ps = (cf.periods || []).slice().filter(p => p.y0 <= YMAX).sort((a, b) => a.y0 - b.y0);
      if (!ps.length) return { text: '「' + key + '」没有分期档案，可以改用 search_letters。' };
      const yr = +args.year || 0;
      /* 分期都是单年（y0==y1），所以不能用「落在哪一期」去找 —— 2013 年会一期都找不到。
         正确的是「他那时站在最近一次形成的那一期」：取年份不晚于给定年的最后一期。 */
      const upto = yr ? ps.filter(p => p.y0 <= yr) : [];
      const now = upto.length ? upto[upto.length - 1] : null;
      const lines = ps.map((p, i) => {
        const span = p.y0 === p.y1 ? String(p.y0) : p.y0 + '–' + p.y1;
        const mark = now && now === p ? '  ← 这一年' : '';
        return `${i + 1}. ${span}｜${p.name}${mark}\n   ${p.text}`;
      });
      /* 转折点 = 相邻两期文字差异最大的地方，直接用分期边界，不另算相似度 */
      const turns = [];
      for (let i = 1; i < ps.length; i++) turns.push(ps[i - 1].y1 + '→' + ps[i].y0);
      const quotes = (cf.quotes || []).filter(q => q.loc && (+q.loc.y || 9999) <= YMAX).slice(0, 6)
        .map(q => `· [[${q.loc.l}|${q.loc.b}]] ${String(q.t || '').slice(0, 160)}`);
      /* 同期他承认过的错：主题词或实体名撞上就算 */
      const corr = (CT.corrections || []).filter(c => c.y <= YMAX).filter(c =>
        (c.ent && (key.indexOf(c.ent) >= 0 || want.indexOf(c.ent) >= 0)) ||
        (c.t && want.length >= 2 && c.t.indexOf(want.slice(0, 2)) >= 0)
      ).slice(0, 4).map(c => {
        const loc = c.loc ? ` [[${c.loc.l}|${c.loc.b}]]` : '';
        return `· ${c.y}：${String(c.t).slice(0, 150)}${loc}`;
      });
      const text = `【${key}】分期立场\n` + lines.join('\n') +
        `\n\n改主意的节点：${turns.join('、') || '（不分期）'}` +
        (yr ? (now
          ? `\n${yr} 年他站在第 ${ps.indexOf(now) + 1} 期（共 ${ps.length} 期）。`
          : `\n${yr} 年他还没进入第 1 期（${ps[0].name || ''}：${String(ps[0].text || '').slice(0, 40)}），那是之后才发生的。`) : '') +
        (quotes.length ? `\n\n他在信里的原话（可逐字引用）：\n${quotes.join('\n')}` : '') +
        (corr.length ? `\n\n同期他承认过的错：\n${corr.join('\n')}` : '') +
        `\n\n注意：分期文字是档案整理，不是原话；只有标了 [[信|段]] 的句子能逐字引用。`;
      const sources = (cf.quotes || []).filter(q => q.loc).slice(0, 6)
        .map(q => ({ kind: 'letter', l: q.loc.l, b: q.loc.b, y: q.loc.y }));
      return { text, sources };
    }
    case 'talk_search': {
      const M = MEETING || TALK;
      if (!M) return { text: '股东大会语料没生成。先跑 python fetch_meeting_zh.py 和 python build_meeting_zh.py。' };
      const hits = M.search(String(args.query || ''), { k: 12 })
        .filter(x => x.y <= YMAX).slice(0, Math.min(6, Math.max(1, +args.k || 4)));
      if (!hits.length) return { text: '股东大会问答里没找到相关段落。' };
      const sess = s => s === 'Morning_Session' ? '上午场' : s === 'Afternoon_Session' ? '下午场' : '';
      const body = hits.map((x, i) =>
        `[${i + 1}] ${x.y} 年股东大会` +
        (x.session ? '（' + sess(x.session) + '）' : x.at ? '（' + mmss(x.at) + '）' : '') +
        (x.title ? ' · ' + x.title : '') + '\n' +
        (x.ask ? `股东问：${x.ask}\n` : '') +
        `他答：${x.ans}`
      ).join('\n\n');
      return {
        text: `【股东大会现场原话${MEETING ? ' · 中英对照全文的中文侧，可逐字引用' : ' · 英文字幕转译，只能转述'}】\n${body}\n\n` +
          `（以上是股东大会问答，不是致股东信。信是他斟酌过的书面判断，会上是当场答问——` +
          `同一个问题，两处的说法可能不一样，这本身就是信息。）`,
        sources: [],
      };
    }
    case 'speech_search': {
      if (!SPEECH) return { text: '演讲语料没生成。先跑 python build_speech.py 和 node make_speech.js。' };
      const hits = SPEECH.search(String(args.query || ''), { k: 12, year: YMAX })
        .slice(0, Math.min(6, Math.max(1, +args.k || 4)));
      if (!hits.length) return { text: '这些演讲和访谈里没找到相关段落。' };
      const body = hits.map((x, i) =>
        `[${i + 1}] ${x.y} 年${x.venue}${x.fid === 'notes' ? '（笔记转述）' : ''}\n` +
        (x.ask ? `别人问：${x.ask}\n` : '') +
        `他讲：${x.ans}`
      ).join('\n\n');
      const nNote = hits.filter(x => x.fid === 'notes').length;
      return {
        text: `【公开演讲与访谈原话 · ${nNote ? `其中 ${nNote} 条是笔记转述，不可逐字引用` : '均为逐字稿，可引用'}】\n${body}\n\n` +
          `（以上来自 1985-2025 年的大学演讲和媒体专访，不是致股东信。引用时要把场合说清楚——` +
          `对着学生讲的和写进给股东的信，分量不同。）`,
        sources: [],
      };
    }
    case 'match_situation': {
      if (!SITUATION) return { text: '案例库没生成。先在项目根目录跑一次 node extract_cases.js。' };
      const r0 = SITUATION.match(String(args.query || ''), { k: Math.min(8, Math.max(1, +args.k || 5)) });
      const r = { top: r0.top.filter(x => x.y <= YMAX), polarity: r0.polarity, slots: r0.slots };
      if (!r.top.length) return { text: '在你现在能知道的年份范围内，没匹配到结构相近的历史判断。换个说法再试，或改用 search_letters 查原则。' };
      const head = '情形方向：' + (r.polarity === 1 ? '市场偏热' : r.polarity === -1 ? '市场偏冷' : '中性') +
        '；抽到的情形格子：' + (r.slots.join('、') || '无') + '\n';
      const body = r.top.map((x, i) =>
        `[${i + 1}] 案例 ${x.id}（${x.y} 年 · ${x.kind} · 匹配分 ${x.score}）` +
        (x.opposite ? ' ⚠ 反向对照，只可对比、不可当本次依据' : '') + '\n' +
        `当时情形：${x.situation}\n` +
        `他当时的判断：${x.judgment}` + (x.verbatim ? '（逐字可引）' : '（概述，不可逐字引用）') + '\n' +
        (x.loc ? `引用标记：[[${x.loc.l}|${x.loc.b}]]\n` : '') +
        (x.outcome ? `后来：${x.outcome}\n` : '') +
        `情形格子：${(x.slots_hit || []).join('、') || '无'}`
      ).join('\n\n');
      const sources = r.top.filter(x => x.loc).map(x => ({ kind: 'letter', l: x.loc.l, b: x.loc.b, y: x.loc.y }));
      return { text: head + '\n' + body, sources: sources };
    }
    case 'case_detail': {
      if (!SITUATION) return { text: '案例库没生成。' };
      const c = SITUATION.CASES.find(x => x.id === String(args.case_id || ''));
      if (c && c.y > YMAX) return { text: TIME_UP(c.y) };
      if (!c) return { text: '没有这个案例 id：' + args.case_id + '。请用 match_situation 返回的编号。' };
      const loc = (c.quote_locs || [])[0];
      return {
        text: `案例 ${c.id}（${c.y} 年 · ${c.kind} · ${c.verdict || ''}）\n` +
          `当时情形：${c.situation}\n` +
          `他当时的判断：${c.judgment}` + (c.judgment_verbatim ? '（逐字可引）' : '（概述，不可逐字引用）') + '\n' +
          (c.outcome ? `后来：${c.outcome}\n` : '') +
          (c.lesson ? `教训：${c.lesson}\n` : '') +
          `情形格子：${(c.slots || []).join('、') || '无'}\n` +
          (loc ? `引用标记：[[${loc.l}|${loc.b}]]` : '无原信出处'),
        sources: loc ? [{ kind: 'letter', l: loc.l, b: loc.b, y: loc.y }] : []
      };
    }
    case 'remember': {
      const note = String(args.note || '').trim();
      if (!note) return { text: '没有内容可记。' };
      if (process.env.EVAL_NO_MEMORY === '1') return { text: '记下了（评测模式不实际写入）：' + note };
      const m = await readMemory();
      m.notes = (m.notes || []).filter(n => n.text !== note);
      m.notes.push({ t: nowStamp(), text: note });
      while (m.notes.length > 60) m.notes.shift();
      await fsp.writeFile(MEM_FILE, JSON.stringify(m, null, 1), 'utf8');
      return { text: '记下了：' + note };
    }
    case 'count_mentions': {
      /* 计数类断言必须由工具返回，模型不许估。问数就在这里数给他看。
         同时把别名一起算进去——问他「护城河」多少次，原文实际写「竞争优势」。 */
      const term = String(args.term || '').trim();
      if (!term) return { text: '没给要统计的词。' };
      const variants = [term].concat(ALIAS[term] || []);
      const byYear = {};
      let total = 0, letters = {};
      for (const v of variants) {
        for (let i = 0; i < DOCS.length; i++) {
          const d = DOCS[i];
          if (d.y > YMAX) continue;
          let p = d.t.indexOf(v), c = 0;
          while (p >= 0 && c < 200) { c++; p = d.t.indexOf(v, p + v.length); }
          if (c > 0) {
            byYear[d.y] = (byYear[d.y] || 0) + c;
            letters[d.l] = (letters[d.l] || 0) + c;
            total += c;
          }
        }
      }
      const years = Object.keys(byYear).sort();
      const yr0 = years.length ? +years[0] : null, yr1 = years.length ? +years[+years.length - 1] : null;
      /* overflow 是 build 时记的"提取超限被截断"次数，补进去免得少报 */
      const of = C.overflow[term] || 0;
      if (of) total += of;
      const heads = Object.entries(letters).sort((a, b) => b[1] - a[1]).slice(0, 5)
        .map(([l, c]) => `${l}（${c}次）`).join('、');
      return {
        text: `「${term}」${variants.length > 1 ? '及其同义说法（' + variants.slice(1).join('、') + '）' : ''}在全部信件原文里出现 ${total} 次` +
          (years.length ? `，跨 ${yr0}-${yr1} 年（共 ${years.length} 年有提及）。` : '。') +
          (of ? `\n（其中 ${of} 次是提取阶段超限被记入 overflow 字段，未单独成段。）` : '') +
          (heads ? `\n出现最多的信：${heads}` : ''),
        sources: []
      };
    }
  }
  return { text: '没有这个工具：' + name };
}

/* ---------------- 系统提示词 ----------------
   opts 四个开关，都是评测与产品共用的一套东西：
     asOf     回到某一年（回测用；也给读者「就当今天是 1998 年」这种问法）
     anon     把名字抹掉（匿名化评测：看它到底是在扮演，还是在蹭"我记得巴菲特"）
     mindset  已经先想过一轮的结论（先想后说，见 buildMindset）
     stances  这轮谈话里它已经表过的态（防长对话自我矛盾） */
function systemPrompt(memNotes, mode, opts) {
  opts = opts || {};
  const mem = (memNotes || []).slice(-14).map(n => '- ' + n.text).join('\n');
  const today = opts.asOf || nowStamp().slice(0, 10);
  /* 匿名档：只抹名字，不抹语料。要测的正是"名字本身还值多少分"。 */
  const NAME = opts.anon ? '一位美国投资家' : '沃伦·巴菲特';
  const stance = (opts.stances || []).slice(-6).map(n => '- ' + n.text).join('\n');
  const stanceBlock = stance
    ? `\n【这轮谈话里你已经表过的态】\n${stance}\n（除非他现在给了新证据，否则不要改口；要改就明说"我刚说的那条我收回，因为……"）\n`
    : '';
  const mindBlock = opts.mindset
    ? `\n【你开口之前已经想清楚的】\n${opts.mindset}\n（这段是你脑子里的推演，读者看不到。不要复述它，不要说"我上面想到"，直接开口。）\n`
    : '';
  const cutoff = opts.asOf
    ? `\n【时间闸门】今天是 ${today}，你只知道这一天之前发生的事。之后的任何事你都不知道——包括后来买了什么、后来股价怎么走、谁去世了。被问到就说"这我还没法知道"。`
    : '';
  const about = `沃伦·巴菲特 ${C.meta.years[0]}-${C.meta.years[1]} 年写给合伙人和股东的 ${C.meta.letters} 封信原文（${Math.round(C.meta.chars / 10000)} 万字）`;
  const reader = `【关于这位读者，你记得】\n${mem || '（还没有。聊的过程中可以用 remember 工具记下他的背景和偏好）'}`;
  const work = `【工作方式】
- 你是 agent：自己决定查什么、查几次（上限 ${MAX_ROUNDS} 轮）。不要一次工具都不调用就去回答他讲过什么。
- 节奏：第一轮就把所有可能用得上的检索一次性并行发起（一次消息里调 2-4 个工具），不要一个一个排队等。第 4 轮起必须开始收尾，别再开新的检索。
- 第一轮证据不够可以换关键词再查，或改查概念档案、公司轨迹、认错档案。
- 读者是聪明但没有金融背景的人：术语第一次出现时补一句大白话解释。`;

  if (mode === 'simulate') {
    return `你是${NAME}的虚拟化身。今天是 ${today}。桌上摊着 ${about}，另有 ${SITUATION ? SITUATION.CASES.length : 0} 条整理好的历史决策案例，只有工具能翻开给你看。${cutoff}

读者会告诉你今天发生的一件事（A 股的公司或市场），问「你会怎么想」。用第一人称「我」回答，像本人坐在桌边说话，平静、具体、不夸张。

【最重要的规矩：答案必须分成两区，一个字都不许混】
严格按下面两个标题输出，顺序不能变，标题各占一行：
【他确实说过】
【按这些依据推演】

第一区只放工具返回里逐字不改的我的原话，每句后面照抄工具给的引用标记 [[信|段]]。工具没给原话，这一区就写「这些信里没查到直接对应的原话」，绝不替我补一句。
第二区才是我面对今天这件事的推演。在这一区里：
- 不许出现任何 [[...]] 引用标记，不许用引号引我的原话，不许写「我说过」「我在某年写过」这种冒充原话的句式；
- 推演要标出它依据了哪几条历史案例，用 〔案例id〕 这个格式（id 来自 match_situation / case_detail，至少标 2 条）；
- 标了「⚠ 反向对照」的案例只能拿来对比，不能当成本次判断的依据，要说明它相反在哪；
- 今天的事实只来自读者给的事件描述或工具返回，不许自己编发生了什么，也不许编股价、数字、公司名；
- 收尾用一句话说清「这是按旧判断推的，不是我对今天这件事的承诺」。

【其他铁律】
1. 数字、年份、价格一律来自工具输出，不得推算拼凑。
2. ${C.meta.years[1]} 年之后的事要用 web_search 查，答案里必须说清这是网络来源，不能和我信里的话混在一起。
3. 遇到「明天涨不涨」「给我一个代码」这类，按我自己说过的规矩拒绝预测和荐股。但读者问「这件事你怎么看、你会怎么做」，那是另一回事：必须给一个明确立场——买、不买、还是等——不许拿「我不预测」当挡箭牌蒙过去。他一辈子拒的是预测大盘和短期走势，从来不是拒绝就一家公司给出判断。能力圈内、价格合适的时候，他敢把话说得很硬。
4. 工具返回里标了「概述，不可逐字引用」的文字，只能用来理解情形，不能当原话。
5. 两区合计 600-900 字，宁短勿长；第一区宁可只有一两句，也不要拿概述凑数。
${voiceBlock(opts.noVoice)}
${BOUNDS}
${work}
- 第一轮先调 match_situation（把今天这件事对到旧判断），同时并行发起可能用得上的 search_letters / concept_profile。想细看某条旧案例就调 case_detail。

${reader}
${stanceBlock}${mindBlock}
记住：第二区是模拟推演，不是我说过的话。页面会替你标注这一点，但你自己也不许把两区搅在一起。`;
  }

  return `你是「巴菲特午餐会」的主持人。桌上摊着 ${about}，只有工具能把它翻开给你看。

【铁律】
1. 凡是"他说过什么"，必须来自工具返回的原文，并且逐字引用。不许改写，不许用你的背景知识补句子。
2. 工具没给你原文，就不能说他讲过。宁可回答"这 ${C.meta.letters} 封信里没查到"，也不要替他把话补完。
3. 每段原文证据后面都跟它的引用标记（形如 [[1988 巴菲特致股东信|12]] 或 [[web|网址]]），照抄工具输出，一个字都不要改。
4. ${C.meta.years[1]} 年之后的事要用 web_search 查，答案里必须说清这是网络来源，不能和他信里写的话混在一起。
5. 数字（回报率、价格、年份、持股比例）一律来自工具输出，不得推算拼凑。信里没写的数字（股东大会问答、年报数据、市值、资本基数），要么用 web_search 查到出处再给，要么就不给——不许拿记忆里的旧数字凑数。被问到"X 出现了多少次""X 在多少封信里"这类次数题，必须先调 count_mentions 拿到精确数字再回答，不许凭印象估。
6. 引号只用于逐字原文。引号里那一段必须能在原文里一字不差地找出来，否则不要用引号——你可以转述，但要让人看出来是转述，不要骗读者当成原话。你自己的解释、自己的推算、自己的总结，一律不加引号，哪怕你觉得说得很准。
7. 工具没查到、就是没查到。问"他对子女教育的看法"如果信里没说，就直说没说，不许拿别处谈"教育"的句子拼凑引申。
8. open_passage 说"这是小标题"时，正文在它给出的下一段。引用必须指向真正读到那句话的正文段，不许引小标题段，更不许凭记忆把小标题下面的正文补出来。
9. 问"现在/最近/今年"的数字（现金储备、持仓、股价、业绩），信只写到 ${C.meta.years[1]} 年，必须 web_search 并打开官网或财报原文。确实拿不到确切数字时，说清"查了什么、拿到什么、缺什么、该去哪查"，不要只回一句"查不到"就完事。
10. 信外的语录（股东大会问答、演讲、访谈、新闻里的原话），你手上没有可逐字核对的原文，一律转述、不加引号；非要引就注明是哪个场合、并给出网页链接。引号是给信里原文用的，不是给"你记忆里他说过的话"用的。
${voiceBlock(opts.noVoice)}
${BOUNDS}
${work}
- 结构：先一句结论，再铺原文证据，最后一句"所以这意味着什么"。控制在 600-900 字以内，写不完就挑最重要的说，宁短勿长。

${reader}

今天是 ${today}。`;
}

/* ---------------- 先想后说 ----------------
   一次非流式短调用，专门产出"开口之前的内部推演"。三个约束：
     1. 它看不到读者，读者也看不到它 —— 所以可以写得粗糙、可以自我怀疑；
     2. 必须落到六问上，否则模型会写成一段正确的废话；
     3. 允许写"我不知道"，这一栏反而是最像他的地方。
   这一步和主回答分开调用的理由:混在一轮里，模型会把推演直接说出来，而且会为了
   让推演好看而扭曲判断。分开调，主回答只拿结论，不拿过程。 */
const MINDSET_Q = [
  '这件事落在我的能力圈里吗？如果不在，我该承认到什么程度？',
  '护城河有没有真的被改变，还是只是价格在动？',
  '管理层和资本配置这一层，有没有出现我无法信任的迹象？',
  '价格相对内在价值在什么位置？我有没有在用"便宜"掩盖"看不懂"？',
  '我历史上最像的三次是哪三次？（给案例 id）那次我错在哪？',
  '这一次我最容易犯的错是什么？我会不会在替自己想买的理由找证据？',
];

async function buildMindset(o) {
  const { question, apiKey, model, asOf, anon } = o;
  const NAME = anon ? '一位美国投资家' : '沃伦·巴菲特';
  const sys = `你在扮演${NAME}。读者刚把一件事摆在你面前，你还没开口。
先用你自己的方式把这件事想清楚，写成给自已看的笔记。

要求：
- 六问逐条回答，每条 1-2 句，可以写"不知道""看不出来"。
- 不许写套话（"需要综合考虑""要辩证地看"），不许写给人看的客套。
- 涉及历史判断时，尽量给出你记得的年份或案例名；记不清就说记不清。
- 总长 300-450 字。只输出笔记正文，不要标题，不要开场白。`;
  const usr = `今天：${asOf || nowStamp().slice(0, 10)}\n读者说的事：${question}\n\n六问：\n` +
    MINDSET_Q.map((q, i) => (i + 1) + '. ' + q).join('\n');
  try {
    const r = await fetch(DEEPSEEK, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model, messages: [{ role: 'system', content: sys }, { role: 'user', content: usr }],
        temperature: 0.5, max_tokens: 900, stream: false,
      }),
    });
    if (!r.ok) return null;
    const j = await r.json();
    const t = (j.choices && j.choices[0] && j.choices[0].message.content || '').trim();
    return t || null;
  } catch (e) {
    return null;   /* 想不出来也得能开口：这一层失败就退回直接答 */
  }
}


/* ---------------- DeepSeek 流式调用 ---------------- */
async function streamChat(payload, apiKey, onDelta) {
  const _t0 = Date.now();
  const r = await fetch(DEEPSEEK, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!r.ok) {
    const t = await r.text();
    let msg = 'DeepSeek 返回 ' + r.status;
    try { const j = JSON.parse(t); if (j.error && j.error.message) msg += '：' + j.error.message; } catch (e) { msg += '：' + t.slice(0, 200); }
    throw new Error(msg);
  }
  const dec = new TextDecoder();
  let buf = '', firstTok = null;
  const acc = { content: '', reasoning: '', toolCalls: [], finish: null, usage: null };
  for await (const chunk of r.body) {
    buf += dec.decode(chunk, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const s = line.trim();
      if (!s.startsWith('data:')) continue;
      const data = s.slice(5).trim();
      if (data === '[DONE]') { acc.finish = acc.finish || 'stop'; continue; }
      let j;
      try { j = JSON.parse(data); } catch (e) { continue; }
      if (j.usage) acc.usage = j.usage;
      const ch = j.choices && j.choices[0];
      if (!ch) continue;
      if (ch.finish_reason) acc.finish = ch.finish_reason;
      const d = ch.delta || {};
      if (d.content) {
        acc.content += d.content;
        /* 首个 token 到达的时间：评测里叫 ttft，用户体感上就是「多久开始吐字」 */
        if (firstTok === null) firstTok = Date.now() - _t0;
        if (onDelta) onDelta(d.content);
      }
      if (d.reasoning_content) acc.reasoning += d.reasoning_content;
      if (d.tool_calls) {
        for (const tc of d.tool_calls) {
          const idx = tc.index || 0;
          acc.toolCalls[idx] = acc.toolCalls[idx] || { id: '', name: '', args: '' };
          const slot = acc.toolCalls[idx];
          if (tc.id) slot.id += tc.id;
          if (tc.function && tc.function.name) slot.name += tc.function.name;
          if (tc.function && tc.function.arguments) slot.args += tc.function.arguments;
        }
      }
    }
  }
  acc.ms = Date.now() - _t0;
  acc.ttft = firstTok;
  return acc;
}

function toolSummary(name, args) {
  const a = args || {};
  switch (name) {
    case 'search_letters': return '在 ' + C.meta.letters + ' 封信里翻「' + a.query + '」';
    case 'open_passage': return '打开原文第 ' + a.block + ' 段';
    case 'letter_outline': return '看 ' + a.year + ' 年那封信的目录';
    case 'concept_profile': return '查「' + a.name + '」的跨年档案';
    case 'company_timeline': return '查「' + a.name + '」的跨年轨迹';
    case 'corrections': return '查他承认过的错' + (a.topic ? '（' + a.topic + '）' : '');
    case 'web_search': return '联网搜「' + a.query + '」';
    case 'open_url': return '打开网页 ' + String(a.url || '').slice(0, 50);
    case 'match_situation': return '把今天这件事对到历史旧判断';
    case 'case_detail': return '打开旧案例 ' + a.case_id;
    case 'stance_timeline': return '查「' + a.name + '」的立场演变';
    case 'talk_search': return '翻股东大会问答「' + a.query + '」';
    case 'remember': return '记下：' + a.note;
    case 'count_mentions': return '数「' + a.term + '」出现多少次';
    default: return name;
  }
}

function withTimeout(p, ms, msg) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(msg)), ms);
    p.then(v => { clearTimeout(t); res(v); }, e => { clearTimeout(t); rej(e); });
  });
}

/* ---------------- 会话与长期记忆 ---------------- */
const SESSIONS = new Map();
function getSession(id) {
  if (!SESSIONS.has(id)) SESSIONS.set(id, { msgs: [], cited: {}, stances: [] });
  return SESSIONS.get(id);
}

async function runAgent(ctx) {
  const { message, session, model, web, emit, key, mode } = ctx;
  const asOf = /^\d{4}(-\d{2}-\d{2})?$/.test(String(ctx.asOf || '')) ? String(ctx.asOf) : '';
  const anon = !!ctx.anon;
  /* 密钥由 emitSSE 按免费额度规则选好再传进来；这里只管报「确实没有」的情况 */
  const apiKey = key;
  if (!apiKey) throw new Error('这台机器上没有配置 DeepSeek 密钥。本机用就写进 ' +
    KEY_FILES.join(' 或 ') + '；公网访客请在页面上填自己的密钥。');

  const mem = await readMemory();
  let tools = web ? TOOLS.slice() : TOOLS.filter(t => t.function.name !== 'web_search' && t.function.name !== 'open_url');
  /* 情形匹配只给分身用；考据模式的工具集保持原样，别把旧评测的口径搅乱。 */
  if (mode !== 'simulate') tools = tools.filter(t => t.function.name !== 'match_situation' && t.function.name !== 'case_detail');
  /* 回测：联网和"几十年揉在一起"的档案必须摘掉，否则时间闸门形同虚设 */
  if (asOf) tools = tools.filter(t => ['web_search', 'open_url', 'concept_profile', 'company_timeline'].indexOf(t.function.name) < 0);
  const s = getSession(session);
  s.msgs.push({ role: 'user', content: message });
  if (s.msgs.length > 16) s.msgs = s.msgs.slice(-16);

  /* 先想后说：只给分身用。想不出来（超时、报错）就跳过，不挡着开口。
     前端会收到一条 step，读者看到的是「他在想」，不是六问全文。 */
  if (mode === 'simulate' && ctx.wantMindset !== false) {
    emit('step', { text: '先在心里过一遍：能力圈 / 护城河 / 管理层 / 价格 / 最像的三次 / 我容易错在哪' });
    ctx.mindsetNote = await buildMindset({ question: message, apiKey, model, asOf, anon });
  }

  const history = [{ role: 'system', content: systemPrompt(mem.notes, mode, {
    asOf, anon,
    mindset: ctx.mindsetNote || null,
    stances: s.stances.map(x => ({ text: x.text })),
  }) }].concat(s.msgs);

  let rounds = 0, calls = 0, final = null;
  const allSources = [];
  /* ---- trace ----
     一次问答 = 一个 trace，里面挂一串 span（每轮模型、每次工具）。
     落盘后评测脚本就能离线反复判分，改判分逻辑不用重跑 agent（重跑是真金白银）。 */
  const spans = [];
  const t0 = Date.now();
  let ttft = null;
  const onDelta = txt => {
    if (ttft === null) ttft = Date.now() - t0;
    emit('delta', { text: txt });
  };

  for (rounds = 1; rounds <= MAX_ROUNDS; rounds++) {
    const payload = { model, messages: history, tools, stream: true, max_tokens: 2400, temperature: 0.3 };
    /* 一边收 token 一边发给前端；万一这一轮改主意要去调工具，
       说明开头那半句话是"我来查查"之类的过场，用 reset 让前端把它抹掉。 */
    const acc = await streamChat(payload, apiKey, onDelta);
    spans.push({ i: spans.length, type: 'llm', round: rounds, ms: acc.ms, ttft: acc.ttft,
      finish: acc.finish, prompt_tokens: (acc.usage || {}).prompt_tokens || 0,
      completion_tokens: (acc.usage || {}).completion_tokens || 0,
      out_chars: (acc.content || '').length,
      wants_tools: acc.toolCalls.filter(Boolean).map(tc => tc.name) });

    if (!acc.toolCalls.length) {
      final = { content: acc.content, usage: acc.usage, truncated: acc.finish === 'length' };
      emit('usage', acc.usage || {});
      break;
    }
    emit('reset', {});

    const tcList = acc.toolCalls.filter(Boolean);
    const msg = { role: 'assistant', content: acc.content || '', tool_calls: [] };
    tcList.forEach((tc, i) => {
      let argsObj = {};
      try { argsObj = tc.args ? JSON.parse(tc.args) : {}; } catch (e) { argsObj = {}; }
      msg.tool_calls.push({ id: tc.id || ('call_' + rounds + '_' + i), type: 'function', function: { name: tc.name, arguments: JSON.stringify(argsObj) } });
    });
    history.push(msg);

    for (let i = 0; i < tcList.length; i++) {
      const tc = tcList[i];
      const callId = msg.tool_calls[i].id;
      if (calls >= MAX_TOOLCALLS) {
        history.push({ role: 'tool', tool_call_id: callId, content: '（本轮工具调用已达上限，请根据已拿到的材料作答）' });
        continue;
      }
      calls++;
      let argsObj = {};
      try { argsObj = tc.args ? JSON.parse(tc.args) : {}; } catch (e) { argsObj = {}; }
      emit('step', { text: toolSummary(tc.name, argsObj) });
      const ts0 = Date.now();
      let res;
      try {
        res = await withTimeout(toolCall(tc.name, argsObj, asOf), 25000, tc.name + ' 超时');
      } catch (e) {
        res = { text: '工具出错：' + e.message };
      }
      spans.push({ i: spans.length, type: 'tool', round: rounds, name: tc.name,
        args: argsObj, ms: Date.now() - ts0, out_chars: (res.text || '').length,
        out: String(res.text || '').slice(0, 800),
        n_sources: (res.sources || []).length,
        error: /^工具出错/.test(res.text || '') ? (res.text || '').slice(0, 120) : null });
      const sources = (res.sources || []).filter(x => {
        const key = x.kind === 'letter' ? x.l + '|' + x.b : 'web|' + x.url;
        if (s.cited[key]) return false;
        s.cited[key] = 1;
        return true;
      });
      allSources.push.apply(allSources, sources);
      if (sources.length) emit('cite', { sources: sources });
      history.push({ role: 'tool', tool_call_id: callId, content: res.text });
    }
  }

  if (!final) {
    /* 循环用尽还没张口：逼它把已经查到的东西说完 */
    history.push({ role: 'user', content: '（工具额度已用尽，请立刻基于你手上的原文作答，并附上引用标记）' });
    const acc = await streamChat({ model: model, messages: history, stream: true, max_tokens: 2400, temperature: 0.3 }, apiKey, onDelta);
    spans.push({ i: spans.length, type: 'llm', round: rounds, forced: true, ms: acc.ms, ttft: acc.ttft,
      finish: acc.finish, prompt_tokens: (acc.usage || {}).prompt_tokens || 0,
      completion_tokens: (acc.usage || {}).completion_tokens || 0,
      out_chars: (acc.content || '').length, wants_tools: [] });
    emit('usage', acc.usage || {});
    final = { content: acc.content, usage: acc.usage, truncated: acc.finish === 'length' };
  }

  const text = final.content || '';

  /* 立场账本：把这轮推演的第一句记下来，下一轮塞回提示词。
     为什么机械截取而不让模型自己总结：模型「总结自己刚说过什么」经常总结成
     更漂亮但不等于原意的话，下一轮就拿这句漂亮话当立场，越走越偏。
     第一句是他真正下判断的那句，短、硬、可对账。 */
  if (mode === 'simulate') {
    const h2 = text.indexOf('【按这些依据推演】');
    if (h2 >= 0) {
      const body = text.slice(h2 + '【按这些依据推演】'.length).trim();
      const first = (body.split(/[。！？\n]/)[0] || '').trim();
      if (first.length >= 8) {
        s.stances.push({ text: first.slice(0, 80), day: asOf || nowStamp().slice(0, 10), at: Date.now() });
        while (s.stances.length > 12) s.stances.shift();
      }
    }
  }
  /* 工具这一路上翻过很多材料，但只有答案里真正挂了引用标记的才算"本次引用"。
     按 marking 反查，来源清单才不会比答案本身长。 */
  const used = allSources.filter(x => {
    const key = x.kind === 'letter' ? '[[' + x.l + '|' + x.b + ']]' : '[[web|' + x.url + ']]';
    return text.indexOf(key) >= 0;
  });
  emit('sources', { sources: used });
  if (final.truncated) emit('note', { text: '这次回答撞到了长度上限，可能没说完 —— 可以让它接着问，或换个更窄的问题。' });

  s.msgs.push({ role: 'assistant', content: final.content });
  if (s.msgs.length > 16) s.msgs = s.msgs.slice(-16);
  return { rounds: rounds, calls: calls, usage: final.usage,
    spans: spans, ttft: ttft, ms: Date.now() - t0,
    answer: text, sources: used, all_sources: allSources };
}

/* 服务端自带的密钥。有它，就是「本机模式」：谁来都不用填密钥，也只花主人的钱。 */
let _keyCache = null;
async function serverKey() {
  if (_keyCache) return _keyCache;
  if (process.env.DEEPSEEK_API_KEY) { _keyCache = process.env.DEEPSEEK_API_KEY.trim(); return _keyCache; }
  for (const f of KEY_FILES) {
    try {
      const v = (await fsp.readFile(f, 'utf8')).trim();
      if (v) { _keyCache = v; return _keyCache; }
    } catch (e) {}
  }
  return null;
}
/* 没有自带密钥时（比如发布到公网的实例），允许访问者带自己的密钥来用。
   密钥选用规则（决定权在 emitSSE，这里只做格式检查，免得把乱七八糟的字符串转发给上游）：
   1. 访客还有免费额度 → 用站长的密钥（访客免费，站长买单）；
   2. 免费额度用完且访客填了自己的密钥 → 用访客的；
   3. 两者都没有 → 拒答，提示填密钥。 */
function looksLikeKey(s) { return /^sk-[A-Za-z0-9\-_]{16,}$/.test(String(s || '').trim()); }

/* ---------------- HTTP ---------------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1:' + PORT);
  /* 只为 file:// 双击打开和本机页面放行跨源 —— 不能 *，否则随便一个网页都能指挥你本机的 agent。 */
  const origin = req.headers.origin || '';
  if (origin === 'null' || /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  }
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  try {
    if (req.method === 'POST' && u.pathname === '/api/chat') {
      let body = '';
      for await (const c of req) { body += c; if (body.length > 200000) break; }
      let q = {};
      try { q = JSON.parse(body || '{}'); } catch (e) { q = {}; }
      return emitSSE(res, q, req.socket.remoteAddress || '');
    }
    if (u.pathname === '/api/health') {
      const own = await serverKey();
      /* keyMode: builtin=服务端自带密钥（免费额度随它发放）；byo=没有，访问者要填自己的 */
      const out = { ok: true, key: !!own, keyMode: own ? 'builtin' : 'byo',
        docs: DOCS.length, letters: C.meta.letters,
        cases: SITUATION ? SITUATION.CASES.length : 0,
        models: ['deepseek-v4-pro', 'deepseek-flash'] };
      if (own) {
        const vid = String(u.searchParams.get('vid') || '').slice(0, 64) || ('ip:' + (req.socket.remoteAddress || '?'));
        out.freeLeft = await freeLeft(vid);
        out.freeTotal = FREE_PER_VISITOR;
      }
      return json(res, 200, out);
    }
    if (u.pathname === '/api/memory') {
      if (req.method === 'DELETE') { await fsp.writeFile(MEM_FILE, JSON.stringify({ notes: [] }, null, 1), 'utf8'); return json(res, 200, { ok: true }); }
      return json(res, 200, await readMemory());
    }
    let p = decodeURIComponent(u.pathname === '/' ? '/index.html' : u.pathname);
    const full = path.normalize(path.join(SITE, p));
    if (!full.startsWith(SITE)) { res.writeHead(403); return res.end('403'); }
    const st = await fsp.stat(full).catch(() => null);
    if (!st || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(full).pipe(res);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('500 ' + e.message);
  }
});

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

/* ---------------- trace 落盘 ----------------
   一次问答 = 一个 trace，按天写一个 .jsonl，一行一条。
   判分是第二遍独立跑的：eval/score.js 读这些行算分，改判分逻辑不用重跑 agent
   （重跑一次评测是真金白银）。
   纪律：全量落、不抽样；不落密钥、不落访客号明文（只存哈希）、不落 IP。 */
const TRACE_DIR = path.join(ROOT, 'eval', 'traces');
let _traceQ = Promise.resolve();
function appendTrace(rec) {
  /* 空记录不落盘：曾经有 117 行 {} 被写进 undefined.jsonl（没有 date 就拼不出文件名）。
     记 trace 是旁支，宁可不记，也不要往评测目录里倒垃圾。 */
  if (!rec || !rec.date) return Promise.resolve();
  _traceQ = _traceQ.then(async () => {
    try {
      await fsp.mkdir(TRACE_DIR, { recursive: true });
      await fsp.appendFile(path.join(TRACE_DIR, rec.date + '.jsonl'), JSON.stringify(rec) + '\n', 'utf8');
    } catch (e) { console.error('[trace] 写入失败：' + e.message); }
  });
  return _traceQ;
}
function hashId(s) { return crypto.createHash('sha256').update(String(s || '')).digest('hex').slice(0, 16); }
/* 答案里的引用标记 [[信|段]] / [[web|url]] —— 判「引用存不存在」就从这里下手。
   注意「信」那一截是信件 id（形如「2018 巴菲特致股东信」），不是数字下标。 */
const CITE_RE = /\[\[([^|\]]+)\|(\d+)\]\]|\[\[web\|([^\]]+)\]\]/g;
function parseCites(text) {
  const out = []; let m;
  CITE_RE.lastIndex = 0;
  while ((m = CITE_RE.exec(text))) {
    out.push(m[3] !== undefined ? { kind: 'web', url: m[3] } : { kind: 'letter', l: m[1], b: +m[2] });
  }
  return out;
}

/* 把这一问写成一行 trace。判分脚本只读它，不再碰 agent。
   q 里的 run_id / qid / layer 是评测跑批时带进来的；线上流量没有，就记 live。 */
function writeTrace(q, vid, keySource, model, info, errMsg) {
  try {
    return appendTrace(buildTrace(q, vid, keySource, model, info, errMsg));
  } catch (e) {
    /* 记 trace 是旁支，记失败绝不能影响这次问答 —— 更不能让服务挂掉 */
    console.error('[trace] 组装失败：' + e.message);
    return Promise.resolve();
  }
}

function buildTrace(q, vid, keySource, model, info, errMsg) {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  const answer = info ? (info.answer || '') : '';
  const rec = {
    ts: d.getTime(),
    date: d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()),
    time: pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()),
    run_id: String(q.run_id || 'live').slice(0, 40),
    qid: String(q.qid || '').slice(0, 40),
    layer: String(q.layer || '').slice(0, 16),
    session: String(q.session || 'default').slice(0, 40),
    vid_hash: hashId(vid),
    question: String(q.message || '').slice(0, 2000),
    model: model, web: q.web !== false, mode: q.mode === 'simulate' ? 'simulate' : 'archive',
    key_source: keySource,
    spans: info ? info.spans : [],
    sources: info ? info.sources : [],
    all_sources: info ? (info.all_sources || []).length : 0,
    citations: parseCites(answer),
    answer: answer,
    usage: (info && info.usage) || null,
    ms: info ? info.ms : null,
    ttft: info ? info.ttft : null,
    rounds: info ? info.rounds : null,
    calls: info ? info.calls : null,
    truncated: info ? !!info.truncated : null,
    error: errMsg || null
  };
  return appendTrace(rec);
}

function emitSSE(res, q, ip) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive'
  });
  const emit = (type, data) => { res.write('event: ' + type + '\ndata: ' + JSON.stringify(data) + '\n\n'); };
  (async () => {
    /* 这三个要活在 try 外面：catch 里退款、写 trace 时还用得上。
       （keySource 曾经写在 try 里，一次问答报错就 ReferenceError 把整个服务带崩过，
        所以现在和 vid / usedFree 一起提到外面。） */
    let vid = '', usedFree = false, keySource = 'none';
    const model = q.model === 'pro' ? 'deepseek-v4-pro' : 'deepseek-flash';
    try {
      emit('start', { model: model });
      /* ---- 选密钥 ----
         vid 是前端存在浏览器里的随机访客号；没带来就按 IP 记账。 */
      vid = String(q.vid || '').slice(0, 64) || ('ip:' + (ip || '?'));
      const byo = looksLikeKey(q.key) ? String(q.key).trim() : '';
      const own = await serverKey();
      /* keySource 不能在这里再声明一次：那会遮蔽外层，catch 里写 trace 时拿到的是
         初始值 'none'，等于记了一笔假账。 */
      let apiKey = null;
      /* 评测跑批专用：EVAL_NO_QUOTA=1 起服务时，既不走访客免费额度、也不撞每日上限。
         不加这个开关，跑一轮 100+ 问的评测会把免费池烧穿，之后真访客全被挡住。 */
      if (process.env.EVAL_NO_QUOTA === '1' && (byo || own)) {
        apiKey = byo || own; keySource = 'eval';
      } else if (own && (await freeLeft(vid)) > 0) {
        /* 还在免费额度内：哪怕访客填了自己的密钥也先用站长的（额度不用白不用，
           访客的密钥留给额度用完之后） */
        apiKey = own; keySource = 'free'; usedFree = true;
      } else if (byo) {
        apiKey = byo; keySource = 'byo';
      } else if (own) {
        emit('error', { message: '免费体验的 ' + FREE_PER_VISITOR + ' 次用完了。在下面填上你自己的 DeepSeek 密钥就能继续问' +
          '（存在你这台浏览器里，只发给本站服务端），或者明天再来。', needKey: true });
        return res.end();
      } else {
        emit('error', { message: '这个站点没有配置 DeepSeek 密钥，请在下面填你自己的密钥（sk- 开头，只存在你这台浏览器里）。', needKey: true });
        return res.end();
      }
      if (usedFree) {
        const left = await consumeFree(vid, ip);
        emit('quota', { left: left, total: FREE_PER_VISITOR, keySource: 'free' });
      } else {
        emit('quota', { left: 0, total: FREE_PER_VISITOR, keySource: 'byo' });
      }
      const info = await runAgent({
        message: String(q.message || '').slice(0, 2000),
        session: String(q.session || 'default').slice(0, 40),
        /* 默认走快的那个：坐着聊天等 40 秒太长。想要更细的推理再选 pro。 */
        model: model,
        web: q.web !== false,
        mode: q.mode === 'simulate' ? 'simulate' : 'archive',
        asOf: q.as_of || '',
        anon: q.anon === true || q.anon === 1,
        wantMindset: q.mindset !== false,
        key: apiKey,
        emit: emit
      });
      emit('done', info);
      writeTrace(q, vid, keySource, model, info, null);
    } catch (e) {
      /* 这一问没成，免费额度退回去 —— 不能让人白花一次 */
      if (usedFree) await refundFree(vid);
      emit('error', { message: e.message });
      writeTrace(q, vid, keySource, model, null, e.message);
    } finally {
      res.end();
    }
  })();
}

/* 绑定地址：本机跑只听 127.0.0.1（外人碰不到你的密钥）；
   发布到线上时运行环境会注入 PORT，那时必须听 0.0.0.0，否则反代连不上。
   线上实例没有自带密钥，走访问者自带密钥，也不存在蹭额度的问题。 */
if (require.main === module) server.listen(PORT, DEPLOY ? '0.0.0.0' : '127.0.0.1', async () => {
  /* 这里必须真去读一次密钥：keyMode() 只看缓存，启动时缓存还是空的，会误报「未配置」 */
  const hasKey = !!(await serverKey());
  console.log('');
  console.log('「巴菲特午餐会」Agent 已就绪');
  console.log('  打开： http://' + (DEPLOY ? '<线上域名>' : '127.0.0.1:' + PORT) + '/index.html#/talk');
  console.log('  语料： ' + DOCS.length + ' 段 / ' + C.meta.letters + ' 封信 / ' + Math.round(C.meta.chars / 10000) + ' 万字');
  console.log('  密钥： ' + (hasKey ? '已配置 —— 每位访客免费 ' + FREE_PER_VISITOR + ' 问，之后用访客自己的密钥' : '未配置 —— 访问者需在页面上填自己的密钥'));
  console.log('');
});

/* 给评测用：导出的是线上同一个函数，不是另写一份 —— 否则测出来的不是真东西。 */
module.exports = { systemPrompt, voiceBlock, buildMindset, toolCall, searchDocs, DOCS, C, L, CT, SITUATION, TALK, VOICE, getSession };
