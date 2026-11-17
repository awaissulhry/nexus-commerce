import type { CardMessage } from '../card/model'
import { dayOf, THREAD_TIME_ZONE } from '../parts/time'

/**
 * B-TH-204 — the record thread's feed (threads plan T4; picture 1, approved 2026-11-17): the order and rhythm of a record's
 * messages in the office. It reads like e-mail: oldest at the top, newest at the bottom, the box under it, and opens at the
 * newest message (or the one a link names). Day lines in the company's time zone. Older messages fold BY AGE (PR-08: all but
 * the last 3) until per-person reads arrive; B-TH-229 (the person's own read mark, B-TH-027) then folds READ messages: what is new
 * to the reader stays open with the one read message just before it (what the new ones answer), and the line "New since your last
 * visit" sits above the first new message; with nothing new it folds by age as before. The oldest run is one line "12 earlier
 * messages", the two just before the open ones are one line each. Record steps are one thin line; field changes group by person
 * and hour ("5 changes by Bea Esempio · Show"). Pure: the view draws these rows.
 *
 * Not drawn until the back end has it (design kit §5): the held-mail line (thread-G06, B-TH-079), the erased card (thread-G09).
 */

/** The last messages that stay open (PR-08). */
export const OPEN_LAST = 3
/** Folded messages shown one line each just before the open ones; older ones fold into one line. */
export const FOLDED_ROWS = 2
/** A page of messages ("Show 50 earlier"; the API allows up to 200). */
export const PAGE_SIZE = 50

export type ActorAudience = 'OFFICE' | 'FLOOR' | 'PARTNER' | 'LINK' | 'SYSTEM'

/** One step or change of the record, from its history (the API's timeline `change` entries). */
export interface FeedEvent {
  id: string
  /** ISO instant (UTC). */
  at: string
  /** Who did it, when the reader knows the person; null: said by the audience. */
  who: string | null
  /** A floor worker did it and the site's legal gate keeps back who. */
  whoHidden?: boolean
  actorAudience: ActorAudience
  /** The command's verb (the last part of `sales.orders.setStatus`). */
  verb: string
  status: { from: string | null; to: string | null } | null
  /** The values, only when the API gave them (audit.read; money only with its grain). */
  values: ReadonlyArray<{ field: string; before: string; after: string }>
  fields: readonly string[]
}

/** A plain field change (no status move, an update) groups with its neighbours; anything else is a record step. */
export const isFieldChange = (event: Pick<FeedEvent, 'verb' | 'status'>): boolean => event.status === null && (event.verb === 'update' || event.verb === 'changed')

const VERBS: Readonly<Record<string, string>> = {
  create: 'created',
  update: 'updated',
  delete: 'deleted',
  issue: 'issued',
  suspend: 'suspended',
  reinstate: 'reinstated',
  withdraw: 'withdrawn',
  archive: 'archived',
  setStatus: 'statusChanged',
  send: 'sent',
  completeUpload: 'uploaded',
  setVisibility: 'shared',
  setRetention: 'retentionChanged',
  assign: 'assigned',
  release: 'released',
  reject: 'rejected',
  approve: 'approved',
  confirm: 'confirmed',
  cancel: 'cancelled',
}

/** A step's verb in words: a key of record-thread-feed (`verb.issued`), `verb.changed` otherwise. */
export const verbKey = (verb: string): string => `verb.${VERBS[verb] ?? 'changed'}`

/** Who did a step, in words: the name; "A person on the floor" behind the gate; else by audience. */
export function whoWords(event: Pick<FeedEvent, 'who' | 'whoHidden' | 'actorAudience'>): { text: string } | { key: string } {
  if (event.whoHidden) return { key: 'who.floorPerson' }
  if (event.who) return { text: event.who }
  return { key: `who.${event.actorAudience}` }
}

export type FeedRow =
  | { kind: 'day'; key: string; day: string }
  // B-TH-229: "New since your last visit" above the first message new to the reader (T4-F04); `count` the reader's new messages.
  | { kind: 'new'; key: string; count: number }
  | { kind: 'fold'; key: string; count: number; from: string; to: string }
  | { kind: 'folded'; key: string; message: CardMessage }
  | { kind: 'message'; key: string; message: CardMessage }
  | { kind: 'step'; key: string; event: FeedEvent }
  | { kind: 'changes'; key: string; events: readonly FeedEvent[] }

export interface FeedRowsInput {
  messages: readonly CardMessage[]
  events: readonly FeedEvent[]
  /** Messages the reader opened in place. */
  openIds?: readonly string[]
  /** The message a link names (`?message=`): open. */
  anchorId?: string | null
  /** "12 earlier messages" was opened: its messages show one line each. */
  runOpen?: boolean
  timeZone?: string
  // ---- B-TH-229: the reader's own reading as it was on arrival (the thread's `reading`, B-TH-027)
  /** The first message new to the reader: the line sits above it and the read ones before it fold; null / absent: nothing new. */
  firstNewId?: string | null
  /** How many are new to the reader (the line's and the Head's number); 0 / absent: nothing new. */
  newCount?: number
  // ---- end B-TH-229
}

const byTime = <T extends { at: string; id: string }>(a: T, b: T) => (a.at === b.at ? a.id.localeCompare(b.id) : a.at < b.at ? -1 : 1)

/**
 * The messages that fold, oldest first: all but the last 3 (by age) — or, B-TH-229, when something is new to the reader, the READ
 * ones before the first new message except the one just before it (what the new ones answer). Never the opened ones, the anchor or
 * a message on its way. A first new message older than the page read: every message of the page is new, none folds.
 */
export function foldedIds(messages: readonly CardMessage[], openIds: readonly string[] = [], anchorId: string | null = null, firstNewId: string | null = null, newCount = 0): string[] {
  const sorted = [...messages].sort(byTime)
  const newAt = firstNewId ? sorted.findIndex((message) => message.id === firstNewId) : -1
  const unreadOutside = firstNewId !== null && newAt === -1 && newCount > 0
  const openFrom = unreadOutside ? 0 : newAt !== -1 ? Math.max(0, newAt - 1) : Math.max(0, sorted.length - OPEN_LAST)
  const open = new Set([...sorted.slice(openFrom).map((message) => message.id), ...openIds, ...(anchorId ? [anchorId] : [])])
  // A message on its way or not sent never folds: its writer is looking at it.
  return sorted.filter((message) => !open.has(message.id) && !message.outbox).map((message) => message.id)
}

/** The rows of the feed, oldest first. */
export function feedRows(input: FeedRowsInput): FeedRow[] {
  const timeZone = input.timeZone ?? THREAD_TIME_ZONE
  const firstNewId = input.firstNewId ?? null
  const newCount = input.newCount ?? 0
  const folded = foldedIds(input.messages, input.openIds, input.anchorId ?? null, firstNewId, newCount)
  const foldedSet = new Set(folded)
  const sorted = [...input.messages].sort(byTime)
  let run = !input.runOpen && folded.length - FOLDED_ROWS >= 2 ? folded.slice(0, folded.length - FOLDED_ROWS) : []
  // A link to a message inside the old run opens the run: the message is read among its neighbours, one line each.
  const anchorAt = input.anchorId ? sorted.findIndex((message) => message.id === input.anchorId) : -1
  if (anchorAt !== -1 && run.length > 0 && anchorAt < sorted.findIndex((message) => message.id === run[run.length - 1])) run = []
  const runSet = new Set(run)
  const runMessages = sorted.filter((message) => runSet.has(message.id))
  const runEnd = runMessages.length > 0 ? runMessages[runMessages.length - 1].at : null

  type Item = { at: string; id: string; message?: CardMessage; event?: FeedEvent }
  const items: Item[] = [
    ...sorted.map((message) => ({ at: message.at, id: message.id, message })),
    // Steps inside the folded run fold with it.
    ...input.events.filter((event) => runEnd === null || event.at > runEnd).map((event) => ({ at: event.at, id: event.id, event })),
  ].sort(byTime)

  const rows: FeedRow[] = []
  let lastDay: string | null = null
  const dayLine = (at: string) => {
    const day = dayOf(at, timeZone)
    if (day !== lastDay) rows.push({ kind: 'day', key: `day:${day}`, day })
    lastDay = day
  }
  let foldShown = false
  let newShown = false
  for (const item of items) {
    if (item.message) {
      const message = item.message
      if (runSet.has(message.id)) {
        if (!foldShown) {
          rows.push({ kind: 'fold', key: 'fold', count: runMessages.length, from: runMessages[0].at, to: runMessages[runMessages.length - 1].at })
          foldShown = true
        }
        lastDay = dayOf(message.at, timeZone)
        continue
      }
      dayLine(message.at)
      // B-TH-229: the line above the first new message (or above the page's first message when the first new one is older).
      if (newCount > 0 && !newShown && (message.id === firstNewId || (firstNewId !== null && !sorted.some((one) => one.id === firstNewId)))) {
        rows.push({ kind: 'new', key: 'new', count: newCount })
        newShown = true
      }
      rows.push(foldedSet.has(message.id) ? { kind: 'folded', key: `folded:${message.id}`, message } : { kind: 'message', key: `message:${message.id}`, message })
      continue
    }
    const event = item.event as FeedEvent
    dayLine(event.at)
    const previous = rows[rows.length - 1]
    if (isFieldChange(event) && previous?.kind === 'changes' && sameGroup(previous.events[0], event, timeZone)) {
      rows[rows.length - 1] = { ...previous, events: [...previous.events, event] }
    } else if (isFieldChange(event)) {
      rows.push({ kind: 'changes', key: `changes:${event.id}`, events: [event] })
    } else {
      rows.push({ kind: 'step', key: `step:${event.id}`, event })
    }
  }
  return rows
}

/** Two changes group when the same person (or audience) made them in the same hour of the same day. */
function sameGroup(first: FeedEvent, next: FeedEvent, timeZone: string): boolean {
  const sameWho = first.whoHidden === next.whoHidden && first.who === next.who && first.actorAudience === next.actorAudience
  return sameWho && dayOf(first.at, timeZone) === dayOf(next.at, timeZone) && Math.abs(Date.parse(next.at) - Date.parse(first.at)) < 3_600_000
}

/** A folded message's one line: its first words. */
export function gistOf(body: string): string {
  const line = body.split(/\r?\n/).find((part) => part.trim() !== '') ?? ''
  return line.length > 140 ? `${line.slice(0, 139)}…` : line
}

/**
 * J / K walk the messages when the feed has the focus (T4-F09): the next or previous message row from the focused one (from
 * outside a row: the last for K, the first for J). Inside the box the keys type text; the page band's J / K walk records.
 */
export function walkTarget(ids: readonly string[], current: string | null, key: 'j' | 'k'): string | null {
  if (ids.length === 0) return null
  const index = current === null ? -1 : ids.indexOf(current)
  if (index === -1) return key === 'j' ? ids[0] : ids[ids.length - 1]
  return ids[Math.min(ids.length - 1, Math.max(0, index + (key === 'j' ? 1 : -1)))]
}

/** How many messages arrived at the end since the last read (the "2 new messages" bar); an older page is not new. */
export function arrivedAtEnd(before: readonly string[], after: readonly string[]): number {
  if (before.length === 0) return 0
  const last = before[before.length - 1]
  const index = after.indexOf(last)
  return index === -1 ? 0 : after.length - 1 - index
}
