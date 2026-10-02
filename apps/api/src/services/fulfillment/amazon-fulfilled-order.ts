/**
 * MCP full control 07 O1 — the one fail-closed test "Amazon ships this order", for every Nexus shipping path
 * (shipment create, bulk create, label purchase). FBA quantity is untouchable, and so is an FBA parcel: Nexus must
 * never create a shipment or buy a carrier label for an order Amazon fulfils.
 *
 * Amazon ships an order when any of these holds:
 *   - the order says FBA / AFN / Amazon-fulfilled (`Order.fulfillmentMethod`, from SP-API FulfillmentChannel);
 *   - it has an MCF request that is still alive (an eBay or Shopify order sent to Amazon Multi-Channel Fulfilment
 *     from FBA stock; only CANCELLED, INVALID and UNFULFILLABLE requests leave the parcel to Nexus);
 *   - it is an Amazon order WITHOUT explicit merchant evidence (FBM / MFN): unknown means refused (fail closed).
 */
import type { Prisma } from '@prisma/client'

const MERCHANT_FULFILLED = new Set(['FBM', 'MFN', 'MERCHANT', 'MERCHANTFULFILLED'])
/** MCF statuses in which Amazon will not ship the order (amazon-mcf.service.ts CANCELLED_STATUSES). */
export const MCF_NOT_SHIPPING_STATUSES = ['CANCELLED', 'INVALID', 'UNFULFILLABLE'] as const

export function isAmazonFulfilledOrder(
  order: { channel: string; fulfillmentMethod: string | null | undefined },
  activeMcfShipments = 0,
): boolean {
  if (activeMcfShipments > 0) return true
  const method = String(order.fulfillmentMethod ?? '').trim().toUpperCase()
  if (method === 'FBA' || method === 'AFN' || method.startsWith('AMAZON')) return true
  if (String(order.channel).toUpperCase() === 'AMAZON') return !MERCHANT_FULFILLED.has(method)
  return false
}

export const AMAZON_FULFILLED_CODE = 'AMAZON_FULFILLED' as const
export const AMAZON_FULFILLED_REASON =
  'Amazon ships this order (FBA or Multi-Channel Fulfilment): Nexus creates no shipment and buys no label for it.'

/** The refusal for one order, or null when Nexus may ship it. Reads the MCF requests in the caller's business. */
export async function amazonFulfilledRefusal(
  db: Pick<Prisma.TransactionClient, 'mCFShipment'>,
  order: { id: string; channel: string; fulfillmentMethod: string | null | undefined },
): Promise<{ code: typeof AMAZON_FULFILLED_CODE; error: string } | null> {
  const activeMcf = await db.mCFShipment.count({
    where: { orderId: order.id, status: { notIn: [...MCF_NOT_SHIPPING_STATUSES] } },
  })
  return isAmazonFulfilledOrder(order, activeMcf) ? { code: AMAZON_FULFILLED_CODE, error: AMAZON_FULFILLED_REASON } : null
}

/** fulfillmentMethod equals / starts with `value`, ignoring case; FALSE (never NULL) when it is empty. */
const methodIs = (value: string) => ({ AND: [{ fulfillmentMethod: { not: null } }, { fulfillmentMethod: { equals: value, mode: 'insensitive' as const } }] })
const methodStartsWith = (value: string) => ({ AND: [{ fulfillmentMethod: { not: null } }, { fulfillmentMethod: { startsWith: value, mode: 'insensitive' as const } }] })

/**
 * 07 O5 — isAmazonFulfilledOrder as a WHERE, so the queue pages over the orders Nexus ships. Every
 * leaf is TRUE or FALSE (never NULL), so its NOT is exactly "the business ships it". The rows read are checked again
 * with the TypeScript test (it also trims the stored value): a disagreement leaves the order out of the queue.
 */
export const AMAZON_SHIPS_WHERE = {
  OR: [
    { mcfShipments: { some: { status: { notIn: [...MCF_NOT_SHIPPING_STATUSES] } } } },
    methodIs('FBA'),
    methodIs('AFN'),
    methodStartsWith('AMAZON'),
    { AND: [{ channel: 'AMAZON' as const }, { NOT: { OR: [...MERCHANT_FULFILLED].map(methodIs) } }] },
  ],
}
