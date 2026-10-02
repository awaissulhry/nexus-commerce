/**
 * MCP full control 07 — order actions that reach outside Nexus and cannot be taken back: `cancel-order` (O10).
 *
 * Each runs the service the Nexus page runs, in the caller's business only, always waits for a person's approval in
 * Nexus (never auto, never confirm: irreversible), says in its preview per channel whether the action is live or a dry
 * run (from the switch the service itself reads), and refuses a run whose approval no longer describes the order.
 */

import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import prisma from '../../../db.js'
import { logger } from '../../../utils/logger.js'
import { amazonFulfilledRefusal } from '../../fulfillment/amazon-fulfilled-order.js'
import { cancelOrder, channelCancelMode } from '../../order-cancellation/cancel-order.service.js'
import { staleRefusal } from './stale-preview.js'
import { ownActiveAccounts, SYNC_NOW_CHANNELS, syncNowWindow, syncOrdersNow } from '../../orders/order-sync-now.service.js'
import { isOwnConnection } from '../../connection-resolver.service.js'
import type { AgentTool, ToolResult } from '../tool-types.js'

const toolLog = {
  warn: (...args: unknown[]) => logger.warn('[order actions]', { detail: String(args[1] ?? args[0]) }),
  error: (...args: unknown[]) => logger.error('[order actions]', { detail: String(args[1] ?? args[0]) }),
}

// ── cancel-order ────────────────────────────────────────────────────────────────────────────────────

const TOO_FAR = ['SHIPPED', 'DELIVERED', 'PARTIALLY_SHIPPED', 'RETURNED', 'REFUNDED']

const cancelInput = z.object({
  orderId: z.string().trim().min(1).max(64).describe('Nexus order id (from order-search)'),
  reason: z.string().trim().min(3).max(300).describe('why it is cancelled: kept in the audit log and sent to the channel where it takes one'),
})
type CancelArgs = z.infer<typeof cancelInput>

/** cancel-order's dry run: the order, what the cancel undoes in Nexus, and what the channel does (live or dry run). */
async function previewCancel(a: CancelArgs): Promise<ToolResult> {
  const order = await prisma.order.findFirst({
    where: { id: a.orderId, deletedAt: null },
    select: {
      id: true, channel: true, channelOrderId: true, marketplace: true, status: true, fulfillmentMethod: true, totalPrice: true, currencyCode: true,
      items: { select: { quantity: true } },
      shipments: { where: { status: { not: 'CANCELLED' } }, select: { status: true, sendcloudParcelId: true } },
    },
  })
  if (!order) return { ok: false, error: 'Order not found' }
  const which = `Order ${order.channelOrderId}`
  if (order.status === 'CANCELLED') return { ok: false, error: `${which} is already cancelled. Nothing was queued.` }
  if (TOO_FAR.includes(order.status)) return { ok: false, error: `${which} is ${order.status}: it is not cancelled (a shipped order is returned instead). Nothing was queued.` }
  if (await amazonFulfilledRefusal(prisma, order)) return { ok: false, error: `${which}: Amazon ships it (FBA or Multi-Channel Fulfilment); cancel it in Seller Central or on its MCF request. Nothing was queued.` }
  if (order.channel === 'AMAZON') {
    const { amazonMarketplaceIdFor } = await import('../../reviews/amazon-solicitations.service.js')
    if (!amazonMarketplaceIdFor(order.marketplace)) return { ok: false, error: `${which}: Nexus does not know the Amazon marketplace id of market "${order.marketplace ?? 'none'}"; cancel it in Seller Central. Nothing was queued.` }
  }
  return {
    ok: true,
    preview: {
      action: 'cancel-order',
      order: { id: order.id, channel: order.channel, marketplace: order.marketplace, channelOrderId: order.channelOrderId, status: order.status, totalPrice: Number(order.totalPrice), currencyCode: order.currencyCode },
      reason: a.reason,
      inNexus: {
        status: 'CANCELLED',
        unitsBackInStock: order.items.reduce((n, item) => n + item.quantity, 0),
        shipmentsCancelled: order.shipments.length,
        labelsVoided: order.shipments.filter((s) => s.sendcloudParcelId).length,
      },
      channelCancel: channelCancelMode(order.channel),
      note: 'Cancels the order in Nexus (its stock comes back, its shipments are cancelled and their labels voided) and on the channel when that is live; a channel cancel refunds the buyer. It cannot be undone.',
    },
  }
}

const cancelOrderTool: AgentTool = {
  name: 'cancel-order',
  title: 'Cancel an order',
  input: cancelInput,
  requires: [F.ordersCancel],
  category: 'orders',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  openWorld: true,
  reversibility: 'none',
  maxClaudeTrust: 'ask',
  description:
    'Cancel an order of this business that has not shipped: in Nexus (stock back, shipments cancelled, labels voided) '
    + 'and on its channel (Amazon, eBay, Shopify; live or a dry run, as the preview says — a live cancel refunds the '
    + 'buyer). Refused for a shipped, returned or refunded order and for an order Amazon ships. Always waits for a person '
    + 'to approve it in Nexus; it cannot be undone. If the order changes before the approval runs, nothing is cancelled.',
  handler: (args) => previewCancel(args as CancelArgs),
  async execute(args, ctx) {
    const a = args as CancelArgs
    const fresh = await previewCancel(a)
    if (!fresh.ok) return fresh
    const stale = staleRefusal(ctx.approvedPreview, fresh.preview, ['order', 'inNexus', 'channelCancel'], 'the order')
    if (stale) return { ok: false, error: stale }
    const before = (fresh.preview as { order: { status: string } }).order.status
    const answer = await cancelOrder(a.orderId, a.reason, toolLog)
    if (!answer.ok) return { ok: false, error: answer.body?.error ?? `not cancelled (${answer.status})` }
    const ack = answer.body.channelAck as { ok?: boolean; dryRun?: boolean; error?: string; ackRef?: string | null } | null
    return {
      ok: true,
      data: {
        orderId: a.orderId,
        status: 'CANCELLED',
        cleanup: answer.body.cleanup,
        channel: answer.body.channel,
        channelCancel: ack ? { ok: !!ack.ok, dryRun: !!ack.dryRun, error: ack.error ?? null } : null,
        channelPushbackPending: answer.body.channelPushbackPending,
      },
      change: { before: { orderId: a.orderId, status: before }, after: { orderId: a.orderId, status: 'CANCELLED' } },
    }
  },
}

// ── sync-orders-now (07 O17) ────────────────────────────────────────────────────────────────────────

const syncInput = z.object({
  channel: z.enum(SYNC_NOW_CHANNELS).describe('EBAY or AMAZON: read its new and changed orders now'),
  accountId: z.string().trim().min(1).max(64).optional().describe('one connected account of that channel (its id in Settings › Channels); omit for all of them'),
})
type SyncArgs = z.infer<typeof syncInput>

/** sync-orders-now's dry run: the channel's accounts in this business, and when it last ran. */
async function previewSync(a: SyncArgs): Promise<ToolResult> {
  let account: { id: string; externalAccountId: string | null; displayName: string | null } | null = null
  if (a.accountId) {
    const row = await prisma.channelConnection.findFirst({ where: { id: a.accountId }, select: { id: true, channelType: true, isActive: true, externalAccountId: true, displayName: true, workspaceId: true } })
    if (!row) return { ok: false, error: `Account not found: ${a.accountId}. Nothing was queued.` }
    if (!isOwnConnection(row)) return { ok: false, error: `Account ${a.accountId} is shared by another business, which syncs its orders. Nothing was queued.` }
    const name = row.displayName ?? row.externalAccountId ?? row.id
    if (row.channelType !== a.channel) return { ok: false, error: `Account ${name} is a ${row.channelType} account, not ${a.channel}. Nothing was queued.` }
    if (!row.isActive) return { ok: false, error: `Account ${name} is not active. Nothing was queued.` }
    account = { id: row.id, externalAccountId: row.externalAccountId, displayName: row.displayName }
  }
  const accounts = account ? 1 : (await ownActiveAccounts(a.channel)).length
  if (accounts === 0) return { ok: false, error: `No active ${a.channel} account is connected in this business. Nothing was queued.` }
  const window = await syncNowWindow(a.channel)
  if (window.nextAllowedAt) return { ok: false, error: `${a.channel} orders were synced at ${window.lastRunAt!.toISOString().slice(11, 16)} UTC; the next sync now is allowed from ${window.nextAllowedAt.toISOString().slice(11, 16)} UTC (once every 10 minutes). Nothing was queued.` }
  return {
    ok: true,
    preview: {
      action: 'sync-orders-now',
      channel: a.channel,
      accounts,
      account,
      lastRunAt: window.lastRunAt?.toISOString() ?? null,
      note: `Reads new and changed ${a.channel} orders now, as the order schedule does; new orders take their stock. Once per channel every 10 minutes.`,
    },
  }
}

const syncOrdersNowTool: AgentTool = {
  name: 'sync-orders-now',
  title: 'Sync orders now',
  input: syncInput,
  requires: [F.ordersEdit],
  category: 'orders',
  riskTier: 'low',
  readOnly: false,
  requiresApprovalDefault: true,
  openWorld: true,
  reversibility: 'none',
  maxClaudeTrust: 'ask',
  description:
    'Read the new and changed orders of one channel of this business now (AMAZON or EBAY), as the order schedule does: '
    + 'new orders come into Nexus and take their stock. At most once per channel every 10 minutes. Waits for a person to '
    + 'approve it in Nexus; orders read in are not taken back.',
  handler: (args) => previewSync(args as SyncArgs),
  async execute(args, ctx) {
    const a = args as SyncArgs
    const fresh = await previewSync(a)
    if (!fresh.ok) return fresh
    const stale = staleRefusal(ctx.approvedPreview, fresh.preview, ['channel', 'accounts', 'account'], 'the channel')
    if (stale) return { ok: false, error: stale }
    const result = await syncOrdersNow(a.channel, { userId: ctx.userId ?? null, via: ctx.via }, a.accountId)
    if (result.ok === false) return { ok: false, error: result.error }
    return {
      ok: true,
      data: result,
      change: { before: { channel: a.channel }, after: { channel: a.channel, ordersCreatedOrUpdated: result.ordersCreatedOrUpdated } },
    }
  },
}

export const ORDER_ACTION_TOOLS: AgentTool[] = [cancelOrderTool, syncOrdersNowTool]
