'use client'

/**
 * THE editors behind the rule columns' hover pencil — **one anchored popover per kind**, used by
 * the Ad Manager grid and by Apply Rules.
 *
 * 🔴 **Operator instruction, 2026-08-19:** *"I said to make use of the same UI, like, for example,
 * the modal that appears when I click on the edit of the Min/Max/Bid column. It should be the same
 * as on the Ad Manager, and the same with others."*
 *
 * `RuleColumnCells.tsx` shares the READING; this file shares the EDITING. Before it, the same
 * field had two different editors: the Ad Manager opened Helium 10's small popover anchored under
 * the pencil ("Min/Max Bid" · None / Set a Range · Cancel / Apply), and Apply Rules opened a
 * full-screen modal with its own title, its own field labels and its own button verb ("Bid band —
 * <campaign>" · Floor / Ceiling · Cancel / Save band). Same endpoint, same campaign, two UIs.
 * H10's popover is the one that stays, because H10 is the reference this whole section is being
 * shaped to.
 *
 * ── What moving them here FIXED, not just unified ───────────────────────────────────────────────
 * · 🔴 `ValuePopover` for Target ACoS was passed `((c.targetAcos ?? 0.3) * 100)`, pre-filling
 *   **30.00** on a campaign with no target — measured 2026-08-19, that is ALL 220. It is the editor
 *   half of the fabricated 30% removed from the display cell the same day: open the pencil, press
 *   Apply without typing, and you have written a target nobody chose. The caller now passes `''`
 *   when the field is unset, and the placeholder carries the fallback, where a fallback belongs.
 * · `RangePopover` now takes **CENTS** (`minCents`/`maxCents`) — the unit
 *   `PATCH /campaigns/:id/guardrails` actually takes. It used to take a euro pair the Ad Manager
 *   derived client-side at fetch time into `Camp.minMaxBid`; that derived field existed only to
 *   feed this popover and its cell, both of which now read the cents directly, so it is gone.
 *   ⚠ This is a simplification, NOT a bug fix — the euro path was correct, and an earlier note in
 *   this programme wrongly attributed Apply Rules' dead-`minMaxBid`-key defect to the Ad Manager.
 *
 * ── Validation is shared too, and that is a change for the Ad Manager ────────────────────────────
 * Apply Rules' modal refused a bound below **€0.02** (the suppression floor — a €0.00 floor is not
 * a floor) and refused floor > ceiling. The Ad Manager's popover validated nothing. The rule now
 * lives in the popover, so both pages enforce it. See `reference_ads_suppression_by_low_bid`.
 *
 * ── 🔴 Give every mount a `key` ─────────────────────────────────────────────────────────────────
 * Both popovers seed `useState` from their props, so React reusing the instance across two
 * different rows would show the FIRST row's values while writing to the SECOND. Today the
 * full-screen `h10-menu-back` backdrop makes that unreachable by hand (it swallows the click that
 * would open another row's pencil), which is exactly the kind of accident that stops being true
 * later. Every call site passes `key={`${id}:${kind}`}` so the instance is thrown away instead.
 *
 * ── 🔴 No copy props. The description belongs to the component ──────────────────────────────────
 * The first version of this file took a `note` prop, and the two pages promptly passed different
 * sentences — which is how the operator noticed the editors "are not really any shared components".
 * A prop that lets one caller reword the dialog is a fork with extra steps. The copy below is the
 * copy, everywhere. If a page needs to say something else, that is a signal the CONTROL differs,
 * and the answer is a new component, not a string.
 *
 * ── Styling ─────────────────────────────────────────────────────────────────────────────────────
 * Every class here (`h10-mmbid`, `h10-editpop`, `h10-bulk-inp`, `h10-menu-back`, the DS `nds-btn link`,
 * `h10-am-btn`) is already in `ads.css`, which `marketing/ads/layout.tsx` loads for the whole
 * sub-tree — verified in the deployed DOM from the Apply Rules page, where all six resolve. Moving
 * the components needed no CSS at all.
 */
import { useLayoutEffect, useRef, useState } from 'react'
import { Button } from '@/design-system/primitives'

/** Both popovers are positioned from the pencil's own bounding rect, in fixed coordinates. */
export interface PopAnchor { x: number; y: number }

/**
 * Opens the anchor for a pencil click. Kept here so every caller anchors the popover the same way
 * — under the CELL, not under the 11px icon, which is what H10 does and what the Ad Manager
 * already did by walking up to the enclosing `<td>`.
 */
export function anchorFromEvent(ev: React.MouseEvent<HTMLElement>): PopAnchor {
  const el = ev.currentTarget
  const td = el.closest('td')
  const r = (td ?? el).getBoundingClientRect()
  return { x: r.left, y: r.bottom + 4 }
}

/**
 * 🔴 Keeps the popover ON SCREEN. Anchoring alone is not placement.
 *
 * Both popovers are `position: fixed` at the cell's bottom-left corner, and the card is taller than
 * a grid row. Measured on prod 2026-08-19, opening the Min/Max Bid editor on a row in the lower
 * half of the page put the card's bottom at **~1055 in a 962px viewport**. The flip fixes that, and
 * the deployed page confirms it fires (`flippedUp: true` on the row that used to overflow).
 *
 * ⚠ **Correction to this file's own first version, and to the U11c.1 commit message.** Both also
 * claimed a HORIZONTAL clip — "x=1440 in a 1459px viewport, 233px of a 252px card cut off". That
 * was wrong: 1459 was the width of a *screenshot*, which the capture scales down; the real viewport
 * was **1728** (`devicePixelRatio` 2), and the card ended at 1692, comfortably inside. The x clamp
 * below is therefore DEFENSIVE — the column really does sit at the far right of both grids, so a
 * narrower window would clip it — not a fix for anything that was measured. Read viewport geometry
 * from `document.documentElement.clientWidth`, never from a screenshot's pixel dimensions.
 *
 * It renders at the anchor first and corrects after measuring, rather than guessing from the CSS
 * width: the card's height depends on which radio is selected and whether a note or an error is
 * showing, so a hard-coded number would be wrong the moment the copy changes.
 */
function useClampedAnchor(anchor: PopAnchor) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState(anchor)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const M = 8
    const { width, height } = el.getBoundingClientRect()
    const vw = document.documentElement.clientWidth
    const vh = document.documentElement.clientHeight
    const x = Math.max(M, Math.min(anchor.x, vw - width - M))
    // Flip above the cell when there is no room below — `anchor.y` is already the cell's bottom,
    // so the flip target is that bottom minus the row height and the card.
    const y = anchor.y + height + M > vh ? Math.max(M, anchor.y - height - 34) : anchor.y
    setPos({ x, y })
  }, [anchor.x, anchor.y])
  return { ref, pos }
}

const MIN_CENTS = 2

/**
 * H10's range popover — **None / Set a Range**. Used for Min/Max Bid and Min/Max Budget.
 *
 * Values in and out are **CENTS**, because that is what both endpoints take
 * (`PATCH /campaigns/:id/guardrails { minBidCents, maxBidCents }`) and what both grids hold. The
 * euro strings exist only inside the two inputs.
 *
 * `onApply(null)` means the operator chose **None**: clear both ends. A blank input inside "Set a
 * Range" clears only that end — that is not the same thing, and the copy says so.
 */
/** The `kind` picks the title, the radio label and the description — all of them, together. */
const RANGE_COPY = {
  bid: {
    title: 'Min/Max Bid',
    rangeLabel: 'Set a Min/Max Bid Range',
    note: 'Enforced at the write gate on every bid write to this campaign: outside the band a write is DENIED and recorded, never clamped. A bid already outside it stays put until something tries to move it.',
    floorCents: MIN_CENTS,
  },
  budget: {
    title: 'Min/Max Budget',
    rangeLabel: 'Set a Min/Max Budget Range',
    // 🔴 ADM-H P1 — the old note said "Read by Budget Manager when it paces this campaign",
    // which understated it in the one direction that matters: these bounds are enforced at the
    // WRITE GATE, so they bind every rule, the pacer and any manual edit, not one consumer that
    // chooses to look. "Local only" stays because it is true — Amazon has no such field — but on
    // its own it read as "this does nothing yet", which is what the Ad Manager's editor actually
    // did before this unit.
    note: 'Enforced at the write gate on every budget write to this campaign: outside the band a write is DENIED and recorded, never clamped. Amazon has no min/max budget field — this is our own bound, and it binds rules, the pacer and manual edits alike.',
    // Amazon's own hard floor is €1 and the server refuses anything below 100 cents, so a 0
    // floor here let the editor offer a value the endpoint would reject.
    floorCents: 100,
  },
} as const

export function RangePopover({
  kind, minCents, maxCents, anchor, busy, error, onApply, onClose,
}: {
  kind: keyof typeof RANGE_COPY
  minCents: number | null
  maxCents: number | null
  anchor: PopAnchor
  busy?: boolean
  error?: string | null
  onApply: (mm: { minCents: number | null; maxCents: number | null } | null) => void
  onClose: () => void
}) {
  const { title, rangeLabel, note, floorCents } = RANGE_COPY[kind]
  const { ref, pos } = useClampedAnchor(anchor)
  const eur = (c: number | null) => (c == null ? '' : (c / 100).toFixed(2))
  const [range, setRange] = useState(minCents != null || maxCents != null)
  const [min, setMin] = useState(eur(minCents))
  const [max, setMax] = useState(eur(maxCents))

  const toCents = (s: string) => (s.trim() === '' ? null : Math.round(Number(s) * 100))
  const minC = toCents(min)
  const maxC = toCents(max)
  const bad = range && (
    (minC != null && (!Number.isFinite(minC) || minC < floorCents))
    || (maxC != null && (!Number.isFinite(maxC) || maxC < floorCents))
    || (minC != null && maxC != null && minC > maxC)
  )

  return (
    <>
      <button type="button" className="h10-menu-back" aria-label="Close" onClick={() => { if (!busy) onClose() }} />
      <div ref={ref} className="h10-mmbid" style={{ position: 'fixed', left: pos.x, top: pos.y }} role="dialog" aria-label={title}>
        <div className="h">{title}</div>
        <label className="r"><input type="radio" name="rangepop" checked={!range} onChange={() => setRange(false)} /> None</label>
        <label className="r"><input type="radio" name="rangepop" checked={range} onChange={() => setRange(true)} /> {rangeLabel}</label>
        {range && (
          <div className="mmrow">
            <span className="h10-bulk-inp"><span className="pf">€</span><input inputMode="decimal" placeholder="Min" value={min} onChange={(e) => setMin(e.target.value)} aria-label="Min" /></span>
            <span className="h10-bulk-inp"><span className="pf">€</span><input inputMode="decimal" placeholder="Max" value={max} onChange={(e) => setMax(e.target.value)} aria-label="Max" /></span>
          </div>
        )}
        <p className="n">{note}</p>
        {bad && <p className="e" role="alert">Each end must be at least €{(floorCents / 100).toFixed(2)}, and Min must not exceed Max.</p>}
        {error && <p className="e" role="alert">{error}</p>}
        <div className="f">
          <Button variant="link" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button
 variant="primary" size="sm" disabled={busy || bad}
 onClick={() => onApply(range ? { minCents: minC, maxCents: maxC } : null)}
 >{busy ? 'Applying…' : 'Apply'}</Button>
        </div>
      </div>
    </>
  )
}

/**
 * H10's single-value popover (Target ACoS %, Daily Budget €), opened from the hover pencil.
 *
 * 🔴 `initial` must be `''` when the field is genuinely unset. It used to be pre-filled with the
 * engine's 30% fallback, which made "press Apply without typing" write a target nobody chose.
 * `placeholder` is where a fallback belongs.
 */
const VALUE_COPY = {
  targetAcos: {
    title: 'Target ACoS', prefix: undefined as string | undefined, suffix: '%', placeholder: 'unset',
    note: 'Leave blank and the optimiser uses its own 30% fallback — a fallback is not a setting, which is why the column reads a dash rather than 30%.',
  },
  dailyBudget: {
    title: 'Daily Budget', prefix: '€', suffix: undefined as string | undefined, placeholder: '',
    note: 'Amazon resets spend at midnight in the campaign\'s own marketplace timezone.',
  },
} as const

export function ValuePopover({
  kind, initial, anchor, busy, error, onApply, onClose,
}: {
  kind: keyof typeof VALUE_COPY
  /** '' when unset — never the fallback value */
  initial: string
  anchor: PopAnchor
  busy?: boolean
  error?: string | null
  onApply: (v: string) => void
  onClose: () => void
}) {
  const { title, prefix, suffix, placeholder, note } = VALUE_COPY[kind]
  const { ref, pos } = useClampedAnchor(anchor)
  const [v, setV] = useState(initial)
  const bad = v.trim() !== '' && !Number.isFinite(Number(v))
  return (
    <>
      <button type="button" className="h10-menu-back" aria-label="Close" onClick={() => { if (!busy) onClose() }} />
      <div ref={ref} className="h10-editpop" style={{ position: 'fixed', left: pos.x, top: pos.y }} role="dialog" aria-label={title}>
        <div className="h">{title}</div>
        <span className={`h10-bulk-inp ${suffix ? 'sf' : ''}`}>
          {prefix && <span className="pf">{prefix}</span>}
          <input inputMode="decimal" value={v} placeholder={placeholder} onChange={(e) => setV(e.target.value)} aria-label={title} autoFocus />
          {suffix && <span className="sfx">{suffix}</span>}
        </span>
        <p className="n">{note}</p>
        {bad && <p className="e" role="alert">Enter a number.</p>}
        {error && <p className="e" role="alert">{error}</p>}
        <div className="f">
          <Button variant="link" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="sm" disabled={busy || bad} onClick={() => onApply(v)}>{busy ? 'Applying…' : 'Apply'}</Button>
        </div>
      </div>
    </>
  )
}
