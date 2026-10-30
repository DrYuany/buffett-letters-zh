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
  const N = DOCS.length, y0 = +opts.y0 || 0, y1 = +opts.y1 || 9999;
  const scored = [];
  for (let i = 0; i < N; i++) {
    const d = DOCS[i];
    if (d.y < y0 || d.y > y1) continue;
    const t = d.t;
    let s = 0;
    for (const tm of ts) {
      if (t.indexOf(tm.g) < 0) continue;
      let p = t.indexOf(tm.g), c = 0;
      while (p >= 0 && c < 4) { c++; p = t.indexOf(tm.g, p + tm.g.length); }
      const idf = Math.log(1 + N / (countCache(tm.g) + 1));
      s += idf * tm.w * (1 + Math.log(c));
    }
    if (s <= 0) continue;
    s = s / (1 + Math.log(1 + t.length / 140));
    if (/^[（(]\s*\d+\s*[)）]/.test(t) || !/[。！？…”」』]$/.test(t)) s *= 0.82;
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
async function readMemory() {
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
      name: 'remember',
      description: '把关于这位读者的重要信息长期记下来（背景、关注的公司、读信的目的、约定过的偏好），下回对话还记得。',
      parameters: { type: 'object', properties: { note: { type: 'string', description: '要记住的一句话，写清楚主语' } }, required: ['note'] }
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

async function toolCall(name, args) {
  switch (name) {
    case 'search_letters': {
      const picks = searchDocs(args.query, { y0: +args.year_from || 0, y1: +args.year_to || 9999, k: 6 });
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
      const heads = [];
      (L[lt.id] || { blocks: [] }).blocks.forEach((b, i) => { if (b.k === 'h' || b.k === 'h2') heads.push(`第 ${i} 段 ${b.t}`); });
      const top = (LT_MENTIONS[lt.id] || []).sort((a, b) => b.c - a.c).slice(0, 12).map(x => x.n);
      return {
        text: `${lt.title}（${lt.year} 年，共 ${lt.n} 段）\n小标题：\n${heads.slice(0, 40).join('\n') || '（这封信没有小标题）'}\n\n这一年反复提到：${top.join('、')}\n引用标记：[[${lt.id}|0]]`,
        sources: [{ kind: 'letter', l: lt.id, b: 0, y: lt.year }]
      };
    }
    case 'concept_profile': {
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
    case 'remember': {
      const note = String(args.note || '').trim();
      if (!note) return { text: '没有内容可记。' };
      const m = await readMemory();
      m.notes = (m.notes || []).filter(n => n.text !== note);
      m.notes.push({ t: nowStamp(), text: note });
      while (m.notes.length > 60) m.notes.shift();
      await fsp.writeFile(MEM_FILE, JSON.stringify(m, null, 1), 'utf8');
      return { text: '记下了：' + note };
    }
  }
  return { text: '没有这个工具：' + name };
}

/* ---------------- 系统提示词 ---------------- */
function systemPrompt(memNotes) {
  const mem = (memNotes || []).slice(-14).map(n => '- ' + n.text).join('\n');
  return `你是「巴菲特午餐会」的主持人。桌上摊着沃伦·巴菲特 ${C.meta.years[0]}-${C.meta.years[1]} 年写给合伙人和股东的 ${C.meta.letters} 封信原文（${Math.round(C.meta.chars / 10000)} 万字），只有工具能把它翻开给你看。

【铁律】
1. 凡是"他说过什么"，必须来自工具返回的原文，并且逐字引用。不许改写，不许用你的背景知识补句子。
2. 工具没给你原文，就不能说他讲过。宁可回答"这 ${C.meta.letters} 封信里没查到"，也不要替他把话补完。
3. 每段原文证据后面都跟它的引用标记（形如 [[1988 巴菲特致股东信|12]] 或 [[web|网址]]），照抄工具输出，一个字都不要改。
4. ${C.meta.years[1]} 年之后的事要用 web_search 查，答案里必须说清这是网络来源，不能和他信里写的话混在一起。
5. 数字（回报率、价格、年份、持股比例）一律来自工具输出，不得推算拼凑。

【工作方式】
- 你是 agent：自己决定查什么、查几次（上限 ${MAX_ROUNDS} 轮）。不要一次工具都不调用就去回答他讲过什么。
- 节奏：第一轮就把所有可能用得上的检索一次性并行发起（一次消息里调 2-4 个工具），不要一个一个排队等。第 4 轮起必须开始收尾，别再开新的检索。
- 第一轮证据不够可以换关键词再查，或改查概念档案、公司轨迹、认错档案。
- 读者是聪明但没有金融背景的人：术语第一次出现时补一句大白话解释。
- 结构：先一句结论，再铺原文证据，最后一句"所以这意味着什么"。控制在 600-900 字以内，写不完就挑最重要的说，宁短勿长。

【关于这位读者，你记得】
${mem || '（还没有。聊的过程中可以用 remember 工具记下他的背景和偏好）'}

今天是 ${nowStamp().slice(0, 10)}。`;
}

/* ---------------- DeepSeek 流式调用 ---------------- */
async function streamChat(payload, apiKey, onDelta) {
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
  let buf = '';
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
      if (d.content) { acc.content += d.content; if (onDelta) onDelta(d.content); }
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
    case 'remember': return '记下：' + a.note;
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
  if (!SESSIONS.has(id)) SESSIONS.set(id, { msgs: [], cited: {} });
  return SESSIONS.get(id);
}

async function runAgent(ctx) {
  const { message, session, model, web, emit, key } = ctx;
  /* 密钥由 emitSSE 按免费额度规则选好再传进来；这里只管报「确实没有」的情况 */
  const apiKey = key;
  if (!apiKey) throw new Error('这台机器上没有配置 DeepSeek 密钥。本机用就写进 ' +
    KEY_FILES.join(' 或 ') + '；公网访客请在页面上填自己的密钥。');

  const mem = await readMemory();
  const tools = web ? TOOLS : TOOLS.filter(t => t.function.name !== 'web_search' && t.function.name !== 'open_url');
  const s = getSession(session);
  s.msgs.push({ role: 'user', content: message });
  if (s.msgs.length > 16) s.msgs = s.msgs.slice(-16);

  const history = [{ role: 'system', content: systemPrompt(mem.notes) }].concat(s.msgs);

  let rounds = 0, calls = 0, final = null;
  const allSources = [];

  for (rounds = 1; rounds <= MAX_ROUNDS; rounds++) {
    const payload = { model, messages: history, tools, stream: true, max_tokens: 2400, temperature: 0.3 };
    /* 一边收 token 一边发给前端；万一这一轮改主意要去调工具，
       说明开头那半句话是"我来查查"之类的过场，用 reset 让前端把它抹掉。 */
    const acc = await streamChat(payload, apiKey, txt => emit('delta', { text: txt }));

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
      let res;
      try {
        res = await withTimeout(toolCall(tc.name, argsObj), 25000, tc.name + ' 超时');
      } catch (e) {
        res = { text: '工具出错：' + e.message };
      }
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
    const acc = await streamChat({ model: model, messages: history, stream: true, max_tokens: 2400, temperature: 0.3 }, apiKey, t => emit('delta', { text: t }));
    emit('usage', acc.usage || {});
    final = { content: acc.content, usage: acc.usage, truncated: acc.finish === 'length' };
  }

  const text = final.content || '';
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
  return { rounds: rounds, calls: calls, usage: final.usage };
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
        docs: DOCS.length, letters: C.meta.letters, models: ['deepseek-v4-pro', 'deepseek-flash'] };
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

function emitSSE(res, q, ip) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive'
  });
  const emit = (type, data) => { res.write('event: ' + type + '\ndata: ' + JSON.stringify(data) + '\n\n'); };
  (async () => {
    /* 这两个要活在 try 外面：catch 里退款时还用得上 */
    let vid = '', usedFree = false;
    try {
      emit('start', { model: q.model === 'pro' ? 'deepseek-v4-pro' : 'deepseek-flash' });
      /* ---- 选密钥 ----
         vid 是前端存在浏览器里的随机访客号；没带来就按 IP 记账。 */
      vid = String(q.vid || '').slice(0, 64) || ('ip:' + (ip || '?'));
      const byo = looksLikeKey(q.key) ? String(q.key).trim() : '';
      const own = await serverKey();
      let apiKey = null, keySource = 'none';
      if (own && (await freeLeft(vid)) > 0) {
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
        model: q.model === 'pro' ? 'deepseek-v4-pro' : 'deepseek-flash',
        web: q.web !== false,
        key: apiKey,
        emit: emit
      });
      emit('done', info);
    } catch (e) {
      /* 这一问没成，免费额度退回去 —— 不能让人白花一次 */
      if (usedFree) await refundFree(vid);
      emit('error', { message: e.message });
    } finally {
      res.end();
    }
  })();
}

/* 绑定地址：本机跑只听 127.0.0.1（外人碰不到你的密钥）；
   发布到线上时运行环境会注入 PORT，那时必须听 0.0.0.0，否则反代连不上。
   线上实例没有自带密钥，走访问者自带密钥，也不存在蹭额度的问题。 */
server.listen(PORT, DEPLOY ? '0.0.0.0' : '127.0.0.1', async () => {
  /* 这里必须真去读一次密钥：keyMode() 只看缓存，启动时缓存还是空的，会误报「未配置」 */
  const hasKey = !!(await serverKey());
  console.log('');
  console.log('「巴菲特午餐会」Agent 已就绪');
  console.log('  打开： http://' + (DEPLOY ? '<线上域名>' : '127.0.0.1:' + PORT) + '/index.html#/talk');
  console.log('  语料： ' + DOCS.length + ' 段 / ' + C.meta.letters + ' 封信 / ' + Math.round(C.meta.chars / 10000) + ' 万字');
  console.log('  密钥： ' + (hasKey ? '已配置 —— 每位访客免费 ' + FREE_PER_VISITOR + ' 问，之后用访客自己的密钥' : '未配置 —— 访问者需在页面上填自己的密钥'));
  console.log('');
});
