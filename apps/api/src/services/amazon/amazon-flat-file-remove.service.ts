/** Five-level local removal. Child fan-out is enumerated and returned. */
import { dispatchChannelDelist } from '../channel-delist.service.js'
import { sellerSkuForDelist } from '../outbound-enqueue.js'
import { whereCoordinate, type ListingCoordinate } from '../../lib/listing-coordinate.js'

export interface RemoveAmazonTarget extends Omit<ListingCoordinate, 'channel'> { actor: string }
export interface RemoveAmazonResult {
  productId: string
  marketplace: string
  channelListingsRemoved: number
  delisted: boolean
  fanOut: Array<ListingCoordinate & { listingId: string; externalListingId: string | null }>
  error?: string
}
interface RemovePrisma {
  product: { findFirst(a: any): Promise<any>; findMany(a: any): Promise<any[]> }
  channelListing: { findMany(a: any): Promise<any[]>; deleteMany(a: any): Promise<{count: number}> }
  $transaction<T>(fn: (tx: any) => Promise<T>): Promise<T>
}
export async function removeAmazonListing(prisma: RemovePrisma, target: RemoveAmazonTarget): Promise<RemoveAmazonResult> {
  const coordinate = { ...target, channel: 'AMAZON' }
  whereCoordinate(coordinate) // Validate before any read or mutation.
  if (!target.actor) throw new Error('LISTING_REMOVAL_ACTOR_REQUIRED')
  const { productId, marketplace } = coordinate
  const result: RemoveAmazonResult = { productId, marketplace, channelListingsRemoved: 0, delisted: false, fanOut: [] }
  const product = await prisma.product.findFirst({ where: { id: productId }, select: { id: true } })
  if (!product) return { ...result, error: `Product not found: ${productId}` }
  const children = await prisma.product.findMany({ where: { parentId: productId, deletedAt: null }, select: { id: true } })
  const coordinates = [product, ...children].map(p => ({ ...coordinate, productId: p.id }))
  // This exact OR is shared by the identity capture and the local delete.
  const where = { OR: coordinates.map(whereCoordinate) }
  const listings = await prisma.channelListing.findMany({ where, include: { product: { select: { sku: true } }, offers: true } })
  result.fanOut = listings.map(l => ({
    productId: l.productId, channel: l.channel, marketplace: l.marketplace,
    channelConnectionId: l.channelConnectionId, aliasKey: l.aliasKey,
    listingId: l.id, externalListingId: l.externalListingId,
  }))
  await prisma.$transaction(async tx => {
    const deleted = await tx.channelListing.deleteMany({ where })
    result.channelListingsRemoved = deleted.count
    if (deleted.count) await tx.productEvent.create({ data: {
      aggregateType: 'Product', aggregateId: productId, eventType: 'LISTING_REMOVED',
      data: { coordinate: whereCoordinate(coordinate), removedCount: deleted.count, fanOut: result.fanOut },
      metadata: { actor: target.actor, source: 'amazon-flat-file-remove' },
    } })
  })
  // W1 retains the local-first removal protocol. Wave 4 supplies durable
  // remote orchestration; a refusal/dry run is never reported as a delist.
  const errors: string[] = []
  for (const l of listings) {
    if (!l.externalListingId) continue
    try {
      const r = await dispatchChannelDelist({
        queueId: `amz-rm-${l.id}`, productId: l.productId, channelListingId: null,
        targetChannel: 'AMAZON', targetRegion: l.marketplace, externalListingId: l.externalListingId,
        sellerSku: sellerSkuForDelist(l), channelConnectionId: l.channelConnectionId,
        syncType: 'DELETE_LISTING', payload: { channelAction: 'delete', aliasKey: l.aliasKey, originalListingId: l.id },
      })
      if (r.success && !r.dryRun) result.delisted = true
      else errors.push(`${l.id}: ${r.error ?? (r.dryRun ? 'dry-run; not delisted' : 'delist refused')}`)
    } catch (e) { errors.push(`${l.id}: ${e instanceof Error ? e.message : String(e)}`) }
  }
  if (errors.length) result.error = errors.join('; ')
  return result
}
