/**
 * ONE BRAIN AB-10 — the negatives run (design 2026-10-08-ads-one-brain/DESIGN.md §2.7, §4 step 4, §5, §8 row AB-10, §10).
 * Once a day (jobs/ads-brain-negatives.job.ts), inside one business: for every product whose negatives lever is OBSERVE
 * or higher, the term ledger decides each term (brain/terms-shadow.ts, the same pure path AB-9 stores), brain/negatives.ts
 * decides the day's negatives, and each one acts at its campaign's level:
 *
 *   OBSERVE  logged only (status SHADOW): nothing at Amazon, no request
 *   PROPOSE  ONE change plan for the product's day (submit-change-plan, through the normal approval gate, as the system
 *            principal "Nexus ads brain"): each add is an add-negative-targets step, each retire a retire-negatives step,
 *            so a person approves them in Nexus and they run as that person through the tools' own checks (the Owner's
 *            rule 2 — a converting term is never negated — and rule 3 among them). A step a tool refuses is left out,
 *            named (REFUSED), and the rest is asked. A request still waiting is not asked again; one the Owner rejected
 *            waits REJECTED_HOLD_DAYS.
 *   AUTO     written as the brain (BRAIN_NEGATIVES_ACTOR) through the existing write paths, hard rule 4: an add through the
 *            one negative write service (ads-negative-kw.service.ts: protected terms, the lock L1, dedupe, the write gate
 *            with the campaign and the negatives lever, then the channel gateway, the row and its audit row); a retire
 *            through the Negatives page's retire (negatives-retire.service.ts: the outbound queue, the gate at dispatch,
 *            the gateway). The gate passes the brain only on a lever its product owns; every refusal is kept in its words.
 *
 *   facts     the market once (loadTermsMarket, a fixed number of reads), then per product a fixed number more: its own
 *             campaigns and ad groups, their positives and standing negatives, who made each negative (the create audit
 *             rows), each term's record per ad group over the ledger's window, the Owner's overrides (per campaign: the
 *             lever, the locks, the per-entity budget), the enrollment and the lever's history (the shadow days), the
 *             playbook's negative set, and the product's own log (today's count, requests waiting).
 *   stored    one row per negative per product × market (AdsBrainNegative): created when new, rewritten when its decision
 *             changed, only stamped when not (a rerun the same day changes and writes nothing). A row first, the act after:
 *             what was written or asked is on the row before the run ends.
 *   kept      30 days: rows no run has checked since are deleted (also when nothing is due).
 *   nothing   no product enrolled (production today): the enrollments are read, nothing decided, written or asked.
 */
import { createHash, randomUUID } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import prisma from '../../../db.js'
import { inDatabaseTransaction } from '../../../lib/database-context.js'
import { logger } from '../../../utils/logger.js'
import { settledBounds } from '../ads-settled-window.js'
import { isAsin } from '../ads-negation-policy.js'
import { positivesIn } from '../ads-winner-lock.js'
import type { AdWriteEvidence } from '../ads-evidence.js'
import { brainLiveCeiling } from '../bid-brain/live.js'
import { resolveBrainSettings, type OverrideRow } from './settings.js'
import { decideMarket, loadTermsMarket, termsDue, type DueProduct, type MarketDecisions, type MarketFacts } from './terms-shadow.js'
import { addEvidence, LEDGER_WINDOW_DAYS, NO_TERM_EVIDENCE, productEstimate, termKey, type LeverEffective, type TermEvidence } from './terms.js'
import {
  BRAIN_NEGATIVES_ACTOR, decideNegatives, reconcile, shadowSinceOf,
  type ApprovalFact, type NegativesInput, type NegativesPlan, type NegItem, type NegStatus, type Origin, type PreviousRow, type Reconciled, type StandingNegative,
} from './negatives.js'

/** Log rows no run has checked for this long are deleted (Neon cost; the design's 30-day retention, §9). */
export const NEGATIVES_DAYS_KEPT = 30
const ACTS: readonly string[] = ['OBSERVE', 'PROPOSE', 'AUTO']
const CHANGE_PLAN_TOOL = 'submit-change-plan'
const ADD_TOOL = 'add-negative-targets'
const RETIRE_TOOL = 'retire-negatives'
/** The most steps one day's request holds (PLAN_MAX_STEPS). */
const MAX_PLAN_STEPS = 200
const OVERRIDE_SELECT = { id: true, productId: true, marketplace: true, scope: true, campaignId: true, kind: true, key: true, ref: true, value: true, by: true, reason: true, createdAt: true, endedAt: true } as const
const COUNTED: readonly string[] = ['WRITTEN', 'QUEUED', 'PROPOSED']
/** Outcomes a row keeps word for word while the log keeps its status. */
const ACTED: readonly string[] = ['WRITTEN', 'QUEUED', 'REFUSED', 'FAILED', 'PROPOSED']

// ── Who is due ───────────────────────────────────────────────────────────────────────────────────────────────────

export interface NegativesDue { due: boolean; why: string; products: DueProduct[] }

/** Enrolled products whose negatives lever is OBSERVE or higher (product level). Nothing enrolled: one read. */
export async function negativesDue(): Promise<NegativesDue> {
  const terms = await termsDue()
  if (!terms.due && /no product is enrolled/.test(terms.why)) return { due: false, why: 'no product is enrolled in the brain: no negative to decide', products: [] }
  const products = terms.products.filter((d) => ACTS.includes(d.settings.levers.negatives.effective))
  return products.length
    ? { due: true, why: `${products.length} product${products.length === 1 ? '' : 's'} with the negatives lever at OBSERVE or higher`, products }
    : { due: false, why: 'no enrolled product has its negatives lever at OBSERVE or higher: no negative to decide', products: [] }
}

// ── One product's facts ──────────────────────────────────────────────────────────────────────────────────────────

const asinTerm = (s: string) => (isAsin(s) ? s.trim().toLowerCase() : null)
const dayStart = (d: Date) => new Date(`${d.toISOString().slice(0, 10)}T00:00:00Z`)

/** Who made a negative, from the actor of its create audit row. */
export function originOf(actor: string | null | undefined): Origin {
  const a = (actor ?? '').trim()
  if (!a) return 'unknown'
  if (a.startsWith('automation:ads-brain')) return 'brain'
  if (a.startsWith('automation:')) return 'automation'
  return 'person'
}

export interface LogRow extends PreviousRow {
  id: string
  action: string
  reason: string
  status: string
  digest: string
  firstSeenAt: Date
  createdAt: Date
  adTargetId: string | null
  outboundQueueId: string | null
  result: string | null
}

export interface ProductNegatives {
  input: NegativesInput
  /** The product's log, by key. */
  previous: Map<string, LogRow>
  approvals: Map<string, ApprovalFact>
  productName: string | null
  /** The product's level of the lever (what makes it due) and why. */
  lever: { effective: LeverEffective; why: string }
}

/**
 * Everything brain/negatives.ts reads for one product, after the market's facts and the ledger's decisions. Null when
 * the product has no Sponsored Products campaign of its own in the market. `asIfEnrolled`: a dry run for a product not
 * enrolled yet resolves its settings as the default levels would (the read view).
 */
export async function loadNegativesFacts(m: MarketFacts, decided: MarketDecisions, due: DueProduct, now: Date, opts: { asIfEnrolled?: boolean } = {}): Promise<ProductNegatives | null> {
  const root = due.productId
  const p = m.products.get(root)
  const ctx = m.contexts.get(root)
  if (!p || !ctx) return null
  const market = m.market
  const campaignIds = [...p.campaigns].sort()
  const groupIds = [...p.adGroups].sort()
  const window = settledBounds(LEDGER_WINDOW_DAYS, 'SPONSORED_PRODUCTS', { now })
  const [campaigns, groups, positives, negatives, overrides, enrollment, members, logRows] = await Promise.all([
    prisma.campaign.findMany({ where: { id: { in: campaignIds } }, select: { id: true, name: true, status: true, targetingType: true, externalCampaignId: true } }),
    groupIds.length ? prisma.adGroup.findMany({ where: { id: { in: groupIds } }, select: { id: true, campaignId: true, name: true, status: true, externalAdGroupId: true } }) : Promise.resolve([]),
    positivesIn(groupIds),
    groupIds.length
      ? prisma.adTarget.findMany({
        where: { adGroupId: { in: groupIds }, isNegative: true, kind: { in: ['KEYWORD', 'PRODUCT'] }, status: { not: 'ARCHIVED' } },
        select: { id: true, adGroupId: true, kind: true, expressionType: true, expressionValue: true, negativeLevel: true, externalTargetId: true, status: true, createdAt: true },
      })
      : Promise.resolve([]),
    // Every override of the product and its campaigns, the ended ones too (the lever's history decides the shadow days).
    prisma.adsBrainOverride.findMany({ where: { OR: [{ scope: 'PRODUCT', productId: root, marketplace: market }, ...(campaignIds.length ? [{ scope: 'CAMPAIGN', campaignId: { in: campaignIds } }] : [])] }, select: OVERRIDE_SELECT }) as Promise<OverrideRow[]>,
    prisma.adsBrainEnrollment.findFirst({ where: { productId: root, marketplace: market }, select: { createdAt: true } }),
    prisma.product.findMany({ where: { deletedAt: null, OR: [{ id: root }, { parentId: root }] }, select: { id: true, name: true } }),
    prisma.adsBrainNegative.findMany({
      where: { productId: root, marketplace: market },
      select: { id: true, key: true, action: true, reason: true, status: true, approvalId: true, actedAt: true, digest: true, firstSeenAt: true, createdAt: true, adTargetId: true, outboundQueueId: true, result: true },
    }),
  ])
  const groupById = new Map(groups.map((g) => [g.id, g]))
  const enrolled = !!enrollment || opts.asIfEnrolled === true

  // Who made each standing negative (one read, chunked).
  const negIds = negatives.map((n) => n.id)
  const actorOf = new Map<string, string | null>()
  for (let i = 0; i < negIds.length; i += 1000) {
    const logs = await prisma.advertisingActionLog.findMany({
      where: { entityType: 'AD_TARGET', entityId: { in: negIds.slice(i, i + 1000) }, actionType: { startsWith: 'create_negative' } },
      select: { entityId: true, userId: true, createdAt: true }, orderBy: { createdAt: 'asc' },
    })
    for (const l of logs) if (!actorOf.has(l.entityId)) actorOf.set(l.entityId, l.userId)
  }
  const standing: StandingNegative[] = negatives.flatMap((n) => {
    const g = groupById.get(n.adGroupId)
    if (!g) return []
    const product = n.kind === 'PRODUCT'
    const match = product ? 'PRODUCT' as const : /PHRASE/i.test(n.expressionType) ? 'PHRASE' as const : /EXACT/i.test(n.expressionType) ? 'EXACT' as const : null
    if (!match) return []
    const text = product ? n.expressionValue.trim().toLowerCase() : termKey(n.expressionValue)
    if (!text) return []
    return [{
      id: n.id, campaignId: g.campaignId, adGroupId: n.adGroupId, level: n.negativeLevel === 'CAMPAIGN' ? 'CAMPAIGN' as const : 'AD_GROUP' as const, match, text,
      externalTargetId: n.externalTargetId, live: String(n.status) === 'ENABLED' && !!n.externalTargetId, origin: originOf(actorOf.get(n.id)), createdAt: n.createdAt,
    }]
  })

  // Each term's record per ad group over the ledger's window (one aggregate over the product's own campaigns).
  const extCampaigns = campaigns.map((c) => c.externalCampaignId).filter((x): x is string => !!x)
  const groupOfExt = new Map(groups.filter((g) => g.externalAdGroupId).map((g) => [g.externalAdGroupId!, g.id]))
  const places = new Map<string, Map<string, TermEvidence>>()
  if (extCampaigns.length) {
    const rows = await prisma.amazonAdsSearchTerm.groupBy({
      by: ['adGroupId', 'query'],
      where: { campaignId: { in: extCampaigns }, date: { gte: window.since, lte: window.until } },
      _sum: { impressions: true, clicks: true, costMicros: true, orders7d: true, sales7dCents: true },
    })
    for (const r of rows) {
      const groupId = groupOfExt.get(r.adGroupId)
      const term = asinTerm(r.query) ?? termKey(r.query)
      if (!groupId || !term) continue
      const ev: TermEvidence = { impressions: r._sum.impressions ?? 0, clicks: r._sum.clicks ?? 0, orders: r._sum.orders7d ?? 0, salesCents: r._sum.sales7dCents ?? 0, spendCents: Math.round(Number(r._sum.costMicros ?? 0n) / 10_000) }
      const byGroup = places.get(term) ?? new Map<string, TermEvidence>()
      byGroup.set(groupId, addEvidence(byGroup.get(groupId) ?? NO_TERM_EVIDENCE, ev))
      places.set(term, byGroup)
    }
  }

  // The playbook's product negative set (terms.negatives, kept as compile.ts reads it).
  const playbooks = members.length ? await prisma.adsPlaybook.findMany({ where: { channel: 'AMAZON', market, level: 'PRODUCT', scopeId: { in: members.map((x) => x.id) } }, select: { terms: true } }) : []
  const productSet = new Map<string, { text: string; match: 'EXACT' | 'PHRASE' }>()
  for (const row of playbooks) {
    const list = (row.terms as { negatives?: unknown } | null)?.negatives
    if (!Array.isArray(list)) continue
    for (const n of list as Array<{ text?: unknown; match?: unknown }>) {
      if (typeof n?.text !== 'string' || (n.match !== 'EXACT' && n.match !== 'PHRASE')) continue
      productSet.set(`${n.match}|${termKey(n.text)}`, { text: n.text, match: n.match })
    }
  }

  // The lever per campaign (the Owner's campaign choice over the product's), its locks and budget; the product's caps.
  const product = resolveBrainSettings({ productId: root, market, campaignId: null, enrolled, overrides })
  const negCampaigns = campaigns.map((c) => {
    const s = resolveBrainSettings({ productId: root, market, campaignId: c.id, enrolled, overrides })
    const lever = s.levers.negatives
    return {
      id: c.id, name: c.name, status: String(c.status), targetingType: c.targetingType ?? null,
      lever: lever.effective as LeverEffective, leverWhy: `the negatives lever: ${lever.why}`,
      lockedAdGroups: new Set(lever.locks.filter((l) => l.ref.startsWith('adGroup:')).map((l) => l.ref.slice('adGroup:'.length))),
      warn: Number(s.values.negativesPerEntityWarn.value), max: Number(s.values.negativesPerEntityMax.value),
    }
  }).sort((a, b) => a.id.localeCompare(b.id))

  const levelRows = overrides.filter((o) => o.scope === 'PRODUCT' && o.kind === 'LEVEL' && o.key === 'negatives')
    .map((o) => ({ value: o.value, createdAt: new Date(o.createdAt), endedAt: o.endedAt ? new Date(o.endedAt) : null }))
  const today = dayStart(now)
  const previous = new Map<string, LogRow>(logRows.map((r) => [r.key, r as LogRow]))
  const acted = logRows.filter((r) => r.actedAt && r.actedAt >= today && COUNTED.includes(r.status))
  const approvalIds = [...new Set(logRows.map((r) => r.approvalId).filter((x): x is string => !!x))]
  const approvals = new Map<string, ApprovalFact>(approvalIds.length
    ? (await prisma.agentApproval.findMany({ where: { id: { in: approvalIds } }, select: { id: true, status: true, decidedAt: true, expiresAt: true } }))
      // A pending request past its expiry waits for nobody: asked again.
      .map((a) => [a.id, { status: a.status === 'pending' && a.expiresAt && a.expiresAt.getTime() < now.getTime() ? 'expired' : a.status, decidedAt: a.decidedAt ?? null }])
    : [])
  const estimate = productEstimate(ctx.pool)
  const decisions = decided.byProduct.get(root) ?? []
  return {
    input: {
      productId: root, market, now, decisions, protections: ctx.protections, brand: ctx.brand, lockedTerms: ctx.lockedTerms.negatives,
      cr: estimate.cr, aovCents: estimate.aovCents, targetAcos: ctx.targetAcos,
      campaigns: negCampaigns,
      adGroups: groups.map((g) => ({ id: g.id, campaignId: g.campaignId, name: g.name, status: String(g.status), positives: positives.get(g.id) ?? [] })).sort((a, b) => a.id.localeCompare(b.id)),
      standing, places, productSet: [...productSet.values()],
      caps: {
        perDay: Number(product.values.negativesPerDay.value),
        usedToday: acted.filter((r) => r.action === 'ADD').length,
        revivedToday: acted.filter((r) => r.action === 'RETIRE' && r.reason.startsWith('revive')).length,
        actedKeys: new Set(acted.map((r) => r.key)),
      },
      gates: { ceilingLive: brainLiveCeiling(), shadowSince: shadowSinceOf(enrollment?.createdAt ?? (opts.asIfEnrolled ? now : null), levelRows, now), shadowDays: Number(product.values.negativesShadowDays.value) },
    },
    previous, approvals,
    productName: members.find((x) => x.id === root)?.name ?? null,
    lever: { effective: product.levers.negatives.effective as LeverEffective, why: product.levers.negatives.why },
  }
}

/** The plan with each item set against the log: what it is now, and what the run does with it. */
export function reconciledPlan(plan: NegativesPlan, facts: Pick<ProductNegatives, 'previous' | 'approvals'>, now: Date): Array<NegItem & Reconciled> {
  return plan.items.map((i) => {
    const prev = facts.previous.get(i.key)
    return { ...i, ...reconcile(i, prev, prev?.approvalId ? facts.approvals.get(prev.approvalId) : undefined, now) }
  })
}

// ── Store ────────────────────────────────────────────────────────────────────────────────────────────────────────

const json = (v: unknown) => v as Prisma.InputJsonValue
const digestOf = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('base64url').slice(0, 22)
const CHUNK = 500

type Planned = NegItem & Reconciled & { adTargetId?: string | null; outboundQueueId?: string | null; result?: string | null }

/** A log row's content (everything the decision and its outcome say; the run's own fields apart). */
export function rowContent(i: Planned, previous?: LogRow) {
  const content = {
    action: i.action, reason: i.reasons[0], reasons: i.reasons, kind: i.kind, match: i.match, text: i.text, level: i.level, campaignId: i.campaignId, adGroupId: i.adGroupId,
    negativeId: i.negativeId ?? null, origin: i.origin ?? null, coverId: i.coverId ?? null, mode: i.mode, status: i.status, askFirst: i.askFirst,
    // What holds it, only while it is held; what became of it: this run's outcome, else (kept as it was today) the outcome
    // on the row, else the log's note (asked already, rejected).
    heldBy: i.status === 'HELD' ? i.heldBy : null, why: i.why.slice(0, 2000), evidence: i.evidence, approvalId: i.approvalId ?? null,
    adTargetId: i.adTargetId ?? previous?.adTargetId ?? null, outboundQueueId: i.outboundQueueId ?? previous?.outboundQueueId ?? null,
    result: i.result ?? (previous && previous.status === i.status && ACTED.includes(i.status) ? previous.result : null) ?? i.note ?? null,
    actedAt: i.actedAt ? i.actedAt.toISOString() : null,
  }
  return { content, digest: digestOf(content) }
}

export interface StoreCounts { created: number; changed: number; unchanged: number }

/** One product's planned negatives into its log (one transaction): new rows created, changed rewritten, the rest stamped. */
export async function storeNegatives(args: { productId: string; market: string; items: readonly Planned[]; previous: ReadonlyMap<string, LogRow>; runId: string; dataDay: Date; now: Date }): Promise<StoreCounts> {
  const { productId, market, runId, dataDay, now } = args
  return inDatabaseTransaction(prisma, async () => {
    const create: Prisma.AdsBrainNegativeCreateManyInput[] = []
    const rewrite: Prisma.AdsBrainNegativeCreateManyInput[] = []
    const unchanged: string[] = []
    for (const i of args.items) {
      const was = args.previous.get(i.key)
      const { content, digest } = rowContent(i, was)
      const row = {
        productId, marketplace: market, key: i.key, ...content, evidence: json(content.evidence), actedAt: content.actedAt ? new Date(content.actedAt) : null,
        digest, runId, dataDay, checkedAt: now, changedAt: now,
      }
      if (!was) create.push({ ...row, firstSeenAt: now })
      else if (was.digest === digest) unchanged.push(was.id)
      else rewrite.push({ ...row, id: was.id, createdAt: was.createdAt, firstSeenAt: was.firstSeenAt })
    }
    for (let i = 0; i < rewrite.length; i += CHUNK) await prisma.adsBrainNegative.deleteMany({ where: { id: { in: rewrite.slice(i, i + CHUNK).map((r) => r.id!) } } })
    const all = [...create, ...rewrite]
    for (let i = 0; i < all.length; i += CHUNK) await prisma.adsBrainNegative.createMany({ data: all.slice(i, i + CHUNK) })
    for (let i = 0; i < unchanged.length; i += CHUNK) await prisma.adsBrainNegative.updateMany({ where: { id: { in: unchanged.slice(i, i + CHUNK) } }, data: { runId, dataDay, checkedAt: now } })
    return { created: create.length, changed: rewrite.length, unchanged: unchanged.length }
  }, { isolationLevel: 'ReadCommitted' })
}

/** What became of one acted item, onto its row (and its digest, so the next run sees it unchanged). */
async function recordOutcome(productId: string, market: string, i: Planned, previous: LogRow | undefined) {
  const { content, digest } = rowContent(i, previous)
  await prisma.adsBrainNegative.updateMany({
    where: { productId, marketplace: market, key: i.key },
    data: { status: content.status, approvalId: content.approvalId, adTargetId: content.adTargetId, outboundQueueId: content.outboundQueueId, result: content.result, actedAt: content.actedAt ? new Date(content.actedAt) : null, heldBy: content.heldBy, digest },
  })
}

// ── Act: AUTO through the write paths, PROPOSE as one change plan ────────────────────────────────────────────────

function writeEvidence(i: NegItem, market: string): AdWriteEvidence {
  return {
    metric: i.reasons[0] === 'ngram' ? 'searchTermWordClicks' : 'searchTermClicks',
    observed: i.evidence.clicks,
    threshold: i.evidence.clicksNeeded ?? null,
    windowDays: LEDGER_WINDOW_DAYS,
    sampleSize: i.evidence.clicks,
    sampleUnit: 'rows',
    note: `ads brain (${market}) ${i.action === 'ADD' ? 'adds' : 'retires'} ${i.match === 'PRODUCT' ? `negative product target ${i.text}` : `negative ${i.match.toLowerCase()} "${i.text}"`} — ${i.reasons.join(', ')}: ${i.why}`.slice(0, 1000),
  }
}

/** AUTO: one add through the one negative write service, as the brain. */
async function writeAdd(i: Planned, market: string): Promise<Partial<Planned>> {
  const { writeNegativeKeyword, writeNegativeProductTarget } = await import('../ads-negative-kw.service.js')
  const evidence = writeEvidence(i, market)
  const r = i.kind === 'PRODUCT'
    ? await writeNegativeProductTarget({ adGroupId: i.adGroupId!, asin: i.text, userId: BRAIN_NEGATIVES_ACTOR, evidence })
    : await writeNegativeKeyword({
      scope: i.level, ...(i.level === 'AD_GROUP' ? { adGroupId: i.adGroupId! } : { campaignId: i.campaignId }),
      keywordText: i.text, matchType: i.match === 'PHRASE' ? 'PHRASE' : 'EXACT', userId: BRAIN_NEGATIVES_ACTOR, evidence,
    })
  if (r.outcome === 'refused') return { status: 'REFUSED', result: `refused at ${r.refusal?.deniedAt}: ${r.refusal?.reason}`.slice(0, 2000) }
  if (r.outcome === 'failed') return { status: 'FAILED', result: (r.error ?? 'failed').slice(0, 2000) }
  return {
    status: 'WRITTEN', adTargetId: r.adTargetId,
    result: r.outcome === 'already_existed' ? 'already standing: nothing sent' : r.outcome === 'local' ? 'kept in Nexus: the place has no Amazon ids yet (the launch repair sends it)' : r.reachedAmazon ? `added at Amazon (${r.externalTargetId})` : `added (${r.mode})`,
  }
}

/** AUTO: one retire through the Negatives page's retire (the outbound queue, the gate at dispatch), as the brain. */
async function writeRetire(i: Planned, market: string): Promise<Partial<Planned>> {
  const { retireNegatives } = await import('../negatives-retire.service.js')
  const r = await retireNegatives({ adTargetIds: [i.negativeId!], actor: BRAIN_NEGATIVES_ACTOR, retireReason: `ads brain: ${i.reasons.join(', ')}`, evidence: writeEvidence(i, market) })
  const o = r.outcomes[0]
  if (!o) return { status: 'FAILED', result: 'the retire answered nothing' }
  if (o.kind === 'retired') return { status: 'QUEUED', outboundQueueId: o.outboundQueueId, result: o.reason }
  if (o.kind === 'removed_local' || o.kind === 'skipped') return { status: 'WRITTEN', result: o.reason ?? o.kind }
  return { status: o.kind === 'refused' ? 'REFUSED' : 'FAILED', result: (o.reason ?? o.kind).slice(0, 2000) }
}

/** The plan step one item is: an add-negative-targets step, or a retire-negatives step. */
export function stepOf(i: NegItem, productId: string): { tool: string; args: Record<string, unknown> } {
  const why = `Ads brain: ${i.why}`.slice(0, 300)
  if (i.action === 'RETIRE') return { tool: RETIRE_TOOL, args: { negativeIds: [i.negativeId], why } }
  const place = i.level === 'CAMPAIGN' ? { campaignId: i.campaignId } : { adGroupId: i.adGroupId }
  const negative = i.kind === 'PRODUCT' ? { ...place, asin: i.text.toUpperCase() } : { ...place, text: i.text, matchType: i.match === 'PHRASE' ? 'NEGATIVE_PHRASE' : 'NEGATIVE_EXACT' }
  return { tool: ADD_TOOL, args: { negatives: [negative], product: productId, why } }
}

/**
 * PROPOSE: the day's items as ONE change plan a person approves (the normal approval gate, the system principal). A step
 * a tool refuses is left out and named; the rest is asked once more. Returns each item's outcome by key.
 */
async function proposeDay(productId: string, market: string, label: string, items: Planned[], now: Date): Promise<Map<string, Partial<Planned>>> {
  const out = new Map<string, Partial<Planned>>()
  if (!items.length) return out
  const { queuePlan } = await import('../../agents/change-plan.service.js')
  const { systemPrincipal } = await import('../../agents/call-tool.js')
  let asking = items.slice(0, MAX_PLAN_STEPS)
  for (const i of items.slice(MAX_PLAN_STEPS)) out.set(i.key, { status: 'HELD', note: `past the ${MAX_PLAN_STEPS} steps one day's request holds: asked on a later day` })
  const run = await prisma.agentRun.create({ data: { agentKey: 'ads-brain-negatives', trigger: 'schedule', status: 'running', input: json({ productId, market, steps: asking.length }) } })
  let approvalId: string | null = null
  let error: string | null = null
  for (let attempt = 0; attempt < 2 && asking.length; attempt++) {
    const adds = asking.filter((i) => i.action === 'ADD').length
    const title = `Ads brain — negatives for ${label} in ${market}: ${adds} to add, ${asking.length - adds} to retire`
    const asked = await queuePlan({ title, steps: asking.map((i) => stepOf(i, productId)) }, systemPrincipal('Nexus ads brain'), run.id)
    if (asked.mode === 'queued' && asked.approvalId) { approvalId = asked.approvalId; break }
    const refusals = asked.refusals ?? []
    if (!refusals.length) { error = asked.error ?? 'the request was not queued'; break }
    const refused = new Set<number>()
    for (const r of refusals) {
      const item = asking[r.step - 1]
      if (!item) continue
      refused.add(r.step - 1)
      out.set(item.key, { status: 'REFUSED', actedAt: now, result: `${r.tool} refused it: ${r.error}`.slice(0, 2000) })
    }
    asking = asking.filter((_, index) => !refused.has(index))
  }
  await prisma.agentRun.update({
    where: { id: run.id },
    data: approvalId ? { status: 'done', ok: true, endedAt: new Date(), output: json({ mode: 'queued', approvalId }) } : { status: 'failed', ok: false, endedAt: new Date(), errorMessage: error ?? 'every step was refused' },
  })
  for (const i of asking) {
    out.set(i.key, approvalId
      ? { status: 'PROPOSED', approvalId, actedAt: now, result: `asked in change plan ${approvalId}: a person approves it in Nexus` }
      : { status: 'FAILED', actedAt: now, result: (error ?? 'not asked').slice(0, 2000) })
  }
  return out
}

// ── The run ──────────────────────────────────────────────────────────────────────────────────────────────────────

export interface NegativesRunSummary {
  ran: boolean
  why: string
  runId?: string
  products: number
  markets: string[]
  planned: number
  byStatus: Partial<Record<NegStatus, number>>
  stored: StoreCounts
  /** The change plans asked (approval ids). */
  proposed: string[]
  skipped: Array<{ productId: string; market: string; why: string }>
  pruned: number
}

const ZERO: StoreCounts = { created: 0, changed: 0, unchanged: 0 }

/** Delete log rows no run has checked for NEGATIVES_DAYS_KEPT days. */
export async function pruneNegatives(now: Date): Promise<number> {
  const before = new Date(now.getTime() - NEGATIVES_DAYS_KEPT * 86_400_000)
  return (await prisma.adsBrainNegative.deleteMany({ where: { checkedAt: { lt: before } } })).count
}

/** One product: decide, log, act at its levels, record each outcome. */
async function runProduct(m: MarketFacts, decided: MarketDecisions, due: DueProduct, runId: string, now: Date): Promise<{ items: Planned[]; stored: StoreCounts; approvalId: string | null } | null> {
  const facts = await loadNegativesFacts(m, decided, due, now)
  if (!facts) return null
  const plan = decideNegatives(facts.input)
  const items: Planned[] = reconciledPlan(plan, facts, now)
  const stored = await storeNegatives({ productId: due.productId, market: m.market, items, previous: facts.previous, runId, dataDay: m.dataDay, now })
  // AUTO, one at a time through the write paths (the day's cap keeps it small).
  for (const i of items.filter((x) => x.act === 'write')) {
    let outcome: Partial<Planned>
    try {
      outcome = i.action === 'ADD' ? await writeAdd(i, m.market) : await writeRetire(i, m.market)
    } catch (error) {
      outcome = { status: 'FAILED', result: (error instanceof Error ? error.message : String(error)).slice(0, 2000) }
    }
    Object.assign(i, outcome, { actedAt: now })
    await recordOutcome(due.productId, m.market, i, facts.previous.get(i.key))
  }
  // PROPOSE: the day's request.
  const asked = await proposeDay(due.productId, m.market, facts.productName ?? due.productId, items.filter((x) => x.act === 'propose'), now)
  let approvalId: string | null = null
  for (const i of items) {
    const o = asked.get(i.key)
    if (!o) continue
    Object.assign(i, o)
    approvalId ??= o.approvalId ?? null
    await recordOutcome(due.productId, m.market, i, facts.previous.get(i.key))
  }
  return { items, stored, approvalId }
}

/** One run in the business the caller is in. Nothing due: nothing read past the enrollments, nothing written but the prune. */
export async function runNegativesOnce(opts: { now?: Date; due?: NegativesDue; pinned?: ReadonlyMap<string, string> } = {}): Promise<NegativesRunSummary> {
  const now = opts.now ?? new Date()
  const due = opts.due ?? await negativesDue()
  if (!due.due) return { ran: false, why: due.why, products: 0, markets: [], planned: 0, byStatus: {}, stored: ZERO, proposed: [], skipped: [], pruned: await pruneNegatives(now) }
  const runId = randomUUID()
  const byMarket = new Map<string, DueProduct[]>()
  for (const d of due.products) byMarket.set(d.market, [...(byMarket.get(d.market) ?? []), d])
  let stored = ZERO
  let planned = 0
  const byStatus: Partial<Record<NegStatus, number>> = {}
  const proposed: string[] = []
  const skipped: NegativesRunSummary['skipped'] = []
  for (const [market, list] of [...byMarket].sort(([a], [b]) => a.localeCompare(b))) {
    const facts = await loadTermsMarket(market, list, now)
    const decided = decideMarket(facts, list, { pinned: opts.pinned })
    for (const d of list) {
      try {
        const done = await runProduct(facts, decided, d, runId, now)
        if (!done) { skipped.push({ productId: d.productId, market, why: 'no Sponsored Products campaign of its own in this market (a shared campaign is no product\'s, D2): no negative to decide' }); continue }
        stored = { created: stored.created + done.stored.created, changed: stored.changed + done.stored.changed, unchanged: stored.unchanged + done.stored.unchanged }
        planned += done.items.length
        for (const i of done.items) byStatus[i.status] = (byStatus[i.status] ?? 0) + 1
        if (done.approvalId) proposed.push(done.approvalId)
      } catch (error) {
        // One product's failure never stops the others; it is named.
        logger.error('[ads-brain-negatives] product run failed', { productId: d.productId, market, error: error instanceof Error ? error.message : String(error) })
        skipped.push({ productId: d.productId, market, why: `the run failed for it: ${error instanceof Error ? error.message : String(error)}` })
      }
    }
  }
  const pruned = await pruneNegatives(now)
  const summary: NegativesRunSummary = { ran: true, why: due.why, runId, products: due.products.length - skipped.length, markets: [...byMarket.keys()].sort(), planned, byStatus, stored, proposed, skipped, pruned }
  logger.info('[ads-brain-negatives] run', { runId, products: summary.products, markets: summary.markets, planned, byStatus, proposed: proposed.length, skipped: skipped.length, pruned })
  return summary
}

/** The run in one line (the cron's record). */
export function negativesSummaryLine(s: NegativesRunSummary): string {
  if (!s.ran) return `not run: ${s.why}`
  const statuses = Object.entries(s.byStatus).map(([k, n]) => `${k}=${n}`).join(' ')
  return `products=${s.products} markets=${s.markets.join(',') || '-'} planned=${s.planned} ${statuses} created=${s.stored.created} changed=${s.stored.changed} proposed=${s.proposed.length} skipped=${s.skipped.length} pruned=${s.pruned}`.replace(/\s+/g, ' ').trim()
}
