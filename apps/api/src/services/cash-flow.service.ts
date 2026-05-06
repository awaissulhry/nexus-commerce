/**
 * R.20 — 13-week cash flow projection.
 *
 * Pure functions:
 *   parsePaymentTermsDays — "Net 30" / "30gg DF" / "60 days" → days
 *   estimatePayableDate — PO + termsDays → ISO date
 *   weekStart — UTC Monday of the week containing the date
 *   projectWeeklyCashFlow — main reducer; takes committed POs +
 *                            speculative recs + trailing daily revenue
 *
 * Defaults (R.20 design questions):
 *   1. Inflow proxy = trailing-30d daily revenue × 7 per week
 *   2. Speculative recs included; bucket items tagged 'PO_DUE' vs 'REC_DUE'
 *   3. Manufactured = same-day outflow (no payment terms)
 *   4. FX path reuses R.15 fxRates map (caller passes EUR cents)
 *   5. Underwater: balance < 0 → red, balance < safety floor → amber
 */

export interface OpenPo {
  id: string
  poNumber: string
  supplierId: string | null
  supplierName: string | null
  totalCentsEur: number
  expectedDeliveryDate: Date | null
  createdAt: Date
  paymentTerms: string | null
}

export interface SpeculativeRec {
  productId: string
  sku: string
  unitsRecommended: number
  landedCostPerUnitCentsEur: number
  preferredSupplierId: string | null
  supplierName: string | null
  paymentTerms: string | null
  isManufactured: boolean
  leadTimeDays: number
}

export interface CashFlowItem {
  kind: 'PO_DUE' | 'REC_DUE' | 'WO_DUE' | 'SALES_FORECAST'
  label: string
  cents: number // negative = outflow, positive = inflow
  refId?: string | null
  payableDate: string // ISO yyyy-mm-dd
}

export interface CashFlowBucket {
  weekStart: string // ISO yyyy-mm-dd (Monday)
  outflowCents: number // sum of negative items as positive value
  inflowCents: number // sum of positive items
  netCents: number // inflow - outflow
  startingBalanceCents: number
  endingBalanceCents: number
  /** 'OK' | 'AMBER' | 'RED' per safety-floor logic */
  health: 'OK' | 'AMBER' | 'RED'
  items: CashFlowItem[]
}

export interface ProjectionInput {
  today: Date
  horizonWeeks: number
  cashOnHandCents: number | null
  /** trailing 30-day average daily revenue in EUR cents */
  dailyRevenueCents: number
  openPos: OpenPo[]
  speculativeRecs: SpeculativeRec[]
  /** safety floor: amber when ending balance below this; default = cashOnHandCents × 0.2 */
  safetyFloorCents?: number | null
}

// ─── Pure helpers ──────────────────────────────────────────────────

const TERMS_RX_LIST: Array<RegExp> = [
  /(\d{1,3})\s*g{1,2}\s*df/i, // "30gg DF" Italian
  /net\s*(\d{1,3})/i, // "Net 30"
  /(\d{1,3})\s*days?/i, // "60 days"
  /(\d{1,3})\s*gg/i, // "30gg"
  /^(\d{1,3})$/, // bare number
]

export function parsePaymentTermsDays(terms: string | null | undefined): number {
  if (!terms) return 30
  const s = terms.trim()
  for (const rx of TERMS_RX_LIST) {
    const m = s.match(rx)
    if (m) {
      const n = Number(m[1])
      if (Number.isFinite(n) && n >= 0 && n <= 365) return n
    }
  }
  return 30
}

export function weekStart(d: Date): Date {
  // UTC Monday of the week containing d. Sunday = 0, so map to 6 back.
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const dow = x.getUTCDay() // 0=Sun..6=Sat
  const offset = dow === 0 ? 6 : dow - 1
  x.setUTCDate(x.getUTCDate() - offset)
  return x
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

export function estimatePayableDate(args: {
  expectedShip: Date | null
  createdAt: Date
  termsDays: number
}): Date {
  const anchor = args.expectedShip ?? args.createdAt
  const d = new Date(anchor.getTime())
  d.setUTCDate(d.getUTCDate() + args.termsDays)
  return d
}

// ─── Projection reducer ────────────────────────────────────────────

export function projectWeeklyCashFlow(input: ProjectionInput): CashFlowBucket[] {
  const buckets: CashFlowBucket[] = []
  const start = weekStart(input.today)
  for (let i = 0; i < input.horizonWeeks; i++) {
    const ws = new Date(start.getTime())
    ws.setUTCDate(ws.getUTCDate() + i * 7)
    buckets.push({
      weekStart: isoDate(ws),
      outflowCents: 0,
      inflowCents: 0,
      netCents: 0,
      startingBalanceCents: 0,
      endingBalanceCents: 0,
      health: 'OK',
      items: [],
    })
  }
  const horizonEndMs = start.getTime() + input.horizonWeeks * 7 * 86400000

  function bucketIndexFor(date: Date): number {
    const ws = weekStart(date)
    const diffWeeks = Math.floor((ws.getTime() - start.getTime()) / (7 * 86400000))
    return diffWeeks
  }

  // ── Open POs ──
  for (const po of input.openPos) {
    const termsDays = parsePaymentTermsDays(po.paymentTerms)
    const payable = estimatePayableDate({
      expectedShip: po.expectedDeliveryDate,
      createdAt: po.createdAt,
      termsDays,
    })
    if (payable.getTime() < start.getTime() || payable.getTime() >= horizonEndMs) continue
    const idx = bucketIndexFor(payable)
    if (idx < 0 || idx >= buckets.length) continue
    buckets[idx].items.push({
      kind: 'PO_DUE',
      label: `${po.poNumber} · ${po.supplierName ?? 'unknown'} (${termsDays}d)`,
      cents: -po.totalCentsEur,
      refId: po.id,
      payableDate: isoDate(payable),
    })
  }

  // ── Speculative recommendations ──
  for (const rec of input.speculativeRecs) {
    const termsDays = rec.isManufactured ? 0 : parsePaymentTermsDays(rec.paymentTerms)
    const payable = rec.isManufactured
      ? new Date(input.today.getTime())
      : estimatePayableDate({
          expectedShip: null,
          createdAt: input.today,
          termsDays,
        })
    if (payable.getTime() < start.getTime() || payable.getTime() >= horizonEndMs) continue
    const idx = bucketIndexFor(payable)
    if (idx < 0 || idx >= buckets.length) continue
    const total = rec.unitsRecommended * rec.landedCostPerUnitCentsEur
    if (total <= 0) continue
    buckets[idx].items.push({
      kind: rec.isManufactured ? 'WO_DUE' : 'REC_DUE',
      label: `${rec.sku} · ${rec.unitsRecommended}u${rec.isManufactured ? ' (work order)' : ` · ${rec.supplierName ?? 'supplier'}`}`,
      cents: -total,
      refId: rec.productId,
      payableDate: isoDate(payable),
    })
  }

  // ── Sales inflow (one item per week) ──
  for (const b of buckets) {
    const weekly = Math.round(input.dailyRevenueCents * 7)
    if (weekly > 0) {
      b.items.push({
        kind: 'SALES_FORECAST',
        label: 'Sales forecast (trailing 30d × 7)',
        cents: weekly,
        payableDate: b.weekStart,
      })
    }
  }

  // ── Aggregate + running balance + health ──
  const safetyFloor =
    input.safetyFloorCents ??
    (input.cashOnHandCents != null ? Math.round(input.cashOnHandCents * 0.2) : 0)
  let running = input.cashOnHandCents ?? 0
  for (const b of buckets) {
    let outflow = 0
    let inflow = 0
    for (const it of b.items) {
      if (it.cents < 0) outflow += -it.cents
      else inflow += it.cents
    }
    b.outflowCents = outflow
    b.inflowCents = inflow
    b.netCents = inflow - outflow
    b.startingBalanceCents = running
    running += b.netCents
    b.endingBalanceCents = running
    if (running < 0) b.health = 'RED'
    else if (input.cashOnHandCents != null && running < safetyFloor) b.health = 'AMBER'
    else b.health = 'OK'
  }
  return buckets
}
