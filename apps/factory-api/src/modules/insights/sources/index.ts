import type { AttentionKind } from '@nexus/factory-domain/insights/attention'
import type { Source } from './common'
import { registerDuty, styleHold } from './compliance'
import { invoiceSdi, invoiceToIssue } from './invoicing'
import { mailToSort } from './mail'
import { privacyDuty } from './privacy'
import { scanCorrection, scanRefusal, workOrderHeld } from './production'
import { poNotConfirmed, poProposal } from './purchasing'
import { lotHold } from './quality'
import { orderPromise, quoteApproval } from './sales'
import { mentioned, taskDue } from './personal'
import { ruleAlerts } from './alerts'
import { ncrDecision } from './ncr-decisions'
// B-W2b-190: order requests customers sent from the portal.
import { portalOrderRequest } from './portal-order-requests'
import { portalChangeRequests } from './portal-change-requests'
// B-W2b-189: what suppliers sent in the portal that waits for a check (profile changes, documents).
import { supplierChange, supplierDocument } from './supplier-changes'
// B-W2b-F13b: delivery addresses customers added in the portal, waiting for our check.
import { deliveryAddress } from './delivery-addresses'
// B-W2b-307: change orders, SMV changes and inspection plan versions waiting for my approval, and the approval engine's requests.
import { changeOrderApproval } from './change-orders'
import { smvChange } from './smv-changes'
import { planVersion } from './plan-versions'
import { approvalTask } from './approval-tasks'
// B-W2b-385 (NT1:02): inquiries waiting for us over a working day.
import { inquiryWaiting } from './inquiries'

/** One source per kind of Today (factory-domain insights/attention ATTENTION_KINDS). */
export const SOURCES: Readonly<Record<AttentionKind, Source>> = Object.freeze({
  ORDER_PROMISE: orderPromise,
  WORK_ORDER_HELD: workOrderHeld,
  LOT_HOLD: lotHold,
  INVOICE_SDI: invoiceSdi,
  QUOTE_APPROVAL: quoteApproval,
  PO_PROPOSAL: poProposal,
  PO_NOT_CONFIRMED: poNotConfirmed,
  SCAN_CORRECTION: scanCorrection,
  SCAN_REFUSAL: scanRefusal,
  INVOICE_TO_ISSUE: invoiceToIssue,
  REGISTER_DUTY: registerDuty,
  PRIVACY_DUTY: privacyDuty,
  STYLE_COMPLIANCE: styleHold,
  MAIL_TO_SORT: mailToSort,
  // B-W2a-20: the person's own rows (Today asks for them with `include`).
  TASK_DUE: taskDue,
  MENTION: mentioned,
  // B-W2a-33: my open alerts of the exception rules (Today asks for them with include=ALERTS).
  RULE_ALERT: ruleAlerts,
  // B-W2b-17: NCR decisions waiting for an approval (the Approvals tile).
  NCR_DECISION: ncrDecision,
  // B-W2b-190: order requests from the customer portal waiting for a decision (the Approvals tile).
  PORTAL_ORDER_REQUEST: portalOrderRequest,
  // B-W2b-183: customers' change and cancel requests from the portal waiting for an answer (the Approvals tile).
  ORDER_CHANGE_REQUEST: portalChangeRequests,
  // B-W2b-189: suppliers' changes of addresses and contacts, and their documents, waiting for a check (the Approvals tile).
  SUPPLIER_CHANGE: supplierChange,
  SUPPLIER_DOCUMENT: supplierDocument,
  // B-W2b-F13b: delivery addresses customers added in the portal, waiting for our check (the Approvals tile).
  DELIVERY_ADDRESS: deliveryAddress,
  // B-W2b-307 (PLT-085; AW2:01-03): every request that needs my yes, in the Approvals tile and Home › Approvals.
  CHANGE_ORDER: changeOrderApproval,
  SMV_CHANGE: smvChange,
  PLAN_VERSION: planVersion,
  APPROVAL_TASK: approvalTask,
  // B-W2b-385 (NT1:02): an inquiry waiting for us over a working day, the assignee's or (nobody has it) the answerers'.
  INQUIRY_WAITING: inquiryWaiting,
})
