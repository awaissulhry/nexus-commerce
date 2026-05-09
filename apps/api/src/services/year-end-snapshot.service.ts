/**
 * T.8 part 2 — Year-end inventory valuation snapshot service.
 *
 * Three exports:
 *   computeYearEndValuation(opts)
 *     Pure aggregation over open StockCostLayer rows (unitsRemaining > 0).
 *     Returns totals + breakdowns by location/method/currency/VAT.
 *     Used by the live GET endpoint AND the snapshot writer.
 *
 *   snapshotYearEndValuation(year, opts?)
 *     Computes + persists into YearEndSnapshot. Idempotent: re-running
 *     for the same year upserts the row.
 *
 *   readYearEndSnapshot(year)
 *     Returns the persisted snapshot if one exists, else null.
 *
 * Why the split: the GET endpoint needs to either read the snapshot
 * (when the operator queries a closed year) or compute live (when
 * the operator queries the current year and no snapshot yet exists).
 * Same shape either way so the UI doesn't branch.
 */

import prisma from '../db.js'

export interface YearEndValuation {
  year: number
  asOf: string
  scope: { locationId: string } | { all: true }
  total: { units: number; valueEurCents: number }
  byLocation: Array<{
    locationId: string | null
    locationCode: string
    locationName: string
    units: number
    valueEurCents: number
  }>
  byMethod: Record<'FIFO' | 'LIFO' | 'WAC', { units: number; valueEurCents: number }>
  byCurrency: Array<{
    currency: string
    units: number
    originalValueCents: number
    valueEurCents: number
  }>
  vatTreatment: {
    netCapitalised: { units: number; valueEurCents: number }
    grossCapitalised: { units: number; valueEurCents: number }
    unknownVat: { units: number; valueEurCents: number }
  }
  layerCount: number
  /** Provenance disclosure. Live = computed from current StockCostLayer
   *  state. Snapshot = read from YearEndSnapshot. */
  source: 'live' | 'snapshot'
  /** When source=snapshot, the operator who triggered the snapshot
   *  may have left a note (e.g. "manually replayed 2024 after late
   *  ECB rate update"). */
  notes?: string | null
}

export interface ComputeOpts {
  /** Label only — informational. Calculation uses asOf. */
  year: number
  /** Cutoff timestamp the snapshot represents. Today, "live"
   *  computes use new Date() — historical asOf reconstruction is a
   *  follow-up (would need to replay StockMovement consumes back from
   *  now to asOf). */
  asOf: Date
  locationId?: string | null
}

/**
 * Pure aggregation — no DB writes. Caller decides whether to persist.
 */
export async function computeYearEndValuation(opts: ComputeOpts): Promise<YearEndValuation> {
  const { year, asOf, locationId } = opts

  const layers = await prisma.stockCostLayer.findMany({
    where: {
      unitsRemaining: { gt: 0 },
      ...(locationId ? { locationId } : {}),
    },
    select: {
      id: true, productId: true, locationId: true,
      unitsRemaining: true, unitCost: true,
      costCurrency: true, exchangeRateOnReceive: true,
      unitCostVatExcluded: true, vatRate: true,
      product: { select: { id: true, sku: true, name: true, costingMethod: true } },
      location: { select: { id: true, code: true, name: true, type: true } },
    },
  })

  let totalValueEurCents = 0
  let totalUnits = 0
  const byLocation = new Map<string, {
    locationId: string | null
    locationCode: string
    locationName: string
    units: number
    valueEurCents: number
  }>()
  const byMethod: YearEndValuation['byMethod'] = {
    FIFO: { units: 0, valueEurCents: 0 },
    LIFO: { units: 0, valueEurCents: 0 },
    WAC: { units: 0, valueEurCents: 0 },
  }
  const byCurrency = new Map<string, { units: number; originalValueCents: number; valueEurCents: number }>()
  const vatBuckets = {
    netCapitalised: { units: 0, valueEurCents: 0 },
    grossCapitalised: { units: 0, valueEurCents: 0 },
    unknownVat: { units: 0, valueEurCents: 0 },
  }

  for (const layer of layers) {
    const unitCostNum = Number(layer.unitCost)
    const valueEurNum = unitCostNum * layer.unitsRemaining
    const valueEurCents = Math.round(valueEurNum * 100)
    totalUnits += layer.unitsRemaining
    totalValueEurCents += valueEurCents

    const locId = layer.locationId ?? '__unassigned__'
    const cur = byLocation.get(locId) ?? {
      locationId: layer.locationId,
      locationCode: layer.location?.code ?? '(unassigned)',
      locationName: layer.location?.name ?? 'Unassigned',
      units: 0,
      valueEurCents: 0,
    }
    cur.units += layer.unitsRemaining
    cur.valueEurCents += valueEurCents
    byLocation.set(locId, cur)

    const method = (layer.product?.costingMethod ?? 'WAC') as 'FIFO' | 'LIFO' | 'WAC'
    const m = byMethod[method] ?? byMethod.WAC
    m.units += layer.unitsRemaining
    m.valueEurCents += valueEurCents

    const ccy = layer.costCurrency ?? 'EUR'
    const c = byCurrency.get(ccy) ?? { units: 0, originalValueCents: 0, valueEurCents: 0 }
    c.units += layer.unitsRemaining
    const rate = layer.exchangeRateOnReceive ? Number(layer.exchangeRateOnReceive) : null
    const originalCents = rate && rate > 0
      ? Math.round((unitCostNum / rate) * layer.unitsRemaining * 100)
      : valueEurCents
    c.originalValueCents += originalCents
    c.valueEurCents += valueEurCents
    byCurrency.set(ccy, c)

    if (layer.vatRate == null) {
      vatBuckets.unknownVat.units += layer.unitsRemaining
      vatBuckets.unknownVat.valueEurCents += valueEurCents
    } else if (layer.unitCostVatExcluded) {
      vatBuckets.netCapitalised.units += layer.unitsRemaining
      vatBuckets.netCapitalised.valueEurCents += valueEurCents
    } else {
      vatBuckets.grossCapitalised.units += layer.unitsRemaining
      vatBuckets.grossCapitalised.valueEurCents += valueEurCents
    }
  }

  return {
    year,
    asOf: asOf.toISOString(),
    scope: locationId ? { locationId } : { all: true },
    total: { units: totalUnits, valueEurCents: totalValueEurCents },
    byLocation: Array.from(byLocation.values()).sort((a, b) => b.valueEurCents - a.valueEurCents),
    byMethod,
    byCurrency: Array.from(byCurrency.entries()).map(([currency, v]) => ({ currency, ...v })),
    vatTreatment: vatBuckets,
    layerCount: layers.length,
    source: 'live',
  }
}

/**
 * Compute + persist. asOf defaults to "Dec 31 23:59:59 UTC of `year`"
 * which is the canonical Italian fiscal year-end timestamp. Idempotent
 * upsert on (year).
 *
 * Today the underlying `computeYearEndValuation` reads CURRENT layer
 * state regardless of asOf — so calling this on Jan 1 2026 captures
 * Jan-1-state under the label "year=2025". A future enhancement
 * (replay-style reconstruction) would let the operator backfill a
 * truly point-in-time snapshot for past years.
 */
export async function snapshotYearEndValuation(
  year: number,
  opts: { asOf?: Date; notes?: string | null } = {},
): Promise<YearEndValuation> {
  const asOf = opts.asOf ?? new Date(Date.UTC(year, 11, 31, 23, 59, 59))
  const computed = await computeYearEndValuation({ year, asOf })

  await prisma.yearEndSnapshot.upsert({
    where: { year },
    create: {
      year,
      asOf,
      totalUnits: computed.total.units,
      totalValueEurCents: computed.total.valueEurCents,
      layerCount: computed.layerCount,
      byLocation: computed.byLocation as any,
      byMethod: computed.byMethod as any,
      byCurrency: computed.byCurrency as any,
      vatTreatment: computed.vatTreatment as any,
      notes: opts.notes ?? null,
    },
    update: {
      asOf,
      snapshotAt: new Date(),
      totalUnits: computed.total.units,
      totalValueEurCents: computed.total.valueEurCents,
      layerCount: computed.layerCount,
      byLocation: computed.byLocation as any,
      byMethod: computed.byMethod as any,
      byCurrency: computed.byCurrency as any,
      vatTreatment: computed.vatTreatment as any,
      notes: opts.notes ?? null,
    },
  })

  return { ...computed, source: 'snapshot', notes: opts.notes ?? null }
}

/**
 * Read a persisted snapshot. Returns null when no snapshot exists for
 * the requested year — the caller decides whether to fall back to a
 * live compute or surface the absence.
 */
export async function readYearEndSnapshot(year: number): Promise<YearEndValuation | null> {
  const row = await prisma.yearEndSnapshot.findUnique({ where: { year } })
  if (!row) return null
  return {
    year: row.year,
    asOf: row.asOf.toISOString(),
    scope: { all: true },
    total: { units: row.totalUnits, valueEurCents: row.totalValueEurCents },
    byLocation: row.byLocation as YearEndValuation['byLocation'],
    byMethod: row.byMethod as YearEndValuation['byMethod'],
    byCurrency: row.byCurrency as YearEndValuation['byCurrency'],
    vatTreatment: row.vatTreatment as YearEndValuation['vatTreatment'],
    layerCount: row.layerCount,
    source: 'snapshot',
    notes: row.notes,
  }
}
