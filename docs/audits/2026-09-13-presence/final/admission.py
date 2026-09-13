"""Read-only PR.F admission check. Exit 1 means the eight-lane entry gate is absent."""
from datetime import datetime, timezone
from hashlib import sha256
import json
import os
from pathlib import Path
import re
import socket
import subprocess

ROOT = Path(__file__).resolve().parents[4]
OUT = Path(__file__).resolve().parent
ledger = ROOT / 'docs/pes-claims.md'
raw = ledger.read_bytes()
lines = raw.decode().splitlines()


def grep(pattern, paths):
    command = ['/usr/bin/grep', '-nE', pattern, *paths]
    result = subprocess.run(command, cwd=ROOT, text=True, capture_output=True)
    assert result.returncode in (0, 1), result.stderr
    return {'command': command, 'exit': result.returncode,
            'matches': result.stdout.splitlines(), 'stderr': result.stderr}


completion = grep(r'^PR-GATE PR\.[1-8] AT-WAVE-4', ['docs/pes-claims.md'])
positive = grep(r'^PR-GATE W0-SEC DONE', ['docs/pes-claims.md'])
assert positive['exit'] == 0 and positive['matches']
lanes = sorted(set(re.search(r'PR-GATE (PR\.[1-8]) AT-WAVE-4', x)[1]
                   for x in completion['matches']))
missing = [f'PR.{i}' for i in range(1, 9) if f'PR.{i}' not in lanes]
gates = [(i, line) for i, line in enumerate(lines, 1) if line.startswith('PR-GATE ')]
runs = [(i, line) for i, line in enumerate(lines, 1) if line.startswith('PR-GATE-RUN ')]
active = {}
overlaps = []
for number, line in runs:
    match = re.match(r'PR-GATE-RUN (\S+) (STARTING|FINISHED)', line)
    if not match:
        continue
    name, state = match.groups()
    if state == 'STARTING':
        if active:
            overlaps.append({'line': number, 'script': name, 'already_open': dict(active)})
        active[name] = number
    else:
        active.pop(name, None)

route = 'apps/api/src/routes/product-studio.routes.ts'
host = 'apps/web/src/app/products/[id]/edit/_studio/StudioTabHost.tsx'
nav = 'apps/web/src/app/products/[id]/edit/_studio/navigation.tsx'
sources = {
    'presence_registration_in_contract_route': grep('/presence', [route]),
    'route_positive_control': grep('fastify.get|studio', [route]),
    'listings_mount_in_contract_files': grep('Listings|listings|Presence', [host, nav]),
    'mount_positive_control': grep('matrix|StudioTabHost', [host, nav]),
    'listings_directory_exists': (ROOT / 'apps/web/src/app/products/[id]/edit/_studio/listings').exists(),
}
assert sources['route_positive_control']['exit'] == 0
assert sources['mount_positive_control']['exit'] == 0
required = ['W2-SCHEMA-APPLIED', 'W2-READ', 'W3-API', 'W3-VOCAB', 'W3-SURFACE']
missing_gates = [name for name in required if not any(
    re.match(r'^PR-GATE ' + re.escape(name) + r'(?: DONE| —)', line)
    for _, line in gates)]
receipt = {
    'time_utc': datetime.now(timezone.utc).isoformat(),
    'host': socket.gethostname(), 'cwd': str(ROOT), 'load': os.getloadavg(),
    'scope': 'Admission inspection only. No DB, HTTP, browser, compilation, test, or pre-push run.',
    'ledger_sha256': sha256(raw).hexdigest(), 'ledger_lines': len(lines),
    'completion': completion, 'positive_control': positive,
    'distinct_completed_lanes': lanes, 'missing_completed_lanes': missing,
    'missing_prerequisite_gates': missing_gates,
    'browser_start_count': sum(' STARTING ' in x for _, x in runs),
    'browser_finish_count': sum(' FINISHED ' in x for _, x in runs),
    'open_browser_holds': active, 'historical_overlapping_starts': overlaps,
    'source_readings': sources,
    'source_sha256': {p: sha256((ROOT / p).read_bytes()).hexdigest() for p in [route, host, nav]},
    'exit': 1 if missing else 0,
}
(OUT / 'admission.json').write_text(json.dumps(receipt, indent=2) + '\n')
text = '# Gate register — admission snapshot\n\n'
text += f"Read at {receipt['time_utc']} on {receipt['host']}; ledger SHA-256 `{receipt['ledger_sha256']}`.\n\n"
text += 'These are **relayed lane receipts**, not PR.F executions of their tests. All canonical PR-GATE and PR-GATE-RUN lines are preserved, including reopened gates. This register does not resolve every ASSUMED/QUESTION/REQUEST line or certify sequencing. Line numbers refer to this captured ledger snapshot.\n\n'
text += '| Snapshot line | Literal gate receipt, including its recorded time |\n| --- | --- |\n'
for number, line in sorted(gates + runs):
    text += f'| {number} | {line.replace(chr(124), "&#124;")} |\n'
text += '\nOpen browser holds at this snapshot: `' + json.dumps(active) + '`.\n'
text += '\nHistorical overlapping STARTING lines: `' + json.dumps(overlaps) + '`. These are historical coordination findings, not evidence that a later rerun failed.\n'
(OUT / 'gate-register.md').write_text(text)
print(json.dumps(receipt, indent=2))
raise SystemExit(receipt['exit'])
