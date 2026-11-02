import { defineManifest } from '../../../core/manifest'

/**
 * The payroll export (B-W2b-54; MES-267, MES-268, MES-270 to MES-274; GATE-PAYROLL). Office: an export is a company's whole
 * month, so each handler asks the permission over every site of the company with can() (`record`). What names a figure per
 * employee code is people.payroll.records, recorded as a POST; an amount is `money.pay`. Link: a secure link of a PayrollExport
 * reads its own files (links.open, one record); any other link is the one 404.
 */
const view = { audiences: ['office'], permission: 'people.payroll.view', scope: 'record' } as const
const records = { audiences: ['office'], permission: 'people.payroll.records', scope: 'record' } as const
const manage = { audiences: ['office'], permission: 'people.payroll.manage', scope: 'record' } as const
const link = { audiences: ['link'], permission: 'links.open', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /people/payroll/month': view,
  'POST /people/payroll/month/show': records,
  'POST /people/payroll/preview': records,
  'GET /people/payroll/codes': view,
  'PUT /people/payroll/codes': manage,
  'GET /people/payroll/layouts': view,
  'POST /people/payroll/layouts': manage,
  'PATCH /people/payroll/layouts/:layoutId': manage,
  'POST /people/payroll/layouts/:layoutId/archive': manage,
  'GET /people/payroll/exports': view,
  'POST /people/payroll/exports': manage,
  'GET /people/payroll/exports/:exportId': view,
  'POST /people/payroll/exports/:exportId/cancel': manage,
  'POST /people/payroll/exports/:exportId/values': records,
  'POST /people/payroll/exports/:exportId/files/:fileId/open': records,
  'POST /people/payroll/exports/:exportId/send': manage,
  'POST /people/payroll/exports/:exportId/links/:linkId/withdraw': manage,
  'GET /people/payroll/link/files': link,
  'POST /people/payroll/link/files/:fileId/download': link,
})
