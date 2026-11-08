import type { Cutboard, CutboardOrder } from './api'

/**
 * Made-up cutting room boards for SCR-073's Cutting room cases (B-W2b-130; no designScreen of its own: Floor now's fixtures.ts
 * draws them). Invented codes and figures only; nobody who cut is named anywhere (the API serves no such field).
 */

const ID = (n: number) => `0190f0e2-0000-7000-9130-${String(n).padStart(12, '0')}`
const SITE = { id: ID(1), code: 'A1', name: 'Stabilimento dimostrativo', timeZone: 'Europe/Rome' }
const SITE_2 = { id: ID(2), code: 'B1', name: 'Laboratorio esempio', timeZone: 'Europe/Rome' }
const COMPANY = ID(3)
const siteRef = ({ id, code, name }: { id: string; code: string; name: string }) => ({ id, code, name })
const ref = (n: number, code: string, name: string) => ({ id: ID(n), code, name })

const order = (n: number, over: Partial<CutboardOrder>): CutboardOrder => ({
  id: ID(100 + n),
  number: `CO-2026-00${String(10 + n)}`,
  kind: 'FABRIC',
  status: 'RELEASED',
  companyId: COMPANY,
  siteId: SITE.id,
  item: ref(20, 'FOD-GRI', 'Fodera grigia'),
  colour: ref(21, 'GRY', 'Grigio'),
  dueDate: '2026-10-29',
  late: false,
  garments: 80,
  lays: { cut: 0, of: 2 },
  workOrders: [{ id: ID(200 + n), number: `WO-000${n}` }],
  ...over,
})

const ORDERS: CutboardOrder[] = [
  order(1, { status: 'IN_PROGRESS', lays: { cut: 1, of: 2 }, workOrders: [{ id: ID(201), number: 'WO-00041' }, { id: ID(202), number: 'WO-00042' }] }),
  order(2, { kind: 'LEATHER', status: 'IN_PROGRESS', item: ref(22, 'PEL-NERA', 'Pelle bovina nera'), colour: ref(23, 'BLK', 'Nero'), garments: 12, lays: null, dueDate: '2026-10-28', late: true }),
  order(3, { status: 'RELEASED', garments: 48 }),
  order(4, { kind: 'LEATHER', status: 'RELEASED', item: ref(22, 'PEL-NERA', 'Pelle bovina nera'), colour: ref(23, 'BLK', 'Nero'), garments: 8, lays: null, dueDate: '2026-10-30' }),
  order(5, { status: 'PLANNED', garments: 32, dueDate: null, lays: { cut: 0, of: 1 } }),
]

export const CUTBOARD: Cutboard = {
  asOf: '2026-10-29T09:42:00.000Z',
  site: SITE,
  sites: [siteRef(SITE)],
  day: '2026-10-29',
  today: '2026-10-29',
  tiles: { planned: 1, released: 2, inProgress: 2, late: 1 },
  lays: { atTable: 1, waitingFabric: 1 },
  plan: { planned: 120, cut: 96, cutThatDay: 104, pct: 80 },
  cut: { cutOrders: 1, lays: 2, leatherPieces: 126 },
  hides: 7,
  leather: [{ uom: 'FT2', hides: 7, used: '312.4000', pattern: '252.0000', unmatched: '0.0000', yieldPct: '80.67', plannedPct: '82.00', variancePct: '-1.33' }],
  fabric: { lays: 2, confirmed: 1, estimated: '14.4000', used: '15.0000', differencePct: '4.2' },
  orders: ORDERS,
  more: 3,
}

/** A quiet morning: nothing open, nothing cut yet. */
export const CUTBOARD_EMPTY: Cutboard = {
  ...CUTBOARD,
  tiles: { planned: 0, released: 0, inProgress: 0, late: 0 },
  lays: { atTable: 0, waitingFabric: 0 },
  plan: { planned: 0, cut: 0, cutThatDay: 0, pct: null },
  cut: { cutOrders: 0, lays: 0, leatherPieces: 0 },
  hides: 0,
  leather: [],
  fabric: { lays: 0, confirmed: 0, estimated: '0.0000', used: '0.0000', differencePct: null },
  orders: [],
  more: 0,
}

/** A second site that cuts leather in two area units (never added across). */
export const CUTBOARD_SITE_2: Cutboard = {
  ...CUTBOARD,
  site: SITE_2,
  sites: [siteRef(SITE), siteRef(SITE_2)],
  tiles: { planned: 0, released: 1, inProgress: 0, late: 0 },
  lays: { atTable: 0, waitingFabric: 0 },
  plan: { planned: 8, cut: 8, cutThatDay: 8, pct: 100 },
  cut: { cutOrders: 1, lays: 0, leatherPieces: 40 },
  hides: 3,
  leather: [
    { uom: 'FT2', hides: 2, used: '96.0000', pattern: '79.2000', unmatched: '0.0000', yieldPct: '82.50', plannedPct: '82.00', variancePct: '0.50' },
    { uom: 'M2', hides: 1, used: '4.1000', pattern: '3.2000', unmatched: '0.0000', yieldPct: '78.05', plannedPct: '80.00', variancePct: '-1.95' },
  ],
  fabric: { lays: 0, confirmed: 0, estimated: '0.0000', used: '0.0000', differencePct: null },
  orders: [order(6, { kind: 'LEATHER', siteId: SITE_2.id, item: ref(22, 'PEL-NERA', 'Pelle bovina nera'), colour: ref(23, 'BLK', 'Nero'), garments: 8, lays: null, dueDate: '2026-10-31' })],
  more: 0,
}
