# Retiring the Tailwind kit

**Status:** SCOPE — direction set by the operator 2026-08-24: *"make the tailwind legacy, and use
the design system for all of them."* Not started as a programme; **Phase 9.3 is already doing the
component half** (`design-system/docs/PHASE-9-3-DUPLICATE-CONCEPTS.md`), tranche by tranche.

**One sentence:** `components/ui` and the design system implement the same twelve concepts, 397
files import the legacy copy — and the harder half is not those imports but the **376 files that
use raw Tailwind utility classes and import nothing at all**.

Token vocabulary: `/DESIGN.md`. Measured 2026-08-24 at `cc6314471`.

---

## 1. The number that gets missed

| bucket | files |
|---|---:|
| imports `@/components/ui` | 397 |
| **raw Tailwind utility classes, no kit import** | **376** |
| on `@/design-system` | 127 |
| on `ads.css` | 246 |
| no styling at all | 360 |

**773 files are Tailwind-dependent, not ~290.** A component-swap migration walks straight past the
376: they carry no import to grep for, only `className="flex gap-2 text-sm bg-white"`. Any plan
sized on import counts is half a plan.

Where the 397 sit:

| section | files | | section | files |
|---|---:|---|---|---:|
| products | 150 | | settings | 17 |
| fulfillment | 75 | | orders | 13 |
| marketing | 29 | | pricing | 10 |
| dashboard | 23 | | listings | 9 |
| insights | 21 | | sync-logs | 9 |
| bulk-operations | 19 | | _shared | 7 |

## 2. `components/ui` is not the enemy — it is the well-behaved one

It scores ~0 violations on the DS-conformance ratchet. Not from discipline: **Tailwind utility
classes are its token layer**, resolved through `tailwind.config.ts`. Where a token vocabulary is
the only way to write the code, it gets used — which is the same lesson as
`TOKEN-GUARD-RATCHET.md`, from the other direction.

So "retire Tailwind" is not "remove a mess". It is **moving 773 files from one working token system
to another**, and the reason to do it is one visual language, not code quality.

## 3. What actually blocks it

**Phase 9.3 measured the component half and found no clean drop-in among the twelve.** Do not
re-derive it — read that doc. The three items it says need a decision are still open, and two are
the largest concepts:

- **`Toast` runs the other way.** The legacy implementation is *richer* — 567 `toast.error` + 333
  `toast.success` + 147 object-form calls using tone helpers, title/description and an action
  button the DS version does not have. Swapping is a downgrade dressed as convergence.
- **`Badge` is a name collision, not a duplicate.** DS `Badge` is an ad-program chip
  (`program: AdProgram`); the legacy one is a generic label with 246 uses. Its real equivalent is
  `Tag` or `Pill` — both already exist.
- **`Input`**: the DS has **no error affordance at all** — no `error` prop, no
  `.nds-field.invalid` rule — while the legacy one carries label/error/hint/charLimit across 38
  files.

Beyond those, three gaps have no DS equivalent at all:

| missing | legacy uses | note |
|---|---:|---|
| `ConfirmProvider` / `ConfirmDialog` | **81 files** | The DS already made a call here: `AccountsPanel` takes a `confirm` prop and delegates to the host. Decide whether the DS grows a Confirm or that pattern is the answer. |
| `IconButton` | 38 | `ToolbarButton` is close but is a fixed 28×28 icon button |
| `MultiSelectChips` | 5 | `MultiSelect` / `TagInput` are adjacent |

And `_shared/grid-lens` is a **22-file subsystem** the DS covers only partly (`GridToolbar`,
`ColumnCustomizer`, `PreferencesModal`).

## 4. The half that is genuinely easy

Twelve primitives map closely and cover ~700 of ~800 import sites: `Button` (200),
`Toast`→`ToastProvider` (145), `Card` (142), `Modal` (59), `EmptyState` (55), `Skeleton` (38),
`Input` (35), `Tooltip` (18), `Tabs` (9), plus `Spinner` and `ProgressBar`.

**Phase 9.3's approach is the right one and is already running: adapters, not replacements.**
`components/ui/Tabs` became a thin adapter over the DS (`3ca5438e5`); `Card`, `EmptyState`,
`Spinner`, `ProgressBar` followed (`5fd58b847`). An adapter keeps all 397 call sites working while
collapsing the implementation — the opposite of the "build new primitives" advice that gets given
for greenfield projects and would produce a *third* button here.

## 5. The cost nobody counts

Component swaps are the cheap half. The expensive half is the token tier:

- Every migrated file flips from `rgb(var(--text-primary))` to `var(--text-primary)` — see
  `/DESIGN.md`, "the same names mean two different things".
- Every Tailwind colour utility in it (`text-primary`, `bg-surface-card`, `border-default`) is
  bound through `<alpha-value>` in `tailwind.config.ts` against channel-format tokens. Those
  classes stop resolving when the file leaves Tailwind.
- `--border-default` alone feeds **636 files**, which is why Phase 9.0b could not simply flip
  `globals.css` to whole colours.

**Sequencing consequence:** a section is only safe to migrate once its token tier is settled. That
is Phase 9.2 (`Converge globals.css onto H10`), and it is upstream of this work, not parallel to it.

## 6. Suggested order

Not a schedule — a dependency order.

| | | why |
|---|---|---|
| 1 | Let **9.3** finish the adapters | Already running. It removes the duplicate-implementation problem without touching call sites. |
| 2 | Decide the three **9.3 blockers** | Toast, Badge, Input. Two are the biggest concepts; guessing them is how you get a downgrade. |
| 3 | Fill the three **DS gaps** | Confirm (81 files), IconButton (38), MultiSelectChips (5). |
| 4 | **9.2** — converge `globals.css` | Settles the token tier. Nothing below is safe first. |
| 5 | Section by section, smallest first | `listings` (9) → `orders` (13) → `settings` (17) → … → `fulfillment` (75) → `products` (150). Screenshot-diff each. |
| 6 | The **376 raw-utility files** | No import to grep. Needs a class-level codemod and the `token-guard` ratchet extension (`TOKEN-GUARD-RATCHET.md`) to stop the backfill. |
| 7 | Delete `components/ui` and drop Tailwind | Only once 5 and 6 are done. |

## 7. What would make this fail

- **Sizing it on import counts.** 397 is not the number; 773 is.
- **Migrating before 9.2.** The token collision turns a mechanical swap into silent visual breakage
  that no test catches — invalid declarations are *dropped*, not errored.
- **Treating `Toast` as a swap.** It is a downgrade unless the DS grows the richer API first.
- **Skipping the guard.** Adherence outside the design system is 5–12% today. Without the ratchet
  extension, migrated sections refill at the rate new code lands.
