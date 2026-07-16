# XLSM Hybrid — Verification Runbook

**Scope:** the Amazon official-template hybrid workflow (plan: `docs/superpowers/plans/2026-07-16-xlsm-amazon-template-hybrid.md`) — list initially with Amazon's own downloaded Custom Listings Template (.xlsm), import into Nexus, manage everything from the platform, export back to a Seller-Central-ready .xlsm on demand.

**Status 2026-07-16:** A1–A8 shipped. This runbook is the regression battery + the owner's E2E script.

---

## 1. What shipped (commit map)

| Phase | What | Commits |
|---|---|---|
| A1+A2 | .xlsm/.xlsb accepted everywhere; 32 MB route bodyLimit; ~30 ms template reader (jszip linear walks — exceljs never finished these workbooks) | `0403b704` |
| A2b | Multi-sheet + header-row operator override on every Excel parse (`workbook` block in /parse response) | `8a2d98ae` `fd702890` |
| A3/A3w | Tier-0 template-path mapping (canonicalized attribute paths, confidence 1.0); wizard template banner, market auto-switch, qty OFF / price ON policies, typed-DELETE override, per-template presets | `42551c44` `8a2d98ae` |
| A3.1a | eBay /parse rejects Amazon templates with a redirect hint | `222f7efe` |
| A4C | Exhaustive-by-construction column expansion: schema walker + `__coverage` sentinel (`uncovered: []`), deep-field submit reassembly | `697f4f4b` `678adf90` `817db169` |
| A5 | Full theme-axis extraction on create (TEAM_NAME/ATHLETE/SIZE/COLOR intact; legacy SIZE_COLOR still splits); `apparel_size__size`/`bottoms_size__size` → Size; ProductReadCache refresh on FFC create | `9e4d110f` |
| A6 | Multi-market loop = A3w market-switch + per-`templateIdentifier` presets (fold-in; no separate commit) | — |
| A7 | Template vault (auto-capture on import) + **Export for Amazon (.xlsm)** — surgical zip rewrite of ONLY the Template sheet's data rows | `0e404ed4` |
| B1 | Amazon `#`-column extras behind View menu (compact rows by default) | `8c10c1f8` |

## 2. Invariants (never weaken)

- **Quantity import default OFF** — pool + Follow columns stay the source of truth (owner decision). Price import default ON.
- **Delete-action rows always excluded by default**; importing them requires the typed-DELETE override panel (owner has full control).
- **FBA quantity is never written on import and never exported** (`FBA_VALUE_HINT` belt in the wizard; `FULFILLMENT_QTY_HEADER_RE` belt in `buildTemplateDataRows`). Follow Master invariant.
- **Export `::record_action` is always blank** (= Amazon's "create or replace" default in every locale). Delete/partial are localized dropdown tokens the operator picks in Excel deliberately.
- **Originals on the Desktop are never modified** — imports read bytes; the vault stores a copy; exports are new files.
- Amazon SKUs are **case-sensitive** → import matching is exact by design. A case near-miss shows up loudly as "N new rows will be created" in the plan step — review that count before applying.

## 3. Regression battery (run before touching this area)

```bash
# Unit battery — template reader, mapping tiers, schema walker, FFC axes, vault rails
cd apps/api && npx vitest run $(find src -name '*.vitest.test.ts' | grep -E 'flat-file|amazon-flat|parsers|template' | tr '\n' ' ')
# expected: 44 files / 680 tests green (as of 0e404ed4)

# Real-file identity round-trip (owner's 5 Desktop templates, read-only):
# detect → rewrite(all parsed rows) → re-detect → cell-for-cell identical
npx tsx scripts/_xlsm-roundtrip-smoke.mts
# expected: 5/5 "round-trip identical" — AIREON IT/DE/ES/FR (41×344/352) + X-RACING IT (50×252)

# Real-file parse smoke (detection, settings, actions histogram)
npx tsx scripts/_xlsm-template-smoke.mts

# Map-rate vs live manifests (needs prod DATABASE_URL)
npx tsx scripts/_xlsm-map-smoke.mts
# expected: 100% deterministic map-rate (e.g. AIREON IT 251/251), 0 unmapped headers

# API + web typecheck
cd apps/api && npx tsc --noEmit && cd ../web && npx tsc --noEmit
```

Coverage sentinel (any manifest, any market): `manifest.__coverage.uncovered` must be `[]`. A non-empty list means the schema walker missed leaves — the "SCHEMA COVERAGE GAP" server warn fires and the missing-column bug class is back; fix the walker, never hand-patch columns.

## 4. Owner E2E script (prod)

Import (per market file):
1. `/products/amazon-flat-file` → File → **Smart import** → drag the market's .xlsm (e.g. `AIREON IT.xlsm`).
2. Expect the **Amazon template banner** (template id, market, product types, action histogram) and, when the file's market ≠ current page, the one-click market switch.
3. Mapping step: expect ~100% auto-mapped via `template-path`; qty toggle OFF, price ON, delete rows excluded (override panel available).
4. Plan step: sanity-check update-vs-create counts (existing family = all updates, 0 new). Apply.
5. After save: products visible in `/products` immediately (A5 read-cache); ASIN/status link via the 15-min reconcile cron, or immediately via the grid's pull-from-Amazon.

Export:
6. File → **Export for Amazon (.xlsm) — <original filename>** (enabled once any template import seeded the vault for that market; ticked rows = partial export).
7. Open the download in Excel: Template sheet has your grid rows from the data row down; **Valori validi dropdowns, labels, settings row and every other sheet intact**; no repair prompt.
8. Re-import the exported file into the wizard → plan shows **no-ops** (round-trip = zero diff).
9. Spot-check rails inside the file: `::record_action` blank everywhere; FBA rows have empty quantity.
10. (When actually listing) upload the exported file in Seller Central → Add Products via Upload — same grammar Amazon produced, so it validates like a hand-edited original.

Multi-market loop: repeat 1–5 for IT → DE → ES → FR files back-to-back; each market's content lands on that market's listing (per-market columns), shared attributes fill-missing.

## 5. Architecture pointers

- Reader/rewriter: `apps/api/src/services/amazon/template-workbook.ts` (`detectAmazonTemplate`, `parseOoxmlSheet`, `rewriteTemplateDataRows`).
- Vault + export assembly: `apps/api/src/services/amazon/template-vault.service.ts` (capture is fire-and-forget from /parse; `buildTemplateDataRows` carries the rails).
- Mapping: `apps/api/src/services/amazon/flat-file-mapping.ts` (`canonicalizeTemplatePath` — same canon on import headers and manifest fieldRefs; export reuses the identical mapper, so directions can't drift).
- Exhaustive columns: `apps/api/src/services/amazon/flat-file-schema-walk.ts` + `__coverage` in the manifest.
- Endpoints: `POST /api/amazon/flat-file/parse` (template detect + capture), `GET …/template-vault`, `POST …/export-template`, plus the FX suite (suggest-mapping/coerce/plan-import/validate-rows/submit).

## 6. Gotchas (hard-won)

- Fastify default bodyLimit is 1 MB — the FX endpoints carry a 32 MB route-level override; a new sibling endpoint must set it too or real uploads 400.
- exceljs stalls for minutes on these workbooks (1 MB+ defined-names). Never route template files through it; the jszip walker is the only safe path.
- DE/ES/FR templates use **absolute** `/xl/…` rel targets; IT relative — `sheetList` normalizes both.
- The "Definizioni dati" dictionary sheet contains attribute paths but never a dense row — detection requires ≥20 attr-like cells in one row + settings-marker priority.
- Rewrite drops `<dimension>` + `calcChain.xml` (stale after row surgery; Excel recomputes — leaving them triggers repair prompts).
- Vault rows keep Amazon's localized action tokens verbatim on identity rewrites; the export path (vault service) is what blanks `::record_action`.
