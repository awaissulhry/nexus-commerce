import type { Grains } from '../../../model'
import type { ApprovalTask, BySizeView, CompareView, ComponentsView, GoalSeekView, VersionRecord, VersionRow, VersionsView } from '../api'
import type { CostSheetAbilities, Read } from '../model'
import type { VersionsModel } from '../screen'

/**
 * Made-up data for the cost sheets' design cases (B-W2b-430; PLAN §3.1): the invented jacket DEMO-JKT-01 (sizes 46 … 58, base
 * 52) of the invented factory, its cost sheet versions, lines and figures, an invented costing owner — never a real record.
 * Hand-worked at the base size 52 of version 3: leather 8.9 ft² × 3.20 = 28.48; materials 41.12; labour 59.13; overhead 12 %
 * of materials + leather + labour = 15.45; subcontract 6.50 + transport 1.20 + 1.20 = 8.90; packaging 0.18 + 0.12 + 1.80 ÷ 12
 * = 0.45; freight 2 % of materials 0.82 and duty 3.5 % of leather 1.00 → 155.35. This file only exports builders.
 */

export const DEMO_CURRENCY = 'EUR'
const uid = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`
export const DEMO_STYLE_ID = '0190f0e2-7777-7000-8000-000000000101'
export const DEMO_COMPANY_ID = '0190f0e2-1111-7000-8000-000000000001'
export const DEMO_SIZES = ['46', '48', '50', '52', '54', '56', '58']
export const DEMO_REV = { id: uid('7777', 22), revision: 2 }
export const SHEET_IDS = { v1: uid('8800', 1), v2: uid('8800', 2), v3: uid('8800', 3), v4: uid('8800', 4) }

/** The Owner (every right and grain), a cost engineer (writes drafts, sees costs, no decision), the costing owner (approves), the production manager (no money), a reader. */
export const DEMO_CAN: Record<'owner' | 'engineer' | 'costingOwner' | 'production' | 'reader', CostSheetAbilities> = {
  owner: { view: true, manage: true, approve: true, decide: true, surcharge: true },
  engineer: { view: true, manage: true, approve: false, decide: false, surcharge: false },
  costingOwner: { view: true, manage: false, approve: true, decide: true, surcharge: false },
  production: { view: true, manage: false, approve: false, decide: false, surcharge: false },
  reader: { view: true, manage: false, approve: false, decide: false, surcharge: false },
}
export const DEMO_GRAINS: Record<'all' | 'cost' | 'none', Grains> = {
  all: { cost: true, price: true, margin: true },
  cost: { cost: true, price: false, margin: false },
  none: { cost: false, price: false, margin: false },
}

const as = <T,>(value: unknown): T => value as T

function row(n: 1 | 2 | 3 | 4, overrides: Record<string, unknown> = {}): VersionRow {
  const base = {
    id: SHEET_IDS[`v${n}`],
    key: `COST_SHEET:${DEMO_COMPANY_ID}:${DEMO_STYLE_ID}:none`,
    sheetVersion: n,
    state: 'DRAFT',
    companyId: DEMO_COMPANY_ID,
    styleId: DEMO_STYLE_ID,
    revision: { id: DEMO_REV.id, revision: n === 1 ? 1 : 2 },
    season: { id: uid('5500', 1), code: 'AI27', status: 'OPEN' },
    basedOnId: n > 1 ? SHEET_IDS[`v${(n - 1) as 1 | 2 | 3}`] : null,
    currency: DEMO_CURRENCY,
    baseSize: '52',
    baseCost: '155.350000',
    weightedCost: '157.948000',
    targetPrice: '260.000000',
    targetMarginPct: '42',
    approvedAt: null,
    approvedBy: null,
    frozenAt: null,
    frozenReason: null,
    approval: null,
    createdAt: `2026-1${n === 4 ? '1-12' : n === 3 ? '1-05' : n === 2 ? '0-20' : '0-02'}T09:30:00.000Z`,
    version: 2,
  }
  return as<VersionRow>({ ...base, ...overrides })
}

/** v1 frozen (replaced), v2 approved by the invented costing owner, v3 a draft waiting for its yes, v4 a newer draft. */
export function demoRows(options: { v3?: 'waiting' | 'draft' | 'approved'; withV4?: boolean } = {}): VersionRow[] {
  const v3 = options.v3 ?? 'waiting'
  return [
    row(1, { state: 'FROZEN', frozenReason: 'SUPERSEDED', frozenAt: '2026-10-20T10:00:00.000Z', baseCost: '149.900000', weightedCost: '152.300000', approvedBy: { id: uid('3300', 2), name: 'Laura Demo' }, approvedAt: '2026-10-03T15:00:00.000Z' }),
    row(2, { state: v3 === 'approved' ? 'FROZEN' : 'APPROVED', frozenReason: v3 === 'approved' ? 'SUPERSEDED' : null, baseCost: '151.220000', weightedCost: '153.640000', approvedBy: { id: uid('3300', 2), name: 'Laura Demo' }, approvedAt: '2026-10-21T11:20:00.000Z', approval: { taskId: uid('9900', 2), status: 'APPROVED', version: 3 } }),
    row(3, v3 === 'waiting' ? { approval: { taskId: uid('9900', 3), status: 'PENDING', version: 1 } } : v3 === 'approved' ? { state: 'APPROVED', approvedBy: { id: uid('3300', 2), name: 'Laura Demo' }, approvedAt: '2026-11-10T08:45:00.000Z', approval: { taskId: uid('9900', 3), status: 'APPROVED', version: 2 } } : {}),
    ...(options.withV4 ? [row(4, { baseCost: '156.080000', weightedCost: '158.700000', targetPrice: null, targetMarginPct: null, note: null })] : []),
  ]
}

export function demoVersions(rows: VersionRow[] = demoRows()): VersionsView {
  return as<VersionsView>({ style: { id: DEMO_STYLE_ID, code: 'DEMO-JKT-01', name: 'Giacca Esempio Touring', companyId: DEMO_COMPANY_ID, sizes: DEMO_SIZES }, versions: rows })
}

type Line = ComponentsView['lines'][number]
const line = (seq: number | null, category: string, source: string, label: string, quantity: string, uom: string | null, unitCost: string, cost: string, extra: Partial<Record<keyof Line, unknown>> = {}): Line =>
  as<Line>({ seq, category, source, sourceRecordType: null, sourceRecordId: null, itemId: null, workCentreKind: null, label, size: null, quantity, uom, unitCost, cost, pct: null, note: null, ...extra })

/** The lines of version 3 (the base size's leather; every-size lines otherwise). */
export function demoLines(written = true): Line[] {
  const s = (n: number) => (written ? n : null)
  return [
    line(s(10), 'LEATHER', 'BOM_LINE', 'DEMO-LEA-01 Vacchetta esempio 1,2 mm', '8.9', 'FT2', '3.200000', '28.480000', { size: '52' }),
    line(s(20), 'MATERIAL', 'BOM_LINE', 'DEMO-LIN-01 Fodera rete', '1.6', 'M', '4.500000', '7.200000'),
    line(s(30), 'MATERIAL', 'BOM_LINE', 'DEMO-PRO-01 Protezione spalle', '2', 'PC', '6.400000', '12.800000'),
    line(s(40), 'MATERIAL', 'BOM_LINE', 'DEMO-MEM-01 Membrana', '2.17', 'M', '9.800000', '21.120000'),
    line(s(50), 'LABOUR', 'ROUTING', 'OP-SEW-10 Cucitura corpo', '64', null, '0.687500', '44.000000', { workCentreKind: 'SEWING' }),
    line(s(60), 'LABOUR', 'ROUTING', 'OP-CUT-10 Taglio pelle', '24.4', null, '0.620000', '15.130000', { workCentreKind: 'CUTTING' }),
    line(s(70), 'OVERHEAD', 'COSTING_SETTINGS', 'Overhead on material and labour', '1', null, '15.445000', '15.445000', { pct: '12' }),
    line(s(80), 'SUBCONTRACT', 'ROUTING', 'OP-EMB-01 Ricamo logo at Laboratorio Esempio', '1', null, '6.500000', '6.500000', { sourceRecordType: 'RoutingOperation', workCentreKind: 'SUBCONTRACT' }),
    line(s(90), 'SUBCONTRACT', 'UPLIFT', 'Transport to Laboratorio Esempio', '1', null, '1.200000', '1.200000', { sourceRecordType: 'MaterialCostUplift' }),
    line(s(100), 'SUBCONTRACT', 'UPLIFT', 'Transport back from Laboratorio Esempio', '1', null, '1.200000', '1.200000', { sourceRecordType: 'MaterialCostUplift' }),
    line(s(110), 'PACKAGING', 'PACKAGING', 'Sacchetto 60×80', '1', null, '0.180000', '0.180000', { sourceRecordType: 'PackagingType' }),
    line(s(120), 'PACKAGING', 'PACKAGING', 'Gruccia giacca', '1', null, '0.120000', '0.120000', { sourceRecordType: 'PackagingType' }),
    line(s(130), 'PACKAGING', 'PACKAGING', "Cartone export: one garment's share", '1', null, '0.150000', '0.150000', { sourceRecordType: 'PackagingType', note: "The carton's cost ÷ 12 garments." }),
    line(s(140), 'FREIGHT', 'UPLIFT', 'Freight on membrane materials', '1', null, '0.822400', '0.822400', { pct: '2', sourceRecordType: 'MaterialCostUplift' }),
    line(s(150), 'DUTY', 'LANDED_COST', 'Duty on the material', '1', null, '0.996800', '0.996800', { pct: '3.5', sourceRecordType: 'MaterialCostUplift', note: 'The percent read from the landed cost of earlier receipts.' }),
  ]
}

/** Each size's split: the leather grows with the size (8.9 ft² at 52, ±0.3 a size); the rest is the same. */
export function demoSplit(): ComponentsView['split'] {
  return DEMO_SIZES.map((size, index) => {
    const leather = 28.48 + (index - 3) * 0.96
    const total = 155.3502 + (index - 3) * 0.96 * 1.12
    return as<ComponentsView['split'][number]>({
      size,
      categories: [
        { category: 'MATERIAL', amount: '41.120000' },
        { category: 'LEATHER', amount: leather.toFixed(6) },
        { category: 'LABOUR', amount: '59.130000' },
        { category: 'OVERHEAD', amount: '15.445000' },
        { category: 'SUBCONTRACT', amount: '8.900000' },
        { category: 'FREIGHT', amount: '0.822400' },
        { category: 'DUTY', amount: '0.996800' },
        { category: 'PACKAGING', amount: '0.450000' },
        { category: 'COMMISSION', amount: '0.000000' },
      ],
      knownTotal: total.toFixed(6),
      total: total.toFixed(6),
      complete: true,
    })
  })
}

export function demoRecord(sheet: VersionRow, options: { leftOut?: boolean; note?: string | null } = {}): VersionRecord {
  return as<VersionRecord>({
    sheet: { ...sheet, note: options.note ?? 'Prezzi della pelle aggiornati a novembre.' },
    sizes: DEMO_SIZES,
    lines: demoLines().map((entry, index) => ({ ...entry, id: uid('8810', index + 1) })),
    split: demoSplit(),
    leftOut: options.leftOut ? [{ key: 'CARTON_PIECES', code: 'CARTON_PIECES', itemId: null, recordType: null, recordId: null, size: null, workCentreKind: null, message: 'x' }] : [],
    weights: {
      source: 'EVERY_SEASON',
      sizeCurveId: null,
      weights: { '48': '1', '50': '2', '52': '3', '54': '2.5', '56': '1.5' },
      shares: [
        { size: '48', weight: '1', sharePct: '10' },
        { size: '50', weight: '2', sharePct: '20' },
        { size: '52', weight: '3', sharePct: '30' },
        { size: '54', weight: '2.5', sharePct: '25' },
        { size: '56', weight: '1.5', sharePct: '15' },
      ],
      weighted: sheet.weightedCost,
      missing: [],
    },
    can: { edit: sheet.state === 'DRAFT', remove: sheet.state === 'DRAFT', submit: sheet.state === 'DRAFT' && !options.leftOut, newVersion: true, takeBack: sheet.state === 'APPROVED' },
    words: 'x',
  })
}

export function demoTask(options: { mine?: boolean; allowed?: boolean } = {}): ApprovalTask {
  return { id: uid('9900', 3), status: 'PENDING', version: 1, requester: { me: !!options.mine }, approve: { allowed: options.allowed ?? !options.mine } }
}

export function demoComponents(options: { carton?: boolean; empty?: boolean } = {}): ComponentsView {
  const carton = options.carton ?? true
  const lines = demoLines(false).filter((entry) => carton || !entry.label?.startsWith('Cartone'))
  return as<ComponentsView>({
    style: { id: DEMO_STYLE_ID, code: 'DEMO-JKT-01', name: 'Giacca Esempio Touring', companyId: DEMO_COMPANY_ID, baseSize: '52' },
    revision: { id: DEMO_REV.id, revision: 2, status: 'RELEASED' },
    companyId: DEMO_COMPANY_ID,
    currency: DEMO_CURRENCY,
    on: '2026-11-14',
    colourway: { id: uid('7777', 31), code: 'NERO', name: 'Nero' },
    sizes: DEMO_SIZES,
    pieceRate: { on: false, siteId: null, words: 'x' },
    piecesPerCarton: carton ? 12 : null,
    lines: options.empty ? lines.filter((entry) => !['SUBCONTRACT', 'PACKAGING', 'FREIGHT', 'DUTY'].includes(entry.category)) : lines,
    split: demoSplit().map((cell) => (carton ? cell : { ...cell, total: null, complete: false })),
    complete: carton,
    missing: carton ? [] : [{ key: 'CARTON_PIECES', code: 'CARTON_PIECES', itemId: null, recordType: null, recordId: null, size: null, workCentreKind: null, message: 'x' }],
    warnings: carton ? [] : [{ code: 'NO_WRITTEN_TERMS', recordId: null, message: 'x' }, { code: 'NO_LEATHER_BASIS', recordId: null, message: 'x' }],
    ledger: [],
    unverified: 'x',
    computedAt: '2026-11-14T08:00:00.000Z',
  })
}

/** Version 2 against version 3: the leather's price rose, the transport back is new. */
export function demoCompare(options: { comparable?: boolean } = {}): CompareView {
  const comparable = options.comparable ?? true
  const rows = demoRows()
  const side = (entry: Line, unitCost?: string, cost?: string) => ({ quantity: entry.quantity, uom: entry.uom, unitCost: unitCost ?? entry.unitCost, cost: cost ?? entry.cost, pct: entry.pct })
  const lines = demoLines(false)
  return as<CompareView>({
    a: rows[1],
    b: { ...rows[2], currency: comparable ? DEMO_CURRENCY : 'USD' },
    sizes: DEMO_SIZES,
    comparable,
    sizesCompared: DEMO_SIZES.map((size, index) => ({ size, total: { a: (151.22 + (index - 3) * 1.07).toFixed(6), b: (155.3502 + (index - 3) * 1.0752).toFixed(6), difference: '4.130200' }, categories: [] })),
    lines: lines.map((entry, index) => {
      const key = `line:${index}`
      if (entry.category === 'LEATHER') return { key, category: entry.category, label: entry.label, size: entry.size, a: side(entry, '2.950000', '26.255000'), b: side(entry), difference: '2.225000', change: 'CHANGED' }
      if (entry.label?.startsWith('Transport back')) return { key, category: entry.category, label: entry.label, size: entry.size, a: null, b: side(entry), difference: '1.200000', change: 'ADDED' }
      return { key, category: entry.category, label: entry.label, size: entry.size, a: side(entry), b: side(entry), difference: '0', change: 'SAME' }
    }),
    weighted: { a: '153.640000', b: '157.948000', difference: '4.308000' },
    words: 'x',
  })
}

/** At 260.00 and 42 %: allowed 150.80; the weighted cost 157.948 is 7.148 above. */
export function demoGoal(state: 'ABOVE' | 'WITHIN' | 'PRICE_ONLY' = 'ABOVE'): GoalSeekView {
  const top = [
    { lineId: uid('8810', 5), seq: 50, category: 'LABOUR', label: 'OP-SEW-10 Cucitura corpo', cost: '44.000000', sharePct: '27.86', cutAlonePct: '16.3', cutShared: '2.620000' },
    { lineId: uid('8810', 1), seq: 10, category: 'LEATHER', label: 'DEMO-LEA-01 Vacchetta esempio 1,2 mm', cost: '29.440000', sharePct: '18.64', cutAlonePct: '24.3', cutShared: '1.753000' },
    { lineId: uid('8810', 4), seq: 40, category: 'MATERIAL', label: 'DEMO-MEM-01 Membrana', cost: '21.120000', sharePct: '13.37', cutAlonePct: '33.9', cutShared: '1.258000' },
    { lineId: uid('8810', 6), seq: 60, category: 'LABOUR', label: 'OP-CUT-10 Taglio pelle', cost: '15.130000', sharePct: '9.58', cutAlonePct: '47.3', cutShared: '0.901000' },
    { lineId: uid('8810', 3), seq: 30, category: 'MATERIAL', label: 'DEMO-PRO-01 Protezione spalle', cost: '12.800000', sharePct: '8.10', cutAlonePct: '55.9', cutShared: '0.762000' },
  ]
  const within = state === 'WITHIN'
  return as<GoalSeekView>({
    sheet: { id: SHEET_IDS.v3, sheetVersion: 3, state: 'DRAFT', currency: DEMO_CURRENCY, baseSize: '52' },
    basis: { kind: 'WEIGHTED', size: null },
    target: { price: within ? '290.000000' : '260.000000', marginPct: state === 'PRICE_ONLY' ? null : '42', from: within ? 'ASKED' : 'SHEET' },
    cost: '157.948000',
    allowedCost: state === 'PRICE_ONLY' ? null : within ? '168.200000' : '150.800000',
    gap: state === 'PRICE_ONLY' ? null : within ? '-10.252000' : '7.148000',
    marginAtCost: state === 'PRICE_ONLY' ? '39.25' : null,
    priceForMargin: null,
    state,
    lines: within ? top.map((entry) => ({ ...entry, cutAlonePct: null, cutShared: null })) : state === 'PRICE_ONLY' ? top.map((entry) => ({ ...entry, cutAlonePct: null, cutShared: null })) : top,
    words: 'x',
    held: null,
  })
}

/** Sizes 56 and 58 are 2 % or more above 52: at 42 % the surcharge keeps the margin (rounded up to the cent). */
export function demoBySize(options: { target?: boolean; current?: boolean; none?: boolean } = {}): BySizeView {
  const target = options.target ?? true
  const split = demoSplit()
  return as<BySizeView>({
    sheet: { id: SHEET_IDS.v3, sheetVersion: 3, state: 'DRAFT', currency: DEMO_CURRENCY, baseSize: '52', styleId: DEMO_STYLE_ID },
    sizes: DEMO_SIZES,
    baseSize: '52',
    split,
    weights: { source: 'EVERY_SEASON', weights: { '52': '1' }, shares: [], weighted: '157.948000', missing: [] },
    fromPct: '2',
    surcharges: options.none
      ? []
      : [
          { size: '56', extraCost: '3.225600', extraPct: '2.08', priceSurcharge: target ? '5.570000' : null, current: options.current ? { amount: '5.570000', currency: DEMO_CURRENCY, pct: null } : null },
          { size: '58', extraCost: '4.300800', extraPct: '2.77', priceSurcharge: target ? '7.420000' : null, current: { amount: '5.000000', currency: DEMO_CURRENCY, pct: null } },
        ],
    words: 'x',
  })
}

const ready = <T,>(value: T): Read<T> => ({ status: 'ready', value })

/** The versions card's model for a role and a version in view. */
export function versionsModel(overrides: Partial<VersionsModel> = {}, role: keyof typeof DEMO_CAN = 'owner', grains: Grains = DEMO_GRAINS.all): VersionsModel {
  const rows = demoRows()
  const inView = rows[2]!
  return {
    styleId: DEMO_STYLE_ID,
    revision: DEMO_REV,
    sizes: DEMO_SIZES,
    baseSize: '52',
    can: DEMO_CAN[role],
    grains,
    list: ready(demoVersions(rows)),
    inView,
    record: ready(demoRecord(inView)),
    task: ready(demoTask()),
    seasons: ready([{ id: uid('5500', 1), companyId: DEMO_COMPANY_ID, code: 'AI27', name: 'Autunno-inverno 2027', status: 'OPEN' }]),
    dialog: null,
    compare: null,
    busy: false,
    problem: null,
    notice: null,
    stepUp: { open: false, busy: false, problem: null },
    ...overrides,
  }
}
