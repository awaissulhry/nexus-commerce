'use client'

import type { ChannelMediaLayout } from '@nexus/shared/media-plan-channels'

import { Card, SourceIndicator } from '@/design-system/components'
import { DataGrid, type Column } from '@/design-system/grid/datagrid'
import { Button, Tag } from '@/design-system/primitives'

import { checkCounts, destinationCells, destinationLabel, layoutSummary, type MediaDestinationRow, type MediaRead } from './model'
import styles from './planPage.module.css'

export interface DestinationsTableProps {
  read: MediaRead
  destinations: MediaDestinationRow[]
  layouts: Record<string, ChannelMediaLayout>
  selected: string | null
  onOpen(key: string): void
}

const SOURCE = {
  shared: { kind: 'master' as const, text: 'follows Shared' },
  channel: { kind: 'channel' as const, text: 'follows the channel' },
  own: { kind: 'override' as const, text: 'own photos' },
  none: { kind: 'missing' as const, text: 'not set' },
}

/** Every destination in one table — or, on a phone, one card each: where each set's photos come from, what it would
 *  receive, its checks (PLAN.md §5.1, §5.2). The same pieces render both, so the two layouts cannot say different things. */
export function DestinationsTable({ read, destinations, layouts, selected, onOpen, cards = false }: DestinationsTableProps & { cards?: boolean }) {
  const where = (d: MediaDestinationRow) => d.channel === 'AMAZON' ? `${d.markets.join(' ')} · one photo set per ASIN` : d.api === 'INVENTORY' ? 'Inventory API' : d.api === 'TRADING' ? 'Trading API' : d.markets.join(' ')
  const title = (d: MediaDestinationRow) => <Button size="xs" variant="link" onClick={() => onOpen(d.key)} aria-current={selected === d.key || undefined} disabled={!d.targetable}>{destinationLabel(d)}</Button>
  const notes = (d: MediaDestinationRow) => <>
    {d.targetable && !d.accountActive && <Tag tone="warning">Account paused — reconnect it before publishing</Tag>}
    {d.refusal && <span className={styles.refusal}>{d.refusal}</span>}
  </>
  const sets = (d: MediaDestinationRow) => !d.targetable ? '—' : <span className={styles.cells}>
    {destinationCells(read, d).map(cell => <span key={cell.ref} className={styles.cell}>
      <SourceIndicator kind={SOURCE[cell.source].kind} label={`${cell.label}: ${SOURCE[cell.source].text}`} description={`${cell.count} photo${cell.count === 1 ? '' : 's'}.`} tabIndex={-1} />
      {cell.label} {cell.count}
    </span>)}
  </span>
  const sends = (d: MediaDestinationRow) => layouts[d.key] ? layoutSummary(d.channel, layouts[d.key]) : '—'
  const checks = (d: MediaDestinationRow) => {
    const layout = layouts[d.key]
    if (!layout) return '—'
    const { errors, warnings } = checkCounts(layout.checks)
    return <Button size="xs" variant="ghost" onClick={() => onOpen(d.key)} aria-label={`Checks for ${destinationLabel(d)}: ${errors.length} to fix, ${warnings.length} warnings`}>
      {errors.length ? <Tag tone="danger">{errors.length} to fix</Tag> : null}
      {warnings.length ? <Tag tone="warning">{warnings.length} warning{warnings.length > 1 ? 's' : ''}</Tag> : null}
      {!errors.length && !warnings.length ? <Tag tone="success">Ready</Tag> : null}
    </Button>
  }
  const variants = (d: MediaDestinationRow) => `${d.productIds.filter(id => read.family.variants.some(v => v.productId === id)).length} of ${read.family.variants.length}`

  if (cards) return destinations.length ? <ul className={styles.destinationCards} aria-label="Where the photos go">
    {destinations.map(d => <li key={d.key}>
      <Card header={title(d)} description={where(d)} headingLevel={4} className={selected === d.key ? styles.selectedCard : undefined}>
        <div className={styles.cardBody}>
          {checks(d)}
          {notes(d)}
          {sets(d)}
          <span className={styles.muted}>Would send: {sends(d)} · Variants {variants(d)}</span>
        </div>
      </Card>
    </li>)}
  </ul> : <p className={styles.muted}>This product has no listing here yet.</p>

  const columns: Array<Column<MediaDestinationRow>> = [
    { key: 'destination', label: 'Destination', render: d => <span className={styles.destination}>{title(d)}<span className={styles.muted}>{where(d)}</span>{notes(d)}</span> },
    { key: 'sets', label: 'Photo sets', render: sets },
    { key: 'sends', label: 'Would send', render: sends },
    { key: 'checks', label: 'Checks', render: checks },
    { key: 'variants', label: 'Variants', numeric: true, render: variants },
  ]
  return <DataGrid ariaLabel="Where the photos go" columns={columns} rows={destinations} rowKey={d => d.key}
    rowProps={d => ({ 'aria-selected': selected === d.key || undefined, className: selected === d.key ? 'sel' : undefined })}
    emptyState={<span className={styles.muted}>This product has no listing here yet.</span>} />
}
