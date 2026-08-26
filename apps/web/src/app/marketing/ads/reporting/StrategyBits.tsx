'use client'

/**
 * RPX — the pieces every strategy tab shares.
 *
 * The provenance strip is the point of the redesign as much as any chart. Each tab reads a
 * different feed at a different grain with a different lag, and a figure whose source and
 * as-of date are not on screen is a figure you have to take on trust. The strip carries the
 * feed, the grain, what we hold, and the per-market freshness — the last of which is the thing
 * no competitor ships and the thing that surfaced Italy running eight days behind Germany.
 */
import type { ReactNode } from 'react'
import { Info, RefreshCw } from 'lucide-react'
import { Pill } from '@/design-system/primitives/Pill'
import { Button } from '@/design-system/primitives/Button'

export interface ProvenanceMarket {
  marketplace: string
  lagDays: number | null
  /** Late FOR ITS OWN CADENCE — a 11-day-old weekly feed is healthy, a 3-day-old daily one is not. */
  late?: boolean
}

export function ProvenanceStrip({
  source, grain, held, markets, extra,
}: {
  source: string
  grain: string
  held: ReactNode
  markets: ProvenanceMarket[]
  extra?: ReactNode
}) {
  return (
    <div className="rpx-prov">
      <span className="k">Source</span><span className="v">{source}</span>
      <span className="sep" aria-hidden />
      <span className="k">Grain</span><span className="v">{grain}</span>
      <span className="sep" aria-hidden />
      <span className="k">Held</span><span className="v">{held}</span>
      {extra ? (<><span className="sep" aria-hidden />{extra}</>) : null}
      {markets.length > 0 && (
        <span className="rpx-prov-fresh">
          <span className="k">Freshness</span>
          {markets.map((m) => (
            <Pill key={m.marketplace} tone={m.late ? 'warning' : 'neutral'}>
              {m.marketplace} {m.lagDays == null ? '—' : m.lagDays <= 0 ? 'today' : `${m.lagDays}d`}
            </Pill>
          ))}
        </span>
      )}
    </div>
  )
}

/** A figure with its label and a line of context underneath. Never a bare number. */
export function StatCard({
  label, value, sub, tone, wide,
}: {
  label: string
  value: ReactNode
  sub?: ReactNode
  tone?: 'default' | 'warn' | 'good'
  wide?: boolean
}) {
  return (
    <div className={`rpx-stat${tone && tone !== 'default' ? ` is-${tone}` : ''}${wide ? ' is-wide' : ''}`}>
      <div className="lbl">{label}</div>
      <div className="val">{value}</div>
      {sub ? <div className="sub">{sub}</div> : null}
    </div>
  )
}

/**
 * The standing caveats for a tab.
 *
 * Rendered as a list rather than folded into a tooltip on purpose: these are the conditions
 * under which the numbers above are true, and a reader who has not seen them has not seen the
 * numbers. They come from the server beside the SQL that produced the figures, so they cannot
 * drift from what was actually measured.
 */
export function Caveats({ items, title = 'How to read this' }: { items: string[]; title?: string }) {
  if (!items.length) return null
  return (
    <div className="rpx-caveats">
      <div className="hd"><Info size={14} aria-hidden /> {title}</div>
      <ul>{items.map((c) => <li key={c}>{c}</li>)}</ul>
    </div>
  )
}

/** A block that states, in the product, what a feed cannot answer and what was measured. */
export function BlockedNote({
  title, tone = 'warn', children,
}: {
  title: string
  tone?: 'warn' | 'danger' | 'neutral'
  children: ReactNode
}) {
  return (
    <div className={`rpx-blocked is-${tone}`}>
      <div className="t">{title}</div>
      <p>{children}</p>
    </div>
  )
}

/** Loading and error states, identical on every tab so one never looks more broken than another. */
export function TabState({ loading, error, onRetry }: { loading: boolean; error: string | null; onRetry: () => void }) {
  if (error) {
    return (
      <div className="rpt-lede is-error" role="alert">
        <span><b>Could not load this tab.</b> {error}.{' '}
          <Button size="sm" onClick={onRetry}><RefreshCw size={12} aria-hidden /> Retry</Button>
        </span>
      </div>
    )
  }
  if (loading) return <div className="rpx-loading" role="status">Loading…</div>
  return null
}
