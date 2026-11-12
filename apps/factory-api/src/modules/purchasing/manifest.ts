import { defineManifest, PUBLIC, SIGNED_IN } from '../../core/manifest'

/**
 * Purchase orders (B-W1-30; SCM-050, SCM-053, SCM-054, SCM-055, SCM-075; A2 SCR-058, SCR-059, SCR-037, SCR-055 "Draft PO"):
 * office only (a floor, portal or link session is refused by audience; the supplier's confirm link is B-W1-31's, receiving
 * B-W1-32's). An order belongs to a company, a delivery site and a supplier, so the handlers check each order with can()
 * and filter the list with scopeWhere() (`record`). Sending (PDF, confirm link, mail) is its own permission; cancelling an
 * order the supplier already holds also needs it (checked in the handler).
 *
 * The supplier's confirm link (B-W1-31): the `link` audience of a PO_CONFIRM link, its action's permission, scope `record`
 * (the link's one order; command() refuses any other record). "Ask for a new link" is public: a dead link has no session,
 * and the answer is the same whatever the token (rate limited per address like the link routes).
 */
export const manifest = defineManifest({
  'GET /purchasing/orders': { audiences: ['office'], permission: 'purchasing.view', scope: 'record' },
  'GET /purchasing/orders/:purchaseOrderId': { audiences: ['office'], permission: 'purchasing.view', scope: 'record' },
  'POST /purchasing/orders': { audiences: ['office'], permission: 'purchasing.manage', scope: 'record' },
  'PATCH /purchasing/orders/:purchaseOrderId': { audiences: ['office'], permission: 'purchasing.manage', scope: 'record' },
  'POST /purchasing/orders/:purchaseOrderId/lines': { audiences: ['office'], permission: 'purchasing.manage', scope: 'record' },
  'PATCH /purchasing/orders/:purchaseOrderId/lines/:lineId': { audiences: ['office'], permission: 'purchasing.manage', scope: 'record' },
  'DELETE /purchasing/orders/:purchaseOrderId/lines/:lineId': { audiences: ['office'], permission: 'purchasing.manage', scope: 'record' },
  'POST /purchasing/from-plan': { audiences: ['office'], permission: 'purchasing.manage', scope: 'record' },
  'POST /purchasing/from-plan/undo': { audiences: ['office'], permission: 'purchasing.manage', scope: 'record' },
  'GET /purchasing/orders/:purchaseOrderId/preview': { audiences: ['office'], permission: 'purchasing.view', scope: 'record' },
  'GET /purchasing/orders/:purchaseOrderId/send-check': { audiences: ['office'], permission: 'purchasing.view', scope: 'record' },
  'POST /purchasing/orders/:purchaseOrderId/send': { audiences: ['office'], permission: 'purchasing.send', scope: 'record' },
  'POST /purchasing/orders/:purchaseOrderId/send-link': { audiences: ['office'], permission: 'purchasing.send', scope: 'record' },
  'POST /purchasing/orders/:purchaseOrderId/cancel': { audiences: ['office'], permission: 'purchasing.manage', scope: 'record' },
  'GET /purchasing/orders/:purchaseOrderId/documents': { audiences: ['office'], permission: 'purchasing.view', scope: 'record' },
  'GET /purchasing/orders/:purchaseOrderId/supplier-view': { audiences: ['office'], permission: 'purchasing.view', scope: 'record' },
  // B-W1-31: the supplier's answer on the order, and its confirm link.
  'GET /purchasing/orders/:purchaseOrderId/answer': { audiences: ['office'], permission: 'purchasing.view', scope: 'record' },
  'POST /purchasing/orders/:purchaseOrderId/proposal/accept': { audiences: ['office'], permission: 'purchasing.send', scope: 'record' },
  'POST /purchasing/orders/:purchaseOrderId/proposal/refuse': { audiences: ['office'], permission: 'purchasing.send', scope: 'record' },
  // B-W2a-52: changes after the send (a revision, a counter-proposal, cancel or close short lines and what they reach), the
  // confirm-by deadline and reminders, the expected deliveries, Send n. A change the supplier is told of also needs
  // purchasing.send (checked in the handler).
  'POST /purchasing/orders/:purchaseOrderId/proposal/counter': { audiences: ['office'], permission: 'purchasing.send', scope: 'record' },
  'POST /purchasing/orders/:purchaseOrderId/change': { audiences: ['office'], permission: 'purchasing.send', scope: 'record' },
  'GET /purchasing/orders/:purchaseOrderId/revisions': { audiences: ['office'], permission: 'purchasing.view', scope: 'record' },
  'POST /purchasing/orders/:purchaseOrderId/lines/cancel': { audiences: ['office'], permission: 'purchasing.manage', scope: 'record' },
  'POST /purchasing/orders/:purchaseOrderId/lines/close-short': { audiences: ['office'], permission: 'purchasing.manage', scope: 'record' },
  'GET /purchasing/orders/:purchaseOrderId/reach': { audiences: ['office'], permission: 'purchasing.view', scope: 'record' },
  'POST /purchasing/orders/:purchaseOrderId/confirm-by': { audiences: ['office'], permission: 'purchasing.manage', scope: 'record' },
  'POST /purchasing/orders/:purchaseOrderId/remind': { audiences: ['office'], permission: 'purchasing.send', scope: 'record' },
  'GET /purchasing/orders/:purchaseOrderId/reminders': { audiences: ['office'], permission: 'purchasing.view', scope: 'record' },
  'GET /purchasing/reminders/due': { audiences: ['office'], permission: 'purchasing.view', scope: 'record' },
  'GET /purchasing/expected': { audiences: ['office'], permission: 'purchasing.view', scope: 'record' },
  'POST /purchasing/orders/send-checks': { audiences: ['office'], permission: 'purchasing.view', scope: 'record' },
  'POST /purchasing/orders/send-many': { audiences: ['office'], permission: 'purchasing.send', scope: 'record' },
  'GET /link/purchase-order': { audiences: ['link'], permission: 'links.open', scope: 'record' },
  'POST /link/purchase-order/confirm': { audiences: ['link'], permission: 'links.confirm', scope: 'record' },
  'POST /link/purchase-order/decline': { audiences: ['link'], permission: 'links.decline', scope: 'record' },
  // B-W1-33 (SCR-100): the supplier's confirmation PDF, uploaded before it answers.
  'POST /link/purchase-order/confirmation': { audiences: ['link'], permission: 'links.confirm', scope: 'record' },
  'POST /link/purchase-order/confirmation/:fileId/complete': { audiences: ['link'], permission: 'links.confirm', scope: 'record' },
  'POST /link/purchase-order/renew': { audiences: PUBLIC, permission: PUBLIC, scope: 'none' },
  // B-W2a-10 (SCM-005): approved sources; read with purchasing.view, kept with purchasing.sources.manage (./supplier-items).
  'GET /purchasing/supplier-items': { audiences: ['office'], permission: 'purchasing.view', scope: 'record' },
  'GET /purchasing/supplier-items/:supplierItemId': { audiences: ['office'], permission: 'purchasing.view', scope: 'record' },
  'POST /purchasing/supplier-items': { audiences: ['office'], permission: 'purchasing.sources.manage', scope: 'record' },
  'PATCH /purchasing/supplier-items/:supplierItemId': { audiences: ['office'], permission: 'purchasing.sources.manage', scope: 'record' },
  'POST /purchasing/supplier-items/:supplierItemId/archive': { audiences: ['office'], permission: 'purchasing.sources.manage', scope: 'record' },
  'POST /purchasing/supplier-items/:supplierItemId/restore': { audiences: ['office'], permission: 'purchasing.sources.manage', scope: 'record' },
  // B-W2a-10 (SCM-034, SCM-036): requests to buy, the queue and "Draft POs for n" (./requests).
  'GET /purchasing/requests': { audiences: ['office'], permission: 'purchasing.view', scope: 'record' },
  'GET /purchasing/requests/counts': { audiences: ['office'], permission: 'purchasing.view', scope: 'record' },
  'GET /purchasing/requests/:kind/:refId': { audiences: ['office'], permission: 'purchasing.view', scope: 'record' },
  'POST /purchasing/requests/preview': { audiences: ['office'], permission: 'purchasing.view', scope: 'record' },
  'POST /purchasing/requests/convert': { audiences: ['office'], permission: 'purchasing.manage', scope: 'record' },
  // B-W2a-25 (SCM-138, SCM-140, SCM-141, SCM-142): subcontract orders; read with purchasing.view, prepared with
  // purchasing.subcontract.manage, the kit out with purchasing.subcontract.kit (its DDT also needs shipping.ddt.issue,
  // checked in the handler), goods back with purchasing.subcontract.receive (./subcontracting).
  'GET /purchasing/subcontracting/orders': { audiences: ['office'], permission: 'purchasing.view', scope: 'record' },
  'GET /purchasing/subcontracting/orders/counts': { audiences: ['office'], permission: 'purchasing.view', scope: 'record' },
  'GET /purchasing/subcontracting/orders/:subcontractOrderId': { audiences: ['office'], permission: 'purchasing.view', scope: 'record' },
  'GET /purchasing/subcontracting/work-orders/:workOrderId/outside-operations': { audiences: ['office'], permission: 'purchasing.view', scope: 'record' },
  'GET /purchasing/subcontracting/stock': { audiences: ['office'], permission: 'purchasing.view', scope: 'record' },
  // B-W2a-56: the released and running work orders a new subcontract order may be made for.
  'GET /purchasing/subcontracting/work-orders': { audiences: ['office'], permission: 'purchasing.view', scope: 'record' },
  'POST /purchasing/subcontracting/orders': { audiences: ['office'], permission: 'purchasing.subcontract.manage', scope: 'record' },
  'PATCH /purchasing/subcontracting/orders/:subcontractOrderId': { audiences: ['office'], permission: 'purchasing.subcontract.manage', scope: 'record' },
  'POST /purchasing/subcontracting/orders/:subcontractOrderId/operations': { audiences: ['office'], permission: 'purchasing.subcontract.manage', scope: 'record' },
  'PATCH /purchasing/subcontracting/orders/:subcontractOrderId/operations/:operationId': { audiences: ['office'], permission: 'purchasing.subcontract.manage', scope: 'record' },
  'DELETE /purchasing/subcontracting/orders/:subcontractOrderId/operations/:operationId': { audiences: ['office'], permission: 'purchasing.subcontract.manage', scope: 'record' },
  'POST /purchasing/subcontracting/orders/:subcontractOrderId/kit': { audiences: ['office'], permission: 'purchasing.subcontract.manage', scope: 'record' },
  'POST /purchasing/subcontracting/orders/:subcontractOrderId/kit/from-work-order': { audiences: ['office'], permission: 'purchasing.subcontract.manage', scope: 'record' },
  'PATCH /purchasing/subcontracting/orders/:subcontractOrderId/kit/:lineId': { audiences: ['office'], permission: 'purchasing.subcontract.manage', scope: 'record' },
  'DELETE /purchasing/subcontracting/orders/:subcontractOrderId/kit/:lineId': { audiences: ['office'], permission: 'purchasing.subcontract.manage', scope: 'record' },
  'POST /purchasing/subcontracting/orders/:subcontractOrderId/issue': { audiences: ['office'], permission: 'purchasing.subcontract.manage', scope: 'record' },
  'POST /purchasing/subcontracting/orders/:subcontractOrderId/reopen': { audiences: ['office'], permission: 'purchasing.subcontract.manage', scope: 'record' },
  'POST /purchasing/subcontracting/orders/:subcontractOrderId/cancel': { audiences: ['office'], permission: 'purchasing.subcontract.manage', scope: 'record' },
  'POST /purchasing/subcontracting/orders/:subcontractOrderId/close': { audiences: ['office'], permission: 'purchasing.subcontract.manage', scope: 'record' },
  'POST /purchasing/subcontracting/orders/:subcontractOrderId/kit/send': { audiences: ['office'], permission: 'purchasing.subcontract.kit', scope: 'record' },
  'POST /purchasing/subcontracting/orders/:subcontractOrderId/kit/:lineId/return': { audiences: ['office'], permission: 'purchasing.subcontract.kit', scope: 'record' },
  'POST /purchasing/subcontracting/orders/:subcontractOrderId/receive': { audiences: ['office'], permission: 'purchasing.subcontract.receive', scope: 'record' },
  // B-W2a-76: the warehouse tablet's subcontract kits, at the device's own site (floor only; the reads and the PDF need kit
  // or receive, the handler asks which; send needs kit, receive needs receive). Never a fee.
  'GET /purchasing/subcontracting/kits': { audiences: ['floor'], permission: SIGNED_IN, scope: 'record' },
  'GET /purchasing/subcontracting/kits/:subcontractOrderId': { audiences: ['floor'], permission: SIGNED_IN, scope: 'record' },
  'POST /purchasing/subcontracting/kits/:subcontractOrderId/send': { audiences: ['floor'], permission: 'purchasing.subcontract.kit', scope: 'record' },
  'POST /purchasing/subcontracting/kits/:subcontractOrderId/receive': { audiences: ['floor'], permission: 'purchasing.subcontract.receive', scope: 'record' },
  'GET /purchasing/subcontracting/kits/:subcontractOrderId/ddts/:ddtId/pdf': { audiences: ['floor'], permission: SIGNED_IN, scope: 'record' },
  // B-W2b-176 (SCM-154 to SCM-157): subcontractor jobs. The workshop's portal (its party; acts also check the capability in the
  // handler: approve, comment, upload; an office preview never acts), its JOB_ACCEPT link (the link's one order), and the
  // office's view of what the workshop said, the job link, the date answer and its acts for a workshop without e-mail (C3).
  'GET /portal/jobs': { audiences: ['partner'], permission: 'portal.jobs.view', scope: 'party' },
  'GET /portal/jobs/:subcontractOrderId': { audiences: ['partner'], permission: 'portal.jobs.view', scope: 'party' },
  'POST /portal/jobs/:subcontractOrderId/accept': { audiences: ['partner'], permission: 'portal.jobs.view', scope: 'party' },
  'POST /portal/jobs/:subcontractOrderId/decline': { audiences: ['partner'], permission: 'portal.jobs.view', scope: 'party' },
  'POST /portal/jobs/:subcontractOrderId/kit': { audiences: ['partner'], permission: 'portal.jobs.view', scope: 'party' },
  'POST /portal/jobs/:subcontractOrderId/kit/photos': { audiences: ['partner'], permission: 'portal.jobs.view', scope: 'party' },
  'POST /portal/jobs/:subcontractOrderId/kit/photos/:fileId/complete': { audiences: ['partner'], permission: 'portal.jobs.view', scope: 'party' },
  'POST /portal/jobs/:subcontractOrderId/progress': { audiences: ['partner'], permission: 'portal.jobs.view', scope: 'party' },
  'POST /portal/jobs/:subcontractOrderId/returns': { audiences: ['partner'], permission: 'portal.jobs.view', scope: 'party' },
  'GET /purchasing/subcontracting/orders/:subcontractOrderId/workshop': { audiences: ['office'], permission: 'purchasing.view', scope: 'record' },
  'POST /purchasing/subcontracting/orders/:subcontractOrderId/job-link': { audiences: ['office'], permission: 'purchasing.subcontract.manage', scope: 'record' },
  'POST /purchasing/subcontracting/orders/:subcontractOrderId/workshop/date': { audiences: ['office'], permission: 'purchasing.subcontract.manage', scope: 'record' },
  'POST /purchasing/subcontracting/orders/:subcontractOrderId/workshop/accept': { audiences: ['office'], permission: 'purchasing.subcontract.manage', scope: 'record' },
  'POST /purchasing/subcontracting/orders/:subcontractOrderId/workshop/decline': { audiences: ['office'], permission: 'purchasing.subcontract.manage', scope: 'record' },
  'POST /purchasing/subcontracting/orders/:subcontractOrderId/workshop/kit': { audiences: ['office'], permission: 'purchasing.subcontract.manage', scope: 'record' },
  'POST /purchasing/subcontracting/orders/:subcontractOrderId/workshop/progress': { audiences: ['office'], permission: 'purchasing.subcontract.manage', scope: 'record' },
  'POST /purchasing/subcontracting/orders/:subcontractOrderId/workshop/returns': { audiences: ['office'], permission: 'purchasing.subcontract.manage', scope: 'record' },
  'POST /purchasing/subcontracting/orders/:subcontractOrderId/workshop/returns/:returnNoticeId/cancel': { audiences: ['office'], permission: 'purchasing.subcontract.receive', scope: 'record' },
  'GET /link/job': { audiences: ['link'], permission: 'links.open', scope: 'record' },
  'POST /link/job/accept': { audiences: ['link'], permission: 'links.accept', scope: 'record' },
  'POST /link/job/move-date': { audiences: ['link'], permission: 'links.moveDate', scope: 'record' },
  'POST /link/job/decline': { audiences: ['link'], permission: 'links.decline', scope: 'record' },
  // B-W2a-44 (SCM-134): supplier claims and returns to the supplier; read with purchasing.view, kept with
  // purchasing.claims.manage, the goods back with purchasing.claims.return (the return DDT also needs shipping.ddt.issue,
  // and "Return to supplier" in one go claims.manage too: both checked in the handler) (./claims).
  'GET /purchasing/claims': { audiences: ['office'], permission: 'purchasing.view', scope: 'record' },
  'GET /purchasing/claims/counts': { audiences: ['office'], permission: 'purchasing.view', scope: 'record' },
  'GET /purchasing/claims/:claimId': { audiences: ['office'], permission: 'purchasing.view', scope: 'record' },
  'POST /purchasing/claims': { audiences: ['office'], permission: 'purchasing.claims.manage', scope: 'record' },
  'PATCH /purchasing/claims/:claimId': { audiences: ['office'], permission: 'purchasing.claims.manage', scope: 'record' },
  'POST /purchasing/claims/:claimId/lines': { audiences: ['office'], permission: 'purchasing.claims.manage', scope: 'record' },
  'PATCH /purchasing/claims/:claimId/lines/:lineId': { audiences: ['office'], permission: 'purchasing.claims.manage', scope: 'record' },
  'DELETE /purchasing/claims/:claimId/lines/:lineId': { audiences: ['office'], permission: 'purchasing.claims.manage', scope: 'record' },
  'GET /purchasing/claims/:claimId/send-check': { audiences: ['office'], permission: 'purchasing.claims.manage', scope: 'record' },
  'POST /purchasing/claims/:claimId/send': { audiences: ['office'], permission: 'purchasing.claims.manage', scope: 'record' },
  'POST /purchasing/claims/:claimId/answer': { audiences: ['office'], permission: 'purchasing.claims.manage', scope: 'record' },
  'POST /purchasing/claims/:claimId/close': { audiences: ['office'], permission: 'purchasing.claims.manage', scope: 'record' },
  'POST /purchasing/claims/:claimId/cancel': { audiences: ['office'], permission: 'purchasing.claims.manage', scope: 'record' },
  'POST /purchasing/claims/:claimId/return': { audiences: ['office'], permission: 'purchasing.claims.return', scope: 'record' },
  'POST /purchasing/claims/returns': { audiences: ['office'], permission: 'purchasing.claims.return', scope: 'record' },
  // B-W2b-14 (SCM-135; Z1:08): the claim's photos (files.upload / files.delete too, checked by the handler) and its letter.
  'POST /purchasing/claims/:claimId/photos': { audiences: ['office'], permission: 'purchasing.claims.manage', scope: 'record' },
  'POST /purchasing/claims/:claimId/photos/:fileId/complete': { audiences: ['office'], permission: 'purchasing.claims.manage', scope: 'record' },
  'DELETE /purchasing/claims/:claimId/photos/:fileId': { audiences: ['office'], permission: 'purchasing.claims.manage', scope: 'record' },
  'GET /purchasing/claims/:claimId/letter': { audiences: ['office'], permission: 'purchasing.view', scope: 'record' },
  'POST /purchasing/claims/:claimId/letter': { audiences: ['office'], permission: 'purchasing.claims.manage', scope: 'record' },
  // B-W2b-14 (Z1:09): where the Owner's reminder switch stands (purchasing.view) and the switch itself (the owner's, step-up).
  'GET /purchasing/reminders/settings': { audiences: ['office'], permission: 'purchasing.view', scope: 'record' },
  'PUT /purchasing/reminders/settings/switch': { audiences: ['office'], permission: 'purchasing.reminders.switch', scope: 'record' },
  // B-W2b-219: the leather area tolerance where a PO line names none.
  'GET /purchasing/settings/leather-tolerance': { audiences: ['office'], permission: 'purchasing.view', scope: 'record' },
  'PUT /purchasing/settings/leather-tolerance': { audiences: ['office'], permission: 'purchasing.manage', scope: 'record' },
  // B-W2b-174 (SCM-094, SCM-086): the supplier's purchase orders in the portal, the session's party (row-level security), no
  // grain. Answering also needs the person's capability portal.approve (checked in the handler; an office preview never).
  'GET /portal/purchase-orders': { audiences: ['partner'], permission: 'portal.purchaseOrders.view', scope: 'party' },
  'GET /portal/purchase-orders/:purchaseOrderId': { audiences: ['partner'], permission: 'portal.purchaseOrders.view', scope: 'party' },
  'GET /portal/purchase-orders/:purchaseOrderId/revisions': { audiences: ['partner'], permission: 'portal.purchaseOrders.view', scope: 'party' },
  'GET /portal/purchase-orders/:purchaseOrderId/copy': { audiences: ['partner'], permission: 'portal.purchaseOrders.view', scope: 'party' },
  'POST /portal/purchase-orders/:purchaseOrderId/confirm': { audiences: ['partner'], permission: 'portal.purchaseOrders.view', scope: 'party' },
  'POST /portal/purchase-orders/:purchaseOrderId/decline': { audiences: ['partner'], permission: 'portal.purchaseOrders.view', scope: 'party' },
  // B-W2b-182 (SCM-106, SCM-107): the supplier's ship notices, the session's party, no grain. Announcing, the packing list,
  // sending and cancelling also need the person's capability portal.upload (checked in the handler; an office preview never).
  'GET /portal/ship-notices': { audiences: ['partner'], permission: 'portal.shipNotices.view', scope: 'party' },
  'GET /portal/ship-notices/shippable': { audiences: ['partner'], permission: 'portal.shipNotices.view', scope: 'party' },
  'GET /portal/ship-notices/template': { audiences: ['partner'], permission: 'portal.shipNotices.view', scope: 'party' },
  'GET /portal/ship-notices/:shipNoticeId': { audiences: ['partner'], permission: 'portal.shipNotices.view', scope: 'party' },
  'POST /portal/ship-notices': { audiences: ['partner'], permission: 'portal.shipNotices.view', scope: 'party' },
  'PATCH /portal/ship-notices/:shipNoticeId': { audiences: ['partner'], permission: 'portal.shipNotices.view', scope: 'party' },
  'PUT /portal/ship-notices/:shipNoticeId/packing-list': { audiences: ['partner'], permission: 'portal.shipNotices.view', scope: 'party' },
  'POST /portal/ship-notices/:shipNoticeId/packing-list/sheet': { audiences: ['partner'], permission: 'portal.shipNotices.view', scope: 'party' },
  'POST /portal/ship-notices/:shipNoticeId/send': { audiences: ['partner'], permission: 'portal.shipNotices.view', scope: 'party' },
  'POST /portal/ship-notices/:shipNoticeId/cancel': { audiences: ['partner'], permission: 'portal.shipNotices.view', scope: 'party' },
  // B-W2b-189 (SCM-096, SCM-097): the supplier's documents and profile, the session's party (row-level security), no grain.
  // Sending a document also needs the person's capability portal.upload (checked in the handler; an office preview never).
  'GET /portal/supplier-documents': { audiences: ['partner'], permission: 'portal.supplierDocuments.view', scope: 'party' },
  'POST /portal/supplier-documents': { audiences: ['partner'], permission: 'portal.supplierDocuments.view', scope: 'party' },
  'POST /portal/supplier-documents/:fileId/complete': { audiences: ['partner'], permission: 'portal.supplierDocuments.view', scope: 'party' },
  'GET /portal/supplier-profile': { audiences: ['partner'], permission: 'portal.supplierProfile.view', scope: 'party' },
  'POST /portal/supplier-profile/changes': { audiences: ['partner'], permission: 'portal.supplierProfile.change', scope: 'party' },
  'POST /portal/supplier-profile/changes/:requestId/withdraw': { audiences: ['partner'], permission: 'portal.supplierProfile.change', scope: 'party' },
  // B-W2b-189: the office's check (can() over each upload's or request's company and supplier in the handler).
  'GET /purchasing/supplier-documents': { audiences: ['office'], permission: 'purchasing.supplierDocuments.review', scope: 'record' },
  'POST /purchasing/supplier-documents/:fileId/accept': { audiences: ['office'], permission: 'purchasing.supplierDocuments.review', scope: 'record' },
  'POST /purchasing/supplier-documents/:fileId/refuse': { audiences: ['office'], permission: 'purchasing.supplierDocuments.review', scope: 'record' },
  'GET /purchasing/supplier-changes': { audiences: ['office'], permission: 'purchasing.supplierChanges.decide', scope: 'record' },
  'POST /purchasing/supplier-changes/:requestId/approve': { audiences: ['office'], permission: 'purchasing.supplierChanges.decide', scope: 'record' },
  'POST /purchasing/supplier-changes/:requestId/refuse': { audiences: ['office'], permission: 'purchasing.supplierChanges.decide', scope: 'record' },
  // B-W2b-172 (SCM-023): the supplier questionnaire. The office (can() over the company and the supplier in the handler):
  // versions read with purchasing.questionnaire.view, kept with .manage; the link sent with .send; the answer reviewed with
  // .review. The supplier's SUPPLIER_ONBOARD link: reading and the VAT check links.open, documents and the answer links.submit.
  'GET /purchasing/questionnaires': { audiences: ['office'], permission: 'purchasing.questionnaire.view', scope: 'record' },
  'POST /purchasing/questionnaires': { audiences: ['office'], permission: 'purchasing.questionnaire.manage', scope: 'record' },
  'PATCH /purchasing/questionnaires/:questionnaireId': { audiences: ['office'], permission: 'purchasing.questionnaire.manage', scope: 'record' },
  'POST /purchasing/questionnaires/:questionnaireId/publish': { audiences: ['office'], permission: 'purchasing.questionnaire.manage', scope: 'record' },
  'GET /purchasing/suppliers/:partyId/questionnaire': { audiences: ['office'], permission: 'purchasing.questionnaire.view', scope: 'record' },
  'POST /purchasing/suppliers/:partyId/questionnaire-link': { audiences: ['office'], permission: 'purchasing.questionnaire.send', scope: 'record' },
  'POST /purchasing/questionnaire-answers/:responseId/review': { audiences: ['office'], permission: 'purchasing.questionnaire.review', scope: 'record' },
  'GET /link/supplier-questionnaire': { audiences: ['link'], permission: 'links.open', scope: 'record' },
  'POST /link/supplier-questionnaire': { audiences: ['link'], permission: 'links.submit', scope: 'record' },
  'POST /link/supplier-questionnaire/vat-check': { audiences: ['link'], permission: 'links.open', scope: 'record' },
  'POST /link/supplier-questionnaire/documents': { audiences: ['link'], permission: 'links.submit', scope: 'record' },
  'POST /link/supplier-questionnaire/documents/:fileId/complete': { audiences: ['link'], permission: 'links.submit', scope: 'record' },
  'GET /link/supplier-questionnaire/code-of-conduct': { audiences: ['link'], permission: 'links.open', scope: 'record' },
  // B-W2b-296 (po-depth/): purchase orders in depth, office only (a receipt reads the tolerances inside its own command). An
  // order's depth is checked with can() over the order's company, site and supplier, as every order route; a delivery
  // tolerance over its company (every company's: a role over every company).
  'GET /purchasing/orders/:purchaseOrderId/depth': { audiences: ['office'], permission: 'purchasing.view', scope: 'record' },
  'PUT /purchasing/orders/:purchaseOrderId/lines/:lineId/deliveries': { audiences: ['office'], permission: 'purchasing.manage', scope: 'record' },
  'DELETE /purchasing/orders/:purchaseOrderId/lines/:lineId/deliveries': { audiences: ['office'], permission: 'purchasing.manage', scope: 'record' },
  'POST /purchasing/orders/:purchaseOrderId/lines/:lineId/supplier-date': { audiences: ['office'], permission: 'purchasing.manage', scope: 'record' },
  'PUT /purchasing/orders/:purchaseOrderId/rate': { audiences: ['office'], permission: 'purchasing.manage', scope: 'record' },
  'PUT /purchasing/orders/:purchaseOrderId/ship-to': { audiences: ['office'], permission: 'purchasing.manage', scope: 'record' },
  'GET /purchasing/tolerances': { audiences: ['office'], permission: 'purchasing.view', scope: 'record' },
  'POST /purchasing/tolerances': { audiences: ['office'], permission: 'purchasing.tolerances.manage', scope: 'record' },
  'PATCH /purchasing/tolerances/:toleranceId': { audiences: ['office'], permission: 'purchasing.tolerances.manage', scope: 'record' },
  'POST /purchasing/tolerances/:toleranceId/archive': { audiences: ['office'], permission: 'purchasing.tolerances.manage', scope: 'record' },
  'POST /purchasing/tolerances/:toleranceId/reactivate': { audiences: ['office'], permission: 'purchasing.tolerances.manage', scope: 'record' },
})
