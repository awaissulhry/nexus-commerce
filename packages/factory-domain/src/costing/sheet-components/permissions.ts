import { definePermissions } from '../../auth/permissions/registry'
import type { Permission } from '../../core/permissions'

/**
 * The permission of the cost sheet's components (B-W2b-418; FIN-003, FIN-008, FIN-009, FIN-011), in the costing area, office
 * only. Reading the components, a sheet's split and a work order's split is costing.view (figures only with the cost grain);
 * switching piece-rate labour on a company's sheets is costing.rates.manage, the costing settings' own (GATE-PIECE-PAY: the
 * database lets it on only while a site of the company pays piece rates).
 *
 *   sheets.manage   write a DRAFT cost sheet's lines from its components, and keep what the components read: each leather's
 *                   cost basis (unit of area, expected yield, grade mix) and what lands on a price (freight, duty and
 *                   insurance on a material or a kind, typed or read from landed cost; a workshop's transport out and back)
 */
export const COST_SHEET_COMPONENTS_DEFINITIONS = definePermissions('costing', {
  'sheets.manage': {
    risk: 'write',
    description:
      "Write a draft cost sheet's lines from its components (leather's bought area, labour, outside operations with their transport, freight and duty on materials, packaging, overhead) and keep the inputs they read: each leather's cost basis (area unit, expected yield, grade mix) and the freight, duty, insurance or transport that lands on a price. Sending a figure needs the cost grain.",
  },
})

export const COSTING_SHEETS_MANAGE = 'costing.sheets.manage' satisfies Permission

export const COST_SHEET_COMPONENTS_PERMISSIONS: readonly Permission[] = Object.freeze([COSTING_SHEETS_MANAGE])

/** The role templates that get it (owner: every()): finance, who keeps the costing. */
export const COST_SHEET_COMPONENTS_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  finance: [COSTING_SHEETS_MANAGE],
})
