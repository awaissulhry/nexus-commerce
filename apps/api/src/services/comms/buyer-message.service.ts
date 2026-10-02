/**
 * MCP full control 07 O11 — the one door for writing to a buyer: `prepareBuyerMessage` (what would be sent, or why
 * not) and `sendBuyerMessage` (one BuyerMessage row per send, then the send, then the outcome on the row and a
 * `customer.message.sent` event with ids, channel, route and outcome only).
 *
 *   - Route per channel (decision O-2): Amazon and eBay buyers are written to only through Amazon's and eBay's own
 *     messaging (O15, marketplace-messaging.service: through the gateway, each behind its own switch) — Amazon only in
 *     its own message kinds (a template), no links; Shopify, Etsy, WooCommerce and own-shop orders get an e-mail.
 *   - The business's own identity (O3, business-identity.service): its name, contact and sender; refused without one.
 *   - Language per market (Italian for Italy, English elsewhere), a template or a free text.
 *   - Suppression of e-mails (an opted-out buyer is refused), and the marketplace copy lint (rules of message-lint.ts;
 *     warnings for an e-mail, refusals for an Amazon or eBay message, whose rules forbid links and incentives).
 *   - Each route is a dry run until its switch is on (NEXUS_ENABLE_OUTBOUND_EMAILS, …_AMAZON_MESSAGING,
 *     …_EBAY_MESSAGING); the preview says which.
 *
 * Everything runs in the caller's business. The preview (prepare) never names the buyer beyond a first name and a
 * masked e-mail (decision O-1).
 */

import prisma from '../../db.js'
import { publishEvent } from '../../lib/events/publish.js'
import { sendEmail, defaultFrom } from '../email/transport.js'
import { isEmailSuppressed } from '../reviews/email-suppression.service.js'
import { resolveBusinessIdentity, type BusinessIdentity } from '../business-identity.service.js'
import { maskBuyer } from '../orders/buyer-mask.js'
import { lintBuyerCopy, type LintIssue } from './message-lint.js'
import {
  AMAZON_MESSAGE_KINDS, amazonMessagingMode, ebayMessagingMode, sendAmazonMessage, sendEbayMemberMessage,
} from './marketplace-messaging.service.js'
import { amazonMarketplaceIdFor } from '../reviews/amazon-solicitations.service.js'

export const MESSAGE_LANGUAGES = ['it', 'en'] as const
export type MessageLanguage = (typeof MESSAGE_LANGUAGES)[number]
export type MessageRoute = 'EMAIL' | 'AMAZON' | 'EBAY'

/** The suppression list's channel for these messages (unchanged since ACP.3b). */
export const BUYER_MESSAGE_SUPPRESSION_CHANNEL = 'agent-customer-message'

/** Ready-made messages: {orderNumber} and {brand} are filled in; a free `message` is added below the template. */
export const MESSAGE_TEMPLATES: Record<string, { label: string; it: string; en: string }> = {
  'shipping-update': {
    label: 'Your order is on its way soon',
    it: 'Il tuo ordine {orderNumber} è in preparazione e partirà a breve. Ti scriveremo appena lo affidiamo al corriere.',
    en: 'Your order {orderNumber} is being prepared and will leave shortly. We will write as soon as it is with the carrier.',
  },
  'delay-apology': {
    label: 'Sorry, a short delay',
    it: 'Ci scusiamo: il tuo ordine {orderNumber} partirà con qualche giorno di ritardo. Grazie per la pazienza.',
    en: 'We are sorry: your order {orderNumber} will leave a few days later than planned. Thank you for your patience.',
  },
  'address-check': {
    label: 'Please confirm your address',
    it: 'Per spedire il tuo ordine {orderNumber} ci serve una conferma dell\'indirizzo di consegna. Puoi rispondere a questa email?',
    en: 'To ship your order {orderNumber} we need you to confirm the delivery address. Could you reply to this e-mail?',
  },
}
export const MESSAGE_TEMPLATE_IDS = Object.keys(MESSAGE_TEMPLATES) as [string, ...string[]]

/** How a channel's buyers are written to (O-2). */
export function routeFor(channel: string): MessageRoute {
  if (channel === 'AMAZON') return 'AMAZON'
  if (channel === 'EBAY') return 'EBAY'
  return 'EMAIL'
}

/** The language of a market: Italian for Italy, English elsewhere (the languages the templates are written in). */
export function languageFor(marketplace: string | null | undefined): MessageLanguage {
  return (marketplace ?? '').toUpperCase() === 'IT' ? 'it' : 'en'
}

export function emailMode(): string {
  return process.env.NEXUS_ENABLE_OUTBOUND_EMAILS === 'true' ? 'live: the e-mail is sent' : 'dry run: no e-mail is sent (NEXUS_ENABLE_OUTBOUND_EMAILS off)'
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export interface MessageRequest {
  orderId: string
  template?: string
  message?: string
  language?: MessageLanguage
}

export interface MessagePlan {
  order: { id: string; channel: string; marketplace: string | null; channelOrderId: string }
  to: { firstName: string | null; city: string | null; country: string | null; email: string | null }
  route: MessageRoute
  language: MessageLanguage
  template: string | null
  subject: string
  body: string
  lint: LintIssue[]
  mode: string
  sendsAs: { name: string; from: string }
  /** Not in the preview: where it goes (the e-mail address, or the marketplace's ids) and the identity it is sent as. */
  internal: {
    email: string | null
    customerName: string
    identity: BusinessIdentity
    amazon?: { amazonOrderId: string; marketplaceId: string; kind: string }
    ebay?: { itemId: string; buyerUserId: string; siteId: string }
  }
}

export type Prepared = { ok: true; plan: MessagePlan } | { ok: false; error: string }

/** What would be sent, or why not. Reads only; changes nothing. */
export async function prepareBuyerMessage(request: MessageRequest): Promise<Prepared> {
  const order = await prisma.order.findFirst({
    where: { id: request.orderId, deletedAt: null },
    select: {
      id: true, channel: true, marketplace: true, channelOrderId: true, customerName: true, customerEmail: true, shippingAddress: true, ebayMetadata: true,
      items: { select: { ebayMetadata: true } },
    },
  })
  if (!order) return { ok: false, error: 'Order not found' }
  const which = `Order ${order.channelOrderId}`
  const route = routeFor(order.channel)
  if (!request.template && !request.message?.trim()) return { ok: false, error: `${which}: name a template or write a message. Nothing was queued.` }
  if (request.template && !MESSAGE_TEMPLATES[request.template]) return { ok: false, error: `${which}: no such template: ${request.template}. Nothing was queued.` }

  // O15 — where the message goes: the marketplace's own messaging for Amazon and eBay buyers, else an e-mail.
  let amazon: MessagePlan['internal']['amazon']
  let ebay: MessagePlan['internal']['ebay']
  if (route === 'AMAZON') {
    const kind = request.template ? AMAZON_MESSAGE_KINDS[request.template] : undefined
    if (!kind) return { ok: false, error: `${which} is an Amazon order: Amazon allows only its own message kinds, so name a template (${Object.keys(AMAZON_MESSAGE_KINDS).join(', ')}); a message of your own is added below it. Nothing was queued.` }
    const marketplaceId = amazonMarketplaceIdFor(order.marketplace)
    if (!marketplaceId) return { ok: false, error: `${which}: Nexus does not know the Amazon marketplace of market "${order.marketplace ?? 'none'}"; write from Seller Central. Nothing was queued.` }
    amazon = { amazonOrderId: order.channelOrderId, marketplaceId, kind }
  } else if (route === 'EBAY') {
    const buyerUserId = String(((order.ebayMetadata ?? {}) as { buyer?: { username?: unknown } }).buyer?.username ?? '').trim()
    const itemId = order.items.map((item) => String(((item.ebayMetadata ?? {}) as { legacyItemId?: unknown }).legacyItemId ?? '').trim()).find(Boolean) ?? ''
    if (!buyerUserId || !itemId) return { ok: false, error: `${which}: Nexus does not have the eBay buyer or item of this order; write from eBay Messages. Nothing was queued.` }
    let siteId: string
    try {
      siteId = (await import('../ebay-trading-api.service.js')).siteIdForMarket(order.marketplace ?? 'IT')
    } catch {
      return { ok: false, error: `${which}: Nexus does not know the eBay site of market "${order.marketplace ?? 'none'}"; write from eBay Messages. Nothing was queued.` }
    }
    ebay = { itemId, buyerUserId, siteId }
  } else if (!order.customerEmail) {
    return { ok: false, error: `${which} has no buyer e-mail on file. Nothing was queued.` }
  }

  const found = await resolveBusinessIdentity()
  if (found.ok === false) return { ok: false, error: found.reason }
  const identity = found.identity
  if (route === 'EMAIL') {
    const suppressed = await isEmailSuppressed(order.customerEmail!, BUYER_MESSAGE_SUPPRESSION_CHANNEL)
    if (suppressed.suppressed) return { ok: false, error: `${which}: the buyer has opted out of e-mails (${suppressed.source ?? 'opt-out'}). Nothing was queued.` }
  }
  const language = request.language ?? languageFor(order.marketplace)
  const templated = request.template ? MESSAGE_TEMPLATES[request.template][language].replace('{orderNumber}', order.channelOrderId).replace('{brand}', identity.brandName) : ''
  const body = [templated, request.message?.trim() ?? ''].filter(Boolean).join('\n\n')
  const subject = language === 'it' ? `Un messaggio sul tuo ordine ${identity.brandName}` : `A message about your ${identity.brandName} order`
  const lint = lintBuyerCopy(body)
  // Amazon and eBay forbid links and incentives in buyer messages: what the lint flags is refused there, not warned.
  if (route !== 'EMAIL') {
    const blocked = lint.filter((issue) => issue.severity === 'error' || /link/i.test(issue.message))
    if (blocked.length) return { ok: false, error: `${which}: ${route === 'AMAZON' ? 'Amazon' : 'eBay'} does not allow this in a buyer message — ${blocked.map((issue) => `${issue.message}${issue.match ? ` ("${issue.match}")` : ''}`).join(' ')} Nothing was queued.` }
  }
  return {
    ok: true,
    plan: {
      order: { id: order.id, channel: order.channel, marketplace: order.marketplace, channelOrderId: order.channelOrderId },
      to: maskBuyer({ name: order.customerName, email: order.customerEmail, address: order.shippingAddress }),
      route,
      language,
      template: request.template ?? null,
      subject,
      body,
      lint,
      mode: route === 'AMAZON' ? amazonMessagingMode() : route === 'EBAY' ? ebayMessagingMode() : emailMode(),
      sendsAs: {
        name: identity.brandName,
        from: route === 'AMAZON' ? `Amazon Buyer-Seller Messaging (as "${amazon!.kind}")` : route === 'EBAY' ? 'eBay Messages' : identity.emailFrom ?? defaultFrom(),
      },
      internal: { email: order.customerEmail, customerName: order.customerName, identity, ...(amazon ? { amazon } : {}), ...(ebay ? { ebay } : {}) },
    },
  }
}

/** The e-mail itself, as the business. The Italian free message keeps exactly the text it had since O3. */
function renderEmail(plan: MessagePlan): { html: string; text: string } {
  const it = plan.language === 'it'
  const name = plan.internal.customerName || (it ? 'cliente' : 'there')
  const brand = escapeHtml(plan.internal.identity.brandName)
  const support = escapeHtml(plan.internal.identity.supportEmail)
  const greet = it ? `Ciao ${name},` : `Hi ${name},`
  const footer = it
    ? `Per dubbi, scrivi a <a href="mailto:${support}" style="color:#2563eb;">${support}</a>.`
    : `Questions? Write to <a href="mailto:${support}" style="color:#2563eb;">${support}</a>.`
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f8fafc;">
<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f8fafc;padding:32px 16px;"><tr><td align="center">
<table cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:560px;background:#fff;border-radius:8px;border:1px solid #e2e8f0;padding:32px;font-family:Inter,-apple-system,sans-serif;color:#0f172a;"><tr><td>
<div style="font-size:22px;font-weight:700;margin-bottom:24px;">${brand}</div>
<p style="font-size:16px;margin:0 0 12px 0;">${greet}</p>
<p style="font-size:16px;margin:0 0 20px 0;white-space:pre-wrap;">${escapeHtml(plan.body)}</p>
<p style="font-size:11px;color:#94a3b8;margin-top:24px;">${footer}</p>
</td></tr></table></td></tr></table></body></html>`
  const text = `${greet}\n\n${plan.body}\n\n— ${plan.internal.identity.brandName}`
  return { html, text }
}

export interface SendContext {
  sentByUserId: string | null
  via: string
  approvalId?: string | null
}

/**
 * Sends a prepared message: the BuyerMessage row first (PENDING), then the e-mail (refused again if the buyer opted
 * out meanwhile), then the outcome on the row and the event. Returns the row's outcome.
 */
export async function sendBuyerMessage(plan: MessagePlan, context: SendContext) {
  const row = await prisma.buyerMessage.create({
    data: {
      orderId: plan.order.id,
      channel: plan.order.channel,
      route: plan.route,
      template: plan.template,
      language: plan.language,
      subject: plan.subject,
      body: plan.body,
      status: 'PENDING',
      sentByUserId: context.sentByUserId,
      via: context.via,
      approvalId: context.approvalId ?? null,
    },
    select: { id: true },
  })
  let outcome: 'SENT' | 'DRY_RUN' | 'SUPPRESSED' | 'FAILED'
  let providerRef: string | null = null
  let error: string | null = null
  const suppressed = plan.route === 'EMAIL' ? await isEmailSuppressed(plan.internal.email!, BUYER_MESSAGE_SUPPRESSION_CHANNEL) : { suppressed: false, source: null }
  if (plan.internal.amazon) {
    // O15 — Amazon's own messaging, through the gateway.
    const sent = await sendAmazonMessage({ orderId: plan.order.id, ...plan.internal.amazon, text: plan.body })
    ;({ outcome, providerRef, error } = sent)
  } else if (plan.internal.ebay) {
    // O15 — eBay member messages, through the gateway.
    const sent = await sendEbayMemberMessage({ orderId: plan.order.id, ...plan.internal.ebay, subject: plan.subject, body: plan.body })
    ;({ outcome, providerRef, error } = sent)
  } else if (suppressed.suppressed) {
    outcome = 'SUPPRESSED'
    error = `recipient is suppressed (${suppressed.source ?? 'opt-out'})`
  } else {
    const { html, text } = renderEmail(plan)
    const sent = await sendEmail({
      to: plan.internal.email!,
      subject: plan.subject,
      html,
      text,
      tag: BUYER_MESSAGE_SUPPRESSION_CHANNEL,
      ...(plan.internal.identity.emailFrom ? { from: plan.internal.identity.emailFrom } : {}),
    })
    outcome = !sent.ok ? 'FAILED' : sent.dryRun ? 'DRY_RUN' : 'SENT'
    providerRef = sent.messageId ?? null
    error = sent.ok ? null : sent.error ?? 'email send failed'
  }
  await prisma.$transaction(async (tx) => {
    await tx.buyerMessage.update({
      where: { id: row.id },
      data: { status: outcome, providerRef, error, ...(outcome === 'SENT' || outcome === 'DRY_RUN' ? { sentAt: new Date() } : {}) },
    })
    await publishEvent(tx, 'customer.message.sent', { messageId: row.id, orderId: plan.order.id, channel: plan.order.channel, route: plan.route, outcome })
  })
  return { messageId: row.id, outcome, providerRef, error }
}

/** The preview a person reads (no address, no full name). */
export function publicPlan(plan: MessagePlan) {
  const { internal: _internal, ...visible } = plan
  return visible
}
