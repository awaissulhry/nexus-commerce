import type { ChatRead } from './api'

/**
 * owb-po5.4 (plan § 5d: "a Chat button in the top bar, with the number of new messages; a panel beside the page: a list of chats →
 * one chat → the back arrow → the list; with the panel open, each order page shows that order's chat") — the panel without a screen.
 */

/** A conversation the panel opens: its record (type and id) and its name in words. */
export interface ChatRecord {
  readonly type: string
  readonly id: string
  readonly label: string | null
}

export interface ChatRow {
  readonly key: string
  readonly record: ChatRecord
  /** Its name: their reference, else ours, else its kind in words. */
  readonly title: string
  readonly subtitle: string | null
  readonly excerpt: string | null
  readonly at: string | null
  readonly newCount: number
}

/** The panel's state: closed, the list, or one chat. */
export type ChatPanelState = { readonly open: false } | { readonly open: true; readonly record: ChatRecord | null }

/** The top bar's count: the new messages of every conversation (null: not read — no number, never a made-up 0). */
export function chatCountOf(list: readonly Pick<ChatRead, 'newCount'>[] | null): number | null {
  if (!list) return null
  return list.reduce((sum, chat) => sum + Math.max(0, chat.newCount), 0)
}

/** The list's rows in the person's words (`kind` names a record type: "Order", "Return"). */
export function chatRowsOf(list: readonly ChatRead[], kind: (type: string) => string): ChatRow[] {
  return list.map((chat) => {
    const title = chat.record.theirRef ?? chat.record.ourRef ?? kind(chat.record.type)
    return {
      key: `${chat.record.type}:${chat.record.id}`,
      record: { type: chat.record.type, id: chat.record.id, label: title },
      title,
      subtitle: chat.record.subtitle,
      excerpt: chat.last?.excerpt ?? null,
      at: chat.last?.at ?? null,
      newCount: Math.max(0, chat.newCount),
    }
  })
}

/**
 * Where the panel opens: on a page about one record (the band's "Ask a question" record: an order, a request, a return), that record's
 * chat; anywhere else the list. The account's own conversation (`Party`) is in the list, not opened by itself.
 */
export function chatOpensAt(pageRecord: ChatRecord | null | undefined): ChatPanelState {
  return { open: true, record: pageRecord && pageRecord.type !== 'Party' ? pageRecord : null }
}
