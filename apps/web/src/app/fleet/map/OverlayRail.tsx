'use client'

/**
 * NAF.SB.M.4 — the left rail: what the canvas is coloured by, and what the
 * colours mean.
 *
 * The legend is real DOM text, always visible, and every entry carries its
 * swatch AND its words. Not a hover tooltip: a legend is a control surface,
 * not a footnote, and a hover-only one is unreachable by keyboard, screen
 * reader and touch. The entity graph's existing legend puts its meanings in
 * `title` attributes, which is exactly that mistake, and this does not repeat
 * it.
 *
 * It carries NO counts. The census strip above the canvas owns every count of
 * the node population; a second set of numbers a few hundred pixels away is
 * how a summary and its rows drift apart.
 *
 * It does NOT restate the halt. A halt applies to all seven nodes identically,
 * so it is a sentence, not a colour, and it is already stated once in the
 * banner directly above.
 */

import type { KeyboardEvent } from 'react'

import type { MapNode } from './lib'
import { OVERLAYS, occupiedBucketIds, visibleBuckets, type Overlay } from './overlays'

const TIERS = ['analyst', 'director', 'critic', 'auditor']

/**
 * S3R — the ARIA radiogroup contract, actually implemented.
 *
 * Both control groups in this rail declared a pattern and shipped none of it.
 * `Colour by` announced `role="radiogroup"` with three `role="radio"` children
 * and gave all three `tabIndex 0` — three tab stops where the pattern specifies
 * one — with no key handler at all, so the arrow keys a screen reader promises
 * on "radio button, 1 of 3" were dead. `Show` had the opposite fault: five
 * mutually exclusive choices expressed as independent `aria-pressed` toggles,
 * which describes a multi-select that does not exist.
 *
 * In a radiogroup an arrow key moves focus AND selects — that is the pattern,
 * not a shortcut. The caller re-focuses because the DOM node that should hold
 * focus is the one that just became checked.
 */
function rovingKeys(
  e: KeyboardEvent<HTMLElement>,
  count: number,
  current: number,
  select: (i: number) => void,
) {
  const k = e.key
  if (!['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End'].includes(k)) return
  e.preventDefault()
  const next =
    k === 'Home'
      ? 0
      : k === 'End'
        ? count - 1
        : k === 'ArrowDown' || k === 'ArrowRight'
          ? (current + 1) % count
          : (current - 1 + count) % count
  select(next)
  const group = e.currentTarget
  const btns = group.querySelectorAll<HTMLButtonElement>('[role="radio"]')
  btns[next]?.focus()
}

export function OverlayRail({
  overlay,
  onOverlay,
  nodes,
  tierFilter,
  onTierFilter,
  hideDiagnostic,
  onHideDiagnostic,
}: {
  overlay: Overlay
  onOverlay: (id: string) => void
  nodes: MapNode[]
  tierFilter: string | null
  onTierFilter: (t: string | null) => void
  hideDiagnostic: boolean
  onHideDiagnostic: (v: boolean) => void
}) {
  const buckets = visibleBuckets(overlay, nodes)
  const occupied = occupiedBucketIds(overlay, nodes)
  const tiers = TIERS.filter((t) => nodes.some((n) => n.tier === t))
  const hasDiagnostic = nodes.some((n) => n.diagnostic)

  return (
    <aside className="sbm-orail" aria-label="Colour and filters">
      <div className="sbm-orail-sec">
        <h3>Colour by</h3>
        <div
          className="sbm-seg vertical"
          role="radiogroup"
          aria-label="Colour the map by"
          onKeyDown={(e) =>
            rovingKeys(
              e,
              OVERLAYS.length,
              OVERLAYS.findIndex((o) => o.id === overlay.id),
              (i) => onOverlay(OVERLAYS[i].id),
            )
          }
        >
          {OVERLAYS.map((o) => (
            <button
              key={o.id}
              type="button"
              role="radio"
              aria-checked={overlay.id === o.id}
              tabIndex={overlay.id === o.id ? 0 : -1}
              className={overlay.id === o.id ? 'on' : ''}
              onClick={() => onOverlay(o.id)}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>

      {/* S3R — the overlay's question heads the legend rather than trailing the
          picker. It is the one sentence that tells a first-time reader what the
          colour channel is FOR, and it was the faintest important text in the
          section (3.62:1) sitting under a generic "What the colours mean". A
          legend title should be the meaningful one. */}
      <div className="sbm-orail-sec is-legend">
        <h3 className="sbm-orail-q">{overlay.question}</h3>
        <ul className="sbm-legend">
          {buckets.map((b) => {
            const here = occupied.has(b.id)
            return (
              <li key={b.id} className={here ? '' : 'is-vacant'}>
                <span className={`sbm-swatch ${b.className}`} aria-hidden />
                <span className="txt">
                  <span className="lab">{b.label}</span>
                  {here && b.note ? <span className="note">{b.note}</span> : null}
                </span>
                {/* The rung keeps its colour and its words, and says it is
                    empty rather than being silently unexplained. Right-aligned
                    so the empties can be read down the column at a glance — on
                    a fleet where nothing may act, "May act on its own — none"
                    is the most reassuring line on the page. */}
                {here ? null : <span className="none">none</span>}
              </li>
            )
          })}
        </ul>
        {overlay.id === 'health' ? (
          <p className="sbm-orail-foot">
            This is about how a run <i>went</i> — not about whether a worker is allowed to run. A
            worker you switched off still shows how its last run finished.
          </p>
        ) : null}
      </div>

      {tiers.length > 1 || hasDiagnostic ? (
        <div className="sbm-orail-sec">
          <h3>Show</h3>
          {/* S3R — one radiogroup, not five toggles, because the choice is
              mutually exclusive. `every role` is the null option and belongs in
              the same group as the roles it clears.

              The per-chip `Def` tooltips are gone. They were 288px of content
              inside a 194px clipping box — the rail is `overflow` on both axes,
              so 94px of every one of them was unreachable — and they restated
              "The rest stay on the map, dimmed", which the block already ends
              with in permanent, readable text 40px below. A hover-only,
              keyboard-hostile, clipped restatement of a visible sentence is not
              worth repairing. */}
          <div
            className="sbm-orail-filters"
            role="radiogroup"
            aria-label="Show only one role"
            onKeyDown={(e) =>
              rovingKeys(
                e,
                tiers.length + 1,
                tierFilter === null ? 0 : tiers.indexOf(tierFilter) + 1,
                (i) => onTierFilter(i === 0 ? null : tiers[i - 1]),
              )
            }
          >
            <button
              type="button"
              role="radio"
              aria-checked={tierFilter === null}
              tabIndex={tierFilter === null ? 0 : -1}
              className={`sbm-chip ${tierFilter === null ? 'on' : ''}`}
              onClick={() => onTierFilter(null)}
            >
              every role
            </button>
            {tiers.map((t) => (
              <button
                key={t}
                type="button"
                role="radio"
                aria-checked={tierFilter === t}
                tabIndex={tierFilter === t ? 0 : -1}
                className={`sbm-chip ${tierFilter === t ? 'on' : ''}`}
                onClick={() => onTierFilter(tierFilter === t ? null : t)}
              >
                {t}
              </button>
            ))}
          </div>
          {hasDiagnostic ? (
            <label className="sbm-orail-check">
              <input
                type="checkbox"
                checked={hideDiagnostic}
                onChange={(e) => onHideDiagnostic(e.target.checked)}
              />
              Dim the self-test
            </label>
          ) : null}
          <p className="sbm-orail-foot">
            Filtering dims; it never removes. The map keeps its shape so you can still see where
            everything sits.
          </p>
        </div>
      ) : null}
    </aside>
  )
}
