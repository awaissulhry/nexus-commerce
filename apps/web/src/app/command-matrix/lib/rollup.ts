// Pure functions for computing parent (master) status rollups from
// child (variant) rows. All logic is client-side so rollups stay
// reactive to in-progress edits before they're saved.

import type { CatalogNode, SyncStatus } from './types'

// Status precedence: ERROR beats OVERRIDE beats UNLISTED beats SYNCED.
const STATUS_RANK: Record<SyncStatus, number> = {
  ERROR: 3,
  OVERRIDE: 2,
  UNLISTED: 1,
  SYNCED: 0,
}

export function worstStatus(statuses: SyncStatus[]): SyncStatus {
  if (statuses.length === 0) return 'UNLISTED'
  return statuses.reduce<SyncStatus>(
    (worst, s) => (STATUS_RANK[s] > STATUS_RANK[worst] ? s : worst),
    'SYNCED',
  )
}

export type ChannelKey = 'amazonDe' | 'ebayUk' | 'shopify'

export interface RolledUpChannel {
  status: SyncStatus
  /** How many variants are at a worse status than SYNCED. 0 = all good. */
  badCount: number
}

/**
 * Roll up a single channel column across all variant subRows.
 * The parent's own channel status is merged in too.
 */
export function rollupChannel(
  master: CatalogNode,
  channelKey: ChannelKey,
): RolledUpChannel {
  const masterStatus = master.channels[channelKey]
  const variantStatuses: SyncStatus[] = (master.subRows ?? []).map(
    (v) => v.channels[channelKey],
  )
  const allStatuses = [masterStatus, ...variantStatuses]
  const worst = worstStatus(allStatuses)
  const badCount = allStatuses.filter((s) => STATUS_RANK[s] > 0).length
  return { status: worst, badCount }
}

/**
 * Locale completion thresholds → indicator tone.
 */
export function localeTone(pct: number): 'success' | 'warning' | 'danger' {
  if (pct >= 100) return 'success'
  if (pct >= 50) return 'warning'
  return 'danger'
}

/**
 * Does a master pass the given view filter?
 * Variant rows are always shown when their parent passes.
 */
export function matchesView(
  node: CatalogNode,
  viewId: string,
): boolean {
  if (viewId === 'global') return true
  if (viewId === 'translation-gaps') {
    if (!node.locales) return true // variants follow their parent
    return Object.values(node.locales).some((pct) => pct < 100)
  }
  if (viewId === 'sync-errors') {
    const channels = Object.values(node.channels) as SyncStatus[]
    if (channels.some((s) => s === 'ERROR')) return true
    // Also show masters that have variant errors
    if (node.isMaster && node.subRows) {
      return node.subRows.some((v) =>
        (Object.values(v.channels) as SyncStatus[]).some((s) => s === 'ERROR'),
      )
    }
    return false
  }
  if (viewId === 'unlisted-variants') {
    if (!node.isMaster) return false
    return (node.subRows ?? []).some((v) =>
      (Object.values(v.channels) as SyncStatus[]).some((s) => s === 'UNLISTED'),
    )
  }
  return true
}
