# -*- coding: utf-8 -*-
"""
读巴菲特 — 会议/演讲「认错档案」抽取（corrections aux）
输入: site/data-core.js 的 CORE（companies/concepts/people 实体名单）
      _src/meeting/meetings_zh.jsonl（股东大会语料）
      _src/speech/speech.jsonl（演讲/访谈语料）
输出: site/data-corrections-aux.js（window.CORRECTIONS_AUX）

只扫本人发言：
  会议: who in {buffett, munger}（芒格单列 who，不冒充巴菲特）
  演讲: who == 'buffett'（盖茨/unknown/股东提问(other)不算）
每条产出:
  meeting: {"y":年,"k":类别,"t":认错句,"ent":实体或"","who":说话人,"session":..,"ch":..}
  speech : {"y":年,"k":类别,"t":认错句,"ent":实体或"","who":说话人,"venue":..,"i":..}
"""

import json, os, sys, re, datetime

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

ROOT = os.path.dirname(os.path.abspath(__file__))
os.chdir(ROOT)

OUT = 'site'
MEETING_PATH = '_src/meeting/meetings_zh.jsonl'
SPEECH_PATH = '_src/speech/speech.jsonl'


# ---------- 认错正则（⚠ 与 extract_content.py 第 337-346 行的 CORR_PAT 保持一致，两处同步） ----------
# 实测调过: 单字(笨/傻)会误伤"笨重"之类, 一律用词组
# 收紧过一轮: 放宽时会抓进"坦白说，我希望未来…""他们会坦诚地告诉你"这类
# —— 前者是普通表述, 后者是引用别人的话, 都不是他本人认错。一律要求第一人称。
CORR_PAT = [
    ('admit',   r'我承认|我必须承认|我得承认|我坦承|我们承认|我错了|我犯了?错|我失算'),
    ('error',   r'我的错误|判断错误|估计错误|是个错误|严重的错误|最糟糕的(交易|投资|错误|决定)|愚蠢的错误|我的.{0,4}失误'),
    ('lesson',  r'教训|付出了.{0,8}代价|昂贵的代价|惨痛|学费|代价是'),
    ('reverse', r'化为乌有|烟消云散|蒸发殆尽|幻想从未成真|事与愿违|判断.{0,4}落空'
                r'|事实证明[^。]{0,40}(没有|未能|并未|落空|相反|失败|亏损|沮丧|失望|糟糕|错)'
                r'|但事实是[^。]{0,40}(没有|未能|并未|相反|失败|亏损)'),
]


def load_core():
    """读 data-core.js，取 CORE.companies/concepts/people 的 name 组成实体名单。"""
    raw = open(os.path.join(OUT, 'data-core.js'), encoding='utf-8').read()
    core = json.loads(raw[raw.index('window.CORE = ') + len('window.CORE = '):].rstrip().rstrip(';'))
    names = []
    for section in ('companies', 'concepts', 'people'):
        for item in core.get(section, []):
            n = (item or {}).get('name')
            if n:
                names.append(n)
    return sorted(set(names), key=len, reverse=True)


def load_jsonl(path):
    rows = []
    with open(path, encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def pick_sentence(p, keys, n=150):
    """取段落里**含关键词**的那一句（与 extract_content.py 的 pick_sentence 同逻辑，截断调成 150）。
    不能机械取首句 —— 关键词若在第二句, 摘要里看不到实体, 读者会以为是乱配的。"""
    p = re.sub(r'\s+', ' ', p).strip()
    for s in re.split(r'(?<=[。！？])', p):
        s = s.strip()
        if len(s) >= 12 and any(k in s for k in keys):
            return s[:n]
    return p[:n]


def scan(rows, src, ent_names):
    """扫描本人发言的段，按 CORR_PAT 顺序匹配，命中即取含触发词那句。"""
    out = []
    seen = set()
    scanned = 0
    for r in rows:
        who = r.get('who')
        if src == 'meeting':
            if who not in ('buffett', 'munger'):
                continue
            y, a, b = r['y'], r.get('session'), r.get('ch')
        else:  # speech：只扫 buffett
            if who != 'buffett':
                continue
            y, a, b = r['y'], r.get('venue'), r.get('i')
        scanned += 1
        text = r.get('text') or ''
        if not text:
            continue
        for kind, pat in CORR_PAT:
            m = re.search(pat, text)
            if m:
                sn = pick_sentence(text, [m.group(0)], 150)
                key = (src, y, sn[:40])
                if key in seen:
                    break
                seen.add(key)
                entry = {'y': y, 'k': kind, 't': sn,
                         'ent': entity_in(text, ent_names), 'who': who}
                if src == 'meeting':
                    entry['session'] = a
                    entry['ch'] = b
                else:
                    entry['venue'] = a
                    entry['i'] = b
                out.append(entry)
                break
    out.sort(key=lambda x: x['y'])
    return out, scanned


def entity_in(text, ent_names):
    for n in ent_names:
        if len(n) >= 2 and n in text:
            return n
    return ''


def dump_js(var, obj, path):
    with open(path, 'w', encoding='utf-8') as f:
        f.write('window.%s = ' % var)
        json.dump(obj, f, ensure_ascii=False, separators=(',', ':'))
        f.write(';\n')


def main():
    ent_names = load_core()

    meeting_rows = load_jsonl(MEETING_PATH)
    speech_rows = load_jsonl(SPEECH_PATH)

    meeting, m_scanned = scan(meeting_rows, 'meeting', ent_names)
    speech, s_scanned = scan(speech_rows, 'speech', ent_names)

    aux = {
        'meeting': meeting,
        'speech': speech,
        'meta': {
            'meeting_scanned': m_scanned,
            'speech_scanned': s_scanned,
            'entities': len(ent_names),
            'built': datetime.date.today().isoformat(),
        },
    }
    dump_js('CORRECTIONS_AUX', aux, os.path.join(OUT, 'data-corrections-aux.js'))

    from collections import Counter
    m_who = Counter(x['who'] for x in meeting)
    s_who = Counter(x['who'] for x in speech)
    m_kind = Counter(x['k'] for x in meeting)
    s_kind = Counter(x['k'] for x in speech)
    m_ent = Counter(x['ent'] for x in meeting if x['ent'])
    s_ent = Counter(x['ent'] for x in speech if x['ent'])

    print('会议 扫描段 %d（buffett/munger）| 认错 %d 条 | who %s | 类别 %s'
          % (m_scanned, len(meeting), dict(m_who), dict(m_kind)))
    print('演讲 扫描段 %d（buffett）| 认错 %d 条 | who %s | 类别 %s'
          % (s_scanned, len(speech), dict(s_who), dict(s_kind)))
    print('会议 命中实体 TOP: ' + ', '.join('%s:%d' % kv for kv in m_ent.most_common(8)))
    print('演讲 命中实体 TOP: ' + ', '.join('%s:%d' % kv for kv in s_ent.most_common(8)))

    size = os.path.getsize(os.path.join(OUT, 'data-corrections-aux.js'))
    print('  site/data-corrections-aux.js  %.1f KB' % (size / 1024))


if __name__ == '__main__':
    main()
