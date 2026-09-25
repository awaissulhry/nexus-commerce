# Every eBay-shaped file through the product-sheet drawer path (inspect → preview), staged on the private copy.
import json, subprocess, sys
SP = '/private/tmp/claude-501/-Users-awais-nexus-commerce/860563e3-4083-4cae-95e2-45981fb48a2e/scratchpad'
cases = json.load(open(f'{SP}/runs/ebay-cases.json'))
for i, c in enumerate(cases, 1):
    root = c['root'] or '3K-HP05-BH9I'  # Misano: Nexus holds the family under Amazon's generated parent
    args = {'id': f'ebay-{i:02d}', 'path': 'drawer', 'file': f"/Users/awais/Desktop/2026/LISTNGS/{c['path']}", 'market': 'IT', 'productSku': root, 'stage': True}
    with open(f'{SP}/runs/out/ebay-index.tsv', 'a') as f: f.write(f"{args['id']}\t{c['path']}\t{root}\n")
    r = subprocess.run(['node', f'{SP}/runs/run.mjs', json.dumps(args)], capture_output=True, text=True, timeout=1500)
    print([l for l in r.stdout.splitlines() if l.startswith('{"id"')] or r.stderr[-800:], flush=True)
