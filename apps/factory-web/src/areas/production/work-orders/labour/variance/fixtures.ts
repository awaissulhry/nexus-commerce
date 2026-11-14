import { defineDesignScreen } from '../../../../../lib/design/design-screen'
import { DEMO_USER } from '../../../../../shell/design-data'
import { at, type Role } from '../../../_shared/fixtures'
import type { WorkOrderStatus } from '../../../_shared/api'
import { CLOSE_ROLES, closeRecord, FIGURES_WITHIN, SPLIT, withoutCost } from '../../close/fixtures'
import { recordCase, RecordDesign, type RecordCase } from '../../record/fixtures'
import type { Split } from '../../close/api'
import { LABOUR, labourAs } from '../fixtures'
import type { StoredClose, WorkOrderCloses } from './api'
import type { VarianceModel } from './model'

/**
 * SCR-461 — Variance at close on the work order's Labour & cost tab (design production.workorders rec:labour wo-cost "W2b
 * variance at close (MES-012)"; B-W2b-424) with made-up data only: the invented WO-00009's close settled with its split
 * (leather price and usage, scrap, labour efficiency and rate; the lines explain all that was left, closing entry 0.00), a
 * close as a status only while the accountant's switch was off, the preview of a completed work order (and while the switch
 * is off, and with nothing to compare with), the closes taken back (undone within seconds, reopened with a reason), not
 * closed yet, the states (loading, failed) and the production manager without the cost grain (the whole cost section is
 * withheld, the variance with it). Per work order, category and material: never per person.
 */

const uid = (n: number) => `0190f0e2-4343-7000-8000-${String(n).padStart(12, '0')}`
const ENTRY = (n: number, reversalOfId: string | null = null) => ({ id: uid(n), reversalOfId })
const PERSON = { id: DEMO_USER.id, name: DEMO_USER.displayName }

const stored = (record: Parameters<typeof closeRecord>[0], extra: Partial<Pick<StoredClose, 'lines' | 'closing' | 'entries'>> = {}): StoredClose => ({
  ...closeRecord(record),
  lines: SPLIT.lines,
  closing: 0,
  entries: [ENTRY(1), ENTRY(2), ENTRY(3), ENTRY(4), ENTRY(5), ENTRY(6)],
  ...extra,
})

const closes = (list: StoredClose[]): WorkOrderCloses => ({ workOrder: { id: uid(9), number: 'WO-00009', status: 'CLOSED' }, currency: 'EUR', closes: list })

const SETTLED = closes([stored({})])
const STATUS_ONLY = closes([stored({ settled: false }, { lines: [], closing: null, entries: [] })])
/** Closed on 28 Oct and undone a few seconds later; closed again, then reopened with a reason; closed for good on 29 Oct. */
const WITH_HISTORY = closes([
  stored({}),
  stored({ id: uid(702), closedAt: at(28, 16, 40), undoneAt: at(28, 17, 5), undoneBy: PERSON, reopenReason: 'Two more jackets found finished in packing: counted again', live: false }, { entries: [ENTRY(11), ENTRY(12), ENTRY(13, uid(11)), ENTRY(14, uid(12))] }),
  stored({ id: uid(703), closedAt: at(28, 16, 20), undoneAt: new Date(Date.parse(at(28, 16, 20)) + 9_000).toISOString(), undoneBy: PERSON, live: false, settled: false }, { lines: [], closing: null, entries: [] }),
])
const NONE_YET = closes([])

const NO_BASIS: Split = { basis: null, lines: [], balance: 30240, explained: 0, closing: 30240, notSplit: [{ category: null, code: 'NO_BASIS' }, ...SPLIT.notSplit] }

const variance = (status: WorkOrderStatus, over: Partial<VarianceModel> = {}): VarianceModel => ({
  can: { view: true, cost: true },
  status,
  preview: status === 'COMPLETED' ? { split: SPLIT, settles: true, problem: null } : null,
  closes: status === 'COMPLETED' || status === 'CLOSED' ? { value: status === 'CLOSED' ? SETTLED : NONE_YET, problem: null } : null,
  ...over,
})

const tab = (role: Role, status: WorkOrderStatus, model: VarianceModel | null, cost = true): RecordCase =>
  recordCase(role, status, { tab: 'labour', labour: labourAs(cost ? 'finance' : 'manager', LABOUR), variance: model, close: { can: cost ? CLOSE_ROLES.owner : CLOSE_ROLES.managerNoCost, check: null, dialog: null, busy: false, problem: null, undo: null } })

export const designScreen = defineDesignScreen<RecordCase>({
  screen: 'SCR-461',
  title: 'Variance at close on the work order’s Labour & cost tab: the split by category, the closing entry, a preview before the close, closes taken back',
  view: RecordDesign,
  cases: [
    { id: 'settled', label: 'Owner · closed and settled: the lines explain all that was left (closing entry 0,00)', model: tab('owner', 'CLOSED', variance('CLOSED')), note: 'Leather price +60.00, usage +156.00, scrap +78.00, labour efficiency −15.00, rate +23.40 = 302.40 explained; closing 0.00.' },
    { id: 'status-only', label: 'Closed as a status while the accountant’s switch was off: nothing split, how to settle it', model: tab('owner', 'CLOSED', variance('CLOSED', { closes: { value: STATUS_ONLY, problem: null } })) },
    { id: 'history', label: 'Closes taken back: one undone within seconds, one reopened with a reason (who, inside this record)', model: tab('owner', 'CLOSED', variance('CLOSED', { closes: { value: WITH_HISTORY, problem: null } })) },
    { id: 'preview', label: 'Completed, not closed yet: what the close would write now; rework and lot size not split', model: tab('owner', 'COMPLETED', variance('COMPLETED')) },
    { id: 'preview-waits', label: 'Completed while the accountant’s switch is off: the preview with "Waits for the accountant…"', model: tab('owner', 'COMPLETED', variance('COMPLETED', { preview: { split: SPLIT, settles: false, problem: null } })) },
    { id: 'no-basis', label: 'Completed with nothing to compare with: no lines, the closing entry takes all that is left', model: tab('owner', 'COMPLETED', variance('COMPLETED', { preview: { split: NO_BASIS, settles: true, problem: null } })) },
    { id: 'not-yet', label: 'In progress: the variance is taken at the close', model: tab('owner', 'IN_PROGRESS', variance('IN_PROGRESS')) },
    { id: 'loading', label: 'Reading the variance at close', model: tab('owner', 'CLOSED', variance('CLOSED', { closes: { value: null, problem: null } })) },
    { id: 'error', label: 'The read failed: in words with Try again (never drawn as empty)', model: tab('owner', 'CLOSED', variance('CLOSED', { closes: { value: null, problem: 'problem.unavailable' } })) },
    { id: 'no-cost', label: 'Production manager without the cost grain: the whole cost section withheld with why (the variance with it)', model: tab('manager', 'CLOSED', { ...variance('CLOSED', { closes: { value: withoutCost(SETTLED), problem: null } }), can: { view: true, cost: false } }, false) },
    { id: 'within', label: 'Closed within the tolerance, nothing to split', model: tab('owner', 'CLOSED', variance('CLOSED', { closes: { value: closes([stored({ figures: FIGURES_WITHIN, beyond: { quantity: false, material: false, minutes: false, scrap: false, any: false }, reasonCode: null, reasonNote: null }, { lines: [], closing: 0, entries: [ENTRY(21)] })]), problem: null } })) },
  ],
})
