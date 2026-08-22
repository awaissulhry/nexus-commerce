/**
 * W1 — read-only verification stub (see reference_web_verify_without_local_api).
 * Serves ONLY the three endpoints RulesGrid reads, from prod Neon via read-only Prisma queries,
 * so the legacy chip/filter can be screen-verified without booting apps/api (whose crons write).
 * CORS: echoes Origin, answers OPTIONS, allows private network — the three PNA requirements.
 */
import '../src/env.js'
import { createServer } from 'node:http'
const { default: prisma } = await import('../src/db.js')

const PORT = 8099
createServer(async (req, res) => {
  const origin = req.headers.origin ?? 'http://localhost:3000'
  res.setHeader('access-control-allow-origin', origin)
  res.setHeader('access-control-allow-credentials', 'true')
  res.setHeader('access-control-allow-headers', 'content-type')
  res.setHeader('access-control-allow-methods', 'GET,POST,PATCH,DELETE,OPTIONS')
  res.setHeader('access-control-allow-private-network', 'true')
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
  const url = (req.url ?? '').split('?')[0]
  const json = (code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  try {
    if (url === '/api/advertising/automation-rules') {
      const items = await prisma.automationRule.findMany({
        where: { domain: 'advertising' },
        orderBy: [{ enabled: 'desc' }, { name: 'asc' }],
      })
      json(200, { items, count: items.length })
    } else if (url === '/api/advertising/autonomy/rules') {
      // Minimal but complete DetailRule shape, with the W1 `legacy` field computed the same way
      // the real route now does — enough to screen-verify the badge + filter on Automations.
      const { isLegacyRule } = await import('@nexus/shared/ads-rule-legacy')
      const rules = await prisma.automationRule.findMany({ where: { domain: 'advertising' }, orderBy: [{ enabled: 'desc' }, { name: 'asc' }] })
      const items = rules.map((r) => ({
        id: r.id, name: r.name, description: r.description, conditions: r.conditions,
        reach: null, priority: r.priority, trigger: r.trigger, marketplace: r.scopeMarketplace,
        level: !r.enabled ? 'OFF' : r.autonomyLevel, ceiling: 'AUTO', ceilingReason: '', blockedBy: [],
        writes: true, actions: r.actions,
        actionTypes: (Array.isArray(r.actions) ? (r.actions as Array<{ type?: string }>) : []).map((a) => String(a?.type ?? '')).filter(Boolean),
        category: 'bid', categoryColor: '#5b7ba6', categoryLabel: 'Bid & placement',
        scope: { kind: 'account', id: null, name: null, product: null },
        caps: { perDay: r.maxExecutionsPerDay, perExecutionCents: r.maxValueCentsEur, perDayCents: r.maxDailyAdSpendCentsEur, writesPerDay: r.maxWritesPerDay },
        week: { acted: 0, proposed: 0, failed: 0, capped: 0 },
        lifetime: { evaluations: r.evaluationCount, matches: r.matchCount, executions: r.executionCount },
        lastEvaluatedAt: r.lastEvaluatedAt, lastMatchedAt: r.lastMatchedAt, lastExecutedAt: r.lastExecutedAt,
        ageDays: Math.floor((Date.now() - r.createdAt.getTime()) / 86_400_000),
        createdAt: r.createdAt, legacy: isLegacyRule(r),
      }))
      json(200, { items, protectedTerms: 0 })
    } else if (url === '/api/advertising/automation-rules/activity') {
      json(200, { items: {} })
    } else if (url === '/api/advertising/campaigns' && req.method === 'GET') {
      const cs = await prisma.campaign.findMany({
        select: {
          id: true, name: true, status: true, marketplace: true, portfolioId: true,
          biddingStrategy: true, minBidCents: true, maxBidCents: true,
          externalCampaignId: true, dynamicBidding: true,
        },
        orderBy: { name: 'asc' },
      })
      json(200, {
        items: cs.map((c) => {
          const db = (c.dynamicBidding ?? {}) as Record<string, unknown>
          return {
            id: c.id, name: c.name, status: c.status, marketplace: c.marketplace,
            portfolioId: c.portfolioId, biddingStrategy: c.biddingStrategy,
            minBidCents: c.minBidCents, maxBidCents: c.maxBidCents,
            externalCampaignId: c.externalCampaignId,
            bidAutomation: db.bidAutomation === true,
            bidAlgorithm: (db.bidAlgorithm as string | undefined) ?? null,
          }
        }),
      })
    } else if (url === '/api/advertising/control-room/guardrail-grid' && req.method === 'GET') {
      const cs = await prisma.campaign.findMany({
        select: {
          id: true, name: true, status: true, marketplace: true, portfolioId: true,
          liveBidWritesEnabled: true, minBidCents: true, maxBidCents: true,
          targetAcosPct: true, dynamicBidding: true,
        },
      })
      json(200, {
        accountWideRules: 0,
        totals: { campaigns: cs.length },
        rows: cs.map((c) => {
          const db = (c.dynamicBidding ?? {}) as Record<string, unknown>
          return {
            id: c.id, name: c.name, status: c.status, marketplace: c.marketplace,
            portfolioId: c.portfolioId, managed: c.liveBidWritesEnabled,
            minBidCents: c.minBidCents, maxBidCents: c.maxBidCents,
            targetAcosPct: typeof db.targetAcos === 'number' ? Math.round(db.targetAcos * 100) : c.targetAcosPct,
            pins: null, boundRules: [],
          }
        }),
      })
    } else if (url === '/api/advertising/scope-options' && req.method === 'GET') {
      const cs = await prisma.campaign.findMany({ select: { id: true, name: true, marketplace: true, portfolioId: true } })
      json(200, { campaigns: cs, portfolios: [], productLines: [] })
    } else if (url === '/api/advertising/bid-grid' || url === '/api/advertising/budget-grid') {
      json(200, { rows: [] })
    } else if (url === '/api/advertising/campaign-rule-assignments' && req.method === 'GET') {
      const [rules, links] = await Promise.all([
        prisma.automationRule.findMany({
          where: { domain: 'advertising', trigger: 'CAMPAIGN_PERFORMANCE_BUDGET' },
          select: { id: true, name: true, enabled: true, autonomyLevel: true },
        }),
        prisma.campaignRuleAssignment.findMany({ where: { kind: 'budget' }, select: { campaignId: true, ruleId: true } }),
      ])
      const byCampaign = new Map<string, string[]>()
      for (const l of links) byCampaign.set(l.campaignId, [...(byCampaign.get(l.campaignId) ?? []), l.ruleId])
      json(200, {
        rules: rules.map((r) => ({ id: r.id, name: r.name, enabled: r.enabled, level: r.enabled ? r.autonomyLevel : 'OFF', percent: null, conditionsText: null })),
        items: [...byCampaign.entries()].map(([campaignId, ruleIds]) => ({ campaignId, ruleIds })),
      })
    } else if (url === '/api/advertising/budget-schedules' && req.method === 'GET') {
      // FABRICATED rows (not from DB — the table holds 0 rows) covering all four W4 states.
      json(200, {
        items: [
          { id: 'bs-1', name: 'Prime Day Push', type: 'campaign-budget', enabled: true, autoRefill: false, days: 'All Days', startDate: '2026-08-01', endDate: null, excludeStart: '2026-08-25', excludeEnd: '2026-08-26', excludeRanges: 1 },
          { id: 'bs-2', name: 'Black Friday Weekend', type: 'budget-multiplier', enabled: true, autoRefill: false, days: 'FRI, SAT, SUN', startDate: '2026-11-27', endDate: '2026-11-30', excludeStart: null, excludeEnd: null, excludeRanges: 0 },
          { id: 'bs-3', name: 'Summer Sale (over)', type: 'campaign-budget', enabled: true, autoRefill: false, days: 'MON, TUE', startDate: '2026-07-01', endDate: '2026-07-15', excludeStart: null, excludeEnd: null, excludeRanges: 0 },
          { id: 'bs-4', name: 'Paused experiment', type: 'campaign-budget', enabled: false, autoRefill: false, days: 'WED', startDate: '2026-08-01', endDate: null, excludeStart: null, excludeEnd: null, excludeRanges: 0 },
        ],
        count: 4,
      })
    } else if (req.method === 'PATCH' && /^\/api\/advertising\/budget-schedules\/[^/]+$/.test(url)) {
      json(200, { schedule: { id: url.split('/').pop() } }) // simulated — nothing stored
    } else if (req.method === 'DELETE' && /^\/api\/advertising\/budget-schedules\/[^/]+$/.test(url)) {
      json(200, { ok: true }) // simulated — nothing deleted
    } else if (url === '/api/advertising/apply-rules/cursor') {
      json(200, { baseline: null })
    } else if (req.method === 'PATCH' && /^\/api\/advertising\/campaigns\/[^/]+\/(live-writes|automation|guardrails)$/.test(url)) {
      // SIMULATED write — 200 ok, nothing stored. Exists so the popover's success path
      // (result line surviving, selection persisting until Close) can be exercised
      // without a single prod write.
      json(200, { ok: true })
    } else if (req.method === 'POST' && url === '/api/advertising/campaign-rule-assignments/bulk') {
      json(200, { ok: true }) // simulated — nothing stored
    } else {
      json(404, { error: 'stub: not served', url })
    }
  } catch (e) {
    json(500, { error: (e as Error).message })
  }
}).listen(PORT, () => console.log(`w1 stub on http://localhost:${PORT} (read-only)`))
