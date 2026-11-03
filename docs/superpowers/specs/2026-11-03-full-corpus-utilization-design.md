# 设计文档：会议/演讲语料全面入索引与知识结构

- 日期：2026-11-03
- 状态：已评审（待用户复核后进入实现计划）
- 关联：`README.md`、`docs/AGENT.md`、`eval/README.md`、`eval/基线报告.md`

---

## 0. 摘要

项目现有四路语料（信件 10,835 块 / 会议 87,439 段 / 演讲 2,030 段 / 午餐会 380 段，共约 314 万字）。
信件被三层彻底利用（知识结构、检索索引、喂进上下文），但**会议和演讲在知识结构层是零参与**，且检索索引里
存在三处「材料根本没进索引」的过滤漏洞。

本文档规划四件事，把现有资料充分利用：

1. **索引层三处补丁**（芒格 5,050 段 / 信件表格 429 块 / 会议·演讲实体倒排）——确定性，成本近零。
2. **考据类标注集**（30–50 道题 + 必须命中段 + recall@4/6/MRR）——回答「改前改后有没有变好」的尺子。
3. **知识结构层扩展**（认错档案 / 规则库 / 记分牌扩到会议+演讲）——认错走确定性正则，规则+记分牌走 LLM 抽取 + 人工审。
4. **参数扫描 + 向量检索决策**——用标注集当尺子。

---

## 1. 背景：三层「用上」的诊断结论

「现有资料用上多少」要分三层看，结论各自独立：

### 第 1 层：构建知识结构时

| 数据 | 信件 | 会议 | 演讲 |
|---|---|---|---|
| 实体倒排（跨年出场） | ✅ 全扫含表格块 | ❌ | ❌ |
| 记分牌 | ✅ 手写 + 自动 | ❌ | ⚠️ 半参与（进分身案例库） |
| 规则库 | ✅ 概念原话 | ❌ | ⚠️ 半参与 |
| 认错档案 | ✅ 正则 4 类模式 | ❌ | ⚠️ 半参与 |

### 第 2 层：检索索引里装了什么

| 工具 | 收了什么 | 丢了什么 |
|---|---|---|
| `search_letters` | 信件 blocks | ① <24 字的块 ② 表格块（`agent.js` 只取 `b.t`，表格无 `t` 字段拿空串被过滤） |
| `talk_search` | 只收 `who==='buffett'` 且 ≥20 字 | **芒格 5,050 段全丢**（`meeting.js:41`） |
| `speech_search` | 全部 2,030 段 | 无 |

内部不一致：`build.py` 的实体倒排专门处理了表格块，`agent.js` 的搜索索引没处理。

### 第 3 层：喂进上下文

中位 11 次工具 × 每次 4–6 段 ≈ 56–84 段 ≈ 0.4%。检索是暴力扫全部索引，所有进了索引的段都有机会被选中，
这一层是架构限制，不算浪费。**真正的浪费在第 2 层的过滤，不在上下文。**

---

## 2. 目标与范围

### 做什么

- 工作流 ① 索引层三处补丁
- 工作流 ② 考据类标注集
- 工作流 ③ 知识结构层扩展（认错档案确定性 + 规则/记分牌 LLM+人工审）
- 工作流 ④ 参数扫描 + 向量决策

### 不做什么（本轮明确排除）

- 不新增语料来源（段永平分身、音频语料等，见 README 路线图，另立项）。
- 不上向量检索（④ 的结论可能是「暂不需要」，依据是标注集数据）。
- 不改判分口径（`eval/score.js`、`eval/check_sim.js` 现有红线不动）。
- 不碰研判模式的五段结构。

---

## 3. 现状：数据流与代码地图

### 3.1 语料清单（已核实数字）

| 语料 | 文件 | 段数 | 字 | 说话人 |
|---|---|---|---|---|
| 信件 | `site/data-letters.js`（`build.py` 产出） | 10,835 块（含表格） | 122 万 | 巴菲特 |
| 会议 | `_src/meeting/meetings_zh.jsonl`（`build_meeting_zh.py` 产出） | 87,439 = 27,136 巴菲特 + 5,050 芒格 + 55,253 其他 | 157 万 | 巴菲特/芒格/其他 |
| 演讲 | `_src/speech/speech.jsonl`（`build_speech.py` 产出） | 2,030 | 27 万 | 巴菲特/芒格/盖茨/其他 |
| 午餐会 | `site/data-talk.js` | 380 | 8 万 | 巴菲特（中译转述） |

### 3.2 生成管线

```
_src/buffett-letters ──build.py──────────▶ site/data-core.js（meta/entities/mentions/scorecard/decisions）
                                          └▶ site/data-letters.js（信件全文）
_src/buffett-letters ──extract_content.py─▶ site/data-content.js（concepts/companies/corrections/rules/scorecards/paths）
site/data-core.js ─────extract_cases.js───▶ site/data-cases.js（分身案例库：letter + speech cases 合并）
_src/meeting/html ────build_meeting_zh.py─▶ _src/meeting/meetings_zh.jsonl ──meeting.js──▶ 服务端内存（talk_search）
_src/speech/*.md ─────build_speech.py─────▶ _src/speech/speech.jsonl ──make_speech.js──▶ site/data-speech.js ──speech.js
_src/speech/speech.jsonl ──extract_speech_cases.js──▶ _src/speech/cases.json ──(extract_cases.js 并入)──▶ data-cases.js
```

### 3.3 检索索引（三处漏洞的精确位置）

- `agent.js:129-137`：`searchDocs` 构造 `DOCS` 时只取 `(b.t || '')`，表格块 `k==='t'` 只有 `head`/`rows`，无 `t` → 空串被 `< 24` 过滤。
- `meeting.js:36-56`：`load()` 只处理 `who==='other'`（提问缓存）和 `who==='buffett'`，`who==='munger'` 落到第 41 行 `continue` 被丢弃；且芒格段出现时未结算已缓存的提问 `buf`（配对错位 bug）。
- `build.py:190-212`：`mentions` 只扫 `LET`（信件），会议/演讲未参与。

### 3.4 知识结构两层

| 结构 | 静态页（`data-content.js`） | 分身案例库（`data-cases.js`） |
|---|---|---|
| 实体倒排 `mentions` | 只信件 | 不涉及 |
| 认错 `corrections` | 只信件（108 条，`extract_content.py` `CORR_PAT`） | 信件 + 演讲 |
| 规则 `rules` | 只信件（概念原话 quotes） | 信件 + 演讲 |
| 记分牌 `scorecards` | 只信件（15 手写 + 46 自动） | 信件 + 演讲 |

演讲的半参与靠 `extract_speech_cases.js`：信号词过滤（correction/reject/sell/money/year）→ LLM 抽
judgment/kind/entity/situation/lesson/verdict/slots → 回挂来源坐标 → 人工可审。**这是 ③ 的既有模板。**

---

## 4. 工作流 ① 索引层三处补丁（确定性）

### 4.1 芒格 5,050 段入索引

**文件**：`meeting.js`、`agent.js`

**改动**：
1. `meeting.js` `load()`：`who==='munger'` 的段也入 `SEGS`，每条带 `who: 'buffett'|'munger'`。
2. 修配对 bug：芒格段出现前先结算已缓存的提问 `buf`（把 `who==='munger'` 视作和 `buffett` 同级的「答话人」，
   同样触发 `pickAsk(buf)`）。
3. 芒格段的 `ans` 长度门槛与巴菲特一致（≥20 字），连续短段合并逻辑同样适用。
4. `agent.js` `talk_search` 输出：芒格段标「芒格答：」而非「他答：」，并注明「这是芒格在会上说的，不是巴菲特」。
5. 检索打分：芒格段与巴菲特段同权召回，但**靠输出标注区分说话人**，让模型引用时写清「芒格在会上说」。
   （不降权——读者问「芒格怎么看X」时需要命中；分错说话人是提示词层面约束，不是打分层面。）

**验收**：`node meeting.js "商誉"` 能返回芒格段且标注「芒格答」；`_agentcli.js` 问「芒格怎么看商誉」答案里
芒格的话被正确归因。

### 4.2 信件表格 429 块入索引

**文件**：`agent.js`

**改动**：`searchDocs` 构造 `DOCS` 时，把 `(b.t || '')` 换成与 `build.py:491 block_text()` 等价的逻辑：
表格块拼 `head` + 各 `rows`，其余取 `t`。可复用前端 `index.html` 已有的 `blockText()` 逻辑（保持一致）。

**验收**：「五年毛利率」这类财报表能被 `search_letters` 命中；`node _bench_search.js` 延迟不劣化。

### 4.3 实体倒排扩到会议+演讲

**文件**：新脚本（如 `build_mentions_aux.py`）或扩展 `build.py`、`site/data-core.js`、`site/index.html`、`agent.js`

**改动**：
1. 扫描 `meetings_zh.jsonl`（`who in {buffett, munger}`）和 `speech.jsonl`（`who in {buffett, munger}`），
   用与 `build.py` 相同的 `SURF` 字面匹配，产出每条实体的会议/演讲出场。
2. 归属口径：**只算巴菲特和芒格本人的段**（分开标注 `who`），股东提问/主持人开场不算「出场」。
3. 坐标：
   - 会议：`年 | 场次（上午/下午） | 章 | who`
   - 演讲：`年 | 场合（venue） | 段 | who | fid`
4. 数据结构：不污染现有 `CORE.mentions`（信件元组 `[year, blockIdx, lid]` 被前端多处硬绑定），
   新增平行键（如 `CORE.mentions_meeting`、`CORE.mentions_speech`）。
5. 前端 `entity()`（`index.html:1227`）：在「跨年出场」下新增会议/演讲出场区，按年分组，
   每条可跳转到对应会议/演讲页（或展示「哪一年哪一场哪一段」），说话人标注清楚。
6. `agent.js` 消费侧：`concept_profile` / `company_timeline` 的「出现次数/跨年」如要计入会议/演讲，
   需同时更新计数口径（否则静态页与 Agent 回答数字打架）。

**验收**：点「芒格」实体页能看到他在股东大会上的出场；点某公司能看到会议/演讲里的提及；
`smoke.js` 内容断言不破。

---

## 5. 工作流 ② 考据类标注集

**目标**：给「改前 vs 改后」一个客观的检索质量尺子，兼作参数扫描的判据。

**格式**（`eval/cases-annotation.jsonl` 或等价文件）：
```
{
  "id": "ann-001",
  "question": "他怎么看商誉？",
  "gold": [ {"src": "letter", "l": "1983 巴菲特致股东信", "b": 12},
            {"src": "meeting", "y": 1999, "session": "Morning_Session", "ch": 3} ],
  "corpus": "letter|meeting|speech"
}
```

**定位方式**：信件用 `信|段号`；会议用 `年|场次|章`；演讲用 `年|场合|段`。每题 2–5 个「必须命中」段。

**指标**：`recall@4`（主指标）、`recall@6`、`MRR`。命中判定 = 返回段与 gold 任一坐标相等（或同段落文本）。

**出题流程**：
1. 我起草 30–50 道种子题（按三路语料各覆盖一批，含概念/公司/人物/认错/表格数据类），标好 gold。
2. 用户审题增删改。
3. 评分脚本（`eval/score_annotation.js`）先对**改前索引**跑一遍，存档 baseline。
4. 改后重跑同一套，对比 recall@4/6/MRR。

**边界**：研判类不进这个标注集（正确答案是「一组事实+一个判断」，不是「某段话」，拿它算 recall 会污染指标；
它已有 `eval/judge.js` 五段结构 + 数字溯源 + 立场判据）。

---

## 6. 工作流 ③ 知识结构层扩展

### 6.1 认错档案（确定性正则）

**文件**：`extract_content.py`（或新脚本）

**改动**：把 `CORR_PAT` 四类正则扫会议（`who in {buffett, munger}`）和演讲（`who==='buffett'`）段，
产出结构对齐现有 `corrections` 条目，新增 `src: 'meeting'|'speech'` 字段，坐标用会议/演讲坐标系。
- 说话人口径：认错只收本人（巴菲特认自己的错；芒格的错单独标 `who`，不进巴菲特的认错账本）。
- 口语噪声：会议上「我错了」可能带寒暄，正则触发后仍取含触发词的那一句（沿用 `pick_sentence`）。

**产出**：静态认错账本页新增会议/演讲认错条目，标注来源场合。

### 6.2 规则库 + 记分牌（LLM 抽取 + 人工审）

**方法**：复用 `extract_speech_cases.js` 的管线，目标语料从演讲扩到**会议**（演讲已有的 cases 保留）。

**改动**：
1. 写 `extract_meeting_cases.js`（镜像 `extract_speech_cases.js`）：
   - 信号词过滤（correction/reject/sell/money/year）捞候选段。
   - 只喂巴菲特段（芒格段单列，不混入巴菲特案例；是否抽芒格案例另行决定）。
   - LLM 抽 `kind/entity/judgment/situation/lesson/verdict/slots`，回挂会议坐标 `src: {kind:'meeting', y, session, ch}`。
   - `fid` 对应：会议是逐字可引（`verbatim`），与演讲 notes 不同，标注可逐字引用。
2. 产出 `_src/meeting/cases.json`，由 `extract_cases.js` 并入 `data-cases.js`。
3. **回喂静态页**：把会议+演讲抽出的 rule/correction/scorecard，按实体/概念挂回 `data-content.js` 对应页，
   使静态「规则库/记分牌」页能看到会议/演讲来源（带 `src` 标注、逐字/转述区分）。

**成本与审**：LLM 抽取要花钱 + 人工审一遍再进静态页。分小批跑（`--limit`），产出落 JSONL 供审。

**验收**：分身案例库会议案例可被 `match_situation` 命中；静态规则库/记分牌页出现「会议/演讲来源」条目。

---

## 7. 工作流 ④ 参数扫描 + 向量决策

**用标注集（工作流 ②）当尺子**，对检索参数做网格扫描：
- 返回条数 `k`（4/6/8）
- 长度归一化系数（`140`/`200` 等）
- n-gram 权重（2 字 1.2 / 3 字 2 / 整词 3）
- `MAX_TOOLCALLS`（14 的上下界）

**向量检索决策**：在改后索引上，用标注集对比「字面检索 vs 字面+向量融合」，输出是否值得上向量的结论。
当前已知约束（回测年份截断、引用可解释）保持不变，向量只能作为字面 Top-k 全空时的补召回，不作为主路径。

---

## 8. 分阶段执行顺序与依赖

```
① 索引层三处（芒格/表格/实体倒排）    —— 无依赖，0.5 天
   ↓
② 标注集：起草种子题 + 评分脚本 + 改前基线  —— 依赖 ①（标注要标在正确的索引上）
   ↓
③a 认错档案正则扩会议/演讲            —— 依赖 ① 的会议/演讲数据就位
   ↓
③b 规则+记分牌 LLM 抽取 + 人工审       —— 依赖 ③a 的坐标体系；单独一批（花钱+审）
   ↓
④ 参数扫描 + 向量决策                  —— 依赖 ② 的标注集 + ① 的改后索引
```

③b 可与 ② 并行（两者不冲突），但都排在 ① 之后。

---

## 9. 风险与注意事项

1. **会议口语噪声**：正则/LLM 抽会议会混入寒暄。缓解：认错仍取含触发词单句；规则/记分牌靠信号词 + LLM 精读 + 人工审。
2. **说话人归因**：会议混巴菲特/芒格/股东。实体倒排与认错只收本人；规则/记分牌抽芒格段时单列，不冒充巴菲特。
3. **静态页与 Agent 计数打架**：实体倒排扩到会议/演讲后，`concept_profile`/`company_timeline` 的「出现次数」
   要么同步计入新来源、要么明确标注「仅信件」。改前先对齐口径。
4. **体积**：会议 159 万字做成页面 JS 约 4.8 MB，浏览器扛不动。实体倒排/认错/规则的新数据只做**聚合后的索引**，
   不把会议全文塞进 `site/`（维持现有「会议全量只在服务端」的架构）。
5. **回测时间闸门**：会议/演讲新数据进知识结构后，`asOf` 截断必须同样生效——静态页可看全量，Agent 回测仍按年截断。
6. **`extract_cases.js` 的去重**：并入会议 cases 时复用「同 judgment 前缀去重」逻辑，避免和演讲/信件案例重复。
7. **LLM 抽取成本**：`extract_speech_cases.js` 已有 `--limit` 分小批先试效果的习惯，会议照做，先跑一小批看质量再全量。

---

## 10. 验收标准

| 工作流 | 验收 |
|---|---|
| ① 芒格 | `node meeting.js "商誉"` 返回芒格段且标「芒格答」；追问「芒格怎么看」归因正确 |
| ① 表格 | 「五年毛利率」表可被 `search_letters` 命中；`_bench_search.js` 延迟不劣化 |
| ① 实体倒排 | 实体页出现会议/演讲出场，说话人标注清楚；`smoke.js` 不破 |
| ② 标注集 | recall@4/6/MRR 改前基线存档，改后可复算对比 |
| ③a 认错 | 认错账本页出现会议/演讲来源条目 |
| ③b 规则/记分牌 | 分身案例库含会议案例且可被命中；静态页出现会议/演讲来源 |
| ④ 参数 | 标注集网格扫描结论 + 向量决策有据可依 |

---

## 附：关键代码坐标速查

- `build.py:190-212` 实体倒排（只扫信件）；`build.py:491 block_text()`（表格拼法）
- `agent.js:129-137` 信件搜索索引（表格漏洞）；`agent.js:956-977` `talk_search` 输出
- `meeting.js:36-56` 会议问答配对 + 芒格丢弃 + buf 不结算
- `extract_content.py:337-371` 认错正则；`extract_content.py:381-656` 规则/记分牌
- `extract_cases.js` 分身案例库合并；`extract_speech_cases.js` 演讲 LLM 抽取模板
- `site/index.html:1227-1262` 实体页「跨年出场」渲染
- `eval/README.md` 评测口径；`eval/基线报告.md` 语料规模与向量结论
