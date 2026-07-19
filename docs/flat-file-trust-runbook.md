# Flat-File Trust (FFT) — runbook

**Program:** `docs/superpowers/plans/2026-07-19-flat-file-trust.md` (root causes, phase log, deferred tail). This runbook is the operational side: the invariant, the proof battery, and what to run when.

## The Zero-Data-Loss Invariant (what the system now guarantees)

1. **Z1** Every edit is drafted locally before any network call; drafts flush on `pagehide` (both grids).
2. **Z2** A draft clears **only after read-back verification**: after a clean eBay save, the exact GET a reload would issue is compared field-by-field against what was saved (aspect keys folded across language/casing; live/system fields excluded). Mismatch ⇒ draft kept + rows named. Network failure ⇒ draft kept, honest toast.
3. **Z3** A save response never claims success for an unwritten row: per-row errors for every skip (deleted-SKU twins named precisely), honest `created` counts, conflict errors carrying `currentVersion` so the next Save wins knowingly.
4. **Z4** Nothing overwrites unsaved local edits silently — draft merges are row-identity-first and field-level.
5. **Z5** Every content writer rewrites what the grids read: grid saves (full-row snapshot), unified grid + import-apply + pull + re-parent + eBay publish write-back (via `services/flat-file/listing-content-write.service.ts` or in-write patches). **Rule for new writers:** any code that mutates ChannelListing content MUST go through the choke point or patch `flatFileSnapshot` in the same write — never leave the snapshot stale.
6. **Z6** Identity transitions re-key drafts (family+SKU field-merge), never drop them.
7. **Z7** Continuous proof: the battery below + live drift surfacing (FFT.4, pending).

## The battery — `apps/api/scripts/_fft-roundtrip-probe.mts`

Exercises the REAL route handlers (Fastify inject) against the prod DB on a throwaway `FFT-SCRATCH-*` family. Zero platform writes (dead eBay base, no real-API env, Amazon save path is DB-only). Creates + cleans its scratch family; `--keep` leaves it for browser E2E.

```bash
cd apps/api && npx tsx scripts/_fft-roundtrip-probe.mts        # full run + cleanup
cd apps/api && npx tsx scripts/_fft-roundtrip-probe.mts --keep # leave scratch family
```

**Expected: 18/18 GREEN.** Checks: 5× body-limit (save/submit/push/publish accept >1 MB), Amazon create/update accounting + field round-trip + CAS contract (returned version re-save; stale version ⇒ per-row error WITH `currentVersion`), eBay save/round-trip/per-market isolation, deleted-SKU re-import NAMED (the proven silent-loss), unified-grid edits visible in BOTH grids, import-apply visible in the Amazon grid.

**Run it:** before/after touching any flat-file save/read path (`amazon-flat-file.routes.ts`, `ebay-flat-file.routes.ts`, `flat-file.service.ts` rows/save, `ebay-flat-file-create.service.ts`, `listing-content-write.service.ts`, `import/apply.ts`, snapshot overlays). Any RED = stop and fix; the check names the violated invariant.

Gotchas: run from `apps/api` (module resolution); it force-exits (BullMQ handles); Amazon create rows need `_isNew: true`; the 413-payload rows are deliberately SKU-less (post-fix they reach real handlers).

## Prod probes (no auth needed)

Body-limit regression — the size gate fires before auth, so anonymously:
```bash
# expect HTTP 401 (auth) — a 413 means the body-limit fix regressed
node -e 'const rows=[];for(let i=0;i<600;i++){rows.push({item_name:"x".repeat(1800),title:"x".repeat(1800)})};process.stdout.write(JSON.stringify({rows,marketplace:"IT"}))' > /tmp/big.json
curl -s -o /dev/null -w "%{http_code}\n" -X POST -H "Content-Type: application/json" --data-binary @/tmp/big.json https://nexusapi-production-b7bb.up.railway.app/api/amazon/flat-file/sync-rows
```

## Browser E2E (the operator-truth check)

`--keep` the scratch family, then on prod web: eBay `/products/ebay-flat-file?familyId=<scratch-parent-id>&marketplace=IT` → edit title → Save → draft key `ff-ebay-draft-IT-family-<id>` must be GONE from localStorage (verified clear) → hard reload → value identical. Amazon `/products/amazon-flat-file?marketplace=IT&productType=OUTERWEAR` → All-products scope → search FFT-SCRATCH → edit Item Name → Save ("Saved N rows") → reload → identical + `Submit to Amazon (N)` still armed. Never reload mid-edit in automation (native confirm freezes it). Passed 2026-07-20.

## Owner E2E script (the real-file pass)

1. Import a filled single-family .xlsm (e.g. AIREON IT) → banner: template + **"This file is now the Export for Amazon base for {family} on IT"**.
2. Map (template-tier ~100%) → **Review families**: counts + badges sane; try skipping a family → Preview excludes it.
3. Preview: click "N values flagged" → exact cells listed; check FBA-qty-ignored / duplicates chips when applicable.
4. Apply → green report banner (cells/new/updated/file) persists across reload; version history shows "Import: {file}".
5. Edit a few cells → Save → hard reload → identical.
6. File → Export for Amazon → toast says **"based on your own {family} file"**; re-import the export → no-ops.
7. Amazon flat-file → Pull from Amazon (preview→apply) → grid SHOWS the pulled values (pre-FFT.3a they were masked).

## Read-model (/products) health

Refresh enqueues are hang-proof (`addJobSafely`); skips defer to the 15-min reconcile, which now diffs the full cheap projection (sku/name/status/stock/price/parent/type/fulfillment). Manual recovery stays `POST /api/admin/backfill-read-cache`.

## Deferred tail (tracked in the plan doc)

FFT.4 (feed-reject re-arm on rows, verify-against-live content compare, pending-sync chips over the RT instant lane) — the one open phase. FFT.3b writer sweep: eBay/Amazon cockpits, `/products` bulk PATCH channel fields, marketplaces/syndication/PIM/bulk-action/wizard/catalog — choke point is the mandated pattern when touched. AMX.3/.5 (owner D5), flagged-cell tinting, filter-to-changed, policy-group generalization.
