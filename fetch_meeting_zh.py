# -*- coding: utf-8 -*-
"""下载 berkshiredata.cloud 的股东大会中英对照全文
输入: _bd.html（站点首页，内含 Y[年份].sessions[].f 文件名清单）
输出: _src/meeting/html/*.html      66 场会议原文
      _src/meeting/files.json      清单与状态

为什么值得做：现有股东大会语料只有 380 条（英文字幕的中译，占原始 9,598 段的 4%），
瓶颈在翻译成本。这个站直接给了 1994-2026 全部会议的中英对照全文（中文 176 万字），
不用自己翻译，而且带说话人和章节标题。
"""
import re, os, json, time, urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))
IDX = os.path.join(ROOT, '_bd.html')
OUT = os.path.join(ROOT, '_src', 'meeting', 'html')
os.makedirs(OUT, exist_ok=True)

t = open(IDX, encoding='utf-8', errors='replace').read()
files = re.findall(r"f:'([^']+)'", t)
files = sorted(set(files))
print('清单', len(files), '场')

UA = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'}
ok, fail = [], []
for i, f in enumerate(files):
    dst = os.path.join(OUT, f + '.html')
    if os.path.exists(dst) and os.path.getsize(dst) > 5000:
        ok.append(f)
        continue
    url = 'http://berkshiredata.cloud/' + f + '.html'
    for attempt in range(3):
        try:
            r = urllib.request.Request(url, headers=UA)
            h = urllib.request.urlopen(r, timeout=60).read().decode('utf-8', errors='replace')
            if len(h) < 5000:
                raise ValueError('太短 %d' % len(h))
            open(dst, 'w', encoding='utf-8').write(h)
            ok.append(f)
            break
        except Exception as e:
            if attempt == 2:
                fail.append((f, str(e)))
            else:
                time.sleep(2)
    if (i + 1) % 10 == 0:
        print(f'  {i+1}/{len(files)}  成功 {len(ok)}  失败 {len(fail)}')
    time.sleep(0.3)

json.dump({'files': files, 'ok': ok, 'fail': fail},
          open(os.path.join(ROOT, '_src', 'meeting', 'files.json'), 'w', encoding='utf-8'),
          ensure_ascii=False, indent=1)
print(f'完成：成功 {len(ok)}，失败 {len(fail)}')
for f, e in fail[:10]:
    print('  FAIL', f, e)
