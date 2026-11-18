'use client'

import { MetricStrip, type Metric } from '@nexus/ui/components'
import { useT } from '../../../../../lib/i18n/provider'
import { STRIP_GROUPS, tileOf, tilesShown, type StripTile, type TileRead, type WorkCan, type WorkReads } from '../use-customer-work'
import './customer-work.css'

/** Where a tile leads: a view of the Work tab's own sheet, a real link, or a centred window (F-SA-278). */
export interface StripDoors {
  /** Requests to answer → Waiting on us; Late → Late; Waiting for deposit → its view. */
  readonly onView?: (view: 'waitingUs' | 'late' | 'deposit') => void
  /** Replies waiting on us: their list (until the dock's All of <customer> view, F-SA-279). */
  readonly repliesHref?: string | null
  /** Waiting for <customer> and Open tasks: their centred windows (F-SA-278); absent: the tile is a number only. */
  readonly onWindow?: (window: 'customer' | 'tasks') => void
  readonly onRetry?: (tile: StripTile) => void
}

/**
 * F-SA-276 (sales page plan N5, picks R5, P10; 11-customer-page §3.2; picture 21 pin 3): the Work tab's waiting strip — what needs
 * someone, in two labelled groups (Waiting on us · Waiting on <customer>; the label says it, never the colour alone) and the open
 * tasks beside them, each tile a door. While reading "—" (never 0); a read that failed: only that tile says so, and a click reads it
 * again; a tile the reader has no right to read is left out (no empty "0" tile); 0 is an answer. Every count is one customer's, from
 * a walled API read (use-customer-work.ts). Not a banner (the page's one notice place stays the record's).
 */
export function WaitingStrip({ customer, reads, can, doors }: { customer: string; reads: WorkReads; can: WorkCan; doors: StripDoors }) {
  const t = useT('parties')
  const shown = tilesShown(can)
  const metricOf = (tile: StripTile): Metric => {
    const read = tileOf(tile, reads)
    const label = t(`customers.work.tile.${tile}`, { customer })
    if (read.status === 'failed') return { label, value: '—', hint: t('customers.work.tile.failed'), ...(doors.onRetry ? { onClick: () => doors.onRetry?.(tile) } : {}) }
    const value = valueOf(read)
    const door = doorOf(tile, doors)
    return { label, value, ...door }
  }
  const groups = (Object.entries(STRIP_GROUPS) as Array<[keyof typeof STRIP_GROUPS, readonly StripTile[]]>).map(([group, tiles]) => ({ group, tiles: tiles.filter((tile) => shown.includes(tile)) })).filter((entry) => entry.tiles.length > 0)
  if (groups.length === 0) return null
  return (
    <div className="fw-cw-strip" role="group" aria-label={t('customers.work.strip.label')}>
      {groups.map(({ group, tiles }) => (
        <section key={group} className={group === 'us' ? 'fw-cw-group fw-cw-grow' : 'fw-cw-group'} aria-labelledby={`fw-cw-g-${group}`}>
          <span className="fw-cw-glabel" id={`fw-cw-g-${group}`}>
            {t(`customers.work.strip.${group}`, { customer })}
          </span>
          <MetricStrip metrics={tiles.map(metricOf)} minTileWidth={136} />
        </section>
      ))}
    </div>
  )
}

/** "—" while reading, the count, "100+" past a capped read. */
export const valueOf = (read: TileRead): string => (read.status === 'ready' ? `${read.count}${read.more ? '+' : ''}` : '—')

function doorOf(tile: StripTile, doors: StripDoors): { onClick: () => void } | { href: string } | Record<string, never> {
  if (tile === 'requests' && doors.onView) return { onClick: () => doors.onView?.('waitingUs') }
  if (tile === 'late' && doors.onView) return { onClick: () => doors.onView?.('late') }
  if (tile === 'deposit' && doors.onView) return { onClick: () => doors.onView?.('deposit') }
  if (tile === 'replies' && doors.repliesHref) return { href: doors.repliesHref }
  if ((tile === 'customer' || tile === 'tasks') && doors.onWindow) return { onClick: () => doors.onWindow?.(tile) }
  return {}
}
