// 冒烟测试: 用 DOM 桩在 Node 里跑一遍前端脚本, 捕获真实运行时错误
const fs = require('fs');
const vm = require('vm');

const html = fs.readFileSync('site/index.html', 'utf8');
const blocks = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)];
if (!blocks.length) { console.error('没找到内联脚本'); process.exit(1); }
const appJs = blocks[blocks.length - 1][1];

function loadVar(file, name) {
  const src = fs.readFileSync(file, 'utf8');
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: file });
  return sandbox.window[name];
}

const CORE = loadVar('site/data-core.js', 'CORE');
const LETTERS = loadVar('site/data-letters.js', 'LETTERS');
const CONTENT = loadVar('site/data-content.js', 'CONTENT');
console.log('CORE 信件数:', CORE.letters.length, '| LETTERS 键数:', Object.keys(LETTERS).length);
console.log('实体:', CORE.companies.length, '公司', CORE.concepts.length, '概念', CORE.people.length, '人物');
console.log('记分牌:', CORE.scorecard.length, '| 决策卡:', CORE.decisions.length);
const nCo = Object.keys(CONTENT.companies || {}).length;
const nCp = Object.keys(CONTENT.concepts || {}).length;
const nTl = Object.keys(CONTENT.companies || {}).reduce((a, k) => a + (CONTENT.companies[k].timeline || []).length, 0);
const nPd = Object.keys(CONTENT.concepts || {}).reduce((a, k) => a + (CONTENT.concepts[k].periods || []).length, 0);
const nQt = Object.keys(CONTENT.concepts || {}).reduce((a, k) => a + (CONTENT.concepts[k].quotes || []).length, 0);
console.log('CONTENT: 公司', nCo, '(时间线', nTl, ') | 概念', nCp, '(分期', nPd, '/ 原话', nQt, ')');
console.log('  认错', (CONTENT.corrections || []).length, '条 /', (CONTENT.corrTopics || []).length, '主题 | 规则', (CONTENT.rules || []).length, '| 导引', (CONTENT.paths || []).length);

// DOM 桩
const store = {};
function mkEl(id) {
  return store[id] || (store[id] = {
    id, innerHTML: '', value: '', dataset: {}, selectionStart: 0,
    classList: { toggle(){}, add(){}, contains(){ return false; } },
    style: {}, onclick: null, oninput: null,
    focus(){}, setSelectionRange(){}, scrollIntoView(){}
  });
}
const document = {
  getElementById: mkEl,
  querySelectorAll: () => ({ forEach(){}, length: 0 }),
  documentElement: { style: {} },
  addEventListener(){},
  body: { tagName: 'BODY' },
};
const sandbox = {
  window: { CORE, LETTERS, CONTENT, scrollTo(){}, innerWidth: 1200 },
  document,
  location: { hash: '' },
  console,
  setTimeout: () => {},
  encodeURIComponent, decodeURIComponent, prompt: () => '1', parseInt,
  Uint8Array, Math, Object, Array, String, Number, JSON,
};
sandbox.window.onhashchange = null;
vm.createContext(sandbox);
vm.runInContext(appJs, sandbox, { filename: 'app.js' });
console.log('\n脚本加载: OK');

const routes = [
  ['/',                              '首页'],
  ['/ents',                          '实体总览'],
  ['/talk',                          '巴菲特午餐会'],
  ['/score',                         '① 记分牌'],
  ['/concept',                       '② 术语演化列表'],
  ['/corr',                          '③ 认错档案'],
  ['/rules',                         '④ 规则库'],
  ['/decide',                        '决策卡'],
  ['/c/护城河',                       '概念-护城河'],
  ['/c/内在价值',                     '概念-内在价值'],
  ['/c/保险业',                       '概念-保险业(裸年份分期)'],
  ['/c/复利',                         '概念-复利(带年字分期)'],
  ['/co/可口可乐',                    '公司-可口可乐'],
  ['/co/IBM',                        '公司-IBM'],
  ['/co/三井物产',                    '公司-三井物产(少数据)'],
  ['/l/1957 巴菲特致合伙人信',        '1957合伙人信'],
  ['/l/1988 巴菲特致股东信',          '1988股东信'],
  ['/l/2020 巴菲特致股东信',          '2020股东信'],
  ['/l/2025 感恩节致辞',              '2025特别信'],
  ['/e/companies/可口可乐',           '实体-可口可乐'],
  ['/e/concepts/护城河',              '实体-护城河'],
  ['/e/people/芒格',                  '实体-芒格'],
  ['/e/companies/伯克希尔哈撒韦',     '实体-高频伯克希尔'],
];
let fail = 0;
console.log('\n=== 路由渲染 ===');
for (const [hash, name] of routes) {
  try {
    sandbox.location.hash = '#' + hash;
    vm.runInContext('render()', sandbox);
    const out = store.app.innerHTML;
    const ok = out && out.length > 200;
    if (!ok) { fail++; console.log('  ✗', name, '内容过短', out.length); }
    else console.log('  ✓', name.padEnd(20), String(out.length).padStart(7), '字符');
  } catch (e) {
    fail++; console.log('  ✗', name, '抛错:', e.message);
  }
}

console.log('\n=== 内容抽查 ===');
function check(hash, must, label) {
  sandbox.location.hash = '#' + hash;
  vm.runInContext('render()', sandbox);
  const out = store.app.innerHTML;
  const hit = out.includes(must);
  if (!hit) fail++;
  console.log('  ' + (hit ? '✓' : '✗'), label.padEnd(22), hit ? '含「' + must.slice(0, 30) + '」' : '缺「' + must + '」');
}
function checkNot(hash, mustNot, label) {
  sandbox.location.hash = '#' + hash;
  vm.runInContext('render()', sandbox);
  const out = store.app.innerHTML;
  const hit = !out.includes(mustNot);
  if (!hit) fail++;
  console.log('  ' + (hit ? '✓' : '✗'), label.padEnd(22), hit ? '不含「' + mustNot + '」' : '仍残留「' + mustNot + '」');
}
// 阅读层（原有）
check('/l/1988 巴菲特致股东信', 'class="ent"', '实体高亮');
check('/l/2020 巴菲特致股东信', '<table', '表格渲染');
/* 第一版不做英文原文：原词对照按钮、enw 内联词、首页入口都应彻底消失 */
checkNot('/l/2020 巴菲特致股东信', 'class="enw', '英文锚点已移除');
checkNot('/l/2020 巴菲特致股东信', '原文字对照', '对照按钮已移除');
checkNot('/', '原文字对照', '首页入口已移除');
check('/talk', '巴菲特午餐会', '午餐会标题');
check('/talk', 'class="tp-topic', '午餐会话题卡');
check('/talk', '请教巴菲特一个问题', '午餐会输入框');
check('/', 'class="talk-banner', '首页午餐会入口');
check('/e/companies/可口可乐', '跨年出场', '实体页跨年追踪');
check('/decide', 'class="opt"', '决策卡选项');
// 第一步 记分牌
check('/score', '确定程度', '记分牌确定程度');
check('/score', '公司轨迹 · 人工档案', '记分牌公司网格');
check('/score', 'class="co"', '记分牌公司卡片');
check('/co/可口可乐', '跨年轨迹', '公司页年份轴');
check('/co/可口可乐', 'class="trow"', '公司页时间线行');
check('/co/可口可乐', 'class="ax', '公司页年份刻度');
// 第二步 术语演化
check('/concept', '个阶段', '术语列表阶段数');
check('/c/护城河', 'class="period"', '概念页分期块');
check('/c/护城河', '萌芽期', '概念页分期名');
check('/c/护城河', 'class="pline"', '概念页时间轴');
check('/c/护城河', 'class="quote"', '概念页原话');
check('/c/护城河', '常见误区', '概念页误区');
check('/c/复利', 'class="period"', '复利(带年字)分期');
check('/c/保险业', 'class="period"', '保险业(裸年份)分期');
// 第三步 认错档案
check('/corr', '按主题归档', '认错主题归档');
check('/corr', 'class="ci ', '认错条目');
check('/corr', '坦承', '认错分类标签');
// 第四步 规则库
check('/rules', 'class="rule"', '规则条目');
check('/rules', 'id="rq"', '规则库搜索框');
// 首页导引
check('/', '不知道从哪读起', '首页入门导引');
check('/', 'class="pcard"', '导引卡片');
check('/letters', '合伙人信', '信件总览');
check('/letters', '非信件', '1956协议标注');

// 搜索行为
console.log('\n=== 交互抽查 ===');
// 注意: render() 读 location.hash, 测搜索前必须先切到对应路由
function searchCheck(hash, js, cls, total, label) {
  try {
    sandbox.location.hash = '#' + hash;
    vm.runInContext(js + '; render();', sandbox);
    const out = store.app.innerHTML;
    const n = (out.match(new RegExp(cls, 'g')) || []).length;
    const ok = n > 0 && n < total;
    if (!ok) fail++;
    console.log('  ' + (ok ? '✓' : '✗'), (label + ' ' + n + '/' + total).padEnd(24), ok ? '过滤生效' : '过滤无效');
  } catch (e) { fail++; console.log('  ✗ ' + label + ' 抛错:', e.message); }
}
searchCheck('/rules', 'ruleQ = "回购"', 'class="rule"', (CONTENT.rules || []).length, '规则库搜"回购"');
searchCheck('/score', 'coQ = "可乐"', 'class="co"', nCo, '记分牌搜"可乐"');
vm.runInContext('ruleQ = ""; coQ = "";', sandbox);

console.log('\n失败项:', fail);
console.log(fail === 0 ? '冒烟测试通过' : '冒烟测试未通过');
process.exit(fail === 0 ? 0 : 1);
