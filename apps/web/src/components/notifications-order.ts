/**
 * The order the notification bell shows rows in.
 *
 * Kept pure and out of the component so the rule can be tested on its own, and so
 * the panel cannot quietly re-sort in a way the test does not see.
 *
 * 🔴 Measured 2026-09-16, the first day the bell showed real rows at all: sorted by
 * date alone, the ONE unread notice — a `danger` automation-halt alarm — sat below
 * three read weekly digests and a run of old warnings, while the badge said "1
 * unread". The badge pointed at something the list hid. So:
 *
 *   1. unread before read — the badge's number is a promise about the top of the list
 *   2. among unread, the most severe first — an alarm must never wait behind a digest
 *   3. then newest first
 *
 * Read rows keep plain newest-first order: once seen, severity no longer decides what
 * needs attention, and re-ranking history by severity would make it harder to scan.
 */
export interface OrderableNotification {
  severity: string
  readAt: string | null
  createdAt: string
}

const SEVERITY_RANK: Record<string, number> = { danger: 0, warn: 1, success: 2, info: 2 }

export function notificationRank(severity: string): number {
  return SEVERITY_RANK[severity] ?? 2
}

export function orderNotifications<T extends OrderableNotification>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => {
    const aUnread = a.readAt === null
    const bUnread = b.readAt === null
    if (aUnread !== bUnread) return aUnread ? -1 : 1
    if (aUnread) {
      const bySeverity = notificationRank(a.severity) - notificationRank(b.severity)
      if (bySeverity !== 0) return bySeverity
    }
    return Date.parse(b.createdAt) - Date.parse(a.createdAt)
  })
}
