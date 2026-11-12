import { defineManifest } from '../../../core/manifest'

/**
 * Warranty and service cases (B-W2b-345; SAL-368, SAL-436; design sales.service "Warranty & service"). Office only; handlers
 * check each case with can() over its company and, when it names one, its customer (`record`). Deciding the cover needs
 * sales.service.decide; opening a repair or a return from a case also needs sales.repairs.manage or sales.returns.manage
 * (the handler checks the second).
 */
const view = { audiences: ['office'], permission: 'sales.service.view', scope: 'record' } as const
const manage = { audiences: ['office'], permission: 'sales.service.manage', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /sales/service/cases': view,
  'GET /sales/service/cases/counts': view,
  'GET /sales/service/cases/people': view,
  'POST /sales/service/cases/preview': manage,
  'POST /sales/service/cases': manage,
  'GET /sales/service/cases/:caseId': view,
  'PATCH /sales/service/cases/:caseId': manage,
  'POST /sales/service/cases/:caseId/cover': { audiences: ['office'], permission: 'sales.service.decide', scope: 'record' },
  'POST /sales/service/cases/:caseId/status': manage,
  'POST /sales/service/cases/:caseId/links': manage,
  'DELETE /sales/service/cases/:caseId/links/:linkId': manage,
  'POST /sales/service/cases/:caseId/repair': manage,
  'POST /sales/service/cases/:caseId/return': manage,
})
