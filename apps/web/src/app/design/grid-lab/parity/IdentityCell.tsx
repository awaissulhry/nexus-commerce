'use client'

/**
 * AGL — the cells the fixture hands to BOTH engines.
 *
 * The identity cell is the console's `CampaignNameCell` anatomy, class for class: `.nmw` holding the
 * pacing `.bulb`, the `.tg` targeting letter, the `.pb` product chip, the `.t` name, the `.mk` market
 * chip and the hover-revealed `.h10-open` pill. The hover cards are left out on purpose — they are a
 * portal, not part of the cell's box — and the Open pill is inert here (the lab navigates nowhere),
 * but its markup and classes are exactly what `workspace-grid.css` keys on, which is what the probe
 * measures. Design §2.6: cells keep the consumers' markup; an engine that changes any of these boxes
 * has changed the console.
 *
 * Every renderer is a module-level function so its identity is stable across renders (GDS decision 12
 * — nothing handed to a grid may be a fresh object per render).
 */
import type { MouseEvent, ReactNode } from 'react'
import { Lightbulb, ExternalLink, Pause, Play } from 'lucide-react'
import { Pill, Button } from '@/design-system/primitives'
import type { ParityRow, Status } from './fixture'

const inert = (e: MouseEvent) => { e.preventDefault(); e.stopPropagation() }
const stop = (e: MouseEvent) => { e.stopPropagation() }

/** The console's first column, verbatim. */
export function renderIdentity(r: ParityRow): ReactNode {
  return (
    <div className="nmw">
      <span className="bulb"><Lightbulb size={12} aria-hidden /></span>
      <span className="tg" data-t={r.targeting}>{r.targeting}</span>
      <span className="pb" data-p={r.product}>{r.product}</span>
      <span className="t" title={r.name}>{r.name}</span>
      <span className="mk">{r.market}</span>
      <a className="h10-open" href={`#${r.id}`} onClick={inert} title={`Open ${r.name} in the Ad Manager`}>
        <ExternalLink size={11} aria-hidden /> Open
      </a>
    </div>
  )
}

const STATUS_TONE: Record<Status, 'success' | 'warning' | 'neutral'> = { ENABLED: 'success', PAUSED: 'warning', ARCHIVED: 'neutral' }
const STATUS_LABEL: Record<Status, string> = { ENABLED: 'Enabled', PAUSED: 'Paused', ARCHIVED: 'Archived' }

export function renderStatus(s: Status): ReactNode {
  return <Pill tone={STATUS_TONE[s]} dot>{STATUS_LABEL[s]}</Pill>
}

export function renderMarketPill(m: string): ReactNode {
  return <span className="mk">{m}</span>
}

/** The decision verbs the console pins right: a ghost pause/enable per row. Inert in the lab. */
export function renderVerbs(r: ParityRow): ReactNode {
  const paused = r.status !== 'ENABLED'
  return (
    <Button size="sm" variant="ghost" onClick={stop} aria-label={paused ? `Enable ${r.name}` : `Pause ${r.name}`}>
      {paused ? <Play size={12} aria-hidden /> : <Pause size={12} aria-hidden />} {paused ? 'Enable' : 'Pause'}
    </Button>
  )
}

/** The DataGrid's identity: name + market, no chips (the `.nds-grid` look has no `.nmw` rules). */
export function renderNameOnly(r: ParityRow, asPanel = false): ReactNode {
  if (asPanel) {
    return (
      <div style={{ padding: '10px 14px', display: 'grid', gap: 4 }}>
        <b>{r.name}</b>
        <span style={{ color: 'var(--nds-text-2)' }}>{r.market} · {r.product} · {r.targeting === 'A' ? 'Auto' : 'Manual'} targeting · {r.orders} orders</span>
      </div>
    )
  }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
      <span className="t" title={r.name} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 200 }}>{r.name}</span>
      <span className="mk">{r.market}</span>
    </span>
  )
}
