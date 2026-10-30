import { defineManifest } from '../../../core/manifest'

/**
 * Repairs and alterations (B-W2a-57; SAL-383, SAL-390, LOG-116; design sales.returns "Repair order"). Office only;
 * handlers check each repair with can() over its company, site and customer (`record`). The repair work order itself is
 * production's (POST /production/work-orders/repairs, B-W2a-12); the DDT of the way back is shipping's source DDT
 * (B-W2a-17), issued by the ship step in the same command.
 */
const view = { audiences: ['office'], permission: 'sales.repairs.view', scope: 'record' } as const
const manage = { audiences: ['office'], permission: 'sales.repairs.manage', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /sales/repairs': view,
  'GET /sales/repairs/counts': view,
  'POST /sales/repairs/preview': manage,
  'POST /sales/repairs': manage,
  'GET /sales/repairs/:repairId': view,
  'PATCH /sales/repairs/:repairId': manage,
  'POST /sales/repairs/:repairId/receive': { audiences: ['office'], permission: 'sales.repairs.receive', scope: 'record' },
  'POST /sales/repairs/:repairId/stage': manage,
  'POST /sales/repairs/:repairId/safety-check': { audiences: ['office'], permission: 'sales.repairs.check', scope: 'record' },
  'POST /sales/repairs/:repairId/ship': { audiences: ['office'], permission: 'sales.repairs.ship', scope: 'record' },
  'POST /sales/repairs/:repairId/cancel': manage,
})
