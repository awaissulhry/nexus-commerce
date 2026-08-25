# Phase 9.3 — Twelve concepts, twenty-four implementations

**Status:** IN PROGRESS. Tranche 1 (Tabs) shipped `3ca5438e5`. The rest is scoped below and
**three items need a decision before they can be built.**

**One sentence:** twelve UI concepts exist twice — once in `components/ui`, once in the design
system — and 397 files import the legacy copy. Collapsing them onto one implementation is what
makes the platform look like one product.

---

## 1. The correction to the original estimate

This phase was pitched as *"26 files edited, ~290 pages adopt the DS, mechanical."* **That was
wrong**, and the measurement that produced it was wrong in three ways worth recording:

- **"Just re-export the DS component."** There is **no clean drop-in among the twelve.** Every
  pair differs in props, and several differ in *types* for props that share a name —
  `EmptyState.icon` is a `LucideIcon` **component** in the legacy version and a `ReactNode` in
  the DS one.
- **A props-interface diff missed half the API.** `Skeleton` and `Spinner` declare their props
  inline in the function signature rather than in a named `XProps` interface, so a scan for
  `interface SkeletonProps` reported them as having *no* legacy-only props. `Skeleton` in fact
  has six variants and a `lines` prop the DS has never had.
- **`grep -c <word>` is not usage.** `trailing` looked like it had two callers; both were the
  word in prose and an unrelated `trailingSlot` on a different component. Real count: zero.
  It was nearly ported into the DS as a permanent API on that evidence.

**Method that actually works, for the remaining tranches:** parse the JSX
(`<Name ...>` attribute by attribute), not the prose; read the *type* of every shared prop, not
just its name; and check the legacy component for inline prop declarations before trusting an
interface diff.

## 2. The real scope

| Concept | Files | Uses | What collapsing it needs | |
|---|---:|---:|---|---|
| **Tabs** | 9 | 9 | `activeTab`→`active`; `disabled` lifted into the DS | ✅ shipped |
| **Toast** | 150 | 900+ | 🔴 **the DS version is the WEAKER one — see §3** | **decision** |
| **Button** | 205 | 786 | DS needs `loading` (108) and `icon` (101) | DS feature work |
| **Card** | 145 | 485 | `title` (187) / `description` (105) / `action` (27) → DS `header`/`headerAction` | adapter |
| **Badge** | 91 | 246 | 🔴 **concept collision — see §3** | **decision** |
| **Modal** | 62 | 80 | DS needs `dismissOnBackdrop` (19), `dismissOnEscape` (18), `description` (14), `placement` (13), `header` (5) | DS feature work |
| **EmptyState** | 56 | 63 | `icon: LucideIcon`→`ReactNode`; `action` object→node | adapter |
| **Skeleton** | 41 | 158 | DS has one primitive; legacy has 6 variants + `lines` | DS feature work |
| **Input** | 38 | 114 | 🔴 **DS has no error affordance at all — see §3** | **decision** |
| **Tooltip** | 21 | 64 | `content`→`label`; DS needs `placement` (14), `delay` (3) | DS feature work |
| **Spinner** | 1 | 5 | `size` is a string here, a number in the DS; plus `tone`, `label` | small |
| **ProgressBar** | 1 | 3 | `label`/`tone`/`max`/`showPercent`; **plus a third, hand-rolled copy** inside `ReconciliationClient.tsx:694` | small |

**397 distinct files. 2,013 call sites.** Note `Button` and `Card` alone are 1,271 of them.

## 3. 🔴 The three decisions

**Badge is not a duplicate — it is a name collision.** The DS `Badge` takes
`program: AdProgram` and renders a Sponsored Products / Display / Brands chip. The legacy
`Badge` takes `variant` (240 uses) and `size` (175) and is a generic label. They are different
concepts wearing one name. The DS equivalent of the legacy one is `Tag` (tone-based) or `Pill`
(entity status) — both already exist. **Decide:** map the 91 files onto `Tag`, onto `Pill`, or
rename the DS's ad-program chip and give `Badge` back its generic meaning.

**Input has no error state anywhere in the design system.** There is no `.nds-field.invalid`
rule and no `error` prop; the legacy `Input` has `label`, `error`, `hint` and `charLimit`. The
DS's current answer is composition — label above, message below in
`var(--nds-danger-strong)`, `aria-invalid` on the control. **Decide:** design a real field-error
affordance in the DS (a first-class primitive concern, and 38 files want it), or keep composing
and have the adapter assemble it.

**Toast runs the other way — the legacy implementation should be promoted INTO the DS.** This
was scoped as "one edit at `app/layout.tsx`, largest reach in the phase". Measuring the call
sites killed that idea:

| legacy API | uses | files | in the DS? |
|---|---:|---:|---|
| `toast.error(msg)` | 567 | 130 | ✗ no tone helpers |
| `toast.success(msg)` | 333 | 122 | ✗ |
| `toast({ title, description })` | 147 | 29 | ✗ single `message` node only |
| `durationMs` | 65 | 16 | ✓ as `opts.duration` |
| `tone: 'error'` | 54 | 14 | ✗ the DS tone is `danger`, not `error` |
| `action: { label, onClick }` | 4 | 3 | ✗ |
| `dismiss()` / `dismissAll()` | 0 | 0 | ✗ — and unused, so drop it |

The DS `Toast` takes `(message, tone?, opts?)` and returns void. Swapping 900+ calls onto it
would **lose** the title/description structure, the tone helpers and the action button — a
downgrade dressed as convergence. There is also a live crash risk: legacy `useToast()` returns
no-ops when no provider is mounted (deliberately, for SSR/standalone renders); the DS version
**throws**.

**Decide:** promote the legacy Toast's API into the DS (title/description, `.success`/`.error`/
`.warning`/`.info`, `action`, and the no-op fallback), replacing the DS's simpler version — or
keep the DS's minimal API and accept that 900 call sites get less than they have now.

None of the three should be guessed at: the first changes how 246 chips read, the second adds a
primitive the whole platform inherits, and the third rewrites the API behind 900 calls.

## 3b. 🔴 The prerequisite nobody had written down: DS CSS is not reliably loaded

Found while shipping tranche 2. **The design system's stylesheets are not loaded app-wide.**
The root layout imports only `globals.css`; every DS stylesheet arrives because some individual
file imported it.

| stylesheet | files importing it |
|---|---:|
| `tokens.css` | 202 |
| `components.css` | 198 |
| `primitives.css` | **46** |
| `patterns.css` | 24 |
| `a11y.css` | **1** |

Measured on `/design`: `.nds-card` resolves, `.nds-btn` **does not** — `components.css`
reaches most routes incidentally, `primitives.css` does not reach that one at all. Of the 205
files calling the legacy `Button`, **5** import `primitives.css`.

**This is the Tailwind content-glob defect one level up**: a component styled only when some
unrelated sibling happens to import its stylesheet. It bit this tranche directly — the
`EmptyState` adapter renders a DS `Button`, which came out as unstyled black text on 55 of its
56 pages until it was caught.

**Interim fix, applied:** each adapter imports the stylesheets its DS component needs, the way
`AccountSwitcher` already did. Next dedupes them, so it costs nothing.

### ✅ SHIPPED — the root layout now loads the design system

`app/layout.tsx` imports, in this order and no other (**order is the cascade** in this system):
`tokens-global.css` → `primitives.css` → `components.css` → `patterns.css` → `a11y.css`.

`tokens.css` is **generated in two variants** from the one source (`tokens/css-vars.ts`):

| file | contains | who loads it |
|---|---|---|
| `tokens.css` | everything, including the 11 contested platform aliases | pages that opt in (202 of them, unchanged) |
| `tokens-global.css` | the same minus those 11 | the **root layout**, every route |

Withholding the 11 is the whole point: publishing `--text-primary` app-wide as a colour would
make Tailwind's `rgb(var(--text-primary) / <alpha-value>)` resolve to `rgb(#1c2530)` — invalid —
and kill the utilities behind 636 files. **Phase 9.0b is what made a global stylesheet possible
at all**, by removing the design system's own dependence on those names.

Verified on `/sync-logs` and `/dashboard`, routes that import nothing themselves: `.nds-btn`
now resolves (`padding: 7px 13px`, `radius: 8px`), and the DS `focus-visible` + reduced-motion
rules are present — `a11y.css` went from **one** importing file to every route.

### 🔴 Found while verifying: the app's semantic Tailwind utilities are dead wherever DS tokens load

Not caused by this change — confirmed by measuring with the layout imports temporarily removed,
which gave identical results. But it is the largest styling defect found so far and it belongs
on the record.

On `/dashboard/overview`, measured on **real rendered elements**:

| utility | intended | actual |
|---|---|---|
| `.text-secondary` | slate-600, ~7.5:1 | **`rgb(0,0,0)`** — pure black |
| `.border-default` | slate-300 | **`rgb(0,0,0)`** — black |
| `.bg-card` | white | **`rgba(0,0,0,0)`** — transparent |

Cause: 202 files import DS `tokens.css`, which redefines `--text-*` / `--surface-*` /
`--border-*` at `:root` as **colours**. Tailwind composes them as `rgb(var(--x) / <alpha-value>)`,
so `rgb(#5b6573 / 1)` is invalid and the declaration is dropped. `tailwind.config.ts` says these
utilities replaced "6,485 raw `text-slate-400`" and "6,547 invisible borders" — that entire
migration is inert on every route where DS `tokens.css` is loaded.

**This is 9.0b's mirror image**: 9.0b fixed the design system reading the app's channel tokens;
this is the app reading the design system's colour tokens. The fix is the same shape — stop
publishing contested names into a scope that already defines them — and `tokens-global.css` is
the first half of it. The second half is auditing those 202 `tokens.css` imports and moving each
to `tokens-global.css` unless it genuinely needs the aliases as colours. **That is its own
phase**, and it should come before any further 9.3 tranche that touches text or borders.

**The real fix is app-wide loading, and 9.0b is what makes it possible.** It could not be done
before, because `tokens.css` publishes the platform-alias tier at `:root` and loading it
globally would race `globals.css` for `--text-*` / `--surface-*` / `--border-*`. Now that DS
stylesheets consume only `--nds-*`, `tokens.css` can be split — the `--nds-*` tiers load
globally with `primitives`/`components`/`patterns`/`a11y`, and the alias tier stays opt-in.
**That should land before the `Button` tranche**, which is 205 files needing `primitives.css`.

**Separately: `a11y.css` is imported by exactly one file.** The DS's `focus-visible` and
`prefers-reduced-motion` rules are absent from essentially the whole platform. That is an
accessibility gap, not a styling one, and it is fixed by the same app-wide load.

## 4. Suggested order for the rest

1. ✅ **Spinner, ProgressBar** — shipped. Both had exactly one caller: `app/design/page.tsx`,
   the legacy showcase 9.7 deletes. Every production call site was already on the DS versions.
   The hand-rolled `{ pct }` copy at `ReconciliationClient.tsx:694` is still outstanding.
2. ✅ **EmptyState, Card** — shipped. `Card.description` was lifted into the DS (105 call sites
   wanted it) and `padded` now reaches the body of a headed card (17 charts needed that).
3. **§3b first**, then **Tooltip, Skeleton, Modal, Button** — each needs a real DS capability first. Contribute the
   capability, then adapt; per `CONTRIBUTING.md` these belong in the system, not in a shim.
4. **Badge, Input, Toast** — after §3 is decided.

**A note on direction.** Three of the twelve (`Toast` certainly, `Skeleton` and `Modal`
probably) have a RICHER legacy implementation than the DS one. "Collapse onto the DS" is the
right goal, but for these the collapse means lifting the legacy behaviour into the design
system first. Convergence is not the same as replacement, and picking the weaker of two
implementations because it lives in the right folder is how a design system loses trust.

## 5. Hard rails

- **Adapters, not rewrites.** `components/ui/X` renders the DS component and keeps the legacy
  API verbatim, so no call site changes and TypeScript stays green.
- **Lift, don't shim.** When the legacy component has a capability the DS lacks and it has real
  callers, it goes into the DS. When it has *no* callers, it is deleted, not ported.
- **Measure usage before porting any prop.** See §1.
- One tranche per commit, `tsc` + guards + a rendered check on a real page each time.

---

## Appendix A — a thirteenth concept: the grid (added 2026-08-24)

**Found by the operator reviewing the claude.ai/design cards**, not by a scan: the DataGrid card
"doesn't look like the grid on the ad manager page." It doesn't, and `DataGrid` appears nowhere in
the twelve above. This is the largest duplicate in the codebase by line count.

| | `design-system/components/DataGrid` | `app/marketing/ads/campaigns/_grid/AdsDataGrid` |
|---|---|---|
| lines | 275 | **967** |
| props | 18 | **49** |
| call sites (JSX-parsed) | 20 in 14 files | **64 in 51 files** |
| self-description | the DS table primitive | *"the ONE shared Helium-10 Ad-Manager grid"* |

### Why this one is not a swap in either direction

**Neither is a superset.** Unlike `Toast` — where the legacy side is simply richer — the two grids
each hold capabilities the other lacks, in the column type itself:

- **`Column<T>` (DS) has 3 fields `GridColumn<T>` does not:** `align`, `sticky`, `stickyRight`.
- **`GridColumn<T>` (ads) has 5 the DS does not:** `metric`, `tip`, `defaultHidden`, `filterValue`,
  `freezeRight`.

So collapsing them is a two-way merge, not an adoption.

### Same concept, different spelling — four traps

These read as new API in a diff and are not. Every pair below is the same concept, and the first
three have **identical types**:

| ads | DS | |
|---|---|---|
| `rowId` | `rowKey` | `(row: T) => string` — identical |
| `showTotal` | `showTotals` | `boolean` — identical, singular vs plural |
| `defaultSort` | `initialSort` | `{ key, dir }` — identical |
| `emptyLabel: string` + `emptyNode` | `emptyState: ReactNode` | **types differ**; ads splits it in two |

### One real behavioural difference

`onSortChange` is `(sort: {…} | null) => void` on the ads side and `(next: {…}) => void` on the DS
side. The `| null` is not slack — it is *controlled-and-currently-unsorted*, which the DS `sort`
prop documents as a real state but its callback cannot express. Any merge has to keep the nullable
form or the ads console loses "back to the default order".

### What the ads grid owns that the DS has no concept of

`filters` (28 callers) · `selectionActions` (25) · `searchValue` / `searchPlaceholder` (27/23) ·
`toolbarLeft` / `toolbarRight` (20/33) · `storageKey` (38) · `customizable` · `exportable` ·
`editMode` · `groupBy` · `keyboardNav` · `server` · pager (`initialPage`/`onPageChange`) ·
`reportLabel`. Roughly 43 props with no DS counterpart — a filters panel, a toolbar, a Customize
popover, a pinned Total row, per-column info tips and a pager.

Note `rows` · `rowId` · `noun` · `firstColLabel` · `renderFirst` · `firstSortValue` · `columns` are
passed by **all 56** measured call sites: the ads grid's real required surface is seven props, not
two, because the first column is a distinct concept there.

### The fifth asymmetry: column reorder — and the only one that is cheap to close

**Found by the operator, again from the live product** (2026-08-24): *"on our ad manager page I can
drag and drop to change the position of the grid, but it's not the same case with other grids."*
Correct — but not because the ads grid built a drag feature. **The DS already owns the drag UI.**

`patterns/PreferencesModal` renders the reorder list itself: a `GripVertical` grip per row and
native HTML5 drag (`draggable` + `onDragStart` / `onDragOver` / `onDrop`) — no dnd-kit. It returns

```ts
PreferencesValue { visibleColumns: string[]; stickyFirstColumn; stickyLastColumn; pageSize; sortBy; sortDir }
```

where **`visibleColumns` carries the set AND the order** in one array — deliberately, per
`AdsDataGrid`: *"one source of truth rather than a Set beside an array that could disagree."*

So the DS has the hard half. What it lacks is the wiring: `components/DataGrid` scores **0** on
every `reorder` / `columnOrder` / `visibleColumns` / `storageKey` / `customizable` grep, and renders
`columns` in array order, full stop.

| surface | column reorder | where the order is persisted | drag UI |
|---|---|---|---|
| `AdsDataGrid` | ✅ | `storageKey`-scoped, inside the component | DS `PreferencesModal` |
| products · listings · stock · replenishment · purchase-orders · pricing | ✅ | a key per page (`products.visibleColumns`, …), in the page | DS `PreferencesModal` |
| `FlatFileGrid` | ✅ | **two** keys — `${storageKey}-col-order` (per group) + `${storageKey}-hidden-cols` | its own, entirely |
| DS `DataGrid` | ❌ | — | — |

`_shared/grid-lens/PreferencesModal` is **not** a fourth implementation — it is an adapter over the
DS one (XG.1, hoisted from products PG.5) so every `VirtualizedGrid` consumer plugs into the same
modal.

**The trap: row drag is a different axis.** `draggable|dnd-kit|onDrop` scores **16** on
`VirtualizedGrid` and matches `GridView` too, and none of it is column reorder — those are *row*
drag handles (a `LEAD_DRAG_W` lead cell, droppable parent-row overlays for the product/variant
tree), and `GridView` is the set's only dnd-kit user. Measure this capability by whether a persisted
order reaches render order, never by the drag vocabulary. A first pass here scored `VirtualizedGrid`
as having no reorder and `FlatFileGrid` as having its own drag UI; both were the same mistake read
in opposite directions.

**Why this gap is unlike the other four.** `filters`, the toolbar, the pager and the Total row are
missing *design* — someone must first decide what a DS filters panel is. This one is missing
**wiring plus one model choice**: the modal exists, eight surfaces already share it, and it returns
exactly the array `DataGrid` would need. `storageKey` + `customizable` props and a `visibleColumns`
→ order map is most of the work.

**The model choice: the two sticky models collide under reorder.** DS `Column<T>` pins *per column*
— `sticky` / `stickyRight`, the developer's call, with offsets stacked by `width`, which presumes
pinned columns sit contiguously at an edge. `PreferencesValue` pins *positionally* —
`stickyFirstColumn` / `stickyLastColumn`, the operator's call. Drag a developer-pinned column to
position 5 and it pins mid-table over its neighbours. **`AdsDataGrid` has already resolved this and
the resolution is copyable: the operator's toggle gates the developer's flag** —

```ts
const list = prefs.stickyLast ? visibleCols.filter((c) => c.freezeRight && c.width != null) : []
```

— and its first column is a distinct, non-movable concept (`renderFirst`), so the reorderable region
never contains a left-pinned column. Migration cost is small: **7** `sticky: true` / `stickyRight:
true` declarations exist across all 14 `DataGrid` call sites.

**And the call sites justify it.** These are not summary tables — `fleet/workers` declares 28
columns, `products/next` and `stock/import` 21 each, `products/ebay-flat-file` 20; the median across
the 14 files is ~10. Only `fleet/map/EntityListView` (5) is small enough that reorder would be
noise, which is the argument for making it opt-in (`storageKey` + `customizable` absent = today's
behaviour) rather than default-on.

It cuts the other way too: **the persistence is hand-rolled at every call site** — three spellings
of "remember the operator's column order", one inside the component, six in their pages, one split
across two keys, none shared. That is a real duplicate underneath the shared modal, whichever way
#13 goes.

### Decision needed

Same shape as the `Toast` question in §3, with the extra wrinkle that neither side dominates:

1. **Leave both.** Honest today, but it is the platform's most-used component existing twice.
2. **Merge into the DS** — the DS grows the filters/toolbar/pager surface. Largest piece of DS
   feature work in this phase by some distance.
3. **Promote `AdsDataGrid` into the DS and retire the DS one** — 20 call sites migrate instead of
   64, and the DS's `align`/`sticky`/`stickyRight` must be ported across.

**Column reorder is the cheapest item here, but option 3 does gate it.** Under **1** it pays for
itself — the DS grid otherwise stays unable to do what eight other surfaces already do, on tables of
up to 28 columns. Under **2** it is a down payment on the merge. Under **3** the DS grid is retired
and its 20 call sites inherit reorder from `AdsDataGrid`, so building it first is **wasted work**.
So it is cheap under two of three outcomes, not free of the decision — an earlier revision of this
appendix claimed the latter and was wrong.

### ✅ DECIDED 2026-08-25 — option 3, with a requirement attached

The operator chose **promote the ads grid, retire the DS one**, and attached a requirement that is
not satisfied by either grid today (see the next section). Two measurements taken before the call
corrected this appendix and both pointed the same way.

**Correction 1 — the "two-way merge" was overstated.** Of the three `Column<T>` fields this doc
said `GridColumn<T>` lacks, **two are renames**:

| DS `Column<T>` | ads `GridColumn<T>` | |
|---|---|---|
| `align` | `metric` — *"right-aligned numeric look (default true); false renders a left settings cell"* | same concept, DS's 3-value is richer than ads' boolean |
| `stickyRight` | `freezeRight` — same `width` requirement | **identical** |
| `sticky` (per-column left pin) | first column pinned positionally (`fzFirst`) | **the one genuine gap** |

So the port is **one field plus widening `metric` → `align`**, not 43 props of new feature work.

**Correction 2 — the DS grid is not the "simple table" its size suggests.** 10 of its 14 call sites
already hand-roll the chrome the ads grid has built in: `SyncControlClient` carries 17 pager
references, `SyncProductsGrid` and `HistoryClient` 11 each, `ProductsNextClient` hand-rolls toolbar,
filters, pager *and* search. Only `stock/locations`, `stock/import`, `fleet/map/EntityListView` and
`pricing/volume-pricing` are bare tables. Migration therefore **deletes** code at 10 of the 20 sites
rather than burdening them.

**A fourth option was considered and killed:** keep `DataGrid` as the primitive and layer the chrome
on top. The divergence is not chrome, it is **cell-level** — every ads cell is
`cellWithPencil(row, key, c.render(row))` with an edit-mode override, a `metric`-derived class and
freeze styling, plus interleaved group rows and a distinct first-column concept. A `DataGrid` that
grew all of that *is* `AdsDataGrid`, so option 4 collapses into option 2.

**Two conditions on the promotion:** it lands in `patterns/`, not as a primitive — 967 lines is not
a primitive, and the DS already has that layer — and it is **renamed**. Nothing about it is
ads-specific except its vocabulary; `WorkspaceGrid` is what it actually is.

### WG.1 shipped 2026-08-25 — and the "one field" turned out to be blocked

The correction above said the port was **one field plus two renames**. The renames are done
(`metric` → `align`, three alignments where there were two, `.ctr` added beside `.num`/`.ed`; all
64 ads call sites render byte-identically because `align` falls through to `metric` when unset).

**The one field does not port.** `Column.sticky` pins per column by accumulating widths inward from
the edge. In the ads grid the left edge is the IDENTITY cell, and it declares only
`max-width: 360px` — it is fluid. A left-pinned data column therefore cannot know where it starts,
and no arrangement of static CSS can tell it. It needs a runtime measurement, which is the same
measurement the operator-pinning work below needs.

So the two are one task, not two, and `sticky` was left OUT of WG.1 rather than shipped as a prop
that type-checks and does nothing.

**Consequence for the migration order.** The 20 call sites split:

| | |
|---|---|
| migrate now | every grid that does not left-pin a column |
| blocked on runtime measurement | the ones that do — `sticky: true` appears in **7** places across `stock/sync-control` (3), `stock/locations`, `stock/import` (3) |

The four bare-table sites named as the low-risk proof are NOT all clear: `stock/locations` and
`stock/import` both left-pin. `fleet/map/EntityListView` and `pricing/volume-pricing` are.

**Order, corrected.** Call sites cannot migrate first. Until the component lives in the DS,
pointing `fleet` or `pricing` at `app/marketing/ads/campaigns/_grid/AdsDataGrid` trades a duplicate
component for a cross-section app import — worse coupling than the thing being fixed.

| | | |
|---|---|---|
| WG.1 | `align` + `.ctr` | ✅ 2026-08-25 |
| WG.2 | extract the grid's CSS out of `ads.css` into a DS-owned stylesheet | the bulk |
| WG.3 | move the TSX + its three local deps into `patterns/WorkspaceGrid` | |
| WG.4 | `AdsDataGrid` becomes a re-export — 64 ads call sites untouched | |
| WG.5 | migrate the 20 DS `DataGrid` call sites | 5 blocked on `sticky` |
| WG.6 | retire the DS `DataGrid` | |

**The CSS is the real bulk, and it was under-counted.** Promoting the component means moving its
styles, and they are **312 rules across 10 interleaved blocks** of a 3,088-line `ads.css`, spanning
lines 19–3071 — not a contiguous block, not a cut-and-paste. Plus three app-local code
dependencies: `FilterDropdown` (370 lines), `AdsFilterBar` (178), `enabledRank` (20). Any estimate
of #13 that counts only `AdsDataGrid.tsx`'s 967 lines is short by more than half.

### WG.2 census 2026-08-25 — the plan had the shape wrong, and the blocker is not CSS volume

Measured before moving anything. Three corrections to the WG.2 line above:

**1. The CSS is 265 rules across FOUR stylesheets, not 312 in `ads.css`.**

| stylesheet | rules on a grid root |
|---|---|
| `ads.css` | 237 |
| `rules-automation/rules-automation.css` | 25 |
| `reporting/reporting.css` | 2 |
| `rules-automation/dayparting/rank-dayparting.css` | 1 |

Extracting "the grid's CSS out of `ads.css`" would leave three other stylesheets styling a component
whose styles had supposedly moved.

**2. Only 23 of 279 rules (8%) sit on a root the grid alone renders.** Partitioned by anchor root —
the first class of the selector, which is what a rule is actually attached to:

- **movable** (8 roots, 23 rules): `h10-dd-opt`, `h10-am-searchbox`, `h10-hc`, `h10-am-searchbtn`,
  `h10-dd-pop`, `h10-hc-anchor`, `h10-dd-empty`, `h10-dd-list`
- **entangled** (21 roots, 256 rules): led by `h10-am-grid` itself at **129 rules spanning lines
  32–3025** — interleaved through the whole file, exactly as warned.

Three of the entangled roots are not grid concepts at all and should be extracted as their own:
`h10-am-link` (+33 files), `h10-cd-field` (+10), `h10-am-card` (+8). The DS already has `Link`-like,
`Input`/field and `Card` primitives for these.

**3. 🔴 The real blocker: four call sites hand-roll the grid's markup and depend on its classes.**

`AdsDataGrid` has 64 render sites — and **`CampaignsGrid.tsx`, the flagship Ad Manager page, is not
one of them.** It hand-rolls `<div className="h10-am-grid"><table>…` itself (its own line 1720
comment admits it "carries its own copy of the banding"). So do three eBay wizard steps
(`ReviewStep`, `RatesStep`, `KeywordsStep`).

That makes `.h10-am-grid` a public API, not a component-private class. Renaming it to `nds-wsgrid-*`
— which WG.3 implies — silently unstyles four surfaces, and CSS never errors.

### WG.2b shipped 2026-08-25 — the DOM coupling, removed first

Seven call sites reached the grid with `document.querySelector('.h10-am-grid …')`. That is worse
than coupling: it takes the **first match on the page**, so with two grids mounted the column
hover-highlight, the drag hit-testing and the keyboard-focus scroll all targeted whichever grid
rendered first. All seven now scope to a ref on their own root — a correctness fix in its own
right, and the prerequisite for any rename.

(One transform hazard worth recording: replacing `document.querySelectorAll(…)` with
`(ref.current?.querySelectorAll(…) ?? [])` put a **leading paren** on a line after one with no
semicolon, so ASI parsed the previous `new Map<…>()` as a *call*. `Array.from(…)` starts with an
identifier and avoids it — and also collapses the `NodeListOf | never[]` union that made `.forEach`
uncallable.)

**Verified on prod 2026-08-25**, because none of this is provable by `tsc`:

- hover highlight — 101 cells lit, exactly one column (`amazonDelivery`), correctly scoped
- column drag — armed, swapped `amazonDelivery`/`automation`, persisted, and tore down clean
  (no stuck `col-dragging`, `user-select` cleared). Saved order then restored to the default.
- the old global selector is absent from the deployed bundle

🔴 **A method note that nearly produced a false negative.** The browser tool's `left_click_drag`
reported *no reorder*, which reads exactly like "the change broke the drag". It did not — the
gesture teleports without intermediate `pointermove` events, and this handler arms on the first
move past a 5px threshold. A synchronous synthetic `pointerdown → move → move → pointerup` on
`window` (its real listener target) reordered correctly. **An automated gesture that does nothing
is indistinguishable from a feature that is broken; confirm the gesture before blaming the code.**
An earlier attempt at the same probe froze the renderer by `await`ing a frame *inside* the drag,
which yielded to the handler's own `requestAnimationFrame` loop — drive it synchronously.

**Revised order.** WG.2 cannot start with the CSS:

| | | |
|---|---|---|
| WG.2b | scope the 7 DOM queries to refs | ✅ 2026-08-25 |
| WG.2a | 3 of 4 hand-rolled sites settled — the eBay wizard steps now use `.eb-tablebox` | ✅ 2026-08-25 |
| WG.2a′ | the 4th is `CampaignsGrid` — it is not a consumer to migrate, it is the thing that **becomes** WorkspaceGrid | folds into WG.3 |
| WG.2c | `h10-am-link` → DS `Button variant="link"`; `h10-am-card` → DS `.nds-card` | ✅ 2026-08-25 |
| ~~WG.2c (field)~~ | `h10-cd-field` — **mis-scoped, removed from WG.2**, see below | not a grid blocker |

**WG.2c closed, and one item removed from it.** Two of the three were genuinely grid-entangled:

- `h10-am-link` — 67 uses, 36 files. **No DS equivalent existed**, so this added
  `Button variant="link"`. It exposed a live bug: the class sets font-size and font-weight but
  never `font-family`, and buttons do not inherit it while anchors do — so **47 link-buttons were
  rendering in Arial** beside 18 identical-looking anchors in Inter. Four contextual rules
  (`.nds-toast`, `.h10-mmbid/.h10-editpop` disabled, `.h10-bud-foot`, `.aig2-sug`) were retargeted;
  all verified rendering.
- `h10-am-card` — 14 sites, a class swap onto `.nds-card`. Background and radius matched exactly;
  the border moves #d8dde4 → #e6e9ee because the DS chose `--nds-border-subtle` for cards (note
  `--nds-border` IS grey-200 — a style intent, not a defect, and far below any threshold WCAG
  applies to a container). The trap was `margin-top: 16px`, which the DS Card does not carry and
  four stacked AutomationTab cards depend on; kept explicit as `.h10-cardstack` rather than a
  scoped `.h10-shell .nds-card` rule that would silently re-style every future DS Card here.

🔴 **`h10-cd-field` was mis-scoped into WG.2c and is removed from it.** Measured: **1 of its 43
uses sits in a grid file, and that one is `bulkActions.tsx`** — the Bulk Actions modal, which lives
in `_grid/` but is a *consumer* of the grid's `selectionActions` slot, not the grid. `AdsDataGrid`,
`AdsFilterBar` and `FilterDropdown` use it **zero** times. It cannot block WG.2d.

It is still a real gap, just a separate one: `.h10-cd-field` is a **field group** (label above,
control below, bottom margin) and the DS has no such concept — `.nds-field` is an *input shell*
(inline-flex bordered container with adornment slots) that would sit *inside* one. I had recorded
them as the same concept by matching the class NAME; they are not. Closing it means designing a
`FormField` primitive (label, required marker, info slot, width) across 43 call sites, with the
input styling it currently also carries belonging to a separate text-input concept.

**The WG.2a design call, and why it is not an abstraction.** The three eBay wizard tables used
`.h10-am-grid` only as a scrollable bordered table container. Adopting `AdsDataGrid` would impose
967 lines of column config, sorting and selection they do not want; inventing a shared
`TableSurface` would build a cross-cutting concept on top of a DS `DataGrid` that #13 already
retires. So each of the 18 rules they actually depend on gained an `.eb-tablebox` branch — no
duplicated declarations, and the branches survive the rename.

Which 18 was **measured**: render the shape in a real DOM, then test `el.matches()` for every
`.h10-am-grid` selector. 17 of 148 matched. Three method notes worth keeping:

- The probe first returned **0 matches** — Chrome blocks `cssRules` on `file://` stylesheets and the
  try/catch hid it. Inline the CSS into a `<style>`. A zero has to be earned.
- The first transform read a **comment as a selector** and spliced a class into it. Mask comments
  with equal-length spaces before matching so offsets stay valid.
- The pixel check earned its place: `.h10-am-card .h10-am-grid` removes the border when nested and
  the matcher skipped it (the branch does not *start* with `.h10-am-grid`) — 127,336 differing
  subpixels. After the fix, **0 in both the in-card and standalone cases**, with a non-white-pixel
  count proving neither render was blank.
| WG.2d | move the 265 rules, across all four stylesheets | only now safe |

### 🔴 The requirement: pinning must become an OPERATOR preference, not developer config

Operator, 2026-08-25: *"I want the ability to be able to stick the column and lock the columns and
positions… myself, or freeze them"*, and to arrange them by dragging or through the Customise
dialog.

**Nothing in the codebase does this today, on either side of the merge.** Measured: no surface
anywhere exposes per-column pinning to the operator (the `togglePin` hits in the app are pinned
notes, guardrail pins, the placement inspector and the nav rail — none is a column). What exists is:

| | who decides | grain |
|---|---|---|
| DS `Column.sticky` / `.stickyRight` | **developer**, at the call site | per column |
| ads `GridColumn.freezeRight` | **developer**, at the call site | per column |
| `PreferencesValue.stickyFirstColumn` / `.stickyLastColumn` | operator | **first/last only**, on/off |

So the operator can only say *"honour the pins the developer chose, or don't"*. They cannot say
*"pin THIS column"*.

**The model that satisfies it — three bands, one ordered list.** This is the same move `AdsDataGrid`
already made for order and visibility (SGX3: *"order and stickiness are preferences here, not fixed
component config"*), extended to one more axis:

```
[ left-pinned, operator order ] [ scrolling, operator order ] [ right-pinned, operator order ]
```

- The pref becomes one ordered array carrying all three facts per column —
  `{ key, visible, pin: 'left' | 'right' | null }` — the natural extension of today's
  `visibleColumns: string[]`, which already carries set AND order for exactly this reason.
- In the dialog each row gets a pin control; setting a pin **moves the row into that band**, and
  drag reorders **within** a band.
- The developer's `sticky` / `stickyRight` / `freezeRight` become the **default** for that
  preference rather than fixed config — the same demotion order and visibility already got.

**The one hard part: sticky offsets need widths.** Both grids stack pinned columns by accumulating
`width`, which presumes pinned columns are contiguous at an edge AND have a numeric width — the ads
grid states it outright (*"fixed width in px — required with freezeRight"*). Once the operator can
pin any column, a column with no declared `width` can be pinned, and the offset maths has nothing to
add. Either pinning is offered only on columns declaring a width (honest, and the disabled control
must say why — see [[reference_disabled_control_cannot_explain]]), or widths are measured at
runtime. **Decide this before building**: it is the difference between a working feature and a
silently misaligned header.

**This supersedes the locking rule shipped on 2026-08-25.** `DataGrid`'s new `customizable` mode
locks pinned columns out of the drag region, which was correct *only while* pinning was positional
and developer-owned — a developer-pinned column dragged into the middle would pin over its
neighbours. Under the band model a pinned column is draggable **within its band**, and `locked`
narrows to its real meaning: structurally fixed columns, like the ads grid's first column or an
actions cell.

**Until it is decided**, `.design-sync/conventions.md` tells the claude.ai/design agent that
`DataGrid` is the product-table workhorse and explicitly **not** the ads console's grid, so designs
for that surface compose the missing affordances rather than assuming them.

*Method note, per §1: the prop lists came from the named interfaces after confirming neither
component declares props inline; call sites were parsed as JSX open tags with brace- and
generic-aware scanning. A naive `<Name ...>` regex reported* **zero** *props for `AdsDataGrid`,
because every call site uses generic syntax (`<AdsDataGrid<CampaignRow>`) and the regex terminated
on the generic's `>`.*


---

## Appendix B — a fourteenth concept: the modal (closed 2026-08-25)

Unlike #13, this one **was** a straight swap, and it is now done: **16 of 16 ads-console
modals render the DS `Modal`.** Recorded here because the reasons it looked hard were wrong,
and the reasons it was actually hard were invisible to `tsc`.

### The concept was duplicated three ways, not two

| | shell | Esc | backdrop click | portal | accessible name |
|---|---|---|---|---|---|
| DS `Modal` | `.nds-modal` | ✅ `[open, onClose]` | ✅ | ✅ `createPortal` | ✗ → **fixed** |
| ads `.h10-modal` markup ×14 | hand-rolled per site | ✗ (0 of 14) | ✅ | ✗ | each its own `aria-label` |
| `ebay/_lib/H10Modal` | hand-rolled once | ✅ but on `[props]` | ✅ | ✗ | `aria-label={title}` |

`H10Modal` was a **second `Modal`** with the same prop list (`open/onClose/title/subtitle/
footer/children`). Its effect depended on `[props]` — a fresh object every render — so its keydown
listener re-bound on every render. It now wraps the DS `Modal` and contributes only `.eb-form`,
which moved all 14 eBay call sites in one edit.

### What the DS was missing, found by converting rather than by reading

1. **No accessible name.** `role="dialog" aria-modal="true"` with a rendered title that nothing
   pointed at. Every ads modal carried its own `aria-label`, so a straight port would have *lost*
   the name. Now `useId` + `aria-labelledby`, with `aria-label` accepted for the untitled case.
2. ~~**Footer right-aligned everything.**~~ **Not a gap — corrected.** 11 of 16 ads modals split
   the footer with `<span className="grow" />`, and I added `.nds-modal-f .grow { flex: 1 }` to
   `components.css` believing it was missing. **`patterns.css:599` already defined it, identically.**
   The duplicate has been removed. The lesson is the cheap check I skipped: the DS splits its CSS
   across `components.css` and `patterns.css`, so "is this rule missing?" must be asked of the
   whole `styles/` directory, never one file.
3. **The scale stopped at xl/920.** `.h10-modal.neg` is 1040 and holds a keyword *table*. Added
   `xxl` (1040) rather than narrow a table by 12% to satisfy a scale.

### The trap: a class name is not a width

Four ad-group pickers carry `className="h10-modal wide apm"`. `.wide{width:560px}` is line 336;
`.apm{max-width:1000px;width:94vw}` is line 1352 — equal specificity, later wins. **They render at
1000px and `wide` is dead on them.** `ebay`'s `wide` was the same lie by a different route: `.wide`
(560) plus an inline `style={{width:760}}`.

Sizing from the class name would have narrowed four pickers 1000→560. `tsc` green, no CSS error.
Every width here was resolved with `getComputedStyle` on the real class *combination*.

The mapping that resulted — and the one rule that overrode "nearest step":

| was | → | why |
|---|---|---|
| `wide` 560 | `md` 560 | exact |
| `bulk` 600 | `lg` 660 | nearest that doesn't squeeze; its content carries its own 6px margins |
| `bm` 808 | `xl` 920 | widening only |
| `aig-add` 920 | `xl` 920 | exact (it declared 860 at line 1580, then 920 at 1660 — the first was dead) |
| `apm` 1000 | `xxl` 1040 | content width nets **+8px** (12px padding → 28px) |
| `neg` 1040 | `xxl` 1040 | exact |
| `eb wide` 760 | `xl` 920 | **not** the nearer `lg` 660 — see the rule |

> **Never narrow a modal that holds a table.** It spared `neg` (a keyword table) and then
> `ImportCsvModal` (`.eb-difftable`), where nearest-step would have cost 112px.

### The screenshot that decided the body padding

The ads shell pads its body `4px 12px` while header and footer sit at `18px`, so **every field
label hangs 6px left of the modal title**. The DS aligns all three at 18px. The one visible cost —
a targeting description rewrapping to two lines — is that misalignment being fixed. Measured
before/after: panel 510.4 → 534.5px tall at 560px wide.

### What CSS did after the markup left

12 rules required `.h10-modal` on an *ancestor* and would have stopped matching silently. The five
`.h10-modal.apm .apm-ctx*` rules were re-anchored to `.apm-ctx*`; 21 dead shell/variant rules were
swept, along with `.eb-modal-f`. `.h10-modal-err` stays — `StrategyModal` still uses it.

Two rules were already dead before this work: `.h10-modal.tc` (660px, **no tsx user at all**) and
the first of `.aig-add`'s two width declarations.

### The probe that would have gone green on nothing

`scripts/_spw_a11y.mjs` asserts `(await p.$('.h10-modal')) === null` to prove Esc closed the modal.
After conversion that selector matches nothing, so it would have reported **pass** for a modal it
could no longer see. Eight `_spw_*` probes were retargeted to `.nds-modal*`.

### Verification

`tsc` clean; `ds-conformance-guard`, `check-css-hex-ratchet`, `check-alias-form` all exit 0; both
workspace builds green on push. Every string literal was diffed old-vs-new across all 19 files —
the only losses are shell class names, the `role`/`Close`/`Escape` strings the DS now owns, and
six `aria-label`s superseded by the visible title.

Shipped in `eda47fc6f`, `4d432be9c`, `4e5d3bb7b`.

### Ported to `apps/factory`, and one claim withdrawn

`apps/factory` keeps a forked DS copy; its `Modal.tsx` was **byte-identical** to web's before this
work, so the two genuine fixes ported cleanly and the file is now identical again. That gave **46
factory modal call sites** an accessible name — none of them passed `aria-label`, so the change is
purely additive.

It also exposed the error above: factory already had `.nds-modal-f .grow` in *its* `patterns.css`,
which is what sent me to check web's — where it had been all along.
