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

import { Def } from './definitions'
import type { MapNode } from './lib'
import { OVERLAYS, visibleBuckets, type Overlay } from './overlays'

const TIERS = ['analyst', 'director', 'critic', 'auditor']

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
  const tiers = TIERS.filter((t) => nodes.some((n) => n.tier === t))
  const hasDiagnostic = nodes.some((n) => n.diagnostic)

  return (
    <aside className="sbm-orail" aria-label="Colour and filters">
      <div className="sbm-orail-sec">
        <h3>Colour by</h3>
        <div className="sbm-seg vertical" role="radiogroup" aria-label="Colour the map by">
          {OVERLAYS.map((o) => (
            <button
              key={o.id}
              type="button"
              role="radio"
              aria-checked={overlay.id === o.id}
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
      <div className="sbm-orail-sec">
        <h3 className="sbm-orail-q">{overlay.question}</h3>
        <ul className="sbm-legend">
          {buckets.map((b) => (
            <li key={b.id}>
              <span className={`sbm-swatch ${b.className}`} aria-hidden />
              <span className="txt">
                <span className="lab">{b.label}</span>
                {b.note ? <span className="note">{b.note}</span> : null}
              </span>
            </li>
          ))}
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
          <div className="sbm-orail-filters">
            <button
              type="button"
              className={`sbm-chip ${tierFilter === null ? 'on' : ''}`}
              aria-pressed={tierFilter === null}
              onClick={() => onTierFilter(null)}
            >
              every role
            </button>
            {tiers.map((t) => (
              <Def key={t} k={`tier-${t}`} note={`Show only the ${t}s. The rest stay on the map, dimmed.`}>
                {(described) => (
                  <button
                    type="button"
                    className={`sbm-chip ${tierFilter === t ? 'on' : ''}`}
                    aria-pressed={tierFilter === t}
                    onClick={() => onTierFilter(tierFilter === t ? null : t)}
                    {...described}
                  >
                    {t}
                  </button>
                )}
              </Def>
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
