# Session prompt — import the NATIVE Amazon and eBay Excel files "as is" (2026-09-24)

Written by the R-11 product-sheet lane at the Owner's request. Facts below were MEASURED on 2026-09-24 (read only) unless marked.

## 1. The goal (the Owner's words, summarised)

The Owner lists his products on Amazon with **Amazon's own Excel category templates**, and on eBay with **our own eBay Excel
workbook**. He wants Nexus to **import these files as they are — no re-formatting by hand — through the import system AND the product
sheet**, so that Nexus holds exactly what the channels hold, and he can keep Nexus the same as Amazon and eBay.
🔴 **The goal is GENERAL support, not one product:** *"The goal is not only for the jacket. The goal is that it supports these files so that
I can import all of the other products as well."* Every family, every product type, every market, every template version he uses (the
test corpus in §2b). GALE is only the first sample. The import must be driven by the file's own keys and the category schema, never by
per-family code.
"AAA quality": zero data loss, an honest preview before any write, every value traceable, the design system and 7:1 contrast.

Scope: **IMPORT first** (file → Nexus). Exporting back in the same native shape is a later step; it partly exists already (see §4).
Importing writes to the Nexus database only. **It never publishes to a channel.**

## 2. The first sample — GALE (measured, read only — never edit the Owner's files; copy them into your scratchpad to work)

| File | Shape |
|---|---|
| `/Users/awais/Desktop/2026/LISTNGS/JACKETS/Gale/Amazon/LISTINGS/IT/GALE IT - FINAL (upload this)/GALE IT.xlsm` (also a `GALE IT.xlsx` copy, 16 Sep) | Amazon's NEW Custom Listings Template. 10 sheets: `Modifiche al modello`, `Istruzioni`, `Immagini`, `Definizioni dati`, **`Modello`** (data, A1:MG27), `Esplora dati`, `Conditions List`, `Valori validi`, `Dropdown Lists`, `AttributePTDMAP`. |
| `…/Amazon/LISTINGS/DE/GALE DE - FINAL (upload this)/GALE DE.xlsm` | Same layout; data sheet **`Vorlage`**; 352 row-5 keys; `de_DE`; marketplace `A1PA6795UKMFR9`; 21 data rows |
| `…/Amazon/LISTINGS/FR/GALE FR - FINAL (upload this)/GALE FR.xlsm` | data sheet **`Modèle`**; 344 keys; `fr_FR`; `A13V1IB3VIYZZH`; 21 rows |
| `…/Amazon/LISTINGS/ES/GALE ES - FINAL (upload this)/GALE ES.xlsm` | data sheet **`Plantilla`**; 344 keys; `es_ES`; `A1RKKUPIHCS9HS`; 21 rows |
| `/Users/awais/Desktop/2026/LISTNGS/JACKETS/Gale/eBay/IT/GALE IT.xlsx` | OUR eBay workbook: ONE sheet **`ebay_it`**, A1:CA106 — row 1 headers (`SKU`, `Action`, `Parent/Child`, `Parent SKU`, `EAN`, `MPN`, `Title`, `Condition`, `Category ID`, `Variation Theme`, …), rows 2–106 = 105 rows (5 eBay listings × 21 products; category 177104; theme `Colore,Taglia`) |

**Amazon template layout (IT `Modello`):** row 1 = settings (`settings=feedType=256&timestamp…`, base64 blocks — keep them for export);
row 2 = instruction; row 3 = group headers (`Identità dell'offerta`, `Variazioni`, `Identità prodotto`, …); row 4 = localized labels
(`SKU`, `Tipo di prodotto`, `Azione sull'offerta`, `Livello di parentela`, …); **row 5 = the machine keys** (`contribution_sku#1.value`,
`product_type#1.value`, `::record_action`, `parentage_level[marketplace_id=…]#1.value`, `child_parent_sku_relationship…`,
`variation_theme#1.name`, `item_name[marketplace_id=APJ6JRA9NG5V4][language_tag=it_IT]#1.value`, `brand[…]`, …); row 6 = blank;
**rows 7–27 = data** (GALE-JACKET parent, product type `COAT`, action "Crea o sostituisci", + 20 children). Match columns by the
ROW-5 KEY, never by position or by the localized label. 🔴 `exceljs` HANGS on these .xlsm files (measured: >7 min, killed) — the repo
reads them with its own jszip/XML reader (`services/amazon/template-workbook.ts`). Parse on the worker thread (see §5, 09-16).

## 2b. The whole test corpus — `/Users/awais/Desktop/2026/LISTNGS/` (89 spreadsheets; a quick read-only classification, 2026-09-24)

Families: JACKETS (AIR MESH, AIREON, Gale, Misano, Moss, REGAL, VENTRA, WATERPROOF), SUITS (XAVIA X AAA), ACCESSORIES (SLIDERS); the
folders GLOVES, PANTS, PROTECTOR, MX hold no spreadsheets. Formats found (the quick classifier read shared strings only — ~33 files it
called "other" are most likely the same new template with inline strings; measure them properly):

| Format | Found | What to know |
|---|---|---|
| **Amazon NEW Custom Listings Template** (A1 `settings=feedType=…`; keys in **row 5**; data from row 7) | ≥ 30 | Data sheet named per language (`Modello`/`Vorlage`/`Modèle`/`Plantilla`/`Template`); 274–352 keys; **`::record_action` varies per file: full "Crea o sostituisci" (create/replace), PARTIAL update "Modifica (aggiornamento parziale)" / "Bearbeiten (Teilaktualisierung)" / "Modifier (mise à jour partielle)" / "Editar (actualización parcial)" — a blank cell there means NO CHANGE, never "clear" — and DELETE "Löschen" (`Gale/Amazon/DE/GALE DE NEW TEMPLATE.xlsm`)**; several product types in one file (AIREON IT: COAT + PANTS); one file carries TWO languages (`en_GB` + `it_IT`); blank templates exist (`_BLANK TEMPLATES (per language)`) |
| **Amazon OLD flat file** (A1 `TemplateType=fptcustom…`; keys in **row 3**) | 12 | the classic 2019-era format (e.g. `Gale Jacket IT.xlsm`, `AIREON GLOBAL.xlsm`, `Misano/AMAZON/LISTING/IT.xlsx`); 175–366 keys |
| **Our eBay workbook** (one sheet `ebay_<market>`, 79 columns, header row 1) | 10 | 8 jacket families + 2 slider files; one row per product per listing (GALE IT: 5 listings × 21 = 105 rows) |
| **Per-family eBay workbooks at the root** (`XAVIA-eBay-IT-<FAMILY>.xlsx`, one sheet named by the family) | 6 | shape NOT measured — find out what they are |
| `Gale/Amazon/IT/amazon_OUTERWEAR_IT(.filled).xlsx` | 2 | shape NOT measured |

Also: skip Excel lock files (`~$…xlsm`); folders named `OLD - previous versions & backup` are history, and the `… - FINAL (upload this)`
folders hold the latest file per market — the IMPORTER must never guess which file is current: the Owner picks the file, the preview
shows what it would change. A file may be OLDER than what is live on the channel (later Seller Central / eBay edits): Nexus already reads
what the channel holds (`ChannelDrift`, the nightly content read A-39/A-40) — use it to show "file vs Nexus vs channel" and to prove
after an import that Nexus now matches the channel.

## 3. How to work (this programme's rules — they bind)

1. Claim a row in `docs/pes-claims.md` (top of the file) BEFORE editing; name every file before its first edit. Other sessions share this
   working tree: `git commit --only <your files>`, never `git add -A`, never `git stash`, never `--amend`, never `--no-verify`.
   Before any edit and before any push: `ps -axo pid=,command= | /usr/bin/grep -E "^ *[0-9]+ (/[^ ]*/)?git push|^ *[0-9]+ /bin/bash \.githooks/pre-push"`
   (NOT `pgrep -af` — it matches its own shell). Do not edit files while any push runs (its browser gates measure the working tree).
2. Your own folder: **`docs/channel-file-import/`** (PLAN.md, PROGRESS.md, records/). `docs/product-cheat/**` belongs to the R-11 lane.
3. **Measure before claiming; write predictions before every run; label claims read / inferred.** A plan amendment is approved by the
   Owner BEFORE building ("FOR YOUR RULING", at most two questions, each with a recommendation). Prove every test with mutations
   (Python harness, per-file backups, sha256 restore, a green no-mutation control first, anchors asserted once). All four closure
   fields per step: *Done when* · *Cost when* · *Gate* · *Rollback*. One commit per step group.
4. API tests run from `apps/api` only (the repo-root `.env` is PRODUCTION). Real-database arms use `formulaDatabase()` unless they test a
   race. A schema change also needs `packages/database/scripts/generate-baseline.mjs`. Typecheck with a FRESH private build-info file
   (a reused one gave a false TS2339 twice on 09-24).
5. R-40: run read-only production tools yourself. **Every production data write (an import into production Nexus IS one) needs the
   Owner's word in the chat, per run:** read → preview → write → read back → a restore path → delayed re-read.
   Heavy transactional work does NOT run from the dev box against production (09-24: every family's transaction timed out) — use a
   server-side path (e.g. the Sync Logs job registry) or a worker.
6. Work in parallel sub-agent lanes with DISJOINT files (R-44); you verify and commit. Only the main session edits the shared design-system
   files (CHANGELOG web + factory, `.claude/DS-GAPS.md`, catalog, barrels). UI: `apps/web/src/design-system` first (read `DESIGN.md`);
   mirror DS changes into `apps/factory`; 7:1 contrast (the hook holds 0/0); keyboard; light/dark; 100 % honest UI.
7. Standing rules: **Amazon EU merchant quantity is ONE number for all EU markets — never import one market's quantity as if it were
   per-market; never touch FBA quantity.** The Owner LIFTED the flat-file no-touch rule on 2026-09-24 ("we have already built our flat
   file completely"); the legacy import-wizard (`/bulk-operations/imports`, `ImportJob`) is validated and in use — name any change to it
   in the plan before building. The pre-push hook takes ~30–40 min on a UI push; a known flake (AE.4 `sync.vitest.test.ts:419`,
   `claimed: 0`) may refuse a push once — retry once, never bypass.
8. Report to the Owner in plain, short English: what you did, did it work, what he does now.

## 4. What already exists — read these, do not redo the research

★ = read first. Found by a scan of 1,118 markdown files on 2026-09-24.

**Import/export engine and the product-sheet drawer (September, the engine the studio uses):**
- ★ `docs/2026-09-05-catalog-transfer.md` — the catalog import/export engine and `/products/catalog-transfer` (template, preview, apply).
- ★ `docs/2026-09-08-product-import-export-approach.md` + ★ `docs/2026-09-08-product-import-export-implementation.md` — import/export
  in the product editor via `ProductTransferDrawer` (scopes, aliases, value ownership; zero-loss LibreOffice round trip of 335 values).
- ★ `docs/audits/2026-09-14-gale-import/README.md` — **the GALE Amazon IT `Modello` sheet was already imported into the studio**
  (ASIN preservation, keyword scalar↔array, round-trip comparison). Start from what it proved and what it left out.
- ★ `docs/2026-09-15-ebay-workbook-import.md` — the studio adapter for our historical `ebay_it/de/fr/es/uk` single-sheet XLSX (matched by
  Item ID, parent/variant SKU, marketplace) — the shape of `GALE IT.xlsx`.
- ★ `docs/2026-09-16-studio-import-wedged-production.md` — an XLSX upload hit the V8 heap ceiling and took production down; the parse
  now runs on a worker (`workbook-parse.worker.ts`). Every new parser must obey it.
- `docs/audits/2026-09-07-attribute-mapping/{README,PRODUCT-EDITOR-TRANSFER,MULTICHANNEL-WORKBOOKS}.md`,
  `docs/audits/2026-09-08-workbook-functionality/README.md` (choice rules, 16,379-choice limit), `docs/audits/2026-09-08-workbook-format/README.md`,
  `docs/audits/2026-09-11-product-export/README.md` (`value:sku` header escaping), `docs/2026-09-15-catalog-csv-record-limit.md`,
  `docs/2026-09-16-catalog-csv-separator.md`, ★ `docs/workbook-v4/README.md` (v4 layout design, gated on the Owner's §9, no code).

**Amazon templates and the flat-file editor (July):**
- ★ `docs/superpowers/plans/2026-07-16-xlsm-amazon-template-hybrid.md` + `docs/xlsm-hybrid-runbook.md` — import Amazon's official .xlsm,
  manage it in Nexus, export a Seller-Central-ready .xlsm; the template vault ("ALL PHASES SHIPPED").
- `docs/flat-file/v2/` (FF0 current state / decisions / field census / findings / market discovery / workbook spec; FF1-SPEC export;
  FF2-SPEC + FF2-PLAN import: parse, diff, gated apply) — the July whole-catalog engine (`services/flat-file/**`).
- `docs/superpowers/plans/2026-07-17-amazon-import-excellence.md` (AMX; banner says PROPOSAL, git shows AMX.1/.2/.4 shipped),
  `2026-07-19-flat-file-trust.md` + `docs/flat-file-trust-runbook.md` (zero data loss), `2026-07-10-unified-flat-file-excellence.md`,
  the browse-node and custom-group plans/specs (06-30, 07-01), `docs/superpowers/specs/2026-07-06-channel-market-scoped-flat-files-design.md`.
- `docs/market-features/15-amazon-category-schema.md`, `21-amazon-apply-to-siblings-vault.md`, `24-amazon-pull-from-channel.md`.

**eBay files:**
- `docs/superpowers/plans/2026-07-17-ebay-import-excellence.md` + `docs/ebay-import-runbook.md` (EI.1–EI.6 shipped; File Exchange /
  Seller Hub reports listed as a stretch), `docs/ebay-integration-map.md`, `docs/ebay-flat-file-fields.md`,
  `docs/superpowers/plans/2026-07-02-ebay-shared-sku-flatfile-management.md` (current; the "unblock-persist" plan is SUPERSEDED),
  `2026-07-06-ebay-per-market-flat-file.md`, `docs/superpowers/specs/2026-07-04-ebay-explicit-parentage-columns-design.md`,
  `docs/market-features/04-ebay-aspects.md`, `10-ebay-pull-live-preview.md`.

**Product sheet plans (import/export parts):**
- `docs/product-cheat/PLAN.md` (the active product-sheet plan; all 26 steps built; A-50 language fallback, A-52 bullets, A-56 eBay builder),
  `docs/product-cheat/PROGRESS.md` (handoff 8).
- `docs/product-sheet/PLAN.md` (untracked; SUPERSEDED IN PART 09-22 but the most compact import/export decisions: "Import/export — wave4 §2"
  ~L681, "TR — import/export" TR-1…TR-17 ~L1469, "Workbook / export" WB-1…WB-6 ~L1606), `docs/product-sheet/RESEARCH.md` §07/§08,
  `docs/product-sheet/IMPLEMENTATION.md` §07.
- `docs/2026-09-02-wave4-design.md` §2 (D15, the unshipped IO.1 `ImportDrawer`), `docs/pes5-phase0-backend.md` §15.22–15.28,
  `docs/2026-09-02-industry-research.md`, `docs/pes-parity-audit.md` (row 8.13 eBay File Exchange CSV export MISSING),
  `docs/2026-09-04-sheet-views-and-full-attributes-design.md`, `docs/audits/2026-09-13-single-sheet/README.md`.

**Attribute mapping:** `docs/audits/2026-09-07-attribute-mapping/README.md` (+ LIVE-VALIDATION, LISTING-READINESS, WORKFLOW-QUALITY),
`docs/2026-09-04-channel-attribute-model-design.md`, `docs/2026-09-05-product-attribute-foundation.md`, `docs/2026-09-01-pes6-global-mapping-engine.md`,
`docs/2026-09-02-writability-matrix.md`. Do NOT mix up the Amazon **Ads** bulksheet docs (`docs/AMAZON-BULKSHEET-SCHEMA.md`, `docs/AX-IE-0-1-PLAN.md`).

**Traps already found (believe the code, not the banner):**
- `docs/product-cheat/RESEARCH.md` says "Import is not on the sheet" — FALSE today: `ProductTransferDrawer` import is wired into both sheet
  adapters. What never shipped is the separate IO.1 `ImportDrawer` (fixture transport, not mounted).
- TWO workbook engines exist: FF v2 (`services/flat-file/**`, July, whole catalog, `field@MARKET`) and catalog-transfer
  (`services/pim/catalog-*`, September, used by the studio). Pick one on purpose and say why.
- Several July plans still read "PROPOSAL / awaiting approval" although git shows them shipped (FF1-SPEC, AMX).

## 5. Code entry points (paths)

- Routes: `apps/api/src/routes/catalog-transfer.routes.ts` (`/catalog-transfer/*`: product export/inspect/preview, jobs apply/outcomes/retry),
  `amazon-flat-file.routes.ts` (`/amazon/flat-file/*`: template, parse, plan-import, export, template-vault, submit, pull-preview),
  `ebay-flat-file.routes.ts`, `flat-file-import.routes.ts` (FF2), `flat-file-unified.routes.ts`, `import-wizard.routes.ts` (legacy),
  `ebay-cockpit.routes.ts` (File Exchange CSV).
- Services `apps/api/src/services/pim/`: `catalog-product-transfer.ts` (the drawer's server boundary), `catalog-transfer{,.service,-plan,-jobs,-export,-download,-file,-effects,-preserved,-content}.ts`,
  `catalog-workbook{,-format,-scopes}.ts`, `catalog-editor-workbook.ts`, **`catalog-amazon-workbook.ts`** (native Amazon template / Modello
  mapping), **`catalog-ebay-workbook.ts`** (the `ebay_xx` adapter), `catalog-source-{file,mapping,fetch}.ts`, `catalog-csv-dialect.ts`,
  **`workbook-parse.ts` + `workbook-parse.worker.ts`**; contract `packages/shared/catalog-transfer.ts`.
- Amazon .xlsm: `services/amazon/template-workbook.ts` (jszip reader), `template-vault.service.ts` (.xlsm export), `flat-file{,-mapping,-merge,-coerce,-schema-walk,-pull*}.ts`.
- Web: `apps/web/src/app/products/[id]/edit/_studio/import/ProductTransferDrawer.tsx` (live; mounted by `sheet/master/useMasterSheetAdapter.tsx`
  and `sheet/channel/useChannelSheetAdapter.tsx`), `_studio/import/ImportDrawer.tsx` (IO.1, NOT mounted), `apps/web/src/app/products/catalog-transfer/`,
  `products/amazon-flat-file/`, `products/ebay-flat-file/`, `components/flat-file/`.
- Tests: `services/pim/catalog-{product-transfer,transfer*,workbook*,ebay-workbook,csv-*,source-mapping}.vitest.test.ts`, `workbook-parse.vitest.test.ts`,
  `services/amazon/{template-workbook,flat-file-roundtrip,flat-file-*}.vitest.test.ts`, `services/flat-file/**/__tests__/*`, web `_studio/import/*.vitest.test.ts`,
  `apps/api/scripts/{verify-catalog-transfer.mts,_xlsm-roundtrip-smoke.mts}`.

## 6. The first step (measure only — no code change, no production write)

1. Read the ★ documents. Write `docs/channel-file-import/PLAN.md` §0 "What exists" in 20 lines, citing file:line.
2. **Classify the whole corpus (§2b) properly** (a read-only script in your scratchpad, jszip/XML — never `exceljs` on the .xlsm): per file the
   format, data sheet, key row, markets and languages, product types, record actions, row count. Save the table in `records/`.
3. Pick a **representative sample per format × record action × market × product type** (e.g. GALE IT/DE/FR/ES new full, a partial-update
   file, the delete file, AIREON COAT+PANTS, the two-language file, one old flat file, two eBay workbooks, one root `XAVIA-eBay-IT-*` file).
   Copy them into your scratchpad. On the LOCAL database only, run the EXISTING import paths on each exactly as the Owner would (the
   product-sheet drawer, and `/products/catalog-transfer`), through their preview/inspect endpoints. Predictions written first.
4. Produce a **coverage table per format**: every key/header → which Nexus field and scope (Shared, channel·market·language) / ignored
   with a reason / refused / wrongly mapped; counts imported · preserved-not-editable · lost; how a blank cell is treated (partial update =
   no change); what happens to parent/child, variation theme, ASIN/EAN/GTIN exemption, images, price (🔴 every price write goes through the
   ONE price door, `writeChannelPrices`, `expectedVersion` required — PLAN.md Part 2), quantity (EU = one number; FBA never). Then a **value
   round trip** per sample: import → export → compare every cell; list every difference.
5. From the gaps, write the plan as an amendment for the Owner ("FOR YOUR RULING"): the smallest GENERIC set of changes that makes every
   format in the corpus import AS IS, for any family, with zero loss, a truthful preview (what changes, per field, per product, before any
   write — and where the channel differs, shown), each market's language stored in its own language (never as Shared Italian), record
   actions honoured, and a proof run over the whole corpus (every file: parsed, previewed, 0 unexplained losses). At most two questions,
   each with a recommendation. Nothing is built before the Owner rules.
