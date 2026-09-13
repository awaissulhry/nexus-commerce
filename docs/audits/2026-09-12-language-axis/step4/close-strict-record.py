from pathlib import Path
from datetime import datetime, timezone
import hashlib, json, re, subprocess

root = Path.cwd()
here = root / 'docs/audits/2026-09-12-language-axis/step4'
receipt = json.loads((here / 'editor-open-authenticated.json').read_text())
assert receipt['exitCode'] == 0 and not receipt.get('diagnostic'), 'Only a complete strict green can close Step 4'
output = (here / receipt['log']).read_text()
summary = next(line for line in output.splitlines() if line.startswith('✅ OPEN-GESTURE GATE PASSED'))
assert '240 open gestures' in summary and '9 geometry readings' in summary and '3 refused-cell readings' in summary
assert '0 API writes armed, 12 expected saves held open' in summary
subprocess.run(['python3', str(here / 'manifest.py')], check=True)
manifest = json.loads((here / 'source-manifest.json').read_text())
assert all(row['unchanged'] for row in json.loads((here / 'protected-check.json').read_text())['files']), 'Reclassify any peer change before claiming all protected hashes match'
at = datetime.now(timezone.utc).isoformat()
ledger = root / 'docs/pes-claims.md'
text = ledger.read_text()
start = text.index('## Language axis · Step 4 · §4 record ·')
end = text.index('\nLX Step 4 additional claims', start)
record = text[start:end]
record = re.sub(r'^\*\*Gate status:.*$', '**Gate status: CLOSED. The Owner-accepted six local fixture paths and the complete strict editor gate are verified. Step 5 may proceed.**', record, flags=re.M)
strict = f'''**Strict editor gate — Q-LX4-1 completed.** Dedicated test user exists only in `127.0.0.1:55439/nexus_development`, with the invitation-equivalent workspace membership and existing OPS_MANAGER role on both authorization paths. The existing `hashPassword` helper used by change-password supplied Argon2id hashing. Credential values stayed in memory and the child gate environment; no credential values or browser storage-state file were recorded. Account receipt: `gate-account-receipt.json` (IDs only). The authenticated browser helper now uses the real browser CSRF/login flow, the server's `x-nexus-csrf` header, and waits for initial auth hydration before login.

The complete `node scripts/check-editor-open.mjs --strict` ran alone on `http://localhost:3000`, local API `:8091`, **{receipt['start']} → {receipt['finish']}, exit 0**. Ledger gate-start/gate-finish announcements bracket the source hold. Output: [editor-open-authenticated.log](audits/2026-09-12-language-axis/step4/editor-open-authenticated.log); command/timing/SHA256: [receipt](audits/2026-09-12-language-axis/step4/editor-open-authenticated.json), log SHA256 `{receipt['sha256']}`.

> {summary}

**Contract and gate changed together.** The held-save arm verifies both acknowledgement destinations and Cancel above the grid before choosing the shared destination. The September 6–7 formula-aware value editors are distinguished from expression mode; named fixtures, virtualization and the shared footer-note selector match the current documented studio. Every gesture/hit point remains required. The original first/early/settled timing expectations remain in force. Q-LX4-2's proposed loading-state reclassification was **not applied** and is unnecessary for this closing run. Failed and focused receipts remain separate; neither substituted for the complete green. The final fixture-token lookup requires its actual ledger heading.

**Additional repairs and validation.** Account-specific Amazon schema loading now uses the existing database cache before seller fallback, pulling forward the already specified Step 7 cache correction needed to keep this gate provider-free. Two cache tests verify the database timestamp survives repeated account loads and mock the fallback. Channel refusal warnings retain the exact server sentence, including a native title in hosts that disable custom tooltip portals; the formula-aware long-text textarea retains the no-resize-handle rule. Shared DS changes are mirrored in Factory and documented in catalog/changelog/DS-GAPS. A diagnostic targeting change briefly removed Playwright's stable-element wait; its failed receipt is retained and the wait was restored, with exact center/corner validation afterward. Focused verification then passed 80/80 first-load gestures and all three refusal scopes before the complete green.

Focused tests: web 3 files / **81 passed**; API cache plus language guard 2 files / **4 passed**. Latest scoped types: API **28**, web **14**, Factory **1** input files plus transitive imports, exit 0. Web and Factory token guards, raw-primitive ratchet, DS conformance and AG Grid import boundary all exit 0. The language guard scans **1484** sources, retains **13** protected exemptions and reports **0** violations. All **16** protected hashes still match, including the peer SDK file; no SDK diagnostic was fixed by this lane. Current source manifest has **{len(manifest)}** changed source files; `git diff --check` exits 0. No production business write, provider call, push or deployment occurred in this continuation.

**Step 5 question.** Q-LX5-1 is recorded below: the existing readiness endpoint distinguishes account and listing alias while LX.5's sample key omits them. Recommendation is to preserve those dimensions in the index. No readiness migration has been applied at this Step 4 close.
'''
record = re.sub(r'^\*\*Q-LX4-1 — open, required gate input\.\*\*.*$', lambda _: strict, record, flags=re.M)
table_start = record.index('| File | mtime (UTC) | SHA256 |')
table = '| File | mtime (UTC) | SHA256 |\n| --- | --- | --- |\n'
table += ''.join(f"| `{row['file']}` | {row['mtime']} | `{row['sha256']}` |\n" for row in manifest)
record = record[:table_start] + table
ledger.write_text(text[:start] + record + text[end:])
boundary = here / 'boundary-integration.md'
b = boundary.read_text()
b = re.sub(r'^- The full standalone .*$', f'- The complete standalone `check-editor-open.mjs --strict` passed on :3000 at {receipt["finish"]}, exit 0, with a dedicated local test login. Credentials stayed in the gate process environment; no storage-state export or auth bypass. All attempted content writes were held/aborted before the database. See `editor-open-authenticated.json` and its log.', b, flags=re.M)
boundary.write_text(b)
location = {'file': 'docs/pes-claims.md', 'line': ledger.read_text()[:start].count('\n') + 1, 'at': at, 'status': 'step4-closed-strict-green', 'receipt': receipt}
(here / 'record-location.json').write_text(json.dumps(location, indent=2) + '\n')
print(json.dumps({'at': at, 'line': location['line'], 'files': len(manifest), 'gateExit': 0}))
