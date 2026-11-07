import { RECORD_RULES } from './records'
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
])
