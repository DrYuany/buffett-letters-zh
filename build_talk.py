# -*- coding: utf-8 -*-
"""
读巴菲特 — 口语语料 ETL
输入: _src/talk/_lib.json  (GitHub whwhwhwhwh56/buffett-library 内嵌数据)
输出: _src/talk/meetings.jsonl  每行一段巴菲特/芒格在股东大会上的发言
      _src/talk/stats.json      语料统计(字号、句长、问答结构)

rows 字段(来自该库前端解码逻辑):
  rows: [doc, line, main_topic, kind, person, quotability x10, topic_mask, time, question_idx, text]

设计原则与 build.py 一致:
  1. 确定性抽取,不过 LLM
  2. 每段带稳定坐标 (year + doc + time + 行号) —— 上层引用可回溯
  3. 只保留 speech(股东大会),信件已在 data-letters.js 里,不重复
"""
import json, os, re, statistics

SRC = os.path.join('_src', 'talk', '_lib.json')
OUT_DIR = os.path.join('_src', 'talk')
os.makedirs(OUT_DIR, exist_ok=True)

D = json.load(open(SRC, encoding='utf-8'))
DOCS, PEOPLE = D['docs'], D['people']
QUESTIONS = D['questions']

def who_of(person):
    if re.search(r'buffett', person, re.I):
        return 'buffett'
    if re.search(r'munger', person, re.I):
        return 'munger'
    return 'other'

rows = []
for n, r in enumerate(D['rows']):
    doc = DOCS[r[0]]
    person = PEOPLE[r[4]] if 0 <= r[4] < len(PEOPLE) else ''
    rows.append({
        'n': n, 'doc': r[0], 'line': r[1], 'y': doc['year'], 'src': doc['src'],
        'kind': r[3], 'who': who_of(person), 'person': person,
        'q': (r[5] or 0) / 10, 'mask': r[6], 'at': r[7], 'qn': r[8],
        't': re.sub(r'\s+', ' ', (r[9] or '')).strip(),
    })

meet = [r for r in rows if r['src'] == 'meeting' and r['t']]

def sentences(t):
    return [s for s in re.split(r'(?<=[.!?])\s+', t) if s.strip()]

def wc(t):
    return len(re.findall(r"[A-Za-z0-9$%.,'-]+", t))

# ---------- 输出发言单元 ----------
lines = []
for r in meet:
    if r['who'] == 'other':
        continue                      # 提问者/主持人,不收
    qtext = QUESTIONS[r['qn']] if isinstance(r['qn'], int) and 0 <= r['qn'] < len(QUESTIONS) else ''
    lines.append(json.dumps({
        'y': r['y'], 'doc': r['doc'], 'line': r['line'], 'at': r['at'],
        'qn': r['qn'], 'who': r['who'], 'kind': r['kind'], 'q': r['q'],
        'ask': re.sub(r'\s+', ' ', qtext).strip()[:400],
        't': r['t'],
    }, ensure_ascii=False))

with open(os.path.join(OUT_DIR, 'meetings.jsonl'), 'w', encoding='utf-8') as f:
    f.write('\n'.join(lines) + '\n')

# ---------- 统计 ----------
buff = [r for r in meet if r['who'] == 'buffett']
all_sent = [s for r in buff for s in sentences(r['t'])]
words = sum(wc(r['t']) for r in buff)
sent_wc = [wc(s) for s in all_sent]

# 常见开场与回避用语(字面统计,不算语义)
def count_phrases(pats, corpus):
    out = []
    for label, pat in pats:
        c = sum(1 for t in corpus if re.search(pat, t, re.I))
        if c:
            out.append({'label': label, 'hits': c, 'per1000': round(c / len(corpus) * 1000, 1)})
    return sorted(out, key=lambda x: -x['hits'])

AP = "['\u2019]?"          # 直引号或弯引号,可选

hedges = count_phrases([
    ('遇事就说不知道', r"\b(I don" + AP + r"t know|we don" + AP + r"t know|no idea|can" + AP + r"t answer|haven" + AP + r"t the faintest)\b"),
    ('拒绝预测', r"\b(I (never|don" + AP + r"t) (predict|forecast|make forecasts)|we don" + AP + r"t (predict|forecast)|not going to predict|I have no prediction)\b"),
    ('老实说/坦白讲', r"\b(frankly|to be honest|honestly)\b"),
    ('承认自己会错', r"\b(I (may|might|could) be wrong|I" + AP + r"ve been wrong|I was (wrong|dumb|stupid)|my (mistake|error))\b"),
    ('打比方', r"\b(it" + AP + r"s like|think of it as|imagine|analogy|just like|it" + AP + r"s the same as)\b"),
    ('先认下问题再拆', r"\b(that" + AP + r"s a (good|fair|tough|interesting) question|let me (back up|start)|the question is)\b"),
    ('拉回原则', r"\b(the key (thing|point|question) is|the basic (idea|principle|point)|what matters is|the important thing)\b"),
    ('我第一人称下判断', r"\b(I think|I believe|I feel|my (guess|view|judgment))\b"),
], [r['t'] for r in buff])

answers_with_q = [r for r in buff if isinstance(r['qn'], int) and r['qn'] >= 0]
q_lens = [wc(QUESTIONS[r['qn']]) for r in answers_with_q if 0 <= r['qn'] < len(QUESTIONS)]

stats = {
    'source': 'whwhwhwhwh56/buffett-library',
    'years': sorted({r['y'] for r in meet}),
    'meeting_rows': len(meet),
    'buffett_utterances': len(buff),
    'munger_utterances': sum(1 for r in meet if r['who'] == 'munger'),
    'questions': len(QUESTIONS),
    'words': words,
    'sentences': len(all_sent),
    'sent_words_median': round(statistics.median(sent_wc), 1),
    'sent_words_p90': sorted(sent_wc)[int(len(sent_wc) * 0.9)],
    'utt_words_median': round(statistics.median([wc(r['t']) for r in buff]), 1),
    'q_words_median': round(statistics.median(q_lens), 1) if q_lens else None,
    'answered_questions': len(answers_with_q),
    'hedges': hedges,
}
json.dump(stats, open(os.path.join(OUT_DIR, 'stats.json'), 'w', encoding='utf-8'),
          ensure_ascii=False, indent=1)

print('发言单元', len(lines), '| 巴菲特', len(buff), '| 芒格', stats['munger_utterances'])
print('年份', stats['years'][0], '-', stats['years'][-1], '共', len(stats['years']), '年')
print('词数', words, '| 句数', len(all_sent), '| 句中位词数', stats['sent_words_median'])
print('有对应提问的发言', len(answers_with_q))
for h in hedges:
    print('  ', h['label'], h['hits'], f"{h['per1000']}/千段")
