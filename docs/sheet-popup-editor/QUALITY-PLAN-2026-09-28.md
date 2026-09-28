# Sheet pop-up editor — quality plan (2026-09-28)

Status: **APPROVED 2026-09-28** (Owner: "I'll go with your recommendations … For everything else, I'll go with your recommendations.") — the plan and Q-D1 … Q-D4 = (a). Lane B runs in a new session (prompt: `LANE-B-PROMPT.md`). **Each slice still starts only on the Owner's "build <slice>".**
**A1 approved 2026-09-28** (Owner: "Please continue. Go ahead." after "Can I start A1 now?"). **A1 built — local commit, not pushed** (§4.6). **A1b approved** (Owner: "Yes, I'll go with your recommendation.") and built (§4.7). **A1c approved** (Owner: "I'll go with your recommendations.") and built (§4.8).
It replaces the loose next steps in `PLAN-2026-09-27.md` §10 for the work that is left.

## 0. What the Owner asked (2026-09-28)

> "Let's actually write a structured plan to do everything in a proper way so that everything is built of high quality,
> instead of doing low-quality work for each thing and then continuing with the implementation of it. Obviously, there are
> multiple attributes of meta fields as well, so we also need to work on those and make sure everything's AAA quality and
> there are no errors at all. If you want, I can start a new session on those, and we can start a new work tree and a new
> branch."

Earlier the same day: *"each channel could potentially have different axes … I should be able to directly add or edit axes
from here … for Amazon we … have to choose from the list. This scenario has to be taken into account at all costs."* and *"I
should be able to create custom [axes]. I should be able to name them myself."* — decisions P3-D1 (b), P3-D2 (a), P3-D3 (a).

## 1. The quality bar ("AAA", in checks we can run)

A slice is done only when **every** line below is true. No line is skipped because it is inconvenient.

| # | Check | How it is proven |
|---|---|---|
| Q1 | Every scenario of the slice (§4, §5) works on real data | browser run on the private copy, each scenario ticked with a screenshot; production read-only where local cannot (Owner's word) |
| Q2 | No silent failure | every refusal shows one plain sentence with the reason and what to do; no control is disabled without its reason on screen |
| Q3 | No errors | 0 console errors, 0 failed network requests, 0 React warnings during the scenario run (Chrome console + network log saved) |
| Q4 | What you see is what is sent | a parity test per publisher: the payload built from the sheet equals the payload the publisher sends |
| Q5 | Nothing is lost | open + close with no change writes nothing; Esc throws away; a conflict (someone else saved) says "reload", never overwrites |
| Q6 | Design system only | DS components and tokens only, no new Tailwind classes, every DS file mirrored to `apps/factory`, catalog entry for a new DS piece |
| Q7 | Works for everyone | keyboard only; screen-reader labels; light and dark; phone (≤ 640 px, full-width sheet) and desktop |
| Q8 | Tests | unit + API tests for every rule and every refusal; the editor-open browser gate has arms for every new editor; a real-PostgreSQL test where two saves can race |
| Q9 | Gates | `npm run typecheck` for every changed workspace; area tests; `node scripts/ci/run-static-gates.mjs`; CI green |
| Q10 | Safe to publish on GitHub | real-id scan of every commit against the private copy's ids; made-up ids in tests and fixtures |
| Q11 | Reviewed | a self-review against this table + `/code-review` on the diff before the PR; findings fixed or written down |
| Q12 | Recorded | PLAN progress line, HANDOFF, memory; the PR text lists what was checked and what was not |

## 2. How we work (the process)

1. **Research** — read the code and the real data (read-only). Write facts with file:line.
2. **Spec** — for each slice: the screens (text mock), the scenario list with the expected result, the refusals with their
   exact sentences, the data changes, the files. In this document.
3. **Owner approves the slice** — the words "build <slice>". A choice between options is not a build approval.
4. **Build** — small commits, tests first for rules and refusals.
5. **Verify** — every Q-line of §1, in the browser on the private copy.
6. **PR** — one PR per slice group, no auto-merge. The Owner merges.

## 3. Where things stand (2026-09-28)

- **PR #124** (P0 design-system pickers + live drag, P1 Shopify cell pop-ups) — open, **CI green** (after a re-run).
- **PR #127** (P2 variation theme pop-up, Shared scope) — open, stacked on #124, **CI green** (after two re-runs).
- CI note: the "PostgreSQL 17" job takes 7 min 22 s to 9 min 50 s on every PR (5 runs measured) and its limit is 600 s
  (`scripts/run-real-postgres-tests.mjs:185`). Any PR can fail by chance. Not this lane's file; the Owner decides (§8, note N1).
- **Uncommitted** on `feat/sheet-popup-channel-axes` (started too early, paused): the server half of channel-only axes
  (§4.3). API typecheck passes; 13 new tests and 735 area tests pass. See decision Q-D2.
- Open items carried from HANDOFF: production read-only Shopify check after #124 merges; phone width not checked; the
  editor-open gate not run for the new editors; the Variants tab still reads value order from the eBay listing (VTR step 2).

## 4. Workstream A — variation theme on channel scopes (P3)

### 4.1 Rules per channel (decided)

| Channel | Pick / reorder / remove Shared axes | Channel-only axis from the channel's list | Axis under your own name | Values of a channel-only axis |
|---|---|---|---|---|
| eBay | yes | yes — the category's variation-enabled aspects | yes (P3-D1 b), ≤ 40 characters; refused: a name eBay lists for the category but not for variations (error 219451); not in eBay's search filters | an aspect: its eBay column per variant · an own name: a Shared per-variant attribute (P3-D2 a) |
| Shopify | yes | — | yes, ≤ 255 characters, unique (P3b) | a Shared per-variant attribute |
| Etsy | yes | — (P3a) | yes — Etsy's two custom slots (API property ids 513 / 514); saved, not published yet | a Shared per-variant attribute |
| Amazon | **theme list only** | **no** | **no** | Amazon's theme decides |

Limits count Shared and channel-only axes together: eBay 5, Shopify 3, Etsy 2, Amazon = the widest theme.

### 4.2 Scenarios (each one is an acceptance test in the browser)

eBay, a DRAFT listing (private copy: `xavia-knee-slider`, eBay · IT, category offers Taglia / Colore / Adatta; the family has Colore only):

| # | Do | Expected |
|---|---|---|
| A-E1 | Open the pop-up | rows: channel name, where it comes from ("from Shared: Color" / "only on eBay"), value chips, "N variants empty" when any; header "Follows Shared" or "Own setup"; limit line "1 of 5 specifics · 8 of 250 variants" |
| A-E2 | Drag Colore below a second axis, Enter, reopen | same order; the eBay payload sends that order |
| A-E3 | + Add → "Only on eBay" → Adatta | row added, "8 variants empty"; Enter saves; the Adatta column on the variant rows takes one value per variant; after filling, the warning goes away |
| A-E4 | + Add → "Your own name" → "Stile" → Values from → a Shared attribute | saved; row says "not in eBay's search filters"; values come from the attribute |
| A-E5 | Own name "Marca" (eBay lists it, not for variations) | refused before save: "eBay lists Marca for this category, but not for variations. eBay refuses it as a variation specific (error 219451). Choose another name." |
| A-E6 | Own name of 41 characters / empty / same as another axis | refused before save with the matching sentence |
| A-E7 | Add a sixth axis | "+ Add" is shown disabled with the visible reason "eBay takes at most 5 specifics." |
| A-E8 | Remove Colore while variants would collide | refused: the collision sentence names the variants; nothing saved |
| A-E9 | Rename Colore to another eBay aspect | only names from eBay's list are offered |
| A-E10 | Reset to Shared | own setup cleared; header "Follows Shared" |
| A-E11 | Same pop-up on a LIVE listing | set changes refused with "changing the set relists it"; reorder works |
| A-E12 | Listing with no category | reason shown; own names disabled with the reason |
| A-E13 | "New attribute" when no attribute fits | a per-variant attribute is created with your name; it appears under Values from; its column can be filled on the variant rows |
| A-E14 | Publish (Trading, Inventory, the older eBay push) | each payload carries the channel-only axis with the sheet's values (parity tests) |
| A-E15 | Esc; open + close without a change; another user saved meanwhile | nothing written; nothing written; "This listing changed. Reload." |

Amazon: A-A1 theme list only, one line "Amazon decides the axes. Choose a theme from its list.", no own axes · A-A2 pick a theme,
dropped axes named, collisions refused · A-A3 live listing locked (new parent).
Etsy: A-T1 own name + Values from, "Nexus keeps Etsy variations but does not publish them yet." · A-T2 at most 2 axes.
Shopify (P3b): A-S1 own option, free name ≤ 255, Values from · A-S2 at most 3 options · A-S3 options sent with the Shared
attribute values (parity test) · A-S4 a product already on Shopify: set change refused (no option-update call exists yet).
Everywhere: A-X1 keyboard only · A-X2 light and dark · A-X3 phone width · A-X4 zero console errors · A-X5 screen-reader labels.

### 4.3 Design (server)

- A channel-only axis is stored as a key that names where its values live: `own:channel:<column>` or `own:shared:<attribute>`
  (`packages/shared/variation-mapping.ts`), in the stores that exist today (eBay `_variationAxes`, others `variationMapping`).
  No migration.
- One value reader for everyone: `apps/api/src/services/pim/variation-own-axes.ts` (sheet cell, save checks, publishers).
- The resolver marks each channel-only axis bound or refused with a reason; it offers eBay's unused variation aspects with
  their fill counts (`ownCandidates`), says whether own names are allowed (`ownNames`) and gives the chips (`valueSummary`).
- The save accepts a channel-only axis only when its source is real (a variation-enabled column here, or a Shared per-variant
  attribute); names, limits, 219451 and collisions are refused by the same checks every axis goes through.
- Publishers: eBay Trading and Inventory read the values through the same builder; the older eBay push declares the axis
  under its eBay name and gets the Shared-attribute values on each row.
- Read route for "Values from": `GET /api/products/:id/studio/own-axis-sources?market=`.
- Missing values: **see Q-D3** (save allowed and publish blocked, or save refused).

### 4.4 Design (pop-up)

```
┌ Variation theme · eBay · IT ─────────────── Own setup · Reset to Shared ┐
│ ⠿ Colore       from Shared: Color   [Nero] [Blu] [Verde] …              │
│ ⠿ Adatta       only on eBay         8 variants empty ⚠                  │
│ ⠿ Stile        your name · not in eBay's search filters   [Slim] [Regular]│
│ + Add a specific                                                        │
│    From Shared ─ …    Only on eBay ─ Taglia · 0 of 8 filled              │
│    Your own name ─ [ Stile        ]  Values from [ Fit ▾ ]  New attribute│
│ 3 of 5 specifics · 8 of 250 variants                                    │
│ Enter saves · Esc cancels                                               │
└─────────────────────────────────────────────────────────────────────────┘
```

Same shell as P2: under the cell, `media` box, no Save/Cancel buttons, one key line, full-width sheet on a phone. DS pieces:
`OrderedList` (live drag), `MediaChipField`/`TokenChip` (chips), `Listbox`/`MediaPickList` (the add groups), `Input`
(name), existing notice styles. A new DS piece only if the spec shows a gap; then catalog + factory mirror first.

### 4.5 Slices (Workstream A)

| Slice | What | PR |
|---|---|---|
| A0 | This spec, approved by the Owner | — |
| A1 | Server: key, value reader, resolver, save checks, read route, publishers; API tests incl. a PGlite save test on an eBay fixture and parity tests (Trading, Inventory, older push) | P3a |
| A2 | Pop-up on eBay, Amazon, Etsy; web tests; editor-open gate arms; browser run of A-E1…A-E15, A-A*, A-T*, A-X* | P3a |
| A3 | "New attribute" from the pop-up (`POST /api/attributes`, scope `per_variant`) — only after checking the new attribute shows as a column on the variant rows | P3a |
| A4 | Shopify own options: workspace, publisher, parity test, lab; A-S1…A-S4 | P3b |

### 4.6 A1 — done (2026-09-28, local commit on `feat/sheet-popup-channel-axes`, not pushed)

What A1 contains (server only; the pop-up is A2):
- Key `own:channel:<column>` / `own:shared:<attribute>` (`packages/shared/variation-mapping.ts`); one value reader
  (`pim/variation-own-axes.ts`); resolver: bound or refused with a reason, `ownCandidates`, `ownNames`, `valueSummary`;
  save: source checks + every existing check; read route `GET /studio/own-axis-sources`; publishers: the studio builder
  (Trading and Inventory), the older eBay push and the eBay family-axes read (`ebayRowAxes`).
- **Found and fixed in the review:** (1) three builders spell an aspect's key differently — all now use the sheet's column key
  and compare keys the tolerant way the family axes do; (2) the eBay order editor would have written a channel-only axis back
  under its NAME (it then reads as a family axis the family lacks) — it now writes the key; (3) the presentation order put a
  channel-only axis last — it now ranks it by name; (4) a stored channel-only axis with a refused name was only a WARNING
  off Amazon, so publish would have sent the refused name — it is now an ERROR everywhere.
- Readers checked and left as they are: `routes/ebay-cockpit.routes.ts` (returns the raw list; no web reader),
  `ebay-image-axis-preference`, `ebay-variation-order-apply`, `ebay-flat-file-attributes` (keeps `_variationAxes*` as is),
  `variation-rule-view` (override test works with the key), `routes/matrix.routes.ts` (passes the mapping through), and the
  Amazon-only `variationMapping` readers (Amazon never stores a channel-only key: the save refuses it).
- Checks: typecheck web / api / shared 0; 59/59 static gates; new tests: shared 17, own-axes unit 16, database save test 7
  (profiles off and on), publish parity 4, order editor 3, presentation 1, older push 2; area run: the same 3 failures as a
  clean copy of the branch against the private database (data / database-name dependent) and the same 19 with profiles on —
  **0 new failures**. Real route on the private copy: "Marca" refused with the 219451 sentence; "Adatta" saved, 8 empty
  variants listed; REGAL-JACKET's Scollatura candidate reads 40 of 40 filled; reset restored.
- **Finding, not fixed (needs your word): a channel theme save does not refresh the readiness index.** The row shows the
  error at once, but the header ("eBay · Ready 100%") and the catalogue filters keep the old state until another write of the
  family. This was true before P3 for every channel theme change (`writeProjectionMapping` never calls
  `produceReadinessForProducts`, which `setFamilyAxes` does). The fix moves that save into the content transaction
  (`inDatabaseTransaction`) so the readiness producer can run — it touches every channel theme save, so it is its own small
  slice (**A1b**) with its own tests.

### 4.7 A1b — a channel theme save refreshes the readiness index (2026-09-28)

- `writeProjectionMapping` now writes inside the content transaction (`inDatabaseTransaction`, Serializable, retried on a
  lost race) and runs `produceReadinessForProducts` for this coordinate only, before the commit — as `setFamilyAxes` does.
  The theme save, the eBay order save and Reset all take this path.
- Proven: database test — no eBay index row before; after the save one parent row, state `blocked`, `missing` holds
  `value-missing` with the row's own sentence; after Reset no gap and no collision; Shared rows untouched (profiles off and
  on). Browser on the private copy: header "eBay · Ready" → save → "eBay · Blocked" → Reset → "eBay · Ready"; the save took
  0.9 s. Area tests: 0 new failures (same 3 / 19 as a clean copy). Real-PostgreSQL suites: the three that race this save (first theme save, draft listings, live listings) pass; one unrelated suite (live product sync, test 9, a retry claimed "now") failed once and passed 14/14 on a rerun — a timing flake, no changed file in its path.
- **Same gap, not fixed (your word needed): the include / exclude save** (`writeProjectionInclusion`) also changes gaps and
  collisions and does not refresh the index either. Same fix, same size (A1c).

### 4.8 A1c — include / exclude refreshes the readiness index too (2026-09-28)

- `writeProjectionInclusion` now writes inside the content transaction and runs `produceReadinessForProducts` for this
  coordinate before the commit (a lost race is retried, then answered "reload" by the version check, as before).
- Proven: database test — ticking out the variant with the gap clears it from the index, ticking it back brings it back
  (profiles off and on); a mutation check (the producer call removed) makes that test fail. Private stack, real routes:
  8 empty variants → exclude one → the index says 7 → include it → 8 → Reset. Area tests: 0 new failures. Real-PostgreSQL
  suites: all pass (exit 0), including the draft-listings, live-listings and first-theme-save races.
- Note: excluding a variant also lowers its `isPublished` (by design: a tick never restores publishing). The check did this
  to one variant of the private copy; it was set back by hand there. Production data was never touched.

## 5. Workstream B — Shopify metafields, every type (AAA)

### 5.1 What the Owner's store really uses (read only, 2026-09-28, through the Shopify connector; nothing changed)

- **39 metafield definitions:** 25 on products, 14 on variants. All "ALL_VALID" in Shopify.
- **11 types in use:** single-line text (14, one with a choice list, one list of text with max 100 characters × 10),
  entry lists (`list.metaobject_reference`, 9), one entry (`metaobject_reference`, 5), product lists
  (`list.product_reference`, 3, max 10), rating (1, scale 1–5), whole number (2), true/false (1), page (1, "Size Chart"),
  file (1, variant swatch image), colour (1, variant swatch colour).
- **22 entry kinds (metaobject definitions).** The fields inside them use: single-line text, multi-line text, colour,
  file (with "Image" / "Video" / "Image or Video" limits), URL, product, true/false, id, list of text, and — in Shopify's
  own **Color** entry kind (the category "Color" metafield) — `product_taxonomy_value_reference` and its list (required:
  "Base color" 1–4 values and "Base pattern").
- Shopify itself has many more types (new measurement types, language, link, …). The live list comes from the store
  (`metafieldDefinitionTypes`), never from a list we type by hand.

### 5.2 What Nexus does today (read-only code inventory, spot-checked)

Cell save is always a Nexus draft (`POST /shopify-linked/cells` → `saveShopifySheetCells`); publish = `/preview` then
`/synchronize` (`metafieldsSet` with a compare digest, 25 per batch, read back after). Entry "Add new" / "Edit" writes to
Shopify at once (`metaobjectCreate` / `metaobjectUpdate`), gated by the publish permission and live publish mode.

| Area | Today | Gap (must be fixed for AAA) |
|---|---|---|
| The 11 store types | editors exist for all 11 | **no tests at all** for colour, multi-line text; no display tests for any non-reference type; never checked against the real store |
| Entry lists / one entry | chips + tick list + Add / Edit / copy (P1) | the file picker is not filtered by the field's file type (`linked-products-gateway.ts:171`) — a wrong file is refused only at publish; nested entries cannot be added from inside an entry; one read-only field blocks saving the whole entry kind; "copy" sends every field and fails on an unsupported one; new handle `nexus-<uuid>`; no entry delete; never run against a real store |
| Shopify's **Color** entries (category metafield) | older picker for taxonomy values, which in practice needs a typed raw id | a proper taxonomy value picker (Base color, Base pattern) — without it "Add new entry" for Color cannot work |
| date and time | plain text box, check is `Date.parse` (`shopify-linked-products.ts:230`) | a date-time picker and a strict ISO check |
| 27 newer measurement types | editor exists | the cell shows raw JSON: they are missing from `STRUCTURED` (`metafieldDisplay.ts:71, 118`) |
| Unit spelling | long names only (`kilograms`) | Shopify's docs use long names; older values may hold `kg`. Read both, write long names — confirm on Shopify's docs + a test |
| mixed / disclosure references | older "choose a type first" picker | move onto the new pop-up or show honest read-only |
| json, jurisdiction | fallback text box, misleading hint for jurisdiction | a checked JSON box with the schema error in plain words; correct hint |
| Unknown / future types | read-only with a reason | keep; add one test per type in Shopify's live list proving "edits correctly or is read-only with a reason — never crashes" |
| Pop-up footer | "Saves in Nexus · Publish to send it to Shopify" | true for cells; the entry editor must say "Saves to Shopify now" everywhere it writes (it does in its confirm; check every path) |
| Lab `/design/shopify-popup` | 6 types, no entry editor | every type in §5.1 + an entry editor per field type, made-up data |
| Cold store schema (09-24 trap) | **fixed** on this branch (stored copy, never cache a set without fields, banner + reload) | a store never read still shows the banner until the first read ends — keep the banner honest, add a test |

### 5.3 Scenarios (acceptance, per type)

For **every type in §5.1** (and each entry field type): B-1 the cell shows the value like Shopify's bulk editor (picture,
swatch, stars, chips) · B-2 the pop-up opens under the cell with the right editor · B-3 a valid edit + Enter saves a draft ·
B-4 each validation the definition carries refuses with Shopify's rule in plain words (min, max, regex, choices, list.max,
file type, entry kind, scale) · B-5 Esc and open+close write nothing · B-6 Publish preview lists the change; synchronize
sends it; the read-back matches · B-7 a Shopify refusal comes back as one plain sentence on the cell · B-8 keyboard only,
light/dark, phone.
Entries: B-E1 add a new entry of each kind used by a product metafield (13 kinds) · B-E2 edit one · B-E3 copy one · B-E4 a
Color entry with Base color + Base pattern · B-E5 a file field limited to "Image" refuses a video in the picker, not at
publish.

### 5.4 Where it can be tested

- Local has no Shopify keys (production logins are KMS-sealed) and no local listing is linked to Shopify.
- So: the lab page (made-up store, every type), API tests with a stand-in gateway, and a fixture built from Shopify's live
  type list.
- **Real writes** (entries, publish) need a real store: **see Q-D4**.

### 5.5 Slices (Workstream B)

| Slice | What | PR |
|---|---|---|
| B0 | Spec sign-off; a made-up store fixture with every Shopify type and the store's 22 entry kinds; the lab shows all of them | B-1 |
| B1 | The 11 store types: display, editor, codec, validation, draft save, publish — one test per layer per type; B-1…B-8 in the lab and with the stand-in gateway | B-1 |
| B2 | Entries: file-type-filtered file picker, taxonomy value picker (Color), nested entries, copy without unsupported fields, clear "Saves to Shopify now", B-E1…B-E5 | B-2 |
| B3 | Every other Shopify type: measurement display fix, date-time picker + strict check, unit spelling, json box, mixed references; the "never crashes" test over the live type list | B-3 |
| B4 | Real-store proof (Q-D4), then one read-only look on production with the Owner's word | — |

## 6. Two lanes, no clashes

| | Lane A — variation theme on channels | Lane B — Shopify metafields |
|---|---|---|
| Session | this one | a new session (the Owner starts it) |
| Worktree / branch | `/private/tmp/nexus-sheet-popup-editor`, `feat/sheet-popup-channel-axes` | `/private/tmp/nexus-shopify-metafields`, `feat/shopify-metafields-aaa` |
| Branch from | `origin/main` after #124 and #127 merge (else stacked on #127) | `origin/main` after #124 merges (else stacked on #124) |
| Owns | `grid/editors/AxesPanelEditor.tsx`, `variationFamily.ts`, `renderers/variationTheme.tsx`, `pim/variation-*`, `family-projection*`, `stored-variation-projection.ts`, eBay publishers' axis reads; P3b: `shopify/content-workspace.service.ts`, `content-publisher.ts` option code | `_studio/shopify/*`, `renderers/{MetafieldValue.tsx,metafieldDisplay.ts}`, `packages/shared/shopify-*`, `shopify/linked-*`, `shopify/channel-sheet.service.ts`, `channel-specs/shopify*.ts`, the lab |
| Shared, claim first, one lane at a time | design-system media pickers (`MediaPickList`, `MediaChipField`, `MediaOrderedList`, `ResourcePickerDialog`, `OrderedList`), `editorBox.ts`, `grid.css`, `scripts/check-editor-open.mjs`, CHANGELOG, DS-GAPS, the factory mirror | same |
| Private stack | pg `nexus-popup-pg` :55523 db `nexus_popup_test`, redis :6403, API :8099, web :3109 | own containers `nexus-metafields-pg` :55524 (a dump of `nexus_popup_test`) and `nexus-metafields-redis` :6404, API :8100, web :3110 |

## 7. Order of work

1. The Owner merges **#124**, then **#127** (both green).
2. The Owner answers Q-D1 … Q-D4 and approves this plan.
3. Lane A: A1 → A2 → A3 (PR P3a) → A4 (PR P3b). Each slice starts only on "build <slice>".
4. Lane B: B0 → B1 → B2 → B3 → B4. Same rule.

## 8. Decisions for the Owner

**Q-D1 — Two lanes or one?**
- (a) Two sessions at once: this session keeps the variation theme (Lane A); a new session takes Shopify metafields (Lane B),
  with its own worktree, branch and ports (§6). **Recommended** — the two share almost no files.
- (b) One session: Lane A first, then Lane B.

**Q-D2 — The server code I started too early (uncommitted, tests pass).**
- (a) Keep it as the start of slice A1. It is re-reviewed line by line against §1 before any commit. **Recommended.**
- (b) Throw it away and rebuild A1 from the spec.

**Q-D3 — A new channel-only axis whose variants have no values yet.**
- (a) The save is allowed. The pop-up and the readiness list show the empty variants. Publish is blocked until they are
  filled — the same rule Shared axes already follow. **Recommended.**
- (b) The save is refused until every variant has a value.

**Q-D4 — How to prove Shopify writes (entries, publish) without risk.**
- (a) A free Shopify **development store** connected to the local Nexus: real writes, no risk to the live store. You create
  it once (an account step only you can do); I prepare every other step. **Recommended.**
- (b) Test writes on the live store with a clearly named test item, each time only with your word.

Notes (no decision needed now):
- **N1** — the CI "PostgreSQL 17" job runs 7.4–9.9 min against a 10-min limit (`scripts/run-real-postgres-tests.mjs:185`),
  so any PR can fail by chance. A small separate fix (split the suite or raise the limit) belongs to whoever owns CI.
- **N2** — Amazon SP-API secret rotation deadline 2026-10-19 21:05 UTC.

## 9. Evidence

- Store census: the Shopify connector, `metafieldDefinitions(ownerType: PRODUCT | PRODUCTVARIANT)` and
  `metaobjectDefinitions`, read only, 2026-09-28. No ids from it are written here.
- Code inventory: read-only helper report, spot-checked (`metafieldDisplay.ts:71, 118`; `shopify-linked-products.ts:230`;
  `ShopifyDraftCell.tsx:185`). One helper claim was wrong and is left out: Shopify's product metafield definitions have no
  "required" flag (`MetafieldDefinition` has no such field).
- Variation theme facts: `PLAN-2026-09-27.md` §10 (file:line table) and the uncommitted slice's tests.
