# -*- coding: utf-8 -*-
"""
读巴菲特 — 会议/演讲语料里的「公司/机构名」确定性候选扫描（不调 LLM，纯字面提取）

目的：从会议/演讲中文语料里扫出「公司/机构名」，找出不在现有 CORE 名单里的，
      产出一份候选清单供人工审。

输入:
    site/data-core.js   现有实体（companies/concepts/people 的 name + surf 表面词）
    _src/meeting/meetings_zh.jsonl  股东大会语料（字段 y/session/who/text）
    _src/speech/speech.jsonl        演讲/访谈语料（字段 y/venue/who/text）

输出:
    _src/entities-candidates.txt（UTF-8，按出现次数降序：名字 / 次数 / 例句）

只扫 who in {buffett, munger} 的段（与 build_mentions_aux.py 口径一致）。

提取策略（均字面、可复现）:
    1) 中文：2~8 个汉字 + 尾缀（公司/集团/银行/…/商社 等），非贪婪取最短核心，
       再用「并列拆分 + 虚词字符黑名单 + 泛指核心词表 + 泛动词前缀表」滤掉
       「一家公司 / 所以保险 / 伯克希尔与苏黎世保险」这类系统噪声。
    2) 英文：多词专名短语（如 "Fruit of the Loom"）+ 全大写缩写（如 USAA、AIG）
       + 单个首字母大写词（如 Costco、Progressive），再用 常见词/人名/碎片 黑名单滤噪声。
       英文句子的整段（ascii 占比 > 0.5，多为英文原文对照）跳过不扫，避免普通英文词噪声。
"""
import json, os, re, sys

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

ROOT = os.path.dirname(os.path.abspath(__file__))
os.chdir(ROOT)

MEETING_PATH = '_src/meeting/meetings_zh.jsonl'
SPEECH_PATH = '_src/speech/speech.jsonl'
OUT_PATH = '_src/entities-candidates.txt'

# ============================================================
# 中文
# ============================================================
CH_SUFFIX = [
    '公司', '集团', '银行', '证券', '保险', '航空', '石油', '铁路', '钢铁', '矿业',
    '制药', '药业', '汽车', '能源', '通信', '电信', '科技', '传媒', '出版', '零售',
    '食品', '饮料', '酒店', '地产', '物业', '电力', '燃气', '水务', '港口', '航运',
    '物流', '电商', '基金', '资本', '控股', '交易所', '大学', '学院', '医院',
    '连锁', '超市', '百货', '商社', '商事', '物产',
]
CH_SUFFIX_ALT = '|'.join(CH_SUFFIX)
# 非贪婪：取最短核心，避免把「伯克希尔与苏黎世保险」「道明尼能源公司」里的前文/尾缀吞进核心
CH_RE = re.compile(r'([\u4e00-\u9fa5]{2,8}?)(' + CH_SUFFIX_ALT + ')')

# 核心名里出现即判为噪声的字符（量词/代词/动词/虚词/程度/形容词——几乎不出现在公司专名里）。
# 注意：除「进」外都保留（前进=Progressive 要保住；「进入…保险」仍会被「入」拦下）。
BAD_CHARS = set(
    '一二三四五六七八九十百千万亿两几每各某该这那此本诸全整半多少数若许'
    '家个批间座条只项类种些位名笔宗'
    '我你他她它咱们吾汝其'
    '买卖收购投资持有经营管建成观跟研究析控谈论说讲看见到用做作为是有无没不也都还要能会可就才把被让给对从和与及或之其于'
    '的了着过地得吧吗呢啊呀'
    '好大小新旧老高低快慢优劣强弱'
    '在所如果但且而负责配置冻结采纳拟议任何时候超级灾难除非均值现应哪怕追溯共同别另只仅光单净白坏未莫勿休禁止免掉完毕并则却竟恰'
    '什么像今交易提供然后后然'
    '拿制年去告诉再加来自包括'
    '比起当以险承算子巨额关注'
)

# 泛指核心词（「XX + 尾缀」里的 XX 是纯行业/通名/国别，不是具体名字）
GENERIC_CORE = {
    '保险', '石油', '铁路', '钢铁', '矿业', '制药', '药业', '汽车', '能源',
    '通信', '电信', '科技', '传媒', '出版', '零售', '食品', '饮料', '酒店',
    '地产', '物业', '电力', '燃气', '水务', '港口', '航运', '物流', '电商',
    '基金', '资本', '控股', '交易所', '大学', '学院', '医院', '连锁', '超市',
    '百货', '证券', '银行', '航空', '集团', '公司', '商社', '商事', '物产',
    # 常见泛称
    '上市', '私营', '民营', '国有', '公用', '公用事业', '财险', '寿险',
    '再保险', '贸易', '投资', '管理', '咨询', '服务', '综合', '大型',
    '小型', '中型', '金融', '实业', '建筑', '化工', '制造', '农用',
    '运输', '快递', '仓储', '批发', '外贸', '代理', '中介',
    '经纪', '信托', '融资', '租赁', '担保', '典当', '拍卖', '评估',
    '会计', '审计', '法律', '广告', '营销', '策划', '翻译', '设计',
    '工程', '施工', '装修', '家政', '旅游', '培训', '教育', '学校',
    '互联网', '软件', '硬件', '计算机', '半导体', '芯片',
    '长期', '短期', '自由', '共同', '私募', '私募股权', '对冲',
    '养老', '主权', '指数', '风险', '天使', '糖果',
    # 国别/地区（「美国公司/日本公司」等泛指；具体「美国银行/中国石油」已在 EXISTING 里）
    '美国', '中国', '日本', '英国', '德国', '法国', '韩国', '加拿大',
    '澳洲', '澳大利亚', '欧洲', '亚洲', '全球', '全国', '世界', '国际',
    '外国', '海外', '跨国', '环球',
    # 观察到的泛称/碎片
    '人寿', '财产', '财产意外', '商业', '个人', '赌博', '烟草', '债券', '债券保险',
    '货币', '货币市场', '主权财富', '住宅', '住宅房', '中央', '反向',
    '工伤', '智力', '自愿', '受托', '盎司', '最终', '生物', '股票', '包括',
    '增量', '合伙', '承保', '关注', '意外', '巨额', '客运', '街车',
    '私人', '生产', '权益', '衍生', '支付', '销售', '实际', '领域', '愚蠢', '狂热',
    '哈撒韦',
}

# 泛动词/副词/连词前缀：核心名以这些词开头即判为噪声（如「进入超级灾难保险」「负责保险」）
GENERIC_PREFIX = [
    '进入', '然后', '所以', '如果', '但是', '而且', '除非', '负责', '配置',
    '冻结', '采纳', '拟议', '均值', '哪怕', '追溯', '共同', '什么', '交易',
    '提供', '包括', '比起', '关注', '承保', '巨额', '还有', '另外', '同时',
    '作为', '成为', '例如', '比如', '通过', '由于', '因为', '关于', '对于',
    '按照', '根据', '采用', '进行', '开展', '实现', '达到', '获得', '带来',
    '导致', '造成', '产生', '形成', '收购', '投资', '持有', '经营', '管理',
    '研究', '分析', '观察', '跟踪', '购买', '买入', '卖出', '建立', '成立',
    '使用', '现在', '任何', '时候', '然后', '今天', '告诉', '算上', '拿',
    '再加上', '退出', '卖掉', '买下', '从事', '涉及', '属于', '来自', '用于',
]

# ============================================================
# 英文
# ============================================================
EN_WORD = r"[A-Z][A-Za-z&.\-']+"
EN_CONN = r"(?:of|and|the|for|de|in|at|to|&)"
EN_PHRASE_RE = re.compile(EN_WORD + r"(?:\s+(?:" + EN_CONN + r"\s+)*" + EN_WORD + r")+")
EN_ACRO_RE = re.compile(r"(?<![A-Za-z])([A-Z]{3,6})(?![A-Za-z&])")
EN_SINGLE_RE = re.compile(EN_WORD)


def _norm(s):
    return s.lower().replace('.', '').replace('’', '').replace("'", '').replace('&', 'and')


# 财经/通用缩写（不是公司名）
NON_ORG_ACRO = set('''
GDP GAAP EBITDA FDIC REIT IPO MBA LIFO FIFO FASB S&P NYSE NASDAQ OTC AMEX ETF
IRS VAT USA UK UN EU IMF WTO WHO FBI CIA FCC FDA EPA PDF TV PC CD DVD IT AI HR
PR FAQ FY Q1 Q2 Q3 Q4 H1 H2 USD RMB CNY JPY EUR GBP CHF AUD CAD
EVA CPI CDO CDS SPAC SIFI IRA XYZ IRR ROE ROIC EPS CEO CFO COO CTO AAA DJIA
PPI PB PE ESG ROA OK OKAY
'''.split())

# 英文常见词/场次/地名/缩写噪音（小写化后比对）
EN_STOP = set('''
morning afternoon session evening buffet buffetts munger charlie warren berkshire
hathaway mr mrs ms dr inc co corp llc ltd jr sr iii ii iv
inflation competitive diversification compounding leverage goodwill depreciation
franchise dividends derivatives advantage moat culture circle competence
january february march april may june july august september october november december
monday tuesday wednesday thursday friday saturday sunday
america american united states china chinese japan japanese europe european
germany german london new york chicago california nebraska omaha
one two three four five six seven eight nine ten eleven twelve
first second third then that this these those what why how when where who
the and but for you we they he she it my our your their not was were are is
be been have has had would could should will can do does did about over under
with from into than there here only rich prime becoming shut grab baggage walk
please pleased very much more most some any all every each other another
psychology misjudgment almanack amendment codicil economic possibilities
grandchildren transportation manual coffee fortune journal magazine book review
handbook dictionary encyclopedia world book university college service group company
companies corporation eastern airlines railway railroad pacific union international
business machines chesapeake ohio norfolk western delaware lackawanna northern
enchanted kasparov nipper house stock exchange street park school home store shop
well big little small good better best new old high low fast slow strong weak
interview interviewer financial times wall street blog tweet post news king queen
prince princess president chairman senator governor congress senate
ive im ill id weve were its thats dont cant wont youve youre youll hes shes
theres whats lets isnt didnt doesnt havent hasnt couldnt wouldnt shouldnt
americas charlies looms state states farm phone level reits encarta newman
netjet behring loomis irene dillon hanes jetblue
'''.split())

# 人名（单名 + 全名，归一化后比对）。用于滤掉会议纪要里的董事/高管/提问者名字。
PERSON_STOP = set('''
walter greg ron ronald susan steve don bob frank patrick howard marc phillip philip
tom tim jim bill david john robert michael james william richard charles paul peter
george albert abraham carl sam roger ben will jessica vicki chuck ralph craig mason
davy al ajit ted todd susie katharine benjamin larry sandy carrie debbie tony becki
malcolm lorimer meryl charlotte forrest fred ken barry nancy henry leo jamie jeff
ryan andrew alex daniel mark chris matthew anthony jason eric brian kevin gary jerry
terry dennis douglas bruce alan arthur roy louis harry jack joe lucy mary linda karen
scott murphy olson hollub icahn bell butler lincoln keynes getty kiewit young sokol
mitchell cook sova bosanek amick chace davidson witmer guyman keough issler wurster
schey huggins jacques burgess denham zeien rooney gottesman krutter cunningham hawkins
salsteiner rosner toonkel dimon bezos gates szilard laffer noll zhou patel holmes
fusaro begley skarbeck roberts lewis goodwin goldberg christian christiansen
walter scott tom murphy thomas murphy ron olson ronald l olson tim cook marc hamburg
marc d hamburg frank rooney sandy gottesman forrest krutter larry cunningham
carrie sova debbie bosanek tony nicely becki amick malcolm g chace lorimer davidson
meryl witmer charlotte guyman don keough david sokol bill mitchell paul getty
john maynard keynes abraham lincoln peter kiewit jim young will salsteiner ben rosner
jessica toonkel vicki hollub carl icahn roger bell sam butler jim issler don wurster
ralph schey chuck huggins susan jacques ron burgess bob denham al zeien frank olson
howard g buffett mason hawkins ajit jain greg abel ted weschler todd combs
susie buffett katharine graham benjamin graham albert einstein jamie dimon jeff bezos
bill gates warren buffett charlie munger philip fisher peter lynch walter schloss
leo szilard barry laffer ben noll henry zhou archie patel stanley holmes ryan fusaro
bill begley ken skarbeck bill roberts leo goodwin peter lewis paul andrews
'''.split())


def ascii_ratio(t):
    if not t:
        return 0.0
    return sum(1 for c in t if ord(c) < 128) / len(t)


def load_core():
    raw = open('site/data-core.js', encoding='utf-8').read()
    core = json.loads(raw[raw.index('window.CORE = ') + len('window.CORE = '):].rstrip().rstrip(';'))
    return core


def build_existing(core):
    existing = set()
    for key in ('companies', 'concepts', 'people'):
        for item in core.get(key, []):
            name = item.get('name')
            if name:
                existing.add(name.lower())
    for surfaces in core.get('surf', {}).values():
        for s in surfaces:
            existing.add(_norm(s))
    return existing


def load_jsonl(path):
    rows = []
    with open(path, encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def core_ok(core_cn, full):
    if core_cn in GENERIC_CORE or full in GENERIC_CORE:
        return False
    if core_cn.startswith('哈撒韦'):  # 「伯克希尔·哈撒韦XXX」碎片
        return False
    if core_cn[-1] in '和与及或的之把被让给':
        return False
    for pre in GENERIC_PREFIX:
        if core_cn.startswith(pre):
            return False
    for ch in core_cn:
        if ch in BAD_CHARS:
            return False
    return True


def scan():
    core = load_core()
    existing = build_existing(core)

    fragment_words = set()
    for surfaces in core.get('surf', {}).values():
        for s in surfaces:
            for w in re.findall(r"[A-Za-z&.\-']+", s):
                fragment_words.add(_norm(w))

    candidates = {}  # name -> {'count': int, 'example': (y, loc, snippet), 'lang': 'zh'|'en'}

    def register(name, y, loc, snippet, lang):
        rec = candidates.get(name)
        if rec is None:
            candidates[name] = {'count': 1, 'example': (y, loc, snippet), 'lang': lang}
        else:
            rec['count'] += 1

    def process_rows(rows, kind):
        for r in rows:
            if r.get('who') not in ('buffett', 'munger'):
                continue
            text = r.get('text') or ''
            if not text:
                continue
            y = r.get('y')
            loc = r.get('session') if kind == 'meeting' else r.get('venue')
            is_english_row = ascii_ratio(text) > 0.5

            # --- 中文 ---
            for m in CH_RE.finditer(text):
                core_cn, suffix = m.group(1), m.group(2)
                full = m.group(0)
                # 并列列举拆分：「伯克希尔与苏黎世保险」→「苏黎世保险」
                if any(sep in core_cn for sep in '与和及或、'):
                    core_cn = re.split(r'[与和及或、]+', core_cn)[-1]
                    full = core_cn + suffix
                    if len(core_cn) < 2:
                        continue
                if not core_ok(core_cn, full):
                    continue
                if full in existing or core_cn in existing:
                    continue
                p = m.start()
                register(full, y, loc, text[max(0, p - 12): p + len(m.group(0)) + 20], 'zh')

            # --- 英文：跳过整段英文句子的行 ---
            if is_english_row:
                continue

            for m in EN_PHRASE_RE.finditer(text):
                phrase = m.group(0)
                words = phrase.split()
                if any(_norm(w) in PERSON_STOP for w in words):
                    continue
                if _norm(phrase) in existing or _norm(phrase) in PERSON_STOP:
                    continue
                p = m.start()
                register(phrase, y, loc, text[max(0, p - 12): p + len(phrase) + 20], 'en')

            for m in EN_ACRO_RE.finditer(text):
                a = m.group(1)
                if a in NON_ORG_ACRO or a.lower() in existing:
                    continue
                p = m.start()
                register(a, y, loc, text[max(0, p - 12): p + len(a) + 20], 'en')

            for m in EN_SINGLE_RE.finditer(text):
                w = m.group(0)
                nw = _norm(w)
                if w.isupper():
                    continue
                if nw in existing or nw in EN_STOP or nw in PERSON_STOP:
                    continue
                if nw in fragment_words:
                    continue
                p = m.start()
                register(w, y, loc, text[max(0, p - 12): p + len(w) + 20], 'en')

    process_rows(load_jsonl(MEETING_PATH), 'meeting')
    process_rows(load_jsonl(SPEECH_PATH), 'speech')

    # 把刚抽到的多词短语的所有词并入碎片黑名单，再过滤一次英文单词候选
    for name in list(candidates):
        rec = candidates[name]
        if rec['lang'] == 'en' and ' ' in name:
            for w in re.findall(r"[A-Za-z&.\-']+", name):
                fragment_words.add(_norm(w))

    new_candidates = {}
    for name, rec in candidates.items():
        if rec['lang'] == 'en' and ' ' not in name:
            if _norm(name) in fragment_words:
                continue
        new_candidates[name] = rec
    candidates = new_candidates

    return candidates, core


def main():
    candidates, core = scan()
    ranked = sorted(candidates.items(), key=lambda kv: kv[1]['count'], reverse=True)

    zh = [kv for kv in ranked if kv[1]['lang'] == 'zh']
    en = [kv for kv in ranked if kv[1]['lang'] == 'en']

    print('现有实体名 + 表面词（EXISTING）数量: %d' % len(build_existing(core)))
    print('新发现候选（去重后）: 中文 %d 个，英文 %d 个，共 %d 个' % (len(zh), len(en), len(candidates)))
    print()

    def fmt(kv):
        name, rec = kv
        y, loc, snippet = rec['example']
        return '%s / %d / [%s] %s %s …%s' % (name, rec['count'], rec['lang'], y, loc, snippet)

    def dump(title, sub):
        print(title)
        for kv in sub:
            print('  ' + fmt(kv))
        print()

    dump('===== 中文候选 TOP 50 =====', zh[:50])
    dump('===== 英文候选 TOP 50 =====', en[:50])

    lines = [fmt(kv) for kv in ranked]
    with open(OUT_PATH, 'w', encoding='utf-8') as f:
        f.write('# 读巴菲特 — 会议/演讲 公司/机构名候选（确定性扫描，非 LLM）\n')
        f.write('# 格式：名字 / 出现次数 / [语言] 例句（年份 + 场次/venue + 上下文）\n')
        f.write('# 共 %d 个候选（中文 %d / 英文 %d），按出现次数降序。\n\n' % (len(candidates), len(zh), len(en)))
        for line in lines:
            f.write(line + '\n')
    print('已写入 %s' % OUT_PATH)


if __name__ == '__main__':
    main()
