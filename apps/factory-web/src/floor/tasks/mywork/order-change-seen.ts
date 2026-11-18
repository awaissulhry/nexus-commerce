import type { WorkMessage } from './model'

/**
 * F-SA-247 (sales page plan P8', R2; 14-change-flow §5.3; review WP-1): an order change's "For your work" note on the floor tablet,
 * without React or the network, so the tests hold the rules.
 *
 *   first     For your work lists the ORDER_CHANGE notes first (newest first, as read), each "New" until opened on this tablet
 *   CHECK     opens before the next Start (or the next cut) on its work order, ONCE PER TABLET: the worker reads it and taps
 *             "Got it", then the Start goes on
 *   Got it    kept in THIS tablet's own storage only and NEVER sent: no queue kind, no call to the instructions' Seen route
 *             (a training record, another matter), no server row, no event. Nothing anywhere records who or which tablet read
 *             it (R2; Statuto dei Lavoratori art. 4). The office reads only "Told the floor at hh:mm"
 *   STOP      the work order is held: the hold already refuses the next scan; the note is the reason, in the office's words, and
 *             the screen says to stop and ask the team leader. There is nothing to pass: no Got it
 *   running   a bundle already started is never interrupted: the gate stands only at a Start (Resume, Pause and Finish go on), and
 *             nothing pops up over a running timer
 *   storage   wrapped (a private window, cleared or blocked data): the tablet may show a note twice, never zero times, and a
 *             storage failure never blocks a Start (this visit still remembers the tap)
 *
 * The note's words are the office's (B-SA-053: the customer's CODE, never its name; never a person, never a price): shown as
 * written, never translated.
 */

/** An order change's floor note, as B-SA-053's read lists it (the newest of its work order). */
export type OrderChangeNote = WorkMessage & { readonly kind: 'ORDER_CHANGE'; readonly check: 'STOP' | 'CHECK' }

export function isOrderChange(message: WorkMessage): message is OrderChangeNote {
  return message.kind === 'ORDER_CHANGE' && (message.check === 'STOP' || message.check === 'CHECK')
}

/** For your work: the order changes first, then the other notes; each group keeps the read's order (newest first). */
export function orderChangesFirst<T extends WorkMessage>(messages: readonly T[]): T[] {
  return [...messages.filter((message) => isOrderChange(message)), ...messages.filter((message) => !isOrderChange(message))]
}

/** The newest order-change note of one work order (the read lists one per work order); null: none. */
export function orderChangeOf(messages: readonly WorkMessage[], workOrderId: string): OrderChangeNote | null {
  return messages.find((message): message is OrderChangeNote => message.workOrder.id === workOrderId && isOrderChange(message)) ?? null
}

/** The order changes not opened on this tablet (the tile's count). */
export function newOrderChanges(messages: readonly WorkMessage[], seen: readonly string[]): number {
  const opened = new Set(seen)
  return messages.filter((message) => isOrderChange(message) && !opened.has(message.id)).length
}

/**
 * The note that opens before a Start on these work orders now: the first CHECK note not "got" on this tablet, in the order the
 * work orders are given; null: the Start goes. A STOP note never opens a gate (the hold refuses the scan itself).
 */
export function gateOf(notes: readonly (OrderChangeNote | null | undefined)[], gotIt: readonly string[]): OrderChangeNote | null {
  const got = new Set(gotIt)
  return notes.find((note): note is OrderChangeNote => Boolean(note) && note!.check === 'CHECK' && !got.has(note!.id)) ?? null
}

/** Whether this tablet still has to show a note on a card or a list ("New", "Read this before you start."). */
export function stillToRead(note: OrderChangeNote | null | undefined, gotIt: readonly string[]): boolean {
  return Boolean(note) && (note!.check === 'STOP' || !gotIt.includes(note!.id))
}

// ---- the tablet's own "Got it" marks (browser storage, wrapped; nothing is ever sent) ----------------------------------------------

export const GOT_IT_KEY = 'nexus.floor.orderChange.gotIt'

const GOT_IT_KEPT = 300

/** The note ids tapped "Got it" on this tablet, newest last; the oldest marks fall off. */
export function withGotIt(gotIt: readonly string[], id: string): string[] {
  return gotIt.includes(id) ? [...gotIt] : [...gotIt, id].slice(-GOT_IT_KEPT)
}

/** The marks kept on this tablet: ids only (never a person, a station or a time); anything unreadable is dropped. */
export function readGotIt(text: string | null): string[] {
  if (!text) return []
  try {
    const value = JSON.parse(text) as unknown
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(-GOT_IT_KEPT) : []
  } catch {
    return []
  }
}

/** The tablet's storage, or null where there is none to reach (a private window, a test, blocked site data). */
export type GotItStorage = Pick<Storage, 'getItem' | 'setItem'>

function deviceStorage(): GotItStorage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

/** This visit's taps: a tablet whose storage fails still lets the same note through once in the visit. */
const THIS_VISIT = new Set<string>()

/** The marks on this tablet: its storage's (a failing storage reads as none) and this visit's. */
export function gotItHere(storage: GotItStorage | null = deviceStorage()): string[] {
  let kept: string[] = []
  try {
    kept = readGotIt(storage?.getItem(GOT_IT_KEY) ?? null)
  } catch {
    kept = []
  }
  return [...new Set([...kept, ...THIS_VISIT])]
}

/** "Got it": marked on this tablet only — this visit at once, its storage when it can (a failure is swallowed, never sent). */
export function markGotIt(id: string, storage: GotItStorage | null = deviceStorage()): string[] {
  THIS_VISIT.add(id)
  const next = withGotIt(gotItHere(storage), id)
  try {
    storage?.setItem(GOT_IT_KEY, JSON.stringify(next))
  } catch {
    // Private window or blocked storage: the mark lives for this visit only (the note may show once more after a reload).
  }
  return next
}

/** Tests only: forget this visit's taps (a reload of the page). */
export function forgetThisVisit(): void {
  THIS_VISIT.clear()
}
