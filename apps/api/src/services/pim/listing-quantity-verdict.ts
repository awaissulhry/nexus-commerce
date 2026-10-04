/**
 * Amazon sheet gaps — the quantity VERDICT of one listing, as the Matrix shows it (`matrix.service.ts` `resolveListing`),
 * as ONE pure function so the product sheet's stock columns and the Matrix cannot read a listing two ways.
 *
 * Inputs the Matrix builds (design §3.1, verbatim): the fail-closed FBA verdict (`isFbaListing` with FBA stock and an
 * active FBA offer), `resolveIntendedQuantity` over the product's ledger (`loadSyncLedgers` — own stock or the pool it
 * sells from), the channel policy, and the rows of that ledger that route to this channel and market. The caller runs
 * the queries; nothing here reads the database.
 */
import type { SyncCell } from '@nexus/shared/matrix-contract'
import { isFbaCoordinate } from '../../lib/amazon-fulfillment.js'
import { computeAvailableToPublish } from '../available-to-publish.service.js'
import { ledgerInputs, type ProductLedger } from '../stock-pool/sync-ledgers.js'
import { locationServes, resolveIntendedQuantity, type IntendedResolution } from '../sync-control-core.js'
import { syncCellOf } from './matrix-cells.js'

export interface VerdictListing {
  channel: string
  marketplace: string
  fulfillmentMethod: string | null
  platformAttributes: unknown
  offerClosedAt: unknown
  followMasterQuantity: boolean | null
  syncPaused: boolean
  /** `ChannelListing.quantity` — what the channel holds (the pinned value when pinned). */
  quantity: number | null
  stockBuffer: number | null
  sourceLocationCodes: string[] | null
}

export interface ListingQuantityVerdictInput {
  listing: VerdictListing
  /** The product's own fulfilment flag (one FBA signal of the guard). */
  productFulfillmentMethod: string | null
  ledger: ProductLedger | undefined
  /** This business's AMAZON-EU-FBA units of the product (`ProductLedger.fbaBucket`). */
  fbaStockQty: number
  hasActiveFbaOffer: boolean
  channelPolicy: { pushesPaused: boolean } | null | undefined
  /** Amazon only: FBA sellable units at Amazon for this SKU and market (else the bucket), shown beside the cell. */
  fbaAtAmazon?: number | null
}

export interface ListingQuantityVerdict {
  isFba: boolean
  resolution: IntendedResolution
  /** The ledger rows that serve this channel + market (`locationServes`). */
  routed: Array<{ locationCode: string; available: number }>
  warehouseAvailable: number
  /** The FBM ceiling (`computeAvailableToPublish`); null for an FBA listing. */
  publishable: number | null
  sync: SyncCell
}

export function listingQuantityVerdict(input: ListingQuantityVerdictInput): ListingQuantityVerdict {
  const l = input.listing
  const ch = String(l.channel ?? '').toUpperCase(), mk = String(l.marketplace ?? '').toUpperCase()
  const isFba = ch === 'AMAZON' && isFbaCoordinate(
    { fulfillmentMethod: l.fulfillmentMethod, platformAttributes: l.platformAttributes },
    { fulfillmentMethod: input.productFulfillmentMethod },
    { fbaStockQty: input.fbaStockQty, hasActiveFbaOffer: input.hasActiveFbaOffer },
  )
  const inputs = ledgerInputs(input.ledger, l.sourceLocationCodes ?? [])
  const resolution = resolveIntendedQuantity({
    channel: ch, marketplace: mk, isFba, offerClosed: !!l.offerClosedAt,
    followMasterQuantity: l.followMasterQuantity !== false, syncPaused: l.syncPaused,
    pinnedQuantity: l.quantity, stockBuffer: l.stockBuffer ?? 0,
    channelPolicy: input.channelPolicy, ...inputs,
  })
  const routed = inputs.ledger.filter((r) => locationServes(r.syncRoutes, ch, mk)).map((r) => ({ locationCode: r.locationCode, available: r.available }))
  const warehouseAvailable = routed.reduce((s, r) => s + r.available, 0)
  const publishable = isFba ? null : computeAvailableToPublish({ fulfillmentMethod: 'FBM', warehouseAvailable, fbaSellable: 0, stockBuffer: l.stockBuffer ?? 0 }).available
  const sync = syncCellOf(resolution, {
    followMasterQuantity: l.followMasterQuantity, held: l.quantity, buffer: l.stockBuffer ?? 0, routed,
    fbaAtAmazon: ch === 'AMAZON' ? input.fbaAtAmazon ?? null : null, publishable,
  })
  return { isFba, resolution, routed, warehouseAvailable, publishable, sync }
}
