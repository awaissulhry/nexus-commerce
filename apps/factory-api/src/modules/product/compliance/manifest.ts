import { defineManifest } from '../../../core/manifest'

/**
 * The style compliance tab's routes (B-W1-20; A2 SCR-045 "Style › Compliance"; Reg. (EU) 2016/425). Office only: the
 * floor reads no compliance document (ownership/compliance.json; its labels pass the certificate gate in B-W1-44), and
 * portal and link sessions see none of it (a DoC reaches a customer as a copy on the shipment, B-W1-49). A style
 * belongs to one company or to every company of the tenant, so each handler checks it with can() (`record`). Reading
 * is the certificate register's view permission; uploading the signed DoC and leaflet is compliance.declarations.manage
 * (and files.upload, which the files platform checks).
 */
const view = { audiences: ['office'], permission: 'compliance.certificates.view', scope: 'record' } as const
const manage = { audiences: ['office'], permission: 'compliance.declarations.manage', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /product/styles/:styleId/compliance': view,
  'GET /product/styles/:styleId/compliance/documents': view,
  'GET /product/styles/:styleId/compliance/documents/:documentId': view,
  'POST /product/styles/:styleId/compliance/documents': manage,
  'POST /product/styles/:styleId/compliance/documents/:documentId/files/:fileId/complete': manage,
  'GET /product/styles/:styleId/compliance/documents/:documentId/files/:fileId/download': view,
})
