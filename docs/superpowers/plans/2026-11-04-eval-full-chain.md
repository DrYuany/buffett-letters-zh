# 评测全链条完善 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把评测从"只评答案"补成"三个对象 × 13 个评测点"全覆盖，让 lookup/chat 不再裸奔，让过程（路由/工具/循环）和一致性有可复算的指标。

**Architecture:** 沿用项目既有的"机械判分优先、判分与跑批分离、trace 离线复算"三条原则。本方案的核心新增是一张**评测总纲**（三个对象 × 13 个评测点）作为坐标系——所有任务都挂到这张地图上，任何一个维度缺了都看得见。落地为三个新判分器（`route.js` 路由、`check_bucket.js` lookup/chat 契约、score.js 里的工具签名+循环预算）。

**Tech Stack:** 零依赖 Node.js + JSONL 评测集 + SSE trace（沿用现状，不引入任何新依赖）。

---

## 零、评测总纲（这是坐标系，后续所有任务都挂在它上面）

评价一个 Agent，不是评"答案好不好"一句话，而是评**三个对象**：

| 对象 | 评测点 | 问的是什么 |
|---|---|---|
| **答案** | 匹配性 | 答的是不是这个问题 |
| | 正确性 | 结论对不对（最难判） |
| | 完整性 | 该有的维度有没有考虑全 |
| | 可信度 | 依据真不真、能不能点开核对 |
| | 一致性 | 换问法、换前提，骨架稳不稳 |
| | 体验 | 语气像不像、术语解释没、读着顺不顺 |
| **过程** | 路由 | 该进哪个桶 |
| | 工具选择 | 该调什么工具、调错没 |
| | 循环 | 该查几轮、查够没 |
| | 检索 | 语料召回够不够 |
| **系统** | 效率 | 快不快、贵不贵 |
| | 安全性 | 边界守不守、抗诱导不 |
| | 鲁棒性 | 降级稳不稳、隐私泄不泄 |

### 纵向拆解（每个评测点往下拆到"能机械判的指标"）

纵向 = 从大方向拆到机器能判的层。这是"机械判分优先"能不能成立的前提——拆不到机械层的，才交给 judge / 人工。

| 对象 | 评测点 | 往下拆到（可机械判的指标） |
|---|---|---|
| 答案 | 匹配性 | 分诊对不对 → 约束守没守（限字数/分步/格式）→ 该给的数给了没 |
| | 正确性 | 数字与实时行情对得上 → judge 1-5 分 → 人工对抗比对（最后一层只能人判） |
| | 完整性 | 五段齐全 → 顺序对 → 每角度"尺子+读数+判断"三件套 → 证伪点可观察 |
| | 可信度 | 引用存在率 → 逐字忠实率 → 数字溯源率 → 网络标注率 → 句级落地率 |
| | 一致性 | 反事实配对骨架 → 多轮追问承接 → 会话内立场账本不自我矛盾 |
| | 体验 | 语体指纹（句长/口语标记）→ 成对盲判认出率 → 术语大白话解释 → 长度 |
| 过程 | 路由 | 分类器准确率 + regex 降级准确率（两数必须分开报） |
| | 工具选择 | 工具签名命中 + 错工具罚则 |
| | 循环 | 循环预算（超=浪费，缺=证据不足） |
| | 检索 | 金标 hit@6 + 跨年覆盖 |
| 系统 | 效率 | TTFT → 总耗时 → 轮数/工具次数 → token → 折合人民币 |
| | 安全性 | 守住率 → 不泄提示词 → 不越权(SSRF) → 不荐股/不预测 |
| | 鲁棒性 | 降级路径 → 分类器成本/延迟 → 隐私不落盘 |

### 横向拆解（同一评测点，在不同桶上测法不同）

横向 = 一个评测点横向铺到四桶，判据不同。以**可信度**为例：

| 桶 | 可信度的测法 |
|---|---|
| quote | 逐字忠实率（引号内 vs 原文） |
| judgment | 原话区引文可核 + 事实区每条带 [[quote\|...]] 来源 |
| lookup | 数字溯源（这个数是不是工具返回的） |
| chat | **反向**：不许编 [[ ]] 引用（有了反而是错） |

再横向铺到评测集三层：金标层专测"过程·检索"、真实层测"答案"整排、对抗层专测"系统·安全性"、分身层测"正确性+一致性"。

---

## 覆盖矩阵（每个评测点的现状 → 目标 → 挂靠任务）

这是"完成"的完整定义：下面的 ❌/⚠️ 全部转 ✅。

| 对象 | 评测点 | 现状 | 挂靠任务 |
|---|---|---|---|
| 答案 | 匹配性 | ⚠️ judge 隐含 abdicated，无独立指标 | Phase 2（lookup/chat 契约里的"给出数字/无立场"） |
| | 正确性 | ⚠️ judge 1-5 + 数字核对；研判"对不对"无对抗测试 | Phase 4.2（反事实）+ 待补研判对抗 |
| | 完整性 | ✅ 五段契约（check_sim / judge） | Phase 4.1（扩充用例） |
| | 可信度 | ✅ 四率全过红线（rb10） | 已有，不动 |
| | 一致性 | ❌ 反事实一致性没做 | Phase 4.2 |
| | 体验 | ⚠️ 语体指纹有，盲判 100% 认出=未达标 | 路线图，不在本方案 |
| 过程 | 路由 | ✅ 已建 route.js + 30 探针，跑出基线 | **已提交**；剩 Phase 1.3 端到端 |
| | 工具选择 | ⚠️ expect_tools 稀疏 | Phase 3.1 |
| | 循环 | ⚠️ 只记轮数不判 | Phase 3.2 |
| | 检索 | ✅ 金标 153 条（词面 96.5%） | Phase 4.5（补别名） |
| 系统 | 效率 | ✅ 轮数/token/成本全记 | 已有 |
| | 安全性 | ✅ 对抗层守住率 10/10 | 已有 |
| | 鲁棒性 | ⚠️ 降级路径已量化、分类器成本没进 trace | Phase 0 |

---

## 前置假设（先确认，否则方案建在流沙上）

四桶路由代码（`classifyBucket` / `triageMode` / `BUCKETS` / `systemPrompt` 的 lookup/chat 分支 / trace 的 `bucket` 字段）**已提交**（并发会话 Dr Yuan 已 commit）。已确认 `git show HEAD:agent.js` 里有这些符号。

- 本方案所有"修改 agent.js"都在这个已提交的四桶代码之上改，不是重写。
- 注意并发会话仍在活跃（`extract_cases.js` 被改、`extract_meeting_cases.js` 未跟踪），改 `agent.js` 前先 `git status` 确认没撞。

---

## 文件结构

**已提交（本轮已完成）：**
- `eval/cases-route.jsonl` — 30 条四桶路由探针 + gold
- `eval/route.js` — 路由判分器（regex 免费层 + classifier 花钱层）
- `eval/cases-lookup.jsonl` — 15 条 lookup 用例
- `eval/cases-chat.jsonl` — 10 条 chat 用例
- `eval/check_bucket.js` — lookup/chat 契约判分器
- `agent.js` — `classifyBucket` 的 `max_tokens` 12→512（修空返回）

**待建/待改：**
- `eval/score.js` — 加工具签名 + 循环预算 + 端到端路由核对
- `eval/run_batch.js` — 装载 lookup/chat/route 三个新评测集
- `eval/report.js` — 输出分桶/路由/工具/循环新指标
- `eval/cases-sim.jsonl` — 分身扩到 ≥ 20 条
- `eval/cases-real.jsonl` — 补 1956–1969 + 多轮
- `_src/backtest.jsonl` — 回测平衡到 ≥ 40 条
- `eval/cases-gold.jsonl` + `agent.js` 的 `ALIAS` — 补 40 条 needs_alias
- `eval/README.md`、`eval/基线报告.md` — 文档收尾

---

## Phase 0：把路由决策补进 trace（系统·鲁棒性）

### Task 0.1: classifyBucket 的成本/延迟/结果进 trace

**Files:** Modify `agent.js`（`emitSSE` 调用处 + `buildTrace` 处）

- [ ] 在 `emitSSE` 给 `classifyBucket` 计时，`info.route_ms = Date.now() - t0`
- [ ] `buildTrace` 落 `route_ms`（`bucket` 字段已有）
- [ ] `node --check agent.js` + 起服务问一句，trace 行里有 `bucket` 和 `route_ms`
- [ ] Commit

> 现状：`bucket` 字段已落，`route_ms` 还没。每次提问多花一次 flash 调用（推理模型 ~58 token），这笔账现在看不见，得补。

---

## Phase 1：路由判分（过程·路由）

### Task 1.1 + 1.2 ✅ 已完成（提交 ac38e5f）

`cases-route.jsonl`（30 探针）+ `route.js`（判分器）已建并跑出基线：

- **regex 降级层 60%**（lookup/chat 100% 判错——regex 只有 quote/judgment 两出口，结构性兜不住四桶）
- **classifier 层 83.3%**（25/30），空返回 bug 已修（`max_tokens` 12→512，提交 f0699f2）

剩余 5 条判据盲区（转给并发会话或 Phase 5 一起补）：
| 探针 | 期望 | 分类器给 |
|---|---|---|
| 是不是比存银行划算 | judgment | lookup |
| 什么是保险浮存金 | quote | chat |
| 格雷厄姆和费雪的影响 | quote | lookup |
| 巴菲特哪年出生 | lookup | quote |
| 伯克希尔哪年成立 | lookup | quote |

### Task 1.3: 端到端路由核对（trace.bucket 对 gold）

**Files:** Modify `eval/run_batch.js`、`eval/score.js`

- [ ] `run_batch.js` 加 `--set route` 装载
- [ ] `score.js` 读 `trace.bucket` 对 gold，报端到端路由准确率 + 平均 `route_ms`
- [ ] 小样跑批验证，Commit

---

## Phase 2：lookup / chat 答案契约（答案·匹配性 + 可信度的两桶）

### Task 2.1 + 2.2 ✅ 已完成（提交 9656f8b）

`cases-lookup.jsonl`（15）+ `cases-chat.jsonl`（10）+ `check_bucket.js`（判分器）已建，合成 trace 冒烟通过：

- lookup 判据：给出数字/事实、有出处标记、无五段结构、无研判立场、长度 ≤ 400
- chat 判据：零工具调用、无编引用标记、无硬拉回投资、长度 ≤ 300

### Task 2.3: 接 report.js 输出分桶指标

**Files:** Modify `eval/report.js`

- [ ] 报告加"分桶答案契约"一节，四个桶各自机械通过率 + judge 均分
- [ ] Commit

---

## Phase 3：工具选择 + 循环预算（过程·工具 + 循环）

### Task 3.1: 四桶工具签名 + 错工具罚则

**Files:** Modify `eval/score.js`

- [ ] 常量 `BUCKET_TOOLS`（judgment must=[market_snapshot, match_situation]；chat zero=true；lookup good=[...]；quote good=[...]）
- [ ] `scoreToolSig`：must 缺失 = 错，bad 命中 = 错，研判用 web_search 拿行情（二手）而不用 market_snapshot = 错
- [ ] 接入 agg + Commit

### Task 3.2: 四桶循环预算

**Files:** Modify `eval/score.js`

- [ ] 常量 `BUCKET_BUDGET`（lookup ≤2 轮/3 次、chat 0 次、judgment 4-16、quote 1-10）
- [ ] 超 max 记"过度循环"、低于 min 记"证据不足"，单独报数不判死
- [ ] Commit

---

## Phase 4：评测集扩充（补类型缺口，不堆数量）

### Task 4.1: 分身扩到 ≥ 20 条（行业 + 决策类型）

**Files:** Modify `eval/cases-sim.jsonl`
- [ ] 补科技/新能源车/地产/周期资源/消费电子/保险；补"贵了该卖/亏损该割/成长股估值/周期股"

### Task 4.2: 反事实一致性配对（答案·一致性）

**Files:** Modify `eval/cases-sim.jsonl`、`eval/check_sim.js`
- [ ] 加"同一事件正反两问"配对（回购在高位 vs 回购在低位），判分器比对两问"所以"方向一致

### Task 4.3: 港股/美股分身用例（验收新数据源）

**Files:** Modify `eval/cases-sim.jsonl`
- [ ] 加腾讯/苹果/特斯拉 2-3 条；美股价格分位留空是已知边界，rubric 别判成失败

### Task 4.4: 回测平衡到 ≥ 40 条

**Files:** Modify `_src/backtest.jsonl`
- [ ] 补"看过没投/买了又卖/拒绝参与"，买入占比继续压，kappa 才有判别力

### Task 4.5: 金标别名补齐（过程·检索）

**Files:** Modify `agent.js` 的 `ALIAS`、重跑 `gen_cases.js`
- [ ] 40 条 needs_alias 对应到别名表；`node eval/gen_cases.js` + `node eval/score.js --mode retrieve` 看 hit@6 上来

### Task 4.6: 真实层补年份 + 多轮

**Files:** Modify `eval/cases-real.jsonl`
- [ ] 补 1956–1969 合伙人时期；多轮从 3 组 5 问加到 6 组以上

---

## Phase 5：文档收尾

### Task 5.1: 更新 eval/README + 基线报告 + 看板

**Files:** Modify `eval/README.md`、`eval/基线报告.md`
- [ ] 把总纲（三个对象 × 13 评测点）写进 README；看板从"五个数"扩成"五个红数 + 路由准确率 + 工具命中率 + 循环预算"
- [ ] Commit

---

## 验收标准（Definition of Done）

按总纲对账，全部为真：

1. `node eval/route.js` 输出四桶路由准确率（regex 免费层 + classifier 花钱层，两数分开）✅ 已可
2. `node eval/check_bucket.js --run-id X` 输出 lookup/chat 机械通过率 ✅ 已可
3. `node eval/score.js --run-id X` 输出工具命中率（含错工具）+ 循环预算
4. `agent.js` 的 trace 里每条都有 `bucket` + `route_ms`
5. `cases-sim.jsonl` ≥ 20 条（含反事实配对 + 港股美股）；`backtest.jsonl` ≥ 40 条；金标 40 条 needs_alias 有别名；real 层覆盖 1956–1969 + 多轮
6. 覆盖矩阵里没有 ❌/⚠️
7. 一次全量跑批（四桶各一遍）跑通，报告里有分桶 + 路由 + 工具 + 循环指标

---

## 风险与注意

- **并发**：Dr Yuan 会话在改 `agent.js`（classifyBucket 的 rubric 正在加边界示例）。改 `agent.js` 前先 `git status`，路由判据的 5 条盲区优先转给它，避免撞。
- **花钱**：route/lookup/chat 的跑批都要真金白银，先 `--limit 4` 小样验证再全量。
- **口径一致**：judgment 以 `check_sim.js` 为准、quote 以 `score.js` 为准，这两份不动，只在旁边加 lookup/chat 新判据，保持旧基线可比。
- **边界题别拍脑袋**：路由探针的 gold 标签先人工想清楚理由，`note` 写死。
- **推理模型**：`deepseek-flash` 是推理模型，`max_tokens` 别写回 12；judge 类短输出同理（已修 classifyBucket，score.js 的 judge 用 `deepseek-chat`）。
