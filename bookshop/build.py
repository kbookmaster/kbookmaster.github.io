import json, re, html, pathlib, subprocess, sys
base = pathlib.Path('.')
ORDER = ["en","ko","ja","zh","es","fr","de","pt","et","fa"]
avail = [c for c in ORDER if (base/'i18n'/f'{c}.json').exists()]
data = {c: json.loads((base/'i18n'/f'{c}.json').read_text(encoding='utf-8')) for c in avail}
def fr_fix(s):
    s = re.sub(r' ([:;?!»])', '\u00a0\\1', s)
    return s.replace('« ', '«\u00a0')
if 'fr' in data:
    data['fr'] = {k: fr_fix(v) for k, v in data['fr'].items()}
keys = list(data['en'].keys())
OPTIONAL = {'s9h','s9p1','s9p2','sup1t','sup1','sup1btn','sup2t','sup2','sup2btn','supPending','s9tgT','s9tg'}
probs = []
for c, d in data.items():
    miss = [k for k in keys if k not in d]; extra = [k for k in d if k not in keys and k not in OPTIONAL]
    if miss or extra: probs.append(f'{c}: missing {miss} extra {extra}')
    for k, v in d.items():
        if any(x in v for x in ('\u2014', '\u2013', '\u2015')): probs.append(f'{c}.{k}: dash')
        if re.search('[\u0400-\u04FF]', v): probs.append(f'{c}.{k}: cyrillic')
        if '"' in v: probs.append(f'{c}.{k}: straight double quote')
tpl = (base/'template.html').read_text(encoding='utf-8')
used = set(re.findall(r'data-i18n(?:-html|-aria)?="([A-Za-z0-9]+)"', tpl))
probs += [f'template key missing in en: {k}' for k in used if k not in data['en'] and k not in OPTIONAL]
en = data['en']
def fill(m):
    attr, key = m.group(1), m.group(2)
    if key not in en: return m.group(0)
    val = en[key] if attr == 'data-i18n-html' else html.escape(en[key], quote=False)
    return f'{attr}="{key}">{val}'
out = re.sub(r'(data-i18n(?:-html)?)="([A-Za-z0-9]+)">(?=</)', fill, tpl)
out = re.sub(r'data-langname>(?=</)', 'data-langname>' + en['langName'], out)
out = re.sub(r'data-i18n-aria="([A-Za-z0-9]+)"', lambda m: f'data-i18n-aria="{m.group(1)}" aria-label="{html.escape(en[m.group(1)])}"', out)
blob = json.dumps(data, ensure_ascii=False, separators=(',', ':')).replace('</', '<\\/')
out = out.replace('/*__I18N__*/null', blob).replace('/*__ORDER__*/["en"]', json.dumps(avail))
if any(x in out for x in ('\u2014', '\u2013')): probs.append('dash in final html')
dst = pathlib.Path('index.html')
dst.write_text(out, encoding='utf-8')
js = out.split('<script>')[1].split('</script>')[0]
(base/'check.js').write_text(js, encoding='utf-8')
r = subprocess.run(['node', '--check', str(base/'check.js')], capture_output=True, text=True)
print('languages:', avail)
print('node check:', 'OK' if r.returncode == 0 else r.stderr[:500])
print('problems:', probs or 'none')
print('size KB:', round(len(out.encode()) / 1024, 1))
