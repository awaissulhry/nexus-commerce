import { defineManifest } from '../../../core/manifest'

/**
 * Repairs and alterations in depth (B-W2b-342; SAL-384, SAL-385, SAL-387, SAL-391, SAL-393; follow-ups RR1:01, RR1:02).
 *
 * The office (B-W2a-57's permissions; handlers check each repair with can() over its company, site and customer: `record`):
 * the intake, its damage photos and the garment's history read with sales.repairs.view; the estimate read with view and
 * written with sales.repairs.manage (the handler also asks the price grain: an estimate is prices).
 * The portal (partner sessions inside their party; B-W2b-192's Returns & claims page permission portal.returns.view): asking,
 * answering an estimate and a photo also need portal.returns.request (a photo the upload capability, an answer the price
 * grain), checked by the handler in words.
 * The claim link (link sessions of a CLAIM link): reading is links.open, sending a repair and its photos links.submit.
 */
const view = { audiences: ['office'], permission: 'sales.repairs.view', scope: 'record' } as const
const manage = { audiences: ['office'], permission: 'sales.repairs.manage', scope: 'record' } as const
const portal = { audiences: ['partner'], permission: 'portal.returns.view', scope: 'party' } as const
const open = { audiences: ['link'], permission: 'links.open', scope: 'record' } as const
const submit = { audiences: ['link'], permission: 'links.submit', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /sales/repairs/history': view,
  'GET /sales/repairs/:repairId/intake': view,
  'POST /sales/repairs/:repairId/photos': manage,
  'POST /sales/repairs/:repairId/photos/:fileId/complete': manage,
  'GET /sales/repairs/:repairId/estimates': view,
  'POST /sales/repairs/:repairId/estimates': manage,
  'PATCH /sales/repairs/estimates/:estimateId': manage,
  'POST /sales/repairs/estimates/:estimateId/lines': manage,
  'PATCH /sales/repairs/estimates/:estimateId/lines/:lineId': manage,
  'DELETE /sales/repairs/estimates/:estimateId/lines/:lineId': manage,
  'POST /sales/repairs/estimates/:estimateId/send': manage,
  'POST /sales/repairs/estimates/:estimateId/answer': manage,
  'POST /sales/repairs/estimates/:estimateId/withdraw': manage,

  'GET /portal/repairs': portal,
  'POST /portal/repairs': portal,
  'POST /portal/repairs/files/:fileId/open': portal,
  'GET /portal/repairs/:repairId': portal,
  'POST /portal/repairs/:repairId/photos': portal,
  'POST /portal/repairs/:repairId/photos/:fileId/complete': portal,
  'POST /portal/repairs/:repairId/estimate/answer': portal,

  'GET /link/claim/repair': open,
  'POST /link/claim/repair': submit,
  'GET /link/claim/repair/:repairId': open,
  'POST /link/claim/repair/photos': submit,
  'POST /link/claim/repair/photos/:fileId/complete': submit,
  'POST /link/claim/repair/files/:fileId/open': open,
})
