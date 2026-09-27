'use client'

import type { ChannelMediaLayout } from '@nexus/shared/media-plan-channels'

import { DataGrid, SourceIndicator, type Column } from '@/design-system/components'
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

/** Every destination in one table: where each set's photos come from, what it would receive, its checks (PLAN.md §5.1). */
export function DestinationsTable({ read, destinations, layouts, selected, onOpen }: DestinationsTableProps) {
  const columns: Array<Column<MediaDestinationRow>> = [
    { key: 'destination', label: 'Destination', render: d => <span className={styles.destination}>
      <Button size="xs" variant="link" onClick={() => onOpen(d.key)} aria-current={selected === d.key || undefined} disabled={!d.targetable}>{destinationLabel(d)}</Button>
      <span className={styles.muted}>
        {d.channel === 'AMAZON' ? `${d.markets.join(' ')} · one photo set per ASIN` : d.api === 'INVENTORY' ? 'Inventory API' : d.api === 'TRADING' ? 'Trading API' : d.markets.join(' ')}
      </span>
      {d.refusal && <span className={styles.refusal}>{d.refusal}</span>}
    </span> },
    { key: 'sets', label: 'Photo sets', render: d => !d.targetable ? '—' : <span className={styles.cells}>
      {destinationCells(read, d).map(cell => <span key={cell.ref} className={styles.cell}>
        <SourceIndicator kind={SOURCE[cell.source].kind} label={`${cell.label}: ${SOURCE[cell.source].text}`} description={`${cell.count} photo${cell.count === 1 ? '' : 's'}.`} tabIndex={-1} />
        {cell.label} {cell.count}
      </span>)}
    </span> },
    { key: 'sends', label: 'Would send', render: d => layouts[d.key] ? layoutSummary(d.channel, layouts[d.key]) : '—' },
    { key: 'checks', label: 'Checks', render: d => {
      const layout = layouts[d.key]
      if (!layout) return '—'
      const { errors, warnings } = checkCounts(layout.checks)
      return <Button size="xs" variant="ghost" onClick={() => onOpen(d.key)} aria-label={`Checks for ${destinationLabel(d)}: ${errors.length} to fix, ${warnings.length} warnings`}>
        {errors.length ? <Tag tone="danger">{errors.length} to fix</Tag> : null}
        {warnings.length ? <Tag tone="warning">{warnings.length} warning{warnings.length > 1 ? 's' : ''}</Tag> : null}
        {!errors.length && !warnings.length ? <Tag tone="success">Ready</Tag> : null}
      </Button>
    } },
    { key: 'variants', label: 'Variants', numeric: true, render: d => `${d.productIds.filter(id => read.family.variants.some(v => v.productId === id)).length} of ${read.family.variants.length}` },
  ]
  return <DataGrid ariaLabel="Where the photos go" columns={columns} rows={destinations} rowKey={d => d.key}
    rowProps={d => ({ 'aria-selected': selected === d.key || undefined, className: selected === d.key ? styles.selectedRow : undefined })}
    emptyState={<span className={styles.muted}>This product has no listing here yet.</span>} />
}

