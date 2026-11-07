import type { PartnerEmailFrequency } from './topics'

/**
 * When the partner summaries go (B-W2b-167, COL-063 "As it happens / Daily summary / Weekly summary"): at 08:00 Europe/Rome
 * on working days (Monday to Friday) the DAILY summary; on Monday the same mail also carries the WEEKLY topics (one mail a
 * day at most). A summary lists the person's notifications of those topics that no mail carried yet (no delivery row),
 * still unread, from the last 8 days; nothing to list, nothing sent. The partner's own time zone is not known yet: the
 * business zone is used.
 */

export const PARTNER_DIGEST_TIME = '08:00'
export const PARTNER_DIGEST_WEEKDAYS: readonly number[] = Object.freeze([1, 2, 3, 4, 5])
/** Monday: the weekly summary. */
export const PARTNER_WEEKLY_DAY = 1
export const PARTNER_DIGEST_LOOKBACK_MS = 8 * 86_400_000

/** The frequencies a summary sent now carries, or none when no summary is due (`sentToday`: one went out today already). */
export function digestFrequenciesAt(at: { readonly weekday: number; readonly clock: string }, sentToday: boolean): PartnerEmailFrequency[] {
  if (sentToday || !PARTNER_DIGEST_WEEKDAYS.includes(at.weekday) || at.clock < PARTNER_DIGEST_TIME) return []
  return at.weekday === PARTNER_WEEKLY_DAY ? ['DAILY', 'WEEKLY'] : ['DAILY']
}
