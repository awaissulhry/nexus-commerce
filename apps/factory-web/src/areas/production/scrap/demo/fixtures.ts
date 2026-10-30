import { createElement, type ReactNode } from 'react'
import { permissionCheck } from '../../../../lib/session/session'
import { DEMO_COMPANIES, DEMO_TAG, DEMO_USER, OWNER_PERMISSIONS } from '../../../../shell/design-data'
import { officeNavFor } from '../../../../shell/nav/office-nav'
import { OfficeShellView, type OfficeShellViewModel } from '../../../../shell/office/view/OfficeShellView'
import type { Replacement } from '../../cutting/api'
import type { ScrapRow, ScrapTiles } from '../api'
import { scrapCanOf, type ScrapCan } from '../model'

/**
 * Made-up data for the design cases of SCR-140 (Scrap & rework, its detail and Replace scrapped quantity): invented
 * work orders ("WO-26-0031"), bundles, operations, stations, lots, hides and people ("Bea Esempio"); the figures worked
 * out by hand. Nothing here is a real company, person or number. Design-only; it exports no `designScreen`.
 */

const uid = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`
export const at = (day: number, hour: number, minute = 0) => new Date(Date.UTC(2026, 9, day, hour, minute)).toISOString()
export const NOW = Date.parse(at(30, 9, 30))
/** 30 October 2026 00:00 in Rome (UTC+1 after the clocks went back on the 25th). */
export const TODAY_START = Date.parse('2026-10-29T23:00:00.000Z')

const BASE = ['home.view', 'threads.read', 'threads.post', 'files.read']
export const ROLES = {
  owner: [...OWNER_PERMISSIONS, 'workorders.view', 'production.scrap.view', 'production.scrap', 'production.scrap.approve', 'production.cutting.view', 'money.cost'],
  manager: [...BASE, 'workorders.view', 'production.scrap.view', 'production.scrap', 'production.scrap.approve', 'production.cutting.view', 'production.rework'],
  planner: [...BASE, 'workorders.view', 'production.scrap.view', 'production.scrap.approve'],
  inspector: [...BASE, 'workorders.view', 'production.scrap.view', 'production.rework'],
  finance: [...BASE, 'production.scrap.view', 'money.cost'],
  sales: [...BASE, 'orders.view'],
} as const
export type Role = keyof typeof ROLES
export const canAs = (role: Role): ScrapCan => scrapCanOf(ROLES[role])

/** The Office shell around a page at this address (the role's navigation). */
export function inShell(path: string, page: ReactNode, role: Role = 'manager'): ReactNode {
  const shell: OfficeShellViewModel = {
    nav: officeNavFor(permissionCheck(ROLES[role])),
    path,
    switcher: { companies: DEMO_COMPANIES, company: 'DEMO', sites: [], site: null, path },
    user: { displayName: DEMO_USER.displayName, email: DEMO_USER.email },
    tenantTag: DEMO_TAG,
    banners: [],
  }
  return createElement(OfficeShellView, { model: shell }, page)
}
/** The signed-in person of the cases (Carlo Prova asks; Bea Esempio approves). */
export const ME = uid('1616', 2)
const ASKER = { id: ME, name: 'Carlo Prova' }

const JKT = { id: uid('7777', 1), code: 'DEMO-JKT-01', name: 'Giacca pelle demo' }
const PNT = { id: uid('7777', 2), code: 'DEMO-PNT-02', name: 'Pantalone pelle demo' }
const WO31 = { id: uid('3333', 1), number: 'WO-26-0031', status: 'IN_PROGRESS' as const, style: JKT }
const WO29 = { id: uid('3333', 5), number: 'WO-26-0029', status: 'IN_PROGRESS' as const, style: JKT }
const WO36 = { id: uid('3333', 4), number: 'WO-26-0036', status: 'COMPLETED' as const, style: PNT }
const op = (seq: number, code: string, name: string) => ({ id: uid('2525', seq), seq, code, name })
const SEW = op(30, 'CUC-CORPO', 'Cucitura corpo')
const SLEEVE = op(40, 'MONT-MANICHE', 'Montaggio maniche')
const QC = op(70, 'CQ', 'Controllo qualità')
const reason = (code: string, it: string, en: string) => ({ reasonCode: code, reasonLabel: { it, en } })

const scrap = (n: number, over: Partial<ScrapRow>): ScrapRow => ({
  id: `scan:${uid('2626', n)}:STAIN`,
  kind: 'SCRAP',
  source: { type: 'SCAN', id: uid('2626', n) },
  at: at(30, 8, n),
  workOrder: WO31,
  bundle: { id: uid('1818', n), code: `DEMO-BN-${String(n).padStart(4, '0')}` },
  operation: SEW,
  cell: { id: uid('9191', 2), colourwayCode: 'NER', size: '50' },
  part: null,
  pieces: 1,
  ...reason('STAIN', 'Macchia', 'Stain'),
  status: null,
  station: { id: uid('6767', 1), code: 'L1-05' },
  // One size-50 garment holds 43 ft² of leather (made up); valued at 4.20 € per ft² → 180.60 €.
  materials: [{ lotId: uid('5555', 1), lotCode: 'DEMO-LOT-0101', hideId: uid('4444', 1), hideCode: 'DEMO-HD-0001', itemId: uid('8888', 1), uom: 'FT2', area: '43.0000', value: 18060 }],
  replacements: [],
  value: 18060,
  currency: 'EUR',
  ...over,
})

export const ROWS: ScrapRow[] = [
  scrap(1, { pieces: 2, materials: [{ lotId: uid('5555', 1), lotCode: 'DEMO-LOT-0101', hideId: uid('4444', 1), hideCode: 'DEMO-HD-0001', itemId: uid('8888', 1), uom: 'FT2', area: '86.0000', value: 36120 }], value: 36120, replacements: [{ id: uid('1414', 1), kind: 'RECUT', status: 'OPEN', quantity: 1 }] }),
  scrap(2, { id: `scan:${uid('2626', 2)}:CUT_WRONG`, ...reason('CUT_WRONG', 'Taglio errato', 'Wrong cut'), operation: SLEEVE, part: 'sleeve', station: { id: uid('6767', 2), code: 'L1-07' }, replacements: [{ id: uid('1414', 3), kind: 'REDUCE', status: 'OPEN', quantity: 1 }] }),
  scrap(3, { workOrder: WO29, at: at(29, 15, 30), id: `scan:${uid('2626', 3)}:STAIN`, replacements: [{ id: uid('1414', 4), kind: 'REDUCE', status: 'OPEN', quantity: 1 }] }),
  scrap(4, { at: at(29, 11, 10), id: `scan:${uid('2626', 4)}:HOLE`, ...reason('HOLE', 'Foro nella pelle', 'Hole in the leather'), operation: QC, replacements: [{ id: uid('1414', 5), kind: 'RECUT', status: 'DONE', quantity: 1 }] }),
  scrap(5, { workOrder: WO36, at: at(27, 10), id: `scan:${uid('2626', 5)}:STAIN`, cell: { id: uid('9191', 9), colourwayCode: 'NER', size: '48' }, value: null, materials: [] }),
  {
    ...scrap(6, {}),
    id: `rework:${uid('2727', 1)}`,
    kind: 'REWORK',
    source: { type: 'REWORK', id: uid('2727', 1) },
    at: at(30, 7, 45),
    operation: SEW,
    pieces: 3,
    ...reason('SEAM_OPEN', 'Cucitura aperta', 'Open seam'),
    status: 'IN_PROGRESS',
    station: null,
    materials: [],
    value: null,
  },
  {
    ...scrap(7, {}),
    id: `rework-scrap:${uid('2727', 2)}`,
    source: { type: 'REWORK', id: uid('2727', 2) },
    at: at(29, 16, 20),
    operation: QC,
    ...reason('SEAM_OPEN', 'Cucitura aperta', 'Open seam'),
    status: 'DONE',
    station: null,
  },
]
// Tiles: today 2 + 1 pieces scrapped (rows 1, 2), 1 rework open, 1 recut to cut, 2 lower quantities to approve.
export const TILES: ScrapTiles = { scrapToday: 3, reworkOpen: 1, recutsToCut: 1, reductionsToApprove: 2 }

const reduction = (n: number, workOrder: typeof WO31, createdBy: { id: string; name: string }, cellSize = '50'): Replacement => ({
  id: uid('1414', n),
  workOrder: { id: workOrder.id, number: workOrder.number, status: workOrder.status },
  cell: { id: uid('9191', 2), colourwayCode: 'NER', size: cellSize, quantity: 10 },
  kind: 'REDUCE',
  quantity: 1,
  part: null,
  sourceScanId: uid('2626', n === 3 ? 2 : 3),
  reworkOrderId: null,
  reason: 'The customer accepts one garment less',
  status: 'OPEN',
  decidedAt: null,
  decidedBy: null,
  decisionNote: null,
  cutLogId: null,
  doneAt: null,
  note: null,
  version: 1,
  createdAt: at(30, 8, 20),
  createdBy,
})
/** Row 2's request was asked by the signed-in person (Carlo Prova): he never decides it; row 3's by Bea Esempio. */
export const REDUCTIONS: Replacement[] = [reduction(3, WO31, ASKER), reduction(4, WO29, { id: uid('1616', 1), name: 'Bea Esempio' })]
