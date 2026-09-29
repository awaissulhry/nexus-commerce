'use client'

import type { ChannelMediaLayout, MediaAsset } from '@nexus/shared/media-plan-channels'

import { Banner } from '@/design-system/components'
import { Button, Tag } from '@/design-system/primitives'

import { BuyerPreview } from './BuyerPreview'
import { DestinationName } from './destinationName'
import { amazonOwnMarkets, checkCounts, destinationCells, destinationLabel, layoutSummary, type MediaDestinationRow, type MediaRead } from './model'
import styles from './planPage.module.css'

export interface SidePanelProps {
  read: MediaRead
  /** The destination the scope selector points at; null on the Shared product. */
  destination: MediaDestinationRow | null
  layouts: Record<string, ChannelMediaLayout>
  /** "Only DE" on Amazon: the market the page shows alone, and its layout (what its ZIP holds). */
  market?: { code: string; layout: ChannelMediaLayout } | null
  assets: Map<string, MediaAsset>
  /** Point the scope selector at a destination (the Shared product's list). */
  onOpenDestination(d: MediaDestinationRow): void
}

/**
 * The Media page's side panel (redesign 2026-09-29): what the buyers of the chosen destination see and its checks — or,
 * on the Shared product, every destination with its state, one click from its own photos.
 */
export function SidePanel({ read, destination: d, layouts, market = null, assets, onOpenDestination }: SidePanelProps) {
  const url = (id: string) => assets.get(id)?.url ?? null
  const name = (id: string) => assets.get(id)?.label ?? 'Photo'
  if (!d) return <aside className={styles.side} aria-labelledby="media-side-title">
    <h3 id="media-side-title" className={styles.sectionTitle}>Where the photos go</h3>
    {read.destinations.length ? <ul className={styles.destinationList}>
      {read.destinations.map(x => {
        const layout = layouts[x.key]
        const own = x.targetable ? destinationCells(read, x).filter(c => c.source === 'own' || c.source === 'channel').map(c => c.label) : []
        const markets = x.targetable ? amazonOwnMarkets(read, x) : []
        return <li key={x.key} className={styles.destinationItem}>
          <Button size="xs" variant="link" onClick={() => onOpenDestination(x)} aria-label={`Open the photos of ${destinationLabel(x)}`}><DestinationName d={x} /></Button>
          <span className={styles.destinationState}>
            <Status layout={layout} />
            <span className={styles.muted}>{!x.targetable ? x.refusal : own.length ? `Own photos: ${own.join(', ')}` : 'Shows the Shared photos'}</span>
          </span>
          {markets.length > 0 && <span className={styles.muted}>{markets.map(m => `Amazon ${m}`).join(', ')}: own photos, sent only by {markets.length === 1 ? 'its' : 'each market\'s'} ZIP</span>}
          {x.targetable && !x.accountActive && <Tag tone="warning">Account paused — reconnect it before publishing</Tag>}
        </li>
      })}
    </ul> : <p className={styles.muted}>This product has no listing yet.</p>}
  </aside>

  const layout = market?.layout ?? layouts[d.key]
  const { errors, warnings } = checkCounts(layout?.checks ?? [])
  return <aside className={styles.side} aria-labelledby="media-side-title">
    <h3 id="media-side-title" className={styles.sectionTitle}>{market ? `Buyer preview · Amazon ${market.code}` : 'Buyer preview'}</h3>
    {d.targetable && !d.accountActive && <Tag tone="warning">Account paused — reconnect it before publishing</Tag>}
    {layout && <p className={styles.muted}>{market ? `Amazon ${market.code} shows (with its ZIP uploaded)` : 'Would send'}: {layoutSummary(d.channel, layout)}</p>}
    <BuyerPreview read={read} destination={d} layout={layout} url={url} name={name} />
    <h3 className={styles.sectionTitle}>Checks</h3>
    {errors.length === 0 && warnings.length === 0 ? <p className={styles.muted}>No problems. Publishing is a separate step.</p> : <>
      {errors.length > 0 && <Banner tone="danger" title={market ? `${errors.length} to fix in the photos of Amazon ${market.code}` : `${errors.length} to fix before this destination can be published`}><ul className={styles.checkList}>{errors.map(c => <li key={c.message}>{c.message}</li>)}</ul></Banner>}
      {warnings.length > 0 && <Banner tone="warning" title={`${warnings.length} warning${warnings.length > 1 ? 's' : ''}`}><ul className={styles.checkList}>{warnings.map(c => <li key={c.message}>{c.message}</li>)}</ul></Banner>}
    </>}
  </aside>
}

function Status({ layout }: { layout: ChannelMediaLayout | undefined }) {
  if (!layout) return <Tag tone="neutral">Not sent</Tag>
  const { errors, warnings } = checkCounts(layout.checks)
  if (errors.length) return <Tag tone="danger">{errors.length} to fix</Tag>
  if (warnings.length) return <Tag tone="warning">{warnings.length} warning{warnings.length > 1 ? 's' : ''}</Tag>
  return <Tag tone="success">Ready</Tag>
}
