/**
 * Shopify fulfilments and stock (re-review of 2026-09-26, stock model C1). Used by the Shopify order
 * webhooks (routes/shopify-webhooks.ts): orders/create, orders/updated and fulfillments/create.
 */
import prisma from '../../db.js'
import { addAfter, afterOrderHoldsCommit, consumeOpenOrderInTx, nothingAfter, takeShippedUnitsInTx } from '../stock-level.service.js'
import { shopifyFulfilledUnits } from '../order-cancellation/index.js'

const jsonObject = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** An order payload keeps every fulfilment Nexus has recorded (by id), also one an older payload lacks. */
export function withRecordedFulfilments(previous: unknown, incoming: Record<string, unknown>): Record<string, unknown> {
  const kept = jsonObject(previous)?.fulfillments;
  const now = Array.isArray(incoming.fulfillments) ? incoming.fulfillments : [];
  if (!Array.isArray(kept) || kept.length === 0) return incoming;
  const ids = new Set(now.map((f) => String(jsonObject(f)?.id ?? '')));
  const missing = kept.filter((f) => !ids.has(String(jsonObject(f)?.id ?? '')));
  return missing.length ? { ...incoming, fulfillments: [...now, ...missing] } : incoming;
}

/**
 * Re-review (2026-09-26) — C1 for Shopify's real sequence. Each fulfilment (the fulfilments/create
 * webhook, or the fulfilments an orders/create or orders/updated payload lists) takes out only the
 * units it fulfilled, line by line; the rest stays held. The order is PARTIALLY_SHIPPED until every
 * line is fulfilled, then SHIPPED (and whatever is still held is taken, as before). One transaction:
 * the order row, then the order-stock lock door (with the order reference); a duplicate delivery finds
 * its fulfilment recorded and its units taken, and takes nothing. A cancelled or refunded order is the
 * cancellation's to settle: its fulfilment is recorded, no stock moves here.
 */
export async function applyShopifyFulfilments(orderId: string, opts: { fulfilment?: Record<string, unknown>; actor: string }): Promise<void> {
  const after = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${orderId} FOR NO KEY UPDATE`;
    const order = await tx.order.findUnique({ where: { id: orderId }, select: { status: true, shippedAt: true, shopifyMetadata: true,
      items: { select: { productId: true, quantity: true, externalLineItemId: true } } } });
    if (!order) return nothingAfter();
    let metadata = (jsonObject(order.shopifyMetadata) ?? {}) as Record<string, unknown>;
    if (opts.fulfilment?.id != null) {
      const record = { id: opts.fulfilment.id, status: opts.fulfilment.status ?? 'success', created_at: opts.fulfilment.created_at ?? null,
        line_items: (Array.isArray(opts.fulfilment.line_items) ? opts.fulfilment.line_items : []).map((line) => ({ id: jsonObject(line)?.id, quantity: jsonObject(line)?.quantity })) };
      const others = (Array.isArray(metadata.fulfillments) ? metadata.fulfillments : []).filter((f) => String(jsonObject(f)?.id ?? '') !== String(record.id));
      metadata = { ...metadata, fulfillments: [...others, record] };
      await tx.order.update({ where: { id: orderId }, data: { shopifyMetadata: metadata as object } });
    }
    if (['CANCELLED', 'REFUNDED', 'RETURNED'].includes(order.status)) return nothingAfter();
    const fulfilled = shopifyFulfilledUnits(metadata) ?? new Map<string, number>();
    const shipped = new Map<string, number>();
    let any = false;
    let all = true;
    for (const item of order.items) {
      if (!(item.quantity > 0)) continue;
      const units = Math.min(fulfilled.get(item.externalLineItemId ?? '') ?? 0, item.quantity);
      if (units > 0) any = true;
      if (units < item.quantity) all = false;
      if (item.productId && units > 0) shipped.set(item.productId, (shipped.get(item.productId) ?? 0) + units);
    }
    if (!any) return nothingAfter();
    const held = await tx.stockReservation.findMany({ where: { orderId, releasedAt: null, consumedAt: null }, select: { stockLevel: { select: { productId: true } } } });
    const products = [...new Set([...order.items.flatMap((item) => (item.productId ? [item.productId] : [])), ...held.map((hold) => hold.stockLevel.productId)])];
    await tx.$executeRaw`SELECT nexus_lock_order_stock(${products}::text[], ${orderId})`;
    const taken = await takeShippedUnitsInTx(tx, { orderId, shipped, actor: opts.actor });
    if (all) addAfter(taken.after, (await consumeOpenOrderInTx(tx, { orderId, actor: opts.actor })).after);
    const status = all ? 'SHIPPED' : 'PARTIALLY_SHIPPED';
    const settledStatus = order.status === 'SHIPPED' || order.status === 'DELIVERED' || order.status === status;
    if (!settledStatus || !order.shippedAt) {
      await tx.order.update({ where: { id: orderId }, data: { ...(settledStatus ? {} : { status }), ...(order.shippedAt ? {} : { shippedAt: new Date() }) } });
    }
    return taken.after;
  }, { isolationLevel: 'ReadCommitted', maxWait: 5_000, timeout: 30_000 });
  await afterOrderHoldsCommit(after);
}
