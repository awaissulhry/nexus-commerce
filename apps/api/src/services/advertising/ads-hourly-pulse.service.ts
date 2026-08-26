/**
 * GX.5 — the hourly report, rebuilt around the one thing it can do that nothing else can.
 *
 * It was a flat list of campaign-hours, which is the least useful shape for a feed whose entire
 * value is that it is current to THIS HOUR while every other feed is a day or more behind.
 *
 * Three questions it can answer and the daily reports cannot:
 *   · what is happening right now, and is it normal for this hour?
 *   · which hour of which weekday actually converts — the dayparting substrate;
 *   · and per market, because a share of attention pooled across four markets is nobody's day.
 *
 * ── 🔴 Two facts that decide how this must be read ────────────────────────────
 *
 * 1. **The hours are UTC**, exactly as Amazon Marketing Stream delivers them, and they are NOT
 *    converted. That is not laziness: Amazon's budget day also rolls at 00:00 UTC, not at
 *    marketplace midnight, so a dayparting or budget decision taken in local time is taken
 *    against the wrong day boundary. The surface says UTC everywhere rather than quietly
 *    shifting the numbers into a timezone the money does not use.
 *
 * 2. **This table is 100% stream-written**, so `EXCLUDE_AMS_DAILY` must NEVER be applied to it —
 *    all 33,099 rows carry that marker and the filter would return nothing. That is not a
 *    hypothetical: it happened in the campaign detail page's intraday overlay, which summed zero
 *    from the day it shipped. See the note on the constant itself.
 *
 * ── What the stream can and cannot carry ──────────────────────────────────────
 *
 * CAMPAIGN grain only. There are no product or target rows in it, so an hourly drill-down stops
 * at the campaign — three levels, not four. Saying so is better than drawing a chevron that
 * opens nothing.
 */
import prisma from '../../db.js'

/** Sunday-first, matching Postgres `EXTRACT(DOW)`. */
const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export interface HourPoint {
  hour: number
  impressions: number
  clicks: number
  cost: number
  sales: number
  orders: number
}

export interface HeatCell {
  weekday: number
  hour: number
  /** Null where the window holds no rows for that weekday-hour at all — never a measured zero. */
  cost: number | null
  clicks: number | null
  sales: number | null
  orders: number | null
  acos: number | null
  cvr: number | null
  /** How many distinct days contributed, so a cell built from one day is not read as a pattern. */
  days: number
}

export interface HourlyMarket {
  marketplace: string
  lastDay: string | null
  lagDays: number | null
  days: number
  campaigns: number
  /** Nothing enabled and nothing spending — the market is idle, not broken. */
  idle: boolean
}

export interface HourlyCampaign {
  id: string | null
  label: string
  cost: number
  clicks: number
  sales: number
  orders: number
  acos: number | null
  href: string | null
}

export interface HourlyPulse {
  marketplace: string
  /** Today in UTC, which is the day the stream and Amazon's budget both use. */
  today: string
  /** The last hour that has any row today, or null before the first delivery of the day. */
  throughHour: number | null
  comparisonDay: string
  todaySeries: HourPoint[]
  comparisonSeries: HourPoint[]
  totals: { today: HourPoint; comparison: HourPoint }
  heat: HeatCell[]
  heatWindowDays: number
  topCampaigns: HourlyCampaign[]
  markets: HourlyMarket[]
  caveats: string[]
  elapsedMs: number
}

const n = (v: unknown): number => {
  if (v == null) return 0
  const x = typeof v === 'bigint' ? Number(v) : Number(v as number)
  return Number.isFinite(x) ? x : 0
}
const ratio = (a: number, b: number): number | null => (b > 0 ? a / b : null)

const EMPTY: HourPoint = { hour: -1, impressions: 0, clicks: 0, cost: 0, sales: 0, orders: 0 }

export async function hourlyPulse(opts: {
  marketplace: string
  /** Days of history behind the heat grid. */
  heatWindowDays?: number
}): Promise<HourlyPulse> {
  const started = Date.now()
  const market = opts.marketplace
  const heatWindowDays = Math.max(7, Math.min(180, opts.heatWindowDays ?? 56))

  // UTC, deliberately — see the header. `CURRENT_DATE` on the server is not guaranteed UTC, so
  // the day is computed here and passed in.
  const nowUtc = new Date()
  const today = nowUtc.toISOString().slice(0, 10)
  const lastWeek = new Date(nowUtc.getTime() - 7 * 86_400_000).toISOString().slice(0, 10)

  const [dayRows, heatRows, campRows, marketRows] = await Promise.all([
    prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
      SELECT "date"::text AS day, "hour",
             SUM("impressions")::bigint AS impressions, SUM("clicks")::bigint AS clicks,
             SUM("costMicros")::numeric / 1000000.0 AS cost,
             SUM(COALESCE("sales7dCents", 0))::numeric / 100.0 AS sales,
             SUM(COALESCE("orders7d", 0))::bigint AS orders
      FROM "AmazonAdsHourlyPerformance"
      WHERE "entityType" = 'CAMPAIGN' AND "marketplace" = $1 AND "date" IN ($2::date, $3::date)
      GROUP BY 1, 2 ORDER BY 1, 2`, market, today, lastWeek),

    prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
      SELECT EXTRACT(DOW FROM "date")::int AS weekday, "hour",
             COUNT(DISTINCT "date")::int AS days,
             SUM("costMicros")::numeric / 1000000.0 AS cost,
             SUM("clicks")::bigint AS clicks,
             SUM(COALESCE("sales7dCents", 0))::numeric / 100.0 AS sales,
             SUM(COALESCE("orders7d", 0))::bigint AS orders
      FROM "AmazonAdsHourlyPerformance"
      WHERE "entityType" = 'CAMPAIGN' AND "marketplace" = $1
        AND "date" >= ($2::date - ${heatWindowDays})
      GROUP BY 1, 2`, market, today),

    prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
      SELECT h."localEntityId" AS id, COALESCE(c."name", h."entityId") AS label,
             SUM(h."costMicros")::numeric / 1000000.0 AS cost,
             SUM(h."clicks")::bigint AS clicks,
             SUM(COALESCE(h."sales7dCents", 0))::numeric / 100.0 AS sales,
             SUM(COALESCE(h."orders7d", 0))::bigint AS orders
      FROM "AmazonAdsHourlyPerformance" h
      LEFT JOIN "Campaign" c ON c."id" = h."localEntityId"
      WHERE h."entityType" = 'CAMPAIGN' AND h."marketplace" = $1 AND h."date" = $2::date
      GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 12`, market, today),

    // Per market, so the picker can say which ones have anything and which are simply idle.
    prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
      SELECT h."marketplace", MAX(h."date")::text AS last_day,
             COUNT(DISTINCT h."date")::int AS days,
             COUNT(DISTINCT h."entityId")::int AS campaigns,
             (SELECT COUNT(*) FROM "Campaign" k
              WHERE k."marketplace" = h."marketplace" AND k."status"::text = 'ENABLED')::int AS enabled
      FROM "AmazonAdsHourlyPerformance" h
      WHERE h."entityType" = 'CAMPAIGN'
      GROUP BY 1 ORDER BY 3 DESC`),
  ])

  const series = (day: string): HourPoint[] => {
    const byHour = new Map<number, HourPoint>()
    for (const r of dayRows) {
      if (r.day !== day) continue
      const h = n(r.hour)
      byHour.set(h, {
        hour: h,
        impressions: n(r.impressions), clicks: n(r.clicks),
        cost: n(r.cost), sales: n(r.sales), orders: n(r.orders),
      })
    }
    // Every hour is present so the two days line up; an hour with no row is a real zero here,
    // because the stream delivers a row for any hour the campaign served.
    return Array.from({ length: 24 }, (_, h) => byHour.get(h) ?? { ...EMPTY, hour: h })
  }
  const todaySeries = series(today)
  const comparisonSeries = series(lastWeek)

  const sum = (pts: HourPoint[]): HourPoint => pts.reduce((t, p) => ({
    hour: -1,
    impressions: t.impressions + p.impressions, clicks: t.clicks + p.clicks,
    cost: t.cost + p.cost, sales: t.sales + p.sales, orders: t.orders + p.orders,
  }), { ...EMPTY })

  const seenToday = dayRows.filter((r) => r.day === today).map((r) => n(r.hour))
  const throughHour = seenToday.length ? Math.max(...seenToday) : null

  // The grid is dense by construction: 7 × 24, with null where the window holds nothing.
  const heatBy = new Map<string, Record<string, unknown>>()
  for (const r of heatRows) heatBy.set(`${n(r.weekday)}:${n(r.hour)}`, r)
  const heat: HeatCell[] = []
  for (let w = 0; w < 7; w++) {
    for (let h = 0; h < 24; h++) {
      const r = heatBy.get(`${w}:${h}`)
      if (!r) {
        heat.push({ weekday: w, hour: h, cost: null, clicks: null, sales: null, orders: null, acos: null, cvr: null, days: 0 })
        continue
      }
      const cost = n(r.cost); const clicks = n(r.clicks); const sales = n(r.sales); const orders = n(r.orders)
      heat.push({
        weekday: w, hour: h, cost, clicks, sales, orders,
        acos: ratio(cost, sales), cvr: ratio(orders, clicks), days: n(r.days),
      })
    }
  }

  const markets: HourlyMarket[] = marketRows.map((r) => {
    const last = r.last_day ? String(r.last_day) : null
    // 🔴 Days between two DATES, not elapsed hours rounded. `Date.now()` at 15:59 UTC is 0.66 days
    // past today's midnight, which `Math.round` turned into 1 — so the live stream, current to
    // this hour, reported itself as a day behind. Compare the calendar days.
    const todayMs = Date.parse(`${today}T00:00:00Z`)
    const lag = last ? Math.round((todayMs - Date.parse(`${last}T00:00:00Z`)) / 86_400_000) : null
    return {
      marketplace: String(r.marketplace),
      lastDay: last,
      lagDays: lag,
      days: n(r.days),
      campaigns: n(r.campaigns),
      // Idle is not broken: a market with nothing enabled produces no stream rows by construction.
      idle: n(r.enabled) === 0,
    }
  })

  const caveats: string[] = [
    'Hours are UTC, exactly as Amazon Marketing Stream delivers them, and are not converted. Amazon’s budget day also rolls at 00:00 UTC rather than at marketplace midnight, so a dayparting or budget decision taken in local time is taken against the wrong day boundary.',
    'The stream carries campaign rows only — there are no product or target rows in it, so this feed cannot be broken down below a campaign.',
  ]
  const mine = markets.find((m) => m.marketplace === market)
  if (mine?.idle) {
    caveats.push(`${market} has no enabled campaigns, so it produces no stream rows. Its last delivery was ${mine.lastDay ?? 'never'} — idle, not broken.`)
  }
  const thin = heat.filter((c) => c.days > 0 && c.days < 3).length
  if (thin > 0) {
    caveats.push(`${thin} of the 168 weekday-hour cells rest on fewer than three days of history. A cell built from one day is a reading, not a pattern.`)
  }
  const empty = heat.filter((c) => c.days === 0).length
  if (empty > 0) {
    caveats.push(`${empty} cells hold no rows at all in this window and are drawn hatched rather than as a zero — absence and “nothing spent” are different answers.`)
  }

  return {
    marketplace: market,
    today,
    throughHour,
    comparisonDay: lastWeek,
    todaySeries,
    comparisonSeries,
    totals: { today: sum(todaySeries), comparison: sum(comparisonSeries) },
    heat,
    heatWindowDays,
    topCampaigns: campRows.map((r) => {
      const cost = n(r.cost); const sales = n(r.sales)
      return {
        id: r.id ? String(r.id) : null,
        label: String(r.label),
        cost, clicks: n(r.clicks), sales, orders: n(r.orders),
        acos: ratio(cost, sales),
        href: r.id ? `/marketing/ads/campaigns/${r.id}` : null,
      }
    }),
    markets,
    caveats,
    elapsedMs: Date.now() - started,
  }
}

export { DAY_LABELS }
