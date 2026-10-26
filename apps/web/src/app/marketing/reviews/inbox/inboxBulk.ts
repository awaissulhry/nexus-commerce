/**
 * Reviews › Inbox — the bulk bar (ticked rows swap the search for Assign · Tag · Set status · Draft with AI · Clear;
 * build spec ruling 7). `POST /reviews/inbox/bulk { ids ≤ 200, action, value }` → `{ changed, skipped }`.
 *
 * Every button says why when it cannot run (held, never a silent grey): no "Manage reviews", nothing ticked, too many.
 * An action that cannot apply to some ticked rows counts the rows it changes ("Set 9 to Resolved", 3 already are); when
 * it can apply to none it is held and names why. The page knows the ticked rows as the grid shows them; the server
 * decides again and its counts are the ones the toast reports. Draft with AI follows each channel's reply rules
 * (`@nexus/shared/review-reply-rules`): no draft where a reply already went out or the window closed.
 * Pure, tested in inboxBulk.vitest.test.ts.
 */
import { reviewReplyRules } from '@nexus/shared/review-reply-rules'
import { STATUS_WORD } from '../_lib/reviewWords'
import type { InboxRow } from './inboxDatasource'
import { count, plural } from './inboxTiles'

export type BulkAction = 'assign' | 'tag' | 'status' | 'draft'
export const BULK_ACTIONS: readonly BulkAction[] = ['assign', 'tag', 'status', 'draft']
export const BULK_MAX = 200
export const BULK_DRAFT_MAX = 50
export const TAG_MAX = 40

export const BULK_LABEL: Record<BulkAction, string> = { assign: 'Assign', tag: 'Tag', status: 'Set status', draft: 'Draft with AI' }

/** The statuses a person sets (Overdue is a time, not a status). */
export const SETTABLE_STATUSES = ['NEW', 'IN_PROGRESS', 'RESPONDED', 'RESOLVED', 'IGNORED'] as const

const MANAGE_DOING: Record<BulkAction, string> = {
  assign: 'assign reviews',
  tag: 'tag reviews',
  status: 'change a review’s status',
  draft: 'draft replies',
}

/** "You need 'Manage reviews' to assign reviews." */
export function manageHeld(action: BulkAction): string {
  return `You need 'Manage reviews' to ${MANAGE_DOING[action]}.`
}

/** What a bulk decision needs to know about one ticked row (as the grid shows it). */
export type BulkRow = Pick<InboxRow, 'id' | 'channel' | 'market' | 'kind' | 'postedAt' | 'imported' | 'status' | 'assignee' | 'responses'>

export interface BulkReach {
  /** The rows the action changes. */
  apply: string[]
  /** The rows it leaves as they are, with why. */
  skipped: { id: string; reason: string }[]
}

function skipReason(action: BulkAction, value: string | null, row: BulkRow, now: Date): string | null {
  switch (action) {
    case 'assign':
      if ((row.assignee ?? null) === (value || null)) return value ? `Already assigned to ${value}.` : 'Nobody is assigned already.'
      return null
    case 'tag':
      // The rows on screen do not carry their tags: the server skips a row that already has the tag.
      return null
    case 'status':
      return value && row.status === value ? `Already ${STATUS_WORD[value] ?? value}.` : null
    case 'draft': {
      const rules = reviewReplyRules(row.channel, {
        kind: row.kind,
        marketplace: row.market,
        postedAt: row.postedAt,
        imported: row.imported,
        replied: row.responses.sent > 0,
      }, now)
      if (rules.held) return rules.held
      if (row.responses.sent > 0) return 'A reply was already sent.'
      if (row.responses.draft > 0) return 'A reply draft is already saved.'
      return null
    }
  }
}

/** Which ticked rows the action would change, and why it leaves the others (in the order they were ticked). */
export function bulkReach(action: BulkAction, value: string | null, rows: readonly BulkRow[], now: Date = new Date()): BulkReach {
  const apply: string[] = []
  const skipped: { id: string; reason: string }[] = []
  for (const row of rows) {
    const reason = skipReason(action, value, row, now)
    if (reason) skipped.push({ id: row.id, reason })
    else apply.push(row.id)
  }
  return { apply, skipped }
}

export interface BulkContext {
  canManage: boolean
  rows: readonly BulkRow[]
  now?: Date
}

/** Why an action's button in the bar is held before a value is picked, or null. First that applies wins. */
export function bulkActionHeld(action: BulkAction, { canManage, rows, now = new Date() }: BulkContext): string | null {
  if (!canManage) return manageHeld(action)
  if (rows.length === 0) return 'Tick at least one review.'
  if (rows.length > BULK_MAX) return `Pick at most ${BULK_MAX} reviews at once. Untick ${count(rows.length - BULK_MAX)}.`
  if (action === 'draft') {
    if (rows.length > BULK_DRAFT_MAX) return `Draft with AI takes at most ${BULK_DRAFT_MAX} reviews at once. Untick ${count(rows.length - BULK_DRAFT_MAX)}.`
    const reach = bulkReach('draft', null, rows, now)
    if (reach.apply.length === 0) return `None of the ticked reviews can get a draft: ${reach.skipped[0]?.reason ?? 'each already has a reply.'}`
  }
  return null
}

/** Why the window's Apply button is held once a value is picked, or null. */
export function bulkApplyHeld(action: BulkAction, value: string | null, ctx: BulkContext): string | null {
  const held = bulkActionHeld(action, ctx)
  if (held) return held
  const text = (value ?? '').trim()
  if (action === 'tag') {
    if (!text) return 'Type a tag first.'
    if (text.length > TAG_MAX) return `A tag is at most ${TAG_MAX} characters.`
  }
  if (action === 'status' && !(SETTABLE_STATUSES as readonly string[]).includes(text)) return 'Pick a status first.'
  const reach = bulkReach(action, action === 'tag' || action === 'status' ? text : text || null, ctx.rows, ctx.now ?? new Date())
  if (reach.apply.length === 0) return `Nothing to change: ${reach.skipped[0]?.reason ?? 'every ticked review is like this already.'}`
  return null
}

/** The window's Apply button: it says how many reviews it changes. */
export function bulkApplyLabel(action: BulkAction, value: string | null, changes: number): string {
  const n = plural(changes, 'review', 'reviews')
  switch (action) {
    case 'assign': return value ? `Assign ${n} to ${value}` : `Unassign ${n}`
    case 'tag': return `Tag ${n}`
    case 'status': return `Set ${n} to ${STATUS_WORD[value ?? ''] ?? 'this status'}`
    case 'draft': return `Draft ${changes === 1 ? 'a reply' : `${count(changes)} replies`} with AI`
  }
}

/** The skipped rows in one line, grouped by reason: "3 stay as they are: 2 already Resolved · 1 already assigned to …". */
export function bulkSkipWords(skipped: readonly { reason: string }[]): string | null {
  if (skipped.length === 0) return null
  const groups = new Map<string, number>()
  for (const s of skipped) groups.set(s.reason, (groups.get(s.reason) ?? 0) + 1)
  const parts = [...groups.entries()].map(([reason, n]) => `${count(n)} × ${reason.replace(/\.$/, '')}`)
  return `${plural(skipped.length, 'ticked review stays', 'ticked reviews stay')} as ${skipped.length === 1 ? 'it is' : 'they are'}: ${parts.join(' · ')}.`
}

/** The toast after the call, with the server's own counts. */
export function bulkResultWords(action: BulkAction, value: string | null, result: { changed: number; skipped: readonly { reason: string }[] }): string {
  const n = plural(result.changed, 'review', 'reviews')
  let done: string
  if (result.changed === 0) done = 'Nothing changed.'
  else if (action === 'assign') done = value ? `Assigned ${n} to ${value}.` : `${n.charAt(0).toUpperCase()}${n.slice(1)} now have no owner.`
  else if (action === 'tag') done = `Tagged ${n} “${value ?? ''}”.`
  else if (action === 'status') done = `Set ${n} to ${STATUS_WORD[value ?? ''] ?? value}.`
  else done = `Drafted ${result.changed === 1 ? 'a reply' : `${count(result.changed)} replies`} with AI. Nothing was sent: each draft waits for a person.`
  const skipped = bulkSkipWords(result.skipped)
  return skipped ? `${done} ${skipped}` : done
}

/** The request body. */
export function bulkBody(ids: readonly string[], action: BulkAction, value: string | null): { ids: string[]; action: BulkAction; value: string | null } {
  const text = (value ?? '').trim()
  return { ids: [...new Set(ids)], action, value: action === 'draft' ? null : text || null }
}

/** The Assign window's people: nobody, the signed-in person, everyone who owns a review now. */
export function ownerChoices(owners: readonly string[], me: string | null): { value: string; label: string }[] {
  const names = [...new Set([...(me ? [me] : []), ...owners].map((o) => o.trim()).filter(Boolean))]
  return [{ value: '', label: 'Nobody' }, ...names.map((name) => ({ value: name, label: name === me ? `${name} (you)` : name }))]
}
