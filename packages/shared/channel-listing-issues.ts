/** Saved open findings, scoped to one visible account in the selected business. */
export interface ChannelListingIssue {
  id: string
  listingId: string
  productId: string
  productSku: string
  marketplace: string
  externalListingId: string | null
  code: string
  severity: string
  message: string
  attributeNames: string[]
  categories: string[]
  source: string
  firstSeenAt: string
  lastSeenAt: string
  occurredAt: string | null
}

/** A live keyset page, not a snapshot or a verdict about the channel's current health. */
export interface ChannelListingIssuesPage {
  connectionId: string
  workspaceId: string
  channel: string
  readAt: string
  items: ChannelListingIssue[]
  nextCursor: string | null
}
