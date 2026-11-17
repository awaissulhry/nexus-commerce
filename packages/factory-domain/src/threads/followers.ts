/**
 * Followers of a record (B-W2a-20; COL-011; design shell.panels popup followers "Who follows and why (creator, assignee,
 * mentioned, chose to); Follow / Unfollow for me; add a person", the band's Follow toggle; home.notifications "M — mute
 * this record"), pure. apps/factory-api platform/threads/followers.ts applies them; RecordFollower keeps the record, the
 * person and why they first followed it fixed.
 *
 *   follow      a person who may read the record's thread (threads.read over its company, site and party) follows it:
 *               they chose to (CHOSE), were added by a colleague who may write on it (ADDED, made by that colleague and
 *               told so: B-TH-068), were @mentioned on it (MENTIONED), were given a task or a row of Today on it
 *               (ASSIGNEE), or made it (CREATOR, the modules' create commands call the seam). B-TH-068: on a project shared
 *               with an outside company, the office also adds that company's portal people one by one (ADDED; their row
 *               names their party): the project's brand members, told by the portal's own news, never the office's fan-out
 *   unfollow    removes the row: a later mention or assignment follows again
 *   mute        keeps the row, muted: no news of the record reaches them (a mention of them still does), and nothing
 *               follows them again on its own
 *
 * Following brings the record's news to the person's notifications (FOLLOWING: a note, a mail out, a reply in).
 */

// B-TH-065 (threads plan, schema wave 8/9; PROJ-G04): ADDED, a person a colleague added by hand ("added by Marco"); the only
// reason of a project member of its outside company (only the office adds them).
export const FOLLOW_REASONS = ['CREATOR', 'ASSIGNEE', 'MENTIONED', 'CHOSE', 'ADDED'] as const
export type FollowReason = (typeof FOLLOW_REASONS)[number]

// ---- B-TH-068: the reason a person added by someone else gets (ADDED); adding oneself stays one's own choice (CHOSE).
export const addedReason = (userId: string, byId: string): FollowReason => (userId === byId ? 'CHOSE' : 'ADDED')
// ---- end B-TH-068

/** The most followers a record lists (the popover; the count is exact). */
export const FOLLOWERS_SHOWN = 200

/**
 * Whether an automatic follow (a mention, an assignment, the record's creation) adds a row: only when the person has
 * none (a muted row stays muted and is not touched; a chosen follow keeps its reason).
 */
export const autoFollows = (existing: { readonly muted: boolean } | null): boolean => existing === null

/** What a change of my own follow does: add (following), remove (unfollow), set muted, or nothing. */
export function followChange(existing: { readonly muted: boolean } | null, wanted: { readonly following: boolean; readonly muted: boolean }): 'ADD' | 'REMOVE' | 'MUTE' | 'UNMUTE' | null {
  if (!wanted.following) return existing === null ? null : 'REMOVE'
  if (existing === null) return 'ADD'
  if (existing.muted === wanted.muted) return null
  return wanted.muted ? 'MUTE' : 'UNMUTE'
}
