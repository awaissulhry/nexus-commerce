import type { CutYield, YieldLot, YieldSupplier } from './api'

/**
 * Made-up Cutting and yield reports for SCR-240's prr-yield cases (B-W2b-130; no designScreen of its own: the reports'
 * fixtures.ts draws them). Invented lots, suppliers, codes and figures only; never a cutter.
 */

const ID = (n: number) => `0190f0e2-0000-7000-9131-${String(n).padStart(12, '0')}`
const SITE = { id: ID(1), code: 'A1', name: 'Stabilimento dimostrativo', timeZone: 'Europe/Rome' }
const COMPANY = ID(2)
const siteRef = ({ id, code, name }: { id: string; code: string; name: string }) => ({ id, code, name })
const LEATHER = { id: ID(10), code: 'PEL-NERA', name: 'Pelle bovina nera' }
const LINING = { id: ID(11), code: 'FOD-GRI', name: 'Fodera grigia' }
const BLACK = { id: ID(12), code: 'BLK', name: 'Nero' }
const GREY = { id: ID(13), code: 'GRY', name: 'Grigio' }
const CONCERIA = { id: ID(20), name: 'Conceria Esempio' }
const PELLAMI = { id: ID(21), name: 'Pellami Dimostrativi' }

const figures = (used: string, pattern: string, yieldPct: string, plannedPct: string, variancePct: string, wastePct: string) => ({
  used,
  unmatched: '0.0000',
  pattern,
  remnant: '6.0000',
  waste: '0.0000',
  wastePct,
  yieldPct,
  plannedPct,
  variancePct,
})

const lot = (n: number, code: string, ref: string | null, supplier: typeof CONCERIA | null, hides: number, f: ReturnType<typeof figures>): YieldLot => ({
  lot: { id: ID(100 + n), code, supplierLotRef: ref },
  supplier,
  item: LEATHER,
  uom: 'FT2',
  hides,
  ...f,
})

const LOTS: YieldLot[] = [
  lot(1, 'LOT-DEMO-0031', 'CE-2611-B', PELLAMI, 6, figures('288.0000', '213.1200', '74.00', '82.00', '-8.00', '24.00')),
  lot(2, 'LOT-DEMO-0028', 'CE-2609-A', CONCERIA, 9, figures('412.5000', '334.1300', '81.00', '82.00', '-1.00', '17.50')),
  lot(3, 'LOT-DEMO-0025', null, CONCERIA, 7, figures('320.0000', '268.8000', '84.00', '82.00', '2.00', '14.50')),
]

const SUPPLIERS: YieldSupplier[] = [
  { supplier: PELLAMI, uom: 'FT2', lots: 1, hides: 6, ...figures('288.0000', '213.1200', '74.00', '82.00', '-8.00', '24.00') },
  { supplier: CONCERIA, uom: 'FT2', lots: 2, hides: 16, ...figures('732.5000', '602.9300', '82.31', '82.00', '0.31', '16.20') },
]

export const CUT_YIELD: CutYield = {
  asOf: '2026-10-29T09:42:00.000Z',
  site: SITE,
  sites: [siteRef(SITE)],
  from: '2026-09-30',
  to: '2026-10-29',
  today: '2026-10-29',
  cut: { orders: 6, ordered: 412, cut: 404, difference: -8, pct: 98, waiting: 1, variances: 2 },
  orders: [
    { id: ID(201), number: 'CO-2026-0016', kind: 'FABRIC', status: 'RECONCILED', companyId: COMPANY, siteId: SITE.id, cutAt: '2026-10-28T10:15:00.000Z', item: LINING, colour: GREY, ordered: 80, cut: 72, reconciled: true },
    { id: ID(202), number: 'CO-2026-0015', kind: 'LEATHER', status: 'CUT', companyId: COMPANY, siteId: SITE.id, cutAt: '2026-10-27T14:30:00.000Z', item: LEATHER, colour: BLACK, ordered: 12, cut: null, reconciled: false },
    { id: ID(203), number: 'CO-2026-0014', kind: 'FABRIC', status: 'CUT', companyId: COMPANY, siteId: SITE.id, cutAt: '2026-10-24T09:00:00.000Z', item: LINING, colour: GREY, ordered: 96, cut: 96, reconciled: false },
  ],
  more: 4,
  fabric: {
    lays: 9,
    waiting: 1,
    estimated: '186.0000',
    used: '191.6000',
    differencePct: '3.0',
    materials: [{ item: LINING, colour: GREY, lays: 9, estimated: '186.0000', used: '191.6000', differencePct: '3.0' }],
  },
  leather: {
    units: [{ uom: 'FT2', hides: 22, ...figures('1020.5000', '816.0500', '79.96', '82.00', '-2.04', '18.40') }],
    materials: [{ item: LEATHER, colour: BLACK, uom: 'FT2', hides: 22, ...figures('1020.5000', '816.0500', '79.96', '82.00', '-2.04', '18.40') }],
    lots: LOTS,
    suppliers: SUPPLIERS,
  },
}

/** A period with nothing cut. */
export const CUT_YIELD_EMPTY: CutYield = {
  ...CUT_YIELD,
  cut: { orders: 0, ordered: 0, cut: 0, difference: 0, pct: null, waiting: 0, variances: 0 },
  orders: [],
  more: 0,
  fabric: { lays: 0, waiting: 0, estimated: '0.0000', used: '0.0000', differencePct: null, materials: [] },
  leather: { units: [], materials: [], lots: [], suppliers: [] },
}

/** Leather only, no cut order reconciled yet (W2a's cutting by the work order, before cut orders). */
export const CUT_YIELD_LEATHER_ONLY: CutYield = {
  ...CUT_YIELD,
  cut: { orders: 0, ordered: 0, cut: 0, difference: 0, pct: null, waiting: 0, variances: 0 },
  orders: [],
  more: 0,
  fabric: { lays: 0, waiting: 0, estimated: '0.0000', used: '0.0000', differencePct: null, materials: [] },
}
