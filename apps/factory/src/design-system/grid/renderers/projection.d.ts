/**
 * VP.5 — the PROJECTION vocabulary: what one variant row says about one channel coordinate.
 *
 * The Variants page (spec `docs/2026-09-11-variants-page-spec.md` §3.3) puts one cell per
 * connected channel × market beside every variant, and §9 fixes the five words it may say:
 *
 *     Listed · Draft · Excluded · Not set up · Needs a value
 *
 * VT.4 added a SIXTH, `Collides` (VX design D9, `docs/2026-09-12-variation-projection-design.md` §11.3),
 * on the same rule: its tone is READ from `readinessMeta`, its `from` records which state, and it earns a
 * member because its remedy is in the mapping dock and not in the cell. See its entry below.
 *
 * ## Why this is a THIRD table and not a local map
 *
 * `readiness.ts` deliberately holds two vocabularies and exports no converter between them
 * (hub rulings #3 and #11): a ROW is `ready | missing | errors | live | unlisted`, a SCOPE is
 * `ready | warn | blocked | absent`. The five words above are neither list renamed —
 *
 *   - `Excluded` has no counterpart in either. It is not a degree of readiness and not an
 *     absence of setup: it is the operator's own decision to leave this variant out of this
 *     listing. It is the one genuinely new state, and it paints NO status colour at all
 *     (`dot: 'none'`, muted text), so there is no colour here to fork.
 *   - `Not set up` is a SCOPE fact rendered in a row's cell — the channel column exists so the
 *     absence is visible (§3.3), and the whole coordinate, not this row, is what is missing.
 *   - `Listed` / `Draft` / `Needs a value` are row facts under different names.
 *
 * So the rule ruling #3 exists to enforce — *one source of tone; no lane invents a colour* — is
 * kept the only way it can be: **every tone below is READ from `readinessMeta()`**, by a declared
 * counterpart recorded in `from`, and this file is the one place that declaration lives. Nothing
 * here picks a colour. A lane that needs the projection vocabulary imports it; a lane that writes
 * `state === 'draft' ? 'neutral' : …` has forked it, and that is what this file prevents.
 *
 * The WORDS come from spec §9, verbatim and literal, because the spec is the approved copy —
 * `readinessMeta('live', 'row').label` is "Live", and the operator reads "Listed". Both facts are
 * pinned by tests in `projection.vitest.test.ts`, so neither can drift unnoticed.
 *
 * ## Two counterparts worth arguing about (stated, not hidden)
 *
 *   - `draft → unlisted`. §3.3 asks for a hollow NEUTRAL dot, and `unlisted` is the only
 *     neutral-toned row state. It also reads correctly: a draft has no live listing yet, which is
 *     exactly what the sheet reports for the same coordinate.
 *   - `needs-value → missing`: a missing value uses the row warning tone.
 *
 * Pure — no React, no CSS, no imports beyond the sibling table — so both the rule and the words
 * are reachable from this repo's node-environment vitest.
 *
 * 🔴 IMPORT THIS FILE DIRECTLY, not through `@/design-system/grid`. The grid barrel pulls
 * `NexusGrid.tsx` → `ag-grid-react` → `theme/grid.css`, and this workspace's vitest is
 * `environment: 'node'` with no CSS transform — so a lane's own rules become untestable the moment
 * they reach this table through the barrel. Deep-import `grid/renderers/projection` (and
 * `grid/renderers/readiness`) in anything a test has to load. Reported by VP.3, 2026-09-11.
 */
import { type ReadinessTone } from './readiness';
/** One variant row against one channel coordinate, as the operator reads it. */
export type ProjectionState = 'listed' | 'draft' | 'excluded' | 'not-set-up' | 'needs-value' | 'collides' | 'suppressed' | 'closed' | 'error' | 'ended';
export interface ProjectionMeta {
    /** Taken from `readinessMeta()`; never chosen here. See `from`. */
    tone: ReadinessTone;
    /** The word in the cell. Spec §9, verbatim. */
    label: string;
    /** 7px status dot: filled, ring-only, or not painted at all. */
    dot: 'solid' | 'hollow' | 'none';
    /** The row is not participating on this coordinate — word and detail render quiet. */
    muted: boolean;
    /**
     * Whether the include checkbox can be toggled here. `false` HOLDS the control
     * (`aria-disabled` + a reason), never the `disabled` attribute, which cannot deliver one
     * (`scripts/check-silent-disabled.mjs`).
     */
    interactive: boolean;
    /** One sentence an operator can read on hover, and the reason a held checkbox gives. */
    hint: string;
    /**
     * The readiness state this tone was read from, as `"<vocabulary>:<state>"`, or `null` when the
     * state paints no status colour. Present so an auditor can check the delegation without
     * re-deriving it, and so a test can assert the tone still equals its source.
     */
    from: `row:${string}` | `scope:${string}` | null;
}
/**
 * The tone, word and presentation of one projection state.
 *
 * An unknown state is a contract change, and a cell that rendered it as "Listed" would be lying.
 * It is named instead — neutral, verbatim, no dot, held — the same refusal `readinessMeta` makes.
 */
export declare function projectionMeta(state: ProjectionState): ProjectionMeta;
export declare function projectionMeta(state: string): ProjectionMeta;
/** Every projection state, in the order §3.3 lists them — for a legend or a filter's options. */
export declare const PROJECTION_STATES: ProjectionState[];
/** Whether a wire value is one of ours. A read boundary should parse, not cast. */
export declare function isProjectionState(value: unknown): value is ProjectionState;
