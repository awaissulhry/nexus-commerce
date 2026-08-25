# Aligning the advertising console with the Nexus Design System

You are ONE OF SIX parallel sessions. Read this whole file before touching anything.

## The goal
Every component in the advertising console uses the design system instead of hand-rolling
what the DS already ships. Measured 2026-08-25: **453 components, 1,331 raw `<button>`,
269 `<input>`, 70 checkboxes, 48 `<table>`, 33 `<select>`, 25 hand-built modals.**

## The DS is at `apps/web/src/design-system/`
- `primitives/` — **Button** (`primary|secondary|ghost|danger|link`, `md|sm`, `active`), ToolbarButton, tone
- `components/` — Modal, Listbox, MultiSelect, Combobox, Menu, Tabs, Card, Banner, Toast,
  Drawer, EmptyState, Pagination, ProgressBar, DateField, DateRangePicker, HoverCard, DataGrid…
- `patterns/` — AppShell, PageHeader, FilterBar, GridToolbar, PreferencesModal, BulkActionBar,
  ColumnCustomizer, EditModeBar, Builder, DetailHeader, workspace-grid/**WorkspaceGrid**
Read the component before using it. `components/README.md` and `patterns/README.md` are current.

## 🔴 Rule 1 — you may NOT edit the design system
`design-system/**` is owned by the DS session alone. Six sessions editing shared files is how
one concept ends up with five spellings.
**Known DS coverage, corrected 2026-08-25 by measurement — read this before reporting a gap:**
- **Icon-only buttons are already covered.** `primitives/ToolbarButton` takes `icon` + `label`
  (which becomes the `aria-label`) + `active` (`aria-pressed`) + `badge` + tooltip. The console's
  boxed icon buttons (`.az-iconbtn`, `.h10-sug-iconbtn`, `.rec-iconbtn`) map straight onto it.
  Do NOT report these as a gap; convert them.
- **A `Segmented` control is genuinely missing** and the DS session is building it. Leave the
  console's 20 `-seg` spellings alone until it lands.
- **The bare icon button** (`.x` ×29, `.rm` ×14 — `border:none; background:none`) is a real gap,
  also with the DS session. Note that none of those 43 call sites has an `aria-label` today.

**Found some OTHER gap, or a missing variant?**
STOP on that case, leave the original markup untouched, and write one line to
`.claude/DS-GAPS.md` (append, never rewrite: `- <class> → <what's missing> — <file:line>`).
Then move on. Do not invent a local workaround. Do not extend the DS.

## 🔴 Rule 2 — stay inside your scope
Your prompt names your directories. Touching a file outside them WILL collide: a parallel
session has it open, and git will silently absorb their half-finished work into your commit.
This has already happened twice on this repo.

## 🔴 Rule 3 — commit discipline
The sessions share one working tree and one git index.
```sh
until [ ! -e .git/index.lock ]; do sleep 2; done
git commit -m "msg" --only -- path/one.tsx path/two.css   # -m BEFORE the `--`
```
A file you just CREATED is untracked, and `--only` refuses untracked paths — `git add` it
first, then commit with the same pathspec.
Everything after `--` is a pathspec, so `--only -- <paths> -m "msg"` makes git look for a file
called `-m` and fail. Never `git add .`, never a bare `git commit`.
`--only` still absorbs a parallel session's edits to the SAME file — which Rule 2 prevents.
**Never `--no-verify`.** Pre-push runs six DS guards; if one fails, that is the system working.

## The method — all six steps, every time
1. **Census every spelling** — the same concept hides under `-chip`, `-pill`, `-badge`.
2. **Resolve by computation, not by class name** — a class called `w-560` rendered at 1000px.
   Use `getComputedStyle` on the real class *combination*.
3. **Never lower contrast** — a substitution may only ever raise it. Measure both colours.
4. **Verify in three dimensions** — `tsc`, a string-literal diff of the change, and *pixels*.
   Each catches what the other two cannot see.
5. **Delete the CSS you orphaned.** A converted button leaves a dead rule behind.
6. **Report honestly.** "17 of 20; 3 blocked on a DS gap" beats a clean-sounding "done".

## Traps this repo has already paid for
- **A single-line `grep` misses multi-line CSS rules and multi-line `import {}` blocks.** Six wrong
  measurements this session came from exactly this. Parse structure; never regex a whole file.
- **CSS source order beats specificity at equal specificity.** Overriding needs the END of the file.
- **An undefined CSS class fails silently** — check class↔stylesheet in BOTH directions.
- **A selector matching nothing makes a test pass.** Assert the match count, not just the result.
- Screenshots are SCALED — never trust raw coordinates from one.

## Never touch
`apps/web/src/app/products/amazon-flat-file/**`, `.../ebay-flat-file/**`,
`apps/api/src/routes/{amazon,ebay}-flat-file.routes.ts` — hard no-touch zone.
Do not rotate credentials. Do not deploy. Do not `git push --force`.

## Done
Per directory, in small verified units: convert → `tsc` → screenshot → delete dead CSS →
`git commit --only`. Push when the unit is green. Report what you skipped and why.
