/**
 * Apex C.2 — advertising intelligence routes (profit-native target ACOS).
 *
 * Kept in a SEPARATE plugin from advertising.routes.ts on purpose: that file
 * carries a € literal that trips plain grep into binary mode, and it sees heavy
 * concurrent edits — new read-only intel endpoints are safer here. Registered
 * under the same /api prefix.
 */

import type { FastifyPluginAsync } from 'fastify'
import { Prisma } from '@prisma/client'
import prisma from '../db.js'
import { computeProductTargetAcos, computeFleetTargetAcos, type AcosMode } from '../services/advertising/ads-target-acos.service.js'
import { simulateAutopilot, applyAutopilot } from '../services/advertising/ads-autopilot.service.js'
import { getKeywordTracker, KT_MARKETS } from '../services/advertising/keyword-tracker.service.js'
import { getNegatives, getTermContext, NEG_MARKETS, NEG_MARKET_ALL } from '../services/advertising/negatives.service.js'
import { getKeywordHarvest, HV_MARKETS, HV_MARKET_ALL, type HvStatus, type HvKind, type HvSortKey } from '../services/advertising/keyword-harvest.service.js'
import { resolveHarvestPolicy, listHarvestPolicies, saveHarvestPolicy, deleteHarvestPolicy, HV_DEFAULT_CRITERIA, type HvPolicyGrain } from '../services/advertising/harvest-policy.service.js'
import { planPromotion, promoteCandidates } from '../services/advertising/harvest-promote.service.js'
import { getHarvestCohort } from '../services/advertising/harvest-cohort.service.js'
import {
  loadDestinationGraph, resolveStoredDestinations, rankDestinations, listHarvestDestinations,
  saveHarvestDestination, deleteHarvestDestination, HV_CREATE_TYPES,
  type HvDestGrain, type HvCreateType,
} from '../services/advertising/harvest-destination.service.js'
import {
  getBidGrid, getBidCursorForRequest, BID_MARKETS, BID_MARKET_ALL, BID_BANDS,
  type BidBand, type BidMeasured, type BidStatusFilter, type BidView,
} from '../services/advertising/bid-grid.service.js'
import {
  getBudgetGrid, getBudgetCursorForRequest, BUD_MARKETS, BUD_MARKET_ALL, BUD_STATES,
  type BudState, type BudStatusFilter, type BudView,
} from '../services/advertising/budget-grid.service.js'
import {
  getPlacementGrid, getPlacementCursorForRequest, previewPlacementBulk,
  PLC_MARKETS, PLC_MARKET_ALL, PLC_SORT_KEYS, PLC_FLAG_KEYS, LANE_BY_KEY,
  type PlcLaneKey, type PlcSortKey, type PlcFlagKey,
} from '../services/advertising/placement-grid.service.js'
import { buildManualAdjustments, type ManagedPlacement } from '../services/advertising/ads-placement-manual.js'
import { getShareOfVoice, SOV_MARKETS, SOV_WEEKS } from '../services/advertising/share-of-voice.service.js'
import { envEnabled } from '../utils/env-flag.js'
import { cronStartupState } from '../jobs/cron-startup-state.js'
import { amsQueueUrl, isAmsSqsConfigured, sqsUrlFromArn } from '../services/ams-sqs.service.js'

const advertisingIntelRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * RT.0 — invalidate the ads read cache after any successful write from THIS plugin.
   *
   * `advertising.routes.ts` has carried this hook since Phase 4; this file never did, and it has
   * grown to **48 write routes** (bid policies, spend ceilings, campaign goals, harvest policies and
   * destinations, watchlists, budget baselines…). Meanwhile `GET /advertising/campaigns` is
   * `cached(…, 300)` — so a write through any of those 48 left the Apply Rules grid serving a
   * five-minute-old answer, and no amount of client-side polling can see past a cache.
   *
   * Verbatim copy of the sibling hook, deliberately: two flush policies for one cache is how they
   * start to disagree about what a write invalidates.
   */
  fastify.addHook('onResponse', async (request, reply) => {
    if (request.method === 'GET' || request.method === 'HEAD') return
    if (reply.statusCode >= 400) return
    if (!request.url.includes('/advertising/')) return
    const { flushAdsCache } = await import('../services/advertising/ads-cache.js')
    void flushAdsCache()
  })

  // Apex — diagnostic probe for the ads-cron gate. Reads the SAME process.env
  // the boot-time cron block reads (single process serves HTTP + crons), so this
  // definitively shows whether the running process sees the flag as enabled and
  // what raw value was set. processUptimeSec confirms whether a recent deploy
  // actually restarted the container.
  fastify.get('/advertising/cron-status', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store')
    return {
      adsCronEnabled: envEnabled('NEXUS_ENABLE_AMAZON_ADS_CRON'),
      adsCronRaw: process.env.NEXUS_ENABLE_AMAZON_ADS_CRON ?? null,
      cronStartupStep: cronStartupState.step,
      cronStartupAt: cronStartupState.updatedAt,
      adsMode: process.env.NEXUS_AMAZON_ADS_MODE ?? null,
      queueWorkersRaw: process.env.ENABLE_QUEUE_WORKERS ?? null,
      hasRedisUrl: !!process.env.REDIS_URL,
      // Apex B.1 — why the AMS poller is/ isn't active. amsQueueUrlResolved=true
      // means we derived a pollable SQS URL (from NEXUS_AMS_SQS_QUEUE_URL or an
      // SQS NEXUS_AMS_DESTINATION_ARN). pollerActive requires that + AWS creds.
      ams: {
        destinationArnSet: !!process.env.NEXUS_AMS_DESTINATION_ARN,
        destinationArnIsSqs: process.env.NEXUS_AMS_DESTINATION_ARN ? !!sqsUrlFromArn(process.env.NEXUS_AMS_DESTINATION_ARN) : false,
        explicitQueueUrlSet: !!process.env.NEXUS_AMS_SQS_QUEUE_URL,
        queueUrlResolved: !!amsQueueUrl(),
        hasAwsAccessKey: !!process.env.AWS_ACCESS_KEY_ID,
        hasAwsSecret: !!process.env.AWS_SECRET_ACCESS_KEY,
        pollerActive: isAmsSqsConfigured(),
      },
      processUptimeSec: Math.round(process.uptime()),
      nowUtc: new Date().toISOString(),
    }
  })

  // Per-product profit-native target ACOS + break-even + TACOS/TACoP.
  fastify.get('/advertising/target-acos', async (request, reply) => {
    const q = request.query as { productId?: string; marketplace?: string; windowDays?: string; mode?: string }
    if (!q.productId) { reply.status(400); return { error: 'productId required' } }
    const result = await computeProductTargetAcos({
      productId: q.productId,
      marketplace: q.marketplace ?? null,
      windowDays: q.windowDays ? Number(q.windowDays) : undefined,
      mode: (q.mode as AcosMode) ?? undefined,
    })
    reply.header('Cache-Control', 'private, max-age=120')
    return result
  })

  /**
   * Simulate ONE rule against real current data. Nothing reaches Amazon.
   *
   * RA.AUTO rewrote this route. It used to say "dry-run forced for safety" and then call
   * `void runAdvertisingRuleEvaluatorOnce()` — the whole evaluator, all 21 triggers, every
   * enabled rule, with dry-run forced by nothing but the account-level SUGGEST posture (which is
   * off). Pressing Simulate on one PROPOSE rule therefore handed the eight writing AUTO rules a
   * live tick, and the un-awaited `void` meant it returned before anything happened and could
   * never show what the rule would do. Nothing in the UI called it, which is the only reason
   * this was latent rather than an incident.
   *
   * `simulateOneRule` evaluates that rule and no other, with `forceDryRun` and `isTestRun` set,
   * and can simulate a DISABLED rule without arming it — which is the main case, since 29 of the
   * 51 rules are off and "what would this do" is what you ask before turning one on.
   *
   * It DOES write `AutomationRuleExecution` rows, one per evaluated context, exactly as a
   * dry-run tick does. "Writes nothing" means nothing reaches Amazon, not that the database is
   * untouched — the response says so on `wroteAuditRows` so no caller has to guess.
   */
  fastify.post('/advertising/automation-rules/:id/simulate', async (request, reply) => {
    const { id } = request.params as { id: string }
    try {
      const { simulateOneRule } = await import('../jobs/advertising-rule-evaluator.job.js')
      const out = await simulateOneRule(id)
      if (!out.ok) { reply.status(out.error === 'not_found' ? 404 : 400); return out }
      return {
        ...out,
        reachedAmazon: false,
        wroteAuditRows: out.results?.length ?? 0,
      }
    } catch (e) {
      reply.status(500); return { ok: false, error: (e as Error)?.message }
    }
  })

  // Automation real-time activity feed — last N executions with what changed
  fastify.get('/advertising/automation-feed', async (request, reply) => {
    const q = request.query as { limit?: string; domain?: string }
    const limit = Math.min(200, Math.max(10, Number(q.limit) || 50))
    const execs = await prisma.automationRuleExecution.findMany({
      // ACR.6 — `domain` is a column on AutomationRule, NOT on AutomationRuleExecution, so this
      // filter has to travel through the relation. Written flat with an `as never` it threw
      // "Unknown argument `domain`" on every call and the route 500'd; the cast is what hid it
      // from tsc (this workspace is not strict). Verified on prod 2026-08-05.
      where: { rule: { domain: 'advertising' } },
      orderBy: { startedAt: 'desc' },
      take: limit,
      select: {
        id: true, dryRun: true, status: true, startedAt: true, finishedAt: true, durationMs: true,
        actionResults: true,
        rule: { select: { id: true, name: true, trigger: true } },
      },
    })
    const items = execs.map((e) => {
      const actions = (e.actionResults as Array<{ type?: string; ok?: boolean; output?: Record<string, unknown>; error?: string }> | null) ?? []
      const summary = actions.map((a) => {
        const o = a.output ?? {}
        if (a.type === 'harvest_and_negate') return `negated ${o.negativesAdded ?? 0}, graduated ${o.keywordsGraduated ?? 0}`
        if (a.type === 'retail_guard') return `guarded ${o.paused ?? 0} campaigns`
        if (a.type === 'pause_all_campaigns') return `paused ${o.paused ?? 0} campaigns`
        if (a.type === 'bid_to_target_acos') return `adjusted ${o.applied ?? 0} bids`
        if (a.type === 'promote_to_exact') return `promoted "${o.query}" → exact`
        if (a.type === 'add_negative_exact') return `negated "${o.keyword}"`
        if (a.type === 'bid_down' || a.type === 'bid_up') return `bid ${a.type === 'bid_down' ? '↓' : '↑'} ${o.target ?? ''}`
        if (a.type === 'adjust_ad_budget') return `budget changed`
        if (a.type === 'notify' || a.type === 'alert_operator') return null
        return a.type
      }).filter(Boolean).join('; ') || (e.dryRun ? 'dry-run preview' : 'no action')
      return {
        id: e.id, ruleName: e.rule?.name ?? '—', trigger: e.rule?.trigger ?? '—',
        status: e.status, dryRun: e.dryRun, startedAt: e.startedAt,
        durationMs: e.durationMs, summary,
        actionCount: actions.length,
        successCount: actions.filter((a) => a.ok !== false).length,
      }
    })
    reply.header('Cache-Control', 'private, max-age=30')
    return { items, count: items.length }
  })

  // Automation analytics — per-rule impact over time
  fastify.get('/advertising/automation-analytics', async (request, reply) => {
    const q = request.query as { windowDays?: string }
    const days = Math.max(7, Math.min(90, Number(q.windowDays) || 30))
    const since = new Date(); since.setUTCDate(since.getUTCDate() - days); since.setUTCHours(0, 0, 0, 0)
    const execs = await prisma.automationRuleExecution.findMany({
      // ACR.6 — see automation-feed above: `domain` lives on the RULE. This threw on every
      // call, so this endpoint had never returned data to anything that asked. The relation
      // filter is also what bounds the scan: 3,577 advertising executions in 30d against
      // 522,985 across all domains.
      where: { startedAt: { gte: since }, status: { in: ['SUCCESS', 'PARTIAL'] }, rule: { domain: 'advertising' } },
      select: { actionResults: true, rule: { select: { id: true, name: true } }, startedAt: true },
    })
    /**
     * ACR.6 — WHAT THIS COUNTS, MEASURED RATHER THAN ASSUMED.
     *
     * The original three lines counted `harvest_and_negate`, `bid_to_target_acos` and
     * `retail_guard`. Measured over 30 days on prod (scripts/_acr6-actiontypes-probe.mts),
     * advertising executions emit 7,218 action results across six types, and those three cover
     * 20.3% of them. `harvest_and_negate` **never appears at all**, while `adjust_ad_budget` —
     * 88 results, each carrying an `outboundQueueId`, i.e. real queued budget writes — was
     * counted by nothing. So a surface built on this reported "0 actions" on an account that was
     * changing budgets that week.
     *
     * FAILURES ARE NOW FIRST-CLASS, and they are the largest thing in this data: 2,032 `bid_up`
     * results in 30 days, every one `ok:false` with "Unsupported target=ad_group", all from a
     * single rule. An impact view that answers "did the fleet do anything" while silently
     * dropping 2,032 failures answers it wrongly — and the older read would have shown a
     * confident, quiet zero.
     *
     * Additive to the response shape; the only consumer is the Rules & Automation impact strip.
     */
    const byRule = new Map<string, { name: string; runs: number; termsNegated: number; bidsAdjusted: number; campaignsGuarded: number; budgetChanges: number; failedActions: number; lastRun: string }>()
    for (const e of execs) {
      const ruleId = e.rule?.id ?? 'unknown'; const ruleName = e.rule?.name ?? 'Unknown'
      if (!byRule.has(ruleId)) byRule.set(ruleId, { name: ruleName, runs: 0, termsNegated: 0, bidsAdjusted: 0, campaignsGuarded: 0, budgetChanges: 0, failedActions: 0, lastRun: '' })
      const r = byRule.get(ruleId)!; r.runs++; r.lastRun = e.startedAt.toISOString()
      for (const a of (e.actionResults as Array<{ type?: string; ok?: boolean; output?: Record<string, unknown> }> | null) ?? []) {
        const o = a.output ?? {}
        // An action that reports ok:false did not happen, whatever else it says.
        if (a.ok === false) { r.failedActions++; continue }
        if (a.type === 'harvest_and_negate') { r.termsNegated += Number(o.negativesAdded ?? 0) }
        if (a.type === 'bid_to_target_acos') { r.bidsAdjusted += Number(o.applied ?? 0) }
        if (a.type === 'retail_guard') { r.campaignsGuarded += Number(o.paused ?? 0) }
        // One queued budget write per result — there is no count in the output to sum.
        if (a.type === 'adjust_ad_budget') { r.budgetChanges++ }
      }
    }
    const rules = [...byRule.values()].sort((a, b) => b.runs - a.runs)
    reply.header('Cache-Control', 'private, max-age=120')
    return { windowDays: days, rules, totalRuns: execs.length }
  })

  // AU.7 — automation impact summary: what did automation actually DO this week?
  // Parses AutomationRuleExecution.actionResults to surface real numbers.
  fastify.get('/advertising/automation-impact', async (request, reply) => {
    const q = request.query as { windowDays?: string }
    const days = Math.max(1, Math.min(90, Number(q.windowDays) || 7))
    const since = new Date(); since.setUTCDate(since.getUTCDate() - days); since.setUTCHours(0, 0, 0, 0)
    const execs = await prisma.automationRuleExecution.findMany({
      // ACR.6 — same defect, same fix; `domain` is on AutomationRule.
      where: { startedAt: { gte: since }, status: { in: ['SUCCESS', 'PARTIAL', 'DRY_RUN'] }, rule: { domain: 'advertising' } },
      select: { actionResults: true, dryRun: true, status: true, startedAt: true, rule: { select: { name: true, trigger: true } } },
      orderBy: { startedAt: 'desc' },
      take: 2000,
    })
    let termsNegated = 0, termsGraduated = 0, campaignsPaused = 0, campaignsGuarded = 0, bidsAdjusted = 0, budgetChanges = 0
    for (const e of execs) {
      for (const a of (e.actionResults as Array<{ type?: string; output?: Record<string, unknown> }> | null) ?? []) {
        if (!a?.output) continue
        const o = a.output
        switch (a.type) {
          case 'harvest_and_negate': termsNegated += Number(o.negativesAdded ?? 0); termsGraduated += Number(o.keywordsGraduated ?? 0); break
          case 'retail_guard': campaignsGuarded += Number(o.paused ?? 0); break
          case 'pause_campaign': case 'pause_ad_group': campaignsPaused += 1; break
          case 'pause_all_campaigns': campaignsPaused += Number(o.paused ?? 0); break
          case 'bid_down': case 'bid_up': case 'bid_to_target_acos': bidsAdjusted += Number(o.applied ?? (o.outboundQueueId ? 1 : 0)); break
          case 'adjust_ad_budget': budgetChanges += 1; break
        }
      }
    }
    reply.header('Cache-Control', 'private, max-age=120')
    return { windowDays: days, liveRuns: execs.filter((e) => !e.dryRun).length, dryRuns: execs.filter((e) => e.dryRun).length, termsNegated, termsGraduated, campaignsPaused, campaignsGuarded, bidsAdjusted, budgetChanges }
  })

  // Apex F.1 — beginner autopilot: simulate (read-only) the full plan one north
  // star drives (profit-native bids + Bayesian sparse handling + ToS defense),
  // as a plain-language list. Nothing is applied.
  fastify.get('/advertising/autopilot/simulate', async (request, reply) => {
    const q = request.query as { campaignId?: string; marketplace?: string; mode?: string; bayesian?: string; targetAcos?: string }
    const plan = await simulateAutopilot({
      campaignId: q.campaignId,
      marketplace: q.marketplace,
      mode: q.mode === 'profit' || q.mode === 'balanced' || q.mode === 'growth' ? q.mode : undefined,
      bayesian: q.bayesian == null ? true : q.bayesian === '1' || q.bayesian === 'true',
      targetAcos: q.targetAcos ? Number(q.targetAcos) : undefined,
    })
    reply.header('Cache-Control', 'private, max-age=30')
    return plan
  })

  // Apex F.2 — apply the autopilot plan (operator-triggered). Allowlist-gated end
  // to end: bid changes filtered to liveBidWritesEnabled campaigns before write;
  // ToS pass allowlistedOnly. Returns applied vs skipped counts.
  fastify.post('/advertising/autopilot/apply', async (request, reply) => {
    const b = (request.body ?? {}) as { campaignId?: string; marketplace?: string; mode?: string; bayesian?: boolean; targetAcos?: number }
    try {
      const result = await applyAutopilot({
        campaignId: b.campaignId,
        marketplace: b.marketplace,
        mode: b.mode === 'profit' || b.mode === 'balanced' || b.mode === 'growth' ? b.mode : undefined,
        bayesian: b.bayesian !== false,
        targetAcos: typeof b.targetAcos === 'number' ? b.targetAcos : undefined,
        actor: (() => { const a = (request.headers as Record<string, unknown>)['x-actor-id']; return typeof a === 'string' && a ? `user:${a}` : 'autopilot' })(),
      })
      return { ok: true, ...result }
    } catch (e) {
      reply.status(500)
      return { ok: false, error: (e as Error)?.message }
    }
  })

  // Apex E.1 — competitive intel: our SHARE per search query (Brand Analytics SQP).
  // Read the ingested SearchQueryPerformance, newest period first, biggest-volume
  // queries first. Optional minShare / asin filters surface where we under-index.
  fastify.get('/advertising/search-query-performance', async (request, reply) => {
    const q = request.query as { marketplace?: string; asin?: string; minImpressionShare?: string; limit?: string; days?: string }
    const since = new Date(); since.setUTCDate(since.getUTCDate() - (q.days ? Number(q.days) : 90)); since.setUTCHours(0, 0, 0, 0)
    const rows = await prisma.searchQueryPerformance.findMany({
      where: {
        startDate: { gte: since },
        ...(q.marketplace ? { marketplace: q.marketplace } : {}),
        ...(q.asin ? { asin: q.asin } : {}),
        ...(q.minImpressionShare ? { impressionShare: { gte: Number(q.minImpressionShare) } } : {}),
      },
      orderBy: [{ startDate: 'desc' }, { searchQueryVolume: 'desc' }],
      take: Math.min(2000, q.limit ? Number(q.limit) : 500),
    })
    reply.header('Cache-Control', 'private, max-age=120')
    return { items: rows, count: rows.length }
  })

  // Diagnostic: the last SQP report's real shape (top-level + first-row keys +
  // a raw sample), captured during ingest — lets us finalise the parser against
  // Amazon's actual fields without Railway log access.
  fastify.get('/advertising/sqp/debug', async (_request, reply) => {
    const { sqpDebugState } = await import('../services/advertising/sqp.service.js')
    reply.header('Cache-Control', 'no-store')
    return sqpDebugState.last ?? { note: 'no SQP report ingested yet this process' }
  })

  // ── KT.1 — the Keyword Tracker page's one read ──────────────────────
  // Registered HERE and not in advertising.routes.ts on purpose: that file sees heavy concurrent
  // edits from parallel sessions and a duplicate route registration there is a boot crash, not a
  // warning. One call carries the resolved scope, the freshness of every source it read, and the
  // rows. See keyword-tracker.service.ts for why a row picks its own SQP period.
  fastify.get('/advertising/keyword-tracker', async (request, reply) => {
    const q = (request.query ?? {}) as Record<string, string | undefined>
    const market = (q.market ?? '').toUpperCase()
    if (!KT_MARKETS.includes(market as (typeof KT_MARKETS)[number])) {
      reply.status(400)
      return { error: `market is required and must be one of ${KT_MARKETS.join('/')}`, code: 'market_required' }
    }
    const measured = q.measured === 'yes' || q.measured === 'no' ? q.measured : 'all'
    const sortKeys = ['keyword', 'volume', 'rank', 'share', 'asins', 'asOf'] as const
    const out = await getKeywordTracker({
      market,
      line: q.line ?? null,
      portfolio: q.portfolio ?? null,
      campaign: q.campaign ?? null,
      list: q.list ?? null,
      // branded=1 includes our own brand terms; absent or 0 excludes them, because our brand
      // flatters every share number on the page.
      branded: q.branded === '1' || q.branded === 'true',
      measured,
      sort: sortKeys.includes(q.sort as (typeof sortKeys)[number]) ? (q.sort as (typeof sortKeys)[number]) : undefined,
      dir: q.dir === 'asc' ? 'asc' : 'desc',
      limit: q.limit ? Number(q.limit) : undefined,
      offset: q.offset ? Number(q.offset) : undefined,
    })
    // Short private cache: the grid is a full scan of SQP joined to the campaign/ad graph, and the
    // underlying feeds move once a night at most.
    reply.header('Cache-Control', 'private, max-age=60')
    return out
  })

  // ── NEG.1 — the Negative Targeting page's one read ──────────────────
  // Here rather than in advertising.routes.ts for the same reason KT.1 is: a duplicate route in
  // that 600 KB file is a boot crash, not a warning, and it sees heavy concurrent edits.
  //
  // Not a variant of `GET /advertising/targets?negative=1`: that route selects `externalTargetId`
  // for its own filtering and then drops it from the returned row, and caps at 2,000 rows against
  // a base of 2,059 — so it can neither say whether a negative reached Amazon nor show the whole
  // account. Both are the point of this page.
  //
  // One call carries the resolved scope, the census over the FULL filtered set, the facet counts,
  // and the rows — so the page can state what it is showing without a second fetch, and no count
  // it renders is ever computed from a page of rows.
  // NEG-P3 — the Negative Targeting tab's one-line strip. `grep -a`ed this file first:
  // `/advertising/negatives/strip` appears nowhere else (a duplicate route is a boot crash).
  fastify.get('/advertising/negatives/strip', async () => {
    const { getNegativesStrip } = await import('../services/advertising/negatives.service.js')
    return getNegativesStrip()
  })

  fastify.get('/advertising/negatives', async (request, reply) => {
    const q = (request.query ?? {}) as Record<string, string | undefined>
    // `all` is accepted here and refused on the Keyword Tracker: everything this page counts is a
    // count of rows, and those sum honestly across markets. See the service header.
    const raw = (q.market ?? '').trim()
    const market = raw.toLowerCase() === NEG_MARKET_ALL ? NEG_MARKET_ALL : raw.toUpperCase()
    if (market !== NEG_MARKET_ALL && !NEG_MARKETS.includes(market as (typeof NEG_MARKETS)[number])) {
      reply.status(400)
      return { error: `market is required and must be one of ${NEG_MARKETS.join('/')} or "all"`, code: 'market_required' }
    }
    const oneOf = <T extends string>(v: string | undefined, allowed: readonly T[]): T | null =>
      (allowed as readonly string[]).includes(v ?? '') ? (v as T) : null
    const out = await getNegatives({
      market,
      line: q.line ?? null,
      portfolio: q.portfolio ?? null,
      campaign: q.campaign ?? null,
      adGroup: q.adGroup ?? null,
      view: q.view === 'terms' ? 'terms' : 'negations',
      q: q.q ?? null,
      match: oneOf(q.match, ['EXACT', 'PHRASE', 'ASIN', 'OTHER', 'all'] as const),
      level: oneOf(q.level, ['AD_GROUP', 'CAMPAIGN', 'all'] as const),
      state: oneOf(q.state, ['live', 'paused', 'archived', 'inert', 'all'] as const),
      amazon: oneOf(q.amazon, ['yes', 'no', 'all'] as const),
      blocking: oneOf(q.blocking, ['yes', 'no', 'all'] as const),
      attribution: oneOf(q.attribution, ['user', 'engine', 'unattributed', 'actor-not-recorded', 'all'] as const),
      sort: oneOf(q.sort, ['term', 'match', 'scope', 'market', 'state', 'amazon', 'added', 'by', 'spread'] as const),
      dir: q.dir === 'asc' ? 'asc' : 'desc',
      window: q.window ? Number(q.window) : null,
    })
    // Short private cache. The base is 2,059 rows joined up to the campaign graph and it changes
    // only when an ingest ticks or an operator acts.
    reply.header('Cache-Control', 'private, max-age=60')
    return out
  })

  // ── NEG.2 — one term, everywhere it is blocked, and what it earns ───
  // The single owner of "what does this term do". NEG.3's removal confirm needs `performance` and
  // `remainder`; NEG.4's detectors need `overlap` and `history`. Both consume this and must not
  // re-derive it — three derivations would disagree, and the one that disagreed would be the one
  // on the confirm dialog.
  //
  // 🔴 Returns facts, not verdicts. There is deliberately no `isConflict` boolean: whether an
  // overlap is a conflict is a threshold decision that belongs to NEG.4.
  fastify.get('/advertising/negatives/term-context', async (request, reply) => {
    const q = (request.query ?? {}) as Record<string, string | undefined>
    const term = (q.term ?? '').trim()
    if (!term) {
      reply.status(400)
      return { error: 'term is required', code: 'term_required' }
    }
    const rawMarket = (q.market ?? '').trim()
    const market = rawMarket.toLowerCase() === NEG_MARKET_ALL || !rawMarket ? NEG_MARKET_ALL : rawMarket.toUpperCase()
    if (market !== NEG_MARKET_ALL && !NEG_MARKETS.includes(market as (typeof NEG_MARKETS)[number])) {
      reply.status(400)
      return { error: `market must be one of ${NEG_MARKETS.join('/')} or "all"`, code: 'market_invalid' }
    }
    const out = await getTermContext({
      term,
      market,
      line: q.line ?? null,
      portfolio: q.portfolio ?? null,
      campaign: q.campaign ?? null,
      adGroup: q.adGroup ?? null,
      window: q.window ? Number(q.window) : null,
    })
    if (!out) {
      // A term with no negation is not an error — it is one of the drawer's four empty states, and
      // it has to be distinguishable from a failed read.
      reply.status(404)
      return { error: 'no negation of that term exists', code: 'term_not_negated', term }
    }
    reply.header('Cache-Control', 'private, max-age=60')
    return out
  })

  // ── NEG.4 — attention: what is wrong right now ──────────────────────
  //
  // Three lists, each a count that can reach zero. 🔴 Detector A's correct answer is currently 0,
  // and a broken query returns 0 too — so the payload carries `overlapsRelaxed` (the same join
  // WITHOUT the blocking predicate) and `coverage.searchTermRows` beside it. A zero in either of
  // those means the read failed, not that the account is clean, and the page says so rather than
  // rendering an empty box.
  //
  // Read-only. It owns the THRESHOLDS; `term-context` owns the FACTS and ships no verdict.
  fastify.get('/advertising/negatives/attention', async (request, reply) => {
    const q = (request.query ?? {}) as Record<string, string | undefined>
    const raw = (q.market ?? '').trim()
    const market = raw.toLowerCase() === NEG_MARKET_ALL || !raw ? NEG_MARKET_ALL : raw.toUpperCase()
    if (market !== NEG_MARKET_ALL && !NEG_MARKETS.includes(market as (typeof NEG_MARKETS)[number])) {
      reply.status(400)
      return { error: `market must be one of ${NEG_MARKETS.join('/')} or "all"`, code: 'market_invalid' }
    }
    const { getAttention } = await import('../services/advertising/negatives-attention.service.js')
    const out = await getAttention({
      market,
      line: q.line ?? null,
      portfolio: q.portfolio ?? null,
      campaign: q.campaign ?? null,
      adGroup: q.adGroup ?? null,
      window: q.window ? Number(q.window) : null,
    })
    reply.header('Cache-Control', 'private, max-age=60')
    return out
  })

  // ── NEG.3 — retire a negative ───────────────────────────────────────
  //
  // 🔴 THE ONLY WRITE ON THIS PAGE, AND IT IS IRREVERSIBLE AT AMAZON. Archive is the only removal
  // Amazon offers for a negative keyword, and archive is terminal. There is no un-archive route
  // here and there must never be one.
  //
  // POST rather than PATCH because it is not a field edit: it is a decision with a record. The
  // body carries the ids, the operator's reason, and an explicit `confirm` — a retirement must not
  // be reachable by a stray request that merely got the URL right.
  //
  // RBAC: a POST under /api/advertising falls past the read-only rule to
  // `RW(F.adsView, F.adsCampaignsManage, pfx('/api/advertising'))`, so it requires
  // `ads.campaigns.manage`, not `ads.view`. That is the correct authority for a write that reaches
  // Amazon and it is deliberately NOT widened.
  fastify.post('/advertising/negatives/retire', async (request, reply) => {
    const body = (request.body ?? {}) as { adTargetIds?: unknown; reason?: unknown; confirm?: unknown }
    const ids = Array.isArray(body.adTargetIds) ? body.adTargetIds.map(String).filter(Boolean) : []
    if (ids.length === 0) {
      reply.status(400)
      return { error: 'adTargetIds is required and must be a non-empty array', code: 'ids_required' }
    }
    // A bound, not a policy. The per-scope ceiling is undecided (NEG.3 §9) and this is NOT it —
    // it only stops a single request asking for more writes than an operator could review.
    if (ids.length > 200) {
      reply.status(400)
      return { error: `${ids.length} ids in one request; the cap is 200. This is a request bound, not a spend ceiling — no per-scope ceiling exists yet.`, code: 'too_many' }
    }
    if (body.confirm !== true) {
      reply.status(400)
      return { error: 'confirm:true is required — archiving a negative at Amazon cannot be undone', code: 'confirm_required' }
    }
    const userId = (request as { authUser?: { id?: string } }).authUser?.id ?? 'anonymous'
    const { retireNegatives } = await import('../services/advertising/negatives-retire.service.js')
    const out = await retireNegatives({
      adTargetIds: ids,
      actor: `user:${userId}` as never,
      retireReason: typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim().slice(0, 500) : null,
    })
    // 🔴 Always 200 with per-row outcomes, never a single pass/fail status. 72 writes have 72
    // independent failure modes, and an HTTP status cannot carry five outcome classes.
    reply.header('Cache-Control', 'no-store')
    return out
  })

  // ── NEG.5 — protected terms: the whitelist, and what already contradicts it ──
  //
  // The forward half (what can never be negated) has always been true. The backward half has
  // never existed: `ads-write-gate.ts:300-337` is a going-forward gate installed 2026-08-04 over
  // a base written 2026-05-20, so it can refuse the next write and can see nothing that is
  // already there. 132 contradictions, all of them BLOCKING right now.
  //
  // 🔴 132 is a PAIR count (negation × protected term) and 128 is the distinct negation count —
  // four `xavia gale` rows contradict two protections each. Both are in the payload because the
  // groups sum to the first and a removal costs the second.
  fastify.get('/advertising/negatives/protections', async (request, reply) => {
    const q = (request.query ?? {}) as Record<string, string | undefined>
    const raw = (q.market ?? '').trim()
    const market = raw.toLowerCase() === NEG_MARKET_ALL || !raw ? NEG_MARKET_ALL : raw.toUpperCase()
    if (market !== NEG_MARKET_ALL && !NEG_MARKETS.includes(market as (typeof NEG_MARKETS)[number])) {
      reply.status(400)
      return { error: `market must be one of ${NEG_MARKETS.join('/')} or "all"`, code: 'market_invalid' }
    }
    const { getProtections } = await import('../services/advertising/negatives-protections.service.js')
    const out = await getProtections({
      market,
      line: q.line ?? null,
      portfolio: q.portfolio ?? null,
      campaign: q.campaign ?? null,
      adGroup: q.adGroup ?? null,
      window: q.window ? Number(q.window) : null,
    })
    reply.header('Cache-Control', 'private, max-age=60')
    return out
  })

  // ── NEG.5 — the review decision ─────────────────────────────────────
  //
  // The ONLY write this section owns, and it touches `AdNegativeReview` alone: no Amazon call, no
  // change to the whitelist, no change to the gate. Removal is NEG.3's path and stays there.
  //
  // Grain is (protected term × campaign) — deliberately NOT per negation row. See the model's own
  // comment: per-row marking would need 132 decisions and would re-alarm on every new negation of
  // the same term in the same campaign.
  //
  // RBAC: a POST/DELETE under /api/advertising requires `ads.campaigns.manage`, not `ads.view`.
  // That is the right authority for a decision that suppresses an alarm, and it is not widened.
  fastify.post('/advertising/negatives/review', async (request, reply) => {
    const b = (request.body ?? {}) as { protectedTerm?: unknown; campaignId?: unknown; reason?: unknown }
    const term = typeof b.protectedTerm === 'string' ? b.protectedTerm : ''
    const campaignId = typeof b.campaignId === 'string' ? b.campaignId : ''
    if (!term || !campaignId) {
      reply.status(400)
      return { error: 'protectedTerm and campaignId are both required', code: 'fields_required' }
    }
    const userId = (request as { authUser?: { id?: string } }).authUser?.id ?? 'anonymous'
    const { markReview } = await import('../services/advertising/negatives-protections.service.js')
    const out = await markReview({
      protectedTerm: term,
      campaignId,
      reason: typeof b.reason === 'string' && b.reason.trim() ? b.reason.trim().slice(0, 500) : null,
      reviewedBy: `user:${userId}`,
    })
    if (!out.ok) { reply.status(400); return out }
    reply.header('Cache-Control', 'no-store')
    return out
  })

  fastify.delete('/advertising/negatives/review', async (request, reply) => {
    const q = (request.query ?? {}) as Record<string, string | undefined>
    const term = (q.protectedTerm ?? '').trim()
    const campaignId = (q.campaignId ?? '').trim()
    if (!term || !campaignId) {
      reply.status(400)
      return { error: 'protectedTerm and campaignId are both required', code: 'fields_required' }
    }
    const { unmarkReview } = await import('../services/advertising/negatives-protections.service.js')
    const out = await unmarkReview(term, campaignId)
    reply.header('Cache-Control', 'no-store')
    return out
  })

  // ── NEG.6 — wasteful words: the n-grams, scoped and safe to act on ──
  //
  // The n-gram surface has worked since AX.11 and was orphaned on its own route with no scope and
  // no action. This adds both.
  //
  // 🔴 The row's `catches` is a CONTIGUOUS TOKEN match, not `NgramRow.terms`. The tokenizer strips
  // stop words before pairing, so `moto protezioni` reports 61 terms while only 13 queries contain
  // that phrase — a 4.7× overstatement on the exact number a confirm dialog would quote.
  fastify.get('/advertising/negatives/wasteful-words', async (request, reply) => {
    const q = (request.query ?? {}) as Record<string, string | undefined>
    const raw = (q.market ?? '').trim()
    const market = raw.toLowerCase() === NEG_MARKET_ALL || !raw ? NEG_MARKET_ALL : raw.toUpperCase()
    if (market !== NEG_MARKET_ALL && !NEG_MARKETS.includes(market as (typeof NEG_MARKETS)[number])) {
      reply.status(400)
      return { error: `market must be one of ${NEG_MARKETS.join('/')} or "all"`, code: 'market_invalid' }
    }
    const { getWastefulWords } = await import('../services/advertising/negatives-ngrams.service.js')
    const out = await getWastefulWords({
      market,
      line: q.line ?? null,
      portfolio: q.portfolio ?? null,
      campaign: q.campaign ?? null,
      adGroup: q.adGroup ?? null,
      window: q.window ? Number(q.window) : null,
    })
    reply.header('Cache-Control', 'private, max-age=120')
    return out
  })

  // ── NEG.6 — negate one gram as a negative phrase ────────────────────
  //
  // 🔴 THE ONLY CREATE PATH ON THIS PAGE, and one decision replaces up to 195 term-level ones.
  //
  // The service re-runs every safety rail server-side before writing. The UI disabling the button
  // is a courtesy; this is the enforcement — a stale page, a hand-made request, or a gram that
  // became unsafe between render and click all arrive here and are refused with the rail named.
  //
  // One gram per request. No bulk: `gram` is a string, not an array, and that is deliberate.
  //
  // RBAC: a POST under /api/advertising requires `ads.campaigns.manage`, not `ads.view`.
  fastify.post('/advertising/negatives/negate-gram', async (request, reply) => {
    const b = (request.body ?? {}) as Record<string, unknown>
    const gram = typeof b.gram === 'string' ? b.gram.trim() : ''
    if (!gram) { reply.status(400); return { error: 'gram is required', code: 'gram_required' } }
    if (b.confirm !== true) {
      reply.status(400)
      return { error: 'confirm:true is required — a negative phrase cannot be undone at Amazon, only archived', code: 'confirm_required' }
    }
    const rawMarket = typeof b.market === 'string' ? b.market.trim() : ''
    const market = rawMarket.toLowerCase() === NEG_MARKET_ALL || !rawMarket ? NEG_MARKET_ALL : rawMarket.toUpperCase()
    if (market !== NEG_MARKET_ALL && !NEG_MARKETS.includes(market as (typeof NEG_MARKETS)[number])) {
      reply.status(400)
      return { error: `market must be one of ${NEG_MARKETS.join('/')} or "all"`, code: 'market_invalid' }
    }
    const userId = (request as { authUser?: { id?: string } }).authUser?.id ?? 'anonymous'
    const { negateGram } = await import('../services/advertising/negatives-ngrams.service.js')
    const out = await negateGram({
      gram,
      market,
      line: typeof b.line === 'string' ? b.line : null,
      portfolio: typeof b.portfolio === 'string' ? b.portfolio : null,
      campaign: typeof b.campaign === 'string' ? b.campaign : null,
      adGroup: typeof b.adGroup === 'string' ? b.adGroup : null,
      window: typeof b.window === 'number' ? b.window : null,
      actor: `user:${userId}`,
    })
    // 🔴 Always 200 with per-ad-group outcomes when the write ran; a single status cannot carry
    // four outcome classes across 27 ad groups. A pre-write refusal is a 400 with its rail.
    if (!out.ok) reply.status(400)
    reply.header('Cache-Control', 'no-store')
    return out
  })

  // ── NEG.7 — the rules that can negate here, and whether AUTO is defensible ──
  //
  // 🔴 READ-ONLY, and deliberately so. No mode change, no enable/disable, no ceiling lift, no
  // scope write. Automations owns the dial; this page owns the CONSEQUENCES of the rules — what
  // one execution would create, where, and whether the preconditions for arming them hold.
  //
  // The blast radius is the number nobody has ever seen on a screen:
  // `sync_negatives_across_campaigns` writes one campaign-level negative per ENABLED campaign in a
  // marketplace, and its cap is 20/day.
  fastify.get('/advertising/negatives/rules', async (request, reply) => {
    const q = (request.query ?? {}) as Record<string, string | undefined>
    const raw = (q.market ?? '').trim()
    const market = raw.toLowerCase() === NEG_MARKET_ALL || !raw ? NEG_MARKET_ALL : raw.toUpperCase()
    if (market !== NEG_MARKET_ALL && !NEG_MARKETS.includes(market as (typeof NEG_MARKETS)[number])) {
      reply.status(400)
      return { error: `market must be one of ${NEG_MARKETS.join('/')} or "all"`, code: 'market_invalid' }
    }
    const { getNegRules } = await import('../services/advertising/negatives-rules.service.js')
    const out = await getNegRules({
      market,
      line: q.line ?? null,
      portfolio: q.portfolio ?? null,
      campaign: q.campaign ?? null,
      adGroup: q.adGroup ?? null,
    })
    reply.header('Cache-Control', 'private, max-age=60')
    return out
  })

  // ── NEG.8 — the record: what changed, what was refused ──────────────
  //
  // 🔴 The most valuable content on this page is the REFUSALS, and they have never been on a
  // screen: `protectConverting` refusals live inside `AutomationRuleExecution.actionResults` JSON
  // and carry the term, the order count and the sales. Five terms, €1,045.40 earned between them,
  // every one of which a rule tried to negate.
  fastify.get('/advertising/negatives/record', async (request, reply) => {
    const q = (request.query ?? {}) as Record<string, string | undefined>
    const raw = (q.market ?? '').trim()
    const market = raw.toLowerCase() === NEG_MARKET_ALL || !raw ? NEG_MARKET_ALL : raw.toUpperCase()
    if (market !== NEG_MARKET_ALL && !NEG_MARKETS.includes(market as (typeof NEG_MARKETS)[number])) {
      reply.status(400)
      return { error: `market must be one of ${NEG_MARKETS.join('/')} or "all"`, code: 'market_invalid' }
    }
    const { getNegRecord } = await import('../services/advertising/negatives-record.service.js')
    const out = await getNegRecord({
      market,
      line: q.line ?? null,
      portfolio: q.portfolio ?? null,
      campaign: q.campaign ?? null,
      adGroup: q.adGroup ?? null,
      window: q.window ? Number(q.window) : null,
    })
    reply.header('Cache-Control', 'private, max-age=60')
    return out
  })

  // ── NEG.8 — the one write on this section, and it is a preference ───
  //
  // Writes to `NotificationPreference` and nothing else. No ads write, no Amazon call. The model
  // already carries eventType / inApp / email / digestCadence, so this adds five event types to an
  // existing store rather than a second notification system.
  fastify.post('/advertising/negatives/alerts', async (request, reply) => {
    const b = (request.body ?? {}) as Record<string, unknown>
    const eventType = typeof b.eventType === 'string' ? b.eventType : ''
    if (!eventType) { reply.status(400); return { ok: false, error: 'eventType is required', code: 'event_required' } }
    const { setNegAlert } = await import('../services/advertising/negatives-record.service.js')
    const out = await setNegAlert({
      eventType: eventType as never,
      inApp: b.inApp !== false,
      email: b.email === true,
      cadence: typeof b.cadence === 'string' ? b.cadence : 'instant',
    })
    if (!out.ok) { reply.status(400); return { ...out, code: 'event_unknown' } }
    reply.header('Cache-Control', 'no-store')
    return out
  })

  // ── BID.S0 — the Bid page's one read ────────────────────────────────
  //
  // Here rather than in advertising.routes.ts for the reason KT.1 and NEG.1 are: a duplicate route
  // in that 600 KB file is a boot crash, not a warning, and it sees heavy concurrent edits.
  //
  // Not a variant of `GET /advertising/targets`: that route caps at 2,000 rows against 3,154
  // positive targets, has NO orderBy so the truncation is non-deterministic, filters by a single
  // campaignId and by nothing else — no market, portfolio, product line or status — and has no
  // aggregate for the campaign roll-up. See the service header.
  //
  // One call carries the resolved scope, the census over the FULL scope, facet counts that exclude
  // their own dimension, the rows, and the poll cursor — so the page can state what it is showing
  // without a second fetch, and no number it renders is computed from a page of rows.
  fastify.get('/advertising/bid-grid', async (request, reply) => {
    const q = (request.query ?? {}) as Record<string, string | undefined>
    const raw = (q.market ?? '').trim()
    const market = raw.toLowerCase() === BID_MARKET_ALL ? BID_MARKET_ALL : raw.toUpperCase()
    if (market !== BID_MARKET_ALL && !BID_MARKETS.includes(market as (typeof BID_MARKETS)[number])) {
      reply.status(400)
      return { error: `market is required and must be one of ${BID_MARKETS.join('/')} or "all"`, code: 'market_required' }
    }
    const oneOf = <T extends string>(v: string | undefined, allowed: readonly T[]): T | null =>
      (allowed as readonly string[]).includes(v ?? '') ? (v as T) : null
    // Multi-valued chips arrive comma-separated. Deliberately NOT validated against an enum: the
    // account holds 13 distinct expressionType values and 7 kinds, both sets grow when Amazon adds
    // a targeting form, and a hard-coded list would silently drop rows behind a filter that looks
    // complete. The service matches on equality, so an unknown value simply returns nothing.
    const list = (v: string | undefined): string[] =>
      (v ?? '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
    const windowDays = oneOf(q.window, ['7', '30', '60'] as const)
    const out = await getBidGrid({
      market,
      line: q.line || null,
      portfolio: q.portfolio || null,
      campaign: q.campaign || null,
      view: (oneOf(q.view, ['targets', 'campaigns'] as const) ?? 'targets') as BidView,
      status: (oneOf(q.status, ['enabled', 'paused', 'archived', 'all'] as const) ?? 'enabled') as BidStatusFilter,
      kind: list(q.kind),
      match: list(q.match),
      band: oneOf(q.band, BID_BANDS) as BidBand | null,
      measured: (oneOf(q.measured, ['yes', 'no', 'all'] as const) ?? 'all') as BidMeasured,
      q: q.q || null,
      windowDays: windowDays ? Number(windowDays) : 30,
      sort: q.sort || null,
      dir: q.dir === 'asc' ? 'asc' : 'desc',
      limit: Math.max(1, Math.min(5000, Number(q.limit ?? 5000))),
    })
    // Short private cache. The base is a full scan of the positive targets joined to the campaign
    // graph and one grouped read of the daily performance table.
    reply.header('Cache-Control', 'private, max-age=60')
    return out
  })

  // ── HV.1 — the Keyword Harvest page's one read ──────────────────────
  //
  // Here rather than in advertising.routes.ts for the reason KT.1, NEG.1 and BID.S0 are: that file
  // is ~600 KB, the default `grep` in this repo (ugrep) returns NOTHING on it so a duplicate is
  // easy to miss, and a duplicate route registration is a BOOT CRASH rather than a warning.
  //
  // One call carries the resolved scope, the census over the FULL candidate set, the facets and
  // the rows — so the page can state what it is showing without a second fetch, and no number it
  // renders is ever computed from a page of rows.
  //
  // Read-only, and it will stay read-only: HV.4 (promote) and HV.7 (queue) are POSTs of their own.
  fastify.get('/advertising/keyword-harvest', async (request, reply) => {
    const q = (request.query ?? {}) as Record<string, string | undefined>
    // `all` is accepted, as on Negative Targeting: a candidate count and a spend total both sum
    // honestly across markets, and every row carries its own market.
    // 🔴 HV.10 — `all`, a single code, or a COMMA LIST (`IT,DE`). The list is validated by
    // `parseMarketScope`, which drops unknown codes rather than erroring, so a stale link naming a
    // disconnected market narrows the view instead of 400-ing. A request that names ONLY unknown
    // codes is still a mistake worth reporting, so it is refused here rather than silently widened.
    const raw = (q.market ?? '').trim()
    const market = raw.toLowerCase() === HV_MARKET_ALL ? HV_MARKET_ALL : raw.toUpperCase()
    if (market !== HV_MARKET_ALL) {
      const named = market.split(',').map((c) => c.trim()).filter(Boolean)
      const known = named.filter((c) => HV_MARKETS.includes(c as (typeof HV_MARKETS)[number]))
      if (named.length === 0 || known.length === 0) {
        reply.status(400)
        return { error: `market is required and must be one of ${HV_MARKETS.join('/')}, a comma list of them, or "all"`, code: 'market_required' }
      }
    }
    const oneOf = <T extends string>(v: string | undefined, allowed: readonly T[]): T | null =>
      (allowed as readonly string[]).includes(v ?? '') ? (v as T) : null
    // 🔴 Not a truthiness test — see the note on minClicks below.
    const numOrNull = (v: string | undefined) => (v != null && v !== '' ? Number(v) : null)

    const out = await getKeywordHarvest({
      market,
      line: q.line ?? null,
      portfolio: q.portfolio ?? null,
      campaign: q.campaign ?? null,
      adGroup: q.adGroup ?? null,
      // HV.2 — the FILTER half. Absent means "use the policy in force for this scope", which the
      // service resolves; it never means a hard-coded default here.
      //
      // 🔴 `!= null && !== ''`, NOT a truthiness test. `minClicks=0` is a legitimate value that
      // says "no click floor for this view", and `q.minClicks ? …` would read it as absent and
      // silently hand back the policy's 3. Found on prod by checking that the count moved when
      // the param did: it did not, and `overridden` said `(none)` while the URL said otherwise.
      windowDays: numOrNull(q.window),
      minOrders: numOrNull(q.minOrders),
      minClicks: numOrNull(q.minClicks),
      // 'none' is a value, not an absence: it clears the ceiling for this view, and is the only
      // way a link can distinguish "no ceiling" from "whatever the policy says".
      maxAcosPct: q.maxAcos === 'none' ? 'none' : numOrNull(q.maxAcos),
      matched: oneOf(q.matched, ['all', 'harvestable'] as const),
      minSpendEur: numOrNull(q.minSpend),
      status: oneOf(q.status, ['new', 'already-exact-here', 'exact-elsewhere', 'local-only', 'all'] as const) as HvStatus | 'all' | null,
      kind: oneOf(q.kind, ['keyword', 'product', 'all'] as const) as HvKind | 'all' | null,
      // HV.3 — how the destination resolved, and the self-competition filter.
      dest: oneOf(q.dest, ['all', 'proposed', 'overridden', 'none'] as const),
      competing: q.competing === '1' ? true : null,
      q: q.q ?? null,
      sort: oneOf(q.sort, ['term', 'market', 'source', 'impressions', 'clicks', 'spend', 'orders', 'sales', 'acos', 'cpc', 'status', 'negated', 'kind'] as const) as HvSortKey | null,
      dir: q.dir === 'asc' ? 'asc' : 'desc',
    })
    // Short private cache. The base is a 60-day grouped scan of 10,826 search-term rows joined to
    // the full positive/negative target set, and it changes only when the five-minute export
    // ingest lands a new day.
    reply.header('Cache-Control', 'private, max-age=60')

    /**
     * HV.6 — the actors panel, computed ONLY when it is open.
     *
     * Additive on this route rather than a route of its own, deliberately. Registering a route is
     * the one operation in this repo that can crash the API on boot (a duplicate registration in a
     * 600 KB file the default grep cannot read), and this panel needs exactly one caller. Behind
     * `?actors=1` the grid pays nothing for it: absent, not one extra query runs.
     */
    if (q.actors === '1') {
      const { getHarvestActors } = await import('../services/advertising/harvest-actors.service.js')
      return { ...out, actors: await getHarvestActors({ market }) }
    }
    return out
  })

  /**
   * PLC-P1 — the Placement tab's one-line strip: what a placement rule can reach, and what
   * already rewrites those lanes.
   *
   * `grep -a`ed BOTH route files first (the ugrep-returns-nothing trap — a duplicate registration
   * is a boot crash, not a warning): `/advertising/placement-rules` appears in neither. It cannot
   * be swallowed by a `:param` route either — the only neighbours are `/advertising/placements`
   * and `/advertising/placements/:campaignId/lane`, a different first segment.
   *
   * No `Cache-Control`: the numbers this returns decide whether an operator arms a rule, and a
   * cached census is one that cannot notice the rank engine taking a campaign over.
   */
  fastify.get('/advertising/placement-rules/strip', async () => {
    const { getPlacementRulesStrip } = await import('../services/advertising/placement-grid.service.js')
    return getPlacementRulesStrip()
  })

  // ── PLC.0 — the Placement page's one read ───────────────────────────
  //
  // Here rather than in advertising.routes.ts for the reason KT.1, NEG.1, BID.S0 and HV.1 are:
  // that file is ~600 KB, the default `grep` in this repo (ugrep) returns NOTHING on it so a
  // duplicate is easy to miss, and a duplicate route registration is a BOOT CRASH, not a warning.
  // `grep -a`ed both files before adding this: `/advertising/placements` appears in neither, and
  // the two routes that look like it — `GET`/`PATCH /advertising/campaigns/:id/placements`
  // (`advertising.routes.ts:564`, `:635`) — are a different path and are left alone.
  //
  // Not a list-shaped variant of that per-campaign route either: its main `groupBy` carries **no
  // date filter at all**, so it returns LIFETIME totals for one campaign whose id you must already
  // know. This page's question is account-wide and windowed.
  //
  // One call carries the resolved scope, the counts over the FULL scope, the engine's own stamped
  // receipt and the rows — so the page can state what it is showing without a second fetch, and no
  // number it renders is ever computed from a page of rows.
  //
  // Read-only, and it stays read-only: the multiplier edit, the pin and the ledger are P1–P7,
  // each a write of its own.
  fastify.get('/advertising/placements', async (request, reply) => {
    const q = (request.query ?? {}) as Record<string, string | undefined>
    // `all` is accepted here and refused on the Keyword Tracker. Everything this page shows is
    // either a per-campaign fact (a campaign belongs to exactly one market) or a EUR amount, and
    // all four markets bill in EUR — so a merged view sums nothing dishonestly.
    const raw = (q.market ?? '').trim()
    const market = raw.toLowerCase() === PLC_MARKET_ALL ? PLC_MARKET_ALL : raw.toUpperCase()
    if (market !== PLC_MARKET_ALL && !PLC_MARKETS.includes(market as (typeof PLC_MARKETS)[number])) {
      reply.status(400)
      return { error: `market is required and must be one of ${PLC_MARKETS.join('/')} or "all"`, code: 'market_required' }
    }
    const oneOf = <T extends string>(v: string | undefined, allowed: readonly T[]): T | null =>
      (allowed as readonly string[]).includes(v ?? '') ? (v as T) : null

    const out = await getPlacementGrid({
      market,
      line: q.line || null,
      portfolio: q.portfolio || null,
      campaign: q.campaign || null,
      // Server date vocabulary only. A `DateRangePicker` key must never reach here — the two
      // vocabularies share `today` and `yesterday` and nothing else, so forwarding one hits
      // `resolveRange`'s `default:` branch and returns seven days under a "Last 30 days" label
      // (substrate spec §1.2.5). The client sends resolved dates for anything it picked.
      preset: q.preset || null,
      start: q.start || null,
      end: q.end || null,
      lane: (oneOf(q.lane, Object.keys(LANE_BY_KEY) as PlcLaneKey[]) ?? 'all') as PlcLaneKey | 'all',
      // PLC.1 — the flag filter narrows ROWS. It never narrows a count, exactly as `?q=` and
      // `?lane=` do not: the census answers "what is true in this scope", not "what am I looking at".
      flag: (oneOf(q.flag, PLC_FLAG_KEYS) ?? 'all') as PlcFlagKey | 'all',
      q: q.q || null,
      sort: oneOf(q.sort, PLC_SORT_KEYS) as PlcSortKey | null,
      dir: q.dir === 'asc' ? 'asc' : 'desc',
    })
    // Short private cache, as the neighbouring reads use. The base is 220 campaigns expanded to
    // 660 lane rows over one grouped scan of the placement report; the engine moves the lever
    // every 15 minutes and the report lands once a day.
    reply.header('Cache-Control', 'private, max-age=60')
    return out
  })

  // ── PLC.1 — the poll cursor ─────────────────────────────────────────────
  //
  // Three cheap aggregates, ~100 bytes, meant to be hit every 45 s by every open tab. The grid read
  // above is not. A separate endpoint rather than a `?cursorOnly=1` on it, so it cannot quietly
  // acquire the expensive parts of that handler later — BID.S0's reasoning, adopted whole.
  //
  // 🔴 It is NOT a copy of Bid's cursor, and `useCursorPoll`'s header names copying one as the sole
  // way to misuse the hook. Bid watches `AdTarget.updatedAt` because an hourly resync moves a bid
  // and writes no audit row; no `AdTarget` moves when a placement multiplier changes. This watches
  // `CampaignBidHistory` over the three lane fields — the one row-per-changed-lane record that both
  // the engine and the manual PATCH write through — plus the engine's held-target tally, because
  // the plan switching hour changes every governed campaign's multiplier and this page prints it.
  // See `PlcCursor` in the service for the measurement behind each field.
  //
  // Uncached on purpose: a cursor behind a 60 s cache is a cursor that lies for 60 s.
  fastify.get('/advertising/placements/cursor', async (request, reply) => {
    const q = (request.query ?? {}) as Record<string, string | undefined>
    const raw = (q.market ?? '').trim()
    const market = raw.toLowerCase() === PLC_MARKET_ALL ? PLC_MARKET_ALL : raw.toUpperCase()
    if (market !== PLC_MARKET_ALL && !PLC_MARKETS.includes(market as (typeof PLC_MARKETS)[number])) {
      reply.status(400)
      return { error: `market is required and must be one of ${PLC_MARKETS.join('/')} or "all"`, code: 'market_required' }
    }
    const out = await getPlacementCursorForRequest({
      market, line: q.line || null, portfolio: q.portfolio || null, campaign: q.campaign || null,
    })
    reply.header('Cache-Control', 'no-store')
    return out
  })

  // ── SOV.0 — the Share of Voice page's one read ──────────────────────
  //
  // Here rather than in advertising.routes.ts for the reason KT.1, NEG.1, BID.S0, HV.1 and PLC.0
  // are: that file is ~600 KB, the repo's default `grep` (ugrep) returns NOTHING on it so a
  // duplicate is easy to miss, and a duplicate route registration is a BOOT CRASH, not a warning.
  //
  // 🔴 The path is `share-of-voice-PAGE`, deliberately. `GET /advertising/share-of-voice` already
  // exists at `advertising.routes.ts:7284` and still serves the old tab and its CSV. That route is
  // NOT replaced here and NOT touched: `ads-impression-share.service.ts` behind it is imported by
  // `buildSovBidContexts`, so retiring it is SOV.7's problem, not SOV.0's. `grep -a`ed both files:
  // `share-of-voice-page` appears in neither.
  //
  // Nor is this a variant of that route. It reads a different table for a different quantity: the
  // old one divides a query's impressions by 498,606 `AmazonAdsSearchTerm` impressions against a
  // real campaign-grain total of 1,765,323 (28.2%), because Amazon's search-term report returns
  // only CLICKED queries and 76% of our impressions are on product detail pages. This one reads
  // `SearchQueryPerformance` — the whole market's counts against ours.
  //
  // One call carries the resolved scope, the chosen period and why, both feeds' freshness, the
  // census over the FULL filtered set and the facets — so the page can state what it is showing
  // without a second fetch, and no count it renders is ever computed from a page of rows.
  fastify.get('/advertising/share-of-voice-page', async (request, reply) => {
    const q = (request.query ?? {}) as Record<string, string | undefined>
    // 🔴 No `all`. Share is a per-market quantity — impression share, market volume and market rank
    // are all per-marketplace, and `veste moto homme` in FR is a different row from the same string
    // in DE. There is no honest way to add them, so this refuses rather than merges. Same answer as
    // the Keyword Tracker, and the opposite of Negatives/Harvest/Placement, where every number is a
    // count or a EUR amount and sums honestly.
    const market = (q.market ?? '').toUpperCase()
    if (!SOV_MARKETS.includes(market as (typeof SOV_MARKETS)[number])) {
      reply.status(400)
      return { error: `market is required and must be one of ${SOV_MARKETS.join('/')}`, code: 'market_required' }
    }
    const oneOf = <T extends string>(v: string | undefined, allowed: readonly T[]): T | null =>
      (allowed as readonly string[]).includes(v ?? '') ? (v as T) : null
    const weeks = Number(q.weeks)

    const out = await getShareOfVoice({
      market,
      line: q.line || null,
      portfolio: q.portfolio || null,
      campaign: q.campaign || null,
      // 'all' is the DEFAULT here and the list is a filter, not the population — the deliberate
      // inverse of the Keyword Tracker, which defaults to its list. A market view shows the market.
      list: q.list || null,
      // How far back the view may reach for its ONE period, in weeks. Not a trend window: SOV.0
      // renders one period, and this decides which. Measured: at 4, ES and FR have no complete week
      // inside the bound and both fall to the truncated-week branch.
      weeks: (SOV_WEEKS as readonly number[]).includes(weeks) ? weeks : null,
      // branded=1 includes our own brand terms; absent or 0 excludes them. The SOV study measured
      // 0.37% branded and recommended defaulting it ON; the Keyword Tracker measured `xavia` at
      // 5.45% against a market volume of 3 and defaults it off. KT is right — tiny volumes let
      // brand terms flatter the page — so both pages default it off.
      branded: q.branded === '1' || q.branded === 'true',
      // Honoured, but NOT rendered as a control: measured 2026-08-12, `SearchQueryPerformance` holds
      // 0 ASIN-shaped queries in all four markets, all-time. The 643 of 5,383 the study counts are
      // on the AD side (`AmazonAdsSearchTerm`), which this page does not read until SOV.2. A
      // control where no pixel moves does not go on the page (RA plan §3.0).
      kind: oneOf(q.kind, ['keyword', 'asin', 'all'] as const),
      q: q.q || null,
      // SOV.1 — `clickShare` and `delta` join the list. Both are share-shaped, so the service sinks
      // low-confidence rows below confident ones when either is the sort key: the top of a
      // share-descending page is otherwise `sappnetta knee spider nero`, 50.00% of FOUR market
      // impressions, followed by five typos.
      sort: oneOf(q.sort, ['query', 'volume', 'rank', 'share', 'clickShare', 'delta', 'asins', 'adSpend'] as const),
      dir: q.dir === 'asc' ? 'asc' : 'desc',
      limit: q.limit ? Number(q.limit) : undefined,
      offset: q.offset ? Number(q.offset) : undefined,
      // SOV.2/3/4 — the ad side's own window, the signal narrowing, and the unbid view.
      adWindow: q.adWindow ? Number(q.adWindow) : null,
      signal: q.signal || null,
      view: q.view || null,
      // SOV.6 — look at a week the gate declined, deliberately. Validated in the service against the
      // periods this market actually has; a malformed or unknown value yields the gate's own choice
      // plus a STATED refusal, never a silent fallback to a different week than the link names.
      period: q.period || null,
    })
    // Short private cache: one grouped scan of SQP joined to the campaign/ad graph, and both feeds
    // underneath move once a night at most.
    reply.header('Cache-Control', 'private, max-age=60')
    return out
  })

  /**
   * SOV.5 — the row drawer's read: one query in one market, through the page's scope. The weekly
   * series with the parser flag, cart-add/purchase share (drawer facts, not columns — 2.9% / 0.2%
   * row coverage), which ASIN holds the term, and the campaigns buying it (observed vs declared).
   */
  fastify.get('/advertising/share-of-voice-page/row', async (request, reply) => {
    const q = (request.query ?? {}) as Record<string, string | undefined>
    const market = (q.market ?? '').toUpperCase()
    if (!SOV_MARKETS.includes(market as (typeof SOV_MARKETS)[number])) {
      reply.status(400)
      return { error: `market is required and must be one of ${SOV_MARKETS.join('/')}`, code: 'market_required' }
    }
    if (!q.query?.trim()) { reply.status(400); return { error: 'query is required', code: 'query_required' } }
    const { getSovRowDetail } = await import('../services/advertising/share-of-voice.service.js')
    reply.header('Cache-Control', 'private, max-age=60')
    return getSovRowDetail({
      query: q.query, market,
      line: q.line || null, portfolio: q.portfolio || null, campaign: q.campaign || null,
    })
  })

  // ── HV.2 — the harvest policy ───────────────────────────────────────
  //
  // 🔴 The policy is NOT the filter. `GET /advertising/keyword-harvest` already returns the
  // criteria in force for a view, because the view composes a stored policy with whatever the URL
  // overrides. These three routes are about the STORED half only: what is saved, where, and by
  // whom. Keeping them separate is what stops a URL override from ever looking like a decision.
  fastify.get('/advertising/harvest-policy', async (request) => {
    const q = (request.query ?? {}) as Record<string, string | undefined>
    const raw = (q.market ?? '').trim()
    const market = raw.toLowerCase() === HV_MARKET_ALL ? HV_MARKET_ALL : (raw ? raw.toUpperCase() : HV_MARKET_ALL)
    const [resolved, all] = await Promise.all([
      resolveHarvestPolicy({ market, line: q.line ?? null, portfolio: q.portfolio ?? null, campaign: q.campaign ?? null, adGroup: q.adGroup ?? null }),
      listHarvestPolicies(),
    ])
    // Every policy that exists, not just the one in force: the save dialog has to be able to say
    // "you already have one at IT" before an operator creates a second at a narrower grain and
    // wonders why nothing changed.
    return { resolved, policies: all, defaults: HV_DEFAULT_CRITERIA }
  })

  fastify.put('/advertising/harvest-policy', async (request, reply) => {
    const b = (request.body ?? {}) as Record<string, unknown>
    const userId = (request as { authUser?: { id?: string } }).authUser?.id ?? 'anonymous'
    try {
      const saved = await saveHarvestPolicy({
        scopeGrain: String(b.scopeGrain ?? '') as HvPolicyGrain,
        scopeId: b.scopeId == null ? null : String(b.scopeId),
        criteria: {
          minOrders: Number(b.minOrders),
          minClicks: Number(b.minClicks),
          maxAcosPct: b.maxAcosPct == null || b.maxAcosPct === '' ? null : Number(b.maxAcosPct),
          windowDays: Number(b.windowDays),
          excludeExactMatched: b.excludeExactMatched !== false,
        },
        updatedBy: `user:${userId}`,
      })
      return { ok: true, saved }
    } catch (e) {
      const err = e as { code?: string; message?: string }
      reply.status(400)
      return { ok: false, error: err.message ?? 'could not save the policy', code: err.code ?? 'bad_request' }
    }
  })

  // Removing an override is how a scope goes back to inheriting. Without it a saved policy would
  // be permanent, which is the "cannot be undone" class of control this section keeps deleting.
  fastify.delete('/advertising/harvest-policy', async (request, reply) => {
    const q = (request.query ?? {}) as Record<string, string | undefined>
    try {
      const out = await deleteHarvestPolicy(String(q.scopeGrain ?? '') as HvPolicyGrain, q.scopeId ?? null)
      return { ok: true, ...out }
    } catch (e) {
      const err = e as { code?: string; message?: string }
      reply.status(err.code === 'not_found' ? 404 : 400)
      return { ok: false, error: err.message ?? 'could not remove the policy', code: err.code ?? 'bad_request' }
    }
  })

  // ── HV.3 — the harvest destination ──────────────────────────────────
  //
  // 🔴 These three are the STORED override only. `GET /advertising/keyword-harvest` already returns
  // the resolved destination on every row, because the destination is what decides whether the H.3
  // isolation negative fires — it is a property of a candidate, not a separate lookup.
  //
  // Nothing here reaches Amazon. HV.4 owns the write.
  fastify.get('/advertising/harvest-destination', async (request) => {
    const q = (request.query ?? {}) as Record<string, string | undefined>
    const raw = (q.market ?? '').trim()
    const market = raw.toLowerCase() === HV_MARKET_ALL ? HV_MARKET_ALL : (raw ? raw.toUpperCase() : HV_MARKET_ALL)
    const scope = { market, line: q.line ?? null, portfolio: q.portfolio ?? null, campaign: q.campaign ?? null, adGroup: q.adGroup ?? null }
    const [stored, all] = await Promise.all([resolveStoredDestinations(scope), listHarvestDestinations()])

    // The picker's options for ONE source ad group. Supplied on demand rather than on every row of
    // the grid: the shortlist is 5-21 ad groups per row and 8 rows of it is a payload nobody reads.
    let shortlist: ReturnType<typeof rankDestinations> = []
    if (q.sourceAdGroupId) {
      const graph = await loadDestinationGraph()
      const createType = (HV_CREATE_TYPES as string[]).includes(q.matchType ?? '') ? (q.matchType as HvCreateType) : 'EXACT'
      shortlist = rankDestinations(graph, q.sourceAdGroupId, createType, q.term ?? '', q.kind === 'product' ? 'product' : 'keyword')
    }
    return { resolved: Object.fromEntries(stored), destinations: all, shortlist }
  })

  fastify.put('/advertising/harvest-destination', async (request, reply) => {
    const b = (request.body ?? {}) as Record<string, unknown>
    const userId = (request as { authUser?: { id?: string } }).authUser?.id ?? 'anonymous'
    try {
      const saved = await saveHarvestDestination({
        scopeGrain: String(b.scopeGrain ?? '') as HvDestGrain,
        scopeId: b.scopeId == null ? null : String(b.scopeId),
        matchType: String(b.matchType ?? 'EXACT') as HvCreateType,
        adGroupId: String(b.adGroupId ?? ''),
        negateAtSource: b.negateAtSource !== false,
        updatedBy: `user:${userId}`,
      })
      return { ok: true, saved }
    } catch (e) {
      const err = e as { code?: string; message?: string }
      reply.status(400)
      return { ok: false, error: err.message ?? 'could not save the destination', code: err.code ?? 'bad_request' }
    }
  })

  fastify.delete('/advertising/harvest-destination', async (request, reply) => {
    const q = (request.query ?? {}) as Record<string, string | undefined>
    try {
      const out = await deleteHarvestDestination(
        String(q.scopeGrain ?? '') as HvDestGrain,
        q.scopeId ?? null,
        String(q.matchType ?? 'EXACT') as HvCreateType,
      )
      return { ok: true, ...out }
    } catch (e) {
      const err = e as { code?: string; message?: string }
      reply.status(err.code === 'not_found' ? 404 : 400)
      return { ok: false, error: err.message ?? 'could not remove the destination', code: err.code ?? 'bad_request' }
    }
  })

  // ── HV.4 — the paired write ─────────────────────────────────────────
  //
  // 🔴 The first route on this page that spends money. GET plans it (nothing is written); POST
  // executes exactly that plan. They share `planPromotion`, so the sentence the dialog states and
  // the number written cannot diverge.
  //
  // This arms no automation. Harvest rules are capped at PROPOSE by `ads-graduation.ts`
  // (the ads-auto-harvest cron itself was retired in HP5, 2026-08-21) — that caps AUTOMATIONS;
  // an operator pressing a button is a different actor.
  fastify.get('/advertising/harvest-promote', async (request, reply) => {
    const q = (request.query ?? {}) as Record<string, string | undefined>
    const raw = (q.market ?? '').trim()
    const market = raw.toLowerCase() === HV_MARKET_ALL ? HV_MARKET_ALL : (raw ? raw.toUpperCase() : HV_MARKET_ALL)
    // Repeated `?ids=` params, not a delimited string: a candidate id is
    // `market|campaign|adGroup|term` and a search term may itself contain a comma or a pipe.
    const rawIds = (request.query as { ids?: string | string[] }).ids
    const ids = (Array.isArray(rawIds) ? rawIds : rawIds ? [rawIds] : []).filter(Boolean)
    if (ids.length === 0) { reply.status(400); return { error: 'ids is required', code: 'ids_required' } }
    if (ids.length > 200) { reply.status(400); return { error: `${ids.length} candidates in one request; the cap is 200`, code: 'too_many' } }
    return planPromotion({ market, candidateIds: ids, line: q.line ?? null, portfolio: q.portfolio ?? null, campaign: q.campaign ?? null, adGroup: q.adGroup ?? null })
  })

  fastify.post('/advertising/harvest-promote', async (request, reply) => {
    const b = (request.body ?? {}) as Record<string, unknown>
    const ids = Array.isArray(b.ids) ? b.ids.map(String).filter(Boolean) : []
    if (ids.length === 0) { reply.status(400); return { ok: false, error: 'ids is required', code: 'ids_required' } }
    if (ids.length > 200) { reply.status(400); return { ok: false, error: `${ids.length} candidates in one request; the cap is 200. This is a request bound, not a spend ceiling.`, code: 'too_many' } }
    // Structural writes that create a keyword AND a negative on Amazon. An explicit confirm is
    // required, in the body, so a stray POST cannot spend money.
    if (b.confirm !== true) { reply.status(400); return { ok: false, error: 'confirm:true is required — this creates keywords and negatives on Amazon', code: 'confirm_required' } }
    const raw = String(b.market ?? '').trim()
    const market = raw.toLowerCase() === HV_MARKET_ALL ? HV_MARKET_ALL : (raw ? raw.toUpperCase() : HV_MARKET_ALL)
    const userId = (request as { authUser?: { id?: string } }).authUser?.id ?? 'anonymous'
    const out = await promoteCandidates({
      market, candidateIds: ids, userId,
      line: (b.line as string) ?? null, portfolio: (b.portfolio as string) ?? null,
      campaign: (b.campaign as string) ?? null, adGroup: (b.adGroup as string) ?? null,
    })
    // 🔴 Always 200 with per-row outcomes, never a single pass/fail. N writes have N independent
    // failure modes and an HTTP status cannot carry three outcome classes (C7).
    return { ok: true, ...out }
  })

  // ── HV.5 — the harvested cohort ─────────────────────────────────────
  //
  // "Did the last batch work?" — the second half of the page's question. Read-only.
  /**
   * HV-R P3a — GET /advertising/harvest-pathways
   *
   * Every ad group that can SOURCE a harvest and every one that can RECEIVE it, so the Keyword
   * Harvest tab's Ad Group View can answer *"which of my ad groups is harvesting, and which is
   * not?"*. It previously derived its rows from `actions[0].mappings`, which only a BUILDER rule
   * writes — and all five harvest rules here are ENGINE rules with none, so the view rendered 0
   * rows and always would have.
   *
   * Read-only. No assignment is invented: an ad group with no rule attached is reported as exactly
   * that, and P3b adds the binding that changes it.
   */
  fastify.get('/advertising/harvest-pathways', async (_request, reply) => {
    const { listHarvestPathways } = await import('../services/advertising/harvest-pathways.service.js')
    const out = await listHarvestPathways()
    reply.header('Cache-Control', 'private, max-age=120')
    return out
  })

  fastify.get('/advertising/harvest-cohort', async (request, reply) => {
    const q = (request.query ?? {}) as Record<string, string | undefined>
    const raw = (q.market ?? '').trim()
    const market = raw.toLowerCase() === HV_MARKET_ALL ? HV_MARKET_ALL : (raw ? raw.toUpperCase() : HV_MARKET_ALL)
    if (market !== HV_MARKET_ALL && !HV_MARKETS.includes(market as (typeof HV_MARKETS)[number])) {
      reply.status(400)
      return { error: `market must be one of ${HV_MARKETS.join('/')} or "all"`, code: 'market_required' }
    }
    const oneOf = <T extends string>(v: string | undefined, allowed: readonly T[]): T | null =>
      (allowed as readonly string[]).includes(v ?? '') ? (v as T) : null
    const out = await getHarvestCohort({
      market,
      outcome: oneOf(q.outcome, ['served', 'never-served', 'not-measured', 'local-only', 'all'] as const) as never,
      actor: oneOf(q.actor, ['engine', 'operator', 'app-bulk', 'mirrored', 'all'] as const) as never,
      since: q.since ?? null,
      q: q.q ?? null,
    })
    reply.header('Cache-Control', 'private, max-age=60')
    return out
  })

  // 🔴 Pushes keywords that exist HERE and never reached Amazon. This SPENDS MONEY — a pushed
  // keyword starts bidding. Same shape as HV.4's promote: confirm in the body, 200 with per-row
  // outcomes, never a single pass/fail (C7).
  fastify.post('/advertising/harvest-push', async (request, reply) => {
    const b = (request.body ?? {}) as Record<string, unknown>
    const ids = Array.isArray(b.ids) ? b.ids.map(String).filter(Boolean) : []
    if (ids.length === 0) { reply.status(400); return { ok: false, error: 'ids is required', code: 'ids_required' } }
    if (ids.length > 200) { reply.status(400); return { ok: false, error: `${ids.length} keywords in one request; the cap is 200. This is a request bound, not a spend ceiling.`, code: 'too_many' } }
    if (b.confirm !== true) { reply.status(400); return { ok: false, error: 'confirm:true is required — pushing a keyword makes it start bidding at Amazon', code: 'confirm_required' } }
    const userId = (request as { authUser?: { id?: string } }).authUser?.id ?? 'anonymous'
    const { pushExistingKeyword } = await import('../services/advertising/ads-create.service.js')
    const outcomes: Array<{ adTargetId: string } & Awaited<ReturnType<typeof pushExistingKeyword>>> = []
    for (const id of ids) outcomes.push({ adTargetId: id, ...(await pushExistingKeyword({ adTargetId: id, userId: `user:${userId}` })) })
    return {
      ok: true,
      acted: outcomes.filter((o) => o.outcome === 'acted').length,
      refused: outcomes.filter((o) => o.outcome === 'refused').length,
      failed: outcomes.filter((o) => o.outcome === 'failed').length,
      outcomes,
    }
  })

  // ── PLC.3 — what a scope-bulk write WOULD do ────────────────────────
  //
  // Read-only. No bulk write may commit without this, because the page already knows four things
  // the operator cannot see on the grid: which campaigns an engine overwrites within fifteen
  // minutes, which are pinned, which have the write gate shut, and which are already at the value.
  //
  // Deliberately NOT filtered by `?q=` — the search narrows what you are looking at, not what you
  // are acting on, and a bulk that quietly followed a half-typed search term is the worst possible
  // reading of the defect PLC.0 already fixed on the counts.
  fastify.get('/advertising/placements/preview', async (request, reply) => {
    const q = (request.query ?? {}) as Record<string, string | undefined>
    const raw = (q.market ?? '').trim()
    const market = raw.toLowerCase() === PLC_MARKET_ALL ? PLC_MARKET_ALL : raw.toUpperCase()
    if (market !== PLC_MARKET_ALL && !PLC_MARKETS.includes(market as (typeof PLC_MARKETS)[number])) {
      reply.status(400)
      return { error: `market is required and must be one of ${PLC_MARKETS.join('/')} or "all"`, code: 'market_required' }
    }
    const lane = (Object.keys(LANE_BY_KEY) as PlcLaneKey[]).includes(q.lane as PlcLaneKey) ? (q.lane as PlcLaneKey) : null
    if (!lane) { reply.status(400); return { error: 'lane must be one of top/rest/product', code: 'lane_required' } }
    const pct = Number(q.pct)
    if (!Number.isFinite(pct)) { reply.status(400); return { error: 'pct must be a number 0-900', code: 'pct_required' } }
    // `inverted` is the one flag a preview cannot honour: it needs the window's per-lane ROAS, and
    // this endpoint is scope-shaped rather than window-shaped. Refused by name rather than silently
    // widened to every campaign, which would apply a bulk to 220 campaigns instead of 9.
    const flag = (PLC_FLAG_KEYS as readonly string[]).includes(q.flag ?? '') ? (q.flag as PlcFlagKey) : 'all'
    if (flag === 'inverted') {
      reply.status(400)
      return { error: 'a bulk cannot be scoped to “inverted”: the verdict depends on the date window, so select those campaigns individually', code: 'flag_not_bulkable' }
    }
    const out = await previewPlacementBulk({
      market,
      line: q.line || null,
      portfolio: q.portfolio || null,
      campaign: q.campaign || null,
      lane,
      pct,
      flag,
      status: q.status === 'all' ? 'all' : 'enabled',
    })
    reply.header('Cache-Control', 'no-store')
    return out
  })

  // ── PLC.3 — the one manual placement write ──────────────────────────
  //
  // 🔴 It takes ONE lane and merges server-side. That is the whole point.
  //
  // `updatePlacementBidding` writes `placementBidding` WHOLESALE (`ads-create.service.ts:972`), so
  // a caller sending only the lane it changed leaves the other two absent — and absent is 0 to
  // Amazon. A one-lane payload is therefore a silent two-lane erase, and the obvious client is the
  // one that writes it. Accepting a lane rather than an array makes that shape unreachable from
  // this route: `buildManualAdjustments` (unit-tested, 12 cases) always emits all three.
  //
  // `PATCH /advertising/campaigns/:id/placements` keeps its `adjustments[]` contract untouched for
  // the callers that already send a full profile.
  fastify.patch('/advertising/placements/:campaignId/lane', async (request, reply) => {
    const { campaignId } = request.params as { campaignId: string }
    const b = (request.body ?? {}) as { lane?: string; percentage?: number; reason?: string }
    const lane = (Object.keys(LANE_BY_KEY) as PlcLaneKey[]).includes(b.lane as PlcLaneKey) ? LANE_BY_KEY[b.lane as PlcLaneKey] : null
    if (!lane) { reply.status(400); return { error: 'lane must be one of top/rest/product', code: 'lane_required' } }
    if (!Number.isFinite(Number(b.percentage))) { reply.status(400); return { error: 'percentage must be a number 0-900', code: 'percentage_required' } }

    const c = await prisma.campaign.findUnique({ where: { id: campaignId }, select: { dynamicBidding: true } })
    if (!c) { reply.status(404); return { error: 'campaign not found' } }
    const existing = ((c.dynamicBidding as { placementBidding?: Array<{ placement: string; percentage: number }> })?.placementBidding) ?? []
    const adjustments = buildManualAdjustments(existing, lane as ManagedPlacement, Number(b.percentage))

    const { updatePlacementBidding } = await import('../services/advertising/ads-create.service.js')
    try {
      // The result now carries `reason` + `deniedAt` on a refusal (PLC.3, ads-create.service.ts),
      // so the UI can print the gate's own sentence instead of "HTTP 200".
      //
      // Actor from `authUser`, this file's own convention (NEG.3 `:527`), not the `x-actor-id`
      // header sniff `advertising.routes.ts:120` uses — that helper is module-private there, and
      // real auth beats a header a client sets for itself.
      //
      // The ads read cache is flushed by this plugin's own `onResponse` hook (`:58`), which fires
      // on any non-GET under `/advertising/` that returns < 400. Verified rather than assumed:
      // `GET /advertising/campaigns` sits behind `cached(key, 300)` and feeds the Ad Manager and
      // the Control Room, so without a flush a multiplier this route changed would read five
      // minutes stale on both.
      return await updatePlacementBidding({
        campaignId,
        adjustments,
        actor: `user:${(request as { authUser?: { id?: string } }).authUser?.id ?? 'anonymous'}` as never,
        reason: typeof b.reason === 'string' && b.reason.trim() ? b.reason.trim() : undefined,
      })
    } catch (e) { reply.status(500); return { error: (e as Error)?.message } }
  })

  // ── BID.S0 — the poll cursor ────────────────────────────────────────
  //
  // Three cheap aggregates, ~100 bytes, meant to be hit every 45 s by every open tab. The grid read
  // is not. Separate endpoint rather than a `?cursorOnly=1` on the one above so it cannot
  // accidentally acquire the expensive parts of that handler later.
  //
  // 🔴 It reports `AdTarget.updatedAt`, not just the audit log, because the hourly inbound resync
  // moves the bid and writes no audit row — measured 1h53m of drift between the two on 2026-08-12.
  // See the service header. Not SSE: that bus carries 0.21% of writes.
  fastify.get('/advertising/bid-grid/cursor', async (request, reply) => {
    const q = (request.query ?? {}) as Record<string, string | undefined>
    const raw = (q.market ?? '').trim()
    const market = raw.toLowerCase() === BID_MARKET_ALL ? BID_MARKET_ALL : raw.toUpperCase()
    if (market !== BID_MARKET_ALL && !BID_MARKETS.includes(market as (typeof BID_MARKETS)[number])) {
      reply.status(400)
      return { error: `market is required and must be one of ${BID_MARKETS.join('/')} or "all"`, code: 'market_required' }
    }
    const out = await getBidCursorForRequest({
      market, line: q.line || null, portfolio: q.portfolio || null, campaign: q.campaign || null,
    })
    // No cache at all: a cached cursor is a cursor that cannot detect a change, which is its only job.
    reply.header('Cache-Control', 'no-store')
    return out
  })

  // ── BUD.1 — the Budget Rules page's one read ────────────────────────
  //
  // Here rather than in advertising.routes.ts for the reason KT.1, NEG.1, HV.1, BID.S0 and SOV.0
  // are: that file is ~600 KB, the default `grep` in this repo (ugrep) returns NOTHING on it so a
  // duplicate is easy to miss, and a duplicate route registration is a BOOT CRASH, not a warning.
  // `grep -a` for `budget-grid` across both route files returned nothing before this was added.
  //
  // One call carries the resolved scope, the census over the FULL scope, the facets, the rows and
  // the poll cursor — so the page can state what it is showing without a second fetch, and no
  // number it renders is ever computed from a page of rows.
  //
  // 🔴 Read-only, and it will stay read-only. BUD.1 shows the ratchet; it does not stop it. The
  // guardrails that stop it are BUD.2 and they are POSTs of their own.
  /**
   * BUD-P4 — the Budget tab's one-line strip. `grep -a`ed every routes file first:
   * `/advertising/budget-rules/strip` appears nowhere else, and no `:param` route sits above
   * `/advertising/budget-rules` that could swallow it (a duplicate route is a boot crash).
   */
  /**
   * BUD-PP — preview a DRAFT budget rule: what it would do to which campaigns, right now.
   *
   * POST because the draft is a whole rule payload and must not sit in a URL. Nothing is written
   * and nothing is stored; the handler runs with `dryRun`. `grep -a`ed first —
   * `/advertising/automation-rules/preview` appears nowhere else, and it is registered BEFORE any
   * `/advertising/automation-rules/:id` POST could shadow it (there is none today, but the static
   * path must win if one is ever added).
   */
  fastify.post('/advertising/automation-rules/preview', async (request, reply) => {
    const body = (request.body ?? {}) as { actions?: unknown; conditions?: unknown; scopeMarketplace?: string | null }
    /**
     * SOV-P2 — dispatched on the draft's OWN slug (`actions[0].type`, the type a stored rule
     * carries), so the dispatch key is the rule's identity rather than a second contract.
     *
     * 🔴 PLC-P2's placement branch is below. It was dropped by a bad hunk-filter in `e1e78d6d9`,
     * which shipped `previewPlacementRule` with NO caller — a placement draft fell through to
     * `previewBudgetRule` and came back `not_a_budget_draft`. Caught by the SOV session reading
     * the committed route rather than the working tree, which is the only place the gap was
     * visible: it is a missing BRANCH, so nothing in tsc or the test suite could see it.
     */
    const slug = String((Array.isArray(body.actions) ? (body.actions[0] as { type?: unknown })?.type : '') ?? '')
    const svc = await import('../services/advertising/ads-rule-preview.service.js')
    if (slug === 'placement') {
      const out = await svc.previewPlacementRule(body)
      if (!out.ok) reply.code(400)
      return out
    }
    // BID-P — the fifth and last consumer. Bid was the only slug still computing its preview in
    // the browser; with this branch every draft preview on every tab runs the real engine.
    if (slug === 'bid') {
      const out = await svc.previewBidRule(body)
      if (!out.ok) reply.code(400)
      return out
    }
    if (slug === 'sov') {
      const { previewSovRule } = await import('../services/advertising/ads-sov-preview.service.js')
      const out = await previewSovRule(body)
      if (!out.ok) reply.code(400)
      return out
    }
    /**
     * KT-P2 — the Keyword Tracker branch, and the only one that must also report the state of its
     * FEED. A rank rule matching nothing has two completely different causes — "no keyword met your
     * criteria" and "no rank has ever been ingested" — and today it is always the second, so the
     * result carries `feed` alongside the census and the surface can tell them apart.
     */
    if (slug === 'keyword-tracker') {
      const out = await svc.previewKeywordTrackerRule(body)
      if (!out.ok) reply.code(400)
      return out
    }
    const out = await svc.previewBudgetRule(body)
    if (!out.ok) reply.code(400)
    return out
  })

  /**
   * KT-P1 — the rank feed's own census, read before any draft exists.
   *
   * The Keyword Tracker tab and its builder both have to state whether a rank rule can do anything
   * at all, and that is a property of `KeywordRank`, not of a draft. Served here rather than as a
   * field on the rules list so the builder can ask for it with nothing filled in yet.
   *
   * `grep -a`ed for collisions: `/advertising/keyword-tracker` and `/advertising/keyword-tracker/term`
   * are the only neighbours and both are static, so no `:param` route can shadow this one.
   */
  fastify.get('/advertising/keyword-tracker/feed-health', async (_request, reply) => {
    const { keywordRankFeedHealth } = await import('../services/advertising/ads-rule-preview.service.js')
    reply.header('Cache-Control', 'private, max-age=60')
    return keywordRankFeedHealth()
  })

  // SOV-P3 — the Share of Voice tab's one-line census, from the same call the engine makes.
  fastify.get('/advertising/sov/strip', async () => {
    const { getSovStrip } = await import('../services/advertising/ads-sov-keyword-share.service.js')
    return getSovStrip()
  })

  fastify.get('/advertising/budget-rules/strip', async () => {
    const { getBudgetRulesStrip } = await import('../services/advertising/budget-grid.service.js')
    return getBudgetRulesStrip()
  })

  fastify.get('/advertising/budget-grid', async (request, reply) => {
    const q = (request.query ?? {}) as Record<string, string | undefined>
    // `all` is accepted and is the page default: a budget total and a floor count both sum honestly
    // across markets, and every row carries its own market.
    const raw = (q.market ?? '').trim()
    const market = raw.toLowerCase() === BUD_MARKET_ALL ? BUD_MARKET_ALL : raw.toUpperCase()
    if (market !== BUD_MARKET_ALL && !BUD_MARKETS.includes(market as (typeof BUD_MARKETS)[number])) {
      reply.status(400)
      return { error: `market is required and must be one of ${BUD_MARKETS.join('/')} or "all"`, code: 'market_required' }
    }
    const oneOf = <T extends string>(v: string | undefined, allowed: readonly T[]): T | null =>
      (allowed as readonly string[]).includes(v ?? '') ? (v as T) : null
    const windowDays = oneOf(q.window, ['7', '30', '60'] as const)

    // portfolio ⇄ campaign exclusivity (campaign wins) is enforced inside the service's
    // `resolveScope`, which the cursor endpoint below also calls — so the two cannot resolve
    // different scopes from the same query string. Passed through raw here on purpose.
    const out = await getBudgetGrid({
      market,
      product: q.product || null,
      portfolio: q.portfolio || null,
      campaign: q.campaign || null,
      view: (oneOf(q.view, ['campaigns', 'rules'] as const) ?? 'campaigns') as BudView,
      status: (oneOf(q.status, ['enabled', 'paused', 'archived', 'all'] as const) ?? 'enabled') as BudStatusFilter,
      state: oneOf(q.state, BUD_STATES) as BudState | null,
      q: q.q || null,
      windowDays: windowDays ? Number(windowDays) : 7,
      sort: q.sort || null,
      dir: q.dir === 'asc' ? 'asc' : 'desc',
      limit: Math.max(1, Math.min(5000, Number(q.limit ?? 5000))),
    })
    // Short private cache. The base is a scan of the campaign graph joined to the budget audit log
    // and one grouped read of the daily performance table.
    reply.header('Cache-Control', 'private, max-age=60')
    return out
  })

  // ── BUD.1 — the poll cursor ─────────────────────────────────────────
  //
  // 🔴 It does NOT report `Campaign.updatedAt`, and that is the whole design. Measured 2026-08-12:
  // that column moved in 7 distinct minutes in 24 hours (219 rows, one burst of 200 from the
  // campaign-settings resync) against 6 AD_BUDGET_UPDATE writes in 48 hours — so a cursor built on
  // it would raise the "changed" banner more often wrongly than rightly, which is how an operator
  // learns to ignore it. There is no `budgetUpdatedAt` column, so the fingerprint is the VALUE:
  // Σ Campaign.dailyBudget over the scope. See the service header.
  //
  // Takes `view` because the two views render different numbers: a rules-view cursor watching the
  // budget sum would never move, and a campaigns-view cursor watching executions would move every
  // 15 minutes over numbers that view does not show. Same `view` on both sides ⇒ identical key sets
  // ⇒ `useCursorPoll`'s structural equality works with no change to the shared hook.
  //
  // Separate endpoint rather than a `?cursorOnly=1` on the read above, so it cannot accidentally
  // acquire that handler's expensive parts later. Not SSE: that bus carries 0.21% of writes and is
  // blind to `budget-manager-cron`, which made 1,164 of the 2,386 budget changes.
  fastify.get('/advertising/budget-grid/cursor', async (request, reply) => {
    const q = (request.query ?? {}) as Record<string, string | undefined>
    const raw = (q.market ?? '').trim()
    const market = raw.toLowerCase() === BUD_MARKET_ALL ? BUD_MARKET_ALL : raw.toUpperCase()
    if (market !== BUD_MARKET_ALL && !BUD_MARKETS.includes(market as (typeof BUD_MARKETS)[number])) {
      reply.status(400)
      return { error: `market is required and must be one of ${BUD_MARKETS.join('/')} or "all"`, code: 'market_required' }
    }
    const oneOf = <T extends string>(v: string | undefined, allowed: readonly T[]): T | null =>
      (allowed as readonly string[]).includes(v ?? '') ? (v as T) : null
    // 🔴 `status` is forwarded, and it must be. The grid defaults to ENABLED (86 campaigns,
    // €318.57/day); without this the cursor summed all 220 (€8,768.57) and would have gone stale on
    // a PAUSED campaign moving. A cursor describing a different row set from the page is a banner
    // that fires for changes you cannot see.
    const out = await getBudgetCursorForRequest({
      market,
      product: q.product || null,
      // portfolio ⇄ campaign exclusivity is enforced in the service, in the one function the grid
      // and the cursor share, so the two cannot resolve different scopes from the same query string.
      portfolio: q.portfolio || null,
      campaign: q.campaign || null,
      view: (q.view === 'rules' ? 'rules' : 'campaigns') as BudView,
      status: (oneOf(q.status, ['enabled', 'paused', 'archived', 'all'] as const) ?? 'enabled') as BudStatusFilter,
    })
    // No cache at all: a cached cursor is a cursor that cannot detect a change, which is its only job.
    reply.header('Cache-Control', 'no-store')
    return out
  })

  /**
   * KT.4 — one watched term: its weekly series, our ASINs competing for it, the campaigns bidding it.
   *
   * A distinct path segment under the KT.1 route, so 401-vs-404 still proves deployment: no
   * `:param` route can match `/advertising/keyword-tracker/term` (verified — it 404s before deploy).
   */
  fastify.get('/advertising/keyword-tracker/term', async (request, reply) => {
    const q = (request.query ?? {}) as Record<string, string | undefined>
    const market = (q.market ?? '').toUpperCase()
    if (!KT_MARKETS.includes(market as (typeof KT_MARKETS)[number])) {
      reply.status(400); return { error: `market must be one of ${KT_MARKETS.join('/')}`, code: 'market_required' }
    }
    if (!q.kw?.trim()) { reply.status(400); return { error: 'kw is required', code: 'kw_required' } }
    const { getKeywordTerm } = await import('../services/advertising/keyword-term.service.js')
    const out = await getKeywordTerm({
      market, keyword: q.kw,
      line: q.line ?? null, portfolio: q.portfolio ?? null, campaign: q.campaign ?? null,
    })
    reply.header('Cache-Control', 'private, max-age=60')
    return out
  })

  // ── KT.2 — the Keyword Tracker's watchlists, per market ─────────────
  //
  // 🔴 These endpoints never touch `KeywordCoverageSet`/`KeywordCoverageTerm` except to READ a set
  // as an import source. That table is the ACR coverage engine's arming switch: the engine is
  // scheduled daily at 07:10, has run six nights (mode=observe, sets=0), and at
  // NEXUS_COVERAGE_ENGINE_MODE=auto it steps the bids of an ENABLED set's terms through
  // `updateAdTargetWithSync` — a real write to Amazon. `ads-coverage-sets.service.ts` stays the
  // only writer of those tables, and no route here exposes `enabled`.
  //
  // Reads map to ads.view and writes to ads.campaigns.manage through the generic /api/advertising
  // rules in permissions-manifest.ts — no new permission, and verified by the RBAC coverage gate.

  /** Every watchlist (optionally one market's), plus the coverage sets offered as import sources. */
  fastify.get('/advertising/keyword-watchlists', async (request, reply) => {
    const q = (request.query ?? {}) as { market?: string }
    const market = q.market ? q.market.toUpperCase() : null
    const { listWatchlists, coverageSetsAsImportSources } = await import('../services/advertising/keyword-watchlist.service.js')
    const [items, importSources] = await Promise.all([
      listWatchlists(market),
      coverageSetsAsImportSources(market),
    ])
    reply.header('Cache-Control', 'no-store')
    return { items, importSources }
  })

  /** One watchlist's terms, for the editor. */
  fastify.get('/advertising/keyword-watchlists/:id/terms', async (request, reply) => {
    const { id } = request.params as { id: string }
    const { watchlistTerms } = await import('../services/advertising/keyword-watchlist.service.js')
    reply.header('Cache-Control', 'no-store')
    return { items: await watchlistTerms(id) }
  })

  fastify.post('/advertising/keyword-watchlists', async (request, reply) => {
    const b = (request.body ?? {}) as { market?: string; name?: string; source?: string; isDefault?: boolean }
    const market = (b.market ?? '').toUpperCase()
    if (!KT_MARKETS.includes(market as (typeof KT_MARKETS)[number])) {
      reply.status(400); return { error: `market must be one of ${KT_MARKETS.join('/')}`, code: 'market_required' }
    }
    if (!b.name?.trim()) { reply.status(400); return { error: 'name is required', code: 'name_required' } }
    const { createWatchlist } = await import('../services/advertising/keyword-watchlist.service.js')
    try {
      return { ok: true, watchlist: await createWatchlist({ marketplace: market, name: b.name, source: b.source, isDefault: b.isDefault }) }
    } catch (e) {
      // (marketplace, name) is unique — a duplicate is an operator mistake, not a 500.
      reply.status(409); return { ok: false, error: `A list called "${b.name.trim()}" already exists in ${market}.`, code: 'duplicate_name', detail: (e as Error).message }
    }
  })

  /** Rename, or make this market's default. */
  fastify.patch('/advertising/keyword-watchlists/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const b = (request.body ?? {}) as { name?: string; isDefault?: boolean }
    const { renameWatchlist, setDefaultWatchlist } = await import('../services/advertising/keyword-watchlist.service.js')
    try {
      if (b.name?.trim()) await renameWatchlist(id, b.name)
      if (b.isDefault === true) await setDefaultWatchlist(id)
      return { ok: true }
    } catch (e) {
      reply.status(400); return { ok: false, error: (e as Error).message }
    }
  })

  /** Delete a list and every term on it. The response says what went, so the UI can too. */
  fastify.delete('/advertising/keyword-watchlists/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const { deleteWatchlist } = await import('../services/advertising/keyword-watchlist.service.js')
    try {
      return { ok: true, deleted: await deleteWatchlist(id) }
    } catch (e) {
      reply.status(404); return { ok: false, error: (e as Error).message }
    }
  })

  /** Paste a list of terms. Normalised, deduped against the list, branded-classified on insert. */
  fastify.post('/advertising/keyword-watchlists/:id/terms', async (request, reply) => {
    const { id } = request.params as { id: string }
    const b = (request.body ?? {}) as { terms?: string[] | string; addedFrom?: string }
    const terms = Array.isArray(b.terms) ? b.terms : typeof b.terms === 'string' ? [b.terms] : []
    if (!terms.length) { reply.status(400); return { ok: false, error: 'terms is required', code: 'terms_required' } }
    const { addTerms } = await import('../services/advertising/keyword-watchlist.service.js')
    try {
      return { ok: true, result: await addTerms({ watchlistId: id, terms, addedFrom: b.addedFrom ?? 'manual' }) }
    } catch (e) {
      reply.status(404); return { ok: false, error: (e as Error).message }
    }
  })

  /** Remove terms by id. DELETE with a body, because the ids are a set, not a path segment. */
  fastify.delete('/advertising/keyword-watchlists/:id/terms', async (request, reply) => {
    const { id } = request.params as { id: string }
    const b = (request.body ?? {}) as { termIds?: string[] }
    const ids = Array.isArray(b.termIds) ? b.termIds : []
    if (!ids.length) { reply.status(400); return { ok: false, error: 'termIds is required', code: 'term_ids_required' } }
    const { removeTerms } = await import('../services/advertising/keyword-watchlist.service.js')
    return { ok: true, ...(await removeTerms(id, ids)) }
  })

  /** Flip one term's branded flag — the operator owns the classification once it is stored. */
  fastify.patch('/advertising/keyword-watchlists/:id/terms/:termId', async (request, reply) => {
    const { id, termId } = request.params as { id: string; termId: string }
    const b = (request.body ?? {}) as { isBranded?: boolean }
    if (typeof b.isBranded !== 'boolean') { reply.status(400); return { ok: false, error: 'isBranded must be a boolean' } }
    const { setTermBranded } = await import('../services/advertising/keyword-watchlist.service.js')
    await setTermBranded(id, termId, b.isBranded)
    return { ok: true }
  })

  /** COPY a coverage set's terms in. Copy, never reference — see the block comment above. */
  fastify.post('/advertising/keyword-watchlists/:id/import', async (request, reply) => {
    const { id } = request.params as { id: string }
    const b = (request.body ?? {}) as { coverageSetId?: string }
    if (!b.coverageSetId) { reply.status(400); return { ok: false, error: 'coverageSetId is required' } }
    const { importFromCoverageSet } = await import('../services/advertising/keyword-watchlist.service.js')
    try {
      return { ok: true, result: await importFromCoverageSet({ watchlistId: id, coverageSetId: b.coverageSetId }) }
    } catch (e) {
      reply.status(404); return { ok: false, error: (e as Error).message }
    }
  })

  // ── Data Kiosk economics (Phase 2) ─────────────────────────────────
  // Per-SKU-day net proceeds after fees and ad spend, from SP-API Data Kiosk.

  fastify.get('/advertising/economics', async (request) => {
    const q = (request.query ?? {}) as { marketplace?: string; asin?: string; msku?: string; limit?: string }
    const take = Math.min(1000, Math.max(1, Number(q.limit) || 200))
    const rows = await prisma.amazonEconomicsDaily.findMany({
      where: {
        ...(q.marketplace ? { marketplace: q.marketplace } : {}),
        ...(q.asin ? { childAsin: q.asin } : {}),
        ...(q.msku ? { msku: q.msku } : {}),
      },
      orderBy: [{ date: 'desc' }, { childAsin: 'asc' }],
      take,
    })
    return { items: rows, count: rows.length }
  })

  // Job queue state — economics queries can run 10+ minutes, so surfacing the
  // in-flight jobs is how an operator tells "slow" from "stuck".
  fastify.get('/advertising/economics/jobs', async () => {
    const jobs = await prisma.dataKioskQueryJob.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true, queryType: true, marketplaceId: true, startDate: true, endDate: true,
        externalQueryId: true, status: true, rowsIngested: true, attempts: true,
        errorMessage: true, lastPolledAt: true, completedAt: true, createdAt: true,
      },
    })
    return { items: jobs, count: jobs.length }
  })

  // Manual trigger: create the query only. Deliberately NOT awaiting
  // completion — the poll cron picks it up, because these queries routinely
  // outlive an HTTP request.
  fastify.post('/advertising/economics/create', async (request, reply) => {
    const b = (request.body ?? {}) as { startDate?: string; endDate?: string; marketplaceIds?: string[] }
    const endDate = b.endDate ?? new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10)
    const startDate = b.startDate ?? new Date(Date.now() - 9 * 86400000).toISOString().slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
      reply.status(400); return { error: 'startDate/endDate must be YYYY-MM-DD' }
    }
    const { runEconomicsCreateCycle } = await import('../services/amazon/data-kiosk.service.js')
    const out = await runEconomicsCreateCycle({ startDate, endDate, marketplaceIds: b.marketplaceIds })
    return { startDate, endDate, ...out, note: 'poll cron ingests on completion; economics queries can take 10+ minutes' }
  })

  fastify.post('/advertising/economics/poll', async () => {
    const { runDataKioskPollCycle } = await import('../services/amazon/data-kiosk.service.js')
    return runDataKioskPollCycle()
  })

  // ── Brand Metrics (Phase 1) ────────────────────────────────────────
  // Brand funnel vs CATEGORY benchmarks. Weekly grain — Amazon ignores
  // aggregationLevel and always returns lookbackPeriod="1w".

  fastify.get('/advertising/brand-metrics', async (request) => {
    const q = (request.query ?? {}) as { marketplace?: string; limit?: string }
    const take = Math.min(500, Math.max(1, Number(q.limit) || 200))
    const rows = await prisma.amazonAdsBrandBuildingMetric.findMany({
      where: q.marketplace ? { marketplace: q.marketplace } : undefined,
      orderBy: [{ computationDate: 'desc' }, { brandName: 'asc' }],
      take,
    })
    return { items: rows, count: rows.length }
  })

  // Diagnostic: the last Brand Metrics report's real shape. Amazon extends the
  // metric set over time and every value arrives as a string, so this is how a
  // contract drift gets caught without Railway log access.
  fastify.get('/advertising/brand-metrics/debug', async (_request, reply) => {
    const { brandMetricsDebugState } = await import('../services/advertising/ads-brand-metrics.service.js')
    reply.header('Cache-Control', 'no-store')
    return brandMetricsDebugState.last ?? { note: 'no Brand Metrics report ingested yet this process' }
  })

  fastify.post('/advertising/brand-metrics/probe', async (request) => {
    const b = (request.body ?? {}) as { profileId?: string }
    const { probeBrandMetricsAccess } = await import('../services/advertising/ads-brand-metrics.service.js')
    return probeBrandMetricsAccess(b.profileId)
  })

  // Manual trigger. Runs create → poll → ingest inline because the signed
  // download URL is only valid for 300s; splitting the stages would guarantee
  // an expired link. Awaited (not fire-and-forget) since the whole cycle is
  // seconds, unlike the per-ASIN SQP reports below.
  fastify.post('/advertising/brand-metrics/ingest', async (request, reply) => {
    const b = (request.body ?? {}) as { startDate?: string; endDate?: string }
    const endDate = b.endDate ?? new Date(Date.now() - 9 * 86400000).toISOString().slice(0, 10)
    const startDate = b.startDate ?? new Date(Date.now() - 44 * 86400000).toISOString().slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
      reply.status(400); return { error: 'startDate/endDate must be YYYY-MM-DD' }
    }
    const { runBrandMetricsCycle, runBrandMetricsIngestCycle } =
      await import('../services/advertising/ads-brand-metrics.service.js')
    const created = await runBrandMetricsCycle({ startDate, endDate })
    await new Promise((r) => setTimeout(r, 20_000))
    const out = await runBrandMetricsIngestCycle()
    return { startDate, endDate, created, ingested: out.ingested, errors: [...created.errors, ...out.errors] }
  })

  // Probe whether the account has Brand Analytics SQP access (resolves the
  // gating dependency without committing to ingestion).
  fastify.post('/advertising/sqp/probe', async (request, reply) => {
    const b = (request.body ?? {}) as { marketplace?: string; period?: string }
    if (!b.marketplace) { reply.status(400); return { error: 'marketplace required' } }
    const { probeSqpAccess } = await import('../services/advertising/sqp.service.js')
    return probeSqpAccess(b.marketplace, (b.period as 'WEEK' | 'MONTH' | 'QUARTER') ?? 'WEEK')
  })

  // Manual SQP ingest trigger. FIRE-AND-FORGET: SP-API reports take minutes to
  // generate (per ASIN), so we can't make the caller wait — kick it off in the
  // background and return immediately. Poll GET /search-query-performance for
  // results (or check the sqp-ingest cron run). `limit` bounds the ASIN batch.
  fastify.post('/advertising/sqp/ingest', async (request, reply) => {
    const b = (request.body ?? {}) as { marketplace?: string; period?: string; limit?: number; asins?: string[] }
    if (!b.marketplace) { reply.status(400); return { error: 'marketplace required' } }
    const { ingestSqp } = await import('../services/advertising/sqp.service.js')
    void ingestSqp({ marketplaceCode: b.marketplace, period: (b.period as 'WEEK' | 'MONTH' | 'QUARTER') ?? 'WEEK', limit: b.limit, asins: b.asins })
      .then((r) => fastify.log.info({ sqp: r }, '[sqp] manual ingest complete'))
      .catch((e) => fastify.log.error({ err: e }, '[sqp] manual ingest failed'))
    reply.header('Cache-Control', 'no-store')
    return { ok: true, started: true, marketplace: b.marketplace, note: 'ingest running in background; poll GET /advertising/search-query-performance for results' }
  })

  // ── RM4 — AMS (Amazon Marketing Stream) subscription management. Creating the hourly perf-dataset
  // subscriptions (sp-traffic + sp-conversion) is what makes Amazon push hourly data → SQS →
  // AmazonAdsHourlyPerformance → the rank loss-proxy + intraday spend circuit-breaker. Until a
  // subscription exists, hourlyRows stays 0 and those signals are inert. ──────────────────────────
  const amsRegionFor = (m?: string | null): 'NA' | 'EU' | 'FE' =>
    !m ? 'EU' : ['US', 'CA', 'MX', 'BR'].includes(m) ? 'NA' : ['JP', 'AU', 'SG', 'IN'].includes(m) ? 'FE' : 'EU'

  fastify.get('/advertising/ams/status', async (_request, reply) => {
    const { amsStatus } = await import('../services/advertising/ads-marketing-stream.service.js')
    reply.header('Cache-Control', 'no-store')
    return amsStatus()
  })

  fastify.get('/advertising/ams/subscriptions', async (request, reply) => {
    const q = (request.query ?? {}) as { marketplace?: string }
    const { listAmsSubscriptions } = await import('../services/advertising/ads-marketing-stream.service.js')
    const conns = await prisma.amazonAdsConnection.findMany({ where: { isActive: true, ...(q.marketplace ? { marketplace: q.marketplace } : {}) }, select: { marketplace: true, profileId: true } })
    const out: Record<string, unknown> = {}
    for (const c of conns) { try { out[c.marketplace] = await listAmsSubscriptions(c.profileId, amsRegionFor(c.marketplace)) } catch (e) { out[c.marketplace] = { error: (e as Error).message } } }
    return out
  })

  // Create the sp-traffic + sp-conversion subscriptions for active production connections.
  // Idempotent — lists first + skips datasets already subscribed. Hourly data then flows over the
  // next hour(s) as Amazon delivers it to the SQS queue the poller already drains.
  fastify.post('/advertising/ams/subscribe', async (request, reply) => {
    const b = (request.body ?? {}) as { marketplace?: string }
    const { createAmsSubscription, listAmsSubscriptions, AMS_DATASETS } = await import('../services/advertising/ads-marketing-stream.service.js')
    const conns = await prisma.amazonAdsConnection.findMany({ where: { isActive: true, mode: 'production', ...(b.marketplace ? { marketplace: b.marketplace } : {}) }, select: { marketplace: true, profileId: true } })
    if (!conns.length) { reply.status(400); return { error: `no active production AmazonAdsConnection${b.marketplace ? ` for ${b.marketplace}` : ''}` } }
    const results: Array<{ marketplace: string; dataSetId: string; status: string; detail?: string }> = []
    for (const c of conns) {
      const region = amsRegionFor(c.marketplace)
      let have = new Set<string>()
      try { const ls = (await listAmsSubscriptions(c.profileId, region)) as { subscriptions?: Array<{ dataSetId?: string }> }; have = new Set((ls?.subscriptions ?? []).map((s) => s.dataSetId ?? '')) } catch { /* list best-effort */ }
      for (const ds of AMS_DATASETS) {
        if (have.has(ds)) { results.push({ marketplace: c.marketplace, dataSetId: ds, status: 'already_subscribed' }); continue }
        try { await createAmsSubscription({ profileId: c.profileId, region, dataSetId: ds }); results.push({ marketplace: c.marketplace, dataSetId: ds, status: 'created' }) }
        catch (e) { results.push({ marketplace: c.marketplace, dataSetId: ds, status: 'error', detail: (e as Error).message }) }
      }
    }
    return { results }
  })

  // Fleet view — every advertised product's target ACOS, revenue-ranked.
  fastify.get('/advertising/target-acos/fleet', async (request, reply) => {
    const q = request.query as { marketplace?: string; windowDays?: string; mode?: string }
    const items = await computeFleetTargetAcos({
      marketplace: q.marketplace ?? null,
      windowDays: q.windowDays ? Number(q.windowDays) : undefined,
      mode: (q.mode as AcosMode) ?? undefined,
    })
    reply.header('Cache-Control', 'private, max-age=120')
    return { items, count: items.length }
  })

  // ── DP.1 — Orders-sourced dayparting demand heatmap ──────────────────────
  // Weekday × hour (Europe/Rome) demand grid from Order ⨝ OrderItem, filterable
  // by channel/market/product/sku and any date range. The real hour-of-day
  // signal (the ad hourly stream is dormant) — drives the rebuilt Dayparting tab.
  fastify.get('/advertising/orders-dayparting', async (request, reply) => {
    const q = request.query as {
      channel?: string; marketplace?: string; productId?: string; sku?: string
      from?: string; to?: string; windowDays?: string; metric?: string
    }
    const { aggregateOrdersDayparting } = await import('../services/advertising/orders-dayparting.service.js')
    const windowDays = q.windowDays ? Math.max(7, Math.min(365, Number(q.windowDays))) : undefined
    const result = await aggregateOrdersDayparting({
      channel: q.channel || 'AMAZON',
      marketplace: q.marketplace ? q.marketplace.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
      productId: q.productId || undefined,
      sku: q.sku || undefined,
      from: q.from ? new Date(q.from) : undefined,
      to: q.to ? new Date(q.to) : undefined,
      windowDays,
      metric: q.metric === 'orders' || q.metric === 'units' ? q.metric : 'revenue',
    })
    reply.header('Cache-Control', 'private, max-age=300')
    return result
  })

  // ── DP.2 — Amazon ad-spend-by-hour overlay ───────────────────────────────
  // Reuses analyzeDayparting() (single source of truth for "is the hourly ad
  // stream live"). Returns hasData:false + a connect-stream note until Amazon
  // Marketing Stream is provisioned (true on prod today). When AMS lands, switch
  // this to the CD.12 Rome-recast raw query for TZ-correct heatmap alignment.
  fastify.get('/advertising/orders-dayparting/ad-overlay', async (request, reply) => {
    const q = request.query as { windowDays?: string; campaignId?: string }
    const { analyzeDayparting } = await import('../services/advertising/ads-dayparting-intel.service.js')
    const intel = await analyzeDayparting({
      windowDays: q.windowDays ? Math.max(7, Math.min(365, Number(q.windowDays))) : 60,
      campaignId: q.campaignId || undefined,
    })
    reply.header('Cache-Control', 'private, max-age=300')
    return {
      hasData: intel.hourlyAvailable,
      hours: intel.hours.map((h) => ({ hour: h.hour, costCents: h.costCents, salesCents: h.salesCents, orders: h.orders, acos: h.acos })),
      note: intel.hourlyAvailable ? null : 'Connect Amazon Marketing Stream for an hourly ad-spend overlay.',
    }
  })
  // NB: GET /advertising/dayparting-intel already exists in advertising.routes.ts
  // (returns the same analyzeDayparting() full intel) — the cockpit "When" panel
  // (RC2.T1) consumes that one. Do NOT re-declare it here: a duplicate Fastify
  // route is a BOOT CRASH, not a 4xx.

  // RPT.2 — live coverage behind the Reporting library: per report, how much data
  // we hold and how stale each MARKET is. Read-only grouped aggregates; the GET
  // falls under the /api/advertising read rule, so it already requires ads.view.
  fastify.get('/advertising/reporting/coverage', async (_request, reply) => {
    const { getReportingCoverage } = await import('../services/advertising/ads-reporting-coverage.service.js')
    const coverage = await getReportingCoverage()
    // Short cache: the underlying feeds move at most hourly, and this page is a
    // landing surface people bounce through.
    reply.header('Cache-Control', 'private, max-age=120')
    return coverage
  })

  // RPT.3 — run a report. GET, not POST, and deliberately so: the RBAC manifest
  // maps reads under /api/advertising to ads.view, while a POST there would
  // demand ads.campaigns.manage. Running a report is a read.
  fastify.get('/advertising/reporting/run', async (request, reply) => {
    const q = request.query as Record<string, string | undefined>
    const list = (v?: string) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : [])
    const { runReport, ReportError } = await import('../services/advertising/ads-report-runner.service.js')
    try {
      const result = await runReport({
        reportId: String(q.reportId ?? ''),
        from: q.from ?? null,
        to: q.to ?? null,
        marketplaces: list(q.marketplaces),
        adProducts: list(q.adProducts),
        search: q.search ?? null,
        groupBy: list(q.groupBy),
        columns: list(q.columns),
        sort: q.sortCol ? { col: q.sortCol, dir: q.sortDir === 'asc' ? 'asc' : 'desc' } : null,
        page: q.page ? Number(q.page) : 1,
        pageSize: q.pageSize ? Number(q.pageSize) : 50,
      })
      reply.header('Cache-Control', 'private, max-age=60')
      return result
    } catch (err) {
      if (err instanceof ReportError) {
        reply.code(err.status)
        return { error: err.message }
      }
      throw err
    }
  })

  // RPT.11 — TACoS, the ad-vs-organic split and wasted spend. Read-only.
  fastify.get('/advertising/reporting/business-context', async (request, reply) => {
    const q = request.query as Record<string, string | undefined>
    const { businessContext } = await import('../services/advertising/ads-business-context.service.js')
    const to = q.to ?? new Date().toISOString().slice(0, 10)
    const from = q.from ?? (() => { const d = new Date(`${to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - 29); return d.toISOString().slice(0, 10) })()
    reply.header('Cache-Control', 'private, max-age=300')
    return businessContext({
      from, to,
      minClicks: q.minClicks ? Number(q.minClicks) : undefined,
      // RPX — the Business tab reads one market at a time, because TACoS blended across
      // markets hides exactly the market that moved.
      marketplaces: q.marketplaces ? q.marketplaces.split(',').map((m) => m.trim()).filter(Boolean) : [],
    })
  })

  // RPX.1 — the Brand tab. One market, ONE category node: Amazon returns the same brand-week at
  // several tree depths and summing them overstated every count by about three times.
  fastify.get('/advertising/reporting/brand', async (request, reply) => {
    const q = request.query as Record<string, string | undefined>
    const { brandStrategy } = await import('../services/advertising/ads-brand-strategy.service.js')
    const market = (q.marketplace ?? '').trim().toUpperCase()
    reply.header('Cache-Control', 'private, max-age=300')
    return brandStrategy({
      // 'ALL' and an empty value both mean the ratio view; a bad code is not silently a market.
      marketplace: market && market !== 'ALL' && /^[A-Z]{2,12}$/.test(market) ? market : null,
      node: q.node ?? null,
      weeks: q.weeks ? Number(q.weeks) : undefined,
    })
  })

  // GX.2 — one level of the drill-down tree. Children of a node, over the caller's filters.
  // Lazy by design: a tree that fetched everything would be the search-terms report's 12,443 rows
  // in a browser, and expanding is a query rather than a slice.
  fastify.get('/advertising/reporting/hierarchy', async (request, reply) => {
    const q = request.query as Record<string, string | undefined>
    const { hierarchyChildren, HierarchyError } = await import('../services/advertising/ads-hierarchy.service.js')
    const level = (q.level ?? 'root') as 'root' | 'market' | 'portfolio' | 'campaign'
    if (!['root', 'market', 'portfolio', 'campaign'].includes(level)) {
      reply.code(400); return { error: 'level must be root | market | portfolio | campaign' }
    }
    const to = q.to ?? new Date().toISOString().slice(0, 10)
    const from = q.from ?? (() => { const d = new Date(`${to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - 29); return d.toISOString().slice(0, 10) })()
    try {
      reply.header('Cache-Control', 'private, max-age=60')
      return await hierarchyChildren({
        level,
        parentId: q.parentId ?? null,
        from, to,
        decompose: q.decompose === 'target' ? 'target' : 'product',
        marketplaces: q.marketplaces ? q.marketplaces.split(',').map((m) => m.trim()).filter(Boolean) : [],
      })
    } catch (err) {
      if (err instanceof HierarchyError) { reply.code(err.status); return { error: err.message } }
      throw err
    }
  })

  // RPX.3 — the Market share tab: our slice of the whole market from Search Query Performance.
  fastify.get('/advertising/reporting/market-share', async (request, reply) => {
    const q = request.query as Record<string, string | undefined>
    const { marketShare } = await import('../services/advertising/ads-market-share.service.js')
    const market = (q.marketplace ?? 'IT').trim().toUpperCase()
    if (!/^[A-Z]{2,12}$/.test(market)) {
      reply.code(400)
      return { error: 'marketplace must be a country code' }
    }
    reply.header('Cache-Control', 'private, max-age=300')
    return marketShare({
      marketplace: market,
      weeks: q.weeks ? Number(q.weeks) : undefined,
      queryLimit: q.queryLimit ? Number(q.queryLimit) : undefined,
    })
  })

  // RPT.10 — KPI totals, period comparison and the trend series for a report.
  // Separate from /run so the grid stays fast and the chart loads alongside it.
  fastify.get('/advertising/reporting/summary', async (request, reply) => {
    const q = request.query as Record<string, string | undefined>
    const list = (v?: string) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : [])
    const { reportSummary } = await import('../services/advertising/ads-report-summary.service.js')
    const { ReportError } = await import('../services/advertising/ads-report-runner.service.js')
    try {
      const out = await reportSummary({
        reportId: String(q.reportId ?? ''),
        from: q.from ?? null, to: q.to ?? null,
        marketplaces: list(q.marketplaces), adProducts: list(q.adProducts),
        search: q.search ?? null, groupBy: list(q.groupBy), columns: list(q.columns),
        sort: null, page: 1,
        compare: (q.compare === 'none' || q.compare === 'yoy' ? q.compare : 'previous'),
        metrics: list(q.metrics),
      })
      reply.header('Cache-Control', 'private, max-age=60')
      return out
    } catch (err) {
      if (err instanceof ReportError) { reply.code(err.status); return { error: err.message } }
      throw err
    }
  })

  // ── RPT.5 — saved report definitions ────────────────────────────────────
  // All methods here map to ads.view (see permissions-manifest): a saved report
  // is a named query over data the caller can already read.
  fastify.get('/advertising/reporting/saved', async (request, reply) => {
    const q = request.query as { reportId?: string }
    const { listSavedReports } = await import('../services/advertising/ads-saved-reports.service.js')
    reply.header('Cache-Control', 'no-store')
    return { items: await listSavedReports(q.reportId) }
  })

  fastify.get('/advertising/reporting/saved/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const svc = await import('../services/advertising/ads-saved-reports.service.js')
    try {
      return await svc.getSavedReport(id)
    } catch (err) {
      if (err instanceof svc.SavedReportError) { reply.code(err.status); return { error: err.message } }
      throw err
    }
  })

  fastify.get('/advertising/reporting/saved/:id/versions', async (request, reply) => {
    const { id } = request.params as { id: string }
    const svc = await import('../services/advertising/ads-saved-reports.service.js')
    try {
      return { items: await svc.listVersions(id) }
    } catch (err) {
      if (err instanceof svc.SavedReportError) { reply.code(err.status); return { error: err.message } }
      throw err
    }
  })

  fastify.post('/advertising/reporting/saved', async (request, reply) => {
    const body = request.body as { name?: string; description?: string; query?: Record<string, unknown> }
    const svc = await import('../services/advertising/ads-saved-reports.service.js')
    try {
      const created = await svc.createSavedReport({
        name: String(body?.name ?? ''),
        description: body?.description ?? null,
        query: (body?.query ?? {}) as never,
      })
      reply.code(201)
      return created
    } catch (err) {
      if (err instanceof svc.SavedReportError) { reply.code(err.status); return { error: err.message } }
      throw err
    }
  })

  fastify.patch('/advertising/reporting/saved/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = request.body as { name?: string; description?: string; query?: Record<string, unknown> }
    const svc = await import('../services/advertising/ads-saved-reports.service.js')
    try {
      return await svc.updateSavedReport(id, {
        name: body?.name,
        description: body?.description,
        query: body?.query as never,
      })
    } catch (err) {
      if (err instanceof svc.SavedReportError) { reply.code(err.status); return { error: err.message } }
      throw err
    }
  })

  fastify.post('/advertising/reporting/saved/:id/restore', async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = request.body as { version?: number }
    const svc = await import('../services/advertising/ads-saved-reports.service.js')
    try {
      return await svc.restoreVersion(id, Number(body?.version))
    } catch (err) {
      if (err instanceof svc.SavedReportError) { reply.code(err.status); return { error: err.message } }
      throw err
    }
  })

  fastify.delete('/advertising/reporting/saved/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const svc = await import('../services/advertising/ads-saved-reports.service.js')
    try {
      await svc.archiveSavedReport(id)
      return { ok: true }
    } catch (err) {
      if (err instanceof svc.SavedReportError) { reply.code(err.status); return { error: err.message } }
      throw err
    }
  })

  // ── RPT.12 — operator-defined metrics ───────────────────────────────────
  // Under the same ads.view prefix rule: a custom metric is a formula over data
  // the caller can already read, and touches nothing on the account.
  // ── RPT.15 share links ──────────────────────────────────────────────
  // Three authenticated routes for managing links, and ONE public route that
  // resolves a token. The public route is the only unauthenticated way into the
  // reporting engine, so it takes nothing from the caller but the token itself —
  // the query it runs was frozen when the link was minted.

  fastify.get('/advertising/reporting/shares', async (_request, reply) => {
    const { listShareLinks } = await import('../services/advertising/ads-report-shares.service.js')
    reply.header('Cache-Control', 'no-store')
    return { items: await listShareLinks() }
  })

  fastify.post('/advertising/reporting/shares', async (request, reply) => {
    const body = request.body as { reportId?: string; query?: Record<string, unknown>; label?: string; ttlDays?: number }
    const svc = await import('../services/advertising/ads-report-shares.service.js')
    if (!body?.reportId || !body?.query) {
      return reply.code(400).send({ error: 'reportId and query are required' })
    }
    try {
      const out = await svc.createShareLink({
        reportId: body.reportId,
        query: body.query as never,
        label: body.label ?? null,
        ttlDays: body.ttlDays,
      })
      reply.header('Cache-Control', 'no-store')
      // The token is shown once and is unrecoverable afterwards — it is not stored.
      return { ...out, note: 'Copy this link now. Only a hash is stored, so it cannot be shown again.' }
    } catch (e) {
      const err = e as { status?: number; message?: string }
      return reply.code(err.status ?? 400).send({ error: err.message ?? 'Could not create the link' })
    }
  })

  fastify.delete('/advertising/reporting/shares/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const svc = await import('../services/advertising/ads-report-shares.service.js')
    try {
      return { link: await svc.revokeShareLink(id) }
    } catch (e) {
      const err = e as { status?: number; message?: string }
      return reply.code(err.status ?? 400).send({ error: err.message ?? 'Could not revoke the link' })
    }
  })

  // PUBLIC — see permissions-manifest. Unauthenticated by design.
  fastify.get('/advertising/reporting/public/share/:token', async (request, reply) => {
    const { token } = request.params as { token: string }
    const svc = await import('../services/advertising/ads-report-shares.service.js')
    try {
      const out = await svc.resolveShareLink(token)
      // Never cached: revocation must take effect on the very next request, and
      // a shared report must not linger in an intermediary.
      reply.header('Cache-Control', 'no-store, private')
      reply.header('X-Robots-Tag', 'noindex, nofollow')
      return out
    } catch (e) {
      const err = e as { status?: number; message?: string }
      // Same response for missing, expired and revoked — see the service.
      return reply.code(err.status ?? 404).send({ error: err.message ?? 'This link is not valid, or has expired' })
    }
  })

  fastify.get('/advertising/reporting/custom-metrics', async (request, reply) => {
    const q = request.query as { reportId?: string }
    const { listCustomMetrics } = await import('../services/advertising/ads-custom-metrics.service.js')
    reply.header('Cache-Control', 'no-store')
    return { items: await listCustomMetrics(q.reportId) }
  })

  // Compile without saving — powers the live check while a formula is typed.
  fastify.get('/advertising/reporting/custom-metrics/preview', async (request, reply) => {
    const q = request.query as { reportId?: string; formula?: string }
    const svc = await import('../services/advertising/ads-custom-metrics.service.js')
    try {
      return svc.previewFormula(String(q.reportId ?? ''), String(q.formula ?? ''))
    } catch (err) {
      if (err instanceof svc.CustomMetricError) { reply.code(err.status); return { error: err.message } }
      throw err
    }
  })

  fastify.post('/advertising/reporting/custom-metrics', async (request, reply) => {
    const svc = await import('../services/advertising/ads-custom-metrics.service.js')
    try { reply.code(201); return await svc.createCustomMetric(request.body as never) }
    catch (err) {
      if (err instanceof svc.CustomMetricError) { reply.code(err.status); return { error: err.message } }
      throw err
    }
  })

  fastify.patch('/advertising/reporting/custom-metrics/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const svc = await import('../services/advertising/ads-custom-metrics.service.js')
    try { return await svc.updateCustomMetric(id, request.body as never) }
    catch (err) {
      if (err instanceof svc.CustomMetricError) { reply.code(err.status); return { error: err.message } }
      throw err
    }
  })

  fastify.delete('/advertising/reporting/custom-metrics/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const svc = await import('../services/advertising/ads-custom-metrics.service.js')
    try { await svc.deleteCustomMetric(id); return { ok: true } }
    catch (err) {
      if (err instanceof svc.CustomMetricError) { reply.code(err.status); return { error: err.message } }
      throw err
    }
  })

  // RPT.9 — per-feed pipeline health: is every feed landing, how late, what failed.
  fastify.get('/advertising/reporting/pipeline', async (_request, reply) => {
    const { pipelineHealth } = await import('../services/advertising/ads-pipeline-health.service.js')
    reply.header('Cache-Control', 'private, max-age=60')
    return pipelineHealth()
  })

  // ── RPT.7 — importing Amazon console exports ────────────────────────────
  fastify.get('/advertising/reporting/imports', async (_request, reply) => {
    const { listImports } = await import('../services/advertising/ads-console-import.service.js')
    reply.header('Cache-Control', 'no-store')
    return { items: await listImports() }
  })

  // Upload → PREVIEW. Parses, stages and reports the arithmetic. Writes nothing
  // that any report can see until the operator commits.
  fastify.post('/advertising/reporting/imports/preview', async (request, reply) => {
    const body = request.body as { fileName?: string; content?: string }
    const svc = await import('../services/advertising/ads-console-import.service.js')
    try {
      const content = String(body?.content ?? '')
      if (!content.trim()) { reply.code(400); return { error: 'The file is empty' } }
      return await svc.previewImport(String(body?.fileName ?? 'upload.csv'), content.length, content)
    } catch (err) {
      reply.code(400); return { error: (err as Error).message }
    }
  })

  fastify.post('/advertising/reporting/imports/:id/commit', async (request, reply) => {
    const { id } = request.params as { id: string }
    const svc = await import('../services/advertising/ads-console-import.service.js')
    try { return await svc.commitImport(id) } catch (err) { reply.code(400); return { error: (err as Error).message } }
  })

  fastify.delete('/advertising/reporting/imports/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const svc = await import('../services/advertising/ads-console-import.service.js')
    try { await svc.discardImport(id); return { ok: true } } catch (err) { reply.code(400); return { error: (err as Error).message } }
  })

  // The error file: one line per problem, naming the field and offending value.
  fastify.get('/advertising/reporting/imports/:id/errors', async (request, reply) => {
    const { id } = request.params as { id: string }
    const svc = await import('../services/advertising/ads-console-import.service.js')
    try {
      const out = await svc.errorCsv(id)
      reply.header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="${out.filename}"`)
      return reply.send(out.body)
    } catch (err) { reply.code(400); return { error: (err as Error).message } }
  })

  // ── RPT.6 — scheduled delivery ──────────────────────────────────────────
  // Same ads.view mapping as saved reports: a schedule is a delivery preference
  // for data the caller can already read.
  fastify.get('/advertising/reporting/schedules', async (_request, reply) => {
    const { listSchedules } = await import('../services/advertising/ads-report-schedules-crud.service.js')
    reply.header('Cache-Control', 'no-store')
    return { items: await listSchedules() }
  })

  fastify.get('/advertising/reporting/schedules/:id/deliveries', async (request) => {
    const { id } = request.params as { id: string }
    const { listDeliveries } = await import('../services/advertising/ads-report-schedules-crud.service.js')
    return { items: await listDeliveries(id) }
  })

  fastify.post('/advertising/reporting/schedules', async (request, reply) => {
    const svc = await import('../services/advertising/ads-report-schedules-crud.service.js')
    try {
      reply.code(201)
      return await svc.createSchedule(request.body as never)
    } catch (err) {
      reply.code(400); return { error: (err as Error).message }
    }
  })

  fastify.patch('/advertising/reporting/schedules/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const svc = await import('../services/advertising/ads-report-schedules-crud.service.js')
    try {
      return await svc.updateSchedule(id, request.body as never)
    } catch (err) {
      reply.code(400); return { error: (err as Error).message }
    }
  })

  fastify.delete('/advertising/reporting/schedules/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const svc = await import('../services/advertising/ads-report-schedules-crud.service.js')
    try {
      await svc.deleteSchedule(id)
      return { ok: true }
    } catch (err) {
      reply.code(400); return { error: (err as Error).message }
    }
  })

  // Run one schedule immediately — the SAME path the cron takes, so a manual
  // test exercises exactly what will happen at the scheduled hour rather than a
  // convenient approximation. Still honours NEXUS_ENABLE_OUTBOUND_EMAILS, so
  // this is a true dry run until outbound email is switched on.
  fastify.post('/advertising/reporting/schedules/:id/run', async (request, reply) => {
    const { id } = request.params as { id: string }
    const { runSchedule } = await import('../services/advertising/ads-report-schedules.service.js')
    try {
      return await runSchedule(id)
    } catch (err) {
      reply.code(400); return { error: (err as Error).message }
    }
  })

  // RPT.4 — download the FULL result set as CSV or XLSX. Same parameters as /run
  // and the same runner underneath, so what downloads is what the grid showed.
  fastify.get('/advertising/reporting/export', async (request, reply) => {
    const q = request.query as Record<string, string | undefined>
    const list = (v?: string) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : [])
    const format = q.format === 'xlsx' ? 'xlsx' : 'csv'
    const { exportReport } = await import('../services/advertising/ads-report-export.service.js')
    const { ReportError } = await import('../services/advertising/ads-report-runner.service.js')
    try {
      const out = await exportReport({
        reportId: String(q.reportId ?? ''),
        from: q.from ?? null,
        to: q.to ?? null,
        marketplaces: list(q.marketplaces),
        adProducts: list(q.adProducts),
        search: q.search ?? null,
        groupBy: list(q.groupBy),
        columns: list(q.columns),
        sort: q.sortCol ? { col: q.sortCol, dir: q.sortDir === 'asc' ? 'asc' : 'desc' } : null,
      }, format)
      // The manifest also rides on the response so a CSV — which carries no
      // manifest sheet — is still self-describing to whatever fetched it.
      reply
        .header('Content-Type', out.contentType)
        .header('Content-Disposition', `attachment; filename="${out.filename}"`)
        .header('Cache-Control', 'no-store')
        .header('X-Nexus-Report', out.manifest.reportId)
        .header('X-Nexus-Report-Rows', String(out.manifest.rows))
        // Split into ASCII fields on purpose: the manifest's window string uses an
        // arrow, and a non-Latin-1 byte in a header value makes Node reject the
        // entire response — the download fails with a JSON error instead of a file.
        .header('X-Nexus-Report-From', out.manifest.dataFirstDay ?? '')
        .header('X-Nexus-Report-To', out.manifest.dataLastDay ?? '')
        .header('X-Nexus-Report-Generated', out.manifest.generatedAt)
      return reply.send(out.body)
    } catch (err) {
      if (err instanceof ReportError) {
        reply.code(err.status)
        return { error: err.message }
      }
      throw err
    }
  })

  /**
   * RD.P2 — the campaign-grain runtime the Rank & Dayparting page has never had.
   *
   * `/advertising/rank-schedule-groups` returns group AGGREGATES only, so the page could say what a
   * schedule holds but never that one row of eleven campaigns contains four different fates. This
   * returns both grains from ONE derivation: the group rows are a roll-up of the campaign rows, so
   * an aggregate cannot drift from its own members and switching grain costs no round-trip.
   *
   * Path checked with `grep -a` against BOTH route files before adding it — a duplicate
   * registration here is a boot crash, not a warning.
   */
  fastify.get('/advertising/rank-runtime', async (_request, reply) => {
    // The engine moves these rows every 15 minutes, so a short cache is honest and a long one is
    // not. Matches the group endpoint's own max-age.
    reply.header('Cache-Control', 'private, max-age=5')
    const { getRankRuntime } = await import('../services/advertising/rank-runtime.service.js')
    return getRankRuntime()
  })

  /**
   * AUTO.A0 — the non-rule half of the actor list: engines (normalised from the Levers registry
   * into the section's vocabulary) plus every OBSERVED actor string the last window's log
   * carries that no rule and no engine claims. The rules half stays on
   * `GET /advertising/autonomy/rules` — one owner per read; the client merges.
   * Path grep-a'd against both route files — a duplicate registration is a boot crash.
   */
  fastify.get('/advertising/actors', async (_request, reply) => {
    reply.header('Cache-Control', 'private, max-age=30')
    const { getActors } = await import('../services/advertising/ads-actors.service.js')
    return getActors()
  })

  /**
   * AUTO.A4 — conflicts by ENTITY (campaign × field), replacing the trigger-blind client
   * detector that flags 0 of 22 live rules. Server-side because reach resolution needs
   * Campaign, AdTarget and the action log. Path grep-a'd against both route files.
   */
  fastify.get('/advertising/autonomy/conflicts', async (request, reply) => {
    const q = request.query as { window?: string }
    const windowDays = q.window && Number.isFinite(Number(q.window)) ? Math.min(120, Math.max(7, Number(q.window))) : 60
    reply.header('Cache-Control', 'private, max-age=120')
    const { getConflicts } = await import('../services/advertising/ads-conflicts.service.js')
    return getConflicts(windowDays)
  })

  /**
   * AUTO.A7 — the per-scope spend ceilings (AdSpendCeiling, KT.6's model), CRUD at last. KT.6
   * shipped the read deliberately and left setting values to this page — "the values are set on
   * Automations" is the substrate arbitration's line. The gate half (`spend_ceiling` denials on
   * budget increases) lives in ads-write-gate.ts and is inert until a row exists.
   */
  fastify.get('/advertising/spend-ceilings', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const rows = await prisma.adSpendCeiling.findMany({ orderBy: [{ grain: 'asc' }, { label: 'asc' }] })
    return { ceilings: rows }
  })

  fastify.put('/advertising/spend-ceilings', async (request, reply) => {
    const b = request.body as { grain?: string; scopeId?: string; label?: string; dailyCapCents?: number | null; enabled?: boolean; note?: string | null }
    const GRAINS = new Set(['CAMPAIGN', 'LINE', 'PORTFOLIO', 'MARKET'])
    if (!b?.grain || !GRAINS.has(b.grain) || !b.scopeId || !b.label?.trim()) {
      reply.code(400)
      return { error: 'grain (CAMPAIGN|LINE|PORTFOLIO|MARKET) + scopeId + label required' }
    }
    if (b.dailyCapCents != null && (!Number.isFinite(b.dailyCapCents) || b.dailyCapCents < 0)) {
      reply.code(400)
      return { error: 'dailyCapCents must be a non-negative integer, or null for "opened but not set"' }
    }
    const row = await prisma.adSpendCeiling.upsert({
      where: { grain_scopeId: { grain: b.grain, scopeId: b.scopeId } },
      create: { grain: b.grain, scopeId: b.scopeId, label: b.label.trim(), dailyCapCents: b.dailyCapCents ?? null, enabled: b.enabled ?? true, note: b.note ?? null, createdBy: 'operator' },
      update: { label: b.label.trim(), dailyCapCents: b.dailyCapCents ?? null, ...(b.enabled !== undefined ? { enabled: b.enabled } : {}), ...(b.note !== undefined ? { note: b.note } : {}) },
    })
    return { ceiling: row }
  })

  fastify.delete('/advertising/spend-ceilings', async (request, reply) => {
    const q = request.query as { grain?: string; scopeId?: string }
    if (!q.grain || !q.scopeId) { reply.code(400); return { error: 'grain + scopeId required' } }
    const existing = await prisma.adSpendCeiling.findUnique({ where: { grain_scopeId: { grain: q.grain, scopeId: q.scopeId } } })
    if (!existing) { reply.code(404); return { error: 'not_found' } }
    await prisma.adSpendCeiling.delete({ where: { id: existing.id } })
    return { ok: true }
  })

  /**
   * BID.S5 — bid-bounds policies at MARKET/PORTFOLIO/LINE grain (the campaign grain is the
   * Campaign columns, edited via the guardrails PATCH). Same CRUD shape as the spend ceilings.
   */
  fastify.get('/advertising/bid-policies', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const rows = await prisma.adBidPolicy.findMany({ orderBy: [{ grain: 'asc' }, { label: 'asc' }] })
    return { policies: rows }
  })

  fastify.put('/advertising/bid-policies', async (request, reply) => {
    const b = request.body as { grain?: string; scopeId?: string; label?: string; minBidCents?: number | null; maxBidCents?: number | null; enabled?: boolean; note?: string | null }
    const GRAINS = new Set(['LINE', 'PORTFOLIO', 'MARKET'])
    if (!b?.grain || !GRAINS.has(b.grain) || !b.scopeId || !b.label?.trim()) {
      reply.code(400)
      return { error: 'grain (LINE|PORTFOLIO|MARKET) + scopeId + label required — the CAMPAIGN grain is the Campaign columns, set via the guardrails PATCH' }
    }
    for (const [name, v] of [['minBidCents', b.minBidCents], ['maxBidCents', b.maxBidCents]] as const) {
      if (v != null && (!Number.isFinite(v) || v < 2)) { reply.code(400); return { error: `${name} must be ≥ 2 cents or null` } }
    }
    if (b.minBidCents != null && b.maxBidCents != null && b.minBidCents > b.maxBidCents) {
      reply.code(400)
      return { error: `minBidCents (${b.minBidCents}¢) is above maxBidCents (${b.maxBidCents}¢)` }
    }
    const row = await prisma.adBidPolicy.upsert({
      where: { grain_scopeId: { grain: b.grain, scopeId: b.scopeId } },
      create: { grain: b.grain, scopeId: b.scopeId, label: b.label.trim(), minBidCents: b.minBidCents ?? null, maxBidCents: b.maxBidCents ?? null, enabled: b.enabled ?? true, note: b.note ?? null, createdBy: 'operator' },
      update: { label: b.label.trim(), minBidCents: b.minBidCents ?? null, maxBidCents: b.maxBidCents ?? null, ...(b.enabled !== undefined ? { enabled: b.enabled } : {}), ...(b.note !== undefined ? { note: b.note } : {}) },
    })
    return { policy: row }
  })

  fastify.delete('/advertising/bid-policies', async (request, reply) => {
    const q = request.query as { grain?: string; scopeId?: string }
    if (!q.grain || !q.scopeId) { reply.code(400); return { error: 'grain + scopeId required' } }
    const existing = await prisma.adBidPolicy.findUnique({ where: { grain_scopeId: { grain: q.grain, scopeId: q.scopeId } } })
    if (!existing) { reply.code(404); return { error: 'not_found' } }
    await prisma.adBidPolicy.delete({ where: { id: existing.id } })
    return { ok: true }
  })

  /**
   * AUTO.A7 / substrate S5 — the gate's refusal record, countable at last. The table starts
   * 2026-08-15 (the payload says so): earlier refusals exist only in the application log, and a
   * surface must never read this zero as "the gate refused nothing before then".
   */
  /**
   * AUTO.A5 / substrate S4 — the account-wide change ledger, honest about its own completeness.
   *
   * 44,435 writes existed, attributed, and were rendered nowhere. This is the ONE route over
   * `AdvertisingActionLog` (other pages filter it; nobody re-derives it). Its defining feature
   * is stating what it cannot claim: the null-actor share travels on every response, evidence
   * coverage is reported PER action type (100% on placements, 0% on budgets — a blank where a
   * reason should be is a claim), and `payloadBefore/After.dailyBudget` is EUROS — the one ads
   * money field that is not cents — so the client is told rather than left to inflate 100×.
   * Actor strings resolve server-side ('user:<id>' → the profile's name, 'automation:<ruleId>'
   * → the rule's name) so every consumer agrees on the words.
   */
  fastify.get('/advertising/action-log', async (request, reply) => {
    const q = request.query as { days?: string; take?: string; before?: string; entityType?: string; actionType?: string; actor?: string; campaignId?: string }
    const days = q.days && Number.isFinite(Number(q.days)) ? Math.min(60, Math.max(1, Number(q.days))) : 7
    const take = q.take && Number.isFinite(Number(q.take)) ? Math.min(500, Math.max(1, Number(q.take))) : 100
    const since = new Date(Date.now() - days * 86_400_000)
    reply.header('Cache-Control', 'private, max-age=15')

    const where = {
      createdAt: { gte: since, ...(q.before ? { lt: new Date(q.before) } : {}) },
      ...(q.entityType ? { entityType: q.entityType } : {}),
      ...(q.actionType ? { actionType: q.actionType } : {}),
      ...(q.actor === 'null' ? { userId: null } : q.actor ? { userId: q.actor } : {}),
      // 🔴 BSP.2 · binding — `campaignId` was destructured above and never used, so this route has
      // been advertising a filter it did not apply: `?campaignId=X` returned EVERY campaign's rows.
      // Same defect shape as `budget-schedules/hourly-performance` destructuring `marketplace` and
      // ignoring it. Substrate spec §4 makes this route the ONE ledger query for all eleven pages,
      // so a page rendering "this campaign's history" was going to caption another campaign's
      // writes as this one's. For a CAMPAIGN row `entityId` IS the local campaign id — verified
      // against `Campaign.id` in `_bs-page-binding.mts`. Additive: a caller that omits it is
      // byte-identical to before.
      ...(q.campaignId ? { entityId: q.campaignId } : {}),
    }

    const [rows, total, nullActor, byType, withEvidence] = await Promise.all([
      prisma.advertisingActionLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take,
        select: {
          id: true, createdAt: true, userId: true, executionId: true, actionType: true,
          entityType: true, entityId: true, payloadBefore: true, payloadAfter: true,
          evidence: true, rolledBackAt: true, amazonResponseStatus: true,
        },
      }),
      prisma.advertisingActionLog.count({ where: { createdAt: { gte: since } } }),
      prisma.advertisingActionLog.count({ where: { createdAt: { gte: since }, userId: null } }),
      prisma.advertisingActionLog.groupBy({ by: ['actionType'], where: { createdAt: { gte: since } }, _count: { _all: true } }),
      // Json? null filtering needs Prisma's typed nulls: AnyNull matches DB null and JSON null
      // both, so `not: AnyNull` is "carries any evidence at all".
      prisma.advertisingActionLog.groupBy({ by: ['actionType'], where: { createdAt: { gte: since }, evidence: { not: Prisma.AnyNull } }, _count: { _all: true } }),
    ])

    // Resolve actors once for the page of rows: user:<id> → displayName, automation:<ruleId> →
    // the rule's name. Anything else passes through raw — an invented label is worse than an id.
    const userIds = [...new Set(rows.map((r) => r.userId).filter((u): u is string => !!u?.startsWith('user:')))].map((u) => u.slice(5))
    const ruleIds = [...new Set(rows.map((r) => r.userId).filter((u): u is string => !!u?.startsWith('automation:')))].map((u) => u.slice(11))
    const [users, ruleRows] = await Promise.all([
      userIds.length ? prisma.userProfile.findMany({ where: { id: { in: userIds } }, select: { id: true, displayName: true, email: true } }) : Promise.resolve([]),
      ruleIds.length ? prisma.automationRule.findMany({ where: { id: { in: ruleIds } }, select: { id: true, name: true } }) : Promise.resolve([]),
    ])
    const userName = new Map(users.map((u) => [u.id, u.displayName || u.email || u.id]))
    const ruleName = new Map(ruleRows.map((r) => [r.id, r.name]))
    const actorLabel = (userId: string | null): string => {
      if (userId == null) return '(no actor recorded)'
      if (userId.startsWith('user:')) return userName.get(userId.slice(5)) ?? userId
      if (userId.startsWith('automation:')) {
        const bare = userId.slice(11)
        return ruleName.get(bare) ?? userId
      }
      return userId
    }

    const evidenceByType = new Map(withEvidence.map((g) => [g.actionType, g._count._all]))
    return {
      windowDays: days,
      rows: rows.map((r) => ({ ...r, actorLabel: actorLabel(r.userId) })),
      summary: {
        total,
        nullActor,
        nullActorNote: nullActor > 0 ? `${nullActor.toLocaleString('en-IE')} of ${total.toLocaleString('en-IE')} writes in this window carry no author at all — this ledger cannot claim completeness of attribution.` : null,
        byActionType: byType
          .sort((a, b) => b._count._all - a._count._all)
          .map((g) => ({
            actionType: g.actionType,
            count: g._count._all,
            evidencePct: g._count._all > 0 ? Math.round(((evidenceByType.get(g.actionType) ?? 0) / g._count._all) * 100) : 0,
          })),
      },
      notes: {
        budgetsAreEuros: 'payloadBefore/After.dailyBudget is EUROS, not cents — the one ads money field that is not.',
      },
    }
  })

  /**
   * BID.S6 — declare (or clear) a campaign's target-ACoS goal.
   *
   * Writes `Campaign.dynamicBidding.targetAcos` — the field five services READ and
   * `Campaign.targetAcosPct` is documented as a mistake. This is a LOCAL declaration: Amazon has
   * no concept of it, nothing is synced, and today no engine acts on it unprompted — the bid
   * optimizer runs flat-30%/profit targets and the bid rules carry their own `action.targetAcos`.
   * What it changes immediately is the bidder derivation: `bidderByCampaign` reads this exact key,
   * so the row flips to "Goal" the next load. The AIREON `30` trap is refused, never guessed:
   * a value above 1 is a percentage in the wrong unit and the error says exactly that.
   */
  fastify.put('/advertising/campaigns/:id/goal', async (request, reply) => {
    const { id } = request.params as { id: string }
    const b = (request.body ?? {}) as { targetAcos?: number | null }
    if (b.targetAcos != null && (!Number.isFinite(b.targetAcos) || b.targetAcos <= 0 || b.targetAcos > 1)) {
      reply.code(400)
      return { error: `targetAcos must be a fraction between 0 and 1 (0.3 = 30%) or null to clear — got ${JSON.stringify(b.targetAcos)}, which would be read as ${(Number(b.targetAcos) * 100).toFixed(0)}%` }
    }
    const c = await prisma.campaign.findUnique({ where: { id }, select: { id: true, dynamicBidding: true } })
    if (!c) { reply.code(404); return { error: 'campaign not found' } }
    const db = (c.dynamicBidding ?? {}) as Record<string, unknown>
    const before = typeof db.targetAcos === 'number' ? db.targetAcos : null
    if (b.targetAcos == null) delete db.targetAcos
    else db.targetAcos = b.targetAcos
    await prisma.campaign.update({ where: { id }, data: { dynamicBidding: db as never } })
    const actorRaw = (request.headers as Record<string, unknown>)['x-actor-id']
    await prisma.advertisingActionLog.create({
      data: {
        userId: typeof actorRaw === 'string' && actorRaw ? `user:${actorRaw}` : 'user:anonymous',
        actionType: 'set_campaign_goal', entityType: 'CAMPAIGN', entityId: id,
        payloadBefore: { targetAcos: before }, payloadAfter: { targetAcos: b.targetAcos ?? null },
        amazonResponseStatus: 'SUCCESS',
        evidence: { metric: 'operator_goal', note: 'Local declaration — read by the bidder derivation and the target-ACoS tooling; never pushed to Amazon; no engine acts on it unprompted.' },
      },
    }).catch(() => { /* an audit row must never fail the write it describes */ })
    return { ok: true, targetAcos: b.targetAcos ?? null }
  })

  /**
   * BID.S4 — the staged tray's account-wide read.
   *
   * `GET /advertising/campaigns/:id/pending-writes` answers this per campaign, which is one
   * request per campaign for an account-wide tray. This is its bulk sibling for the GRACE WINDOW:
   * every PENDING Amazon-bound queue row, flattened to one item per field change, with entity and
   * campaign names resolved server-side. Cancellation stays on the existing
   * `POST /advertising/queued-mutations/:queueId/cancel` — this route only reads.
   */
  fastify.get('/advertising/staged-writes', async (request, reply) => {
    const q = request.query as { field?: string }
    reply.header('Cache-Control', 'no-store')
    const rows = await prisma.outboundSyncQueue.findMany({
      where: { targetChannel: 'AMAZON', syncStatus: 'PENDING' },
      select: { id: true, payload: true, holdUntil: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 500,
    })
    type Staged = {
      queueId: string; entityType: string | null; entityId: string
      field: string; oldValue: string | null; newValue: string | null
      holdUntil: Date | null; createdAt: Date
    }
    const flat: Staged[] = []
    for (const r of rows) {
      const p = (r.payload ?? {}) as { entityType?: string; entityId?: string; fieldChanges?: Array<{ field: string; oldValue: string | null; newValue: string | null }> }
      if (!p.entityId) continue
      for (const c of p.fieldChanges ?? []) {
        if (q.field && c.field !== q.field) continue
        flat.push({ queueId: r.id, entityType: p.entityType ?? null, entityId: p.entityId, field: c.field, oldValue: c.oldValue, newValue: c.newValue, holdUntil: r.holdUntil, createdAt: r.createdAt })
      }
    }
    const targetIds = [...new Set(flat.filter((f) => f.entityType === 'AD_TARGET' || f.entityType == null).map((f) => f.entityId))]
    const campaignIds = [...new Set(flat.filter((f) => f.entityType === 'CAMPAIGN').map((f) => f.entityId))]
    const [targets, camps] = await Promise.all([
      targetIds.length ? prisma.adTarget.findMany({ where: { id: { in: targetIds } }, select: { id: true, expressionValue: true, expressionType: true, kind: true, adGroup: { select: { campaign: { select: { id: true, name: true } } } } } }) : [],
      campaignIds.length ? prisma.campaign.findMany({ where: { id: { in: campaignIds } }, select: { id: true, name: true } }) : [],
    ])
    const { labelFor } = await import('../services/advertising/bid-grid.service.js')
    const targetById = new Map(targets.map((t) => [t.id, t] as const))
    const campById = new Map(camps.map((c) => [c.id, c] as const))
    return {
      // The server's clock rides along so the client's countdown is skew-proof.
      now: new Date().toISOString(),
      items: flat.map((f) => {
        const t = targetById.get(f.entityId)
        const camp = f.entityType === 'CAMPAIGN' ? campById.get(f.entityId) : t?.adGroup?.campaign
        return {
          ...f,
          entityName: t ? labelFor(t.expressionValue, t.kind, t.expressionType).label : campById.get(f.entityId)?.name ?? f.entityId,
          campaignId: camp?.id ?? null,
          campaignName: camp?.name ?? null,
        }
      }),
    }
  })

  /**
   * RT.2 — the five page cursors. Shapes, and the reason each field is not the obvious one, are in
   * `ads-cursors.service.ts`; the measurement that disqualified the obvious ones is in
   * `scripts/_rt-cursor-probe.mts`.
   *
   * `no-store` on every one of them: a cached cursor is a cursor that cannot detect a change,
   * which is its only job.
   *
   * 🔴 Budget Pacing & Schedules deliberately has NO cursor — `BudgetSchedule` holds 0 rows and the
   * page's real movers are either operator-only or a continuously-moving Σ. See the closing note in
   * the service.
   */
  fastify.get('/advertising/apply-rules/cursor', async (request, reply) => {
    const q = (request.query ?? {}) as Record<string, string | undefined>
    const { getApplyRulesCursor } = await import('../services/advertising/ads-cursors.service.js')
    reply.header('Cache-Control', 'no-store')
    return getApplyRulesCursor({
      market: q.market ?? 'all', line: q.line || null, portfolio: q.portfolio || null, campaign: q.campaign || null,
    })
  })

  fastify.get('/advertising/automations/cursor', async (request, reply) => {
    const q = (request.query ?? {}) as Record<string, string | undefined>
    const { getAutomationsCursor } = await import('../services/advertising/ads-cursors.service.js')
    reply.header('Cache-Control', 'no-store')
    // The page's four reads are account-wide, so the cursor takes no scope — a scoped cursor would
    // describe a different row set from the grid. `view` only decides whether `actedAt` rides along.
    return getAutomationsCursor(q.view ?? 'actors')
  })

  fastify.get('/advertising/dayparting/cursor', async (request, reply) => {
    const q = (request.query ?? {}) as Record<string, string | undefined>
    const { getDaypartingCursor } = await import('../services/advertising/ads-cursors.service.js')
    reply.header('Cache-Control', 'no-store')
    return getDaypartingCursor({ market: q.market ?? 'all', portfolio: q.portfolio || null, campaign: q.campaign || null })
  })

  fastify.get('/advertising/keyword-harvest/cursor', async (request, reply) => {
    const q = (request.query ?? {}) as Record<string, string | undefined>
    const { getHarvestCursor } = await import('../services/advertising/ads-cursors.service.js')
    reply.header('Cache-Control', 'no-store')
    return getHarvestCursor({ market: q.market ?? 'all', campaign: q.campaign || null })
  })

  fastify.get('/advertising/negatives/cursor', async (request, reply) => {
    const q = (request.query ?? {}) as Record<string, string | undefined>
    const { getNegativesCursor } = await import('../services/advertising/ads-cursors.service.js')
    reply.header('Cache-Control', 'no-store')
    return getNegativesCursor({ market: q.market ?? 'all', campaign: q.campaign || null })
  })

  fastify.get('/advertising/write-refusals', async (request, reply) => {
    // BID.S8 (additive) — `entityType` lets a page ask for its own slice (AD_TARGET = bid writes).
    // `recent` now carries the SAME window and filter as `byKind`: before this, the list was
    // all-time while the counts were windowed — two answers under one heading.
    const q = request.query as { days?: string; entityType?: string }
    const days = q.days && Number.isFinite(Number(q.days)) ? Math.min(60, Math.max(1, Number(q.days))) : 7
    const since = new Date(Date.now() - days * 86_400_000)
    const where = { createdAt: { gte: since }, ...(q.entityType ? { entityType: q.entityType } : {}) }
    reply.header('Cache-Control', 'private, max-age=30')
    // AUTO.P0 — the AUTOMATION refusal family, on this route rather than a second one. Two routes
    // returning the same counts drift, and `/advertising/write-refusals` is already the question
    // "what was refused"; a rule refused by its own cap is the same question with a different
    // subject. `automation` is a COUNTER (27,629 refusals/day measured — a row each would be 10M
    // a year), so it carries counts and one verbatim last-instance per (actor, day, reason),
    // where `byKind`/`recent` above carry the gate's per-instance rows.
    const sinceDay = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10)
    const [byKind, recent, autoRows] = await Promise.all([
      prisma.adWriteRefusal.groupBy({ by: ['deniedAt'], where, _count: { _all: true } }),
      prisma.adWriteRefusal.findMany({ where, orderBy: { createdAt: 'desc' }, take: 50 }),
      prisma.automationRefusalDaily.findMany({
        where: { dayUtc: { gte: sinceDay } },
        orderBy: [{ dayUtc: 'desc' }, { count: 'desc' }],
      }),
    ])
    const ruleNames = autoRows.length
      ? new Map((await prisma.automationRule.findMany({
        where: { id: { in: [...new Set(autoRows.map((r) => r.actorId))] } },
        select: { id: true, name: true, maxExecutionsPerDay: true },
      })).map((r) => [r.id, r]))
      : new Map()
    const byActor = new Map<string, { actorId: string; actorKind: string; actorName: string | null; cap: number | null; total: number; byReason: Record<string, number>; lastAt: Date; lastReason: string }>()
    for (const r of autoRows) {
      const cur = byActor.get(r.actorId)
      if (!cur) {
        const named = ruleNames.get(r.actorId)
        byActor.set(r.actorId, {
          actorId: r.actorId, actorKind: r.actorKind,
          actorName: named?.name ?? null, cap: named?.maxExecutionsPerDay ?? null,
          total: r.count, byReason: { [r.reason]: r.count }, lastAt: r.lastAt, lastReason: r.lastReason,
        })
        continue
      }
      cur.total += r.count
      cur.byReason[r.reason] = (cur.byReason[r.reason] ?? 0) + r.count
      if (r.lastAt > cur.lastAt) { cur.lastAt = r.lastAt; cur.lastReason = r.lastReason }
    }
    return {
      recordStarts: '2026-08-15',
      windowDays: days,
      byKind: byKind.map((g) => ({ deniedAt: g.deniedAt, count: g._count._all })),
      recent,
      // 🔴 A refusal is never a failure. Nothing in here may be folded into a failure rate.
      automation: {
        recordStarts: '2026-08-16',
        byActor: [...byActor.values()].sort((a, b) => b.total - a.total),
        byDay: autoRows.map((r) => ({ dayUtc: r.dayUtc, actorId: r.actorId, reason: r.reason, count: r.count })),
      },
    }
  })
}

export default advertisingIntelRoutes
