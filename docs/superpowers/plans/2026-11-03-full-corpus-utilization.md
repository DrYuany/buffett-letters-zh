# 会议/演讲语料全面入索引与知识结构 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把会议（87,439 段）和演讲（2,030 段）语料从「只在动态检索里」提升到「进索引、进知识结构」，并建立考据类 recall 标注集作为改前/改后的客观尺子。

**Architecture:** 沿用项目既有约定——确定性 ETL（不过 LLM）+ 字面 n-gram/tf-idf 检索 + 可复算验证脚本。索引层三处补丁是纯机械改动；知识结构层复用 `extract_speech_cases.js` 的「信号词过滤 + LLM 抽取 + 人工审」管线，把目标语料从演讲扩到会议，再回喂静态页。

**Tech Stack:** Node 18+（零依赖）、Python 3（标准库）、现有 `node` / `python` 验证脚本。

**关联 spec:** `docs/superpowers/specs/2026-11-03-full-corpus-utilization-design.md`

---

## ⚠️ 执行前必读

工作区有**未提交改动**（`agent.js`、`README.md`、`eval/check_sim.js`、`eval/judge.js`、`eval/基线报告.md`、`site/index.html`、`.workbuddy/memory/2026-11-03.md`）。这些是「研判模式」那批工作，**不属于本计划**，但本计划要改的 `agent.js` 正是其中之一。

纪律：
1. **不要 `git add .`**。每次提交只 `git add` 本计划明确改动的文件路径。
2. 每个 Task 的 commit 只包含该 Task 的文件。
3. 开始前先 `git status --short` 确认基线，全程不 `checkout`/`reset` 未提交文件。

---

## 文件结构总览

| 文件 | 动作 | 职责 |
|---|---|---|
| `meeting.js` | 修改 | 芒格段入索引 + 修 buf 不结算 bug |
| `agent.js` | 修改 | `searchDocs` 表格块 + `open_passage` 表格块 + `talk_search` 说话人标注 + 消费侧计数口径 |
| `build_mentions_aux.py` | 新建 | 扫会议/演讲 JSONL 生成实体出场（巴菲特+芒格，分开标） |
| `site/data-mentions.js` | 新建 | 会议/演讲实体出场（聚合索引，**不含全文**） |
| `site/index.html` | 修改 | 加载 data-mentions.js + 实体页渲染会议/演讲出场 |
| `eval/annotation.schema.json` | 新建 | 标注集条目 schema（可选，文档用） |
| `eval/cases-annotation.jsonl` | 新建 | 30–50 道考据题 + gold 命中段 |
| `eval/score_annotation.js` | 新建 | recall@4/6/MRR 评分脚本 |
| `extract_meeting_cases.js` | 新建 | 会议 LLM 抽取（镜像 extract_speech_cases.js） |
| `_src/meeting/cases.json` | 新建 | 会议 LLM 抽取产物 |
| `extract_content.py` | 修改 | 认错正则扩会议/演讲 |

---

## Phase 0：索引层三处补丁

### Task 1: 芒格 5,050 段入 `meeting.js` 索引 + `talk_search` 说话人标注

**Files:**
- Modify: `meeting.js:36-61`
- Modify: `agent.js:956-977`（`talk_search` case）

- [ ] **Step 1: 记录当前（错误）行为作为基线**

Run:
```bash
node meeting.js "商誉"
```
Expected: 返回的段落都是巴菲特的话，**没有任何「芒格」标注**；且 `_src/meeting/stats.json` 里 `paras_total 87439`、`buffett_paras 27136`，芒格 5,050 段不存在于 `SEGS`。

- [ ] **Step 2: 改 `meeting.js` 的 `load()`，让芒格段入索引并结算提问 buf**

把 `meeting.js` 第 36-57 行的循环体改为：

```js
for (const r of arr) {
  if (r.who === 'other') {
    if (r.text && r.text.length >= 8) buf.push(r.text);
    continue;
  }
  /* 巴菲特和芒格都是"答话人"，都要保留并配到同一条提问 */
  if ((r.who !== 'buffett' && r.who !== 'munger') || !r.text || r.text.length < 20) continue;
  if (buf.length) {
    lastAsk = pickAsk(buf);
    buf = [];
  }
  if (lastAsk) nAsk++;
  const prev = all[all.length - 1];
  if (prev && lastAsk && prev.ask === lastAsk && prev.r.text.length < 60) {
    prev.r = Object.assign({}, prev.r, { text: prev.r.text + ' ' + r.text });
    continue;
  }
  all.push({ r, ask: lastAsk });
}
```

把第 58-61 行的 `SEGS` 映射加上 `who`：

```js
SEGS = all.map(({ r, ask }) => ({
  y: r.y, session: r.session, ch: r.ch, title: r.title || '',
  ans: r.text, ask, who: r.who, src: 'meeting',
}));
```

- [ ] **Step 3: 验证芒格段已入索引**

Run:
```bash
node meeting.js "商誉"
```
Expected: `SEGS.length` 从约 18,400 涨到含芒格段（约 2 万+）；命令行打印的段落里出现芒格段的文本。再加一条临时打印确认：`node -e "console.log(require('./meeting').SEGS.filter(s=>s.who==='munger').length)"` 应为数千量级（原始 5,050 段经 `<20` 过滤与 `<60` 连续合并后略有减少，非精确值，重点是 > 0 且稳定）。

- [ ] **Step 4: 改 `agent.js` 的 `talk_search`，输出说话人标注**

把 `agent.js` 第 963-969 行的 `body` 拼接里 `他答：` 改为按 `who` 分支：

```js
const body = hits.map((x, i) =>
  `[${i + 1}] ${x.y} 年股东大会` +
  (x.session ? '（' + sess(x.session) + '）' : x.at ? '（' + mmss(x.at) + '）' : '') +
  (x.title ? ' · ' + x.title : '') + '\n' +
  (x.ask ? `股东问：${x.ask}\n` : '') +
  (x.who === 'munger' ? `芒格答：${x.ans}` : `他答：${x.ans}`)
).join('\n\n');
```

并把第 971 行返回头部那句注释补一句「其中可能有芒格在会上的回答，已标『芒格答』，引用时说清是谁说的」。

- [ ] **Step 5: 端到端验证归因**

Run:
```bash
node _agentcli.js "芒格怎么看商誉？" --flash --noweb
```
Expected: 答案里芒格的话被标成「芒格答」或文字注明「这是芒格在会上说的」，不冒充巴菲特。

- [ ] **Step 6: 提交**

```bash
git add meeting.js agent.js
git commit -m "feat(meeting): 芒格段入 talk_search 索引，输出标注说话人"
```

---

### Task 2: 信件表格 429 块入 `searchDocs` 索引（+ `open_passage` 兼容）

**Files:**
- Modify: `agent.js:49-57`（`loadData` 附近，新增 `blockText`）
- Modify: `agent.js:129-137`（`DOCS` 构造）
- Modify: `agent.js:807-810`（`open_passage` 上下文渲染）

- [ ] **Step 1: 记录当前（错误）行为**

Run:
```bash
node _bench_search.js "五年毛利率"
```
Expected: 「毛利率」类表格词命中为空（表格块因无 `t` 字段被 `<24` 过滤），作为改前基线。

- [ ] **Step 2: 在 `agent.js` 里新增与 `build.py` 等价的 `blockText`**

在 `loadData()` 之后（第 57 行 `const { C, L, CT } = loadData();` 下方）加：

```js
/* 与 build.py:491 block_text() / index.html blockText() 完全一致：
   表格块拼 head + rows，其余取 t */
function blockText(b) {
  if (b.k === 't') {
    const parts = (b.head || []).slice();
    for (const r of (b.rows || [])) parts.push(r.join(' '));
    return parts.join(' ');
  }
  return b.t || '';
}
```

- [ ] **Step 3: 改 `DOCS` 构造用 `blockText`**

把第 132 行 `const t = (b.t || '').replace(/\s+/g, ' ').trim();` 改为：

```js
const t = blockText(b).replace(/\s+/g, ' ').trim();
```

- [ ] **Step 4: 改 `open_passage` 兼容表格块**

把第 809 行 `around.push(\`第 ${i} 段：${(lt.blocks[i].t || '').slice(0, 700)}\`);` 改为用 `blockText`：

```js
around.push(`第 ${i} 段：${blockText(lt.blocks[i]).slice(0, 700)}`);
```

（同时检查第 792-795 行 `open_passage` 的小标题正文拼接处，若也有 `b2.t` 直接取值，一并换 `blockText(b2)`，避免表格当正文时为空。）

- [ ] **Step 5: 验证表格可被命中**

Run:
```bash
node _bench_search.js "五年毛利率"
node _agentcli.js "他信里五年毛利率那张表怎么说的？" --flash --noweb
```
Expected: 能命中表格块的原文（head+rows 拼出的数字），引用标记 `[[信|段号]]` 点开 `open_passage` 能看到表格内容而非空。

- [ ] **Step 6: 延迟回归**

Run:
```bash
node _bench_search.js
```
Expected: 信件检索中位延迟不劣化（基线 16.7 ms 量级）。

- [ ] **Step 7: 提交**

```bash
git add agent.js
git commit -m "feat(search): 信件表格块入索引，open_passage 兼容表格"
```

---

### Task 3: 实体倒排扩到会议+演讲

**Files:**
- Create: `build_mentions_aux.py`
- Create: `site/data-mentions.js`（产出）
- Modify: `site/index.html:1227-1262`（实体页渲染）
- Modify: `agent.js`（消费侧计数口径，可选）

- [ ] **Step 1: 写 `build_mentions_aux.py` 生成会议/演讲实体出场**

复用 `build.py` 的实体加载与 `SURF` 字面匹配逻辑，输入换成两份 JSONL，只扫 `who in {buffett, munger}`：

```python
# build_mentions_aux.py
# 输入: _src/meeting/meetings_zh.jsonl + _src/speech/speech.jsonl
# 输出: site/data-mentions.js  (window.MENTIONS_AUX)
# 归属: 只算巴菲特/芒格本人段(who 分开标)，股东提问/主持人/其他不算
import re, os, json, glob, ast

# 从 build.py 里 import 实体名单与 ALIAS（保持字面口径一致）
import importlib.util
spec = importlib.util.spec_from_file_location('build', 'build.py')
# 注意: 直接 import build.py 会执行其 ETL 主体；更稳妥是抽公共实体加载，
# 若嫌耦合，可把 build.py 的 load_entities/surfaces/ALIAS 复制一份到此文件（保持一致）
```

（实现时二选一：① 抽公共模块 `entities.py` 供 `build.py` 与本脚本共用；② 复制实体/别名加载。计划默认 ①，减少漂移。）

每条产出的形状（元组，紧凑）：

- 会议出场：`[year, session, ch, who]`，`who` 用 `'buffett'|'munger'`
- 演讲出场：`[year, venue, i, who]`

输出：
```python
aux = {
  'meeting': {name: [[y, session, ch, who], ...]},
  'speech':  {name: [[y, venue, i, who], ...]},
}
with open('site/data-mentions.js', 'w', encoding='utf-8') as f:
    f.write('window.MENTIONS_AUX = ' + json.dumps(aux, ensure_ascii=False, separators=(',',':')) + ';\n')
```

- [ ] **Step 2: 跑脚本并核对规模**

Run:
```bash
python build_mentions_aux.py
```
Expected: 打印每个实体的会议/演讲出场条数 TOP；「芒格」在会议里有大量出场（他本人发言被标 `who=munger`）。

- [ ] **Step 3: 前端加载新数据 + 实体页渲染会议/演讲出场**

`site/index.html`：
1. 在 `<script>` 引入处加 `data-mentions.js`（在 `data-content.js` 之后）。
2. `entity()` 函数（约 1227 行）在「跨年出场」区块后新增两小节：
   - 「会议出场（按年）」，渲染 `MENTIONS_AUX.meeting[name]`，每条显示 `年 上午/下午场` 或「谁说的」。
   - 「演讲出场（按年）」，渲染 `MENTIONS_AUX.speech[name]`，每条显示 `年 venue`。

渲染时不跳原文（会议全文不在页面），只展示「哪一年哪一场」；若会议/演讲有独立阅读页则加跳转（当前无，则先纯展示 + 年份）。

- [ ] **Step 4: 消费侧计数口径对齐（防打架）**

`agent.js` 的 `concept_profile` / `company_timeline`：
- 默认**保持「出现次数」仅信件**（不破坏现有回测与页面数字）。
- 新增一行「会议/演讲另有 N 段提及」（读 `MENTIONS_AUX`，若有）。

Run:
```bash
node _agentcli.js "商誉这个概念的档案" --flash --noweb
```
Expected: 概念档案里出现「会议/演讲另有 N 段提及」，与信件次数分开列，不混加。

- [ ] **Step 5: 回归现有断言**

Run:
```bash
node smoke.js --file
```
Expected: 内容断言不破（新数据文件加载不破坏现有页面）。

- [ ] **Step 6: 提交**

```bash
git add build_mentions_aux.py site/data-mentions.js site/index.html agent.js
git commit -m "feat(mentions): 实体倒排扩到会议+演讲，实体页展示会议/演讲出场"
```

---

## Phase 1：考据类标注集

### Task 4: 标注集格式 + 评分脚本

**Files:**
- Create: `eval/cases-annotation.jsonl`
- Create: `eval/score_annotation.js`

- [ ] **Step 1: 定条目 schema 并写进文档注释**

每条：
```jsonc
{
  "id": "ann-001",
  "question": "他怎么看商誉？",
  "corpus": "letter|meeting|speech",   // 期望命中哪一路
  "gold": [
    {"src":"letter","l":"1983 巴菲特致股东信","b":12},
    {"src":"meeting","y":1999,"session":"Morning_Session","ch":3,"who":"buffett"},
    {"src":"speech","y":1998,"venue":"佛罗里达大学","i":4}
  ]
}
```

- [ ] **Step 2: 写 `eval/score_annotation.js`**

脚本对每个 `id` 调对应检索（`searchDocs` / `MEETING.search` / `SPEECH.search`），取 top-k，与 `gold` 坐标比对：
- 命中判定：返回段落坐标与任一 gold 坐标相等（信件比 `l+b`，会议比 `y+session+ch`，演讲比 `y+venue+i`）。
- 指标：`recall@4`（top-4 命中 gold 数 / min(4, gold 数)）、`recall@6`、`MRR`（首个命中位置的倒数均值）。
- 输出 `eval/results/annotation-<run-id>.json` + 控制台汇总。

- [ ] **Step 3: 空标注集跑通脚本**

先放 1 条样例题跑通评分脚本（防空跑报错），确认指标计算正确。

- [ ] **Step 4: 提交评分脚本**

```bash
git add eval/score_annotation.js eval/cases-annotation.jsonl
git commit -m "feat(eval): 考据类标注集评分脚本（recall@4/6/MRR）"
```

---

### Task 5: 起草 30–50 道种子题

**Files:**
- Modify: `eval/cases-annotation.jsonl`

- [ ] **Step 1: 我按三路语料各出一批题，标好 gold**

覆盖：概念（商誉/护城河/浮存金…）、公司（可口可乐/IBM/中国石油…）、人物（芒格/格雷厄姆…）、认错（德克斯特/航空…）、表格数据（五年毛利率类）。
每题 2–5 个 gold，`corpus` 标明期望命中的路。至少 8 题刻意覆盖会议/演讲，验证①改后它们能被命中。

- [ ] **Step 2: 用户审题增删改**（阻塞点：等你过目）

- [ ] **Step 3: 对改前索引跑 baseline 并存档**

Run:
```bash
node eval/score_annotation.js --run-id baseline-before
```
Expected: 存档 `eval/results/annotation-baseline-before.json`。**注意**：此时①可能已改，若要纯「改前」数字，应在 Task 1-3 之前跑；若已在①之后，则 baseline 记为「改后」起点，另行说明。执行时以实际时序为准并标注。

- [ ] **Step 4: 提交**

```bash
git add eval/cases-annotation.jsonl eval/results/annotation-baseline-before.json
git commit -m "eval: 考据类标注集 30-50 题 + 改前基线"
```

---

## Phase 2：知识结构层扩展

### Task 6: 认错档案正则扩会议/演讲

**Files:**
- Modify: `extract_content.py:337-371`（或新脚本）

- [ ] **Step 1: 把 `CORR_PAT` 四类正则扫会议（巴菲特+芒格）与演讲（巴菲特）**

新增函数读 `meetings_zh.jsonl` / `speech.jsonl`，只扫本人段，产出条目对齐现有 `corrections`，加 `src: 'meeting'|'speech'` 与坐标。芒格的认错单列 `who: 'munger'`，**不进巴菲特的认错账本**（或进但页面标注「芒格说的」）。

- [ ] **Step 2: 跑抽取看召回与噪声**

Run:
```bash
python extract_content.py
```
Expected: 打印「认错档案」新增会议/演讲条数；抽看 20 条确认无寒暄误报（口语「我错了」可能混入，需 `pick_sentence` 取含触发词单句 + 必要时收紧正则）。

- [ ] **Step 3: 静态认错账本页渲染新来源**（`site/index.html` 认错页 + `agent.js` `corrections` 工具）

- [ ] **Step 4: 回归 + 提交**

```bash
node smoke.js --file
git add extract_content.py site/data-content.js site/index.html agent.js
git commit -m "feat(corrections): 认错档案扩到会议+演讲"
```

---

### Task 7: 规则库 + 记分牌 LLM 抽取（会议）

**Files:**
- Create: `extract_meeting_cases.js`（镜像 `extract_speech_cases.js`）
- Create: `_src/meeting/cases.json`（产出）
- Modify: `extract_cases.js`（并入 data-cases.js）

- [ ] **Step 1: 写 `extract_meeting_cases.js`**

镜像 `extract_speech_cases.js`：信号词过滤（correction/reject/sell/money/year）→ 只喂巴菲特段（芒格段单列，先不抽，留口子）→ LLM 抽 `kind/entity/judgment/situation/lesson/verdict/slots` → 回挂会议坐标 `src:{kind:'meeting',y,session,ch}`。会议标 `verbatim`（可逐字引，与演讲 notes 区分）。

- [ ] **Step 2: 先小批试跑看质量**

Run:
```bash
node extract_meeting_cases.js --limit 1
```
Expected: 产出若干条，抽看判断 `judgment` 是否真的是段落原话、`entity` 是否准确、`slots` 是否合理。质量不行先调信号词与 prompt，再跑全量。

- [ ] **Step 3: 全量跑 + 人工审**

Run:
```bash
node extract_meeting_cases.js
```
产出 `_src/meeting/cases.json`。人工审一遍（尤其 `kind=scorecard` 的 `entity` 与 `correction` 的归因）。

- [ ] **Step 4: `extract_cases.js` 并入 data-cases.js**

在 `extract_cases.js` 里加一段读 `_src/meeting/cases.json`，复用「同 judgment 前缀去重」，并入 `cases`（kind 用 rule/correction/scorecard）。

- [ ] **Step 5: 验证分身案例库可命中会议案例**

Run:
```bash
node extract_cases.js
node situation.js "公司宣布大额回购，但股价已经在历史高位" --k 3
```
Expected: `match_situation` 能返回含会议来源的案例。

- [ ] **Step 6: 回喂静态页**（规则库/记分牌页出现会议/演讲来源，带 `src` 标注）

- [ ] **Step 7: 提交**

```bash
git add extract_meeting_cases.js _src/meeting/cases.json extract_cases.js site/data-cases.js
git commit -m "feat(cases): 会议 LLM 抽取决策案例并入分身案例库"
```

---

## Phase 3：参数扫描 + 向量决策

### Task 8: 参数扫描

**Files:**
- Create: `eval/scan_params.js`（或扩展 `score_annotation.js` 支持参数矩阵）

- [ ] **Step 1: 对标注集跑网格扫描**（k ∈ {4,6,8}、长度系数 ∈ {140,200}、字权重变体、MAX_TOOLCALLS 边界）

- [ ] **Step 2: 输出参数 × recall@4/6/MRR 矩阵，标出最优组合**

- [ ] **Step 3: 提交扫描脚本与结果**

```bash
git add eval/scan_params.js eval/results/param-scan.json
git commit -m "eval: 标注集参数网格扫描"
```

### Task 9: 向量检索决策

- [ ] **Step 1: 在改后索引上，用标注集对比「字面检索 vs 字面+向量融合」**

- [ ] **Step 2: 输出结论**（是否值得上向量；约束回测年份截断、引用可解释不变；向量仅作字面 Top-k 全空时的补召回）

- [ ] **Step 3: 结论写进 `eval/基线报告.md`「要不要向量库」一节**

---

## 依赖与顺序

```
Task 1（芒格） → Task 2（表格） → Task 3（实体倒排）   —— 可并行，无互相依赖
Task 4/5（标注集）  —— 依赖 Task 1-3（标在正确索引上）
Task 6（认错）      —— 依赖 Task 3 的会议/演讲数据就位
Task 7（规则/记分牌）—— 依赖 Task 6 坐标体系；独立一批（花钱+审）
Task 8/9（参数/向量）—— 依赖 Task 5 标注集 + Task 1-3 改后索引
```

---

## 验证命令速查

```bash
node meeting.js "商誉"                      # 芒格段是否入索引、是否标注
node _bench_search.js                       # 检索延迟回归
node _agentcli.js "…" --flash --noweb       # 端到端归因/召回
node smoke.js --file                        # 内容断言
python build_mentions_aux.py                # 生成会议/演讲实体出场
python extract_content.py                   # 认错/规则/记分牌再抽取
node extract_cases.js                       # 分身案例库重建
node eval/score_annotation.js --run-id X    # recall@4/6/MRR
```
