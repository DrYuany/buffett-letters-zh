# -*- coding: utf-8 -*-
"""盘点: 实体在多少个不同年份被提到 / 每年多少段 / 术语演化跨度
输出用于决定 记分牌 & 术语演化 的覆盖面"""
import re, os, glob, json
from collections import defaultdict

SRC = '_src/buffett-letters'

def load_entities(kind_dir):
    ents = []
    for f in sorted(glob.glob(os.path.join(SRC, kind_dir, '*.md'))):
        name = os.path.basename(f)[:-3]
        raw = open(f, encoding='utf-8').read()
        body = raw.split('---', 1)[-1]
        m = re.search(r'[（(]\s*([A-Za-z][A-Za-z0-9 .\-&,\']{1,45})\s*[）)]', body[:400])
        ents.append({'name': name, 'en': m.group(1).strip() if m else '', 'kind': kind_dir})
    return ents

ALIAS = {
    '盖可保险': ['GEICO', '盖可'], '可口可乐': ['Coca-Cola'], '喜诗糖果': ["See's", "See’s"],
    '伯克希尔哈撒韦': ['Berkshire', '伯克希尔'], '美国运通': ['American Express', '运通'],
    '中国石油': ['PetroChina'], '苹果': ['Apple'], 'BNSF铁路': ['BNSF'],
    '富国银行': ['Wells Fargo'], '通用再保险': ['Gen Re'], '德克斯特鞋业': ['Dexter'],
    '康菲石油': ['ConocoPhillips'], '华盛顿邮报': ['Washington Post'],
    '芒格': ['Munger', '查理'], '格雷厄姆': ['Graham'], '阿吉特·贾恩': ['Ajit'],
    'B夫人': ['Mrs. B', 'Mrs B'], '格雷格·阿贝尔': ['Greg Abel'],
    '托德·库姆斯': ['Todd Combs'], '泰德·韦施勒': ['Ted Weschler'],
    '内布拉斯加家具店': ['NFM'], '大都会通信': ['Capital Cities'],
    '蓝筹印花': ['Blue Chip'], '所罗门': ['Salomon'], '穆迪': ["Moody's"],
    '比亚迪': ['BYD'], '利捷航空': ['NetJets'], '冰雪皇后': ['Dairy Queen'],
    '通用电气': ['GE', 'General Electric'], '雪佛龙': ['Chevron'],
}

def surfaces(e):
    s = {e['name']}
    if e['en'] and len(e['en']) >= 2:
        s.add(e['en'])
    for a in ALIAS.get(e['name'], []):
        s.add(a)
    return {x for x in s if len(x) >= 2}

ALL = load_entities('companies') + load_entities('concepts') + load_entities('people')
SURF = {e['name']: surfaces(e) for e in ALL}

# 逐篇正文
LET = {}
for dirn in ['partnership', 'berkshire', 'special']:
    for f in sorted(glob.glob(os.path.join(SRC, 'letters', dirn, '*.md'))):
        base = os.path.basename(f)[:-3]
        m = re.match(r'(\d{4})', base)
        year = int(m.group(1)) if m else 0
        txt = open(f, encoding='utf-8').read().replace('\r', '')
        i = 0
        while i < len(txt) and txt[i:i+3] != '---':
            i += 1
        body = txt[i:]
        LET[base] = (year, body)

# 跨年统计 (年份集合, 段落计数)
years = {e['name']: set() for e in ALL}
paras = {e['name']: 0 for e in ALL}
for lid, (yr, body) in LET.items():
    for e in ALL:
        n = 0
        for s in SURF[e['name']]:
            n += body.count(s)
        if n:
            years[e['name']].add(yr)
            paras[e['name']] += n

rows = []
for e in ALL:
    ys = sorted(years[e['name']])
    rows.append({'name': e['name'], 'kind': e['kind'], 'ny': len(ys),
                 'span': (max(ys) - min(ys) + 1) if ys else 0,
                 'y0': min(ys) if ys else 0, 'y1': max(ys) if ys else 0,
                 'hits': paras[e['name']]})

print('=' * 64)
print('一、实体跨年覆盖分布（≥N 个年份被提到）')
print('=' * 64)
for thr in [10, 8, 5, 3, 2, 1]:
    a = [r for r in rows if r['ny'] >= thr]
    c = [r for r in a if r['kind'] == 'companies']
    k = [r for r in a if r['kind'] == 'concepts']
    p = [r for r in a if r['kind'] == 'people']
    print('  ≥%2d 年:  合计 %3d   公司 %3d  概念 %3d  人物 %2d' % (thr, len(a), len(c), len(k), len(p)))

print()
print('=' * 64)
print('二、公司类 TOP20（按跨年数）')
print('=' * 64)
print('  %-16s %4s %4s %4s  %s' % ('公司', '年数', '跨度', '次数', '年份区间'))
for r in sorted([r for r in rows if r['kind'] == 'companies'],
                key=lambda x: (-x['ny'], -x['hits']))[:20]:
    print('  %-16s %4d %4d %4d  %d-%d' % (r['name'], r['ny'], r['span'], r['hits'], r['y0'], r['y1']))

print()
print('=' * 64)
print('三、概念类 TOP20（按跨年数）— 术语演化的原料')
print('=' * 64)
print('  %-16s %4s %4s %4s  %s' % ('概念', '年数', '跨度', '次数', '年份区间'))
for r in sorted([r for r in rows if r['kind'] == 'concepts'],
                key=lambda x: (-x['ny'], -x['hits']))[:20]:
    print('  %-16s %4d %4d %4d  %d-%d' % (r['name'], r['ny'], r['span'], r['hits'], r['y0'], r['y1']))

print()
print('=' * 64)
print('四、概念类：年数 ≥3 的完整名单')
print('=' * 64)
ok = sorted([r for r in rows if r['kind'] == 'concepts' and r['ny'] >= 3],
            key=lambda x: -x['ny'])
print('  共 %d 个：' % len(ok))
print('  ' + '、'.join('%s(%d年)' % (r['name'], r['ny']) for r in ok))

print()
print('=' * 64)
print('五、公司类：年数 ≥3 的完整名单')
print('=' * 64)
ok2 = sorted([r for r in rows if r['kind'] == 'companies' and r['ny'] >= 3],
             key=lambda x: -x['ny'])
print('  共 %d 个：' % len(ok2))
print('  ' + '、'.join('%s(%d年)' % (r['name'], r['ny']) for r in ok2))

print()
print('=' * 64)
print('六、年份覆盖：每年被多少实体提到')
print('=' * 64)
peryear = defaultdict(int)
for r in rows:
    pass
for e in ALL:
    for y in years[e['name']]:
        peryear[y] += 1
ys_all = sorted(peryear)
print('  年份 %d-%d，共 %d 个年份有实体命中' % (min(ys_all), max(ys_all), len(ys_all)))
print('  每年实体数 中位数 %d  最少 %d  最多 %d' % (
    sorted(peryear.values())[len(peryear)//2], min(peryear.values()), max(peryear.values())))

json.dump(rows, open('stats-entities.json', 'w', encoding='utf-8'),
          ensure_ascii=False, indent=1)
print()
print('已写入 stats-entities.json')
