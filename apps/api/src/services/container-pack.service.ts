/**
 * R.19 — Container / freight cost optimization.
 *
 * Pure functions:
 *   normalizeDimsToCm — accept ('in', 'cm') and return cm
 *   normalizeWeightToGrams — accept ('lb','oz','kg','g') and return grams
 *   cbmFromDims — m³ from cm-cube
 *   chargeableWeightKg — max(actual, volumetric) per IATA / FIATA conventions
 *   freightCostForLine — cents for a (qty, dims, weight, profile) tuple
 *   optimizeContainerFill — supplier-level rollup with fill % and top-up
 *
 * I/O helpers:
 *   getShippingProfile, putShippingProfile
 */

import prisma from '../db.js'

export type ShippingMode =
  | 'AIR'
  | 'SEA_LCL'
  | 'SEA_FCL_20'
  | 'SEA_FCL_40'
  | 'ROAD'

export interface ShippingProfile {
  mode: ShippingMode
  costPerCbmCents: number | null
  costPerKgCents: number | null
  fixedCostCents: number | null
  currencyCode: string
  containerCapacityCbm: number | null
  containerMaxWeightKg: number | null
}

export interface PackItem {
  productId: string
  sku: string
  unitsQty: number
  /** unit volume in m³ */
  cbmPerUnit: number
  /** unit weight in kg */
  kgPerUnit: number
  /** unit cost in EUR cents (post-FX) — used for top-up urgency-of-savings calc */
  unitCostCents: number
  /** rec urgency for top-up gating (HIGH / MEDIUM eligible) */
  urgency: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'
  casePack: number | null
}

export interface ContainerFillResult {
  mode: ShippingMode
  totalCbm: number
  totalKg: number
  fillPercentByCbm: number | null
  fillPercentByWeight: number | null
  freightCostCents: number
  /** per-line freight allocated by cbm share (FCL) or computed (LCL/AIR/ROAD) */
  perLineFreightCents: Map<string, number>
  topUpSuggestions: Array<{
    productId: string
    sku: string
    addUnits: number
    marginalFreightSavedCents: number
  }>
}

// ─── Normalizers ───────────────────────────────────────────────────

export function normalizeDimsToCm(args: {
  length: number | null | undefined
  width: number | null | undefined
  height: number | null | undefined
  unit: string | null | undefined
}): { l: number; w: number; h: number } | null {
  if (args.length == null || args.width == null || args.height == null) return null
  const u = (args.unit ?? 'cm').toLowerCase()
  const factor = u === 'in' ? 2.54 : u === 'mm' ? 0.1 : 1
  const l = args.length * factor
  const w = args.width * factor
  const h = args.height * factor
  if (l <= 0 || w <= 0 || h <= 0) return null
  return { l, w, h }
}

export function normalizeWeightToGrams(args: {
  value: number | null | undefined
  unit: string | null | undefined
}): number | null {
  if (args.value == null || args.value <= 0) return null
  const u = (args.unit ?? 'kg').toLowerCase()
  const factor =
    u === 'kg' ? 1000 : u === 'g' ? 1 : u === 'lb' ? 453.592 : u === 'oz' ? 28.3495 : 1000
  return args.value * factor
}

export function cbmFromDims(l: number, w: number, h: number): number {
  return (l * w * h) / 1_000_000
}

/**
 * IATA/FIATA volumetric weight: actual kg vs cbm × ratio.
 * AIR ratio is 167 (kg/cbm), SEA/ROAD ratio is 333.
 */
export function chargeableWeightKg(args: {
  actualKg: number
  cbm: number
  ratio: 167 | 333
}): number {
  const volumetric = args.cbm * args.ratio
  return Math.max(args.actualKg, volumetric)
}

// ─── Single-line freight cost ──────────────────────────────────────

export function freightCostForLine(args: {
  unitsQty: number
  cbmPerUnit: number
  kgPerUnit: number
  profile: ShippingProfile
}): number {
  if (args.unitsQty <= 0) return 0
  const cbm = args.cbmPerUnit * args.unitsQty
  const kg = args.kgPerUnit * args.unitsQty
  switch (args.profile.mode) {
    case 'AIR': {
      const chargeable = chargeableWeightKg({ actualKg: kg, cbm, ratio: 167 })
      const byKg = (args.profile.costPerKgCents ?? 0) * chargeable
      const byCbm = (args.profile.costPerCbmCents ?? 0) * cbm
      // AIR almost always uses chargeable-weight pricing; if both rates
      // are present we take whichever is higher (carrier convention).
      return Math.round(Math.max(byKg, byCbm))
    }
    case 'SEA_LCL':
    case 'ROAD': {
      const chargeable = chargeableWeightKg({ actualKg: kg, cbm, ratio: 333 })
      const byCbm = (args.profile.costPerCbmCents ?? 0) * cbm
      const byKg = (args.profile.costPerKgCents ?? 0) * chargeable
      return Math.round(Math.max(byCbm, byKg))
    }
    case 'SEA_FCL_20':
    case 'SEA_FCL_40': {
      // FCL is per-container; per-line cost is allocated by cbm share
      // upstream in optimizeContainerFill. Standalone single-line
      // freight cost is the full container cost (caller usually
      // allocates).
      return args.profile.fixedCostCents ?? 0
    }
    default:
      return 0
  }
}

// ─── Supplier-level rollup ─────────────────────────────────────────

export function optimizeContainerFill(args: {
  items: PackItem[]
  profile: ShippingProfile
}): ContainerFillResult {
  const { items, profile } = args
  let totalCbm = 0
  let totalKg = 0
  for (const it of items) {
    totalCbm += it.cbmPerUnit * it.unitsQty
    totalKg += it.kgPerUnit * it.unitsQty
  }

  const isFcl = profile.mode === 'SEA_FCL_20' || profile.mode === 'SEA_FCL_40'
  const cap = profile.containerCapacityCbm ?? null
  const maxKg = profile.containerMaxWeightKg ?? null
  const fillPercentByCbm = isFcl && cap ? (totalCbm / cap) * 100 : null
  const fillPercentByWeight = isFcl && maxKg ? (totalKg / maxKg) * 100 : null

  let freightCostCents = 0
  const perLineFreightCents = new Map<string, number>()

  if (isFcl) {
    // One container assumed (or one per fill cycle). Allocate fixed
    // cost by cbm share; if container is over-full we count
    // ceil(totalCbm / cap) containers (rare for v1).
    const containers = cap && cap > 0 ? Math.max(1, Math.ceil(totalCbm / cap)) : 1
    freightCostCents = (profile.fixedCostCents ?? 0) * containers
    if (totalCbm > 0) {
      for (const it of items) {
        const lineCbm = it.cbmPerUnit * it.unitsQty
        const share = lineCbm / totalCbm
        perLineFreightCents.set(it.productId, Math.round(freightCostCents * share))
      }
    }
  } else {
    for (const it of items) {
      const c = freightCostForLine({
        unitsQty: it.unitsQty,
        cbmPerUnit: it.cbmPerUnit,
        kgPerUnit: it.kgPerUnit,
        profile,
      })
      perLineFreightCents.set(it.productId, c)
      freightCostCents += c
    }
  }

  // Top-up suggestions: only for FCL with measurable headroom + at
  // least one HIGH/MEDIUM-urgency case-packed SKU we can extend.
  const topUpSuggestions: ContainerFillResult['topUpSuggestions'] = []
  if (isFcl && cap && totalCbm < cap * 0.9 && totalCbm > 0) {
    const headroomCbm = cap - totalCbm
    // Walk eligible items by velocity-proxy (use unitsQty*urgency-weight
    // as a stable ranking — no live velocity in this pure function).
    const urgencyWeight: Record<PackItem['urgency'], number> = {
      CRITICAL: 4,
      HIGH: 3,
      MEDIUM: 2,
      LOW: 0,
    }
    const eligible = items
      .filter((it) => urgencyWeight[it.urgency] >= 2 && it.cbmPerUnit > 0)
      .sort((a, b) => urgencyWeight[b.urgency] - urgencyWeight[a.urgency])

    let cbmRemaining = headroomCbm
    for (const it of eligible) {
      if (cbmRemaining <= 0) break
      const stepUnits = it.casePack ?? 1
      const stepCbm = it.cbmPerUnit * stepUnits
      if (stepCbm <= 0 || stepCbm > cbmRemaining) continue
      const stepsToFit = Math.floor(cbmRemaining / stepCbm)
      if (stepsToFit < 1) continue
      const addUnits = stepUnits * stepsToFit
      // Marginal freight saved = the per-unit freight share that drops
      // when we amortize the same fixed container cost over more units.
      // Approx: original perUnit = freight / currentTotalUnits;
      //         new perUnit      = freight / (currentTotalUnits + addUnits)
      const currentTotalUnits = items.reduce((s, x) => s + x.unitsQty, 0)
      const perUnitNow = freightCostCents / Math.max(currentTotalUnits, 1)
      const perUnitAfter = freightCostCents / Math.max(currentTotalUnits + addUnits, 1)
      const marginalFreightSavedCents = Math.round(
        (perUnitNow - perUnitAfter) * (currentTotalUnits + addUnits),
      )
      topUpSuggestions.push({
        productId: it.productId,
        sku: it.sku,
        addUnits,
        marginalFreightSavedCents,
      })
      cbmRemaining -= stepCbm * stepsToFit
    }
  }

  return {
    mode: profile.mode,
    totalCbm: Number(totalCbm.toFixed(4)),
    totalKg: Number(totalKg.toFixed(2)),
    fillPercentByCbm: fillPercentByCbm == null ? null : Number(fillPercentByCbm.toFixed(2)),
    fillPercentByWeight: fillPercentByWeight == null ? null : Number(fillPercentByWeight.toFixed(2)),
    freightCostCents,
    perLineFreightCents,
    topUpSuggestions,
  }
}

// ─── DB helpers ────────────────────────────────────────────────────

export async function getShippingProfile(supplierId: string) {
  return prisma.supplierShippingProfile.findUnique({ where: { supplierId } })
}

export async function putShippingProfile(args: {
  supplierId: string
  mode: ShippingMode
  costPerCbmCents?: number | null
  costPerKgCents?: number | null
  fixedCostCents?: number | null
  currencyCode?: string
  containerCapacityCbm?: number | null
  containerMaxWeightKg?: number | null
  notes?: string | null
}) {
  const { supplierId, ...rest } = args
  const data = {
    mode: rest.mode,
    costPerCbmCents: rest.costPerCbmCents ?? null,
    costPerKgCents: rest.costPerKgCents ?? null,
    fixedCostCents: rest.fixedCostCents ?? null,
    currencyCode: rest.currencyCode ?? 'EUR',
    containerCapacityCbm: rest.containerCapacityCbm ?? null,
    containerMaxWeightKg: rest.containerMaxWeightKg ?? null,
    notes: rest.notes ?? null,
  }
  return prisma.supplierShippingProfile.upsert({
    where: { supplierId },
    create: { supplierId, ...data },
    update: data,
  })
}

export async function loadShippingProfilesForSuppliers(
  supplierIds: string[],
): Promise<Map<string, ShippingProfile>> {
  if (supplierIds.length === 0) return new Map()
  const rows = await prisma.supplierShippingProfile.findMany({
    where: { supplierId: { in: supplierIds } },
  })
  const m = new Map<string, ShippingProfile>()
  for (const r of rows) {
    m.set(r.supplierId, {
      mode: r.mode as ShippingMode,
      costPerCbmCents: r.costPerCbmCents ?? null,
      costPerKgCents: r.costPerKgCents ?? null,
      fixedCostCents: r.fixedCostCents ?? null,
      currencyCode: r.currencyCode,
      containerCapacityCbm: r.containerCapacityCbm == null ? null : Number(r.containerCapacityCbm),
      containerMaxWeightKg: r.containerMaxWeightKg == null ? null : Number(r.containerMaxWeightKg),
    })
  }
  return m
}
