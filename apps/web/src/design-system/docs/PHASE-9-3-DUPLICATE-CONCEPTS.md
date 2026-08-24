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

**Input has no error state anywhere in the design system.** There is no `.h10-ds-field.invalid`
rule and no `error` prop; the legacy `Input` has `label`, `error`, `hint` and `charLimit`. The
DS's current answer is composition — label above, message below in
`var(--h10-danger-strong)`, `aria-invalid` on the control. **Decide:** design a real field-error
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

Measured on `/design`: `.h10-ds-card` resolves, `.h10-ds-btn` **does not** — `components.css`
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

Verified on `/sync-logs` and `/dashboard`, routes that import nothing themselves: `.h10-ds-btn`
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
stylesheets consume only `--h10-*`, `tokens.css` can be split — the `--h10-*` tiers load
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

**Until it is decided**, `.design-sync/conventions.md` tells the claude.ai/design agent that
`DataGrid` is the product-table workhorse and explicitly **not** the ads console's grid, so designs
for that surface compose the missing affordances rather than assuming them.

*Method note, per §1: the prop lists came from the named interfaces after confirming neither
component declares props inline; call sites were parsed as JSX open tags with brace- and
generic-aware scanning. A naive `<Name ...>` regex reported* **zero** *props for `AdsDataGrid`,
because every call site uses generic syntax (`<AdsDataGrid<CampaignRow>`) and the regex terminated
on the generic's `>`.*

