'use client'

/**
 * GDS / VT.2 — the `Variation theme` cell: ONE renderer, every scope.
 *
 * The column (`key: 'variation_theme'`, `kind: 'variationTheme'`, `shape: 'axes'`) is served by
 * `GET /studio/sheet` on master AND on every channel coordinate, and its VALUE is a
 * `VariationThemeCell` object — never a string (`docs/vt1-contracts.md` §1). So the cell has to draw
 * a projection, not format a scalar, and it has to do it identically on both sheets.
 *
 * ## What is deliberately NOT here
 *
 * 🔴 **No new provenance member and no local colour map.** The four states the canvas draws
 * (artboard 5) are the DS's existing ones: `derived`/`rule` → `inherited` (🔗 + the info 6% tint),
 * `override` → `pinned` (✎ + the primary 7% tint), master → `own` (no mark at all). The mapping is
 * `variationThemeProvenance()` below: it turns the wire's `source.kind` into the `ProvenanceLike`
 * facts `classifyProvenance()` already reads, and the tint arrives through the
 * `provenanceClassRules` both builders already spread. Nothing about the look of this cell is
 * written twice (`feedback_shared_components_no_copy_props`, ruling #11's anti-fork directive).
 *
 * 🔴 **No composed sentences.** `source.label`, `locked.reason`, `collisions.summary` and
 * `unbound.reason` are server-stated (contract §1.1) — the same rule `describeCellSource()` follows
 * for every other cell. The renderer picks which of them to show; it never writes one.
 *
 * 🔴 **Master draws no mark even though `source.kind` is `derived`** (contract §1.2 + design §3.4):
 * master IS the structure, so "inherited" would be a claim about a layer above that does not exist.
 * That is why `variationThemeProvenance()` takes the scope and why the scope is read from the WIRE
 * (`masterCandidates !== null`) rather than passed in by each builder — two builders passing a
 * scope flag is exactly the shape `reference_two_column_builders_drift` describes.
 */
import { memo } from 'react'
import { AlertTriangle, Lock } from 'lucide-react'
import type { ICellRendererParams } from 'ag-grid-community'

import { Tag } from '../../primitives'
import { composeCellTooltip } from './cellTooltip'
import { classifyProvenance, type CellProvenance, type ProvenanceLike } from './provenance'
import { ProvenanceMark } from './provenanceMark'

/* ── the wire contract, mirrored ──────────────────────────────────────────────────────────── */

/**
 * 🔴 Mirrored by hand and deliberately WIDER than the producer, for the reason
 * `_studio/sheet/master/types.ts` records at length: a consumer may be wider than its producer and
 * must never be narrower. Every optional here is optional because an older server omits it, and
 * absence is UNKNOWN rather than a default this file invents.
 *
 * Source of truth: `docs/vt1-contracts.md` §1 (FINAL, VT.1). Fixtures: `docs/fixtures/vt1/fixtures.ts`.
 */
export interface VariationThemeAxis {
  axisKey: string
  familyKey: string
  label: string
  /** What the channel DELIVERS. This — never `label` — is what the cell prints (§1.4). */
  channelName: string
  target: string | null
  included: boolean
  segment?: string
  /** Set when this axis binds to nothing on this coordinate. Rendered in warning tone. */
  unbound?: { reason: string } | null
}

export interface VariationThemeCell {
  axes: VariationThemeAxis[]
  theme: { code: string; label: string; deprecated: boolean } | null
  source: {
    kind: 'derived' | 'rule' | 'override' | 'none'
    ruleLabel: string | null
    category: string | null
    /** Verbatim, server-stated (§1.1). The cell NEVER composes this. */
    label: string
    tieBreak?: 'bare-form' | 'only-match' | 'only-live' | 'set-order' | 'kept-from-listing'
  }
  candidates: {
    kind: 'theme-enum' | 'aspects' | 'free'
    items: Array<{ code: string; label: string; coversAll: boolean; drops: string[]; deprecated: boolean; required?: boolean }>
    limit: number | null
    schemaFetchedAt: string | null
    /**
     * 🔴 FOUR-way, and `ok` is only ever sent with a NON-EMPTY list. `unavailable` = we COULD NOT LOOK;
     * `no-theme` (R-VT-7) = we looked and this Amazon product type declares no variation theme, so there is
     * nothing to offer. An empty list that reads as "none exist" is the defect all four words exist for.
     */
    state: 'ok' | 'freeform' | 'unavailable' | 'no-theme'
    unavailableReason?: string
  } | null
  /** MASTER ONLY, and the scope discriminator this file reads — see `isMasterProjection`. */
  masterCandidates: Array<{ key: string; label: string; axisKey: string; valueCount: number }> | null
  dropped: string[]
  collisions: { unresolved: number; summary: string } | null
  locked: {
    reason: string
    externalId: string | null
    setChangeIs: 'relist' | 'new-parent' | 'in-place'
    orderChangeAllowed: boolean
    /**
     * VT.2c — the axes this coordinate has ALREADY PUBLISHED, so each of them keeps its row and
     * loses only its target control, with `reason` on the element the operator hovers (spec §4.4.4).
     *
     * VT.F item A5: BOTH producers serve it now. It was optional while only the projection read did
     * (`family-projection.service.ts`, from the parent listing's `__lastPublishedAxes`), so the sheet
     * cell rendered the unlocked arm on a coordinate the dock showed as partly frozen — two answers to
     * "may I move this axis" for one live listing. `lockedAxisKeysFrom()` is now the one function both
     * call. It stays OPTIONAL in the TYPE so an older server's payload still parses, and a missing value
     * is read as `[]` at exactly one place (`axisLockReason`), never as "nothing is locked" by accident.
     */
    lockedAxisKeys?: string[]
  } | null
  /**
   * VT.2c — the PRESENTATION order's writability on this coordinate, when the server states it.
   *
   * Separate from `locked` on purpose, because the two answer different questions and the dock
   * measured both: `locked` is "this coordinate has published", `order.writableHere` is "this
   * endpoint can write the order at all" (`docs/vp2-contracts.md` §4.1 — eBay's presentation order
   * keeps its own editor and its own CAS pair, so the projection PATCH does not touch it). An
   * unlocked coordinate can still refuse a reorder, which a lock flag alone cannot express.
   */
  order?: { writableHere: boolean; reason: string }
  /**
   * VT.2c — the FAMILY axes this coordinate may still add, when the producer states them.
   *
   * `+ Add a <noun>` adds an AXIS, not a channel target: an aspect added as an axis produces an
   * `axisKey` the family does not have, and the projection PATCH would refuse it (measured by VT.4:
   * the dock's own add list is the family axes minus the mapped ones, and it is empty on every
   * coordinate of this catalogue because the server lists every family axis in `mapping`). Absent
   * on the sheet cell, whose producer does not serve it — REQUEST TO VT.1.
   */
  addableAxes?: Array<{ axisKey: string; familyKey: string; label: string }>
  /**
   * VT.2c — the coordinate's own names, SERVER-STATED, for the sentences that name it.
   *
   * The sheet cell carries its coordinate inside `write`, and every sentence read it from there. A
   * host whose write is NOT this panel's has nowhere to put them: the Variants dock owns its own
   * `Save mapping`, so its adapter sets `write: null` on purpose — and every aria sentence then read
   * `The This coordinate specific for Color`, measured in this file's own suite before the field
   * existed. `channel` is the channel's word (`eBay`), `scope` the composed coordinate (`eBay · IT`).
   */
  coordinateNames?: { channel: string; scope: string }
  write: {
    endpoint: 'variation-axes' | 'projection'
    expectedVersion: number
    aliasKey: string
    coordinate: { channel: string | null; market: string; accountId: string | null }
    childIds?: string[]
  } | null
  deliveryNote?: string
  writable: boolean
  writeBlockedReason: string | null
  vocabulary: { axisNoun: string; axisNounPlural: string; sectionTitle: string }
  separator: string
  /**
   * EDITOR-ONLY, never on the wire: the operator pressed `Reset to rule`, so the commit is
   * `{ expectedVersion, reset: true }` ALONE (contract §3.3 — combining it with `theme` or `mapping`
   * is a `400 bad_projection_request`). It rides on the reported value because the reported value is
   * the only thing AG hands the write path, and a parallel channel for one boolean is how an
   * intent gets lost between two hosts.
   */
  resetRequested?: boolean
  /**
   * EDITOR-ONLY, never on the wire: the cell AS THE SERVER SERVED IT, captured when the editor
   * opened.
   *
   * 🔴 It has to travel on the reported value, because by commit time the BEFORE is gone. AG's
   * `valueSetter` replaces `row.values[key]` in place (it must — `reference_ag_value_setter_must_
   * mutate_params_data`), and on the master sheet the grid row IS the object the sheet payload
   * holds, so a commit that read "the row's current value" as the baseline would compare the edited
   * cell with itself, compute `kind: 'none'`, and send nothing at all. Measured exactly that way on
   * `VX-TEST-3AX`: a witnessed reorder gesture, the editor's own footer reading `order`, Enter
   * pressed — and zero requests on the wire.
   *
   * Nothing serialises it: `variationThemeWrite` derives a BODY from these facts and never sends the
   * cell object, so the baseline cannot reach a route.
   */
  baseline?: VariationThemeCell
}

/* ── pure decisions (node-testable: this module is imported, never rendered, by the suite) ──── */

/** The CHILD-row reason, verbatim (Appendix A · contract §1.3). */
export const VARIATION_THEME_CHILD_REASON = 'Set on the parent'

/**
 * Is this projection the MASTER's?
 *
 * 🔴 Read from ONE wire fact rather than a per-builder flag. Contract §1.2: master serves
 * `candidates: null` with `masterCandidates` filled; every channel coordinate serves
 * `masterCandidates: null`. `write.endpoint === 'variation-axes'` is the same fact from the write
 * side and is used only as the fallback for a row that carries no candidates at all, because a
 * coordinate with no listing serves `write: null` and must not silently read as master.
 */
export function isMasterProjection(cell: VariationThemeCell): boolean {
  if (cell.masterCandidates !== null && cell.masterCandidates !== undefined) return true
  return cell.write?.endpoint === 'variation-axes'
}

export type VariationThemeState = 'child' | 'unset' | 'delivered'

/**
 * Which of the design §3.4 states this cell is in.
 *
 * `unset` covers BOTH empty sentences — master's `Set axes…` and Amazon's `Choose a theme` — because
 * they are one state wearing two server-stated labels, not two states. What separates them on
 * screen is the TONE (`variationThemeUnsetTone`), and that follows a fact, not a guess.
 */
export function variationThemeState(cell: VariationThemeCell | null | undefined): VariationThemeState {
  if (!cell) return 'child'
  if (cell.source.kind === 'none' || cell.axes.length === 0) return 'unset'
  return 'delivered'
}

/**
 * `warning` or `muted` for the `unset` state.
 *
 * Design §3.4 / canvas artboard 5: master's `Set axes…` is muted while the family is empty and turns
 * `⚠ required` **once the family has children** — the children are the reason the structure matters.
 * `write.childIds` is where the wire states them (contract §1.2 relays them because the
 * `variation-axes` validator requires them back), so the tone follows a measured count and not an
 * assumption. On a channel coordinate `Choose a theme` is always a warning: readiness raises
 * `theme-unset` as an ERROR there (contract §4), so a muted cell would understate a blocking fact.
 */
export function variationThemeUnsetTone(cell: VariationThemeCell): 'warning' | 'muted' {
  if (!isMasterProjection(cell)) return 'warning'
  return (cell.write?.childIds?.length ?? 0) > 0 ? 'warning' : 'muted'
}

/**
 * Copy, export and filter text — contract §1.4, stated there so both hosts agree.
 *
 * INCLUDED axes only, `channelName` (never `label`), joined with the coordinate's own separator:
 * `Color · Size` on master and eBay, `Farbe / Größe` on Amazon·DE. A child row is the em dash the
 * grid uses everywhere else; a family with no axes is `''`, because the cell is showing a SENTENCE
 * (`source.label`) at that point and exporting that sentence as a value would put prose in a CSV
 * column of names.
 */
export function variationThemeText(cell: VariationThemeCell | null | undefined): string {
  if (!cell) return '—'
  return cell.axes
    .filter((a) => a.included)
    .map((a) => a.channelName)
    .join(cell.separator)
}

/**
 * The wire's `source.kind` as the facts `classifyProvenance()` reads — NOT a provenance member.
 *
 * 🔴 This function exists so that there is no second classifier. It answers in the DS's own
 * vocabulary (`layer`, `inherited`, `pinned`) and hands the verdict to the one classifier the
 * master sheet, the channel sheet and the drawer already share (ruling #11).
 *
 * | scope   | `source.kind`        | facts                                  | member      |
 * |---------|----------------------|----------------------------------------|-------------|
 * | master  | any                  | `layer: 'master'`, nothing inherited   | `own`       |
 * | channel | `derived` \| `rule`  | `layer: 'master'`, `inherited: true`   | `inherited` |
 * | channel | `override`           | `layer: 'channel'`, `pinned: true`     | `pinned`    |
 * | channel | `none`               | `layer: 'master'`, nothing inherited   | `own`       |
 *
 * **`rule` draws 🔗 and not Σ, and that is the canvas's word, not an oversight.** Σ (`mapped`) is the
 * DS member for "computed by a rule", and its whole justification is that the next click lands on a
 * different surface. Here it does not: design §3.4 and canvas artboard 5 both draw the link glyph
 * for `derived` AND for `rule` ("Same mark; tooltip 'Follows rule Apparel default'"), because the
 * editor this cell opens can override the rule ON THIS COORDINATE — the click lands here either
 * way. The rule is named in the tooltip, which §9.6b calls the right home for a secondary fact.
 * Recorded as `ASSUMED:` in the ledger with the doc lines that decide it.
 */
export function variationThemeProvenance(cell: VariationThemeCell): ProvenanceLike {
  if (isMasterProjection(cell)) return { layer: 'master', inherited: false, pinned: false }
  switch (cell.source.kind) {
    case 'override':
      return { layer: 'channel', inherited: false, pinned: true }
    case 'derived':
    case 'rule':
      return { layer: 'master', inherited: true }
    case 'none':
    default:
      return { layer: 'master', inherited: false, pinned: false }
  }
}

/** The member, through the ONE classifier. Exported so the gate and the tests read what the cell reads. */
export function variationThemeProvenanceMember(cell: VariationThemeCell): CellProvenance {
  return classifyProvenance(variationThemeProvenance(cell), isMasterProjection(cell) ? 'master' : 'channel')
}

/**
 * The cell's ONE tooltip. Every line is server-stated; the order is what most changes the next action.
 *
 * Amazon·DE reads `COLOR/SIZE` then `Derived from the family axes` — design §3.4's own example. The
 * enum CODE leads because it is the fact the printed label cannot carry (two enum spellings share
 * one label on this product type — `COLOR/SIZE` and `COLOR_NAME/SIZE_NAME` are both `Farbe / Größe`,
 * measured by VT.0), so a tooltip without it cannot tell an operator which theme is live.
 */
export function variationThemeTooltip(cell: VariationThemeCell | null | undefined): string {
  if (!cell) return VARIATION_THEME_CHILD_REASON
  return composeCellTooltip(
    cell.theme?.code,
    cell.source.label,
    cell.source.kind === 'rule' && cell.source.category ? cell.source.category : undefined,
    cell.dropped.length > 0 ? `${cell.dropped.length} dropped on this channel` : undefined,
    cell.collisions?.summary,
    cell.locked?.reason,
    ...cell.axes.filter((a) => a.unbound).map((a) => a.unbound!.reason),
    cell.writable ? undefined : cell.writeBlockedReason ?? undefined,
  )
}

/* ── the cell ─────────────────────────────────────────────────────────────────────────────── */

export interface VariationThemeValueParams {
  /** Set by the host when the row is a CHILD, so the `—` carries its reason without a value. */
  childReason?: string
}

/**
 * The cell. `.nds-cell-value` + `.nds-cell-value-text` are the ENGINE's own wrappers (grid.css:843)
 * — the same two master's `withMark` uses — so the mark sits on the value's line and the names
 * truncate before anything trailing moves (#707's measured defect). The trailing pieces are
 * SIBLINGS of the text for exactly that reason.
 */
export const VariationThemeValue = memo(function VariationThemeValue(
  p: ICellRendererParams & VariationThemeValueParams,
) {
  const cell = (p.value ?? null) as VariationThemeCell | null

  /* A child row: structure is the parent's. The em dash is the grid's, and it says why. */
  if (!cell) {
    return (
      <span className="nds-cell-value nds-axes-cell">
        <span className="nds-cell-empty" title={p.childReason ?? VARIATION_THEME_CHILD_REASON} aria-label={p.childReason ?? VARIATION_THEME_CHILD_REASON}>
          —
        </span>
      </span>
    )
  }

  const state = variationThemeState(cell)
  const member = variationThemeProvenanceMember(cell)
  const tooltip = variationThemeTooltip(cell)

  if (state === 'unset') {
    const tone = variationThemeUnsetTone(cell)
    return (
      <span className="nds-cell-value nds-axes-cell">
        {/* R-VT-16 — the DS 12x12 SVG, never the `⚠` GLYPH this used to print. A glyph is a FONT's
            drawing: its shape, weight, baseline and colour support vary by platform, it does not
            take `strokeWidth`, and it sat beside a real `Lock size={12}` SVG two elements away, so
            one cell drew its two marks two different ways. Same icon set, same size and stroke as
            that Lock — and the same one `Banner`, `CoverageSummary` and `MediaCellView` already use
            for a warning. */}
        {tone === 'warning' && (
          <span className="nds-axes-warn" aria-hidden>
            <AlertTriangle size={12} strokeWidth={2} />
          </span>
        )}
        <span className={`nds-cell-value-text ${tone === 'warning' ? 'nds-axes-unset-required' : 'nds-axes-unset'}`}>
          {cell.source.label}
        </span>
      </span>
    )
  }

  const shown = cell.axes.filter((a) => a.included)
  return (
    <span className="nds-cell-value nds-axes-cell">
      {/* `from` is the server's sentence — the mark's tooltip is the reason and nothing else (#780). */}
      <ProvenanceMark provenance={member} tooltip={tooltip} from={cell.source.label} />
      <span className="nds-cell-value-text">
        {shown.map((a, i) => (
          <span key={a.axisKey}>
            {i > 0 && <span className="nds-axes-sep">{cell.separator}</span>}
            {/* An unbound axis is NOT delivered, whatever `included` says — the warning tone is the
                only thing on screen that separates "we will send this name" from "we found nothing
                to send it as" (contract §1, `unbound`). */}
            <span className={a.unbound ? 'nds-axes-name nds-axes-name-unbound' : 'nds-axes-name'} title={a.unbound?.reason}>
              {a.channelName}
            </span>
          </span>
        ))}
      </span>
      {cell.dropped.length > 0 && (
        <span className="nds-axes-trail">
          <Tag tone="warning">{`${cell.dropped.length} dropped`}</Tag>
        </span>
      )}
      {cell.locked && (
        <span className="nds-axes-lock" aria-label={cell.locked.reason} title={cell.locked.reason}>
          <Lock size={12} strokeWidth={2} aria-hidden />
        </span>
      )}
    </span>
  )
})
