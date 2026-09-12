# FE.1 — Principal frontend engineer review: over-engineering and lies

`_studio/**` + `design-system/grid/**`, reviewed as one thing.
Session `nexus-commerce-e7`. 2026-09-02. **Review only — I changed no product file.**

> The Owner's standard, verbatim: *"Everything has to be super simple and easy to use and extremely
> functional and efficient."*

Nine lanes built these two trees in two days, each optimising its own surface. This is what the
whole looks like from outside any one of them. Every fix below lands via a cross-lane request to
the owning lane, carrying the measurement that justifies it. I own this file and nothing else.

---

## §0 Method, instrument, and what I did NOT verify

**Static.** A resolved import graph over all 1,341 `.ts`/`.tsx` files under `apps/web/src`
(`@/` and relative specifiers resolved to real files, `index` resolution included), plus a
per-export reference census: 1,277 exported names, each counted separately in product code, in
test code, and within its own file. Scripts in the session scratchpad; both are re-runnable and I
give their counts wherever I make a claim about a set.

**Runtime.** No React DevTools renderer was registered on this build, so I built a commit counter
directly on the fiber root: `Object.defineProperty(fiberRoot, 'current', …)` counts every commit
React makes, and on each commit the committed tree is walked for components that **actually
re-rendered**. That last word is where a naive probe lies, and it took two wrong instruments to get
right:

- `actualStartTime` alone **over-reports every ancestor**. React clones every fiber on the path
  from the root to an update (`cloneChildFibers`), so a bailed-out `AppShell` looks "visited".
- `memoizedState` identity alone **over-reports every fiber React never touched**, whose alternate
  is simply from an older pass.
- The discriminator I used is the **conjunction**: visited this pass (`actualStartTime >= previous
  commit`) **and** a fresh hook chain (`memoizedState !== alternate.memoizedState`, which
  `renderWithHooks` only produces when a component body actually runs).

Validated with a **negative control** (350 ms and 2,500 ms idle → **0 commits**, twice) and a
**positive control** (one keystroke in the sheet's quick filter → `MasterSheet` and its subtree
only, with `AppRail`, `StudioBar`, `StudioHeader` and `PublishMenu` correctly *absent*, while the
row count fell 21 → 3, proving the keystroke really landed). Before that conjunction, the same
keystroke "showed" the app rail and 30 nav links re-rendering. Every number in §4 is from the
validated instrument.

**Build window.** All runtime numbers were taken between **00:52 and 01:06** on 2026-09-02 against
`localhost:3000` / `127.0.0.1:8091`. `MasterSheet.tsx` was edited at **01:07** and the stack was
restarted at **01:08:01** (hub #234). Nothing in §4 was measured in or after that window. Five
lanes were editing these trees while I read them; every static claim below was re-checked against
the file on disk at the time of writing.

**Not verified, and why.**

- **300 rows: UNMEASURED.** No family that size exists (hub: the largest it can see is ≤ 22 rows;
  I did not manufacture one, and I will not extrapolate a profiler number). What I *can* state is
  bounded and measured: row and column virtualisation are both on and `rowBuffer` is 10
  (`getGridOption` readback), so rendered cells are viewport-bounded, **not** row-count-bounded.
  The costs in this review that are genuinely O(rows) are named in D4 — and the one component that
  is O(**columns**) rather than O(rows) is the drawer (D1), which already renders 96 fields at 21
  rows and will grow with the schema, not with the catalogue.
- **The app rail's re-render trigger.** `AppNavRail` + `AppRail` + 29–30 `LinkComponent`s re-render
  on almost every interaction (4–7 ms each, 1–3 times per interaction; idle controls at the same
  durations produced 0 commits, so it is interaction-driven, not periodic). It lives in
  `app/_shared/AppNavRail.tsx`, outside both my trees. I ruled out `useRecentlyViewed` (event-driven
  only) and did not isolate it further. Reported, not diagnosed — hub to route.
- **Write paths.** The browser holds no session, so no write verb was exercised. The one editor I
  opened was cancelled with `stopEditing(true)`; nothing was committed, and GALE-JACKET is unchanged.

---

## §0.2 Current state of every finding — re-checked by CONTENT at 02:33

This document has been amended as lanes fixed things under it, so a reader arriving now cannot tell
the live list from the history. This table is the live list. **Every row was re-checked by matching
the code, not the line number** (line numbers move when someone adds a comment above a statement —
that cost me a wrong "unchanged" at 01:47), and re-read at the moment of writing rather than the
moment of measuring.

### Landed — 12 of 22 filed items, verified on disk

| item | what landed | lane |
|---|---|---|
| **A1, A4** | `Available` and `Stockout days` go through readings; a real 0 still renders as 0. PES.7 went **wider than the finding** — they gated the whole row and found four sibling figures rendering empty `<dd>`s | PES.7 |
| **A2 + P2-2** | the invented cap, **both halves**: `columns.tsx` stopped sending it, then `sheet.ts:12`'s own `?? 4000` stopped re-inventing it. The second half existed only because I re-measured after the first | PES.2 |
| **A3** | `lengthValidation(col.maxLength ?? null …)` — 66 uncapped columns no longer validated against 4,000 | PES.2 |
| **A7** | both `?? 'unlisted'` siblings — `AliasBandCell` (01:45) and `ListingsPane` (01:47) | PES.3, PES.4 |
| **A8** | 🔴 **the test the comment promised now exists** — `useHeaderCollapse.vitest.test.ts`, with `expandedScrollRange` extracted so the DOM-free rule is exercised at 47/48/0/36/92/204. PES.1 took option (a), which was the right one | PES.1 |
| **P2-1** | the `SheetWriter` latch — `Promise.race` with a resolving loser. **Watched by me**: refused at 31 s, `busy` clears, a second edit to the same row sends (`commits=2`) | PES.2 |
| **P2-3** | `as unknown as CascadeRow` gone from `matrixModel.ts` | PES.7 |
| **P3-1 + P3-2** | 🔴 **the structural fix, not the patch** — `useStudioRead.ts` (160 lines + its own test) now carries the monotonic `requestId`, a real `AbortController` that **aborts the superseded request rather than ignoring it**, a deadline, and the 404/501 → `unavailable` split; all three drawer hooks consume it and the three duplicate status unions collapsed to `StudioReadStatus`. I verified the refactor **carried** the guard rather than moving the plumbing and dropping it | PES.4 |
| **P4-1** | `buyBoxByCoord = new Map(…)` — the buy-box price now joins on the key both sides carried all along | PES.7 |

**Withdrawn: A6** — mine, and wrong. `publishPlan.ts` returns early; the `?? 0` was never a claim.

### Still open — verified present at 02:33

| item | class | lane | note |
|---|---|---|---|
| **D3** | RSC round-trip on every URL write (~0.6 s) | PES.1 | the largest operator cost still standing |
| **A9** | `.d.ts` drift: **43 → 27** stale, but **`roundTrip.d.ts` still omits `SaveOutcome.version`** | DS.1 | that one is the highest-value of the set — it is the field whose own source comment calls its absence "a real defect… invisible to the compiler" |
| **P4-2** | an unrecognised publish mode falls silent through `live`'s branch | PES.3 | |
| **P4-3** | two `PublishMode` types, different member sets | PES.3 + PES.7 | |
| **P2-4** | `PublishState` documents four states, accepts every string | PES.7 | |
| **E1** | two `as never` at the PES.2↔PES.3 seam | PES.2 + PES.3 | the only cross-lane seam with neither a type nor a contract test |
| **C1** | `marketplacesFailed` drilled through 5 files, consumed by none | PES.1 | |
| **C2** | `useHeaderCollapse`'s `reassess` returned, never called | PES.1 | A8's fix landed beside it; this half remains |
| **C4** | `onNewColumnsLoaded` composition for a caller that does not exist, **plus the live spread-order bug** | PES.2/AG.1 | |
| **D4** | `missingRequiredChip`'s O(rows × missing × columns) scan | PES.2 | one-line `Set` |
| **F1** | the legacy sheet fallback, and its network-failure conflation | PES.2 | Owner question Q1 |
| **B1** | `GridToastBoundary` still wraps unconditionally | PES.2 | hub ruled context-detect |
| **B2, C3, C5, A5** | duplicate chip predicate · dead `textEditor` · `/studio/columns` zero callers · the low-ranked `?? 0` triple | various | all low |
| ~~**P3-3**~~ | ✅ **re-measured in the freeze: 254.3 ms → 111.4 ms**, the four repeat renders gone — but memo + collapsed-groups together, not the memo alone (§7) | done | |

**§9 remediation correction (hub #367):** both §9 items shipped, and doing them corrected the rule —
"hoist to module scope" is insufficient, **nothing on the import path may be a `.tsx`**. Measured
across both trees: **97 of 111 `.ts` modules are testable in node today**, 14 are poisoned by a
transitive `.tsx`, 8 of those are barrels, and two files (`contracts.tsx`, `NexusGrid.tsx`) strand
three modules each. See §9.

**Reading of the tally:** the items that landed fastest were the ones carrying a measurement someone
could re-run — A2 was fixed twice because I re-measured after the first fix and found the wall had
moved from 2,000 to 4,000. The ones still open are mostly type-honesty and dead-code items, which
cost maintenance rather than operators, and are correctly ranked below the rest.

## §1 The map

### 1.1 Census

| | `_studio/**` | `design-system/grid/**` |
|---|---|---|
| files | 196 | 104 |
| product `.ts`/`.tsx` | 135 | 49 |
| product lines | **24,816** | **5,769** |
| test files / lines | 47 / 6,912 | 19 / 2,265 |
| `.d.ts` | 0 | 34 |
| CSS files / lines | 13 / 3,061 | 1 / 665 |

Product lines by studio sub-tree: `images` 8,160 · `sheet` 7,269 · `drawer` 4,010 · root files
2,608 · `ancillary` 1,112 · `ai` 967 · `channel-ops` 741.

Ten largest product modules: `sheet/master/MasterSheet.tsx` 1,139 · `contracts.tsx` 852 ·
`sheet/channel/ChannelSheet.tsx` 845 · `sheet/master/familyActions.ts` 546 · `drawer/types.ts` 526 ·
`drawer/RecordDrawer.tsx` 487 · `grid/renderers/cells.tsx` 456 · `sheet/channel/types.ts` 413 ·
`channel-ops/syncQueue.ts` 390 · `images/master/MasterGallery.tsx` 389.

### 1.2 Import graph

Every module in both trees has at least one importer — **no orphan files**, and no module whose
only importers are tests. Where the graph is interesting is at the level of *exports*, not files:
of 1,277 exported names, **five are defined once and referenced nowhere at all** (not in product
code, not in a test, not even again inside their own file):

```
_studio/drawer/types.ts            :: DrawerTarget
_studio/types.ts                   :: ScopeReadinessResponse
_studio/useHeaderCollapse.ts       :: collapseIsArmed        ← see A8, this one is not harmless
_studio/useHeaderCollapse.ts       :: HeaderCollapse
design-system/grid/editors/index.ts:: textEditor
```

A further 30 exports exist **only for their own test**. That is mostly healthy — it is the
"extract the risky part so it can be tested without a browser" pattern, and it is why
`readiness.ts`, `saveState.ts`, `syncQueue.ts` and `familyActions.ts` have real coverage. The
exception is `collapseIsArmed`, which claims that pattern and does not have it.

The tree's shape is a clean funnel, and it is worth saying so plainly: one route file →
`StudioLoader` → `StudioClient` → `StudioStateProvider` → `StudioFrame` → `StudioTabHost` → one
tab. Component decomposition inside a lane (`PublishMenu` ← `StudioHeader`, `RecordActions` ←
`RecordDrawer`, …) shows up as "one caller" in a naive scan and is **not** a finding; I have not
listed any of it. The one-caller items in §2 are *generalised* abstractions — parameters, unions
and composition hooks whose variation does not exist.

### 1.3 State inventory — where each fact lives, and who else holds a copy

`StudioStateProvider` (`contracts.tsx:532`) is a single component holding **56 hooks** (measured by
walking its hook chain) and publishing **seven nested contexts**:

| Context | Holds | Changes on | Consumers |
|---|---|---|---|
| `ProductCtx` | `StudioProduct` | never (prop) | `StudioHeader`, tabs |
| `FamilyCtx` | `StudioFamily \| null` | never (prop) | header |
| `ScopeCtx` | scope · market · locale · tab · coordinate · options | every URL write | 7 files |
| `RecordCtx` | `?rec=` / `?cell=` + open/close | drawer open/close | 8 files |
| `SaveCtx` | **`{state, reporter}` together** | **every write start and finish** | `SaveIndicator`, `MasterSheet:192`, `ChannelSheet:111`, `useImageWorkspace:66` |
| `ReadinessCtx` | per-scope readiness | fetch + every live-refresh nonce | `StudioBar`, `PublishMenu` |
| `ViewChipsCtx` + `RegisterCtx` | chip registry | chip register/withdraw | `MasterSheet`, `ChannelSheet` |

**The state model is deliberate and mostly right**: scope, market, locale, tab, open record and
active chip all live in the URL, so a studio link is a coordinate you can send to a colleague.
`patchSearch` touches only the keys it was given, and same-tick writes coalesce through one
microtask so `setTab()` + `record.open()` cannot lose each other. Both of those exist because
somebody paid for them; neither should be "simplified".

Two structural notes fall out of the inventory and drive §4:

1. **`SaveCtx` bundles a value that changes constantly with a handle that never changes.**
   `reporter` is stable (`useMemo` over two stable callbacks); `state` moves on every write's start
   and finish. They share one context, so the two 1,100-line sheet components re-render on every
   save tick purely to hold a function reference that did not change.
2. **There is no memo boundary anywhere between the app root and the grid.** Measured across both
   trees: **45 `memo()` calls, 39 of them in `design-system/grid/**` and only 6 in `_studio/**`**
   (`GalleryTile`, `ReadinessBar`, `AliasBandCell`, `CascadeCell`, `FamilyBar`,
   `FamilySelectionBar`). The substrate is memoised with real care. The studio around it is not:
   `MasterSheet`, `ChannelSheet`, `StudioTabHost`, `SheetTab`, `MasterSheetTab`, `RecordDrawer` and
   `RecordField` are all plain functions. Every root-level update therefore walks straight through
   to `NexusGrid`.

---

## §2 The ranked list

Ranked by **cost to the operator** first, maintenance second. A lie in an error path outranks a
duplicated helper.

### A — error paths that lie

---

**A1 · `"Available 0"` for an inventory nobody read** — 🔴 highest operator cost
`_studio/ancillary/AnalyticsAdsTab.tsx:277` · lane **PES.7**

```tsx
<div><dt>Available</dt><dd>{inventory?.totalAvailable ?? 0}</dd></div>
```

**Measurement.** `const inventory = analytics?.inventory` (`:214`), so `inventory` is `undefined`
exactly when the analytics read failed or has not returned. In the same `<dl>`, **three of four
fields guard and one does not**: `cover` and `risk` are built as `inventory ? … : null` two lines
above (`:215`, `:216`), `Cover` even carries a `known` flag and a `.unknown` style; `Available`
alone coerces. Same file, thirty lines up, the Sales card does it perfectly —
`sales?.kind === 'measured' ? <numbers> : <p>{sales?.note}</p>`, with the comment *"The number is
refused, and the reason takes its place."*

**Why it is first.** `Available 0` is the most actionable number on the page and it reads as *out
of stock*. An operator can raise a purchase order or pause a listing on it. This is
`feedback_100_percent_honest_ui` and the prod defect already on record (`totalStock: 0` beside
`fbmStock: 105`).

**Simpler form** — the lane already wrote it one element away:

```tsx
<dd className={inventory ? undefined : styles.unknown}>
  {inventory ? inventory.totalAvailable : 'not read'}
</dd>
```

**Risk:** none. Render-only, no data path touched.

**✅ Re-measured at 01:47: PES.7 landed this at 01:43** — `totalAvailable ?? 0` is gone from the
file. **A4 below (`stockoutDays ?? 0`, now line 243) is unchanged and still open**, so half the pair
has landed.


---

**A2 · A 2,000-character wall on a field the server says is uncapped** — 🔴 proven on screen
`_studio/sheet/master/columns.tsx:272` (via `design-system/grid/editors/sheet.ts:12`) · lane **PES.2** / **AG.1**

```ts
...longTextEditor({ maxLength: Math.max(col.maxLength ?? 2000, 200) })
```

**Measurement — this one I ran and looked at.** On GALE-JACKET, master scope, `product_description`
(a column the live `studio/sheet` payload sends with **no** `maxLength`):

| | |
|---|---|
| `getColumnDef('product_description').cellEditorParams.maxLength` | **2000** |
| textarea's DOM `maxLength` once the editor is open | **2000** |
| seeded programmatically | 1,996 chars |
| typed with real keystrokes | 8 chars (`ABCDEFGH`) |
| **accepted** | **4** — final length exactly 2000, tail `xxxxABCD` |
| character counter on screen | **none** |

The operator is silently stopped mid-word, and the cell shows no counter to explain it, because
`LongTextCell` is passed the raw `col.maxLength` (`:275`) — `undefined` — while the editor was
passed an invention. BE.1 confirms the server side independently: absent `maxLength` means
*uncapped*, unambiguously (`sheet-columns.service.ts:283` starts `{}` and only ever widens via
`tightest()`), and **66 of 102 columns have no cap**. Three long-text columns are affected today —
`description`, `product_description`, `amazon_description` — which are exactly the fields long copy
goes into.

It also contradicts the file's own rule three lines earlier: *"Warn, never block"* (`:144`), and
`selectValidation`'s *"Off-list handling the eBay flat file taught: WARN, never block — the
operator can always type a value."* The long-text editor blocks.

**Simpler form:** stop inventing. Pass the server's value through, and let it be absent:

```ts
...longTextEditor(col.maxLength != null ? { maxLength: col.maxLength } : {})
// and in editors/sheet.ts:12, omit maxLength from cellEditorParams when opts.maxLength is undefined
// (AG's own default is 200, so `?? 4000` there is a second invention behind the first).
```

**Risk:** low. Removing a cap cannot truncate anything; the validator (A3) is where over-length is
reported, which is where "warn, never block" says it belongs.

---

**A3 · 66 uncapped columns validated against an invented 4,000, and a cap from the wrong channel**
`_studio/sheet/master/columns.tsx:143` · lane **PES.2**

```ts
: lengthValidation<StudioRow>(col.maxLength ?? 4000, col.requiredBy.length > 0, !!col.maxBytes)
```

**Measurement.** Two defects in one expression, and they compose with a server bug BE.1 found.

1. `?? 4000` gives 66 of 102 columns a channel cap no channel asked for. Note that the *same absent
   value* gets **three different answers within one file**: 4,000 here, 2,000 at `:272`, and
   nothing at `:275`.
2. `maxLength` is taken **unconditionally, without `capFrom`**. I set-scanned all 13 `capFrom`
   references in `apps/web/src`: exactly two render it — a header tooltip at `columns.tsx:175`
   (`Max 200 characters (Amazon · IT)`) and `RecordField.tsx:306` — and **none gates behaviour**.
   BE.1 measured that `studio/columns` currently returns byte-identical columns for every scope, so
   on the eBay sheet the cell that paints red is enforcing Amazon's cap while a tooltip you have to
   hover is the only thing telling the truth.

**Simpler form:** `col.maxLength == null ? NO_LENGTH_VALIDATION : lengthValidation(col.maxLength, …)`.
Cause of the second half is BE.1's `coordinatesFor`; the surface is this line.

**Risk:** low — strictly fewer false errors.

---

**A4 · A zero inside the honest branch** — `AnalyticsAdsTab.tsx:241` · **PES.7**
`{analytics?.sales.stockoutDays ?? 0}` sits inside the `sales?.kind === 'measured'` guard but is the
one number in the block read off a *different, unguarded* object. "Stockout days 0" is a claim that
nothing was ever out of stock. Same simpler form as A1.

---

**A5 · ~~An alias nobody scored reports a clean bill of health~~ → CORRECTED: a latent type
inconsistency, ranked low** — `_studio/sheet/channel/rows.ts:225-227` · **PES.3**

```ts
errors: alias.readiness?.errors ?? 0,
warnings: alias.readiness?.warnings ?? 0,
rowsMissingRequired: alias.readiness?.rowsMissingRequired ?? 0,
```

**I filed this from the grep line without reading its consumers, and the claim was wrong.** The band
does **not** render "0 errors, 0 warnings, 0 missing required". Both consumers gate on `> 0`
(`AliasBandCell.tsx:91-92`: `if (s && s.rowsMissingRequired > 0) bits.push(…)`), so an unscored
alias says *nothing* about errors — and the same function's readiness sentence is explicitly honest
about the null case: `pct === null` → *"Readiness has not been measured for this listing"*. Nothing
is presented as measured that was not measured. **Withdraw the operator-cost claim.**

What survives is narrow and belongs low in the list: `AliasSummary.errors / warnings /
rowsMissingRequired` are typed `number`, so the *type* cannot express "not scored" — while
`percent`, assigned four lines above them in the same function, is deliberately `number | null` and
carries a 🔴 comment explaining that coercing null to 0 "draws an empty red bar and tells the
operator their listing is 0% ready, which is an invention… Caught by the #129 field-drift scan,
having shipped as 0%." The file sets the standard and three of its own fields do not meet it. Today
every consumer gates correctly; the cost is that the next consumer to render the number directly
inherits a false zero with nothing to warn it. **Simpler form:** make the three `number | null`,
matching `percent`. **Risk:** low, but it is a type change with call-site fallout, so it is PES.3's
to sequence, not urgent.

**A6 · ~~A publish gate that reads "nothing blocked" when it read nothing~~ → WITHDRAWN. My
finding was wrong; the file is correct.** `_studio/images/channel/amazon/publishPlan.ts:81-82` · **PES.7**

I cited `const blocked = validation?.summary.asinsBlocked ?? 0` as a zero standing in for an unread
preflight on the object that decides whether a publish may proceed. **It does not, and I would have
known that if I had read twelve lines further.** `buildPublishPlan` returns early at `:94`:

```ts
if (!validation) {
  return { canSubmit: false, …, publishableAsins: 0, blockedAsins: 0,
    actionLabel: 'Running preflight…',
    advisory: 'Checking every ASIN against Amazon’s image rules before anything is submitted.', … }
}
```

The `?? 0` at `:82` is unreachable as a *claim*: when `validation` is null the plan refuses to offer
a submission it cannot describe and says so in a sentence, exactly as its header promises
(*"`null` readiness means the server has not answered yet. That is NOT 'gated' and NOT 'live'"*).
The same is true of the `!readiness` branch at `:85`. **Nothing to fix. PES.7 should ignore this
item.**

While withdrawing it I read the whole file, and it belongs in §3 instead — see §3 item 11.

**A7 · Hub #236's exemplar was fixed and its siblings were not — ✅ HALF LANDED SINCE FILING**
`_studio/drawer/panes/ListingsPane.tsx:44` (**PES.4, still open**) ·
~~`_studio/sheet/channel/AliasBandCell.tsx:157, :172`~~ (**PES.3 — FIXED at 01:45, re-measured**)

As filed (~00:55): `AliasBandCell.tsx:144` carried the comment `🔴 '?? DRAFT' was a LIE on a
coordinate with no listing`, `:154` was correctly `alias?.listingStatus ?? 'NOT LISTED'`, and three
and eighteen lines below it `:157` and `:172` still read `alias?.readiness?.state ?? 'unlisted'`.

**Re-measured at 01:47 on the current build** (`AliasBandCell.tsx` mtime **01:45**): both are gone.
The call is now `bandTitle(s, label, alias?.readiness?.state, pct)` — the raw, possibly-undefined
server value — and a comment at `:108` records the class. That matters beyond the fix, because
`bandTitle`'s `state` parameter is typed `ReadinessState | undefined` and its `undefined` branch is
the honest sentence *"Readiness has not been measured for this listing"*: while the `?? 'unlisted'`
was at the call site, that branch was **unreachable**, and an unscored coordinate read
*"Not listed — this channel declares no required fields, so there is nothing to measure"*. A `??`
over a server state does not only invent a value; it can make the file's own honest fallback dead
code.

**`ListingsPane.tsx:44` is unchanged** (mtime 19:07) and still reads `readiness?.state ?? 'unlisted'`
→ `readinessMeta(state, 'row')`, so an unscored coordinate renders the definite label for *unlisted*.
Same fix, PES.4's file.

**Set-scan result for #236, for the record:** 80 occurrences of `?? '<literal>'` / `|| '<literal>'`
across both trees. The large majority are honest labels for a missing value (`'unknown'`,
`'author not recorded'`, `'Rejected without a reason'`, `'no market'`) and are fine. The ones that
invent a **live state** are the three above. Two more deserve a sentence:

- `_studio/sheet/channel/useChannelSheet.ts:183` — `target: cell?.writeVerb ?? 'master'` looks like
  this class and **is not**: the code carries eight lines explaining that `'master'` matches the
  endpoint's own default and that the safe direction is the shared record refusing the edit rather
  than a silent channel write. Correct, documented, leave it.
- `_studio/sheet/master/columns.tsx:142` — `col.mode ?? 'open'` silently turns off closed-list
  warning for a column whose mode the server omitted. Low cost (it warns less, never more), but it
  is an inference where `reference_explicit_flag_beats_inference` applies.

---

**A8 · A comment claiming a test that does not exist, guarding a rule written twice** — 🔴 highest class
`_studio/useHeaderCollapse.ts:139-142` · lane **PES.1**

```ts
/** Exported for test: the arming rule on its own, with no DOM. */
export function collapseIsArmed(expandedRange: number, freed = C, threshold = T): boolean {
  return expandedRange - freed >= threshold
}
```

**Measurement (set-scanned, whole repo).** `grep -rn "collapseIsArmed\|useHeaderCollapse" apps/ packages/ scripts/`
returns **exactly two files**: this one and `StudioFrame.tsx`, which imports the hook and not the
function. There is no `useHeaderCollapse.vitest.test.ts` — the four test files at the studio root
are `readiness`, `saveState`, `scopes`, `viewChips`. The export census agrees independently:
`collapseIsArmed` has 0 product references, 0 test references, and 1 self-mention (its own
definition).

So the arming rule — the load-bearing invariant this file's 30-line header calls out in red, the
one whose failure mode is *"someone will come hunting in the threshold logic below, which will be
perfectly correct"* — exists in **two copies**: the live one at `:74`
(`armed.current = expandedRange - C >= T`) and this unreachable, untested one. The comment asserts
a protection the repo does not have, and the second copy is precisely the thing that can drift away
from the first without anything failing.

**Simpler form:** one of two, PES.1's call — (a) write the test the comment promises and have `:74`
call `collapseIsArmed(expandedRange)`, so there is one rule; or (b) delete the function and the
comment. **(a) is the right one**, because the header explains why this rule is subtle. What must
not persist is the current state, where the comment says (a) and the code is (b).

---

**A9 · The `.d.ts` reintroduces the exact omission its source calls "a real defect"**
`design-system/grid/editors/roundTrip.d.ts` vs `roundTrip.ts` · lane **PES.2** / **DS.1**

The source's `SaveOutcome.version` carries this comment:

> *"🔴 This field is load-bearing, and its absence was a real defect. … a caller that keeps sending
> the version it first read has its SECOND edit to that row refused with 409 VERSION_CONFLICT …
> this type dropped it on the floor, so the defect was invisible to the compiler."*

The committed declaration is:

```ts
export interface SaveOutcome { ok: boolean; reason?: string; }   // version: gone
```

**Measurement.** I diffed every exported shape in `design-system/**` against its `.d.ts`
(221 shapes across 143 files). **Six genuinely disagree**, and I disclose that **seven further
flags were my own extractor's artefacts** — union type aliases (`SortDir`, `SortValue`,
`GridStateApi`, `TextareaProps`, `StampKind`, `PreferencesAggFunc`, `SectionWidth`) that it could
not parse; I checked each by hand and all seven are present and correct.

The six real ones:

| declaration | omits | who is hurt |
|---|---|---|
| `grid/editors/roundTrip.d.ts :: SaveOutcome` | `version` | the CAS round-trip — see above |
| `grid/filters/gridFilters.d.ts` | `GridFilterDef`, `GridFilterOptions` entirely | filter authors |
| `components/Drawer.d.ts :: DrawerProps` | `mode`, `resizable`, `minWidth`, `maxWidth`, `onWidthChange` | **hub #14's `<Drawer mode="dock">` is invisible in the declaration** (0 mentions of `mode` in the `.d.ts` vs 6 in the `.tsx`) |
| `components/Tabs.d.ts :: TabsProps` | `idBase` | `StudioBar.tsx:111` passes it |
| `patterns/DetailHeader.d.ts :: DetailHeaderProps` | `backAsChild`, `meta`, `status`, `dense`, `className` | `dense` is the studio header's 48 px mode |

For scale: `npm run check-ds-dts-fresh` is red on **43** declarations, **28** of them inside
`design-system/grid/**`. Most of those 28 are stale in ways that do not change a prop list — I spot-
checked `GridSheet.d.ts` and its props match exactly. The measured harm is the six above, and it is
the `reference_stale_dts_makes_the_next_lane_build_worse` class each time: the brief tells lanes to
read the `.tsx`, and tooling reads the `.d.ts`.

**Simpler form:** `node scripts/check-ds-dts-fresh.mjs --write`. Owner: **DS.1**, who already holds
the regeneration pass.

---

### B — the same thing solved twice

**B1 · Two DS `ToastProvider`s, both landed, both from hub ruling #22.**
`_studio/StudioClient.tsx:39` (the "NOW" half, PES.1) and
`design-system/grid/hosts/GridToastBoundary.tsx` (the "SUBSTRATE" half, PES.2).
**Measurement:** walking the live fiber tree, the chain reads
`StudioClient → ToastProvider → StudioStateProvider → … → MasterSheet → GridSheet →
GridDensityProvider → GridToastBoundary → ToastProvider → NexusGrid`, and every studio commit shows
`ToastProvider ×3` (the root layout's legacy one, plus these two). Both fixes were correct when
written and the ruling said nesting is harmless. It is harmless for *crashes*; it is not
neutral for *behaviour*, because a toast raised inside the grid and one raised by the header now
resolve to two different providers with two different queues. **This is a question for the hub
rather than a defect I can rank** — see §5 Q3 — but the duplication is now real and measured, and
whichever provider is redundant should be removed rather than left as two.

**B2 · One predicate, two lanes.** `_studio/viewChips.ts:26 viewChipHasCell(cells, rowId, colId)`
(PES.1) and `_studio/sheet/channel/viewChips.ts:171 chipHasCell(cells, rowId, colId)` (PES.3) are
the same "does this chip cover this cell" test over two cell types. `ChannelSheet.tsx` imports from
**both** files (`:55` and `:70`). Simpler form: make the frame's one generic over the cell shape and
delete the channel copy.

**B3 · Three answers to one absent cap** in one file — covered in A2/A3.

**B4 · A six-line comment block duplicated verbatim** — `contracts.tsx:577-583` and `:649-655`
("Looking around does not make history…"). Trivial, but it is the tell that the `push` helper was
moved and the old header left behind.

### C — abstractions with one caller, config never varied

**C1 · `marketplacesFailed`: an error signal computed, threaded through five files, and dropped.**
**Measurement:** 11 references repo-wide, **0 consumers**. `studio-data.ts:74` sets it `true` by
default and `false` on success; `page.tsx:41` and `StudioLoader.tsx:89` pass it; `StudioClient.tsx:41`
passes it on; `StudioFrame.tsx:36` destructures it as `_marketplacesFailed` and discards it, with
the comment *"Kept for the caller's contract; the empty-marketplaces case is now stated by the scope
bar itself."*

The scope bar does not state it. `StudioBar` renders channel chips from `options.channels` and
market options from `options.markets`, both derived from the marketplaces array. When the fetch
fails that array is `[]`, so the bar renders **Master and no channels, and a market switcher with no
options** — pixel-identical to a tenant that has configured no marketplaces. The honest signal
exists, is correct, and is thrown away one component before the place that needs it. Owner: **PES.1**.
Simpler form: either render it (a line in the scope bar: "Channels could not be read"), or delete
the prop from all five files. **Do not leave it drilled and discarded** — that is the shape that
makes a reader believe the case is handled.

**C2 · `useHeaderCollapse`'s entire public API is unreferenced.** The hook is used purely for its
side effect (`StudioFrame.tsx:39` calls it and discards the return). Measured: `reassess` — 3 grep
hits, all inside its own file, despite a doc comment instructing callers to *"Call when something
changes the row count, the viewport, the view or the drawer"*; `HeaderCollapse` — 0 references, and
it does not even describe the return (it declares `collapsedClass`, which is an **input**, and the
hook returns `{ reassess }`); `collapseIsArmed` — see A8. Simpler form: `useHeaderCollapse(frameRef,
collapsedClass): void`, interface deleted, ~25 lines. The `MutationObserver` + `ResizeObserver` pair
already covers what `reassess` was for; that is why nobody calls it.

**C3 · `textEditor`** (`design-system/grid/editors/index.ts`) — defined once, referenced nowhere,
including by its own file. Delete.

**C4 · A composition hook for a caller that does not exist — plus a live spread-order bug.**
`NexusGrid.tsx:217-224`. `handleNewColumnsLoaded` exists to compose a caller's own
`onNewColumnsLoaded` with `keepSelectionFirst`. **Measurement:** `grep -rn onNewColumnsLoaded
apps/web/src` returns **3 hits, all three inside `NexusGrid.tsx` itself** — no caller anywhere passes
one. For that non-existent caller the file carries an `eslint-disable-next-line
react-hooks/exhaustive-deps` and an `as never`. And the composition would not work anyway:
`onNewColumnsLoaded={handleNewColumnsLoaded}` is written at `:326`, **before** `{...agProps}` at
`:339`, and `onNewColumnsLoaded` is *not* destructured out of `agProps` (unlike `defaultColDef`,
`selectionColumnDef`, `onColumnPinned` and `onGridReady`, which are). The first caller ever to pass
one will silently lose `keepSelectionFirst`. Simpler form: destructure it out of `agProps` like its
four siblings, which removes the bug, the `as never` and the eslint suppression together.

**C5 · `GET /studio/columns` has zero callers.** Two independent methods agree: my resolved import
graph over 1,341 files finds no fetch or import, and BE.1's repo-wide path scan finds only a
future-tense comment at `_studio/sheet/master/views.ts:23`. The master sheet already builds its
column set from the `columns` array embedded in the `studio/sheet` payload. Whoever wires the route
later adds a **second source** for a fact the sheet already holds — and BE.1 measures the route at
0.42–1.43 s warm because it runs a full 21-row sheet read to answer.

**C6 · `CustomEditorModule` is registered with no caller** (`grid/modules.ts:104`, self-documented
by the lane). Bundle bytes for a capability nothing uses; either drop it or note the intended
consumer.

**C7 · A fragment wrapping a single `<div>`** — `NexusGrid.tsx:306-307` / `:341-342`. One line.

### D — render cost → §4.

### E — type honesty

**E1 · Two `as never` at the seam where two lanes meet.** `_studio/sheet/channel/ChannelSheet.tsx:583`
and `:586`:

```ts
defaultViewColumns(data.columns as never, { …, flaggedKeys: flaggedColumnKeys(rows as never) })
```

Both functions are PES.2's, declared in `sheet/master/views.ts` against the *master* row and column
types; PES.3 passes channel shapes through with the checker switched off. This is the one place in
the two trees where a **shared abstraction is reused across a lane boundary with no type contract
at all** — which is the exact seam that hub ruling #25's cross-lane contract-test pattern exists to
protect, and the one seam that has neither a contract test nor a type. Simpler form: widen
`defaultViewColumns`/`flaggedColumnKeys` to the common shape they actually read (they touch `key`,
`group`, `storage`, `requiredBy`) and delete both casts. Owner: **PES.2** to widen, **PES.3** to
consume.

**E2 · `.d.ts` drift** — measured in A9.

**E3 · Three `.includes(x as never)`** — `ImageViewer.tsx:159`, `views.ts:238`,
`MasterSheet.tsx:338`. The honest spelling of the readonly-tuple `.includes` workaround is
`(ARR as readonly string[]).includes(x)`, which keeps the argument checked. Cosmetic; listed for
completeness because a grep for `as never` should come back with a defensible answer for every hit.

**Full `as`-cast census, both trees, product code only:** 5 `as never`, 5 `as unknown as`, **0
`as any`**. That is a good number for 30,000 lines, and it is why the two at E1 stand out.

### F — the old page's shape carried in

**F1 · A silent fallback to the old catalogue endpoint.** `_studio/sheet/master/useMasterSheet.ts:217-231`
plus `adaptLegacy.ts` (163 lines) and its 6 tests. The read tries `/studio/sheet`; on 404 it falls
through to the **old page's** `/api/products/sheet` and adapts the payload.

Two observations, one of which is a defect:

- The disclosure is honest and good: a `meta.source === 'legacy'` Pill reading *"adapted read"* with
  a tooltip saying the layer each value came from is **inferred** rather than stated. Keep that.
- **The network failure and the 404 are conflated.** `fetch(studioUrl).catch(() => null)` at `:217`
  makes a dropped connection produce `studio === null`, which then takes the *same* branch as a
  deployed-but-absent route and silently reads the legacy endpoint. The code immediately below is
  careful about exactly this distinction for HTTP status (*"a 403 answered by silently adapting
  would hide a permissions problem"*) — the transport case slipped past the same reasoning.

**Measurement:** I called `/studio/sheet?market=DE&locale=de` against the running API and it
answered **200** with 96 columns. The route is deployed. Simpler form: keep the 404 branch, and let
a transport failure throw like every other failure (`if (!studio) throw new Error('Could not reach
the studio sheet')`). Owner: **PES.2**. The wider question — whether the legacy adapter should exist
at all now that the route ships — is §5 Q1.

---

## §3 What is well-built, and must not be "simplified"

Named, with the reason, because a simplification pass is exactly how these get lost.

**Each entry is labelled `[read]` or `[watched]` (hub #288).** `[watched]` means I saw the code
execute and have the measurement; `[read]` means I reviewed the source and did not see it run — a
rehearsal could still overturn it. **After hub #294 I ran the cheap probes before publishing the labels, and five items moved from
`[read]` to `[watched]`.** The probe is 60 lines of `tsx` in scratch space importing the pure
modules directly — no network, no database, no product file touched, ~35 seconds to run, and it
had been available all night. **21 assertions, 21 pass.** What is still `[read]` is listed with
exactly what it would take to watch it.

**A second probe round then took it further: ten of twelve are now `[watched]`, and only TWO need
jsdom** — which matters because **jsdom is not available** (see below). Two of my assertions failed
in that round and **both were my own, not the code's** — correcting them produced stronger tests
than I first wrote, which is the second time in this review that checking a failure carefully turned
it into a better result (the first was withdrawing A6). This is not a formality:
**item 1 is the case the rule was written for.** I praised `sheetWriter.ts` in pass 1 from its
source, and pass 2 then found a latch in it (P2-1) that no amount of reading the design would have
ranked correctly — the hole is in what happens when a promise never settles, which is invisible in
the shape of the code and obvious the moment you ask what runs.

1. `[watched]` **`design-system/grid/editors/sheetWriter.ts`.** ⚠️ **Partly overturned by P2-1, then fixed and verified.** The design praise was a `[read]` and the latch was invisible to it — hub #288's exemplar. PES.2's deadline is now on disk, and I **watched it work**: a stub `commit` that never settles is refused after **31 s** with `"The server did not answer within 30s — this change was not saved."`, `busy` returns to `false`, and a second edit to the same row **is actually sent** (`commits=2`). That is the rehearsal, run read-only. Per-row coalescing, a monotonic
   version map, serialised in-flight writes, per-cell outcome painting, and an unmount flush that
   *sends* the queue instead of clearing it. Its header states the limit of its own guarantee —
   that `Product.version` advances only on this CAS path while 124 other write sites do not bump it,
   so a winning CAS can still overwrite a sync job. **A component that documents what it does not
   protect against is the standard the rest of the tree should be held to.** Do not touch it.

2. `[watched]` **`_studio/readiness.ts::parseReadinessResponse`.** On screen it turned a live payload into `Master 71% · Amazon 71% · eBay —`; the probe then exercised every rejection branch on synthetic input: `"92"` → `null` (not 92), `NaN` → `null` (not 0), an out-of-vocabulary state → `absent`, a **measured** `0` survives as `0`, a row with no `id` is dropped, a non-array payload yields `{}`. Nothing here can invent a percentage, and now that is watched rather than believed. Reads the wire as `unknown`, drops rows it
   cannot understand rather than guessing, keeps a measured `0` distinct from "not scored", and
   passes the server's refusal sentence through verbatim rather than re-templating it. This is the
   reference implementation of `reference_wire_parse_boundary_rules` in this repo. Note the
   contrast: everything in §2A is a wire boundary *without* a parser like this one.

3. `[read]` **`NexusGrid.tsx` as a thin pass-through.** I read its live configuration back through the AG API (row/column virtualisation on, `rowBuffer: 10`, theme and density applied), so the *config* is watched; the claim that the thinness is right is a design read. Its header explains that `AgWorkspaceGrid` and
   `AgDataGrid` failed by re-expressing AG through an in-house contract, and that *"the bug did not
   need fixing; it needed the compatibility layer removed."* The four things it does add each carry
   a measurement. Resist any request to add a `toolbar` prop or a column-type abstraction — the file
   already says why, at `:133`.

4. `[watched]` **The URL-write coalescing in `contracts.tsx`.** ⚠️ **The mechanism under this changed on 2026-09-02: `flushUrl` now calls `history.replaceState`/`pushState`, not `router.replace`/`push` (D3's fix).** Any probe written for this must assert on **`window.history.replaceState`** (and `pushState` for `pushHistory`) — one written against `router.replace` would pass for the wrong reason, which on this subject would be a poor joke (PES.1's phrase, and their catch). **A second correction to my own framing:** the coalescing produces one navigation per **tick**, not per gesture — two writers in the same microtask coalesce, two writers 300 ms apart are correctly two navigations. Assert on the microtask boundary, not wall-clock. Measured: one navigation per interaction (exactly one RSC request per chip toggle), and the patch-don't-rewrite rule held — toggling the chip preserved `?market=ES` rather than dropping it. One navigation per tick, `replace` for
   looking around and `push` only for opening a record, with `alive` set **true on mount** rather
   than only false on cleanup (`reference_strictmode_latching_cleanup_flag` — the comment names the
   session where that silently disabled every URL write in dev). Every line has a paid-for reason.

5. `[watched, in part]` **`useInFlightGuard` + `saveState.ts`.** The pure half is now watched: `pendingWrites({kind:'error', pending:3})` returns **3**, so writes still in flight after a refusal are guarded — the subtle bit the file's own comment says the original check got wrong. `shouldInterceptLeave` correctly lets a ⌘-click and a same-page link through. **Still `[read]`:** that the listeners actually fire, which needs a session and an in-flight write. Autosave does not remove the need for a nav guard, it
   changes what is at risk; the guard hooks both `beforeunload` *and* a capture-phase click, and
   keys off `pendingWrites(state)` rather than `kind === 'saving'` because an error state carries
   its own pending count. That last detail is the one a simplifier would delete.

6. `[watched]` **`readinessMeta(state, vocabulary)` and the drawer's 20-line re-export.** My first
    assertion here **failed and was wrong**: I asserted the two vocabularies must give `ready` a
    different label. The file says the opposite in prose — *"`ready` is the one name both
    vocabularies share, and it means the same thing in both"* — so identical label and tone is the
    design, and what distinguishes them is `vocabulary` and `hint`. Corrected, and then the property
    actually worth watching: **an unknown state renders its own name in neutral, never "Ready"**
    (`readinessMeta('totally-new-server-state','row')` → label `totally-new-server-state`, tone
    `neutral`, hint *"Unrecognised row readiness state"*). All nine states in both tables resolve
    with a hint; no converter between vocabularies is exported.
   `_studio/drawer/readinessMeta.ts` is technically an indirection with one caller, and I am
   explicitly **not** filing it: it is six lines of re-export plus a header explaining why the two
   readiness vocabularies never get a converter. That header is worth more than the file costs.

7. `[read]` **`grid/renderers/cells.tsx::EmptyValue({ measuredZero })`** and `NumericCell`'s `zeroTitle`. The
   substrate already built the honest-zero primitive that §2A's eight sites bypass. The fix for most
   of A1/A4/A5/A6 is to *use the thing that exists*, not to write anything new.

8. `[watched]` **The editing hot path.** Measured: **three keystrokes inside an open cell editor produce zero
   React commits in the studio** (§4). AG's editor is imperative and nothing in the studio is
   subscribed to it. That is the correct architecture and the profiler agrees; do not "improve" it
   with controlled state.

9. `[watched, in part]` **`matchPasteToHeaders`** — the data-loss protection is watched: a two-column block over five target columns returns `["A-1","Widget",null,null,null]`, so the three columns the paste did not name come back **`null`, not `""`** — which is what stops AG blanking them. A header block matching fewer than two columns pastes as-is. **Still `[read]`:** `sheetPasteProcessor`'s AG half (turning each `null` back into the cell's current value), which needs a live grid. (`grid/editors/sheet.ts:57-128`), and
   especially its comment: a two-column paste used to blank every column to its right, *"and the
   test that covered this asserted the empty strings, so it described the implementation instead of
   protecting the operator."* Keep the code and keep the comment.

11. `[watched]` **`images/channel/amazon/publishPlan.ts` — the publish gate.** Every claim I made when withdrawing A6 is now executed rather than read: `readiness: null` → `canSubmit:false`, `"Checking publish settings…"`; `validation: null` → `canSubmit:false`, `"Running preflight…"`, with `blockedAsins` a literal `0` sitting behind `canSubmit:false` rather than presented as a measurement; `mode:'gated'` → `rehearsalOnly`; and **an invented mode the server has never sent (`'something-new-from-the-server'`) also degrades to `rehearsalOnly`**, which is the open union failing safe. No label contains the word "published". (added after I wrongly filed it
    as A6; reading it properly is what withdrew the finding). It is the only surface in the images
    tab that reaches a real marketplace, and every rule in it is defensive in the right direction:
    a `null` readiness is *neither* "gated" nor "live" and refuses to offer a submission it cannot
    describe; the mode is the server's `getAmazonPublishMode()` answer and never re-derived in the
    browser; `rehearsalOnly = !readiness.enabled || readiness.mode !== 'live'` treats **anything
    that is not exactly `live` as a rehearsal**, so its open `PublishMode` union degrades safely;
    the dry-run flag and the server gate are reported as two separate facts because an operator who
    turned dry-run off still needs to be told the gate is closed; and the button never says
    "published" because an Amazon feed submission is asynchronous — the honest verb is "queued".
    This is the model for how the rest of §2A should read.

10. `[watched]` **`useChannelSheet`'s commit ordering** — exercised with a stubbed `fetch`, no
    network. `errors[]` **wins over an inflated `updated: 1`** and the refusal is mapped back onto
    the cell that caused it; `updated: 0` with no errors is refused rather than painted saved; and
    the residual exposure BE.1 and I narrowed to is confirmed as the only hole (`updated ≥ 1` with an
    empty `errors[]` reports ok). My 409 fixture **also failed and was also my fault** — I sent
    `currentVersion` with no `versionOf`, and the code correctly asserted *no number at all*
    ("Someone else changed this row first"), which is precisely what its comment promises. Corrected
    fixtures then watched the real contract: `versionOf:'product'` returns 25 as the write result's
    version; `versionOf:'channelListing'` writes 25 onto `row.listing` and **deliberately does not**
    return it as the product version — the exact defect its comment describes (a listing version
    poisoning the product row's next CAS), now demonstrated rather than trusted. **Still `[read]`:**
    that a real channel write round-trips, which needs a session and XAVIA.
    ⚠️ **Safety note for anyone repeating this:** `getBackendUrl()` falls back to the **production**
    Railway URL when `NEXT_PUBLIC_API_URL` is unset, so any probe importing a module that calls it
    must stub `fetch` *before* the import. Mine did, and asserted afterwards that all four captured
    calls went to a dead localhost port and none to production. (`:281` before `:291`). Checking `errors[]` before
    `updated` is what makes BE.1's server-side `updated`-over-counting invisible to the operator on
    that path. It reads like belt-and-braces; it is load-bearing.

12. `[watched]` **`images/local/browserStore.ts` + `publishPrefs.ts`** — probed with a fifteen-line
    `localStorage` shim, no jsdom. `storageAvailable()` really does write-and-remove rather than
    feature-detect, and a store that **throws** on write reports unavailable instead of crashing the
    tab; a stored value the parser rejects reads as `null` rather than a coerced object;
    unparseable JSON reads as `null` rather than throwing; a blocked store returns `null`/`false`
    on read/write. And the rule that matters most: **a channel stored as a non-boolean is dropped,
    so a corrupted entry can never read as "auto-publish on"** (`{AMAZON:'yes', EBAY:true}` →
    `{EBAY:true}`). This was the item I said I would do next, and it was worth it. — how to ship a browser-only feature
    honestly.** Every `localStorage` access is wrapped (it *throws*, not merely returns null, when a
    browser blocks site data); `storageAvailable()` **probes** rather than assumes; stored data is
    parsed as untrusted input with a `parse` that returns null to reject, so "a stored value that no
    longer fits the current shape is dropped, never coerced into a plausible-looking lie"; and the
    scope caveat lives in **one exported sentence** (`STORAGE_SCOPE_NOTE`) rather than in each
    component's memory. Best of all, it ranks its own three features by risk: auto-publish and the
    approval gate are per-operator choices where browser scope is "merely inconvenient", but *"a
    rollback point that does not follow you is a safety net that is not there when you reach for
    it — and you only find out at the moment you need it"*, so `snapshotWarning()` puts that where
    the restore control is rather than in a settings page nobody reads.

**What is still `[read]`, and exactly what it would take** (hub #294). Only **two** items remain,
and **jsdom is not available in this repo**: it is not a devDependency in any `package.json`, not
installed under any `node_modules`, and not transitively resolvable (`require.resolve('jsdom')` →
`MODULE_NOT_FOUND`); neither is `happy-dom` or `@testing-library`. `apps/web/vitest.config.ts` sets
`environment: 'node'` and its header states the policy directly: *"no new dependencies… The day a
test needs to render a component, that is the day to add jsdom and a React plugin, and not before."*

- **Item 7, `EmptyValue({ measuredZero })`** — a React component. Needs jsdom + a React plugin, or
  it goes to PES.2 as a request with my probe attached.
- **Item 4's StrictMode half** — the `alive`-set-true-on-mount guard needs a double-invoke render.
  Same dependency. (The coalescing half of item 4 is already `[watched]` from the browser.)
- **Item 3, `NexusGrid`'s thinness**, is not a testable claim at all — it is a design judgement about
  what the file declines to abstract, and I am labelling it honestly rather than inventing a probe
  for it.

---

## §4 The top three re-render sources, with numbers

Instrument and controls in §0. All at **21 rows**, master scope, GALE-JACKET
(`cmokmy3a40078pm0p1fvnu523`), 1728×906, dev build, 00:52–01:06.

### D1 — Opening the record drawer: **18 commits, 254.3 ms** 🔴 the largest cost in the studio

| commit | ms | what re-rendered |
|---|---|---|
| 6 | **78.0** | `ToolbarButton ×192`, `Tooltip ×192`, `InfoTip ×100`, `RecordField ×96`, `ProvenanceChip ×96`, `Field ×96` |
| 14 | 38.4 | the same 96 fields |
| 13 | 36.0 | the same 96 fields |
| 10 | 26.4 | the same 96 fields + `RecordDrawer`, `Drawer`, `RecordPane`, `GalleryStrip` |

**178.8 ms of the 254.3 is the same 96 fields rendered four times.**

Two independent causes, both fixable without touching behaviour:

1. **Every group starts expanded.** `RecordPane.tsx:75` is
   `useState<Record<string, boolean>>({})` with `isOpen = !collapsed[group]`, so on open every group
   renders every field — all 96, of which the operator asked to see one (`focusKey`). The collapse
   mechanism is already built and wired.
2. **`RecordField` is not memoised, and cannot usefully be**, because `RecordPane.tsx` hands each
   one four fresh closures per render (`onWrite={(value, intent) => onWrite(col, value, intent)}`,
   `onReset`, `onHistory`, `onCompare`). So each of the four commits re-renders all 96 fields plus
   their 2–3 `ToolbarButton`s and `Tooltip`s each — that is where `ToolbarButton ×192` comes from
   (`RecordField.tsx:169-174`: "Field history" and "Compare across scopes" mounted per field).

**Simpler form (≤ 5 lines, PES.4):** have `RecordField` call `onWrite(column, value, intent)` with
the column it already holds, so the parent can pass **one stable** `onWrite`/`onReset`/`onHistory`/
`onCompare`; then `export const RecordField = memo(function RecordField…)`. Commits 10, 13 and 14
become near-free. Expect ~180 ms → ~80 ms with no visual change. Starting groups collapsed except
`focusKey`'s is a second, larger win but it is a product decision, not mine — routed to SR.1/PES.4.

### D2 — One row-selection tick: **4 commits, 29.5 ms**, of which **17.5 ms repaints every cell**

| commit | ms | rendered |
|---|---|---|
| 1 | 7.2 | `MasterSheet`, `GridSheet`, `NexusGrid`, `FamilyBar`, `FamilySelectionBar`, `BulkActionBar`, `StudioDock`, `PreferencesModal`, `AddVariationDialog`, `GridViewsMenu`, `Modal ×2`, `InfoTip ×7` |
| 2 | **17.5** | `CellComp ×189`, `cellRenderer ×147`, `ProvenanceMark ×147`, `LongTextCell ×63`, `RowComp ×21`, `HeaderCellComp ×9`, `HeaderFilterCellComp ×9` + the whole sheet subtree again |

Ticking one checkbox re-renders **189 cells**. Note what else is in commit 1: `PreferencesModal`,
`AddVariationDialog` and two `Modal`s — all **closed** — plus `StudioDock`, which is a child of
`MasterSheet` (`StudioClient → … → MasterSheet → StudioDock`) and therefore re-renders with every
sheet render whether or not a record is open.

**Simpler form (PES.2):** the sheet's own toolbar/footer subtree does not depend on selection —
selection reaches `FamilySelectionBar` through `selectedRows`. Memoising `FamilySelectionBar`'s
siblings, or lifting the closed dialogs out of the render path until they open, removes commit 1's
work. Commit 2's 189-cell repaint is AG's and is expected for a selection class change; it is listed
so nobody hunts it.

### D3 — ✅ FIXED AND VERIFIED. Every URL write cost a server round-trip; it now costs none

**Resolved by PES.1 (#284): `flushUrl` now calls `history.replaceState` / `pushState` instead of
`router.replace` / `router.push`** (`contracts.tsx:734-735`, mtime 07:17:32) — the App Router issues
an RSC request for the route regardless of whether anything server-side reads the URL, and
`page.tsx` never reads `searchParams`.

**Verified independently rather than accepted in prose.** Three URL writes — chip on, chip off,
scope → AMAZON — **0 RSC requests**, against my original reading of **1 per write at 703 ms and
579 ms**. (The 8 `/api/` calls in that window are the Amazon scope legitimately loading its own data,
not round-trips.) PES.1's own control, taken by reverting their fix to get the baseline row, agrees:
`router.replace` 2 toggles → 2 RSC requests; `replaceState` 2 toggles → 0; 3 scope switches → 0.

**Back/forward still work** — `pushState` writes a real history entry and Next's popstate handler
picks it up — so the drawer's Back-closes-the-record behaviour survives.

The rest of this section is kept because the diagnosis was wrong twice before it was right, and both
corrections are the point.

### ⚠️ The original entry, and its two corrected causes

**As filed I gave the wrong cause, and PES.1 was right to refuse it.** I wrote that
`useSearchParams()` returns a new object "and every memo downstream of it recomputes". PES.1
checked all 15 dependency arrays in `contracts.tsx` and none holds the `search` object — the memos
depend on extracted **strings** (`marketParam`, `scopeParam`, `localeParam`, `chipParam`), and the
only raw use is `searchRef.current = search.toString()`, an assignment. **That half of my finding is
withdrawn.**

**And my "17 of 56 hooks changed" was 9 real changes plus 8 artefacts of my own instrument.** React
recreates a `useEffect`'s memoized cell on *every* render whether or not its deps changed
(`pushEffect` runs unconditionally; only the `HasEffect` tag is conditional), so a hook-identity
diff counts every effect as "changed". Re-run with the cells classified by kind: **9 memo/callback
recomputes, 8 effect cells (artefact), 0 state changes.**

**Re-measured at 01:55 on the current build, and the real cause is neither mine nor PES.1's
alternative.** Toggling one view chip, twice:

| reading | RSC request | bytes | React commits | React ms |
|---|---|---|---|---|
| chip off | **1 × 703 ms** | 4,310 | 8 | 54.2 |
| chip on | **1 × 579 ms** | 4,333 | 36 | 127.7 |

`router.replace()` issues an **RSC request for the same route**, and `edit/studio/page.tsx` is
`export const dynamic = 'force-dynamic'` + `revalidate = 0` and calls `await loadStudioData(id)` —
which is **two API fetches** (`/api/products/:id` and `/api/marketplaces/grouped`). So the server
component re-executes on every scope / market / locale / tab / chip change.

**A view chip filters rows that are already in memory, and it costs a ~0.6 s server round-trip.**
That is the item against the Owner's "extremely functional and efficient", and it is
twice-measured and stable, unlike the React figures which vary 35–128 ms with what the chip
actually filters.

On one of the two readings I also caught the downstream cascade directly: `StudioStateProvider`'s
**props** `product`, `marketplaces` and `children` all arrived with new identities, so
`options = useMemo(deriveScopeOptions(marketplaces), [marketplaces])` missed and `market`, `scope`,
`locale`, `coordinate` and `scopeValue` recomputed behind it — which is how a fresh RSC payload
reaches the sheet. **I saw this once in two readings and I am not generalising it**: on the second
toggle the provider's props kept their identity. It is a real consequence of the round-trip, not a
reliable per-toggle one.

**This changes the fix, and it is why the item should not simply become "split the provider".**
Splitting `ScopeCtx` improves granularity for genuine changes, and it is worth doing — but it does
not stop `scopeValue` gaining a new identity when `options` recomputed from a `marketplaces` array
the server just re-sent, and it does nothing at all about the round-trip. In order of value:

1. **Stop re-running `loadStudioData` on a URL-state change.** `page.tsx` never reads
   `searchParams`; the studio's whole state model is client-side. This is the ~0.6 s.
2. Stabilise `options` so a re-sent-but-equal `marketplaces` does not invalidate it.
3. Then split the provider for granularity.

One asymmetry worth PES.1 knowing: **the two load paths behave differently.** `StudioLoader` (the
client second pass) holds the payload in `useState`, so its identity is stable across root
re-renders; `page.tsx` (the server path) hands down a fresh payload each time. I measured with
**`StudioLoader` NOT mounted** (verified by walking the fiber tree: `loader: false, client: true`),
i.e. the server path succeeded locally. Under RBAC-enforce in production the server load 401s and
the client path takes over, so the *prop-identity* half may be local-dev-specific — **the
round-trip is not**, because `page.tsx` runs `loadStudioData` either way before deciding which
branch to render.

**The nav rail (§4 "Ambient") is very likely the same cause**, as PES.1 suggested — a root-level
RSC re-render re-renders `AppShell` and everything unmemoised below it. I have not confirmed that
and am not claiming it.

### D4 — the one genuinely O(rows × columns) computation

`MasterSheet.tsx:493` — `missingRequiredChip`:

```ts
for (const row of rows) {
  const keys = row.completeness.required.missing
    .map((m) => m.key)
    .filter((k) => schemaColumns.some((c) => c.key === k))   // linear scan, inside two loops
```

At today's 21 rows × 42 missing cells × 96 columns that is ~85,000 comparisons per recompute; the
same family at 300 rows is ~1.2 M. **Simpler form (one line):** hoist
`const schemaKeys = new Set(schemaColumns.map((c) => c.key))` out of the loop and use
`schemaKeys.has(k)`. This is the only place I found where row count, not viewport, drives the work
— which is the honest partial answer to the 300-row question I could not measure.

### Ambient, and not mine

`AppNavRail` + `AppRail` + 29–30 `LinkComponent`s + `MarketsModal` re-render on nearly every
interaction, 4–7 ms each, 1–3 times per interaction (opening a cell editor: 2 rail commits,
11.8 ms, while the studio itself did nothing). Idle controls at matching durations produced 0
commits, so it is interaction-driven. Source is `app/_shared/AppNavRail.tsx` — outside both my
trees. On the numbers above it is comparable to the entire cost of a selection tick.

---

## §5 Questions for the Owner

**Two are live. Three have been settled since I filed them** — by a hub ruling or by a lane simply
implementing the recommendation — and I am marking them rather than leaving five questions in front
of the Owner, because five asks where two are real is the same waste of attention this review is
about. The settled three are kept, not deleted, so the Owner can overturn any of them.

**Q1 — Does the legacy sheet fallback stay?** `useMasterSheet.ts:217` still falls back to the old
page's `/api/products/sheet` when the studio route 404s, and `adaptLegacy.ts` (163 lines + 6 tests)
exists to translate it. The studio route answers 200 today (I called it). Under §2.10 and D9 —
*"old trees are specification, never source"*, *"a link to a legacy page is a parity defect"* — the
fallback is the same shape as a link-out: it keeps the old approach alive as a live code path.
Keeping it buys resilience if the route is ever un-deployed; removing it deletes ~200 lines, one
disclosure Pill, and a second definition of what a sheet row is. **Not a lane's call.**

**Q2 — `Product.version` semantics** (already in the Owner queue; restated because two findings sit
on it). `SheetWriter`'s guard protects editor-versus-editor only: the CAS path bumps the version,
124 other write sites do not, so a winning CAS can overwrite a sync job's write with neither side
noticing. The writer documents this honestly and cannot fix it from the client. A9 makes it worse in
one specific way — the shipped `.d.ts` drops `version` from `SaveOutcome`, so the compiler cannot
help a lane that gets it wrong. Fixing the declaration is DS.1's and needs no decision; **deciding
who bumps the version is architecture and needs yours.**

**Q3 — ✅ SETTLED by hub ruling #313; no Owner decision needed.** The grid host's provider now
mounts only when no ancestor provider exists (context-detect), so the studio has one queue and a
standalone grid consumer still cannot white-screen — keeping both halves of #22's intent. *(At my
02:33 re-check the ruling exists and the change has not landed: `GridToastBoundary` still wraps
unconditionally. Tracked as B1, PES.2's.)* The original question, kept for the record:
~~Which `ToastProvider` is the real one?~~ Hub ruling #22 assigned two fixes for one crash and
both landed: PES.1 mounts a provider at `StudioClient`, PES.2 bakes one into every grid host. Three
provider instances now render on every studio commit (measured in the fiber tree). The ruling said
nesting is harmless — true for crashes, not for behaviour: a toast raised inside the grid and one
raised by the header now go to different queues, so a "saved" toast and a "refused" toast can render
in two stacks. Either the frame's mount is redundant (and the substrate guarantee is the contract),
or the substrate's is (and every consumer must remember a provider — the thing #22 forbade). One of
them should go; **which one is a platform decision.**

**Q4 — ✅ ANSWERED BY IMPLEMENTATION, and the Owner may still overturn it.** A2, A3 and P2-2 all
landed with exactly the shape I recommended — **no counter and no ceiling** on a field the server
declares uncapped — so the decision was taken by default rather than asked. The new comment in
`sheet.ts` makes the reasoning explicit: an invented `maxLength` reaches a real textarea and the
BROWSER enforces it, so it is not advisory. **If the Owner would rather have a soft advisory, that
is now a reversal to ask for, not a gap to fill.** The original question:
~~When an uncapped field has no cap, should the sheet say anything at all?~~ A2/A3 will remove
three invented numbers. The operator is then editing a description with no counter and no ceiling,
which is *honest* but may feel like a regression from "there is a limit and I can see it". The
alternative is to show a soft advisory ("Amazon caps this at 2,000 on other product types") — which
is a different claim and, on today's server payload, would name the wrong channel. **My
recommendation is no counter and no ceiling**, because a number that is not a cap is the thing this
programme keeps paying for. Confirming it is yours.

**Q5 — ✅ BACKED; the mechanism was approved and built.** PES.3's `check-wire-null-defaults.mjs`
extends to `?? 0` / `|| 0` over a nullable wire number — type-checked rather than name-matched —
with `EmptyValue({ measuredZero })` as the consumer and a baseline of **17**, having caught two of
its own author's sites on the first run. That is the guard I asked for, and it is already running.
One correction to my own framing while I am here: my "80 occurrences" was the population I read,
never a defect count; **17** is the measured number. The original question:
~~Is "Available 0" ever acceptable?~~ A1 is trivially fixable and I have filed it. But the same
`?? 0` shape appears eight times across three lanes (A1, A4, A5, A6 and four smaller siblings), each
written by someone who knew the rule. That suggests the rule needs a *mechanism*, not more
vigilance: the substrate already ships `EmptyValue({ measuredZero })` for exactly this. **Would you
back a lint rule or a push guard that fails on `?? 0` / `?? []` in a render path**, the way
`check-ds-dts-fresh` and the grid-kit ratchet already gate other classes? That is a programme
decision with a real cost to every lane, which is why it is here rather than in §2.

---

## §6 Pass 2 — `images/**`, plus two classes swept across both trees (hub #278/#279)

`images/**` is 79 files / 8,160 product lines — the largest sub-tree, and the one pass 1 sampled
least. Sub-tree sizes: `channel/amazon` 2,260 · `publish` 1,177 · `master` 1,108 · root 812 ·
`local` 748 · `channel/ebay` 464 · `editor` 391 · `plan` 375 · `dam` 258 · `viewer` 245 ·
`record` 171 · `ai` 151.

---

### P2-1 🔴 The one write path can latch permanently on a hung request, and lose a row's edits in silence

`design-system/grid/editors/sheetWriter.ts:219-248` (the latch) ·
`_studio/sheet/master/useMasterSheet.ts:96` and `_studio/sheet/channel/useChannelSheet.ts:221`
(the fetch that can hang) · lanes **PES.2** and **PES.3**

**Measurement, set-scanned across both trees:** of **35 `fetch(` call sites, 29 carry no `signal`
or timeout of any kind** (6 do — `contracts.tsx`'s readiness query is the model, with a 15 s
`AbortController` and a comment explaining that an unbounded wait is indistinguishable from a
skeleton that is merely slow). PES.1 estimated ~20 from their own tree; across mine the number is 29.

The dangerous subset is the intersection with hub #278's latch shape, and in these two trees it is
exactly one — but it is the one that matters:

```ts
// sheetWriter.ts
q.inFlight = true                                   // :219
result = await this.opts.commit({ … })              // :224   ← the app's fetch, no deadline
q.inFlight = false                                  // :248
// and the gate that reads it:
if (!q || q.inFlight) return                        // :190   schedule() gives up for this row
```

`commit` for the master sheet is `useMasterSheet.ts:96` — `await fetch('/api/products/bulk', …)`
with no `signal`. **A request that never settles latches `q.inFlight` true for the life of the
page.** From that moment every further edit to that row is accepted into the queue and never sent,
while `set()` has already painted each of those cells `saving` (`:182`). The operator sees a
spinner that never resolves and loses every subsequent edit to that row, with no error anywhere.
`flush()`'s settle loop at `:208` — `while ([...queues].some(q => q.inFlight || q.cells.size > 0))`
— would also spin forever, so a Publish that flushes first hangs rather than reporting.

**The `try/catch` around `commit` does not cover this.** It catches a *rejected* promise; a promise
that never settles is invisible to it, which is exactly why PES.1's `finally` never ran.

**I put `sheetWriter.ts` in §3 as exemplary and I stand by that** — the coalescing, the monotonic
version map and the unmount flush are all right, and its header is the best in the tree. This is a
hole in one line of it, not a verdict on the design.

**Simpler form, and it belongs in the writer rather than in each caller:** `commit` is called from
one place, so one deadline protects every present and future implementation —

```ts
result = await Promise.race([
  this.opts.commit({ … }),
  new Promise<SheetWriteResult>((r) => setTimeout(() => r(
    { ok: false, reason: 'The server did not answer within 30s — this change was not saved.' }, ), 30_000)),
])
```

`q.inFlight` then always clears, the cells paint `refused` with a true sentence, and the row keeps
working. Fixing it in the two `commit`s instead needs both lanes to remember, and leaves the next
`commit` exposed. **Risk:** low, but it changes write-path behaviour, so it wants a rehearsal
against XAVIA rather than a straight landing.

**✅ FIXED AND WATCHED (re-checked 02:12 by content, not line number).** PES.2 landed the deadline
in the writer, as `Promise.race` against a 30 s loser that **resolves rather than throws** so it
takes the same path as any other refusal — `sheetWriter.ts` mtime 02:04, with
`sheetWriter.timeout.vitest.test.ts` beside it at 02:06. I then ran it rather than reading it: a
stub `commit` returning `new Promise(() => {})` is refused after **31 s** with *"The server did not
answer within 30s — this change was not saved."*, `writer.busy` returns to `false`, and **a second
edit to the same row is actually sent** (`commits=2`, where the latched behaviour would have left it
at 1 forever). The original `Simpler form` I proposed is what landed:

```ts
result = await Promise.race([
  this.opts.commit({ … }),
  new Promise<SheetWriteResult>((resolve) => setTimeout(() => resolve(
    { ok: false, reason: 'The server did not answer within 30s — this change was not saved.' }), COMMIT_TIMEOUT_MS)),
])
```

**🔴 The class now has THREE confirmed instances, not one, and the third is PES.1's own** (2026-09-02): their no-stacking poll guards in `AppNavRail`/`NotificationsBell` cleared their flag in `finally` — and **a `finally` on a promise that never settles never runs**, so the first hung poll killed the notification badge for the life of the page, silently, under exactly the conditions the guard was written for. Proven both ways in isolation: *without* a timeout, `inFlight` latched `true` and the next tick was SKIPPED; *with* one, it cleared and the next tick ran. So: my P2-1 (`SheetWriter`), my A8 (a comment claiming a test that did not exist), and PES.1's poll guard — **every one a correct-looking source line whose defect is visible only when something runs it.** That is the argument for the 29 remaining deadline-less fetches being a class rather than a list.

**The 29-of-35 deadline-less fetch count still stands for everything else** — the writer now defends
its own path, but `useCompare`, `useFieldHistory`, `useRecordState`, the images API and
`useGridViews` are unchanged, and P3-1 below is what that costs in the drawer.

---

### P2-2 ⚠️ The 2,000-character wall was fixed at the call site and moved to 4,000 — a partial fix that presents as a fix

`design-system/grid/editors/sheet.ts:12` · lane **PES.2** / **AG.1**

PES.2 landed A2/A3 in `columns.tsx` (mtime **01:27**), and both changes are right:
`:148` is now `lengthValidation(col.maxLength ?? null, …)` — with `lengthValidation` widened to
`max: number | null` and returning `{ level: null }` when it is null — and `:279` is
`longTextEditor(col.maxLength ? { maxLength: Math.max(col.maxLength, 200) } : {})`, which correctly
passes **nothing** for an uncapped column.

**But `longTextEditor` re-invents the number the call site just stopped sending:**

```ts
cellEditorParams: { maxLength: opts.maxLength ?? 4000, rows: opts.rows ?? 8, cols: opts.cols ?? 60 }
```

**Re-measured on the running build at 01:52**, same method as A2 — not read, executed:

| column (server sends no cap) | editor `maxLength` before | after |
|---|---|---|
| `product_description` | 2000 | **4000** |
| `description` | 2000 | **4000** |
| `amazon_description` | 2000 | **4000** |

and with the editor open, the textarea's own DOM `maxLength` reads **4000**. The wall moved; it did
not go away. This is `reference_bulk_patch_routes_six_channel_fields`'s rule in a new place — *a
partial fix presents identically to no fix* — and it is only visible if you exercise the path
rather than diff the file that was changed.

**Simpler form (one line):**
`cellEditorParams: { ...(opts.maxLength != null ? { maxLength: opts.maxLength } : {}), rows: …, cols: … }`.
AG's own default is 200, so omitting the key is not "no ceiling" either — but that is AG's
documented behaviour rather than a number this repo invented, and it is the same for every consumer.

**A timeline correction, stated because it was relayed as fact:** the hub relayed that this was
fixed "about twenty minutes before your measurement". `columns.tsx`'s mtime is **01:27** and my
measurement was at **~01:20** — the fix landed *after* it. My original reading of 2,000 was correct
for the build it was taken on, and the 4,000 reading above is the current one.

---

### P2-3 One wire row, three declarations, two of them entered through `as unknown as`

`_studio/images/types.ts:81` (`ListingAsset`, 29 fields) ·
`images/channel/amazon/cascade.ts` (`CascadeRow`, 12) ·
`images/channel/ebay/buckets.ts:27` (`EbayRow`, 11) · lane **PES.7**

Both narrow shapes are **subsets by field name** — neither invents a field, which is the good half.
The problem is how they are entered:

```ts
matrixModel.ts:166  return listing.filter((l) => l.platform === 'AMAZON') as unknown as CascadeRow[]
EbayGrid.tsx:46     const rows = useMemo(() => ebayRows(listing as unknown as EbayRow[]), [listing])
```

`as unknown as` switches off the subset check entirely. Rename or retype a field on `ListingAsset`
and both mirrors keep compiling while resolving nothing — the matrix quietly renders empty cells.
Note the two are not even spelled the same way: the Amazon cast is *inside* the pure module, the
eBay one is at the *call site*.

**One thing I checked and it is NOT the finding I first wrote down.** Both mirrors widen
`publishStatus: PublishState` to bare `string`, which looks like the banked rule "add fields, never
relax the constraint". It is not, because **`PublishState` is already open** — see P2-4. The
widening costs editor autocomplete, not type safety. The cast is the defect; the field type is a
symptom.

**Simpler form:** `type CascadeRow = Pick<ListingAsset, 'id'|'scope'|'platform'|'marketplace'|'amazonSlot'|'variantGroupKey'|'variantGroupValue'|'url'|'locked'|'publishStatus'|'publishError'|'sourceProductImageId'>`
and the same for `EbayRow`. Both casts then delete themselves and the subset is checked by the
compiler. **Risk:** none at runtime; it is a type-only change that may surface real mismatches,
which is the point.

---

### P2-4 A type that documents four states and accepts every string

`_studio/images/types.ts:78` · lane **PES.7**

```ts
export type PublishState = 'DRAFT' | 'PUBLISHED' | 'OUTDATED' | 'ERROR' | (string & {})
```

`(string & {})` keeps autocomplete while accepting any string, so the four
`publishStatus === 'PUBLISHED'` / `=== 'ERROR'` comparisons in the tree
(`matrixModel.ts:193`, `EbayGrid.tsx:88-89`, `local/restorePlan.ts:91`) are **unchecked** — a typo
or a renamed server member compiles and silently never matches, and the "claiming live" count goes
quietly to zero. A reader sees four states named in the type and reasonably assumes the compiler is
holding them.

**Set-scanned:** four uses of `(string & {})` across both trees, **all four in `_studio/**`, none in
the grid substrate**. Three are correct and should stay — `StudioScopeId` (channel ids come from the
marketplace table), `MasterImageType` (Amazon slot codes are server-discovered), and `PublishMode`,
which is genuinely open *and degrades safely*: `publishPlan.ts:105` reads
`rehearsalOnly = !readiness.enabled || readiness.mode !== 'live'`, so anything that is not exactly
`live` is treated as a rehearsal. **`PublishState` is the one that is closed in reality and open in
the type**, and the only one whose comparisons decide what an operator is shown.

**Simpler form:** drop `| (string & {})` from `PublishState`, and let the wire parser degrade an
unknown value explicitly — the pattern `grid/renderers/cells.tsx:78` already uses
(`p.tones[key] ?? { tone: fallbackTone, label: key }`, rendering the raw key rather than guessing).

---

### §6.1 Negative results — things I checked in `images/**` that are NOT findings

- **Amazon and eBay are not a duplication.** 15 files / 2,260 lines against 3 / 464 looks like a
  fork until you read them: Amazon is a slot matrix (server-discovered `amazonSlotTaxonomy`,
  per-market rows, cascade resolution) and eBay is an ordered bucket list capped at 12 per
  variation. The exports share no shape beyond the row they both read. Building one abstraction over
  them would be the over-engineering, not the fix.
- **`images/local/**` is exemplary and goes in §3** — see item 12.
- **Hub #279's wrong-null guard: zero hits across both trees — and that zero is "already fixed",
  not "never existed".** My regex for `?.x === null` / `?.x == null` returns nothing, but
  `AnalyticsAdsTab.tsx`'s mtime is **01:54** and its line 317 now reads
  `analytics.quality.latestScore === null` *inside* a guarded branch — PES.7 landed the fix minutes
  before I scanned. A clean scan taken just after the only instance was repaired is evidence the fix
  landed, not evidence the class is absent, and I am not reporting it as the latter.
- **`?? 0` in `images/publish/**`** — the cluster I flagged in pass 1 as A6 is
  concentrated in accumulator loops (`counts.set(k, (counts.get(k) ?? 0) + 1)`), which are correct.
  The two that reach a screen are `PublishHistory.tsx:147` (`{jobSummary?.skuLines ?? 0} SKU lines
  reported`) and `:199` (`{auditSummary?.total ?? 0} entries`); both are inside a rendered summary
  block, so they are the A1 shape at lower stakes and belong to PES.3's `check-wire-null-defaults`
  baseline rather than to a hand-filed item.

---

### §6.2 A note on the 80-hit list, since PES.3 asked

My pass 1 reported "80 occurrences of `?? '<literal>'` / `|| '<literal>'`" and immediately said the
large majority are honest labels, naming three as defects. **80 was never offered as a defect
count** — it is the size of the population I read, which is what makes "three" meaningful. PES.3 is
right that a name-based match is not a measurement of the class, and their type-checked
`check-wire-null-defaults.mjs` baseline of **17** is the number to carry forward; my three sit inside
it (two of which have since been fixed). The useful thing my list adds is the *shape* to look for
beyond the literal, from A7: **a `??` whose left side feeds a parameter that has an explicit
`undefined` branch**, because that does not merely invent a value — it makes the file's own honest
fallback unreachable, and the honest text stays in the source for the next reader to find and
believe.

## §7 Pass 3 — `drawer/**`

4,081 product lines across 21 modules. `types.ts` 526 · `RecordDrawer.tsx` 521 · `RecordField.tsx`
360 · `RestoreMode.tsx` 291 · `HtmlField.tsx` 283 · `DrawerConfirm.tsx` 257 · four panes 570 ·
four hooks 494 · `drawer.module.css` 754.

---

### P3-1 🔴 Two of the drawer's three read hooks keep nothing to discard a superseded response — and one of them shows one field's history under another field's name

`_studio/drawer/useFieldHistory.ts:81` and `_studio/drawer/useCompare.ts:145` · lane **PES.4**
*(read, not observed — see the honesty note below)*

```ts
// useFieldHistory.ts:81
useEffect(() => {
  setEntries([]); setCoverageSince(null)
  if (productId && fieldKey) void load()
  else setStatus('idle')
}, [productId, fieldKey, load])          // ← no cleanup, no request id, no AbortController
```

`load()` ends in `setEntries(page.entries ?? [])` with nothing between the response and the state.
So this is **last-response-wins, not last-request-wins**: open field A's history, click field B
before A returns, and A's entries land in state while `HistoryPane` renders the label for B (the
pane takes `fieldLabel` as a prop from the current field, `:78`/`:83`). That is not a stale spinner —
it is **wrong data wearing the right label**, in the file whose 20-line header is an essay about
never conflating one history outcome with another.

**The measurement that makes this a finding rather than a style note is the contrast inside one
repo:**

| read path | staleness guard |
|---|---|
| `useMasterSheet.ts:196` | `requestRef` + `cancelled` — last-request-wins |
| `useChannelSheet.ts:102` | `requestRef` + `cancelled` |
| `drawer/useRecordState.ts:68` | `cancelled` flag with cleanup at `:100` |
| **`drawer/useFieldHistory.ts:81`** | **none** |
| **`drawer/useCompare.ts:145`** | **none** |

Three of five guard, and the two that do not are in the same folder as the one that does — so the
lane knows the pattern and applied it once. Both are also in the 29 deadline-less fetches, so a hung
request leaves the pane in `loading` for the session with no way back.

**Simpler form:** copy `useRecordState`'s own six lines — `let cancelled = false` … `if (cancelled)
return` … `return () => { cancelled = true }` — or, better, do it once (P3-2).

**Honesty note:** this is **read, not observed.** Reproducing it needs two field-history opens
against a slow API, and after P2-1 I am wary of ranking a control-flow reading as high as a watched
one. I state the mechanism, the contrast, and the fact that I did not see it happen. What would
settle it: open field A's history, open field B within the response window, and check whether the
entries under B's heading are A's.

---

### P3-2 Four read hooks, one shape, three byte-identical status unions

`useCompare.ts` (156) · `useRecordState.ts` (140) · `useFieldHistory.ts` (95) · lane **PES.4**

```ts
export type CompareStatus     = 'idle' | 'loading' | 'ready' | 'unavailable' | 'error'   // useCompare.ts:27
export type HistoryStatus     = 'idle' | 'loading' | 'ready' | 'unavailable' | 'error'   // useFieldHistory.ts:28
export type RecordStateStatus = 'idle' | 'loading' | 'ready' | 'unavailable' | 'error'   // useRecordState.ts:46
```

Three declarations of the same five states, and three hand-rolled copies of the same
`{ status, <payload>, error, reload }` plus fetch/`try`/`catch`/`setStatus` plumbing. Each one is
individually well written — the 404/501 → `unavailable` split is right in all three, and it is a
distinction most codebases never make.

**But P3-1 is what duplication costs here, and that is why this is worth doing rather than merely
tidy.** The staleness guard is not a shared behaviour that one hook forgot; it is a line each author
had to remember three separate times, and two of the three did not. One
`useStudioRead<T>(url, { enabled })` returning `{ status, data, error, reload }` — with the
`cancelled` flag, the request id, the 404/501 split and a deadline **inside it** — removes roughly
120 lines and makes the defect in P3-1 unrepresentable rather than merely fixed.

---

### P3-3 ✅ RE-MEASURED — 254.3 ms → 111.4 ms, and the repeat renders are gone

`_studio/drawer/**` · lane **PES.4** · taken 02:53–02:57 in a programme-wide freeze (hub #343)

Same protocol as the original, or the numbers would not be comparable: arm the profiler →
right-click a cell → "Open record" → wait 1.4 s → stop. A deep-link `?rec=` load measures *mount*,
not *open*, and I refused to substitute it.

| | before | after |
|---|---|---|
| commits | 18 | **18** |
| total React ms | 254.3 | **111.4** |
| `RecordField` renders | 96 × 4 = **384** | **7, once** |
| the four repeat renders of the whole pane | **178.8 ms** | **0** |

**The specific defect I filed is fixed: the field set is no longer rendered four times on open.**

**🔴 But this is NOT the memo fix in isolation, and the premise I was given said it would be.**
`RecordPane.tsx` (mtime 02:49:15, three minutes before the window) had already inverted its collapse
semantics — `const [open, setOpen] = useState({})` with `isOpen = open[group] === true`, where it
used to be `collapsed` with `isOpen = !collapsed[group]`. Measured on screen: 8 group heads,
**1 expanded, 7 fields mounted**, not 96. So the 143 ms saved is `memo(RecordField)` + stable
callbacks + collapsed-by-default **together**, and 7 fields against 96 is not like-for-like.
Splitting them would need a build with the memo and without the collapse, which no longer exists;
I am not asking a lane to revert one to satisfy a measurement.

**My pre-flight check missed it, and the miss is the interesting part.** I grepped for
`useState<Record<string, boolean>>({})`, found it, and reported "groups still start expanded". That
literal line survived the change untouched — the variable was renamed and the **predicate**
inverted. **I matched content that survived rather than content that carries the meaning.** Content
matching is only as good as the expression chosen, and I chose the initialiser instead of the
predicate: the same family as the line-number miss at 01:47, one level up.

**What the fix did NOT fix, and it is now the largest item in the interaction** *(mechanism
CORRECTED below — I first wrote that the sheet resizes, and it does not):* the biggest single
commit is **37.3 ms** re-rendering the grid — `CellComp ×189`, `cellRenderer ×189`,
`ProvenanceMark ×189`, `LongTextCell ×63` — because the sheet resizes when the dock opens. That is
**D2's 189-cell repaint arriving by a second route**, and with the drawer's own cost down it is now
the dominant cost of opening a record. Whatever fixes D2 fixes a third of this too.

**⚠️ MECHANISM CORRECTED (hub #398, re-measured 04:0x) — and a footnote on how I came to accept it
(hub #430).** PES.2 later **retracted** the geometry reading I aligned to here: their probe had
clicked the selection-checkbox cell so Enter never opened the dock, and their "is it open?" selector
matched an always-present element, so it reported `true` in every state — their original
"nothing changes" was taken with the dock closed throughout. Re-measured properly (root 1660 / sheet
1662 / cells 336 / cols 32, identical closed and open) **the conclusion stands** — but it was not
standing on a real reading at the moment I wrote this correction. My own independent grounds were
the `columnDefs` identity table below, which is what actually carried it; **I should have said that
the geometry half was taken on trust, and I did not.**

**⚠️ MECHANISM CORRECTED (hub #398, re-measured 04:0x).** I attributed the 189-cell repaint to the
sheet resizing when the dock opens. **It does not resize** — PES.2 measured viewport, root, sheet,
cells and columns all unchanged closed → open at 1728×906, and I accept that. The repaint is a
**prop-identity cascade**, which is better news than a resize because prop identity is fixable.

PES.2 then fixed two props that re-identified on every open (`onCellKeyDown` via `record`, and
`getContextMenuItems` via `famActions`), both now read through refs behind `useCallback(…, [])`. I
re-profiled: **the repaint is still there** — 756 `CellComp` across three commits, where it was 189
in one. *(Magnitude is not comparable — 9 visible columns then, ~11–14 now, because `useGridState`
persists column state to localStorage across sessions. The qualitative result is what matters.)*

**A third prop is doing it, found by capturing what AG holds and comparing across a dock close:**

| prop | identity across a dock close |
|---|---|
| `rowData` · `getRowId` · `context` | **same** ✅ |
| **`columnDefs`** | **new array** ❌ — while `columnDefs[0]` is the *same object* and the length is identical (104) |

**The container re-identifies while every element in it is stable**, so AG repaints cells for an
array rebuilt from unchanged parts. `columnDefs` is the `useMemo` at `MasterSheet.tsx:822`, deps at
`:831` = `[identityColumns, attributeColumns, readinessColumns, schemaColumns, viewCtx]`; the
record-derived input is visible at `:310-311` (`openRecordId: record.rowId`), and the file's own
comment at `:1000` already names the `lockedColumns → identityColumns → columnDefs` chain. Named as
the likely link, not asserted — PES.2 can bisect five deps faster than I can infer it from outside.

**✅ RESOLVED (hub #407/#408). Cause: a default parameter.** `MasterSheet({ …, variationAxes = [] })`
— evaluated on **every call**, and the studio never passes the prop, so a fresh array every render →
`viewCtx` (deps `[sheet, locale, variationAxes]`) → `columnDefs` → every cell repaints. Dock open was
never special; it was simply the render everyone happened to be watching, which is exactly why
`columnDefs[0]` was the same object with the length unchanged at 104. Fixed with a module-level
`NO_VARIATION_AXES` constant.

**Re-measured on `MasterSheet.tsx` mtime 04:13:29, fix verified by content first:**

| | baseline (04:07:00) | after |
|---|---|---|
| commits on a dock close | 31 | **4** |
| React ms | 125.1 | **45.9** |
| `CellComp` | 651 across 3 commits | **0** |
| **ratio (`CellComp` ÷ 315 DOM cells)** | **2.07** | **0.00** |

Second check, one keystroke in the quick filter — the right one, since the array was fresh on *every*
render and not only on open: **3 commits, 17.6 ms, `CellComp` 0**, with only `MasterSheet` /
`GridSheet` / `NexusGrid` re-rendering and not one cell. The 45.9 ms that remains on a close is the
App Router and nav rail (`LinkComponent ×29`, `OuterLayoutRouter`), i.e. **D3's RSC round-trip, not
the sheet.**

**Method caveats, because the input device was not what I intended.** My real Enter did not reach
`onCellKeyDown` and a real Escape did not close the drawer — **I checked whether that was a
regression rather than assuming it was my input, and it is not**: invoked through the AG api both
`onCellKeyDown` and `getContextMenuItems` behave correctly. So the dock was opened and closed through
the components' own handlers. **The re-render cascade under test is identical; only the device
differs.** Separately, under that programmatic open the dock rendered at x=1728 in a 1728px viewport —
almost certainly an artefact of skipping the layout pass that sizes the track, and **not filed**.

**🔴 What actually found it, and the lesson that generalises.** I measured the symptom and narrowed it
to "`columnDefs` is a new array of stable elements — one of these five deps". **My two named suspects,
`lockedColumns` and `openRecordId`, were both wrong** — which is why they were filed as "likely, not
asserted". PES.2 stopped hypothesising and **bisected the five deps with an in-page probe**, and that
is what turned five candidates into `viewCtx → variationAxes`. **A default parameter minting a fresh
array on every render is invisible to every grep any of us ran**, and only an instrument watching
identities across a render could catch it. So, beside the "check the event the cost rides on" rule:
**when a prop re-identifies and the memo deps all look innocent, instrument the deps — do not read
them.**

**🔴 The generalisable lesson, and it nearly closed this wrongly.** AG.1 measured that *"a new
`getContextMenuItems` identity fires **0** column-model events"* — **true, and irrelevant to this
cost.** A column-model rebuild and a React cell repaint are different things with different
triggers: AG can leave the column model completely alone and still re-render every `CellComp`, which
is exactly what a new `columnDefs` array identity does. It was a correct measurement of the wrong
quantity. **When a fix is verified by the absence of an event, check that the event is the one the
cost actually rides on** — the profiler counts commits; the column-model counter does not.

**Instrument note, banked because it cost me four failed attempts across two sessions:** the
browser window had been resized between sessions and I was carrying a stale screenshot-to-CSS scale
factor (1512×793 against a 1459×812 capture — every click ~6% off, which is why the AG context menu
"would not open"). It was not Fast Refresh, which is what I had assumed and told the hub. **Never
carry a scale factor between measurements; read the capture's own dimensions every time.** This is
the same trap I had warned SR.1 about two hours earlier.

---

### P3-4 🔴 The deep link does not land: `?cell=` scrolls nowhere, measured

`_studio/drawer/panes/RecordPane.tsx:113-118` · lane **PES.4** · **symptom measured, cause NOT established**

Raised by SR.1 from the operator side (they measured `scrollTop: 11` against a field at offset
1,429px). I checked it rather than amplifying it, because `RecordPane` **does** have a
scroll-to-field effect and the wiring is all correct — `?cell=` → `record.colKey` →
`StudioDock:146` → `RecordDrawer:463` → `focusKey` → `[data-field]` on `RecordField:305`. Every
link in that chain is present.

**Measured on a deep-link load** (`?rec=…&cell=weightUnit`, market PL, 30 fields):

| | |
|---|---|
| the pane's scroll container | one, `scrollHeight 3704` / `clientHeight 641` — **5.8 screens** |
| `scrollTop` after load, sampled well past any animation | **0** |
| the target field's position | **3,804px** down a 906px viewport — ~2,900px below the fold |

**And the mechanism itself works.** Calling `scrollIntoView({block:'center'})` on the same element
by hand, late: `scrollTop` **0 → 3063**, the field lands at viewport top 741, on screen. **So the
bug is *when* the effect runs, not what it does** — which is the useful half for whoever fixes it.

**I am not asserting the cause.** Two candidates and I could not separate them:

1. **The element does not exist when the effect fires.** Deps are `[focusKey, row.id]` — both stable
   from mount — so it runs exactly once and never retries. Any path where the fields paint after
   that single run fails permanently and silently.
2. **A `behavior: 'smooth'` scroll interrupted by the re-layout as fields mount.** SR.1's `11` is
   movement; my `0` is none. Two different readings of the same control may be two different modes.

I tried to separate them by watching every `scrollTop` change from the instant the pane appears, and
could not: the watcher cannot survive the page load it needs to observe, and the in-session path
needs the AG context menu, which would not open on four attempts. **Stated as unresolved rather
than guessed** — this review has already had three confident readings turn out to be mine rather
than the code's (§8.4).

**Simpler form, and it covers both candidates without needing to know which:** give the effect a
signal that the fields have actually arrived, and stop using an interruptible scroll —

```ts
}, [focusKey, row.id, columns.length])          // retry when the fields appear
el?.scrollIntoView({ block: 'center' })          // 'auto': a re-layout cannot cancel it mid-flight
```

**Risk:** low. Worth pairing with SR.1's product finding — they measured the same pane at **21.3
screens** with all seven groups expanded on a 97-field market, so today the operator pays the full
scroll *and* does not land on the cell they clicked. Collapsing every group except the one holding
`focusKey` fixes both at once, and makes PES.4's `memo(RecordField)` work cheaper because the
collapsed groups never mount.

### §7.1 What the drawer does better than anywhere else in either tree — `[watched, in part]`

`useFieldHistory`'s **four-outcome contract** is the best honesty work I have read in the programme,
and it is worth naming precisely because P3-1 sits in the same file:

> rows → the history · no rows + coverage started → *"nothing recorded for this field since
> <date>"* · no rows + coverage null → *"per-cell history is not being recorded yet"* · 404/501 →
> *"the history API has not shipped yet"*

Four states where most code has one empty list, and `HistoryPane` renders all four in words.
`types.ts:454`'s `previousWasRecorded()` implements hub ruling #14 — `previousRecorded` when the
server sends it, a documented inference when it does not — so the pane can say *"its prior value was
never recorded"* instead of showing `null` as though the field had been empty. `[read]`: watching it
needs a history payload with `coverageSince` set, which needs the endpoint and a session.

`ListingsPane.tsx:51` is now the reference fix for hub #236 — `readiness?.state ?? null`, with
`meta = state ? readinessMeta(state,'row') : null` — and its comment points at `offerActive` right
below, which had been rendering *"not reported"* correctly all along. The lane was enforcing the
rule one line away from breaking it, which is the most common shape of this defect and the reason a
guard beats vigilance.

### §7.2 Negative results in `drawer/**`

- **No empty `catch` blocks**, and no `?? 0` reaching a rendered number.
- **`RecordPane.tsx:22`'s `NO_IMAGES = Object.freeze([])`** is the fix for `?? []` minting a fresh
  array per render, applied deliberately and with the reason written down — the opposite of the
  defect class, in the same syntax.
- **`types.ts:287`'s `LAYER_OF[source] ?? 'unknown'`** is an honest fallback, not a #236 hit: it
  names the unknown rather than inventing a layer.

## §8 Pass 4 — `ancillary/**` + `channel-ops/**`

1,920 product lines across 9 modules. `AnalyticsAdsTab.tsx` 415 · `syncQueue.ts` 390 ·
`ErrorsSyncConsole.tsx` 282 · `readEvents.ts` 186 · `ActivityTab.tsx` 183 · `readAnalytics.ts` 160 ·
`readAds.ts` 120 · `analytics/types.ts` 115 · `ErrorsSyncTab.tsx` 69. **This is the cleanest of the
four sweeps** — see §8.3 — and the two findings are both latent.

---

### P4-1 A buy-box price joined to its row by array INDEX, not by the key both sides carry

`_studio/ancillary/AnalyticsAdsTab.tsx:151-152` · lane **PES.7** · **latent, measured**

```ts
const buyBox = readPrices(analytics.pricing.latestBuyBoxPrices)
return readPrices(analytics.pricing.currentPrices).map((p, i) => ({
  channel: p.channel, marketplace: p.marketplace,   // the row's identity: from currentPrices
  buyBox: buyBox[i]?.text ?? 'Not set',             // the number shown: from POSITION i
  buyBoxKnown: buyBox[i]?.known ?? false,
}))
```

`currentPrices` and `latestBuyBoxPrices` are **two independent arrays** on the wire
(`analytics/types.ts`), and nothing in the contract says they are the same length, the same order,
or cover the same coordinates. `readPrices` returns `channel` and `marketplace` on **every** row —
**the join key is on both sides and is discarded.** If the server ever omits a buy-box row for one
coordinate, every row below the gap shows another marketplace's buy-box price, under the right
channel label. Same class as P3-1: wrong data wearing the right label.

**Measured on the live payload for GALE-JACKET** (read-only GET, `?days=30`): both arrays are
length 5 with identical coordinates in identical order — `AMAZON|DE, AMAZON|ES, AMAZON|IT,
AMAZON|FR, EBAY|IT` — so **0 rows currently show the wrong buy-box.** It is latent, and it is latent
because of a server implementation detail (both arrays built from the same listing set) that the
client's own types do not state. **Measured on one product; I have not swept the catalogue.**

The reason it is worth filing at all despite being latent: the surrounding code is *carefully*
honest — `readPrices` keeps a measured `0` as a real reading rather than hiding it behind "not set",
and the columns render `'Not set'` only when `known` is false. A reviewer sees that care and does
not look underneath it at the join.

**Simpler form** (three lines, no behaviour change while the arrays align):

```ts
const bb = new Map(readPrices(analytics.pricing.latestBuyBoxPrices).map((b) => [`${b.channel}|${b.marketplace ?? ''}`, b]))
const hit = bb.get(`${p.channel}|${p.marketplace ?? ''}`)
buyBox: hit?.text ?? 'Not set', buyBoxKnown: hit?.known ?? false,
```

**One question for BE.1 rather than PES.7:** does the server *guarantee* the two arrays are parallel?
If it does, the fix is still right (the client should not depend on an unstated guarantee) but the
rank stays low. If it does not, this becomes live the first time a coordinate lacks a buy-box row.

---

### P4-2 An unrecognised publish mode falls silent through the same branch as `live` — `[watched]`

`_studio/channel-ops/syncQueue.ts:310-325` · lane **PES.3**

`gateNote(mode, channelLabel)` warns the operator when re-running failed writes cannot work. Probed:

| mode | note |
|---|---|
| `gated` | ✅ *"publishing is switched off on the server… The flag, not the retry, is what has to change."* |
| `dry-run` | ✅ *"a write runs and reports success without touching the real listing."* |
| `sandbox` | ✅ *"pointed at its sandbox. Writes land there, never on the live listing."* |
| `live` | `null` — **correct**, retrying genuinely is safe |
| **anything else** | **`null` — the same branch as `live`** |

The `default:` case serves both "the gate is open" and "the server sent a mode this build has never
heard of", and those want opposite treatment: `live` is the one mode where silence is right, and an
unknown mode is the one where the operator most needs telling that the console cannot vouch for the
retry. The file is otherwise scrupulous about exactly this — `modeForChannel` returns `null` rather
than guessing for an undescribed channel, with the comment *"answering 'live' for a channel the
server did not describe would be the most dangerous possible default"* — so the principle is stated
one function above and the switch does not carry it.

**Simpler form:** an explicit case, so the unknown is named rather than defaulted —

```ts
case 'live': return null
default:     return `${channelLabel} reports a publish mode this build does not recognise (${mode}). Whether a retry can work is unknown.`
```

**Risk:** none — it can only add a sentence where there was silence.

---

### P4-3 Two `PublishMode` types for one server concept, with different member sets

`channel-ops/syncQueue.ts:277` (**PES.3**) · `images/channel/amazon/publishPlan.ts:23` (**PES.7**)

```ts
export type PublishMode = 'gated' | 'dry-run' | 'sandbox' | 'live'                    // closed, 4 members
export type PublishMode = 'live' | 'dry-run' | 'gated' | (string & {})                // open, 3 members
```

Both mirror the same server vocabulary and both read the `/api/listings/publish-readiness` family.
They disagree twice over: **PES.7's cannot name `sandbox`** (so a sandbox mode is invisible to its
type, though `publishPlan`'s `mode !== 'live'` still treats it as a rehearsal — correct behaviour,
unexpressible type), and **PES.3's cannot accept anything new** (though `gateNote`'s `default`
swallows it — see P4-2, where the type being closed is what made the silent branch look complete).
Each type's weakness is masked by the other file's behaviour, which is why neither lane has hit it.

**Simpler form:** one exported `PublishMode` — the four real members plus `(string & {})` — in a
place both lanes already import from, with the open member documented as "the server may add
modes; treat any unrecognised value as not-live". P2-4's rule applies: an open union is right *when
every consumer degrades safely*, and here one does and one does not.

---

### §8.1 What `channel-ops/syncQueue.ts` gets right, and it is a lot — `[watched]`

The best-reasoned single file I have read in either tree, and probed rather than admired:

- **Grouping is the feature, and it works.** 2,000 identical gate failures plus two "listing not
  found" rows differing only by an id → **2 causes**, not 2,002 rows and not 2,001 groups
  (`normaliseMessage` strips the ids). `summarise()` returns *"2,002 queued writes across 2 causes ·
  1 product · none need you"* — the shape, not the count.
- **`products` beside the row count**, because the row count alone cannot tell the two apart:
  probed, 300 rows on one product → `products: 1`; 300 rows across 300 products → `products: 300`.
  *"One product retrying itself into the ground"* versus *"a channel-wide outage"*, which need
  opposite responses.
- **It refuses to guess, twice.** `modeForChannel` returns `null` for a channel the response does
  not describe (Etsy, WooCommerce) rather than `'live'`; `jumpTargetOf` returns `null` when
  `aliasResolved` is false rather than assuming `primary`, because *"a jump to the wrong row is
  worse than no jump, because the operator believes it."*
- **The design is measured, not assumed.** A four-pane console was rejected because
  `ListingIssue`, `AmazonSuppression` and validation failures are all at **zero** on prod while
  `OutboundSyncQueue` holds 37,846 rows / 2,553 dead — *"a four-pane console would have been three
  empty panes."* And `gateNote`'s claim about retries was verified against
  `outbound-sync.service.ts:1209` calling the same helper, not inferred from the flag's name.
- Its mirror-type comment is the rule the rest of the programme learned the hard way: *"I asked for
  a `sku` and did not get one, so nothing here pretends to have it. An incomplete mirror has cost
  this programme five defects."* Compare P2-3, where two mirrors were entered through `as unknown as`.

### §8.2 `readPrices` keeps a measured zero — `[read]`

`readAnalytics.ts` — *"`0` is kept as a real reading — a zero price is a data problem worth seeing,
and hiding it behind 'not set' would silently repair it on screen."* The same rule as
`EmptyValue({ measuredZero })`, applied independently in a different lane. Worth naming because a
zero price *looks* like a bug to repair, and repairing it on screen is how it survives.

### §8.3 Negative results — this sweep is the cleanest of the four

Set-scanned across both folders: **no empty `catch` blocks · no `as never`, `as any` or
`as unknown as` (zero, against 10 in the other trees) · no `?? 0` reaching a rendered number**
(the only two matches are inside PES.7's own comments describing the A1/A4 fix, and
`ActivityTab.tsx:83`'s `(events?.length ?? 0) === 0`, which is a length guard, not a displayed
number). Two deadline-less fetches (`ErrorsSyncConsole.tsx:85,103`), already counted in the 29.

### §8.4 A note on my own error rate, since it bears on how to read this document

Across the probe rounds, **three assertions failed and all three were mine, not the code's**:
`readinessMeta` must label `ready` differently per vocabulary (it must not — the file says so);
a 409 carrying `currentVersion` must return a version (it must not without `versionOf`); and
`SyncCause` has a `count` field (it has `rows.length` and a deliberate `products`). Every one was a
plausible reading of the code that a review would have published as fact. **That is the argument
for probing, stated as a measurement rather than a principle: three in about forty assertions, and
each would have been a wrong finding filed against a lane.** It is also why P4-1 is labelled latent
with the payload that makes it latent, rather than ranked as live.

## §9 What the test suite cannot reach — AST-measured (hub #334)

Asked for after PES.7's second defect in a row hid in a helper defined **inside** a component,
unreachable to the node-only vitest by construction. Measured with the TypeScript compiler API over
**189 files** in both trees — AST, not regex, because a name-based scan of this class is the
88,914-hits-with-no-true-positives failure PES.3 already demonstrated. "Logic weight" counts
statements, calls and branch nodes: a one-line accessor scores ~1, a real function scores 25+.

**PES.2's discovery while fixing `EmptyValue` changes the shape of the answer**, so it is folded in:
a node test importing a `.tsx` **dies at parse** (`content contains invalid JS syntax`) before any
test runs. They found it by extracting the rule out of the component *into the same `.tsx` file* and
watching it still fail. So the class is bigger than "inside a component" — it is **two** classes.

### The measurement

| where the logic lives | weight | reachable by the suite that exists? |
|---|---|---|
| **`.tsx` files** | **11,466** | ❌ never — the import dies at parse, at *any* scope |
| `.ts` files, module scope | 4,751 | ✅ yes |
| `.ts` files, inside a component or hook body | **3,993** | ❌ not without rendering |

**15,459 of 20,210 (76%) of the logic in these two trees cannot be reached by the test suite that
exists**, for two different reasons — and only the smaller half is the inline-helper class the
question was about.

### List A — the one the hub asked for: named helpers inside a component or hook

339 named functions are declared inside a component or hook body. Most are event handlers and
`useCallback`/`useMemo` bodies that belong there. **The one that matters is the first:**

| weight | where | captures | tested? |
|---|---|---|---|
| **150** | `sheet/master/useMasterSheet.ts:77` — `useMasterSheet → commit()` | `sheetRef, optsRef, locale` | **no** |
| 65 | `sheet/master/MasterSheet.tsx:629` — `visibleRows()` | 6 | no |
| 59 | `drawer/useStudioRead.ts:98` — `start()` | 5 | yes (new) |
| 54 | `sheet/channel/ChannelSheet.tsx:440` — `columnDefs()` | 8 | no |
| 54 / 53 | `VideoSection → upload()` · `MasterGallery → uploadFiles()` | 6 / 5 | no |

🔴 **`commit()` is the sharpest finding in this section, because its twin is right there to compare
against.** It is the master sheet's entire write path — the `commit` that `SheetWriter` calls, the
function at the centre of P2-1 — at weight **150**, declared inside a hook, and **no test exercises
it**. Its exact counterpart on the channel side, `commitChannelRow`, is a **module-level export** in
`useChannelSheet.ts` with its own `channelWrite.vitest.test.ts` — and it is the one I probed earlier
tonight with a stubbed `fetch` and five assertions, which is how the `errors[]`-before-`updated`
ordering got confirmed for BE.1.

**Same operation, two lanes: one is a module-level export with tests and a probe; the other is a
150-weight closure with neither.** And it is hoistable — its three captures are two refs and a
scalar, so `commitMasterRow(req, { sheet, opts, locale })` at module scope is the same shape PES.3
already shipped. **Simpler form: do what the channel sheet did.**

*(`MasterSheet` itself at weight 776 and `ChannelSheet` at 531 appear in the raw scan and are **not**
findings — a component is expected to be large. Only named helpers and non-component functions are
listed.)*

### List B — logic stranded in `.tsx` at module scope, testable the day it moves to a `.ts` sibling

21 non-component functions, **978 weight**. No restructuring, no jsdom, no new dependency — the fix
is the one PES.2 just performed for `EmptyValue`: move the function to a `.ts` file beside it.
Excluding the hooks (which need a renderer regardless), the pure-logic subset is ~471 weight:

| weight | function | why it matters |
|---|---|---|
| **268** | `sheet/master/columns.tsx:129` — `buildMasterColumns()` | **the single best item on this list.** It builds every column def for the master sheet, it is where A2's 2,000-char wall and A3's invented 4,000 cap both lived, and **it has never been run by a test** |
| 63 | `drawer/fields/HtmlField.tsx:49` — `sanitize()` | an HTML sanitiser with no test, in a file no node test can import |
| 35 | `sheet/channel/AliasBandCell.tsx:76` — `bandTitle()` | the function whose honest `undefined` branch was **dead code** until A7 was fixed — a test would have caught that the branch was unreachable |
| 32 · 20 · 18 · 18 · 17 | `actionContextMenu` · `revealColumn` · `currentState` · `gateOf` · `gridFilterDef` | |

The hooks in the same list — `useReadinessQuery` (89), `useInFlightGuard` (64), `useSaveMachine`
(50), `useLiveRefresh` (34), `useActionConfirm` (62), `useActionPress` (43) — need a renderer
whatever file they live in, so they belong with the jsdom question (§3 items 4 and 7), not here.

### ⚠️ Correction to the remediation cost — PES.2 landed both items and the rule was wrong

Both §9 recommendations shipped (`commitMasterRow`, 21 tests, 8/9 mutations killed with two honest
equivalent mutants recorded in source; `buildMasterColumns`' pure decisions as `columnRules.ts`,
12 tests). Doing it corrected **the remediation rule**, not the measurement above.

**1. "Hoist to module scope" is not sufficient. The rule is: nothing on the import path may be a
`.tsx`.** Hoisting `commit` out of the hook still died at parse, because `useMasterSheet.ts`
value-imports the grid barrel, which re-exports `NexusGrid.tsx`. The function needed **its own
module**, off that path.

**I measured what that costs across both trees.** For each `.ts` module I walked the transitive
**value**-import graph (`import type` is erased by esbuild and does not poison):

| | |
|---|---|
| `.ts` modules in the two trees (excl. tests) | 111 |
| testable in node today — no `.tsx` anywhere on the path | **97** |
| poisoned by a transitive `.tsx` — dies at parse | **14** |

So the "4,751 reachable at module scope" line above is **broadly right, not optimistic** — which is
the opposite of what I expected when I checked. And the 14 are concentrated: **8 of them are `index.ts`
barrels** re-exporting a component, and **two files strand 3 modules each** — `contracts.tsx` and
`NexusGrid.tsx`. The non-barrel casualties are `useMasterSheet.ts` (via `NexusGrid.tsx` — PES.2's
exact case), `useAiDraftLayer.ts` / `useRecordDrawer.ts` / `useImageWorkspace.ts` (all via
`contracts.tsx`), and `grid/columns/presets.ts`.

This is the banked barrel trap — *"importing via the `@/design-system/grid` BARREL pulls
`NexusGrid.tsx` and breaks node-env test files; import pure modules DEEP"* — now with a number on it:
**14 modules, 2 chokepoints.** Anything that wants a node test imports deep, or lives off the path.

**2. `buildMasterColumns` could not move wholesale — its `cellRenderer`s are JSX.** Only the pure
decisions could be extracted (`columnRules.ts`). **So List B's 978 weight overstates what relocates
in one move**: for any function that both decides *and* renders, the decision travels and the JSX
stays. The right reading of List B is "the pure fraction of this is testable", and the fraction is
only knowable per function.

Neither correction changes the headline — **76% of the logic here is unreachable by the suite that
exists** — but both change what it costs to fix, and in opposite directions: the import-path rule
makes some items harder, and the 97-of-111 finding makes the `.ts` half healthier than I implied.

### What I would do with this list

1. **`commit()` → a module-level export**, mirroring `commitChannelRow`. One function, and it is the
   write path.
2. **`buildMasterColumns()` → `columns.ts`.** 268 weight, currently untestable, and demonstrably
   where cap defects live.
3. **`sanitize()` → a `.ts` sibling**, because an untested sanitiser is a different kind of risk
   from an untested formatter.

Everything else on both lists is real but lower value, and the totals above are the argument rather
than any individual row: **76% of this logic is unreachable, and roughly a quarter of that is
unreachable for a reason as cheap to fix as a file extension.**

## §10 The §5.4 trailing inset — measured for UX.1's re-rule

`design-system/grid/theme/grid.css:665` (STAGED block, mtime 04:38:06) · staged by **PES.2**,
measured here on the ratio protocol. §5.4 had ruled a trailing scroll *pad*; PES.2 measured that AG
clamps `scrollLeft` to `totalColumnWidth − viewportWidth` and ignores a wider container, so the pad
cannot work. The staged alternative shrinks the viewport instead, only while the panel is open.

**Efficacy — confirmed independently, and exact:**

| | closed | open with inset |
|---|---|---|
| viewport `clientWidth` | 1660 | **1140** |
| `maxScrollLeft` | 1099 | **1619** |

Delta **exactly 520**, the panel's width.

**Cost on the dock transition — nil.** Three cycles each way: open 6/6/6 commits, close 4/4/4,
`CellComp` **0**, ratio **0.00**, against a pre-inset baseline of open 5–6 / close 4 with the same 0.
Isolating the CSS with no drawer involved — toggling `data-panel-open` — narrows the wrapper
1660 → 1140 at **0 commits, 0 ms, 0 `CellComp`**.

**Cost on the next scroll — negative. It is a saving.** Paired trial, 3/3 identical in each arm:

| first scroll after… | commits | ms | **`CellComp`** | rendered cols |
|---|---|---|---|---|
| **with inset** | 6–7 | 10.5–13.6 | **168** | 12 → 13 |
| control, no inset | 7 | 10.1–12.3 | **210** | 15 → 17 |

A narrower viewport renders fewer columns, so the scroll costs **42 fewer cell renders**.

**🔴 The methodological point, which is why this number is trustworthy and my first one was not.**
My first reading of the post-inset scroll was **168 `CellComp` in isolation, and it reads as a
cost** — I was one step from filing "the inset makes scrolling expensive". It is only the **control**
(the same scroll at full width, 210) that turns it into a saving. **A cost measured without its
control is a number, not a finding**, and this is the fifth time in this review that the control or
the second reading reversed the conclusion.

**🔴 PERCEPTIBILITY IS OPEN, AND I COULD NOT MEASURE IT (hub #436).** `CellComp` counts React only;
AG moves columns in the DOM directly, so the re-virtualisation is **unobserved rather than absent**.
I built the frame harness (rAF gaps + `longtask`) and every arm returned `longestFrame: null`,
`over16: 0`, `over50: 0` — which reads exactly like "nothing exceeds the noise band". **It is a
measurement of nothing:** `document.visibilityState` is `hidden` and **0 frames fired in 600 ms**
against ~36 expected, because rAF does not run in a hidden tab. A click gave `hasFocus: true` but not
visibility; the Chrome window is occluded and I cannot raise it. A fallback to synchronous layout
timing was void for a second reason worth recording — in that run **AG did not re-virtualise at all**
(cells 378 in both states with the width demonstrably changing), so while hidden the work under test
does not appear to run.

**So UX.1 should rule on efficacy and React cost — both measured — and treat perceptibility as open.**
"0 `CellComp` on the transition" is not evidence about frames; they are different quantities, which
is the #398 lesson turned on me.

**Banked: a frame-timing probe must open with a positive control that it is sampling at all** — ~36
frames in 600 ms — and refuse to report if it is not. **A silent sampler and a genuinely smooth
transition produce byte-identical output.** Added to [[reference_browser_probe_lies]].

**Three caveats, first one load-bearing:**

1. **This says nothing about whether it looks right.** Under my programmatic open the panel renders
   at x=1728, off-viewport, so "the last column lands 1px clear of the panel edge" is PES.2's
   measurement — mine neither confirms nor refutes it.
2. **Re-virtualisation timing is not deterministic in my instrument** (15 columns at rest in one
   test, 12 in another); its *cost* never appeared as React commits either way.
3. **View-dependent magnitudes.** PES.2 renders 30 columns, I render 15. The direction should hold —
   fewer rendered columns is fewer cell renders — the magnitudes should not be quoted across views.

**🔴 A THIRD consideration my measurements do not cover, found by AG.1 (hub #439) — and it makes my
"not a trade" reading too favourable on its own.** The inset **redefines `panelWidth` for the reveal
rule.** `revealCell.ts:75` is `cellRight > viewportRight − panelWidth − margin`; with the inset
applied the grid viewport has *already* been narrowed by the panel's width, so `viewportRight` is the
narrowed edge and subtracting `panelWidth` again **double-counts 520**. The panel no longer overlaps
the grid at all — overlap is 0 — so the value the rule should be given is 0, not 520. Left as is,
`isCellCovered` reports covered for cells that are fully visible and `revealDistance` scrolls for no
reason.

That is the same family as this review's own two lessons, arriving from the layout side rather than
the profiler side: **a quantity that was correct under one geometry silently becomes wrong when the
geometry changes underneath it.** It is `revealCell.ts`'s own recorded failure mode too — its
comment at `:130` describes a build where *"`isCellCovered` computed 'not covered' and nothing ever
scrolled. The whole reveal was inert."*

**So the honest summary of §10 is three-part, not two:** efficacy confirmed and exact; React cost
zero on the transition and negative on the next scroll; **and one dependent rule that must be updated
in the same change, plus perceptibility still unmeasured.** My numbers say the performance objection
to §5.4's mechanism does not hold. They do not say the change is free.

**Build integrity, stated because it is not clean:** `grid.css` was stable at 04:38:06 throughout,
but `MasterSheet.tsx` moved to 04:46:30, the second the run ended. The evidence against
contamination is the paired trials' internal consistency — 168 and 210 identical across all three
trials in each arm, which a mid-run build change would have disturbed.

## Appendix — cross-lane requests, by owner

| # | Owner | Item | Measurement it must carry |
|---|---|---|---|
| A1, A4 | PES.7 | honest inventory/stockout numbers | `inventory = analytics?.inventory`; 3 of 4 fields in the same `<dl>` already guard |
| A2, A3, B3 | PES.2 / AG.1 | stop inventing caps | 1,996 seeded + 8 typed = 4 accepted, hard stop at 2,000; 66 of 102 columns uncapped |
| A5 | PES.3 | alias readiness may be null | three `?? 0` → "0 errors, 0 warnings, 0 missing" for an unscored alias |
| A6 | PES.7 | publish gate | `asinsBlocked ?? 0` on the object that decides publish |
| A7 | PES.3, PES.4 | `readiness?.state ?? 'unlisted'` ×3 | the sibling of the `?? 'DRAFT'` fix, 3 lines below it |
| A8, C1, C2 | PES.1 | the header-collapse file and `marketplacesFailed` | repo-wide grep: 2 files, 0 tests; 11 refs, 0 consumers |
| A9, E2 | DS.1 | regenerate declarations | 6 of 221 shapes disagree; `SaveOutcome.version`, `Drawer.mode`, `Tabs.idBase`, `DetailHeader.dense` |
| B1, Q3 | hub | one ToastProvider | 3 instances render per studio commit |
| B2 | PES.1 + PES.3 | one chip-cell predicate | `ChannelSheet` imports from both files |
| C3, C4, C6, C7 | PES.2 / AG.1 | dead `textEditor`; `onNewColumnsLoaded` spread-order bug | 3 grep hits, all in-file; `{...agProps}` at `:339` after `:326` |
| C5 | PES.5 | delete `/studio/columns` | two independent zero-caller measurements (mine + BE.1's) |
| D1 | PES.4 | stable callbacks + `memo(RecordField)` | 96 fields × 4 renders = 178.8 of 254.3 ms |
| D2, D3, D4 | PES.2, PES.1 | memo boundary, `SaveCtx` split, `Set` in the chip loop | 189-cell repaint; 17/56 provider hooks; ~85k comparisons at 21 rows |
| E1 | PES.2 + PES.3 | widen `defaultViewColumns`, drop two `as never` | the only cross-lane seam with neither a type nor a contract test |
| — | hub | `AppNavRail` churn | 4–7 ms × 1–3 per interaction, 0 on idle controls |
