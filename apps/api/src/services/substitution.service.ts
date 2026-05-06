/**
 * R.17 — Substitution-aware demand service.
 *
 * Pure function: adjustDemandForSubstitution() takes a SKU's daily
 * series + its substitution links + relevant stockout windows and
 * returns the adjusted series.
 *
 * Two cases (additive in one pass):
 *
 *   A) productId is the PRIMARY in some links. Primary went out of
 *      stock; some of the substitute's sales during that window are
 *      "stolen demand" credited back to the primary.
 *
 *      adjusted_primary[day] = own[day] +
 *        Σ over (primary's stockout windows that include day) of
 *          Σ over (substitute links where this is primary) of
 *            substitutionFraction × substitute_sales[day]
 *
 *   B) productId is the SUBSTITUTE in some links. Primary's stockout
 *      drove up substitute's observed sales; remove the "stolen"
 *      portion so substitute's velocity reflects its baseline demand.
 *
 *      adjusted_substitute[day] = own[day] -
 *        Σ over (primary's stockout windows that include day) of
 *          substitutionFraction × own[day]
 *
 *      Clamps to 0 — substitute's adjusted demand can't go below 0.
 *
 * v1 scope:
 *   - Stockout windows are global (locationId considered but not
 *     filtered — if R.12 records location-scoped events, we still
 *     use them as "primary unavailable" signal).
 *   - Forecast cron keeps using raw DailySalesAggregate input.
 *     R.17 only adjusts the velocity/σ_d fed into computeRecommendation.
 */

import prisma from '../db.js'

export interface DailyPoint {
  day: string  // YYYY-MM-DD
  units: number
}

export interface SubstitutionLink {
  primaryProductId: string
  substituteProductId: string
  substitutionFraction: number  // 0-1
}

export interface StockoutWindow {
  productId: string
  startedAt: Date
  endedAt: Date | null  // null = still ongoing
}

const DAY_MS = 86400_000

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function* daysInWindow(start: Date, end: Date): Generator<string> {
  const startMs = Math.floor(start.getTime() / DAY_MS) * DAY_MS
  const endMs = end.getTime()
  for (let t = startMs; t <= endMs; t += DAY_MS) {
    yield dayKey(new Date(t))
  }
}

/**
 * Pure function: given own series + links + substitute series +
 * stockout windows, return the adjusted daily series for productId.
 */
export function adjustDemandForSubstitution(args: {
  productId: string
  ownSeries: DailyPoint[]
  links: SubstitutionLink[]
  substituteSeries: Map<string, DailyPoint[]>
  stockoutWindows: StockoutWindow[]
  /** Treat ongoing stockouts (endedAt=null) as ending today. */
  now?: Date
}): DailyPoint[] {
  const now = args.now ?? new Date()

  // Index own series by day for fast lookup.
  const ownByDay = new Map(args.ownSeries.map((p) => [p.day, p.units]))
  const allDays = new Set(args.ownSeries.map((p) => p.day))

  // Index substitute series by (substituteId, day).
  const subByKey = new Map<string, number>()
  for (const [subId, series] of args.substituteSeries) {
    for (const p of series) {
      subByKey.set(`${subId}::${p.day}`, p.units)
      allDays.add(p.day)
    }
  }

  // Categorize links: which substitutes "feed" this productId
  // (productId is primary), and which primaries this productId
  // "substitutes for" (productId is substitute).
  const substitutesForMe = args.links.filter((l) => l.primaryProductId === args.productId)
  const primariesIBackUp = args.links.filter((l) => l.substituteProductId === args.productId)

  // Index stockout windows by productId for O(1) lookup. Also expand
  // each to a Set<day> covered.
  const stockoutDaysByProduct = new Map<string, Set<string>>()
  for (const w of args.stockoutWindows) {
    const end = w.endedAt ?? now
    const set = stockoutDaysByProduct.get(w.productId) ?? new Set<string>()
    for (const day of daysInWindow(w.startedAt, end)) set.add(day)
    stockoutDaysByProduct.set(w.productId, set)
  }

  const adjusted: DailyPoint[] = []
  for (const day of [...allDays].sort()) {
    let units = ownByDay.get(day) ?? 0

    // (A) productId is PRIMARY. During its own stockout windows,
    // credit back substitute sales × fraction.
    const myStockouts = stockoutDaysByProduct.get(args.productId)
    if (myStockouts?.has(day)) {
      for (const link of substitutesForMe) {
        const subUnits = subByKey.get(`${link.substituteProductId}::${day}`) ?? 0
        units += link.substitutionFraction * subUnits
      }
    }

    // (B) productId is SUBSTITUTE. During the PRIMARY's stockout
    // windows, remove the inflated portion of own sales.
    for (const link of primariesIBackUp) {
      const primaryStockouts = stockoutDaysByProduct.get(link.primaryProductId)
      if (primaryStockouts?.has(day)) {
        const ownUnits = ownByDay.get(day) ?? 0
        units -= link.substitutionFraction * ownUnits
      }
    }

    units = Math.max(0, units)  // clamp negatives
    adjusted.push({ day, units: Number(units.toFixed(2)) })
  }

  return adjusted
}

// ─── DB helpers ─────────────────────────────────────────────────

export async function loadSubstitutionLinks(productIds: string[]): Promise<{
  byPrimary: Map<string, SubstitutionLink[]>
  bySubstitute: Map<string, SubstitutionLink[]>
  affectedSubstituteIds: string[]
  affectedPrimaryIds: string[]
}> {
  if (productIds.length === 0) {
    return {
      byPrimary: new Map(),
      bySubstitute: new Map(),
      affectedSubstituteIds: [],
      affectedPrimaryIds: [],
    }
  }
  const rows = await prisma.productSubstitution.findMany({
    where: {
      OR: [
        { primaryProductId: { in: productIds } },
        { substituteProductId: { in: productIds } },
      ],
    },
    select: { primaryProductId: true, substituteProductId: true, substitutionFraction: true },
  })

  const byPrimary = new Map<string, SubstitutionLink[]>()
  const bySubstitute = new Map<string, SubstitutionLink[]>()
  const subSet = new Set<string>()
  const primSet = new Set<string>()

  for (const r of rows) {
    const link: SubstitutionLink = {
      primaryProductId: r.primaryProductId,
      substituteProductId: r.substituteProductId,
      substitutionFraction: Number(r.substitutionFraction),
    }
    const a = byPrimary.get(r.primaryProductId) ?? []
    a.push(link)
    byPrimary.set(r.primaryProductId, a)

    const b = bySubstitute.get(r.substituteProductId) ?? []
    b.push(link)
    bySubstitute.set(r.substituteProductId, b)

    subSet.add(r.substituteProductId)
    primSet.add(r.primaryProductId)
  }

  return {
    byPrimary,
    bySubstitute,
    affectedSubstituteIds: [...subSet],
    affectedPrimaryIds: [...primSet],
  }
}

// ─── CRUD for the operator UI ───────────────────────────────────

export async function listSubstitutionsForProduct(productId: string) {
  const [asPrimary, asSubstitute] = await Promise.all([
    prisma.productSubstitution.findMany({
      where: { primaryProductId: productId },
      include: { substitute: { select: { id: true, sku: true, name: true } } },
      orderBy: { substitutionFraction: 'desc' },
    }),
    prisma.productSubstitution.findMany({
      where: { substituteProductId: productId },
      include: { primary: { select: { id: true, sku: true, name: true } } },
      orderBy: { substitutionFraction: 'desc' },
    }),
  ])
  return { asPrimary, asSubstitute }
}

export async function createSubstitution(args: {
  primaryProductId: string
  substituteProductId: string
  substitutionFraction?: number
  notes?: string
}) {
  const fraction = args.substitutionFraction ?? 0.5
  if (fraction < 0 || fraction > 1) {
    throw new Error('substitutionFraction must be in [0, 1]')
  }
  if (args.primaryProductId === args.substituteProductId) {
    throw new Error('primary and substitute must be different products')
  }
  return prisma.productSubstitution.create({
    data: {
      primaryProductId: args.primaryProductId,
      substituteProductId: args.substituteProductId,
      substitutionFraction: fraction,
      notes: args.notes ?? null,
    },
  })
}

export async function updateSubstitution(
  id: string,
  fields: { substitutionFraction?: number; notes?: string | null },
) {
  if (fields.substitutionFraction != null) {
    if (fields.substitutionFraction < 0 || fields.substitutionFraction > 1) {
      throw new Error('substitutionFraction must be in [0, 1]')
    }
  }
  return prisma.productSubstitution.update({
    where: { id },
    data: {
      substitutionFraction: fields.substitutionFraction,
      notes: fields.notes,
    },
  })
}

export async function deleteSubstitution(id: string) {
  await prisma.productSubstitution.delete({ where: { id } })
}
