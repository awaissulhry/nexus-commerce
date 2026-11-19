import { isApiError, issuePath } from '../../api/errors'
import { releaseRefusalCodes, writeProblem as productionWriteProblem } from '../../../areas/production/_shared/model'

/**
 * F-OP-113 (order page plan 10-order-page §5.2; review R-11, B6) — what a person may do to one work order from a page that is not the
 * work order's own (the sales order's Production tab), without a screen:
 *
 *   in place   Due (a day), Priority (a whole number, higher first) and Rush — until the work order is closed or cancelled
 *   row ⋯      Note… (always, but on a work order shared with other customers);
 *              F-OP-114: Hold… (a draft, released or started one not held), Lift… (a held one), Release… (a draft)
 *              F-OP-115: Split… (a draft), Cancel… (a draft, released or started one; with cut pieces refused in words — R-16),
 *              Close… (a completed one) · Reopen… (a closed one); Open in Planning › (line, workshop, start, outside: the board)
 *              and Open the work order — links. Scrap and cut orders stay links on their own pages; Dispatch never shows here
 *              (it names workers).
 *
 * Every write sends the version the row carries (B6: the order's production read gives it) or the newer one a write answered. A work
 * order made before the one-customer rule (shared with other customers) is changed on its own page only: the row offers nothing but
 * its link and says why (R-11) — a mixed work order is never changed from one customer's order. Without the right, the act stays on
 * the row held in words ("Production does this — …"), never hidden.
 *
 * Words are `orders` keys (`wo.*`); a phrase from another catalogue names it (`production:error.changed`).
 */

export interface Phrase {
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
}

/** A read the page holds: its value, or why it failed (a message key); both null while it reads. */
export interface Part<T> {
  readonly value: T | null
  readonly problem: string | null
}
export const READING = { value: null, problem: null } as const

/** Text in both languages, as the API sends it. */
export interface Words {
  readonly it: string
  readonly en: string
}

/** The reader's rights over one work order, as the order's production read says them (B-OP-021: by can() over the work order). */
export interface RowRights {
  readonly manage: boolean
  readonly release: boolean
  readonly hold: boolean
  /** Why nothing may be done here (a work order shared with other customers); null: the rights are the reader's own. */
  readonly why: Words | null
}

/** One work order as a row of the order's Production tab holds it (the production read's work order). */
export interface ActsRow {
  readonly id: string
  readonly number: string
  readonly status: string
  readonly held: boolean
  readonly rush: boolean
  readonly due: string | null
  readonly sharedWithOtherCustomers: boolean
  /** B-OP-021 (B6): absent on an older read — then the row offers nothing in place. */
  readonly version?: number
  readonly priority?: number
  readonly rights?: RowRights
}

/** The rights of the page's reader that are not the work order's own (reopen, the planning board). */
export interface ActsCan {
  /** workorders.view: the work order is read afresh before a dialog opens. */
  readonly view: boolean
  /** F-OP-114: quality.holds.place — Hold… offers the quality reasons too (a production hold needs the row's own hold right). */
  readonly qualityHold: boolean
  /** workorders.reopen: reopen a closed work order (the production manager). */
  readonly reopen: boolean
  /** planning.view: Open in Planning ›. */
  readonly planning: boolean
}

export function actsCanOf(permissions: readonly string[]): ActsCan {
  const held = new Set(permissions)
  return { view: held.has('workorders.view'), qualityHold: held.has('quality.holds.place') /* F-OP-114 */, reopen: held.has('workorders.reopen'), planning: held.has('planning.view') }
}

export const INLINE_FIELDS = ['due', 'priority', 'rush'] as const
export type InlineField = (typeof INLINE_FIELDS)[number]

/** The row ⋯ acts, in the order the menu lists them (F-OP-114: + hold, lift, release; F-OP-115: + split, cancel, close, reopen). */
export const MENU_ACTS = ['note', 'hold', 'lift', 'release', 'split', 'cancel', 'close', 'reopen'] as const
export type MenuAct = (typeof MENU_ACTS)[number]

/** A closed or cancelled work order keeps its due date, priority and rush (only its note changes: the API's rule). */
export const FINAL_STATUSES: readonly string[] = Object.freeze(['CLOSED', 'CANCELLED'])
/** F-OP-114: a work order is put on hold while a draft, released or started (the daily page's rule, HOLDABLE). */
export const HOLDABLE_STATUSES: readonly string[] = Object.freeze(['DRAFT', 'RELEASED', 'IN_PROGRESS'])
/** F-OP-115: the machine cancels a draft, released or started work order (never a held, completed or final one). */
export const CANCELLABLE_STATUSES: readonly string[] = Object.freeze(['DRAFT', 'RELEASED', 'IN_PROGRESS'])
/** F-OP-115: only the production manager reopens a closed work order (workorders.reopen). */
export const HELD_REOPEN: Phrase = Object.freeze({ key: 'wo.heldReopen' })
/** F-OP-115: the row ⋯'s links (never an act): the planning board at this work order, and the work order's own page. */
export const MENU_LINKS = ['planning', 'open'] as const
export type MenuLink = (typeof MENU_LINKS)[number]

/** Production's people do it: a planner or the production manager (Planner / PM hold workorders.manage, .release and .hold). */
export const HELD_FOR_SALES: Phrase = Object.freeze({ key: 'wo.heldHold' })

export interface RowActs {
  /** Shared with other customers: the row offers nothing but its link, with these words (R-11). */
  readonly shared: Words | null
  /** Due, priority and rush in place: null when the row offers none (shared, closed, cancelled, an older read without a version). */
  readonly inline: { readonly held: Phrase | null } | null
  /** The row ⋯, each act open (held null) or held in words. Empty: no ⋯ on the row. */
  readonly menu: readonly { readonly act: MenuAct; readonly held: Phrase | null }[]
  /** F-OP-115: the row ⋯'s links after its acts (Open in Planning ›, Open the work order); none on a shared row. */
  readonly links?: readonly MenuLink[]
}

const NOTHING: RowActs = Object.freeze({ shared: null, inline: null, menu: [] })

/** What one row offers its reader (see the head of this file). */
export function rowActsOf(row: ActsRow, can: ActsCan): RowActs {
  const rights = row.rights
  if (row.sharedWithOtherCustomers || rights?.why) return { shared: rights?.why ?? null, inline: null, menu: [] }
  if (!rights || row.version === undefined || !can.view) return NOTHING
  const manage = rights.manage ? null : HELD_FOR_SALES
  const final = FINAL_STATUSES.includes(row.status)
  const menu: { act: MenuAct; held: Phrase | null }[] = [{ act: 'note', held: manage }]
  // ---- F-OP-114: Hold… / Lift… (workorders.hold over the work order) and Release… (workorders.release) ----
  const hold = rights.hold ? null : HELD_FOR_SALES
  if (row.held || row.status === 'ON_HOLD') menu.push({ act: 'lift', held: hold })
  else if (HOLDABLE_STATUSES.includes(row.status)) menu.push({ act: 'hold', held: hold })
  if (row.status === 'DRAFT') menu.push({ act: 'release', held: rights.release ? null : HELD_FOR_SALES })
  // ---- end F-OP-114
  // ---- F-OP-115: Split… (a draft), Cancel…, Close… (completed) · Reopen… (closed); the links ----
  if (row.status === 'DRAFT') menu.push({ act: 'split', held: manage })
  if (CANCELLABLE_STATUSES.includes(row.status)) menu.push({ act: 'cancel', held: manage })
  if (row.status === 'COMPLETED') menu.push({ act: 'close', held: manage })
  if (row.status === 'CLOSED') menu.push({ act: 'reopen', held: can.reopen ? null : HELD_REOPEN })
  const links: MenuLink[] = [...(can.planning && !final ? (['planning'] as const) : []), 'open']
  // ---- end F-OP-115
  return { shared: null, inline: final ? null : { held: manage }, menu, links }
}

/**
 * Whether a write reaches the floor (its tablets and dispatch lists follow it): a due date, priority or rush on a released work order
 * (a draft is not on the floor yet). The row then says "Told the floor at hh:mm" — when, never who read it.
 */
export function reachesFloor(field: InlineField | 'note', status: string): boolean {
  if (field === 'note') return false
  return status !== 'DRAFT' && !FINAL_STATUSES.includes(status)
}

/** The version a write sends: the newer of the row's (the production read) and the one a write of this page answered. */
export const versionOf = (row: Pick<ActsRow, 'id' | 'version'>, known: Readonly<Record<string, number>>): number => Math.max(row.version ?? 0, known[row.id] ?? 0)

/** The priorities offered in place (higher comes first; the API takes -1000…1000), with the row's own when it is another. */
export const PRIORITY_CHOICES: readonly number[] = Object.freeze([1000, 500, 200, 100, 50, 0, -100])
export function priorityChoices(current: number | undefined): number[] {
  const all = new Set<number>(PRIORITY_CHOICES)
  if (current !== undefined && Number.isInteger(current)) all.add(current)
  return [...all].sort((a, b) => b - a)
}

/** The note's limit (the API's PATCH: at most 2000 characters, trimmed). */
export const NOTE_MAX = 2000

/** The work orders of a card in a stable order — by number — so a row never moves under the cursor when the read comes again. */
export function stableRows<T extends { readonly number: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => a.number.localeCompare(b.number, 'en', { numeric: true }))
}

/** The later of two instants (an ISO string or null): the floor's last told time from the server and from a write here. */
export function laterOf(a: string | null | undefined, b: string | null | undefined): string | null {
  if (!a) return b ?? null
  if (!b) return a
  return Date.parse(a) >= Date.parse(b) ? a : b
}

/** A phrase of the production catalogue, named for a translator scoped to another (`production:error.changed`). */
export const fromProduction = (phrase: Phrase): Phrase => (phrase.key.includes(':') ? phrase : { ...phrase, key: `production:${phrase.key}` })

// ---- F-OP-114 ----
/** A phrase of the production lane's work-order catalogue (hold.*, liftHold.*, notice.*), named for another translator. */
export const fromWorkOrders = (phrase: Phrase): Phrase => (phrase.key.includes(':') ? phrase : { ...phrase, key: `production-work-orders:${phrase.key}` })

/**
 * Why a release from the order page was refused, in words (never the API's English): the customer over its credit limit (the
 * release checks it again), a compliance gate, the release check that changed since it was read (the dialog reads it again), or the
 * work order's own refusal.
 */
export function releaseProblemOf(error: unknown): Phrase {
  if (isApiError(error) && error.kind === 'conflict') {
    const paths = error.issues.map(issuePath)
    if (paths.some((path) => path === 'credit' || path.startsWith('credit/'))) return { key: 'wo.release.credit' }
    if (paths.some((path) => path.startsWith('gate/'))) return { key: 'wo.release.gate' }
    const codes = releaseRefusalCodes(error)
    if (codes.length > 0) return { key: 'wo.release.refused', params: { count: codes.length } }
  }
  return fromProduction(productionWriteProblem(error))
}
// ---- end F-OP-114

// ---- F-OP-115 ----
/**
 * Why Cancel… waits, from the cancel check: with cut pieces the API's own words (no outcome picker, R-16: "{n} pieces are cut: lower
 * the work order to the cut instead"); a state the machine does not cancel; else the reason it asks. A string is the API's words in
 * the reader's language; a phrase is a key.
 */
export function cancelHeld(check: { readonly cancellable: boolean; readonly refusal: Words | null } | null, reason: string, busy: boolean, locale: string): string | Phrase | null {
  if (busy) return { key: 'production:held.busy' }
  if (!check) return { key: 'production:held.checking' }
  if (check.refusal) return locale === 'it' ? check.refusal.it : check.refusal.en
  if (!check.cancellable) return { key: 'wo.cancel.notNow' }
  if (reason.trim().length === 0) return { key: 'production:cancel.reasonNeeded' }
  return null
}

/** The planning board at one work order (its bar's detail opens: line, workshop, start, an outside operation). */
export const planningHref = (prefix: string, workOrderId: string): string => `${prefix}/planning/board?wo=${encodeURIComponent(workOrderId)}`
// ---- end F-OP-115
