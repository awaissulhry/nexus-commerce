/**
 * SQP catch-up — the older weeks the nightly pass missed, asked for again, a few a night.
 *
 * 🔴 Why. The nightly request pass asks only for the newest complete week (`SQP_LOOKBACK` = 1). A week
 * it failed to ask for was never asked for again. Until #483 the channel gateway refused most nightly
 * `createReport` calls ("Not sent yet … Retry later."), so — measured 2026-10-07 — Amazon IT holds no
 * week after 2026-08-16, DE none after 08-23, ES none after 09-06. The Share-of-Voice gate reads 8 weeks
 * back (`SOV_DEFAULT_WEEKS`, 56 days) and rank-runtime stops trusting SQP after 28 days
 * (`SQP_STALL_DAYS`), so a gap only closes if somebody asks for it — and IT's last week leaves the
 * 56-day window on 2026-10-11.
 *
 * What it asks for, after the normal week and inside the same paced pass and time budget:
 *   · only complete weeks still useful to Share of Voice: lookback `SQP_LOOKBACK + 1` up to
 *     `maxLookback` (the job passes `SOV_DEFAULT_WEEKS - 2`, so the oldest week asked still has a week
 *     of life inside the 56-day window after it is collected);
 *   · newest first, and every market's newest gap before any market's older one (week-major), so one
 *     market with a long gap cannot take a whole night;
 *   · at most `maxUnits` (market × week) a night;
 *   · per week only the market's best-yielding PROVEN ASINs, at most `asinsPerWeek`. A catch-up fills a
 *     gap; exploring never-asked ASINs is the normal pass's job.
 *
 * What it skips: an ASIN that already has an answer for that week — rows held in
 * SearchQueryPerformance, a report in flight (PENDING / DONE), an ingest, or Amazon's own
 * FATAL / CANCELLED. The ASIN set is the top `asinsPerWeek` proven ASINs FIRST and the answered ones are
 * taken out AFTER, so a covered week costs nothing and drops out by itself instead of reaching further
 * down the ranking every night.
 *
 * Pure, so the rule is tested without Amazon or the database; the job supplies the facts.
 */

/** (market × week) units asked for per night. `NEXUS_SQP_CATCHUP_WEEKS=0` switches the catch-up off. */
export const SQP_CATCHUP_WEEKS_PER_NIGHT = envInt('NEXUS_SQP_CATCHUP_WEEKS', 4)
/** Proven ASINs asked for per caught-up week. */
export const SQP_CATCHUP_ASINS_PER_WEEK = envInt('NEXUS_SQP_CATCHUP_ASINS', 6)

/** Statuses that are an answer for an (ASIN, week): leave it alone. ERROR and EXPIRED may be asked again. */
export const SQP_CATCHUP_ANSWERED_STATUSES = ['PENDING', 'DONE', 'INGESTED', 'FATAL', 'CANCELLED'] as const

export interface CatchUpWeek { start: Date; end: Date }

export interface CatchUpMarket {
  mkt: string
  /** The market's PROVEN ASINs (they have returned rows before), best yield first. */
  proven: string[]
  /** `YYYY-MM-DD` week start → the ASINs that already have an answer for that week. */
  answered: ReadonlyMap<string, ReadonlySet<string>>
}

export interface CatchUpUnit {
  mkt: string
  week: CatchUpWeek
  /** The ASINs to ask for, in yield order. Never empty. */
  asins: string[]
}

export const weekKey = (d: Date): string => d.toISOString().slice(0, 10)

/** The lookbacks the catch-up may ask for, newest first: `from` … `to`, both included. */
export function catchUpLookbacks(from: number, to: number): number[] {
  const out: number[] = []
  for (let k = Math.max(1, Math.floor(from)); k <= Math.floor(to); k++) out.push(k)
  return out
}

/**
 * Which (market × week) to ask for tonight. `weeks` newest first, `markets` in tonight's order.
 * Returns the units chosen and how many gaps there were in all (chosen + left for later nights).
 */
export function planCatchUp(args: {
  markets: readonly CatchUpMarket[]
  weeks: readonly CatchUpWeek[]
  maxUnits: number
  asinsPerWeek: number
}): { units: CatchUpUnit[]; gaps: number } {
  const maxUnits = Math.max(0, Math.floor(args.maxUnits))
  const perWeek = Math.max(0, Math.floor(args.asinsPerWeek))
  const units: CatchUpUnit[] = []
  let gaps = 0
  if (perWeek === 0) return { units, gaps }
  for (const week of args.weeks) {
    const key = weekKey(week.start)
    for (const m of args.markets) {
      const top = m.proven.slice(0, perWeek)
      const answered = m.answered.get(key)
      const asins = answered ? top.filter((a) => !answered.has(a)) : top
      if (asins.length === 0) continue
      gaps++
      if (units.length < maxUnits) units.push({ mkt: m.mkt, week, asins })
    }
  }
  return { units, gaps }
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw == null || raw.trim() === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback
}
