// RX.0 — Returns shared barrel.
//
// Public surface for the returns domain types + constants. Consumers:
// /fulfillment/returns (workspace, drawer), its command center (RX.1),
// the policies settings page (RX.2), and the analytics surface.

export type {
  ItemChecklist,
  AuditEntry,
  RefundAttempt,
  CreditNoteRow,
  RefundRow,
  ReturnRow,
  RefundDeadlineView,
  ReturnWindowView,
  ReturnPolicyView,
  ReturnFull,
  SavedView,
} from './types'

export {
  STATUS_TONE,
  CHANNEL_TONE,
  STATUSES,
  ACTION_LABEL,
} from './constants'
