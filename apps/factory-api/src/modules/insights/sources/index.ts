import type { AttentionKind } from '@nexus/factory-domain/insights/attention'
import type { Source } from './common'
import { registerDuty, styleHold } from './compliance'
import { invoiceSdi, invoiceToIssue } from './invoicing'
import { privacyDuty } from './privacy'
import { scanCorrection, scanRefusal, workOrderHeld } from './production'
import { poNotConfirmed, poProposal } from './purchasing'
import { lotHold } from './quality'
import { orderPromise, quoteApproval } from './sales'

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
})
