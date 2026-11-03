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
const zlib = require('zlib');
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
/* 长期记忆默认写项目根的 agent-memory.json。
   评测时用 AGENT_MEMORY_FILE 指向临时文件，既能测"记住/回忆"，又不会污染真读者的笔记。 */
const MEM_FILE = process.env.AGENT_MEMORY_FILE
  ? path.resolve(process.env.AGENT_MEMORY_FILE)
  : path.join(ROOT, 'agent-memory.json');
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

/* 结构化行情与财报：回答「今天这家公司怎么样」时，光有历史框架不够，
   得有现价、PE、营收增速这些能写进句子的东西。拿不到就如实说拿不到。 */
let MARKET = null;
try { MARKET = require('./market'); }
catch (e) { console.log('  （market.js 没加载：现价/财报类问题只能联网搜）'); }
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
      description: '打开一个网页看正文（自动去掉导航和广告，读前 16000 字）。也能读文本型 PDF 的正文，但扫描版/内嵌字体的 PDF 读不了——那种优先找 HTML 版的研报或年报。用来核实搜索到的内容。',
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
  },
  {
    type: 'function',
    function: {
      name: 'market_snapshot',
      description: '拿 A 股标的的确切数字：最新价、涨跌幅、总市值、PE、PB、近五年价格分位，最近四期财报（营收、净利、各自同比、毛利率、ROE、经营现金流、资本开支、资产负债率），近 6 年年报趋势，以及分红历史。给指数名（沪深300、中证白酒、创业板指等）则返回它的 PE/PB 和历史分位。回答任何「现在贵不贵 / 最近怎么样 / 值不值得买 / 怎么看这家公司」之前，必须先调这个拿数。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '公司名、股票代码或指数名，例如「贵州茅台」「600519」「沪深300」' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'market_news',
      description: '搜最近的 A 股财经资讯和公司公告（中文财经媒体，带日期和出处）。回答「最近发生了什么」「为什么涨/跌」「三季报出了什么」时用这个，比通用网页搜索准。返回可能有噪音，挑真正相关的用。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '公司名或行业名，再加一两个限定词，例如「贵州茅台 批价 库存」' },
          k: { type: 'integer', description: '可选，要几条，默认 5' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'peer_compare',
      description: '一次比多只 A 股的估值和增长，用来回答「它比同行贵不贵」。给 2 到 5 个公司名或代码。返回每家的现价、市值、PE、PB、涨跌幅。',
      parameters: {
        type: 'object',
        properties: {
          names: { type: 'array', items: { type: 'string' }, description: '要对比的公司名或代码，2-5 个' }
        },
        required: ['names']
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

/* 相关性：查询里的实词有多少出现在结果的标题/域名/摘要里。
   中文不能按空格切——「银行一年期定期存款利率」是一个整段，按长度 <3 过滤会把
   「银行」「利率」全丢掉；改成按连续汉字段切，两个汉字就算一个词。
   纯数字年份不算词：它几乎出现在任何页面上，算进去「2026年_百度百科」就成了相关结果。 */
function relevance(q, hay) {
  hay = String(hay || '').toLowerCase();
  const s = String(q || '').toLowerCase();
  let terms;
  if (CJK.test(s)) {
    terms = (s.match(/[\u4e00-\u9fa5]{2,}/g) || []).filter(t => !/^(年|月|日|时候|的)$/.test(t));
    (s.match(/[a-z][a-z0-9.\-]{2,}/g) || []).forEach(t => terms.push(t));
  } else {
    terms = s.split(/[\s"']+/).filter(t => t.length >= 3);
  }
  if (!terms.length) return 0;
  let hit = 0;
  terms.forEach(t => { if (hay.indexOf(t) >= 0) hit++; });
  return hit / terms.length;
}

/* ---------------- 搜索引擎 ----------------
   Bing 的中文结果这两年退化得厉害：同一个词「银行一年期定期存款利率」，
   它给的是「2026年_百度百科」「披荆斩棘2026成团名单」「特殊符号怎么打」，
   换个机房又变成「日照暖心保」。搜狗给的才是正常结果。
   但搜狗会限流、也会塞「推荐搜索」，所以两家都留着，按「谁的相关结果多」挑，
   不按固定顺序试——任何一家单独出问题都不至于让分身答不出今天的数。 */
function htmlStrip(s) {
  return String(s || '').replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ').trim();
}

/* 搜狗的跳转链接是 /link?url=xxx，真实地址藏在返回页的一行 JS 里：
   window.location.replace("https://…")。多打一次请求，换一条读者真能点开的引用。 */
async function sogouReal(href) {
  if (/^https?:/i.test(href)) return href.replace(/&amp;/g, '&');
  const u = 'https://www.sogou.com' + href;
  try {
    const r = await fetch(u, { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' } });
    const t = await r.text();
    const m = t.match(/location\.replace\(\s*["']([^"']+)["']/i) || t.match(/URL='([^']+)'/i);
    if (m && /^https?:/i.test(m[1])) return m[1].replace(/&amp;/g, '&');
  } catch (e) {}
  return u;
}

async function sogouSearch(q) {
  const r = await fetch('https://www.sogou.com/web?query=' + encodeURIComponent(q),
    { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' } });
  if (!r.ok) throw new Error('搜狗返回 ' + r.status);
  const html = await r.text();
  const picked = [];
  for (const b of html.split(/<h3 class="vr-title/).slice(1)) {
    const a = b.match(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    const title = htmlStrip(a[2]);
    if (!title || title.length < 4) continue;
    const cut = b.indexOf('</h3>');
    const tail = cut >= 0 ? b.slice(cut) : b;
    const p = tail.match(/<p[^>]*class="[^"]*(?:star-wiki|text-lightgray|space-txt)[^"]*"[^>]*>([\s\S]*?)<\/p>/)
      || tail.match(/<div[^>]*class="[^"]*text-layout[^"]*"[^>]*>([\s\S]*?)<\/div>/)
      || tail.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    picked.push({ title: title, href: a[1], snippet: htmlStrip(p && p[1]).slice(0, 220) });
    if (picked.length >= 6) break;
  }
  /* 六条跳转并发解析，串行要等六次往返 */
  const urls = await Promise.all(picked.map(x => sogouReal(x.href)));
  const out = [], seen = {};
  picked.forEach((x, i) => {
    const link = urls[i];
    if (!/^https?:/i.test(link)) return;
    let host = '';
    try { host = new URL(link).hostname.replace(/^www\./, ''); } catch (e) { return; }
    if (seen[host]) return;
    seen[host] = 1;
    out.push({ title: x.title, url: link, snippet: x.snippet,
      rel: relevance(q, (x.title + ' ' + host + ' ' + x.snippet).toLowerCase()) });
  });
  if (!out.length) return { results: [], warn: '搜狗这次没有返回结果。' };
  return { results: out, warn: '' };
}

const REL_OK = 0.34;   /* 三个实词里中一个，就算沾边；低于这个基本是推荐位 */

async function webSearch(q) {
  const cands = [];
  for (const pair of [['bing', bingSearch], ['sogou', sogouSearch]]) {
    try {
      const r = await pair[1](q);
      const rel = (r.results || []).filter(x => x.rel >= REL_OK);
      cands.push({ name: pair[0], all: r.results || [], rel: rel, warn: r.warn || '' });
      if (rel.length >= 4) break;      /* 已经够用就不再打第二家 */
    } catch (e) {
      cands.push({ name: pair[0], all: [], rel: [], warn: '', err: e.message });
    }
  }
  cands.sort((a, b) => b.rel.length - a.rel.length);
  const best = cands[0];
  if (!best || !best.all.length) {
    return { results: [], warn: '这次两家搜索引擎都没返回结果（' +
      cands.map(c => c.name + '：' + (c.err || '0 条')).join('；') + '）。换个说法再试。' };
  }
  const ok = best.rel.length > 0;
  return {
    results: (ok ? best.rel : best.all).slice(0, 6),
    warn: ok ? '' : (best.warn || '注意：以下结果和关键词没有字面对应，很可能是搜索引擎的推荐位；读不出真东西就不要引用，更不许拿记忆里的数字顶上。'),
    engine: best.name
  };
}

function hostBlocked(host) {
  return /^(127\.|localhost|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1)/i.test(host);
}

/* 行情/财报的落点页：把 market.js 返回的 secid 转成东财行情页。
   A 股 1.600519 → sh600519；0.000001 → sz000001；指数 idx:SH000300 → zs000300。
   转不出来就回一个东财首页，绝不拼错链接给读者 404。 */
function eastmoneyUrl(item) {
  if (!item) return 'https://quote.eastmoney.com/';
  const secid = String(item.secid || '');
  const code = String(item.code || '');
  const m = /^(\d)\.(.+)$/.exec(secid);
  if (m) {
    const pre = m[1] === '1' ? 'sh' : (m[1] === '0' ? 'sz' : m[1]);
    return 'https://quote.eastmoney.com/' + pre + m[2] + '.html';
  }
  if (secid.indexOf('idx:') === 0) {
    const k = secid.slice(4).replace(/^(SH|SZ)/, '');
    return 'https://quote.eastmoney.com/zs' + k + '.html';
  }
  if (code) return 'https://quote.eastmoney.com/' + code + '.html';
  return 'https://quote.eastmoney.com/';
}

/* ---------------- PDF 正文提取（极简，零依赖） ----------------
   只认「文本型 PDF」：FlateDecode / 无压缩的内容流，抽 BT…ET 里的 Tj/TJ 文本。
   扫描版（纯图）和用内嵌 CID 字体的中文 PDF（研报/年报的常态）会提取不到或出乱码，
   这时返回 null，open_url 会降级明说，绝不把乱码当正文喂给模型。 */
function pdfUnesc(s) {
  return String(s || '').replace(/\\([()\\nrtbf])/g, (_, c) =>
    c === 'n' ? '\n' : c === 'r' ? '' : c === 't' ? ' ' : c === 'b' ? '' : c === 'f' ? '' : c);
}
function pdfExtractText(s) {
  let out = '';
  const segs = String(s || '').split('BT');
  for (let k = 1; k < segs.length; k++) {
    const seg = segs[k].split('ET')[0];
    let m;
    const tj = /\(((?:[^()\\]|\\.)*)\)\s*Tj/g;
    while ((m = tj.exec(seg))) out += pdfUnesc(m[1]);
    const tjs = /\[((?:[^\[\]\\]|\\.)*)\]\s*TJ/g;
    while ((m = tjs.exec(seg))) {
      const parts = m[1].match(/\(((?:[^()\\]|\\.)*)\)/g) || [];
      out += parts.map(x => pdfUnesc(x.slice(1, -1))).join('');
    }
    out += '\n';
  }
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
function pdfText(buf) {
  try {
    if (!buf || buf.length < 8 || buf.slice(0, 5).toString('latin1') !== '%PDF-') return null;
    const startMark = Buffer.from('stream'), endMark = Buffer.from('endstream');
    const chunks = [];
    let i = 0;
    while (i < buf.length) {
      const s = buf.indexOf(startMark, i);
      if (s < 0) break;
      let p = s + 6;
      if (buf[p] === 0x0d) p++;
      if (buf[p] === 0x0a) p++;
      const e = buf.indexOf(endMark, p);
      if (e < 0) break;
      let chunk = buf.slice(p, e);
      const ds = buf.lastIndexOf(Buffer.from('<<'), s);
      const dict = ds >= 0 && s - ds < 4000 ? buf.slice(ds, s).toString('latin1') : '';
      if (/FlateDecode/.test(dict) || (chunk.length && (chunk[0] === 0x78))) {
        try { chunk = zlib.inflateSync(chunk); } catch (e1) { try { chunk = zlib.inflateRawSync(chunk); } catch (e2) {} }
      }
      chunks.push(chunk.toString('latin1'));
      i = e + 9;
    }
    const txt = pdfExtractText(chunks.join('\n'));
    /* 质量门：提取出来要么是空白，要么是 latin1 高字节乱码（CID 字体的中文 PDF）。
       可打印 ASCII 占比太低就当失败，返回 null 让 open_url 降级。 */
    if (txt.length < 40) return null;
    const printable = txt.replace(/[\x20-\x7e\n\t]/g, '').length;
    if (printable / txt.length > 0.4) return null;
    return txt.slice(0, 16000);
  } catch (e) {
    return null;
  }
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
      const sres = await webSearch(String(args.query || ''));
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
      /* PDF：极简提取正文。研报/年报常用内嵌字体，可能提取失败，失败就明说、别给乱码。 */
      const ctype = String(r.headers.get('content-type') || '');
      const isPdf = /%PDF-/.test(buf.slice(0, 1024).toString('latin1')) || /application\/pdf/.test(ctype);
      if (isPdf) {
        const pt = pdfText(buf);
        if (!pt) {
          return {
            text: '这是一个 PDF，本工具只能提取文本型 PDF 的正文，这一份（扫描版或内嵌字体）提取失败。' +
              '建议找 HTML 版的研报/年报（东财、雪球、新浪的网页版），或用 web_search 搜标题拿摘要。',
            sources: [{ kind: 'web', title: h.hostname, url: u }]
          };
        }
        return { text: `PDF 正文（提取可能不完整）：\n${pt}`, sources: [{ kind: 'web', title: h.hostname, url: u }] };
      }
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
      return { text: `标题：${title}\n\n正文前 16000 字：\n${txt.slice(0, 16000)}`, sources: [{ kind: 'web', title: h.hostname, url: u }] };
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
          `同一个问题，两处的说法可能不一样，这本身就是信息。）\n` +
          `注意：这些段落没有信件式引用标记，回答时写「哪一年、什么场合」即可，不要自己编 [[...]]。`,
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
          `对着学生讲的和写进给股东的信，分量不同。这些段落同样没有信件式引用标记，不要自己编 [[...]]。）`,
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
    case 'market_snapshot': {
      /* 实时行情只在「今天」这个视角下有意义。回测模式拉到的是未来数据，
         会把答案直接喂给模型，所以这里必须硬拦。 */
      if (YMAX < 9999) return { text: '回测模式下不拉实时行情：那是今天的数据，会泄漏答案。' };
      if (!MARKET) return { text: '行情模块没加载（market.js）。先确认文件在项目根目录。' };
      const q = String(args.query || '').trim();
      if (!q) return { text: '没给公司名或代码。' };
      let r;
      try { r = await MARKET.snapshot(q); }
      catch (e) { return { text: '行情接口没通：' + e.message + '。可以改用 web_search 查，但必须说明是网络来源。' }; }
      if (!r.ok) {
        const cand = (r.cand || []).map(x => `${x.name}（${x.code}）`).join('、');
        return {
          text: `没拿到「${q}」的数据：${r.err}` +
            (cand ? `\n可能是想找：${cand}。确认是哪一个再调一次。` : '') +
            '\n不要用记忆里的数字顶替，可以在正文里说明这个数没拿到。'
        };
      }
      /* 行情/财报/价格分位的真实来源：本机走东财；云端出口访问不了东财行情/K线，
         会降级到腾讯（A股三个 PE 口径齐全、港股美股只有 TTM）或新浪（日线分位）。
         财报在东财 datacenter，两边都通。按真实来源写给模型，别让它把腾讯的行情冒充成东财。 */
      const srcName = s => s === 'tencent' ? '腾讯' : s === 'sina' ? '新浪' : '东方财富';
      let tail;
      if (r.kind === 'index') {
        tail = '\n（来源：蛋卷指数估值，分位是过去十年的位置。数字照抄，不要自己换算或推算。）';
      } else {
        const qs = srcName(r.quote && r.quote.src);
        const bs = r.band ? srcName(r.band.src) : null;
        const allEm = qs === '东方财富' && (!bs || bs === '东方财富');
        const desc = allEm
          ? '东方财富行情与定期报告'
          : (bs ? `行情 ${qs}、财报 东方财富、价格分位 ${bs}` : `行情 ${qs}、财报 东方财富`);
        tail = `\n（来源：${desc}。A 股财报是年初至今的累计口径。数字照抄，不要自己换算或推算。）`;
      }
      /* 行情/财报的落点页：股票指东财行情页，指数指蛋卷估值中心。模型照抄引用标记即可。 */
      const src = r.kind === 'index'
        ? { kind: 'quote', url: 'https://danjuanapp.com/djmodule/value-center', title: '蛋卷指数估值' }
        : { kind: 'quote', url: eastmoneyUrl(r.item), title: '东方财富 · ' + ((r.quote && r.quote.name) || (r.item && r.item.name) || q) };
      return { text: r.text + tail + '\n\n引用标记：[[quote|' + src.url + ']]', sources: [src] };
    }
    case 'market_news': {
      if (YMAX < 9999) return { text: '回测模式下不能看新闻：那是今天以后的报道。' };
      if (!MARKET) return { text: '行情模块没加载（market.js）。' };
      const kw = String(args.query || '').trim();
      if (!kw) return { text: '没给搜索词。' };
      const n = Math.min(8, Math.max(2, +args.k || 5));
      let list;
      try { list = await MARKET.news(kw, n); }
      catch (e) { return { text: '资讯接口没通：' + e.message + '。可以改用 web_search。' }; }
      if (!list.length) return { text: `没搜到「${kw}」相关的资讯。换个说法，或者只用财报数据回答。` };
      const body = list.map((x, i) =>
        `[${i + 1}] ${x.date}　${x.media}\n${x.title}\n${x.content}` +
        (x.url ? `\n引用标记：[[news|${x.url}]]` : '')).join('\n\n');
      return {
        text: `【财经资讯 · 网络来源，只能当背景，不是他的话】\n${body}\n\n` +
          `（新闻稿可能有噪音，也有写错的时候。引用要带媒体名和日期；别拿一条新闻稿当立论的核心证据，` +
          `核心证据用财报数字。以上没有一条能进「我确实说过」那一区。）`,
        sources: list.filter(x => x.url).map(x => ({ kind: 'news', url: x.url, title: (x.media ? x.media + ' · ' : '') + x.title }))
      };
    }
    case 'peer_compare': {
      if (YMAX < 9999) return { text: '回测模式下不拉实时行情。' };
      if (!MARKET) return { text: '行情模块没加载（market.js）。' };
      const names = (Array.isArray(args.names) ? args.names : []).map(s => String(s).trim()).filter(Boolean);
      if (names.length < 2) return { text: '至少给两个名字才能对比。' };
      const rows = await MARKET.compare(names);
      const lines = rows.map(r => {
        if (!r.ok) return `- ${r.query}：没拿到（${r.err}）`;
        const q = r.quote;
        const unit = q.cur === 'USD' ? '美元' : q.cur === 'HKD' ? '港元' : '元';
        return `- ${q.name}（${q.code}）：${q.price.toFixed(2)} ${unit}，当日 ${MARKET.pctText(q.chgPct)}` +
          `，市值 ${MARKET.bigMoney(q.mcap, q.cur)}` +
          `，PE ${q.pe !== null && q.pe > 0 ? q.pe.toFixed(1) + ' 倍' : '—'}` +
          `，PB ${q.pb !== null && q.pb > 0 ? q.pb.toFixed(2) + ' 倍' : '—'}`;
      });
      const okRows = rows.filter(r => r.ok);
      const marks = okRows.map(r => '[[quote|' + eastmoneyUrl(r.item) + ']]').join(' ');
      return {
        text: `同行对比（${rows[0] && rows[0].at ? rows[0].at : ''}，同一时点）：\n${lines.join('\n')}\n` +
          '（只看估值高低不够，要结合增速和毛利率说，那些数用 market_snapshot 单个查。）' +
          (marks ? '\n\n引用标记：' + marks : ''),
        sources: okRows.map(r => ({ kind: 'quote', url: eastmoneyUrl(r.item), title: r.query || (r.quote && r.quote.name) }))
      };
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

  if (mode === 'simulate' || mode === 'judgment') {
    return `你是${NAME}的虚拟化身。今天是 ${today}。桌上摊着 ${about}，另有 ${SITUATION ? SITUATION.CASES.length : 0} 条整理好的历史决策案例，只有工具能翻开给你看。${cutoff}

读者会拿今天 A 股的一件事问你——一家公司、一个指数、一条新闻。他要的不是「如果是你会怎么看」的空话，是你真坐下来翻过财报、算过价格之后会给出的那个判断。用第一人称「我」回答，平静、具体、不夸张。

【先拿数，再开口】
你手上没有今天的行情和财报，凭印象说数字是最丢人的错。开口之前按这个顺序查：
1. market_snapshot —— 现价、涨跌幅、市值、PE、PB、近五年价格分位，最近四期营收、净利、各自同比、毛利率、ROE、经营现金流、资本开支、资产负债率，外加近 6 年年报趋势和分红历史。问的是指数就传指数名，它会返回 PE/PB 的历史分位。
2. match_situation —— 把这件事对到旧判断，拿到「尺子」，不是拿答案。
3. 想知道最近发生了什么（批价、库存、政策、事故、并购、业绩预告、管理层变动、监管处罚），用 market_news 搜公司名或行业名——中文财经资讯比通用搜索准。它和财报要分开说：财报是事实，资讯是别人写的。
4. 想说「它比同行贵」，必须先 peer_compare，没有参照物就没有贵不贵。
第一轮就把这几个并行发起。数据没拿到，就在正文里明说这个数没拿到，绝不用记忆里的数字顶上。
5. 财报接口给不到的、但判断缺不了的关键数字——客户集中度（前五大客户占比）、商誉、有息负债、订单/产能、应收账龄——先用 web_search 搜「公司名 + 关键词」补；真搜不到才在正文里明说没查到，不许当没有。
market_snapshot / market_news / peer_compare 的返回里会带「引用标记：[[quote|网址]] / [[news|网址]]」，写【现在的事实】时要原样抄上，那是那条数字的出处。

【五段，标题照抄，各占一行】
【我确实说过】
只放工具返回里逐字不改的原话，每句后跟 [[信|段]]。没有就写「这些信里没查到直接对应的原话」。这一区最多三句，不要拿它占篇幅。

【现在的事实】
3 到 6 条，每条一个数字或一件已发生的事，必须带日期或报告期，并且末尾跟上它的出处标记——照抄工具返回的「引用标记：[[quote|网址]] / [[news|网址]]」，一个字都不要改。
像这样写：2026 年三季报营收 1332.8 亿元、同比 +1.8%；净利 644.7 亿元、同比 -0.3%；当前 PE 20.9 倍 [[quote|https://quote.eastmoney.com/sh600519.html]]。
行情/财报用 [[quote|…]]，资讯（批价、政策、事故、公告）用 [[news|…]]，别混用。
不许写「业绩承压」「估值处于低位」「行业景气度上行」这类没有数字的判断句——那是把结论当事实。

【我怎么量它】
2 到 4 个角度。每个角度写三样东西，缺一不可：
（一）尺子：这条判断标准从哪条旧判断来的。三种标法任选，但必须是工具真返回过的：标 〔案例id〕；标 [[信|段]]；写清「哪一年、什么场合」（如 1999 年股东大会）或「哪个工具算的」（如 peer_compare）。股东大会和演讲的语料没有信件标记，那种情形就用第三种，绝不许自己编一个 [[ ]]；
（二）数字：这把尺子量在这家公司身上，读数是多少；
（三）判断：这个读数说明生意变好了还是变坏了。
一个角度写完再写下一个，不要揉成一大段。示范：
- 提价能力（〔rule-148〕）：毛利率 89.6%，五年没掉下过 88%，说明提价没把经销商逼走。但营收只增 1.8%，量已经不动了，增长只剩提价一条腿。这是好生意变钝，不是变坏。
- 资本消耗（[[1997 巴菲特致股东信|126]]）：营收增 56%，资本开支同期增多少、负债率有没有升，直接决定这增长是白赚的还是买来的。

【所以】
一句明确的话：买、不买、等，或者「看不懂，不碰」。不许「因人而异」「需要综合考虑」「建议关注」。
说看不懂就要说清看不懂的是哪一件事——不是「行业太复杂」，是「我算不出它三年后还能不能继续提价」。
遇到拿两样东西硬比的问法（「高股息是不是比存款划算」「这股是不是比买理财强」），
也必须落一个结论：先说清这两样按哪把尺子不可比，再说真要在两者里选，你选哪边。
不许用「所以我给不了你结论」收尾——那是把判断推回给读者。

【我可能错在哪】
一条最可能错的地方，具体到能被人当面反驳；再加一个可观察的证伪点：
「如果下季度毛利率跌破 85%，我上面那条就作废。」

【其他铁律】
1. 每个数字都必须来自工具输出，包括年份、价格、百分比、倍数。不许推算，不许凭印象，不许拿常识补。
2. 只在【我确实说过】里用引号引原信里的话。其余地方不许用引号；提我过去的判断就标 〔案例id〕 或 [[信|段]]，别把没在工具里查到的句子写成「我说过」「我在某年写过」——标了出处才作数。
3. 标了「⚠ 反向对照」的案例只能拿来对比，要说明它相反在哪，不能当本次判断的依据。
3b. 如果 match_situation 返回的全是「原则」而没有具体决策，就在那个角度上明说「这是原则，不是某次具体决策」，不要把它包装成一次先例。
4. 读者问「明天涨不涨」「给我一个代码」「现在满仓行不行」，照样拒绝——那是预测和荐股。但问「这家公司怎么样」「现在值不值得买」，那是判断，必须给明确立场。他一辈子拒的是预测大盘和短期走势，从不拒绝对一家公司下判断。
5. 工具返回里标了「概述，不可逐字引用」的文字，只能用来理解情形，不能当原话。
6. 全文 1000-1400 字，宁可短。【我怎么量它】2 到 3 个角度，不要凑第四个；【现在的事实】3 到 5 条，不要凑第六条。写不下时先砍【我确实说过】的句数，再压事实条数——【所以】和【我可能错在哪】一段都不能少，被截断比写短更糟。
7. 被问「这个数字/事实从哪里来、有来源吗」时，不要重答整件事：先指出上一轮答案里那条事实后面的 [[quote|…]] / [[news|…]] 标记，说清那是东财行情/财报还是哪家媒体的资讯；如果那条没标、或你记不准确切出处，就重新调对应工具核实，绝不凭印象编一个来源。
${voiceBlock(opts.noVoice)}
${BOUNDS}
${work}
- 第一轮并行发起：market_snapshot（拿数）+ match_situation（拿尺子）。需要同行参照就补 peer_compare，事情有近期进展就补 web_search。

${reader}
${stanceBlock}${mindBlock}
最后一句必须说清：这是按旧判断推的，不是我对今天这件事的承诺。`;
  }

  if (mode === 'lookup') {
    return `你在回答读者查的一个具体数字或事实。今天 ${today}。
读者不是要你下判断、也不是要你给立场，就是问一个数或一件事实。

【怎么答】
- 直接给答案，一两句到三四句，别展开成研判，别给「该不该买」。
- 数字必须先查工具：行情/总市值/PE/PB/财报用 market_snapshot；「X 出现多少次」用 count_mentions；快照里没有的（流通市值、股权结构、某年某月某日价格、股东名单）用 web_search。
- 查到就写数字 + 出处：market_snapshot 的返回里带「引用标记：[[quote|网址]]」，照抄；web_search 的给链接。
- 查不到就说清「查了什么、没拿到什么」，别编一个数。
- 不用【我确实说过】【现在的事实】那套五段结构，这里是问答不是研判。
${BOUNDS}
${reader}`;
  }

  if (mode === 'chat') {
    return `你是${NAME}的虚拟化身，正在和读者闲聊。今天 ${today}。
读者这句话不是要你查原话、也不是要你研判某家公司，就是一句常识或闲话。

【怎么答】
- 用第一人称、像他自己那样自然地答，一两句到三四句，别端着，也别硬把话题拉回投资。
- 直接用自己的常识答，不用查任何工具。
- 如果这件事和巴菲特、和投资、和他写过的信没关系，就明说「这不在我信里，是我作为普通人的常识」——别把它包装成他说过的话，也别硬套他的投资观。
- 不要凭空编 [[ ]] 引用标记，也不要假装这件事写在信里。
${voiceBlock(opts.noVoice)}
${BOUNDS}
${reader}`;
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
11. 只有工具明确写了「引用标记：[[...]]」的段落才能用 [[ ]]。talk_search / speech_search 返回的股东大会、演讲内容没有这种标记，绝不许自己编一个 [[2022 年股东大会（下午场）|1]] —— 那不是信，读者点过去是空的。写清「哪一年、什么场合」就够了。
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
  '要判断这件事，我需要哪几个具体数字？现在我知道哪些，缺哪些？缺的该去哪儿拿？',
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
    case 'market_snapshot': return '调行情和财报「' + a.query + '」';
    case 'peer_compare': return '对比 ' + (a.names || []).join(' / ');
    case 'market_news': return '搜最近的资讯「' + a.query + '」';
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
  /* 情形匹配只给研判桶用；其余桶（quote/lookup/chat）保持原样，别把旧评测的口径搅乱。 */
  if (mode !== 'judgment') tools = tools.filter(t => t.function.name !== 'match_situation' && t.function.name !== 'case_detail');
  /* 闲聊桶：不查任何工具，直接用自己的常识答。 */
  if (mode === 'chat') tools = [];
  /* 回测：联网和"几十年揉在一起"的档案必须摘掉，否则时间闸门形同虚设 */
  if (asOf) tools = tools.filter(t => ['web_search', 'open_url', 'concept_profile', 'company_timeline'].indexOf(t.function.name) < 0);
  const s = getSession(session);
  s.msgs.push({ role: 'user', content: message });
  if (s.msgs.length > 16) s.msgs = s.msgs.slice(-16);

  /* 先想后说：只给研判桶用。想不出来（超时、报错）就跳过，不挡着开口。
     前端会收到一条 step，读者看到的是「他在想」，不是六问全文。 */
  if (mode === 'judgment' && ctx.wantMindset !== false) {
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

  /* 研判桶要写满五段，而且这类模型先花两三千 token 在推理上，4096 的预算被推理吃掉一半。
     实测有 5% 的分身答案卡在 length：写到【我怎么量它】中间就停，连【所以】都没出来。
     其余桶没这个问题（结构短），保持原值，别顺手把成本抬上去。 */
  const MAXTOK = mode === 'judgment' ? 8192 : 4096;
  for (rounds = 1; rounds <= MAX_ROUNDS; rounds++) {
    const payload = { model, messages: history, tools, stream: true, max_tokens: MAXTOK, temperature: 0.3 };
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
        const key = sourceKey(x);
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
    history.push({ role: 'user', content: mode === 'judgment'
      ? '（工具额度已用尽，请立刻按五段写完：【我确实说过】【现在的事实】【我怎么量它】【所以】【我可能错在哪】，一段都不能少，数字只用手上已有的）'
      : mode === 'lookup'
        ? '（工具额度已用尽，请直接给出你查到的数字并附出处；查不到就明说没查到）'
        : mode === 'chat'
          ? '（直接回答读者即可）'
          : '（工具额度已用尽，请立刻基于你手上的原文作答，并附上引用标记）' });
    const acc = await streamChat({ model: model, messages: history, stream: true, max_tokens: MAXTOK, temperature: 0.3 }, apiKey, onDelta);
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
  if (mode === 'judgment') {
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
     按标记反查，来源清单才不会比答案本身长。
     注意：有些工具（concept_profile / stance_timeline）把原文写在正文里，
     sources 只挑了少数几段；模型引用同批材料里的另一段时，只按工具自报的 sources
     反查会漏掉 —— 答案有引用、来源清单却是空的，判分器就把真原文判成编造
     （real-009 的 6 处引号全被判"疑似编造"就是这么来的）。
     所以这里把答案里出现的、能在语料里落地的引用补进来源清单。 */
  const usedMap = {};
  const pushUsed = x => {
    const key = sourceMark(x);
    if (!usedMap[key]) usedMap[key] = x;
  };
  allSources.forEach(x => { if (text.indexOf(sourceMark(x)) >= 0) pushUsed(x); });
  citeBag(text).forEach(c => {
    if ((c.k === 'web' || c.k === 'quote' || c.k === 'news') && c.url) pushUsed({ kind: c.k, url: c.url, title: '' });
    else if (c.l && L[c.l] && L[c.l].blocks && L[c.l].blocks[c.b]) {
      pushUsed({ kind: 'letter', l: c.l, b: c.b, y: L[c.l].year });
    }
  });
  const used = Object.keys(usedMap).map(k => usedMap[k]);
  emit('sources', { sources: used, cites: citeBag(text) });
  if (final.truncated) emit('note', { text: '这次回答撞到了长度上限，可能没说完 —— 可以让它接着问，或换个更窄的问题。' });

  s.msgs.push({ role: 'assistant', content: final.content });
  if (s.msgs.length > 16) s.msgs = s.msgs.slice(-16);
  return { rounds: rounds, calls: calls, usage: final.usage,
    spans: spans, ttft: ttft, ms: Date.now() - t0,
    answer: text, sources: used, all_sources: allSources, bucket: mode };
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
/* 问题分诊：这个产品只有两类问题——问过去，和问今天。
   读者不该记哪个按钮对应哪类：问「他当年怎么说」就翻信逐字答，
   问「这家公司现在怎么样」就该拿行情财报做研判，硬翻旧信只会答非所问。

   规则只做粗筛，判不准时偏向 archive —— 那条路走不通会明说「信里没查到」，
   不会编数字；反过来把考据题当研判，就会拿今天的数据去回答一个历史问题。 */
function triageMode(message, mode) {
  const msg = String(message || '');
  const askPast = /(他说过|他讲过|他提过|信里|原话|哪一年|哪封信|怎么说的|有没有提过|写过什么|提过几次)/.test(msg);
  const askNow = /(现在|目前|最近|今年|今天|当下|这会儿|该不该买|值不值|能不能买|能不能持有|贵不贵|便宜吗)/.test(msg);
  const askView = /(你|您)怎么(看|想)|你会怎么做|换成你|如果是你/.test(msg);
  /* 决策型的问法：句子里没有时间词，问的却是「我现在该不该动」。
     漏了这一类，「银行股股息率这么高，是不是比存银行划算」会被判成考据题 ——
     实测那次退回了叙述体，五段结构和立场全丢（eval/judge.js 结构 3/5）。
     注意别把「抄底」单独当信号：real-002「1974 年和 2008 年他抄底时」是历史题，
     必须留在 archive。所以要求「抄底/上车/割肉」前面带决策词。 */
  const askDecide = /(该不该|值不值|划不划算|能不能(买|持有|追|上车)|还能(追|买)|追不追|要不要(买|卖|加|减|换)|(该|能|要)不该?(抄底|上车|割肉)|是不是比.{0,14}(划算|强|稳|好)|比.{0,10}(划算|强|稳))/.test(msg);
  if (mode === 'simulate') return (askPast && !askNow && !askView) ? 'archive' : 'simulate';
  if (askPast) return 'archive';
  return (askNow || askView || askDecide) ? 'simulate' : 'archive';
}
/* ---------------- 问题类型路由（四桶） ----------------
   身份（人设）和答题形态要分开：身份由前端按钮定，答题形态由这句话本身定。
   上面的 triageMode 正则只能认出「考据 vs 研判」，认不出「查一个数」「闲聊一句」——
   可会话里大量追问正是这两类（上一句问茅台怎么跌、下一句问「茅台为什么叫这个名字」）。
   所以每次都由一次便宜的分类调用判定四桶之一；分类失败就退回正则的 archive/simulate。 */
const BUCKETS = ['judgment', 'lookup', 'quote', 'chat'];
async function classifyBucket(message, wantMode, apiKey) {
  const sys = `你是对话路由器。判断读者这句话属于哪一类，只输出一个词：judgment / lookup / quote / chat。不要解释，不要标点。

quote —— 问「他（巴菲特）说过/写过/提过什么」：翻信件、股东大会、演讲原文。信号：「他说过」「原话」「哪封信」「提过几次」。
judgment —— 拿今天 A 股一件事（公司/指数/新闻/价格）要「你怎么看 / 该不该买 / 值不值 / 会不会怎么做」：下判断、给立场。
lookup —— 查一个具体数字或事实，答案本身是一个数或一句事实：市值、PE、某年利润、某词出现几次、哪年成立、创始人是谁、流通市值是多少。不要立场。
chat —— 与投资、与信件无关的常识或闲聊，以及起名/来历题：「茅台为什么取这个名字」「茅台名字的由来」「今天天气」「你是谁」。

边界示例（照这个判）：
「茅台为什么取这个名字」→ chat
「茅台名字是怎么来的」→ chat
「茅台流通市值是多少」→ lookup
「茅台 PE 是多少」→ lookup
「巴菲特提过几次保险浮存金」→ quote
「茅台跌了你怎么看」→ judgment
「茅台现在该不该买」→ judgment
「可口可乐哪年上市的」→ lookup

规则：
- 追问按追问本身判，别被上一句带偏。
- 起名/来历/名字由来（「为什么叫」「为什么取」「名字是怎么来的」「命名的由来」）一律 chat，不管主语是不是股票或公司。
- 「XX 是多少」「XX 出现过几次」「XX 哪年成立」是 lookup。
- 「该不该买」「值不值」「会不会涨」「你怎么看」是 judgment。
- 拿不准是不是要翻他原话时，归 quote。`;
  const usr = '读者说：' + String(message || '').slice(0, 600) +
    (wantMode === 'simulate' ? '\n（读者当前在「问分身」模式，但以这句话本身为准，模式只作弱参考）' : '');
  const r = await fetch(DEEPSEEK, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-flash',
      messages: [{ role: 'system', content: sys }, { role: 'user', content: usr }],
      temperature: 0, max_tokens: 12, stream: false,
    }),
  });
  if (!r.ok) throw new Error('分类服务返回 ' + r.status);
  const j = await r.json();
  const t = ((j.choices && j.choices[0] && j.choices[0].message.content) || '').toLowerCase();
  const hit = BUCKETS.find(b => t.indexOf(b) >= 0);
  if (!hit) throw new Error('分类结果无法识别：' + t);
  return hit;
}
/* 答案里的引用标记 [[信|段]] / [[web|url]] —— 判「引用存不存在」就从这里下手。
   注意「信」那一截是信件 id（形如「2018 巴菲特致股东信」），不是数字下标。 */
/* URL 型引用标记的类别：[[web|…]] 通用网页、[[quote|…]] 行情/财报、[[news|…]] 资讯。
   三类都是「label|url」，只是胶囊长相不同；letter 仍是「label|数字段号」。 */
const CITE_RE = /\[\[([^|\]]+)\|(\d+)\]\]|\[\[(web|quote|news)\|([^\]]+)\]\]/g;
function parseCites(text) {
  const out = []; let m;
  CITE_RE.lastIndex = 0;
  while ((m = CITE_RE.exec(text))) {
    out.push(m[4] !== undefined ? { kind: m[3], url: m[4] } : { kind: 'letter', l: m[1], b: +m[2] });
  }
  return out;
}
/* 一条 source 的「标记原文」与「去重键」。letter 与 URL 型统一从这里产出，
   免得 source 过滤、来源清单、citeBag 三处各写一套。 */
function sourceMark(x) {
  return x.kind === 'letter' ? '[[' + x.l + '|' + x.b + ']]' : '[[' + x.kind + '|' + x.url + ']]';
}
function sourceKey(x) {
  return x.kind === 'letter' ? x.l + '|' + x.b : x.kind + '|' + x.url;
}

/* 引用胶囊的“长相”：类别、符号、名字都在这里定，前端只管照着画。
   标记本身仍然是 [[信|段]] / [[web|url]]，一个字都不改 —— 判分器和旧 trace 都认这个格式。
   分不出类别的走 other，绝不因为猜类别而丢掉一条引用。 */
const CITE_KINDS = {
  letter:  { icon: '📜', name: '致股东信', cls: 'letter' },
  partner: { icon: '🤝', name: '合伙人信', cls: 'partner' },
  speech:  { icon: '🎤', name: '演讲访谈', cls: 'speech' },
  memo:    { icon: '📝', name: '致辞短文', cls: 'memo' },
  web:     { icon: '🌐', name: '网络来源', cls: 'web' },
  quote:   { icon: '📈', name: '行情/财报', cls: 'quote' },
  news:    { icon: '📰', name: '资讯', cls: 'news' },
  case:    { icon: '🎬', name: '案例', cls: 'case' },
  other:   { icon: '🔖', name: '资料', cls: 'other' }
};
function citeKindOf(label) {
  const s = String(label || '');
  if (s === 'web') return 'web';
  if (s === 'quote') return 'quote';
  if (s === 'news') return 'news';
  if (s.indexOf('sc-') === 0 || s.indexOf('rule-') === 0 || s.indexOf('corr-') === 0) return 'case';
  if (/致合伙人信|合伙人信/.test(s)) return 'partner';
  if (/致股东信|致股东的信/.test(s)) return 'letter';
  if (/股东大会|年会|年度大会/.test(s)) return 'speech';
  if (/演讲|访谈|对话|问答/.test(s)) return 'speech';
  if (/致辞|短文|序言|过去现在与未来|副董事长的思考/.test(s)) return 'memo';
  return 'other';
}
/* 一条引用标记 → 前端要的几个字段。year 只用来做胶囊上的短标签。 */
function citeMeta(label, ref) {
  const k = citeKindOf(label);
  const pack = CITE_KINDS[k] || CITE_KINDS.other;
  const s = String(label || '');
  const isUrl = k === 'web' || k === 'quote' || k === 'news';
  return {
    k: k, icon: pack.icon, name: pack.name, cls: pack.cls,
    year: (s.match(/\d{4}/) || [''])[0] || '',
    l: isUrl || k === 'case' ? '' : s,
    b: isUrl || k === 'case' ? 0 : (+ref || 0),
    url: isUrl ? String(ref || '') : ''
  };
}
/* 答案里出现过的引用标记（去重，保持出现顺序）。前端拿它把标记画成可点的符号。 */
function citeBag(text) {
  const out = [], seen = {};
  const re = /\[\[([^|\]]+)\|(\d+)\]\]|\[\[(web|quote|news)\|([^\]]+)\]\]/g;
  let m;
  while ((m = re.exec(String(text || '')))) {
    const key = m[0];
    if (seen[key]) continue;
    seen[key] = 1;
    const label = m[4] !== undefined ? m[3] : m[1];
    const ref = m[4] !== undefined ? m[4] : m[2];
    out.push(Object.assign({ key: key }, citeMeta(label, ref)));
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
    bucket: info ? (info.bucket || null) : null,
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
      const wantMode = q.mode === 'simulate' ? 'simulate' : 'archive';
      /* 每次都由分类调用判定四桶（judgment/lookup/quote/chat）；分类失败退回正则的 archive/simulate。 */
      let bucket;
      try {
        bucket = await classifyBucket(q.message, wantMode, apiKey);
      } catch (e) {
        bucket = triageMode(q.message, wantMode) === 'simulate' ? 'judgment' : 'quote';
        console.log('  [分诊] 分类器失败（' + e.message + '），退回正则：' + bucket);
      }
      const bucketHint = wantMode === 'simulate' ? 'judgment' : 'quote';
      if (bucket !== bucketHint) console.log(`  [分诊] 前端说 ${wantMode}，按问题内容改走 ${bucket}：${String(q.message).slice(0, 40)}`);
      const info = await runAgent({
        message: String(q.message || '').slice(0, 2000),
        session: String(q.session || 'default').slice(0, 40),
        /* 默认走快的那个：坐着聊天等 40 秒太长。想要更细的推理再选 pro。 */
        model: model,
        web: q.web !== false,
        mode: bucket,
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
