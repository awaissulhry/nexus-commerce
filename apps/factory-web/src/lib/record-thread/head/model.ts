import type { CountKind, CountPopoverModel } from '../popups/model'

/**
 * B-TH-209 — the thread's Head (threads plan T1; features T1-F01…F14, rule R-ACT): ONE row that fits the narrowest dock
 * (~438 px) and the wide one (~718 px). The pure part: who must answer next and for how long (from what the back end has
 * today: the last message shared with the record's party), the View choice, the dock width (remembered on this device per
 * person and record type), and the "⋯" with Activity's doors — Add task · Ask a partner to approve · Share with a partner ·
 * Followers / Follow / Mute · Remind me — always there, held with the reason when the person cannot use one, also at
 * count 0 (R-ACT). "Close thread…" only with threads.manage. No React, no API.
 *
 * B-TH-229 (TH-2, on B-TH-027 / B-TH-028): the API's ONE waiting rule (a request by its state, any other record by its last shared
 * message; working time on the company calendar; amber only while it waits on us past 1 working day for a request, 3 for any other
 * record), the owner (who answers it) with "Change owner", and "2 new" — the reader's own new messages. Not drawn until the back end
 * has it (honest UI): search (G11), "Done" (N18), "In project" (PROJ-G12).
 *
 * Brand wall (W06, W08, W24, W34): the portal head is one plain line from real states, with no office count; "Share with a
 * partner" and "Ask a partner to approve" reach only this record's party (held when it has none); the doors open the
 * existing dialogs of record-panels, which check the party again.
 */

// ── who answers next ────────────────────────────────────────────────────────────────────────────────────────────────

/** A message as the waiting rule reads it (record-panels' ApiMessage has these fields). */
export interface AnswerInput {
  readonly direction: 'INTERNAL_NOTE' | 'OUTBOUND' | 'INBOUND'
  readonly author: { readonly kind: 'USER' | 'WORKER' | 'PARTY' | 'SYSTEM' }
  readonly at: string
}

/** Who must answer next and since when: `us` (the party wrote last) or `party` (a person of ours wrote to them last). */
export interface Answers {
  readonly on: 'us' | 'party'
  readonly since: string
  // ---- B-TH-229: the API's waiting (B-TH-028, the one rule); absent: the clock-time reading of the messages (whoAnswers)
  /** Working minutes since, on the record's company calendar (clock minutes when `calendar` is false). */
  readonly workingMinutes?: number
  readonly calendar?: boolean
  /** Over the rule's threshold while it waits on us: the pill is amber. */
  readonly amber?: boolean
  /** The rule's threshold in working days (1 for a request, 3 for any other record), said in the tooltip. */
  readonly thresholdDays?: number
  // ---- end B-TH-229
}

// ---- B-TH-229: the API's head (B-TH-028) as the pill reads it -------------------------------------------------------------------
/** The office thread answer's `head.waiting` (platform/threads contract). */
export interface ApiWaiting {
  readonly on: 'US' | 'CUSTOMER'
  readonly since: string
  readonly workingMinutes: number
  readonly calendar: boolean
  readonly amber: boolean
  readonly thresholdDays: number
}

/** The API's waiting as the Head's pill: the same rule as Incoming's tile and Today (factory-domain threads/waiting). */
export const answersOf = (waiting: ApiWaiting | null): Answers | null =>
  waiting ? { on: waiting.on === 'US' ? 'us' : 'party', since: waiting.since, workingMinutes: waiting.workingMinutes, calendar: waiting.calendar, amber: waiting.amber, thresholdDays: waiting.thresholdDays } : null

/** One working day, in working minutes (factory-domain sales/inquiries WORKING_DAY_MINUTES). */
export const WORKING_DAY = 480

/**
 * How long, short, by the rule's own clock: working time when the API counted it on the calendar ("4 h" = four working hours, a
 * day = 8 working hours), else clock time since the message (waitWords).
 */
export function waitingWords(answers: Answers, now: number): { readonly key: 'wait.minutes' | 'wait.hours' | 'wait.days'; readonly n: number } {
  if (answers.workingMinutes === undefined || !answers.calendar) return waitWords(answers.since, now)
  const minutes = Math.max(1, answers.workingMinutes)
  if (minutes < 60) return { key: 'wait.minutes', n: minutes }
  if (minutes < WORKING_DAY) return { key: 'wait.hours', n: Math.floor(minutes / 60) }
  return { key: 'wait.days', n: Math.floor(minutes / WORKING_DAY) }
}

/** The thread's owner (B-TH-028): who answers it — set on the thread, else the request's assignee or the order's supervisor, else its maker. */
export interface HeadOwner {
  readonly id: string
  readonly name: string
  readonly active: boolean
  readonly source: 'SET' | 'ASSIGNEE' | 'SUPERVISOR' | 'MAKER'
}

/** "2 new", "99+ new": the reader's own new messages (null: nothing new, no chip). */
export const newWords = (count: number): { readonly key: 'new.count' | 'new.many'; readonly n: number } | null => (count <= 0 ? null : count > 99 ? { key: 'new.many', n: 99 } : { key: 'new.count', n: count })
// ---- end B-TH-229

/**
 * The waiting rule as far as the back end holds it today: the last message SHARED with the party decides (an office note
 * never flips it). Inbound → on us; outbound written by a person → on the party; an automatic mail (the system) decides
 * nothing. No shared message, or no party → nobody waits (no pill). Clock time: the working-hours rule comes with B-TH-028.
 */
export function whoAnswers(messages: readonly AnswerInput[], hasParty: boolean): Answers | null {
  if (!hasParty) return null
  let last: AnswerInput | null = null
  for (const message of messages) {
    if (message.direction === 'INTERNAL_NOTE') continue
    if (message.direction === 'OUTBOUND' && message.author.kind !== 'USER') continue
    if (!last || Date.parse(message.at) >= Date.parse(last.at)) last = message
  }
  if (!last) return null
  return { on: last.direction === 'INBOUND' ? 'us' : 'party', since: last.at }
}

/** How long, short: "8 min", "4 h", "2 d" (a key of `record-thread-head` and its number). Under a minute counts as 1 min. */
export function waitWords(since: string, now: number): { readonly key: 'wait.minutes' | 'wait.hours' | 'wait.days'; readonly n: number } {
  const minutes = Math.max(1, Math.floor((now - Date.parse(since)) / 60_000))
  if (minutes < 60) return { key: 'wait.minutes', n: minutes }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return { key: 'wait.hours', n: hours }
  return { key: 'wait.days', n: Math.floor(hours / 24) }
}

// ── the view, the width ─────────────────────────────────────────────────────────────────────────────────────────────

/** View ▾ All · With the customer · Office notes · Changes (Changes needs audit.read; money by grain). */
export type ThreadView = 'all' | 'shared' | 'notes' | 'changes'
export const THREAD_VIEWS: readonly ThreadView[] = ['all', 'shared', 'notes', 'changes']

/** The views offered: a kind the thread does not hold is not offered, Changes only with audit.read. All is always there. */
export function viewsOffered(input: { readonly hasShared: boolean; readonly hasNotes: boolean; readonly canAudit: boolean }): ThreadView[] {
  return THREAD_VIEWS.filter((view) => view === 'all' || (view === 'shared' && input.hasShared) || (view === 'notes' && input.hasNotes) || (view === 'changes' && input.canAudit))
}

/** The dock's widths (T1-F07): one third / 40 % / 50 % / full; hide is ⌘J. */
export type DockWidth = 'third' | 'forty' | 'half' | 'full'
export const DOCK_WIDTHS: readonly DockWidth[] = ['third', 'forty', 'half', 'full']
export const DEFAULT_DOCK_WIDTH: DockWidth = 'forty'

/** Where the width is remembered on this device: per person and record type (a private window has none: 40 %). */
export const widthKey = (recordType: string, personId: string | null) => `factory.thread.width.${personId ?? 'anyone'}.${recordType}`

export const isDockWidth = (value: unknown): value is DockWidth => typeof value === 'string' && (DOCK_WIDTHS as readonly string[]).includes(value)

// ── the doors (rule R-ACT) ──────────────────────────────────────────────────────────────────────────────────────────

/** Activity's tools, in the order every record shows them. */
export type HeadDoor = 'task' | 'approve' | 'share' | 'followers' | 'follow' | 'mute' | 'remind'
export const R_ACT_ORDER: readonly HeadDoor[] = ['task', 'approve', 'share', 'followers', 'follow', 'mute', 'remind']

/** Why a door is held, in words to come: a key of `record-thread-head` and its values (`right` = the right's words). */
export interface Held {
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
}

/** What the person may do here (the container reads their rights over the record; the API checks each call again). */
export interface HeadAbilities {
  /** Add a task on the record. */
  readonly task: boolean
  /** partners.approvals.ask */
  readonly approve: boolean
  /** Invite a partner to the record. */
  readonly share: boolean
  /** Follow, mute and add a colleague (threads.read; adding needs threads.post: the Followers dialog says so). */
  readonly follow: boolean
  /** Set a reminder. */
  readonly remind: boolean
  /** threads.manage: Close thread… and Reopen. */
  readonly manage: boolean
  /** audit.read: View › Changes. */
  readonly audit: boolean
}

/** The right each door needs, in the words the container gives (`rightWords`); a door without words says "another role". */
export type RightWords = Partial<Record<'task' | 'approve' | 'share' | 'follow' | 'remind', string>>

/**
 * Why each door is held, or null when it opens. The five tools never hide (R-ACT): no right → held with the right it
 * needs; no party on the record → Ask and Share held "This record has no customer or supplier"; a record that is never
 * shared (`shareable: false`: a work order, a quality hold, a nonconformance — the API's NOT_SHAREABLE, B-PR-08a) → Ask and
 * Share held "This record stays inside the factory"; offline → held "You are offline". A closed thread keeps them open (a task or a share does not write in the thread).
 */
export function doorHolds(input: { readonly can: HeadAbilities; readonly hasParty: boolean; readonly offline: boolean; readonly rights?: RightWords; readonly shareable?: boolean }): Readonly<Record<HeadDoor, Held | null>> {
  const right = (door: keyof RightWords): Held => (input.rights?.[door] ? { key: 'held.noRight', params: { right: input.rights[door]! } } : { key: 'held.noRole' })
  const hold = (door: keyof RightWords, needsParty = false): Held | null => {
    if (input.offline) return { key: 'held.offline' }
    // B-PR-08a: a work order, a quality hold or a nonconformance is never shared (the API's NOT_SHAREABLE): said, not hidden.
    if (needsParty && input.shareable === false) return { key: 'held.notShareable' }
    if (!input.can[door]) return right(door)
    if (needsParty && !input.hasParty) return { key: 'held.noParty' }
    return null
  }
  const follow = hold('follow')
  return { task: hold('task'), approve: hold('approve', true), share: hold('share', true), followers: follow, follow, mute: follow, remind: hold('remind') }
}

// ── the Head's view model ───────────────────────────────────────────────────────────────────────────────────────────

/** The record's party, as the Head words it: "Waiting on customer", "With the supplier". */
export interface HeadParty {
  readonly name: string
  readonly role: 'customer' | 'supplier' | 'partner'
}

export interface HeadModel {
  /** The record as its page names it ("SO-2026-0142"): the region's name and the phone head's title. */
  readonly record: string
  readonly party: HeadParty | null
  /** Who answers next (whoAnswers), or null: no pill. */
  readonly answers: Answers | null
  /** Closed: by whom and when ("Closed by Alex Demo, 12 Nov"). */
  readonly closed: { readonly by: string | null; readonly at: string } | null
  /** Offline since: "Offline · as of 10:42"; the doors are held. */
  readonly offline: { readonly asOf: string } | null
  readonly view: ThreadView
  readonly views: readonly ThreadView[]
  /** The record's counts (each a chip when not zero, opening its popover); absent: the person may not see that count. */
  readonly counts: Partial<Record<CountKind, CountPopoverModel>>
  readonly holds: Readonly<Record<HeadDoor, Held | null>>
  /** Me and the record: Follow / Unfollow, Mute / Unmute. */
  readonly follow: { readonly following: boolean; readonly muted: boolean } | null
  /** My reminder on the record ("Reminder set for 18 Nov"), or null. */
  readonly reminder: { readonly at: string } | null
  /** threads.manage (Owner, Administrator): Close thread… / Reopen. */
  readonly canManage: boolean
  /** The dock's width now, or null where there is no dock (below 1280 px, a full page): no width menu. */
  readonly width: DockWidth | null
  /** The phone head: the record and the pill; the View and the rest in the "⋯". */
  readonly compact?: boolean
  /** "Print or save as PDF" (record-panels' print view), when the page has it. */
  readonly print?: boolean
  readonly now: number
  readonly timeZone?: string
  // ---- B-TH-229
  /** Who answers the thread; null: nobody known; undefined: not read (no owner drawn). */
  readonly owner?: HeadOwner | null
  /** "Change owner" (threads.post): held with why, or null; undefined: not offered. */
  readonly ownerHeld?: Held | null
  /** The reader's own new messages ("2 new"); 0: no chip. */
  readonly newCount?: number
  // ---- end B-TH-229
}

/** One row of the "⋯", in order: an R-ACT door, a View choice (phone), Print, Close / Reopen. */
export type MenuRow =
  | { readonly kind: 'door'; readonly door: HeadDoor; readonly held: Held | null; readonly label: { readonly key: string; readonly params?: Readonly<Record<string, string | number>> }; readonly hint?: { readonly key: string; readonly params?: Readonly<Record<string, string | number>> } }
  | { readonly kind: 'view'; readonly view: ThreadView; readonly checked: boolean }
  | { readonly kind: 'print' }
  | { readonly kind: 'close' | 'reopen' }
  // B-TH-229: "Change owner…" (threads.post), after the doors.
  | { readonly kind: 'owner'; readonly held: Held | null }

/**
 * The "⋯" rows: the five R-ACT tools ALWAYS (held with why, also at count 0), the views on a phone, Print, then Close.
 * `folded`: the count chips did not fit the row (a narrow dock): the counts go on their door's line.
 */
export function menuRows(model: Pick<HeadModel, 'holds' | 'follow' | 'reminder' | 'counts' | 'canManage' | 'closed' | 'compact' | 'views' | 'view' | 'print' | 'ownerHeld'>, folded = false): MenuRow[] {
  const following = model.follow?.following ?? false
  const muted = model.follow?.muted ?? false
  const followers = model.counts.followers?.count
  const count = (kind: CountKind, key: string) => {
    const n = model.counts[kind]?.count ?? 0
    return folded && n > 0 ? { hint: { key, params: { count: n } } } : {}
  }
  const rows: MenuRow[] = [
    { kind: 'door', door: 'task', held: model.holds.task, label: { key: 'act.task' }, ...count('tasks', 'act.openTasks') },
    { kind: 'door', door: 'approve', held: model.holds.approve, label: { key: 'act.approve' }, ...count('approvals', 'act.openApprovals') },
    { kind: 'door', door: 'share', held: model.holds.share, label: { key: 'act.share' }, ...count('partners', 'act.invited') },
    { kind: 'door', door: 'followers', held: model.holds.followers, label: followers ? { key: 'act.followersN', params: { count: followers } } : { key: 'act.followers' } },
    { kind: 'door', door: 'follow', held: model.holds.follow, label: { key: following ? 'act.unfollow' : 'act.follow' } },
    // Muting keeps a follow without its news: one must follow first.
    { kind: 'door', door: 'mute', held: model.holds.mute ?? (following ? null : { key: 'held.followFirst' }), label: { key: muted ? 'act.unmute' : 'act.mute' }, hint: { key: 'act.muteHint' } },
    { kind: 'door', door: 'remind', held: model.holds.remind, label: { key: 'act.remind' }, ...(model.reminder ? { hint: { key: 'act.reminderSet', params: { at: model.reminder.at } } } : {}) },
  ]
  // B-TH-229: who answers it, changed by whoever may write on it.
  if (model.ownerHeld !== undefined) rows.push({ kind: 'owner', held: model.ownerHeld })
  if (model.compact) for (const view of model.views) rows.push({ kind: 'view', view, checked: view === model.view })
  if (model.print) rows.push({ kind: 'print' })
  if (model.canManage) rows.push({ kind: model.closed ? 'reopen' : 'close' })
  return rows
}
