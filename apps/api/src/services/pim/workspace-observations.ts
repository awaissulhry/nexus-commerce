import { Prisma } from '@prisma/client'
import prisma from '../../db.js'
import { resolveWorkspaceDestination, workspaceListingWhere, type WorkspaceDestinationInput } from './workspace-destination.js'
import { workspaceMetadataWhere } from './workspace-history.js'

export async function getWorkspaceActivity(input: WorkspaceDestinationInput & { scope?: string; cursor?: string }) {
  const destination = input.scope === 'master' ? null : await resolveWorkspaceDestination(input)
  const productId = destination?.listing?.productId ?? input.productId
  const listings = destination ? await prisma.channelListing.findMany({ where: { productId, ...workspaceListingWhere(destination) }, select: { id: true } }) : []
  const events = await prisma.productEvent.findMany({ where: { OR: [
    { aggregateType: 'Product', aggregateId: productId, ...workspaceMetadataWhere(destination) },
    ...(destination ? [{ aggregateType: 'ChannelListing', aggregateId: { in: listings.map(l => l.id) }, ...workspaceMetadataWhere(destination) }] : []),
  ] }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 101,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}) })
  return { events: events.slice(0, 100), nextCursor: events.length > 100 ? events[99].id : null,
    coverageNote: 'Only events attributed to this product and scope are shown. Older events without scope attribution remain in the audit log.' }
}

/** Reads from the existing order, inventory and listing owners; it creates no aggregate
 * or pricing state. Account-less traffic/advertising/quality observations are not reused. */
export async function getWorkspacePerformance(input: WorkspaceDestinationInput & { days: number }) {
  const destination = await resolveWorkspaceDestination(input)
  const productId = destination.listing?.productId ?? input.productId
  const cutoff = new Date(Date.now() - input.days * 86400_000)
  const [prices, stock, sales] = await Promise.all([
    prisma.channelListing.findMany({ where: { productId, ...workspaceListingWhere(destination) },
      select: { id: true, aliasKey: true, price: true, priceOverride: true } }),
    prisma.stockLevel.aggregate({ where: { productId }, _sum: { available: true } }),
    // Order lines carry account/product attribution, but no listing-alias attribution.
    destination.listing || destination.aliasKey !== null ? Promise.resolve(null) : prisma.$queryRaw<Array<{ currency: string | null; units: bigint; revenue: Prisma.Decimal; orders: bigint }>>(Prisma.sql`
      SELECT o."currencyCode" AS currency, SUM(i.quantity)::bigint AS units,
        SUM(i.price * i.quantity) AS revenue, COUNT(DISTINCT o.id)::bigint AS orders
      FROM "OrderItem" i JOIN "Order" o ON o.id = i."orderId"
      WHERE i."productId" = ${productId} AND o."channelConnectionId" = ${destination.accountId}
        AND o.channel::text = ${destination.channel} AND o.marketplace = ${destination.marketplace}
        AND COALESCE(o."purchaseDate", o."createdAt") >= ${cutoff} AND o.status::text <> 'CANCELLED'
      GROUP BY o."currencyCode"`),
  ])
  return { productId, days: input.days, inventoryAvailable: stock._sum.available,
    prices: prices.map(p => ({ id: p.id, aliasKey: p.aliasKey, currency: destination.currency, price: p.priceOverride === null && p.price === null ? null : Number(p.priceOverride ?? p.price) })),
    sales: sales?.map(s => ({ currency: s.currency, units: Number(s.units), revenue: Number(s.revenue), orders: Number(s.orders) })) ?? null,
    salesNote: sales === null ? 'Order lines do not identify individual listing customizations. Clear the listing selection to see sales attributed to this product, account and market.' : 'Sales use non-cancelled order lines attributed to this product, account and market. Missing account attribution and SKU-only matches are excluded. Currencies are shown separately.',
    observationNote: 'Traffic, advertising, buy-box history and quality scores do not have verified attribution to this destination and are unavailable here.' }
}
