# XLSM + Amazon Official-Template Hybrid Import/Export — and Flat-File `#`-Column View Menu

**Date:** 2026-07-16 · **Status: PROPOSAL — AWAITING OWNER GATE** (no code written; per approval-before-implementing + flat-file-untouchable rules, every phase below ships only after explicit approval, phase-by-phase)

## 0. What the owner asked for

1. **XLSM compatibility.** The flat-file systems must import and export `.xlsm`.
2. **Hybrid workflow.** Initial listing happens on Amazon's own downloaded spreadsheet (the official Custom Listings Template, `.xlsm`, per market). Then that same file is imported into Nexus so the platform takes over ongoing operations — inventory, real-time sync, Follow/Pin/Buffer columns, pricing, content — with nothing lost. Headers must map correctly; every scenario considered; "absolutely perfect."
3. **Compact `#` column.** The ASIN / "Active" / copy-icon extras in the first (`#`) column inflate row height. Hide them by default; add a **View** menu next to **Edit** that can re-enable them.

Reference files analysed (read-only; copies in scratchpad, originals untouched):
`AIREON {IT,DE,ES,FR}.xlsm` + `X-RACING IT.xlsm` from `~/Desktop/2026/LISTNGS/...FINAL (upload this)/`.

---

## 1. Ground truth A — anatomy of the real files (all 5 verified programmatically)

These are Amazon's **new-generation Custom Listings Template** (not the legacy `TemplateType=fptcustom` TSV grammar):

- **Workbook:** 10 sheets, localized names. IT: `Modifiche al modello, Istruzioni, Immagini, Definizioni dati, `**`Modello`**`, Esplora dati, Conditions List(hidden), Valori validi, Dropdown Lists(hidden), AttributePTDMAP(hidden)`. DE/ES/FR identical structure (`Vorlage`/`Plantilla`/`Modèle`, `Gültige Werte`/`Valores válidos`/`Valeurs valides`).
- **No VBA despite `.xlsm`:** none of the 5 files contains `vbaProject.bin`, yet `[Content_Types].xml` says `macroEnabled` → **never trust extension or content-type; sniff the zip**. (Fresh Seller-Central downloads MAY carry real VBA — importer must tolerate both; we parse XML only and never execute macros.)
- **Template sheet layout:** `A1` = settings blob `settings=feedType=256&…&primaryMarketplaceId=amzn1.mp.o.<MPID>&contentLanguageTag=xx_XX&templateIdentifier=<uuid>&headerLanguageTag=xx_XX…`; **row 4 = localized labels; row 5 = canonical attribute paths; row 6 blank; data rows 7+.**
- **Attribute grammar (row 5):** SP-API listings paths with qualifiers + instance indices:
  `contribution_sku#1.value`, `::record_action`, `parentage_level[marketplace_id=…]#1.value`, `child_parent_sku_relationship[…]#1.parent_sku`, `variation_theme#1.name`, `item_name[marketplace_id=…][language_tag=…]#1.value`, `purchasable_offer[…][audience=ALL]#1.our_price#1.schedule#1.value_with_tax`, `bullet_point[…]#1..#5.value`, `supplier_declared_dg_hz_regulation#1..#5.value`, `image_locator_ps01[…]#1.media_location`, `gpsr_*`, `dsa_responsible_party_address[…]#1.value`, …
- **Column counts:** IT 344 / DE 352 / ES 344 / FR 344 / X-RACING 252. **ES + FR canonical attr sets are IDENTICAL to IT; DE genuinely drifts** (+`epr_eco_fee_eubr#1.*`, +`regulatory_compliance_certification#1..3.*`, −`ghs#1.classification#1..5`) → mapping must be manifest-driven per market, never hardcoded.
- **`::record_action`:** IT = `Modifica (aggiornamento parziale)` on all 41 rows (partial update); DE/ES/FR = blank (default create-or-replace); delete tokens exist per market (`Elimina`/`Löschen`/…). Values are **localized**.
- **Parentage values localized:** `Articolo parent`/`Bambino` · `Eltern`/`Kind` · `Principal.`/`Niños` (ES parent has a trailing period!) · `Parent`/`Enfant`.
- **Fulfillment/qty (as-built):** all rows FBA (`Logistica di Amazon (UE)` / `Versand durch Amazon (EU)`), `fulfillment_availability#1.quantity` **empty** on every row (FBA rule honored in the files themselves).
- **Variation:** AIREON theme = literal `TEAM_NAME/ATHLETE/SIZE/COLOR` on every row incl. children; axes live in `team_name` (Giacca/Pantaloni · Jacke/Hose), `athlete` (Uomo/Herren), `color` (Italian names kept in all markets), `apparel_size` (COAT) vs `bottoms_size` (PANTS) with per-market `size_system`/`size_class` + disambiguated tokens (`M (m)`, `XXS (xx_s)`). **X-RACING (product type `APPAREL`) uses a LOCALIZED theme name `TIPO_MISURA_SPECIALE/DIMENSIONI/COLORE` and a plain `size#1.value` (numeric 46–58)** → theme tokens and size attributes vary per PT and template version.
- **No product-identity columns at all** in any of the 5 files (no ASIN/EAN/GTIN/`merchant_suggested_asin` columns) — identity is resolved by Amazon from SKU; ASINs reach Nexus only via catalog sync/reconciliation, never the file.
- **Multi-PT in one file:** AIREON = COAT (21 rows incl. parent) + PANTS (20) in one sheet — the platform's MT union-sheet model matches this exactly.
- **Zip quirk found:** DE/ES/FR store worksheet rel targets as **absolute** `/xl/worksheets/sheetN.xml` (IT relative) — a real-world parser edge case now captured for tests.
- **Data volume:** 41 data rows (1 parent + 40 children) AIREON; 50 X-RACING (1+49: 7 colours × 7 numeric sizes). Files 460–690 KB.

## 2. Ground truth B — current platform pipeline (verified 2026-07-16)

Three separate import systems; only one is in scope:

| System | Where | Status |
|---|---|---|
| **FX smart import/export** (in-scope host) | Amazon page wizard `ImportWizardModal.tsx` + `/api/amazon/flat-file/{parse,suggest-mapping,suggest-columns-ai,coerce,plan-import,validate-rows,export}`; eBay equivalents | Live; the natural home for template import |
| Legacy W8 import-wizard | `/bulk-operations/imports`, `ImportJob`, `import.service.ts` | **Owner-locked — zero changes** |
| FF2 catalog-workbook engine | `/api/flat-file/import/*`, `services/flat-file/import/*` | Dormant (no web caller), own grammar (`price@IT`), **out of scope** |

Hard findings that explain "XLSM doesn't work":

- **B1. `.xlsm` is accepted in exactly one place and parseable in none.** The only mention in both apps is the hidden TSV-input accept list (`AmazonFlatFileClient.tsx:4193`). `detectFileKind` (`services/import/parsers.ts:38`) knows only `.xlsx/.xls`; the wizard's `fileToPayload` (`ImportWizardModal.tsx:72`) base64-encodes only `.xlsx/.xls` → a picked `.xlsm` is sent as **text** and mis-parses. The three Amazon accept surfaces disagree (input allows `.xlsm`; drop-regex `AmazonFlatFileClient.tsx:4187` allows `.xls` not `.xlsm`; wizard allows `.xls/.json` not `.xlsm`).
- **B2. Fastify default 1 MB `bodyLimit` chokes the upload before parsing.** FX upload endpoints take base64 in JSON (no multipart); server inline caps say 15/20 MB but the app never overrides Fastify's 1 MB default (`apps/api/src/index.ts:422`) → AIREON IT (687 KB → ~916 KB base64 + JSON) already breaches it. **Real xlsx imports of this size are broken today too.**
- **B3. Parser shape mismatch:** `parseXlsx` reads **first worksheet only** + **first non-empty row as headers** (`parsers.ts:155-168`). In these templates sheet 1 is "Modifiche al modello" and headers live at row 5 of sheet 5 → today's parse yields garbage even as `.xlsx`.
- **B4. Export today:** CSV/XLSX = single-English-header via `renderExport` (exceljs, `renderers.ts:113-140`); the only Amazon-re-uploadable export is the **legacy TSV** (`buildTsvExport`) — nothing can emit the new template grammar.
- **B5. exceljs (already the repo's parser) reads these files fine** — but is slow on their 1.1 MB defined-names tables (~minutes). The FF2 parser reads all sheets; the FX one doesn't. (My structural dumps used direct-XML parsing in seconds — worth keeping as a perf option for the Template sheet only.)
- **B6. Mapping substrate already strong:** `suggestFlatFileMapping` (4 tiers: id → EN/localized label → normalized → alias, `flat-file-mapping.ts`), `coerce` (enum exact→case→normalized + AI rescue + EU decimals), `planImportMerge` (fill-missing|overwrite, per-cell), `validate-rows`, per-source presets, drag-drop. The wizard applies into the grid and **Save** creates/updates products via FFC `syncRowsToPlatform`.

## 3. Ground truth C — data model & "don't lose the platform features"

- **Product:** children are child `Product` rows; `variationAxes String[]` + `variantAttributes Json` **can** hold arbitrary axes, but FFC's `ffcExtractVariantAxes` (`flat-file.service.ts:1547-1552`) extracts **Color + Size only** → `team_name`/`athlete` axes would be dropped on create (must extend).
- **ChannelListing:** one row per product×channel×marketplace (`@@unique`), per-market content in `title/description/bulletPointsOverride/platformAttributes/flatFileSnapshot/overrideData`; ASIN = `externalListingId`/`externalParentId`. A child's `flatFileSnapshot.parent_sku` drives family reconstruction in the feed (`flat-file.service.ts:2824-2826`) — the known re-parent trap.
- **FBA safety:** `isFbaListing()` fail-closed + `buildAmazonListingPatch` omits `fulfillment_availability` for FBA (`outbound-sync.service.ts:143-211`) — import must add its own belt (drop qty cells for FBA rows at map/coerce time) but the floor already exists.
- **Follow/Pin/Buffer:** all on ChannelListing (`followMasterQuantity/quantityOverride/stockBuffer`); the flat-file save **no longer force-pins** (defer-to-Follow-column, shipped). Newly created listings default `followMasterQuantity=true` → imported products get Follow behavior automatically.
- **Known gap (pre-existing bug to fix in-scope):** the FFC **create** path never refreshes `ProductReadCache` (only the delete path does, `flat-file.service.ts:3088-3090`) → newly imported products are invisible in `/products` until a manual backfill.
- **Matching:** SKU exact + case-sensitive (`productBySku`), `SkuAlias` for normalized aliases; ASIN matching + operator-confirmed linking exists in `listing-reconciliation.service.ts` (SKU→ASIN→GTIN; CONFIRMED never overwritten). `amazon-sync.service.ts` sets `amazonAsin`/`parentAsin` by SKU. **This is how live ASINs/status arrive post-import — the file has no identity columns.**
- **GPSR:** template `gpsr_*`/`dsa_responsible_party_address`/`compliance_media` columns ↔ the grid's Safety & Compliance columns (UFX P6b shapes, ground-truthed against real IT schema) — mapping is 1:1 by attribute path.

---

## 4. Design — Part A: XLSM + Amazon-template hybrid (8 phases)

Host = the **FX pipeline** (wizard + `/api/amazon/flat-file/*`). W8 legacy and FF2 untouched. Each phase independently shippable, committed+pushed after verification; deploy target noted (Railway = api, Vercel = web).

### A1 — Ingestion unblocked: `.xlsm` end-to-end + body-limit fix _(api + web)_
- `detectFileKind`: `.xlsm` (+ `.xlsb` rejection with clear message) → `xlsx` kind; content **sniff** (zip magic `PK` + `[Content_Types].xml`) so a mis-named file still parses and a text file named `.xlsm` errors cleanly; `.xls` (BIFF) keeps the explicit "re-save as .xlsx" error.
- Wizard `fileToPayload`: base64 branch for `.xlsm`; unify all accept lists/drop-regexes on one constant (`.csv,.tsv,.txt,.xlsx,.xlsm,.xls,.json`) across the wizard, hidden input, grid drop, and eBay wizard.
- **Fix B2:** route-level `bodyLimit` (~32 MB) on the FX parse endpoints (or move them onto the already-registered 50 MB multipart) — this also un-breaks large plain-xlsx imports today.
- Safety: keep 15/20 MB inline caps; add a cell-count ceiling; macros never executed (parse-only); never echo file contents in errors.
- Exit: AIREON IT.xlsm uploads and parses (raw, pre-template-smarts); regression tests for the sniffing matrix incl. the absolute-`/xl/` rels quirk.

### A2 — Official-template detection + reshaping _(api)_
- In `/parse`: recognize **both grammars** — new (`settings=feedType=256` in A1 + dense `#N.`/`::` attr row within rows 1-8) and legacy (`TemplateType=fptcustom`) — via **dense-row detection** (≥20 attr-like cells; the "Definizioni dati" vertical dictionary sheet must NOT match — proven trap).
- Choose the Template sheet by detection (never `worksheets[0]`); headers = attr row (row 5); skip label + blank rows; skip all-empty data rows; forced-text identifier hygiene (port FF2's `normalizeCell` sci-notation/date recovery).
- Return `templateMeta`: `templateIdentifier, headerLanguageTag, contentLanguageTag, primaryMarketplaceId→marketplace (APJ6JRA9NG5V4=IT, A1PA6795UKMFR9=DE, A1RKKUPIHCS9HS=ES, A13V1IB3VIYZZH=FR, +UK/…), productTypes found, record_action histogram, row counts`.
- Perf: exceljs is minutes-slow on these workbooks (B5) → parse the Template sheet via streamed XML (the approach validated today: seconds) or cap exceljs to the detected sheet.
- Exit: all 5 files parse to `{headers=attr paths, rows, templateMeta}` correctly (fixture-tested).

### A3 — Header canonicalization + deterministic auto-map _(api)_
- Pure `canonicalizeTemplateHeader()`: strip `[qualifiers]`, extract `language_tag`/`marketplace_id`, keep instance indices → new **top tier `template-path` (confidence 1.0)** in `suggestFlatFileMapping`, with instance fan-out (`bullet_point…#2.value` → the manifest's bullet-2 column; `supplier_declared_dg_hz_regulation#1..5`; `other_offer_image_locator_N`). Manifest ids derive from the same SP-API schema, so post-normalization matches should be near-total.
- `::record_action` is **never a data column**: rows tagged by action; **Delete rows are excluded from apply and prominently warned** (import never deletes); partial-update vs create-or-replace informs the default merge mode.
- Marketplace routing: file's marketplace ≠ active page market → blocking banner with one-click "Switch to DE and continue" (manifest + enum sets then align 1:1 — importing the DE file against the DE manifest makes localized values match natively).
- Exit: ≥95% of the 344-352 headers auto-map at `template-path` tier on all 5 real files; remainder visibly listed (AI tail available); auto-saved preset keyed by `templateIdentifier`.

### A4 — Value semantics + safety policies _(api + wizard toggles)_
- Enum values: same-market import ⇒ file values are the manifest's own valid values (verify on real files); keep coerce tiers + AI rescue for stragglers; per-market parentage/action token maps (incl. ES `Principal.` trailing dot) normalized to canonical `parent`/`child` (the snapshot normalizer already canonicalizes these).
- **FBA belt:** rows whose `fulfillment_channel_code` maps to FBA (or whose existing listing `isFbaListing`) get quantity cells **dropped at plan time** with a per-row note (floor guards at preflight/submit remain).
- **Owner-gated toggles (defaults = my recommendation):** Import quantities **OFF** (pool + Follow govern; file qty was for initial listing) · Import prices **ON** · merge mode default **fill-missing** for existing families / full for new SKUs.
- Exit: coerce over the 5 files yields zero `flagged` on enum columns; FBA qty-drop unit-tested.

### A5 — Entity linking + first-class wiring _(api)_
- Existing-SKU rows update listings (already works); unknown SKUs create via FFC. **Extend `ffcParseThemeAxes`/`ffcExtractVariantAxes` to ALL theme axes** (TEAM_NAME/ATHLETE/…; unify `apparel_size`/`bottoms_size`/`size` → Size) so AIREON-shaped families create losslessly; localized theme names (`TIPO_MISURA_SPECIALE/DIMENSIONI/COLORE`) normalized to canonical axis tokens.
- Re-parent detection: imported `parent_sku` differing from current parentage → explicit warning + (on apply) children's `flatFileSnapshot.parent_sku` rewritten (the known trap).
- **Fix the pre-existing read-cache gap:** FFC create path refreshes `ProductReadCache` (mirror of what `products.routes.ts` does) → imported products appear in `/products` immediately.
- Post-import linking: offer "Reconcile with live Amazon listings" (runs the existing SKU/ASIN reconciliation for the imported SKUs) so ASIN/listingStatus/publish-status light up without waiting for cron; FBM rows then flow through outbound qty/price sync (Follow default = Follow), FBA rows show the standard `—` locks.
- SKU-case misses surface as "near-match via SkuAlias — confirm" instead of silent new-product creation.
- Exit: dry-run on AIREON IT (existing family): 41/41 matched-existing, 0 new; X-RACING: creates full 49-child family with axes intact (staging family, then removed) — verified via API assertions.

### A6 — Multi-market hybrid loop _(web + api)_
- Sequential import of IT→DE→ES→FR files for the same family: per-market content lands on that market's listing (page is single-active-market; auto-switch from A3 makes this one-click per file); shared/global attributes collide under fill-missing by default with per-cell diff visibility.
- Wizard remembers per-`templateIdentifier` mapping+toggles; import summary states per-market outcome (updated/created/skipped-FBA-qty/excluded-deletes).
- Exit: all four AIREON files imported back-to-back on a staging copy leave IT/DE/ES/FR listings each carrying their own language content, prices per file, zero qty writes, pool untouched.

### A7 — Export round-trip: "Amazon template vault" (.xlsm out) _(api + web)_
- **Vault:** on every successful template import, store the original workbook bytes (existing `ArtifactStore`) keyed `(templateIdentifier, marketplace, productTypes)`; blank templates uploadable to the vault directly (the owner already archives them under `_BLANK TEMPLATES (per language)/`).
- **Export for Amazon (.xlsm):** File-menu item per market — clone the vaulted workbook and rewrite ONLY the Template sheet's data rows from live platform truth (same attr columns), via **surgical zip rewrite** (every other part byte-identical: valid values, named ranges, content-types, VBA if a future template has it — immune to exceljs's slowness/lossiness here). FBA rows emit qty **empty**; `::record_action` default = partial-update (localized token); filename `<FAMILY> <MKT> - nexus-export.xlsm`.
- Round-trip invariant test: `import(export(state))` = zero-diff plan.
- No vault entry → fall back to legacy TSV (unchanged) or prompt to add the blank template once.
- Exit: exported AIREON IT.xlsm opens in Excel with intact Valori validi dropdowns and passes a byte-level non-Template-part diff vs the vault original.

### A8 — Verification matrix on the real files _(no new code)_
Scripted prod-parity run (dry, then owner-supervised apply of ONE family): 5/5 files parse → map ≥95% tier-1 → coerce clean → plan sane (counts above) → apply (gated) → read-cache/`/products` visible → Follow column present → reconcile links ASINs → export round-trip zero-diff → re-import idempotent. Runbook + `_xlsm-hybrid-smoke.mts` kept as regression.

## 5. Design — Part B: compact `#` column + View menu _(web only, 1 phase)_

Findings (verified): the extras are **Amazon-only**, injected via `renderRowMeta` (`AmazonFlatFileClient.tsx:3921-3998`: ASIN dp-link, `listingStatus.slice(0,4)` badge, Copy-icon **Clone-variant** button on child rows, override/cascade/last-sync badges). The `#` cell (`FlatFileGrid.tsx:3085-3120`) uses `minHeight: rowHeight` + `flex-col`, so the stacked meta (~40-60px intrinsic) stretches the whole row past the 28px default. eBay's meta is already light. Both pages share the grid.

**B1 — View menu + default-compact row meta**
- New `viewMenuItems` prop + a **View** `MenuDropdown` between Edit and the divider (`FlatFileGrid.tsx:2400/2401`), mirroring the `fileMenuItems`/`editMenuItems` pattern (types at `FlatFileGrid.types.ts:384-390`); checkbox-style items (extend the local `MenuDropdown` item shape with `checked?`).
- Amazon default: `renderRowMeta` returns **null** (row number only → rows sit at uniform `rowHeight`). View toggles: **"Row details (ASIN + status)"** and **"Row actions (clone)"** — both **off by default**; existing gated badges (override/cascade) keep their current switches, relocated into View for discoverability.
- **Clone-variant stays reachable always** via the existing shared `FlatFileContextMenu` ("Clone variant" on child rows) so hiding the meta never removes the capability.
- Persistence: localStorage via the `smartPasteEnabled` pattern — **page-scoped key** (`ff-amazon-view`) rather than per-market `storageKey`, so one setting governs all markets (deviation noted; trivially switchable if the owner prefers per-market).
- Self-verify before showing: local preview screenshots + numeric row-height measurement (28px uniform with meta off; no reflow of frozen columns; `containIntrinsicSize` consistent), then deploy on "deploy" (Vercel).
- eBay inherits the View menu shell only when it has items (none initially — its meta is already compact).

## 6. Every-scenario ledger (edge cases → handling → phase)

| # | Scenario | Handling | Phase |
|---|---|---|---|
| 1 | `.xlsm` without VBA but macro content-type (all 5 files) | sniff zip, ignore content-type | A1 |
| 2 | Real VBA in fresh Seller-Central downloads | parse-only (never execute); vault clone preserves bytes | A1/A7 |
| 3 | Renamed extensions (.xlsx↔.xlsm), text file named .xlsm | magic-byte sniff + clear error | A1 |
| 4 | `.xls` BIFF / `.xlsb` | explicit "re-save as .xlsx/.xlsm" error | A1 |
| 5 | >1 MB uploads (any xlsx today!) | route bodyLimit fix | A1 |
| 6 | Zip-bomb / huge valid-values sheets | size + cell-count ceilings; parse Template sheet only | A1/A2 |
| 7 | Absolute `/xl/...` rel targets (DE/ES/FR) | normalization + fixture test | A2 |
| 8 | Wrong sheet matches ("Definizioni dati" vertical dictionary) | dense-attr-row detection | A2 |
| 9 | Legacy `fptcustom` files (GALE old market files) | dual-grammar detection | A2 |
| 10 | Localized labels/sheet names per market | detection keys on attr paths, not labels | A2 |
| 11 | File market ≠ page market | blocking banner + one-click switch | A3 |
| 12 | DE schema drift (+epr/+reg-cert/−ghs) | manifest-driven mapping per market | A3 |
| 13 | Multi-instance columns (#1..#5, image_locator_N) | instance fan-out in canonicalizer | A3 |
| 14 | `::record_action` Delete rows | excluded + warned; never delete via import | A3 |
| 15 | Partial-update vs create-or-replace files | informs default merge mode | A3/A4 |
| 16 | Localized enum values (parentage, sizes `M (m)`, fulfillment) | same-market manifest alignment + coerce tiers + per-market token maps | A4 |
| 17 | EU decimal commas / sci-notation EANs / date coercions | existing coerce + FF2 normalizeCell port | A2/A4 |
| 18 | FBA rows carrying qty (older FBM-built files) | qty dropped at plan time + preflight/submit floor guards | A4 |
| 19 | Qty vs shared pool | qty import default OFF; pool never written (invariant) | A4 |
| 20 | Duplicate SKUs in file | existing dedupe (later non-blank wins) + count surfaced | existing |
| 21 | Blank rows / ghost tails / merged header cells | skipped; attr row is single flat row | A2 |
| 22 | Multi-PT one file (COAT+PANTS) | MT union manifest (exists) | A3 |
| 23 | APPAREL numeric sizes + localized theme name | axis token normalization | A5 |
| 24 | team_name/athlete axes lost on create | ffcExtractVariantAxes extension | A5 |
| 25 | Re-parenting via changed parent_sku | warn + children snapshot rewrite | A5 |
| 26 | SKU case/whitespace mismatch | exact match + SkuAlias near-match confirm | A5 |
| 27 | New products invisible in /products | read-cache refresh on FFC create (bug fix) | A5 |
| 28 | ASIN/status linkage (file has no identity cols) | post-import reconciliation trigger | A5 |
| 29 | Same SKUs across 4 market files | per-market listings enriched; shared attrs fill-missing | A6 |
| 30 | Re-import same file | idempotent (plan shows no-ops) | A5/A8 |
| 31 | Export preserving dropdowns/VBA/named ranges | surgical zip rewrite from vault | A7 |
| 32 | Export of FBA qty | always empty | A7 |
| 33 | Amazon rejects our export | round-trip zero-diff test + owner uploads same grammar already proven live | A7/A8 |

## 7. Owner decision points (answers shape A4/A6/B1)

1. **Quantity import default** — recommend **skip** (FBM opt-in toggle only).
2. **Price import default** — recommend **on** (fill-missing still protects).
3. **Delete-action rows** — recommend always excluded (never map file deletes to platform deletes).
4. **Vault auto-capture** — recommend every imported template is auto-stored as the export base.
5. **View-menu persistence** — recommend page-scoped (one setting for all markets).
6. **Clone button relocation** — recommend context-menu as the permanent home (View toggle re-adds inline).
7. **Phase order** — recommend A1→A2→A3 (import works end-to-end for the real files) → B1 (quick visible win) → A4→A5→A6 → A7 (export) → A8. B1 can also go first — it's independent.

## 8. Invariants honored throughout

Never write `StockLevel`/`totalStock` · never write/pin/push FBA quantity (guard never weakened) · flat-file endpoints never bump `version` outside the content save · legacy W8 import untouched · FF2 engine untouched · sensitive config untouched · additive migrations only (none currently foreseen — vault uses existing ArtifactStore) · design-system components for all new UI · commit+push per verified phase · verify on prod (api) / local preview then Vercel (web).
