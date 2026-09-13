# Variation projection (VX) — lane prompts (VX.1–VX.4, VX.F), 2026-09-12

Launch each in its own terminal from the repo root, on the lane model the Owner chooses (the earlier waves ran
`claude --model claude-opus-5`; VP.F and LX ran on Codex). Paste the lane's block as the FIRST message. Each
block is self-contained: the lane name, the shared rules, the brief. The Owner manages the sessions (ledger
#794); lanes report to the Owner in `docs/pes-claims.md` and in their own terminal. Nothing is committed until
the Owner says so.

**Launch order:** VX.1 first (it can start now). VX.2 and VX.4 once `docs/vx1-contracts.md` exists. VX.3 only
after VP.F has written "100% done" in the ledger — it owns every `_studio/variants/**` path until then. VX.F
after the four report done.

---

## SHARED RULES (already inside every prompt below — do not paste separately)

READ FIRST, in this order: (1) `docs/2026-09-12-variation-projection-design.md` — the design; §1 is what was
measured, §2 the principles you are measured against, §3 the contracts, §13 your lane's row, §14 how you verify,
§15 the decisions with their defaults, Appendix B what you must not edit, Appendix C the verbatim copy;
(2) `docs/2026-09-11-variants-page-spec.md` + `docs/vp2-contracts.md` — the page and contracts you extend;
(3) `docs/2026-09-01-product-edit-studio-layout.md` §1b, §2.10, §5; (4) `docs/pes-claims.md` — factual notes
near the top (the hub list closed at #794), lane sections at the bottom (VP.F, LX.0–LX.2, then yours).
RULES: claim your lane in the ledger before editing (session name, lane, date, files); edit only your owned
paths — anything else is a ledger request to its owner; LX's and VP.F's paths are off-limits (Appendix B);
build from scratch on the DS (a missing piece is added to `apps/web/src/design-system/**`, light and dark,
never page-locally); nothing is committed or pushed; before ANY write establish which database `:3000 → :8091`
answers for (GALE's `Product.version` separates the local Docker `nexus_development` from Neon — re-measure,
never inherit); local web hits the PROD API unless `NEXT_PUBLIC_API_URL` points elsewhere — every write is real,
so rehearse on the fixtures only (GALE-JACKET `cmokmy3a40078pm0p1fvnu523`, eBay·IT account
`cmr4aaqb00025nz016k18rup9`, MISANO, AIREON, XRI01, and `VX-TEST-3AX` once VX.1 has created it) and announce a
fixture in the ledger BEFORE writing it; read back after 8 s — a write's response is not what it wrote;
typecheck etiquette: one `tsc` at a time per app, private tsbuildinfo; a claim must match its measurement —
numbers, never adjectives; run every gate BARE for its exit code. The design IS the approval: proceed on the
§15 defaults, write your phase plan into your ledger section, append numbers as you go. STOP and ask the Owner
only for: a write outside the fixtures, a schema migration, a data correction on a real product (report it,
never apply it), a deviation from the design, or a conflict with another lane.

---

## VX.1 — backend: contracts, rules, collisions, preview, plans

```
You are VX.1 — the backend lane of the Variation projection programme (VX). Your design is
docs/2026-09-12-variation-projection-design.md; your row is §13 VX.1. You own: services/pim/family-projection*.ts,
services/pim/variation-rules.service.ts (new), services/pim/variation-preview.service.ts (new),
services/pim/theme-change.service.ts (new), services/pim/variant-attribute-keys.ts, routes/product-studio.routes.ts
(additions only), routes/channel-mapping.routes.ts (additions only), services/pim/schema-mapping.service.ts (the
additive `variations` block only), services/shopify/content-workspace.service.ts + content-publisher.ts (the axes
SOURCE only), services/ebay-variation-push.service.ts lines ~900-912 (the precedence only).

[SHARED RULES — see docs/vx-prompts.md; they bind you verbatim.]

PHASE 1 — contracts, before any behaviour: write docs/vx1-contracts.md with the FINAL shapes of §3
(VariationRule, ProjectionSource, CollisionReport, AxisDelivery, ProjectionReadVx, ProjectionPreview,
ThemeChangePlan) and the routes: GET/PUT /pim/channel-mapping/:channel/:code/variations[/:categoryId]
(reviewRequired, blast-radius simulate before commit), the extended GET /studio/projection, GET
/studio/projection/preview, POST /studio/projection/theme-change (dryRun: true only — refuse anything else with
400 by name). Measure first and put the numbers at the top of that file: the projection read time on GALE for
eBay·IT and Amazon·IT (the 3.77 s columns read is the baseline not to regress), the count of parent listings with
a non-empty platformAttributes._variationAxes across the catalogue (read-only; this is the set the M3 flip
touches), and whether any family on prod has three axes. VX.2/VX.3/VX.4 code against this file, so it is final
when you publish it and every later change is an amendment with a date.

PHASE 2 — M3 first, with proof: write a characterisation test that captures the declared axis set the eBay push
computes for EVERY parent listing on the catalogue (read-only), flip the precedence at ~:904 to "coordinate
_variationAxes when non-empty, else Product.variationTheme, else legacy", run the test again: identical on every
coordinate, or the diff is in the ledger with the coordinate named. The projection PATCH stops writing
Product.variationTheme and writes the coordinate's _variationAxes + _axisNameLabels only; response keeps
affectsAllMarkets honest (now false).

PHASE 3 — rules and resolution (§4 M2, §5): the `variations` block on MarketplaceSchemaMapping (channel-wide and
byProductType[<category>]), the category key per channel, the rule → override → pins resolution, `source` on the
read, Reset to rule = null the row's theme + mapping. The axis-name chain (pinned → site aspect for the canonical
key → English label; Amazon informational) and the value chain (pin → FieldValueMap(channel, market) →
FieldValueMap(channel, '*') → option label) as ONE function each, pure, unit-tested; the mapped-value cell's value
is the chain's RESULT with provenance through classifyProvenance (a map hit is `inherited` with from = "Value map ·
<Channel> <Market>"; no new member).

PHASE 4 — collisions (§6): key(v) over the mapped axes and the INCLUDED variants; GET always reports groups;
PATCH refuses 400 collision_unresolved without a runnable resolver; fold writes pins through the existing child
write path (never a new path), exclude through PATCH …/projection/children, split through the alias route and is
`unresolved` while legacyAliasIndexesPresent() is true. A dropped axis is named in the read (axesOnChannel).

PHASE 5 — the Shopify publisher reads the projection (V6): content-workspace.service.ts seeds `axes` from the
coordinate's projection (rule ⊕ override), not from family.variationAxes; content-publisher.ts:218-224 is then
correct by construction. Prove with a read-back on the Shopify fixture ONLY if the Owner names one in the ledger —
otherwise prove on the composed productSet input (no HTTP) and say so.

PHASE 6 — preview (§8) and plans (§9): the preview calls the adapters' own composers with dryRun (Amazon
buildChildAttributes + parent envelope; eBay's <Variations>/inventory-group composer; Shopify productSet input);
a test asserts preview payload ≡ live payload by calling the same function; buyerView derived from the payload;
diff from __lastPublishedAxes / the last snapshot / the read-back. ThemeChangePlan for the three kinds, dry-run
only, steps + keeps + loses verbatim from §9.

PHASE 7 — codes (§4 M1): axes as CustomAttribute(scope per_variant) + values as AttributeOption; readers resolve
labels through the option and treat an un-backfilled string as code AND label (byte-identical). Write the
backfill as a DRY-RUN REPORT only (per family: strings → codes, the XXS/XS rows listed) into the ledger; the
Owner runs it.

FIXTURE (§14): create VX-TEST-3AX under XAVIA through the existing generate endpoint — parent + 8 children
(colour × size × style = 2×2×2), DRAFT, excluded on every coordinate, never published; announce it in the ledger
BEFORE creating; read back after 8 s. Run the collision matrix on it (each resolver × each dropped axis) and put
the table in the ledger.

DONE (§14): contracts file final; every phase measured; tests green; api tsc + vitest bare exit 0; the
projection read on GALE not slower than your phase-1 number; nothing committed. Then say "100% done" and stop.
```

## VX.2 — the Variations section on the channel mapping page

```
You are VX.2 — the mapping-page lane of the Variation projection programme (VX). Your design is
docs/2026-09-12-variation-projection-design.md §11.1 (and §4 M2, §6, §15 D3/D4/D10); your row is §13 VX.2.
You own apps/web/src/app/channels/mapping/**. Your contracts are docs/vx1-contracts.md (FINAL when VX.1 publishes
it; until then build against typed fixtures shaped by design §3 and switch without a redesign).

[SHARED RULES — see docs/vx-prompts.md; they bind you verbatim.]

BUILD, on the DS only, inside the existing mapping page (never a new route; layout doc §4 names this page as the
global area): the `Variations` group under the selected category — Theme (Amazon: the PT enum listbox with its
labels; other channels: the row is absent, not disabled), Axes on channel (ordered rows: grip · axis label ·
target listbox from targetOptions or a free Input when freeform · include checkbox; unchecked = dropped, named),
Collisions (three radios with the fold target listbox and the separator input), Listing split, Value maps (counts
+ unreviewed count + a link to the existing value-map surface), Axis names (the informational line per channel,
verbatim from Appendix C), Preview SKU (the existing typeahead; opening the preview uses VX.1's
/studio/projection/preview for that SKU's family and renders the SAME preview dock the studio uses — one
component, in the DS, shared with VX.3; agree its name in the ledger with VX.3 before either builds it).
`<n> follow · <m> override [List]` at the group header from VX.1's counts; [List] opens /products/next with the
variation-mapping filter. Save = the PUT under reviewRequired with the blast-radius simulation shown BEFORE the
commit, counts verbatim from the server.

MEASURE: the group's rows at the mapping page's own row height, controls 28, copy verbatim; zero console errors;
the census and layout gates extended to this surface if they do not cover it (say which). Fixtures: rules on
Amazon·IT OUTERWEAR and eBay·IT 177104 only, announced in the ledger before saving.

DONE: every control has a row in a functionality matrix (control → what it does → endpoint → how verified →
result); web tsc + vitest + check-control-census + check-layout-v2 + raw-primitive ratchet + check-dark-alias-scope
bare exit 0; nothing committed. Then say "100% done" and stop.
```

## VX.3 — the studio: band, dock, preview, listings, codes

```
You are VX.3 — the studio lane of the Variation projection programme (VX). Your design is
docs/2026-09-12-variation-projection-design.md §10, §11.2, §11.3, §11.5 (what does NOT change); your row is §13
VX.3. DO NOT START until VP.F has written "100% done" in docs/pes-claims.md — until then every
_studio/variants/** path is VP.F's. You own _studio/variants/**, _studio/StudioBar.tsx (the listing listbox —
claim it), _studio/useWorkspaceDestination.ts (aliasKey from the URL — claim it), and DS additions under
apps/web/src/design-system/** with a claim (the `collides` projection word, the preview dock pieces). Contracts:
docs/vx1-contracts.md.

[SHARED RULES — see docs/vx-prompts.md; they bind you verbatim.]

BUILD, in this order, each measured on screen at 1440×900 signed in on GALE-JACKET and on VX-TEST-3AX:
1. Listing listbox in the scope bar's right slot (Primary · ② … · + New listing, the last HELD with the server's
   reason while creation is blocked — rendered, never hidden); aliasKey on the URL like listingId today; Amazon
   shows Primary only with the reason on hover. Shared state: one projection column per coordinate including
   aliases (`eBay · IT ②`; market suffix rule VP.F D11 unchanged).
2. Mapping band: source words (`Follows rule <label>` / `Overridden here`), the collision Tag when non-zero,
   `Preview` beside `Edit mapping`; one row at 1280.
3. Dock sections in §11.2 order — source row with Override / Reset to rule; include toggle per family axis with
   `dropped on this channel`; Values with the `On <Channel> · <Market>` column carrying the provenance mark;
   Collisions with the server's summary and the resolver radios; Listing split and the lock banner unchanged. All
   visible at 900 for a three-axis family.
4. Preview dock in the same 420 track (segmented Mapping · Preview at the dock header): Buyer view, Payload
   (Parent/Child, mono, Copy), Changes since last publish; warnings as a Banner above. ONE component in the DS,
   shared with VX.2 — agree its name in the ledger first.
5. ⋯ menu items (Change variation theme… / Relist with new specifics… / Change options…) → Modal md rendering
   the ThemeChangePlan (steps, keeps, loses) with the single `Copy plan` button. No live run exists; do not build
   one.
6. Sixth projection word `collides` in design-system/grid/renderers/projection.ts with tone from
   readinessMeta('missing','row'); the cell's next click opens the dock's Collisions section.
7. Manage shared axes: the axis picker over CustomAttribute(per_variant) with inline create; axis cell editors
   over AttributeOption with inline create. No Labels tab.

MEASURE before and after (the VP.F method): band heights, control heights, dock section order and fit at 900,
copy verbatim to Appendix C, console errors, and a functionality matrix for every control you add.

DONE: the matrix complete; web tsc, `npx vitest run _studio`, check-ag-grid-import-boundary, check-editor-open,
check-control-census (signed in, all surfaces measured), check-layout-v2, raw-primitive ratchet,
check-dark-alias-scope all bare exit 0 on one clean run; nothing committed. Then say "100% done" and stop.
```

## VX.4 — catalogue filters, bulk verb, readiness items

```
You are VX.4 — the catalogue lane of the Variation projection programme (VX). Your design is
docs/2026-09-12-variation-projection-design.md §4 M5, §11.4, §12; your row is §13 VX.4. You own
apps/web/src/app/products/next/** (filters, the bulk verb, FamilyFooter) and the readiness item kinds in
services/pim/scope-readiness.service.ts — BUT the LX build owns ReadinessIndex: before touching readiness, write
a ledger request naming the four item kinds (mapping-missing, collision, unreviewed-value-map, theme-unset) and
build the uncached computation only if LX has not landed LX.5; the catalogue filter must then say the numbers are
uncached. Contracts: docs/vx1-contracts.md.

[SHARED RULES — see docs/vx-prompts.md; they bind you verbatim.]

BUILD: the `Variation mapping` filter (follows rule · overridden · collisions · missing · theme unset, per channel
and market) on the /products/next grid, fed by the index or the uncached read (stated on screen); the bulk verb
`Apply mapping rule…` on the selection: dry-run count from the server (`<n> families · <m> overrides removed ·
<k> new collisions`), apply = null the overrides on the chosen coordinates through the projection PATCH with one
CAS per row, a results table, and families with an unresolved collision LISTED and skipped, never touched;
FamilyFooter shows the selection's counts. DS only; the grid's existing filter and bulk-modal patterns are the
substrate — no second modal shape.

MEASURE: filter round-trip time on the prod-shaped catalogue (338 products / 37 roots at last count — re-measure)
and put it in the ledger; the dry-run's counts match a read-only SQL count you write alongside.

DONE: functionality matrix; web tsc + vitest + census/layout gates bare exit 0; nothing committed; the readiness
request answered or the uncached path labelled. Then say "100% done" and stop.
```

## VX.F — final pass

```
You are VX.F — the FINAL PASS on the Variation projection programme (VX). The four lanes VX.1–VX.4 built it and
closed; you own all their paths. Your job: make every state in docs/2026-09-12-variation-projection-design.md
§10–§11 identical to the design and to the Information sheet's vocabulary, prove it with numbers, delete every
fixture/stub the lanes left, and remove VX-TEST-3AX at the very end with a ledger line.

[SHARED RULES — see docs/vx-prompts.md; they bind you verbatim.]

METHOD (VP.F's): BEFORE table (every band, control, section order, copy, console errors on: shared state with
aliases; channel state with the dock; the preview dock; the plan modal; the mapping page's Variations group; the
catalogue filter + bulk dry-run) → FIX → AFTER table + a FUNCTIONALITY MATRIX covering every control on every
surface (control → does → endpoint → verified how → result). Re-run VX.1's preview ≡ live test and precedence
characterisation test on the finished tree. Defaults for anything open are §15's; the Owner overrules in the
ledger.

DONE means, and only means: AFTER table at the design's numbers; matrix complete; all gates bare exit 0 on one
clean run of the finished tree (web tsc, api tsc, vitest web + api, check-ag-grid-import-boundary,
check-editor-open, check-control-census signed in, check-layout-v2, raw-primitive ratchet,
check-dark-alias-scope); the projection read on GALE not slower than VX.1's phase-1 number; VX-TEST-3AX deleted
and read back gone; nothing committed. Then say "100% done" and stop.
```
