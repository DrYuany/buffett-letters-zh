# -*- coding: utf-8 -*-
"""
读巴菲特 — 会议/演讲实体出场倒排（mentions aux）
输入: site/data-core.js 的 CORE.surf（实体表面词）
      _src/meeting/meetings_zh.jsonl（股东大会语料）
      _src/speech/speech.jsonl（演讲/访谈语料）
输出: site/data-mentions.js（window.MENTIONS_AUX）

与 build.py 的差别：
  信件全文进浏览器，出场按坐标去 data-letters.js 查，无需内联原文；
  会议/演讲全文不进浏览器，所以每条出场内联一小段原文摘录（snippet）。
归属口径：只扫 who in {buffett, munger} 的段；who 存下来区分「巴菲特说的 / 芒格说的」。
"""
import json, os, sys, datetime

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

ROOT = os.path.dirname(os.path.abspath(__file__))
os.chdir(ROOT)

OUT = 'site'
CAP = 200

MEETING_PATH = '_src/meeting/meetings_zh.jsonl'
SPEECH_PATH = '_src/speech/speech.jsonl'


def load_core():
    """读 data-core.js，只取 CORE.surf（直接读 build.py 的输出，不复制实体名单/别名表）。"""
    raw = open(os.path.join(OUT, 'data-core.js'), encoding='utf-8').read()
    core = json.loads(raw[raw.index('window.CORE = ') + len('window.CORE = '):].rstrip().rstrip(';'))
    return core['surf']


def load_jsonl(path):
    rows = []
    with open(path, encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def scan(rows, kind, surf):
    """
    扫描 buffett/munger 段，对每个实体做字面匹配（任一表面词 in text 即命中）。
    kind: 'meeting' -> 坐标 [y, session, ch, who, snippet]
          'speech'  -> 坐标 [y, venue, i, who, snippet]
    每实体每语料 CAP 200 条，超出计入 overflow。
    返回 (mentions, overflow, scanned)。
    """
    mentions = {}
    overflow = {}
    scanned = 0
    for r in rows:
        who = r.get('who')
        if who not in ('buffett', 'munger'):
            continue
        scanned += 1
        text = r.get('text') or ''
        if not text:
            continue
        if kind == 'meeting':
            y, loc, idx = r['y'], r['session'], r['ch']
        else:
            y, loc, idx = r['y'], r['venue'], r['i']
        for name, surfaces in surf.items():
            # 首个命中的表面词在 text 里的位置（表面词已按字母序排好）
            p = None
            for s in surfaces:
                i = text.find(s)
                if i != -1:
                    p = i
                    break
            if p is None:
                continue
            snip = text[max(0, p - 8): p + 70]
            entry = [y, loc, idx, who, snip]
            lst = mentions.setdefault(name, [])
            if len(lst) < CAP:
                lst.append(entry)
            else:
                overflow[name] = overflow.get(name, 0) + 1
    return mentions, overflow, scanned


def dump_js(var, obj, path):
    with open(path, 'w', encoding='utf-8') as f:
        f.write('window.%s = ' % var)
        json.dump(obj, f, ensure_ascii=False, separators=(',', ':'))
        f.write(';\n')


def main():
    surf = load_core()

    meeting_rows = load_jsonl(MEETING_PATH)
    speech_rows = load_jsonl(SPEECH_PATH)

    m_mentions, m_overflow, m_scanned = scan(meeting_rows, 'meeting', surf)
    s_mentions, s_overflow, s_scanned = scan(speech_rows, 'speech', surf)

    aux = {
        'meeting': m_mentions,
        'speech': s_mentions,
        'overflow': {'meeting': m_overflow, 'speech': s_overflow},
        'meta': {
            'meeting_scanned': m_scanned,
            'speech_scanned': s_scanned,
            'built': datetime.date.today().isoformat(),
        },
    }
    dump_js('MENTIONS_AUX', aux, os.path.join(OUT, 'data-mentions.js'))

    # ---------- 统计 ----------
    def total_hits(mentions, overflow):
        stored = sum(len(v) for v in mentions.values())
        over = sum(overflow.values())
        return stored + over, stored

    m_hits, m_stored = total_hits(m_mentions, m_overflow)
    s_hits, s_stored = total_hits(s_mentions, s_overflow)

    print('会议 扫描段 %d（buffett/munger）| 实体命中实体数 %d | 命中 %d 条（存 %d / 溢出 %d）'
          % (m_scanned, len(m_mentions), m_hits, m_stored, sum(m_overflow.values())))
    print('演讲 扫描段 %d（buffett/munger）| 实体命中实体数 %d | 命中 %d 条（存 %d / 溢出 %d）'
          % (s_scanned, len(s_mentions), s_hits, s_stored, sum(s_overflow.values())))

    def top10(mentions, overflow):
        scores = {n: len(v) + overflow.get(n, 0) for n, v in mentions.items()}
        return sorted(scores.items(), key=lambda kv: kv[1], reverse=True)[:10]

    print('会议 TOP10: ' + ', '.join('%s:%d' % (n, c) for n, c in top10(m_mentions, m_overflow)))
    print('演讲 TOP10: ' + ', '.join('%s:%d' % (n, c) for n, c in top10(s_mentions, s_overflow)))

    size = os.path.getsize(os.path.join(OUT, 'data-mentions.js'))
    print('  site/data-mentions.js  %.1f KB' % (size / 1024))


if __name__ == '__main__':
    main()
