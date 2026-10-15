/**
 * Google Ads programme 2, G8a (2026-10-15) — what sending sales to Google reads from Nexus: the business's own Shopify
 * orders, and what Nexus sent to Google before (its own change records). Both through the workspace-scoped client
 * (db.ts): only THIS business's rows, never another business's orders.
 *
 *   - Orders: Order rows of channel SHOPIFY, not in the recycle bin, by the day of the sale (purchaseDate, else the day
 *     Nexus took the order in) or by id (Shopify's order id or Nexus's). Order.shopifyMetadata is Shopify's order webhook
 *     body (routes/shopify-webhooks.ts handleOrderCreate): landing_site, note_attributes, current totals, phone.
 *   - Sent before: AgentChange rows of upload-google-sales (each `after.sent`: the sales Google took, by Shopify order id)
 *     and adjust-google-sales (`after.retracted`, `after.restated`) on the SAME Google Ads account (`after.customerId`).
 *     An upload is never undone in Google by an undo of the record (a retraction is), so every upload row counts.
 */
import prisma from '../../../db.js'
import type { UploadOrder } from './conversion-upload.js'

/** The tool names whose records say what Nexus sent to Google (agents/tools/google-ads-conversions.tools.ts). */
export const UPLOAD_TOOL = 'upload-google-sales'
export const ADJUST_TOOL = 'adjust-google-sales'

/** At most this many orders are read for one upload: more is refused (send fewer days at a time). */
export const MAX_ORDERS_READ = 2000
const DAY_MS = 86_400_000

const ORDER_SELECT = {
  id: true, channelOrderId: true, status: true, purchaseDate: true, createdAt: true, totalPrice: true, currencyCode: true,
  customerEmail: true, shopifyMetadata: true,
} as const

type OrderRow = {
  id: string; channelOrderId: string; status: string; purchaseDate: Date | null; createdAt: Date; totalPrice: unknown; currencyCode: string | null
  customerEmail: string; shopifyMetadata: unknown
}

const uploadOrderOf = (o: OrderRow): UploadOrder => ({
  orderId: o.id,
  shopifyOrderId: o.channelOrderId,
  status: o.status,
  purchaseDate: o.purchaseDate,
  createdAt: o.createdAt,
  totalCents: Math.round(Number(o.totalPrice) * 100),
  currency: o.currencyCode,
  email: o.customerEmail || null,
  metadata: o.shopifyMetadata,
})

/**
 * The business's Shopify orders of the days `from`..`to` (YYYY-MM-DD, UTC, both included), or the ones named (Shopify's
 * or Nexus's order ids). `tooMany` when there are more than MAX_ORDERS_READ: nothing is guessed, the caller refuses.
 */
export async function shopifyOrdersForUpload(q: { from?: string; to?: string; orderIds?: string[] }): Promise<{ orders: UploadOrder[]; tooMany: boolean }> {
  const ids = [...new Set(q.orderIds ?? [])]
  const where = ids.length
    ? { channel: 'SHOPIFY' as const, deletedAt: null, OR: [{ channelOrderId: { in: ids } }, { id: { in: ids } }] }
    : (() => {
      const gte = new Date(`${q.from}T00:00:00Z`)
      const lt = new Date(Date.parse(`${q.to}T00:00:00Z`) + DAY_MS)
      return { channel: 'SHOPIFY' as const, deletedAt: null, OR: [{ purchaseDate: { gte, lt } }, { purchaseDate: null, createdAt: { gte, lt } }] }
    })()
  const rows = await prisma.order.findMany({ where, select: ORDER_SELECT, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: MAX_ORDERS_READ + 1 }) as OrderRow[]
  return { orders: rows.slice(0, MAX_ORDERS_READ).map(uploadOrderOf), tooMany: rows.length > MAX_ORDERS_READ }
}

/** The business's Shopify orders by Shopify order id (the ones an adjustment names). */
export async function shopifyOrdersById(shopifyOrderIds: string[]): Promise<Map<string, UploadOrder>> {
  const ids = [...new Set(shopifyOrderIds)]
  if (!ids.length) return new Map()
  const rows = await prisma.order.findMany({ where: { channel: 'SHOPIFY', deletedAt: null, channelOrderId: { in: ids } }, select: ORDER_SELECT }) as OrderRow[]
  return new Map(rows.map((o) => [o.channelOrderId, uploadOrderOf(o)]))
}

/** What Nexus sent to one Google Ads account before, from its own change records. */
export interface NexusSales {
  /** Shopify order id → the conversion action it was sent to (an order is sent once, to one action). */
  sent: Map<string, string>
  /** `${conversionActionId}:${orderId}` of every sale Nexus retracted. */
  retracted: Set<string>
  /** `${conversionActionId}:${orderId}` → the last value Nexus gave Google (the value sent, or the last restatement). */
  value: Map<string, { valueCents: number; currency: string }>
}

type Rec = Record<string, unknown>
const rec = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {})
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

/** Every upload and adjustment Nexus recorded for this Google Ads account, oldest first. */
export async function nexusSales(customerId: string): Promise<NexusSales> {
  const rows = await prisma.agentChange.findMany({
    where: { toolName: { in: [UPLOAD_TOOL, ADJUST_TOOL] }, after: { path: ['customerId'], equals: customerId } },
    orderBy: [{ executedAt: 'asc' }, { id: 'asc' }],
    select: { toolName: true, after: true },
  })
  const out: NexusSales = { sent: new Map(), retracted: new Set(), value: new Map() }
  for (const row of rows) {
    const after = rec(row.after)
    const action = typeof after.conversionActionId === 'string' ? after.conversionActionId : null
    if (!action) continue
    if (row.toolName === UPLOAD_TOOL) {
      for (const s of arr(after.sent).map(rec)) {
        if (typeof s.orderId !== 'string') continue
        if (!out.sent.has(s.orderId)) out.sent.set(s.orderId, action)
        if (typeof s.valueCents === 'number' && typeof s.currency === 'string') out.value.set(`${action}:${s.orderId}`, { valueCents: s.valueCents, currency: s.currency })
      }
    } else {
      for (const id of arr(after.retracted)) if (typeof id === 'string') out.retracted.add(`${action}:${id}`)
      for (const r of arr(after.restated).map(rec)) {
        if (typeof r.orderId === 'string' && typeof r.valueCents === 'number' && typeof r.currency === 'string') out.value.set(`${action}:${r.orderId}`, { valueCents: r.valueCents, currency: r.currency })
      }
    }
  }
  return out
}
