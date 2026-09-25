#!/usr/bin/env python3
"""Read-only classifier for the Owner's listing corpus.

stdlib only (zipfile + xml.etree.iterparse). Never writes to the corpus.
Outputs into the folder this script lives in: corpus.json, corpus.md, skus.json, keys/.
"""
import json, os, re, signal, sys, zipfile, time, posixpath
from collections import Counter, defaultdict
import xml.etree.ElementTree as ET

ROOT = '/Users/awais/Desktop/2026/LISTNGS'
OUT = os.path.dirname(os.path.abspath(__file__))
MKT = {'A1PA6795UKMFR9': 'DE', 'APJ6JRA9NG5V4': 'IT', 'A13V1IB3VIYZZH': 'FR', 'A1RKKUPIHCS9HS': 'ES',
       'A1F83G8C2ARO7P': 'UK', 'ATVPDKIKX0DER': 'US', 'A1805IZSGTT6HS': 'NL', 'A2NODRKZP88ZB9': 'SE',
       'A1C3SOZRARQ6R3': 'PL', 'AMEN7PMS3EDWL': 'BE', 'A28R8C7NBKEWEA': 'IE', 'A33AVAJ2PDY3EV': 'TR'}
REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

def local(tag):
    return tag.rsplit('}', 1)[-1]

def col_index(ref):
    m = re.match(r'([A-Z]+)', ref or '')
    if not m:
        return None
    n = 0
    for ch in m.group(1):
        n = n * 26 + ord(ch) - 64
    return n - 1

def col_name(i):
    s = ''
    i += 1
    while i:
        i, r = divmod(i - 1, 26)
        s = chr(65 + r) + s
    return s

class Timeout(Exception):
    pass

def _alarm(signum, frame):
    raise Timeout()

def text_of(el):
    """Concatenate <t> text, skipping phonetic runs (<rPh>)."""
    out = []
    def walk(e):
        for ch in e:
            ln = local(ch.tag)
            if ln == 'rPh':
                continue
            if ln == 't':
                out.append(ch.text or '')
            else:
                walk(ch)
    walk(el)
    return ''.join(out)

def load_shared(zf, target):
    if not target or target not in zf.namelist():
        return []
    strings = []
    with zf.open(target) as fh:
        for ev, el in ET.iterparse(fh, events=('end',)):
            if local(el.tag) == 'si':
                strings.append(text_of(el))
                el.clear()
    return strings

def workbook_sheets(zf):
    wb = ET.fromstring(zf.read('xl/workbook.xml'))
    rels_xml = ET.fromstring(zf.read('xl/_rels/workbook.xml.rels'))
    rels = {}
    shared = None
    for r in rels_xml:
        tgt = r.get('Target')
        if tgt.startswith('/'):
            path = tgt.lstrip('/')
        else:
            path = posixpath.normpath(posixpath.join('xl', tgt))
        rels[r.get('Id')] = path
        if r.get('Type', '').endswith('/sharedStrings'):
            shared = path
    sheets = []
    workbook_workbook_ns = wb.tag.split('}')[0].lstrip('{')
    for el in wb.iter():
        if local(el.tag) == 'sheet':
            rid = next((v for k, v in el.attrib.items() if k.endswith('}id')), None)
            sheets.append({'name': el.get('name'), 'state': el.get('state') or 'visible', 'path': rels.get(rid)})
    return sheets, shared, workbook_workbook_ns

def read_rows(zf, path, shared, max_row=None):
    """Yield (rownum, {colidx: value}, formula_count, error_count) per row."""
    with zf.open(path) as fh:
        rownum = 0
        for ev, el in ET.iterparse(fh, events=('end',)):
            if local(el.tag) != 'row':
                continue
            r = el.get('r')
            rownum = int(r) if r else rownum + 1
            if max_row and rownum > max_row:
                el.clear()
                return
            cells = {}
            fcount = ecount = 0
            fcols = []
            ci = -1
            for c in el:
                if local(c.tag) != 'c':
                    continue
                ref = c.get('r')
                ci = col_index(ref) if ref else ci + 1
                t = c.get('t')
                v = None
                has_f = False
                for ch in c:
                    ln = local(ch.tag)
                    if ln == 'v':
                        v = ch.text
                    elif ln == 'f':
                        has_f = True
                    elif ln == 'is':
                        v = text_of(ch)
                if has_f:
                    fcount += 1
                    fcols.append(ci)
                if t == 's' and v is not None:
                    try:
                        v = shared[int(v)]
                    except (ValueError, IndexError):
                        v = '<<bad-sst %s>>' % v
                elif t == 'b' and v is not None:
                    v = 'TRUE' if v == '1' else 'FALSE'
                elif t == 'e':
                    ecount += 1
                    v = '<<error %s>>' % v
                if v is not None and v != '':
                    cells[ci] = v
            el.clear()
            yield rownum, cells, (fcount, fcols), ecount

def head_rows(zf, path, shared, n=8):
    return {rn: cells for rn, cells, _, _ in read_rows(zf, path, shared, max_row=n)}

def fsum(f):
    return f[0] if isinstance(f, tuple) else f

def flag_of(rel):
    if 'FINAL (upload this)' in rel:
        return 'final'
    if 'OLD - previous versions & backup' in rel:
        return 'old-backup'
    if '_BLANK TEMPLATES' in rel:
        return 'blank-template'
    return 'other'

def norm_key(k):
    k = re.sub(r'\[marketplace_id=[^\]]+\]', '[marketplace_id=*]', k)
    k = re.sub(r'\[language_tag=[^\]]+\]', '[language_tag=*]', k)
    return k

# Localized parentage labels measured in this corpus (see corpus.md "parentage labels").
PARENT_WORDS = {'parent', 'articolo parent', 'eltern', 'principal', 'principal.', 'übergeordnetes produkt'}
CHILD_WORDS = {'child', 'bambino', 'enfant', 'kind', 'kinder', 'niños', 'hijo'}

def classify_parentage(v):
    s = (v or '').strip().lower()
    if not s:
        return 'blank'
    if s in PARENT_WORDS:
        return 'parent'
    if s in CHILD_WORDS:
        return 'child'
    return 'other:' + s

# Localized record-action labels measured in this corpus -> the three Amazon semantics.
ACTION_FULL = {'crea o sostituisci (aggiornamento completo)', 'erstellen oder ersetzen (vollständige aktualisierung)',
               'créer ou remplacer (actualisation complète)', 'crear o reemplazar (actualización completa)',
               '(default) create or replace', '(impostazione predefinita) crea o sostituisci', '(par défaut) créer ou remplacer',
               '(predeterminado) crear o reemplazar', '(standard) erstellen oder ersetzen',
               'aggiorna', 'aktualisierung', 'actualisation', 'full_update', 'update', 'actualización'}
ACTION_PARTIAL = {'bearbeiten (teilaktualisierung)', 'edit (partial update)', 'editar (actualización parcial)',
                  'modifica (aggiornamento parziale)', 'modifier (mise à jour partielle)',
                  'aggiornamentoparziale', 'partielle aktualisierung', 'actualisation partielle', 'partial_update', 'actualización parcial'}
ACTION_DELETE = {'löschen', 'elimina', 'eliminación', 'löschung', 'supprimer', 'delete'}

def action_semantic(v):
    s = (v or '').strip().lower()
    if not s:
        return 'blank'
    if s in ACTION_FULL:
        return 'full'
    if s in ACTION_PARTIAL:
        return 'partial'
    if s in ACTION_DELETE:
        return 'delete'
    return 'unknown:' + s

EXAMPLE_SHEETS = {'esempio', 'beispiel', 'ejemplo', 'exemple', 'example', 'voorbeeld'}

def trunc(v, n=160):
    v = str(v)
    return v if len(v) <= n else v[:n] + '…(%d chars)' % len(v)

def analyse_amazon(zf, sheet, shared, key_row, fmt):
    """Full read of an Amazon data sheet (new or old)."""
    rows = {}
    formulas = errors = 0
    formula_cols = Counter()
    for rn, cells, f, e in read_rows(zf, sheet['path'], shared):
        rows[rn] = cells
        formulas += f[0]
        for c in f[1]:
            formula_cols[(c, rn > key_row)] += 1
        errors += e
    keys = rows.get(key_row, {})
    keylist = [(ci, keys[ci]) for ci in sorted(keys)]
    by_key = {k: ci for ci, k in keylist}
    if fmt == 'amazon-new':
        sku_k = 'contribution_sku#1.value'
        type_k = 'product_type#1.value'
        act_k = '::record_action'
        par_k = next((k for _, k in keylist if k.startswith('parentage_level')), None)
        psku_k = next((k for _, k in keylist if k.startswith('child_parent_sku_relationship') and k.endswith('parent_sku')), None)
        theme_k = next((k for _, k in keylist if k.startswith('variation_theme')), None)
    else:
        sku_k = 'item_sku'
        type_k = 'feed_product_type'
        act_k = 'update_delete'
        par_k = 'parent_child' if 'parent_child' in by_key else None
        psku_k = 'parent_sku' if 'parent_sku' in by_key else None
        theme_k = 'variation_theme' if 'variation_theme' in by_key else None
    sku_ci = by_key.get(sku_k)
    data = []
    pre_data_rows = []
    for rn in sorted(rows):
        if rn <= key_row:
            continue
        cells = rows[rn]
        sku = cells.get(sku_ci, '').strip() if sku_ci is not None else ''
        if not sku:
            if cells:
                pre_data_rows.append({'row': rn, 'nonEmpty': len(cells), 'sample': {col_name(c): trunc(v, 60) for c, v in list(cells.items())[:4]}})
            continue
        data.append((rn, {k: cells.get(ci, '') for ci, k in keylist}))
    def col_counter(k):
        if not k:
            return None
        return dict(Counter(rec.get(k, '').strip() for _, rec in data))
    ptypes = col_counter(type_k)
    actions = col_counter(act_k)
    action_sem = dict(Counter(action_semantic(rec.get(act_k, '')) for _, rec in data)) if act_k in by_key else None
    parentage_sem = dict(Counter(classify_parentage(rec.get(par_k, '')) for _, rec in data)) if par_k else None
    # Cross-tab product type x action semantic.
    type_action = dict(Counter(f"{rec.get(type_k, '').strip()}|{action_semantic(rec.get(act_k, ''))}" for _, rec in data)) if act_k in by_key else None
    parentage_raw = col_counter(par_k)
    parent_skus = set()
    n_parent = n_child = n_stand = 0
    child_skus_with_parent = 0
    for _, rec in data:
        psku = rec.get(psku_k, '').strip() if psku_k else ''
        cls = classify_parentage(rec.get(par_k, '')) if par_k else 'blank'
        if psku:
            parent_skus.add(psku)
            child_skus_with_parent += 1
        if cls == 'parent':
            n_parent += 1
        elif cls == 'child' or psku:
            n_child += 1
        else:
            n_stand += 1
    markets = sorted({m for _, k in keylist for m in re.findall(r'marketplace_id=([A-Z0-9]+)', k)})
    langs = sorted({m for _, k in keylist for m in re.findall(r'language_tag=([A-Za-z_]+)', k)})
    hints = {}
    for _, k in keylist:
        kl = k.lower()
        if any(w in kl for w in ('currency', 'language_value', 'language')) and 'language_tag' not in kl:
            vals = Counter(rec.get(k, '').strip() for _, rec in data)
            vals.pop('', None)
            if vals:
                hints[k] = dict(vals)
    row1 = rows.get(1, {})
    settings = {col_name(c): trunc(v, 300) for c, v in sorted(row1.items())[:8]}
    settings_tokens = {}
    a1 = next((v for c, v in sorted(row1.items()) if str(v).startswith('settings=')), '')
    if a1.startswith('settings='):
        for part in a1[len('settings='):].split('&'):
            if '=' in part:
                kk, vv = part.split('=', 1)
                if kk.lower() in ('feedtype', 'timestamp', 'templateidentifier', 'version', 'contentlanguagetag', 'primarymarketplaceid', 'marketplaceid', 'templatetype', 'isedit'):
                    settings_tokens[kk] = trunc(vv, 100)
                elif kk == 'AttributeDefaultValues':
                    import base64, urllib.parse
                    try:
                        settings_tokens[kk] = base64.b64decode(urllib.parse.unquote(vv)).decode('utf-8', 'replace')
                    except Exception:  # noqa: BLE001
                        settings_tokens[kk] = vv
                elif kk == 'ptds':
                    import base64, urllib.parse
                    try:
                        settings_tokens[kk] = base64.b64decode(urllib.parse.unquote(vv)).decode('utf-8', 'replace')
                    except Exception:  # noqa: BLE001
                        settings_tokens[kk] = vv
                elif len(vv) < 80:
                    settings_tokens[kk] = vv
                else:
                    settings_tokens[kk] = '<%d chars>' % len(vv)
    group_row = {col_name(c): trunc(v, 60) for c, v in sorted(rows.get(key_row - 2, {}).items())[:40]} if fmt == 'amazon-new' else {}
    label_row = {col_name(c): trunc(v, 60) for c, v in sorted(rows.get(key_row - 1, {}).items())[:12]}
    return {
        'keyRow': key_row,
        'firstDataRow': data[0][0] if data else None,
        'lastDataRow': data[-1][0] if data else None,
        'keyCount': len(keylist),
        'keys': [k for _, k in keylist],
        'markets': [f'{m}={MKT.get(m, "?")}' for m in markets],
        'languages': langs,
        'productTypes': ptypes,
        'recordActions': actions,
        'recordActionSemantics': action_sem,
        'productTypeByAction': type_action,
        'parentageSemantics': parentage_sem,
        'actionKey': act_k if act_k in by_key else None,
        'parentageKey': par_k,
        'parentageRaw': parentage_raw,
        'variationThemes': col_counter(theme_k),
        'rows': len(data),
        'parents': n_parent,
        'children': n_child,
        'standalone': n_stand,
        'distinctParentSkus': sorted(parent_skus),
        'nonSkuRowsAfterKeys': pre_data_rows[:10],
        'nonSkuRowsAfterKeysCount': len(pre_data_rows),
        'formulaCells': formulas,
        'formulaColumns': {f"{col_name(c)}:{keys.get(c, '?')}{'' if data_row else ' (header rows)'}": n for (c, data_row), n in formula_cols.items()},
        'errorCells': errors,
        'row1': settings,
        'settingsTokens': settings_tokens,
        'labelRowSample': label_row,
        'groupRowSample': group_row,
        'marketHints': hints,
        '_data': data,
    }

def analyse_ebay(zf, sheet, shared):
    rows = {}
    formulas = errors = 0
    for rn, cells, f, e in read_rows(zf, sheet['path'], shared):
        rows[rn] = cells
        formulas += f[0]
        errors += e
    hdr = rows.get(1, {})
    headers = [(ci, hdr[ci]) for ci in sorted(hdr)]
    width = (max(hdr) + 1) if hdr else 0
    blank_headers = [col_name(i) for i in range(width) if i not in hdr]
    hk = {h: ci for ci, h in headers}
    data = []
    for rn in sorted(rows):
        if rn == 1:
            continue
        cells = rows[rn]
        if not any(str(v).strip() for v in cells.values()):
            continue
        data.append((rn, {h: cells.get(ci, '') for ci, h in headers}))
    def counter(h):
        if h not in hk:
            return None
        return dict(Counter(str(rec.get(h, '')).strip() for _, rec in data))
    item_ids = Counter(str(rec.get('Item ID', '')).strip() for _, rec in data) if 'Item ID' in hk else Counter()
    extra_cols = sorted({ci for rn in rows for ci in rows[rn] if ci not in hdr})
    return {
        'headerRow': 1,
        'headers': [h for _, h in headers],
        'headerCount': len(headers),
        'blankHeaderColumnsWithin': blank_headers,
        'dataColumnsWithoutHeader': [col_name(c) for c in extra_cols],
        'rows': len(data),
        'firstDataRow': data[0][0] if data else None,
        'lastDataRow': data[-1][0] if data else None,
        'actions': counter('Action'),
        'parentChild': counter('Parent/Child'),
        'categoryIds': counter('Category ID'),
        'variationThemes': counter('Variation Theme'),
        'itemIdsDistinct': len([k for k in item_ids if k]),
        'itemIdBlankRows': item_ids.get('', 0),
        'rowsPerItemId': dict(item_ids),
        'listingIdPopulated': (sum(1 for _, rec in data if str(rec.get('Listing ID', '')).strip()) if 'Listing ID' in hk else None),
        'itemIdPopulated': (sum(1 for _, rec in data if str(rec.get('Item ID', '')).strip()) if 'Item ID' in hk else None),
        'distinctParentSkus': sorted({str(rec.get('Parent SKU', '')).strip() for _, rec in data if str(rec.get('Parent SKU', '')).strip()}),
        'formulaCells': formulas,
        'errorCells': errors,
        'counters': {h: counter(h) for h in ('Product Type', 'Operation', 'Marketplace', 'Condition', 'Format', 'Duration', 'Shared-SKU (Trading API)') if h in hk},
        '_data': data,
        '_skuKey': 'SKU' if 'SKU' in hk else ('Seller SKU' if 'Seller SKU' in hk else None),
    }

def classify_file(full):
    rel = os.path.relpath(full, ROOT)
    st = os.stat(full)
    info = {'path': rel, 'size': st.st_size, 'mtime': time.strftime('%Y-%m-%d %H:%M', time.localtime(st.st_mtime)), 'flag': flag_of(rel)}
    if os.path.basename(full).startswith('~$'):
        info['format'] = 'lock-file'
        info['note'] = 'lock file, skipped'
        return info
    zf = zipfile.ZipFile(full, 'r')
    sheets, sst_path, wb_ns = workbook_sheets(zf)
    info['ooxmlFlavor'] = 'strict' if 'purl.oclc.org' in wb_ns else 'transitional'
    shared = load_shared(zf, sst_path)
    info['sheets'] = [{'name': s['name'], 'state': s['state'], 'path': s['path']} for s in sheets]
    info['sharedStrings'] = len(shared)
    heads = {}
    detected = []
    for s in sheets:
        if not s['path'] or s['path'] not in zf.namelist():
            continue
        h = head_rows(zf, s['path'], shared, n=10)
        heads[s['name']] = h
        # A key ROW holds several machine keys side by side; the data-definitions sheet lists them in one column.
        new_row = next((rn for rn in sorted(h) if {'contribution_sku#1.value', 'product_type#1.value'} <= set(h[rn].values())), None)
        old_row = next((rn for rn in sorted(h) if {'item_sku', 'feed_product_type'} <= set(h[rn].values())), None)
        row1 = h.get(1, {})
        ebay = 'SKU' in row1.values() and 'Parent/Child' in row1.values()
        if new_row:
            detected.append(('amazon-new', s, new_row))
        elif old_row:
            detected.append(('amazon-old', s, old_row))
        elif ebay:
            detected.append(('ebay', s, 1))
    info['sheetHeads'] = {name: {str(rn): {col_name(c): trunc(v, 80) for c, v in sorted(cells.items())[:14]} for rn, cells in sorted(h.items())} for name, h in heads.items()}
    info['dataSheets'] = []
    if not detected:
        base = os.path.basename(full)
        if base.startswith('XAVIA-eBay-'):
            info['format'] = 'xavia-root'
        elif 'OUTERWEAR' in base:
            info['format'] = 'outerwear'
            s0 = sheets[0]
            a = analyse_ebay(zf, s0, shared)
            a['sheet'] = s0['name']; a['sheetState'] = s0['state']; a['format'] = 'outerwear-table'; a['role'] = 'data'
            info['dataSheets'].append(a)
        else:
            info['format'] = 'other'
        # Full read of every sheet for description.
        desc = []
        for s in sheets:
            if not s['path'] or s['path'] not in zf.namelist():
                continue
            nrows = 0
            ncols = 0
            f = e = 0
            for rn, cells, fc, ec in read_rows(zf, s['path'], shared):
                if cells:
                    nrows += 1
                    ncols = max(ncols, max(cells) + 1)
                f += fc[0]
                e += ec
            desc.append({'sheet': s['name'], 'nonEmptyRows': nrows, 'maxCols': ncols, 'formulaCells': f, 'errorCells': e})
        info['sheetShapes'] = desc
        return info
    fmts = sorted({d[0] for d in detected if d[1]['name'].strip().lower() not in EXAMPLE_SHEETS})
    for fmt, s, krow in detected:
        if fmt in ('amazon-new', 'amazon-old'):
            a = analyse_amazon(zf, s, shared, krow, fmt)
        else:
            a = analyse_ebay(zf, s, shared)
        a['sheet'] = s['name']
        a['sheetState'] = s['state']
        a['format'] = fmt
        a['role'] = 'example' if s['name'].strip().lower() in EXAMPLE_SHEETS else 'data'
        info['dataSheets'].append(a)
    if fmts == ['ebay']:
        names = [s['name'] for s in sheets]
        if len(sheets) == 1 and re.match(r'^ebay_[a-z]{2}$', sheets[0]['name'], re.I):
            info['format'] = 'ebay-ours'
        elif os.path.basename(full).startswith('XAVIA-eBay-'):
            info['format'] = 'xavia-root'
        else:
            info['format'] = 'ebay-like:' + ','.join(names)
    elif len(fmts) == 1:
        info['format'] = fmts[0]
    else:
        info['format'] = '+'.join(fmts)
    return info

def main():
    files = []
    for dp, dn, fn in os.walk(ROOT):
        for f in fn:
            if f.lower().endswith(('.xlsx', '.xlsm')):
                files.append(os.path.join(dp, f))
    files.sort()
    signal.signal(signal.SIGALRM, _alarm)
    results = []
    for full in files:
        t0 = time.time()
        signal.alarm(120)
        try:
            info = classify_file(full)
        except Timeout:
            info = {'path': os.path.relpath(full, ROOT), 'format': 'error', 'error': 'timeout 120 s', 'flag': flag_of(full)}
        except Exception as ex:  # noqa: BLE001
            info = {'path': os.path.relpath(full, ROOT), 'format': 'error', 'error': repr(ex), 'flag': flag_of(full)}
        finally:
            signal.alarm(0)
        info['seconds'] = round(time.time() - t0, 2)
        results.append(info)
        print(f"{info['seconds']:6.2f}s  {info.get('format'):12s}  {info['path']}", file=sys.stderr)
    with open(os.path.join(OUT, '_raw.json'), 'w') as fh:
        json.dump(results, fh, default=lambda o: sorted(o) if isinstance(o, set) else str(o))
    return results

if __name__ == '__main__':
    main()
