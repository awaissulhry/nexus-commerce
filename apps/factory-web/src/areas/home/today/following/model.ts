import { z } from 'zod'
import { recordAddress } from '../../../../lib/records/record-links'
import { pageOfList } from '../my-views/model'
import type { Loaded } from '../model'
// B-TH-239: the reader's own new messages per followed record (B-TH-027's one read).
import type { UnreadMap } from '../../../../lib/last-message-cell/model'

/**
 * Today › Changed since you looked (B-W2b-388; COL-035; design home.today `following` "Records I follow that changed, in one line
 * each": "'ORD-2026-0042 promise date 12 Nov → 19 Nov by Marco · 09:12' · 'LOT-0088 released by Lucia'", verbs "Mark seen (E) ·
 * Open · Unfollow", "Changed values only with their grain"). GET /home/following: my FOLLOWING news not marked seen, one line per
 * record or saved view, its words the notification's own (cut to my grains now, PLT-152; said with `home-notifications` w.*).
 */

export const followingSchema = z.object({
  asOf: z.string(),
  items: z.array(
    z.object({
      key: z.string(),
      record: z.object({ type: z.string(), id: z.string(), label: z.string() }),
      companyId: z.string().nullable(),
      anchor: z.string().nullable(),
      view: z.boolean(),
      listKey: z.string().nullable(),
      messageKey: z.string(),
      params: z.unknown(),
      sentence: z.string(),
      actor: z.object({ id: z.string(), name: z.string() }).nullable(),
      people: z.record(z.string(), z.string()),
      at: z.string(),
      count: z.number().int(),
      ids: z.array(z.string()),
    }),
  ),
  complete: z.boolean(),
  live: z.object({ events: z.array(z.string()) }),
})
export type FollowingAnswer = z.infer<typeof followingSchema>
export type FollowingItem = FollowingAnswer['items'][number]

/** A line as the section draws it: the news and where it opens (a record's page or panels; a view's list with the view). */
export interface FollowingRow extends FollowingItem {
  readonly href: string | null
  /** B-TH-239: the reader's own new messages on the record (absent or 0: none, or not counted); the line then opens the first one. */
  readonly newMessages?: number
}

export interface FollowingModel {
  readonly rows: Loaded<{ readonly items: readonly FollowingRow[]; readonly complete: boolean; readonly asOf: string }>
  readonly now: number
  /** Why changing is held (offline, a change in flight): a message key of `home-mywork`, or null. */
  readonly held: string | null
  readonly notice: { readonly key: string; readonly tone: 'success' | 'warning' | 'danger'; readonly params?: Readonly<Record<string, string>> } | null
}

/** Where a line opens: a followed view's list with the view (null while its page is not built), else the record. */
export function rowOf(item: FollowingItem, prefix: string, built: ReadonlySet<string>): FollowingRow {
  if (item.view) {
    const page = item.listKey ? pageOfList(item.listKey) : null
    return { ...item, href: page && built.has(page) ? `${prefix}${page}?savedView=${encodeURIComponent(item.record.id)}` : null }
  }
  return { ...item, href: `${prefix}${recordAddress({ type: item.record.type, id: item.record.id, label: item.record.label, companyId: item.companyId }, built)}` }
}

/** The section's keys: e marks the focused line seen (never in a text field, a menu or a dialog). */
export function followingKey(key: string, modifiers: { readonly alt: boolean; readonly ctrl: boolean; readonly meta: boolean }): 'seen' | null {
  if (modifiers.alt || modifiers.ctrl || modifiers.meta) return null
  return key === 'e' ? 'seen' : null
}

// ---- B-TH-239 (threads plan TH-3; O-HOME-TODAY.changed-F01, picture 17): "3 new messages", opening the first unread one -------------

/**
 * Where a line with new messages opens: the record with its thread at "New since your last visit" (B-TH-229: the feed opens at the
 * reader's first unread message) — a request beside Sales › Incoming's list (its pane's thread), any other record through the record
 * frame's `?thread=new` (B-TH-230, R-8). Company-prefixed.
 */
export function firstUnreadHref(item: Pick<FollowingItem, 'record' | 'companyId'>, prefix: string, built: ReadonlySet<string>): string {
  if (item.record.type === 'Inquiry' && built.has('/sales/incoming')) return `${prefix}/sales/incoming?open=${encodeURIComponent(item.record.id)}`
  const address = recordAddress({ type: item.record.type, id: item.record.id, label: item.record.label, companyId: item.companyId }, built)
  return `${prefix}${address}${address.includes('?') ? '&' : '?'}thread=new`
}

/** The records whose new messages one read counts (POST /threads/unread): the record lines, never a saved view. */
export const unreadRowsOf = (rows: readonly FollowingRow[]): Array<{ readonly recordType: string; readonly id: string }> => rows.filter((row) => !row.view).map((row) => ({ recordType: row.record.type, id: row.record.id }))

/**
 * The lines with the reader's own new messages (the API counts only what the reader may open: a record they may not read counts 0,
 * like one without a thread). A line with new messages says "3 new messages" and opens the first unread one; a line without (or a
 * failed count: the map is empty) keeps its news and its link — never a made-up count.
 */
export function withUnread(rows: readonly FollowingRow[], unread: UnreadMap, prefix: string, built: ReadonlySet<string>): FollowingRow[] {
  return rows.map((row) => {
    if (row.view) return row
    const count = unread[row.record.id]?.newCount ?? 0
    return count > 0 ? { ...row, newMessages: count, href: firstUnreadHref(row, prefix, built) } : row
  })
}
// ---- end B-TH-239
