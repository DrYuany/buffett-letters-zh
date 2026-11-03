# 评测全链条完善 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把评测从"只评答案"补成"四桶 × 四环全覆盖"，让 lookup/chat 两个新桶不再裸奔，让意图路由/工具选择/循环这三个链路环节也有可复算的指标。

**Architecture:** 沿用项目既有的"机械判分优先、判分与跑批分离、trace 离线复算"三条原则。新增三样东西：①路由判分器（直测 `classifyBucket`/`triageMode`，零到极低成本）；②lookup/chat 答案契约判分器（仿 `check_sim.js` 的机械判据模式）；③跨桶的工具签名与循环预算（并入 `score.js`）。评测集按"补类型缺口优先于堆数量"扩充分身/回测/金标/真实四层。

**Tech Stack:** 零依赖 Node.js + JSONL 评测集 + SSE trace（沿用现状，不引入任何新依赖）。

---

## 前置假设（先确认，否则方案建在流沙上）

四桶路由代码（`classifyBucket` / `triageMode` / `BUCKETS = ['judgment','lookup','quote','chat']` / `systemPrompt` 的 lookup/chat 分支 / `runAgent` 的 bucket 逻辑 / trace 里的 `bucket` 字段）**当前在 working tree 里未提交**（另一个会话 Dr Yuan 在改）。

- 本方案假定这些代码已就位且已提交锁定。执行前第一步先确认四桶代码已 commit，否则后面每个判分器都会对不上。
- 方案中所有"修改 `agent.js`"都是在这个四桶代码之上改，不是重写。

---

## 一、覆盖矩阵（这是"完成"的完整定义）

四桶 × 四环。当前状态 → 目标状态：

| 桶 | 路由（该不该进这桶） | 工具（该调什么） | 循环（该几轮） | 答案（契约） |
|---|---|---|---|---|
| `judgment` 研判 | ❌ 无 | ⚠️ 稀疏 | ⚠️ 只记轮数 | ✅ check_sim.js |
| `quote` 考据 | ❌ 无 | ⚠️ 稀疏 | ⚠️ 只记轮数 | ✅ score.js |
| `lookup` 查数 | ❌ 无 | ❌ 无 | ⚠️ 只记轮数 | ❌ **新增** |
| `chat` 闲聊 | ❌ 无 | ❌ 无 | ⚠️ 只记轮数 | ❌ **新增** |

跨桶的两件：`classifyBucket` 的成本/延迟 ❌ 没进 trace；`triageMode` 降级路径 ❌ 没测（它只会落到 judgment/quote 两桶）。

**"完成" = 上面每个 ❌ / ⚠️ 都变成 ✅，外加评测集扩充到下文 Phase 4 的目标条数。**

---

## 二、文件结构

**新建：**
- `eval/cases-route.jsonl` — 路由探针 + gold 桶（约 30 条）
- `eval/cases-lookup.jsonl` — lookup 答案用例（约 15 条）
- `eval/cases-chat.jsonl` — chat 答案用例（约 10 条）
- `eval/route.js` — 路由判分器（直测 classifyBucket / triageMode / trace.bucket 对 gold）
- `eval/check_bucket.js` — lookup/chat 答案契约判分器（仿 check_sim.js）

**修改：**
- `agent.js` — 把 `classifyBucket` 的耗时/结果记进 trace（Phase 0）
- `eval/score.js` — 加跨桶工具签名 + 循环预算
- `eval/run_batch.js` — 装载 lookup/chat/route 三个新评测集
- `eval/report.js` — 输出路由/工具/循环新指标
- `eval/cases-sim.jsonl` — 分身扩到 ≥ 20 条（含反事实配对 + 港股美股）
- `eval/cases-real.jsonl` — 补 1956–1969 合伙人时期 + 多轮
- `_src/backtest.jsonl` — 回测平衡到 ≥ 40 条
- `eval/cases-gold.jsonl` + `agent.js` 的 `ALIAS` 表 — 补 40 条 needs_alias 的别名
- `eval/README.md`、`eval/基线报告.md` — 文档收尾

**不改：** `check_sim.js`、`score.js` 的 quote 机械判据（口径不动，保持旧基线可比）。

---

## Phase 0：把路由决策补进 trace（前置）

### Task 0.1: classifyBucket 的成本/延迟/结果进 trace

**Files:**
- Modify: `agent.js`（`emitSSE` 里调用 `classifyBucket` 处 + `buildTrace` 处）

- [ ] **Step 1: 在 `emitSSE` 里给 classifyBucket 计时**

`classifyBucket` 现在是 `emitSSE` 里、`runAgent` 之前的一次独立 fetch，没计时。在调用处包一层：

```js
const _r0 = Date.now();
let bucket;
try {
  bucket = await classifyBucket(q.message, wantMode, apiKey);
} catch (e) {
  bucket = triageMode(q.message, wantMode) === 'simulate' ? 'judgment' : 'quote';
  console.log('  [分诊] 分类器失败（' + e.message + '），退回正则：' + bucket);
}
const routeMs = Date.now() - _r0;   // 新增：路由耗时
```

把 `routeMs` 和 `bucket` 一起透传给 `runAgent` 的返回值，最终进 `info`。

- [ ] **Step 2: `runAgent` 返回路由信息**

`runAgent` 的 return 里已经加了 `bucket: mode`。再补一个由 ctx 传入的 `route_ms`（从 emitSSE 传进来），或者更简单——emitSSE 把 `route_ms` 直接写进 `info`：

```js
info.route_ms = routeMs;   // emitSSE 拿到 info 后补这一行（在 emit('done', info) 之前）
```

- [ ] **Step 3: `buildTrace` 落盘路由字段**

`buildTrace` 里 `bucket: info ? (info.bucket || null) : null` 已有。补：

```js
route_ms: info ? (info.route_ms || null) : null,
```

- [ ] **Step 4: 验证**

```bash
node --check agent.js
# 起服务，问一句，然后看 trace 行里有没有 bucket 和 route_ms
findstr /c:"\"bucket\"" eval\traces\2026-11-04.jsonl
findstr /c:"\"route_ms\"" eval\traces\2026-11-04.jsonl
```

Expected: 每行都有 `bucket`（judgment/lookup/quote/chat 之一）和 `route_ms`（数字）。

- [ ] **Step 5: Commit**

```bash
git add agent.js
git commit -m "feat(eval): classifyBucket 的结果与耗时进 trace，路由可观测"
```

---

## Phase 1：路由判分（最高优先，最便宜）

### Task 1.1: 建 cases-route.jsonl（路由探针 + gold 桶）

**Files:**
- Create: `eval/cases-route.jsonl`

每条格式：`{"id":"route-001","layer":"route","q":"…","gold":"lookup","note":"歧义点说明"}`

- [ ] **Step 1: 写探针**（覆盖四桶 + 关键歧义点，至少 30 条）

按桶分组，`gold` 标期望桶。以下为必含的骨架（执行时可按此扩）：

| id | q | gold | 为什么 |
|---|---|---|---|
| route-001 | 他怎么看回购股票？ | quote | 问过去，翻原话 |
| route-002 | 茅台现在这个价位该不该买？ | judgment | 今天 + 决策 |
| route-003 | 贵州茅台现在的市盈率是多少？ | lookup | 查一个数 |
| route-004 | 茅台为什么叫茅台？ | chat | 与投资无关的常识 |
| route-005 | 他提到过几次"护城河"？ | lookup | 查次数（易误判成 quote） |
| route-006 | "在别人贪婪时恐惧"出自哪封信？ | quote | 查出处（易误判成 lookup） |
| route-007 | 腾讯控股的市值是多少？ | lookup | 港股查数（测新数据源） |
| route-008 | 今天天气怎么样？ | chat | 纯闲聊 |
| route-009 | 1974 年和 2008 年他抄底时说法有什么不同？ | quote | 历史对比 |
| route-010 | 银行股股息率这么高，是不是比存银行划算？ | judgment | 比较型决策（triageMode 的 askDecide） |
| route-011 | 他是谁？ | chat | 身份闲聊 |
| route-012 | 伯克希尔现在现金储备多少？ | lookup | 需联网的实时数字 |
| route-013 | 他是不是说过永远不要卖出好公司？ | quote | 拿原文核对 |
| route-014 | 沪深300 现在贵不贵？ | judgment | 指数估值研判 |
| route-015 | 给我一个能买的股票代码 | judgment | 荐股（应判 judgment 后拒答，或 chat？）|
| route-016 | 什么是保险浮存金？ | quote | 概念解释（可能判 lookup，看 rubric）|
| route-017 | 苹果公司现在市值多少？ | lookup | 美股查数 |
| route-018 | 他这辈子最糟糕的决定是什么？ | quote | 认错档案 |
| route-019 | 吃了吗？ | chat | 寒暄 |
| route-020 | 比亚迪现在估值你买不买？ | judgment | 个股研判 |

> 注意 route-015/route-016 这类边界题：gold 不能拍脑袋定，要先人工想清楚"这句话到底该进哪个桶"，`note` 里写死理由。这是路由判分能不能成立的前提。

- [ ] **Step 2: 校验格式**

```bash
node -e "const l=require('fs').readFileSync('eval/cases-route.jsonl','utf8').trim().split('\n').filter(Boolean); l.forEach(x=>{const c=JSON.parse(x); if(!c.id||!c.q||!c.gold) throw new Error('字段不全 '+x)}); console.log('OK', l.length, '条')"
```

Expected: `OK 30 条`（无报错）。

### Task 1.2: 写 route.js（路由判分器）

**Files:**
- Create: `eval/route.js`

判分器仿 `gen_cases.js` 用 `vm.runInContext` 读 `agent.js`，把 `classifyBucket` / `triageMode` 抽出来直测（不跑整个 agent）。

- [ ] **Step 1: 抽函数 + 直测 triageMode（零成本，先跑）**

```js
// eval/route.js
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'agent.js'), 'utf8');
const ctx = { require, console, module: {}, process, __dirname: ROOT };
const vm = require('vm'); vm.createContext(ctx);
// 抽出 classifyBucket / triageMode / BUCKETS 的定义（用函数名定位，别用行号）
vm.runInContext(src + '\n;globalThis.__exp={classifyBucket,triageMode,BUCKETS};', ctx);
const { classifyBucket, triageMode, BUCKETS } = ctx.__exp;

// gold 映射：triageMode 只返回 archive/simulate
const TRIAGE_MAP = { archive: 'quote', simulate: 'judgment' };

async function main() {
  const cases = require('fs').readFileSync(path.join(__dirname,'cases-route.jsonl'),'utf8')
    .trim().split('\n').filter(Boolean).map(JSON.parse);
  const key = /* 读 _agent.key 或 ~/.buffett-agent.key，同 run_batch.js */;
  let ok = 0, n = 0; const conf = {};
  for (const c of cases) {
    n++;
    // 直测 triageMode（免费）
    const tri = TRIAGE_MAP[triageMode(c.q, 'archive')] || triageMode(c.q, 'archive');
    // 直测 classifyBucket（要 key；没 key 就跳过这层只报 regex 结果）
    let cls = tri;
    if (key) { try { cls = await classifyBucket(c.q, 'archive', key); } catch (e) { cls = '（分类器失败:'+e.message.slice(0,20)+'）'; } }
    const hit = cls === c.gold;
    if (hit) ok++;
    conf[c.gold] = conf[c.gold] || { n: 0, hit: 0, miss: [] };
    conf[c.gold].n++; if (hit) conf[c.gold].hit++; else conf[c.gold].miss.push(c.q);
    if (cls !== c.gold) console.log('✗ ' + c.id + ' 期望 ' + c.gold + ' 得 ' + cls + ' · ' + c.q);
  }
  console.log('\n路由准确率 ' + ok + '/' + n + ' = ' + (ok/n*100).toFixed(1) + '%');
  console.log('regex(免费) 与 classifier(花钱) 各跑一遍，分别统计');
}
main();
```

- [ ] **Step 2: 跑 triageMode 层（免费）**

```bash
node eval/route.js
```

Expected: 输出每桶的命中/漏判，以及总准确率。triageMode 层预期 **lookup/chat 全部判错**（因为它只有 quote/judgment 两个出口）——这本身就是要把"regex 兜不住 lookup/chat"这件事量化出来。

- [ ] **Step 3: 带 key 跑 classifyBucket 层**

同一条命令，有 key 时会自动加跑 classifier。Expected: classifier 准确率应显著高于 regex，lookup/chat 也能量到。

- [ ] **Step 4: Commit**

```bash
git add eval/cases-route.jsonl eval/route.js
git commit -m "feat(eval): 路由判分器 route.js + 30 条路由探针（四桶 gold）"
```

### Task 1.3: 端到端路由核对（trace.bucket 对 gold）

**Files:**
- Modify: `eval/run_batch.js`（装载 route 层）
- Modify: `eval/score.js`（读 `trace.bucket` 对 gold）

- [ ] **Step 1: run_batch 装 route 层**

在 `run_batch.js` 的 `loadCases` 之后加：

```js
if (SETS === 'all' || SETS === 'route') cases = cases.concat(loadCases('cases-route.jsonl'));
```

- [ ] **Step 2: 跑一小批 route（验证端到端 + 量 classifyBucket 成本）**

```bash
EVAL_NO_QUOTA=1 node agent.js &   # 后台起
node eval/run_batch.js --set route --limit 6 --run-id rt1
node eval/score.js --run-id rt1
```

Expected: trace 里有 `bucket`，score.js 能把 `trace.bucket` 与 `cases-route.jsonl` 的 gold 比对，输出端到端路由准确率 + 每条的平均 `route_ms`。

- [ ] **Step 3: Commit**

```bash
git add eval/run_batch.js eval/score.js
git commit -m "feat(eval): 端到端路由核对（trace.bucket 对 gold）+ route_ms 成本指标"
```

---

## Phase 2：lookup / chat 答案契约

### Task 2.1: 建 cases-lookup.jsonl + lookup 判据

**Files:**
- Create: `eval/cases-lookup.jsonl`
- Create: `eval/check_bucket.js`（lookup 判据 + chat 判据共用一个文件，仿 check_sim.js）

- [ ] **Step 1: 写 lookup 用例（约 15 条）**

每条：`{"id":"lk-001","layer":"lookup","q":"…","expect_tools":["market_snapshot"],"rubric":"…"}`

骨架（必含）：
- 茅台/宁德/比亚迪/腾讯/苹果 的 PE/市值/股价（A股 + 港股 + 美股，测新数据源）
- "他提到过几次 X"（expect count_mentions）
- 某公司哪年成立（expect web_search）
- 某年某信的主要数字（expect search_letters）

- [ ] **Step 2: 在 check_bucket.js 里写 lookup 机械判据**

lookup 的契约 = "一个数/一句事实 + 出处，不展开、不立场、不五段"。机械判据：

```js
function judgeLookup(d) {
  const t = String(d.answer || '').replace(/\[\[[^\]]+\]\]/g, '');
  const checks = [];
  const rec = (g, n, ok, detail) => checks.push({ group: g, name: n, ok: !!ok, detail: detail || '' });
  // 1. 有数字或事实（lookup 就该给出那个数）
  rec('lookup', '给出数字或事实', /\d/.test(t), t.slice(0, 40));
  // 2. 数字能溯源（复用 score.js 的 scoreNumTrace 逻辑，或抽成共享函数）
  // 3. 没出现五段标题（lookup 不该有五段结构）
  rec('lookup', '没有五段结构', !/【(?:我确实说过|现在的事实|我怎么量它|所以|我可能错在哪)】/.test(t), '');
  // 4. 没给立场（lookup 不该答"该不该买"）
  rec('lookup', '没有研判立场', !/(该不该买|值不值|建议(?:买|关注)|不买|买入)/.test(t), '');
  // 5. 长度短（1-4 句，< 400 字；超了是硬拉成研判）
  rec('lookup', '长度 ≤ 400 字', t.length <= 400, t.length + ' 字');
  return { checks, len: t.length, qid: d.qid || '' };
}
```

- [ ] **Step 3: 跑批 + 判分（小样）**

```bash
node eval/run_batch.js --set lookup --limit 4 --run-id lk1
node eval/check_bucket.js --run-id lk1
```

Expected: 输出 lookup 判据的通过率。judge 层（数字对不对、该答不答）在 `score.js --judge` 里补，rubric 要写"lookup 不因没引原文扣分"。

- [ ] **Step 4: Commit**

```bash
git add eval/cases-lookup.jsonl eval/check_bucket.js
git commit -m "feat(eval): lookup 桶答案用例 + 机械判据（数字/无五段/无立场/长度）"
```

### Task 2.2: 建 cases-chat.jsonl + chat 判据

**Files:**
- Create: `eval/cases-chat.jsonl`
- Modify: `eval/check_bucket.js`（加 chat 判据）

- [ ] **Step 1: 写 chat 用例（约 10 条）**

骨架（必含）：
- "今天天气怎么样" / "吃了吗" / "你是谁"（纯闲聊）
- "茅台为什么叫茅台"（常识，别硬拉回投资）
- "讲个笑话" / "用 yyds 夸我一句"（语体边界，应婉拒换语体）
- "帮我写封辞职信"（代写文书，应拒）

- [ ] **Step 2: 写 chat 机械判据**

chat 契约 = "自然闲聊，不查工具、不编引用、不硬拉投资"。机械判据：

```js
function judgeChat(d) {
  const t = String(d.answer || '');
  const checks = [];
  const rec = (g, n, ok, detail) => checks.push({ group: g, name: n, ok: !!ok, detail: detail || '' });
  // 1. 没有编 [[ ]] 引用（chat 不该有引用标记）
  rec('chat', '没有编引用标记', !/\[\[[^\]]+\]\]/.test(t), '');
  // 2. 没有工具调用（chat 应 tools=[]，0 次）
  const calls = (d.spans || []).filter(s => s.type === 'tool').length;
  rec('chat', '零工具调用', calls === 0, calls + ' 次');
  // 3. 没有硬拉回投资（不该出现"内在价值/护城河/安全边际"这些术语）
  rec('chat', '没有硬拉回投资', !/(内在价值|护城河|安全边际|能力圈|浮存金)/.test(t), '');
  // 4. 长度短
  rec('chat', '长度 ≤ 300 字', t.length <= 300, t.length + ' 字');
  return { checks, len: t.length, qid: d.qid || '' };
}
```

chat 的 judge 层要额外判"有没有把常识包装成他说过的话"、"语气自不自然"，写进 `score.js --judge` 的 rubric。

- [ ] **Step 3: 跑批 + 判分**

```bash
node eval/run_batch.js --set chat --limit 4 --run-id ch1
node eval/check_bucket.js --run-id ch1
```

- [ ] **Step 4: Commit**

```bash
git add eval/cases-chat.jsonl eval/check_bucket.js
git commit -m "feat(eval): chat 桶答案用例 + 机械判据（无引用/零工具/不硬拉投资）"
```

### Task 2.3: 接 report.js 输出 lookup/chat 指标

**Files:**
- Modify: `eval/report.js`

- [ ] 在报告里加一节"分桶答案契约"，汇总四个桶各自的机械判据通过率 + judge 均分，一屏看清 lookup/chat 是否达标。

```bash
git add eval/report.js
git commit -m "feat(eval): 报告新增分桶答案契约汇总"
```

---

## Phase 3：工具选择 + 循环预算（跨桶，机械）

### Task 3.1: 四桶工具签名 + 错工具罚则

**Files:**
- Modify: `eval/score.js`

- [ ] **Step 1: 定义每桶期望工具签名**

在 score.js 里加一个常量表：

```js
const BUCKET_TOOLS = {
  judgment: { must: ['market_snapshot', 'match_situation'],          // 研判必拿行情+尺子
              good: ['peer_compare', 'market_news'],                    // 可选
              bad: [] },
  lookup:    { must: [], good: ['market_snapshot','count_mentions','web_search','open_url'], bad: [] },
  quote:     { must: [], good: ['search_letters','talk_search','speech_search','concept_profile','company_timeline','corrections','stance_timeline','letter_outline','open_passage'], bad: [] },
  chat:      { must: [], good: [], bad: ['*'], zero: true },           // 零工具
};
```

- [ ] **Step 2: 判分函数**

```js
function scoreToolSig(trace) {
  const bucket = trace.bucket || (trace.mode === 'simulate' ? 'judgment' : 'quote');
  const used = (trace.spans || []).filter(s => s.type === 'tool').map(s => s.name);
  const sig = BUCKET_TOOLS[bucket];
  if (!sig) return { n: 0, ok: 0, rate: null };
  if (sig.zero) return { n: 1, ok: used.length === 0 ? 1 : 0, rate: used.length === 0 ? 1 : 0, used };
  // must 缺失 = 错；bad 命中 = 错
  const missMust = sig.must.filter(t => used.indexOf(t) < 0);
  const hitBad = sig.bad.filter(t => used.indexOf(t) >= 0);
  // 错工具罚则：研判题用 web_search 拿行情数字（二手）而不是 market_snapshot（一手）
  const usedWrong = bucket === 'judgment' && used.indexOf('market_snapshot') < 0 && used.indexOf('web_search') >= 0;
  const ok = missMust.length === 0 && hitBad.length === 0 && !usedWrong;
  return { n: 1, ok: ok ? 1 : 0, rate: ok ? 1 : 0, missMust, hitBad, usedWrong, used };
}
```

- [ ] **Step 3: 接入 score.js 汇总 + 验证**

把 `scoreToolSig` 加进每条 item 的 scores，agg 里加 `tool_sig_rate`。跑：

```bash
node eval/score.js --run-id rt1   # 用已有 trace 验证不报错
```

- [ ] **Step 4: Commit**

```bash
git add eval/score.js
git commit -m "feat(eval): 四桶工具签名 + 错工具罚则（研判必调行情+尺子）"
```

### Task 3.2: 四桶循环预算

**Files:**
- Modify: `eval/score.js`

- [ ] **Step 1: 每桶预算 + 异常告警**

```js
const BUCKET_BUDGET = {
  judgment: { maxRounds: 6, maxCalls: 16, minCalls: 4 },   // 已知 8-13 次
  lookup:    { maxRounds: 2, maxCalls: 3,  minCalls: 1 },
  quote:     { maxRounds: 6, maxCalls: 10, minCalls: 1 },
  chat:      { maxRounds: 1, maxCalls: 0,  minCalls: 0 },
};
```

判分逻辑：超出 max 记"过度循环"（浪费钱），低于 min 记"证据不足"（可能没查够）。这是"盯"不是"红"——单独报数，不硬判死。

- [ ] **Step 2: 接入汇总 + 验证 + Commit**

```bash
node eval/score.js --run-id rt1
git add eval/score.js
git commit -m "feat(eval): 四桶循环预算，抓过度循环与证据不足"
```

---

## Phase 4：评测集扩充（补类型缺口，不堆数量）

### Task 4.1: 分身扩到 ≥ 20 条（行业 + 决策类型）

**Files:**
- Modify: `eval/cases-sim.jsonl`

- [ ] 补行业多样性（现 6 条只有白酒/家电/银行/沪深300/创新药/拒答）：加科技、新能源车、地产、周期资源、消费电子、保险。补决策类型：贵了该卖、亏损该割、成长股估值、周期股。每条带 `rubric`。

### Task 4.2: 反事实一致性配对

**Files:**
- Modify: `eval/cases-sim.jsonl`

- [ ] 加"同一事件正反两问"的配对（测立场稳定性，README 里"还没做"的那项）。例：
  - `sim-pair-a`："公司宣布大额回购，但股价已在历史高位，你怎么看？"
  - `sim-pair-b`："同一家公司宣布大额回购，但股价已腰斩在历史低位，你怎么看？"
  判分器（check_sim.js 加一段）比对两问的"所以"结论是否在合理区间内一致（不是逐字一致，是方向一致）。

### Task 4.3: 港股/美股分身用例（验收新数据源）

**Files:**
- Modify: `eval/cases-sim.jsonl`

- [ ] 加 2-3 条港股/美股研判题（腾讯、苹果、特斯拉），验收 Phase 2 之前刚补的 `tencentSuggest`/`tencentQuotes`/`financialsHK`/`financialsUS`。注意：美股价格分位留空是已知边界，rubric 里别把"没有价格分位"判成失败。

### Task 4.4: 回测平衡到 ≥ 40 条

**Files:**
- Modify: `_src/backtest.jsonl`

- [ ] 补"看过没投/买了又卖/拒绝参与"的案例（README 自己点了：他一生"不投"远多于"投"）。目标把"买入"占比从 66% 再往下压，让方向一致率的判别力（kappa）继续提高。

### Task 4.5: 金标别名补齐

**Files:**
- Modify: `agent.js` 的 `ALIAS` 表
- Modify: `eval/cases-gold.jsonl`（重跑生成）

- [ ] 把金标里 40 条 `needs_alias` 的题，一条条对应到 `ALIAS` 表项（"股东导向"→原文用词、"伊藤忠商事"→"伊藤忠"等），然后：

```bash
node eval/gen_cases.js          # 重跑生成金标
node eval/score.js --mode retrieve   # 看 needs_alias 桶的 hit@6 是否上来（免费，3 秒）
```

### Task 4.6: 真实层补年份 + 多轮

**Files:**
- Modify: `eval/cases-real.jsonl`

- [ ] 补 1956–1969 合伙人时期的题（现在题目集中在 1970–2020）；多轮追问从 3 组 5 问加到 6 组以上。

---

## Phase 5：文档收尾

### Task 5.1: 更新 eval/README.md + 基线报告 + 看板

**Files:**
- Modify: `eval/README.md`
- Modify: `eval/基线报告.md`

- [ ] 把"看板五个数"扩成"五个红数 + 三个新链路指标"：
  - 新增看板：**路由准确率**（classifier + regex 两个数）、**工具命中率**（含错工具）、**循环预算命中率**。
  - README 补一节"四桶 × 四环覆盖矩阵"，讲清 lookup/chat 的判据。
  - 基线报告补一次"四桶全量基线"（judgment/quote/lookup/chat 各自一次全量跑批）。

```bash
git add eval/README.md eval/基线报告.md
git commit -m "docs(eval): 四桶全链条覆盖矩阵 + 看板扩到八个数"
```

---

## 验收标准（Definition of Done）

全部做完时，下面每条都应为真：

1. `node eval/route.js` 能输出四桶路由准确率（regex 层免费、classifier 层花钱，两个数分开）。
2. `node eval/check_bucket.js --run-id X` 能输出 lookup/chat 两桶的机械判据通过率。
3. `node eval/score.js --run-id X` 能输出工具命中率（含错工具）和循环预算命中率。
4. `agent.js` 的 trace 里每条都有 `bucket` 和 `route_ms`。
5. `cases-sim.jsonl` ≥ 20 条（含反事实配对 + 港股美股）；`backtest.jsonl` ≥ 40 条且买入占比继续下降；金标 40 条 needs_alias 有别名；real 层覆盖 1956–1969 + 更多多轮。
6. 四桶 × 四环覆盖矩阵里没有 ❌，⚠️ 全部转 ✅。
7. 一次全量跑批（judgment/quote/lookup/chat 四桶各一遍）跑通，报告里有分桶指标汇总。

---

## 风险与注意

- **并发**：另一个会话（Dr Yuan）在改 `agent.js`。任何改 `agent.js` 的任务，执行前先 `git log` 确认四桶代码已提交，避免在别人的未提交改动上再叠改。
- **花钱**：route/lookup/chat 的跑批都要真金白银。先 `--limit 4` 小样验证判分器无误，再全量。
- **口径一致**：judgment 判据以 `check_sim.js` 为准、quote 以 `score.js` 为准，**这两份不动**，只在它们旁边加 lookup/chat 的新判据，保持旧基线可比。
- **边界题别拍脑袋**：路由探针的 gold 标签必须先人工想清楚理由，`note` 写死，否则路由判分会变成"拿一个错答案去对另一个错答案"。
