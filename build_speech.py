# -*- coding: utf-8 -*-
"""读巴菲特 — 公众演讲稿 ETL
输入: _src/speech/*.md  (GitHub gengjiawen/buffett-chinese，已为中文)
输出: _src/speech/speech.jsonl   每行一段巴菲特（或他人）在公开场合说的话
      _src/speech/stats.json     语料统计

与 build_talk.py 同一套设计原则：
  1. 确定性抽取，不过 LLM
  2. 每段带稳定坐标（年份 + 场合 + 段号）—— 上层引用可回溯
  3. 只留巴菲特本人的话作为语料；他人的话单独标 who，仅用于问答配对

两个必须记住的坑：
  - 空行才是段落边界。按行切会碎成一行一段，叙述体的文件几乎全被过滤掉。
  - 源仓库里混着英文原版（extra_*）。本项目只做中文，用中文字符占比剔除。
  - 有些是「凭速记和回忆整理的笔记」（如 2005 堪萨斯），不是逐字稿。
    标 fidelity=notes，分身只能转述，不得逐字引用——这条和股东大会语料一个规矩。
"""
import json, os, re, glob, statistics

SRC_DIR = os.path.join('_src', 'speech')
OUT = os.path.join(SRC_DIR, 'speech.jsonl')
STATS = os.path.join(SRC_DIR, 'stats.json')

WHO_RULES = [
    ('buffett', r'巴菲特|沃伦|^Buffett|^WB$'),
    ('munger',  r'芒格|查理|Munger|Charlie'),
    ('gates',   r'盖茨|比尔|Gates|^Bill$'),
]

def first_person_rate(t):
    """每 100 字里「我/我们」出现几次。他讲自己的事时密度很高，
    而股东提问多是「请问您怎么看」——第二人称，密度接近 0。"""
    if not t:
        return 0
    hits = len(re.findall(r'我们|我(?!的|国|想问)', t))
    return hits / max(1, len(t) / 100)


# 行首「某某：」—— 认出说话人名字。
# 这里千万别默认归给巴菲特：股东大会和访谈里有一堆人（贝琪、记者、股东、
# 阿贝尔…），默认归他会把别人的提问当成他的原话，分身引用就全错了。
SPEAKER_RE = re.compile(r'^([^：:]{1,14})[:：]\s*(.*)$', re.S)


def clean(t):
    """去掉源站自动加的股票链接、粗体、图片，只留人能读的正文"""
    s = t
    s = re.sub(r'!\[[^\]]*\]\([^)]*\)', '', s)          # 图片
    s = re.sub(r'\[([^\]]{1,40})\]\([^)]*\)', r'\1', s)  # [亚马逊](url) -> 亚马逊
    s = s.replace('**', '').replace('__', '')
    s = re.sub(r'^\s*[-*>]\s+', '', s)
    return re.sub(r'\s+', ' ', s).strip()


# 「案例：」「来源：」「时间：」这种是字段标签，不是说话的人。
# 不排除的话，标题后面的正文会被当成"案例"这个人在说话，整段就丢了。
FIELD_LABELS = ('案例', '时间', '来源', '地点', '日期', '主题', '说明', '注', '备注',
                '作者', '整理', '译者', '编译', '摘要', '标题', '背景', '出处', '前言')


def speaker_of(line):
    """返回 (who, body)。认不出说话人的返回 ('', 原文)"""
    m = SPEAKER_RE.match(line.strip())
    if not m:
        return '', line.strip()
    name, body = m.group(1).strip(), m.group(2).strip()
    # 名字太长多半不是人名，是句子里的冒号（如「他说：」后面接正文）
    if len(name) > 8:
        return '', line.strip()
    if name in FIELD_LABELS:
        return '', line.strip()      # 字段标签，整段仍是正文
    for key, pat in WHO_RULES:
        if re.search(pat, name):
            return key, body
    return 'other', body      # 贝琪/记者/股东/学生…一律是别人

# 明确标注「凭笔记/回忆整理」的，降为 notes
NOTES_HINT = ('凭速记', '凭回忆', '不是一字不差', '笔记是我', '作者不详', '大意')


def zh_ratio(t):
    zh = len(re.findall(r'[\u4e00-\u9fff]', t))
    return zh / max(1, len(t))


def parse_venue(fn):
    stem = os.path.splitext(fn)[0]
    m = re.match(r'(\d{4})', stem)
    y = int(m.group(1)) if m else 0
    name = stem
    name = re.sub(r'^\d{4}\s*年?\s*', '', name)
    name = re.sub(r'^巴菲特(在|与|对话)?', '', name)
    name = re.sub(r'^extra_\d{4}_', '', name)
    name = name.split('：')[0].split(':')[0]      # 去掉标题里的副标题
    name = re.sub(r'^答|^接受|^再度邀请', '', name)
    return y, name.strip() or stem


def who_of(line):
    s = line.strip()
    for key, pat in WHO_RULES:
        if re.search(pat, s):
            return key
    return ''


def strip_mark(p, who):
    s = p.strip()
    if not who:
        return s
    for key, pat in WHO_RULES:
        if key == who:
            s = re.sub(pat, '', s, count=1)
    return s.strip()


rows = []
files = sorted(glob.glob(os.path.join(SRC_DIR, '*.md')))
skipped = []
report = []
for f in files:
    fn = os.path.basename(f)
    text = open(f, encoding='utf-8').read()
    if zh_ratio(text) < 0.2:                      # 英文原版，本项目不用
        skipped.append((fn, '非中文'))
        continue
    y, venue = parse_venue(fn)
    fidelity = 'notes' if any(h in text[:3000] for h in NOTES_HINT) else 'verbatim'

    # 按空行切段（保留段落边界）
    raw = text.split('\n')
    paras, cur = [], []
    for ln in raw:
        if ln.strip() == '':
            if cur:
                paras.append(' '.join(x.strip() for x in cur))
                cur = []
            continue
        s = ln.strip()
        if re.match(r'^#{1,6}\s', s) or re.match(r'^!\[', s):
            if cur:
                paras.append(' '.join(cur)); cur = []
            continue
        if re.match(r'^[-*>|\s]*$', s):
            continue
        cur.append(s)
    if cur:
        paras.append(' '.join(cur))

    # 先扫一遍：这份是「他一个人讲」还是「一堆人在场」。
    # 判据用占比而不是绝对数——演讲里也会插几个学生提问，但主体仍是他。
    n_other = 0
    n_bf = 0
    for p in paras:
        w, _ = speaker_of(p)
        if w == 'other':
            n_other += 1
        elif w == 'buffett':
            n_bf += 1
    solo = n_other < max(3, (n_other + n_bf) * 0.3)

    last_who = ''
    n_before = len(rows)
    for i, p in enumerate(paras):
        p = clean(p)
        if not p:
            continue
        w, body = speaker_of(p)
        if not w:
            if last_who:
                w = last_who          # 承接上一段：长回答中间往往不再重复标名字
            elif solo:
                w = 'buffett'
            else:
                # 多人场合又没标名字：靠第一人称密度猜。他讲自己的事时满口「我们」，
                # 提问的人说的是「您」。猜不出来的宁可不要，也不能当成他的原话。
                w = 'buffett' if first_person_rate(body) >= 1.5 else 'unknown'
        else:
            last_who = w
        if len(body) < 12:
            continue
        rows.append({
            'n': len(rows), 'y': y, 'venue': venue, 'file': fn,
            'who': w, 'i': i, 'fid': fidelity, 'text': body,
        })
    report.append((y, venue, len(rows) - n_before, fidelity, fn))

bf = [r for r in rows if r['who'] == 'buffett']
chars = sum(len(r['text']) for r in bf)
sents = []
for r in bf:
    sents += [s for s in re.split(r'[。！？!?]', r['text']) if len(s.strip()) > 1]

with open(OUT, 'w', encoding='utf-8') as fp:
    for r in rows:
        fp.write(json.dumps(r, ensure_ascii=False) + '\n')

years = sorted({r['y'] for r in bf})
venues = sorted({r['venue'] for r in bf})
stats = {
    'source': 'gengjiawen/buffett-chinese（公众演讲/访谈/大学问答，中文）',
    'files': len(files) - len(skipped),
    'skipped': skipped,
    'years': years,
    'venues': venues,
    'paras_total': len(rows),
    'buffett_paras': len(bf),
    'chars': chars,
    'sentences': len(sents),
    'sent_chars_median': statistics.median([len(s) for s in sents]) if sents else 0,
    'by_fidelity': {
        'verbatim': len([r for r in bf if r['fid'] == 'verbatim']),
        'notes': len([r for r in bf if r['fid'] == 'notes']),
    },
}
json.dump(stats, open(STATS, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)

print(f'文件 {len(files)-len(skipped)} 份（跳过 {len(skipped)}：{[s[0] for s in skipped]}）')
print(f'段落 {len(rows)} 条，其中巴菲特本人 {len(bf)} 条')
print(f'巴菲特原文 {chars} 字，句子 {len(sents)} 句，句中位 {stats["sent_chars_median"]} 字')
print(f'年份 {years[0]}-{years[-1]}，场合 {len(venues)} 个')
print(f'可信度：逐字 {stats["by_fidelity"]["verbatim"]} 段 / 笔记 {stats["by_fidelity"]["notes"]} 段')
print()
for y, v, n, fid, fn in sorted(report):
    print(f'  {y}  {n:>4}段  [{fid[:4]}]  {v}')
