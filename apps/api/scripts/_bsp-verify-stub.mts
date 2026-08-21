/**
 * BSP — local verification rig for the Budget Schedules tab + builder (P1–P5).
 *
 * Its own file rather than an extension of `_bp-verify-stub.mts`: that one is edited by the BUD-P
 * session and there is no reason to contend over it.
 *
 * Two kinds of endpoint, deliberately:
 *
 *  · **REAL reads, run here against prod Neon** — `hourly-performance` (all three grains) and
 *    `context` execute the SAME SQL and the SAME aggregation the routes do, so what renders is a
 *    true reading and the queries themselves get verified. This is the part that would be
 *    worthless as a fixture.
 *  · **FIXTURE schedules** — prod has **0 `BudgetSchedule` rows**, so every new state on the grid
 *    (yielded · not-at-Amazon · refused · in-flight · multi-market · multi-blackout · Off ·
 *    Completed · Scheduled) would render against nothing. The fixtures below exist to make each of
 *    those visible on screen at once. They are shaped exactly like the route's `shaped` object.
 *
 * Everything else proxies prod read-only. No writes reach anything.
 *
 * Run:  cd apps/api && npx tsx scripts/_bsp-verify-stub.mts
 * Web:  cd apps/web && NEXT_PUBLIC_API_URL=http://localhost:8097 NEXT_DEV_ISOLATED=1 \
 *         NEXT_DIST_DIR=.next-bsp npm run dev -- -p 3007
 */
import '../src/env.js'
import { createServer } from 'node:http'

const { default: prisma } = await import('../src/db.js')

const PORT = Number(process.env.BSP_STUB_PORT ?? 8097)
const PROD = 'https://nexusapi-production-b7bb.up.railway.app'

const iso = (d: Date) => d.toISOString().slice(0, 10)
const dayFrom = (n: number) => iso(new Date(Date.now() + n * 864e5))

type Delivery = {
  campaigns: number; applied: number; held: number; yielded: number; refused: number; failed: number
  delivered: number; notDelivered: number; unknown: number; lastError: string | null
  yieldedBy: Array<{ kind: string; label: string; count: number }>
}
const del = (o: Partial<Delivery>): Delivery => ({
  campaigns: 0, applied: 0, held: 0, yielded: 0, refused: 0, failed: 0,
  delivered: 0, notDelivered: 0, unknown: 0, lastError: null, yieldedBy: [], ...o,
})
const PACER = { kind: 'pacer', label: 'the budget pacer holding the monthly envelope', count: 0 }
const HAND = { kind: 'operator', label: 'you, by hand', count: 0 }

/** One fixture per state the grid can now express. */
const FIXTURES = [
  {
    id: 'fx-yielded', name: 'IT evening lift — 18:00 to 23:00', type: 'campaign-budget', enabled: true,
    days: 'All Days', markets: ['IT'], startDate: dayFrom(-10), endDate: null,
    excludeStart: null, excludeEnd: null, excludeRanges: 0, autoRefill: false,
    lastEvaluatedAt: new Date().toISOString(),
    // The headline state: the schedule set them, the pacer moved them, the schedule stood down.
    delivery: del({ campaigns: 6, applied: 6, yielded: 4, delivered: 2, yieldedBy: [{ ...PACER, count: 3 }, { kind: 'rule', label: 'the rule “Reclaim idle budget — DE”', count: 1 }] }),
  },
  {
    id: 'fx-blocked', name: 'DE weekend push', type: 'campaign-budget', enabled: true,
    days: 'SAT, SUN', markets: ['DE'], startDate: dayFrom(-30), endDate: null,
    excludeStart: null, excludeEnd: null, excludeRanges: 0, autoRefill: false,
    lastEvaluatedAt: new Date().toISOString(),
    // Written locally, refused by the write gate — the fact the old screen could not express.
    delivery: del({ campaigns: 3, applied: 3, delivered: 1, notDelivered: 2, lastError: '[ADS-WRITE-GATE-DENY] budget_day_move: this would move today’s budget from €80.00 to €160.00 — a 100% rise, past the 50%/day limit' }),
  },
  {
    id: 'fx-clean', name: 'ES midday multiplier', type: 'budget-multiplier', enabled: true,
    days: 'MON, TUE, WED, THU, FRI', markets: ['ES'], startDate: dayFrom(-3), endDate: null,
    excludeStart: null, excludeEnd: null, excludeRanges: 0, autoRefill: false,
    lastEvaluatedAt: new Date().toISOString(),
    delivery: del({ campaigns: 2, applied: 2, delivered: 2 }),
  },
  {
    id: 'fx-blackouts', name: 'Multi-market Black Friday ramp', type: 'campaign-budget', enabled: true,
    days: 'All Days', markets: ['DE', 'FR', 'IT'], startDate: dayFrom(-1), endDate: dayFrom(40),
    // Three blackout ranges — the grid has room for one and must say so.
    excludeStart: dayFrom(5), excludeEnd: dayFrom(7), excludeRanges: 3, autoRefill: false,
    lastEvaluatedAt: new Date().toISOString(),
    delivery: del({ campaigns: 9, applied: 4, held: 5, unknown: 4 }),
  },
  {
    id: 'fx-refused', name: 'FR restore test', type: 'campaign-budget', enabled: true,
    days: 'MON', markets: ['FR'], startDate: dayFrom(-60), endDate: null,
    excludeStart: null, excludeEnd: null, excludeRanges: 0, autoRefill: false,
    lastEvaluatedAt: new Date().toISOString(),
    delivery: del({ campaigns: 1, refused: 1, lastError: 'not_found' }),
  },
  {
    id: 'fx-scheduled', name: 'Christmas week — starts later', type: 'campaign-budget', enabled: true,
    days: 'All Days', markets: ['IT'], startDate: dayFrom(30), endDate: dayFrom(45),
    excludeStart: null, excludeEnd: null, excludeRanges: 0, autoRefill: false,
    lastEvaluatedAt: null, delivery: null,
  },
  {
    id: 'fx-done', name: 'August heat wave (finished)', type: 'campaign-budget', enabled: true,
    days: 'All Days', markets: ['IT'], startDate: dayFrom(-40), endDate: dayFrom(-5),
    excludeStart: null, excludeEnd: null, excludeRanges: 0, autoRefill: false,
    lastEvaluatedAt: new Date(Date.now() - 5 * 864e5).toISOString(),
    delivery: del({ campaigns: 4, held: 4 }),
  },
  {
    id: 'fx-off', name: 'Paused experiment', type: 'budget-multiplier', enabled: false,
    days: 'All Days', markets: [], startDate: dayFrom(-20), endDate: null,
    excludeStart: null, excludeEnd: null, excludeRanges: 0, autoRefill: false,
    lastEvaluatedAt: new Date(Date.now() - 2 * 864e5).toISOString(),
    delivery: del({ campaigns: 2, held: 2 }),
  },
  {
    // BSP.6 — every yield is the operator's own hand: not an automation conflict to chase.
    id: 'fx-hand', name: 'IT lunchtime lift', type: 'campaign-budget', enabled: true,
    days: 'MON, TUE, WED, THU, FRI', markets: ['IT'], startDate: dayFrom(-6), endDate: null,
    excludeStart: null, excludeEnd: null, excludeRanges: 0, autoRefill: false,
    lastEvaluatedAt: new Date().toISOString(),
    delivery: del({ campaigns: 2, applied: 2, yielded: 2, yieldedBy: [{ ...HAND, count: 2 }] }),
  },
]

/** The route's SQL, verbatim, so the grains are verified and not merely rendered. */
async function hourly(market: string | null, grain: 'hour' | 'weekday' | 'cell') {
  const since = (() => { const d = new Date(); d.setUTCDate(d.getUTCDate() - 60); d.setUTCHours(0, 0, 0, 0); return d })()
  const until = new Date()
  const rows = await prisma.$queryRaw<Array<{ dow: number; hour: number; cost: bigint | null; sales: bigint | null; orders: bigint | null; clicks: bigint | null; impressions: bigint | null }>>`
    SELECT EXTRACT(DOW FROM ts_rome)::int AS dow, EXTRACT(HOUR FROM ts_rome)::int AS hour,
           SUM("costMicros") AS cost, SUM(COALESCE("sales7dCents",0)) AS sales,
           SUM(COALESCE("orders7d",0)) AS orders, SUM("clicks") AS clicks, SUM("impressions") AS impressions
    FROM (
      SELECT (("date" + (("hour")::text || ' hours')::interval) AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Rome') AS ts_rome,
             "costMicros", "sales7dCents", "orders7d", "clicks", "impressions", "marketplace"
      FROM "AmazonAdsHourlyPerformance"
      WHERE "date" >= ${since} AND "date" <= ${until}
    ) t
    WHERE (${market}::text IS NULL OR "marketplace" = ${market})
    GROUP BY dow, hour ORDER BY dow, hour`
  const bucket = (rs: typeof rows, key: { hour?: number; dow?: number }) => {
    const spend = rs.reduce((a, r) => a + Number(r.cost ?? 0n), 0) / 1e6
    const sales = rs.reduce((a, r) => a + Number(r.sales ?? 0n), 0) / 100
    return {
      ...key,
      spend: Math.round(spend * 100) / 100, sales: Math.round(sales * 100) / 100,
      orders: rs.reduce((a, r) => a + Number(r.orders ?? 0n), 0),
      clicks: rs.reduce((a, r) => a + Number(r.clicks ?? 0n), 0),
      impressions: rs.reduce((a, r) => a + Number(r.impressions ?? 0n), 0),
      acos: sales > 0 ? Math.round((spend / sales) * 1000) / 10 : null,
    }
  }
  const series = grain === 'weekday'
    ? Array.from({ length: 7 }, (_, d) => bucket(rows.filter((r) => Number(r.dow) === d), { dow: d }))
    : grain === 'cell'
      ? rows.map((r) => bucket([r], { dow: Number(r.dow), hour: Number(r.hour) }))
      : Array.from({ length: 24 }, (_, h) => bucket(rows.filter((r) => Number(r.hour) === h), { hour: h }))
  return {
    groupBy: grain, timezone: 'Europe/Rome', marketplace: market,
    windowStart: iso(since), windowEnd: iso(until),
    hasData: rows.length > 0,
    bucketsWithoutSales: series.filter((s) => s.acos == null).length,
    series,
  }
}

/** The context strip's readings, run for real. */
async function context(market: string | null) {
  const where = { status: 'ENABLED' as const, ...(market ? { marketplace: market } : {}) }
  const campaigns = await prisma.campaign.findMany({
    where, select: { id: true, name: true, marketplace: true, dailyBudget: true, deliveryStatus: true, deliveryReasons: true, budgetBaselineCents: true },
  })
  const outOfBudget = campaigns.filter((c) => {
    const reasons = Array.isArray(c.deliveryReasons) ? (c.deliveryReasons as unknown[]).map(String) : []
    return c.deliveryStatus === 'NOT_DELIVERING' && reasons.some((r) => r.includes('OUT_OF_BUDGET'))
  })
  const since = new Date(Date.now() - 24 * 3600e3)
  const [logRows, queueRows] = await Promise.all([
    prisma.advertisingActionLog.count({ where: { actionType: 'AD_BUDGET_UPDATE', createdAt: { gte: since } } }),
    prisma.outboundSyncQueue.groupBy({ by: ['syncStatus'], where: { syncType: 'AD_BUDGET_UPDATE', createdAt: { gte: since } }, _count: { _all: true } }),
  ])
  return {
    marketplace: market,
    enabledCampaigns: campaigns.length,
    atFloor: campaigns.filter((c) => Number(c.dailyBudget ?? 0) <= 1).length,
    withBaseline: campaigns.filter((c) => c.budgetBaselineCents != null).length,
    outOfBudget: outOfBudget.length,
    outOfBudgetSample: outOfBudget.slice(0, 3).map((c) => ({ id: c.id, name: c.name, marketplace: c.marketplace })),
    budgetWrites24h: logRows,
    budgetWritesDelivered24h: queueRows.find((r) => r.syncStatus === 'SUCCESS')?._count._all ?? 0,
    budgetWritesBlocked24h: queueRows.filter((r) => ['SKIPPED', 'FAILED', 'CANCELLED'].includes(r.syncStatus)).reduce((a, r) => a + r._count._all, 0),
    dayMove: { dropPct: 30, risePct: 50, riseAbsEur: 10 },
  }
}

createServer(async (req, res) => {
  const origin = req.headers.origin ?? 'http://localhost:3007'
  res.setHeader('access-control-allow-origin', origin)
  res.setHeader('access-control-allow-credentials', 'true')
  res.setHeader('access-control-allow-headers', 'content-type')
  res.setHeader('access-control-allow-methods', 'GET,POST,PATCH,DELETE,OPTIONS')
  res.setHeader('access-control-allow-private-network', 'true')
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
  const [url, qs] = (req.url ?? '').split('?')
  const params = new URLSearchParams(qs ?? '')
  const market = params.get('marketplace') && params.get('marketplace') !== 'all' ? params.get('marketplace')!.toUpperCase() : null
  const json = (code: number, body: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
  const log = (l: string) => console.log(`[bsp-stub] ${l}`)

  try {
    if (url === '/api/advertising/budget-schedules' && req.method === 'GET') {
      const visible = market ? FIXTURES.filter((s) => s.markets.length === 0 || s.markets.includes(market)) : FIXTURES
      log(`GET schedules market=${market ?? 'all'} → ${visible.length} of ${FIXTURES.length}`)
      return json(200, { items: visible, count: visible.length, total: FIXTURES.length, marketplace: market })
    }
    if (url === '/api/advertising/budget-schedules/hourly-performance' && req.method === 'GET') {
      const g = params.get('groupBy')
      const grain = g === 'weekday' ? 'weekday' : g === 'cell' ? 'cell' : 'hour'
      const out = await hourly(market, grain)
      log(`GET hourly market=${market ?? 'all'} grain=${grain} → ${out.series.length} buckets, ${out.bucketsWithoutSales} without sales`)
      return json(200, out)
    }
    /**
     * The builder's per-campaign heatmap, which feeds the BSP-B5 starters. Same reason as the
     * campaign picker: prod's copy needs `ads.view` and this rig has no session, so a proxied call
     * 401s and the starters would render "no hourly spend" against an account that has 90 days of
     * it — a rig artefact that looks exactly like a product defect. Served from prod Neon in the
     * `RawCell` shape the builder reads.
     */
    if (url === '/api/advertising/dayparting/heatmap' && req.method === 'GET') {
      const ids = (params.get('campaignIds') ?? '').split(',').map((x) => x.trim()).filter(Boolean)
      const days = Number(params.get('windowDays') ?? 60)
      const tz = params.get('tz') || 'Europe/Rome'
      const since = new Date(); since.setUTCDate(since.getUTCDate() - days); since.setUTCHours(0, 0, 0, 0)
      const rows = ids.length ? await prisma.$queryRaw<Array<{ dow: number; hour: number; cost: bigint; sales: bigint; orders: bigint; clicks: bigint; impressions: bigint }>>`
        SELECT EXTRACT(DOW FROM ts)::int AS dow, EXTRACT(HOUR FROM ts)::int AS hour,
               SUM("costMicros") AS cost, SUM(COALESCE("sales7dCents",0)) AS sales,
               SUM(COALESCE("orders7d",0)) AS orders, SUM("clicks") AS clicks, SUM("impressions") AS impressions
        FROM (
          SELECT (("date" + (("hour")::text || ' hours')::interval) AT TIME ZONE 'UTC' AT TIME ZONE ${tz}) AS ts,
                 "costMicros","sales7dCents","orders7d","clicks","impressions","localEntityId"
          FROM "AmazonAdsHourlyPerformance" WHERE "date" >= ${since}
        ) AS t WHERE "localEntityId" = ANY(${ids}::text[])
        GROUP BY dow, hour ORDER BY dow, hour` : []
      const cells = rows.map((r) => {
        const costCents = Math.round(Number(r.cost) / 1e4)
        const salesCents = Number(r.sales)
        return {
          dow: Number(r.dow), hour: Number(r.hour), costCents, salesCents,
          orders: Number(r.orders), clicks: Number(r.clicks), impressions: Number(r.impressions),
          acos: salesCents > 0 ? Math.round((costCents / salesCents) * 1000) / 10 : null,
          roas: costCents > 0 ? Math.round((salesCents / costCents) * 100) / 100 : null,
        }
      })
      log(`GET heatmap ids=${ids.length} → ${cells.length} cells, spend €${(cells.reduce((a, c) => a + c.costCents, 0) / 100).toFixed(2)}`)
      return json(200, { windowDays: days, timezone: tz, hasData: cells.some((c) => c.costCents > 0), cells })
    }
    if (url === '/api/advertising/budget-schedules/context' && req.method === 'GET') {
      const out = await context(market)
      log(`GET context market=${market ?? 'all'} → ${out.enabledCampaigns} enabled, ${out.outOfBudget} out of budget, ${out.budgetWrites24h} writes/24h (${out.budgetWritesBlocked24h} blocked)`)
      return json(200, out)
    }
    if (url?.startsWith('/api/advertising/budget-schedules/') && req.method !== 'GET') {
      log(`SIMULATED ${req.method} ${url} — nothing written`)
      return json(200, { ok: true, simulated: true, restore: { restored: 0, refused: 0 } })
    }
    /**
     * The campaign picker. Prod's `/advertising/campaigns` requires `ads.view` and this rig cannot
     * forward the operator's session cookie, so it is served from the SAME prod database instead —
     * a real read of real campaigns, which is what the picker needs to be worth clicking.
     */
    if (url === '/api/advertising/campaigns' && req.method === 'GET') {
      const rows = await prisma.campaign.findMany({
        where: { status: { not: 'ARCHIVED' } },
        select: { id: true, name: true, marketplace: true, status: true, targetingType: true, adProduct: true, dailyBudget: true, portfolioId: true },
        orderBy: { name: 'asc' },
        take: Number(params.get('limit') ?? 500),
      })
      log(`GET campaigns → ${rows.length}`)
      // `items` is the key CampaignSection reads (it falls back to a bare array; `campaigns` is
      // NOT one of the shapes it accepts, which is how a 219-row response rendered "No campaigns match").
      const items = rows.map((c) => ({ ...c, dailyBudget: c.dailyBudget == null ? null : Number(c.dailyBudget) }))
      return json(200, { items, campaigns: items, count: items.length })
    }
    if (req.method === 'GET') {
      const r = await fetch(`${PROD}${url}${qs ? `?${qs}` : ''}`)
      const body = await r.text()
      res.writeHead(r.status, { 'content-type': r.headers.get('content-type') ?? 'application/json' })
      res.end(body)
      return
    }
    log(`UNHANDLED ${req.method} ${url}`)
    return json(200, { ok: true, simulated: true })
  } catch (e) {
    log(`ERROR ${req.method} ${url}: ${String(e)}`)
    return json(500, { error: String(e) })
  }
}).listen(PORT, () => console.log(`[bsp-stub] listening on :${PORT} — hourly + context are REAL reads of prod; schedules are fixtures (prod has 0 rows); writes simulated`))
