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
 * ── Styling ─────────────────────────────────────────────────────────────────────────────────────
 * Every class here (`h10-mmbid`, `h10-editpop`, `h10-bulk-inp`, `h10-menu-back`, `h10-am-link`,
 * `h10-am-btn`) is already in `ads.css`, which `marketing/ads/layout.tsx` loads for the whole
 * sub-tree — verified in the deployed DOM from the Apply Rules page, where all six resolve. Moving
 * the components needed no CSS at all.
 */
import { useState } from 'react'

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
export function RangePopover({
  title, rangeLabel, minCents, maxCents, anchor, floorCents = MIN_CENTS, note, busy, error, onApply, onClose,
}: {
  title: string
  rangeLabel: string
  minCents: number | null
  maxCents: number | null
  anchor: PopAnchor
  /** the lowest either end may be, in cents. €0.02 on bids — the suppression floor. */
  floorCents?: number
  /** one line under the fields, for whatever the page needs to say about enforcement */
  note?: string
  busy?: boolean
  error?: string | null
  onApply: (mm: { minCents: number | null; maxCents: number | null } | null) => void
  onClose: () => void
}) {
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
      <div className="h10-mmbid" style={{ position: 'fixed', left: anchor.x, top: anchor.y }} role="dialog" aria-label={title}>
        <div className="h">{title}</div>
        <label className="r"><input type="radio" name="rangepop" checked={!range} onChange={() => setRange(false)} /> None</label>
        <label className="r"><input type="radio" name="rangepop" checked={range} onChange={() => setRange(true)} /> {rangeLabel}</label>
        {range && (
          <div className="mmrow">
            <span className="h10-bulk-inp"><span className="pf">€</span><input inputMode="decimal" placeholder="Min" value={min} onChange={(e) => setMin(e.target.value)} aria-label="Min" /></span>
            <span className="h10-bulk-inp"><span className="pf">€</span><input inputMode="decimal" placeholder="Max" value={max} onChange={(e) => setMax(e.target.value)} aria-label="Max" /></span>
          </div>
        )}
        {note && <p className="n">{note}</p>}
        {bad && <p className="e" role="alert">Each end must be at least €{(floorCents / 100).toFixed(2)}, and Min must not exceed Max.</p>}
        {error && <p className="e" role="alert">{error}</p>}
        <div className="f">
          <button type="button" className="h10-am-link" disabled={busy} onClick={onClose}>Cancel</button>
          <button
            type="button" className="h10-am-btn primary sm" disabled={busy || bad}
            onClick={() => onApply(range ? { minCents: minC, maxCents: maxC } : null)}
          >{busy ? 'Applying…' : 'Apply'}</button>
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
export function ValuePopover({
  title, prefix, suffix, initial, placeholder, anchor, note, busy, error, onApply, onClose,
}: {
  title: string
  prefix?: string
  suffix?: string
  /** '' when unset — never the fallback value */
  initial: string
  placeholder?: string
  anchor: PopAnchor
  note?: string
  busy?: boolean
  error?: string | null
  onApply: (v: string) => void
  onClose: () => void
}) {
  const [v, setV] = useState(initial)
  const bad = v.trim() !== '' && !Number.isFinite(Number(v))
  return (
    <>
      <button type="button" className="h10-menu-back" aria-label="Close" onClick={() => { if (!busy) onClose() }} />
      <div className="h10-editpop" style={{ position: 'fixed', left: anchor.x, top: anchor.y }} role="dialog" aria-label={title}>
        <div className="h">{title}</div>
        <span className={`h10-bulk-inp ${suffix ? 'sf' : ''}`}>
          {prefix && <span className="pf">{prefix}</span>}
          <input inputMode="decimal" value={v} placeholder={placeholder} onChange={(e) => setV(e.target.value)} aria-label={title} autoFocus />
          {suffix && <span className="sfx">{suffix}</span>}
        </span>
        {note && <p className="n">{note}</p>}
        {bad && <p className="e" role="alert">Enter a number.</p>}
        {error && <p className="e" role="alert">{error}</p>}
        <div className="f">
          <button type="button" className="h10-am-link" disabled={busy} onClick={onClose}>Cancel</button>
          <button type="button" className="h10-am-btn primary sm" disabled={busy || bad} onClick={() => onApply(v)}>{busy ? 'Applying…' : 'Apply'}</button>
        </div>
      </div>
    </>
  )
}
