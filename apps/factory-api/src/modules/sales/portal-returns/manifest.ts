import { defineManifest } from '../../../core/manifest'

/**
 * Returns and complaints from outside (B-W2b-192; SAL-334, SAL-424; follow-ups CO5:01, CO5:02).
 *
 * The portal (partner sessions only, inside their party; the case must be of the portal's company: the handler, else 404):
 * every route needs the Returns & claims page (portal.returns.view); asking (portal.returns.request; a photo also the upload
 * capability) is checked by the handler, so a person who may only read is told why in words and who to ask; the
 * complaints' investigation list needs portal.complaints.view.
 * The claim link (link sessions of a CLAIM link; the tracking page's "Report a problem" from a SHIPMENT_TRACK link):
 * opening is links.open, sending a case and its photos links.submit.
 * The office: a portal request authorised or rejected and a claim link made (the returns' own sales.returns.manage over
 * the record); a complaint's answer published and its 8D shared (quality.complaints.manage, the handler checks the rest).
 * The routes of modules/quality/complaints/portal are registered here (the route loader reads two folder levels).
 */
const view = { audiences: ['partner'], permission: 'portal.returns.view', scope: 'party' } as const
const quality = { audiences: ['partner'], permission: 'portal.complaints.view', scope: 'party' } as const
const open = { audiences: ['link'], permission: 'links.open', scope: 'record' } as const
const submit = { audiences: ['link'], permission: 'links.submit', scope: 'record' } as const
const returnsManage = { audiences: ['office'], permission: 'sales.returns.manage', scope: 'record' } as const
const complaintsManage = { audiences: ['office'], permission: 'quality.complaints.manage', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /portal/returns': view,
  'GET /portal/returns/returnable': view,
  'POST /portal/returns': view,
  'POST /portal/returns/files/:fileId/open': view,
  'GET /portal/returns/:returnId': view,
  'GET /portal/returns/:returnId/instructions': view,
  'POST /portal/returns/:returnId/cancel': view,
  'POST /portal/returns/:returnId/photos': view,
  'POST /portal/returns/:returnId/photos/:fileId/complete': view,
  'POST /portal/complaints': view,
  'GET /portal/complaints': quality,
  'GET /portal/complaints/:complaintId': view,
  'POST /portal/complaints/:complaintId/photos': view,
  'POST /portal/complaints/:complaintId/photos/:fileId/complete': view,

  'GET /link/claim': open,
  'POST /link/claim': submit,
  'GET /link/claim/cases/:caseType/:caseId': open,
  'POST /link/claim/photos': submit,
  'POST /link/claim/photos/:fileId/complete': submit,
  'POST /link/claim/files/:fileId/open': open,
  'GET /link/claim/returns/:returnId/instructions': open,
  'POST /link/tracking/claim': open,

  'POST /sales/returns/:returnId/authorise': returnsManage,
  'POST /sales/returns/:returnId/reject': returnsManage,
  'POST /sales/claim-links': returnsManage,
  'POST /quality/complaints/:complaintId/answer/publish': complaintsManage,
  'POST /quality/complaints/:complaintId/share-eight-d': complaintsManage,
})
