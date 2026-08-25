# Design System — Consistency & Hardening

**Date:** 2026-06-27
**Topic:** Make `apps/web/src/design-system` internally consistent, self-truthful, and durable — the trustworthy foundation for all new and rebuilt UI.
**Status:** Design approved; spec under review (pre-implementation).

---

## 1. Context

The Nexus design system (`apps/web/src/design-system`, ~6,300 LOC, 95 files) is
already substantial: 18 primitives + 21 components + 8 patterns (47 runtime
`.tsx`), a token layer (TS + CSS), a living catalog, a studies framework, and 8
governance docs. Its bones are strong.

An audit against its own documented rules surfaced a small number of real
inconsistencies. The good parts first, as the baseline we must not regress:

- **Zero raw hex** in any primitive/component/pattern — `tools/token-guard.mjs`
  is doing its job.
- **Complete barrels** — every folder ships an `index.ts` exporting its surface.
- **Clean file/component naming** — PascalCase, one component per file.
- A real governance/contribution/naming/accessibility doc set.

### Findings (evidence)

| # | Severity | Finding | Evidence |
|---|---|---|---|
| 1 | Structural | **Semantic tier exists but is `--nds-`-named, not platform-named.** `NAMING.md`, `GOVERNANCE.md`, `TOKEN-RECONCILIATION.md` say components consume the platform's semantic names (`--text-primary`, `--surface-card`, `--status-*`). Reality: an internal semantic Tier 2 exists (`--nds-text`, `--nds-bg`, `--nds-border`, `--nds-primary`, `--nds-success-soft`…) and components mostly consume *that* — so "consume semantic, not primitive" is largely honored — but under the `--nds-` prefix, never the platform names. Convergence with the ~290 platform pages is therefore not wired. | `styles/tokens.css` `:root` is explicitly 3-tiered (ramps → semantic roles → component tokens); **124 distinct `--nds-*`** are consumed by component CSS; **0** platform-semantic names are. |
| 1b | Mechanical | **~13 genuine raw-ramp reaches.** A handful of component CSS rules skip the semantic tier and consume Tier-1 ramps directly — e.g. `.nds-tag.{neutral,info,positive,danger}` use `var(--nds-green-700)`, `var(--nds-blue-700)`, `var(--nds-grey-700)` (`primitives.css:147-151`), plus ~8 more `var(--nds-grey-NNN)` reaches in `primitives/components/patterns.css`. *This* is the real "consume primitive" violation to fix. | 13 hits across the 3 component stylesheets. |
| 2 | Structural | **Two parallel token sources, no generator.** `tokens/*.ts` (JS API) and `styles/tokens.css` (render source) are hand-maintained separately; governance claims "TS generates CSS". | No generator exists (only a lint). Values agree today (`#1f6fde` both) but nothing enforces it. |
| 3 | Mechanical | **One outlier component.** `TagInput.tsx` bypasses the system — raw Tailwind palette + hand-rolled `dark:`, no `.nds-*`. | 8 raw-palette hits (`bg-blue-100`, `text-slate-800`…), 7 `dark:` variants; it is the *only* such file. |
| 4 | Mechanical | **Status/color-role API uses three value vocabularies + a mislabeled component.** | Pill `ok\|warn\|arch\|err`, Tag `neutral\|info\|positive\|warning\|danger`, Toast `info\|success\|error`, Banner `info\|warning\|error\|success`. Badge `BadgeTone = sp\|sd\|sb\|auto\|manual` is the **ad-program badge**, not a tone. `Kbd` exported without its type. `size` scales differ. |
| 5 | Mechanical | **Docs drift from reality.** README says *"Phase 0 — No runtime code yet"* and tags folders "Built in Phase 1–8" (future tense). | CHANGELOG shows P0–P8 **complete**; 47 runtime components exist. |

The DS is consumed by only **25 app files** today (most-used: Input ×7, Modal
×6, Button ×4); **zero** import `tokens` or `lib` directly. Adoption is young —
so breaking changes are cheapest now.

---

## 2. Decisions (locked)

1. **Token tier → alias + migrate.** Add the semantic layer as *value-preserving*
   aliases over the existing `--nds-*` scale, then repoint all 47 components onto
   the semantic names. `--nds-*` survives as the raw tier. No color values move,
   so the catalog screenshot-diff is a no-op — that is the safety net.
2. **Source of truth → generate CSS from TS.** `tokens/*.ts` becomes the single
   source (enriched to hold light + dark + the semantic aliases). A small build
   script emits the `:root{}` + `.dark{}` blocks of `styles/tokens.css`. Drift
   becomes structurally impossible.
3. **API → harmonize now (breaking OK).** Unify the value vocabulary and prop
   names, fix the mislabeled Badge, standardize `size`, export `Kbd`'s type,
   align ref/`className`/controlled patterns, and update all 25 consumers in the
   same sweep.

**Scope:** the `design-system/` folder itself. *Not* migrating the ~290 existing
pages (the later "rebuild current stuff"). Consumers change only where our API
forces it.

---

## 3. The consistency contract (definition of "perfect")

Every primitive / component / pattern MUST satisfy — and, where feasible, this
becomes lint:

- **C1 — Styling:** rendered via `.nds-*` classes only; resolves through
  **semantic** tokens. No raw hex, no raw Tailwind palette classes, no `--nds-*`
  consumed directly in component CSS.
- **C2 — Prop vocabulary:** `tone` (semantic color role), `size`, and `variant`
  (emphasis) used with one canonical meaning and value set across the system.
- **C3 — Exports:** component + all its public types exported via the barrel.
- **C4 — Composition:** forwards `ref` and merges `className`; controlled/
  uncontrolled pattern consistent with siblings.
- **C5 — Catalog:** an entry rendered in every relevant state.
- **C6 — A11y:** focus-visible, ARIA where interactive, keyboard operable,
  `prefers-reduced-motion` honoured; WCAG AA contrast.

---

## 4. Workstream A — Token architecture (keystone)

- **A1. Semantic alias layer.** Add the platform's semantic names, each aliasing
  today's `--nds-*` value — e.g. `--text-secondary: var(--nds-text-2)`,
  `--surface-canvas: var(--nds-bg)`, `--status-danger-soft: var(--nds-danger-soft)`.
  Names follow the existing `TOKEN-RECONCILIATION.md` tables (text / surface /
  border / status / `--color-primary`). **No value changes.**
- **A2. Repoint components.** Flip every `.nds-*` rule in
  `primitives.css` (93), `components.css` (214), `patterns.css` (93) off
  `--nds-*` onto the semantic names, per the mapping table produced in Phase 0.
  `--nds-*` values with no semantic role (ad-program badge colors, focus-ring
  composite) become explicit, named **component tokens**.
- **A3. TS as the one source.** Enrich `tokens/*.ts` so it carries the complete
  truth — light + dark + semantic aliases + component tokens. Author a generator
  (`tools/generate-tokens-css.mjs`) that emits the `:root{}` and `.dark{}` blocks
  of `styles/tokens.css`. The hand-written `.nds-*` component classes are out
  of generator scope and stay as-is.
- **A4.** Fix the governance text that claims generation already happens.

`/marketing/ads` is untouched and safe — it reads `--nds-*`, which we keep.

---

## 5. Workstream B — API harmonization

- **B1. One canonical tone.** `type Tone = 'neutral' | 'info' | 'success' |
  'warning' | 'danger'`, prop named `tone`, applied to **Pill, Tag, Toast,
  Banner**. The exact per-value remap (e.g. Pill `ok→success`, `warn→warning`,
  `err→danger`, `arch→neutral`; Tag `positive→success`; Toast/Banner
  `error→danger`) is produced in Phase 0 for sign-off. `arch` (archived) is
  flagged: confirm it folds to `neutral` vs. warrants a kept state.
- **B2. Button keeps `variant`** (`primary|secondary|ghost`) — the *emphasis*
  axis, deliberately not merged with `tone`.
- **B3. Badge renamed to its real meaning.** `BadgeTone (sp|sd|sb|auto|manual)`
  → the ad-program type (proposed `program` prop / `AdProgram` type). Removes the
  false "tone" label.
- **B4. Standardize `size`** to one scale (`sm|md|lg` baseline; `xl` only where
  justified, e.g. Modal). **Export `Kbd`'s type.** Align ref + `className`
  forwarding and controlled/uncontrolled patterns across primitives.
- **B5. Rebuild `TagInput`** to match siblings — `.nds-*` + semantic tokens,
  dropping the raw Tailwind palette and hand-rolled `dark:` (dark comes free from
  the token flip).
- **B6. Sweep the 25 consumers** in the same change set so nothing breaks;
  `tsc` + `next build` clean.

---

## 6. Workstream C — The Map + docs reconciliation

- **C1. `docs/AUDIT.md` — the exhaustive map** (Phase 0, read-only): every token
  (tier + semantic mapping), every primitive/component/pattern (props, tone/size,
  catalog coverage, a11y state, contract C1–C6 conformance), and every
  inconsistency with severity + resolution. Becomes living documentation.
- **C2. Reconcile README / GOVERNANCE / CHANGELOG** with reality (remove
  "Phase 0 — no runtime code yet", the future-tense phase columns, the false
  generator claim).
- **C3.** Optional: add a root `@/design-system` barrel for ergonomic imports.

---

## 7. Workstream D — Guardrails (so it stays perfect)

Extend `tools/token-guard.mjs` and CI:

- **D1.** Fail on **raw-ramp** usage inside component CSS —
  `var(--nds-{grey,blue,green,red,amber,purple,cyan}-NNN)` — forcing the semantic
  or platform tier. DS-specific `--nds-*` component tokens (radius/shadow/focus/
  pill/badge/rail) remain allowed; this guard targets only the numbered ramps.
- **D2.** Fail on raw Tailwind palette classes in DS `.tsx` (would have caught
  TagInput).
- **D3.** API-consistency check: every component exports its types; `tone`/`size`
  unions conform to the canonical sets.
- **D4.** Wire `catalog/verify.mjs` @2x baselines into CI for automated
  screenshot-diff, per the existing review gate.

---

## 8. Sequencing & safety

| Phase | Work | Gate |
|---|---|---|
| **0 — Map** | `docs/AUDIT.md` inventory + inconsistency register + the exact `--nds-*→semantic` mapping + the per-value tone remap for sign-off | Read-only; no risk |
| **1 — Token source + semantic layer** | Enrich TS, add semantic aliases, write generator, generate `tokens.css` | Screenshot-diff = **no-op** |
| **2 — Repoint components** | Flip `.nds-*` rules onto semantic tokens | Per-component screenshot-diff |
| **3 — API harmonize** | tone/size/Kbd/Badge/ref/className + TagInput rebuild + 25-consumer sweep | `tsc` + `next build` clean |
| **4 — Guardrails + docs** | Extend token-guard, CI screenshot-diff, reconcile docs | Lints green |
| **5 — Catalog/a11y completeness** | Every component in catalog in every state; a11y + contrast verified | Contrast lint + catalog review |

Each phase ends with the existing gate: `build → tsc + contrast lint +
screenshot-diff → human visual review → commit & push`. Commit with
`git commit --only <paths>` (concurrent sessions share `main`).

---

## 9. Risks & mitigations

- **Value drift during migration.** Mitigated by the value-preserving alias
  approach — Phases 1–2 must screenshot-diff to a no-op; any visible diff is a
  bug to fix, not to accept.
- **`/marketing/ads` regression.** Out of the change path (`--nds-*` retained);
  verified by the ads-surface screenshot-diff in the gate.
- **Breaking the 25 consumers.** Bounded and updated in the same PR as the API
  change; `tsc` + build catch the rest.
- **Generator vs. dark/composite tokens.** Generator scope is the `:root`/`.dark`
  variable blocks only; component CSS classes stay hand-written. TS must be
  enriched to hold dark values before generation flips on.

---

## 10. Out of scope

- Migrating the ~290 existing pages onto the DS (separate "rebuild" track).
- Changing the `.h10-*` → `.nx-*` class rename (the Phase 9 codemod, deferred).
- Any edit to `/products/amazon-flat-file` or `/products/ebay-flat-file`
  (standing hard constraint).
- New color values / a visual redesign — this engagement is *consistency*, not
  restyle.

---

## 11. Open items (resolved in Phase 0 audit, surfaced for sign-off)

1. Canonical tone words: `neutral | info | success | warning | danger` — confirm.
2. Pill `arch` → `neutral`, or keep an explicit archived state?
3. Badge rename target: `program` prop / `AdProgram` type — confirm.
4. Root `@/design-system` barrel — include or skip?

---

## 12. Success criteria

- Contract C1–C6 holds for every primitive/component/pattern, enforced by lint
  where feasible.
- One token source (TS); `tokens.css` generated; zero possible drift.
- Components consume **platform-semantic** names for the core color roles
  (text/surface/border/status/primary); **never the raw ramps** (`--nds-*-NNN`)
  directly; DS-specific `--nds-*` component tokens (radius/shadow/focus/pill/
  badge/rail) remain legitimate. Zero raw Tailwind palette in DS `.tsx`.
- One `tone` vocabulary; Badge correctly named; `size` standardized; all types
  exported.
- Docs match code; `docs/AUDIT.md` maps the whole system.
- `/marketing/ads` renders pixel-identical; the 25 consumers build clean.
