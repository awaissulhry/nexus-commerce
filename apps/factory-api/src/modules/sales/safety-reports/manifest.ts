import { defineManifest, PUBLIC } from '../../../core/manifest'

/**
 * Product-safety reports and the accident log (B-W2b-351; SAL-414, SAL-415, SAL-423).
 *
 * The office: handlers check each report with can() over its company and, when it names one, its customer (`record`).
 * Recording a report also opens its SAFETY service case (sales.service.manage, the handler); opening a PPE register entry for it
 * compliance.register.manage (the handler). Whether someone was hurt: sales.safety.injury (the product-safety role). The
 * accident log's revisions: sales.safety.log.
 * The portal (partner sessions of a customer, inside their party): the Returns & claims page (portal.returns.view); sending a
 * report and its photos also portal.returns.request (and the upload capability), checked by the handler in words.
 * The public DoC page: PUBLIC, the abuse guard and route limits; photos with the signed ticket the send gave.
 * The portal's and the public doors are OFF until the privacy notice for these reports is published (GATE-PRIVACY).
 */
const view = { audiences: ['office'], permission: 'sales.safety.view', scope: 'record' } as const
const manage = { audiences: ['office'], permission: 'sales.safety.manage', scope: 'record' } as const
const injury = { audiences: ['office'], permission: 'sales.safety.injury', scope: 'record' } as const
const log = { audiences: ['office'], permission: 'sales.safety.log', scope: 'record' } as const
const portal = { audiences: ['partner'], permission: 'portal.returns.view', scope: 'party' } as const
const open = { audiences: PUBLIC, permission: PUBLIC, scope: 'none' } as const

export const manifest = defineManifest({
  'GET /sales/safety-reports': view,
  'GET /sales/safety-reports/counts': view,
  'GET /sales/safety-reports/accident-log': view,
  'POST /sales/safety-reports': manage,
  'GET /sales/safety-reports/:reportId': view,
  'PATCH /sales/safety-reports/:reportId': manage,
  'POST /sales/safety-reports/:reportId/seen': manage,
  'POST /sales/safety-reports/:reportId/status': manage,
  'POST /sales/safety-reports/:reportId/register-entry': manage,
  'POST /sales/safety-reports/:reportId/reporter/erase': manage,
  'POST /sales/safety-reports/:reportId/injury/open': injury,
  'POST /sales/safety-reports/:reportId/injury': injury,
  'POST /sales/safety-reports/:reportId/injury/erase': injury,
  'GET /sales/safety-reports/:reportId/accident-log': view,
  'POST /sales/safety-reports/:reportId/accident-log': log,
  'POST /sales/safety-reports/:reportId/photos': manage,
  'POST /sales/safety-reports/:reportId/photos/:fileId/complete': manage,
  'POST /sales/safety-reports/:reportId/photos/:fileId/open': view,

  'GET /portal/safety-reports/status': portal,
  'POST /portal/safety-reports': portal,
  'POST /portal/safety-reports/:reportId/photos': portal,
  'POST /portal/safety-reports/:reportId/photos/:fileId/complete': portal,

  'GET /public/safety-reports/status': open,
  'POST /public/safety-reports': open,
  'POST /public/safety-reports/photos': open,
  'POST /public/safety-reports/photos/:fileId/complete': open,
})
