# -*- coding: utf-8 -*-
"""
读巴菲特 — 内容抽取层
输入: _src/buffett-letters 的 concepts/ companies/
输出: site/data-content.js

四个产品层:
  1. 入口  -> company timeline (61 家全量时间线)
  2. 停留  -> concept evolution (49 概念 分期演化 + 原话)
  3. 带走  -> corrections (认错与自我修正档案)
  4. 复访  -> rules (决策规则库) + paths (入门导引)

全部确定性抽取, 不过 LLM。
"""
import re, os, glob, json

SRC = '_src/buffett-letters'
OUT = 'site'

# ---------- 通用: 按小节切分 ----------
SEC_NAMES = ['概念解析', '定义与起源', '核心要义', '实践应用', '常见误区',
             '巴菲特原话精选', '思想演变', '相关概念', '典型案例公司',
             '公司简介', '投资历程', '历年提及', '关键事件', '人物简介']
SEC_RE = re.compile(r'^(%s)\s*$' % '|'.join(SEC_NAMES), re.M)

def split_sections(text):
    """返回 [(name, body)]，按已知小节名切分（小节名独占一行）"""
    marks = [(m.start(), m.end(), m.group(1)) for m in SEC_RE.finditer(text)]
    if not marks:
        return []
    out = []
    for i, (s, e, name) in enumerate(marks):
        end = marks[i + 1][0] if i + 1 < len(marks) else len(text)
        out.append((name, text[e:end].strip()))
    return out

def front_body(path):
    t = open(path, encoding='utf-8').read().replace('\r', '')
    i = t.find('---')
    return t[i + 3:] if i >= 0 else t

# ---------- 1. 思想演变 (分期) ----------
# 语料里实测有 4 种写法, 正则必须全兼容:
#   P1 区间+冒号:  '萌芽期（1970-1989）：从特许经营权到护城河'
#   P2 区间带年字: '合伙人时期（1956-1969年）：复利作为业绩衡量工具。'
#   P3 单年+句号:  '格雷厄姆的原始寓言（1949年）。 格雷厄姆在《聪明的投资者》中...'
#   P4 裸年份:     '1967年：以860万美元收购国民保险公司'
PER_HEAD = re.compile(
    r'^\s*(.{0,20}?)[（(]\s*(\d{4})\s*(?:[-–—]\s*(\d{4})\s*)?年?\s*[）)]\s*[:：。]\s*(.*)$')
PER_BARE = re.compile(r'^\s*(\d{4})\s*年?\s*[:：]\s*(.*)$')

def parse_periods(text):
    lines = [l.strip() for l in text.split('\n')]
    out = []
    i = 0
    def is_head(l):
        return PER_HEAD.match(l) or PER_BARE.match(l)
    while i < len(lines):
        l = lines[i]
        if not l:
            i += 1
            continue
        m = PER_HEAD.match(l)
        if m:
            name = m.group(1).strip() or '%s-%s' % (m.group(2), m.group(3) or m.group(2))
            y0 = int(m.group(2))
            y1 = int(m.group(3)) if m.group(3) else y0
            body = m.group(4).strip()
        else:
            m2 = PER_BARE.match(l)
            if not m2:
                i += 1
                continue
            name, y0, y1, body = '%s年' % m2.group(1), int(m2.group(1)), int(m2.group(1)), m2.group(2).strip()
        # 正文可能延续到后续若干行(直到下一个分期标题)
        j = i + 1
        while j < len(lines) and lines[j] and not is_head(lines[j]):
            body = (body + ' ' + lines[j]).strip() if body else lines[j]
            j += 1
        out.append({'name': name, 'y0': y0, 'y1': y1, 'text': body})
        i = j
    return out

# ---------- 2. 巴菲特原话精选 ----------
Q = re.compile(r'[“"]([^”"]{12,600})[”"]\s*\n?\s*——\s*(\d{4})\s*巴菲特致(股东|合伙人)信[（(]?([^）)\n]*)?[）)]?', re.M)
Q_LOOSE = re.compile(r'[“"]([^”"]{12,600})[”"]\s*\n?\s*——\s*(\d{4})([^\n]{0,30})')

def parse_quotes(text):
    out = []
    for m in Q.finditer(text):
        out.append({'t': m.group(1).strip(), 'y': int(m.group(2)),
                    'kind': m.group(3), 'note': (m.group(4) or '').strip()})
    if not out:
        for m in Q_LOOSE.finditer(text):
            out.append({'t': m.group(1).strip(), 'y': int(m.group(2)),
                        'kind': '', 'note': m.group(3).strip()})
    return out

# ---------- 3. 相关概念 / 典型案例公司 ----------
REL = re.compile(r'^\s*([^\s—–\-]{2,16})\s*[—–]\s*(.+)$')

def parse_rel(text):
    out = []
    for l in text.split('\n'):
        s = l.strip()
        if not s:
            continue
        m = REL.match(s)
        if m:
            out.append({'name': m.group(1).strip(), 'desc': m.group(2).strip()})
    return out

# ---------- 4. 公司历年提及 (兼容两种格式) ----------
TL_A = re.compile(r'^(\d{4}(?:[-–—]\d{2,4})?)\s{2,}(.+?)\s{2,}(.+)$')
TL_B = re.compile(r'^(\d{4}(?:[-–—]\d{2,4})?)\s+(19\d\d|20\d\d)?\s*(巴菲特致(?:股东|合伙人)信[^\n]*)$')

def parse_timeline(text):
    """格式A(表格压平, 列用2+空格分隔): '1964   1964 巴菲特致合伙人信   批评盲目持有蓝筹股'
       格式B(年+引文块): '2007 巴菲特致股东信（2007年）' 换行 引文"""
    lines = [l.rstrip() for l in text.split('\n')]
    out = []
    i = 0
    while i < len(lines):
        s = lines[i].strip()
        if not s or set(s) <= set('-: '):
            i += 1
            continue
        # 跳过表头
        if s.startswith('年份'):
            i += 1
            continue
        m = TL_A.match(s)
        if m:
            out.append({'y': m.group(1), 'letter': m.group(2).strip(),
                        'note': m.group(3).strip(), 'fmt': 'A'})
            i += 1
            continue
        m = TL_B.match(s)
        if m:
            letter = (m.group(2) or '') + ' ' + m.group(3) if m.group(2) else m.group(3)
            note = ''
            j = i + 1
            while j < len(lines):
                nx = lines[j].strip()
                if not nx or TL_B.match(nx) or TL_A.match(nx):
                    break
                note = (note + ' ' + nx).strip()
                j += 1
            out.append({'y': m.group(1), 'letter': letter.strip(),
                        'note': note[:400], 'fmt': 'B'})
            i = j
            continue
        i += 1
    return out

def year0(y):
    m = re.match(r'(\d{4})', str(y))
    return int(m.group(1)) if m else 0

# ---------- 5. 信件正文段落库 (给时间线补摘要用) ----------
import ast
_src = open('build.py', encoding='utf-8').read()
_alias_src = re.search(r'ALIAS\s*=\s*(\{.*?\n\})', _src, re.S).group(1)
ALIAS = ast.literal_eval(re.sub(r'#.*', '', _alias_src))

def letter_paras():
    """year -> [段落]。排除 special 里的非股东信与合伙协议(已验证会污染年份统计)。"""
    out = {}
    for dirn in ['partnership', 'berkshire']:
        for f in sorted(glob.glob(os.path.join(SRC, 'letters', dirn, '*.md'))):
            base = os.path.basename(f)[:-3]
            m = re.match(r'(\d{4})', base)
            if not m:
                continue
            t = open(f, encoding='utf-8').read().replace('\r', '')
            i = 0
            while i < len(t) and t[i:i + 3] != '---':
                i += 1
            ps = [l.strip() for l in t[i:].split('\n')
                  if l.strip() and l.strip() != '---' and not set(l.strip()) <= set('-: ')]
            out.setdefault(int(m.group(1)), []).extend(ps)
    return out

PARAS = letter_paras()

# ---------- 5b. 块级索引: 任何句子定位回「哪封信的哪一块」 ----------
# 直接读 build.py 的输出, 保证坐标与前端一致
_Lsrc = open('site/data-letters.js', encoding='utf-8').read()
LETTERS = json.loads(_Lsrc[_Lsrc.index('window.LETTERS = ') + len('window.LETTERS = '):].rstrip().rstrip(';'))
WS = re.compile(r'\s+')
# 引号归一化：概念档案里的引号风格与信件正文常不一致（'浮存金' vs “浮存金”），
# 不归一化会导致定位失败并退到邻近段落——点进去看到的是不相干的内容。
QCH = re.compile(r'[\u201c\u201d\u2018\u2019"\'\u300c\u300d\u300e\u300f]')

def norm(s):
    return WS.sub('', QCH.sub('', str(s)))

def blockText(b):
    if b['k'] == 't':
        return ' '.join(b.get('head', []) + [' '.join(r) for r in b['rows']])
    return b['t']

YBLOCKS = {}   # year -> [(lid, bi, normtext, k)]
for _lid, _v in LETTERS.items():
    for _bi, _b in enumerate(_v['blocks']):
        _t = norm(blockText(_b))
        if _t:
            YBLOCKS.setdefault(_v['year'], []).append((_lid, _bi, _t, _b['k']))

def locate(text, year):
    """句子 -> (lid, blockIdx)。容忍省略号拼接与截断: 按段试匹配, 长度递减。"""
    key = norm(text)
    segs = [s for s in re.split(r'…+|\.\.\.|——', key) if len(s) >= 8]
    if not segs and len(key) >= 8:
        segs = [key]
    for ln in (30, 20, 12):
        for seg in segs:
            probe = seg[:ln]
            if len(probe) < 8:
                continue
            for lid, bi, t, k in YBLOCKS.get(year, []):
                if probe in t:
                    return {'l': lid, 'b': bi}
    return None

def locate_surface(year, surfaces, want_narrative=True):
    """实体在该年信里的落点。优先叙事段(汉字多), 否则持仓表。"""
    best = None
    for lid, bi, t, k in YBLOCKS.get(year, []):
        if any(s and norm(s) in t for s in surfaces):
            han = len(re.findall(r'[\u4e00-\u9fff]', t))
            if k != 't' and han >= 30 and want_narrative:
                return {'l': lid, 'b': bi}
            if best is None:
                best = {'l': lid, 'b': bi}
    return best

# 补正文字典里没覆盖的简称（实测 14 条时间线摘要取不到，多为日本商社）
EXTRA_ALIAS = {
    '三井物产': ['三井'], '三菱商事': ['三菱'], '伊藤忠商事': ['伊藤忠'],
    '美国家庭服务': ['家庭服务'], '伯克希尔哈撒韦能源': ['BHE'],
    '中美能源': ['MidAmerican'], '美国合众银行': ['合众银行'],
}

def surfaces_for(name, en=''):
    s = {name}
    if en and len(en) >= 2:
        s.add(en)
    for a in ALIAS.get(name, []) + EXTRA_ALIAS.get(name, []):
        s.add(a)
    return {x for x in s if len(x) >= 2}

def first_sentence(p, n=95):
    p = re.sub(r'\s+', ' ', p).strip()
    m = re.search(r'^(.{15,%d}?[。！？])' % n, p)
    return (m.group(1) if m else p[:n])

def pick_sentence(p, keys, n=120):
    """取段落里**含关键词**的那一句。
    不能机械取首句 —— 关键词若在第二句, 摘要里看不到公司名, 读者会以为是乱配的。"""
    p = re.sub(r'\s+', ' ', p).strip()
    for s in re.split(r'(?<=[。！？])', p):
        s = s.strip()
        if len(s) >= 12 and any(k in s for k in keys):
            return s[:n]
    return p[:n]

def fill_note(name, en, year):
    """该年信里找含该公司的段落, 取含公司名的那一句做摘要"""
    keys = sorted(surfaces_for(name, en), key=len, reverse=True)
    for s in keys:
        for p in PARAS.get(year, []):
            if s in p:
                return pick_sentence(p, keys)
    return ''

# ================= 抽取 =================
concepts = {}
for f in sorted(glob.glob(os.path.join(SRC, 'concepts', '*.md'))):
    name = os.path.basename(f)[:-3]
    body = front_body(f)
    secs = dict(split_sections(body))
    periods = parse_periods(secs.get('思想演变', ''))
    quotes = parse_quotes(secs.get('巴菲特原话精选', ''))
    for q in quotes:
        q['loc'] = locate(q['t'], q['y'])   # 原话定位回「哪封信的哪一段」
    concepts[name] = {
        'periods': periods,
        'quotes': quotes,
        'related': parse_rel(secs.get('相关概念', '')),
        'cases': parse_rel(secs.get('典型案例公司', '')),
        'pitfalls': [x.strip(' 　') for x in re.split(r'\n(?=误区[一二三四五六七八九十])', secs.get('常见误区', '')) if x.strip()],
        'def': re.sub(r'\s+', ' ', (secs.get('概念解析', '') or secs.get('定义与起源', '')))[:600],
    }

companies = {}
for f in sorted(glob.glob(os.path.join(SRC, 'companies', '*.md'))):
    name = os.path.basename(f)[:-3]
    body = front_body(f)
    secs = dict(split_sections(body))
    m = re.search(r'[（(]\s*([A-Za-z][A-Za-z0-9 .\-&,\']{1,45})\s*[）)]', body[:400])
    en = m.group(1).strip() if m else ''
    tl = parse_timeline(secs.get('历年提及', ''))
    tl.sort(key=lambda x: year0(x['y']))
    filled = 0
    HAN = re.compile(r'[\u4e00-\u9fff]')
    for t in tl:
        y = year0(t['y'])
        if not y:
            continue
        keys = sorted(surfaces_for(name, en), key=len, reverse=True)
        # 摘要质量门槛: 汉字 < 8 视为"数字垃圾行"(持仓表压平), 先尝试从正文找叙事段
        if len(HAN.findall(t['note'] or '')) < 8:
            t['note'] = fill_note(name, en, y)
            if t['note']:
                filled += 1
                t['fmt'] = 'F'
        if len(HAN.findall(t['note'] or '')) < 8:
            # 正文也没有叙事段 -> 该年只有持仓表, 标记后前端渲染成"持仓表"行
            t['tbl'] = 1
        # 每条时间线都带原文落点: 优先句子精确匹配, 否则该年含公司名的块
        t['loc'] = locate(t['note'] or '', y) or locate_surface(y, keys)
    companies[name] = {
        'timeline': tl,
        'n': len(tl),
        'filled': filled,
        'en': en,
        'years': sorted({year0(x['y']) for x in tl if year0(x['y'])}),
        'intro': re.sub(r'\s+', ' ', secs.get('公司简介', ''))[:600],
        'history': re.sub(r'\s+', ' ', secs.get('投资历程', ''))[:1200],
    }

# ---------- 6. 认错与自我修正档案 ----------
# 实测调过: 单字(笨/傻)会误伤"笨重"之类, 一律用词组
# 收紧过一轮: 放宽时会抓进"坦白说，我希望未来…""他们会坦诚地告诉你"这类
# —— 前者是普通表述, 后者是引用别人的话, 都不是他本人认错。一律要求第一人称。
CORR_PAT = [
    ('admit',   r'我承认|我必须承认|我得承认|我坦承|我们承认|我错了|我犯了?错|我失算'),
    ('error',   r'我的错误|判断错误|估计错误|是个错误|严重的错误|最糟糕的(交易|投资|错误|决定)|愚蠢的错误|我的.{0,4}失误'),
    ('lesson',  r'教训|付出了.{0,8}代价|昂贵的代价|惨痛|学费|代价是'),
    # reverse 不能用"事实证明"单独判定 —— 实测抓进过"事实证明，这一融资安排极为及时"
    # 这种正面句。要么用自带贬义的词, 要么要求"事实证明"后 40 字内出现负面信号。
    ('reverse', r'化为乌有|烟消云散|蒸发殆尽|幻想从未成真|事与愿违|判断.{0,4}落空'
                r'|事实证明[^。]{0,40}(没有|未能|并未|落空|相反|失败|亏损|沮丧|失望|糟糕|错)'
                r'|但事实是[^。]{0,40}(没有|未能|并未|相反|失败|亏损)'),
]
ENT_NAMES = sorted(set(list(concepts.keys()) + list(companies.keys())), key=len, reverse=True)

def entity_in(text):
    for n in ENT_NAMES:
        if len(n) >= 2 and n in text:
            return n
    return ''

corrections = []
seen = set()
for year in sorted(PARAS):
    for p in PARAS[year]:
        for kind, pat in CORR_PAT:
            m = re.search(pat, p)
            if m:
                # 取**含触发词**的那一句, 否则摘要看不出为什么被归到这类
                sn = pick_sentence(p, [m.group(0)], 150)
                key = (year, sn[:40])
                if key in seen:
                    break
                seen.add(key)
                corrections.append({'y': year, 'k': kind, 't': sn, 'ent': entity_in(p),
                                    'loc': locate(sn, year)})
                break
corrections.sort(key=lambda x: x['y'])

# 按实体聚合成「认错档案」条目(>=2 条才成档案)
by_ent = {}
for c in corrections:
    if c['ent']:
        by_ent.setdefault(c['ent'], []).append(c)
corr_topics = [{'ent': k, 'items': v} for k, v in sorted(
    by_ent.items(), key=lambda kv: -len(kv[1])) if len(v) >= 2]

# ---------- 7. 决策规则库 (只收原话; 教训类按用户要求移除) ----------
rules = []
for cname, c in concepts.items():
    for q in c['quotes']:
        rules.append({'t': q['t'], 'y': q['y'], 'src': cname, 'type': 'quote',
                      'loc': q.get('loc')})
rules.sort(key=lambda x: x['y'])

# ---------- 7b. 公司记分牌卡片 ----------
# 样式与 build.py 里 6 条人工核对的一致: 判定 + 他说(含确定程度) + 三色时间线 + 结果 + 教训
# 两层: 人工整理层(如下, 15 家) + 自动层(其余 46 家按时间线/认错/原话归类生成)
CURATED = {
    '富国银行': {
        'verdict': 'mix', 'title': '富国银行：赢了三十年，最后十年黯然退场',
        'claim': {'year': 1990, 'text': '唯一的例外是富国银行——一家管理一流、回报率极高的银行，我们把持股加到略低于10%。', 'confidence': '高'},
        'timeline': [
            {'y': 1990, 'k': 'act', 't': '加州地产危机中逆市加仓至 10%（无需美联储批准的上限），银行股普遍腰斩'},
            {'y': 1994, 'k': 'fact', 't': '13% 持股相当于一家 70 亿美元资产规模的"伯克希尔银行"，当年约赚 1 亿美元（信件原文）'},
            {'y': 2007, 'k': 'claim', 't': '信中转述 CEO 斯坦普夫对放贷机构的批评："旧的赔钱方法还好端端的，新的赔钱法却来势汹汹"'},
            {'y': 2016, 'k': 'fact', 't': '假账户丑闻曝光当年：持股 10.0%，成本 127.3 亿、市值 275.6 亿美元'},
            {'y': 2018, 'k': 'act', 't': '丑闻与美联储资产上限制裁期间逐年减持（9.9% → 8.4%）'},
            {'y': 2020, 'k': 'act', 't': '疫情后大幅减持，2022 年一季度全部清仓，结束约 32 年持有'},
        ],
        'outcome': '1990 年危机中建仓的前二十年是美国最成功的银行投资之一；2016 年假账户丑闻后开始退出，2022 年清仓。整体是赢家，结尾平庸。',
        'lesson': '"管理层一流"不是一次性判断——他对银行股的持续复核方式，比结论本身更值得学。',
        'src': '1990/1994/2007/2016/2018 信件 + 整理',
    },
    '美国运通': {
        'verdict': 'hit', 'title': '美国运通：危机买入，拿了六十年',
        'claim': {'year': 1965, 'text': '色拉油丑闻让运通股价腰斩，但旅行支票与签账卡的特许经营权没有受伤。', 'confidence': '高'},
        'timeline': [
            {'y': 1964, 'k': 'act', 't': '色拉油危机后果断建仓，成为合伙人基金重仓'},
            {'y': 1998, 'k': 'claim', 't': '"品牌特许经营权才是运通的本体，金融麻烦是一次性的"'},
            {'y': 2024, 'k': 'fact', 't': '持股约 8.8%，市值 1,516 亿美元，仍是前五大持仓'},
        ],
        'outcome': '1964 年买入后持有 60 余年从未卖出，是"以合理价格买特许经营权"的样板。',
        'lesson': '丑闻伤害的是一次性资产负债表；特许经营权有没有受伤，才是买不买的标准。',
        'src': '1964/1965/1998/2024 信件 + 整理',
    },
    '喜诗糖果': {
        'verdict': 'hit', 'title': '喜诗糖果：为品质第一次付"贵"价格',
        'claim': {'year': 1972, 'text': '以 2,500 万美元买下喜诗糖果——当时所有人都觉得贵。', 'confidence': '中高'},
        'timeline': [
            {'y': 1972, 'k': 'act', 't': '2,500 万美元收购（有形账面资产约 800 万，为品质付了第一笔显著溢价）'},
            {'y': 1983, 'k': 'claim', 't': '信中用喜诗完整讨论了商誉与"经济商誉 vs 会计商誉"'},
            {'y': 2007, 'k': 'fact', 't': '累计增量资本约 3,200 万美元，累计税前利润 16.5 亿美元（信件原文）'},
        ],
        'outcome': '35 年投入 3,200 万增量资本，产出 16.5 亿税前利润。巴菲特说"喜诗教会了我们关于品牌的一切"。',
        'lesson': '只需少量增量资本就能持续提价的企业，复利形态远好过"便宜"的平庸生意。',
        'src': '1972/1983/2007 信件 + 整理',
    },
    '华盛顿邮报': {
        'verdict': 'hit', 'title': '华盛顿邮报：买对了也套了四年',
        'claim': {'year': 1973, 'text': '熊市中以约 1,000 万美元买入约 10% 股份——市值远低于内在价值。', 'confidence': '高'},
        'timeline': [
            {'y': 1973, 'k': 'act', 't': '熊市中建仓约 1,000 万美元'},
            {'y': 1974, 'k': 'fact', 't': '市值一度腰斩，浮亏近四年；他此后在信里多次复盘"买得太早"'},
            {'y': 1985, 'k': 'claim', 't': '公开称赞凯瑟琳·格雷厄姆的编辑部独立性是治理样板'},
            {'y': 2014, 'k': 'act', 't': '与格雷厄姆控股换股退出（电视台 + 现金 + 伯克希尔股票），规避巨额税负'},
        ],
        'outcome': '1,000 万美元级别的投入，四十年后以约 10 亿量级退出；但前四年浮亏一半。',
        'lesson': '买对了也可能套牢数年——仓位与心态要扛得住市场先生的开价。',
        'src': '1973/1974/1985/2014 信件 + 整理',
    },
    '盖可保险': {
        'verdict': 'hit', 'title': '盖可保险：从 20 岁的第一笔到全资收购',
        'claim': {'year': 1995, 'text': '"1951 年我 20 岁，坐火车去华盛顿敲开盖可的大门"——师从格雷厄姆后的第一笔重仓。', 'confidence': '高'},
        'timeline': [
            {'y': 1951, 'k': 'act', 't': '研究生时期首次买入盖可'},
            {'y': 1976, 'k': 'act', 't': '盖可濒临破产时联合注资救助，其后持续增持'},
            {'y': 1996, 'k': 'act', 't': '以约 23 亿美元收购剩余股份，全资私有化'},
            {'y': 2023, 'k': 'fact', 't': '托德·库姆斯改革后扭亏为盈，承保利润回正（信件原文）'},
        ],
        'outcome': '横跨人生的持有：1951 年 20 岁时的第一笔买入，到 1996 年全资收购。',
        'lesson': '低成本结构是保险业唯一持久的护城河；价格合适时，好公司可以拿一辈子。',
        'src': '1995/1976/1996/2023 信件 + 整理',
    },
    '国民保险公司': {
        'verdict': 'hit', 'title': '国民保险：860 万美元买来的资金引擎',
        'claim': {'year': 1967, 'text': '以 860 万美元收购国民保险公司——用光了当时的全部现金。', 'confidence': '高'},
        'timeline': [
            {'y': 1967, 'k': 'act', 't': '860 万美元全资收购，带来约 4,000 万美元浮存金'},
            {'y': 2023, 'k': 'fact', 't': '浮存金规模超过 1,600 亿美元（信件原文）'},
        ],
        'outcome': '860 万美元的一笔收购，长成了整个伯克希尔的资金引擎。',
        'lesson': '浮存金成本长期低于国债利率时，保险公司是一台近乎免费的资金机器。',
        'src': '1967/2023 信件 + 整理',
    },
    '所罗门': {
        'verdict': 'mix', 'title': '所罗门：条款全赢，声誉惊魂',
        'claim': {'year': 1987, 'text': '股灾中以 7 亿美元买入所罗门 9% 股息可转换优先股"救火"。', 'confidence': '高'},
        'timeline': [
            {'y': 1987, 'k': 'act', 't': '7 亿美元可转换优先股，年息 9%'},
            {'y': 1991, 'k': 'act', 't': '国债投标丑闻：为保住公司亲自出任临时董事长，在国会作证"公司越界了"'},
            {'y': 1991, 'k': 'claim', 't': '"输了钱可以再赚，输了名誉很难找回"——此后他把声誉写进每一封信'},
            {'y': 1997, 'k': 'act', 't': '旅行者集团收购所罗门，伯克希尔退出'},
        ],
        'outcome': '优先股最终全身而退且年息 9%，但过程中他被迫出任董事长收拾烂摊子，自评付出了大量时间。',
        'lesson': '和声名有污点的管理层做交易，条款再好也是输家的游戏。',
        'src': '1987/1991/1997 信件 + 整理',
    },
    '房地美': {
        'verdict': 'mix', 'title': '房地美：因为看不懂账本而提前离场',
        'claim': {'year': 1988, 'text': '买入房地美约 4% 股份，当时认为政府赞助企业的信用利差是错误定价。', 'confidence': '中'},
        'timeline': [
            {'y': 1988, 'k': 'act', 't': '买入约 4% 股份'},
            {'y': 2000, 'k': 'act', 't': '因"看不懂政府赞助企业的复杂账本"全部退出'},
            {'y': 2008, 'k': 'fact', 't': '金融危机中两房崩塌被政府接管——八年前退出躲过几乎全部损失'},
        ],
        'outcome': '2000 年退出时获利数倍；事后看这次"看不懂就卖"成了漂亮的择时。',
        'lesson': '"不懂的就不持有"——他把这条原则执行在了一家正在赚钱的公司上。',
        'src': '1988/2000 信件 + 整理',
    },
    '通用再保险': {
        'verdict': 'mix', 'title': '通用再保险：用十年修复的收购',
        'claim': {'year': 1998, 'text': '以约 220 亿美元股票全资收购通用再保险——当时认为是扩张浮存金的捷径。', 'confidence': '高（事后自认付价过高）'},
        'timeline': [
            {'y': 1998, 'k': 'act', 't': '220 亿美元换股全资收购'},
            {'y': 2001, 'k': 'fact', 't': '"9·11"巨亏暴露承保纪律松弛，浮存金成本多年高于国债利率'},
            {'y': 2010, 'k': 'claim', 't': '整改近十年后重新成为核心引擎——"规模不等于纪律"'},
        ],
        'outcome': '收购后头几年浮存金成本飙升，整改近十年才变成优质资产；他自评"为浮存金付了太高的价钱"。',
        'lesson': '好生意买贵了 + 纪律松弛，就要用十年去修；浮存金只有成本够低才是优势。',
        'src': '1998/2001/2010 信件 + 整理',
    },
    '苹果': {
        'verdict': 'hit', 'title': '苹果：87 岁才等来的科技重仓',
        'claim': {'year': 2016, 'text': '2016 年首次买入苹果——当时市场共识是 iPhone 见顶。', 'confidence': '中'},
        'timeline': [
            {'y': 2016, 'k': 'act', 't': '初建仓位，伯克希尔首次重仓科技股'},
            {'y': 2018, 'k': 'claim', 't': '"苹果不只是股票，是我们的第三大生意"——生态与用户黏性构成护城河'},
            {'y': 2020, 'k': 'act', 't': '开始减持（2020 年）'},
            {'y': 2024, 'k': 'fact', 't': '仍持有约 7.9 亿股，市值 1,675 亿美元，第一大持仓（信件原文）'},
        ],
        'outcome': '买入后成为伯克希尔史上最大单一盈利来源；陆续减持约三分之二，但始终保留核心仓位。',
        'lesson': '能力圈可以扩展——但要等到真正看懂"它为什么留得住用户"再重仓。',
        'src': '2016/2018/2020/2024 信件 + 整理',
    },
    '比亚迪': {
        'verdict': 'hit', 'title': '比亚迪：芒格强力推动的十倍仓',
        'claim': {'year': 2008, 'text': '以每股 8 港元买入约 10% 股份——芒格说"不买就错过"的那家。', 'confidence': '中'},
        'timeline': [
            {'y': 2008, 'k': 'act', 't': '每股 8 港元买入约 10% 股份（约 2.3 亿美元）'},
            {'y': 2022, 'k': 'act', 't': '股价数十倍后开始减持，减持过半仍保留部分'},
        ],
        'outcome': '8 港元买入、数十倍价位减持；他自评"部分减持可能为时过早"。',
        'lesson': '看不懂全部细节，也可以在价格远低于价值时下注——但仓位要匹配理解深度。',
        'src': '2008/2022 信件 + 整理',
    },
    '美国银行': {
        'verdict': 'hit', 'title': '美国银行：救火条款的教科书',
        'claim': {'year': 2011, 'text': '金融危机余波中以 50 亿美元买入 6% 股息优先股 + 认股权证。', 'confidence': '高'},
        'timeline': [
            {'y': 2011, 'k': 'act', 't': '50 亿美元优先股（年息 6%）+ 约 7 亿股认股权证'},
            {'y': 2017, 'k': 'act', 't': '行权换成普通股'},
            {'y': 2024, 'k': 'fact', 't': '市值超 300 亿美元，第二大持仓'},
        ],
        'outcome': '优先股先落袋 6%/年，行权后普通股再翻倍——"救火条款"设计的样板。',
        'lesson': '在别人被迫卖的时候，你可以要到任何条款。',
        'src': '2011/2017/2024 信件 + 整理',
    },
    'BNSF铁路': {
        'verdict': 'hit', 'title': 'BNSF：对美国未来的世纪下注',
        'claim': {'year': 2009, 'text': '以约 440 亿美元全资收购伯灵顿北方——"把全部身家押在美国的未来上"。', 'confidence': '高'},
        'timeline': [
            {'y': 2009, 'k': 'act', 't': '440 亿美元现金 + 股票全资收购'},
            {'y': 2014, 'k': 'fact', 't': '信中用与联合太平洋的对比检讨资本密集行业的回报'},
            {'y': 2020, 'k': 'fact', 't': '铁路成为伯克希尔五大引擎之一，贡献数十亿美元年利润'},
        ],
        'outcome': '收购后美国铁路运量回升，BNSF 成为非保险业务的核心引擎。',
        'lesson': '资本密集生意只有在买价够低、且永不需要再融资时才值得拿。',
        'src': '2009/2014/2020 信件 + 整理',
    },
    '卡夫亨氏': {
        'verdict': 'miss', 'title': '卡夫亨氏：为品牌付了太高的价钱',
        'claim': {'year': 2015, 'text': '与 3G 资本合作合并卡夫与亨氏——经典品牌 + 削减成本公式。', 'confidence': '高（事后自认错判）'},
        'timeline': [
            {'y': 2015, 'k': 'act', 't': '与 3G 合作完成合并，伯克希尔持股约 26.7%'},
            {'y': 2019, 'k': 'act', 't': '减记无形资产 30 亿美元，当年信中明确认错'},
            {'y': 2024, 'k': 'fact', 't': '至今持有，市值低于成本，信中多年不再展开讨论'},
        ],
        'outcome': '品牌是真护城河，但收购杠杆 + 过高价格没有兑现增长；持股至今浮亏。',
        'lesson': '品牌是护城河，但买价可以毁掉整笔投资；杠杆会放大这个错误。',
        'src': '2015/2019/2024 信件 + 整理',
    },
    '西方石油': {
        'verdict': 'hit', 'title': '西方石油：保底 + 期权的三层结构',
        'claim': {'year': 2019, 'text': '为西方石油提供 100 亿美元优先股融资（股息 8%）。', 'confidence': '高'},
        'timeline': [
            {'y': 2019, 'k': 'act', 't': '100 亿美元优先股（年息 8%）+ 认股权证'},
            {'y': 2022, 'k': 'act', 't': '油价回升后大举增持普通股至约 25%'},
            {'y': 2025, 'k': 'fact', 't': '持续增持，仍在其前几大普通股持仓之列'},
        ],
        'outcome': '优先股保底 + 权证参与上行 + 低吸普通股，三层结构全部兑现。',
        'lesson': '强周期生意用"保底 + 期权"结构，比直接判断价格稳健得多。',
        'src': '2019/2022 信件 + 整理',
    },
}

# 公司引用的概念原话(做自动卡片的"他说"素材)
CO_QUOTES = {}
for _cn, _cv in concepts.items():
    for _q in _cv['quotes']:
        _qt = WS.sub('', _q['t'])
        for _nm, _cc in companies.items():
            for _s in surfaces_for(_nm, _cc.get('en', '')):
                if len(_s) >= 2 and WS.sub('', _s) in _qt:
                    CO_QUOTES.setdefault(_nm, []).append({'y': _q['y'], 't': _q['t'], 'loc': _q.get('loc')})
                    break

ACT_PAT = re.compile(r'买入|增持|减持|清仓|出售|卖出|收购|投资|建立|持股比例|换股|退出|买进')
CLAIM_PAT = re.compile(r'说|认为|表示|写道|评价|指出|强调|称[，：]|自评')

def _classify(note):
    if ACT_PAT.search(note):
        return 'act'
    if CLAIM_PAT.search(note):
        return 'claim'
    return 'fact'

def _auto_card(name, c, corr_list):
    tl = [t for t in c['timeline'] if year0(t['y'])]
    items = []
    for t in tl:
        note = (t.get('note') or '').strip()
        if t.get('tbl'):
            note = '该年以持仓表形式出现在信中'
        items.append({'y': year0(t['y']), 'k': _classify(note) if not t.get('tbl') else 'fact',
                      't': note[:90] or '该年有提及', 'loc': t.get('loc')})
    for q in CO_QUOTES.get(name, [])[:4]:
        items.append({'y': q['y'], 'k': 'claim', 't': q['t'][:90], 'loc': q.get('loc')})
    items.sort(key=lambda x: x['y'])
    # 控制篇幅: 头 2 条 + 全部他说/动作(至多 8) + 尾 2 条
    if len(items) > 12:
        keep = set(range(0, 2)) | {i for i, x in enumerate(items) if x['k'] in ('act', 'claim')} | set(range(len(items) - 2, len(items)))
        items = [x for i, x in enumerate(items) if i in keep][:12]
    ys = c['years']
    exit_hit = any(re.search(r'清仓|全部出售|退出', t.get('note') or '') for t in tl)
    last_y = ys[-1] if ys else 0
    status = '已退出' if exit_hit else ('近年仍提及' if last_y >= 2015 else '')
    ks = {x['k'] for x in corr_list}
    verdict = 'miss' if ks & {'error', 'reverse'} else ('mix' if ks & {'admit', 'lesson'} else '')
    claim = None
    qs = CO_QUOTES.get(name, [])
    if qs:
        q0 = sorted(qs, key=lambda q: q['y'])[0]
        claim = {'year': q0['y'], 'text': q0['t'][:110], 'confidence': ''}
    elif items:
        for it in items:
            if it['k'] == 'claim':
                claim = {'year': it['y'], 'text': it['t'], 'confidence': ''}
                break
    outcome = '首次提及 %s，最后一次 %s，共 %d 个年份出现在信中%s。' % (
        ys[0] if ys else '—', ys[-1] if ys else '—', len(ys),
        ('，' + status) if status else '')
    if not claim and items:
        n0 = items[0]['t']
        if len(re.findall(r'[\u4e00-\u9fff]', n0)) >= 8:
            outcome = n0[:60] + '……' + outcome
    lesson = ''
    for x in corr_list:
        if x['k'] in ('lesson', 'error', 'admit', 'reverse'):
            lesson = x['t'][:90]
            break
    return {'auto': True, 'verdict': verdict, 'status': status, 'claim': claim,
            'timeline': items, 'outcome': outcome, 'lesson': lesson,
            'src': '自动整理（时间线 + 概念原话 + 认错档案归类）'}

scorecards = {}
for name, card in CURATED.items():
    if name in companies:
        scorecards[name] = dict(card, entity=name, entityKind='companies')
for name, c in companies.items():
    if name not in scorecards:
        scorecards[name] = dict(_auto_card(name, c, by_ent.get(name, [])),
                                entity=name, entityKind='companies', title=name)

# ---------- 8. 入门导引 (主题 -> 自动选年份) ----------
PATHS_DEF = [
    {'id': 'p-value', 'title': '想学会给一家公司估值',
     'desc': '从"便宜"到"值多少钱"，他的估值方法自己改过三次口。',
     'concepts': ['内在价值', '安全边际', '账面价值', '市盈率']},
    {'id': 'p-hold', 'title': '想搞懂他凭什么拿得住',
     'desc': '可口可乐拿了三十多年，中间七年不涨。支撑他的是什么。',
     'concepts': ['护城河', '长期持有', '竞争优势', '品牌']},
    {'id': 'p-miss', 'title': '想看他怎么认错',
     'desc': '成功可能是运气，认错才是确定的认知更新。',
     'concepts': ['收购', '管理层', '资本配置']},
    {'id': 'p-risk', 'title': '想学怎么避开坑',
     'desc': '他一生的告诫里，重复次数最多的几条。',
     'concepts': ['杠杆', '衍生品', '市场预测', '分散投资']},
    {'id': 'p-first', 'title': '从第一封开始读',
     'desc': '1957 年，他 27 岁，第一次给合伙人写信。',
     'concepts': ['低估', '套利']},
]
paths = []
for p in PATHS_DEF:
    ys = []
    for cn in p['concepts']:
        if cn in concepts:
            ys += [q['y'] for q in concepts[cn]['quotes']]
    cnt = {}
    for y in ys:
        cnt[y] = cnt.get(y, 0) + 1
    top = [y for y, _ in sorted(cnt.items(), key=lambda kv: (-kv[1], kv[0]))[:5]]
    if p['id'] == 'p-first':
        top = [1957, 1958, 1961, 1962, 1969]
    paths.append({'id': p['id'], 'title': p['title'], 'desc': p['desc'],
                  'concepts': [c for c in p['concepts'] if c in concepts],
                  'years': sorted(top)})

# ================= 校验输出 =================
if __name__ == '__main__':
    np = sum(len(v['periods']) for v in concepts.values())
    nq = sum(len(v['quotes']) for v in concepts.values())
    nr = sum(len(v['related']) for v in concepts.values())
    nc = sum(len(v['cases']) for v in concepts.values())
    nt = sum(v['n'] for v in companies.values())
    print('概念 %d 个: 分期 %d  原话 %d  相关概念 %d  案例公司 %d' % (len(concepts), np, nq, nr, nc))
    print('公司 %d 家: 时间线条目 %d  平均 %.1f 条/家' % (len(companies), nt, nt / len(companies)))
    zq = [k for k, v in concepts.items() if not v['quotes']]
    zp = [k for k, v in concepts.items() if not v['periods']]
    zt = [k for k, v in companies.items() if v['n'] == 0]
    print('  原话为空的概念: %s' % (zq or '无'))
    print('  分期为空的概念: %s' % (zp if len(zp) < 8 else '%d 个' % len(zp)))
    print('  时间线为空的公司: %s' % (zt or '无'))
    print()
    nf = sum(v['filled'] for v in companies.values())
    print('  时间线要点: 原文自带 %d 条, 从正文回填 %d 条, 仍为空 %d 条' % (
        nt - sum(1 for v in companies.values() for t in v['timeline'] if not t['note']),
        nf,
        sum(1 for v in companies.values() for t in v['timeline'] if not t['note'])))
    print()
    print('认错档案: 句子 %d 条 (涉及 %d 年), 聚合成 >=2 条的实体档案 %d 个' % (
        len(corrections), len({c['y'] for c in corrections}), len(corr_topics)))
    from collections import Counter
    print('  分类:', dict(Counter(c['k'] for c in corrections)))
    print('  TOP 实体:', ', '.join('%s(%d)' % (t['ent'], len(t['items'])) for t in corr_topics[:6]))
    print()
    print('决策规则库: %d 条 (全部为原话, 教训类已按需求移除)' % len(rules))
    print('入门导引: %d 条' % len(paths))
    for p in paths:
        print('  %s -> %s' % (p['title'], p['years']))
    print()
    nl = sum(1 for v in concepts.values() for q in v['quotes'] if q.get('loc'))
    nq2 = sum(len(v['quotes']) for v in concepts.values())
    print('原话可定位回原文: %d / %d (%.0f%%)' % (nl, nq2, 100 * nl / max(nq2, 1)))
    nc_ = sum(1 for c in corrections if c.get('loc'))
    print('认错句可定位回原文: %d / %d' % (nc_, len(corrections)))
    ntl = sum(1 for v in companies.values() for t in v['timeline'] if t.get('loc'))
    ntt = sum(v['n'] for v in companies.values())
    print('时间线可定位回原文: %d / %d' % (ntl, ntt))
    nj = sum(1 for v in companies.values() for t in v['timeline'] if t.get('tbl'))
    print('时间线"持仓表"行(数字行, 点跳原文表): %d 条' % nj)
    print('记分牌卡片: 人工整理 %d 家 + 自动 %d 家 = %d 家' % (
        sum(1 for v in scorecards.values() if not v.get('auto')),
        sum(1 for v in scorecards.values() if v.get('auto')), len(scorecards)))
    print()
    os.makedirs(OUT, exist_ok=True)
    content = {'concepts': concepts, 'companies': companies,
               'corrections': corrections, 'corrTopics': corr_topics,
               'rules': rules, 'paths': paths, 'scorecards': scorecards}
    with open(os.path.join(OUT, 'data-content.js'), 'w', encoding='utf-8') as f:
        f.write('window.CONTENT = ')
        json.dump(content, f, ensure_ascii=False, separators=(',', ':'))
        f.write(';\n')
    print('  写 data-content.js %.1f KB' % (
        os.path.getsize(os.path.join(OUT, 'data-content.js')) / 1024))
    print()
    print('=== 抽样: 护城河 分期 ===')
    for p in concepts['护城河']['periods']:
        print('  %s(%d-%d) %s' % (p['name'], p['y0'], p['y1'], p['text'][:60]))
    print()
    print('=== 抽样: 能力圈 原话 ===')
    for q in concepts['能力圈']['quotes'][:3]:
        print('  [%d %s信] %s' % (q['y'], q['kind'], q['t'][:60]))
    print()
    print('=== 抽样: 可口可乐 时间线(前5) ===')
    for t in companies['可口可乐']['timeline'][:5]:
        print('  %s | %s | %s' % (t['y'], t['letter'][:20], t['note'][:60]))
    print()
    print('=== 抽样: IBM 时间线(前4, 格式A) ===')
    for t in companies['IBM']['timeline'][:4]:
        print('  %s | %s | %s' % (t['y'], t['letter'][:20], t['note'][:60]))
