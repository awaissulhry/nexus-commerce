import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * Report finished to stock (apps/factory-api modules/production/completion; B-W2a-12; GAP-003, MES-011), in the
 * production area. Checked with can() against the work order's company and site. Office only: the pop-up is on the work
 * order record (design production.workorders "Report finished to stock"). What the pop-up shows is read with
 * workorders.view; the finished-goods stock itself with inventory.stock.view. Nothing here carries money (a receipt's
 * value is written by the stock ledger and shown only with the cost grain).
 */
export const PRODUCTION_COMPLETION_DEFINITIONS = definePermissions('production', {
  finish: {
    risk: 'write',
    description:
      "Report a work order's quality-released garments to finished-goods stock, all or part, per size, into a finished-goods place of its site; take a report back with the reason while its garments are still in stock.",
  },
})

export const PRODUCTION_FINISH = 'production.finish' satisfies Permission

export const PRODUCTION_COMPLETION_PERMISSIONS: readonly Permission[] = Object.freeze([PRODUCTION_FINISH])
