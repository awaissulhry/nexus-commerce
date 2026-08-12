/**
 * Apex C.2 — advertising intelligence routes (profit-native target ACOS).
 *
 * Kept in a SEPARATE plugin from advertising.routes.ts on purpose: that file
 * carries a € literal that trips plain grep into binary mode, and it sees heavy
 * concurrent edits — new read-only intel endpoints are safer here. Registered
 * under the same /api prefix.
 */

import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'
import { computeProductTargetAcos, computeFleetTargetAcos, type AcosMode } from '../services/advertising/ads-target-acos.service.js'
import { simulateAutopilot, applyAutopilot } from '../services/advertising/ads-autopilot.service.js'
import { getKeywordTracker, KT_MARKETS } from '../services/advertising/keyword-tracker.service.js'
import { getNegatives, NEG_MARKETS, NEG_MARKET_ALL } from '../services/advertising/negatives.service.js'
import { envEnabled } from '../utils/env-flag.js'
import { cronStartupState } from '../jobs/cron-startup-state.js'
import { amsQueueUrl, isAmsSqsConfigured, sqsUrlFromArn } from '../services/ams-sqs.service.js'

const advertisingIntelRoutes: FastifyPluginAsync = async (fastify) => {
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
    return businessContext({ from, to, minClicks: q.minClicks ? Number(q.minClicks) : undefined })
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
}

export default advertisingIntelRoutes
