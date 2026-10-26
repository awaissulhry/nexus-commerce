import type { ComponentType, CSSProperties, ReactNode } from 'react'
import NextLink from 'next/link'
import { ChevronRight } from 'lucide-react'
import { metricKind, metricMinWidth } from './metricStripModel'

interface MetricBase {
  label: ReactNode
  value: ReactNode
  /** optional change indicator */
  delta?: { value: ReactNode; positive?: boolean }
  /**
   * Descriptive sub-line under the value — what the number counts ("live & selling", "no
   * available units"). NOT a delta: `delta` is a movement and is coloured up/down, this is a
   * definition and is muted. A tile whose number needs explaining had nowhere to put it, so
   * every strip that needed one was hand-rolled instead of using this component.
   */
  hint?: ReactNode
  /**
   * Colour for a small leading dot on the label — the tile's status key.
   *
   * A raw colour rather than a tone name on purpose: callers key these off their own status
   * tokens (`--nds-success`, `--nds-danger`), and a fixed tone list cannot express "this tile is
   * the primary one".
   */
  accent?: string
}

interface MetricFilter {
  /**
   * Makes the tile a real `<button>`. Metric tiles are very often filters — click "Out of stock"
   * to see the out-of-stock rows — and there was no way to say so, so pages wrapped a `<div>` in
   * `role="button"` + `tabIndex` + a hand-written `onKeyDown` and still shipped no pressed state.
   */
  onClick?: () => void
  /** Engaged — renders the tile selected and emits `aria-pressed`. Requires `onClick`. */
  active?: boolean
  href?: never
}

interface MetricLinkTile {
  /**
   * Makes the tile a real link to another page (Reviews parts, 2026-10-26): "New reviews" opens the Inbox. A link
   * opens, a button filters — a tile is one or the other, so `href` with `onClick` (or `active`) is a type error.
   */
  href: string
  onClick?: never
  active?: never
}

export type Metric = MetricBase & (MetricFilter | MetricLinkTile)

/** The host's link for link tiles. The web app passes its workspace `Link` (it keeps `/w/<id>`); default Next's `Link`. */
export type MetricLinkComponent = ComponentType<{ href: string; className?: string; children?: ReactNode }>

export interface MetricStripProps {
  metrics: Metric[]
  className?: string
  /** The link a tile with `href` renders. Default Next's `Link`. */
  linkAs?: MetricLinkComponent
  /** The narrowest a tile gets before the strip wraps, px (default 150). Phones always show two per row. */
  minTileWidth?: number
}

/** Row of KPI tiles (H10 metric strip). Auto-fits to the container width; two per row on a phone. */
export function MetricStrip({ metrics, className, linkAs, minTileWidth }: MetricStripProps) {
  const Link = linkAs ?? NextLink
  const style = minTileWidth != null ? ({ '--nds-metrics-min': `${metricMinWidth(minTileWidth)}px` } as CSSProperties) : undefined
  return (
    <div className={`nds-metrics${className ? ` ${className}` : ''}`} style={style}>
      {metrics.map((m, i) => {
        const body = (
          <>
            <div className="lbl">
              {m.accent != null && <span className="dot" style={{ background: m.accent }} />}
              {m.label}
              {m.href != null && <ChevronRight className="nds-metric-go" size={14} aria-hidden focusable={false} />}
            </div>
            {/* The number and what follows it share the strip's second row (`.nds-metric-body`, components.css), so a
                row of tiles keeps its numbers on one line whatever label wraps. */}
            <div className="nds-metric-body">
              <div className="val">{m.value}</div>
              {m.delta != null && <div className={`dlt ${m.delta.positive ? 'up' : 'down'}`}>{m.delta.value}</div>}
              {m.hint != null && <div className="hint">{m.hint}</div>}
            </div>
          </>
        )
        // A tile that does something is a button, with the keyboard and the pressed state that
        // come with one for free. A tile that does not stays a div — a focus stop that leads
        // nowhere is worse than no focus stop. A tile that opens a page is a link.
        const kind = metricKind(m)
        if (kind === 'link' && m.href != null) {
          return (
            <Link key={i} href={m.href} className="nds-metric link">
              {body}
            </Link>
          )
        }
        return kind === 'button' && m.onClick ? (
          <button
            key={i}
            type="button"
            className={`nds-metric btn${m.active ? ' active' : ''}`}
            aria-pressed={m.active ?? false}
            onClick={m.onClick}
          >
            {body}
          </button>
        ) : (
          <div key={i} className="nds-metric">
            {body}
          </div>
        )
      })}
    </div>
  )
}
