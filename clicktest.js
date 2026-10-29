/* 真实点击测试：自建最小 DOM，逐个点击每个可点元素，检查跳转是否真的发生、目标页是否真的有内容 */
const fs = require('fs'), vm = require('vm');

/* ============ 最小 DOM ============ */
const VOID = new Set(['input', 'br', 'hr', 'img', 'meta', 'link', 'area', 'base', 'col', 'source']);

class El {
  constructor(tag) {
    this.tag = tag; this.attrs = {}; this.childNodes = []; this.parent = null;
    this.style = {}; this.onclick = null; this.oninput = null; this.value = '';
    this.selectionStart = 0; this._html = '';
    const self = this;
    this.classList = {
      add: c => { self._cls().add(c); self._sync(); },
      remove: c => { self._cls().delete(c); self._sync(); },
      contains: c => self._cls().has(c),
      toggle: (c, on) => { const s = self._cls(); const v = (on === undefined) ? !s.has(c) : !!on; v ? s.add(c) : s.delete(c); self._sync(); return v; }
    };
    this.dataset = new Proxy({}, {
      get: (t, k) => self.attrs['data-' + kebab(k)],
      set: (t, k, v) => { self.attrs['data-' + kebab(k)] = String(v); return true; },
      has: (t, k) => ('data-' + kebab(k)) in self.attrs
    });
  }
  _cls() { return new Set((this.attrs.class || '').split(/\s+/).filter(Boolean)); }
  _sync() { this.attrs.class = [...this._cls()].join(' '); }
  get id() { return this.attrs.id || ''; }
  get tagName() { return this.tag.toUpperCase(); }
  get parentNode() { return this.parent; }
  get className() { return this.attrs.class || ''; }
  get children() { return this.childNodes.filter(n => n instanceof El); }
  get textContent() {
    return this.childNodes.map(n => (n instanceof El) ? n.textContent : n.text).join('');
  }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = v; this.childNodes = parseInto(v, this); }
  get href() { return this.attrs.href || ''; }
  setAttribute(k, v) { this.attrs[k] = v; }
  getAttribute(k) { return this.attrs[k]; }
  scrollIntoView() {}
  focus() {}
  setSelectionRange(a, b) { this.selectionStart = a; }
  matches(sel) { return matchOne(this, sel); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) { return queryAll(this, sel); }
  /* 模拟点击 */
  click() {
    const h = this.attrs.href;
    if (this.tag === 'a' && h && h.charAt(0) === '#') { DOC._nav(h); return; }
    if (this.tag === 'a' && h) return; // 外链不处理
    if (typeof this.onclick === 'function') this.onclick({ target: this });
  }
}
function kebab(k) { return String(k).replace(/[A-Z]/g, m => '-' + m.toLowerCase()); }

function parseAttrs(str) {
  const out = {};
  const re = /([^\s=/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m;
  while ((m = re.exec(str))) out[m[1].toLowerCase()] = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : (m[4] !== undefined ? m[4] : ''));
  return out;
}
function parseInto(src, parent) {
  parent.childNodes = [];
  const stack = [parent];
  const re = /<!--[\s\S]*?-->|<\/([a-zA-Z0-9]+)\s*>|<([a-zA-Z0-9]+)((?:"[^"]*"|'[^']*'|[^>])*?)(\/?)>/g;
  let last = 0, m;
  const top = () => stack[stack.length - 1];
  while ((m = re.exec(src))) {
    const text = src.slice(last, m.index);
    if (text) top().childNodes.push({ text: decode(text), parent: top() });
    last = re.lastIndex;
    if (m[0].startsWith('<!--')) continue;
    if (m[1]) { // 闭合
      const t = m[1].toLowerCase();
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === t) { stack.length = i; break; }
      }
      continue;
    }
    const tag = m[2].toLowerCase();
    const el = new El(tag);
    el.attrs = parseAttrs(m[3] || '');
    el.parent = top();
    top().childNodes.push(el);
    if (!VOID.has(tag) && !m[4]) stack.push(el);
  }
  const tail = src.slice(last);
  if (tail) top().childNodes.push({ text: decode(tail), parent: top() });
  return parent.childNodes;
}
function decode(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ');
}
function walk(root, fn) {
  fn(root);
  (root.childNodes || []).forEach(n => { if (n instanceof El) walk(n, fn); });
}
function matchOne(el, sel) {
  sel = sel.trim();
  const idm = sel.match(/^#([\w-]+)$/); if (idm) return el.id === idm[1];
  const clsm = sel.match(/^\.([\w-]+)$/); if (clsm) return el._cls().has(clsm[1]);
  const am = sel.match(/^\[([\w-]+)\]$/); if (am) return am[1] in el.attrs;
  const cm = sel.match(/^([a-zA-Z0-9]*)((?:[\.\[][^\.\[]+)*)$/);
  if (!cm) return false;
  const tag = cm[1];
  if (tag && el.tag !== tag) return false;
  const rest = cm[2];
  const re = /\.([^\[\s.]+)|\[([^\]\s]+)\]/g;
  let m;
  while ((m = re.exec(rest))) {
    if (m[1] && !el._cls().has(m[1])) return false;
    if (m[2] && !(m[2] in el.attrs)) return false;
  }
  return true;
}
function queryAll(root, sel) {
  sel = sel.trim();
  const parts = sel.split(/\s+/);
  let cur = [root];
  for (let i = 0; i < parts.length; i++) {
    const next = [];
    cur.forEach(r => walk(r, e => { if (e !== r && matchOne(e, parts[i])) next.push(e); }));
    cur = next;
  }
  return [...new Set(cur)];
}

/* ---- document ---- */
const DOC = {
  _root: null, _app: null, _byId: {},
  _nav(href) { LOC.hash = href; if (typeof WIN.onhashchange === 'function') WIN.onhashchange(); },
  getElementById(id) {
    let found = null;
    walk(this._root, e => { if (!found && e.id === id) found = e; });
    return found;
  },
  querySelector(s) { return this.querySelectorAll(s)[0] || null; },
  querySelectorAll(s) { return queryAll(this._root, s); }
};

/* ============ 载入页面 ============ */
const HTML = fs.readFileSync('site/index.html', 'utf8');
const appJs = [...HTML.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].pop()[1];
function lv(f, n) { const s = { window: {} }; vm.createContext(s); vm.runInContext(fs.readFileSync(f, 'utf8'), s); return s.window[n]; }
const CORE = lv('site/data-core.js', 'CORE'), LETTERS = lv('site/data-letters.js', 'LETTERS'), CONTENT = lv('site/data-content.js', 'CONTENT');

/* 初始 DOM：只解析 body 里的静态骨架 */
const bodySrc = HTML.slice(HTML.indexOf('<body>') + 6, HTML.indexOf('<footer>'));
DOC._root = new El('body');
DOC._root.childNodes = parseInto(bodySrc, DOC._root);
/* 关键：真实浏览器里 location.hash = x 会触发 hashchange，这里必须复现，否则 go() 看起来像死链 */
const LOC = { _h: '#/' };
Object.defineProperty(LOC, 'hash', {
  get() { return LOC._h; },
  set(v) { LOC._h = v; if (typeof WIN.onhashchange === 'function') WIN.onhashchange(); }
});
const WIN = { scrollTo(){}, onhashchange: null };
const errors = [];
const sandbox = {
  window: Object.assign(WIN, { CORE, LETTERS, CONTENT }),
  document: DOC, location: LOC, console: { log(){}, error: (...a) => errors.push(a.join(' ')), warn(){} },
  setTimeout: () => {}, prompt: () => '1', encodeURIComponent, decodeURIComponent,
  parseInt, Uint8Array, Math, Object, Array, String, Number, JSON, Proxy, Set, isNaN
};
sandbox.window.document = DOC; sandbox.window.location = LOC; sandbox.window.scrollTo = () => {};
vm.createContext(sandbox);
try { vm.runInContext(appJs, sandbox); } catch (e) { console.log('!! 脚本初始化就抛错:', e.message); process.exit(1); }

const app = DOC.getElementById('app');
if (!app) { console.log('!! 找不到 #app'); process.exit(1); }

/* ============ 测试驱动 ============ */
const ERR_MARK = ['找不到这封信', '没有这个实体', '没有这个概念', '没有这家公司', '没有匹配的公司', '没有匹配的规则'];
const BAD_MARK = ['[object Object]', 'undefined', 'NaN'];

function visit(h) {
  LOC.hash = h;
  try { vm.runInContext('render()', sandbox); } catch (e) { return { err: e.message }; }
  return { html: app.innerHTML };
}
function clickables() {
  const out = [];
  const seen = new Set();
  const push = e => { if (!seen.has(e)) { seen.add(e); out.push(e); } };
  queryAll(app, 'a[href]').forEach(e => { if (e.href.charAt(0) === '#') push(e); });
  ['[data-f]', '[data-p]', '[data-cy]', '[data-d]', '[data-jump]', '.yr', '.snip', '.ent', '.opt', '.pcard']
    .forEach(s => queryAll(app, s).forEach(e => { if (!('disabled' in e.attrs)) push(e); }));
  ['#t-en', '#t-up', '#t-dn', '#cc', '#rc'].forEach(s => { const e = DOC.getElementById(s.slice(1)); if (e && e.style.display !== 'none') push(e); });
  return out;
}
function desc(e) {
  const t = (e.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 34);
  return e.tag + (e.className ? '.' + e.className.split(' ')[0] : '') +
    (e.attrs.href ? '[' + e.attrs.href + ']' : '') + ' "' + t + '"';
}

const routes = ['#/', '#/score', '#/concept', '#/corr', '#/rules', '#/decide', '#/ents'];
const FULL = process.argv[3] === 'full';
// 抽样实体/概念/公司/信件/年份
const cos = Object.keys(CONTENT.companies);
const cps = Object.keys(CONTENT.concepts);
if (FULL) {
  cos.forEach(n => routes.push('#/co/' + encodeURIComponent(n)));
  cps.forEach(n => routes.push('#/c/' + encodeURIComponent(n)));
  const entCounts = CORE.companies.concat(CORE.concepts, CORE.people)
    .map(e => [e.name, e.kind, (CORE.mentions[e.name] || []).length])
    .sort((a, b) => b[2] - a[2]).slice(0, 25);
  entCounts.forEach(e => routes.push('#/e/' + e[1] + '/' + encodeURIComponent(e[0])));
  for (let y = 1957; y <= 2025; y++) routes.push('#/y/' + y);
  CORE.letters.forEach((l, i) => { if (i % 12 === 0) routes.push('#/l/' + encodeURIComponent(l.id)); });
} else {
  routes.push('#/co/' + encodeURIComponent(cos[0]), '#/co/' + encodeURIComponent('可口可乐'));
  routes.push('#/c/' + encodeURIComponent('护城河'), '#/c/' + encodeURIComponent(cps[0]));
  routes.push('#/e/companies/' + encodeURIComponent('可口可乐'), '#/e/concepts/' + encodeURIComponent('护城河'));
  routes.push('#/l/' + encodeURIComponent('1988 巴菲特致股东信'));
  routes.push('#/y/1957', '#/y/1988', '#/y/2025');
}

const fails = [], warns = [];
let clicks = 0, tested = 0;
const MAXPER = Number(process.argv[2] || 25);

routes.forEach(route => {
  const base = visit(route);
  if (base.err) { fails.push([route, '渲染抛错: ' + base.err]); return; }
  const nTotal = clickables().length;
  const n = Math.min(nTotal, MAXPER);
  for (let i = 0; i < n; i++) {
    const before = visit(route);
    if (before.err) continue;
    const els = clickables();
    const e = els[i];
    if (!e) continue;
    const d = desc(e);
    const href = e.attrs.href || '';
    const hadHandler = typeof e.onclick === 'function';
    const beforeHtml = app.innerHTML;
    tested++;
    try { e.click(); } catch (err) { fails.push([route + ' → ' + d, '点击抛错: ' + err.message]); continue; }
    clicks++;
    const after = app.innerHTML;
    const changed = after !== beforeHtml;
    // 1) 链接型：hash 必须真的变了
    if (href && href.charAt(0) === '#') {
      if (LOC.hash !== href) { fails.push([route + ' → ' + d, 'hash 未跳转: 期望 ' + href + ' 实际 ' + LOC.hash]); continue; }
    } else if (hadHandler) {
      if (!changed && e.attrs['data-cy'] === undefined) warns.push([route + ' → ' + d, '有 onclick 但页面无变化']);
      // 整块跳转同样要落到具体段落
      const j = e.attrs['data-jump'] || '';
      const jm = j.match(/[?&]b=(\d+)/);
      if (jm && after.indexOf('id="b' + jm[1] + '"') === -1) {
        fails.push([route + ' → ' + d, '整块跳转落地页找不到段落 #b' + jm[1]]);
      }
    } else {
      fails.push([route + ' → ' + d, '既无 href 也无 onclick —— 点了没反应']);
      continue;
    }
    // 2) 落地页必须是真内容
    const bad = ERR_MARK.filter(m => after.indexOf(m) !== -1);
    if (bad.length) { fails.push([route + ' → ' + d, '跳到空页: ' + bad.join('/')]); continue; }
    const txt = after.replace(/<[^>]*>/g, ' ');
    const bm = BAD_MARK.filter(m => txt.indexOf(m) !== -1);
    if (bm.length) fails.push([route + ' → ' + d, '落地页含 ' + bm.join('/')]);
    // 3) 带 ?b= 深链：落地页必须真的有那个段落，否则用户看到的是页面顶部
    const bm2 = href.match(/[?&]b=(\d+)/);
    if (bm2) {
      const bid = 'b' + bm2[1];
      if (after.indexOf('id="' + bid + '"') === -1) {
        fails.push([route + ' → ' + d, '落地页找不到目标段落 #' + bid]);
      }
    }
  }
  console.log('  ' + route.padEnd(46) + nTotal + ' 个可点元素, 抽测 ' + n);
});

console.log();
console.log('共点击 ' + clicks + ' 个元素, 覆盖 ' + routes.length + ' 个页面');
console.log('失败 ' + fails.length + ' 项:');
const seenF = new Set();
fails.forEach(([w, m]) => { const k = m.replace(/[\d"“”].*/, ''); if (seenF.has(k + m.slice(0, 40))) return; seenF.add(k + m.slice(0, 40)); console.log('  ✗ ' + w + '\n      ' + m); });
if (warns.length) { console.log('警告 ' + warns.length + ' 项:'); warns.slice(0, 12).forEach(([w, m]) => console.log('  ! ' + w + ' :: ' + m)); }
if (!fails.length) console.log('  全部通过');
process.exit(fails.length ? 1 : 0);
