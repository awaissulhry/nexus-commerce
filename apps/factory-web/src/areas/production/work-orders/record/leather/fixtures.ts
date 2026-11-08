import type { LeatherMaterial, WorkOrderLeather } from './api'

/**
 * Made-up Leather panels for SCR-070's Materials cases (B-W2b-130; no designScreen of its own: the record's fixtures.ts draws them).
 * Invented lots, shades and counts only.
 */

const ID = (n: number) => `0190f0e2-0000-7000-9132-${String(n).padStart(12, '0')}`
const ITEM = { id: ID(1), code: 'PEL-NERA', name: 'Pelle bovina nera', uom: 'FT2' }
const BLACK = { id: ID(2), code: 'BLK', name: 'Nero' }
const lot = (n: number, code: string, shade: string | null, held: number, reserved: number, cut: number, outOfShade = false) => ({
  key: `${ID(10 + n)}|${shade ?? '-'}`,
  lot: { id: ID(10 + n), code, supplierLotRef: n === 1 ? 'CE-2609-A' : null },
  shade,
  outOfShade,
  held,
  reserved,
  cut,
})

const material = (over: Partial<LeatherMaterial>): LeatherMaterial => ({
  item: ITEM,
  colour: BLACK,
  verdict: 'ONE',
  breaksRule: false,
  outOfShade: false,
  lots: [lot(1, 'LOT-DEMO-0028', '2', 2, 1, 3)],
  hides: { held: 2, reserved: 1, cut: 3 },
  ...over,
})

const leather = (materials: LeatherMaterial[], rule: WorkOrderLeather['rule'] = 'ORDER'): WorkOrderLeather => ({ workOrder: { id: ID(99), number: 'WO-00041', status: 'IN_PROGRESS' }, rule, materials })

/** One shade lot: the hides held, reserved and cut all of lot LOT-DEMO-0028, shade 2. */
export const LEATHER_ONE = leather([material({})])
/** Nothing reserved, picked or cut yet: the first hide sets the shade lot. */
export const LEATHER_NONE = leather([material({ verdict: 'NONE', lots: [], hides: { held: 0, reserved: 0, cut: 0 } })])
/** Two shade lots under the ORDER rule (an override at the pick): said in words. */
export const LEATHER_MIXED = leather([
  material({ verdict: 'MIXED', breaksRule: true, lots: [lot(1, 'LOT-DEMO-0028', '2', 1, 0, 3), lot(2, 'LOT-DEMO-0031', '3', 1, 0, 0)], hides: { held: 2, reserved: 0, cut: 3 } }),
])
/** Two shade lots where the site's rule is one per garment: allowed, said. */
export const LEATHER_GARMENT = leather([material({ verdict: 'MIXED', breaksRule: false, lots: [lot(1, 'LOT-DEMO-0028', '2', 1, 0, 2), lot(2, 'LOT-DEMO-0031', null, 0, 1, 0)], hides: { held: 1, reserved: 1, cut: 2 } })], 'GARMENT')
/** A hide of the out-of-shade group reserved by mistake. */
export const LEATHER_OUT_OF_SHADE = leather([material({ verdict: 'ONE', breaksRule: true, outOfShade: true, lots: [lot(3, 'LOT-DEMO-0033', 'Fuori tono', 0, 1, 0, true)], hides: { held: 0, reserved: 1, cut: 0 } })])
