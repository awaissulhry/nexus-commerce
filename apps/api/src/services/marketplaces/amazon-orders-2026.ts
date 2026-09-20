/**
 * P5.1 — Amazon Orders v0 → v2026-01-01.
 *
 * Amazon removes Orders **v0** on **2027-03-27**. Its replacement is Orders
 * **2026-01-01**, which is not a rename: it is a different object model.
 * `AmazonOrderId` became `orderId`, `OrderStatus` moved inside `fulfillment`,
 * `OrderTotal` became `proceeds.grandTotal`, and the separate `getOrderItems`
 * call is gone — items arrive on the order itself.
 *
 * Fourteen files read the v0 shape, and every historical `Order.raw` row in the
 * database holds a v0 payload. So this module does NOT spread the new shape
 * through the codebase. It converts a 2026-01-01 order back into the v0
 * `AmazonOrderRaw` / `AmazonOrderItemRaw` shape at the fetch boundary. One file
 * knows both vocabularies; nothing downstream changes.
 *
 * ── What the measurement found (all quotable) ────────────────────────────────
 *
 * 1. **The library's version pin does almost nothing.** `amazon-sp-api@1.2.1`
 *    has `version_fallback: true` by default, so
 *    `endpoints_versions: { orders: '2026-01-01' }` — the literal instruction in
 *    the plan — moves only `getOrder`. Nine other operations resolve back to v0
 *    **silently**, including the two we actually call (`getOrders`,
 *    `getOrderItems`). Proven by `amazon-orders-version.p51.vitest.test.ts`,
 *    which walks the library's own resolver.
 *
 * 2. **`ItemPrice` is a LINE TOTAL; `product.price.unitPrice` is PER UNIT.**
 *    Amazon's own example response proves the factor: `quantityOrdered: 2`,
 *    `unitPrice = 49.99`, `proceeds.breakdowns[ITEM].subtotal = 99.98`.
 *    `upsertOrderItem` (DA-RT.15) divides `ItemPrice.Amount` by the quantity
 *    because v0 gives the line total. Mapping `ItemPrice ← unitPrice` would make
 *    it divide an already-per-unit price a second time. 38 order lines in the
 *    development database have `quantity > 1` (36 × 2, 1 × 4, 1 × 8) — they
 *    would have been stored at half, a quarter and an eighth of their price.
 *    So `ItemPrice` is taken from the **ITEM proceeds breakdown**, and only
 *    falls back to `unitPrice × quantityOrdered`. Never bare `unitPrice`.
 *
 * 3. **The status vocabulary changed case AND spelling, and `mapStatus` has a
 *    `default`.** v0 says `Shipped` / `Unshipped` / `Canceled` (one L);
 *    2026-01-01 says `SHIPPED` / `UNSHIPPED` / `CANCELLED` (two L). Every
 *    unknown value falls through `mapStatus`'s `default` to `PENDING` without a
 *    word, so passing the new strings through would have turned every shipped
 *    and cancelled order into a pending one. Converted here, not passed through.
 *
 * 4. **`FulfillmentChannel` is P2.2 re-armed.** v0 says `AFN` / `MFN`;
 *    2026-01-01 says `AMAZON` / `MERCHANT`. P2.2 found `fulfillmentType` reading
 *    `'MFN'` on 1413/1413 real payloads when the truth was AFN on 1071. Leaving
 *    this unmapped recreates that defect in a new spelling.
 *
 * 5. **Most of the order is behind `includedData`.** `proceeds`, `fulfillment`,
 *    `buyer`, `recipient` are omitted unless asked for. A missing section is
 *    therefore "not requested", not "empty" — so nothing here invents a value
 *    for an absent section. `ORDERS_2026_INCLUDED_DATA` asks for what the v0
 *    shape needs.
 *
 * The switch is `NEXUS_ENABLE_AMAZON_ORDERS_2026`. It is **off** by default:
 * the mapping is proven against Amazon's published model and its own example
 * response, but no live 2026-01-01 call has been made — that needs the Owner.
 */

import type { AmazonOrderRaw, AmazonOrderItemRaw } from './amazon.service.js'

/** The endpoint version that replaces Orders v0 on 2027-03-27. */
export const AMAZON_ORDERS_2026_VERSION = '2026-01-01'

/**
 * `includedData` sections needed to fill the v0 shape. `PROCEEDS` carries the
 * order total and every item price; `FULFILLMENT` carries the status and the
 * AFN/MFN answer; `RECIPIENT` and `BUYER` carry the address and the buyer.
 *
 * `BUYER` is buyer personal data. P5.4 covers the Restricted Data Token, and
 * until it lands this set matches exactly what Orders v0 already returns to us
 * today — it widens nothing.
 */
export const ORDERS_2026_INCLUDED_DATA = [
  'PROCEEDS',
  'FULFILLMENT',
  'RECIPIENT',
  'BUYER',
] as const

/** Is the 2026-01-01 Orders path on? Off unless explicitly enabled. */
export function amazonOrders2026Enabled(): boolean {
  return process.env.NEXUS_ENABLE_AMAZON_ORDERS_2026 === 'true'
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  The 2026-01-01 wire shape — only the parts the v0 shape needs.            */
/* ────────────────────────────────────────────────────────────────────────── */

interface Money2026 {
  amount?: string
  currencyCode?: string
}

interface ProceedsBreakdown2026 {
  /** ITEM | SHIPPING | GIFT_WRAP | COD_FEE | TAX | DISCOUNT | DELIVERY_TIP | OTHER */
  type?: string
  subtotal?: Money2026
}

export interface OrderItem2026 {
  orderItemId?: string
  quantityOrdered?: number
  product?: {
    asin?: string
    title?: string
    sellerSku?: string
    /** `unitPrice` is PER UNIT. v0's `ItemPrice` is the LINE TOTAL — see note 2. */
    price?: { unitPrice?: Money2026 }
  }
  proceeds?: { proceedsTotal?: Money2026; breakdowns?: ProceedsBreakdown2026[] }
  fulfillment?: { quantityFulfilled?: number; quantityUnfulfilled?: number }
}

export interface Order2026 {
  orderId?: string
  createdTime?: string
  lastUpdatedTime?: string
  /** AMAZON_BUSINESS, PRIME, PREMIUM, … — v0 exposed these as booleans. */
  programs?: string[]
  salesChannel?: { channelName?: string; marketplaceId?: string; marketplaceName?: string }
  buyer?: { buyerName?: string; buyerEmail?: string; buyerCompanyName?: string }
  recipient?: {
    deliveryAddress?: {
      name?: string
      addressLine1?: string
      addressLine2?: string
      addressLine3?: string
      city?: string
      stateOrRegion?: string
      postalCode?: string
      countryCode?: string
      phone?: string
    }
  }
  proceeds?: { grandTotal?: Money2026; breakdowns?: ProceedsBreakdown2026[] }
  fulfillment?: {
    /** PENDING_AVAILABILITY | PENDING | UNSHIPPED | PARTIALLY_SHIPPED | SHIPPED | CANCELLED | UNFULFILLABLE */
    fulfillmentStatus?: string
    /** MERCHANT | AMAZON — v0 said MFN | AFN. */
    fulfilledBy?: string
    fulfillmentServiceLevel?: string
    shipByWindow?: { earliestDateTime?: string; latestDateTime?: string }
    deliverByWindow?: { earliestDateTime?: string; latestDateTime?: string }
  }
  orderItems?: OrderItem2026[]
}

export interface SearchOrdersResponse2026 {
  orders?: Order2026[]
  pagination?: { nextToken?: string }
}

/**
 * `getOrder` 2026-01-01 answers `{ "order": { … } }`.
 *
 * That is a THIRD envelope in this one migration: v0 wrapped in `payload`,
 * `searchOrders` puts the list at the top level under `orders`, and `getOrder`
 * wraps a single order in `order`. Reading the wrong one gives an object with
 * every field `undefined` and no error — the double-encoding shape from P3.1.
 */
export interface GetOrderResponse2026 {
  order?: Order2026
}

/** The order inside a `getOrder` answer, or null when there is none. */
export function orderOf(response: GetOrderResponse2026 | Order2026 | null | undefined): Order2026 | null {
  if (!response) return null
  const wrapped = (response as GetOrderResponse2026).order
  if (wrapped && typeof wrapped === 'object') return wrapped
  // Not wrapped: accept a bare order only when it actually carries an id, so a
  // wrong envelope reads as "nothing" rather than as an order with no fields.
  const bare = response as Order2026
  return typeof bare.orderId === 'string' && bare.orderId ? bare : null
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Vocabulary maps — the new words back into the words our code already has.  */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * 2026-01-01 `fulfillmentStatus` → the v0 `OrderStatus` string.
 *
 * `mapStatus` in `amazon-orders.service.ts` switches on the v0 spelling and has
 * a `default: PENDING`. `UNFULFILLABLE` is deliberately mapped to v0's own
 * `Unfulfillable`, which that `default` already catches today — the point is to
 * keep behaviour identical, not to change it inside a version migration.
 */
export const FULFILLMENT_STATUS_TO_V0: Readonly<Record<string, string>> = Object.freeze({
  PENDING_AVAILABILITY: 'PendingAvailability',
  PENDING: 'Pending',
  UNSHIPPED: 'Unshipped',
  PARTIALLY_SHIPPED: 'PartiallyShipped',
  SHIPPED: 'Shipped',
  CANCELLED: 'Canceled',
  UNFULFILLABLE: 'Unfulfillable',
})

/** 2026-01-01 `fulfilledBy` → the v0 `FulfillmentChannel`. P2.2's fact, renamed. */
export const FULFILLED_BY_TO_V0: Readonly<Record<string, 'AFN' | 'MFN'>> = Object.freeze({
  AMAZON: 'AFN',
  MERCHANT: 'MFN',
})

/* ────────────────────────────────────────────────────────────────────────── */
/*  Conversion                                                                */
/* ────────────────────────────────────────────────────────────────────────── */

/** A v0 money object, or `undefined` when Amazon sent no value.
 *
 *  Guarded on whether there is a VALUE, not on whether the object exists: an
 *  object with no `amount` is "not told", the same as no object at all. This is
 *  the `Array.isArray([])` lesson in its money form. */
function toV0Money(money: Money2026 | undefined): { CurrencyCode: string; Amount: string } | undefined {
  if (!money || money.amount === undefined || money.amount === null || money.amount === '') return undefined
  return { CurrencyCode: money.currencyCode ?? '', Amount: String(money.amount) }
}

/** The subtotal of one proceeds category, or `undefined` if that category is absent. */
function breakdownOf(
  breakdowns: ProceedsBreakdown2026[] | undefined,
  type: string,
): { CurrencyCode: string; Amount: string } | undefined {
  if (!Array.isArray(breakdowns)) return undefined
  return toV0Money(breakdowns.find((entry) => entry?.type === type)?.subtotal)
}

/**
 * The LINE total for an item, in v0's `ItemPrice` semantics.
 *
 * Order of preference, and the reason for it (note 2 in the header):
 *   1. the `ITEM` proceeds breakdown — Amazon's own line subtotal;
 *   2. `unitPrice × quantityOrdered` — the same quantity arithmetic, derived;
 *   3. nothing. Never bare `unitPrice`: `upsertOrderItem` divides by quantity.
 */
export function lineTotalOf(item: OrderItem2026): { CurrencyCode: string; Amount: string } | undefined {
  const fromBreakdown = breakdownOf(item.proceeds?.breakdowns, 'ITEM')
  if (fromBreakdown) return fromBreakdown

  const unit = item.product?.price?.unitPrice
  const unitAmount = unit?.amount === undefined ? NaN : Number(unit.amount)
  const quantity = item.quantityOrdered
  if (!Number.isFinite(unitAmount) || !Number.isFinite(quantity as number) || (quantity as number) <= 0) return undefined
  return {
    CurrencyCode: unit?.currencyCode ?? '',
    Amount: (unitAmount * (quantity as number)).toFixed(2),
  }
}

/** One 2026-01-01 order item, in the v0 `getOrderItems` shape. */
export function toV0OrderItem(item: OrderItem2026): AmazonOrderItemRaw {
  return {
    ASIN: item.product?.asin ?? '',
    SellerSKU: item.product?.sellerSku,
    OrderItemId: item.orderItemId ?? '',
    Title: item.product?.title,
    QuantityOrdered: item.quantityOrdered ?? 0,
    QuantityShipped: item.fulfillment?.quantityFulfilled,
    ItemPrice: lineTotalOf(item),
    ShippingPrice: breakdownOf(item.proceeds?.breakdowns, 'SHIPPING'),
    ItemTax: breakdownOf(item.proceeds?.breakdowns, 'TAX'),
    PromotionDiscount: breakdownOf(item.proceeds?.breakdowns, 'DISCOUNT'),
  }
}

/** Every item on a 2026-01-01 order, in the v0 `getOrderItems` shape. */
export function toV0OrderItems(order: Order2026): AmazonOrderItemRaw[] {
  if (!Array.isArray(order.orderItems)) return []
  return order.orderItems.map(toV0OrderItem)
}

/**
 * Items that arrived attached to an order, keyed by order id.
 *
 * Orders 2026-01-01 has no `getOrderItems`: the items come with the order. The
 * ingest still calls `fetchOrderItems(orderId)` separately, so the items are
 * held here between the two calls rather than changing every caller. Bounded,
 * and entries are removed as they are read.
 */
const ordersItemsCache = new Map<string, AmazonOrderItemRaw[]>()
const ORDER_ITEMS_CACHE_LIMIT = 500

/**
 * One 2026-01-01 order, in the v0 `getOrders` / `getOrder` shape.
 *
 * A field is filled only when Amazon sent it. A section left out of
 * `includedData` is not the same as an empty one, and nothing here pretends
 * otherwise — an absent `fulfillment` gives no `OrderStatus`, not `'Pending'`.
 */
export function toV0Order(order: Order2026): AmazonOrderRaw {
  const status = order.fulfillment?.fulfillmentStatus
  const fulfilledBy = order.fulfillment?.fulfilledBy
  const programs = Array.isArray(order.programs) ? order.programs : undefined

  const shipped = order.orderItems?.reduce<number | undefined>((sum, item) => {
    const n = item?.fulfillment?.quantityFulfilled
    return typeof n === 'number' ? (sum ?? 0) + n : sum
  }, undefined)
  const unshipped = order.orderItems?.reduce<number | undefined>((sum, item) => {
    const n = item?.fulfillment?.quantityUnfulfilled
    return typeof n === 'number' ? (sum ?? 0) + n : sum
  }, undefined)

  const address = order.recipient?.deliveryAddress

  const raw: AmazonOrderRaw = {
    AmazonOrderId: order.orderId ?? '',
    PurchaseDate: order.createdTime ?? '',
    OrderStatus: status === undefined ? '' : (FULFILLMENT_STATUS_TO_V0[status] ?? status),
  }

  if (order.lastUpdatedTime !== undefined) raw.LastUpdateDate = order.lastUpdatedTime
  if (fulfilledBy !== undefined) raw.FulfillmentChannel = FULFILLED_BY_TO_V0[fulfilledBy] ?? fulfilledBy
  if (order.salesChannel?.channelName !== undefined) raw.SalesChannel = order.salesChannel.channelName
  if (order.salesChannel?.marketplaceId !== undefined) raw.MarketplaceId = order.salesChannel.marketplaceId

  const total = toV0Money(order.proceeds?.grandTotal)
  if (total) raw.OrderTotal = total

  if (shipped !== undefined) raw.NumberOfItemsShipped = shipped
  if (unshipped !== undefined) raw.NumberOfItemsUnshipped = unshipped
  if (order.fulfillment?.fulfillmentServiceLevel !== undefined) {
    raw.ShipmentServiceLevelCategory = order.fulfillment.fulfillmentServiceLevel
  }

  if (order.buyer) {
    const buyer: NonNullable<AmazonOrderRaw['BuyerInfo']> = {}
    if (order.buyer.buyerEmail !== undefined) buyer.BuyerEmail = order.buyer.buyerEmail
    if (order.buyer.buyerName !== undefined) buyer.BuyerName = order.buyer.buyerName
    if (Object.keys(buyer).length > 0) raw.BuyerInfo = buyer
  }

  if (address) {
    raw.ShippingAddress = {
      Name: address.name,
      AddressLine1: address.addressLine1,
      AddressLine2: address.addressLine2,
      AddressLine3: address.addressLine3,
      City: address.city,
      StateOrRegion: address.stateOrRegion,
      PostalCode: address.postalCode,
      CountryCode: address.countryCode,
      Phone: address.phone,
    }
  }

  if (order.fulfillment?.shipByWindow?.earliestDateTime !== undefined) {
    raw.EarliestShipDate = order.fulfillment.shipByWindow.earliestDateTime
  }
  if (order.fulfillment?.shipByWindow?.latestDateTime !== undefined) {
    raw.LatestShipDate = order.fulfillment.shipByWindow.latestDateTime
  }
  if (order.fulfillment?.deliverByWindow?.earliestDateTime !== undefined) {
    raw.EarliestDeliveryDate = order.fulfillment.deliverByWindow.earliestDateTime
  }
  if (order.fulfillment?.deliverByWindow?.latestDateTime !== undefined) {
    raw.LatestDeliveryDate = order.fulfillment.deliverByWindow.latestDateTime
  }

  // v0 sent these as booleans on every order; 2026-01-01 sends a list of
  // programs. An absent list is "not told" — leave the flag unset rather than
  // report false, which would read as "Amazon says this is not a Prime order".
  if (programs) {
    raw.IsBusinessOrder = programs.includes('AMAZON_BUSINESS')
    raw.IsPrime = programs.includes('PRIME')
  }

  return raw
}

/** Remember the items that came with an order, dropping the oldest when full. */
export function rememberOrderItems(orderId: string, items: AmazonOrderItemRaw[]): void {
  if (!orderId) return
  while (ordersItemsCache.size >= ORDER_ITEMS_CACHE_LIMIT) {
    const oldest = ordersItemsCache.keys().next().value
    if (oldest === undefined) break
    ordersItemsCache.delete(oldest)
  }
  ordersItemsCache.set(orderId, items)
}

/** Take the items that came with an order, if any. Returns null when unknown. */
export function takeOrderItems(orderId: string): AmazonOrderItemRaw[] | null {
  const hit = ordersItemsCache.get(orderId)
  if (!hit) return null
  ordersItemsCache.delete(orderId)
  return hit
}

/** Test seam: forget everything held between an order and its items. */
export function clearOrderItemsCache(): void {
  ordersItemsCache.clear()
}

/**
 * Every order in a `searchOrders` page, in the v0 shape, plus the next cursor.
 *
 * This is also where the page's items are held for the ingest's separate
 * `fetchOrderItems` call. `toV0Order` itself stays pure: a caller that only
 * wants the order — the reconciliation walk, which counts and sums — must not
 * quietly fill a cache the ingest then reads.
 */
export function toV0Page(response: SearchOrdersResponse2026 | undefined): {
  orders: AmazonOrderRaw[]
  nextToken: string | undefined
} {
  const page = Array.isArray(response?.orders) ? response!.orders : []
  const orders = page.map((order) => {
    const raw = toV0Order(order)
    const items = toV0OrderItems(order)
    if (raw.AmazonOrderId && items.length > 0) rememberOrderItems(raw.AmazonOrderId, items)
    return raw
  })
  return { orders, nextToken: response?.pagination?.nextToken }
}
