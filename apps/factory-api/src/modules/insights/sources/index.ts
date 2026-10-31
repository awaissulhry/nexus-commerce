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
})
