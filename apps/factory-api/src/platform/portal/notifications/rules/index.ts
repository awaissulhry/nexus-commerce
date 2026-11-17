import { ADDRESS_RULES } from './addresses'
import { CHANGE_REQUEST_RULES } from './change-requests'
import { RECORD_RULES } from './records'
// B-PR-31: a customer's own production (stage, health, hold, our urgency acts, a problem it reported answered).
import { PRODUCTION_RULES } from './production'
// B-TH-011: a customer's requests (received, a question from us, declined; a catalogue order not accepted).
import { REQUEST_NEWS_RULES } from './requests'
import { TASK_RULES } from './tasks'
import type { PartnerRule } from './types'

/**
 * The partner notification rules (B-W2b-167, PLT-148), one file per source. A portal step that tells partners of its own
 * records adds its file here, one line (a merge point).
 */
export const PARTNER_RULES: readonly PartnerRule[] = Object.freeze([
  // B-W2b-167: the one task list (a request opened, a reminder) and the W1/W2a records' news (orders, dates, shipped,
  // invoices, claims, our messages).
  ...TASK_RULES,
  ...RECORD_RULES,
  // B-W2b-183: the office's answer to a change or cancel request from the portal.
  ...CHANGE_REQUEST_RULES,
  // B-W2b-F15: our check of a delivery address the person added (approved, or refused with the reason).
  ...ADDRESS_RULES,
  // B-TH-011
  ...REQUEST_NEWS_RULES,
  // B-PR-31
  ...PRODUCTION_RULES,
])
