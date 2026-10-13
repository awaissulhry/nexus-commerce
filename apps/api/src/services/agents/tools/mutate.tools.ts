/**
 * ACP.1 / ACP.3b — mutating tools (HIGH risk, alwaysAsk).
 *
 * `handler` is always a dry-run preview (no side effects). `execute` is
 * the real action and runs ONLY after a human approves it through the
 * gate (approval-gate.service.ts) — `alwaysAsk` is a hard floor the
 * policy layer can never downgrade.
 *
 * Each execute routes through the SAME governed service the rest of the app
 * uses, so it INHERITS that service's safety gate rather than bypassing it:
 *   set-price            → masterPriceService.update() (reversible; the
 *                          channel push is enqueued + gated downstream)
 *   send-customer-message→ the buyer-message door, comms/buyer-message.service (dry-run unless
 *                          NEXUS_ENABLE_OUTBOUND_EMAILS=true) + GDPR
 *                          suppression check
 * publish-listing moved to publish.tools.ts (MCP full control L5): it publishes through the product studio.
 */

import prisma from '../../../db.js'
import { MasterPriceRefusedError, masterPriceService } from '../../master-price.service.js'
import {
  MESSAGE_LANGUAGES,
  MESSAGE_TEMPLATE_IDS,
  MESSAGE_TEMPLATES,
  prepareBuyerMessage,
  publicPlan,
  sendBuyerMessage,
  type MessageRequest,
} from '../../comms/buyer-message.service.js'
import { staleRefusal } from './stale-preview.js'
import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import type { AgentTool, ToolUndo } from '../tool-types.js'
import { liveProduct } from './live-product.js'
import { priceBoundsOf, storedPriceReason } from '../../price-bounds.service.js'
import { roundCents } from '@nexus/shared/listing-price'
import {
  applyProductBulkEdits,
  ProductBulkError,
  type ProductBulkChangeError,
  type ProductBulkChangeWarning,
  type ProductBulkContext,
} from '../../products/bulk-edit.service.js'
import { logger } from '../../../utils/logger.js'


/** C1 — how far a master price may move without a person, when a business lets Claude run set-price itself (C5). */
export const SET_PRICE_LIMITS = z.object({
  maxChangePercent: z
    .number()
    .positive()
    .max(100)
    .default(10)
    .describe('the most the master price may move, up or down, in percent of the current price'),
})

/** C1 — is a set-price preview inside the limits? The price bounds of the product are already checked by the preview. */
export function setPriceWithinLimits(preview: unknown, limits: Record<string, unknown>): string | null {
  const deltaPct = (preview as { deltaPct?: unknown } | null)?.deltaPct
  const max = Number(limits.maxChangePercent)
  if (typeof deltaPct !== 'number') return 'the product has no master price yet to compare the new one with'
  if (!(Math.abs(deltaPct) <= max)) {
    return `the master price moves ${Math.abs(deltaPct)} %, more than the ${max} % allowed without a person`
  }
  return null
}

/**
 * C2 — undo of set-price: set the master price it replaced, through set-price itself (the same gate, preview and
 * approval). Refused while the master price is no longer the one it wrote, and when there was none before.
 */
export const SET_PRICE_UNDO: ToolUndo = {
  async current(change) {
    const productId = String((change.after as { productId?: unknown } | null)?.productId ?? '')
    const p = await prisma.product.findFirst({ where: liveProduct(productId), select: { basePrice: true } })
    return { productId, price: p?.basePrice != null ? Number(p.basePrice) : null }
  },
  request(change) {
    const before = (change.before ?? {}) as { productId?: string; sku?: string; price?: number | null }
    if (!before.productId) return { refusal: 'This change does not name its product.' }
    if (before.price == null || !(before.price > 0)) {
      return { refusal: `${before.sku ?? 'The product'} had no master price before this change, and a master price cannot be taken away.` }
    }
    return { tool: 'set-price', args: { productId: before.productId, price: before.price } }
  },
}

const setPrice: AgentTool = {
  name: 'set-price',
  title: 'Set master price',
  input: z.object({
    productId: z.string().min(1).describe('Nexus product id'),
    // Above 0: coercion turns "" and null into 0, and a master price of 0 would be cascaded and pushed.
    price: z.coerce.number().positive().describe('new master price, in the master currency; above 0'),
  }),
  requires: [F.productsPriceEdit],
  category: 'pricing',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  openWorld: true,
  // C1 — the previous master price is recorded (AgentChange) and undo sets it again, through the same gate.
  reversibility: 'full',
  maxClaudeTrust: 'auto',
  limits: SET_PRICE_LIMITS,
  withinLimits: setPriceWithinLimits,
  undo: SET_PRICE_UNDO,
  description:
    'Change a product master price (cascades to channels per their pricing rules; channel push is gated). Waits for a '
    + 'person to approve it in Nexus, unless the business lets Claude make small moves itself (inside its limits).',
  async handler(args) {
    const id = String(args.productId ?? '')
    const proposed = Number(args.price)
    if (!id || !Number.isFinite(proposed))
      return { ok: false, error: 'productId and numeric price are required' }
    const p = await prisma.product.findFirst({
      where: liveProduct(id),
      select: { sku: true, basePrice: true, minPrice: true, maxPrice: true },
    })
    if (!p) return { ok: false, error: 'Product not found' }
    // The shared verdict on a master price (`storedPriceReason`: above 0, inside the product's own floor/ceiling), on
    // the cents the write stores, in the master-price write's own words — the sentence the run would refuse with.
    const refusal = storedPriceReason(roundCents(proposed), priceBoundsOf(p))
    if (refusal) return { ok: false, error: `Not changed: ${refusal}.` }
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
    if (!id || !Number.isFinite(proposed) || proposed <= 0)
      return { ok: false, error: 'productId and a price above 0 are required' }
    const before = await prisma.product.findFirst({
      where: liveProduct(id),
      select: { sku: true, basePrice: true },
    })
    if (!before) return { ok: false, error: 'Product not found' }
    const oldBasePrice = before.basePrice != null ? Number(before.basePrice) : null
    // The floor or ceiling may have changed since the preview: the master-price write itself refuses the whole edit
    // (MasterPriceRefusedError, the same "Not changed: …" sentence) before anything is written.
    let res: Awaited<ReturnType<typeof masterPriceService.update>>
    try {
      res = await masterPriceService.update(id, proposed, {
        actor: ctx.userId ?? null,
        reason: 'agent:set-price',
      })
    } catch (err) {
      if (err instanceof MasterPriceRefusedError) return { ok: false, error: err.message }
      throw err
    }
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
      // C1 — the master price it replaced and wrote. `after` is exactly what undo compares with what is stored then;
      // `before` adds the SKU for a person.
      change: {
        before: { productId: id, sku: before.sku, price: res.oldBasePrice },
        after: { productId: id, price: res.newBasePrice },
      },
    }
  },
}

const sendCustomerMessage: AgentTool = {
  name: 'send-customer-message',
  title: 'Email a customer',
  input: z.object({
    orderId: z.string().min(1).describe('Nexus order id'),
    template: z.enum(MESSAGE_TEMPLATE_IDS).optional()
      .describe(`a ready-made message: ${MESSAGE_TEMPLATE_IDS.map((id) => `${id} (${MESSAGE_TEMPLATES[id].label})`).join(', ')}`),
    message: z.string().trim().min(1).max(2000).optional().describe('the message to the buyer (with a template: added below it)'),
    language: z.enum(MESSAGE_LANGUAGES).optional().describe("it or en; default: the language of the order's market"),
  }),
  requires: [F.ordersEdit],
  category: 'comms',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  openWorld: true,
  // C1 — a sent message cannot be recalled: never more than a person's own yes in Nexus.
  reversibility: 'none',
  maxClaudeTrust: 'ask',
  description:
    'Write to the buyer of an order of this business, as the business, in the language of its market: a ready-made '
    + 'template and/or a free message. Shopify, Etsy, WooCommerce and own-shop buyers get an e-mail; Amazon and eBay '
    + 'buyers are written to only through their marketplace\'s own messaging (Amazon: only with a template, which picks '
    + 'one of Amazon\'s message kinds; no links or incentives on either). An opted-out buyer is refused an e-mail. The '
    + 'preview shows the message, its copy checks and whether the route is live or a dry run. Requires approval; a sent '
    + 'message cannot be recalled.',
  // 07 O11 — the one buyer-message door (services/comms/buyer-message.service.ts).
  async handler(args) {
    const prepared = await prepareBuyerMessage(args as unknown as MessageRequest)
    if (prepared.ok === false) return { ok: false, error: prepared.error }
    return { ok: true, preview: { action: 'send-customer-message', ...publicPlan(prepared.plan), note: 'Sends one e-mail to the buyer as this business; it cannot be recalled.' } }
  },
  async execute(args, ctx) {
    const prepared = await prepareBuyerMessage(args as unknown as MessageRequest)
    if (prepared.ok === false) return { ok: false, error: prepared.error }
    const fresh = { action: 'send-customer-message', ...publicPlan(prepared.plan) }
    const stale = staleRefusal(ctx.approvedPreview, fresh, ['to', 'route', 'mode', 'sendsAs', 'subject', 'body'], 'the message')
    if (stale) return { ok: false, error: stale }
    const sent = await sendBuyerMessage(prepared.plan, { sentByUserId: ctx.userId ?? null, via: ctx.via, approvalId: ctx.approvalId ?? null })
    if (sent.outcome === 'FAILED' || sent.outcome === 'SUPPRESSED') return { ok: false, error: sent.error ?? sent.outcome }
    return {
      ok: true,
      data: {
        messageId: sent.messageId,
        to: prepared.plan.to,
        delivered: sent.outcome === 'SENT',
        dryRun: sent.outcome === 'DRY_RUN',
        providerRef: sent.providerRef,
      },
    }
  },
}

/** C1 — the most bullet points apply-content takes in one call (every list a tool takes is bounded). */
export const APPLY_CONTENT_MAX_BULLETS = 10
/** The most search keywords apply-content takes in one call. */
export const APPLY_CONTENT_MAX_KEYWORDS = 50
const LIMIT_FIELDS = ['title', 'bulletPoints', 'description', 'keywords'] as const

/** C1 — which master content fields Claude may change without a person, when a business allows it (C5). */
export const APPLY_CONTENT_LIMITS = z.object({
  fields: z
    .array(z.enum(LIMIT_FIELDS))
    .max(LIMIT_FIELDS.length)
    .default([...LIMIT_FIELDS])
    .describe('the content fields that may change without a person: title, bulletPoints, description, keywords'),
})

export function applyContentWithinLimits(preview: unknown, limits: Record<string, unknown>): string | null {
  const changes = (preview as { changes?: unknown } | null)?.changes
  if (!changes || typeof changes !== 'object') return 'the preview names no content change'
  const allowed = new Set(Array.isArray(limits.fields) ? (limits.fields as string[]) : [])
  const outside = Object.keys(changes).filter((field) => !allowed.has(field))
  return outside.length ? `${outside.join(' and ')} may not change without a person` : null
}

/**
 * C2 — undo of apply-content: write the content it replaced back, through apply-content itself. Refused while the
 * product's content is no longer what it wrote. Nexus may hold no description at all; apply-content cannot store
 * "none", so undo stores an empty description then.
 */
export const APPLY_CONTENT_UNDO: ToolUndo = {
  async current(change) {
    const after = (change.after ?? {}) as Record<string, unknown>
    const productId = String(after.productId ?? '')
    const p = await prisma.product.findFirst({ where: liveProduct(productId), select: { name: true, bulletPoints: true, description: true, keywords: true } })
    const now: Record<string, unknown> = { productId }
    if ('title' in after) now.title = p ? p.name : null
    if ('bulletPoints' in after) now.bulletPoints = p ? p.bulletPoints : null
    if ('description' in after) now.description = p ? p.description : null
    if ('keywords' in after) now.keywords = p ? p.keywords : null
    return now
  },
  request(change) {
    const before = (change.before ?? {}) as Record<string, unknown>
    if (typeof before.productId !== 'string') return { refusal: 'This change does not name its product.' }
    const args: Record<string, unknown> = { productId: before.productId }
    if ('title' in before) args.title = String(before.title ?? '')
    if ('bulletPoints' in before) args.bulletPoints = Array.isArray(before.bulletPoints) ? before.bulletPoints : []
    if ('description' in before) args.description = before.description == null ? '' : String(before.description)
    if ('keywords' in before) args.keywords = Array.isArray(before.keywords) ? before.keywords : []
    return Object.keys(args).length > 1 ? { tool: 'apply-content', args } : { refusal: 'This change named no content field.' }
  },
}

// apply-content — the reversible "copilot fixes the listing" action: a drafted title / bullets / description /
// keywords on the MASTER product (the primary language). Medium tier, routed through the approval gate
// (requiresApprovalDefault). MCP full control T2: it saves through the product sheet's own writer
// (`applyProductBulkEdits` → `writeContent`, source tier), so the product's version moves, an audit row is written
// and the listings that follow the text get their follow markers, exactly as a sheet edit. Nexus only (the Owner's
// d7): no channel update is queued; the channels change when the listing is published from Nexus.
const CONTENT_FIELDS = [
  // [argument, the writer's field (the product column)]
  ['title', 'name'],
  ['bulletPoints', 'bulletPoints'],
  ['description', 'description'],
  ['keywords', 'keywords'],
] as const
type ContentRow = { name: string; bulletPoints: string[]; description: string | null; keywords: string[] }
const CONTENT_SELECT = { name: true, bulletPoints: true, description: true, keywords: true, version: true } as const

/** What the arguments change, read against the product as stored now: the writer's changes, the preview, the undo. */
function contentPlan(productId: string, args: Record<string, unknown>, p: ContentRow) {
  const writes: Array<{ id: string; field: string; value: unknown; contentAddress: { tier: 'source' } }> = []
  const changes: Record<string, { from: unknown; to: unknown }> = {}
  const undo: Record<string, unknown> = {}
  for (const [arg, column] of CONTENT_FIELDS) {
    const raw = args[arg]
    const value = arg === 'bulletPoints' || arg === 'keywords'
      ? (Array.isArray(raw) ? (raw as unknown[]).map(String) : undefined)
      : (raw != null ? String(raw) : undefined)
    if (value === undefined) continue
    changes[arg] = { from: p[column], to: value }
    undo[column] = p[column]
    writes.push({ id: productId, field: column, value, contentAddress: { tier: 'source' } })
  }
  return { writes, changes, undo }
}

/** The writer's context. It logs as pino does (details, message); Nexus's logger takes (message, details). */
function contentWriterContext(userId: string | null | undefined): ProductBulkContext {
  const log = (level: 'warn' | 'error') => (details: unknown, message?: string) =>
    logger[level](message ?? '[agents/apply-content] product writer', { details })
  return {
    formulaCascade: false,
    userId: userId ?? null,
    // Nexus only: shared text cascades to the listings that follow it, but no channel update is queued.
    queueOutbound: false,
    logger: { warn: log('warn'), error: log('error') } as unknown as ProductBulkContext['logger'],
  }
}

type WriterOutcome = { errors?: ProductBulkChangeError[]; warnings?: ProductBulkChangeWarning[]; currentVersion?: number }
const writerLines = (rows: Array<{ field: string; error?: string; warning?: string }>) =>
  rows.map((row) => `${row.field}: ${row.error ?? row.warning}`)

/** The writer, as a refusal sentence or its outcome. A throw rolls its transaction back: nothing was written then. */
async function runContentWriter(
  input: { changes: ReturnType<typeof contentPlan>['writes']; expectedVersion?: number; dryRun?: boolean },
  userId: string | null | undefined,
): Promise<{ refusal: string } | { outcome: WriterOutcome }> {
  try {
    const outcome = (await applyProductBulkEdits(input, contentWriterContext(userId))) as WriterOutcome
    if (outcome.errors?.length) return { refusal: `The product writer refused it: ${writerLines(outcome.errors).join('; ')}` }
    return { outcome }
  } catch (error) {
    if (!(error instanceof ProductBulkError)) throw error
    const errors = error.details.errors
    return { refusal: Array.isArray(errors) && errors.length ? `The product writer refused it: ${writerLines(errors as ProductBulkChangeError[]).join('; ')}` : error.message }
  }
}

const applyContent: AgentTool = {
  name: 'apply-content',
  title: 'Apply product content',
  input: z.object({
    productId: z.string().min(1).describe('Nexus product id'),
    title: z.string().optional().describe('new title'),
    bulletPoints: z.array(z.string()).max(APPLY_CONTENT_MAX_BULLETS).optional().describe(`new bullet points, at most ${APPLY_CONTENT_MAX_BULLETS}`),
    description: z.string().optional().describe('new description'),
    keywords: z.array(z.string()).max(APPLY_CONTENT_MAX_KEYWORDS).optional().describe(`new search keywords, at most ${APPLY_CONTENT_MAX_KEYWORDS}`),
  }),
  requires: [F.productsEdit],
  category: 'products',
  riskTier: 'medium',
  readOnly: false,
  requiresApprovalDefault: true,
  // C1 — Nexus only: it writes the master product; no marketplace changes until someone publishes.
  openWorld: false,
  reversibility: 'full',
  maxClaudeTrust: 'auto',
  limits: APPLY_CONTENT_LIMITS,
  withinLimits: applyContentWithinLimits,
  undo: APPLY_CONTENT_UNDO,
  description:
    'Apply a drafted title / bullet points / description / keywords to the master product, in its primary language '
    + '(reversible; a person approves it in Nexus, unless the business lets Claude apply it itself, for the fields its '
    + 'limits allow). Saved in Nexus only: listings that follow the master text take it, and the '
    + 'channels change when the listing is published from Nexus.',
  async handler(args, ctx) {
    const id = String(args.productId ?? '')
    if (!id) return { ok: false, error: 'productId is required' }
    const p = await prisma.product.findFirst({ where: liveProduct(id), select: CONTENT_SELECT })
    if (!p) return { ok: false, error: 'Product not found' }
    const plan = contentPlan(id, args, p)
    if (plan.writes.length === 0)
      return {
        ok: false,
        error: 'nothing to apply (title / bulletPoints / description / keywords)',
      }
    // The writer's own dry run (writes nothing): its refusal, or the warnings it would store the values with.
    const checked = await runContentWriter({ changes: plan.writes, dryRun: true }, ctx?.userId)
    if ('refusal' in checked) return { ok: false, error: checked.refusal }
    const warnings = writerLines(checked.outcome.warnings ?? [])
    return {
      ok: true,
      preview: {
        action: 'apply-content',
        productId: id,
        changes: plan.changes,
        ...(warnings.length ? { warnings } : {}),
        note: 'Reversible master-content edit, saved in Nexus only (no channel update is queued); requires approval to apply.',
      },
    }
  },
  async execute(args, ctx) {
    const id = String(args.productId ?? '')
    if (!id) return { ok: false, error: 'productId is required' }
    const p = await prisma.product.findFirst({ where: liveProduct(id), select: CONTENT_SELECT })
    if (!p) return { ok: false, error: 'Product not found' }
    const plan = contentPlan(id, args, p)
    if (plan.writes.length === 0)
      return { ok: false, error: 'nothing to apply' }
    // Guarded by the version just read: the undo below is exactly what this write replaces.
    const written = await runContentWriter({ changes: plan.writes, expectedVersion: p.version }, ctx.userId)
    if ('refusal' in written) return { ok: false, error: written.refusal }
    const warnings = writerLines(written.outcome.warnings ?? [])
    // C1 — the fields it wrote, under the names the tool takes, before and after (`undo.current` reads them back).
    const before: Record<string, unknown> = { productId: id }
    const after: Record<string, unknown> = { productId: id }
    for (const [arg, change] of Object.entries(plan.changes)) [before[arg], after[arg]] = [change.from, change.to]
    return {
      ok: true,
      data: {
        applied: plan.writes.map((w) => w.field),
        undo: plan.undo,
        ...(written.outcome.currentVersion !== undefined ? { version: written.outcome.currentVersion } : {}),
        ...(warnings.length ? { warnings } : {}),
      },
      change: { before, after },
    }
  },
}

export const MUTATE_TOOLS: AgentTool[] = [
  applyContent,
  setPrice,
  sendCustomerMessage,
]
