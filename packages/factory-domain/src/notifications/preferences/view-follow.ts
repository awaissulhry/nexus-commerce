import { createHash } from 'node:crypto'

/**
 * Follow a saved view (B-W2b-385; PLT-151 "Follow a record or a saved view: told when it changes or when an item enters or
 * leaves the view"), pure. A person follows a saved view they see (notify-depth.prisma ViewFollower: the view's rows when they
 * were last counted for them, as a fingerprint of the row ids, how many and when). apps/factory-api
 * platform/notifications/view-follow counts each followed view AS ITS PERSON (the list's own read, through its export source:
 * the same rows, filters and scopes as the screen) every quarter of an hour; when the rows changed, the person is told (a
 * FOLLOWING notification: what came in and what left, when the last ids are still known) and the count moves on.
 *
 * Following a record is W2a's RecordFollower: a followed record's messages since W2a, its status and stage changes since this
 * step (platform/notifications/view-follow/records.ts).
 */

export const VIEW_FOLLOW_LIMITS = Object.freeze({
  /** The most rows a followed view is counted to ("1000+" beyond). */
  maxRows: 1000,
  /** Views one person follows. */
  perPerson: 50,
  /** Followed views counted per tenant in one run (oldest count first). */
  perRun: 100,
  /** Rows read per page of a list. */
  page: 200,
})

/** The fingerprint of a view's rows: SHA-256 (hex) of its row ids, sorted and unique (the database checks the shape). */
export function viewFingerprint(ids: readonly string[]): string {
  return createHash('sha256').update([...new Set(ids)].sort().join('\n')).digest('hex')
}

/** What came in and what left between two counts of a view (by row id). */
export function viewChange(previous: readonly string[], current: readonly string[]): { readonly entered: number; readonly left: number } {
  const before = new Set(previous)
  const now = new Set(current)
  let entered = 0
  let left = 0
  for (const id of now) if (!before.has(id)) entered += 1
  for (const id of before) if (!now.has(id)) left += 1
  return { entered, left }
}

/** The key of one person's follow of one view (ViewFollower.key; the database checks it begins so). */
export const viewFollowKey = (viewId: string, userId: string): string => `view:${viewId}:${userId}`
