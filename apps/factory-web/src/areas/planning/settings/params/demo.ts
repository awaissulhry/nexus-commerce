import type { ItemEntry, ItemParameters, Lane, PlanningSite, SiteLanes, SiteSettings } from '../api'

/**
 * Made-up data for the SCR-127 design cases (never a real customer, supplier, person or number): one demo company with
 * two plants, a handful of leathers, linings and trims, two lines and three work centres.
 */

const uid = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`
const at = '2026-10-29T09:42:00.000Z'

export const DEMO_COMPANY_ID = uid('5901', 1)
export const SITE: PlanningSite = { id: uid('5902', 1), companyId: DEMO_COMPANY_ID, code: 'P1', name: 'Demo plant 1', kind: 'PLANT', timeZone: 'Europe/Rome' }
export const SITE_2: PlanningSite = { id: uid('5902', 2), companyId: DEMO_COMPANY_ID, code: 'P2', name: 'Demo plant 2', kind: 'PLANT', timeZone: 'Europe/Rome' }
export const WAREHOUSE: PlanningSite = { id: uid('5902', 3), companyId: DEMO_COMPANY_ID, code: 'W1', name: 'Demo warehouse', kind: 'WAREHOUSE', timeZone: 'Europe/Rome' }
export const SITES: readonly PlanningSite[] = [SITE, SITE_2, WAREHOUSE]

const supplier = (n: number, code: string, name: string) => ({ id: uid('5903', n), code, name })
export const TANNERY = supplier(1, 'SUP-DEMO-01', 'Demo tannery')
export const TANNERY_2 = supplier(2, 'SUP-DEMO-02', 'Second demo tannery')
export const TRIMS = supplier(3, 'SUP-DEMO-03', 'Demo trims supplier')

const colour = (n: number, code: string, name: string) => ({ id: uid('5904', n), code, name })
const BLACK = colour(1, 'BLK', 'Black')
const RED = colour(2, 'RED', 'Racing red')
const WHITE = colour(3, 'WHT', 'White')

const row = (n: number, item: ItemEntry['item'], patch: Partial<ItemParameters>): ItemParameters => ({
  id: uid('5905', n),
  siteId: SITE.id,
  item: { id: item.id, code: item.code, name: item.name, baseUom: item.baseUom },
  colour: null,
  method: 'ORDERS',
  source: null,
  supplier: null,
  makeSite: null,
  buyLeadTimeDays: null,
  makeLeadTimeDays: null,
  safetyLeadTimeDays: null,
  safetyStock: null,
  reorderPoint: null,
  lotSize: null,
  minStock: null,
  maxStock: null,
  minOrderQty: null,
  orderMultiple: null,
  maxOrderQty: null,
  note: null,
  version: 3,
  updatedAt: at,
  ...patch,
})

const item = (n: number, code: string, name: string, kind: string, baseUom: string, colours: ItemEntry['item']['colours'] = []): ItemEntry['item'] => ({ id: uid('5906', n), code, name, kind, tracking: kind === 'LEATHER' ? 'HIDE' : 'LOT', baseUom, colours })

const COWHIDE = item(1, 'DEMO-LTH-01', 'Demo cowhide 1.2 mm', 'LEATHER', 'M2', [BLACK, RED, WHITE])
const KANGAROO = item(2, 'DEMO-LTH-02', 'Demo kangaroo 0.9 mm', 'LEATHER', 'M2', [BLACK])
const MESH = item(3, 'DEMO-LIN-01', 'Demo mesh lining', 'LINING', 'M', [BLACK])
const ZIP = item(4, 'DEMO-TRM-01', 'Demo zip 60 cm', 'TRIM', 'PCS')
const THREAD = item(5, 'DEMO-THR-01', 'Demo bonded thread', 'THREAD', 'CONE')
const SLIDER = item(6, 'DEMO-CMP-01', 'Demo knee slider puck', 'COMPONENT', 'PCS')

export const COWHIDE_ROW = row(1, COWHIDE, { method: 'REORDER_POINT', source: 'BUY', supplier: TANNERY, buyLeadTimeDays: 21, safetyLeadTimeDays: 3, safetyStock: '40.0000', reorderPoint: '120.0000', lotSize: '210.0000', minOrderQty: '50.0000', orderMultiple: '10.0000' })
export const COWHIDE_RED = row(2, COWHIDE, { colour: RED, method: 'MIN_MAX', minStock: '80.0000', maxStock: '420.0000', buyLeadTimeDays: 28 })
export const MESH_ROW = row(3, MESH, { buyLeadTimeDays: 14, safetyStock: '150.0000', orderMultiple: '50.0000' })
export const THREAD_ROW = row(4, THREAD, { method: 'MIN_MAX', minStock: '24.0000', maxStock: '96.0000', source: 'BUY', supplier: TRIMS })
export const SLIDER_ROW = row(5, SLIDER, { source: 'MAKE', makeSite: { id: SITE_2.id, code: SITE_2.code, name: SITE_2.name }, makeLeadTimeDays: 5, safetyStock: '200.0000' })

const defaults = (patch: Partial<ItemEntry['defaults']> = {}): ItemEntry['defaults'] => ({ sourcing: 'BUY', supplier: null, leadTimeDays: null, purchaseUom: 'M2', minOrderQty: null, orderMultiple: null, ...patch })

export const ENTRIES: readonly ItemEntry[] = [
  { item: COWHIDE, defaults: defaults({ supplier: TANNERY, leadTimeDays: 14, purchaseUom: 'HIDE', minOrderQty: '5', orderMultiple: '1' }), parameters: [COWHIDE_ROW, COWHIDE_RED] },
  { item: KANGAROO, defaults: defaults({ supplier: TANNERY_2, leadTimeDays: 35, purchaseUom: 'HIDE', minOrderQty: '10' }), parameters: [] },
  { item: MESH, defaults: defaults({ supplier: TRIMS, leadTimeDays: 10, purchaseUom: 'ROLL', minOrderQty: '1' }), parameters: [MESH_ROW] },
  { item: ZIP, defaults: defaults({ supplier: TRIMS, leadTimeDays: 7, purchaseUom: 'BOX', orderMultiple: '1' }), parameters: [] },
  { item: THREAD, defaults: defaults({ supplier: TRIMS, leadTimeDays: 7, purchaseUom: 'CONE' }), parameters: [THREAD_ROW] },
  { item: SLIDER, defaults: defaults({ sourcing: 'MAKE', purchaseUom: 'PCS' }), parameters: [SLIDER_ROW] },
]

export const RULES: readonly ItemParameters[] = [COWHIDE_ROW, COWHIDE_RED, THREAD_ROW]

export const SUPPLIER_CHOICES = [TANNERY, TANNERY_2]

const settings = (patch: Partial<SiteSettings['settings']> = {}): SiteSettings['settings'] => ({
  horizonWeeks: 26,
  dayBucketWeeks: 2,
  weekBucketWeeks: 13,
  defaultEfficiencyPct: '85.00',
  scheduledRunTime: '02:00',
  isDefault: false,
  version: 4,
  updatedAt: at,
  ...patch,
})

/** The horizon of a Thursday 29 October 2026: days to Sunday 8 Nov, weeks to Sunday 24 Jan, months to Sunday 25 Apr. */
export const SETTINGS: SiteSettings = {
  site: SITE,
  settings: settings(),
  horizon: {
    from: '2026-10-29',
    to: '2027-04-25',
    buckets: [
      ...Array.from({ length: 11 }, (_, index) => ({ key: `D${index}`, kind: 'DAY' as const, from: '2026-10-29', to: index === 10 ? '2026-11-08' : '2026-10-29' })),
      ...Array.from({ length: 11 }, (_, index) => ({ key: `W${index}`, kind: 'WEEK' as const, from: '2026-11-09', to: index === 10 ? '2027-01-24' : '2026-11-15' })),
      { key: 'M1', kind: 'MONTH' as const, from: '2027-01-25', to: '2027-01-31' },
      { key: 'M2', kind: 'MONTH' as const, from: '2027-02-01', to: '2027-02-28' },
      { key: 'M3', kind: 'MONTH' as const, from: '2027-03-01', to: '2027-03-31' },
      { key: 'M4', kind: 'MONTH' as const, from: '2027-04-01', to: '2027-04-25' },
    ],
  },
}

export const DEFAULT_SETTINGS: SiteSettings = { ...SETTINGS, settings: settings({ defaultEfficiencyPct: '100.00', scheduledRunTime: null, isDefault: true, version: null, updatedAt: null }) }

const lane = (kind: Lane['kind'], n: number, code: string, name: string, patch: Partial<Lane>): Lane => ({
  kind,
  id: uid('5907', n),
  code,
  name,
  workCentreKind: null,
  stations: 8,
  capacity: null,
  effective: { efficiencyPct: '85.00', efficiencySource: 'SITE', people: 8, peopleSource: 'STATIONS' },
  actual: null,
  ...patch,
})

const weeks = (pcts: (string | null)[]) =>
  pcts.map((pct, index) => ({ week: `2026-W${40 + index}`, from: '2026-10-01', to: '2026-10-07', earnedMinutes: pct === null ? '0.0' : '12000.0', availableMinutes: pct === null ? '0.0' : '15000.0', pct }))

export const LANES: SiteLanes = {
  site: SITE,
  defaultEfficiencyPct: '85.00',
  defaultEfficiencySource: 'SITE',
  lines: [
    lane('LINE', 1, 'L1', 'Line 1 — jackets', { stations: 10, capacity: { plannedEfficiencyPct: '90.00', people: 10, note: null, version: 2, updatedAt: at }, effective: { efficiencyPct: '90.00', efficiencySource: 'LANE', people: 10, peopleSource: 'CAPACITY' }, actual: weeks(['82.40', '86.10', '88.75', '91.20']) }),
    lane('LINE', 2, 'L2', 'Line 2 — suits', { stations: 8, actual: weeks(['71.00', null, '78.30', '80.05']) }),
  ],
  workCentres: [
    lane('WORK_CENTRE', 3, 'CUT-01', 'Cutting room', { workCentreKind: 'CUTTING', stations: 3, effective: { efficiencyPct: '85.00', efficiencySource: 'SITE', people: 3, peopleSource: 'STATIONS' } }),
    lane('WORK_CENTRE', 4, 'SEW-01', 'Sewing room', { workCentreKind: 'SEWING', stations: 14, capacity: { plannedEfficiencyPct: '80.00', people: 12, note: null, version: 1, updatedAt: at }, effective: { efficiencyPct: '80.00', efficiencySource: 'LANE', people: 12, peopleSource: 'CAPACITY' } }),
    lane('WORK_CENTRE', 5, 'FIN-01', 'Finishing', { workCentreKind: 'FINISHING', stations: 4 }),
  ],
}
