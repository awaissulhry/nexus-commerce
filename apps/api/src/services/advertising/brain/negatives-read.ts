/**
 * ONE BRAIN AB-10 — the `ads-brain` tool's view `negatives` (design 2026-10-08-ads-one-brain/DESIGN.md §2.7, §5; §10: the
 * Owner builds every screen, so this is the read API his page and Claude share). Read only: it changes nothing, in Nexus or
 * at Amazon, and stores nothing.
 *
 *   product × market  the day's negatives decided NOW (brain/negatives.ts over the term ledger, the same path the daily run
 *                     takes — a dry run, stored nowhere), each set against the log (what was asked, written, refused,
 *                     rejected): the adds (where, exact or phrase, why, at which level), the retirements of duplicates, the
 *                     revives; every campaign and ad group with its negatives against the limit (the warning, the maximum,
 *                     Amazon's 1,000); the campaigns the brain leaves and why; the shadow and the day's cap — beside the log
 *                     of the last 30 days (the newest run's rows and every one acted on). A product not enrolled is decided
 *                     as if enrolled at the default level (OBSERVE), so the Owner reads what it would do first.
 *   market            the products with a log there: counts by status and reason, the newest run, requests waiting.
 *
 * Money: every amount (spend, sales, the spend gate) sits under a `money` key, which the tool hides from a person without the
 * ad-spend permission (ads-brain.tools.ts restrictedFields); the visible words name no amount.
 */
import prisma from '../../../db.js'
import { strategyMarket } from '../ads-strategy/bids.js'
import { productFamily } from './ownership.js'
import { resolveBrainSettings, type OverrideRow } from './settings.js'
import { decideMarket, loadTermsMarket } from './terms-shadow.js'
import { AMAZON_ENTITY_LIMIT, decideNegatives, REVIVES_PER_DAY, type NegItem, type Reconciled } from './negatives.js'
import { loadNegativesFacts, NEGATIVES_DAYS_KEPT, reconciledPlan } from './negatives-run.js'

const PRODUCT_NOT_FOUND = 'Product not found'
export const DEFAULT_NEGATIVES_LIMIT = 100
export const MAX_NEGATIVES_LIMIT = 500
const OVERRIDE_SELECT = { id: true, productId: true, marketplace: true, scope: true, campaignId: true, kind: true, key: true, ref: true, value: true, by: true, reason: true, createdAt: true, endedAt: true } as const

/** One planned item as the view shows it (money under `money`). Pure. */
export function itemView(i: NegItem & Reconciled) {
  const { money, ...evidence } = i.evidence
  return {
    action: i.action, reasons: i.reasons, status: i.status, mode: i.mode, ...(i.askFirst ? { askFirst: true } : {}),
    negative: { kind: i.kind, match: i.match, text: i.text, level: i.level, campaignId: i.campaignId, adGroupId: i.adGroupId },
    ...(i.negativeId ? { negativeId: i.negativeId, origin: i.origin ?? null } : {}), ...(i.coverId ? { coverId: i.coverId } : {}),
    heldBy: i.heldBy, ...(i.note ? { note: i.note } : {}), ...(i.approvalId ? { approvalId: i.approvalId } : {}),
    why: i.why, evidence, money,
  }
}

type LogRow = {
  key: string; action: string; reason: string; reasons: string[]; kind: string; match: string; text: string; level: string; campaignId: string; adGroupId: string | null
  negativeId: string | null; origin: string | null; coverId: string | null; mode: string; status: string; askFirst: boolean; heldBy: string | null; why: string; evidence: unknown
  approvalId: string | null; adTargetId: string | null; outboundQueueId: string | null; result: string | null; runId: string; checkedAt: Date; firstSeenAt: Date; actedAt: Date | null
}

/** One stored log row as the view shows it (money under `money`). Pure. */
export function logView(r: LogRow) {
  const { money, ...evidence } = (r.evidence ?? {}) as Record<string, unknown> & { money?: unknown }
  return {
    action: r.action, reasons: r.reasons, status: r.status, mode: r.mode, ...(r.askFirst ? { askFirst: true } : {}),
    negative: { kind: r.kind, match: r.match, text: r.text, level: r.level, campaignId: r.campaignId, adGroupId: r.adGroupId },
    ...(r.negativeId ? { negativeId: r.negativeId, origin: r.origin } : {}), ...(r.coverId ? { coverId: r.coverId } : {}),
    heldBy: r.heldBy, approvalId: r.approvalId, adTargetId: r.adTargetId, outboundQueueId: r.outboundQueueId, result: r.result,
    firstSeenAt: r.firstSeenAt.toISOString(), checkedAt: r.checkedAt.toISOString(), actedAt: r.actedAt?.toISOString() ?? null,
    why: r.why, evidence, money: money ?? {},
  }
}

/** View negatives. With productId and market: the product's day decided now, beside its log. With market alone: the market's logs. */
export async function brainNegatives(args: { productId?: string; market?: string; limit?: number; now?: Date }): Promise<{ data: unknown } | { error: string }> {
  const market = args.market ? strategyMarket(args.market) : null
  if (args.market && !market) return { error: `${args.market} is not a market code` }
  if (!market) return { error: 'name the market (market), and optionally a productId: view negatives reads one market' }
  const limit = Math.max(1, Math.min(MAX_NEGATIVES_LIMIT, Math.round(args.limit ?? DEFAULT_NEGATIVES_LIMIT)))
  const now = args.now ?? new Date()
  const note = 'OBSERVE logs only; PROPOSE asks a person once a day (one change plan); AUTO writes as the brain through the one negative write service and the retire queue — after the shadow days and only under the live server switch'
  if (!args.productId) {
    const [counts, latest, waiting] = await Promise.all([
      prisma.adsBrainNegative.groupBy({ by: ['productId', 'status', 'reason'], where: { marketplace: market }, _count: { _all: true } }),
      prisma.adsBrainNegative.groupBy({ by: ['productId'], where: { marketplace: market }, _max: { checkedAt: true, actedAt: true } }),
      prisma.adsBrainNegative.findMany({ where: { marketplace: market, status: 'PROPOSED', approvalId: { not: null } }, select: { productId: true, approvalId: true }, distinct: ['approvalId'] }),
    ])
    const ids = [...new Set(latest.map((c) => c.productId))]
    const names = new Map((ids.length ? await prisma.product.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, sku: true, deletedAt: true } }) : []).map((p) => [p.id, p]))
    const sum = (productId: string, key: 'status' | 'reason') => {
      const out: Record<string, number> = {}
      for (const c of counts.filter((x) => x.productId === productId)) out[c[key]] = (out[c[key]] ?? 0) + c._count._all
      return out
    }
    return {
      data: {
        view: 'negatives', scope: { market }, note,
        products: latest.filter((c) => !names.get(c.productId)?.deletedAt).map((c) => ({
          productId: c.productId, name: names.get(c.productId)?.name ?? null, sku: names.get(c.productId)?.sku ?? null,
          checkedAt: c._max.checkedAt?.toISOString() ?? null, lastActedAt: c._max.actedAt?.toISOString() ?? null,
          byStatus: sum(c.productId, 'status'), byReason: sum(c.productId, 'reason'),
          waitingRequests: waiting.filter((w) => w.productId === c.productId).map((w) => w.approvalId),
        })).sort((a, b) => a.productId.localeCompare(b.productId)),
        next: 'Read one product with productId and market: its day decided now (adds, retirements, revives), every campaign and ad group against the negatives limit, and its log.',
      },
    }
  }

  if (!(await prisma.product.count({ where: { id: args.productId, deletedAt: null } }))) return { error: PRODUCT_NOT_FOUND }
  const family = await productFamily(args.productId)
  if (!family) return { error: `product ${args.productId} has no single family (a parentless product whose ASIN variations of several families carry): fix its family first` }
  const root = family.root
  const [enrollment, overrides] = await Promise.all([
    prisma.adsBrainEnrollment.findFirst({ where: { productId: root, marketplace: market }, select: { id: true } }),
    prisma.adsBrainOverride.findMany({ where: { endedAt: null, scope: 'PRODUCT', productId: root, marketplace: market }, select: OVERRIDE_SELECT }) as Promise<OverrideRow[]>,
  ])
  const enrolled = !!enrollment
  // Not enrolled: decided as if enrolled at the brain's defaults (OBSERVE) — what it would do, before the Owner enrolls it.
  const settings = resolveBrainSettings({ productId: root, market, campaignId: null, enrolled: true, overrides })
  const due = { productId: root, market, settings }
  const facts = await loadTermsMarket(market, [due], now)
  const decided = decideMarket(facts, [due])
  const loaded = await loadNegativesFacts(facts, decided, due, now, { asIfEnrolled: !enrolled })
  const lever = enrolled ? { effective: settings.levers.negatives.effective, why: settings.levers.negatives.why } : { effective: 'NOT_ENROLLED', why: 'the product is not enrolled in the brain: decided here as if enrolled at the default level (OBSERVE)' }
  const product = { productId: root, market, enrolled, lever }
  if (!loaded) {
    return { data: { view: 'negatives', scope: { productId: root, market }, note, product, source: { kind: 'dryRun', decidedAt: now.toISOString() }, why: 'no Sponsored Products campaign of its own in this market (a shared campaign is no product\'s, D2): no negative to decide' } }
  }
  const plan = decideNegatives(loaded.input)
  const items = reconciledPlan(plan, loaded, now)
  const adds = items.filter((i) => i.action === 'ADD')
  const retires = items.filter((i) => i.action === 'RETIRE' && i.reasons[0] === 'duplicate')
  const revives = items.filter((i) => i.action === 'RETIRE' && i.reasons[0] !== 'duplicate')
  const shown = (list: typeof items) => list.slice(0, limit).map(itemView)

  // The log: the newest run's rows and every row acted on in the kept window.
  const latestRun = await prisma.adsBrainNegative.findFirst({ where: { productId: root, marketplace: market }, orderBy: { checkedAt: 'desc' }, select: { runId: true, checkedAt: true } })
  const logRows = await prisma.adsBrainNegative.findMany({
    where: { productId: root, marketplace: market, OR: [...(latestRun ? [{ runId: latestRun.runId }] : []), { actedAt: { not: null } }] },
    orderBy: [{ actedAt: { sort: 'desc', nulls: 'last' } }, { checkedAt: 'desc' }], take: limit,
  }) as unknown as LogRow[]
  const byStatus: Record<string, number> = {}
  for (const r of logRows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1

  return {
    data: {
      view: 'negatives', scope: { productId: root, market }, note, product,
      shadow: plan.shadow,
      caps: { negativesPerDay: loaded.input.caps.perDay, usedToday: loaded.input.caps.usedToday, revivesPerDay: REVIVES_PER_DAY, revivedToday: loaded.input.caps.revivedToday },
      source: { kind: 'dryRun', decidedAt: now.toISOString(), dataDay: facts.dataDay.toISOString().slice(0, 10), windowDays: facts.windowDays, note: 'decided now from what Nexus holds — stored nowhere; the daily run decides the same way, logs it and acts at each campaign\'s level' },
      counts: plan.counts,
      adds: shown(adds), retirements: shown(retires), revives: shown(revives),
      ...(adds.length > limit || retires.length > limit || revives.length > limit ? { more: `at most ${limit} of each are listed: ask with a higher limit (at most ${MAX_NEGATIVES_LIMIT})` } : {}),
      entities: plan.entities.map((e) => ({ ...e, amazonLimit: AMAZON_ENTITY_LIMIT })),
      skippedCampaigns: plan.skipped,
      log: {
        keptDays: NEGATIVES_DAYS_KEPT,
        lastRun: latestRun ? { runId: latestRun.runId, checkedAt: latestRun.checkedAt.toISOString() } : null,
        byStatus,
        rows: logRows.map(logView),
      },
    },
  }
}
