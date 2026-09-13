from pathlib import Path
from datetime import datetime, timezone
import json,hashlib
root=Path.cwd();here=root/'docs/audits/2026-09-12-language-axis/step5'
read=lambda name:json.loads((here/name).read_text())
manifest=read('source-manifest.json');gate=read('readiness-screen.json');screen=read('screen-evidence.json');restore=read('write-restored.json');write=read('write-receipt.json')
assert gate['exitCode']==0 and gate['start']<=screen['at']<=gate['finish']
assert len([r for r in screen['readings'] if 'coordinate' in r])==13
assert all(r['equal'] for r in restore['tables']) and restore['delayedReadMs']>=8000 and write['delayedReadMs']>=8000
assert not write['providerGatewaysBlocked'] and not write['transportAttempts']
assert all(r['unchanged'] for r in read('protected-check.json')['files'])
for name in ['api-tests.json','job-tests.json','web-tests.json']:assert read(name)['success']
for name in ['types.json','tokens-web.json','tokens-factory.json','raw-primitives.json','ds-conformance.json','ag-grid-boundary.json','diff-check.json']:assert read(name)['exitCode']==0
for target in ['local','production']:
 for action in ['execute','resolve']:assert read(f'{target}-{action}.json')['status']==0
assert read('production-schema-read.json')['rows']==0
at=datetime.now(timezone.utc).isoformat()
def ref(path,text):
 lines=(root/path).read_text().splitlines();line=next(i+1 for i,s in enumerate(lines) if text in s)
 return f'`{path}:{line}`'
links={
 'schema':ref('packages/database/prisma/schema.prisma','model ReadinessIndex'),
 'producer':ref('apps/api/src/services/pim/readiness-index.service.ts','export async function produceReadiness'),
 'transaction':ref('apps/api/src/lib/database-context.ts','export async function beforeDatabaseCommit'),
 'reader':ref('apps/api/src/services/pim/scope-readiness.service.ts','export async function getProductReadiness'),
 'job':ref('apps/api/src/jobs/readiness-reconcile.job.ts','export async function runReadinessReconcile'),
 'rule':ref('apps/api/src/services/pim/readiness.service.ts','// LX.5:'),
 'screen':ref('apps/web/src/app/products/[id]/edit/_studio/channel-ops/ReadinessPanel.tsx','export function ReadinessPanel'),
 'chip':ref('apps/web/src/app/products/[id]/edit/_studio/StudioBar.tsx','const others ='),
}
before=read('isolated-before.json');after=read('isolated-after.json')
ms=lambda r:' / '.join(str(m['wallMs']) for m in r['measurements'])
sha=hashlib.sha256((here/'readiness-screen.log').read_bytes()).hexdigest()
text=f'''
## Language axis · Step 5 · §4 record · {at}

**Gate status: STOPPED AT STEP 5 — implementation and required local evidence complete, Owner review pending. Step 6 has not started.** Step 4 is closed in its existing §4 record: the standalone authenticated `node scripts/check-editor-open.mjs --strict` exited 0, with 240 gestures, 9 geometry readings, 235 contract assertions, 20 chrome comparisons, 3 refusal readings, 12 planned saves held before network, and no unexpected API writes. Its exact output and timing remain in [the Step 4 receipt](audits/2026-09-12-language-axis/step4/editor-open-authenticated.json). Contract and gate were updated together for the acknowledgement row and actual editor modes. Credentials were created only for the local dedicated account using the existing password helper, and stayed in memory / gate environment.

**Implemented.** LX.5 table at {links['schema']}; synchronous, deduplicated producer at {links['producer']} and pre-commit boundary at {links['transaction']}. Source and shared-language writes schedule it through the master-content cascade; pin/reset writes schedule it in content-write; bulk fact/content/paste/fill/formula writes share the same transaction. Producer failure rolls back the edit and index together. The existing language rule remains at {links['rule']}. No translation backfill or data-moving script was written or run.

The index stores per-product, per-language readiness and the complete design §3 coordinate, including account and alias. A canonical tuple key preserves NULL Shared/primary coordinates without duplicate NULL keys. This resolves Q-LX5-1 from the already accepted Coordinate contract; no account aggregation was substituted for account selection. Workspace model ownership and scoped relations are registered. The producer uses completed schema caches only; unavailable metadata yields `pct: null`, never an invented zero. The nightly workspace-scoped reconcile at {links['job']} uses 100-root cursor pages and atomic family transactions; it tries the remaining families after a failure and reports the run failed. Schedule: `17 2 * * *` in the runtime timezone. It was tested without scheduling or executing a catalogue-wide job.

The index-only reader at {links['reader']} replaces full-sheet reads per channel. It sums required counts for family scopes and keeps account/alias selection. The chip at {links['chip']} shows the pressed language and other-language states in its tooltip. The matrix and Needs-attention list at {links['screen']} use the same response, Nexus Card/DataGrid/Pill and the existing scope vocabulary. Shared is first and languages retain Marketplace order, including Belgium `['nl','fr']`. NULL renders `—`. Wire producer/types/parser/consumer landed together. Integration map: [boundary-integration.md](audits/2026-09-12-language-axis/step5/boundary-integration.md).

**Migration receipts.** One additive folder, `20260912_lx5_readiness_index`, applied on local `nexus_development` and Railway production `neondb`, each by `prisma db execute --file` followed by `prisma migrate resolve --applied`. All four final commands exit 0; before/after announcements are above. Initial sandbox connection attempts and an incorrect Railway service selection did not execute SQL; the verified service was `@nexus/api`. Read-only, rolled-back verification found **18 columns, 5 indexes, one completed migration receipt, no custom trigger/function and production row count 0**. Receipts: `local-execute.json`, `local-resolve.json`, `production-execute.json`, `production-resolve.json`, `local-schema-read.json`, `production-schema-read.json`. Only the new table/index/relation and access to that table were added; no existing business row changed in production. No `migrate deploy`.

**Local XAVIA positive control and restoration.** Root `cmokmy3a40078pm0p1fvnu523` (GALE-JACKET / XAVIA), fixed child `cmokmy0lr0009pm0p9yxk7ho0`. The initial cache-only family reconcile materialized **714 derived rows** in 4,087 ms; the preceding rehearsal rolled back. German shared title then saved through `writeContent` in **{write['writeMs']} ms**: Product version **1→2**, ProductTranslation version **0→1**, reviewed stamp present, child German required count **0/1→1/1** and percentage **0→100** in the same transaction. Readback waited **{write['delayedReadMs']} ms** after commit. Newly created outbound rows were held until 2099 atomically; the two historical FAILED quantity rows were preserved. All seven snapshots were restored **by value**, including versions, timestamps, legacy JSON and all **714 index rows**, then re-read after **{restore['delayedReadMs']} ms**, every row equal. Audit history retained. No eligible rehearsal queue remains. [Write receipt](audits/2026-09-12-language-axis/step5/write-receipt.json), [restore receipt](audits/2026-09-12-language-axis/step5/write-restored.json). The controlled write/reconcile runs recorded **0 provider gateway attempts / 0 external transport attempts**.

**Timing gate.** Same fixed handler harness, local database, read-only transaction rolled back, external transport blocked, three runs each. Before **{ms(before)} ms**; after **{ms(after)} ms**. Both match Shared German 0% blocked and Amazon DE 37% blocked; the read-only index endpoint performs no full sheet construction. The before harness blocked 3 Shopify gateway entries before credential/rate-limit/network work; the after harness had 0 gateway entries. Both had **0 external transport attempts**. Etsy's German all-scope chip is now absent because GLOBAL carries English; its English index/matrix remains blocked. Raw results: [before](audits/2026-09-12-language-axis/step5/isolated-before.json), [after](audits/2026-09-12-language-axis/step5/isolated-after.json). The preserved before bundle and build input hashes make the replaced handler reviewable.

**Screen gate.** `{gate['command']}` via the dedicated local test-user wrapper, alone at :3000 / API :8091, **{gate['start']} → {gate['finish']}, exit 0**. Exact output [readiness-screen.log](audits/2026-09-12-language-axis/step5/readiness-screen.log), SHA256 `{sha}`. Thirteen readings: Shared DE at 1440/1728 in both themes and 960 light; Shared IT; Amazon DE, BE-nl, BE-fr, UK; eBay IT; Shopify GLOBAL; Etsy GLOBAL. Each reading checks **34 matrix entries / 34 Needs-attention entries** against the **714 database rows**, the pressed-language chip, other-language tooltip and NULL rendering. No page errors. At 1440/1728 the matrix fits; at 960 its focusable scroll area moved **0→40 px** on ArrowRight. The final layout keeps the card inside the viewport. The screenshot review also verified wrapped field labels with verbatim reasons on hover. Authenticated screen navigation admitted only audited database GET routes; notification/sidebar counters and the unrelated `/listings/publish-readiness` read were refused before dispatch. No publish action or content save ran in the screen gate.

Visible evidence from the **new Product Edit Studio**, `/products/:id/edit/studio?tab=errors`, not the legacy editor: [Shared DE, light 1440](audits/2026-09-12-language-axis/step5/screen-master-DE-de-1440-light.png), [Shared DE, dark 1728](audits/2026-09-12-language-axis/step5/screen-master-DE-de-1728-dark.png), [Needs attention, dark 1440](audits/2026-09-12-language-axis/step5/attention-master-DE-de-1440-dark.png). Screen data and source reads are timestamped in [screen-evidence.json](audits/2026-09-12-language-axis/step5/screen-evidence.json). No shared DS file changed in Step 5; Factory mirroring was not needed.

**Tests and guards.** API **30/30** across 6 files, reconcile job **2/2**, web readiness/wire **19/19**: **51 passed**. Coverage includes missing-language requirements, index-only reads, NULL percentages, weighted family counts, ordered Belgium languages, cache-only provider refusal, content/index rollback and reconcile repair without content changes. Scoped types: API **15** and web **7** inputs plus transitive imports, exit 0. Token guards web/Factory, raw primitive ratchet, DS conformance and AG Grid import boundary all exit 0. LX.2 guard: **1488 sources, 13 protected exemptions, 0 violations**. Step 5 scoped `git diff --check` exits 0. Whole-tree diff-check separately reports historical trailing whitespace inside the accepted Step 2 diff artifact; it was not rewritten. All **16 protected hashes** match Step 4 closure, including the peer SDK; its prior diagnostics were not fixed here. Step 3 shadow instruments remain available; no production shadow rerun was required for this index change.

**Exception for Owner review.** The initial authenticated timing baseline at 21:10:42–21:10:47 UTC was taken before transport isolation and reached the existing Shopify schema path. Whether it hit the 30-second cache or made a provider request is **unknown**. Its timings are excluded, original receipts retained, and it is **not evidence of zero provider calls**. The limitation was announced when discovered; replacement before/after measurements and the positive write are isolated as described above. See [baseline-limitation.md](audits/2026-09-12-language-axis/step5/baseline-limitation.md). No publish rehearsal occurred. No push, commit or deployment. No further implementation question is blocking, but this exception remains explicit for the Owner's Step 5 review.

**Source mtime and SHA256.** Read at {at}; hashes compare with full claim-time bytes, including untracked source. [Manifest](audits/2026-09-12-language-axis/step5/source-manifest.json), [exact Step 5 diff](audits/2026-09-12-language-axis/step5/step5-source.diff). **{len(manifest)} changed/new source files**:

| File | mtime (UTC) | SHA256 |
| --- | --- | --- |
'''
text+=''.join(f"| `{r['file']}` | {r['mtime']} | `{r['sha256']}` |\n" for r in manifest)
ledger=root/'docs/pes-claims.md';prior=ledger.read_text();assert '## Language axis · Step 5 · §4 record ·' not in prior
line=prior.count('\n')+2;ledger.write_text(prior+text)
(here/'record-location.json').write_text(json.dumps({'at':at,'file':'docs/pes-claims.md','line':line,'status':'step5-gate-review-pending','sourceFiles':len(manifest)},indent=2)+'\n')
print(json.dumps({'recordLine':line,'files':len(manifest),'status':'stopped at Step 5 gate'}))
