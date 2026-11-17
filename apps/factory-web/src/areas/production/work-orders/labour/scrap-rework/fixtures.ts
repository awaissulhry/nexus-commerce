import { defineDesignScreen } from '../../../../../lib/design/design-screen'
import type { WorkOrderStatus } from '../../../_shared/api'
import type { Role } from '../../../_shared/fixtures'
import { CLOSE_ROLES } from '../../close/fixtures'
import { recordCase, RecordDesign, type RecordCase } from '../../record/fixtures'
import { LABOUR, LABOUR_CLOSED, labourAs } from '../fixtures'
import type { ScrapRework } from './api'
import type { ScrapReworkModel } from './model'

/**
 * SCR-461-scrap — the Scrap value line on the work order's Labour & cost tab (design production.workorders rec:labour wo-cost;
 * FIN-029; B-W2b-GB02, B-W2b-424's gap 5; F-PR-06: the second scrap card went, Quality is the scrap home) with made-up data
 * only: the invented WO-2026-0221's scrap and rework value (a stitching fault and a leather flaw at an operation, one scrap
 * with no reason given, leather scrapped from stock, a rework at the standard minutes and cost per minute); a rework with no
 * cost per minute in force (the value not known, never 0); nothing scrapped; the states (loading, failed); a closed work order
 * (its facts say Closed); the production manager without the cost grain (the whole cost section withheld). Never per person.
 */

/**
 * Stitching fault: 2 garments scrapped (78.00), 3 reworked × 12 min = 36 min at 0.375 (13.50). Leather flaw: 1 garment
 * (39.00). No reason: 1 garment, its value still waiting (0.00). Damaged leather from stock: 23.40. Total 153.90.
 */
const SCRAP: ScrapRework = {
  workOrder: { id: '0190f0e2-4646-7000-8000-000000000001', number: 'WO-2026-0221', status: 'IN_PROGRESS' },
  currency: 'EUR',
  rows: [
    { reasonCode: 'DAMAGED', scrappedGarments: 0, scrapValue: 0, stockScrapValue: 2340, reworkGarments: 0, reworkMinutes: '0.0000', reworkCost: 0, total: 2340 },
    { reasonCode: 'LEATHER_FLAW', scrappedGarments: 1, scrapValue: 3900, stockScrapValue: 0, reworkGarments: 0, reworkMinutes: '0.0000', reworkCost: 0, total: 3900 },
    { reasonCode: 'NO_REASON', scrappedGarments: 1, scrapValue: 0, stockScrapValue: 0, reworkGarments: 0, reworkMinutes: '0.0000', reworkCost: 0, total: 0 },
    { reasonCode: 'STITCH_FAULT', scrappedGarments: 2, scrapValue: 7800, stockScrapValue: 0, reworkGarments: 3, reworkMinutes: '36.0000', reworkCost: 1350, total: 9150 },
  ],
  totals: { scrappedGarments: 4, scrapValue: 11700, stockScrapValue: 2340, reworkGarments: 3, reworkMinutes: '36.0000', reworkCost: 1350, total: 15390 },
}
/** The same, with no cost per minute in force for the stitching rework. */
const NO_RATE: ScrapRework = {
  ...SCRAP,
  rows: SCRAP.rows.map((row) => (row.reasonCode === 'STITCH_FAULT' ? { ...row, reworkCost: null, total: null } : row)),
  totals: { ...SCRAP.totals, reworkCost: null, total: null },
}
const NONE: ScrapRework = { ...SCRAP, rows: [], totals: { scrappedGarments: 0, scrapValue: 0, stockScrapValue: 0, reworkGarments: 0, reworkMinutes: '0.0000', reworkCost: 0, total: 0 } }

const scrap = (part: ScrapReworkModel['part']): ScrapReworkModel => ({ part })

const tab = (role: Role, status: WorkOrderStatus, model: ScrapReworkModel | null, cost = true): RecordCase => {
  const labour = labourAs(cost ? 'finance' : 'manager', status === 'CLOSED' ? LABOUR_CLOSED : LABOUR)
  return recordCase(role, status, { tab: 'labour', labour: { ...labour, scrapRework: model }, variance: null, close: { can: cost ? CLOSE_ROLES.owner : CLOSE_ROLES.managerNoCost, check: null, dialog: null, busy: false, problem: null, undo: null } })
}

export const designScreen = defineDesignScreen<RecordCase>({
  screen: 'SCR-461-scrap',
  title: 'Scrap value on the work order’s Labour & cost tab: one line, its door to Quality (the scrap home)',
  view: RecordDesign,
  cases: [
    { id: 'rows', label: 'Owner · the scrap and rework value in one line (a fault, a flaw, no reason given, leather from stock), its door to Quality', model: tab('owner', 'IN_PROGRESS', scrap({ value: SCRAP, problem: null })), note: '78.00 + 13.50 + 39.00 + 0.00 + 23.40 = 153.90. The reasons are on Quality.' },
    { id: 'no-rate', label: 'A rework with no cost per minute in force: the value not known (never 0)', model: tab('owner', 'IN_PROGRESS', scrap({ value: NO_RATE, problem: null })) },
    { id: 'none', label: 'Nothing scrapped or reworked', model: tab('owner', 'IN_PROGRESS', scrap({ value: NONE, problem: null })) },
    { id: 'closed', label: 'Closed work order: its cost facts say Closed; the scrap value below', model: tab('owner', 'CLOSED', scrap({ value: { ...SCRAP, workOrder: { ...SCRAP.workOrder, status: 'CLOSED' } }, problem: null })) },
    { id: 'loading', label: 'Reading the scrap value', model: tab('owner', 'IN_PROGRESS', scrap({ value: null, problem: null })) },
    { id: 'error', label: 'The read failed: in words with Try again (never drawn as empty)', model: tab('owner', 'IN_PROGRESS', scrap({ value: null, problem: 'problem.unavailable' })) },
    { id: 'no-cost', label: 'Production manager without the cost grain: the whole cost section withheld with why', model: tab('manager', 'IN_PROGRESS', null, false) },
  ],
})
