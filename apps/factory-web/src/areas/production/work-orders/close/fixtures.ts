import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { DEMO_USER } from '../../../../shell/design-data'
import { at, ROLES, workOrder, type Role } from '../../_shared/fixtures'
import { recordCase, RecordDesign, type RecordCase } from '../record/fixtures'
import { CLOSE_REASONS, type CloseCheck, type CloseFigures, type CloseRecord, type Split } from './api'
import { closeCanOf } from './model'
import type { CloseModel } from './use-close'

/**
 * SCR-460 — Close work order (design production.workorders pop:wo-close; MES-012, MES-013; B-W2b-424) with made-up data only:
 * the invented work order WO-00009 (24 jackets planned), its planned against actual figures within the 5 % tolerance and
 * beyond it (24 → 22 garments, material 2,450.00 → 2,690.00, 2 scrapped), the reason and its words, what the close settles
 * or "Waits for the accountant…", Close held with its reason (no reason chosen, words missing, costs still waiting, no right),
 * a refusal said in the dialog, the Undo after a close (and too late), a closed work order's close (settled, a status only,
 * closed before the close was recorded) with Reopen… and the reopen dialog. Roles: Owner, Production manager (with and
 * without the cost grain), Team leader and Sales (no right to close or reopen). The office user named is the demo's own.
 */

const uid = (n: number) => `0190f0e2-4242-7000-8000-${String(n).padStart(12, '0')}`
const WO = workOrder('COMPLETED')
const CLOSED_WO = workOrder('CLOSED')
const COST_PERMISSIONS = ['costing.view', 'money.cost']

/** Each role's close abilities: the production roles' permissions with what the close adds (reopen: production manager; cost: owner). */
export const CLOSE_ROLES = {
  owner: closeCanOf([...ROLES.owner, 'workorders.reopen', ...COST_PERMISSIONS]),
  manager: closeCanOf([...ROLES.manager, 'workorders.reopen', ...COST_PERMISSIONS]),
  managerNoCost: closeCanOf([...ROLES.manager, 'workorders.reopen', 'costing.view']),
  teamLeader: closeCanOf(ROLES.teamLeader),
  sales: closeCanOf(ROLES.sales),
} as const

const figures = (over: Partial<CloseFigures> = {}): CloseFigures => ({
  plannedQuantity: 24,
  actualQuantity: 24,
  plannedScrapQuantity: 0,
  scrapQuantity: 0,
  plannedMaterialCost: 245000,
  actualMaterialCost: 249800,
  plannedMinutes: '2400.0000',
  actualMinutes: '2460.0000',
  currency: 'EUR',
  ...over,
})

/** Within: 24 of 24 made, material +2.0 %, minutes +2.5 %, nothing scrapped. */
export const FIGURES_WITHIN = figures()
/** Beyond: 22 of 24 made (−8.3 %), material 2,450.00 → 2,690.00 (+9.8 %), minutes 2,400 → 2,340 (−2.5 %), 2 scrapped (8.3 % of 24). */
export const FIGURES_BEYOND = figures({ actualQuantity: 22, scrapQuantity: 2, actualMaterialCost: 269000, actualMinutes: '2340.0000' })
const NONE = { quantity: false, material: false, minutes: false, scrap: false, any: false }
const BEYOND = { quantity: true, material: true, minutes: false, scrap: true, any: true }

const LEATHER = { id: uid(501), code: 'DEMO-LTH-01', name: 'Pelle bovina demo', baseUom: 'FT2' }

/**
 * The split of the beyond case against the standard of the 22 garments made: leather price +60.00 (600 ft² × 0.10), leather
 * usage +156.00 (640 ft² used − 600 standard = 40 × 3.90), scrap +78.00 (20 ft² of 2 garments × 3.90), lining usage 0, labour
 * efficiency −15.00 (2,340 − 2,400 min × 0.25), labour rate +23.40; explained 302.40, left 302.40, closing 0.00.
 */
export const SPLIT: Split = {
  basis: 'STANDARD',
  lines: [
    { id: uid(601), category: 'MATERIAL_PRICE', item: LEATHER, standardQuantity: '600.0000', actualQuantity: '600.0000', standardUnitCost: '3.900000', actualUnitCost: '4.000000', amount: 6000, note: null },
    { id: uid(602), category: 'MATERIAL_USAGE', item: LEATHER, standardQuantity: '600.0000', actualQuantity: '640.0000', standardUnitCost: '3.900000', actualUnitCost: null, amount: 15600, note: null },
    { id: uid(603), category: 'SCRAP', item: LEATHER, standardQuantity: '0.0000', actualQuantity: '20.0000', standardUnitCost: '3.900000', actualUnitCost: null, amount: 7800, note: null },
    { id: uid(604), category: 'LABOUR_EFFICIENCY', item: null, standardQuantity: '2400.0000', actualQuantity: '2340.0000', standardUnitCost: '0.250000', actualUnitCost: null, amount: -1500, note: null },
    { id: uid(605), category: 'LABOUR_RATE', item: null, standardQuantity: '2340.0000', actualQuantity: '2340.0000', standardUnitCost: '0.250000', actualUnitCost: '0.260000', amount: 2340, note: null },
  ],
  balance: 30240,
  explained: 30240,
  closing: 0,
  notSplit: [
    { category: 'REWORK', code: 'NOT_ON_LEDGER' },
    { category: 'LOT_SIZE', code: 'NO_SET_UP' },
  ],
}

/** The same work order as a person without the cost grain reads it (the amounts dropped as the API drops them). */
export function withoutCost<T>(value: T): T {
  const MONEY = new Set(['plannedMaterialCost', 'actualMaterialCost', 'standardUnitCost', 'actualUnitCost', 'amount', 'balance', 'explained', 'closing'])
  const strip = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(strip)
    if (entry === null || typeof entry !== 'object') return entry
    return Object.fromEntries(Object.entries(entry as Record<string, unknown>).filter(([key]) => !MONEY.has(key)).map(([key, inner]) => [key, strip(inner)]))
  }
  return strip(value) as T
}

const REASONS = CLOSE_REASONS.map((code) => ({ code, noteNeeded: code === 'OTHER' }))
const PERSON = { id: DEMO_USER.id, name: DEMO_USER.displayName }

export const closeCheck = (over: Partial<CloseCheck> = {}): CloseCheck => ({
  workOrder: { id: WO.id, number: WO.number, status: 'COMPLETED', version: WO.version, companyId: WO.companyId, siteId: WO.siteId },
  closable: true,
  refusal: null,
  figures: FIGURES_WITHIN,
  tolerancePct: '5.00',
  beyond: NONE,
  reasonNeeded: false,
  reasons: REASONS,
  settles: true,
  waits: null,
  toPost: 0,
  waiting: [],
  split: null,
  undoSeconds: 60,
  live: null,
  ...over,
})

export const BEYOND_CHECK = closeCheck({ figures: FIGURES_BEYOND, beyond: BEYOND, reasonNeeded: true, split: SPLIT })

/** The close that stands on WO-00009 (closed 29 Oct, beyond the tolerance for the hides' yield). */
export const closeRecord = (over: Partial<CloseRecord> = {}): CloseRecord => ({
  id: uid(701),
  workOrderId: WO.id,
  figures: FIGURES_BEYOND,
  tolerancePct: '5.00',
  beyond: BEYOND,
  reasonCode: 'LEATHER_YIELD',
  reasonNote: 'Two hides with a scar along the back: panels recut',
  closedAt: at(29, 9, 0),
  closedBy: PERSON,
  undoneAt: null,
  undoneBy: null,
  reopenReason: null,
  live: true,
  settled: true,
  undoUntil: null,
  can: { undo: false, reopen: true },
  ...over,
})

const closedCheck = (live: CloseRecord | null, over: Partial<CloseCheck> = {}): CloseCheck =>
  closeCheck({ workOrder: { id: CLOSED_WO.id, number: CLOSED_WO.number, status: 'CLOSED', version: CLOSED_WO.version, companyId: CLOSED_WO.companyId, siteId: CLOSED_WO.siteId }, closable: false, refusal: { code: 'NOT_COMPLETED' }, figures: FIGURES_BEYOND, beyond: BEYOND, live, ...over })

export const closeModel = (can: CloseModel['can'], over: Partial<CloseModel> = {}): CloseModel => ({ can, check: { value: closeCheck(), problem: null }, dialog: null, busy: false, problem: null, undo: null, ...over })

const ready = (value: CloseCheck) => ({ value, problem: null })
const completed = (role: Role, close: CloseModel): RecordCase => recordCase(role, 'COMPLETED', { close })
const closed = (role: Role, close: CloseModel): RecordCase => recordCase(role, 'CLOSED', { close })

const waitsCheck = closeCheck({ figures: FIGURES_BEYOND, beyond: BEYOND, reasonNeeded: true, settles: false, waits: 'Waits for the accountant.', split: SPLIT })
const waitingCheck = closeCheck({
  toPost: 1,
  waiting: [
    { code: 'NO_RATE', sourceType: 'OperationScan', sourceId: uid(801) },
    { code: 'NO_RATE', sourceType: 'OperationScan', sourceId: uid(802) },
    { code: 'NOT_VALUED', sourceType: 'StockMove', sourceId: uid(803) },
  ],
})

export const designScreen = defineDesignScreen<RecordCase>({
  screen: 'SCR-460',
  title: 'Close work order: planned against actual, a reason beyond the tolerance, what it settles, Undo for a few seconds, Reopen with a reason',
  view: RecordDesign,
  cases: [
    { id: 'within', label: 'Production manager · within the 5 % tolerance: no reason needed; the close settles the cost', model: completed('manager', closeModel(CLOSE_ROLES.manager, { dialog: 'close' })), note: '24 of 24 made; material 2,450.00 → 2,498.00 (+2.0 %); minutes 2,400 → 2,460 (+2.5 %); nothing scrapped.' },
    { id: 'beyond', label: 'Beyond the tolerance (garments, material, scrap): Close held until a reason is chosen', model: completed('manager', closeModel(CLOSE_ROLES.manager, { dialog: 'close', check: ready(BEYOND_CHECK) })), note: '22 of 24 made (−8.3 %); material +9.8 %; 2 scrapped = 8.3 % of 24; minutes −2.5 % within.' },
    { id: 'beyond-reason', label: 'Beyond: the hides gave a different yield, with a note: Close ready (⌘↵)', model: completed('manager', closeModel(CLOSE_ROLES.manager, { dialog: 'close', check: ready(BEYOND_CHECK), draft: { reason: 'LEATHER_YIELD', note: 'Two hides with a scar along the back: panels recut' } })) },
    { id: 'other-held', label: 'Another reason chosen without words: Close held ("say the reason in words")', model: completed('manager', closeModel(CLOSE_ROLES.manager, { dialog: 'close', check: ready(BEYOND_CHECK), draft: { reason: 'OTHER', note: '' } })) },
    { id: 'to-post', label: 'The close posts first the one cost entry the worker had not posted yet', model: completed('owner', closeModel(CLOSE_ROLES.owner, { dialog: 'close', check: ready(closeCheck({ toPost: 1 })) })) },
    { id: 'waits', label: 'The company’s figures for the accountant are off: "Waits for the accountant…" (the close is a status today)', model: completed('manager', closeModel(CLOSE_ROLES.manager, { dialog: 'close', check: ready(waitsCheck), draft: { reason: 'SHORT_PRODUCED', note: '' } })) },
    { id: 'costs-waiting', label: 'Held: 3 events still wait to be costed (2 scans without a labour rate, 1 move without a value)', model: completed('manager', closeModel(CLOSE_ROLES.manager, { dialog: 'close', check: ready(waitingCheck) })) },
    { id: 'no-cost', label: 'Production manager without the cost grain: material cost not drawn, whether it is beyond still shown', model: completed('manager', closeModel(CLOSE_ROLES.managerNoCost, { dialog: 'close', check: ready(withoutCost(BEYOND_CHECK)) })) },
    { id: 'refused', label: 'Refused by the API (today is in a locked period): said in the dialog, the reason kept', model: completed('manager', closeModel(CLOSE_ROLES.manager, { dialog: 'close', check: ready(BEYOND_CHECK), problem: { key: 'refusal.LOCKED' }, draft: { reason: 'LEATHER_YIELD', note: '' } })) },
    { id: 'changed', label: 'The work order changed meanwhile (409): read again, said in the dialog', model: completed('manager', closeModel(CLOSE_ROLES.manager, { dialog: 'close', problem: { key: 'problem.changed' } })) },
    { id: 'busy', label: 'Closing… (held while it runs)', model: completed('manager', closeModel(CLOSE_ROLES.manager, { dialog: 'close', busy: true })) },
    { id: 'loading', label: 'The dialog reads planned against actual', model: completed('manager', closeModel(CLOSE_ROLES.manager, { dialog: 'close', check: { value: null, problem: null } })) },
    { id: 'error', label: 'The read failed: in words with Try again (Close held)', model: completed('manager', closeModel(CLOSE_ROLES.manager, { dialog: 'close', check: { value: null, problem: 'problem.unavailable' } })) },
    { id: 'no-permission', label: 'Sales · no workorders.manage: Close held on the band with the reason', model: completed('sales', closeModel(CLOSE_ROLES.sales)) },
    { id: 'undo', label: 'Just closed: Undo for a few seconds (pauses while the pointer or the focus is on it)', model: closed('manager', closeModel(CLOSE_ROLES.manager, { undo: { number: WO.number, settled: true, problem: null }, check: ready(closedCheck(closeRecord({ can: { undo: true, reopen: true }, undoUntil: at(29, 9, 1) }))) })) },
    { id: 'undo-status', label: 'Just closed while the accountant’s switch is off: closed as a status, Undo', model: closed('manager', closeModel(CLOSE_ROLES.manager, { undo: { number: WO.number, settled: false, problem: null } })) },
    { id: 'undo-late', label: 'Undo refused: too late (reopen it with a reason instead)', model: closed('manager', closeModel(CLOSE_ROLES.manager, { undo: { number: WO.number, settled: true, problem: { key: 'refusal.UNDO_TOO_LATE' } } })) },
    { id: 'closed', label: 'Closed: who closed it, when, why; its cost settled; Reopen… (workorders.reopen)', model: closed('manager', closeModel(CLOSE_ROLES.manager, { check: ready(closedCheck(closeRecord())) })) },
    { id: 'closed-status', label: 'Closed as a status while the accountant’s switch was off', model: closed('owner', closeModel(CLOSE_ROLES.owner, { check: ready(closedCheck(closeRecord({ settled: false, reasonCode: null, reasonNote: null, figures: FIGURES_WITHIN, beyond: NONE }))) })) },
    { id: 'closed-no-reopen', label: 'Team leader · closed: Reopen held (needs workorders.reopen)', model: closed('teamLeader', closeModel(CLOSE_ROLES.teamLeader, { check: ready(closedCheck(closeRecord({ can: { undo: false, reopen: false } }))) })) },
    { id: 'closed-before-record', label: 'Closed before the close was recorded: Reopen held with why', model: closed('manager', closeModel(CLOSE_ROLES.manager, { check: ready(closedCheck(null)) })) },
    { id: 'closed-reading', label: 'Closed: who closed it still reading (Reopen held)', model: closed('manager', closeModel(CLOSE_ROLES.manager, { check: { value: null, problem: null } })) },
    { id: 'reopen', label: 'Reopen: what it does (its entries reversed) and the reason', model: closed('manager', closeModel(CLOSE_ROLES.manager, { dialog: 'reopen', check: ready(closedCheck(closeRecord())), draft: { reopenReason: 'Two more jackets found finished in packing: counted again' } })) },
    { id: 'reopen-held', label: 'Reopen held until the reason is said', model: closed('manager', closeModel(CLOSE_ROLES.manager, { dialog: 'reopen', check: ready(closedCheck(closeRecord())) })) },
    { id: 'reopen-refused', label: 'Reopen refused (today is in a locked period): said in the dialog, the reason kept', model: closed('manager', closeModel(CLOSE_ROLES.manager, { dialog: 'reopen', check: ready(closedCheck(closeRecord())), problem: { key: 'refusal.LOCKED' }, draft: { reopenReason: 'Two more jackets found finished in packing: counted again' } })) },
  ],
})
