/**
 * Reviews Insights › Alerts — the ReviewSpike rows the hourly spike check opens (spike-detector.service.ts), read and
 * decided here (routes/reviews.routes.ts):
 *
 *   GET   /api/reviews/spikes?status&channel&market&productId&theme&limit
 *         → { items, count, counts {open, acknowledged, resolved}, timeToResolve, check }
 *   PATCH /api/reviews/spikes/:id               { status: ACKNOWLEDGED | RESOLVED | REOPEN } — actor = the signed-in person
 *   POST  /api/reviews/spikes/bulk              { ids ≤ 200, action: acknowledge | resolve | suggest } → { changed, held }
 *
 * Acknowledge = someone is on it (who and when); Resolve closes it (who and when); Reopen puts it back to Open and
 * forgets both. A bulk action changes only the ticked alerts it applies to and names why it skipped each other one
 * (ruling 7); "suggest" asks the AI for fixes, at most 5 alerts at a time. A spike has a market, not a channel: its
 * channels are read from the negative reviews of its 7 days.
 */
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { marketWords, themeWords } from './overviewMath.js'
import { visibleReviewWhere } from './review-visibility.js'
import { median, parseBulk, parseInsightScope, pct, SUGGEST_MAX, whereWords, InsightsInputError } from './review-insights-math.js'
import { nextCronRun, pipelineJobDefs } from './review-settings-health.js'

const DAY = 86_400_000
const RESOLVED_DAYS = 30
export const ALERT_STATUSES = ['OPEN', 'ACKNOWLEDGED', 'RESOLVED'] as const
export type AlertStatus = (typeof ALERT_STATUSES)[number]

export class AlertNotFoundError extends Error {
  readonly statusCode = 404
}

/** Names of the people behind actor ids (UserProfile ids; an older 'user:…' label is shown as it is). */
export async function peopleNames(ids: ReadonlyArray<string | null | undefined>): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => !!id))]
  const out = new Map<string, string>()
  if (wanted.length === 0) return out
  const rows = await prisma.userProfile.findMany({ where: { id: { in: wanted } }, select: { id: true, displayName: true, email: true } }).catch(() => [])
  for (const row of rows) out.set(row.id, row.displayName?.trim() || row.email?.split('@')[0] || 'someone')
  for (const id of wanted) if (!out.has(id)) out.set(id, id.startsWith('user:') ? id.slice(5) || 'someone' : 'someone')
  return out
}

export interface AlertItem {
  id: string
  status: AlertStatus
  theme: { key: string; label: string }
  product: { id: string; sku: string; name: string } | null
  market: string
  /** The channels the 7 days' negative reviews came from ('AMAZON', 'EBAY' …). */
  channels: string[]
  /** "Amazon Germany" when one channel, else the market ("Germany"). */
  where: string
  /** Share of reviews with the complaint: over 28 days (from) and the last 7 days (to), percent. */
  from: number | null
  to: number | null
  multiplier: number | null
  /** "9 of 50 reviews in 7 days". */
  basis: string
  count: number
  phrases: string[]
  detectedAt: string
  newToday: boolean
  acknowledged: { by: string; at: string | null } | null
  resolved: { by: string | null; at: string } | null
  fixes: { open: number; sent: number; applied: number; dismissed: number }
}

export interface AlertsAnswer {
  items: AlertItem[]
  count: number
  counts: { open: number; acknowledged: number; resolved: number }
  /** Middle number of days from opening to resolving, last 30 days, and the change against the 30 days before. */
  timeToResolve: { days: number | null; change: number | null }
  check: { lastRunAt: string | null; lastStatus: string | null; nextRunAt: string | null; schedule: string }
}

export async function listAlerts(input: { status?: unknown; channel?: unknown; market?: unknown; marketplace?: unknown; productId?: unknown; theme?: unknown; limit?: unknown; now?: Date } = {}): Promise<AlertsAnswer> {
  const now = input.now ?? new Date()
  const scope = parseInsightScope(input)
  const statusText = typeof input.status === 'string' ? input.status.trim().toUpperCase() : ''
  const status = (ALERT_STATUSES as readonly string[]).includes(statusText) ? (statusText as AlertStatus) : null
  const productId = typeof input.productId === 'string' && input.productId.trim() ? input.productId.trim() : null
  const theme = typeof input.theme === 'string' && input.theme.trim() ? input.theme.trim().toUpperCase() : null
  const limit = Math.min(Math.max(Number(input.limit) || 100, 1), 200)
  const resolvedSince = new Date(now.getTime() - RESOLVED_DAYS * DAY)

  const base = {
    ...(scope.market ? { marketplace: scope.market } : {}),
    ...(productId ? { productId } : {}),
    ...(theme ? { category: theme } : {}),
  }
  // Every alert of the scope that is open, acknowledged, or resolved in the last 30 days (the tiles count them all).
  const rows = await prisma.reviewSpike.findMany({
    where: { ...base, OR: [{ status: { in: ['OPEN', 'ACKNOWLEDGED'] } }, { status: 'RESOLVED', OR: [{ resolvedAt: { gte: resolvedSince } }, { resolvedAt: null, detectedAt: { gte: resolvedSince } }] }] },
    orderBy: { detectedAt: 'desc' },
    take: 1000,
    include: { product: { select: { id: true, sku: true, name: true } } },
  })

  // Channels of each alert: the negative reviews of its 7 days, for its product, market and theme.
  const channelsOf = new Map<string, string[]>()
  if (rows.length) {
    const oldest = rows.reduce((d, r) => (r.detectedAt < d ? r.detectedAt : d), now)
    const reviews = await prisma.review.findMany({
      where: visibleReviewWhere({
        productId: { in: [...new Set(rows.map((r) => r.productId).filter((id): id is string => !!id))] },
        postedAt: { gte: new Date(oldest.getTime() - 7 * DAY) },
        sentiment: { is: { label: 'NEGATIVE' } },
      }),
      select: { productId: true, marketplace: true, channel: true, postedAt: true, sentiment: { select: { categories: true } } },
    })
    for (const r of rows) {
      const from = r.detectedAt.getTime() - 7 * DAY
      const set = new Set(
        reviews
          .filter((v) => v.productId === r.productId && (v.marketplace ?? '') === r.marketplace && v.sentiment?.categories.includes(r.category) && v.postedAt.getTime() >= from && v.postedAt.getTime() <= r.detectedAt.getTime() + DAY)
          .map((v) => v.channel.toUpperCase()),
      )
      channelsOf.set(r.id, [...set].sort())
    }
  }
  const inScope = scope.channel ? rows.filter((r) => (channelsOf.get(r.id) ?? []).includes(scope.channel!)) : rows

  const counts = {
    open: inScope.filter((r) => r.status === 'OPEN').length,
    acknowledged: inScope.filter((r) => r.status === 'ACKNOWLEDGED').length,
    resolved: inScope.filter((r) => r.status === 'RESOLVED').length,
  }
  const shown = (status ? inScope.filter((r) => r.status === status) : inScope).slice(0, limit)

  const [fixRows, names, ttr, lastRun] = await Promise.all([
    shown.length
      ? prisma.reviewActionItem.groupBy({ by: ['spikeId', 'status'], where: { spikeId: { in: shown.map((r) => r.id) } }, _count: { _all: true } })
      : Promise.resolve([]),
    peopleNames(shown.flatMap((r) => [r.acknowledgedBy, r.resolvedBy])),
    prisma.reviewSpike.findMany({
      where: { ...base, status: 'RESOLVED', resolvedAt: { gte: new Date(now.getTime() - 2 * RESOLVED_DAYS * DAY) } },
      select: { detectedAt: true, resolvedAt: true },
    }),
    prisma.cronRun.findFirst({ where: { jobName: 'review-spike-detector' }, orderBy: { startedAt: 'desc' }, select: { startedAt: true, status: true } }).catch(() => null),
  ])
  const fixes = new Map<string, AlertItem['fixes']>()
  for (const g of fixRows) {
    if (!g.spikeId) continue
    const slot = fixes.get(g.spikeId) ?? { open: 0, sent: 0, applied: 0, dismissed: 0 }
    const n = g._count._all
    if (g.status === 'OPEN') slot.open += n
    else if (g.status === 'SENT') slot.sent += n
    else if (g.status === 'APPLIED') slot.applied += n
    else if (g.status === 'DISMISSED') slot.dismissed += n
    fixes.set(g.spikeId, slot)
  }
  const days = (rs: typeof ttr) => median(rs.filter((r) => r.resolvedAt).map((r) => (r.resolvedAt!.getTime() - r.detectedAt.getTime()) / DAY))
  const recent = days(ttr.filter((r) => r.resolvedAt! >= resolvedSince))
  const earlier = days(ttr.filter((r) => r.resolvedAt! < resolvedSince))
  const startOfDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const schedule = pipelineJobDefs().find((d) => d.key === 'review-spike-detector')?.schedule ?? '17 * * * *'

  const items: AlertItem[] = shown.map((r) => {
    const channels = channelsOf.get(r.id) ?? []
    return {
      id: r.id,
      status: r.status as AlertStatus,
      theme: { key: r.category, label: themeWords(r.category) },
      product: r.product,
      market: r.marketplace,
      channels,
      where: channels.length === 1 ? whereWords(channels[0], r.marketplace) : marketWords(r.marketplace) ?? r.marketplace,
      from: pct(r.rate28dNumerator, r.rate28dDenominator, 0),
      to: pct(r.rate7dNumerator, r.rate7dDenominator, 0),
      multiplier: r.spikeMultiplier == null ? null : Number(r.spikeMultiplier),
      basis: `${r.rate7dNumerator} of ${r.rate7dDenominator} reviews in 7 days`,
      count: r.rate7dNumerator,
      phrases: r.sampleTopPhrases,
      detectedAt: r.detectedAt.toISOString(),
      newToday: r.detectedAt.getTime() >= startOfDay,
      acknowledged: r.acknowledgedBy || r.acknowledgedAt ? { by: names.get(r.acknowledgedBy ?? '') ?? 'someone', at: r.acknowledgedAt?.toISOString() ?? null } : null,
      resolved: r.status === 'RESOLVED' && r.resolvedAt ? { by: r.resolvedBy ? names.get(r.resolvedBy) ?? 'someone' : null, at: r.resolvedAt.toISOString() } : null,
      fixes: fixes.get(r.id) ?? { open: 0, sent: 0, applied: 0, dismissed: 0 },
    }
  })
  return {
    items,
    count: items.length,
    counts,
    timeToResolve: { days: recent == null ? null : Math.round(recent * 10) / 10, change: recent != null && earlier != null ? Math.round((recent - earlier) * 10) / 10 : null },
    check: {
      lastRunAt: lastRun?.startedAt.toISOString() ?? null,
      lastStatus: lastRun?.status ?? null,
      nextRunAt: nextCronRun(schedule, now)?.toISOString() ?? null,
      schedule,
    },
  }
}

// ── Decisions ────────────────────────────────────────────────────────

export type AlertDecision = 'ACKNOWLEDGED' | 'RESOLVED' | 'REOPEN'

/** Why an alert in `status` cannot take `decision` (null = it can). */
export function decisionHeld(status: string, decision: AlertDecision): string | null {
  if (decision === 'ACKNOWLEDGED') {
    if (status === 'ACKNOWLEDGED') return 'Already acknowledged.'
    if (status === 'RESOLVED') return 'Already resolved: reopen it first.'
    return null
  }
  if (decision === 'RESOLVED') return status === 'RESOLVED' ? 'Already resolved.' : null
  return status === 'OPEN' ? 'Already open.' : null
}

function decisionData(decision: AlertDecision, actor: string, at: Date) {
  if (decision === 'ACKNOWLEDGED') return { status: 'ACKNOWLEDGED', acknowledgedAt: at, acknowledgedBy: actor }
  if (decision === 'RESOLVED') return { status: 'RESOLVED', resolvedAt: at, resolvedBy: actor }
  return { status: 'OPEN', acknowledgedAt: null, acknowledgedBy: null, resolvedAt: null, resolvedBy: null }
}

export function parseDecision(raw: unknown): AlertDecision {
  const value = typeof raw === 'string' ? raw.trim().toUpperCase() : ''
  if (value === 'ACKNOWLEDGED' || value === 'ACKNOWLEDGE') return 'ACKNOWLEDGED'
  if (value === 'RESOLVED' || value === 'RESOLVE') return 'RESOLVED'
  if (value === 'REOPEN' || value === 'OPEN') return 'REOPEN'
  throw new InsightsInputError('status: one of ACKNOWLEDGED, RESOLVED or REOPEN.')
}

/** One alert's decision. An alert already in that state is a 409 with the reason, never a silent no-op. */
export async function decideAlert(id: string, decision: AlertDecision, actor: string, now = new Date()) {
  const existing = await prisma.reviewSpike.findUnique({ where: { id }, select: { id: true, status: true } })
  if (!existing) throw new AlertNotFoundError('No alert with this id in this business.')
  const held = decisionHeld(existing.status, decision)
  if (held) throw Object.assign(new Error(held), { statusCode: 409 })
  // Guarded by the status read: a second press (or another person) in between changes nothing.
  const changed = await prisma.reviewSpike.updateMany({ where: { id, status: existing.status }, data: decisionData(decision, actor, now) })
  if (changed.count === 0) throw Object.assign(new Error('Someone changed this alert a moment ago: reload it.'), { statusCode: 409 })
  return { spike: await prisma.reviewSpike.findUnique({ where: { id } }) }
}

export type AlertBulkAction = 'acknowledge' | 'resolve' | 'suggest'

export interface BulkHeld {
  id: string
  words: string
}

/**
 * The Alerts bulk bar: acknowledge / resolve the ticked alerts that can take it, or ask the AI for fixes for up to 5
 * of them. `suggest` runs `generate` per alert (review-actions.service.ts generateActionItemsForSpike).
 */
export async function bulkAlerts(
  body: unknown,
  actor: string,
  generate: (spikeId: string, actor: string) => Promise<{ created: unknown[] }>,
  now = new Date(),
): Promise<{ changed: number; held: BulkHeld[]; fixes?: number }> {
  const { ids, action } = parseBulk(body, ['acknowledge', 'resolve', 'suggest'] as const)
  if (action === 'suggest' && ids.length > SUGGEST_MAX) {
    return { changed: 0, held: ids.map((id) => ({ id, words: `Suggest fixes works on up to ${SUGGEST_MAX} alerts at a time: untick ${ids.length - SUGGEST_MAX}.` })) }
  }
  const rows = await prisma.reviewSpike.findMany({ where: { id: { in: ids } }, select: { id: true, status: true } })
  const byId = new Map(rows.map((r) => [r.id, r]))
  const held: BulkHeld[] = []
  const apply: string[] = []
  const decision: AlertDecision | null = action === 'acknowledge' ? 'ACKNOWLEDGED' : action === 'resolve' ? 'RESOLVED' : null
  let withFixes = new Set<string>()
  if (action === 'suggest') {
    const existing = await prisma.reviewActionItem.groupBy({ by: ['spikeId'], where: { spikeId: { in: ids }, status: { in: ['OPEN', 'SENT', 'APPLIED'] } }, _count: { _all: true } })
    withFixes = new Set(existing.map((g) => g.spikeId).filter((id): id is string => !!id))
  }
  for (const id of ids) {
    const row = byId.get(id)
    if (!row) {
      held.push({ id, words: 'Not found in this business’s alerts.' })
      continue
    }
    if (decision) {
      const why = decisionHeld(row.status, decision)
      if (why) held.push({ id, words: why })
      else apply.push(id)
      continue
    }
    if (row.status === 'RESOLVED') held.push({ id, words: 'Resolved: reopen it to ask for fixes.' })
    else if (withFixes.has(id)) held.push({ id, words: 'It has fixes already: they are on the Fixes page.' })
    else apply.push(id)
  }
  if (apply.length === 0) return { changed: 0, held }
  if (decision) {
    let changed = 0
    for (const status of ['OPEN', 'ACKNOWLEDGED'] as const) {
      const ids = apply.filter((id) => byId.get(id)!.status === status)
      if (!ids.length) continue
      const done = await prisma.reviewSpike.updateMany({ where: { id: { in: ids }, status }, data: decisionData(decision, actor, now) })
      changed += done.count
    }
    return { changed, held }
  }
  let made = 0
  let changed = 0
  for (const id of apply) {
    try {
      const out = await generate(id, actor)
      made += out.created.length
      if (out.created.length > 0) changed += 1
      else held.push({ id, words: 'The AI suggested nothing for this alert.' })
    } catch (error) {
      logger.warn('[review-alerts] suggest failed', { spikeId: id, error: error instanceof Error ? error.message : String(error) })
      held.push({ id, words: `No fixes: ${error instanceof Error ? error.message : String(error)}` })
    }
  }
  return { changed, held, fixes: made }
}
