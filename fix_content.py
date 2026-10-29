# -*- coding: utf-8 -*-
"""修 data-content.js 的两类内容缺陷：
   1) 括号残缺的残句（抽取时截断了，原文里是完整的）→ 回原文补齐
   2) 规则库里同一句原话被多个概念重复收录 → 合并成一条，概念标签并列

   只做"补回原文里本来就有的字"和"去重"，不改写任何措辞。"""
import json, io, re, sys

CONT = 'site/data-content.js'
LETTERS = 'site/data-letters.js'
OUT = 'site/data-content.js'

def load(path, var):
    s = io.open(path, encoding='utf-8').read()
    pre = var + ' = '
    i = s.index(pre)
    body = s[i + len(pre):].rstrip().rstrip(';')
    return json.loads(body)

CONTENT = load(CONT, 'window.CONTENT')
LETTERS = load(LETTERS, 'window.LETTERS')

OPEN = '（('
CLOSE = '）)'
TERM = '。！？；'

def block_text(loc):
    if not loc: return None
    L = LETTERS.get(loc.get('l'))
    if not L: return None
    b = L['blocks'][loc['b']] if 0 <= loc['b'] < len(L['blocks']) else None
    if not b: return None
    if b.get('k') == 't':
        return (b.get('head') or []) and ' '.join(b.get('head') or []) or None
    return b.get('t') or None

def balanced(s):
    d = 0
    for ch in s:
        if ch in OPEN: d += 1
        elif ch in CLOSE:
            d -= 1
            if d < 0: return False      # 多出来的右括号
    return d == 0

def repair(text, block):
    """把一个括号残缺的片段，从原文段落里扩成完整句子。"""
    i = block.find(text)
    if i < 0:
        i = block.find(text[:10])
        if i < 0: return None
    start = i
    # 片段以右括号开头：往前找回它对应的左括号（中途遇到句号就放弃，免得吞上前一句）
    if text[0] in CLOSE:
        d = 0
        j = i
        while j >= 0:
            ch = block[j]
            if ch in CLOSE: d += 1
            elif ch in OPEN:
                d -= 1
                if d == 0:
                    start = j
                    break
            elif ch in TERM:
                break
            j -= 1
    # 往后补齐括号，并吃到句末
    depth = 0
    j = start
    end = None
    while j < len(block):
        ch = block[j]
        if ch in OPEN: depth += 1
        elif ch in CLOSE: depth = max(0, depth - 1)
        if depth == 0 and j >= i + len(text) - 1:
            end = j + 1
            while end < len(block) and block[end] in '。！？':
                end += 1
            break
        j += 1
    if end is None: return None
    out = block[start:end].strip()
    return out if out != text else None

def drop_stray_closers(s):
    """删掉没有对应左括号的右括号（摘录被从中间截断时会留下这种孤儿）。"""
    out, d = [], 0
    for ch in s:
        if ch in OPEN:
            d += 1; out.append(ch)
        elif ch in CLOSE:
            if d > 0:
                d -= 1; out.append(ch)
            # d==0 时这个右括号就是多余的，直接丢掉
        else:
            out.append(ch)
    return ''.join(out)

def close_open_ends(s):
    """有没闭合的左括号时，退回到最后一个括号配平的位置，并补省略号。"""
    d, last = 0, 0
    for i, ch in enumerate(s):
        if ch in OPEN: d += 1
        elif ch in CLOSE: d = max(0, d - 1)
        if d == 0: last = i + 1
    if d == 0: return s
    cut = s[:last].rstrip()
    if cut and not re.search(r'[。！？…）」》”’\.]$', cut): cut += '…'
    return cut

def tidy(s):
    """回原文补齐失败时的兜底：只做删/截，不添字。"""
    t = drop_stray_closers(s)
    if balanced(t): return t
    t2 = close_open_ends(t)
    return t2 if balanced(t2) else drop_stray_closers(t2)

# ---------- 1) 补括号 ----------
# 全文扫一遍，而不是按字段枚举：认错档案在 corrTopics 里还有一份副本，
# 只修 corrections 会让两处显示不一致。
targets = []          # (容器, 键, 路径, 是否摘录)
EXCERPT_KEYS = ('note', 'intro')

def collect(o, path=''):
    if isinstance(o, dict):
        for k, v in o.items():
            p = path + '.' + str(k)
            if isinstance(v, str):
                if len(v) > 20:
                    targets.append((o, k, p, k in EXCERPT_KEYS))
            else:
                collect(v, p)
    elif isinstance(o, list):
        for i, v in enumerate(o):
            p = '%s[%d]' % (path, i)
            if isinstance(v, str):
                if len(v) > 20:
                    targets.append((o, i, p, False))
            else:
                collect(v, p)
collect(CONTENT)

END_RE = re.compile(r'[。！？…）」》”’\.]$')

def final_touch(s):
    """摘录被截在半句话上时补个省略号，别让读者以为原文就是这么断的。"""
    s = s.rstrip()
    if len(s) >= 60 and not END_RE.search(s):
        return s + '…'
    return s

fixed, unfixable = [], []
for obj, key, where, is_excerpt in targets:
    t = obj[key]
    if not isinstance(t, str) or not t: continue
    if not balanced(t):
        block = block_text(obj.get('loc')) if isinstance(obj, dict) else None
        new = repair(t, block) if block else None      # 能回原文补齐就补齐
        if not new or not balanced(new):
            new = tidy(t)                              # 兜底：删孤儿右括号 / 退回上一个配平处
        if not new or not balanced(new) or new == t:
            unfixable.append((where, '仍配不平'))
            continue
    elif is_excerpt:
        new = final_touch(t)
        if new == t: continue
    else:
        continue
    if is_excerpt: new = final_touch(new)
    if new == t: continue
    fixed.append((where, t, new))
    obj[key] = new

print('=== 括号残缺修复 %d 处 ===' % len(fixed))
for where, old, new in fixed:
    print('  · %s' % where)
    print('    旧: %s' % old[:90])
    print('    新: %s' % new[:90])
if unfixable:
    print('=== 未能修复 %d 处 ===' % len(unfixable))
    for w, why in unfixable: print('  · %s — %s' % (w, why))

# ---------- 2) 规则库去重（同一句原话被多个概念收录） ----------
rules = CONTENT.get('rules') or []
seen = {}
merged, dropped = [], []
for r in rules:
    k = (r.get('t'), r.get('y'))
    if k in seen:
        first = seen[k]
        srcs = [x for x in [first.get('src')] if x]
        if r.get('src') and r['src'] not in srcs:
            srcs.append(r['src'])
            first['src'] = ' / '.join(srcs)
        dropped.append('%s | %s' % (r.get('y'), (r.get('t') or '')[:34]))
    else:
        seen[k] = r
        merged.append(r)
print('\n=== 规则库去重 ===')
print('  原 %d 条 → 合并后 %d 条（去掉 %d 条完全重复）' % (len(rules), len(merged), len(dropped)))
for d in dropped: print('    - %s' % d)
CONTENT['rules'] = merged

# ---------- 写回 ----------
with io.open(OUT, 'w', encoding='utf-8') as f:
    f.write('window.CONTENT = ')
    f.write(json.dumps(CONTENT, ensure_ascii=False, separators=(',', ':')))
    f.write(';\n')
print('\n已写回 %s' % OUT)
