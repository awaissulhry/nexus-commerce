/** Presence wire: canonical DS types, no readiness-state copy. */
// In services/presence/types.ts; these resolve to the canonical DS source.
import type { PresenceIntent, ChannelFact, PresenceVerdict }
  from '@nexus/web/src/design-system/grid/renderers/presence'
import type { Reach, ActionReversal, ActionHandoff }
  from '@nexus/web/src/design-system/grid/actions/registry'
import type { ListingCoordinate } from '../../lib/listing-coordinate.js'

export interface NamedCoordinate {
  coordinate: ListingCoordinate
  label: string                 // SKU · channel · market · account · alias
  sku: string | null            // Product.sku, never labelled seller SKU
  sellerSku: string | null
  sellerSkuSource: string | null // e.g. Offer.sku or explicit legacy Product.sku fallback
  accountLabel: string | null
  aliasLabel: string | null
}
export interface IntentRead {
  value: PresenceIntent | null  // null: never stated by an operator
  at: string | null
  by: string | null
  reason: string | null
  provisional: null | {
    value: PresenceIntent
    source: 'legacy-columns'
    fields: Array<{ name: string; value: unknown }>
    sentence: string
  }
}
export interface FactRead {
  value: ChannelFact            // persisted null is projected as UNKNOWN
  asOf: string | null           // channelFactAt, never lastSyncedAt
  via: string | null
  detail: Record<string, unknown> | null
}
export interface VerbAvailability {
  available: boolean
  reach: Reach
  reversal: ActionReversal | null
  refusal: string | null        // render verbatim; no client reconstruction
  errorCode: string | null
  handoffs: ActionHandoff[]
  fanOut: NamedCoordinate[]     // never just a count
}
export interface PresenceRow extends NamedCoordinate {
  kind: 'listing' | 'opening' | 'retired'
  listingId: string | null
  aliasId: string | null        // actual alias FK for the alias-status route
  version: number | null        // ChannelListing.version; no row means null
  productVersion: number | null // Product.version, independently named
  externalListingId: string | null
  lastChange: null | {
    eventId: string
    at: string
    actorUserId: string | null
    summary: string
  }
  intent: IntentRead
  fact: FactRead
  verdict: PresenceVerdict      // derived on read, never persisted
  inFlight: boolean
  gate: { mode: string | null; sentence: string | null; canVerify: boolean }
  connection: {
    state: 'connected' | 'not-connected' | 'unknown'
    asOf: string | null
    via: string | null
    refusal: string | null
    authStatus: string | null    // actual stored status; not inferred from a failed read
    accessTokenExpiresAt: string | null
    lastErrorAt: string | null
    lastError: string | null     // sanitized operator detail, no credentials
  }
  participation: {
    isParticipating: boolean | null
    participationStatus: string | null
    checkedAt: string | null
  }
  local: {
    syncPaused: boolean | null
    variationExcluded: boolean | null
    offerActive: boolean | null
    offerActiveHonoured: boolean | null
    offerClosedAt: string | null
    offerClosedBy: string | null
    offerCloseReason: string | null
    lastSyncedAt: string | null
    presenceEffectiveFrom: string | null
    presenceUntil: string | null
    scheduleSentence: 'A note, not an alarm. Nothing executes these dates.'
  }
  verbs: Record<string, VerbAvailability>
}
export interface PresencePage {
  product: { id: string; sku: string; version: number; deletedAt: string | null }
  coverage: {
    scope: 'product' | 'family'
    requestedProductId: string
    rootProductId: string
    products: Array<{ id: string; sku: string; version: number; deletedAt: string | null }>
    complete: true             // partial source failure is named in sources, never omitted members
  }
  readAt: string
  freshnessMs: number           // server policy, supplied to verdict derivation
  verifyPolicy: {
    maxCoordinatesPerCall: number
    maxAttemptsPerWorkspaceHour: number
    sentence: string            // render the server's cap sentence verbatim
  }
  rows: PresenceRow[]
  sources: Array<{
    source: string
    status: 'ok' | 'unavailable'
    asOf: string | null
    refusal: string | null
  }>
}

export interface PresenceHistory {
  coordinate: ListingCoordinate
  readAt: string
  events: Array<{
    id: string
    aggregateId: string
    aggregateType: 'ChannelListing'
    eventType: string
    createdAt: string
    data: Record<string, unknown> | null
    actor: { userId: string | null; source: string | null }
  }>
  identities: Array<{
    id: string
    coordinate: ListingCoordinate
    sku: string
    externalListingId: string
    externalParentId: string | null
    firstSeenAt: string
    lastSeenAt: string
    retiredAt: string | null
    retiredReason: string | null
    retiredBy: string | null
    doNotRecreate: boolean
    lastSnapshotId: string | null
  }>
  nextCursor: string | null
}

export interface AmazonPosture {
  coordinate: ListingCoordinate
  readAt: string
  offers: Array<{
    id: string; sellerSku: string; fulfillmentMethod: string
    isActive: boolean; quantity: number | null; lastSyncedAt: string | null
  }>
  fbaInventory: Array<{
    id: string; productId: string | null; sellerSku: string; asin: string | null
    marketplaceId: string; fulfillmentCenterId: string; condition: string
    quantity: number; lastSyncedAt: string
    matchedBy: 'productId' | 'sku' | 'asin'
  }>
  suppressions: Array<{
    id: string; listingId: string; suppressedAt: string; resolvedAt: string | null
    reasonCode: string | null; reasonText: string; severity: string; source: string
  }>
  gate: PresenceRow['gate']
  sharedQuantityIntent: Array<NamedCoordinate & {
    intent: IntentRead; offerClosedAt: string | null; offerActive: boolean | null
  }>
  checks: {
    offers: ImpactCheck
    fbaPosture: ImpactCheck
    suppressions: ImpactCheck
    sharedQuantityIntent: ImpactCheck
  }
}

export interface VerifyRequest { coordinates: ListingCoordinate[]; reason: string }
export interface VerifyResult {
  coordinate: ListingCoordinate
  outcome: 'selling' | 'not-selling' | 'absent' | 'could-not-ask'
  fact: FactRead
  persisted: boolean
  refusal: string | null
  errorCode: string | null
}
export interface VerifyResponse { readAt: string; results: VerifyResult[] }

export interface ImpactCheck {
  status: 'ok' | 'unavailable'
  scope: 'product' | 'coordinate'
  dimensions: string[]
  asOf: string | null
  provenance: string[]
  blocking: boolean
  refusal: string | null
  rows: Array<Record<string, unknown>>
}
export interface OperationalImpactResponse {
  readAt: string
  targets: Array<{
    target: { productId: string } | ListingCoordinate
    checks: {
      channelListings: ImpactCheck
      openOrders: ImpactCheck
      activeBundles: ImpactCheck
      fbaPosture: ImpactCheck
      stockHolds: ImpactCheck
      advertising: ImpactCheck
    }
  }>
}

export type { ListingCoordinate, PresenceIntent, ChannelFact, PresenceVerdict }
