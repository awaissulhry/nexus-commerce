import { defineManifest } from '../../../core/manifest'

/**
 * Earnings and pay periods (B-W2b-43; MES-256, MES-260, MES-261, MES-264, MES-266, MES-304; GATE-PIECE-PAY). The office: a
 * period is a company's, a statement, a hold and an entry a site's, so the handlers check each with can() and filter lists
 * with scopeWhere() (`record`); a figure in an answer or a body is `money.pay` (HR and the worker). The floor: the signed-in
 * worker's own pay at the device's site (`site`), with the PIN again. The report's routes are here too (autoload reads one
 * folder level): its code is ../reports/earnings.
 */
const view = { audiences: ['office'], permission: 'people.earnings.view', scope: 'record' } as const
const records = { audiences: ['office'], permission: 'people.earnings.records', scope: 'record' } as const
const manage = { audiences: ['office'], permission: 'people.earnings.manage', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /people/pay-periods': view,
  'POST /people/pay-periods': manage,
  'GET /people/pay-periods/:periodId': view,
  'POST /people/pay-periods/:periodId/run': manage,
  'POST /people/pay-periods/:periodId/reopen': manage,
  'POST /people/pay-periods/:periodId/review': manage,
  'POST /people/pay-periods/:periodId/review/back': manage,
  'POST /people/pay-periods/:periodId/lock': manage,
  'GET /people/pay-periods/:periodId/statements': view,
  'POST /people/statements/:statementId/open': view,
  'POST /people/statements/:statementId/pdf': records,
  'POST /people/statements/:statementId/approve': manage,
  'POST /people/statements/:statementId/lead-review': { audiences: ['office'], permission: 'people.earnings.review', scope: 'record' },
  'GET /people/employees/:employeeId/statements': records,
  'GET /people/held-scans': view,
  'GET /people/held-scans/:heldScanId': view,
  'POST /people/held-scans/:heldScanId/count': manage,
  'POST /people/held-scans/:heldScanId/not-paid': manage,
  'GET /people/earnings/ledger': records,
  'GET /people/earnings/entries/:entryId': records,
  'POST /people/earnings/entries/:entryId/correct': manage,
  'POST /people/earnings/adjustments': manage,
  'GET /people/earnings/counts': view,
  'GET /people/earnings/labour-cost': { audiences: ['office'], permission: 'costing.view', scope: 'record' },
  'GET /people/earnings/floor/mine': { audiences: ['floor'], permission: 'floor.work', scope: 'site' },
  'GET /people/reports/earnings': view,
  'POST /people/reports/earnings/by-worker': records,
})
