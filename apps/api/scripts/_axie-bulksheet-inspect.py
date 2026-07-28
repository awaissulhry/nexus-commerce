import zipfile, re, sys, html
p = sys.argv[1]
z = zipfile.ZipFile(p)
wb = z.read('xl/workbook.xml').decode('utf-8', 'replace')
rels = z.read('xl/_rels/workbook.xml.rels').decode('utf-8', 'replace')
relmap = dict(re.findall(r'Id="([^"]+)"[^>]*Target="([^"]+)"', rels))
sheets = re.findall(r'<sheet[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"[^>]*/?>', wb)
if not sheets:
    sheets = [(m.group(2), m.group(1)) for m in re.finditer(r'<sheet[^>]*r:id="([^"]+)"[^>]*name="([^"]+)"', wb)]
print(f"SHEETS ({len(sheets)}):")
order = []
for name, rid in sheets:
    tgt = relmap.get(rid, '?').lstrip('/')
    if not tgt.startswith('xl/'): tgt = 'xl/' + tgt
    try: size = z.getinfo(tgt).file_size
    except KeyError: size = -1
    order.append((name, tgt, size))
    print(f'  • "{html.unescape(name)}"  ({tgt}, {size:,} bytes)')

def first_row(path, limit_bytes=600_000):
    raw = z.open(path).read(limit_bytes).decode('utf-8', 'replace')
    m = re.search(r'<row[^>]*r="1"[^>]*>(.*?)</row>', raw, re.S)
    if not m: return []
    cells = re.findall(r'<c[^>]*?(?:t="(\w+)")?[^>]*>(.*?)</c>', m.group(1), re.S)
    out = []
    for t, body in cells:
        v = re.search(r'<(?:v|t)>(.*?)</(?:v|t)>', body, re.S)
        out.append(html.unescape(v.group(1)) if v else '')
    return out

for name, tgt, _ in order:
    hdrs = first_row(tgt)
    print(f'\n=== {html.unescape(name)} — {len([h for h in hdrs if h])} columns ===')
    for i, h in enumerate(hdrs, 1):
        if h: print(f'  {i:2}. {h}')
