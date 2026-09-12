# The writability matrix (D14.1) — GALE-JACKET × four coordinates

**Lane:** SC.1 (`nexus-commerce-22 [7a7bc1]`), under hub rulings #490 / #492 / #493 / #513 / #542.
**Spec:** `docs/2026-09-02-wave4-design.md` §3, D14.1.
**Subject:** `GALE-JACKET`, `cmokmy3a40078pm0p1fvnu523`, productType `OUTERWEAR`, 21 rows
(1 parent + 20 variants). **Filed:** 2026-09-02.

## 0. The headline

D14.1 asks that every declared column on every coordinate be one of three things — **writes and
persists**, **refused with the reason shown in the cell**, or **follows master (a projection, and
the cell says so)** — and that #449's fourth category, *offered but never attemptable*, be gone.

**The fourth category is gone. A successor to it is here, on one scope, and it is the Owner's
complaint:**

| coordinate | declared | writes and persists | refused, cell says why | follows master | **offered, refused by the WRITE PATH, cell silent** |
|---|---:|---:|---:|---:|---:|
| master DE/de | **96** | 23 | 11 (+3 parent-row) | 0 | **59** |
| Amazon·DE/de | **96** | 63 | 11 (+3 parent-row) | 19 | 0 |
| Amazon·IT/it | **97** | 62 | 11 (+5 parent-row) | 19 | 0 |
| eBay·IT/it | **35** | 17 | 9 (+3 parent-row) | 6 | 0 |

On the **master scope**, 60 of 60 `attr_*` columns — `color`, `item_name`, `bullet_point`,
`product_description`, `country_of_origin`, `fabric_type`, `care_instructions` among them — are
declared `writable: true`, `writeBlockedReason: null`, `editable: true`, and are **rejected by the
write path** with `400 "Unknown or read-only category attribute"`. (59 in the table plus
`condition_type`, which is counted once in the refused column because the cell does say no to that
one.) That is *"I'm unable to write a lot of attributes still, such as color"* — measured, on the
scope where an operator meets it. **It is not the field's fault:** the same field on the same
product accepts a write one scope over. See §5, F2.

**The denominator is per coordinate.** There is no single "declared columns" number for this
product — the set is per market, and `xracing` declares 114–119 where GALE-JACKET declares 96–97.
Every count carries its own.

> ## ⏱ READ §10 BEFORE QUOTING THE TABLE ABOVE
> **The 59 is HISTORICAL.** It was measured at 07:19–07:44 on 2026-09-02 and PES.2 + PES.5 closed it
> the same hour. As of **08:19:15 the master row is 0**, verified by `scripts/check-writability.mjs`
> against the route's own `validationMarketplace()`. This document keeps what was measured when it
> was measured — §10 records what moved and what re-measured it. A finding without its clock is a
> claim about the present that was true about the past.

## 1. Method, and every stamp

Read in-process with `app.inject()` against the production database. Read endpoints only, except
the three writes in §4 — all on the XAVIA fixture, all reverted. In-process means the build measured
is the **source at the mtimes below**, not whichever pid holds `:8091`; that process turns over on
any sibling's API-side write, which is why no pid is quoted.

| file | mtime | what it is authority for |
|---|---|---|
| `studio-sheet.service.ts` | **2026-09-02 07:19:33** | the cell contract (§2, §3) |
| `sheet-columns.service.ts` | 2026-09-02 06:39:32 | the column set |
| `product-studio.routes.ts` | 2026-09-02 06:26:15 | the read coordinate |
| `products.routes.ts` | 2026-09-02 06:37:28 | **the write path** (§4, §5 F2) |
| `field-registry.service.ts` | 2026-05-04 17:26:12 | **the write path's refusal** (§5 F2, F6) |

Stamps were captured **inside** the probe, before and after each run, and were stable across each.

> ⚠ **The build moved twice during this pass, and it changed two findings.** The column half was
> first taken on `studio-sheet.service.ts` 06:18:16, where `writable: false` and
> `writeBlockedReason` were **0 on all four coordinates** — no cell could refuse anything. Re-taken
> on 07:19:33 they are 14 / 14 / 16 / 12, every one carrying a sentence. **PES.5 fixed that between
> the two runs**, so the finding this document would have filed against it is withdrawn as already
> landed, and only the re-take is reported. #470's rule earned its keep: the figures below are the
> 07:19:33 ones.

**Build control (#499):** `color` and `size` must read `scope: per_variant`. They do. A first run at
06:39:25 read them `global` — it started 7 s before `sheet-columns.service.ts` landed — and is
discarded rather than reported.

**Coordinates.** `scope=` is always sent: `channel=` without it silently returned master before #483
and now 400s. Locale follows the market.

| name | query | what its writer sends to the write path |
|---|---|---|
| master DE/de | `?scope=master&market=DE&locale=de` | **no `marketplaceContext`** (`masterWrite.ts:87–101`) |
| Amazon·DE/de | `?scope=channel&channel=AMAZON&market=DE&locale=de` | `marketplaceContexts: [{AMAZON, DE}]` (`useChannelSheet.ts:230`) |
| Amazon·IT/it | `?scope=channel&channel=AMAZON&market=IT&locale=it` | `marketplaceContexts: [{AMAZON, IT}]` |
| eBay·IT/it | `?scope=channel&channel=EBAY&market=IT&locale=it` | `marketplaceContexts: [{EBAY, IT}]` |

Column counts come from the contract; where widths are quoted they come from AG's column model,
never from `.ag-header-cell` elements, which virtualise horizontally (#483).

## 2. #458 holds — the fourth category is closed

Every declared column yields a cell on every row, on every coordinate:

| coordinate | declared | `/studio/sheet` columns | same set & order | cells per row (min/max) | rows short | never-attemptable |
|---|---:|---:|---|---|---:|---:|
| master DE/de | 96 | 96 | yes | 96 / 96 | 0 | **0** |
| Amazon·DE/de | 96 | 96 | yes | 96 / 96 | 0 | **0** |
| Amazon·IT/it | 97 | 97 | yes | 97 / 97 | 0 | **0** |
| eBay·IT/it | 35 | 35 | yes | 35 / 35 | 0 | **0** |

#449's shape — 97 declared, 21 cells, 76 columns with no cell on any row — does not reproduce
anywhere. What replaced it is a cell that exists, is offered, and is refused elsewhere.

## 3. Routing, per coordinate

| coordinate | → override bag (`writeVerb: channel`) | → ChannelListing column (prefixed) | → MASTER (`affectsAllChannels`) |
|---|---:|---:|---:|
| master DE/de | 0 | 0 | 96 (it *is* master) |
| Amazon·DE/de | 58 | 4 (`description`, `name`, `item_name`, `product_description`) | **34** |
| Amazon·IT/it | 59 | 4 (same) | **34** |
| eBay·IT/it | **0** | 2 (`description`, `name`) | **33** |

`affectsAllChannels` is surfaced: `channelWriteGate` returns `acknowledge` and the operator is told
before committing (`channel/rows.ts:112`, ruling #58). It is *not* surfaced on the drawer's
equivalent path beyond `RecordField.tsx:167`.

**Provenance and follow state, measured:**

| coordinate | `follows` non-null | columns holding a value at the channel layer | `inherited` true on some row | `mapped` non-null |
|---|---:|---:|---:|---:|
| master DE/de | 0 | — | 14 | 0 |
| Amazon·DE/de | 6 | **0** | 14 | 62 |
| Amazon·IT/it | 6 | **1** (`country_of_origin`) | 14 | 63 |
| eBay·IT/it | 3 (all `true`) | **0** | **0** | 2 |

## 4. The observed writes — one per distinct write path

Executed against `studio-sheet.service.ts` **06:57:51** and `products.routes.ts` **06:37:28** — the
write path is unchanged since, and W1's cell still reads `writable: true` / `writeBlockedReason:
null` on the current 07:19:33 build, so F2 stands as measured.

The verb alone under-counts: `writeVerb` takes two values but the routing takes **three** paths, so
three writes were made, each disclosed to the hub before execution (#492, #513), each read back and
reverted. The write path accepts **no `reason` parameter** — `Validated` is
`{id, field, value, cascade, target}` — so the marker rides in the sentinel value.

| # | path | coordinate & cell | result |
|---|---|---|---|
| W1 | `writeVerb: master` → `writeTarget: master` | master DE/de, parent, `weave_type` → `attr_weave_type` | **REFUSED — `400 "Unknown or read-only category attribute"`** |
| W2 | `writeVerb: channel` → `writeTarget: channelListing` (override bag) | Amazon·IT, child `GALE-JACKET-BLACK-MEN-3XL`, `color` → `attr_color`, `target: 'channel'` | **writes and persists** |
| W3 | `writeVerb: master` → `writeTarget: channelListing` (prefixed) | Amazon·DE **unpublished**, child `GALE-JACKET-BLACK-MEN-XXS`, `item_name` → `amazon_title` | **writes, persists, and the cell never shows it** |

**W1, in full.** Contract before the write: `value "Not applicable"`, `layer master`,
`writeVerb master`, `writeTarget master`, `writeField attr_weave_type`, `writable true`,
`writeBlockedReason null`, `editable true`, kind `text`, cap 260, row version 11. `PATCH
/api/products/bulk {changes:[{id, field:"attr_weave_type", value:"SC1-VERIFY"}], expectedVersion:11}`
→ **400**, `errors: [{field:"attr_weave_type", error:"Unknown or read-only category attribute"}]`.
Read back: unchanged, version still 11. Nothing was written, so nothing needed reverting.

**W2, in full.** Before: `value null`, `layer default`, `pinned false`, listing `cmp26aoku00elrx01ovjpslvk`
v81, `overrideData.color` absent. After `PATCH {…, target:'channel', marketplaceContext:{channel:'AMAZON',
marketplace:'IT'}}` → 200 `updated: 1`; `overrideData.color === "SC1-VERIFY"`, listing **v81 → v82**,
`Product.categoryAttributes.color` verified **untouched**; the cell reads back `"SC1-VERIFY"` at
`layer "channel"`, `pinned: true`. Reverted by **key removal** (`overrideData - 'color'`) because a
merge write cannot express *absent*; key verified gone, cell re-read `null` at `layer "default"`.

**W3, in full.** Target chosen for `isPublished: false` per #513. Before: listing `cmp26amb1002prx01nhabgy85`
v15, `listingStatus DISCOVERABLE`, ASIN `B0DJ4926YX`, title 131 chars. `PATCH {field:"amazon_title",
value:<original + " [SC1]">, marketplaceContext:{AMAZON, DE}}` → 200 `updated: 1`;
`ChannelListing.title` verified ending `"[SC1]"`. **Then the sheet's `item_name` cell for that row on
Amazon·DE still read the master value at `layer: "master"`** — the change the cell routed is not the
value the cell shows. Restored byte-identical (`title === original`).

Two facts fell out of W3 that belong to whoever fixes it:

- **The prefixed route does not bump `ChannelListing.version`** (15 → 15) while the override route
  does (81 → 82). Two channel write paths, one CAS token, and only one of them moves it.
- **`isPublished: false` is not evidence a listing is dark.** That row carries a real ASIN shared
  with FR and ES. The write was safe because there is no push path — verified: the bulk PATCH
  creates no sync item, `BULK_OP_APPLIED` maps only to an SSE `product.updated` plus a read-cache
  refresh (`product-event.service.ts:112`), and `listing-reconciliation.service.ts` pulls and
  requires operator confirmation — **not** because of the flag.

**Residue.** W1's two PATCHes both 400'd before the `BulkOperation` create and left nothing. Actual
permanent residue is **3 `BulkOperation` rows and 3 `AuditLog` rows** (W2's write, W3's write and
restore); `AuditLog` is immutable by trigger (#491) and these rows stay. W2's key removal was raw
SQL and wrote no audit row.

## 5. The findings, with their owners

**F1 — `writable` was a constant; PES.5 fixed it mid-pass. WITHDRAWN as already landed.**
On `studio-sheet.service.ts` 06:18:16 `resolveWriteRouting` ended `writable: true,
writeBlockedReason: null` on every path, so `writable: false` and `writeBlockedReason` were 0 on all
four coordinates and the client's only reason-showing branch (`channel/rows.ts:112`, `affordanceOf`'s
`blocked`) was unreachable. On 07:19:33 the cell builder supplies `cellBlockedReason`
(`studio-sheet.service.ts:1048`) and the counts are 14 / 14 / 16 / 12, each with a sentence. Recorded
because the matrix's first reading was taken against it, not as an open item.

**F1a — one of those new sentences is wrong on master.** Eleven columns on **master DE/de** carry
*"Read-only on this channel — the marketplace does not accept a value for this field."* — on a scope
that has no channel. The variant-axis sentences are right ("Set on each variant — this is a variation
axis, so the family row has no single value", and the identity-code wording for `ean`/`gtin`/`upc`).
→ **PES.5**, one string.

**F2 — 🔴 THE FINDING. The master scope cannot write any schema-derived attribute, and the cell says
nothing.** 60 of 60 `attr_*` columns on master DE/de are refused by the write path. Verified end to
end, in three places and with a discriminating control:

- **Observed** (W1, §4): `PATCH` of `attr_weave_type` on the parent → `400 "Unknown or read-only
  category attribute"`, nothing written, value verified unchanged.
- **Replayed read-only over every column**: with the marketplace the master writer actually sends
  (`null`), `getFieldDefinition` accepts **0 of 60**. With the marketplace a channel writer sends,
  it accepts **57 of 58** (Amazon·DE) and **58 of 59** (Amazon·IT) — the single refusal being
  `condition_type`, which the cell also refuses, honestly.
- **The control that rules out "the field is read-only"**: `attr_weave_type` → `marketplace: null`
  **ABSENT**; `marketplace: "DE"` **found, `editable: true`**; `marketplace: "IT"` **found,
  `editable: true`**. Same for `attr_color`. The field is writable; the request is not.
- **The cause, one line**: `field-registry.service.ts:420` — `if (!context.marketplace) return
  undefined` — refuses every dynamic `attr_*` id when no marketplace is supplied.
  `products.routes.ts:1401` passes `primaryContext?.marketplace ?? null`, and
  `masterWrite.ts:87–101` sends `changes` + `expectedVersion` and **no `marketplaceContext`**.

The contract computed `writable: true` **with the scope's market in hand**; the write threw the
market away. → **PES.2** sends the sheet's scope on the master write (the hub's routing, #542);
**PES.5** makes the no-context refusal name itself instead of returning a bare 400.

**F3 — the prefixed channel route writes where its own cell does not read.**
W3 (§4): `ChannelListing.title` verifiably ended `"[SC1]"` and the `item_name` cell on Amazon·DE went
on showing the master value at `layer: "master"`. A cell advertising `writeField: amazon_title`,
`writeTarget: channelListing` routes an edit to a place it does not read back from — the operator
sees their edit vanish. And that route **does not bump `ChannelListing.version`** (15 → 15) where the
override route does (81 → 82): one CAS token, two channel write paths, one of them silent. → **PES.5**.

**F4 — refusal-without-a-reason via `editable`: FIXED mid-pass, same window as F1.** On 06:18:16 the
11 / 11 / 11 / 9 `editable: false` columns carried no reason at all; on 07:19:33 all of them do, and
the parent-row cases (`ean`/`gtin`/`upc` everywhere, `color`/`size` on Amazon·IT) carry a per-row
sentence. Recorded, not open — except F1a's wording.

**F5 — eBay·IT has no channel write route at all.** 33 of 35 columns are `writeVerb: master` /
`writeTarget: master` / `affectsAllChannels: true`; 2 take the prefixed column route; **zero** reach
`overrideData`. Cause measured, not inferred: eBay·IT declares **no `categoryAttributes` columns
whatever** (storage: 34 `column` + 1 `localizedContent`), and `routesToOverride` requires
`storage !== 'column'`. So on eBay, D14.2's "writes as a PIN" does not exist and **94% of that sheet
edits the shared master record**. `inherited` is true on 0 eBay columns against Amazon's 14.
→ ruled an **honest-notice requirement until eBay attributes exist**.

**F6 — the write path re-parses every cached schema once per `attr_*` change.**
`getFieldDefinition` falls through to `loadCachedSchemas(marketplace, [])` — empty product types
meaning *all* — and runs `schemaToFieldDefinitions` over **every returned row** for **every** id it is
asked about, returning at the first hit. Validating N attribute changes in one bulk PATCH re-parses
the schema set N times; a 50-row cascade of one attribute pays it 50 times. Measured consequence:
exercising it across ~100 columns took ~20 minutes wall-clock on this machine. Also
`loadCachedSchemas` hard-codes `channel: 'AMAZON'`, so an eBay coordinate would scan Amazon schemas
(inert here — eBay declares no `attr_*` columns). Not a correctness bug; a scale one, and it sits
directly under D14.8. → **PES.5**.

**F7 — the pin is nearly unexercised in production data.** Across all four coordinates every column
is a pure projection on every row except one: `country_of_origin` on Amazon·IT holds a value at the
channel layer. 96 of 96 on Amazon·DE and 35 of 35 on eBay·IT hold none. Any acceptance that leans on
a pinned cell must create one first — which is what W2 did, and reverted.

## 6. D14.5 — the threshold measurement

Measured on `xracing`, the **largest family in the catalogue** (50 rows; the next four — AIREON,
VENTRA-JACKET, REGAL-JACKET, IT-MOSS-JACKET — are 41, 41, 41, 31). Build stamp
`studio-sheet.service.ts` **07:19:33**. Byte figures are load-independent.

| coordinate | rows × columns | payload | per row |
|---|---|---:|---:|
| master IT/it | 50 × **119** | **2,157 KB** | 43.1 KB |
| Amazon·IT/it | 50 × **114** | **2,808 KB** | 56.2 KB |

Larger rows synthesised **read-only**, by duplicating the measured response in memory and
serialising it — never a write, and no row count in the database changed:

| rows | master IT/it | Amazon·IT/it |
|---:|---:|---:|
| 200 | 8.19 MB | 10.70 MB |
| **500** | **20.36 MB** | **26.63 MB** |
| 1000 | 40.63 MB | 53.16 MB |

**Two corrections to §3.2 D14.5's stated numbers.** The design's "measured payload 2.2 MB at 50 →
~22 MB at 500 is the ceiling" took #458's *extrapolation* from GALE-JACKET's 44 KB/row. Measured on
the real 50-row family it is **2.81 MB at 50** and **26.6 MB at 500** on a channel scope — because
`xracing` declares 114–119 columns where GALE-JACKET declares 96–97. **The client-side ceiling
should be set from 26.6 MB, not 22 MB**, and the design's own rule (set the threshold from the
measurement, not from a choice) points at a lower row count for the same byte budget.

**First paint is NOT MEASURED.** There is no origin serving a 500-row family; a first-paint number
without one would be invented (hub ruling #493). What *is* measured is server build time — §6.1 —
and on a channel scope it is the constraint that binds first: **4.9 s cold for 50 rows**, before a
byte reaches a browser, against a design that contemplates 500.

### 6.1 The server build time, and its condition

| reading | load (1-min) | server `tookMs` | note |
|---|---:|---:|---|
| `xracing` Amazon·IT, cold | 4.2 → 5.0 | **4,867** | re-take |
| `xracing` Amazon·IT, warm | 5.0 → 5.5 | **1,233**, then 2,013 | two consecutive |
| `xracing` master IT, cold | 5.5 | 5,360 | |
| `xracing` master IT, warm | 5.5 | 909 | |
| ~~`xracing` Amazon·IT~~ | *not captured* | ~~9,045~~ | **withdrawn** — taken 06:55:06 CEST, inside the 06:40–07:13 saturation window (six concurrent repo-wide `tsc` runs, load 20+); does not reproduce |

PES.5 profiled the same read inside the request at load 2.89: 4,155 ms cold, 1,028 ms warm, row
build 11 ms. The re-take corroborates them. **Every timing here carries its 1-minute load.** Banked:
a duration measured without its load is not a measurement — my first one was not labelled, and the
label is what let it be withdrawn cleanly rather than argued about.

## 7. D14.2 "Follow master again" and D14.3 provenance chips — what exists

Measured from source and contract; nothing built (§3.4 assigns both elsewhere).

**D14.2 — the restore verb does not exist in the studio.**
- The server carries `follows` for **six** field keys only (`FOLLOW_BY_KEY`,
  `studio-sheet.service.ts:392`, mapping 10 column keys onto `followMasterTitle` /
  `Description` / `Price` / `Quantity` / `BulletPoints`). Every other column returns
  `follows: null` — deliberately, and the comment says so. Measured: 6 columns on Amazon, 3 on
  eBay·IT, 0 on master.
- `FollowsCell` **exists** in the DS grid renderers (`design-system/grid/renderers/cells.tsx:411`)
  and renders `Follows master` / `Pinned`, with a title that already says "clear to follow master
  again". **The studio does not mount it** — its only consumers are `products/_sheet/MasterSheet.tsx`
  (the catalogue sheet) and the grid lab. Grep for `FollowsCell` under
  `_studio/` returns nothing.
- There is **no "Follow master again" verb** anywhere in the studio: no menu item, no drawer action.
  `masterWrite.ts:96` names the mechanism in a comment — "a channel scope resets by clearing
  `*Override` and restoring `followMaster*`… PES.3 owns that `commit`" — and no code does it.
- So D14.2 needs, in order: the server to carry a follow state for more than six fields (or the
  design to say that six is the set), the studio to mount `FollowsCell`, and PES.4/PES.3 to add the
  verb. → **PES.4** (drawer), **PES.3** (cell menu), **PES.5** (the state beyond six fields).

**D14.3 — chips exist; the provenance chips and their server counts do not.**
- The registry is live: `useRegisterViewChip` / `useViewChips` (`contracts.tsx:222`). Four chips are
  registered today — `missing-required` (master **and** channel), `channel-warnings`,
  `mapping-errors` (`ChannelSheet.tsx:683–685`), `ai-drafts` (`useAiDraftLayer.ts:85`).
- **All counts are computed client-side from the loaded rows** (`channel/viewChips.ts`), which is
  honest today and cannot survive D14.5's server-paged sheet: above the threshold the client holds
  a page, so a client-side count would answer for the page while looking like an answer for the
  family. `viewChips.ts` already has the right vocabulary for that — `count: null` means "nobody
  has counted" and renders numberless rather than printing a false `0`.
- None of §9.6's provenance families (`Pinned · Inherited · Mapped · Formula · AI`) is a chip. The
  facts are all on the wire per cell (`pinned`, `inherited`, `mapped.status`, `formula`), and
  `classifyProvenance` already derives the §9.6 member — so the chip is a producer over facts that
  exist, not new data. What does **not** exist is a server count.
- → **PES.5** (counts per §9.6 family on the sheet contract), **PES.2/PES.3/AG.1** (the chips in the
  toolbar's chip slot), **UX.1** (a provenance chip is a filter, neutral tone, per #362).

## 8. The probe witness (D14.1's structural re-check) — cross-lane request to UX.1

UX.1 owns `scripts/check-layout-v2.mjs`; SC.1 files the assertion rather than adding a probe file
(brief constraint: witnesses go through UX.1). **Three assertions, not one** — the first is D14.1's
stated witness and the other two are what this pass showed it does not catch.

**W-1 (D14.1 as written) — every declared column yields a cell, on every row, on both scopes.**

```
for each coordinate C in {master DE/de, Amazon·DE/de, Amazon·IT/it, eBay·IT/it}:
    cols = GET /api/products/<id>/studio/columns?<C>      // scope= ALWAYS present
    sheet = GET /api/products/<id>/studio/sheet?<C>
    assert  sheet.columns.map(key) == cols.columns.map(key)          // same set, same order
    for each row r in sheet.rows:
        assert  Object.keys(r.values).length == cols.columns.length
        assert  cols.columns.every(c => c.key in r.values)
```
Measured green on all four: 96/96, 96/96, 97/97, 35/35, 21 rows each, zero rows short.

**W-2 — a cell that cannot be edited must say why.** This is the one that would have caught F4, and
it fails today (11/11/11/9 columns, plus the parent-row cases):
```
    for each cell v in r.values:
        assert  (v.writable !== false && v.editable !== false) || v.writeBlockedReason != null
```

**W-3 — a column the write path will refuse must not be declared writable.** This is the one that
would have caught F2 — the Owner's complaint — and it fails on the master scope, 60 of 60:
```
    for each column c where c.writeField startsWith "attr_":
        def = getFieldDefinition(c.writeField, { marketplace: <what THIS scope's writer sends> })
        assert  (def && def.editable) || cell(c).writeBlockedReason != null
```
The `marketplace` argument must be **what the scope's own writer sends**, not what the reader knows:
master sends `null` (`masterWrite.ts`), channel sends the market (`useChannelSheet.ts:230`). Reading
it from the coordinate instead of from the writer is precisely the substitution that hid F2 — the
contract had the market in hand and the write did not.

**Note on the denominator.** The assertion must take `cols.columns.length` per coordinate. Master DE
declares 96 and Amazon·IT 97 on this product; `xracing` declares 119 and 114. A witness with one
hard-coded number would pass on the wrong family.

## 9. Every declared column, per coordinate

Class definitions are §0's. `follows master` is recorded where a channel cell reads at `layer: master`
on at least one row — the state D14.2 calls the projection.

### master DE/de — 96 declared columns × 21 rows

- **offered, refused by the WRITE PATH, cell silent**: **59**
- writes and persists: **23**
- refused: **11**
- refused on the parent row: **3**

<details><summary>every declared column (96)</summary>

| column | class | route | `writeField` | note |
|---|---|---|---|---|
| `age_range_description` | **offered, refused by the WRITE PATH, cell silent** | `master` → MASTER | `attr_age_range_description` | `getFieldDefinition("attr_age_range_description", marketplace=null)` → absent; PATCH returns `400 Unknown or read-only category attribute` |
| `amazonAsin` | refused | `master` → MASTER | `amazonAsin` | “Read-only on this channel — the marketplace does not accept a value for this field.” |
| `amazon_browseNode` | refused | `master` → MASTER | `amazon_browseNode` | “Read-only on this channel — the marketplace does not accept a value for this field.” |
| `amazon_bullets` | refused | `master` → MASTER | `amazon_bullets` | “Read-only on this channel — the marketplace does not accept a value for this field.” |
| `amazon_description` | writes and persists | `master` → MASTER | `amazon_description` | no value on any row (`layer: default`) — writable, empty |
| `amazon_searchKeywords` | refused | `master` → MASTER | `amazon_searchKeywords` | “Read-only on this channel — the marketplace does not accept a value for this field.” |
| `amazon_title` | writes and persists | `master` → MASTER | `amazon_title` | no value on any row (`layer: default`) — writable, empty |
| `amazon_variationTheme` | writes and persists | `master` → MASTER | `amazon_variationTheme` | no value on any row (`layer: default`) — writable, empty |
| `basePrice` | writes and persists | `master` → MASTER | `basePrice` | holds a value on master |
| `batteries_included` | **offered, refused by the WRITE PATH, cell silent** | `master` → MASTER | `attr_batteries_included` | `getFieldDefinition("attr_batteries_included", marketplace=null)` → absent; PATCH returns `400 Unknown or read-only category attribute` |
| `batteries_required` | **offered, refused by the WRITE PATH, cell silent** | `master` → MASTER | `attr_batteries_required` | `getFieldDefinition("attr_batteries_required", marketplace=null)` → absent; PATCH returns `400 Unknown or read-only category attribute` |
| `brand` | writes and persists | `master` → MASTER | `brand` | holds a value on master |
| `bullet_point` | **offered, refused by the WRITE PATH, cell silent** | `master` → MASTER | `attr_bullet_point` | `getFieldDefinition("attr_bullet_point", marketplace=null)` → absent; PATCH returns `400 Unknown or read-only category attribute` |
| `buyBoxPrice` | refused | `master` → MASTER | `buyBoxPrice` | “Read-only on this channel — the marketplace does not accept a value for this field.” |
| `care_instructions` | **offered, refused by the WRITE PATH, cell silent** | `master` → MASTER | `attr_care_instructions` | `getFieldDefinition("attr_care_instructions", marketplace=null)` → absent; PATCH returns `400 Unknown or read-only category attribute` |
| `color` | **offered, refused by the WRITE PATH, cell silent** | `master` → MASTER | `attr_color` | `getFieldDefinition("attr_color", marketplace=null)` → absent; PATCH returns `400 Unknown or read-only category attribute` |
| `competitorPrice` | refused | `master` → MASTER | `competitorPrice` | “Read-only on this channel — the marketplace does not accept a value for this field.” |
| `condition_note` | **offered, refused by the WRITE PATH, cell silent** | `master` → MASTER | `attr_condition_note` | `getFieldDefinition("attr_condition_note", marketplace=null)` → absent; PATCH returns `400 Unknown or read-only category attribute` |
| `condition_type` | refused | `master` → MASTER | `attr_condition_type` | “Read-only on this channel — the marketplace does not accept a value for this field.” |
| `costPrice` | writes and persists | `master` → MASTER | `costPrice` | no value on any row (`layer: default`) — writable, empty |
| `country_of_origin` | **offered, refused by the WRITE PATH, cell silent** | `master` → MASTER | `attr_country_of_origin` | `getFieldDefinition("attr_country_of_origin", marketplace=null)` → absent; PATCH returns `400 Unknown or read-only category attribute` |
| `department` | **offered, refused by the WRITE PATH, cell silent** | `master` → MASTER | `attr_department` | `getFieldDefinition("attr_department", marketplace=null)` → absent; PATCH returns `400 Unknown or read-only category attribute` |
| `description` | writes and persists | `master` → MASTER | `description` | no value on any row (`layer: default`) — writable, empty |
| `dimHeight` | writes and persists | `master` → MASTER | `dimHeight` | no value on any row (`layer: default`) — writable, empty |
| `dimLength` | writes and persists | `master` → MASTER | `dimLength` | no value on any row (`layer: default`) — writable, empty |
| `dimUnit` | writes and persists | `master` → MASTER | `dimUnit` | no value on any row (`layer: default`) — writable, empty |
| `dimWidth` | writes and persists | `master` → MASTER | `dimWidth` | no value on any row (`layer: default`) — writable, empty |
| `dsa_responsible_party_address` | **offered, refused by the WRITE PATH, cell silent** | `master` → MASTER | `attr_dsa_responsible_party_address` | `getFieldDefinition("attr_dsa_responsible_party_address", marketplace=null)` → absent; PATCH returns `400 Unknown or read-only category attribute` |
| `ean` | refused on the parent row | `master` → MASTER | `ean` | “Set on each variant — an identity code belongs to the individual product, not the family.” (parent row only; writable on variants) |
| `ebayItemId` | refused | `master` → MASTER | `ebayItemId` | “Read-only on this channel — the marketplace does not accept a value for this field.” |
| `ec_medical_device_sales_channel` | **offered, refused by the WRITE PATH, cell silent** | `master` → MASTER | `attr_ec_medical_device_sales_channel` | `getFieldDefinition("attr_ec_medical_device_sales_channel", marketplace=null)` → absent; PATCH returns `400 Unknown or read-only category attribute` |
| `fabric_type` | **offered, refused by the WRITE PATH, cell silent** | `master` → MASTER | `attr_fabric_type` | `getFieldDefinition("attr_fabric_type", marketplace=null)` → absent; PATCH returns `400 Unknown or read-only category attribute` |
| `fit_type` | **offered, refused by the WRITE PATH, cell silent** | `master` → MASTER | `attr_fit_type` | `getFieldDefinition("attr_fit_type", marketplace=null)` → absent; PATCH returns `400 Unknown or read-only category attribute` |
| `fulfillmentChannel` | writes and persists | `master` → MASTER | `fulfillmentChannel` | no value on any row (`layer: default`) — writable, empty |
| `generic_keyword` | **offered, refused by the WRITE PATH, cell silent** | `master` → MASTER | `attr_generic_keyword` | `getFieldDefinition("attr_generic_keyword", marketplace=null)` → absent; PATCH returns `400 Unknown or read-only category attribute` |
| `ghs_chemical_h_code` | **offered, refused by the WRITE PATH, cell silent** | `master` → MASTER | `attr_ghs_chemical_h_code` | `getFieldDefinition("attr_ghs_chemical_h_code", marketplace=null)` → absent; PATCH returns `400 Unknown or read-only category attribute` |
| `gpsr_safety_attestation` | **offered, refused by the WRITE PATH, cell silent** | `master` → MASTER | `attr_gpsr_safety_attestation` | `getFieldDefinition("attr_gpsr_safety_attestation", marketplace=null)` → absent; PATCH returns `400 Unknown or read-only category attribute` |
| `gtin` | refused on the parent row | `master` → MASTER | `gtin` | “Set on each variant — an identity code belongs to the individual product, not the family.” (parent row only; writable on variants) |
| `handmade_classification` | **offered, refused by the WRITE PATH, cell silent** | `master` → MASTER | `attr_handmade_classification` | `getFieldDefinition("attr_handmade_classification", marketplace=null)` → absent; PATCH returns `400 Unknown or read-only category attribute` |
| `is_expiration_dated_product` | **offered, refused by the WRITE PATH, cell silent** | `master` → MASTER | `attr_is_expiration_dated_product` | `getFieldDefinition("attr_is_expiration_dated_product", marketplace=null)` → absent; PATCH returns `400 Unknown or read-only category attribute` |
| `is_this_product_subject_to_buyer_age_restrictions` | **offered, refused by the WRITE PATH, cell silent** | `master` → MASTER | `attr_is_this_product_subject_to_buyer_age_restrictions` | `getFieldDefinition("attr_is_this_product_subject_to_buyer_age_restrictions", marketplace=null)` → absent; PATCH returns `400 Unknown or read-only category attribute` |
| `item_name` | **offered, refused by the WRITE PATH, cell silent** | `master` → MASTER | `attr_item_name` | `getFieldDefinition("attr_item_name", marketplace=null)` → absent; PATCH returns `400 Unknown or read-only category attribute` |
| `item_package_quantity` | **offered, refused by the WRITE PATH, cell silent** | `master` → MASTER | `attr_item_package_quantity` | `getFieldDefinition("attr_item_package_quantity", marketplace=null)` → absent; PATCH returns `400 Unknown or read-only category attribute` |
| `item_type_name` | **offered, refused by the WRITE PATH, cell silent** | `master` → MASTER | `attr_item_type_name` | `getFieldDefinition("attr_item_type_name", marketplace=null)` → absent; PATCH returns `400 Unknown or read-only category attribute` |
| `league_name` | **offered, refused by the WRITE PATH, cell silent** | `master` → MASTER | `attr_league_name` | `getFieldDefinition("attr_league_name", marketplace=null)` → absent; PATCH returns `400 Unknown or read-only category attribute` |
| `lifestyle` | **offered, refused by the WRITE PATH, cell silent** | `master` → MASTER | `attr_lifestyle` | `getFieldDefinition("attr_lifestyle", marketplace=null)` → absent; PATCH returns `400 Unknown or read-only category attribute` |
| `lowStockThreshold` | writes and persists | `master` → MASTER | `lowStockThreshold` | no value on any row (`layer: default`) — writable, empty |
| `manufacturer` | writes and persists | `master` → MASTER | `manufacturer` | no value on any row (`layer: default`) — writable, empty |
| `map_policy` | **offered, refused by the WRITE PATH, cell silent** | `master` → MASTER | `attr_map_policy` | `getFieldDefinition("attr_map_policy", marketplace=null)` → absent; PATCH returns `400 Unknown or read-only category attribute` |
| `material` | **offered, refused by the WRITE PATH, cell silent** | `master` → MASTER | `attr_material` | `getFieldDefinition("attr_material", marketplace=null)` → absent; PATCH returns `400 Unknown or read-only category attribute` |
| `maxPrice` | writes and persists | `master` → MASTER | `maxPrice` | no value on any row (`layer: default`) — writable, empty |
| `max_order_quantity` | **offered, refused by the WRITE PATH, cell silent** | `master` → MASTER | `attr_max_order_quantity` | `getFieldDefinition("attr_max_order_quantity", marketplace=null)` → absent; PATCH returns `400 Unknown or read-only category attribute` |
| `merchant_release_date` | **offered, refused by the WRITE PATH, cell silent** | `master` → MASTER | `attr_merchant_release_date` | `getFieldDefinition("attr_merchant_release_date", marketplace=null)` → absent; PATCH returns `400 Unknown or read-only category attribute` |
| `merchant_shipping_group` | **offered, refused by the WRITE PATH, cell silent** | `master` → MASTER | `attr_merchant_shipping_group` | `getFieldDefinition("attr_merchant_shipping_group", marketplace=null)` → absent; PATCH returns `400 Unknown or read-only category attribute` |
| `merchant_suggested_asin` | **offered, refused by the WRITE PATH, cell silent** | `master` → MASTER | `attr_merchant_suggested_asin` | `getFieldDefinition("attr_merchant_suggested_asin", marketplace=null)` → absent; PATCH returns `400 Unknown or read-only category attribute` |
| `minMargin` | writes and persists | `master` → MASTER | `minMargin` | no value on any row (`layer: default`) — writable, empty |
| `minPrice` | writes and persists | `master` → MASTER | `minPrice` | no value on any row (`layer: default`) — writable, empty |
| `model_name` | **offered, refused by the WRITE PATH, cell silent** | `master` → MASTER | `attr_model_name` | `getFieldDefinition("attr_model_name", marketplace=null)` → absent; PATCH returns `400 Unknown or read-only category attribute` |
| `model_number` | **offered, refused by the WRITE PATH, cell silent** | `master` → MASTER | `attr_model_number` | `getFieldDefinition("attr_model_number", marketplace=null)` → absent; PATCH returns `400 Unknown or read-only category attribute` |
| `name` | writes and persists | `master` → MASTER | `name` | holds a value on master |
| `number_of_items` | **offered, refused by the WRITE PATH, cell silent** | `master` → MASTER | `attr_number_of_items` | `getFieldDefinition("attr_number_of_items", marketplace=null)` → absent; PATCH returns `400 Unknown or read-only category attribute` |
| `number_of_lithium_ion_cells` | **offered, refused by the WRITE PATH, cell silent** | `master` → MASTER | `attr_number_of_lithium_ion_cells` | `getFieldDefinition("attr_number_of_lithium_ion_cells", marketplace=null)` → absent; PATCH returns `400 Unknown or read-only category attribute` |
| `number_of_lithium_metal_cells` | **offered, refused by the WRITE PATH, cell silent** | `master` → MASTER | `attr_number_of_lithium_metal_cells` | `getFieldDefinition("attr_number_of_lithium_metal_cells", marketplace=null)` → absent; PATCH returns `400 Unknown or read-only category attribute` |
| `parentAsin` | refused | `master` → MASTER | `parentAsin` | “Read-only on this channel — the marketplace does not accept a value for this field.” |
| `parentage_level` | **offered, refused by the WRITE PATH, cell silent** | `master` → MASTER | `attr_parentage_level` | `getFieldDefinition("attr_parentage_level", marketplace=null)` → absent; PATCH returns `400 Unknown or read-only category attribute` |
| `part_number` | **offered, refused by the WRITE PATH, cell silent** | `master` → MASTER | `attr_part_number` | `getFieldDefinition("attr_part_number", marketplace=null)` → absent; PATCH returns `400 Unknown or read-only category attribute` |
| `pattern` | **offered, refused by the WRITE PATH, cell silent** | `master` → MASTER | `attr_pattern` | `getFieldDefinition("attr_pattern", marketplace=null)` → absent; PATCH returns `400 Unknown or read-only category attribute` |
| `productType` | writes and persists | `master` → MASTER | `productType` | holds a value on master |
| `product_description` | **offered, refused by the WRITE PATH, cell silent** | `master` → MASTER | `attr_product_description` | `getFieldDefinition("attr_product_description", marketplace=null)` → absent; PATCH returns `400 Unknown or read-only category attribute` |
| `product_expiration_type` | **offered, refused by the WRITE PATH, cell silent** | `master` → MASTER | `attr_product_expiration_type` | `getFieldDefinition("attr_product_expiration_type", marketplace=null)` → absent; PATCH returns `400 Unknown or read-only category attribute` |
| `product_site_launch_date` | **offered, refused by the WRITE PATH, cell silent** | `master` → MASTER | `attr_product_site_launch_date` | `getFieldDefinition("attr_product_site_launch_date", marketplace=null)` → absent; PATCH returns `400 Unknown or read-only category attribute` |
| `product_tax_code` | **offered, refused by the WRITE PATH, cell silent** | `master` → MASTER | `attr_product_tax_code` | `getFieldDefinition("attr_product_tax_code", marketplace=null)` → absent; PATCH returns `400 Unknown or read-only category attribute` |
| `recommended_browse_nodes` | **offered, refused by the WRITE PATH, cell silent** | `master` → MASTER | `attr_recommended_browse_nodes` | `getFieldDefinition("attr_recommended_browse_nodes", marketplace=null)` → absent; PATCH returns `400 Unknown or read-only category attribute` |
| `safety_data_sheet_url` | **offered, refused by the WRITE PATH, cell silent** | `master` → MASTER | `attr_safety_data_sheet_url` | `getFieldDefinition("attr_safety_data_sheet_url", marketplace=null)` → absent; PATCH returns `400 Unknown or read-only category attribute` |
| `shippingTemplate` | refused | `master` → MASTER | `shippingTemplate` | “Read-only on this channel — the marketplace does not accept a value for this field.” |
| `ships_globally` | **offered, refused by the WRITE PATH, cell silent** | `master` → MASTER | `attr_ships_globally` | `getFieldDefinition("attr_ships_globally", marketplace=null)` → absent; PATCH returns `400 Unknown or read-only category attribute` |
| `size` | **offered, refused by the WRITE PATH, cell silent** | `master` → MASTER | `attr_size` | `getFieldDefinition("attr_size", marketplace=null)` → absent; PATCH returns `400 Unknown or read-only category attribute` |
| `skip_offer` | **offered, refused by the WRITE PATH, cell silent** | `master` → MASTER | `attr_skip_offer` | `getFieldDefinition("attr_skip_offer", marketplace=null)` → absent; PATCH returns `400 Unknown or read-only category attribute` |
| `sku` | refused | `master` → MASTER | `sku` | “Read-only on this channel — the marketplace does not accept a value for this field.” |
| `special_size_type` | **offered, refused by the WRITE PATH, cell silent** | `master` → MASTER | `attr_special_size_type` | `getFieldDefinition("attr_special_size_type", marketplace=null)` → absent; PATCH returns `400 Unknown or read-only category attribute` |
| `status` | writes and persists | `master` → MASTER | `status` | holds a value on master |
| `style` | **offered, refused by the WRITE PATH, cell silent** | `master` → MASTER | `attr_style` | `getFieldDefinition("attr_style", marketplace=null)` → absent; PATCH returns `400 Unknown or read-only category attribute` |
| `subject_character` | **offered, refused by the WRITE PATH, cell silent** | `master` → MASTER | `attr_subject_character` | `getFieldDefinition("attr_subject_character", marketplace=null)` → absent; PATCH returns `400 Unknown or read-only category attribute` |
| `supplier_declared_dg_hz_regulation` | **offered, refused by the WRITE PATH, cell silent** | `master` → MASTER | `attr_supplier_declared_dg_hz_regulation` | `getFieldDefinition("attr_supplier_declared_dg_hz_regulation", marketplace=null)` → absent; PATCH returns `400 Unknown or read-only category attribute` |
| `supplier_declared_has_product_identifier_exemption` | **offered, refused by the WRITE PATH, cell silent** | `master` → MASTER | `attr_supplier_declared_has_product_identifier_exemption` | `getFieldDefinition("attr_supplier_declared_has_product_identifier_exemption", marketplace=null)` → absent; PATCH returns `400 Unknown or read-only category attribute` |
| `target_gender` | **offered, refused by the WRITE PATH, cell silent** | `master` → MASTER | `attr_target_gender` | `getFieldDefinition("attr_target_gender", marketplace=null)` → absent; PATCH returns `400 Unknown or read-only category attribute` |
| `team_name` | **offered, refused by the WRITE PATH, cell silent** | `master` → MASTER | `attr_team_name` | `getFieldDefinition("attr_team_name", marketplace=null)` → absent; PATCH returns `400 Unknown or read-only category attribute` |
| `temperature_rating` | **offered, refused by the WRITE PATH, cell silent** | `master` → MASTER | `attr_temperature_rating` | `getFieldDefinition("attr_temperature_rating", marketplace=null)` → absent; PATCH returns `400 Unknown or read-only category attribute` |
| `theme` | **offered, refused by the WRITE PATH, cell silent** | `master` → MASTER | `attr_theme` | `getFieldDefinition("attr_theme", marketplace=null)` → absent; PATCH returns `400 Unknown or read-only category attribute` |
| `title_differentiation` | **offered, refused by the WRITE PATH, cell silent** | `master` → MASTER | `attr_title_differentiation` | `getFieldDefinition("attr_title_differentiation", marketplace=null)` → absent; PATCH returns `400 Unknown or read-only category attribute` |
| `totalStock` | writes and persists | `master` → MASTER | `totalStock` | holds a value on master |
| `upc` | refused on the parent row | `master` → MASTER | `upc` | “Set on each variant — an identity code belongs to the individual product, not the family.” (parent row only; writable on variants) |
| `water_resistance_level` | **offered, refused by the WRITE PATH, cell silent** | `master` → MASTER | `attr_water_resistance_level` | `getFieldDefinition("attr_water_resistance_level", marketplace=null)` → absent; PATCH returns `400 Unknown or read-only category attribute` |
| `weave_type` | **offered, refused by the WRITE PATH, cell silent** | `master` → MASTER | `attr_weave_type` | `getFieldDefinition("attr_weave_type", marketplace=null)` → absent; PATCH returns `400 Unknown or read-only category attribute` |
| `weightUnit` | writes and persists | `master` → MASTER | `weightUnit` | no value on any row (`layer: default`) — writable, empty |
| `weightValue` | writes and persists | `master` → MASTER | `weightValue` | no value on any row (`layer: default`) — writable, empty |

</details>

### Amazon·DE/de — 96 declared columns × 21 rows

- writes and persists: **63**
- follows master (projection; the cell says so): **19**
- refused: **11**
- refused on the parent row: **3**

<details><summary>every declared column (96)</summary>

| column | class | route | `writeField` | note |
|---|---|---|---|---|
| `age_range_description` | writes and persists | `channel` → override bag | `attr_age_range_description` | no value on any row (`layer: default`) — writable, empty |
| `amazonAsin` | refused | `master` → MASTER | `amazonAsin` | “Read-only on this channel — the marketplace does not accept a value for this field.” |
| `amazon_browseNode` | refused | `master` → MASTER | `amazon_browseNode` | “Read-only on this channel — the marketplace does not accept a value for this field.” |
| `amazon_bullets` | refused | `master` → MASTER | `amazon_bullets` | “Read-only on this channel — the marketplace does not accept a value for this field.” |
| `amazon_description` | writes and persists | `master` → MASTER | `amazon_description` | no value on any row (`layer: default`) — writable, empty; **the write leaves this channel** (`affectsAllChannels`) |
| `amazon_searchKeywords` | refused | `master` → MASTER | `amazon_searchKeywords` | “Read-only on this channel — the marketplace does not accept a value for this field.” |
| `amazon_title` | writes and persists | `master` → MASTER | `amazon_title` | no value on any row (`layer: default`) — writable, empty; **the write leaves this channel** (`affectsAllChannels`) |
| `amazon_variationTheme` | writes and persists | `master` → MASTER | `amazon_variationTheme` | no value on any row (`layer: default`) — writable, empty; **the write leaves this channel** (`affectsAllChannels`) |
| `basePrice` | follows master (projection; the cell says so) | `master` → MASTER | `basePrice` | reads at `layer: master`; paints the master glyph; **the write leaves this channel** (`affectsAllChannels`) |
| `batteries_included` | writes and persists | `channel` → override bag | `attr_batteries_included` | no value on any row (`layer: default`) — writable, empty |
| `batteries_required` | follows master (projection; the cell says so) | `channel` → override bag | `attr_batteries_required` | reads at `layer: master`; paints the master glyph |
| `brand` | follows master (projection; the cell says so) | `master` → MASTER | `brand` | reads at `layer: master`; paints the master glyph; **the write leaves this channel** (`affectsAllChannels`) |
| `bullet_point` | writes and persists | `channel` → override bag | `attr_bullet_point` | no value on any row (`layer: default`) — writable, empty |
| `buyBoxPrice` | refused | `master` → MASTER | `buyBoxPrice` | “Read-only on this channel — the marketplace does not accept a value for this field.” |
| `care_instructions` | writes and persists | `channel` → override bag | `attr_care_instructions` | no value on any row (`layer: default`) — writable, empty |
| `color` | writes and persists | `channel` → override bag | `attr_color` | no value on any row (`layer: default`) — writable, empty |
| `competitorPrice` | refused | `master` → MASTER | `competitorPrice` | “Read-only on this channel — the marketplace does not accept a value for this field.” |
| `condition_note` | writes and persists | `channel` → override bag | `attr_condition_note` | no value on any row (`layer: default`) — writable, empty |
| `condition_type` | refused | `channel` → override bag | `attr_condition_type` | “Read-only on this channel — the marketplace does not accept a value for this field.” |
| `costPrice` | writes and persists | `master` → MASTER | `costPrice` | no value on any row (`layer: default`) — writable, empty; **the write leaves this channel** (`affectsAllChannels`) |
| `country_of_origin` | follows master (projection; the cell says so) | `channel` → override bag | `attr_country_of_origin` | reads at `layer: master`; paints the master glyph |
| `department` | writes and persists | `channel` → override bag | `attr_department` | no value on any row (`layer: default`) — writable, empty |
| `description` | writes and persists | `master` → ChannelListing column | `amazon_description` | no value on any row (`layer: default`) — writable, empty |
| `dimHeight` | writes and persists | `master` → MASTER | `dimHeight` | no value on any row (`layer: default`) — writable, empty; **the write leaves this channel** (`affectsAllChannels`) |
| `dimLength` | writes and persists | `master` → MASTER | `dimLength` | no value on any row (`layer: default`) — writable, empty; **the write leaves this channel** (`affectsAllChannels`) |
| `dimUnit` | writes and persists | `master` → MASTER | `dimUnit` | no value on any row (`layer: default`) — writable, empty; **the write leaves this channel** (`affectsAllChannels`) |
| `dimWidth` | writes and persists | `master` → MASTER | `dimWidth` | no value on any row (`layer: default`) — writable, empty; **the write leaves this channel** (`affectsAllChannels`) |
| `dsa_responsible_party_address` | writes and persists | `channel` → override bag | `attr_dsa_responsible_party_address` | no value on any row (`layer: default`) — writable, empty |
| `ean` | refused on the parent row | `master` → MASTER | `ean` | “Set on each variant — an identity code belongs to the individual product, not the family.” (parent row only; writable on variants); **the write leaves this channel** (`affectsAllChannels`) |
| `ebayItemId` | refused | `master` → MASTER | `ebayItemId` | “Read-only on this channel — the marketplace does not accept a value for this field.” |
| `ec_medical_device_sales_channel` | writes and persists | `channel` → override bag | `attr_ec_medical_device_sales_channel` | no value on any row (`layer: default`) — writable, empty |
| `fabric_type` | follows master (projection; the cell says so) | `channel` → override bag | `attr_fabric_type` | reads at `layer: master`; paints the master glyph |
| `fit_type` | writes and persists | `channel` → override bag | `attr_fit_type` | no value on any row (`layer: default`) — writable, empty |
| `fulfillmentChannel` | writes and persists | `master` → MASTER | `fulfillmentChannel` | no value on any row (`layer: default`) — writable, empty; **the write leaves this channel** (`affectsAllChannels`) |
| `generic_keyword` | writes and persists | `channel` → override bag | `attr_generic_keyword` | no value on any row (`layer: default`) — writable, empty |
| `ghs_chemical_h_code` | writes and persists | `channel` → override bag | `attr_ghs_chemical_h_code` | no value on any row (`layer: default`) — writable, empty |
| `gpsr_safety_attestation` | writes and persists | `channel` → override bag | `attr_gpsr_safety_attestation` | no value on any row (`layer: default`) — writable, empty |
| `gtin` | refused on the parent row | `master` → MASTER | `gtin` | “Set on each variant — an identity code belongs to the individual product, not the family.” (parent row only; writable on variants); **the write leaves this channel** (`affectsAllChannels`) |
| `handmade_classification` | writes and persists | `channel` → override bag | `attr_handmade_classification` | no value on any row (`layer: default`) — writable, empty |
| `is_expiration_dated_product` | writes and persists | `channel` → override bag | `attr_is_expiration_dated_product` | no value on any row (`layer: default`) — writable, empty |
| `is_this_product_subject_to_buyer_age_restrictions` | writes and persists | `channel` → override bag | `attr_is_this_product_subject_to_buyer_age_restrictions` | no value on any row (`layer: default`) — writable, empty |
| `item_name` | follows master (projection; the cell says so) | `master` → ChannelListing column | `amazon_title` | reads at `layer: master`; paints the master glyph |
| `item_package_quantity` | writes and persists | `channel` → override bag | `attr_item_package_quantity` | no value on any row (`layer: default`) — writable, empty |
| `item_type_name` | writes and persists | `channel` → override bag | `attr_item_type_name` | no value on any row (`layer: default`) — writable, empty |
| `league_name` | writes and persists | `channel` → override bag | `attr_league_name` | no value on any row (`layer: default`) — writable, empty |
| `lifestyle` | writes and persists | `channel` → override bag | `attr_lifestyle` | no value on any row (`layer: default`) — writable, empty |
| `lowStockThreshold` | writes and persists | `master` → MASTER | `lowStockThreshold` | no value on any row (`layer: default`) — writable, empty; **the write leaves this channel** (`affectsAllChannels`) |
| `manufacturer` | writes and persists | `master` → MASTER | `manufacturer` | no value on any row (`layer: default`) — writable, empty; **the write leaves this channel** (`affectsAllChannels`) |
| `map_policy` | writes and persists | `channel` → override bag | `attr_map_policy` | no value on any row (`layer: default`) — writable, empty |
| `material` | writes and persists | `channel` → override bag | `attr_material` | no value on any row (`layer: default`) — writable, empty |
| `maxPrice` | writes and persists | `master` → MASTER | `maxPrice` | no value on any row (`layer: default`) — writable, empty; **the write leaves this channel** (`affectsAllChannels`) |
| `max_order_quantity` | writes and persists | `channel` → override bag | `attr_max_order_quantity` | no value on any row (`layer: default`) — writable, empty |
| `merchant_release_date` | writes and persists | `channel` → override bag | `attr_merchant_release_date` | no value on any row (`layer: default`) — writable, empty |
| `merchant_shipping_group` | follows master (projection; the cell says so) | `channel` → override bag | `attr_merchant_shipping_group` | reads at `layer: master`; paints the master glyph |
| `merchant_suggested_asin` | follows master (projection; the cell says so) | `channel` → override bag | `attr_merchant_suggested_asin` | reads at `layer: master`; paints the master glyph |
| `minMargin` | writes and persists | `master` → MASTER | `minMargin` | no value on any row (`layer: default`) — writable, empty; **the write leaves this channel** (`affectsAllChannels`) |
| `minPrice` | writes and persists | `master` → MASTER | `minPrice` | no value on any row (`layer: default`) — writable, empty; **the write leaves this channel** (`affectsAllChannels`) |
| `model_name` | writes and persists | `channel` → override bag | `attr_model_name` | no value on any row (`layer: default`) — writable, empty |
| `model_number` | writes and persists | `channel` → override bag | `attr_model_number` | no value on any row (`layer: default`) — writable, empty |
| `name` | follows master (projection; the cell says so) | `master` → ChannelListing column | `amazon_title` | reads at `layer: master`; paints the master glyph |
| `number_of_items` | writes and persists | `channel` → override bag | `attr_number_of_items` | no value on any row (`layer: default`) — writable, empty |
| `number_of_lithium_ion_cells` | writes and persists | `channel` → override bag | `attr_number_of_lithium_ion_cells` | no value on any row (`layer: default`) — writable, empty |
| `number_of_lithium_metal_cells` | writes and persists | `channel` → override bag | `attr_number_of_lithium_metal_cells` | no value on any row (`layer: default`) — writable, empty |
| `parentAsin` | refused | `master` → MASTER | `parentAsin` | “Read-only on this channel — the marketplace does not accept a value for this field.” |
| `parentage_level` | follows master (projection; the cell says so) | `channel` → override bag | `attr_parentage_level` | reads at `layer: master`; paints the master glyph |
| `part_number` | writes and persists | `channel` → override bag | `attr_part_number` | no value on any row (`layer: default`) — writable, empty |
| `pattern` | writes and persists | `channel` → override bag | `attr_pattern` | no value on any row (`layer: default`) — writable, empty |
| `productType` | follows master (projection; the cell says so) | `master` → MASTER | `productType` | reads at `layer: master`; paints the master glyph; **the write leaves this channel** (`affectsAllChannels`) |
| `product_description` | writes and persists | `master` → ChannelListing column | `amazon_description` | no value on any row (`layer: default`) — writable, empty |
| `product_expiration_type` | writes and persists | `channel` → override bag | `attr_product_expiration_type` | no value on any row (`layer: default`) — writable, empty |
| `product_site_launch_date` | writes and persists | `channel` → override bag | `attr_product_site_launch_date` | no value on any row (`layer: default`) — writable, empty |
| `product_tax_code` | writes and persists | `channel` → override bag | `attr_product_tax_code` | no value on any row (`layer: default`) — writable, empty |
| `recommended_browse_nodes` | follows master (projection; the cell says so) | `channel` → override bag | `attr_recommended_browse_nodes` | reads at `layer: master`; paints the master glyph |
| `safety_data_sheet_url` | writes and persists | `channel` → override bag | `attr_safety_data_sheet_url` | no value on any row (`layer: default`) — writable, empty |
| `shippingTemplate` | refused | `master` → MASTER | `shippingTemplate` | “Read-only on this channel — the marketplace does not accept a value for this field.” |
| `ships_globally` | writes and persists | `channel` → override bag | `attr_ships_globally` | no value on any row (`layer: default`) — writable, empty |
| `size` | writes and persists | `channel` → override bag | `attr_size` | no value on any row (`layer: default`) — writable, empty |
| `skip_offer` | follows master (projection; the cell says so) | `channel` → override bag | `attr_skip_offer` | reads at `layer: master`; paints the master glyph |
| `sku` | refused | `master` → MASTER | `sku` | “Read-only on this channel — the marketplace does not accept a value for this field.” |
| `special_size_type` | writes and persists | `channel` → override bag | `attr_special_size_type` | no value on any row (`layer: default`) — writable, empty |
| `status` | follows master (projection; the cell says so) | `master` → MASTER | `status` | reads at `layer: master`; paints the master glyph; **the write leaves this channel** (`affectsAllChannels`) |
| `style` | writes and persists | `channel` → override bag | `attr_style` | no value on any row (`layer: default`) — writable, empty |
| `subject_character` | writes and persists | `channel` → override bag | `attr_subject_character` | no value on any row (`layer: default`) — writable, empty |
| `supplier_declared_dg_hz_regulation` | follows master (projection; the cell says so) | `channel` → override bag | `attr_supplier_declared_dg_hz_regulation` | reads at `layer: master`; paints the master glyph |
| `supplier_declared_has_product_identifier_exemption` | follows master (projection; the cell says so) | `channel` → override bag | `attr_supplier_declared_has_product_identifier_exemption` | reads at `layer: master`; paints the master glyph |
| `target_gender` | writes and persists | `channel` → override bag | `attr_target_gender` | no value on any row (`layer: default`) — writable, empty |
| `team_name` | writes and persists | `channel` → override bag | `attr_team_name` | no value on any row (`layer: default`) — writable, empty |
| `temperature_rating` | writes and persists | `channel` → override bag | `attr_temperature_rating` | no value on any row (`layer: default`) — writable, empty |
| `theme` | writes and persists | `channel` → override bag | `attr_theme` | no value on any row (`layer: default`) — writable, empty |
| `title_differentiation` | writes and persists | `channel` → override bag | `attr_title_differentiation` | no value on any row (`layer: default`) — writable, empty |
| `totalStock` | follows master (projection; the cell says so) | `master` → MASTER | `totalStock` | reads at `layer: master`; paints the master glyph; **the write leaves this channel** (`affectsAllChannels`) |
| `upc` | refused on the parent row | `master` → MASTER | `upc` | “Set on each variant — an identity code belongs to the individual product, not the family.” (parent row only; writable on variants); **the write leaves this channel** (`affectsAllChannels`) |
| `water_resistance_level` | follows master (projection; the cell says so) | `channel` → override bag | `attr_water_resistance_level` | reads at `layer: master`; paints the master glyph |
| `weave_type` | follows master (projection; the cell says so) | `channel` → override bag | `attr_weave_type` | reads at `layer: master`; paints the master glyph |
| `weightUnit` | writes and persists | `master` → MASTER | `weightUnit` | no value on any row (`layer: default`) — writable, empty; **the write leaves this channel** (`affectsAllChannels`) |
| `weightValue` | writes and persists | `master` → MASTER | `weightValue` | no value on any row (`layer: default`) — writable, empty; **the write leaves this channel** (`affectsAllChannels`) |

</details>

### Amazon·IT/it — 97 declared columns × 21 rows

- writes and persists: **62**
- follows master (projection; the cell says so): **19**
- refused: **11**
- refused on the parent row: **5**

<details><summary>every declared column (97)</summary>

| column | class | route | `writeField` | note |
|---|---|---|---|---|
| `age_range_description` | writes and persists | `channel` → override bag | `attr_age_range_description` | no value on any row (`layer: default`) — writable, empty |
| `amazonAsin` | refused | `master` → MASTER | `amazonAsin` | “Read-only on this channel — the marketplace does not accept a value for this field.” |
| `amazon_browseNode` | refused | `master` → MASTER | `amazon_browseNode` | “Read-only on this channel — the marketplace does not accept a value for this field.” |
| `amazon_bullets` | refused | `master` → MASTER | `amazon_bullets` | “Read-only on this channel — the marketplace does not accept a value for this field.” |
| `amazon_description` | writes and persists | `master` → MASTER | `amazon_description` | no value on any row (`layer: default`) — writable, empty; **the write leaves this channel** (`affectsAllChannels`) |
| `amazon_searchKeywords` | refused | `master` → MASTER | `amazon_searchKeywords` | “Read-only on this channel — the marketplace does not accept a value for this field.” |
| `amazon_title` | writes and persists | `master` → MASTER | `amazon_title` | no value on any row (`layer: default`) — writable, empty; **the write leaves this channel** (`affectsAllChannels`) |
| `amazon_variationTheme` | writes and persists | `master` → MASTER | `amazon_variationTheme` | no value on any row (`layer: default`) — writable, empty; **the write leaves this channel** (`affectsAllChannels`) |
| `basePrice` | follows master (projection; the cell says so) | `master` → MASTER | `basePrice` | reads at `layer: master`; paints the master glyph; **the write leaves this channel** (`affectsAllChannels`) |
| `batteries_included` | writes and persists | `channel` → override bag | `attr_batteries_included` | no value on any row (`layer: default`) — writable, empty |
| `batteries_required` | follows master (projection; the cell says so) | `channel` → override bag | `attr_batteries_required` | reads at `layer: master`; paints the master glyph |
| `brand` | follows master (projection; the cell says so) | `master` → MASTER | `brand` | reads at `layer: master`; paints the master glyph; **the write leaves this channel** (`affectsAllChannels`) |
| `bullet_point` | writes and persists | `channel` → override bag | `attr_bullet_point` | no value on any row (`layer: default`) — writable, empty |
| `buyBoxPrice` | refused | `master` → MASTER | `buyBoxPrice` | “Read-only on this channel — the marketplace does not accept a value for this field.” |
| `care_instructions` | writes and persists | `channel` → override bag | `attr_care_instructions` | no value on any row (`layer: default`) — writable, empty |
| `color` | refused on the parent row | `channel` → override bag | `attr_color` | “Set on each variant — this is a variation axis, so the family row has no single value.” (parent row only; writable on variants) |
| `competitorPrice` | refused | `master` → MASTER | `competitorPrice` | “Read-only on this channel — the marketplace does not accept a value for this field.” |
| `condition_note` | writes and persists | `channel` → override bag | `attr_condition_note` | no value on any row (`layer: default`) — writable, empty |
| `condition_type` | refused | `channel` → override bag | `attr_condition_type` | “Read-only on this channel — the marketplace does not accept a value for this field.” |
| `costPrice` | writes and persists | `master` → MASTER | `costPrice` | no value on any row (`layer: default`) — writable, empty; **the write leaves this channel** (`affectsAllChannels`) |
| `country_of_origin` | follows master (projection; the cell says so) | `channel` → override bag | `attr_country_of_origin` | reads at `layer: master`; paints the master glyph |
| `department` | writes and persists | `channel` → override bag | `attr_department` | no value on any row (`layer: default`) — writable, empty |
| `description` | writes and persists | `master` → ChannelListing column | `amazon_description` | no value on any row (`layer: default`) — writable, empty |
| `dimHeight` | writes and persists | `master` → MASTER | `dimHeight` | no value on any row (`layer: default`) — writable, empty; **the write leaves this channel** (`affectsAllChannels`) |
| `dimLength` | writes and persists | `master` → MASTER | `dimLength` | no value on any row (`layer: default`) — writable, empty; **the write leaves this channel** (`affectsAllChannels`) |
| `dimUnit` | writes and persists | `master` → MASTER | `dimUnit` | no value on any row (`layer: default`) — writable, empty; **the write leaves this channel** (`affectsAllChannels`) |
| `dimWidth` | writes and persists | `master` → MASTER | `dimWidth` | no value on any row (`layer: default`) — writable, empty; **the write leaves this channel** (`affectsAllChannels`) |
| `dsa_responsible_party_address` | writes and persists | `channel` → override bag | `attr_dsa_responsible_party_address` | no value on any row (`layer: default`) — writable, empty |
| `ean` | refused on the parent row | `master` → MASTER | `ean` | “Set on each variant — an identity code belongs to the individual product, not the family.” (parent row only; writable on variants); **the write leaves this channel** (`affectsAllChannels`) |
| `ebayItemId` | refused | `master` → MASTER | `ebayItemId` | “Read-only on this channel — the marketplace does not accept a value for this field.” |
| `ec_medical_device_sales_channel` | writes and persists | `channel` → override bag | `attr_ec_medical_device_sales_channel` | no value on any row (`layer: default`) — writable, empty |
| `fabric_type` | follows master (projection; the cell says so) | `channel` → override bag | `attr_fabric_type` | reads at `layer: master`; paints the master glyph |
| `fit_type` | writes and persists | `channel` → override bag | `attr_fit_type` | no value on any row (`layer: default`) — writable, empty |
| `fulfillmentChannel` | writes and persists | `master` → MASTER | `fulfillmentChannel` | no value on any row (`layer: default`) — writable, empty; **the write leaves this channel** (`affectsAllChannels`) |
| `generic_keyword` | writes and persists | `channel` → override bag | `attr_generic_keyword` | no value on any row (`layer: default`) — writable, empty |
| `ghs_chemical_h_code` | writes and persists | `channel` → override bag | `attr_ghs_chemical_h_code` | no value on any row (`layer: default`) — writable, empty |
| `gpsr_safety_attestation` | writes and persists | `channel` → override bag | `attr_gpsr_safety_attestation` | no value on any row (`layer: default`) — writable, empty |
| `gtin` | refused on the parent row | `master` → MASTER | `gtin` | “Set on each variant — an identity code belongs to the individual product, not the family.” (parent row only; writable on variants); **the write leaves this channel** (`affectsAllChannels`) |
| `handmade_classification` | writes and persists | `channel` → override bag | `attr_handmade_classification` | no value on any row (`layer: default`) — writable, empty |
| `is_expiration_dated_product` | writes and persists | `channel` → override bag | `attr_is_expiration_dated_product` | no value on any row (`layer: default`) — writable, empty |
| `is_green_purchasing_law_compliant` | writes and persists | `channel` → override bag | `attr_is_green_purchasing_law_compliant` | no value on any row (`layer: default`) — writable, empty |
| `is_this_product_subject_to_buyer_age_restrictions` | writes and persists | `channel` → override bag | `attr_is_this_product_subject_to_buyer_age_restrictions` | no value on any row (`layer: default`) — writable, empty |
| `item_name` | follows master (projection; the cell says so) | `master` → ChannelListing column | `amazon_title` | reads at `layer: master`; paints the master glyph |
| `item_package_quantity` | writes and persists | `channel` → override bag | `attr_item_package_quantity` | no value on any row (`layer: default`) — writable, empty |
| `item_type_name` | writes and persists | `channel` → override bag | `attr_item_type_name` | no value on any row (`layer: default`) — writable, empty |
| `league_name` | writes and persists | `channel` → override bag | `attr_league_name` | no value on any row (`layer: default`) — writable, empty |
| `lifestyle` | writes and persists | `channel` → override bag | `attr_lifestyle` | no value on any row (`layer: default`) — writable, empty |
| `lowStockThreshold` | writes and persists | `master` → MASTER | `lowStockThreshold` | no value on any row (`layer: default`) — writable, empty; **the write leaves this channel** (`affectsAllChannels`) |
| `manufacturer` | writes and persists | `master` → MASTER | `manufacturer` | no value on any row (`layer: default`) — writable, empty; **the write leaves this channel** (`affectsAllChannels`) |
| `map_policy` | writes and persists | `channel` → override bag | `attr_map_policy` | no value on any row (`layer: default`) — writable, empty |
| `material` | writes and persists | `channel` → override bag | `attr_material` | no value on any row (`layer: default`) — writable, empty |
| `maxPrice` | writes and persists | `master` → MASTER | `maxPrice` | no value on any row (`layer: default`) — writable, empty; **the write leaves this channel** (`affectsAllChannels`) |
| `max_order_quantity` | writes and persists | `channel` → override bag | `attr_max_order_quantity` | no value on any row (`layer: default`) — writable, empty |
| `merchant_release_date` | writes and persists | `channel` → override bag | `attr_merchant_release_date` | no value on any row (`layer: default`) — writable, empty |
| `merchant_shipping_group` | follows master (projection; the cell says so) | `channel` → override bag | `attr_merchant_shipping_group` | reads at `layer: master`; paints the master glyph |
| `merchant_suggested_asin` | follows master (projection; the cell says so) | `channel` → override bag | `attr_merchant_suggested_asin` | reads at `layer: master`; paints the master glyph |
| `minMargin` | writes and persists | `master` → MASTER | `minMargin` | no value on any row (`layer: default`) — writable, empty; **the write leaves this channel** (`affectsAllChannels`) |
| `minPrice` | writes and persists | `master` → MASTER | `minPrice` | no value on any row (`layer: default`) — writable, empty; **the write leaves this channel** (`affectsAllChannels`) |
| `model_name` | writes and persists | `channel` → override bag | `attr_model_name` | no value on any row (`layer: default`) — writable, empty |
| `model_number` | writes and persists | `channel` → override bag | `attr_model_number` | no value on any row (`layer: default`) — writable, empty |
| `name` | follows master (projection; the cell says so) | `master` → ChannelListing column | `amazon_title` | reads at `layer: master`; paints the master glyph |
| `number_of_items` | writes and persists | `channel` → override bag | `attr_number_of_items` | no value on any row (`layer: default`) — writable, empty |
| `number_of_lithium_ion_cells` | writes and persists | `channel` → override bag | `attr_number_of_lithium_ion_cells` | no value on any row (`layer: default`) — writable, empty |
| `number_of_lithium_metal_cells` | writes and persists | `channel` → override bag | `attr_number_of_lithium_metal_cells` | no value on any row (`layer: default`) — writable, empty |
| `parentAsin` | refused | `master` → MASTER | `parentAsin` | “Read-only on this channel — the marketplace does not accept a value for this field.” |
| `parentage_level` | follows master (projection; the cell says so) | `channel` → override bag | `attr_parentage_level` | reads at `layer: master`; paints the master glyph |
| `part_number` | writes and persists | `channel` → override bag | `attr_part_number` | no value on any row (`layer: default`) — writable, empty |
| `pattern` | writes and persists | `channel` → override bag | `attr_pattern` | no value on any row (`layer: default`) — writable, empty |
| `productType` | follows master (projection; the cell says so) | `master` → MASTER | `productType` | reads at `layer: master`; paints the master glyph; **the write leaves this channel** (`affectsAllChannels`) |
| `product_description` | writes and persists | `master` → ChannelListing column | `amazon_description` | no value on any row (`layer: default`) — writable, empty |
| `product_expiration_type` | writes and persists | `channel` → override bag | `attr_product_expiration_type` | no value on any row (`layer: default`) — writable, empty |
| `product_site_launch_date` | writes and persists | `channel` → override bag | `attr_product_site_launch_date` | no value on any row (`layer: default`) — writable, empty |
| `product_tax_code` | writes and persists | `channel` → override bag | `attr_product_tax_code` | no value on any row (`layer: default`) — writable, empty |
| `recommended_browse_nodes` | follows master (projection; the cell says so) | `channel` → override bag | `attr_recommended_browse_nodes` | reads at `layer: master`; paints the master glyph |
| `safety_data_sheet_url` | writes and persists | `channel` → override bag | `attr_safety_data_sheet_url` | no value on any row (`layer: default`) — writable, empty |
| `shippingTemplate` | refused | `master` → MASTER | `shippingTemplate` | “Read-only on this channel — the marketplace does not accept a value for this field.” |
| `ships_globally` | writes and persists | `channel` → override bag | `attr_ships_globally` | no value on any row (`layer: default`) — writable, empty |
| `size` | refused on the parent row | `channel` → override bag | `attr_size` | “Set on each variant — this is a variation axis, so the family row has no single value.” (parent row only; writable on variants) |
| `skip_offer` | follows master (projection; the cell says so) | `channel` → override bag | `attr_skip_offer` | reads at `layer: master`; paints the master glyph |
| `sku` | refused | `master` → MASTER | `sku` | “Read-only on this channel — the marketplace does not accept a value for this field.” |
| `special_size_type` | writes and persists | `channel` → override bag | `attr_special_size_type` | no value on any row (`layer: default`) — writable, empty |
| `status` | follows master (projection; the cell says so) | `master` → MASTER | `status` | reads at `layer: master`; paints the master glyph; **the write leaves this channel** (`affectsAllChannels`) |
| `style` | writes and persists | `channel` → override bag | `attr_style` | no value on any row (`layer: default`) — writable, empty |
| `subject_character` | writes and persists | `channel` → override bag | `attr_subject_character` | no value on any row (`layer: default`) — writable, empty |
| `supplier_declared_dg_hz_regulation` | follows master (projection; the cell says so) | `channel` → override bag | `attr_supplier_declared_dg_hz_regulation` | reads at `layer: master`; paints the master glyph |
| `supplier_declared_has_product_identifier_exemption` | follows master (projection; the cell says so) | `channel` → override bag | `attr_supplier_declared_has_product_identifier_exemption` | reads at `layer: master`; paints the master glyph |
| `target_gender` | writes and persists | `channel` → override bag | `attr_target_gender` | no value on any row (`layer: default`) — writable, empty |
| `team_name` | writes and persists | `channel` → override bag | `attr_team_name` | no value on any row (`layer: default`) — writable, empty |
| `temperature_rating` | writes and persists | `channel` → override bag | `attr_temperature_rating` | no value on any row (`layer: default`) — writable, empty |
| `theme` | writes and persists | `channel` → override bag | `attr_theme` | no value on any row (`layer: default`) — writable, empty |
| `title_differentiation` | writes and persists | `channel` → override bag | `attr_title_differentiation` | no value on any row (`layer: default`) — writable, empty |
| `totalStock` | follows master (projection; the cell says so) | `master` → MASTER | `totalStock` | reads at `layer: master`; paints the master glyph; **the write leaves this channel** (`affectsAllChannels`) |
| `upc` | refused on the parent row | `master` → MASTER | `upc` | “Set on each variant — an identity code belongs to the individual product, not the family.” (parent row only; writable on variants); **the write leaves this channel** (`affectsAllChannels`) |
| `water_resistance_level` | follows master (projection; the cell says so) | `channel` → override bag | `attr_water_resistance_level` | reads at `layer: master`; paints the master glyph |
| `weave_type` | follows master (projection; the cell says so) | `channel` → override bag | `attr_weave_type` | reads at `layer: master`; paints the master glyph |
| `weightUnit` | writes and persists | `master` → MASTER | `weightUnit` | no value on any row (`layer: default`) — writable, empty; **the write leaves this channel** (`affectsAllChannels`) |
| `weightValue` | writes and persists | `master` → MASTER | `weightValue` | no value on any row (`layer: default`) — writable, empty; **the write leaves this channel** (`affectsAllChannels`) |

</details>

### eBay·IT/it — 35 declared columns × 21 rows

- writes and persists: **17**
- refused: **9**
- follows master (projection; the cell says so): **6**
- refused on the parent row: **3**

<details><summary>every declared column (35)</summary>

| column | class | route | `writeField` | note |
|---|---|---|---|---|
| `amazonAsin` | refused | `master` → MASTER | `amazonAsin` | “Read-only on this channel — the marketplace does not accept a value for this field.” |
| `basePrice` | follows master (projection; the cell says so) | `master` → MASTER | `basePrice` | reads at `layer: master`; paints the master glyph; **the write leaves this channel** (`affectsAllChannels`) |
| `brand` | follows master (projection; the cell says so) | `master` → MASTER | `brand` | reads at `layer: master`; paints the master glyph; **the write leaves this channel** (`affectsAllChannels`) |
| `buyBoxPrice` | refused | `master` → MASTER | `buyBoxPrice` | “Read-only on this channel — the marketplace does not accept a value for this field.” |
| `competitorPrice` | refused | `master` → MASTER | `competitorPrice` | “Read-only on this channel — the marketplace does not accept a value for this field.” |
| `costPrice` | writes and persists | `master` → MASTER | `costPrice` | no value on any row (`layer: default`) — writable, empty; **the write leaves this channel** (`affectsAllChannels`) |
| `description` | writes and persists | `master` → ChannelListing column | `ebay_description` | no value on any row (`layer: default`) — writable, empty |
| `dimHeight` | writes and persists | `master` → MASTER | `dimHeight` | no value on any row (`layer: default`) — writable, empty; **the write leaves this channel** (`affectsAllChannels`) |
| `dimLength` | writes and persists | `master` → MASTER | `dimLength` | no value on any row (`layer: default`) — writable, empty; **the write leaves this channel** (`affectsAllChannels`) |
| `dimUnit` | writes and persists | `master` → MASTER | `dimUnit` | no value on any row (`layer: default`) — writable, empty; **the write leaves this channel** (`affectsAllChannels`) |
| `dimWidth` | writes and persists | `master` → MASTER | `dimWidth` | no value on any row (`layer: default`) — writable, empty; **the write leaves this channel** (`affectsAllChannels`) |
| `ean` | refused on the parent row | `master` → MASTER | `ean` | “Set on each variant — an identity code belongs to the individual product, not the family.” (parent row only; writable on variants); **the write leaves this channel** (`affectsAllChannels`) |
| `ebayItemId` | refused | `master` → MASTER | `ebayItemId` | “Read-only on this channel — the marketplace does not accept a value for this field.” |
| `ebay_description` | writes and persists | `master` → MASTER | `ebay_description` | no value on any row (`layer: default`) — writable, empty; **the write leaves this channel** (`affectsAllChannels`) |
| `ebay_duration` | refused | `master` → MASTER | `ebay_duration` | “Read-only on this channel — the marketplace does not accept a value for this field.” |
| `ebay_format` | refused | `master` → MASTER | `ebay_format` | “Read-only on this channel — the marketplace does not accept a value for this field.” |
| `ebay_title` | writes and persists | `master` → MASTER | `ebay_title` | no value on any row (`layer: default`) — writable, empty; **the write leaves this channel** (`affectsAllChannels`) |
| `ebay_variationTheme` | writes and persists | `master` → MASTER | `ebay_variationTheme` | no value on any row (`layer: default`) — writable, empty; **the write leaves this channel** (`affectsAllChannels`) |
| `fulfillmentChannel` | writes and persists | `master` → MASTER | `fulfillmentChannel` | no value on any row (`layer: default`) — writable, empty; **the write leaves this channel** (`affectsAllChannels`) |
| `gtin` | refused on the parent row | `master` → MASTER | `gtin` | “Set on each variant — an identity code belongs to the individual product, not the family.” (parent row only; writable on variants); **the write leaves this channel** (`affectsAllChannels`) |
| `lowStockThreshold` | writes and persists | `master` → MASTER | `lowStockThreshold` | no value on any row (`layer: default`) — writable, empty; **the write leaves this channel** (`affectsAllChannels`) |
| `manufacturer` | writes and persists | `master` → MASTER | `manufacturer` | no value on any row (`layer: default`) — writable, empty; **the write leaves this channel** (`affectsAllChannels`) |
| `maxPrice` | writes and persists | `master` → MASTER | `maxPrice` | no value on any row (`layer: default`) — writable, empty; **the write leaves this channel** (`affectsAllChannels`) |
| `minMargin` | writes and persists | `master` → MASTER | `minMargin` | no value on any row (`layer: default`) — writable, empty; **the write leaves this channel** (`affectsAllChannels`) |
| `minPrice` | writes and persists | `master` → MASTER | `minPrice` | no value on any row (`layer: default`) — writable, empty; **the write leaves this channel** (`affectsAllChannels`) |
| `name` | follows master (projection; the cell says so) | `master` → ChannelListing column | `ebay_title` | reads at `layer: master`; paints the master glyph |
| `parentAsin` | refused | `master` → MASTER | `parentAsin` | “Read-only on this channel — the marketplace does not accept a value for this field.” |
| `productType` | follows master (projection; the cell says so) | `master` → MASTER | `productType` | reads at `layer: master`; paints the master glyph; **the write leaves this channel** (`affectsAllChannels`) |
| `shippingTemplate` | refused | `master` → MASTER | `shippingTemplate` | “Read-only on this channel — the marketplace does not accept a value for this field.” |
| `sku` | refused | `master` → MASTER | `sku` | “Read-only on this channel — the marketplace does not accept a value for this field.” |
| `status` | follows master (projection; the cell says so) | `master` → MASTER | `status` | reads at `layer: master`; paints the master glyph; **the write leaves this channel** (`affectsAllChannels`) |
| `totalStock` | follows master (projection; the cell says so) | `master` → MASTER | `totalStock` | reads at `layer: master`; paints the master glyph; **the write leaves this channel** (`affectsAllChannels`) |
| `upc` | refused on the parent row | `master` → MASTER | `upc` | “Set on each variant — an identity code belongs to the individual product, not the family.” (parent row only; writable on variants); **the write leaves this channel** (`affectsAllChannels`) |
| `weightUnit` | writes and persists | `master` → MASTER | `weightUnit` | no value on any row (`layer: default`) — writable, empty; **the write leaves this channel** (`affectsAllChannels`) |
| `weightValue` | writes and persists | `master` → MASTER | `weightValue` | no value on any row (`layer: default`) — writable, empty; **the write leaves this channel** (`affectsAllChannels`) |

</details>


## 10. What moved after this document was filed, and what re-measured it

Everything below was measured, not reported to me. Times are CEST on 2026-09-02.

| finding | state | closed by | verified by |
|---|---|---|---|
| **F1** `writable` a constant, no cell could refuse | **FIXED** | PES.5, `studio-sheet.service.ts:1048` (`cellBlockedReason`) | the §0 re-take: 14 / 14 / 16 / 12 cells refusing with sentences, where the 06:18:16 build had 0 / 0 / 0 / 0 |
| **F1a** master cells said "Read-only on this **channel**" | **FIXED** | PES.5 | master DE/de now reads *"Read-only on the master record — this field is not editable by hand in this market."*; Amazon·IT keeps the channel wording |
| **F2** 60 of 60 master `attr_*` refused by the write path | **FIXED at the registry seam** | PES.2 `masterWrite.ts` 07:28:08 (sends the market) + **PES.5 `validation-marketplace.ts` 07:43:20** (reads it *before* the channel filter) | §10.1 |
| **F4** `editable: false` with no reason | **FIXED** | PES.5, same change as F1 | as F1 |
| **F6** the registry re-parsed every schema per id | **FIXED** | PES.5, `attrDefCache` in `field-registry.service.ts` 08:07:29 | the gate went from **~20 min to 26 s** over the same 252 lookups |
| **F3** prefixed route writes where its cell does not read; no version bump | **OPEN** → PES.5 | W3, §4 |
| **F5** eBay·IT has no channel write route | **OPEN**, ruled an honest-notice requirement until eBay attributes exist | §3 |
| **F7** the pin is nearly unexercised in the data | standing fact | §3 |

**A fix at the caller was inert for fifteen minutes, and that is the part worth keeping.** PES.2's
07:28:08 change sent `marketplaceContexts: [{ marketplace: "DE", locale: "de" }]` — correct, and
still refused, because `products.routes.ts:1129` dropped every context without a `channel` and
`primaryContext` stayed null. Replayed with the writer's exact body it returned
`400 "No marketplace context — the attribute registry is per marketplace…"`. One list was serving two
purposes — fan-out targets, which need a channel, and the marketplace naming a registry, which does
not — and PES.5's split (`validationMarketplace()` reading the raw contexts before any filter) is
what actually closed it. **A correct fix moved the defect one line downstream, and only exercising
the path showed it.**

### 10.1 The gate, and its clean run

`scripts/check-writability.mjs` — D14.1's third witness (W-3), hub #564. It **calls the route's own
`validationMarketplace()`** rather than modelling it, so the gate and the server cannot disagree; it
refuses to report at all if the sources it still replicates (the writers' payloads) drift.

```
writability conformance (D14.1 / W-3)
  load(1m) 3.03 · 2026-09-02T06:19:15Z → finished 06:19:41Z (26s)
  studio-sheet.service.ts 08:04:03 · products.routes.ts 07:43:20 · product-studio.routes.ts 07:53:04
  validation-marketplace.ts 07:43:20 · field-registry.service.ts 08:07:29   [stable before AND after]

  coordinate      declared  attr_*  checked  effective mkt  refused-by-write-path
  master DE/de          96      60       60  DE             ✅ 0   (+1 honest: condition_type)
  Amazon·DE/de          96      58       58  DE             ✅ 0   (+1 honest: condition_type)
  Amazon·IT/it          97      59       59  IT             ✅ 0   (+1 honest: condition_type)
  eBay·IT/it            35       0        0  IT             ✅ 0
  ✅ green — every declared attr_* column resolves in the registry the write path will use.
```

**The 1 of 60 on master, named:** `condition_type` (`attr_condition_type`). The registry resolves it
— `found, editable: false, type: select` — so it is genuinely read-only, not missing; and the cell
refuses it with a reason on every row. Registry and cell agree, so it is **honest, not a defect**,
and the gate counts it separately rather than colouring it red. It is also the control that proves
the red branch discriminates: a witness that only ever goes red has not been tested.

**Two defects the gate found in itself**, both fixed before its numbers were quoted:

- **It read `writeBlockedReason` off the COLUMN.** That field exists only on the **cell**, so it was
  `undefined` on every column, `== null` was always true, and it reported `condition_type` RED on
  three coordinates — a column whose cells refuse it perfectly honestly. `undefined == null` had
  collapsed two different facts, *"no reason was given"* and *"I read the wrong object"*, into one
  answer. It now reads `/studio/sheet` beside `/studio/columns` and goes red only when the registry
  refuses **and** at least one row's cell offers the write with no reason — naming the rows.
- **It stamped only at the start.** Its first run began 07:44:29 and `product-studio.routes.ts`
  moved at 07:53:04 inside it; its second run began 08:07:18 and `field-registry.service.ts` moved
  at 08:07:29 — eleven seconds in, and that is the very file the gate measures. It now stamps before
  **and** after, prints `THE BUILD MOVED DURING THIS RUN` with both mtimes, and exits 2 instead of 0.
  On this repo the API source moved **three times inside this lane's pass**; that is a requirement,
  not a nicety.

**Invocation** — `npx tsx scripts/check-writability.mjs` (tsx, **not** bare node: it imports the
API's TypeScript and runs in-process, no server). `--self-test` plants a column the registry cannot
resolve and asserts the red branch fires, checks the green branch against a known-good field,
asserts the marketplace argument is load-bearing (`@null` must differ from `@DE`), and asserts the
helper returns `"DE"` / `"IT"` / `null` for the three context shapes. **On demand only — never
pre-push, and deliberately not in `package.json`'s scripts block** (hub #596).

### 10.2 What this gate does NOT see

It closes the **registry** door: a column the studio declares writable resolves in the registry the
write path will use. It cannot see the cascade, and it cannot see the paint. PES.2 has since shown
on the wire a master `attr_weave_type` write the server **applied** (`200, updated: 1`) while the
sheet painted the cell refused (#595) — a third defect, on the operator path, measured by someone
else. **The Owner's complaint is closed at the seam this document measures and nowhere else**, and
a green here must never be quoted as "the operator can write it".

---

*SC.1 · `nexus-commerce-22 [7a7bc1]` · read-only against production except the three §4 writes on the
XAVIA fixture, disclosed before execution and reverted · no layout change · no marketplace call ·
no new probe file in the repo (probes ran from the session scratchpad; the witness in §8 is a
cross-lane request to UX.1).*
