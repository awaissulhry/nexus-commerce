/**
 * ACP.1 / ACP.3b — mutating tools (HIGH risk, alwaysAsk).
 *
 * `handler` is always a dry-run preview (no side effects). `execute` is
 * the real action and runs ONLY after a human approves it through the
 * gate (approval-gate.service.ts) — `alwaysAsk` is a hard floor the
 * policy layer can never downgrade.
 *
 * Phase 3b wires execute() for all three high-stakes tools, and each one
 * routes through the SAME governed service the rest of the app uses, so
 * it INHERITS that service's safety gate rather than bypassing it:
 *   set-price            → masterPriceService.update() (reversible; the
 *                          channel push is enqueued + gated downstream)
 *   publish-listing      → enqueue LISTING_SYNC on OutboundSyncQueue →
 *                          the existing gated worker (default non-live:
 *                          getAmazonPublishMode() is 'gated'/'dry-run'
 *                          unless explicitly enabled)
 *   send-customer-message→ sendEmail() (dry-run unless
 *                          NEXUS_ENABLE_OUTBOUND_EMAILS=true) + GDPR
 *                          suppression check
 */

import { Prisma } from '@nexus/database'
import prisma from '../../../db.js'
import { outboundSyncQueue } from '../../../lib/queue.js'
import { logger } from '../../../utils/logger.js'
import { masterPriceService } from '../../master-price.service.js'
import { getAmazonPublishMode } from '../../amazon-publish-gate.service.js'
import { isEmailSuppressed } from '../../reviews/email-suppression.service.js'
import { sendEmail } from '../../email/transport.js'
import type { AgentTool } from '../tool-types.js'

const SUPPRESSION_CHANNEL = 'agent-customer-message'

/** Best-effort resolved publish mode for the operator to see before
 *  approving. Amazon is resolved precisely; the others default non-live
 *  per the same publish-gate pattern. */
function publishModeFor(channel: string): string {
  if (channel === 'AMAZON') return getAmazonPublishMode()
  return 'gated/dry-run by default (live only if the channel is explicitly enabled)'
}

const setPrice: AgentTool = {
  name: 'set-price',
  category: 'pricing',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  description:
    'Change a product master price (cascades to channels per their pricing rules; channel push is gated). Requires approval.',
  async handler(args) {
    const id = String(args.productId ?? '')
    const proposed = Number(args.price)
    if (!id || !Number.isFinite(proposed))
      return { ok: false, error: 'productId and numeric price are required' }
    if (proposed < 0) return { ok: false, error: 'price must be non-negative' }
    const p = await prisma.product.findUnique({
      where: { id },
      select: { sku: true, basePrice: true },
    })
    if (!p) return { ok: false, error: 'Product not found' }
    const current = p.basePrice != null ? Number(p.basePrice) : null
    return {
      ok: true,
      preview: {
        action: 'set-price',
        sku: p.sku,
        scope: 'master',
        changes: {
          'base price': { from: current, to: proposed },
        },
        deltaPct:
          current ? Math.round(((proposed - current) / current) * 1000) / 10 : null,
        note: 'Sets the master price and cascades to channel listings; each channel push is gated (default non-live). Reversible.',
      },
    }
  },
  // ACP.3b — real master-price write through the canonical service:
  // transactional cascade + audit + gated outbound push. Reversible: the
  // undo snapshot carries the prior base price.
  async execute(args, ctx) {
    const id = String(args.productId ?? '')
    const proposed = Number(args.price)
    if (!id || !Number.isFinite(proposed) || proposed < 0)
      return { ok: false, error: 'productId and a non-negative numeric price are required' }
    const before = await prisma.product.findUnique({
      where: { id },
      select: { sku: true, basePrice: true },
    })
    if (!before) return { ok: false, error: 'Product not found' }
    const oldBasePrice = before.basePrice != null ? Number(before.basePrice) : null
    const res = await masterPriceService.update(id, proposed, {
      actor: ctx.userId ?? null,
      reason: 'agent:set-price',
    })
    return {
      ok: true,
      data: {
        sku: before.sku,
        changed: res.changed,
        oldPrice: res.oldBasePrice,
        newPrice: res.newBasePrice,
        cascadedListingIds: res.cascadedListingIds,
        queuedSyncIds: res.queuedSyncIds,
        undo: { price: oldBasePrice },
      },
    }
  },
}

const publishListing: AgentTool = {
  name: 'publish-listing',
  category: 'listings',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  description:
    'Publish / re-sync a channel listing through the gated publish pipeline (default non-live). Requires approval.',
  async handler(args) {
    const id = String(args.productId ?? '')
    const channel = String(args.channel ?? '').toUpperCase()
    if (!id || !channel)
      return { ok: false, error: 'productId and channel are required' }
    const cl = await prisma.channelListing.findFirst({
      where: { productId: id, channel },
      select: { title: true, externalListingId: true },
    })
    return {
      ok: true,
      preview: {
        action: 'publish-listing',
        channel,
        currentlyPublished: !!cl?.externalListingId,
        title: cl?.title ?? null,
        publishMode: publishModeFor(channel),
        note: 'Queues a publish through the existing gated worker; the per-channel mode is live only if explicitly enabled (default non-live).',
      },
    }
  },
  // ACP.3b — does NOT push to the marketplace directly. It enqueues a
  // LISTING_SYNC on OutboundSyncQueue so the publish flows through the
  // SAME gated worker (publish-mode gate + circuit breaker + rate limit +
  // audit) every other publish uses. Safe by default: the gate resolves
  // to 'gated'/'dry-run' unless the channel is explicitly enabled live.
  async execute(args, ctx) {
    const id = String(args.productId ?? '')
    const channel = String(args.channel ?? '').toUpperCase()
    if (!id || !channel)
      return { ok: false, error: 'productId and channel are required' }
    const cl = await prisma.channelListing.findFirst({
      where: { productId: id, channel },
      select: { id: true, region: true, marketplace: true, externalListingId: true },
    })
    if (!cl)
      return { ok: false, error: `no ${channel} listing exists for this product` }
    const row = await prisma.outboundSyncQueue.create({
      data: {
        productId: id,
        channelListingId: cl.id,
        targetChannel: channel as any,
        targetRegion: cl.region ?? cl.marketplace,
        syncStatus: 'PENDING' as any,
        syncType: 'LISTING_SYNC',
        externalListingId: cl.externalListingId,
        payload: {
          source: 'AGENT_PUBLISH',
          productId: id,
          channel,
          marketplace: cl.marketplace,
          requestedBy: ctx.userId ?? null,
        } as Prisma.InputJsonValue,
      },
      select: { id: true },
    })
    try {
      await outboundSyncQueue.add(
        'sync-job',
        { queueId: row.id, productId: id, syncType: 'LISTING_SYNC', source: 'AGENT_PUBLISH' },
        { jobId: row.id },
      )
    } catch (err) {
      logger.warn(
        'publish-listing: BullMQ enqueue failed (DB row stays PENDING for the next drain)',
        { queueId: row.id, productId: id, err: err instanceof Error ? err.message : String(err) },
      )
    }
    return {
      ok: true,
      data: {
        channel,
        queueId: row.id,
        publishMode: publishModeFor(channel),
        note: 'Queued through the gated publish pipeline; the worker resolves the per-channel mode (live only if explicitly enabled).',
      },
    }
  },
}

const sendCustomerMessage: AgentTool = {
  name: 'send-customer-message',
  category: 'comms',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  description:
    'Email a customer about their order (dry-run unless outbound email is enabled; GDPR-suppression honored). Requires approval.',
  async handler(args) {
    const orderId = String(args.orderId ?? '')
    const message = String(args.message ?? '').trim()
    if (!orderId || !message)
      return { ok: false, error: 'orderId and message are required' }
    const o = await prisma.order.findUnique({
      where: { id: orderId },
      select: { customerName: true, customerEmail: true, marketplace: true },
    })
    if (!o) return { ok: false, error: 'Order not found' }
    const suppressed = o.customerEmail
      ? (await isEmailSuppressed(o.customerEmail, SUPPRESSION_CHANNEL)).suppressed
      : false
    return {
      ok: true,
      preview: {
        action: 'send-customer-message',
        to: o.customerName,
        emailOnFile: !!o.customerEmail,
        marketplace: o.marketplace,
        message,
        suppressed,
        marketplaceWarning: marketplaceCommsWarning(o.marketplace),
        note: emailIsLive()
          ? 'Outbound email is ENABLED — approving will send a real email (irreversible).'
          : 'Outbound email is in dry-run — approving records the send without delivering. Suppressed recipients are never emailed.',
      },
    }
  },
  // ACP.3b — routes through the shared sendEmail() transport, which is
  // dry-run unless NEXUS_ENABLE_OUTBOUND_EMAILS=true. GDPR suppression is
  // enforced here (we never email a suppressed address, even when live).
  // Irreversible when live — that is exactly why it is alwaysAsk.
  async execute(args) {
    const orderId = String(args.orderId ?? '')
    const message = String(args.message ?? '').trim()
    if (!orderId || !message)
      return { ok: false, error: 'orderId and message are required' }
    const o = await prisma.order.findUnique({
      where: { id: orderId },
      select: { customerName: true, customerEmail: true, marketplace: true },
    })
    if (!o) return { ok: false, error: 'Order not found' }
    if (!o.customerEmail)
      return { ok: false, error: 'order has no customer email on file' }
    const sup = await isEmailSuppressed(o.customerEmail, SUPPRESSION_CHANNEL)
    if (sup.suppressed)
      return {
        ok: false,
        error: `recipient is suppressed (${sup.source ?? 'opt-out'}) — not sending`,
      }
    const name = o.customerName || 'cliente'
    const subject = 'Un messaggio sul tuo ordine Xavia'
    const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f8fafc;">
<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f8fafc;padding:32px 16px;"><tr><td align="center">
<table cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:560px;background:#fff;border-radius:8px;border:1px solid #e2e8f0;padding:32px;font-family:Inter,-apple-system,sans-serif;color:#0f172a;"><tr><td>
<div style="font-size:22px;font-weight:700;margin-bottom:24px;">Xavia</div>
<p style="font-size:16px;margin:0 0 12px 0;">Ciao ${name},</p>
<p style="font-size:16px;margin:0 0 20px 0;white-space:pre-wrap;">${escapeHtml(message)}</p>
<p style="font-size:11px;color:#94a3b8;margin-top:24px;">Per dubbi, scrivi a <a href="mailto:support@xavia.it" style="color:#2563eb;">support@xavia.it</a>.</p>
</td></tr></table></td></tr></table></body></html>`
    const text = `Ciao ${name},\n\n${message}\n\n— Xavia`
    const res = await sendEmail({
      to: o.customerEmail,
      subject,
      html,
      text,
      tag: SUPPRESSION_CHANNEL,
    })
    if (!res.ok) return { ok: false, error: res.error ?? 'email send failed' }
    return {
      ok: true,
      data: {
        to: o.customerEmail,
        delivered: !res.dryRun,
        dryRun: res.dryRun,
        provider: res.provider,
        messageId: res.messageId ?? null,
        marketplaceWarning: marketplaceCommsWarning(o.marketplace),
      },
    }
  },
}

function emailIsLive(): boolean {
  return process.env.NEXUS_ENABLE_OUTBOUND_EMAILS === 'true'
}

/** Amazon/eBay require buyer contact through their own messaging systems;
 *  direct email can breach marketplace policy. Surfaced (not blocked) so
 *  the approver decides. */
function marketplaceCommsWarning(marketplace: string | null): string | null {
  const m = (marketplace ?? '').toLowerCase()
  if (m.includes('amazon'))
    return 'Amazon orders: contact buyers via Amazon Buyer-Seller Messaging, not direct email (policy).'
  if (m.includes('ebay'))
    return 'eBay orders: contact buyers via eBay Messages, not direct email (policy).'
  return null
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// apply-content — the reversible "copilot fixes the listing" action:
// writes drafted title / bullets / description to the MASTER product (not
// live to any channel). Medium tier but routed through the approval gate
// (requiresApprovalDefault) so the loop is proven on a safe action.
const applyContent: AgentTool = {
  name: 'apply-content',
  category: 'products',
  riskTier: 'medium',
  readOnly: false,
  requiresApprovalDefault: true,
  description:
    'Apply a drafted title / bullet points / description to the master product (reversible; requires approval).',
  async handler(args) {
    const id = String(args.productId ?? '')
    if (!id) return { ok: false, error: 'productId is required' }
    const p = await prisma.product.findUnique({
      where: { id },
      select: { name: true, bulletPoints: true, description: true },
    })
    if (!p) return { ok: false, error: 'Product not found' }
    const changes: Record<string, { from: unknown; to: unknown }> = {}
    if (args.title != null) changes.title = { from: p.name, to: String(args.title) }
    if (Array.isArray(args.bulletPoints))
      changes.bulletPoints = {
        from: p.bulletPoints,
        to: (args.bulletPoints as unknown[]).map(String),
      }
    if (args.description != null)
      changes.description = { from: p.description, to: String(args.description) }
    if (Object.keys(changes).length === 0)
      return {
        ok: false,
        error: 'nothing to apply (title / bulletPoints / description)',
      }
    return {
      ok: true,
      preview: {
        action: 'apply-content',
        productId: id,
        changes,
        note: 'Reversible master-content edit; requires approval to apply.',
      },
    }
  },
  async execute(args) {
    const id = String(args.productId ?? '')
    if (!id) return { ok: false, error: 'productId is required' }
    const p = await prisma.product.findUnique({
      where: { id },
      select: { name: true, bulletPoints: true, description: true },
    })
    if (!p) return { ok: false, error: 'Product not found' }
    const data: Record<string, unknown> = {}
    const undo: Record<string, unknown> = {}
    if (args.title != null) {
      undo.name = p.name
      data.name = String(args.title)
    }
    if (Array.isArray(args.bulletPoints)) {
      undo.bulletPoints = p.bulletPoints
      data.bulletPoints = (args.bulletPoints as unknown[]).map(String)
    }
    if (args.description != null) {
      undo.description = p.description
      data.description = String(args.description)
    }
    if (Object.keys(data).length === 0)
      return { ok: false, error: 'nothing to apply' }
    await prisma.product.update({ where: { id }, data })
    return { ok: true, data: { applied: Object.keys(data), undo } }
  },
}

export const MUTATE_TOOLS: AgentTool[] = [
  applyContent,
  setPrice,
  publishListing,
  sendCustomerMessage,
]
