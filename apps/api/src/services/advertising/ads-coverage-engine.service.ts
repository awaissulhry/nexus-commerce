/**
 * ACR.3 (Stage 3) — the coverage engine: hold each term of an enabled coverage set at its
 * target share, inside its caps, without operator attention.
 *
 * This is the pilot the whole engagement was opened for: "several products, same keywords —
 * make them appear on the same page… automate it all so it doesn't require my attention."
 * The engine is a bid ladder, not a structure builder. It moves ONE lever per term — the
 * championed target's bid — which controls how often the family's tile shows and how much of
 * the term's impressions it takes. What a bid cannot do is put a SECOND tile on the page:
 * ACR.2.4 established that the "10 GALE ASINs on one SERP" were one variation family — one
 * tile — so multi-product presence is NOT the status quo; it needs a second family bidding
 * the same terms, which is structural, operator-gated work the variation experiment informs.
 *
 *   share below target  → step the family's championed keyword bid UP (within every cap)
 *   share at/above target → DECAY the bid gently to find the cheapest bid that still holds
 *   ACOS breach          → step DOWN regardless of share — the family's cap outranks coverage
 *   family daily cap hit → no ups today, decays still allowed
 *
 * ── What it reads, and why ──────────────────────────────────────────────────────────────────
 * ENABLED KeywordCoverageSets only — intent, never raw SQP. Share ground truth is Amazon's weekly
 * Brand Analytics Search Query Performance: of the query's impressions in search results (Amazon
 * counts every search-results impression; there is no page filter), the share the SET's own ASINs
 * took — computed by Nexus as Σ the set's ASINs' impressions ÷ the query's total. Spend/ACOS feedback
 * is daily AD_TARGET grain.
 *
 * A2 (2026-10-10) — the week is the one an SOV rule reads (`sqpWeekGate`, ads-sov-keyword-share.service.ts):
 * WEEK rows only, a complete week, ended at most 14 days ago; else the share is unmeasured and the
 * term holds, saying why. The share is the set's portfolio ASINs' only (it used to sum every ASIN of
 * the business into one family's bid), and the share ladder steps a term at most ONCE per Brand
 * Analytics week (it used to step +12 % every day on the same weekly reading); the ACoS cap and the
 * waste guard, which read daily data, still act daily. Evidence: {metric:'sqp_brand_impression_share',
 * week, ageDays} — not a 30-day window.
 *
 * ── What it will not do ─────────────────────────────────────────────────────────────────────
 *   · Write in OBSERVE mode. Every decision is logged as would-do to AdvertisingActionLog;
 *     mode comes from NEXUS_COVERAGE_ENGINE_MODE (off | observe | auto), default observe.
 *   · Touch a term without a championed target. Structural creation (lead-ASIN isolation,
 *     new keywords) stays operator-gated; the engine moves bids that exist.
 *   · Bypass anything. Writes go through updateAdTargetWithSync — the write gate, the halt,
 *     bounds, audit, queue — tagged with one change-set per day for whole-day revert.
 *   · 1d — Ignore the account dial or its own caps (ads-engine-guard.ts). In auto mode, under SUGGEST
 *     and while halted / OFF, it logs the would-do exactly as OBSERVE does and writes nothing (a step
 *     down is not a suppression, so the gate would refuse it); at most N bid steps a run and a day.
 */
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { allowChange, engineGuardNote, nothingHeld, openEngineGuard, type EngineGuardReport } from './ads-engine-guard.js'
import { brainOwnedCampaignIds } from './bid-brain/live.js'
import { sqpWeekEnd } from './keyword-rank-feed.service.js'

export type CoverageEngineMode = 'off' | 'observe' | 'auto'

export function engineMode(): CoverageEngineMode {
  const raw = (process.env.NEXUS_COVERAGE_ENGINE_MODE ?? 'observe').toLowerCase()
  return raw === 'auto' ? 'auto' : raw === 'off' ? 'off' : 'observe'
}

const LEVEL_OF = { off: 'OFF', observe: 'OBSERVE', auto: 'AUTO' } as const
const MODE_OF = { OFF: 'off', OBSERVE: 'observe', PROPOSE: 'observe', AUTO: 'auto' } as const

/** R16 — the lower of the env mode and this business's switch (engine-switch.service.ts). */
export async function businessEngineMode(): Promise<CoverageEngineMode> {
  const { engineMode: switched } = await import('../automation/engine-switch.service.js')
  return MODE_OF[(await switched('coverage-engine', LEVEL_OF[engineMode()])).mode]
}

/** Ladder tuning — env-tunable, conservative by default. */
const STEP_UP_PCT = Number(process.env.NEXUS_COVERAGE_STEP_UP_PCT ?? 12)
const DECAY_PCT = Number(process.env.NEXUS_COVERAGE_DECAY_PCT ?? 6)
const MIN_BID_CENTS = 5
/** Hard ceiling when neither the term nor the account provides one — never unbounded (ACR.1.4). */
export const DEFAULT_MAX_CPC_CENTS = Number(process.env.NEXUS_COVERAGE_DEFAULT_MAX_CPC_CENTS ?? 120)

export interface LadderInput {
  currentBidCents: number
  /** Weekly SQP share of the set's ASINs, 0..1, null when the term is unmeasured this week. */
  share: number | null
  /** A2 — the Amazon week the share is from (its start, YYYY-MM-DD), for the words. */
  shareWeek?: string | null
  /** A2 — why the share is unmeasured, in words (no usable week, no row for the set's ASINs, …). */
  shareNote?: string | null
  /** A2 — the share ladder already stepped (or logged the would-do of) this term on this week. */
  shareSteppedThisWeek?: boolean
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
  /** A2 — what the decision rests on: the family ACoS cap, the 30-day waste guard, the weekly share, or nothing. */
  basis?: 'acos-cap' | 'waste' | 'share' | 'none'
}

/** A share as a percent with two decimals; a non-zero share under 0.01 % reads "<0.01%", never "0.00%". */
export function sharePctText(share: number): string {
  const pct = share * 100
  return pct > 0 && pct < 0.01 ? '<0.01%' : `${pct.toFixed(2)}%`
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
      return { action: 'down', nextBidCents: down, reason: `ACOS ${(i.acos30d * 100).toFixed(0)}% over the family cap ${i.familyAcosCapPct}% (30 days)`, basis: 'acos-cap' }
    }
    return { action: 'hold', nextBidCents: i.currentBidCents, reason: 'ACOS over cap but bid already at the floor', basis: 'acos-cap' }
  }

  // 2. Waste guard: real spend, zero sales → step down even if share is short. Coverage that
  //    never converts is the failure mode the wasted-spend board prices every day.
  if (i.sales30dCents === 0 && i.spend30dCents >= 2_000) {
    if (down < i.currentBidCents) {
      return { action: 'down', nextBidCents: down, reason: `€${(i.spend30dCents / 100).toFixed(0)} in 30d with no sales`, basis: 'waste' }
    }
    return { action: 'hold', nextBidCents: i.currentBidCents, reason: 'wasteful but already at the floor', basis: 'waste' }
  }

  // 3. Share ladder — only when the operator set a target and the week is measured.
  if (i.targetSharePct != null && i.share != null) {
    const share = `impression share ${sharePctText(i.share)} (the set's ASINs, Brand Analytics week of ${i.shareWeek ?? 'unknown'}, computed by Nexus)`
    // A2 — one share step per Brand Analytics week: the weekly reading has already been acted on.
    if (i.shareSteppedThisWeek) {
      return { action: 'hold', nextBidCents: i.currentBidCents, reason: `${share}: already stepped on this week; the next share step waits for a newer Brand Analytics week`, basis: 'share' }
    }
    const sharePct = i.share * 100
    if (sharePct < i.targetSharePct) {
      if (i.familyDailyCapBreached) {
        return { action: 'hold', nextBidCents: i.currentBidCents, reason: `${share} below target ${i.targetSharePct}% but the family daily cap is spent`, basis: 'share' }
      }
      if (up > i.currentBidCents) {
        return { action: 'up', nextBidCents: up, reason: `${share} below target ${i.targetSharePct}%`, basis: 'share' }
      }
      return { action: 'hold', nextBidCents: i.currentBidCents, reason: `${share} below target but at the ${ceiling}¢ ceiling`, basis: 'share' }
    }
    // At/above target: decay to find the cheapest holding bid.
    if (down < i.currentBidCents) {
      return { action: 'down', nextBidCents: down, reason: `${share} holds target ${i.targetSharePct}% — decaying to find the floor`, basis: 'share' }
    }
    return { action: 'hold', nextBidCents: i.currentBidCents, reason: `${share}: holding target at the floor bid`, basis: 'share' }
  }

  // 4. No target set (or unmeasured week): do nothing loud. A controller with no setpoint
  //    or no measurement has no business moving money.
  return {
    action: 'hold',
    nextBidCents: i.currentBidCents,
    reason: i.targetSharePct == null ? 'no target share set for this term' : `share unmeasured — ${i.shareNote ?? 'no share ground truth this week'}`,
    basis: 'none',
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
  /** The set's ASINs' weekly Brand Analytics impression share for the term (0..1, computed by Nexus); null: unmeasured. */
  share: number | null
  /** A2 — the Amazon week it is from (its start, YYYY-MM-DD) and whole days since that week ended; null: no usable week. */
  shareWeek?: string | null
  shareAgeDays?: number | null
  applied: boolean
  applyError: string | null
}

/** A2 — the evidence a coverage step or would-do carries: the weekly share's week and age, or the 30-day guard it obeyed. */
export function coverageEvidence(a: { decision: LadderDecision; setId: string; term: string; share: number | null; targetSharePct: number | null; week: string | null; ageDays: number | null; acos30d: number | null }): Record<string, unknown> {
  const base = { setId: a.setId, term: a.term }
  if (a.decision.basis === 'acos-cap') return { ...base, metric: 'acos_30d', observed: a.acos30d != null ? `${(a.acos30d * 100).toFixed(0)}%` : 'none', windowDays: 30 }
  if (a.decision.basis === 'waste') return { ...base, metric: 'spend_without_sales_30d', windowDays: 30 }
  return {
    ...base,
    metric: 'sqp_brand_impression_share',
    observed: a.share != null ? sharePctText(a.share) : 'unmeasured',
    threshold: a.targetSharePct != null ? `${a.targetSharePct}%` : 'none',
    week: a.week,
    ageDays: a.ageDays,
  }
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
  /** 1d — auto mode only: the dial posture and the caps this run ran under, and what they held back. */
  guard?: EngineGuardReport
  /** BB-6 — campaigns of its sets the bid brain owns, left to the brain (one writer per campaign). */
  brainOwned?: number
}

/** 1d — the cron's summary line: the counts, plus what the dial or the caps held back (nothing extra on a normal run). */
export function coverageEngineSummaryLine(r: EngineRunSummary): string {
  return `mode=${r.mode} sets=${r.setsEnabled} terms=${r.termsEvaluated} up=${r.ups} down=${r.downs} hold=${r.holds} applied=${r.applied} blocked=${r.blocked}${r.brainOwned ? ` brain-owned=${r.brainOwned} (the bid brain runs them)` : ''}${engineGuardNote(r.guard, {
    suggest: 'nothing is written; the bids it would set are logged, as in observe mode',
    stopped: 'nothing is written; the bids it would set are logged, as in observe mode',
  })}`
}

/**
 * One engine tick. `previewSetId` evaluates ONE set even if disabled — the cockpit's
 * "what would the engine do" preview — and never applies, regardless of mode.
 */
export async function runCoverageEngineOnce(opts: { previewSetId?: string } = {}): Promise<EngineRunSummary> {
  const mode = await businessEngineMode()
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
  // 1d — the account dial and this engine's caps, read once per run (only a run that may write reads them).
  const guard = applyMode ? await openEngineGuard('coverage-engine') : null

  for (const set of sets) {
    // Family membership + campaigns, by the same rule the cockpit uses.
    const members = await prisma.campaign.findMany({
      where: { portfolioId: set.portfolioId, status: 'ENABLED' },
      select: { id: true, name: true, externalCampaignId: true },
    })
    // BID BRAIN BB-6 — a campaign the brain owns has one bid writer, the brain: the coverage engine leaves it.
    const brainOwned = await brainOwnedCampaignIds(members.map((c) => c.id))
    if (brainOwned.size) summary.brainOwned = (summary.brainOwned ?? 0) + brainOwned.size
    const campaigns = members.filter((c) => !brainOwned.has(c.id))
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

    // A2 — share ground truth: the week an SOV rule reads (WEEK rows, complete, ended ≤ 14 days ago), and on it the
    // SET's own portfolio ASINs only (Σ their impressions ÷ the query's total, as the SOV share and the cockpit do).
    const { sqpWeekGate, aggregateQueryShares } = await import('./ads-sov-keyword-share.service.js')
    const period = await sqpWeekGate(set.marketplace)
    const week = !period.refused && period.start ? period.start.toISOString().slice(0, 10) : null
    const shareByTerm = new Map<string, number>()
    let weekNote: string | null = period.refused ? (period.note ?? 'no usable Brand Analytics week') : null
    const steppedOnWeek = new Set<string>()
    if (week && period.start) {
      const { familyIdentity } = await import('./ads-coverage-sets.service.js')
      const { asins } = await familyIdentity(set.portfolioId)
      const terms = [...new Set(set.terms.map((t) => t.term.trim().toLowerCase()))]
      if (!asins.length) weekNote = 'the set\'s portfolio advertises no ASIN Nexus knows, so no share of its own can be read'
      else if (terms.length) {
        const sq = await prisma.$queryRaw<Array<{ searchQuery: string; impressionsBrand: number; impressionsTotal: number }>>`
          SELECT "searchQuery", "impressionsBrand", "impressionsTotal" FROM "SearchQueryPerformance"
           WHERE marketplace = ${set.marketplace} AND "reportPeriod" = 'WEEK' AND "startDate" = ${period.start}::date
             AND asin = ANY(${asins}::text[]) AND LOWER(TRIM("searchQuery")) = ANY(${terms}::text[])`
        for (const [q, a] of aggregateQueryShares(sq)) shareByTerm.set(q, a.sharePct)
      }
      // A2 — one share step per term per Brand Analytics week: what this set already stepped (or logged as a would-do)
      // on this week. Steps on a week happen after it ended, so its end bounds the read.
      const prior = await prisma.advertisingActionLog.findMany({
        where: {
          createdAt: { gte: sqpWeekEnd(period.start) },
          OR: [{ actionType: 'coverage_engine_observe' }, { executionId: { startsWith: 'coverage-engine-' } }],
        },
        select: { evidence: true },
      })
      for (const r of prior) {
        const e = r.evidence as { metric?: unknown; setId?: unknown; week?: unknown; term?: unknown } | null
        if (e?.metric === 'sqp_brand_impression_share' && e.setId === set.id && e.week === week && typeof e.term === 'string') steppedOnWeek.add(e.term)
      }
    }

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

      // Weekly share for this term through the set's own lens (market once, the set's ASINs summed).
      const termKey = term.term.trim().toLowerCase()
      const share = week ? shareByTerm.get(termKey) ?? null : null
      const shareNote = weekNote ?? (share == null ? `the set's ASINs have no Brand Analytics row with a market total for this term in the week of ${week}` : null)

      const totalSpend = targets.reduce((a, t) => a + Number(t.spend_c), 0)
      const totalSales = targets.reduce((a, t) => a + Number(t.sales_c), 0)
      const targetSharePct = term.targetSharePct != null ? Number(term.targetSharePct) : null
      const acos30d = totalSales > 0 ? totalSpend / totalSales : null
      const decision = decideBidStep({
        currentBidCents: champion.bid,
        share,
        shareWeek: week,
        shareNote,
        shareSteppedThisWeek: steppedOnWeek.has(term.term),
        targetSharePct,
        acos30d,
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

      const evidence = coverageEvidence({ decision, setId: set.id, term: term.term, share, targetSharePct, week, ageDays: week ? period.weekEndAgeDays : null, acos30d })
      let applied = false
      let applyError: string | null = null
      // 1d — one bid step per term: the term asks the guard once, before it. A step the dial holds (SUGGEST,
      // stopped) is logged as a would-do below, as OBSERVE does; one the cap defers is decided again next run.
      const permit = guard && decision.action !== 'hold' ? guard.permit() : null
      const held = nothingHeld()
      if (permit && allowChange(true, permit, held, 'forward')) {
        try {
          const { updateAdTargetWithSync } = await import('./ads-mutation.service.js')
          const res = await updateAdTargetWithSync({
            adTargetId: champion.id,
            patch: { bidCents: decision.nextBidCents },
            actor: 'automation:coverage-engine',
            reason: `Coverage engine: ${decision.reason}`,
            evidence: evidence as never,
            applyImmediately: true,
            changeSetId: changeSet,
          })
          applied = res.ok
          if (!res.ok) { applyError = res.error ?? 'not ok'; summary.blocked += 1 }
          else summary.applied += 1
        } catch (e) { applyError = (e as Error).message.slice(0, 160); summary.blocked += 1 }
        guard!.settle(permit, applied ? 1 : 0, held)
      } else if (permit && guard!.posture === 'auto') {
        guard!.settle(permit, 0, held) // deferred by the cap: no would-do row, it is simply decided again next run
      } else if (!opts.previewSetId && decision.action !== 'hold') {
        if (permit) guard!.settle(permit, 0, held)
        // OBSERVE: the would-do, logged where the Activity tab already reads.
        await prisma.advertisingActionLog.create({
          data: {
            actionType: 'coverage_engine_observe',
            entityType: 'AD_TARGET',
            entityId: champion.id,
            payloadBefore: { bidCents: champion.bid },
            payloadAfter: { wouldSetBidCents: decision.nextBidCents, action: decision.action },
            amazonResponseStatus: 'SUCCESS',
            evidence: { ...evidence, reason: decision.reason } as never,
          },
        }).catch(() => {})
      }

      summary.decisions.push({
        setId: set.id, setName: set.name, term: term.term,
        campaignName: nameByCampaign.get(champion.campaign_id) ?? champion.campaign_id,
        adTargetId: champion.id, decision,
        currentBidCents: champion.bid, share, shareWeek: week, shareAgeDays: week ? period.weekEndAgeDays : null, applied, applyError,
      })
    }
  }

  summary.controlsSkipped = controlsSkipped
  if (guard) summary.guard = guard.report()
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
