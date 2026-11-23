import { assignHeld } from '../../../../_shared/production-supervisor/model'
import { openHeld } from '../../../../production/_shared/notes/model'
import { BATCH_MAX } from '../../../../../record-panels/tasks/model'
import type { OrderRow, OrderStatus } from '../../api'
import { selectionHeld } from '../../depth/model'
import { manyHeld, manyShown, type ManyCommand } from '../commands/model'
import { replyManyHeld } from '../reply-many'
import { oneCustomerHeld, supervisorTargetsOf } from './model'
import { invoiceShippedHeld } from './overall'
import { shipHeld } from './ship' // F-CW-301
import { urgencyHeld } from './urgency' // F-CW-302

/**
 * F-CW-202 (customer Work tab plan §4; 10-design §4; 13-backend §8; lead settles S8, S9, S37) — the bar of ticked orders on the ONE
 * Orders sheet, pure, the same on its three hosts (the customer's Work tab, Sales › Orders, Sales › Made to measure):
 *
 *   at most THREE acts with their words, then ONE "More ▾" with the rest, in one fixed order.
 *
 * - An act the reader has NO RIGHT for is not in the bar at all (never a greyed button that only says "you may not"); each act
 *   reads its OWN right — there is no page-level "read only".
 * - An act the ticked orders cannot take NOW stays where its order puts it, held with words: a state ("None of the 3 is in
 *   production."), a cap ("At most 50 orders at once."), or orders of more than one customer.
 * - When a promoted act is not there, the next allowed act of More ▾ moves up: the reader always sees its first three acts.
 * - No act at all: the bar says so in one sentence (`none`).
 *
 * Each hold is the act's own existing rule, asked with the right given (the right itself is decided here, once): the words stay in
 * the catalogue that already says them (`ns`). The list frame's own Edit N and Export N are not acts of this rule (the frame draws
 * them after these, each by its own right).
 */

/** What the reader may do on the ticked orders — each act's OWN right. */
export interface BarCan {
  /** F-CW-301 — shipping.manage: Ship N together… (Sales holds no shipping right: not drawn for them, S23). */
  readonly ship: boolean
  /** F-CW-302 — production.brand.override: Customer urgency: Set to regular… · Unlock… (S7: each with its own right + a fresh code). */
  readonly urgency: boolean
  /** orders.manage: Set priority, Mark ready, Close. */
  readonly manage: boolean
  /** orders.close: Close (an order that is not settled, with a reason). */
  readonly close: boolean
  /** approvals.decide: Confirm. */
  readonly decide: boolean
  /** threads.post: Ask, Reply, Note. */
  readonly post: boolean
  /** production.brand.manage: Assign supervisor. */
  readonly supervisor: boolean
  /** tasks.manage (with threads.post): Add task. */
  readonly task: boolean
  /** F-CW-203 — partners.tasks.manage: "Ask <customer> about N…" (a to-do in the customer's list beside the message). */
  readonly todo: boolean
  /** Finance's right to make invoice drafts: Invoice shipped goods. */
  readonly invoices: boolean
}

/** A reader with no act at all (a read-only role). */
export const NO_BAR_CAN: BarCan = Object.freeze({ ship: false, urgency: false, manage: false, close: false, decide: false, post: false, supervisor: false, task: false, todo: false, invoices: false })

/** The bar's acts, by id. */
export type BarActId = 'ship' /* F-CW-301 */ | 'ask' | 'priority' | 'reply' | 'assign' | 'task' | 'note' | ManyCommand | 'urgencyRegular' | 'urgencyUnlock' /* F-CW-302 */ | 'invoice'
/** The entries of Ask ▾ (S8: exactly two; S37: a reader who may not make a customer's to-dos gets the first alone). */
export type AskEntryId = 'askProduction' | 'askCustomer'

/** Words of a hold, in the catalogue that already says them. */
export type BarNs = 'sheet' | 'orders' | 'notes' | 'supervisor' | 'depth'
export interface BarWords {
  readonly ns: BarNs
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
  /** `{state}` is filled with these status words (the commands' own sentence). */
  readonly states?: readonly OrderStatus[]
}

export interface AskEntry {
  readonly id: AskEntryId
  readonly held: BarWords | null
}

export interface BarAct {
  readonly id: BarActId
  /** More ▾ draws a rule where the group changes. */
  readonly group: number
  /** Why it cannot run on the ticked orders now (a state or a cap), in words; null: it may. Never a missing right. */
  readonly held: BarWords | null
  /** Ask ▾ only: what it offers (each entry held on its own). */
  readonly entries?: readonly AskEntry[]
}

export interface Bar {
  /** The acts drawn as buttons with their words, at most BAR_PROMOTED. */
  readonly promoted: readonly BarAct[]
  /** The rest, for More ▾, in their order. */
  readonly more: readonly BarAct[]
  /** The reader has no act for the ticked orders at all. */
  readonly none: boolean
}

/** At most this many acts with words; the rest sit in More ▾. */
export const BAR_PROMOTED = 3

/**
 * The ONE order of the acts (S8): the promoted ones first (group 0) — F-CW-301: "Ship N together…" leads —, then More ▾'s groups:
 * what the customer and the office read and write (1), the order's own commands (2), money (4). The customer's urgency is group 3.
 */
export const BAR_ORDER: ReadonlyArray<{ readonly id: BarActId; readonly group: number }> = Object.freeze([
  { id: 'ship', group: 0 },
  { id: 'ask', group: 0 },
  { id: 'priority', group: 0 },
  { id: 'reply', group: 1 },
  { id: 'assign', group: 1 },
  { id: 'task', group: 1 },
  { id: 'note', group: 1 },
  { id: 'ready', group: 2 },
  { id: 'close', group: 2 },
  { id: 'confirm', group: 2 },
  { id: 'urgencyRegular', group: 3 }, // F-CW-302: the customer's urgency as we steer it
  { id: 'urgencyUnlock', group: 3 },
  { id: 'invoice', group: 4 },
])

/** The ticked orders as the bar's rules read them. */
export type BarRow = Pick<OrderRow, 'id' | 'number' | 'customerRef' | 'partyId' | 'partyName' | 'companyId' | 'status' | /* F-CW-301 */ 'units' | 'shippedUnits' | 'production' | /* F-CW-302 */ 'customerUrgencyState'>

export interface BarHost {
  /** The page's own customer (the customer page): a ticked order of another customer holds the acts that take one customer. */
  readonly locked: string | null
  /** F-CW-302 — the customer's urgency switch is off (only the customer's Work tab reads it): the urgency acts are held with words. */
  readonly urgencyOff?: boolean
}

const sheet = (phrase: { readonly key: string; readonly params?: Readonly<Record<string, string | number>> } | null): BarWords | null => (phrase ? { ns: 'sheet', ...phrase } : null)
const of = (ns: BarNs, phrase: { readonly key: string; readonly params?: Readonly<Record<string, string | number>> } | null): BarWords | null => (phrase ? { ns, ...phrase } : null)

/** Whether the reader holds the act's own right. */
export function barAllowed(id: BarActId, can: BarCan): boolean {
  switch (id) {
    case 'ship':
      return can.ship
    case 'ask':
    case 'reply':
    case 'note':
      return can.post
    case 'priority':
      return can.manage
    case 'ready':
    case 'close':
    case 'confirm':
      return manyShown(can, can.decide).includes(id) // the commands' ONE rule
    case 'assign':
      return can.supervisor
    case 'task':
      return can.task
    case 'urgencyRegular':
    case 'urgencyUnlock':
      return can.urgency
    case 'invoice':
      return can.invoices
  }
}

/** Why an act the reader may do cannot run on these orders now, or null. */
export function barHeld(id: Exclude<BarActId, 'ask'>, rows: readonly BarRow[], can: BarCan, host: BarHost): BarWords | null {
  if (rows.length === 0) return null
  // The acts that open ONE window for ONE customer: the one-customer check first (the server checks each record again).
  const one = sheet(oneCustomerHeld(rows, host.locked))
  switch (id) {
    case 'ship':
      return sheet(shipHeld(rows, host.locked)) // F-CW-301: one customer, the cap of 20, nothing ready now (only when known)
    case 'priority':
      return one ?? of('depth', selectionHeld(rows.length, { manage: true }))
    case 'reply':
      return sheet(replyManyHeld(rows, host.locked, true))
    case 'assign':
      return one ?? of('supervisor', assignHeld({ manage: true }, { targets: supervisorTargetsOf(rows), leftOut: 0 }))
    case 'task':
      return one ?? (rows.length > BATCH_MAX ? { ns: 'sheet', key: 'bulk.tooMany', params: { max: BATCH_MAX } } : null)
    case 'note':
      return one ?? of('notes', openHeld(true, rows.length))
    case 'urgencyRegular':
      return sheet(urgencyHeld('regular', rows, host)) // F-CW-302: one customer, its switch, a state, the write's cap
    case 'urgencyUnlock':
      return sheet(urgencyHeld('unlock', rows, host))
    case 'invoice': {
      const key = invoiceShippedHeld(rows.length)
      return key ? { ns: 'sheet', key } : null
    }
    default: {
      const words = manyHeld(id, rows, can)
      return words ? { ns: words.sheet ? 'sheet' : 'orders', key: words.key, ...(words.params ? { params: words.params } : {}), ...(words.states ? { states: words.states } : {}) } : null
    }
  }
}

/**
 * Ask ▾'s entries for this reader: "Ask production about N…" (an office note to each order's supervisor that needs an answer) and —
 * F-CW-203, only with partners.tasks.manage — "Ask <customer> about N…" (Reply to N with the to-do tick ON: held as Reply to N is).
 * Without that right the customer is asked by a plain "Reply to <customer> on N…" (the bar's own act).
 */
export function askEntriesOf(rows: readonly BarRow[], can: Pick<BarCan, 'todo'>, host: BarHost): AskEntry[] {
  return [
    { id: 'askProduction', held: barHeld('note', rows, { ...NO_BAR_CAN, post: true }, host) },
    ...(can.todo ? [{ id: 'askCustomer' as const, held: barHeld('reply', rows, { ...NO_BAR_CAN, post: true }, host) }] : []),
  ]
}

/**
 * The bar for this reader over the ticked orders: its first three acts with words, the rest for More ▾.
 * cw fx5 (walk W-9, W-4, W-14): `promoted` — how many acts the room holds WITH their words (promotedFit below; absent: three). An act
 * that does not fit moves to the front of More ▾ (the last promoted first): a button never loses its words.
 */
export function barOf(can: BarCan, rows: readonly BarRow[], host: BarHost, promoted: number = BAR_PROMOTED): Bar {
  const acts: BarAct[] = BAR_ORDER.filter((entry) => barAllowed(entry.id, can)).map((entry) =>
    entry.id === 'ask' ? { id: entry.id, group: entry.group, held: null, entries: askEntriesOf(rows, can, host) } : { id: entry.id, group: entry.group, held: barHeld(entry.id, rows, can, host) },
  )
  const shown = Math.max(1, Math.min(BAR_PROMOTED, promoted))
  return { promoted: acts.slice(0, shown), more: acts.slice(shown), none: acts.length === 0 }
}

// ---- cw fx5 (walk W-9, W-4, W-14; 30-walk §6.4, §6.5): the bar keeps WORDS on every button, on one line ------------------------------
/**
 * What the bar's parts take, measured on the real page with three orders ticked (30-walk §6.4): a button is about 45 px (its icon and
 * padding) + 6.5 px a character, a menu's ▾ 16 more, 8 px stand between two parts, and "N selected" leads. The sum is a little
 * generous on purpose (971 px measured for the Production manager's bar, 992 by this rule): a word is never lost to a near miss.
 */
export const BAR_PX = Object.freeze({ button: 45, char: 6.5, chevron: 16, gap: 8, lead: 12, phonePad: 24 })

/** One part of the bar as it is measured: its words, and whether it is a menu (▾). */
export interface BarPart {
  readonly label: string
  readonly menu?: boolean
}
export const barPartPx = (part: BarPart): number => Math.round(BAR_PX.button + BAR_PX.char * part.label.length + (part.menu ? BAR_PX.chevron : 0))

/** The whole bar's width with every word: "N selected", the promoted acts, then the parts that always stand (Export N, More ▾, Clear selection …). */
export function barPx(lead: string, promoted: readonly BarPart[], rest: readonly BarPart[]): number {
  const parts = [...promoted, ...rest]
  return Math.round(BAR_PX.lead + BAR_PX.char * lead.length) + parts.reduce((sum, part) => sum + barPartPx(part), 0) + BAR_PX.gap * parts.length
}

/**
 * How many promoted acts keep their words in `room` px: all of them when the bar fits, else the LAST one gives way (it moves into
 * More ▾), then the next — never fewer than one. The DS bar hides the words of its own buttons (Export N, Clear selection) as soon
 * as the cluster does not fit, so the sheet makes the cluster fit first. `room` null (not measured yet: the server's draw): all.
 * On the phone (`phone`) at most two: "N selected" · the promoted acts · Export N + More ▾ are then three lines.
 */
export function promotedFit(room: number | null, lead: string, promoted: readonly BarPart[], rest: readonly BarPart[], phone = false): number {
  const most = Math.max(1, Math.min(promoted.length, phone ? 2 : BAR_PROMOTED))
  if (room === null) return most
  for (let count = most; count > 1; count -= 1) {
    // The phone's bar: the promoted acts stand on a line of their own inside the bar's padding ("N selected" is the card list's own line).
    const need = phone ? barPx('', promoted.slice(0, count), []) - BAR_PX.lead + BAR_PX.phonePad : barPx(lead, promoted.slice(0, count), rest)
    if (need <= room) return count
  }
  return 1
}
// ---- end cw fx5
