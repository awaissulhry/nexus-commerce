/**
 * Reviews Insights › Fixes — a fix (ReviewActionItem) never changes a listing by itself (routes/reviews.routes.ts):
 *
 *   GET   /api/reviews/action-items?status&kind&productId&spikeId&limit   the fixes, each with why it cannot be sent
 *   PATCH /api/reviews/action-items/:id        { status: OPEN | DISMISSED } (Bring back / Dismiss) or an edit of the
 *                                              proposal while it is Open (title, bullets, module, language, english, days)
 *   POST  /api/reviews/action-items/:id/propose  "Send for approval"
 *   POST  /api/reviews/action-items/bulk       { ids ≤ 200, action: propose | dismiss } → { changed, held, sent?, tasks? }
 *   POST  /api/reviews/action-items/:id/withdraw  takes the waiting change plan back (every fix in it is Open again)
 *   POST  /api/reviews/action-items/:id/task   "Create task": no approval, nothing reaches a channel
 *
 * "Send for approval" turns every ticked fix that can be sent into ONE Nexus change plan (submit-change-plan, through
 * the same door as every other request: approval-gate.service.ts requestApproval → change-plan.service.ts queuePlan),
 * asked as the signed-in person. A person who may approve changes decides it on the Approvals page; only then does
 * Nexus change anything. The steps per kind:
 *   Bullets      set-content: the product's shared bullet points in the market's language (translated from the AI's
 *                English when they differ; the English goes along as what the text means)
 *   A+ content   set-aplus-content op create: one text module, a DRAFT on Amazon applied to the product's ASIN in that
 *                market (Amazon refuses it without Brand Registry: that refusal holds the fix, in Amazon's words)
 *   Recall check reserve-stock: a hold on the available units in the business's OWN warehouses only. Amazon FBA stock is
 *                never held from here (refused in code: assertOwnWarehouses) — Amazon owns that number.
 *   Task         no step: created at once, without approval.
 * A fix that cannot be sent is held, with why and the way out (ruling 7); the others still go. A plan step the plan
 * refuses (the person's permissions, a market without Brand Registry …) holds only its fix, and the rest are sent.
 * Every status here follows the plan: Sent while it waits, Applied once it ran, Open again (with why) when it is
 * declined, withdrawn or expires (`syncSentFixes`, on every read).
 */
import type { Prisma } from '@prisma/client'
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { marketLanguages } from '../pim/market-languages.js'
import { PRIMARY_CONTENT_LOCALE } from '../pim/content-locale.js'
import type { UserPrincipal } from '../agents/call-tool.js'
import { marketWords, themeWords } from './overviewMath.js'
import { InsightsInputError, parseBulk, whereWords } from './review-insights-math.js'
import { peopleNames } from './review-alerts.service.js'

export const FIX_KINDS = ['BULLETS', 'APLUS', 'RECALL_FLAG', 'TASK', 'SIZE_GUIDE'] as const
export type FixKind = (typeof FIX_KINDS)[number]
export const KIND_WORDS: Record<FixKind, string> = { BULLETS: 'Bullets', APLUS: 'A+ content', RECALL_FLAG: 'Recall check', TASK: 'Task', SIZE_GUIDE: 'Size guide' }
export const FIX_STATUSES = ['OPEN', 'SENT', 'APPLIED', 'DISMISSED'] as const
export type FixStatus = (typeof FIX_STATUSES)[number]
/** How long a recall check holds the units (days); the hold can be released or undone from its change plan. */
export const RECALL_HOLD_DAYS = 14
const MAX_BULLETS = 10

const TOOL_WORDS: Record<string, string> = { 'set-content': 'Product text', 'set-aplus-content': 'A+ content', 'reserve-stock': 'Stock hold' }
const SIZE_GUIDE_LATER = 'Size-guide changes come later: Nexus cannot change a size chart from here yet. Make it a task, or dismiss it.'
const NOT_FOUND = 'Not found in this business’s fixes.'

export class FixNotFoundError extends Error {
  readonly statusCode = 404
}
export class FixConflictError extends Error {
  readonly statusCode = 409
}
/** A reserve-stock step on anything but an own warehouse. Never sent: Amazon owns the FBA number. */
export class FbaRefusedError extends Error {
  readonly statusCode = 409
}

export interface FixRow {
  id: string
  type: string
  status: string
  productId: string | null
  marketplace: string | null
  category: string | null
  title: string
  detail: string | null
  payload: unknown
  approvalId: string | null
  spikeId: string | null
  source: string
  createdBy: string | null
  createdAt: Date
  updatedAt: Date
}

export interface ToolStep {
  tool: string
  args: Record<string, unknown>
}

export interface FixFacts {
  product: { id: string; sku: string; name: string } | null
  /** Bullets / A+: the language the market shows (its first content language), or the source language with no market. */
  language: string | null
  languageProblem: string | null
  /** A+: the market is one of this business's Amazon markets. */
  amazonMarket: boolean
  /** A+: the product's ASIN on that Amazon market. */
  asin: string | null
  /** Bullets / A+: the proposal's text in `language`, and what it says in English (null when `language` is en). */
  text: { bulletPoints?: string[]; headline?: string; body?: string; english: string | null } | null
  textProblem: string | null
  /** Recall: the product's (and its variants') stock with units available, at every kind of location. */
  stock: Array<{ productId: string; sku: string; location: string; locationType: string; available: number }>
}

type Payload = {
  bullets?: unknown
  module?: { headline?: unknown; body?: unknown } | null
  language?: unknown
  english?: unknown
  days?: unknown
  plan?: { approvalId?: string; positions?: number[]; sentBy?: string; sentAt?: string } | null
  task?: { createdBy?: string; createdAt?: string; assignee?: string | null } | null
  lastSend?: { words?: string; at?: string } | null
  [key: string]: unknown
}

const payloadOf = (fix: Pick<FixRow, 'payload'>): Payload => (fix.payload && typeof fix.payload === 'object' && !Array.isArray(fix.payload) ? (fix.payload as Payload) : {})
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.trim().length > 0).map((s) => s.trim()) : [])
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const lang = (v: unknown): string => (typeof v === 'string' && /^[a-z]{2}$/i.test(v.trim()) ? v.trim().toLowerCase() : 'en')
const kindOf = (fix: Pick<FixRow, 'type'>): FixKind => ((FIX_KINDS as readonly string[]).includes(fix.type) ? (fix.type as FixKind) : 'TASK')
const marketLabel = (fix: Pick<FixRow, 'marketplace'>, channel = 'AMAZON') => (fix.marketplace ? whereWords(channel, fix.marketplace) : null)

/** Why a fix in `status` cannot be sent (null = it is Open and can be). */
export function statusHeld(status: string): string | null {
  if (status === 'SENT') return 'Already sent for approval: it waits on the Approvals page.'
  if (status === 'APPLIED') return 'Already applied: undo it from its change plan.'
  if (status === 'DISMISSED') return 'Dismissed: bring it back first.'
  return null
}

/** A+ text module (STANDARD_TEXT) as Amazon's own module object. */
export function textModule(headline: string, body: string) {
  return {
    contentModuleType: 'STANDARD_TEXT',
    standardText: { headline: { value: headline.slice(0, 160), decoratorSet: [] }, body: { textList: [{ value: body.slice(0, 5000), decoratorSet: [] }] } },
  }
}

/**
 * Never a hold on stock that is not the business's own: every reserve-stock step must name a WAREHOUSE location the
 * facts list. An Amazon FBA (or Shopify, or unknown) location throws — the plan is never asked for.
 */
export function assertOwnWarehouses(steps: readonly ToolStep[], stock: FixFacts['stock']): void {
  for (const step of steps) {
    if (step.tool !== 'reserve-stock') continue
    const location = String(step.args.location ?? '')
    const level = stock.find((s) => s.location === location && s.productId === step.args.productId)
    if (!level || level.locationType !== 'WAREHOUSE') {
      throw new FbaRefusedError(
        level?.locationType === 'AMAZON_FBA'
          ? `${location} is Amazon FBA stock: Nexus never holds Amazon FBA stock from Reviews.`
          : `${location || 'That location'} is not one of this business’s own warehouses: Nexus holds stock only there.`,
      )
    }
  }
}

/** The change-plan steps one fix becomes, or why it cannot be sent (in words, with the way out). Pure. */
export function stepsForFix(fix: FixRow, facts: FixFacts, opts: { days?: number } = {}): { steps: ToolStep[] } | { held: string } {
  const kind = kindOf(fix)
  if (kind === 'TASK') return { held: 'A task needs no approval: create it instead.' }
  if (kind === 'SIZE_GUIDE') return { held: SIZE_GUIDE_LATER }
  if (!fix.productId) return { held: 'This fix names no product: make it a task, or dismiss it.' }
  const product = facts.product
  if (!product) return { held: 'Its product is no longer in Nexus: dismiss this fix.' }

  if (kind === 'BULLETS') {
    if (facts.languageProblem || !facts.language) return { held: facts.languageProblem ?? 'Nexus does not know which language this market shows.' }
    if (facts.textProblem) return { held: facts.textProblem }
    const bullets = facts.text?.bulletPoints ?? []
    if (bullets.length === 0) return { held: 'The proposal has no bullet points: edit the proposal first.' }
    if (facts.language !== 'en' && !facts.text?.english) return { held: 'Say what the bullets mean in English (Edit the proposal) before sending: the person who approves reads it.' }
    return {
      steps: [{
        tool: 'set-content',
        args: {
          product: product.id,
          language: facts.language,
          bulletPoints: bullets.slice(0, MAX_BULLETS),
          ...(facts.language !== 'en' ? { englishMeaning: { bulletPoints: facts.text!.english! } } : {}),
        },
      }],
    }
  }

  if (kind === 'APLUS') {
    if (!fix.marketplace) return { held: 'A+ content is made per Amazon market and this fix names none: make it a task instead.' }
    if (!facts.amazonMarket) return { held: `${marketWords(fix.marketplace) ?? fix.marketplace} is not one of this business’s Amazon markets: A+ content is for Amazon only. Make it a task instead.` }
    if (!facts.asin) return { held: `${product.sku} has no live listing on ${marketLabel(fix)}: nothing would show the A+ content. Make it a task, or dismiss it.` }
    if (facts.languageProblem || !facts.language) return { held: facts.languageProblem ?? 'Nexus does not know which language this market shows.' }
    if (facts.textProblem) return { held: facts.textProblem }
    const headline = facts.text?.headline
    const body = facts.text?.body
    if (!headline || !body) return { held: 'The proposal needs a headline and a text: edit the proposal first.' }
    if (facts.language !== 'en' && !facts.text?.english) return { held: 'Say what the A+ text means in English (Edit the proposal) before sending: the person who approves reads it.' }
    return {
      steps: [{
        tool: 'set-aplus-content',
        args: {
          op: 'create',
          market: fix.marketplace,
          name: `${product.sku} · ${fix.category ? themeWords(fix.category) : 'buyers'} (from reviews)`.slice(0, 100),
          language: facts.language,
          modules: [textModule(headline, body)],
          asins: [facts.asin],
          ...(facts.language !== 'en' ? { summary: facts.text!.english!.slice(0, 1000) } : {}),
        },
      }],
    }
  }

  // RECALL_FLAG: own warehouses only.
  const own = facts.stock.filter((s) => s.locationType === 'WAREHOUSE' && s.available > 0)
  const fba = facts.stock.filter((s) => s.locationType === 'AMAZON_FBA').reduce((n, s) => n + s.available, 0)
  if (own.length === 0) {
    return {
      held: fba > 0
        ? `All ${fba} available units are Amazon FBA stock: Nexus never holds Amazon FBA stock. Ask Amazon for a removal in Seller Central, or make this a task.`
        : 'No units are available in your own warehouses to hold. Make it a task, or dismiss it.',
    }
  }
  const days = Math.min(Math.max(Math.trunc(opts.days ?? RECALL_HOLD_DAYS), 1), 90)
  const steps: ToolStep[] = own.map((s) => ({
    tool: 'reserve-stock',
    args: { action: 'reserve', productId: s.productId, location: s.location, quantity: s.available, reason: 'MANUAL_HOLD', days },
  }))
  assertOwnWarehouses(steps, facts.stock)
  return { steps }
}

// ── Facts (one read per kind of fact, for many fixes) ───────────────

const ASIN = /^[A-Z0-9]{10}$/

async function translated(
  kind: 'BULLETS' | 'APLUS',
  source: { bulletPoints?: string[]; headline?: string; body?: string },
  targetLanguage: string,
  productId: string,
): Promise<{ bulletPoints?: string[]; headline?: string; body?: string }> {
  const { translateProductCopy } = await import('../ai/translate.service.js')
  if (kind === 'BULLETS') {
    const out = await translateProductCopy({ source: { bulletPoints: source.bulletPoints ?? [] }, targetLanguage, fields: ['bulletPoints'], productId, feature: 'review-fix' })
    return { bulletPoints: out.bulletPoints ?? [] }
  }
  const out = await translateProductCopy({ source: { name: source.headline ?? '', description: source.body ?? '' }, targetLanguage, fields: ['name', 'description'], productId, feature: 'review-fix' })
  return { headline: out.name ?? '', body: out.description ?? '' }
}

/**
 * The facts each fix needs to become steps. `translate` (only when sending): text written in another language than
 * the market's is translated now; without it a list never calls the AI.
 */
export async function factsFor(rows: readonly FixRow[], opts: { translate: boolean }): Promise<Map<string, FixFacts>> {
  const out = new Map<string, FixFacts>()
  const productIds = [...new Set(rows.map((r) => r.productId).filter((id): id is string => !!id))]
  const products = productIds.length
    ? await prisma.product.findMany({
        where: { id: { in: productIds }, deletedAt: null },
        select: { id: true, sku: true, name: true, amazonAsin: true, children: { where: { deletedAt: null }, select: { id: true } } },
      })
    : []
  const byId = new Map(products.map((p) => [p.id, p]))
  const family = (id: string) => [id, ...(byId.get(id)?.children.map((c) => c.id) ?? [])]
  const needs = (kind: FixKind) => rows.some((r) => kindOf(r) === kind)
  const allIds = [...new Set(products.flatMap((p) => family(p.id)))]
  const [markets, listings, levels] = await Promise.all([
    needs('BULLETS') || needs('APLUS') ? prisma.marketplace.findMany({ select: { channel: true, code: true, language: true, languages: true } }) : Promise.resolve([]),
    needs('APLUS') && allIds.length
      ? prisma.channelListing.findMany({ where: { productId: { in: allIds }, channel: 'AMAZON', listingStatus: 'ACTIVE' }, select: { productId: true, marketplace: true, externalListingId: true, externalParentId: true } })
      : Promise.resolve([]),
    needs('RECALL_FLAG') && allIds.length
      ? prisma.stockLevel.findMany({
          where: { productId: { in: allIds }, variationId: null, available: { gt: 0 }, location: { isActive: true } },
          select: { productId: true, available: true, location: { select: { code: true, type: true } }, product: { select: { sku: true } } },
        })
      : Promise.resolve([]),
  ])

  for (const row of rows) {
    const kind = kindOf(row)
    const p = row.productId ? byId.get(row.productId) : undefined
    const facts: FixFacts = { product: p ? { id: p.id, sku: p.sku, name: p.name } : null, language: null, languageProblem: null, amazonMarket: false, asin: null, text: null, textProblem: null, stock: [] }
    if (p && (kind === 'BULLETS' || kind === 'APLUS')) {
      const market = row.marketplace?.toUpperCase() ?? null
      if (!market) facts.language = PRIMARY_CONTENT_LOCALE
      else {
        const channels = kind === 'APLUS' ? ['AMAZON'] : ['AMAZON', 'EBAY', 'SHOPIFY', 'ETSY']
        for (const channel of channels) {
          if (!markets.some((m) => m.channel.toUpperCase() === channel && m.code.toUpperCase() === market)) continue
          try {
            facts.language = marketLanguages(channel, market, markets)[0]
            break
          } catch (error) {
            facts.languageProblem = `Nexus does not know which language ${whereWords(channel, market)} shows: ${error instanceof Error ? error.message : String(error)}`
          }
        }
        if (!facts.language && !facts.languageProblem) facts.languageProblem = `${marketWords(market) ?? market} is not one of this business’s markets: Nexus does not know which language it shows.`
        if (facts.language) facts.languageProblem = null
      }
      if (kind === 'APLUS' && market) {
        facts.amazonMarket = markets.some((m) => m.channel.toUpperCase() === 'AMAZON' && m.code.toUpperCase() === market)
        const ids = family(p.id)
        const listing = listings.find((l) => ids.includes(l.productId) && l.marketplace.toUpperCase() === market && [l.externalParentId, l.externalListingId].some((v) => v && ASIN.test(v)))
        facts.asin = listing ? [listing.externalParentId, listing.externalListingId].find((v) => v && ASIN.test(v)) ?? null : null
        if (!facts.asin && listings.some((l) => ids.includes(l.productId) && l.marketplace.toUpperCase() === market) && p.amazonAsin && ASIN.test(p.amazonAsin)) facts.asin = p.amazonAsin
      }
      // The proposal's text, in the language it was written in (the AI writes English), and in the market's.
      const payload = payloadOf(row)
      const written = lang(payload.language)
      const source = kind === 'BULLETS'
        ? { bulletPoints: strings(payload.bullets) }
        : { headline: str(payload.module?.headline) ?? undefined, body: str(payload.module?.body) ?? undefined }
      const englishOf = () => {
        if (written === 'en') return kind === 'BULLETS' ? (source.bulletPoints ?? []).join('\n') : [source.headline, source.body].filter(Boolean).join(': ')
        const english = payload.english
        if (Array.isArray(english)) return strings(english).join('\n') || null
        return str(english)
      }
      if (facts.language && (written === facts.language)) facts.text = { ...source, english: facts.language === 'en' ? null : englishOf() }
      else if (facts.language && opts.translate) {
        try {
          facts.text = { ...(await translated(kind, source, facts.language, p.id)), english: englishOf() }
        } catch (error) {
          const into = new Intl.DisplayNames(['en'], { type: 'language' }).of(facts.language) ?? facts.language
          facts.textProblem = `Nexus could not translate the text into ${into} (${error instanceof Error ? error.message : String(error)}): edit the proposal with the ${into} text, or try again.`
        }
      } else facts.text = null
    }
    if (p && kind === 'RECALL_FLAG') {
      const ids = family(p.id)
      facts.stock = levels
        .filter((l) => ids.includes(l.productId))
        .map((l) => ({ productId: l.productId, sku: l.product.sku, location: l.location.code, locationType: l.location.type, available: l.available }))
    }
    out.set(row.id, facts)
  }
  return out
}

/** Why a fix cannot be sent, without sending (no translation, no AI): what the Fixes page shows on its button. */
export function listHeld(fix: FixRow, facts: FixFacts | undefined): string | null {
  const status = statusHeld(fix.status)
  if (status) return null
  const kind = kindOf(fix)
  if (kind === 'TASK') return null
  if (!facts) return null
  // The text is translated when it is sent: checked here as if it were.
  const probe: FixFacts = facts.text || facts.textProblem || !facts.language
    ? facts
    : { ...facts, text: kind === 'BULLETS' ? { bulletPoints: strings(payloadOf(fix).bullets), english: 'x' } : { headline: str(payloadOf(fix).module?.headline) ?? undefined, body: str(payloadOf(fix).module?.body) ?? undefined, english: 'x' } }
  const out = stepsForFix(fix, probe, { days: Number(payloadOf(fix).days) || undefined })
  return 'held' in out ? out.held : null
}

// ── Following the plan ───────────────────────────────────────────────

const PLAN_STATE: Record<string, { state: 'waiting' | 'scheduled' | 'running' | 'done' | 'declined' | 'expired'; words: string }> = {
  pending: { state: 'waiting', words: 'Change plan waits on the Approvals page' },
  scheduled: { state: 'scheduled', words: 'Approved: it runs after the undo window' },
  approved: { state: 'scheduled', words: 'Approved: it runs shortly' },
  executing: { state: 'running', words: 'Approved: the changes are being made' },
  executed: { state: 'done', words: 'The change plan ran' },
  rejected: { state: 'declined', words: 'Declined on the Approvals page' },
  expired: { state: 'expired', words: 'Nobody approved it before it expired' },
}

/**
 * Every Sent fix follows its plan: Applied once the plan ran (with how many of its own changes were made), Open again
 * when the plan was declined, withdrawn, expired, or ran without making any of its changes. Idempotent.
 */
export async function syncSentFixes(now = new Date()): Promise<number> {
  const sent = await prisma.reviewActionItem.findMany({ where: { status: 'SENT', approvalId: { not: null } }, select: { id: true, approvalId: true, payload: true } })
  if (sent.length === 0) return 0
  const approvalIds = [...new Set(sent.map((s) => s.approvalId!))]
  const [approvals, steps] = await Promise.all([
    prisma.agentApproval.findMany({ where: { id: { in: approvalIds } }, select: { id: true, status: true, reason: true, decidedBy: true, decidedAt: true } }),
    prisma.agentPlanStep.findMany({ where: { approvalId: { in: approvalIds } }, select: { approvalId: true, position: true, status: true, reason: true } }),
  ])
  const byId = new Map(approvals.map((a) => [a.id, a]))
  let moved = 0
  for (const fix of sent) {
    const approval = byId.get(fix.approvalId!)
    const payload = payloadOf(fix)
    const positions = payload.plan?.positions ?? []
    let data: Prisma.ReviewActionItemUpdateManyMutationInput | null = null
    if (!approval) {
      data = { status: 'OPEN', approvalId: null, payload: { ...payload, lastSend: { words: 'Its change plan is gone: send it again.', at: now.toISOString() } } as Prisma.InputJsonValue }
    } else if (approval.status === 'executed') {
      const own = steps.filter((s) => s.approvalId === approval.id && (positions.length === 0 || positions.includes(s.position)))
      const done = own.filter((s) => s.status === 'done').length
      const notRun = own.filter((s) => s.status === 'skipped' || s.status === 'failed')
      if (done > 0 || own.length === 0) {
        const words = notRun.length ? `${done} of ${own.length} changes made; ${notRun.length} not: ${notRun[0].reason ?? 'see the change plan'}` : `Applied${approval.decidedBy ? ` · approved by ${approval.decidedBy}` : ''}`
        data = { status: 'APPLIED', payload: { ...payload, applied: { words, at: (approval.decidedAt ?? now).toISOString() } } as Prisma.InputJsonValue }
      } else {
        data = { status: 'OPEN', approvalId: null, payload: { ...payload, lastSend: { words: `The change plan ran but made none of this fix’s changes: ${notRun[0]?.reason ?? 'see the change plan'}`, at: now.toISOString(), approvalId: approval.id } } as Prisma.InputJsonValue }
      }
    } else if (approval.status === 'rejected' || approval.status === 'expired') {
      const withdrawn = (approval.reason ?? '').startsWith('withdrawn')
      const words = withdrawn ? 'Withdrawn before anyone approved it' : approval.status === 'expired' ? PLAN_STATE.expired.words : `Declined on the Approvals page${approval.decidedBy ? ` by ${approval.decidedBy}` : ''}`
      data = { status: 'OPEN', approvalId: null, payload: { ...payload, lastSend: { words, at: (approval.decidedAt ?? now).toISOString(), approvalId: approval.id } } as Prisma.InputJsonValue }
    }
    if (!data) continue
    const changed = await prisma.reviewActionItem.updateMany({ where: { id: fix.id, status: 'SENT', approvalId: fix.approvalId }, data })
    moved += changed.count
  }
  return moved
}

// ── The list ─────────────────────────────────────────────────────────

export interface FixItem {
  id: string
  kind: FixKind
  kindWords: string
  status: FixStatus
  title: string
  detail: string | null
  product: { id: string; sku: string; name: string } | null
  market: string | null
  theme: { key: string; label: string } | null
  spikeId: string | null
  proposal: { bullets?: string[]; module?: { headline: string; body: string } | null; language: string; english?: unknown; days?: number }
  /** Why it cannot be sent now, with the way out; null when it can (or is not Open). */
  held: string | null
  plan: { approvalId: string; state: string; words: string; sentBy: string | null; sentAt: string | null; expiresAt: string | null } | null
  task: { createdBy: string | null; createdAt: string | null; assignee: string | null } | null
  applied: { words: string; at: string | null; approvalId: string | null } | null
  lastSend: { words: string; at: string | null } | null
  source: string
  createdBy: string | null
  createdAt: string
}

export async function listFixes(input: { status?: unknown; kind?: unknown; productId?: unknown; spikeId?: unknown; limit?: unknown; now?: Date } = {}): Promise<{ items: FixItem[]; count: number; counts: Record<FixStatus, number> }> {
  const now = input.now ?? new Date()
  await syncSentFixes(now).catch((error) => logger.warn('[review-fixes] sync with change plans failed', { error: error instanceof Error ? error.message : String(error) }))
  const statusText = typeof input.status === 'string' ? input.status.trim().toUpperCase() : ''
  const status = (FIX_STATUSES as readonly string[]).includes(statusText) ? statusText : null
  const kinds = (typeof input.kind === 'string' ? input.kind.split(',') : []).map((k) => k.trim().toUpperCase()).filter((k) => (FIX_KINDS as readonly string[]).includes(k))
  const scope: Prisma.ReviewActionItemWhereInput = {
    ...(kinds.length ? { type: { in: kinds } } : {}),
    ...(typeof input.productId === 'string' && input.productId.trim() ? { productId: input.productId.trim() } : {}),
    ...(typeof input.spikeId === 'string' && input.spikeId.trim() ? { spikeId: input.spikeId.trim() } : {}),
  }
  const [rows, grouped] = await Promise.all([
    prisma.reviewActionItem.findMany({ where: { ...scope, ...(status ? { status } : {}) }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: Math.min(Math.max(Number(input.limit) || 100, 1), 300) }),
    prisma.reviewActionItem.groupBy({ by: ['status'], where: scope, _count: { _all: true } }),
  ])
  const counts = Object.fromEntries(FIX_STATUSES.map((s) => [s, grouped.find((g) => g.status === s)?._count._all ?? 0])) as Record<FixStatus, number>
  const facts = await factsFor(rows.filter((r) => r.status === 'OPEN'), { translate: false })
  const approvalIds = [...new Set(rows.map((r) => r.approvalId).filter((id): id is string => !!id))]
  const approvals = approvalIds.length
    ? await prisma.agentApproval.findMany({ where: { id: { in: approvalIds } }, select: { id: true, status: true, expiresAt: true } })
    : []
  const products = new Map((await prisma.product.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.productId).filter((id): id is string => !!id))] } }, select: { id: true, sku: true, name: true } })).map((p) => [p.id, p]))
  const names = await peopleNames(rows.flatMap((r) => [payloadOf(r).plan?.sentBy, payloadOf(r).task?.createdBy, payloadOf(r).task?.assignee ?? null]))

  const items: FixItem[] = rows.map((r) => {
    const payload = payloadOf(r)
    const kind = kindOf(r)
    const approval = approvals.find((a) => a.id === r.approvalId)
    const module = payload.module && typeof payload.module === 'object' ? { headline: str(payload.module.headline) ?? '', body: str(payload.module.body) ?? '' } : null
    const applied = payload.applied as { words?: string; at?: string } | undefined
    return {
      id: r.id,
      kind,
      kindWords: KIND_WORDS[kind],
      status: r.status as FixStatus,
      title: r.title,
      detail: r.detail,
      product: r.productId ? products.get(r.productId) ?? null : null,
      market: r.marketplace,
      theme: r.category ? { key: r.category, label: themeWords(r.category) } : null,
      spikeId: r.spikeId,
      proposal: {
        ...(kind === 'BULLETS' ? { bullets: strings(payload.bullets) } : {}),
        ...(kind === 'APLUS' ? { module } : {}),
        language: lang(payload.language),
        ...(payload.english != null ? { english: payload.english } : {}),
        ...(kind === 'RECALL_FLAG' ? { days: Number(payload.days) || RECALL_HOLD_DAYS } : {}),
      },
      held: r.status === 'OPEN' ? listHeld(r, facts.get(r.id)) : null,
      plan: r.status === 'SENT' && r.approvalId
        ? {
            approvalId: r.approvalId,
            state: PLAN_STATE[approval?.status ?? 'pending']?.state ?? 'waiting',
            words: PLAN_STATE[approval?.status ?? 'pending']?.words ?? PLAN_STATE.pending.words,
            sentBy: payload.plan?.sentBy ? names.get(payload.plan.sentBy) ?? null : null,
            sentAt: payload.plan?.sentAt ?? null,
            expiresAt: approval?.expiresAt?.toISOString() ?? null,
          }
        : null,
      task: payload.task ? { createdBy: payload.task.createdBy ? names.get(payload.task.createdBy) ?? null : null, createdAt: payload.task.createdAt ?? null, assignee: payload.task.assignee ? names.get(payload.task.assignee) ?? null : null } : null,
      applied: r.status === 'APPLIED' ? { words: applied?.words ?? (payload.task ? 'Task created: nothing changed on a channel' : 'Applied'), at: applied?.at ?? payload.task?.createdAt ?? null, approvalId: r.approvalId } : null,
      lastSend: r.status === 'OPEN' && payload.lastSend?.words ? { words: payload.lastSend.words, at: payload.lastSend.at ?? null } : null,
      source: r.source,
      createdBy: r.createdBy,
      createdAt: r.createdAt.toISOString(),
    }
  })
  return { items, count: items.length, counts }
}

// ── Send for approval ───────────────────────────────────────────────

export interface HeldFix {
  id: string
  words: string
}

export interface ProposeAnswer {
  changed: number
  held: HeldFix[]
  /** The ONE change plan the sendable fixes went into. */
  sent: { approvalId: string; fixes: number; steps: number; expiresAt: string | null; summary: string | null } | null
  /** Tasks created without approval. */
  tasks: number
}

type Requester = (tool: string, args: Record<string, unknown>, person: UserPrincipal) => Promise<{
  ok: boolean
  mode: string
  approvalId?: string
  expiresAt?: Date | null
  error?: string
  plan?: { steps: number; summary: string; planHash: string }
  refusals?: Array<{ step: number; tool: string; error: string }>
}>

async function defaultRequester(): Promise<{ ask: Requester; planTool: string }> {
  const [{ requestApproval }, { PLAN_TOOL }] = await Promise.all([import('../agents/approval-gate.service.js'), import('../agents/tool-types.js')])
  return { ask: requestApproval as Requester, planTool: PLAN_TOOL }
}

function planTitle(fixes: readonly FixRow[]): string {
  const kinds = new Map<string, number>()
  for (const f of fixes) kinds.set(KIND_WORDS[kindOf(f)], (kinds.get(KIND_WORDS[kindOf(f)]) ?? 0) + 1)
  const parts = [...kinds.entries()].map(([k, n]) => `${n} × ${k}`).join(', ')
  return `Reviews fixes: ${fixes.length} ${fixes.length === 1 ? 'fix' : 'fixes'} from buyers’ reviews (${parts})`.slice(0, 120)
}

/**
 * "Send for approval" for the ticked fixes: ONE change plan for every fix that can be sent, Tasks created at once
 * without approval, and every other fix held with why. `requester` is the approval door (tests pass their own).
 */
export async function proposeFixes(ids: readonly string[], person: UserPrincipal, opts: { now?: Date; requester?: { ask: Requester; planTool: string } } = {}): Promise<ProposeAnswer> {
  const now = opts.now ?? new Date()
  const rows = await prisma.reviewActionItem.findMany({ where: { id: { in: [...ids] } } })
  const byId = new Map(rows.map((r) => [r.id, r]))
  const held: HeldFix[] = []
  const tasks: FixRow[] = []
  const sendable: FixRow[] = []
  for (const id of ids) {
    const row = byId.get(id)
    if (!row) {
      held.push({ id, words: NOT_FOUND })
      continue
    }
    const why = statusHeld(row.status)
    if (why) held.push({ id, words: why })
    else if (kindOf(row) === 'TASK') tasks.push(row)
    else sendable.push(row)
  }

  let taskCount = 0
  for (const t of tasks) {
    const made = await markTask(t, person.userId, null, now)
    if (made) taskCount += 1
    else held.push({ id: t.id, words: 'Someone changed it a moment ago: reload the list.' })
  }

  // Each sendable fix becomes its steps, or is held with why.
  const facts = sendable.length ? await factsFor(sendable, { translate: true }) : new Map<string, FixFacts>()
  let entries: Array<{ fix: FixRow; steps: ToolStep[] }> = []
  for (const fix of sendable) {
    try {
      const out = stepsForFix(fix, facts.get(fix.id)!, { days: Number(payloadOf(fix).days) || undefined })
      if ('held' in out) held.push({ id: fix.id, words: out.held })
      else entries.push({ fix, steps: out.steps })
    } catch (error) {
      held.push({ id: fix.id, words: error instanceof Error ? error.message : String(error) })
    }
  }

  let sent: ProposeAnswer['sent'] = null
  const door = opts.requester ?? (entries.length ? await defaultRequester() : null)
  // A step the plan refuses holds only its own fix; the rest are asked for again (at most three times).
  for (let round = 0; round < 3 && entries.length > 0 && door; round++) {
    const steps = entries.flatMap((e) => e.steps)
    const owner = entries.flatMap((e) => e.steps.map(() => e.fix.id))
    const asked = await door.ask(door.planTool, { title: planTitle(entries.map((e) => e.fix)), steps }, person)
    if (asked.ok && asked.mode === 'queued' && asked.approvalId) {
      let position = 1
      let fixes = 0
      for (const e of entries) {
        const positions = e.steps.map(() => position++)
        const payload = { ...payloadOf(e.fix), plan: { approvalId: asked.approvalId, positions, sentBy: person.userId, sentAt: now.toISOString() }, lastSend: null }
        const done = await prisma.reviewActionItem.updateMany({
          where: { id: e.fix.id, status: 'OPEN' },
          data: { status: 'SENT', approvalId: asked.approvalId, payload: payload as Prisma.InputJsonValue },
        })
        fixes += done.count
      }
      sent = { approvalId: asked.approvalId, fixes, steps: steps.length, expiresAt: asked.expiresAt ? new Date(asked.expiresAt).toISOString() : null, summary: asked.plan?.summary ?? null }
      break
    }
    if (asked.refusals?.length) {
      const refused = new Map<string, string>()
      for (const r of asked.refusals) {
        const id = owner[r.step - 1]
        if (id && !refused.has(id)) refused.set(id, `Not sent — ${TOOL_WORDS[r.tool] ?? r.tool}: ${r.error}`)
      }
      if (refused.size === 0) {
        for (const e of entries) held.push({ id: e.fix.id, words: asked.error ?? 'The change plan was refused.' })
        entries = []
        break
      }
      for (const [id, words] of refused) held.push({ id, words })
      entries = entries.filter((e) => !refused.has(e.fix.id))
      continue
    }
    for (const e of entries) held.push({ id: e.fix.id, words: asked.error ?? 'The change plan was refused.' })
    entries = []
  }
  if (!sent) for (const e of entries) if (!held.some((h) => h.id === e.fix.id)) held.push({ id: e.fix.id, words: 'Not sent: the change plan kept being refused. Try again.' })

  return { changed: taskCount + (sent?.fixes ?? 0), held, sent, tasks: taskCount }
}

// ── Tasks, dismiss, bring back, edit, withdraw ──────────────────────

async function markTask(fix: FixRow, actor: string, assignee: string | null, now: Date): Promise<boolean> {
  const payload = { ...payloadOf(fix), task: { createdBy: actor, createdAt: now.toISOString(), assignee } }
  const done = await prisma.reviewActionItem.updateMany({ where: { id: fix.id, status: 'OPEN' }, data: { status: 'APPLIED', approvalId: null, payload: payload as Prisma.InputJsonValue } })
  return done.count > 0
}

/** "Create task": any Open fix becomes a task for a person — no approval, nothing reaches a channel. */
export async function createFixTask(id: string, actor: string, assignee: string | null = null, now = new Date()) {
  const fix = await prisma.reviewActionItem.findUnique({ where: { id } })
  if (!fix) throw new FixNotFoundError(NOT_FOUND)
  const why = statusHeld(fix.status)
  if (why) throw new FixConflictError(why)
  if (!(await markTask(fix, actor, assignee, now))) throw new FixConflictError('Someone changed it a moment ago: reload the list.')
  return { ok: true, item: await prisma.reviewActionItem.findUnique({ where: { id } }) }
}

/** The bulk bar: propose (one change plan) or dismiss the ticked fixes. */
export async function bulkFixes(body: unknown, person: UserPrincipal, opts: { now?: Date; requester?: { ask: Requester; planTool: string } } = {}): Promise<ProposeAnswer | { changed: number; held: HeldFix[] }> {
  const { ids, action } = parseBulk(body, ['propose', 'dismiss'] as const)
  if (action === 'propose') return proposeFixes(ids, person, opts)
  return dismissFixes(ids)
}

export async function dismissFixes(ids: readonly string[]): Promise<{ changed: number; held: HeldFix[] }> {
  const rows = await prisma.reviewActionItem.findMany({ where: { id: { in: [...ids] } }, select: { id: true, status: true } })
  const byId = new Map(rows.map((r) => [r.id, r]))
  const held: HeldFix[] = []
  const apply: string[] = []
  for (const id of ids) {
    const row = byId.get(id)
    if (!row) held.push({ id, words: NOT_FOUND })
    else if (row.status === 'DISMISSED') held.push({ id, words: 'Already dismissed.' })
    else if (row.status === 'SENT') held.push({ id, words: 'Sent for approval: withdraw it first.' })
    else if (row.status === 'APPLIED') held.push({ id, words: 'Applied: undo it from its change plan.' })
    else apply.push(id)
  }
  if (apply.length === 0) return { changed: 0, held }
  const done = await prisma.reviewActionItem.updateMany({ where: { id: { in: apply }, status: 'OPEN' }, data: { status: 'DISMISSED' } })
  return { changed: done.count, held }
}

/**
 * PATCH: Dismiss (Open → Dismissed), Bring back (Dismissed → Open), or an edit of the proposal while it is Open.
 * There is no direct Apply: a fix is applied through its change plan, or made a task.
 */
export async function updateFix(id: string, body: unknown) {
  const b = (body ?? {}) as Record<string, unknown>
  const fix = await prisma.reviewActionItem.findUnique({ where: { id } })
  if (!fix) throw new FixNotFoundError(NOT_FOUND)
  const status = typeof b.status === 'string' ? b.status.trim().toUpperCase() : null
  if (status) {
    if (status === 'APPLIED') throw new InsightsInputError('A fix is applied through its change plan: send it for approval, or create a task.')
    if (status === 'SENT') throw new InsightsInputError('Send it for approval with POST /reviews/action-items/:id/propose.')
    if (status !== 'OPEN' && status !== 'DISMISSED') throw new InsightsInputError('status: OPEN (bring back) or DISMISSED.')
    const from = status === 'OPEN' ? 'DISMISSED' : 'OPEN'
    if (fix.status !== from) throw new FixConflictError(status === 'OPEN' ? (fix.status === 'OPEN' ? 'It is open already.' : statusHeld(fix.status) ?? 'It cannot be brought back.') : statusHeld(fix.status) ?? 'It cannot be dismissed.')
    await prisma.reviewActionItem.updateMany({ where: { id, status: from }, data: { status } })
    return { ok: true, item: await prisma.reviewActionItem.findUnique({ where: { id } }) }
  }
  // An edit of the proposal.
  if (fix.status !== 'OPEN') throw new FixConflictError(statusHeld(fix.status) ?? 'Only an open fix can be edited.')
  const payload = { ...payloadOf(fix) }
  const data: Prisma.ReviewActionItemUpdateInput = {}
  if (b.title !== undefined) {
    const title = str(b.title)
    if (!title || title.length > 200) throw new InsightsInputError('title: 1 to 200 characters.')
    data.title = title
  }
  if (b.bullets !== undefined) {
    const bullets = strings(b.bullets)
    if (!Array.isArray(b.bullets) || bullets.length === 0 || bullets.length > MAX_BULLETS || bullets.some((x) => x.length > 500)) throw new InsightsInputError(`bullets: 1 to ${MAX_BULLETS} bullet points, each at most 500 characters.`)
    payload.bullets = bullets
  }
  if (b.module !== undefined) {
    const m = (b.module ?? {}) as { headline?: unknown; body?: unknown }
    const headline = str(m.headline)
    const text = str(m.body)
    if (!headline || !text || headline.length > 150 || text.length > 2000) throw new InsightsInputError('module: a headline (at most 150 characters) and a text (at most 2,000).')
    payload.module = { headline, body: text }
  }
  if (b.language !== undefined) {
    if (typeof b.language !== 'string' || !/^[a-z]{2}$/i.test(b.language.trim())) throw new InsightsInputError('language: a two-letter code, e.g. en or de.')
    payload.language = b.language.trim().toLowerCase()
  }
  if (b.english !== undefined) {
    const english = Array.isArray(b.english) ? strings(b.english) : str(b.english)
    if (english == null || (Array.isArray(english) && english.length === 0)) throw new InsightsInputError('english: what the text says in English.')
    payload.english = english
  }
  if (b.days !== undefined) {
    const days = Number(b.days)
    if (!Number.isInteger(days) || days < 1 || days > 90) throw new InsightsInputError('days: a whole number of days, 1 to 90.')
    payload.days = days
  }
  if (Object.keys(data).length === 0 && JSON.stringify(payload) === JSON.stringify(payloadOf(fix))) throw new InsightsInputError('Nothing to change: give status, or an edit (title, bullets, module, language, english, days).')
  data.payload = payload as Prisma.InputJsonValue
  const done = await prisma.reviewActionItem.updateMany({ where: { id, status: 'OPEN', updatedAt: fix.updatedAt }, data: data as Prisma.ReviewActionItemUpdateManyMutationInput })
  if (done.count === 0) throw new FixConflictError('Someone changed it a moment ago: reload it.')
  return { ok: true, item: await prisma.reviewActionItem.findUnique({ where: { id } }) }
}

/** Withdraw: the waiting change plan is taken back; every fix sent in it is Open again. */
export async function withdrawFix(id: string, actor: string, now = new Date()): Promise<{ withdrawn: true; approvalId: string; fixes: number }> {
  const fix = await prisma.reviewActionItem.findUnique({ where: { id }, select: { id: true, status: true, approvalId: true } })
  if (!fix) throw new FixNotFoundError(NOT_FOUND)
  if (fix.status !== 'SENT' || !fix.approvalId) throw new FixConflictError('It is not waiting for approval: nothing to withdraw.')
  const approval = await prisma.agentApproval.findUnique({ where: { id: fix.approvalId }, select: { id: true, status: true } })
  if (approval && !['pending', 'scheduled'].includes(approval.status)) {
    await syncSentFixes(now)
    throw new FixConflictError(
      approval.status === 'approved' || approval.status === 'executing' || approval.status === 'executed'
        ? 'It was approved already: undo it from its change plan on the Approvals page.'
        : 'It is not waiting any more: it was declined or expired, and is Open again.',
    )
  }
  const name = (await peopleNames([actor])).get(actor) ?? 'someone'
  if (approval) {
    const taken = await prisma.agentApproval.updateMany({
      where: { id: approval.id, status: { in: ['pending', 'scheduled'] } },
      data: { status: 'rejected', decidedBy: name, decidedByUserId: actor, decidedAt: now, executeAfter: null, decisionVia: null, reason: 'withdrawn: taken back from Reviews › Fixes before anyone approved it' },
    })
    if (taken.count === 0) {
      await syncSentFixes(now)
      throw new FixConflictError('It was decided a moment ago: reload the list.')
    }
  }
  const inPlan = await prisma.reviewActionItem.findMany({ where: { approvalId: fix.approvalId, status: 'SENT' }, select: { id: true, payload: true } })
  let fixes = 0
  for (const f of inPlan) {
    const payload = { ...payloadOf(f), lastSend: { words: `Withdrawn by ${name}`, at: now.toISOString(), approvalId: fix.approvalId } }
    const done = await prisma.reviewActionItem.updateMany({ where: { id: f.id, status: 'SENT' }, data: { status: 'OPEN', approvalId: null, payload: payload as Prisma.InputJsonValue } })
    fixes += done.count
  }
  return { withdrawn: true, approvalId: fix.approvalId, fixes }
}
