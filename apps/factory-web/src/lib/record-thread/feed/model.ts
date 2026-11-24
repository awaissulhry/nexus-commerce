import type { CardMessage } from '../card/model'
import { dayOf, THREAD_TIME_ZONE } from '../parts/time'
import { runPlace, type RunPlace } from './runs'

/**
 * B-TH-204 — the record thread's feed (threads plan T4; picture 1, approved 2026-11-17): the order and rhythm of a record's
 * messages in the office. Oldest at the top, newest at the bottom, the box under it; it opens at the newest message (or the one a
 * link names, or the unread band). Days in the company's time zone. Record steps and grouped field changes ("5 changes by Bea
 * Esempio · Show"). Pure: the view draws these rows.
 *
 * tw- W1.1 / W1.3 (THE THREAD REBUILD; 10-design §3, §6, §7; D10): no fold any more — older messages load as the person scrolls up
 * (the top sentinel, `shouldLoadOlder`); each message row carries its place in a run (`runs.ts`: side, first, last, name); every row
 * that is not a message is a centred pill (the day, a step, a run of steps, changes, "Alex Demo pinned a message" — office only); the
 * band "3 unread messages" sits above the first message new to the reader (B-TH-229's reading) and the thread opens there; ONE order
 * for messages and rows: time, then id (B15). A jump lights the whole row for FLASH_MS.
 *
 * B-TH-255 (TH-6, on B-TH-079): two quiet pills at the end of the feed — the messages new to the reader that the View hides
 * ("1 new message hidden by this view · Show all": a view left on never hides news, T1-F05) and the mail that waits for a person
 * ("1 email waits in Mail to sort · Review" for a reader with email.triage; "A reply waits for a colleague to check it" for everyone
 * else, never the sender or why: T4-F10, W07 / W08 / W22).
 */

/** tw- W1.3 (Z5, Z22 P2): how long a row lights up after a jump — ONE named constant (no DS motion token runs past 180 ms). */
export const FLASH_MS = 1500

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
  /** F-OP-214: the whole action (`tasks.create`): a step of another module reads in its own words; absent: the verb alone. */
  action?: string
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

// ---- F-OP-214 (order page plan N4; 11-dock §6.1, D1): a step of another module on the record (a task added to it, a file) reads in its own
// words; "created the record" only for the record's own module. The issues engine audits each task it adds on its record
// (`tasks.create`, the actor SYSTEM: "Nexus Factory"), so an order showed "Nexus Factory created the record" five times.
export const FOREIGN_ACTIONS: Readonly<Record<string, string>> = Object.freeze({
  'tasks.create': 'addedTask',
  'tasks.complete': 'completedTask',
  'tasks.reopen': 'reopenedTask',
  'tasks.assign': 'assignedTask',
  'files.completeUpload': 'uploaded',
  // ── F-MS-107 (set the stage by hand; R6, R20): the order's own audit rows of the act (the API's B-MS-005 set / change and clear,
  // B-MS-004 the keeper's end), office only. Never a `status` key in them, so never a status step; the actor is the office person or
  // Nexus Factory (whoWords keeps a floor worker behind the site's gate); the values (from → to, the note) only with audit.read.
  'production.setBrandStage': 'setStageByHand',
  'production.clearBrandStage': 'clearedStageByHand',
  'production.brandKeeper.handCleared': 'stageByHandEnded',
  // ── end F-MS-107
})
/** The other modules' verbs that have plural words ("added 5 tasks"). */
const FOREIGN_VERBS: readonly string[] = Object.values(FOREIGN_ACTIONS)
/** The modules whose steps land on another module's record (never "created the record" there). */
const FOREIGN_MODULES: readonly string[] = ['tasks', 'files']

/** A step's words: another module's own (`verb.addedTask`), its generic change (never "created the record"), else the verb's. */
export function stepVerbKey(event: Pick<FeedEvent, 'verb' | 'action'>): string {
  const own = event.action ? FOREIGN_ACTIONS[event.action] : undefined
  if (own) return `verb.${own}`
  const dot = event.action ? event.action.indexOf('.') : -1
  const module = event.action && dot > 0 ? event.action.slice(0, dot) : ''
  if (FOREIGN_MODULES.includes(module) && event.verb === 'create') return 'verb.changed'
  return verbKey(event.verb)
}

/** A status step: it never folds and it ends a run of steps (a status move is always read on its own). */
export const isStatusStep = (event: Pick<FeedEvent, 'status'>): boolean => event.status !== null && (event.status.from !== null || event.status.to !== null)

/**
 * The words of a run of folded steps: "Nexus Factory added 5 tasks" when every step is the same action of another module (its own
 * plural words), else "5 steps by Nexus Factory".
 */
export function stepsWordsOf(events: readonly Pick<FeedEvent, 'verb' | 'action'>[]): { readonly key: string; readonly count: number } {
  const first = events[0] ? stepVerbKey(events[0]) : null
  const same = first !== null && events.every((event) => stepVerbKey(event) === first) && first.startsWith('verb.') && FOREIGN_VERBS.includes(first.slice(5))
  return { key: same ? `steps.many.${first!.slice(5)}` : 'steps.text', count: events.length }
}
// ---- end F-OP-214

/** Who did a step, in words: the name; "A person on the floor" behind the gate; else by audience. */
export function whoWords(event: Pick<FeedEvent, 'who' | 'whoHidden' | 'actorAudience'>): { text: string } | { key: string } {
  if (event.whoHidden) return { key: 'who.floorPerson' }
  if (event.who) return { text: event.who }
  return { key: `who.${event.actorAudience}` }
}

export type FeedRow =
  | { kind: 'day'; key: string; day: string }
  // B-TH-229 / tw- W1.3: "3 unread messages" above the first message new to the reader (T4-F04); `count` the reader's new messages.
  | { kind: 'new'; key: string; count: number }
  // tw- W1.1: a message and its place in a run (runs.ts).
  | { kind: 'message'; key: string; message: CardMessage; run: RunPlace }
  | { kind: 'step'; key: string; event: FeedEvent }
  // F-OP-214: 2+ consecutive record steps of the same actor within an hour, one pill ("5 steps by Nexus Factory · Show").
  | { kind: 'steps'; key: string; events: readonly FeedEvent[] }
  | { kind: 'changes'; key: string; events: readonly FeedEvent[] }
  // tw- W1.3 (10-design §7): "Alex Demo pinned a message" — office only (the container hands pins with who pinned them).
  | { kind: 'pin'; key: string; pin: FeedPin }

/** tw- W1.3: a pin as the feed's pill says it — who pinned which message, when (office only; never the portal). */
export interface FeedPin {
  readonly messageId: string
  /** ISO instant (UTC) of the pin. */
  readonly at: string
  /** Who pinned it, by name. */
  readonly by: string
}

export interface FeedRowsInput {
  messages: readonly CardMessage[]
  events: readonly FeedEvent[]
  timeZone?: string
  // ---- B-TH-229: the reader's own reading as it was on arrival (the thread's `reading`, B-TH-027)
  /** The first message new to the reader: the band sits above it; null / absent: nothing new. */
  firstNewId?: string | null
  /** How many are new to the reader (the band's number); 0 / absent: nothing new. */
  newCount?: number
  // ---- end B-TH-229
  /** tw- W1.3: the pins with who pinned them (office): their pills. */
  pins?: readonly FeedPin[]
  /** tw- W1.4 (R18): paper — every message alone, on the left, with its name. */
  paper?: boolean
}

/** tw- W1.1 (B15): ONE order for the feed's messages and rows — time, then id — the view's J / K and "seen" use it too. */
export const byTime = <T extends { at: string; id: string }>(a: T, b: T): number => (a.at === b.at ? a.id.localeCompare(b.id) : a.at < b.at ? -1 : 1)

/** The rows of the feed, oldest first. */
export function feedRows(input: FeedRowsInput): FeedRow[] {
  const timeZone = input.timeZone ?? THREAD_TIME_ZONE
  const firstNewId = input.firstNewId ?? null
  const newCount = input.newCount ?? 0
  const sorted = [...input.messages].sort(byTime)

  type Item = { at: string; id: string; message?: CardMessage; event?: FeedEvent; pin?: FeedPin }
  const items: Item[] = [
    ...sorted.map((message) => ({ at: message.at, id: message.id, message })),
    ...input.events.map((event) => ({ at: event.at, id: event.id, event })),
    ...(input.pins ?? []).map((pin) => ({ at: pin.at, id: `pin:${pin.messageId}`, pin })),
  ].sort(byTime)

  const rows: FeedRow[] = []
  let lastDay: string | null = null
  const dayLine = (at: string) => {
    const day = dayOf(at, timeZone)
    if (day !== lastDay) rows.push({ kind: 'day', key: `day:${day}`, day })
    lastDay = day
  }
  let newShown = false
  const placeholder: RunPlace = { side: 'others', first: true, last: true, showName: true }
  for (const item of items) {
    if (item.message) {
      const message = item.message
      dayLine(message.at)
      // B-TH-229: the band above the first new message (or above the page's first message when the first new one is older).
      if (newCount > 0 && !newShown && (message.id === firstNewId || (firstNewId !== null && !sorted.some((one) => one.id === firstNewId)))) {
        rows.push({ kind: 'new', key: 'new', count: newCount })
        newShown = true
      }
      rows.push({ kind: 'message', key: `message:${message.id}`, message, run: placeholder })
      continue
    }
    if (item.pin) {
      dayLine(item.pin.at)
      rows.push({ kind: 'pin', key: `pin:${item.pin.messageId}:${item.pin.at}`, pin: item.pin })
      continue
    }
    const event = item.event as FeedEvent
    dayLine(event.at)
    const previous = rows[rows.length - 1]
    if (isFieldChange(event) && previous?.kind === 'changes' && sameGroup(previous.events[0], event, timeZone)) {
      rows[rows.length - 1] = { ...previous, events: [...previous.events, event] }
    } else if (isFieldChange(event)) {
      rows.push({ kind: 'changes', key: `changes:${event.id}`, events: [event] })
    } else if (!isStatusStep(event) && previous?.kind === 'steps' && sameGroup(previous.events[0], event, timeZone)) {
      // F-OP-214: the run goes on (the same actor, within an hour of its first step, nothing between).
      rows[rows.length - 1] = { ...previous, events: [...previous.events, event] }
    } else if (!isStatusStep(event) && previous?.kind === 'step' && !isStatusStep(previous.event) && sameGroup(previous.event, event, timeZone)) {
      // F-OP-214: a second step of the same actor folds the two into one run; a status step never folds and ends the run.
      rows[rows.length - 1] = { kind: 'steps', key: `steps:${previous.event.id}`, events: [previous.event, event] }
    } else {
      rows.push({ kind: 'step', key: `step:${event.id}`, event })
    }
  }
  // tw- W1.1: each message's place in its run — its neighbours are the rows right beside it (any other row between ends the run).
  return rows.map((row, index) => {
    if (row.kind !== 'message') return row
    const before = rows[index - 1]
    const after = rows[index + 1]
    const previous = before?.kind === 'message' ? before.message : null
    const next = after?.kind === 'message' ? after.message : null
    return { ...row, run: runPlace(previous, row.message, next, { timeZone, paper: input.paper === true }) }
  })
}

/**
 * tw- W1.3 (D10, W-153): the top sentinel asks for the next older page ONCE per page — while older messages exist, no page is being
 * read and none failed (Retry then), and the page now shown (its message count) was not asked for already.
 */
export function shouldLoadOlder(state: { readonly more: boolean; readonly older?: 'idle' | 'loading' | 'failed' | undefined; readonly count: number; readonly askedAt: number | null }): boolean {
  return state.more && (state.older ?? 'idle') === 'idle' && state.askedAt !== state.count
}

/** Two changes group when the same person (or audience) made them in the same hour of the same day. */
function sameGroup(first: FeedEvent, next: FeedEvent, timeZone: string): boolean {
  const sameWho = first.whoHidden === next.whoHidden && first.who === next.who && first.actorAudience === next.actorAudience
  return sameWho && dayOf(first.at, timeZone) === dayOf(next.at, timeZone) && Math.abs(Date.parse(next.at) - Date.parse(first.at)) < 3_600_000
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

/** How many messages arrived at the end since the last read (the down button's count); an older page is not new. */
export function arrivedAtEnd(before: readonly string[], after: readonly string[]): number {
  if (before.length === 0) return 0
  const last = before[before.length - 1]
  const index = after.indexOf(last)
  return index === -1 ? 0 : after.length - 1 - index
}

// ── B-TH-255 (B-TH-079; T1-F05, T4-F10) ─────────────────────────────────────────────────────────────────────────────

/**
 * Why a mail for this conversation waits for a person: HELD's reason (factory-domain email-in/rules HELD_REASONS) or TRIAGE (Mail to
 * sort). Held together by the test (the domain's rules reach node:crypto: a browser module never imports them).
 */
export const HELD_REASON_CODES = ['DMARC_FAIL', 'SPAM', 'UNKNOWN_SENDER', 'THREAD_CLOSED', 'TRIAGE'] as const

/** The office read's `waitingMail` (platform/threads contract), plus where Review opens (Home › Mail to sort) for this company. */
export interface FeedWaitingMail {
  readonly count: number
  readonly reasons: readonly string[]
  /** email.triage over the mail's company: "Review"; else "A reply waits for a colleague to check it". */
  readonly mayReview: boolean
  /** Home › Mail to sort of this company; null: no link (a design case, a host without the address). */
  readonly reviewHref: string | null
}

/** The API counts at most this many waiting mails (WAITING_MAIL_MAX): the line says "50 or more" then. */
export const WAITING_MAIL_MAX = 50

/** A held reason's words: a key of record-thread-feed (`waiting.reason.UNKNOWN_SENDER`); an unknown code says "to be checked". */
export const heldReasonKey = (reason: string): string => ((HELD_REASON_CODES as readonly string[]).includes(reason) ? `waiting.reason.${reason}` : 'waiting.reason.other')

/**
 * The held-mail line at the end of the feed (T4-F10), or null when nothing waits. A reader who may review it (email.triage) reads how
 * many, why (each reason once, in words) and Review (Home › Mail to sort); anyone else reads only that a reply waits for a colleague —
 * never the sender (the API never sends it) and never why (W07, W08, W22, W34).
 */
export function waitingMailLine(waiting: FeedWaitingMail | null | undefined): { readonly key: 'waiting.review' | 'waiting.reviewMany' | 'waiting.colleague' | 'waiting.colleagueMany'; readonly count: number; readonly reasons: readonly string[]; readonly href: string | null } | null {
  if (!waiting || waiting.count <= 0) return null
  const many = waiting.count >= WAITING_MAIL_MAX
  if (!waiting.mayReview) return { key: many ? 'waiting.colleagueMany' : 'waiting.colleague', count: waiting.count, reasons: [], href: null }
  const reasons = [...new Set(waiting.reasons.map(heldReasonKey))]
  return { key: many ? 'waiting.reviewMany' : 'waiting.review', count: waiting.count, reasons, href: waiting.reviewHref }
}

/** "1 new message hidden by this view · Show all": the line's count, or null (All, or nothing new hidden). */
export const hiddenNewLine = (hiddenNew: number | undefined): { readonly count: number } | null => (hiddenNew && hiddenNew > 0 ? { count: hiddenNew } : null)
