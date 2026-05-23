// PB.9 — Browser-side publish-snapshot storage.
//
// Captures the resolved per-channel ListingImage state at the moment
// a publish succeeds, so the operator can "Revert to last published"
// later. Persists in localStorage keyed by (productId, channel,
// marketplace) — per-browser-session, not server-authoritative.
//
// PB.9b (queued) will add server-side snapshots via a new
// ImagePublishSnapshot model so rollbacks survive cache clears.

import type { ListingImage } from './types'

export type SnapshotChannel = 'AMAZON' | 'EBAY' | 'SHOPIFY'

export interface SnapshotRow {
  /** ListingImage.id at capture time. May be missing on rollback
   *  apply if the row was deleted; we fall back to (variantGroupKey,
   *  variantGroupValue, amazonSlot, position) for matching. */
  id: string
  url: string
  variantGroupKey: string | null
  variantGroupValue: string | null
  amazonSlot: string | null
  position: number
  role: string
}

export interface Snapshot {
  productId: string
  channel: SnapshotChannel
  marketplace: string | null
  capturedAt: string
  rows: SnapshotRow[]
}

const STORAGE_PREFIX = 'nexus.images.publishSnapshot'

function storageKey(productId: string, channel: SnapshotChannel, marketplace: string | null): string {
  return `${STORAGE_PREFIX}.${productId}.${channel}.${marketplace ?? 'GLOBAL'}`
}

/**
 * Capture a snapshot of the current ListingImage state for a channel
 * (+ optional marketplace narrowing for Amazon) and write to
 * localStorage. Caller invokes this AFTER a successful publish; rows
 * filter to those that match the channel/marketplace AND are in a
 * publish-eligible status.
 */
export function captureSnapshot(opts: {
  productId: string
  channel: SnapshotChannel
  marketplace: string | null
  listingImages: ListingImage[]
}): Snapshot | null {
  if (typeof window === 'undefined') return null
  const { productId, channel, marketplace, listingImages } = opts

  const rows = listingImages
    .filter((li) => li.platform === channel)
    .filter((li) => {
      // For Amazon with a specific marketplace: include rows scoped
      // to that marketplace OR PLATFORM-wide. For ALL or other
      // channels: include everything for the channel.
      if (!marketplace) return true
      if (li.scope === 'PLATFORM') return true
      if (li.scope === 'MARKETPLACE' && li.marketplace === marketplace) return true
      return false
    })
    .map<SnapshotRow>((li) => ({
      id: li.id,
      url: li.url,
      variantGroupKey: li.variantGroupKey,
      variantGroupValue: li.variantGroupValue,
      amazonSlot: li.amazonSlot,
      position: li.position,
      role: li.role,
    }))

  if (rows.length === 0) return null

  const snapshot: Snapshot = {
    productId,
    channel,
    marketplace,
    capturedAt: new Date().toISOString(),
    rows,
  }

  try {
    window.localStorage.setItem(storageKey(productId, channel, marketplace), JSON.stringify(snapshot))
  } catch {
    // localStorage unavailable (private browsing / quota). Non-fatal —
    // rollback simply won't have a snapshot to read.
  }
  return snapshot
}

export function readSnapshot(opts: {
  productId: string
  channel: SnapshotChannel
  marketplace: string | null
}): Snapshot | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(storageKey(opts.productId, opts.channel, opts.marketplace))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Snapshot
    if (!parsed || typeof parsed !== 'object' || parsed.channel !== opts.channel) return null
    return parsed
  } catch {
    return null
  }
}

export function clearSnapshot(opts: {
  productId: string
  channel: SnapshotChannel
  marketplace: string | null
}): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(storageKey(opts.productId, opts.channel, opts.marketplace))
  } catch {
    // ignore
  }
}

/**
 * Build a diff between a snapshot and the current ListingImage state.
 * Each diff entry tells the operator what would CHANGE on rollback:
 *   - 'restore': current row exists with a different URL — would
 *     restore to snapshot URL
 *   - 'recreate': snapshot row no longer in DB — would create as
 *     pending upsert (rare; happens when operator deleted post-publish)
 *   - 'extra': current row not in snapshot — would NOT touch
 *     (conservative; operator can delete manually if intentional)
 */
export interface DiffEntry {
  kind: 'restore' | 'recreate' | 'extra'
  snapshotRow?: SnapshotRow
  currentRow?: ListingImage
  /** Human-readable hint of what row this is — for the diff modal. */
  label: string
}

export function buildRollbackDiff(opts: {
  snapshot: Snapshot
  listingImages: ListingImage[]
}): DiffEntry[] {
  const { snapshot, listingImages } = opts
  const currentForChannel = listingImages
    .filter((li) => li.platform === snapshot.channel)
    .filter((li) => {
      if (!snapshot.marketplace) return true
      if (li.scope === 'PLATFORM') return true
      if (li.scope === 'MARKETPLACE' && li.marketplace === snapshot.marketplace) return true
      return false
    })
  const currentById = new Map(currentForChannel.map((li) => [li.id, li]))

  const out: DiffEntry[] = []
  const snapshotIds = new Set(snapshot.rows.map((r) => r.id))

  for (const s of snapshot.rows) {
    const cur = currentById.get(s.id)
    if (!cur) {
      out.push({
        kind: 'recreate',
        snapshotRow: s,
        label: describeRow(s),
      })
      continue
    }
    if (cur.url !== s.url) {
      out.push({
        kind: 'restore',
        snapshotRow: s,
        currentRow: cur,
        label: describeRow(s),
      })
    }
  }
  for (const c of currentForChannel) {
    if (!snapshotIds.has(c.id)) {
      out.push({
        kind: 'extra',
        currentRow: c,
        label: describeListingImage(c),
      })
    }
  }
  return out
}

function describeRow(r: SnapshotRow): string {
  const parts: string[] = []
  if (r.variantGroupValue) parts.push(`${r.variantGroupKey ?? 'Color'}: ${r.variantGroupValue}`)
  if (r.amazonSlot) parts.push(r.amazonSlot)
  if (parts.length === 0) parts.push(`#${r.position}`)
  return parts.join(' · ')
}

function describeListingImage(li: ListingImage): string {
  const parts: string[] = []
  if (li.variantGroupValue) parts.push(`${li.variantGroupKey ?? 'Color'}: ${li.variantGroupValue}`)
  if (li.amazonSlot) parts.push(li.amazonSlot)
  if (parts.length === 0) parts.push(`#${li.position}`)
  return parts.join(' · ')
}
