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
