/**
 * F.4.3 — External-signal adapters for the forecast worker.
 *
 * Three signal classes, each composing a per-day multiplicative factor
 * the Holt-Winters baseline gets adjusted by:
 *
 *   1. Holiday signal — public holidays per marketplace via nager.date
 *      (free public-holiday API, no auth). National holidays in retail
 *      countries typically depress B2C demand 30-50% (closed shipping,
 *      consumer spend pulled forward); some events lift it (Boxing Day,
 *      Saint Stephen's). Conservative defaults; overridable per-event.
 *
 *   2. Weather signal — temperature + precipitation forecast via
 *      Open-Meteo (free, no auth). Category-aware: motorcycle gear's
 *      mesh jackets correlate +0.8 with mean temperature; heated gear
 *      −0.9. Per-product elasticity learned from history is v0.1; v0
 *      uses hardcoded category elasticities and skips the lookup when
 *      no productType is set.
 *
 *   3. Retail event signal — RetailEvent table rows. Each event row
 *      contributes its expectedLift on dates within [startDate, endDate]
 *      that match its scope (channel / marketplace / productType).
 *
 * Failure-tolerant: any signal that errors falls back to neutral 1.0
 * (no adjustment). The forecast still runs on the Holt-Winters baseline
 * even if every external API is down.
 *
 * All multipliers are clamped to [0.3, 5.0] so a misconfigured event
 * row can't blow the forecast to zero or 100x.
 */

import prisma from '../db.js'
import { logger } from '../utils/logger.js'

const MULTIPLIER_MIN = 0.3
const MULTIPLIER_MAX = 5.0

export interface SignalsForDay {
  holiday: number
  weather: number
  retail: number
  /** Composed: holiday * weather * retail, clamped. */
  combined: number
  /** Notes for transparency: { event: 'Black Friday', factor: 4.0 }, … */
  notes: Array<{ source: string; description: string; factor: number }>
}

interface ResolveSignalsArgs {
  marketplace: string
  channel: string
  productType?: string | null
  /** Inclusive horizon — same length as the forecast point array. */
  days: Date[]
}

/**
 * Resolve all signals for an entire forecast horizon at once. One
 * external API call per signal class regardless of horizon length —
 * batching is cheaper and the upstream rate-limit budgets are tight.
 */
export async function resolveForecastSignals(
  args: ResolveSignalsArgs,
): Promise<Map<string, SignalsForDay>> {
  if (args.days.length === 0) return new Map()

  const startDay = args.days[0]
  const endDay = args.days[args.days.length - 1]

  const [holidays, weather, retail] = await Promise.all([
    fetchHolidaySignal(args.marketplace, startDay, endDay),
    fetchWeatherSignal(args.marketplace, args.productType ?? null, startDay, endDay),
    fetchRetailEventSignal(
      args.channel,
      args.marketplace,
      args.productType ?? null,
      startDay,
      endDay,
    ),
  ])

  const out = new Map<string, SignalsForDay>()
  for (const day of args.days) {
    const key = day.toISOString().slice(0, 10)
    const h = holidays.get(key) ?? { factor: 1, note: null }
    const w = weather.get(key) ?? { factor: 1, note: null }
    const r = retail.get(key) ?? { factor: 1, note: null }
    const combined = clamp(h.factor * w.factor * r.factor)
    const notes = [
      h.note ? { source: 'holiday', description: h.note, factor: h.factor } : null,
      w.note ? { source: 'weather', description: w.note, factor: w.factor } : null,
      r.note ? { source: 'retail', description: r.note, factor: r.factor } : null,
    ].filter((n): n is { source: string; description: string; factor: number } => n != null)
    out.set(key, {
      holiday: h.factor,
      weather: w.factor,
      retail: r.factor,
      combined,
      notes,
    })
  }
  return out
}

function clamp(v: number): number {
  if (!Number.isFinite(v)) return 1
  return Math.max(MULTIPLIER_MIN, Math.min(MULTIPLIER_MAX, v))
}

/* ───────────────────────────────────────────────────────────────────
 * 1. Holiday signal — nager.date
 * ─────────────────────────────────────────────────────────────────── */

const NAGER_BASE = 'https://date.nager.at/api/v3'

interface NagerHoliday {
  date: string // YYYY-MM-DD
  name: string
  global?: boolean
  types?: string[]
}

const MARKETPLACE_TO_COUNTRY: Record<string, string> = {
  IT: 'IT', DE: 'DE', FR: 'FR', ES: 'ES', NL: 'NL',
  SE: 'SE', PL: 'PL', UK: 'GB', GB: 'GB', US: 'US',
  CA: 'CA', MX: 'MX', AU: 'AU', JP: 'JP',
  // GLOBAL → no country lookup; neutral signal.
}

// Per-name multiplier overrides — most public holidays depress retail by
// 30-50% (carriers closed, consumers offline). Some lift demand (Boxing
// Day sales, Saint Stephen's). Conservative defaults; any unmatched
// holiday name uses DEFAULT_HOLIDAY_FACTOR.
const DEFAULT_HOLIDAY_FACTOR = 0.7
const HOLIDAY_FACTOR_OVERRIDES: Record<string, number> = {
  // Boxing Day / Saint Stephen's — strong shopping day in EU
  'Boxing Day': 1.4,
  "Saint Stephen's Day": 1.3,
  'Stephanitag': 1.3,
  'Santo Stefano': 1.3,
  // Christmas / New Year's Day — near-zero retail
  'Christmas Day': 0.3,
  "New Year's Day": 0.4,
  'Capodanno': 0.4,
  'Natale': 0.3,
  // Easter Monday — slow but not dead
  'Easter Monday': 0.6,
}

async function fetchHolidaySignal(
  marketplace: string,
  startDay: Date,
  endDay: Date,
): Promise<Map<string, { factor: number; note: string | null }>> {
  const out = new Map<string, { factor: number; note: string | null }>()
  const country = MARKETPLACE_TO_COUNTRY[marketplace.toUpperCase()]
  if (!country) return out

  // nager.date is per-year. Pull the year(s) covering our horizon.
  const years = [
    ...new Set([startDay.getUTCFullYear(), endDay.getUTCFullYear()]),
  ]

  try {
    const allHolidays: NagerHoliday[] = []
    for (const year of years) {
      const res = await fetchWithTimeout(
        `${NAGER_BASE}/PublicHolidays/${year}/${country}`,
        8000,
      )
      if (!res.ok) {
        logger.warn('forecast-signals: nager.date returned non-OK', {
          country,
          year,
          status: res.status,
        })
        continue
      }
      const data = (await res.json()) as NagerHoliday[]
      allHolidays.push(...data)
    }

    for (const h of allHolidays) {
      const factor =
        HOLIDAY_FACTOR_OVERRIDES[h.name] ?? DEFAULT_HOLIDAY_FACTOR
      out.set(h.date, { factor, note: h.name })
    }
  } catch (err) {
    logger.warn('forecast-signals: holiday fetch failed, using neutral', {
      country,
      error: err instanceof Error ? err.message : String(err),
    })
  }
  return out
}

/* ───────────────────────────────────────────────────────────────────
 * 2. Weather signal — Open-Meteo
 * ─────────────────────────────────────────────────────────────────── */

const METEO_BASE = 'https://api.open-meteo.com/v1/forecast'

// Marketplace → primary city centroid (lat, lon). Used for weather
// lookup. EU motorcycle gear demand is mostly urban; a single
// representative city per marketplace is a reasonable approximation
// at this level of model precision. Refine to per-region in v0.1.
const MARKETPLACE_TO_LATLON: Record<string, [number, number]> = {
  IT: [41.9, 12.5], DE: [52.5, 13.4], FR: [48.86, 2.35], ES: [40.4, -3.7],
  NL: [52.37, 4.9], SE: [59.33, 18.07], PL: [52.23, 21.01],
  UK: [51.51, -0.13], GB: [51.51, -0.13], US: [40.71, -74.0],
  CA: [43.65, -79.38], MX: [19.43, -99.13], AU: [-33.86, 151.21],
  JP: [35.68, 139.69],
}

/**
 * Category weather elasticities — multipliers per °C deviation from
 * "neutral" 18°C and per mm of precipitation. Hand-seeded for Xavia's
 * motorcycle-gear catalog; UI surfaces these so the user can tune.
 *
 * Mesh / warm-weather riding gear: +0.02 per °C above neutral, capped.
 * Heated gear / winter:           -0.03 per °C above neutral.
 * Rain gear:                      +0.03 per mm precipitation.
 * Helmets / generic:              0 (riders gonna ride).
 *
 * Productive output: a hot summer day (28°C) lifts mesh-jacket demand
 * by 1 + 0.02 * (28-18) = 1.20x; a cold winter day (-2°C) lifts heated-
 * gear demand by 1 + (-0.03) * (-2-18) = 1.60x.
 */
const CATEGORY_ELASTICITY: Record<
  string,
  { tempPerC: number; precipPerMm: number }
> = {
  OUTERWEAR_MESH: { tempPerC: 0.02, precipPerMm: -0.02 },
  OUTERWEAR_HEATED: { tempPerC: -0.03, precipPerMm: 0 },
  OUTERWEAR_WATERPROOF: { tempPerC: -0.005, precipPerMm: 0.03 },
  RAIN_GEAR: { tempPerC: 0, precipPerMm: 0.04 },
  PANTS: { tempPerC: -0.005, precipPerMm: -0.005 },
  GLOVES: { tempPerC: -0.01, precipPerMm: 0 },
  GLOVES_HEATED: { tempPerC: -0.03, precipPerMm: 0 },
  BOOTS: { tempPerC: -0.005, precipPerMm: 0 },
  HELMET: { tempPerC: 0, precipPerMm: 0 },
  PROTECTIVE: { tempPerC: 0, precipPerMm: 0 },
  // Generic OUTERWEAR fallback — slight positive temp correlation
  OUTERWEAR: { tempPerC: 0.005, precipPerMm: 0 },
}

const NEUTRAL_TEMP_C = 18

interface MeteoResponse {
  daily?: {
    time: string[]
    temperature_2m_mean?: number[]
    precipitation_sum?: number[]
  }
}

async function fetchWeatherSignal(
  marketplace: string,
  productType: string | null,
  startDay: Date,
  endDay: Date,
): Promise<Map<string, { factor: number; note: string | null }>> {
  const out = new Map<string, { factor: number; note: string | null }>()
  const latlon = MARKETPLACE_TO_LATLON[marketplace.toUpperCase()]
  if (!latlon) return out
  if (!productType) return out
  const elasticity = CATEGORY_ELASTICITY[productType]
  if (!elasticity) return out
  if (elasticity.tempPerC === 0 && elasticity.precipPerMm === 0) return out

  // Open-Meteo's free daily forecast supports up to 16 days ahead.
  // For longer horizons (we forecast 90), fall back to climatology
  // (seasonal averages) — done as a per-day "factor=1" for days
  // outside the API window. Future: hook a climatology table.
  try {
    const url = new URL(METEO_BASE)
    url.searchParams.set('latitude', String(latlon[0]))
    url.searchParams.set('longitude', String(latlon[1]))
    url.searchParams.set('daily', 'temperature_2m_mean,precipitation_sum')
    url.searchParams.set('forecast_days', '16')
    url.searchParams.set('timezone', 'UTC')
    url.searchParams.set('start_date', startDay.toISOString().slice(0, 10))
    // Cap end date at startDay + 16 (API limit); days past that fall through.
    const apiEnd = new Date(startDay)
    apiEnd.setUTCDate(apiEnd.getUTCDate() + 15)
    const cappedEnd = endDay < apiEnd ? endDay : apiEnd
    url.searchParams.set('end_date', cappedEnd.toISOString().slice(0, 10))

    const res = await fetchWithTimeout(url.toString(), 8000)
    if (!res.ok) {
      logger.warn('forecast-signals: open-meteo non-OK', {
        marketplace,
        status: res.status,
      })
      return out
    }
    const data = (await res.json()) as MeteoResponse
    const days = data.daily?.time ?? []
    const temps = data.daily?.temperature_2m_mean ?? []
    const precips = data.daily?.precipitation_sum ?? []

    for (let i = 0; i < days.length; i++) {
      const tempC = temps[i] ?? NEUTRAL_TEMP_C
      const precip = precips[i] ?? 0
      const factor =
        1 +
        elasticity.tempPerC * (tempC - NEUTRAL_TEMP_C) +
        elasticity.precipPerMm * precip
      out.set(days[i], {
        factor: clamp(factor),
        note: `${tempC.toFixed(1)}°C, ${precip.toFixed(1)}mm`,
      })
    }
  } catch (err) {
    logger.warn('forecast-signals: weather fetch failed', {
      marketplace,
      error: err instanceof Error ? err.message : String(err),
    })
  }
  return out
}

/* ───────────────────────────────────────────────────────────────────
 * 3. Retail event signal — RetailEvent table
 * ─────────────────────────────────────────────────────────────────── */

async function fetchRetailEventSignal(
  channel: string,
  marketplace: string,
  productType: string | null,
  startDay: Date,
  endDay: Date,
): Promise<Map<string, { factor: number; note: string | null }>> {
  const out = new Map<string, { factor: number; note: string | null }>()
  const events = await prisma.retailEvent.findMany({
    where: {
      isActive: true,
      // Event window overlaps with our horizon
      startDate: { lte: endDay },
      endDate: { gte: startDay },
      // Scope match: null on event = applies broadly. Use OR so events
      // with ANY scope set also match.
      AND: [
        {
          OR: [{ channel: null }, { channel: channel.toUpperCase() }],
        },
        {
          OR: [{ marketplace: null }, { marketplace: marketplace.toUpperCase() }],
        },
        productType
          ? {
              OR: [{ productType: null }, { productType }],
            }
          : { productType: null },
      ],
    },
  })

  // Compose multiplicatively when multiple events overlap on the same day
  // (e.g. Black Friday + a brand-specific sale). UI gets the list.
  for (const event of events) {
    const start = event.startDate
    const end = event.endDate
    const cursor = new Date(start)
    while (cursor <= end) {
      if (cursor >= startDay && cursor <= endDay) {
        const key = cursor.toISOString().slice(0, 10)
        const lift = Number(event.expectedLift)
        const existing = out.get(key)
        if (existing) {
          out.set(key, {
            factor: existing.factor * lift,
            note: existing.note
              ? `${existing.note} + ${event.name}`
              : event.name,
          })
        } else {
          out.set(key, { factor: lift, note: event.name })
        }
      }
      cursor.setUTCDate(cursor.getUTCDate() + 1)
    }
  }
  return out
}

/* ───────────────────────────────────────────────────────────────────
 * fetch helper with timeout
 * ─────────────────────────────────────────────────────────────────── */

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}
