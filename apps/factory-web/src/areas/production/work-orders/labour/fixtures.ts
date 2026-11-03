import { DETAIL_221, ROLES, withoutCost } from '../../../finance/costing/demo/fixtures'
import type { WorkOrderCost } from '../../../finance/costing/api'
import { costingCanOf } from '../../../finance/costing/model'
import type { OffStandardMinutes } from './api'
import type { LabourModel } from './model'

/**
 * Made-up cost for the design cases of the work order's Labour & cost tab (SCR-070, B-W2a-72): the same invented work
 * order as Finance › Standard vs actual (standard 4,600.00, actual so far 5,028.00). Design-only (no designScreen: the
 * cases sit in SCR-070's fixtures).
 */

export const LABOUR = { value: DETAIL_221, problem: null }

const code = (id: string, labelIt: string, labelEn: string) => ({ code: id, labelIt, labelEn, labelI18n: {} })

/** B-W2b-81: made-up off-standard minutes of the same work order: per state and code, never per person. */
export const OFF_STANDARD: OffStandardMinutes = {
  minutes: 95,
  approved: 60,
  waiting: 20,
  running: 15,
  blocks: 4,
  codes: [
    { code: code('WAIT_MATERIAL', 'Attesa materiale', 'Waiting for material'), minutes: 60, blocks: 2 },
    { code: code('WAIT_HELP', 'Attesa aiuto', 'Waiting for help'), minutes: 20, blocks: 1 },
    { code: code('MACHINE_DOWN', 'Macchina ferma', 'Machine down'), minutes: 15, blocks: 1 },
  ],
}
export const NO_OFF_STANDARD: OffStandardMinutes = { minutes: 0, approved: 0, waiting: 0, running: 0, blocks: 0, codes: [] }

const AS = { finance: ROLES.finance, manager: ROLES.manager, none: ['home.view', 'workorders.view'] } as const

/** The tab as a person with these permissions reads it (no cost grain: the figures dropped as the API drops them). */
export function labourAs(role: keyof typeof AS, part: { value: WorkOrderCost | null; problem: string | null } | null, offStandard: LabourModel['offStandard'] = { value: OFF_STANDARD, problem: null }): LabourModel {
  const can = costingCanOf(AS[role])
  return { can, part: part && part.value && !can.cost ? { ...part, value: withoutCost(part.value) } : part, offStandard }
}
