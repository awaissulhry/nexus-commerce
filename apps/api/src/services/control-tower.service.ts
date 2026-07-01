/**
 * P6.1 — Pure control-tower status roll-up shaper.
 *
 * No imports, no IO — takes structured data and returns a per-SKU × per-channel
 * status model. All status derivation follows worst-wins precedence:
 *   DEAD > FAILED > CLAMPED > PENDING > IN_SYNC > UNKNOWN
 */

// ─── Public types ──────────────────────────────────────────────────────────────

export type ControlTowerStatus =
  | 'DEAD'
  | 'FAILED'
  | 'CLAMPED'
  | 'PENDING'
  | 'IN_SYNC'
  | 'UNKNOWN'

export interface ControlTowerListing {
  channelListingId: string
  channel: string
  marketplace: string | null
  /** 'SUCCESS' | 'FAILED' | 'PENDING' | null (from ChannelListing.lastSyncStatus) */
  lastSyncStatus: string | null
  lastSyncedAt: Date | null
  quantity: number | null
  offerActive: boolean
}

export interface ControlTowerQueueRow {
  channel: string
  marketplace: string | null
  /** OutboundSyncQueue.syncStatus: PENDING | IN_PROGRESS | SUCCESS | FAILED | CANCELLED */
  syncStatus: string
  isDead: boolean
}

export interface ControlTowerSkuInput {
  sku: string
  productId: string
  listings: ControlTowerListing[]
  queueRows: ControlTowerQueueRow[]
  /** channels with a recent sync.oversell.clamped event */
  clampedChannels?: string[]
  /** this SKU has available < 0 somewhere */
  negativeAvailable?: boolean
  /** true when this product is itself a parent (no parentId) */
  isParent?: boolean
  /** id of the parent Product, or null for standalone / parent rows */
  parentId?: string | null
  /** SKU of the parent Product, or null when not a child */
  parentSku?: string | null
}

export interface ControlTowerChannelCell {
  channelListingId: string
  channel: string
  marketplace: string | null
  status: ControlTowerStatus
  lastSyncedAt: Date | null
  quantity: number | null
  offerActive: boolean
}

export interface ControlTowerRow {
  sku: string
  productId: string
  negativeAvailable: boolean
  isParent: boolean
  parentId: string | null
  parentSku: string | null
  channels: ControlTowerChannelCell[]
  worstStatus: ControlTowerStatus
}

// ─── Precedence table ──────────────────────────────────────────────────────────

/** Higher = worse. Used for worst-wins comparisons. */
const PRECEDENCE: Record<ControlTowerStatus, number> = {
  UNKNOWN: 0,
  IN_SYNC: 1,
  PENDING: 2,
  CLAMPED: 3,
  FAILED: 4,
  DEAD: 5,
}

function worse(a: ControlTowerStatus, b: ControlTowerStatus): ControlTowerStatus {
  return PRECEDENCE[a] >= PRECEDENCE[b] ? a : b
}

// ─── Per-listing status derivation ────────────────────────────────────────────

/**
 * Map a ChannelListing.lastSyncStatus string to a ControlTowerStatus candidate.
 */
function listingStatusToCandidate(lastSyncStatus: string | null): ControlTowerStatus {
  switch (lastSyncStatus) {
    case 'SUCCESS':
      return 'IN_SYNC'
    case 'FAILED':
      return 'FAILED'
    case 'PENDING':
      return 'PENDING'
    default:
      return 'UNKNOWN'
  }
}

/**
 * Derive the worst status for a single (channel, marketplace) cell given:
 *  - the matching queue rows for this cell
 *  - whether this channel is in the clampedChannels set
 *  - the listing's lastSyncStatus
 */
function deriveCell(
  listing: ControlTowerListing,
  matchingQueueRows: ControlTowerQueueRow[],
  isClamped: boolean,
): ControlTowerStatus {
  let status: ControlTowerStatus = 'UNKNOWN'

  // 1. Queue row signals (worst-wins within queue rows)
  for (const row of matchingQueueRows) {
    if (row.isDead) {
      status = worse(status, 'DEAD')
    } else if (row.syncStatus === 'FAILED') {
      status = worse(status, 'FAILED')
    } else if (row.syncStatus === 'PENDING' || row.syncStatus === 'IN_PROGRESS') {
      status = worse(status, 'PENDING')
    }
    // SUCCESS and CANCELLED contribute nothing
  }

  // 2. Clamped flag
  if (isClamped) {
    status = worse(status, 'CLAMPED')
  }

  // 3. Listing lastSyncStatus
  status = worse(status, listingStatusToCandidate(listing.lastSyncStatus))

  return status
}

// ─── Main export ───────────────────────────────────────────────────────────────

export function buildControlTowerRows(input: ControlTowerSkuInput[]): ControlTowerRow[] {
  return input.map((item) => {
    const clampedSet = new Set(item.clampedChannels ?? [])

    const channels: ControlTowerChannelCell[] = item.listings.map((listing) => {
      // Match queue rows by channel + marketplace (null === null)
      const matchingQueueRows = item.queueRows.filter(
        (q) => q.channel === listing.channel && q.marketplace === listing.marketplace,
      )

      const isClamped = clampedSet.has(listing.channel)

      const status = deriveCell(listing, matchingQueueRows, isClamped)

      return {
        channelListingId: listing.channelListingId,
        channel: listing.channel,
        marketplace: listing.marketplace,
        status,
        lastSyncedAt: listing.lastSyncedAt,
        quantity: listing.quantity,
        offerActive: listing.offerActive,
      }
    })

    // worstStatus across all channel cells; UNKNOWN if no channels
    const worstStatus: ControlTowerStatus = channels.reduce<ControlTowerStatus>(
      (worst, cell) => worse(worst, cell.status),
      'UNKNOWN',
    )

    return {
      sku: item.sku,
      productId: item.productId,
      negativeAvailable: item.negativeAvailable ?? false,
      isParent: item.isParent ?? false,
      parentId: item.parentId ?? null,
      parentSku: item.parentSku ?? null,
      channels,
      worstStatus,
    }
  })
}
