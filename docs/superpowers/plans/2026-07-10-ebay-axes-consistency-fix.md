# eBay Variation-Axes & Images Consistency (EAC) — diagnosis + fix proposal

**Date:** 2026-07-10 · **Status:** PROPOSAL — awaiting operator approval, NO code yet.
**Operator principle (stated 2026-07-10):** "complete control over each and every thing." The fix must INCREASE control: declare freely, outputs mirror the declaration exactly, ghosts removed only by operator-approved cleanup (never silent auto-hide), everything unsendable surfaced as a visible warning.

## The problem (operator-reported, all confirmed on live AIREON data)
1. Variation-order tool shows **4 axes** (Size, Colour, Tipo di prodotto, **Team Name**) but the theme + real listing have **3**.
2. Images picker shows **6 axes** (+ Team Name, Athlete, Body Type).
3. Images "Colour" shows **6 in the count but only 2 image-set buckets**.
4. Variation **Theme column** dropdown offers only a narrow set (Size, Colour, Scollatura) — operator wants to see & pick ALL candidate axes.

## Root cause (one disease, five symptoms)
`resolveVariationAxes` (ebay-variation-push.service.ts:250-406) is the ONLY theme-authoritative code — it synonym-folds + fingerprint-suppresses the Team Name↔Tipo di prodotto ghost, honoring the declared theme. But the **five UI surfaces each re-derive independently** from raw data with no theme filter and inconsistent value sources:
- **Variation-order modal**: `deriveAxes(rows)` (variationValueOrder.pure.ts:161-196) admits every aspect_* with >1 value, no theme filter → Team Name shown; order seed = parent `_variationAxes` which still lists Team Name.
- **Cockpit VariationsMatrixCard** (:173-207): `[...declared, ...extras]` — the `extras` concat (181-182) re-adds observed-undeclared ghosts; exact-match drops real `Tipo di prodotto` (mis-keyed under Team Name).
- **Images picker axes** (ebay-image-axis.pure.ts:83-144): 3-source union (variantAttributes + categoryAttributes.variations + varying itemSpecifics), no theme filter → 6 axes.
- **Images Colour 6-vs-2**: the PICKER COUNT folds polluted itemSpecifics values ("Crema e Vino - Giacca"…) = 6 (pure.ts:133,142); the BUCKETS read only clean categoryAttributes.variations = 2 (EbayFlatFileImageModal.tsx:45-59). Two sources, one polluted.
- **Theme column** (ebay-columns.ts:237-245 + EbayFlatFileClient.tsx:1014-1048): options = ONLY eBay-schema aspects flagged `aspectEnabledForVariations` (Size/Colour/Scollatura). `enumMode:'open'` so free-text works (that's how "Tipo di prodotto" got in) — but candidates aren't discoverable.

**Data layer (code alone can't fix):** on AIREON's children, "Tipo di prodotto"'s Giacca/Pantaloni values are physically stored under the ghost **Team Name** key in categoryAttributes.variations (there is NO clean "Tipo di prodotto" key); itemSpecifics Colour is polluted with " - <type>" suffixes; Athlete/Body Type are Amazon leftovers. So even perfect code leaves "Tipo di prodotto resolves to 0 values" until the data is remapped.

## Proposed fix — TWO layers

### Layer A — CODE: one canonical axis/value catalog, theme-authoritative (reversible, tested, no live-listing writes)
1. New read-only `GET /api/ebay/.../resolved-axes?parentProductId&marketplace` wrapping `resolveVariationAxes` over the CLEAN source (categoryAttributes.variations, same as push): returns `{axes:[{name,key,values[]}], candidates:[...all discoverable axis names...], warnings, suppressed}`.
2. **Output surfaces** (variation-order modal, cockpit, images picker + buckets) consume `axes` → filtered to the declared theme, synonym+fingerprint deduped, ghosts gone, ONE value list so picker-count == buckets. Warnings shown (e.g. "Tipo di prodotto has no values — needs data cleanup"), never silent.
3. **Input surface** (theme column) consumes `candidates` = union of {variation-eligible schema aspects} ∪ {aspect keys present on the family} ∪ free-text (enumMode open kept) — widest set, full operator freedom, synonym-folded so no dupes.
4. Control-preserving: nothing is auto-removed from the operator's DATA; the outputs simply reflect the DECLARED theme. An axis the operator wants gone is removed by declaring the theme + cleanup (Layer B), which they drive.

### Layer B — DATA cleanup of AIREON (operator-approved, reversible) — CONFIRMED by read-only prod DB inspection
eBay model facts (confirmed): images vary by exactly ONE aspect; eBay groups image sets by the EXACT aspect-value string, dedup by URL; a listing may have MORE specifics (5 max) than the image aspect. **The "only 2 image sets while I set up 4" answer:** the live listing's colour itemSpecific carries 4 POLLUTED swatches — "Crema e Vino - Giacca", "Crema e Vino - Pantaloni", "Nero Neo - Giacca", "Nero Neo - Pantaloni" — but your curated images are keyed to the 2 base colours, so only 2 swatches get a real image set. Fixing the colour values to {Crema e Vino, Nero Neo} + re-push fixes the buyer gallery.

**REFINED per-row aspect reality (read from GET /ebay/flat-file/rows, item-specifics-first = what the push sees) — each dimension is SPLIT/DUPLICATED across English + Italian + ghost keys:**
- Product-type: `aspect_Tipo_di_prodotto` = {Giacca,Pantaloni} CLEAN + `aspect_Team_Name`/`team_name` = {Giacca,Pantaloni} GHOST dup (fingerprint-suppressed by push). → keep Tipo di prodotto, drop Team Name.
- Colour: `aspect_Color` = {Crema e Vino, Nero Neo} CLEAN + `aspect_Colore` = {"Crema e Vino - Giacca","Nero Neo - Giacca","Crema e Vino - Pantaloni","Nero Neo - Pantaloni"} POLLUTED (4). → keep Color, drop (or de-pollute→dup-of-Color) Colore.
- Size: `aspect_Size` = 6 (INCOMPLETE) + `aspect_Taglia` = 10 (COMPLETE — 3XL,4XL,5XL,L,M,S,XL,XS,XXL,XXS, matches the 40 SKUs). → the COMPLETE set is in Taglia; Size is under-populated. Reconcile so the size axis carries each variant's REAL size (recoverable per-variant from SKU / whichever key is populated) — do NOT blindly pick the 6-value key or data is lost.
- Gender ghosts: `aspect_Athlete`/`athlete` + `aspect_Body_Type`/`body_type` = {Uomo}. → drop.
IMPLICATION: the synonym-fold (Color+Colore, Size+Taglia) is what inflates the resolved value sets the operator sees. The push today likely sends the polluted Colore (→ 4 live swatches). The Layer B script must CONSOLIDATE each dimension to one clean key with the correct COMPLETE per-variant value — this is per-variant work (esp. Size), needs careful design + operator review of the exact before/after diff before running.

**Per-variant reconciliation is DETERMINISTIC (read all 40 children):** Size vs Taglia — 24 agree, 16 have ONLY Taglia, 0 have only Size, 0 disagree → **Taglia is the complete source, agrees wherever Size also set**; clean size per variant = its Taglia value. Colour — Color populated on 24, Colore (polluted) on all 40 → clean base colour per variant = Color if present else strip " - <type>" suffix from Colore (they agree: "Crema e Vino - Giacca"→"Crema e Vino" == Color). Tipo di prodotto clean on all. So no data is lost; each variant's true size+colour+type is recoverable.
**NAMING DECIDED 2026-07-10: ITALIAN canonical (Colore, Taglia, Tipo di prodotto).** Locked Layer-B cleanup spec per child: **Colore** ← clean base colour (strip " - <type>" from current polluted Colore; == Color where present); **Taglia** ← keep (complete, correct); **Tipo di prodotto** ← keep (clean). REMOVE from itemSpecifics + categoryAttributes.variations + variantAttributes: `Color`, `Size` (English dups), `Team Name`, `Athlete`, `Body Type` + case-variants (color/size/team_name/athlete/body_type). Parent: `variationTheme` → "Tipo di prodotto,Colore,Taglia"; platformAttributes `_variationAxes` → [Tipo di prodotto, Colore, Taglia]; `_axisValueOrder` colour-dim values → {Crema e Vino, Nero Neo}, drop team-name key. Script: dry-run diff for all 40 variants + parent FIRST (computed from already-pulled API data, no DB write), operator approves, then --apply with JSON backup. Zero eBay writes; live listing changes only on a later operator-gated push.

**(superseded) prior naming options —** the real eBay-IT category aspects are ITALIAN (Colore, Taglia are the variantEligible schema aspects; Tipo di prodotto is custom). The operator's declared theme mixes English+Italian ("Tipo di prodotto, Color, Size"). Target end-state options: (a) Italian canonical — Tipo di prodotto / Colore / Taglia (matches eBay IT category, what Italian buyers expect), theme becomes "Tipo di prodotto,Colore,Taglia"; or (b) English — Tipo di prodotto / Color / Size (keep the current theme spelling). This changes buyer-facing aspect labels + which key is canonical vs dropped, so the operator picks before the script is written.

Confirmed AIREON data (read-only): variationTheme is already correct ("Tipo di prodotto,Color,Size"); "Tipo di prodotto" is ALREADY clean in itemSpecifics (Giacca/Pantaloni). Ghosts = Amazon apparel leftovers (Team Name = product-type twin, Athlete/Body Type = "Uomo"). Pollution = itemSpecifics "Colore" (4 suffixed) + parent `_axisValueOrder.__dim0__` + `_variationAxes` (lists Team Name).

Cleanup (all **Nexus-local JSON, ZERO eBay writes** until a later operator-gated push; reversible if the script backs up JSON first):
- (i) drop `Team Name` from itemSpecifics + categoryAttributes.variations (Tipo di prodotto already clean — no remap needed, just delete the twin).
- (ii) drop `Athlete`/`Body Type` ghosts (categoryAttributes.variations, variantAttributes, itemSpecifics incl. case-variants).
- (iii) de-pollute itemSpecifics `Colore` → strip " - <type>" suffix; fix parent `_axisValueOrder.__dim0__` → {Crema e Vino, Nero Neo}; `_variationAxes` → [Tipo di prodotto, Color, Size].
- **UI-doable** (existing sheet, sheet-clear persists/doesn't regenerate): the itemSpecifics edits (Colore de-pollute, clear Team Name/Athlete/Body Type columns) — but tedious across 40 rows.
- **Script-only** (NOT surfaced in the eBay sheet, but feeds the images-workspace picker so ghosts persist in that UI until removed): categoryAttributes.variations, variantAttributes, parent platformAttributes axis metadata.
- **Recommendation:** one reversible one-off script (snapshots JSON to backup first) is cleanest — the sheet alone can't clear the picker's ghost sources.
- **Live listing:** unchanged until the next `pushVariationGroup` (an eBay write, operator-gated). Push already suppresses Team Name in DECLARED mode today; the colour pollution is what genuinely needs data-fix + re-push. **Residual to verify:** no Amazon→eBay sync re-writes itemSpecifics.Colore (it's eBay-scoped, shouldn't).

## Sequencing (operator controls)
Proposed: Layer A first (safe code, makes every surface honest + gives full theme freedom, surfaces the data problem as warnings), then Layer B cleanup on AIREON (with operator), then a live re-verify. But this is the operator's call — scope & order to be approved.

Key files: ebay-variation-push.service.ts:250-406 · ebay-theme-axes.ts:16-57 · ebay-image-axis.pure.ts:83-144 · images-workspace.routes.ts:231-315 · ebay-cockpit.routes.ts:400-539 · variationValueOrder.pure.ts:161-196 · VariationValueOrderModal.tsx:35,74-86 · EbayFlatFileImageModal.tsx:45-59,209-245 · VariationsMatrixCard.tsx:173-207 · ebay-columns.ts:237-245 · EbayFlatFileClient.tsx:740,908-938,1014-1048.

## APPLIED 2026-07-10
Layer A (server 7b25730d + client a2dcb354 + type fix fb0c8a3f) SHIPPED + prod-verified: variation-order tool shows 3 axes, Team Name gone. Layer B cleanup APPLIED via `_eac-aireon-cleanup.mts --apply` (operator-approved): 66 writes, backup `_eac-aireon-backup-1783647457170.json`. Verified: theme="Tipo di prodotto,Colore,Taglia"; resolvedAxes = Tipo di prodotto(2), Colore(2 clean), Taglia(10); suppressed/warnings empty. Live eBay listing 257614167151 unchanged until a Phase-8 push. Revert: restore JSON from the backup file.

## NEXT (operator-approved 2026-07-10, propose→approve→build)
- **Draft-inclusive multi-family images view:** the eBay flat file loads families by familyId (single) or scope=listed (all LISTED, drafts excluded); scope=all exists in the API (ebay-flat-file.routes.ts:85) but isn't UI-exposed. A draft's own images ARE manageable (workspace loads 200 for unpublished). Goal: let unpublished draft families load into the multi-family view so their images sit alongside published ones without publishing first.
- **Never-mismanage safeguards:** (1) consistent Italian aspect defaults (Colore/Taglia) on NEW eBay products (TEST came up with English Color/Size); (2) pre-push theme/aspect validation gate (refuse push on mismatch, fixable message) built on resolveFamilyAxes + existing preflights.

## SAFEGUARDS (operator-approved 2026-07-10; guarantee = WARN, NEVER BLOCK)
Root cause of English defaults: EbayFlatFileClient.tsx:1030-1032 prefers the parenthesized English gloss from "Colore (Color)" instead of a.name → new IT products get Color/Size. 
- **S1 correct defaults:** prefer a.name (localized) in variantAxisNames; AddListingPopover:89 fallback marketplace-aware not hardcoded ['Color','Size']. NEW/unpublished only — do NOT rename live-published families (rename hazard; those use the reconcile action). Custom axes (Tipo di prodotto) fold to own name → pass through.
- **S2 warn-only pre-push modal:** on Push, reuse Layer A resolvedAxisWarnings/resolvedAxisSuppressed (already returned) + a client conflict scan (aspect_* grouped by axisSynonymKey with differing values) → DS Modal listing each issue + fix, "Publish anyway" always proceeds. NEVER blocks (operator decision).
- **S3 (bonus) one-click "Clean this family":** generalize _eac-aireon-cleanup.mts, deriving keep/drop from resolveFamilyAxes (axes=keepers, suppressed=drop); dry-run diff → approve → apply-with-backup; for ANY family.
BUILD SEQUENCING: queue after the images-picker build (both touch EbayFlatFileClient.tsx) to avoid concurrent same-file edits.
