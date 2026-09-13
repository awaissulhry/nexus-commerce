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
import { readinessMeta, type ReadinessTone } from './readiness'

/** One variant row against one channel coordinate, as the operator reads it. */
export type ProjectionState =
  | 'listed' | 'draft' | 'excluded' | 'not-set-up' | 'needs-value' | 'collides'
  /* MX.G — the four the Matrix adds (design `docs/2026-09-13-matrix-page-design.md` §3.4). */
  | 'suppressed' | 'closed' | 'error' | 'ended'

export interface ProjectionMeta {
  /** Taken from `readinessMeta()`; never chosen here. See `from`. */
  tone: ReadinessTone
  /** The word in the cell. Spec §9, verbatim. */
  label: string
  /** 7px status dot: filled, ring-only, or not painted at all. */
  dot: 'solid' | 'hollow' | 'none'
  /** The row is not participating on this coordinate — word and detail render quiet. */
  muted: boolean
  /**
   * Whether the include checkbox can be toggled here. `false` HOLDS the control
   * (`aria-disabled` + a reason), never the `disabled` attribute, which cannot deliver one
   * (`scripts/check-silent-disabled.mjs`).
   */
  interactive: boolean
  /** One sentence an operator can read on hover, and the reason a held checkbox gives. */
  hint: string
  /**
   * The readiness state this tone was read from, as `"<vocabulary>:<state>"`, or `null` when the
   * state paints no status colour. Present so an auditor can check the delegation without
   * re-deriving it, and so a test can assert the tone still equals its source.
   */
  from: `row:${string}` | `scope:${string}` | null
}

/* Each tone is READ, not written. The `readinessMeta` call is the whole point of the line. */
const PROJECTION: Record<ProjectionState, ProjectionMeta> = {
  listed: {
    tone: readinessMeta('live', 'row').tone,
    from: 'row:live',
    label: 'Listed',
    dot: 'solid',
    muted: false,
    interactive: true,
    hint: 'This variant is live on this channel',
  },
  draft: {
    tone: readinessMeta('unlisted', 'row').tone,
    from: 'row:unlisted',
    label: 'Draft',
    dot: 'hollow',
    muted: false,
    interactive: true,
    hint: 'Included, but not published on this channel yet',
  },
  excluded: {
    // No counterpart, and none invented: this state paints no status colour, so there is no
    // colour decision to delegate. `neutral` here only tells a caller "nothing semantic".
    tone: 'neutral',
    from: null,
    label: 'Excluded',
    dot: 'none',
    muted: true,
    interactive: true,
    hint: 'Left out of this channel’s listing — tick to include it',
  },
  'not-set-up': {
    tone: readinessMeta('absent', 'scope').tone,
    from: 'scope:absent',
    label: 'Not set up',
    dot: 'none',
    muted: true,
    interactive: false,
    hint: 'This channel is not set up for this product — connect it before including variants',
  },
  'needs-value': {
    tone: readinessMeta('missing', 'row').tone,
    from: 'row:missing',
    label: 'Needs a value',
    dot: 'solid',
    muted: false,
    interactive: true,
    hint: 'A value this channel requires is missing or invalid — publishing would be refused',
  },
  /**
   * VT.4 / VX D9 — the SIXTH word. The row is INCLUDED and every value it needs is there; what is
   * missing is on the coordinate: the axes this channel receives cannot tell this variant apart from
   * another included one (`CollisionReport`, `docs/vt1-contracts.md` §3.5).
   *
   * Why it is a member and not `needs-value` reused: the NEXT CLICK differs. A missing value is fixed
   * in the cell; a collision is fixed in the mapping dock's Collisions section, by choosing a resolver
   * for the whole coordinate. Two states whose remedy is in two different places cannot share one word
   * without the word lying about where to go.
   *
   * The tone is READ from `readinessMeta('missing', 'row')` — the same row-warning tone `needs-value`
   * reads, and recorded in `from` like every other member, because the SEVERITY is the same (this
   * coordinate cannot be published) even though the remedy is not. No colour is chosen here.
   * `interactive: true`: excluding the variant IS one of the three resolvers, so the checkbox must work.
   */
  collides: {
    tone: readinessMeta('missing', 'row').tone,
    from: 'row:missing',
    label: 'Collides',
    dot: 'solid',
    muted: false,
    interactive: true,
    hint: 'Two included variants produce the same combination on this channel — choose a resolver in the mapping dock',
  },
  /**
   * MX.G / design §3.4 — the FOUR the Matrix adds, on the same rule as `collides`: each tone is READ
   * from `readinessMeta` and recorded in `from`, and each earns a member because its REMEDY is
   * somewhere the five original words do not point.
   *
   * They are not a Matrix-local vocabulary. The `Listing` cell is `ProjectionCell` on both the
   * Variants page and the Matrix (design §3.2's last line: "one cell definition on both states"), so
   * a word that existed only on one of them would be the fork this file was written to prevent. The
   * Variants page never produces these four today — its projection read has no channel-side episode
   * — and a state it does not produce costs it nothing.
   *
   * 🔴 `not buyable` (the 386 Amazon `DISCOVERABLE` rows, design Appendix C) is deliberately NOT a
   * tenth word: Amazon's own meaning is "listed, and not winning the buy box", which is `listed`
   * plus a DETAIL. `ListingCell.detail` carries it (contract §3.6), and inventing a word for it
   * would have split `Listed` in two for a fact that is not a state.
   */
  suppressed: {
    /* An Amazon suppression episode: the listing exists and the channel is refusing to show it. The
       row cannot sell — the same severity `errors` carries, which is why the tone is read from it. */
    tone: readinessMeta('errors', 'row').tone,
    from: 'row:errors',
    label: 'Suppressed',
    dot: 'solid',
    muted: false,
    interactive: true,
    hint: 'The channel is suppressing this listing — the reason is on Needs attention',
  },
  closed: {
    /* `offerClosedAt` (SCT.6). Nothing is wrong and nothing is live: exactly `unlisted`'s meaning,
       and the same neutral a `draft` reads. A DIFFERENT word from `Draft` because the remedy is a
       different control — Sync Control reopens an offer; publishing promotes a draft. */
    tone: readinessMeta('unlisted', 'row').tone,
    from: 'row:unlisted',
    label: 'Closed',
    dot: 'hollow',
    muted: true,
    interactive: true,
    hint: 'The offer is closed on this market — reopen it in Sync Control',
  },
  error: {
    tone: readinessMeta('errors', 'row').tone,
    from: 'row:errors',
    label: 'Error',
    dot: 'solid',
    muted: false,
    interactive: true,
    hint: 'The channel refused this listing — the reason is on Needs attention',
  },
  ended: {
    /* `listingStatus: ENDED` — an eBay item that ran out or was ended. Over, not broken. */
    tone: readinessMeta('unlisted', 'row').tone,
    from: 'row:unlisted',
    label: 'Ended',
    dot: 'hollow',
    muted: true,
    interactive: true,
    hint: 'This listing has ended on the channel — relist it to sell again',
  },
}

/* `Object.hasOwn` is ES2022 and this workspace compiles against ES2020 (apps/web/tsconfig.json
   `lib`), so the check is spelled the long way rather than failing to compile. */
const hasOwn = (key: string) => Object.prototype.hasOwnProperty.call(PROJECTION, key)

/**
 * The tone, word and presentation of one projection state.
 *
 * An unknown state is a contract change, and a cell that rendered it as "Listed" would be lying.
 * It is named instead — neutral, verbatim, no dot, held — the same refusal `readinessMeta` makes.
 */
export function projectionMeta(state: ProjectionState): ProjectionMeta
export function projectionMeta(state: string): ProjectionMeta
export function projectionMeta(state: string): ProjectionMeta {
  // `hasOwn`, not `in` and not a truthiness test on the lookup: both answer YES for `toString`
  // and hand back `Object.prototype`'s function as if it were a meta. A wire value reaches here.
  const hit = hasOwn(state) ? (PROJECTION as Record<string, ProjectionMeta>)[state] : undefined
  if (hit) return hit
  return {
    tone: 'neutral',
    from: null,
    label: String(state),
    dot: 'none',
    muted: true,
    interactive: false,
    hint: `Unrecognised projection state “${state}”`,
  }
}

/** Every projection state, in the order §3.3 lists them — for a legend or a filter's options. */
export const PROJECTION_STATES = Object.keys(PROJECTION) as ProjectionState[]

/** Whether a wire value is one of ours. A read boundary should parse, not cast. */
export function isProjectionState(value: unknown): value is ProjectionState {
  return typeof value === 'string' && hasOwn(value)
}
