/**
 * P1.4b (docs/channel-connections/FINAL-PLAN.md) — Shopify order actions (refund, cancel, tracking) on
 * the 2026-07 GraphQL client with the ORDER's own account. They replace the env-credential
 * `ShopifyEnhancedService` paths, which wrote with a token of no named account and sent operations the
 * API no longer has: `orderCancel(input:)`, `fulfillmentCreate(input: { orderId, lineItemsToFulfill })`,
 * and refund transactions without their `gateway`.
 *
 * Each caller keeps its own switch (P0.1: an order action is not a listing write, so the listing
 * publish mode does not apply). A refusal or a Shopify error throws one plain sentence.
 */
import prisma from '../../db.js'
import { listActiveConnections } from '../connection-resolver.service.js'
import { idempotencyKeyFor } from '../gateway/gateway.js'
import { shopifyAdmin, assertShopifyResult as checked } from './admin-client.js'

export const shopifyOrderGid = (id: string) => (id.startsWith('gid://') ? id : `gid://shopify/Order/${id}`)

/**
 * The Shopify account of an order: the one recorded on it; for an order from before accounts were
 * recorded, the only connected Shopify account. With two or more and none recorded: refused — never
 * "the primary".
 */
export async function shopifyOrderAccount(scope: { orderId: string } | { channelOrderId: string }): Promise<string> {
  const order = 'orderId' in scope
    ? await prisma.order.findUnique({ where: { id: scope.orderId }, select: { channel: true, channelConnectionId: true } })
    : await prisma.order.findFirst({ where: { channel: 'SHOPIFY', channelOrderId: scope.channelOrderId }, select: { channel: true, channelConnectionId: true } })
  if (!order) throw new Error('This Shopify order is not in Nexus. Nothing was sent.')
  if (String(order.channel) !== 'SHOPIFY') throw new Error('This order is not a Shopify order. Nothing was sent.')
  if (order.channelConnectionId) return order.channelConnectionId
  const active = await listActiveConnections('SHOPIFY')
  if (active.length === 1) return active[0].id
  throw new Error(active.length === 0
    ? 'No Shopify account is connected. Nothing was sent.'
    : 'This order does not record its Shopify account, and more than one Shopify account is connected. Nothing was sent.')
}

const TRANSACTIONS = `query NexusOrderTransactions($id: ID!) { order(id: $id) { id currencyCode transactions(first: 20) { id kind status gateway amountSet { shopMoney { amount currencyCode } } } } }`

/**
 * Refund `amount` against the order's captured payments, in proportion. `refundCreate` carries
 * `@idempotent(key)` (required since 2026-04): the same return and amount give the same key, so a retry
 * returns the first refund instead of paying twice.
 */
export async function refundShopifyOrder(input: { accountId: string; channelOrderId: string; returnId: string; amount: string; note: string }): Promise<{ refundId: string | null }> {
  const { graphql } = await shopifyAdmin(input.accountId)
  const orderId = shopifyOrderGid(input.channelOrderId)
  const order = (await graphql(TRANSACTIONS, { id: orderId })).order
  if (!order) throw new Error('Shopify does not know this order on the connected account. Nothing was refunded.')
  const refundable = (order.transactions ?? []).filter((tx: any) => (tx.kind === 'CAPTURE' || tx.kind === 'SALE') && tx.status === 'SUCCESS')
  if (!refundable.length) throw new Error('Shopify order has no refundable capture or sale transaction.')
  const captured = refundable.reduce((sum: number, tx: any) => sum + Number(tx.amountSet.shopMoney.amount), 0)
  if (!(captured > 0)) throw new Error('Shopify captured total is zero; nothing to refund against.')
  const total = Number(input.amount)
  if (!(total > 0) || total > captured) throw new Error(`The refund of ${input.amount} is not between 0 and the captured ${captured.toFixed(2)}.`)
  // Proportional shares in cents; the last transaction takes the rounding rest, so the parts add up.
  const cents = Math.round(total * 100)
  let given = 0
  const transactions = refundable.map((tx: any, i: number) => {
    const share = i === refundable.length - 1 ? cents - given : Math.floor((cents * Number(tx.amountSet.shopMoney.amount)) / captured)
    given += share
    return { orderId, parentId: tx.id, gateway: tx.gateway, kind: 'REFUND', amount: (share / 100).toFixed(2) }
  })
  const result = checked((await graphql(`mutation NexusRefundCreate($input: RefundInput!, $key: String!) { refundCreate(input: $input) @idempotent(key: $key) { refund { id legacyResourceId } userErrors { field message } } }`, {
    key: idempotencyKeyFor('shopify-refund', input.returnId, orderId, cents),
    input: { orderId, note: input.note.slice(0, 500), notify: true, transactions },
  })).refundCreate, 'Shopify refund')
  return { refundId: result.refund?.id ?? null }
}

const CANCEL_REASONS = ['CUSTOMER', 'DECLINED', 'FRAUD', 'INVENTORY', 'STAFF', 'OTHER'] as const
export type ShopifyCancelReason = typeof CANCEL_REASONS[number]

/**
 * Cancel the order on Shopify without a refund and without a restock (the operator refunds separately;
 * Nexus already restocked). Returns Shopify's cancellation job id.
 */
export async function cancelShopifyOrder(input: { accountId: string; channelOrderId: string; reason: ShopifyCancelReason; staffNote: string }): Promise<{ jobId: string | null }> {
  const { graphql } = await shopifyAdmin(input.accountId)
  const result = await graphql(`mutation NexusOrderCancel($orderId: ID!, $reason: OrderCancelReason!, $restock: Boolean!, $notifyCustomer: Boolean, $staffNote: String, $refundMethod: OrderCancelRefundMethodInput) { orderCancel(orderId: $orderId, reason: $reason, restock: $restock, notifyCustomer: $notifyCustomer, staffNote: $staffNote, refundMethod: $refundMethod) { job { id done } orderCancelUserErrors { field message code } } }`, {
    orderId: shopifyOrderGid(input.channelOrderId),
    reason: CANCEL_REASONS.includes(input.reason) ? input.reason : 'OTHER',
    restock: false,
    notifyCustomer: true,
    staffNote: input.staffNote.slice(0, 255),
    refundMethod: { originalPaymentMethodsRefund: false },
  })
  const errors = result.orderCancel?.orderCancelUserErrors ?? []
  if (!result.orderCancel) throw new Error('Shopify cancel returned no result.')
  if (errors.length) throw new Error(`Shopify cancel: ${errors.map((e: any) => `${e.field?.join('.') ?? ''} ${e.message}`.trim()).join('; ')}`)
  return { jobId: result.orderCancel.job?.id ?? null }
}

const FULFILLMENT_ORDERS = `query NexusFulfillmentOrders($id: ID!) { order(id: $id) { id fulfillmentOrders(first: 20) { nodes { id status supportedActions { action } } } fulfillments(first: 50) { id trackingInfo(first: 10) { number } } } }`

/**
 * Mark the order shipped with its tracking: one fulfilment for every fulfilment order Shopify can still
 * fulfil. A retry after a lost answer finds the tracking number already on the order and reports it,
 * instead of failing or fulfilling twice.
 */
export async function fulfilShopifyOrder(input: { accountId: string; channelOrderId: string; tracking: { number: string; company?: string | null; url?: string | null } }): Promise<{ fulfillmentId: string | null; alreadyThere: boolean }> {
  const { graphql } = await shopifyAdmin(input.accountId)
  const order = (await graphql(FULFILLMENT_ORDERS, { id: shopifyOrderGid(input.channelOrderId) })).order
  if (!order) throw new Error('Shopify does not know this order on the connected account. Nothing was sent.')
  const existing = (order.fulfillments ?? []).find((f: any) => (f.trackingInfo ?? []).some((t: any) => t.number === input.tracking.number))
  if (existing) return { fulfillmentId: existing.id, alreadyThere: true }
  const open = (order.fulfillmentOrders?.nodes ?? []).filter((fo: any) => (fo.supportedActions ?? []).some((a: any) => a.action === 'CREATE_FULFILLMENT'))
  if (!open.length) throw new Error('This Shopify order has nothing left to fulfil, and its fulfilments do not carry this tracking number.')
  const trackingInfo: Record<string, string> = { number: input.tracking.number }
  if (input.tracking.company) trackingInfo.company = input.tracking.company
  if (input.tracking.url) trackingInfo.url = input.tracking.url
  const result = checked((await graphql(`mutation NexusFulfillmentCreate($fulfillment: FulfillmentInput!) { fulfillmentCreate(fulfillment: $fulfillment) { fulfillment { id status trackingInfo(first: 10) { number company url } } userErrors { field message } } }`, {
    fulfillment: { notifyCustomer: true, trackingInfo, lineItemsByFulfillmentOrder: open.map((fo: any) => ({ fulfillmentOrderId: fo.id })) },
  })).fulfillmentCreate, 'Shopify fulfilment')
  return { fulfillmentId: result.fulfillment?.id ?? null, alreadyThere: false }
}
