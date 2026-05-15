// Derive a four-state SyncStatus from a raw ChannelListing row.
// These four states are NOT stored in the DB — they're computed on read
// and surfaced in the Command Matrix grid.

export type SyncStatus = 'SYNCED' | 'OVERRIDE' | 'ERROR' | 'UNLISTED'

interface ChannelListingRow {
  isPublished: boolean
  listingStatus: string
  lastSyncStatus?: string | null
  followMasterTitle: boolean
  followMasterDescription: boolean
  followMasterPrice: boolean
  followMasterQuantity: boolean
  followMasterImages: boolean
  followMasterBulletPoints: boolean
}

export function deriveSyncStatus(cl: ChannelListingRow): SyncStatus {
  if (
    !cl.isPublished ||
    cl.listingStatus === 'INACTIVE' ||
    cl.listingStatus === 'ENDED'
  ) {
    return 'UNLISTED'
  }
  if (cl.lastSyncStatus === 'FAILED' || cl.listingStatus === 'ERROR') {
    return 'ERROR'
  }
  const followsAll =
    cl.followMasterTitle &&
    cl.followMasterDescription &&
    cl.followMasterPrice &&
    cl.followMasterQuantity &&
    cl.followMasterImages &&
    cl.followMasterBulletPoints
  if (!followsAll) return 'OVERRIDE'
  return 'SYNCED'
}

// Active channel × marketplace combinations surfaced in the grid.
// Key matches the CatalogNode.channels field name.
export const ACTIVE_CHANNELS = [
  { key: 'amazonDe', channel: 'AMAZON', region: 'DE' },
  { key: 'ebayUk', channel: 'EBAY', region: 'UK' },
  { key: 'shopify', channel: 'SHOPIFY', region: null }, // region is null/GLOBAL for Shopify
] as const

export type ChannelKey = (typeof ACTIVE_CHANNELS)[number]['key']
