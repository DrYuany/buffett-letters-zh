# -*- coding: utf-8 -*-
"""
读巴菲特 — ETL
输入: _src/buffett-letters (GitHub Sphinm/buffett-letters)
输出: site/data-core.js  site/data-letters.js

设计原则:
  1. 确定性抽取,不过 LLM -> 数字与原文零失真
  2. 段落级单元,每块有稳定坐标 (year + blockIdx) -> 上层所有机制依赖这个坐标
  3. 实体用字面匹配建倒排 -> 精确归属,不用向量
"""
import re, os, glob, json, sys

SRC = '_src/buffett-letters'
OUT = 'site'
os.makedirs(OUT, exist_ok=True)

# ---------- 1. 读实体名单,自动抽取英文名 ----------
def load_entities(kind_dir):
    ents = []
    for f in sorted(glob.glob(os.path.join(SRC, kind_dir, '*.md'))):
        name = os.path.basename(f)[:-3]
        raw = open(f, encoding='utf-8').read()
        body = raw.split('---', 1)[-1]
        en = ''
        m = re.search(r'[（(]\s*([A-Za-z][A-Za-z0-9 .\-&,\']{1,45})\s*[）)]', body[:400])
        if m:
            en = m.group(1).strip()
        # 正文摘要(概念解析第一段)
        summ = ''
        m2 = re.search(r'概念解析\s*\n(.{20,260})', body, re.S)
        if m2:
            summ = re.sub(r'\s+', ' ', m2.group(1)).strip()
        if not summ:
            m3 = re.search(r'公司简介\s*\n(.{20,260})', body, re.S)
            if m3:
                summ = re.sub(r'\s+', ' ', m3.group(1)).strip()
        ents.append({'name': name, 'en': en, 'summary': summ, 'kind': kind_dir})
    return ents

companies = load_entities('companies')
concepts  = load_entities('concepts')
people    = load_entities('people')

# ---------- 1b. 自动补录实体(独立核实后补的, 源仓库清单缺这些) ----------
# 实测: 沃尔玛26次/16年, 宝洁22次/15年, 卡夫40次+亨氏57次(并入卡夫亨氏别名), 强生9次,
# 达美/西南航空各5次, 凯瑟琳·格雷厄姆11次, 比尔·盖茨9次, 卢·辛普森26次,
# 优先股147次/29年, 折旧86次/31年 —— 均不在源清单。
# 这些实体没有人工档案页, 只有原文出场追踪(auto 标记)
AUTO_ENTS = [
    {'kind': 'companies', 'name': '沃尔玛', 'en': 'Walmart', 'summary': '信件中多次提及的零售商（1990-2015）。自动补录，无人工档案。'},
    {'kind': 'companies', 'name': '宝洁', 'en': 'Procter & Gamble', 'summary': '消费必需品公司，2005-2015 年间在信中出现。自动补录，无人工档案。'},
    {'kind': 'companies', 'name': '强生', 'en': 'Johnson & Johnson', 'summary': '医药健康公司，2006-2011 年间在信中出现。自动补录，无人工档案。'},
    {'kind': 'companies', 'name': '通用动力', 'en': 'General Dynamics', 'summary': '1992-93 年投资过、2021 年再度出现的防务公司。自动补录，无人工档案。'},
    {'kind': 'companies', 'name': '达美航空', 'en': 'Delta Air Lines', 'summary': '2016-2019 年持有的四大航空之一，2020 年清仓。自动补录，无人工档案。'},
    {'kind': 'companies', 'name': '西南航空', 'en': 'Southwest Airlines', 'summary': '2016-2019 年持有的四大航空之一，2020 年清仓。自动补录，无人工档案。'},
    {'kind': 'companies', 'name': '安海斯-布希', 'en': 'Anheuser-Busch', 'summary': '啤酒厂商，2005-2008 年间短暂持有。自动补录，无人工档案。'},
    {'kind': 'companies', 'name': '汉迪哈曼', 'en': 'Handy & Harman', 'summary': '1979-86 年提及的金属加工公司。自动补录，无人工档案。'},
    {'kind': 'companies', 'name': '联合太平洋', 'en': 'Union Pacific', 'summary': 'BNSF 的竞争对手，2014 年信中提及。自动补录，无人工档案。'},
    {'kind': 'companies', 'name': '惠普', 'en': 'HP', 'summary': '2022 年买入的计算机公司。自动补录，无人工档案。'},
    {'kind': 'concepts', 'name': '优先股', 'en': 'Preferred Stock', 'summary': '所罗门/高盛/美国银行等救市投资的核心工具，信中出现 147 次。自动补录，无人工档案。'},
    {'kind': 'concepts', 'name': '折旧', 'en': 'Depreciation', 'summary': '喜诗糖果等案例中反复讨论的会计概念。自动补录，无人工档案。'},
    {'kind': 'people', 'name': '凯瑟琳·格雷厄姆', 'en': 'Katharine Graham', 'summary': '华盛顿邮报发行人，巴菲特一生的挚友与导师。自动补录，无人工档案。'},
    {'kind': 'people', 'name': '比尔·盖茨', 'en': 'Bill Gates', 'summary': '1994-2024 年信中多次提及，伯克希尔董事。自动补录，无人工档案。'},
    {'kind': 'people', 'name': '苏茜·巴菲特', 'en': 'Susie Buffett', 'summary': '巴菲特夫人，1961-69 合伙人信中多次出现。自动补录，无人工档案。'},
    {'kind': 'people', 'name': '卢·辛普森', 'en': 'Lou Simpson', 'summary': '盖可保险投资主管，1982-2010 年信中多次提及。自动补录，无人工档案。'},
    {'kind': 'people', 'name': '菲利普·费雪', 'en': 'Philip Fisher', 'summary': '《怎样选择成长股》作者，影响巴菲特后期投资哲学。自动补录，无人工档案。'},
    {'kind': 'people', 'name': '彼得·林奇', 'en': 'Peter Lynch', 'summary': '麦哲伦基金经理，1988/1993 年信中提及。自动补录，无人工档案。'},
    {'kind': 'people', 'name': '沃尔特·施洛斯', 'en': 'Walter Schloss', 'summary': '格雷厄姆系价值投资者，2006 年信中提及。自动补录，无人工档案。'},
    # 会议/演讲里新发现的实体（2026-11 实体发现：只出现在会议/演讲、信件名单里没有）
    {'kind': 'companies', 'name': '好市多', 'en': 'Costco', 'summary': '仓储式零售巨头，股东会上多次作为好生意范例被讨论。'},
    {'kind': 'companies', 'name': '前进保险', 'en': 'Progressive', 'summary': '美国汽车保险公司，股东会上讨论保险业时提及。'},
    {'kind': 'companies', 'name': '美国国际集团', 'en': 'AIG', 'summary': '保险集团，金融危机期间被反复提及。'},
    {'kind': 'companies', 'name': '联合服务汽车协会', 'en': 'USAA', 'summary': '面向军人的保险与金融服务协会，盖可创始人早年任职之处。'},
    {'kind': 'companies', 'name': '太平洋电力公司', 'en': 'PacifiCorp', 'summary': '西部公用事业，2006 年伯克希尔收购，后并入 BHE。'},
    {'kind': 'companies', 'name': '领航旅行中心', 'en': 'Pilot', 'summary': '卡车服务站与加油站运营商，伯克希尔近年增持至控股。'},
    {'kind': 'companies', 'name': '长期资本管理公司', 'en': 'LTCM', 'summary': '1998 年崩溃的对冲基金，常被用作杠杆风险的教训。'},
    {'kind': 'companies', 'name': '全美航空', 'en': 'USAir', 'summary': '美国航空公司，伯克希尔 1989 年买入其优先股。'},
    {'kind': 'companies', 'name': '好事达保险', 'en': 'Allstate', 'summary': '美国保险公司，股东会上与盖可对比时提及。'},
    {'kind': 'companies', 'name': '福特汽车', 'en': 'Ford', 'summary': '汽车制造商，讨论汽车业时提及。'},
    {'kind': 'companies', 'name': '波音公司', 'en': 'Boeing', 'summary': '飞机制造商，讨论制造业时提及。'},
    {'kind': 'companies', 'name': '花旗集团', 'en': 'Citigroup', 'summary': '银行，讨论银行业时提及。'},
    {'kind': 'companies', 'name': '美孚石油', 'en': 'Mobil', 'summary': '石油公司，埃克森美孚前身之一。'},
    {'kind': 'companies', 'name': '洛克伍德巧克力公司', 'en': 'Rockwood Chocolate', 'summary': '巧克力公司，合伙人时期持有。'},
    {'kind': 'companies', 'name': '堪萨斯城南方铁路', 'en': 'Kansas City Southern', 'summary': '铁路公司，讨论铁路并购时提及。'},
    {'kind': 'companies', 'name': '基威特公司', 'en': 'Kiewit', 'summary': '工程与建筑公司，巴菲特本人长期个人股东。'},
    {'kind': 'companies', 'name': '苏黎世保险', 'en': 'Zurich', 'summary': '瑞士保险公司，2025 年与伯克希尔达成巨额保单合作。'},
    {'kind': 'companies', 'name': '安达保险', 'en': 'Chubb', 'summary': '保险公司，2025 年与伯克希尔达成巨额保单合作。'},
    {'kind': 'companies', 'name': '伊利诺伊国民银行', 'en': 'Illinois National Bank', 'summary': '银行，国民保险公司收购案的相关背景。'},
    {'kind': 'companies', 'name': '范图尔集团', 'en': 'Van Tuyl', 'summary': '汽车经销商集团，2015 年伯克希尔收购。'},
    {'kind': 'companies', 'name': 'Finova', 'en': 'Finova', 'summary': '金融服务公司，伯克希尔 2001 年投资。'},
    {'kind': 'companies', 'name': 'MiTek', 'en': 'MiTek', 'summary': '建筑产品公司，伯克希尔子公司。'},
    {'kind': 'companies', 'name': 'H.H. Brown', 'en': 'H.H. Brown', 'summary': '鞋业公司，伯克希尔子公司。'},
    {'kind': 'companies', 'name': 'CTB', 'en': 'CTB', 'summary': '农业设备公司，伯克希尔子公司。'},
    {'kind': 'companies', 'name': 'Leucadia', 'en': 'Leucadia', 'summary': '金融控股公司，与伯克希尔合资 Berkadia。'},
    {'kind': 'companies', 'name': 'Berkadia', 'en': 'Berkadia', 'summary': '商业地产金融服务，伯克希尔与 Leucadia 合资。'},
    {'kind': 'companies', 'name': '蒂芙尼', 'en': 'Tiffany', 'summary': '珠宝公司，讨论品牌时提及。'},
    {'kind': 'companies', 'name': 'AOL', 'en': 'AOL', 'summary': '互联网服务商，讨论科技股时提及。'},
    {'kind': 'companies', 'name': 'Uber', 'en': 'Uber', 'summary': '出行平台，讨论科技公司时提及。'},
    {'kind': 'companies', 'name': 'LVMH', 'en': 'LVMH', 'summary': '奢侈品集团，讨论品牌护城河时提及。'},
    {'kind': 'companies', 'name': 'Vanguard', 'en': 'Vanguard', 'summary': '资产管理公司，讨论指数基金时提及。'},
    {'kind': 'companies', 'name': 'Teledyne', 'en': 'Teledyne', 'summary': '工业集团，讨论资本配置时提及。'},
    {'kind': 'companies', 'name': 'Unocal', 'en': 'Unocal', 'summary': '石油公司，后被雪佛龙收购。'},
    {'kind': 'companies', 'name': 'USG', 'en': 'USG', 'summary': '建筑材料公司，伯克希尔曾持有。'},
    {'kind': 'companies', 'name': 'Equitas', 'en': 'Equitas', 'summary': '保险实体，承继劳合社历史负债。'},
    {'kind': 'companies', 'name': 'Visa', 'en': 'Visa', 'summary': '支付网络，讨论支付与品牌时提及。'},
    {'kind': 'companies', 'name': '迪士尼', 'en': 'Disney', 'summary': '传媒娱乐公司，讨论媒体与内容时提及。'},
    {'kind': 'companies', 'name': '派拉蒙环球', 'en': 'Paramount', 'summary': '传媒公司，伯克希尔曾持有。'},
    {'kind': 'companies', 'name': '谷歌', 'en': 'Google', 'summary': '科技公司，讨论科技股时提及。'},
    {'kind': 'companies', 'name': '脸书', 'en': 'Facebook', 'summary': '科技公司，讨论科技股时提及。'},
    {'kind': 'companies', 'name': '阿勒格尼公司', 'en': 'Alleghany', 'summary': '保险控股公司，2022 年伯克希尔以约 110 亿美元收购。'},
    # 第二轮实体补充（2026-11）：英文候选里的明确公司/机构
    {'kind': 'companies', 'name': 'TTI', 'en': 'TTI', 'summary': '电子元器件分销商，2007 年伯克希尔收购，股东会上多次提及。'},
    {'kind': 'companies', 'name': 'Phillips 66', 'en': 'Phillips 66', 'summary': '炼油与加油站公司，2012 年从康菲石油分拆，会上作为加油站品牌被提及。'},
    {'kind': 'companies', 'name': 'Dr Pepper', 'en': 'Dr Pepper', 'summary': '软饮料公司，会上讨论软饮市场份额时提及。'},
    {'kind': 'companies', 'name': 'Value Line', 'en': 'Value Line', 'summary': '投资研究出版物，巴菲特与芒格各订一份。'},
    {'kind': 'companies', 'name': 'ESPN', 'en': 'ESPN', 'summary': '体育电视网络，会上讨论迪士尼对它的经营时提及。'},
    {'kind': 'companies', 'name': 'Unicover', 'en': 'Unicover', 'summary': '1999 年爆雷的再保险安排，会上讨论再保险损失分配时提及。'},
    {'kind': 'companies', 'name': 'Pinkerton', 'en': 'Pinkerton', 'summary': '安保公司，巴菲特早年曾任其董事。'},
    {'kind': 'companies', 'name': 'Cities Service', 'en': 'Cities Service', 'summary': '石油公司（后并入 CITGO），巴菲特 11 岁买的第一只股票。'},
    {'kind': 'companies', 'name': 'UPS', 'en': 'UPS', 'summary': '包裹快递公司，会上提及。'},
    {'kind': 'companies', 'name': '万事达', 'en': 'Mastercard', 'summary': '支付网络，会上与 Visa 对比时提及。'},
    {'kind': 'companies', 'name': 'Hochschild Kohn', 'en': 'Hochschild Kohn', 'summary': '巴尔的摩百货公司，巴菲特 1966 年收购的早期投资。'},
    # 第二轮实体补充（2026-11）：无尾缀中文公司名
    {'kind': 'companies', 'name': '微软', 'en': 'Microsoft', 'summary': '软件巨头，会上多次作为科技股范例被讨论。'},
    {'kind': 'companies', 'name': '亚马逊', 'en': 'Amazon', 'summary': '电商与云计算公司，巴菲特买过其债券却错过其股票。'},
    {'kind': 'companies', 'name': '麦当劳', 'en': "McDonald's", 'summary': '快餐连锁，会上多次作为优秀生意范例被讨论。'},
    {'kind': 'companies', 'name': '摩根大通', 'en': 'JPMorgan', 'summary': '美国大银行，会上讨论银行衍生品时提及。'},
    {'kind': 'companies', 'name': '英特尔', 'en': 'Intel', 'summary': '半导体公司，会上讨论科技公司与管理层时提及。'},
    {'kind': 'companies', 'name': '瑞士再保险', 'en': 'Swiss Re', 'summary': '再保险巨头，伯克希尔曾与其达成再保险交易。'},
    {'kind': 'companies', 'name': '埃克森美孚', 'en': 'ExxonMobil', 'summary': '石油巨头，会上讨论石油产量时提及。'},
    {'kind': 'companies', 'name': '健力士', 'en': 'Guinness', 'summary': '啤酒与烈酒公司，会上讨论其持有 LVMH 股权时提及。'},
    {'kind': 'companies', 'name': '贝尔斯登', 'en': 'Bear Stearns', 'summary': '投行，金融危机期间倒闭，会上讨论救助时提及。'},
    {'kind': 'companies', 'name': '动视暴雪', 'en': 'Activision Blizzard', 'summary': '游戏公司，伯克希尔曾做其被微软收购的套利。'},
    {'kind': 'companies', 'name': '吉百利', 'en': 'Cadbury', 'summary': '糖果公司，会上讨论卡夫收购它时提及。'},
    {'kind': 'companies', 'name': '雅虎', 'en': 'Yahoo', 'summary': '互联网门户公司，会上讨论科技股时提及。'},
    {'kind': 'companies', 'name': '耐克', 'en': 'Nike', 'summary': '运动品牌公司，会上讨论品牌时提及。'},
    {'kind': 'companies', 'name': '慕尼黑再保险', 'en': 'Munich Re', 'summary': '再保险巨头，会上与瑞士再保险一同作为承保能力对比提及。'},
]
companies += [dict(e, auto=True) for e in AUTO_ENTS if e['kind'] == 'companies']
concepts  += [dict(e, auto=True) for e in AUTO_ENTS if e['kind'] == 'concepts']
people    += [dict(e, auto=True) for e in AUTO_ENTS if e['kind'] == 'people']

# 高价值别名(仅手工补最关键的,其余靠字面匹配)
ALIAS = {
    '盖可保险': ['GEICO', '盖可'], '可口可乐': ['Coca-Cola'], '喜诗糖果': ["See's", "See’s", "See's Candy", "See's Candies"],
    '伯克希尔哈撒韦': ['Berkshire', '伯克希尔'], '美国运通': ['American Express', '运通'],
    '中国石油': ['PetroChina'], '苹果': ['Apple'], 'BNSF铁路': ['BNSF', '伯灵顿', 'Burlington'],
    '富国银行': ['Wells Fargo'], '通用再保险': ['Gen Re'], '德克斯特鞋业': ['Dexter'],
    '康菲石油': ['ConocoPhillips'], '华盛顿邮报': ['Washington Post'],
    '芒格': ['Munger', '查理'], '格雷厄姆': ['Graham'], '阿吉特·贾恩': ['Ajit', '贾恩'],
    'B夫人': ['Mrs. B', 'Mrs B'], '格雷格·阿贝尔': ['Greg Abel', '阿贝尔'],
    '托德·库姆斯': ['Todd Combs', '库姆斯', '托德'], '泰德·韦施勒': ['Ted Weschler', '韦施勒', '泰德'],
    '内布拉斯加家具店': ['NFM'], '大都会通信': ['Capital Cities', 'Cap Cities', 'ABC'],
    '蓝筹印花': ['Blue Chip'], '所罗门': ['Salomon'], '穆迪': ["Moody's"],
    '比亚迪': ['BYD'], '利捷航空': ['NetJets', 'Executive Jet'], '冰雪皇后': ['Dairy Queen'],
    '通用电气': ['GE', 'General Electric'], '雪佛龙': ['Chevron'],
    # 合并/改名的实体与同概念变体(独立核实后补):
    '卡夫亨氏': ['卡夫', '亨氏', 'Kraft', 'Heinz'],          # 2015 合并前分称卡夫/亨氏
    '收购': ['并购'], '账面价值': ['净资产'], '分散投资': ['多元化'],
    # 自动补录实体的别名:
    '沃尔玛': ['Wal-Mart'], '宝洁': ['P&G'], '强生': ['Johnson'],
    '通用动力': ['General Dynamics'], '达美航空': ['Delta'],
    '西南航空': ['Southwest'], '安海斯-布希': ['安海斯', 'Anheuser'],
    '汉迪哈曼': ['Handy & Harman'], '联合太平洋': ['Union Pacific'],
    '惠普': ['Hewlett-Packard', 'HPQ'],
    '凯瑟琳·格雷厄姆': ['凯瑟琳'], '比尔·盖茨': ['盖茨'],
    '苏茜·巴菲特': ['苏茜'], '卢·辛普森': ['辛普森'],
    '菲利普·费雪': ['费雪'], '彼得·林奇': ['林奇'], '沃尔特·施洛斯': ['施洛斯'],
    # 会议/演讲实体发现时暴露的别名缺口（同一实体在不同语料里的叫法）:
    '马蒙集团': ['美联集团', 'Marmon'], '国民保险公司': ['国民赔偿公司', 'National Indemnity'],
    # 第二轮实体补充时暴露的别名缺口:
    '花旗集团': ['花旗', '花旗银行'],           # 花旗/Citibank 并入花旗集团
    '全美航空': ['US Airways'],                 # USAir 1997 年改名
    'Phillips 66': ['Phillips'],
    'Dr Pepper': ['Dr. Pepper'],
    'Cities Service': ['City Service'],
    '万事达': ['Master Charge'],
    'Hochschild Kohn': ['Hochschild-Kohn'],
    '埃克森美孚': ['埃克森'],
}

def surfaces(e):
    s = {e['name']}
    if e['en'] and len(e['en']) >= 2:
        s.add(e['en'])
    for a in ALIAS.get(e['name'], []):
        s.add(a)
    # 去掉过短的英文,避免误伤
    return {x for x in s if len(x) >= 2}

ALL_ENTS = companies + concepts + people
SURF = {e['name']: surfaces(e) for e in ALL_ENTS}

# ---------- 2. 切块 ----------
NUMISH = re.compile(r'^\(?-?[\d,]+(?:[.\-]\d+)*%?\)?$')
def is_table_row(line):
    """表格行 = 无句号 + 空格分隔的多单元格 + 至少两个数值型单元格。
    单 token 的日期行(如 '1978年3月14日')不算表格,避免误吞签名档。"""
    if '。' in line:
        return False
    cells = line.split()
    if len(cells) < 2:
        return False
    return sum(1 for c in cells if NUMISH.match(c)) >= 2

def is_heading(line, prev_sig):
    t = line.strip()
    if len(t) > 42:
        return False
    if re.search(r'[。，；：！？、]', t):
        return False
    if len(t) <= 20 and not re.search(r'[，。；：！？、（）()]', t):
        return True
    return prev_sig in (None, 'hr', 'table')

def parse_letter(path, year, kind, title):
    raw = open(path, encoding='utf-8').read().replace('\r\n', '\n').replace('\r', '\n')
    lines = raw.split('\n')
    # 跳过 front matter: 到第一个独立的 '---' 为止
    i = 0
    while i < len(lines) and lines[i].strip() != '---':
        i += 1
    i += 1
    blocks, prev_sig, tbl = [], None, None
    for ln in lines[i:]:
        s = ln.strip()
        if not s or s == '---':
            continue
        if set(s) <= set('-: '):        # 表格分隔行
            continue
        if is_table_row(s):
            cells = s.split()
            if tbl is None:
                # 表头紧跟在表格前一行且不含句号 -> 收进表格
                if (blocks and blocks[-1]['k'] == 'p' and len(blocks[-1]['t']) <= 60
                        and not re.search(r'[。，、；：！？]', blocks[-1]['t'])):
                    head = blocks.pop()['t'].split()
                    tbl = {'k': 't', 'head': head, 'rows': []}
                else:
                    tbl = {'k': 't', 'rows': []}
                blocks.append(tbl)
            tbl['rows'].append(cells)
            prev_sig = 'table'
            continue
        tbl = None
        if is_heading(s, prev_sig):
            blocks.append({'k': 'h', 't': s})
            prev_sig = 'h'
        else:
            blocks.append({'k': 'p', 't': s})
            prev_sig = 'p'
    return blocks

letters = []
LET = {}
for kind, dirn in [('partnership', 'partnership'), ('berkshire', 'berkshire'), ('special', 'special')]:
    for f in sorted(glob.glob(os.path.join(SRC, 'letters', dirn, '*.md'))):
        base = os.path.basename(f)[:-3]
        m = re.match(r'(\d{4})', base)
        year = int(m.group(1)) if m else 0
        blocks = parse_letter(f, year, kind, base)
        letters.append({'id': base, 'year': year, 'kind': kind,
                        'title': base, 'n': len(blocks),
                        'chars': sum(len(b.get('t', '')) for b in blocks)})
        LET[base] = {'year': year, 'kind': kind, 'blocks': blocks}

letters.sort(key=lambda x: (x['year'], x['kind']))

# ---------- 3. 实体倒排(精确字面归属) ----------
mentions = {e['name']: [] for e in ALL_ENTS}
CAP = 400
overflow = {}
for lid, L in LET.items():
    for bi, b in enumerate(L['blocks']):
        txt = b.get('t', '')
        if b['k'] == 't':
            txt = ' '.join(' '.join(r) for r in b['rows'])
        if not txt:
            continue
        for e in ALL_ENTS:
            hit = False
            for s in SURF[e['name']]:
                if s in txt:
                    hit = True
                    break
            if hit:
                n = len(mentions[e['name']])
                if n < CAP:
                    mentions[e['name']].append([L['year'], bi, lid])
                else:
                    overflow[e['name']] = overflow.get(e['name'], 0) + 1

# ---------- 4. 记分牌 / 决策卡 (全部取自语料,带出处) ----------
scorecard = [
 # 下面这五条专补"没有买"的那半边。原来 6 条全是买了之后的结果，
 # 于是回测题库天然偏向"买入"。他一生没投的次数远多于投的，缺了这半边，
 # 方向一致率就没有判别力。每条都带原话和出处，不推断。
 {
  'id':'tech1999','title':'科技股：1999 年公开写下"我们不持有"，理由是挑不出赢家',
  'verdict':'mix','entity':'科技股','entityKind':'concepts',
  'claim':{'year':1999,'text':'这也解释了为什么我们不持有科技股，尽管我们和大家一样认为科技产品和服务将深刻改变我们的社会。我们的问题——而且这个问题无法靠恶补来解决——在于，我们无法判断科技行业中的哪些参与者拥有真正持久的竞争优势。',
           'confidence':'极强。1999 年致股东信里公开写明的立场，不是事后追认'},
  'timeline':[
    {'y':1999,'k':'claim','t':'在信里写明不持有科技股的理由：不是看不到它会改变世界，是挑不出谁有持久优势'},
    {'y':1999,'k':'fact','t':'当年标普 500 涨约 21%，伯克希尔仅涨约 0.5%，是他相对表现最差的一年之一'},
    {'y':2000,'k':'fact','t':'互联网泡沫破裂，纳斯达克此后三年跌逾 70%，伯克希尔几乎毫发无损'},
    {'y':2016,'k':'act','t':'买入苹果，第一次把一家科技公司买成第一大重仓'},
    {'y':2017,'k':'claim','t':'股东大会上当众承认"我们完全错过了它。我们从未持有过亚马逊的一股股票"，紧接着补了一句"看懂了——执行才算数"'},
    {'y':2024,'k':'claim','t':'把错过分成两类：看不懂的不可惜，看得懂却没动手才后悔'}
  ],
  'outcome':'短期被骂过时，长期躲过崩盘；代价是错过了科技行业二十年最大的几波涨幅。他自己承认，最后悔的不是"没投看不懂的"，而是"明明看懂了却没下手"。',
  'lesson':'"看不懂就不投"守住了本金，也会让你错过那些只有看懂了才赚得到的钱。他自己的话最狠：看懂了不算数，执行才算数。',
  'src':'1999 股东信 · 1999-2002 行情 · 2016 年建仓苹果 · 2017 / 2024 年股东大会'
 },
 {
  'id':'amazonbond','title':'亚马逊：买了它的垃圾债，没买它的股票',
  'verdict':'mix','entity':'亚马逊','entityKind':'companies',
  'claim':{'year':2007,'text':'2001年和2002年，我们以57%的面值买入了面值3.1亿欧元的亚马逊公司（Amazon.com）2010年到期、票面利率6.875%的债券。当时亚马逊的债券被定价为"垃圾"级信用，尽管它们根本不是。',
           'confidence':'强。2007 年信里主动披露这笔交易的全过程'},
  'timeline':[
    {'y':2001,'k':'act','t':'以约 57% 面值买入亚马逊 2010 年到期的欧元债券，票面 3.1 亿欧元、利率 6.875%'},
    {'y':2002,'k':'fact','t':'买入时欧元均价 0.95 美元，折合美元成本仅 1.69 亿'},
    {'y':2007,'k':'fact','t':'部分债券被赎回收到 2.53 亿美元，年底剩余债券市值 1.62 亿美元'},
    {'y':2007,'k':'fact','t':'累计已实现加未实现收益 2.46 亿美元，其中约 1.18 亿其实来自美元贬值'},
    {'y':2017,'k':'claim','t':'股东大会上承认"我们完全错过了它。我们从未持有过亚马逊的一股股票"'},
    {'y':2024,'k':'claim','t':'"我们最后悔的是，明明能看懂的机会，而且是大机会，眼睁睁错过了。"'}
  ],
  'outcome':'这笔债赚了钱，但一半收益来自汇率而不是判断；真正的大头——亚马逊的股票——从头到尾一股没买，而那才是后来涨了数百倍的资产。',
  'lesson':'看懂一家公司的债券便宜，不等于看懂了它的生意。他买的是"它不会违约"，不是"它会长大"。',
  'src':'2007 股东信 · 2017 / 2024 年股东大会'
 },
 {
  'id':'walmart','title':'沃尔玛：把票投给它，买下它的子公司，却没买它的股票',
  'verdict':'miss','entity':'沃尔玛','entityKind':'companies',
  'claim':{'year':2003,'text':'多年来，在《财富》杂志 (Fortune Magazine) 的"最受尊敬企业"评选中，我一直把票投给沃尔玛。',
           'confidence':'强。2003 年信里写明，是他自己的行为不是旁人转述'},
  'timeline':[
    {'y':2003,'k':'act','t':'只跟沃尔玛 CFO 开了约两小时会、不做任何尽职调查，就买下其配送子公司麦克莱恩'},
    {'y':2003,'k':'fact','t':'麦克莱恩年销售额约 230 亿美元，税前利润率约 1%——薄利，但极其稳定'},
    {'y':2003,'k':'claim','t':'说自己多年来一直把"最受尊敬企业"的票投给沃尔玛，且确信交易"会像沃尔玛所说的那样"'}
  ],
  'outcome':'买下了沃尔玛的一块业务，没买沃尔玛本身。这笔收购是好交易，但沃尔玛股票此后的长期回报远高于那块薄利生意。',
  'lesson':'欣赏一家公司、买它的一块资产、买它的股票，是三件事。他做了前两件，跳过了回报最高的第三件。',
  'src':'2003 股东信'
 },
 {
  'id':'freddie','title':'房地美：说过"持有期限是永远"，十二年后几乎卖光',
  'verdict':'hit','entity':'房地美','entityKind':'companies',
  'claim':{'year':1988,'text':'当我们持有既拥有出色业务又拥有出色管理层的公司股份时，我们最喜欢的持有期限是——永远。',
           'confidence':'强。1988 年信里写下的持有原则，附"拔掉鲜花浇灌杂草"的说法'},
  'timeline':[
    {'y':1988,'k':'act','t':'大手笔买入房地美优先股与可口可乐，持股达到法律允许的上限'},
    {'y':1988,'k':'claim','t':'写下"最喜欢的持有期限是永远"，讽刺那些一见公司表现好就急着卖出的行为'},
    {'y':2000,'k':'act','t':'几乎卖光所有房地美与房利美持股，换入中型公司、少量垃圾债与高等级抵押贷款证券'},
    {'y':2008,'k':'fact','t':'房地美因衍生品与虚报收益陷入危机，被联邦政府接管'},
    {'y':2008,'k':'claim','t':'"它们让房利美和房地美多年来大规模虚报收益……连联邦监管机构 OFHEO 也完全看不明白账目。"'}
  ],
  'outcome':'那次卖出事后看是对的——八年后房地美崩溃。但它也说明他嘴上的"永远"是有条件的：一旦发现账目看不懂了，该卖还是卖。',
  'lesson':'"永远持有"不是承诺，是当时的判断。判断的前提消失时，卖出才是对原则的遵守，而不是违背。',
  'src':'1988 / 2000 / 2008 股东信'
 },
 {
  'id':'gold','title':'黄金：不会下蛋的资产，一辈子没碰',
  'verdict':'mix','entity':'黄金','entityKind':'concepts',
  'claim':{'year':2011,'text':'黄金有两个明显的缺点：既没有太大用处，也不能自我繁殖。没错，黄金有一些工业和装饰用途，但这些用途的需求量有限，无法消化新增的产量。同时，如果你永远持有一盎司黄金，到最后你还是只有一盎司。',
           'confidence':'极强。2011 年信里专门写了一段来表态'},
  'timeline':[
    {'y':2011,'k':'claim','t':'在信里用一整段批评黄金：不生产、不繁殖，一盎司放到最后还是一盎司'},
    {'y':2011,'k':'fact','t':'当时金价刚创下历史新高，市场对纸币普遍恐惧'},
    {'y':2013,'k':'fact','t':'金价随后大跌，自高位回落约三分之一'},
    {'y':2024,'k':'fact','t':'金价再创新高，拉长看仍是正回报'}
  ],
  'outcome':'躲过了 2013 年前后的大跌，也错过了之后十几年的上涨。这笔"不参与"直到今天也无法单用涨跌判对错。',
  'lesson':'他拒绝黄金的理由从来不是"它不会涨"，而是"它不生产"。拿价格涨跌去评价这条原则，本身就是用错了尺子。',
  'src':'2011 股东信'
 },
 {
  'id':'airline','title':'航空业：说了三十年是坟场，自己买了又割',
  'verdict':'miss','entity':'航空业','entityKind':'concepts',
  'claim':{'year':1992,'text':'投资者一次又一次地往国内航空业砸钱，为其无利可图的增长买单。如果当年奥维尔·莱特在小鹰镇没能飞起来就好了：这个行业越发展壮大，投资者亏得越惨。',
           'confidence':'极强。辛辣比喻，属公开宣判'},
  'timeline':[
    {'y':1989,'k':'act','t':'以 3.58 亿美元买入全美航空（USAir）优先股'},
    {'y':1992,'k':'claim','t':'写下"莱特兄弟"名言，把航空业列为增长毁灭价值的典型'},
    {'y':1994,'k':'fact','t':'全美航空 1990–1994 累计亏损 24 亿美元，该笔优先股一度减记至成本的 25%'},
    {'y':1996,'k':'claim','t':'自嘲"又蠢又有钱"，勉强收回本金利息'},
    {'y':2007,'k':'claim','t':'仍把航空业当作商品化行业的反面教材写进年报'},
    {'y':2016,'k':'act','t':'反手大举买入达美、西南、美联航、美国航空四大航'},
    {'y':2020,'k':'fact','t':'疫情冲击，迅速清仓全部航空股，公开承认对这个行业的判断再次出错'},
    {'y':2022,'k':'claim','t':'"还记得我们在全美航空和所罗门兄弟的险些灾难中死里逃生吗？我可记得清清楚楚。"'}
  ],
  'outcome':'同一行业，三十年间三次下注、两次认错。判断本身没错（航空业长期确实毁灭价值），错在高估了自己能挑出例外的能力。',
  'lesson':'对一个行业"长期不行"的判断，不等于"我现在能买到那个例外"。',
  'src':'concepts/航空业.md · 1992 / 1996 / 2007 / 2022 股东信'
 },
 {
  'id':'dexter','title':'德克斯特鞋业：一笔 4.33 亿的收购，最后成本是 60 亿',
  'verdict':'miss','entity':'德克斯特鞋业','entityKind':'companies',
  'claim':{'year':1993,'text':'收购时认定德克斯特拥有"持久的竞争优势"。',
           'confidence':'强。用伯克希尔股票支付，等于押上了自家股价'},
  'timeline':[
    {'y':1993,'k':'act','t':'以 25,203 股伯克希尔 A 股（时值 4.33 亿美元）收购德克斯特鞋业'},
    {'y':2000,'k':'fact','t':'坦承"唯一的例外是制鞋业，尤其是德克斯特"表现不佳'},
    {'y':2001,'k':'fact','t':'德克斯特税前亏损 4,620 万美元，吞掉布朗鞋业与贾斯丁靴业全部利润'},
    {'y':2007,'k':'claim','t':'"我当时评估的持久竞争优势，在短短几年内就烟消云散了。由于我用的是伯克希尔的股票，我把这个错误成倍放大了。"'},
    {'y':2014,'k':'claim','t':'"由于海外竞争的冲击，它的竞争优势很快便蒸发殆尽。而我根本没有预见到这一点。"'},
    {'y':2015,'k':'fact','t':'缅因州工厂关闭，1,600 名员工失业'},
    {'y':2016,'k':'fact','t':'当年付出的 25,203 股 A 股，截至 2016 年底市值已超过 60 亿美元'}
  ],
  'outcome':'企业价值归零；真正的代价是机会成本——那批股票后来值 60 亿美元以上。',
  'lesson':'两个错叠加：误判护城河 + 用会增值的资产去支付。此后巴菲特几乎不再用股票做收购对价。',
  'src':'companies/德克斯特鞋业.md · 1993 / 2007 / 2014 / 2016 股东信'
 },
 {
  'id':'conoco','title':'康菲石油：在油价 147 美元时重仓，次年浮亏 26 亿',
  'verdict':'miss','entity':'康菲石油','entityKind':'companies',
  'claim':{'year':2008,'text':'在油价逼近历史高位时大幅增持康菲石油至 8,490 万股。',
           'confidence':'弱（事后自认违背自己的原则，属择时而非估值）'},
  'timeline':[
    {'y':2006,'k':'act','t':'开始建仓，约 1,800 万股'},
    {'y':2008,'k':'act','t':'油价飙至约 147 美元/桶期间，增持至 8,490 万股，总成本约 70 亿美元'},
    {'y':2008,'k':'fact','t':'金融危机爆发，油价跌破 40 美元；年底持仓市值仅约 44 亿美元，浮亏逾 26 亿美元'},
    {'y':2009,'k':'claim','t':'在致股东信中承认不该在油价高位做如此大规模的择时判断'},
    {'y':2012,'k':'fact','t':'持仓降至约 2,400 万股，逐步退出'}
  ],
  'outcome':'账面上最刺眼的一次择时失败。绝对亏损约 26 亿美元，但因为仓位占比可控，未伤及根本。',
  'lesson':'一生告诫别人别预测大宗商品价格，自己也没能免俗。错的不是标的，是"我在赌价格"。',
  'src':'companies/康菲石油.md · 2006–2012 股东信'
 },
 {
  'id':'petrochina','title':'中国石油：读了一份年报，赚了 35 亿',
  'verdict':'hit','entity':'中国石油','entityKind':'companies',
  'claim':{'year':2003,'text':'按市场价整个公司约值 370 亿美元；查理和我判断它大约值 1,000 亿美元。',
           'confidence':'强。判断基于已探明储量与生产成本，不依赖预测油价'},
  'timeline':[
    {'y':2003,'k':'act','t':'以约 4.88 亿美元买入约 23.4 亿股 H 股，占总股本 1.3%'},
    {'y':2007,'k':'fact','t':'油价从不足 30 美元升至超过 100 美元；公司储量积累亦表现出色'},
    {'y':2007,'k':'act','t':'以总计约 40 亿美元清仓，相对成本获利约 35 亿美元'},
    {'y':2007,'k':'claim','t':'坦承卖出时机并不完美（之后股价又涨了一段），但对收益已很满意'}
  ],
  'outcome':'回报率超过 700%。全过程只读了年报，未造访公司、未见管理层。',
  'lesson':'粗略正确就够了。当价格不到内在价值一半时，不需要精确到小数点的模型。',
  'src':'companies/中国石油.md · 2007 股东信'
 },
 {
  'id':'ibm','title':'IBM：买在"四大"，六年後清仓认错',
  'verdict':'miss','entity':'IBM','entityKind':'companies',
  'claim':{'year':2011,'text':'把 IBM 与美国运通、可口可乐、富国银行并列为伯克希尔"四大"持仓。',
           'confidence':'强。真金白银 109 亿美元，且公开并列'},
  'timeline':[
    {'y':2011,'k':'act','t':'投入 109 亿美元购入 6,390 万股，持股 5.5%，列入"四大"'},
    {'y':2015,'k':'act','t':'持续加仓至 8.4%'},
    {'y':2016,'k':'fact','t':'持 8,123 万股、8.5%，成本 138.15 亿美元对应市值仅 134.84 亿美元，已浮亏'},
    {'y':2017,'k':'fact','t':'大幅减持，IBM 从"四大"名单消失，被苹果取代'},
    {'y':2018,'k':'fact','t':'逐步清空全部持仓，承认对 IBM 维持竞争优势的能力估计错误'}
  ],
  'outcome':'成本逾 100 亿美元，六年持有，最终回报远逊同期持有苹果。',
  'lesson':'回购救不了衰退的主业。后来投苹果时他改口说"这是消费品公司"——认知转变来自 IBM 的教训。',
  'src':'companies/IBM.md · 2011–2017 股东信'
 },
 {
  'id':'coke','title':'可口可乐：13 亿成本，每年领 7 亿股息',
  'verdict':'hit','entity':'可口可乐','entityKind':'companies',
  'claim':{'year':1988,'text':'当我们持有既拥有出色业务又拥有出色管理层的公司股份时，我们最喜欢的持有期限是——永远。',
           'confidence':'极强。这句话后来成了他最广为人知的名言'},
  'timeline':[
    {'y':1988,'k':'act','t':'开始大规模买入可口可乐'},
    {'y':1994,'k':'fact','t':'完成 4 亿股的七年期收购，总成本 13 亿美元'},
    {'y':1999,'k':'fact','t':'1999–2005 股价长期低迷，市值一度较高峰回落逾 40%，巴菲特未减持'},
    {'y':2020,'k':'fact','t':'4 亿股市值达 219 亿美元，相对成本增值近 16 倍'},
    {'y':2022,'k':'claim','t':'1994 年现金股息 7,500 万美元；2022 年增长到 7.04 亿美元。"年年增长，跟过生日一样确定。"'}
  ],
  'outcome':'含股息总回报远超 16 倍市价增值。中途经历过七年不涨。',
  'lesson':'命中不等于过程舒服。1999–2005 那七年，账面最难看的时候他什么都没做。',
  'src':'companies/可口可乐.md · 1988 / 1994 / 2022 股东信'
 },
]

decisions = [
 {
  'id':'d-coke','year':1988,'title':'1988 年，你会买可口可乐吗','entity':'可口可乐',
  'scene':'1987 年 10 月股灾刚过去一年多。可口可乐刚从"新可乐"翻车的公关灾难里爬出来，市场对它还有疑虑。',
  'facts':[
    '可口可乐当时市盈率约 15 倍，高于市场平均',
    '主业是卖糖浆浓缩液，装瓶商承担资本开支——典型的轻资产',
    '海外市场渗透率还很低，增长空间主要在海外',
    '你刚在 1985 年的股东信里宣布自己改喝樱桃可乐'
  ],
  'options':[
    {'label':'重仓买入，做好长期持有的准备','tag':'买'},
    {'label':'买一点，先观察海外扩张成效','tag':'小仓位'},
    {'label':'不买。15 倍 PE 对一个卖糖水的公司太贵','tag':'不买'}
  ],
  'actual':'重仓买入。此后七年持续吸筹，到 1994 年完成 4 亿股收购，总成本 13 亿美元。',
  'result':'到 2020 年市值 219 亿美元（16 倍），2022 年单年现金股息 7.04 亿美元——一年的股息就超过当年成本的 54%。',
  'src':'companies/可口可乐.md'
 },
 {
  'id':'d-conoco','year':2008,'title':'2008 年，油价 147 美元，你加仓还是减仓','entity':'康菲石油',
  'scene':'2008 年上半年，原油冲到每桶约 147 美元的历史高位，"超级周期"论调铺天盖地。你已持有康菲石油 1,800 万股。',
  'facts':[
    '油价从 2003 年的 30 美元涨到 147 美元，五年五倍',
    '你一生的公开主张是：不要预测宏观经济和大宗商品价格',
    '康菲是纯上游勘探生产公司，利润几乎完全由油价决定',
    '你手上现金充裕，市场上处处是"资源稀缺"的叙事'
  ],
  'options':[
    {'label':'大幅增持，资源稀缺是长期趋势','tag':'加仓'},
    {'label':'维持原仓位不动','tag':'不动'},
    {'label':'减持。价格不决定价值，但我在赌价格','tag':'减仓'}
  ],
  'actual':'大幅增持至 8,490 万股，总成本约 70 亿美元。',
  'result':'当年下半年金融危机，油价跌破 40 美元，年底持仓市值仅约 44 亿美元，浮亏逾 26 亿美元。他随后在信中承认这是择时错误。',
  'src':'companies/康菲石油.md'
 },
 {
  'id':'d-dexter','year':1993,'title':'1993 年，收购德克斯特鞋业，你用什么支付','entity':'德克斯特鞋业',
  'scene':'德克斯特业绩优异、管理出色，你判断它有持久竞争优势。对价 4.33 亿美元。你可以付现金，也可以付伯克希尔股票。',
  'facts':[
    '德克斯特当时盈利良好，完全不像"烟蒂股"',
    '美国本土制鞋业正面临亚洲低成本制造的压力',
    '伯克希尔股价长期看大概率持续增值',
    '用股票支付可以省下现金'
  ],
  'options':[
    {'label':'付现金。看错了最多亏这 4.33 亿','tag':'现金'},
    {'label':'付股票。节省现金，且卖方愿意接受','tag':'股票'}
  ],
  'actual':'付股票：25,203 股伯克希尔 A 股。',
  'result':'德克斯特价值归零，缅因州工厂关闭、1,600 人失业。而那 25,203 股到 2016 年底市值超过 60 亿美元——真正代价是 60 亿的机会成本，不是 4.33 亿。此后他几乎不再用股票做收购对价。',
  'src':'companies/德克斯特鞋业.md'
 },
 {
  'id':'d-petro','year':2003,'title':'2003 年，中国石油市值 370 亿美元，你觉得它值多少','entity':'中国石油',
  'scene':'你读了它的年报。它是中国最大的油气生产商，2000 年已在香港上市。市场给整个公司的定价约 370 亿美元。',
  'facts':[
    '你没去过公司，没见过管理层，只读了公开年报',
    '油价当时每桶不到 30 美元',
    '估值核心可归结为：已探明储量 × 生产成本',
    '你正在打破"只投美国本土"的习惯'
  ],
  'options':[
    {'label':'约 1,000 亿美元——市场给的是三折','tag':'大幅低估'},
    {'label':'约 500–600 亿美元——便宜但不夸张','tag':'温和低估'},
    {'label':'不好说。新兴市场国企的治理风险无法定价','tag':'看不清'}
  ],
  'actual':'判断约值 1,000 亿美元，是市场价的近三倍，买入 1.3% 股权，成本 4.88 亿美元。',
  'result':'2007 年以约 40 亿美元清仓，获利约 35 亿美元，回报超 700%。他承认卖早了，但很满意。',
  'src':'companies/中国石油.md'
 },
 {
  'id':'d-ibm','year':2011,'title':'2011 年，你会把 IBM 归入"四大"吗','entity':'IBM',
  'scene':'你一向回避科技股，理由是护城河更新太快。但 IBM 有庞大的企业客户、稳定服务收入和激进回购计划。',
  'facts':[
    'IBM 正在从硬件向 IT 服务与云计算转型',
    '亚马逊 AWS、微软 Azure 已在云上跑在前面',
    '公司有巨额回购计划，流通股持续减少',
    '你刚说过：科技企业的护城河"需要不断重建，最终等于没有护城河"'
  ],
  'options':[
    {'label':'买。企业客户黏性 + 回购，够得上"四大"','tag':'买'},
    {'label':'不买。这违背我自己刚说过的能力圈原则','tag':'不买'}
  ],
  'actual':'买入 109 亿美元，占 5.5%，与美国运通、可口可乐、富国银行并列"四大"，此后持续加仓至 8.4%。',
  'result':'2016 年浮亏，2017 年退出"四大"被苹果取代，2018 年清仓。他承认错估了 IBM 维持竞争优势的能力。',
  'src':'companies/IBM.md'
 },
]

def block_text(b):
    """和 index.html 里的 blockText() 完全一致：表格块拼 head+rows，其他块取 t"""
    if b.get('k') == 't':
        parts = list(b.get('head', []))
        for r in b.get('rows', []):
            parts.append(' '.join(r))
        return ' '.join(parts)
    return b.get('t', '')

meta = {
 'letters': len(letters), 'chars': sum(l['chars'] for l in letters),
 'totChars': sum(len(block_text(b)) for L in LET.values() for b in L['blocks']),
 'years': [min(l['year'] for l in letters), max(l['year'] for l in letters)],
 'companies': len(companies), 'concepts': len(concepts), 'people': len(people),
 'srcRepo': 'github.com/Sphinm/buffett-letters',
}

core = {'meta': meta, 'letters': letters,
        'companies': companies, 'concepts': concepts, 'people': people,
        'mentions': mentions, 'overflow': overflow,
        'scorecard': scorecard, 'decisions': decisions,
        'surf': {e['name']: sorted(surfaces(e)) for e in ALL_ENTS}}

def dump_js(var, obj, path):
    with open(path, 'w', encoding='utf-8') as f:
        f.write('window.%s = ' % var)
        json.dump(obj, f, ensure_ascii=False, separators=(',', ':'))
        f.write(';\n')

dump_js('CORE', core, os.path.join(OUT, 'data-core.js'))
dump_js('LETTERS', LET, os.path.join(OUT, 'data-letters.js'))

print('信件 %d 篇 | 字符 %d' % (len(letters), meta['chars']))
print('实体 公司%d 概念%d 人物%d' % (len(companies), len(concepts), len(people)))
top = sorted(((len(mentions[e['name']]) + overflow.get(e['name'], 0), e['name']) for e in ALL_ENTS), reverse=True)[:8]
print('提及 TOP8:', ', '.join('%s:%d' % (n, c) for c, n in top))
for p in ['data-core.js', 'data-letters.js']:
    print('  %s  %.1f KB' % (p, os.path.getsize(os.path.join(OUT, p)) / 1024))
