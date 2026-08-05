/**
 * ACR.3 (Stage 3) — the coverage engine: hold each term of an enabled coverage set at its
 * target share, inside its caps, without operator attention.
 *
 * This is the pilot the whole engagement was opened for: "several products, same keywords —
 * make them appear on the same page… automate it all so it doesn't require my attention."
 * Presence was measured to be the status quo (10 GALE ASINs already share one SERP); SHARE is
 * the gap, and share is a bid problem. So the engine is a bid ladder, not a structure builder:
 *
 *   share below target  → step the family's championed keyword bid UP (within every cap)
 *   share at/above target → DECAY the bid gently to find the cheapest bid that still holds
 *   ACOS breach          → step DOWN regardless of share — the family's cap outranks coverage
 *   family daily cap hit → no ups today, decays still allowed
 *
 * ── What it reads, and why ──────────────────────────────────────────────────────────────────
 * ENABLED KeywordCoverageSets only — intent, never raw SQP. Share ground truth is weekly SQP
 * (the only page-one measurement that exists); spend/ACOS feedback is daily AD_TARGET grain.
 * The cadence asymmetry is embraced rather than hidden: steps are small and daily, verdicts
 * weekly, which is exactly how a slow-feedback controller should behave.
 *
 * ── What it will not do ─────────────────────────────────────────────────────────────────────
 *   · Write in OBSERVE mode. Every decision is logged as would-do to AdvertisingActionLog;
 *     mode comes from NEXUS_COVERAGE_ENGINE_MODE (off | observe | auto), default observe.
 *   · Touch a term without a championed target. Structural creation (lead-ASIN isolation,
 *     new keywords) stays operator-gated; the engine moves bids that exist.
 *   · Bypass anything. Writes go through updateAdTargetWithSync — the write gate, the halt,
 *     bounds, audit, queue — tagged with one change-set per day for whole-day revert.
 */
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'

export type CoverageEngineMode = 'off' | 'observe' | 'auto'

export function engineMode(): CoverageEngineMode {
  const raw = (process.env.NEXUS_COVERAGE_ENGINE_MODE ?? 'observe').toLowerCase()
  return raw === 'auto' ? 'auto' : raw === 'off' ? 'off' : 'observe'
}

/** Ladder tuning — env-tunable, conservative by default. */
const STEP_UP_PCT = Number(process.env.NEXUS_COVERAGE_STEP_UP_PCT ?? 12)
const DECAY_PCT = Number(process.env.NEXUS_COVERAGE_DECAY_PCT ?? 6)
const MIN_BID_CENTS = 5
/** Hard ceiling when neither the term nor the account provides one — never unbounded (ACR.1.4). */
const DEFAULT_MAX_CPC_CENTS = Number(process.env.NEXUS_COVERAGE_DEFAULT_MAX_CPC_CENTS ?? 120)

export interface LadderInput {
  currentBidCents: number
  /** Weekly SQP share, 0..1, null when the term is unmeasured this week. */
  share: number | null
  /** Operator target, 0..100 (percent), null = "hold presence cheaply" (decay-only). */
  targetSharePct: number | null
  /** 30d term-level ACOS for the family's targets on this term; null = no sales yet. */
  acos30d: number | null
  /** Family ACOS cap, percent, null = none. */
  familyAcosCapPct: number | null
  /** Per-term ceiling, falling back to the default — never null in effect. */
  maxCpcCents: number | null
  /** Has the family spent past its daily cap already today? */
  familyDailyCapBreached: boolean
  /** 30d spend with zero sales on this term — waste guard. */
  spend30dCents: number
  sales30dCents: number
}

export interface LadderDecision {
  action: 'up' | 'down' | 'hold'
  nextBidCents: number
  reason: string
}

/**
 * The whole decision, pure. Order of the guards IS the policy:
 * caps first (they outrank coverage), then waste, then the share ladder.
 */
export function decideBidStep(i: LadderInput): LadderDecision {
  const ceiling = Math.max(MIN_BID_CENTS, i.maxCpcCents ?? DEFAULT_MAX_CPC_CENTS)
  const clamp = (c: number) => Math.max(MIN_BID_CENTS, Math.min(ceiling, Math.round(c)))
  const down = clamp(i.currentBidCents * (1 - DECAY_PCT / 100))
  const up = clamp(i.currentBidCents * (1 + STEP_UP_PCT / 100))

  // 1. ACOS cap outranks everything: a family that set a cap meant it.
  if (i.familyAcosCapPct != null && i.acos30d != null && i.acos30d * 100 > i.familyAcosCapPct) {
    if (down < i.currentBidCents) {
      return { action: 'down', nextBidCents: down, reason: `ACOS ${(i.acos30d * 100).toFixed(0)}% over the family cap ${i.familyAcosCapPct}%` }
    }
    return { action: 'hold', nextBidCents: i.currentBidCents, reason: 'ACOS over cap but bid already at the floor' }
  }

  // 2. Waste guard: real spend, zero sales → step down even if share is short. Coverage that
  //    never converts is the failure mode the wasted-spend board prices every day.
  if (i.sales30dCents === 0 && i.spend30dCents >= 2_000) {
    if (down < i.currentBidCents) {
      return { action: 'down', nextBidCents: down, reason: `€${(i.spend30dCents / 100).toFixed(0)} in 30d with no sales` }
    }
    return { action: 'hold', nextBidCents: i.currentBidCents, reason: 'wasteful but already at the floor' }
  }

  // 3. Share ladder — only when the operator set a target and the week is measured.
  if (i.targetSharePct != null && i.share != null) {
    const sharePct = i.share * 100
    if (sharePct < i.targetSharePct) {
      if (i.familyDailyCapBreached) {
        return { action: 'hold', nextBidCents: i.currentBidCents, reason: `share ${sharePct.toFixed(2)}% below target ${i.targetSharePct}% but the family daily cap is spent` }
      }
      if (up > i.currentBidCents) {
        return { action: 'up', nextBidCents: up, reason: `share ${sharePct.toFixed(2)}% below target ${i.targetSharePct}%` }
      }
      return { action: 'hold', nextBidCents: i.currentBidCents, reason: `below target but at the ${ceiling}¢ ceiling` }
    }
    // At/above target: decay to find the cheapest holding bid.
    if (down < i.currentBidCents) {
      return { action: 'down', nextBidCents: down, reason: `share ${sharePct.toFixed(2)}% holds target ${i.targetSharePct}% — decaying to find the floor` }
    }
    return { action: 'hold', nextBidCents: i.currentBidCents, reason: 'holding target at the floor bid' }
  }

  // 4. No target set (or unmeasured week): do nothing loud. A controller with no setpoint
  //    or no measurement has no business moving money.
  return {
    action: 'hold',
    nextBidCents: i.currentBidCents,
    reason: i.targetSharePct == null ? 'no target share set for this term' : 'week unmeasured — no share ground truth',
  }
}

/* ────────────────────────────────────────────────────────────────────────────────────────── */

export interface EngineTermDecision {
  setId: string
  setName: string
  term: string
  campaignName: string
  adTargetId: string
  decision: LadderDecision
  currentBidCents: number
  share: number | null
  applied: boolean
  applyError: string | null
}

export interface EngineRunSummary {
  mode: CoverageEngineMode
  setsConsidered: number
  setsEnabled: number
  termsEvaluated: number
  /** Held-out control terms the engine deliberately did not evaluate. */
  controlsSkipped: number
  decisions: EngineTermDecision[]
  ups: number
  downs: number
  holds: number
  applied: number
  blocked: number
}

/**
 * One engine tick. `previewSetId` evaluates ONE set even if disabled — the cockpit's
 * "what would the engine do" preview — and never applies, regardless of mode.
 */
export async function runCoverageEngineOnce(opts: { previewSetId?: string } = {}): Promise<EngineRunSummary> {
  const mode = engineMode()
  const summary: EngineRunSummary = {
    mode, setsConsidered: 0, setsEnabled: 0, termsEvaluated: 0, controlsSkipped: 0,
    decisions: [], ups: 0, downs: 0, holds: 0, applied: 0, blocked: 0,
  }
  if (mode === 'off' && !opts.previewSetId) return summary

  const sets = await prisma.keywordCoverageSet.findMany({
    where: opts.previewSetId ? { id: opts.previewSetId } : { enabled: true },
    include: { terms: { where: { status: 'ACTIVE' } } },
  })
  let controlsSkipped = 0
  summary.setsConsidered = sets.length
  summary.setsEnabled = sets.filter((s) => s.enabled).length
  if (sets.length === 0) return summary

  const applyMode = mode === 'auto' && !opts.previewSetId
  const changeSet = `coverage-engine-${new Date().toISOString().slice(0, 10)}`

  for (const set of sets) {
    // Family membership + campaigns, by the same rule the cockpit uses.
    const campaigns = await prisma.campaign.findMany({
      where: { portfolioId: set.portfolioId, status: 'ENABLED' },
      select: { id: true, name: true, externalCampaignId: true },
    })
    if (campaigns.length === 0) continue
    const campaignIds = campaigns.map((c) => c.id)
    const nameByCampaign = new Map(campaigns.map((c) => [c.id, c.name]))

    // Family daily cap: spend today across member campaigns (campaign grain, today's row).
    let familyDailyCapBreached = false
    if (set.dailySpendCapCents != null) {
      const extIds = campaigns.map((c) => c.externalCampaignId).filter((x): x is string => !!x)
      const today = extIds.length ? await prisma.$queryRawUnsafe<{ c: bigint }[]>(`
        SELECT COALESCE(SUM("costMicros")/10000, 0) AS c FROM "AmazonAdsDailyPerformance"
        WHERE "entityType"='CAMPAIGN' AND date = CURRENT_DATE
          AND "entityId" IN (${extIds.map((x) => `'${x.replace(/'/g, "''")}'`).join(',')})
      `) : [{ c: 0n }]
      familyDailyCapBreached = Number(today[0]?.c ?? 0) >= set.dailySpendCapCents
    }

    // Newest measured SQP week for this marketplace — share ground truth.
    const week = await prisma.$queryRawUnsafe<{ w: Date }[]>(`
      SELECT MAX("startDate") AS w FROM "SearchQueryPerformance"
      WHERE marketplace = $1 AND "impressionsBrand" > 0
    `, set.marketplace)
    const weekDate = week[0]?.w ?? null

    for (const term of set.terms) {
      /**
       * Control group — the engine NEVER touches a control term, in any mode, preview
       * included. Without held-out terms a week of share movement proves nothing: the market
       * moves too. The skip is counted, not silent, so the summary always shows the split.
       */
      if (term.isControl) { controlsSkipped += 1; continue }

      // The championed target: the family's best ENABLED positive keyword on this exact term,
      // by the engine ordering (ACOS → spend → impressions). The engine moves ONE bid per
      // term — the champion's — because consolidation already floored the rest.
      const targets = await prisma.$queryRawUnsafe<{
        id: string; campaign_id: string; bid: number
        spend_c: bigint; sales_c: bigint; impressions: bigint
      }[]>(`
        SELECT t.id, c.id AS campaign_id, COALESCE(t."bidCents", 0) AS bid,
               COALESCE(SUM(d."costMicros")/10000, 0) AS spend_c,
               COALESCE(SUM(d."sales7dCents"), 0) AS sales_c,
               COALESCE(SUM(d.impressions), 0) AS impressions
        FROM "AdTarget" t
        JOIN "AdGroup" g ON g.id = t."adGroupId"
        JOIN "Campaign" c ON c.id = g."campaignId"
        LEFT JOIN "AmazonAdsDailyPerformance" d
          ON d."entityType"='AD_TARGET' AND d."entityId"=t."externalTargetId"
         AND d.date > now() - interval '30 days'
        WHERE c.id IN (${campaignIds.map((x) => `'${x}'`).join(',')})
          AND t.kind='KEYWORD' AND t."isNegative"=false AND t.status='ENABLED'
          AND t."externalTargetId" IS NOT NULL
          AND LOWER(t."expressionValue") = $1
        GROUP BY 1, 2, 3
      `, term.term)
      if (targets.length === 0) continue
      const champion = [...targets].sort((a, b) => {
        const aa = Number(a.sales_c) > 0 ? Number(a.spend_c) / Number(a.sales_c) : Number.POSITIVE_INFINITY
        const ba = Number(b.sales_c) > 0 ? Number(b.spend_c) / Number(b.sales_c) : Number.POSITIVE_INFINITY
        return aa - ba || Number(b.spend_c) - Number(a.spend_c) || Number(b.impressions) - Number(a.impressions)
      })[0]

      // Weekly share for this term through the family lens (market once, ours summed).
      let share: number | null = null
      if (weekDate) {
        const sq = await prisma.$queryRawUnsafe<{ m: bigint; o: bigint }[]>(`
          SELECT MAX("impressionsTotal") AS m, SUM("impressionsBrand") AS o
          FROM "SearchQueryPerformance"
          WHERE marketplace = $1 AND "startDate" = $2 AND LOWER("searchQuery") = $3
        `, set.marketplace, weekDate, term.term)
        const m = Number(sq[0]?.m ?? 0)
        share = m > 0 ? Number(sq[0]?.o ?? 0) / m : null
      }

      const totalSpend = targets.reduce((a, t) => a + Number(t.spend_c), 0)
      const totalSales = targets.reduce((a, t) => a + Number(t.sales_c), 0)
      const decision = decideBidStep({
        currentBidCents: champion.bid,
        share,
        targetSharePct: term.targetSharePct != null ? Number(term.targetSharePct) : null,
        acos30d: totalSales > 0 ? totalSpend / totalSales : null,
        familyAcosCapPct: set.acosCapPct != null ? Number(set.acosCapPct) : null,
        maxCpcCents: term.maxCpcCents,
        familyDailyCapBreached,
        spend30dCents: totalSpend,
        sales30dCents: totalSales,
      })

      summary.termsEvaluated += 1
      if (decision.action === 'up') summary.ups += 1
      else if (decision.action === 'down') summary.downs += 1
      else summary.holds += 1

      let applied = false
      let applyError: string | null = null
      if (applyMode && decision.action !== 'hold') {
        try {
          const { updateAdTargetWithSync } = await import('./ads-mutation.service.js')
          const res = await updateAdTargetWithSync({
            adTargetId: champion.id,
            patch: { bidCents: decision.nextBidCents },
            actor: 'automation:coverage-engine',
            reason: `Coverage engine: ${decision.reason}`,
            evidence: {
              metric: 'coverage_share',
              observed: share != null ? `${(share * 100).toFixed(2)}%` : 'unmeasured',
              threshold: term.targetSharePct != null ? `${term.targetSharePct}%` : 'none',
              windowDays: 30,
            } as never,
            applyImmediately: true,
            changeSetId: changeSet,
          })
          applied = res.ok
          if (!res.ok) { applyError = res.error ?? 'not ok'; summary.blocked += 1 }
          else summary.applied += 1
        } catch (e) { applyError = (e as Error).message.slice(0, 160); summary.blocked += 1 }
      } else if (!opts.previewSetId && decision.action !== 'hold') {
        // OBSERVE: the would-do, logged where the Activity tab already reads.
        await prisma.advertisingActionLog.create({
          data: {
            actionType: 'coverage_engine_observe',
            entityType: 'AD_TARGET',
            entityId: champion.id,
            payloadBefore: { bidCents: champion.bid },
            payloadAfter: { wouldSetBidCents: decision.nextBidCents, action: decision.action },
            amazonResponseStatus: 'SUCCESS',
            evidence: {
              metric: 'coverage_share',
              observed: share != null ? `${(share * 100).toFixed(2)}%` : 'unmeasured',
              threshold: term.targetSharePct != null ? `${term.targetSharePct}%` : 'none',
              reason: decision.reason,
            } as never,
          },
        }).catch(() => {})
      }

      summary.decisions.push({
        setId: set.id, setName: set.name, term: term.term,
        campaignName: nameByCampaign.get(champion.campaign_id) ?? champion.campaign_id,
        adTargetId: champion.id, decision,
        currentBidCents: champion.bid, share, applied, applyError,
      })
    }
  }

  summary.controlsSkipped = controlsSkipped
  logger.info('[coverage-engine] tick', {
    mode, sets: summary.setsEnabled, terms: summary.termsEvaluated, controls: controlsSkipped,
    ups: summary.ups, downs: summary.downs, holds: summary.holds,
    applied: summary.applied, blocked: summary.blocked,
  })
  return summary
}

/* ── the engine's paper trail, readable ──────────────────────────────────────────────────── */

export interface EngineLogRow {
  at: string
  term: string | null
  campaignName: string | null
  action: 'up' | 'down'
  fromCents: number | null
  toCents: number | null
  reason: string | null
  /** observed = would-do only (OBSERVE mode); applied = a real write went through the gate. */
  kind: 'observed' | 'applied'
}

/**
 * The observe week is only as good as its record. OBSERVE rows are `coverage_engine_observe`
 * action-log entries; AUTO writes land as ordinary gated mutations whose executionId carries
 * the engine's daily change-set tag. Both are keyed by target id, so terms are joined back on.
 */
export async function getCoverageEngineLog(days = 14): Promise<EngineLogRow[]> {
  const since = new Date(Date.now() - days * 86_400_000)
  const rows = await prisma.advertisingActionLog.findMany({
    where: {
      createdAt: { gte: since },
      OR: [
        { actionType: 'coverage_engine_observe' },
        { executionId: { startsWith: 'coverage-engine-' } },
      ],
    },
    orderBy: { createdAt: 'desc' },
    take: 400,
  })
  const targetIds = [...new Set(rows.map((r) => r.entityId))]
  const targets = targetIds.length === 0 ? [] : await prisma.adTarget.findMany({
    where: { id: { in: targetIds } },
    select: {
      id: true, expressionValue: true,
      adGroup: { select: { campaign: { select: { name: true } } } },
    },
  })
  const targetById = new Map(targets.map((t) => [t.id, t]))
  return rows.map((r) => {
    const t = targetById.get(r.entityId)
    const before = r.payloadBefore as { bidCents?: number } | null
    const after = r.payloadAfter as { wouldSetBidCents?: number; bidCents?: number; action?: string } | null
    const ev = r.evidence as { reason?: string; observed?: string; threshold?: string } | null
    const observed = r.actionType === 'coverage_engine_observe'
    const toCents = observed ? after?.wouldSetBidCents ?? null : after?.bidCents ?? null
    const fromCents = before?.bidCents ?? null
    return {
      at: r.createdAt.toISOString(),
      term: t?.expressionValue ?? null,
      campaignName: t?.adGroup?.campaign?.name ?? null,
      action: (after?.action === 'up' || after?.action === 'down')
        ? after.action
        : toCents != null && fromCents != null && toCents > fromCents ? 'up' : 'down',
      fromCents,
      toCents,
      // Applied rows have no free-text reason on the log row; share vs target is the substance.
      reason: ev?.reason ?? (ev?.observed ? `share ${ev.observed} vs target ${ev.threshold ?? 'none'}` : null),
      kind: observed ? 'observed' : 'applied',
    }
  })
}
