# -*- coding: utf-8 -*-
"""股东大会中文全文 ETL（berkshiredata.cloud）
输入: _src/meeting/html/*.html  66 场，1994-2026，中英对照
输出: _src/meeting/meetings_zh.jsonl   每行一段（带年份/场次/章节/说话人）
      _src/meeting/stats.json          统计

为什么做这个：原来股东大会语料只有 380 条（英文字幕的中译，占原始 9,598 段的 4%），
卡在翻译成本上。这个站直接给了中英对照全文，不用自己翻译。

页面结构（别照抄别处的解析，这套是专用的）：
  <p><strong>说话人：</strong>正文</p>   换了人说话
  <p>正文</p>                            承接上一个人的发言
所以说话人只能从 <strong> 里认，其余段落继承上一段。
"""
import re, os, glob, json, statistics

ROOT = os.path.dirname(os.path.abspath(__file__))
HTML = os.path.join(ROOT, '_src', 'meeting', 'html')
OUT = os.path.join(ROOT, '_src', 'meeting', 'meetings_zh.jsonl')

WHO = [
    ('buffett', r'巴菲特|沃伦|Warren Buffett|^WB$'),
    ('munger',  r'芒格|查理|Munger|Charlie'),
]
# 「股东提问」「记者」这类明摆着是别人
OTHER_HINT = r'提问|记者|股东|观众|主持人|提问人|分析师'


def clean(t):
    s = t
    s = re.sub(r'<strong>([^<]*)</strong>', r'\1', s)     # 说话人留下来，后面单独认
    s = re.sub(r'<[^>]+>', '', s)
    s = s.replace('&quot;', '"').replace('&amp;', '&').replace('&nbsp;', ' ')
    s = s.replace('&#39;', "'").replace('&lt;', '<').replace('&gt;', '>')
    return re.sub(r'\s+', ' ', s).strip()


def who_of(name):
    for key, pat in WHO:
        if re.search(pat, name):
            return key
    return 'other'


rows = []
files = sorted(glob.glob(os.path.join(HTML, '*.html')))
print('文件', len(files))
for f in files:
    base = os.path.basename(f)[:-5]
    m = re.match(r'(\d{4})_(\w+)', base)
    y = int(m.group(1)) if m else 0
    session = m.group(2) if m else base
    h = open(f, encoding='utf-8', errors='replace').read()
    i = h.rfind('</style>')
    body = h[i:] if i > 0 else h
    titles = re.findall(r'<span class="ch-title"[^>]*>([\s\S]*?)</span>', body)
    blocks = re.findall(r'<div class="ch-body[^"]*">([\s\S]*?)</div>', body)
    for ci, blk in enumerate(blocks):
        title = clean(titles[ci]) if ci < len(titles) else ''
        ps = re.findall(r'<p[^>]*>([\s\S]*?)</p>', blk)
        last_who = ''
        for p in ps:
            sm = re.match(r'\s*<strong>([^<]{1,30}?)</strong>\s*[:：]?\s*', p)
            if sm:
                last_who = who_of(sm.group(1).strip())
            raw = clean(p)
            if sm:                      # 去掉已经认过的说话人前缀
                raw = re.sub(r'^[^：:]{1,30}[:：]\s*', '', raw)
            if len(raw) < 12:
                continue
            rows.append({
                'n': len(rows), 'y': y, 'session': session,
                'ch': ci, 'title': title, 'who': last_who or 'other', 'text': raw,
            })

bf = [r for r in rows if r['who'] == 'buffett']
chars = sum(len(r['text']) for r in bf)
sents = []
for r in bf:
    sents += [s for s in re.split(r'[。！？!?]', r['text']) if len(s.strip()) > 1]
years = sorted({r['y'] for r in bf})

with open(OUT, 'w', encoding='utf-8') as fp:
    for r in rows:
        fp.write(json.dumps(r, ensure_ascii=False) + '\n')

stats = {
    'source': 'berkshiredata.cloud（股东大会中英对照全文，1994-2026）',
    'files': len(files),
    'years': years,
    'paras_total': len(rows),
    'buffett_paras': len(bf),
    'chars': chars,
    'sentences': len(sents),
    'sent_chars_median': statistics.median([len(s) for s in sents]) if sents else 0,
    'by_year': {str(y): len([r for r in bf if r['y'] == y]) for y in years},
}
json.dump(stats, open(os.path.join(ROOT, '_src', 'meeting', 'stats.json'), 'w', encoding='utf-8'),
          ensure_ascii=False, indent=1)

print(f'段落 {len(rows)} 条，巴菲特本人 {len(bf)} 条')
print(f'巴菲特原文 {chars} 字，句子 {len(sents)}，句中位 {stats["sent_chars_median"]} 字')
print(f'年份 {years[0]}-{years[-1]}')
print('逐年段数', json.dumps(stats['by_year'], ensure_ascii=False))
