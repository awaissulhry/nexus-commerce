#!/usr/bin/env python3
"""Build corpus.json / corpus.md / skus.json / keys/ from _raw.json (written by classify.py)."""
import json, os, re
from collections import Counter, defaultdict

OUT = os.path.dirname(os.path.abspath(__file__))
R = json.load(open(os.path.join(OUT, '_raw.json')))
os.makedirs(os.path.join(OUT, 'keys'), exist_ok=True)

def norm_key(k):
    k = re.sub(r'\[marketplace_id=[^\]]+\]', '[marketplace_id=*]', k)
    k = re.sub(r'\[language_tag=[^\]]+\]', '[language_tag=*]', k)
    return k

def safe(p):
    return re.sub(r'[^A-Za-z0-9._-]+', '_', p)[-150:]

def data_sheets(r):
    return [d for d in r.get('dataSheets', []) if d.get('role') == 'data']

def sku_key(d):
    if d['format'] == 'amazon-new':
        return 'contribution_sku#1.value'
    if d['format'] == 'amazon-old':
        return 'item_sku'
    return d.get('_skuKey')

def market_of(r, d):
    if d['format'] == 'amazon-new':
        return ','.join(m.split('=')[1] for m in d['markets']) or '?'
    if d['format'] in ('ebay', 'outerwear-table'):
        m = re.match(r'^ebay_([a-z]{2})$', d['sheet'], re.I)
        if m:
            return m.group(1).upper()
        return 'IT?' if 'IT' in r['path'] else '?'
    # amazon-old: the settings cell (D1) names the primary marketplace.
    pm = (d.get('settingsTokens') or {}).get('primaryMarketplaceId', '')
    mid = pm.split('.')[-1] if pm else ''
    MK = {'A1PA6795UKMFR9': 'DE', 'APJ6JRA9NG5V4': 'IT', 'A13V1IB3VIYZZH': 'FR', 'A1RKKUPIHCS9HS': 'ES', 'A1F83G8C2ARO7P': 'UK'}
    return MK.get(mid, mid or '?') + ' (settings)'

# ---------- skus.json + record index ----------
skus = {}
records = {}  # path -> {sku: {key: value}}
for r in R:
    for d in data_sheets(r):
        k = sku_key(d)
        if not k:
            continue
        recs = {}
        for rn, rec in d['_data']:
            sku = str(rec.get(k, '')).strip()
            if sku:
                recs[sku] = rec
        records.setdefault(r['path'], {}).update(recs)
        skus.setdefault(r['path'], [])
        skus[r['path']] = sorted(set(skus[r['path']]) | set(recs))
json.dump(skus, open(os.path.join(OUT, 'skus.json'), 'w'), indent=1, ensure_ascii=False)

# ---------- keys/ ----------
for r in R:
    for d in data_sheets(r):
        if d['format'] in ('amazon-new', 'amazon-old'):
            with open(os.path.join(OUT, 'keys', safe(r['path']) + '.txt'), 'w') as fh:
                fh.write('\n'.join(d['keys']) + '\n')
        elif d.get('headers'):
            with open(os.path.join(OUT, 'keys', safe(r['path']) + '.headers.txt'), 'w') as fh:
                fh.write('\n'.join(d['headers']) + '\n')

def union(fmt):
    files = [(r, d) for r in R for d in data_sheets(r) if d['format'] == fmt]
    n = len(files)
    count = Counter()
    by_pt = defaultdict(Counter)
    pt_files = Counter()
    for r, d in files:
        pts = '+'.join(sorted(k for k in (d.get('productTypes') or {}) if k)) or '(none)'
        pt_files[pts] += 1
        ks = {norm_key(k) for k in d['keys']}
        for k in ks:
            count[k] += 1
            by_pt[pts][k] += 1
    common = sorted(k for k, c in count.items() if c == n)
    partial = sorted((k for k, c in count.items() if c < n), key=lambda k: (-count[k], k))
    lines = [f'# Key union — {fmt} ({n} data sheets)', '',
             'Keys normalized: `[marketplace_id=*]`, `[language_tag=*]`.', '',
             f'Product-type sets: ' + ', '.join(f'{k} ×{v}' for k, v in pt_files.most_common()), '',
             f'## Common to all {n} files: {len(common)} keys', '']
    lines += [f'- `{k}`' for k in common]
    lines += ['', f'## In some files only: {len(partial)} keys (count of files; per product-type set)', '']
    for k in partial:
        per = ', '.join(f'{pts}:{by_pt[pts][k]}/{pt_files[pts]}' for pts in pt_files if by_pt[pts][k])
        lines.append(f'- `{k}` — {count[k]}/{n} — {per}')
    open(os.path.join(OUT, 'keys', f'_union-{fmt}.md'), 'w').write('\n'.join(lines) + '\n')
    return n, len(common), len(partial), len(count)

u_new = union('amazon-new')
u_old = union('amazon-old')

# ---------- overlap / diff vs FINAL ----------
def fmt_of(r):
    ds = data_sheets(r)
    return ds[0]['format'] if ds else None

finals = [r for r in R if r.get('flag') == 'final' and data_sheets(r)]
overlaps = []
for f in finals:
    fs = set(skus.get(f['path'], []))
    for o in R:
        if o is f or not data_sheets(o):
            continue
        os_ = set(skus.get(o['path'], []))
        shared = fs & os_
        if not shared:
            continue
        entry = {'final': f['path'], 'other': o['path'], 'otherFlag': o.get('flag'), 'otherFormat': fmt_of(o),
                 'finalFormat': fmt_of(f), 'sharedSkus': len(shared), 'finalSkus': len(fs), 'otherSkus': len(os_),
                 'finalMarket': market_of(f, data_sheets(f)[0]), 'otherMarket': market_of(o, data_sheets(o)[0])}
        if fmt_of(o) == fmt_of(f) or {fmt_of(o), fmt_of(f)} == {'ebay', 'ebay'}:
            fr, orr = records[f['path']], records[o['path']]
            common_keys = set(next(iter(fr.values())).keys()) & set(next(iter(orr.values())).keys())
            diff_cells = 0
            diff_keys = Counter()
            for sku in shared:
                for k in common_keys:
                    a, b = str(fr[sku].get(k, '')).strip(), str(orr[sku].get(k, '')).strip()
                    if a != b:
                        diff_cells += 1
                        diff_keys[k] += 1
            entry['commonKeys'] = len(common_keys)
            entry['keysOnlyInFinal'] = len(set(next(iter(fr.values())).keys()) - common_keys)
            entry['keysOnlyInOther'] = len(set(next(iter(orr.values())).keys()) - common_keys)
            entry['differingCells'] = diff_cells
            entry['topDifferingKeys'] = diff_keys.most_common(8)
        overlaps.append(entry)
json.dump(overlaps, open(os.path.join(OUT, 'overlaps.json'), 'w'), indent=1, ensure_ascii=False)

# ---------- corpus.json (no row data) ----------
def strip(r):
    r = dict(r)
    r['dataSheets'] = [{k: v for k, v in d.items() if not k.startswith('_')} for d in r.get('dataSheets', [])]
    return r
json.dump([strip(r) for r in R], open(os.path.join(OUT, 'corpus.json'), 'w'), indent=1, ensure_ascii=False)

# ---------- corpus.md ----------
def short(d, maxn=4):
    if not d:
        return ''
    items = sorted(d.items(), key=lambda kv: -kv[1])
    s = ', '.join(f'{k or "(blank)"}×{v}' for k, v in items[:maxn])
    return s + (f', +{len(items) - maxn}' if len(items) > maxn else '')

L = ['# Corpus classification — /Users/awais/Desktop/2026/LISTNGS', '',
     f'Generated by `classify.py` + `report.py` (read only; stdlib zipfile/XML). {len(R)} spreadsheet files.', '']
fmt_count = Counter(r['format'] for r in R)
L += ['## Formats', ''] + [f'- **{k}**: {v}' for k, v in fmt_count.most_common()] + ['']

L += ['## Per file', '',
      '| # | file | flag | format | data sheet | key row → first data | keys | market | lang | product types | record actions (semantic) | rows (P/C/S) | parents | formulas |',
      '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|']
for i, r in enumerate(R, 1):
    ds = data_sheets(r)
    if not ds:
        L.append(f"| {i} | {r['path']} | {r.get('flag')} | {r['format']} | {r.get('note', r.get('error', ''))} | | | | | | | | | |")
        continue
    for d in ds:
        if d['format'] in ('amazon-new', 'amazon-old'):
            sem = short(d.get('recordActionSemantics'))
            ptype = short(d.get('productTypes'))
            L.append(f"| {i} | {r['path']} | {r.get('flag')} | {d['format']}{' ('+r.get('ooxmlFlavor')+')' if r.get('ooxmlFlavor') == 'strict' else ''} | {d['sheet']} | {d['keyRow']} → {d['firstDataRow']} | {d['keyCount']} | {market_of(r, d)} | {','.join(d.get('languages') or []) if d['format'] == 'amazon-new' else (d.get('settingsTokens') or {}).get('contentLanguageTag', '?') + ' (settings)'} | {ptype} | {sem} | {d['rows']} ({d['parents']}/{d['children']}/{d['standalone']}) | {', '.join(d['distinctParentSkus'][:3])}{'…' if len(d['distinctParentSkus']) > 3 else ''} | {d['formulaCells']} |")
        else:
            L.append(f"| {i} | {r['path']} | {r.get('flag')} | {r['format']} | {d['sheet']} | 1 → {d['firstDataRow']} | {d['headerCount']} | {market_of(r, d)} | | {short(d.get('categoryIds') or (d.get('counters') or {}).get('Product Type'))} | action: {short(d.get('actions') or (d.get('counters') or {}).get('Operation'))} | {d['rows']} ({short(d.get('parentChild'))}) | {', '.join(d['distinctParentSkus'][:3])}{'…' if len(d['distinctParentSkus']) > 3 else ''} | {d['formulaCells']} |")
L.append('')

# Summary per format
L += ['## Summary per format', '']
for fmt in ('amazon-new', 'amazon-old', 'ebay', 'outerwear-table'):
    items = [(r, d) for r in R for d in data_sheets(r) if d['format'] == fmt]
    if not items:
        continue
    mk = Counter(market_of(r, d) for r, d in items)
    lang = Counter(l for r, d in items for l in (d.get('languages') or []))
    pts = Counter()
    acts = Counter()
    raw_acts = Counter()
    for r, d in items:
        for k, v in (d.get('productTypes') or (d.get('counters') or {}).get('Product Type') or {}).items():
            pts[k] += v
        for k, v in (d.get('recordActionSemantics') or {}).items():
            acts[k] += v
        for k, v in (d.get('recordActions') or d.get('actions') or (d.get('counters') or {}).get('Operation') or {}).items():
            raw_acts[k] += v
    keyc = [d.get('keyCount') or d.get('headerCount') for r, d in items]
    rows = sum(d['rows'] for r, d in items)
    L += [f'### {fmt} — {len(items)} files, {rows} data rows', '',
          f'- markets: {short(dict(mk), 20)}',
          f'- languages: {short(dict(lang), 20)}',
          f'- product types (rows): {short(dict(pts), 20)}',
          f'- record actions (rows, semantic): {short(dict(acts), 20)}',
          f'- record actions (rows, raw label): {short(dict(raw_acts), 40)}',
          f'- keys/headers per file: min {min(keyc)}, max {max(keyc)}',
          f'- files with formulas in the data sheet: {sum(1 for r, d in items if d["formulaCells"])}; error cells: {sum(d["errorCells"] for r, d in items)}',
          '']
L += [f'Key union: amazon-new {u_new[0]} files, {u_new[3]} distinct normalized keys, {u_new[1]} common to all, {u_new[2]} in some only → `keys/_union-amazon-new.md`.',
      f'amazon-old {u_old[0]} files, {u_old[3]} distinct, {u_old[1]} common, {u_old[2]} some only → `keys/_union-amazon-old.md`.', '']

# Special lists
L += ['## Notable files', '']
for r in R:
    for d in data_sheets(r):
        notes = []
        if len(d.get('languages') or []) > 1:
            notes.append(f"TWO+ languages {d['languages']}")
        if len(d.get('markets') or []) > 1:
            notes.append(f"several markets {d['markets']}")
        pts = [k for k in (d.get('productTypes') or {}) if k]
        if len(pts) > 1:
            notes.append(f'several product types {d["productTypes"]}')
        sem = d.get('recordActionSemantics') or {}
        if sem.get('delete'):
            notes.append(f"DELETE rows {sem['delete']}")
        if sem.get('partial'):
            notes.append(f"PARTIAL rows {sem['partial']}")
        if sem.get('blank') and d['format'] == 'amazon-new':
            dv = (d.get('settingsTokens') or {}).get('AttributeDefaultValues', '')
            notes.append(f"blank action rows {sem['blank']} (template default: {dv or 'none'})")
        if any(k.startswith('unknown') for k in sem):
            notes.append(f'unknown action labels {[k for k in sem if k.startswith("unknown")]}')
        if d.get('formulaCells'):
            notes.append(f"formulas {d['formulaCells']}")
        if d.get('errorCells'):
            notes.append(f"error cells {d['errorCells']}")
        if r.get('ooxmlFlavor') == 'strict':
            notes.append('STRICT OOXML (purl.oclc.org namespaces)')
        if d['rows'] == 0:
            notes.append('NO data rows (blank template)')
        if any(str(k).startswith('other:') for k in (d.get('parentageSemantics') or {})):
            notes.append(f"unmapped parentage {d['parentageSemantics']}")
        if notes:
            L.append(f"- `{r['path']}` [{d['sheet']}]: " + '; '.join(notes))
L.append('')

# Overlap section
L += ['## Same SKUs as a FINAL file (value comparison on common keys, same format only)', '',
      '| FINAL | other file | other flag | fmt | shared/final/other SKUs | common keys | only-final/only-other keys | differing cells | top differing keys |',
      '|---|---|---|---|---|---|---|---|---|']
for e in sorted(overlaps, key=lambda e: (e['final'], e['other'])):
    L.append(f"| {e['final'].split('/')[-1]} ({e['finalMarket']}) | {e['other']} | {e['otherFlag']} | {e['otherFormat']} ({e['otherMarket']}) | {e['sharedSkus']}/{e['finalSkus']}/{e['otherSkus']} | {e.get('commonKeys', '—')} | {e.get('keysOnlyInFinal', '—')}/{e.get('keysOnlyInOther', '—')} | {e.get('differingCells', '—')} | {'; '.join(f'{k}×{v}' for k, v in e.get('topDifferingKeys', [])[:4])} |")
L.append('')
L += ['## Positive controls (independent reads with unzip + perl, 2026-09-24)', '',
      '- GALE DE FINAL: workbook.xml has `<sheet name="Vorlage" … r:id="rId5">`; row 5 of sheet5.xml holds 352 valued cells; all 352 key strings carry `[marketplace_id=A1PA6795UKMFR9]`, 0 carry another id; `language_tag=de_DE` present; 21 rows ≥ 7 have a column-A value. Classifier: Vorlage, 352 keys, de_DE, DE, 21 rows. MATCH.',
      '- GALE IT eBay: sheet `ebay_it`; last row r=106 (105 data rows); 105 cells hold 177104. Classifier: 105 rows, 177104×105. MATCH.',
      '- GALE DE NEW TEMPLATE (delete file): column B (`::record_action`) has 19 cells = sst 1054 = `Löschen`. Classifier: Löschen×19. MATCH. AIREON IT FINAL: 21 cells = COAT, 20 = PANTS. Classifier: COAT×21, PANTS×20. MATCH.',
      '- (A first perl count returned 0 for `Löschen` — a shell-quoting fault in the probe, not the data; re-run with a literal pattern gave 19.)', '',
      '## Caveats', '',
      '- The outerwear table repeats headers (`Currency`, `Quantity`, `Weight`, `Weight Unit`, `Packaging` twice); the per-row dicts keep the LAST column of a repeated name.',
      '- eBay files repeat one SKU once per listing; the overlap diff keeps the last row per SKU, so eBay "differing cells" counts are indicative only.',
      '- Parentage / record-action semantics use the localized label lists measured here (`classify.py` PARENT_WORDS / ACTION_*). No `unknown:` label remains in this corpus.',
      '']
open(os.path.join(OUT, 'corpus.md'), 'w').write('\n'.join(L) + '\n')
print('ok', len(R), 'files;', len(overlaps), 'overlap pairs')
