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
YEAR_CAP = 6     # 每实体每语料每年最多保留 6 条（保证覆盖摊到所有年份）
TOTAL_CAP = 500  # 每实体每语料总上限（安全阀，防止极端情况爆表；6/年 × 33 年 ≈ 198，正常不会触顶）

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
    取样策略：每实体每语料按年分组，每年最多保留 YEAR_CAP 条（保持年内行序），
    再套一个 TOTAL_CAP 总上限作安全阀，超出的计入 overflow。
    返回 (mentions, overflow, scanned, raw_hits)。
    """
    by_entity = {}  # name -> {year: [entry, ...]}
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
            by_entity.setdefault(name, {}).setdefault(y, []).append(entry)

    mentions = {}
    overflow = {}
    raw_hits = 0
    for name in surf:  # 按 CORE.surf 顺序输出，保证 key 顺序稳定
        by_year = by_entity.get(name)
        if not by_year:
            continue
        kept = []
        for y in sorted(by_year):  # 年份升序，年内保持原始行序
            kept.extend(by_year[y][:YEAR_CAP])
        raw_hits += sum(len(v) for v in by_year.values())
        total = len(kept)
        if total > TOTAL_CAP:
            overflow[name] = total - TOTAL_CAP
            kept = kept[:TOTAL_CAP]
        mentions[name] = kept
    return mentions, overflow, scanned, raw_hits


def dump_js(var, obj, path):
    with open(path, 'w', encoding='utf-8') as f:
        f.write('window.%s = ' % var)
        json.dump(obj, f, ensure_ascii=False, separators=(',', ':'))
        f.write(';\n')


def main():
    surf = load_core()

    meeting_rows = load_jsonl(MEETING_PATH)
    speech_rows = load_jsonl(SPEECH_PATH)

    m_mentions, m_overflow, m_scanned, m_raw = scan(meeting_rows, 'meeting', surf)
    s_mentions, s_overflow, s_scanned, s_raw = scan(speech_rows, 'speech', surf)

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
    m_stored = sum(len(v) for v in m_mentions.values())
    s_stored = sum(len(v) for v in s_mentions.values())
    m_over = sum(m_overflow.values())
    s_over = sum(s_overflow.values())

    print('会议 扫描段 %d（buffett/munger）| 命中实体 %d | 存 %d 条 | 溢出 %d 条 | 原始命中 %d 条'
          % (m_scanned, len(m_mentions), m_stored, m_over, m_raw))
    print('演讲 扫描段 %d（buffett/munger）| 命中实体 %d | 存 %d 条 | 溢出 %d 条 | 原始命中 %d 条'
          % (s_scanned, len(s_mentions), s_stored, s_over, s_raw))

    def top10(mentions, overflow):
        scores = {n: len(v) + overflow.get(n, 0) for n, v in mentions.items()}
        return sorted(scores.items(), key=lambda kv: kv[1], reverse=True)[:10]

    print('会议 TOP10: ' + ', '.join('%s:%d' % (n, c) for n, c in top10(m_mentions, m_overflow)))
    print('演讲 TOP10: ' + ', '.join('%s:%d' % (n, c) for n, c in top10(s_mentions, s_overflow)))

    size = os.path.getsize(os.path.join(OUT, 'data-mentions.js'))
    print('  site/data-mentions.js  %.1f KB' % (size / 1024))


if __name__ == '__main__':
    main()
