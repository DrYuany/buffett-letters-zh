/* market.js — 结构化行情与财务数据层

   为什么单独一层：分身回答「今天的事」时，最缺的不是观点，是确切数字。
   以前只能联网搜，搜到的是新闻稿里的二手数字，还常常是旧闻。
   这一层直接拿交易所口径的行情和财报，模型拿到的就是可以写进句子的东西：
   现价多少、PE 多少倍、最近四个季度营收和净利各增了多少、毛利率有没有掉。

   数据来源（都是公开接口，不需要 key）：
   - 东方财富 quote / kline / 数据中心（A股、美股、港股、指数）
   - 蛋卷指数估值（主要宽基和行业指数的 PE/PB 及历史分位）

   两条纪律：
   1. 每个数字都带 asOf 和数据期间。拿不到就返回 ok:false 和原因，
      调用方必须如实说「没拿到」，不许让模型凭印象补。
   2. 单位在这里统一换算成人话（元/美元/港元、亿、%），不给模型留换算余地。
*/

const { fetchJSON, fetchText, UA } = require('./net');

const REF = 'https://quote.eastmoney.com/';
const TTL = 3 * 60 * 1000;          /* 行情缓存 3 分钟：同一轮回答里多次调用不重复打接口 */
const _cache = new Map();

async function httpJSON(url, ms = 9000) {
  return fetchJSON(url, { timeout: ms, headers: { Referer: REF, Accept: 'application/json, text/plain, */*' } });
}

/* ---------- 备用源：云端出口访问不了东财时用 ----------

   同一个接口，本机和云端拿到的完全不是一回事（2026-11-03 实测）：
   - searchapi 在云端回一段不相干的 JSONP（内容是「达利食品」的用户搜索结果，
     回调名里的时间戳还是 2023 年的），push2 / push2his 直接 socket hang up；
   - datacenter-web 和蛋卷是通的，所以财报、指数估值不受影响。
   腾讯和新浪在云端都正常。

   分工：找代码用新浪 suggest3，取行情用腾讯 qt.gtimg.cn，价格分位用新浪日线。
   腾讯的 PE(TTM)/PB/总市值和东财逐位对得上（茅台 22.18 / 6.72 / 18221.94 亿），
   但它只有一个 PE 口径，另外两个留空——不许拿同一个数冒充三个口径。 */

const GBK = (() => { try { return new TextDecoder('gbk'); } catch (e) { return null; } })();

async function rawText(url, headers, ms = 8000) {
  const r = await fetch(url, {
    headers: Object.assign({ 'User-Agent': UA }, headers || {}),
    signal: AbortSignal.timeout(ms),
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  const ct = r.headers.get('content-type') || '';
  /* 腾讯/新浪这两个接口是 GBK 且不带 charset，直接按 UTF-8 解会得到乱码 */
  if (GBK && !/utf-8/i.test(ct)) return GBK.decode(buf);
  return buf.toString('utf8');
}

function symOf(secid) {
  const m = /^([01])\.(\d{6})$/.exec(String(secid || ''));
  return m ? (m[1] === '1' ? 'sh' : 'sz') + m[2] : null;
}

async function sinaSuggest(q) {
  const t = await rawText('https://suggest3.sinajs.cn/suggest/type=11,12,15&key=' + encodeURIComponent(q),
    { Referer: 'https://finance.sina.com.cn' });
  const m = /"([^"]*)"/.exec(t);
  if (!m || !m[1]) return [];
  const out = [];
  for (const seg of m[1].split(';')) {
    const f = seg.split(',');
    if (f.length < 5 || !/^\d{6}$/.test(f[2] || '')) continue;
    const mk = /^sh/i.test(f[3]) ? '1' : /^sz/i.test(f[3]) ? '0' : '';
    if (!mk) continue;                       /* 只做 A 股，港股美股不在这里兜底 */
    out.push({ code: f[2], name: f[4] || f[0], secid: mk + '.' + f[2], cls: 'AStock',
      market: mk === '1' ? '沪A' : '深A', mktNum: mk });
  }
  return out;
}

async function tencentQuotes(list) {
  const pairs = list.map(it => [it, symOf(it.secid)]).filter(x => x[1]);
  if (!pairs.length) return list.map(it => ({ ...it, ok: false, err: '行情接口没有这只' }));
  const t = await rawText('https://qt.gtimg.cn/q=' + pairs.map(x => x[1]).join(','), { Referer: 'https://finance.qq.com' });
  const by = {};
  for (const line of t.split(';')) {
    const m = /v_(\w+)="([^"]*)"/.exec(line);
    if (!m) continue;
    const f = m[2].split('~');
    if (f.length > 46) by[m[1].slice(2)] = f;
  }
  const n = x => { const v = +x; return (x !== '' && isFinite(v)) ? v : null; };
  return list.map(it => {
    const f = by[it.code];
    if (!f) return { ...it, ok: false, err: '行情接口没有这只' };
    return {
      ...it, ok: true, src: 'tencent',
      name: f[1] || it.name,
      price: n(f[3]), prev: n(f[4]),
      chgPct: n(f[32]),                       /* 腾讯这个字段已经是百分数，不除 100 */
      high: n(f[33]), low: n(f[34]),
      mcap: n(f[45]) === null ? null : Math.round(n(f[45]) * 1e8),   /* 腾讯给的是亿元 */
      pe: null, peTTM: n(f[39]), peStatic: null,
      pb: n(f[46]),
      cur: 'CNY',
    };
  });
}

async function sinaBand(it, days = 1200, lastPx = null) {
  const sym = symOf(it.secid);
  if (!sym) return null;
  const t = await rawText('https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=' +
    sym + '&scale=240&ma=no&datalen=' + days, { Referer: 'https://finance.sina.com.cn' });
  const arr = JSON.parse(t);
  const row = arr.filter(x => x && isFinite(+x.close) && +x.close > 0);
  if (row.length < 12) return null;
  const vals = row.map(x => +x.close);
  /* 日线最后一条是上一个交易日。用今天现价顶掉它，分位才是「现在」的位置，
     否则盘中涨了 1% 还按昨收算，读数会系统性偏一格。 */
  const last = (lastPx != null && isFinite(lastPx) && lastPx > 0) ? +lastPx : vals[vals.length - 1];
  let lo = 0, hi = 0;
  vals.forEach((v, i) => { if (v < vals[lo]) lo = i; if (v > vals[hi]) hi = i; });
  return {
    label: '约 ' + Math.round(row.length / 240) + ' 年日线', n: row.length,
    last, pct: vals.filter(x => x <= last).length / vals.length,
    lo: vals[lo], loAt: row[lo].day.slice(0, 7),
    hi: vals[hi], hiAt: row[hi].day.slice(0, 7),
  };
}

function cached(key, ms, fn) {
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.t < ms) return Promise.resolve(hit.v);
  return fn().then(v => { _cache.set(key, { t: Date.now(), v }); return v; });
}

/* ---------- 单位 ---------- */

const num = x => (typeof x === 'number' && isFinite(x)) ? x : null;

/* 价格缩放：A 股 /100，美股港股 /1000。指数按 A 股口径。 */
function scaleOf(item) {
  return /AStock|Index|ABond/.test(item.cls) ? 100 : 1000;
}
function px(v, item) {
  const n = num(v);
  if (n === null) return null;
  return n / scaleOf(item);
}
function bigMoney(n, cur) {
  if (num(n) === null) return null;
  const unit = cur === 'USD' ? '美元' : cur === 'HKD' ? '港元' : '元';
  if (Math.abs(n) >= 1e12) return (n / 1e12).toFixed(2) + ' 万亿' + unit;
  if (Math.abs(n) >= 1e8) return (n / 1e8).toFixed(2) + ' 亿' + unit;
  if (Math.abs(n) >= 1e4) return (n / 1e4).toFixed(2) + ' 万' + unit;
  return n.toFixed(0) + ' ' + unit;
}

/* ---------- 名称 / 代码 → 标的 ---------- */

const CODE_RE = /^\d{6}$/;
const US_RE = /^[A-Z][A-Z.]{0,5}$/;

/* 常见指数别名：用户不会说「SH000300」，也不会说「国证A指」 */
const INDEX_ALIAS = {
  '沪深300': 'SH000300', '沪深三百': 'SH000300', 'hs300': 'SH000300',
  '中证500': 'SH000905', '中证1000': 'SH000852', '上证50': 'SH000016',
  '创业板': 'SZ399006', '创业板指': 'SZ399006', '科创50': 'SH000688',
  '上证指数': 'SH000001', '上证综指': 'SH000001', '大盘': 'SH000001',
  '深证成指': 'SZ399001', '中证白酒': 'SZ399997', '白酒': 'SZ399997',
  '恒生科技': 'HKHSTECH', '恒生指数': 'HKHSI',
  '标普500': 'SPX', '纳斯达克': 'IXIC', '纳指': 'IXIC', '道琼斯': 'DJI',
};

async function suggest(q) {
  const url = 'https://searchapi.eastmoney.com/api/suggest/get?input=' + encodeURIComponent(q) +
    '&type=14&token=D43BF722C8E33BDC906FB84D85E326E8&count=8';
  const j = await httpJSON(url);
  const rows = (j && j.QuotationCodeTable && j.QuotationCodeTable.Data) || [];
  return rows.map(r => ({
    code: r.Code, name: r.Name, secid: r.QuoteID, cls: r.Classify,
    market: r.SecurityTypeName, mktNum: r.MktNum,
  })).filter(r => r.secid && !/Bond|Fund|ETF|Option|Warrant/.test(r.Classify || ''));
}

/* 找代码：东财优先，云端回空就换新浪。
   注意东财在云端不是报错，是回一段别的 JSONP——解析出来没有 Data 字段，
   等于静默返回空数组，所以必须按「空」降级，不能只 catch 异常。 */
async function resolveBy(q) {
  let g = [];
  try { g = await suggest(q); } catch (e) { g = []; }
  if (!g.length) { try { g = await sinaSuggest(q); } catch (e) { g = []; } }
  return g;
}

/* 返回候选数组。第一个是最可能的。 */
async function resolve(q) {
  const s = String(q || '').trim();
  if (!s) return [];
  const alias = INDEX_ALIAS[s] || INDEX_ALIAS[s.toLowerCase()];
  if (alias) return [{ code: alias, name: s, secid: 'idx:' + alias, cls: 'Index', market: '指数' }];

  /* 直接给了 6 位代码 */
  if (CODE_RE.test(s)) {
    const g = await resolveBy(s);
    const exact = g.find(x => x.code === s);
    if (exact) return [exact].concat(g.filter(x => x !== exact).slice(0, 3));
    const pre = s[0] === '6' ? '1' : '0';
    return [{ code: s, name: s, secid: pre + '.' + s, cls: 'AStock', market: 'A股' }];
  }
  /* 直接给了美股代码 */
  if (US_RE.test(s) && s.length <= 5 && /^[A-Z]+$/.test(s)) {
    const g = await resolveBy(s);
    const exact = g.find(x => String(x.code).toUpperCase() === s);
    if (exact) return [exact].concat(g.filter(x => x !== exact).slice(0, 3));
  }
  return (await resolveBy(s)).slice(0, 8);
}

/* ---------- 行情 ---------- */

/* 批量。items 来自 resolve。 */
async function quotes(items) {
  const list = items.filter(x => x && x.secid && !x.secid.startsWith('idx:'));
  if (!list.length) return [];
  const ids = list.map(x => x.secid).join(',');
  const url = 'https://push2.eastmoney.com/api/qt/ulist.np/get?secids=' + encodeURIComponent(ids) +
    '&fields=f2,f3,f12,f14,f15,f16,f18,f20,f9,f23,f114,f115';
  let diff = [];
  try {
    const j = await httpJSON(url);
    diff = (j && j.data && j.data.diff) || [];
  } catch (e) { diff = []; }
  if (!diff.length) {
    /* 云端对 push2 是直接断连（socket hang up），不是返回空 body */
    try { return await tencentQuotes(list); }
    catch (e) { return list.map(it => ({ ...it, ok: false, err: '行情没拿到：' + e.message })); }
  }
  const byCode = new Map(diff.map(d => [String(d.f12), d]));
  return list.map(it => {
    const d = byCode.get(String(it.code));
    if (!d) return { ...it, ok: false, err: '行情接口没有这只' };
    const cur = /美股|US/.test(it.market || '') ? 'USD' : /港股|HK/.test(it.market || '') ? 'HKD' : 'CNY';
    return {
      ...it, ok: true,
      name: String(d.f14 || it.name).replace(/(?<=[\u4e00-\u9fa5])\s+(?=[\u4e00-\u9fa5])/g, ''),
      price: px(d.f2, it), prev: px(d.f18, it),
      chgPct: num(d.f3) === null ? null : d.f3 / 100,
      high: px(d.f15, it), low: px(d.f16, it),
      mcap: num(d.f20),
      /* 三个 PE 口径差得不小（茅台 20.93 / 21.85 / 21.90），财经站和 MCP 通常用 TTM。
         全给出来，正文里说清用哪个，免得读者拿别的网站一对就以为算错了。 */
      pe: num(d.f9) === null ? null : d.f9 / 100,
      peTTM: num(d.f115) === null ? null : d.f115 / 100,
      peStatic: num(d.f114) === null ? null : d.f114 / 100,
      pb: num(d.f23) === null ? null : d.f23 / 100,
      cur,
    };
  });
}

/* 近 N 个月收盘价分位：回答「现在贵不贵」时，价格分位比 PE 更好拿也更直观 */
async function priceBand(item, months = 60, lastPx = null) {
  if (!item || !item.secid) return null;
  if (item.secid.startsWith('idx:')) return null;
  try {
    const url = 'https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=' + encodeURIComponent(item.secid) +
      '&fields1=f1,f2,f3&fields2=f51,f53&klt=103&fqt=1&end=20500101&lmt=' + months;
    const j = await httpJSON(url);
    const ks = (j && j.data && j.data.klines) || [];
    const vals = ks.map(s => +(String(s).split(',')[1])).filter(x => isFinite(x) && x > 0);
    if (vals.length < 12) throw new Error('月线太少');
    const last = (lastPx != null && isFinite(lastPx) && lastPx > 0) ? +lastPx : vals[vals.length - 1];
    const below = vals.filter(x => x <= last).length;
    return {
      label: '近 ' + vals.length + ' 个月月线', n: vals.length, months: vals.length, last,
      pct: below / vals.length,
      hi: Math.max(...vals), lo: Math.min(...vals),
      hiAt: ks[vals.indexOf(Math.max(...vals))].split(',')[0],
      loAt: ks[vals.indexOf(Math.min(...vals))].split(',')[0],
    };
  } catch (e) {
    /* 云端 push2his 直接断连，改算新浪日线的分位 —— 口径从月线换成日线，
       文案要跟着换，不能拿日线冒充「60 个月月线」。 */
    try { return await sinaBand(item, 1200, lastPx); } catch (e2) { return null; }
  }
}

/* ---------- 财务 ---------- */

function periodOf(s) { return String(s || '').slice(0, 10); }

async function financialsA(code) {
  const url = 'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_LICO_FN_CPD' +
    '&columns=SECURITY_CODE,SECURITY_NAME_ABBR,REPORTDATE,TOTAL_OPERATE_INCOME,YSTZ,PARENT_NETPROFIT,SJLTZ,BASIC_EPS,WEIGHTAVG_ROE,XSMLL' +
    '&filter=' + encodeURIComponent(`(SECURITY_CODE="${code}")`) +
    '&sortColumns=REPORTDATE&sortTypes=-1&pageSize=5&source=WEB&client=WEB';
  const j = await httpJSON(url);
  const rows = (j && j.result && j.result.data) || [];
  return rows.map(r => ({
    period: periodOf(r.REPORTDATE),
    revenue: num(r.TOTAL_OPERATE_INCOME), revYoY: num(r.YSTZ),
    profit: num(r.PARENT_NETPROFIT), profitYoY: num(r.SJLTZ),
    grossMargin: num(r.XSMLL), roe: num(r.WEIGHTAVG_ROE), eps: num(r.BASIC_EPS),
    cur: 'CNY', scope: '累计',
  }));
}

async function financialsUS(secucode) {
  const url = 'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_USF10_FN_GMAININDICATOR' +
    '&columns=SECUCODE,SECURITY_NAME_ABBR,REPORT_DATE,REPORT_TYPE,OPERATE_INCOME,OPERATE_INCOME_YOY,' +
    'PARENT_HOLDER_NETPROFIT,PARENT_HOLDER_NETPROFIT_YOY,GROSS_PROFIT_RATIO,ROE_AVG,BASIC_EPS' +
    '&filter=' + encodeURIComponent(`(SECUCODE="${secucode}")`) +
    '&sortColumns=REPORT_DATE&sortTypes=-1&pageSize=5&source=WEB&client=WEB';
  const j = await httpJSON(url);
  const rows = (j && j.result && j.result.data) || [];
  return rows.map(r => ({
    period: periodOf(r.REPORT_DATE), label: r.REPORT_TYPE,
    revenue: num(r.OPERATE_INCOME), revYoY: num(r.OPERATE_INCOME_YOY),
    profit: num(r.PARENT_HOLDER_NETPROFIT), profitYoY: num(r.PARENT_HOLDER_NETPROFIT_YOY),
    grossMargin: num(r.GROSS_PROFIT_RATIO), roe: num(r.ROE_AVG), eps: num(r.BASIC_EPS),
    cur: 'USD', scope: '单季',
  }));
}

async function financialsHK(code) {
  const url = 'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_HKF10_FN_MAININDICATOR' +
    '&columns=ALL&filter=' + encodeURIComponent(`(SECURITY_CODE="${code}")`) +
    '&sortColumns=REPORT_DATE&sortTypes=-1&pageSize=4&source=WEB&client=WEB';
  const j = await httpJSON(url);
  const rows = (j && j.result && j.result.data) || [];
  return rows.map(r => ({
    period: periodOf(r.REPORT_DATE),
    revenue: num(r.OPERATE_INCOME), revYoY: num(r.OPERATE_INCOME_YOY),
    profit: num(r.HOLDER_PROFIT), profitYoY: num(r.HOLDER_PROFIT_YOY),
    grossMargin: num(r.GROSS_PROFIT_RATIO), roe: num(r.ROE_AVG), eps: num(r.BASIC_EPS),
    cur: 'HKD', scope: '累计',
  }));
}

async function financials(item) {
  try {
    if (item.secid.startsWith('idx:')) return [];
    if (/AStock/.test(item.cls)) return await financialsA(item.code);
    if (/UsStock/.test(item.cls)) return await financialsUS(item.code + '.O').then(r => r.length ? r : financialsUS(item.code + '.N'));
    if (/HKStock/.test(item.cls)) return await financialsHK(item.code);
  } catch (e) { return []; }
  return [];
}

/* ---------- 指数估值 ---------- */

let _eva = null;
async function indexEvaAll() {
  if (_eva && Date.now() - _eva.t < 10 * 60 * 1000) return _eva.v;
  const j = await httpJSON('https://danjuanfunds.com/djapi/index_eva/dj', 9000);
  const items = (j && j.data && j.data.items) || [];
  const v = items.map(x => ({
    code: x.index_code, name: x.name, pe: num(x.pe), pb: num(x.pb),
    pePct: num(x.pe_percentile), pbPct: num(x.pb_percentile),
    roe: num(x.roe), dy: num(x.yeild),
  }));
  _eva = { t: Date.now(), v };
  return v;
}

async function indexEva(codeOrName) {
  const all = await indexEvaAll();
  const s = String(codeOrName || '');
  const alias = INDEX_ALIAS[s] || INDEX_ALIAS[s.toLowerCase()];
  return all.find(x => x.code === s) || (alias && all.find(x => x.code === alias)) ||
    all.find(x => x.name === s) || all.find(x => s && (x.name.includes(s) || s.includes(x.name))) || null;
}

/* ---------- 给模型看的文本 ---------- */

function pctText(x, digits = 2) {
  if (num(x) === null) return null;
  return (x >= 0 ? '+' : '') + x.toFixed(digits) + '%';
}

function finBlock(fins, cur) {
  if (!fins || !fins.length) return '';
  const lines = fins.slice(0, 4).map(f => {
    const bits = [];
    if (num(f.revenue) !== null) bits.push(`营收 ${bigMoney(f.revenue, f.cur || cur)}` + (num(f.revYoY) !== null ? `（同比 ${pctText(f.revYoY, 1)}）` : ''));
    if (num(f.profit) !== null) bits.push(`净利 ${bigMoney(f.profit, f.cur || cur)}` + (num(f.profitYoY) !== null ? `（同比 ${pctText(f.profitYoY, 1)}）` : ''));
    if (num(f.grossMargin) !== null) bits.push(`毛利率 ${f.grossMargin.toFixed(1)}%`);
    if (num(f.roe) !== null) bits.push(`ROE ${f.roe.toFixed(1)}%`);
    return `  ${f.period}${f.scope === '单季' ? '（单季）' : ''}：` + bits.join('，');
  });
  return '\n财报（' + (fins[0].cur === 'USD' ? '美元' : fins[0].cur === 'HKD' ? '港元' : '人民币') +
    '，按报告期倒序）：\n' + lines.join('\n');
}

/* 主入口：一次把一个标的能拿到的都拿到，组装成模型能直接读的事实块 */
async function snapshot(q, opt = {}) {
  const at = new Date().toISOString().slice(0, 16).replace('T', ' ');
  let cands;
  try { cands = await resolve(q); }
  catch (e) { return { ok: false, err: '查代码失败：' + e.message, at }; }
  if (!cands.length) return { ok: false, err: `没有找到「${q}」对应的股票或指数。`, at };

  const it = cands[0];
  const isIdx = it.secid.startsWith('idx:') || /Index/.test(it.cls);

  if (isIdx) {
    const key = it.secid.startsWith('idx:') ? it.secid.slice(4) : it.code;
    const eva = await indexEva(key).catch(() => null);
    if (!eva) return { ok: false, err: `指数「${q}」的估值数据没拿到（蛋卷没收录这个指数）。`, at, cand: cands.slice(0, 4) };
    const lines = [
      `标的：${eva.name}（指数 ${eva.code}）`,
      `估值（${at}，来源：蛋卷指数估值）：`,
      eva.pe !== null && eva.pe > 0 ? `  PE ${eva.pe.toFixed(2)} 倍，处在历史 ${(eva.pePct * 100).toFixed(0)}% 分位` : '  PE 为负或缺失（成分股整体亏损）',
      eva.pb !== null && eva.pb > 0 ? `  PB ${eva.pb.toFixed(2)} 倍，历史 ${(eva.pbPct * 100).toFixed(0)}% 分位` : '',
      eva.roe ? `  成分股整体 ROE ${(eva.roe * 100).toFixed(1)}%` : '',
      eva.dy ? `  股息率 ${(eva.dy * 100).toFixed(2)}%` : '',
    ].filter(Boolean);
    return { ok: true, kind: 'index', item: it, eva, text: lines.join('\n'), at };
  }

  const qs = await quotes([it]).catch(e => [{ ...it, ok: false, err: e.message }]);
  const quote = qs[0];
  if (!quote || !quote.ok) return { ok: false, err: (quote && quote.err) || '行情没拿到', at, cand: cands.slice(0, 4) };

  const fins = opt.financials === false ? [] : await financials(it);
  const band = opt.band === false ? null : await priceBand(it, 60, quote.price);

  const L = [];
  L.push(`标的：${quote.name}（${quote.code} · ${quote.market || it.market}）`);
  L.push(`行情（${at}）：`);
  L.push(`  最新价 ${quote.price !== null ? quote.price.toFixed(2) : '—'} ${quote.cur === 'USD' ? '美元' : quote.cur === 'HKD' ? '港元' : '元'}` +
    (quote.chgPct !== null ? `，当日 ${pctText(quote.chgPct)}` : '') +
    (quote.high !== null && quote.low !== null ? `，当日区间 ${quote.low.toFixed(2)}–${quote.high.toFixed(2)}` : ''));
  if (quote.mcap) L.push(`  总市值 ${bigMoney(quote.mcap, quote.cur)}`);
  if (quote.peTTM !== null && quote.peTTM > 0) {
    L.push(`  PE ${quote.peTTM.toFixed(2)} 倍（TTM，滚动十二个月）` +
      (quote.pe !== null && quote.pe > 0 ? `；动态 ${quote.pe.toFixed(2)} 倍` : ''));
  } else if (quote.pe !== null && quote.pe > 0) {
    L.push(`  PE ${quote.pe.toFixed(2)} 倍（动态）`);
  }
  if (quote.pb !== null && quote.pb > 0) L.push(`  PB ${quote.pb.toFixed(2)} 倍`);
  if (band) {
    L.push(`价格位置（${band.label || ('近 ' + band.months + ' 个月月线')}，共 ${band.n || band.months} 个收盘价）：`);
    L.push(`  当前处在 ${(band.pct * 100).toFixed(0)}% 分位；区间 ${band.lo.toFixed(2)}（${band.loAt}）到 ${band.hi.toFixed(2)}（${band.hiAt}）`);
  }
  if (fins.length) L.push(finBlock(fins, quote.cur));
  if (opt.ann !== false && /AStock/.test(it.cls)) {
    const ann = await announcements(quote.code, 3).catch(() => []);
    if (ann.length) L.push('\n最近公告：\n' + ann.map(a => `  ${a.date}　${a.title}`).join('\n'));
  }

  return { ok: true, kind: 'stock', item: it, quote, fins, band, text: L.join('\n'), at, cand: cands.slice(0, 5) };
}

/* 一次比多家：模型问「它和同行比贵不贵」时用 */
async function compare(names) {
  const out = [];
  for (const n of names.slice(0, 6)) {
    const s = await snapshot(n, { financials: false, band: false }).catch(e => ({ ok: false, err: e.message }));
    s.query = n;
    out.push(s);
  }
  return out;
}

/* ---------- 新闻与公告 ---------- */

/* 东财资讯搜索。比通用搜索引擎强的地方：中文财经语境、带日期和媒体名，
   而且不会把三年前的旧闻当新闻端上来（按时间排序）。 */
async function news(q, n = 6) {
  const param = {
    uid: '', keyword: String(q || ''), type: ['cmsArticleWebOld'],
    client: 'web', clientType: 'web', clientVersion: 'curr',
    param: { cmsArticleWebOld: { searchScope: 'default', sort: 'time', pageIndex: 1, pageSize: Math.min(10, n) } },
  };
  const url = 'https://search-api-web.eastmoney.com/search/jsonp?cb=x&param=' + encodeURIComponent(JSON.stringify(param));
  /* 这个接口返回的是 JSONP（x({...})），不能直接当 JSON 解析 */
  const raw = await fetchText(url, { headers: { Referer: REF } });
  const body = raw.text.replace(/^[^(]*\(/, '').replace(/\)\s*;?\s*$/, '');
  const j = JSON.parse(body);
  const rows = (j && j.result && j.result.cmsArticleWebOld) || [];
  /* 这个搜索是关键词 OR，会混进完全不相干的稿子（搜「茅台 批价」能返回港股科技）。
     不硬删——中文财经新闻的标题常常只写「白酒」「龙头」，硬卡主体词会一条不剩；
     改成按命中词数沉底排序，噪音留在尾部，模型自己有判断力。 */
  const kws = String(q || '').split(/[\s,，、]+/).filter(x => x.length >= 2);
  const txt = r => String(r.title || '') + String(r.content || '');
  const scored = rows.map(r => ({ r, bonus: kws.filter(k => txt(r).includes(k)).length }));
  scored.sort((a, b) => b.bonus - a.bonus || String(b.r.date).localeCompare(String(a.r.date)));
  return scored.map(x => x.r).map(r => ({
    date: String(r.date || '').slice(0, 10),
    title: String(r.title || '').replace(/<[^>]+>/g, ''),
    media: r.mediaName || '',
    url: r.url || '',
    content: String(r.content || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 240),
  }));
}

/* 沪深公司公告。业绩预告、减持、问询函、诉讼——这些比新闻硬。 */
async function announcements(code, n = 5) {
  if (!/^\d{6}$/.test(String(code))) return [];
  const url = 'https://np-anotice-stock.eastmoney.com/api/security/ann?sr=-1&page_size=' + Math.min(10, n) +
    '&page_index=1&ann_type=A&client_source=web&stock_list=' + code;
  const j = await httpJSON(url);
  const list = (j && j.data && j.data.list) || [];
  return list.map(x => ({
    date: String(x.notice_date || '').slice(0, 10),
    title: String(x.title_ch || x.title || '').replace(/^[^:：]+[:：]/, '').trim(),
    column: (x.columns && x.columns[0] && x.columns[0].column_name) || '',
  }));
}

module.exports = { resolve, snapshot, compare, quotes, financials, indexEva, indexEvaAll, priceBand, news, announcements, bigMoney, pctText,
  /* 备用源单独导出：云端的东财是断的，本地测不到那条路径，直接单测这三个 */
  sinaSuggest, tencentQuotes, sinaBand };
