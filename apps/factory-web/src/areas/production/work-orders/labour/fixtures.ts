import { DETAIL_221, ROLES, withoutCost } from '../../../finance/costing/demo/fixtures'
import type { WorkOrderCost } from '../../../finance/costing/api'
import { costingCanOf } from '../../../finance/costing/model'
import type { LabourModel } from './model'

/**
 * Made-up cost for the design cases of the work order's Labour & cost tab (SCR-070, B-W2a-72): the same invented work
 * order as Finance › Standard vs actual (standard 4,600.00, actual so far 5,028.00). Design-only (no designScreen: the
 * cases sit in SCR-070's fixtures).
 */

export const LABOUR = { value: DETAIL_221, problem: null }

const AS = { finance: ROLES.finance, manager: ROLES.manager, none: ['home.view', 'workorders.view'] } as const

/** The tab as a person with these permissions reads it (no cost grain: the figures dropped as the API drops them). */
export function labourAs(role: keyof typeof AS, part: { value: WorkOrderCost | null; problem: string | null } | null): LabourModel {
  const can = costingCanOf(AS[role])
  return { can, part: part && part.value && !can.cost ? { ...part, value: withoutCost(part.value) } : part }
}
