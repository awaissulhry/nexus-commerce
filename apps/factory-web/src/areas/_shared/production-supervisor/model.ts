import { SUPERVISOR_REFUSAL_WORDS, NOT_IN_PRODUCTION_WORDS } from '@nexus/factory-domain/production-brand/words'
import { isApiError } from '../../../lib/api/errors'
import type { OrderSupervisorsAnswer, SupervisorPickList } from './api'

/**
 * F-PR-21 — the production supervisor in the office, without a screen (production plan §3 "Supervisor"; lead picks L21, L22; 17-web-r2
 * §1.1). ONE assign dialog for every place that sets an order's supervisor (the work order band's Change…, Work orders' "Assign
 * supervisor…" on a selection; later the Customer card and the limits card mount the same dialog): it names the orders it sets, lists
 * only the people who may take it on EVERY customer of the selection (the pick list read per customer and company, then crossed),
 * "Customer default" takes each order's own away, and after Send says one result per order (a refused order named only because the
 * API named it to this reader; the rest counted). Lists say Me / Someone else / Not set; a name only inside one record (worker privacy).
 */

/** The catalogue of these words (`messages/<locale>/production-supervisor.json`). */
export const SUPERVISOR_NS = 'production-supervisor'

/** The most orders one "Assign supervisor…" sets (the API's ORDER_SUPERVISOR_MAX; a test keeps them equal). */
export const ASSIGN_MAX = 100

/** A list row's supervisor for the reader (the API's SUPERVISOR_MARKS). */
export { SUPERVISOR_MARKS, type SupervisorMark } from '@nexus/factory-domain/production-brand/supervisor'
import type { SupervisorMark } from '@nexus/factory-domain/production-brand/supervisor'

/** The words key of a list row's mark (null: a work order of no customer — no supervisor at all). */
export const markKeyOf = (mark: SupervisorMark | null | undefined): string | null => (mark ? `mark.${mark}` : null)

/** An order the dialog sets: its number and PO, its customer, its company (the pick list is read per customer and company). */
export interface SupervisorTarget {
  readonly orderId: string
  readonly number: string
  readonly customerRef: string | null
  readonly partyId: string
  /** The customer's name (with parties.view) or its code. */
  readonly partyName: string
  readonly companyId: string
}

/** What a selection of work orders sets: their orders (each once), and the work orders left out because they have no one customer. */
export interface Targets {
  readonly targets: readonly SupervisorTarget[]
  /** Work orders of no customer, or made before the one-customer rule with several: not set here (counted, said in words). */
  readonly leftOut: number
}

interface RowLike {
  readonly companyId: string
  readonly orders: readonly { readonly id: string; readonly number: string; readonly customerRef?: string | null }[]
  readonly customer?: { readonly id: string; readonly code: string; readonly name: string } | null
}

/** The orders of a Work orders selection (a work order's orders are its one customer's: B-PR-03), each order once, in the list's order. */
export function targetsOfRows(rows: readonly RowLike[], names: boolean): Targets {
  const seen = new Set<string>()
  const targets: SupervisorTarget[] = []
  let leftOut = 0
  for (const row of rows) {
    const customer = row.customer ?? null
    if (!customer || row.orders.length === 0) {
      leftOut++
      continue
    }
    for (const order of row.orders) {
      if (seen.has(order.id)) continue
      seen.add(order.id)
      targets.push({ orderId: order.id, number: order.number, customerRef: order.customerRef ?? null, partyId: customer.id, partyName: names ? customer.name : customer.code, companyId: row.companyId })
    }
  }
  return { targets, leftOut }
}

interface RecordLike {
  readonly companyId: string
  readonly orders: readonly { readonly id: string; readonly number: string; readonly customerRef: string | null; readonly partyId: string; readonly partyName: string }[]
}

/** The orders of one work order (the band's Change…), each once. */
export function targetsOfRecord(record: RecordLike): SupervisorTarget[] {
  const seen = new Set<string>()
  return record.orders.flatMap((order) => {
    if (seen.has(order.id)) return []
    seen.add(order.id)
    return [{ orderId: order.id, number: order.number, customerRef: order.customerRef, partyId: order.partyId, partyName: order.partyName, companyId: record.companyId }]
  })
}

/** The customers and companies whose pick lists the dialog reads (each once). */
export function scopesOf(targets: readonly SupervisorTarget[]): readonly { readonly partyId: string; readonly companyId: string }[] {
  const seen = new Map<string, { partyId: string; companyId: string }>()
  for (const target of targets) seen.set(`${target.partyId}|${target.companyId}`, { partyId: target.partyId, companyId: target.companyId })
  return [...seen.values()]
}

/** The customers of the selection (the dialog says "2 customers"; their names only as the reader may see them). */
export const customersOf = (targets: readonly SupervisorTarget[]): readonly string[] => [...new Set(targets.map((target) => target.partyName))]

export interface Person {
  readonly id: string
  readonly name: string
  readonly me: boolean
}

/** The people who may take it on EVERY customer and company of the selection: the lists crossed, the reader first, then by name. */
export function commonPeople(lists: readonly SupervisorPickList[]): { readonly people: readonly Person[]; readonly complete: boolean } {
  if (lists.length === 0) return { people: [], complete: true }
  const [first, ...rest] = lists
  const people = first!.people.filter((person) => rest.every((list) => list.people.some((other) => other.id === person.id)))
  const sorted = [...people].sort((a, b) => Number(b.me) - Number(a.me) || a.name.localeCompare(b.name))
  return { people: sorted, complete: lists.every((list) => list.complete) }
}

/** The answer's "why", said from its code: the API's sentences (assign.ts, factory-domain words, eligible.ts) are its logs' English. */
/** The sentences only the API's own files hold (assign.ts, eligible.ts): a test finds each one there. */
export const API_SKIP_SENTENCES = Object.freeze({
  noRight: "Your role does not set this order's production supervisor.",
  noState: 'This order has no production state yet: it is made when the order is confirmed. Try again in a moment.',
  NO_THREAD: "This person cannot read this customer's order threads: a supervisor follows them and answers there.",
})

const SKIP_WORDS: Readonly<Record<string, string>> = Object.freeze({
  [API_SKIP_SENTENCES.noRight]: 'skip.noRight',
  [NOT_IN_PRODUCTION_WORDS.en]: 'skip.notInProduction',
  [API_SKIP_SENTENCES.noState]: 'skip.noState',
  ...Object.fromEntries(Object.entries(SUPERVISOR_REFUSAL_WORDS).map(([code, words]) => [words.en, `skip.${code}`])),
  [API_SKIP_SENTENCES.NO_THREAD]: 'skip.NO_THREAD',
})

export const skipKeyOf = (why: string): string => SKIP_WORDS[why] ?? 'skip.other'

export type ResultLine = { readonly orderId: string; readonly number: string } & ({ readonly state: 'changed' } | { readonly state: 'unchanged' } | { readonly state: 'skipped'; readonly key: string })

export interface AssignResult {
  /** The person the orders follow now (null: back to their customer's default). */
  readonly supervisor: { readonly name: string; readonly active: boolean } | null
  /** One line per order the API named to this reader, in the dialog's order. */
  readonly lines: readonly ResultLine[]
  /** Orders the API did not name to this reader: counted, never named (PW-12, PW-14). */
  readonly unknown: number
}

/** The answer as one line per order, in the order the dialog named them (an order the answer does not name is only counted). */
export function resultOf(answer: OrderSupervisorsAnswer, targets: readonly SupervisorTarget[]): AssignResult {
  const changed = new Set(answer.changed.map((order) => order.orderId))
  const unchanged = new Set(answer.unchanged.map((order) => order.orderId))
  const skipped = new Map(answer.skipped.map((order) => [order.orderId, order.why]))
  const lines: ResultLine[] = []
  let missing = 0
  for (const target of targets) {
    if (changed.has(target.orderId)) lines.push({ orderId: target.orderId, number: target.number, state: 'changed' })
    else if (unchanged.has(target.orderId)) lines.push({ orderId: target.orderId, number: target.number, state: 'unchanged' })
    else if (skipped.has(target.orderId)) lines.push({ orderId: target.orderId, number: target.number, state: 'skipped', key: skipKeyOf(skipped.get(target.orderId)!) })
    else missing++
  }
  return { supervisor: answer.supervisor ? { name: answer.supervisor.name, active: answer.supervisor.active } : null, lines, unknown: Math.max(answer.unknown, missing) }
}

/** A refused Send, in words: the person refused (400: the first refusal of the person, from its code), none of the orders seen, else. */
export function assignProblemOf(error: unknown): string {
  if (!isApiError(error)) return 'problem.failed'
  if (error.kind === 'invalid') {
    const said = error.issues.map((issue) => skipKeyOf(issue.message ?? '')).find((key) => key !== 'skip.other')
    return said ?? 'problem.invalid'
  }
  if (error.kind === 'not_found') return 'problem.notFound'
  if (error.kind === 'forbidden') return 'problem.forbidden'
  if (error.kind === 'unavailable') return 'problem.offline'
  return 'problem.failed'
}

/** Why "Assign supervisor…" / Change… is held (a words key of this catalogue), or null. */
export function assignHeld(can: { readonly manage: boolean }, targets: Targets): { readonly key: string; readonly params?: Readonly<Record<string, number>> } | null {
  if (!can.manage) return { key: 'held.noRight' }
  if (targets.targets.length === 0) return { key: targets.leftOut > 0 ? 'held.noCustomerOrder' : 'held.nothing' }
  if (targets.targets.length > ASSIGN_MAX) return { key: 'held.tooMany', params: { count: targets.targets.length, max: ASSIGN_MAX } }
  return null
}

/** The people list's state: reading, read (crossed), or refused (words key). */
export type PeopleState = { readonly status: 'loading' } | { readonly status: 'ready'; readonly people: readonly Person[]; readonly complete: boolean } | { readonly status: 'error'; readonly problem: string }

export interface AssignSupervisorModel {
  readonly targets: readonly SupervisorTarget[]
  /** Work orders left out (no one customer), said once. */
  readonly leftOut: number
  /** The band's current supervisor (one work order), for "Now: …"; null: several orders, or none set. */
  readonly current: { readonly name: string; readonly from: 'ORDER' | 'BRAND' } | null
  readonly people: PeopleState
  readonly busy: boolean
  /** A refused Send (words key of this catalogue); the choice stays. */
  readonly problem: string | null
  /** After Send: one line per order. */
  readonly result: AssignResult | null
}

export interface AssignSupervisorActions {
  /** A person, or null for "Customer default" (each order's own taken away). */
  readonly onAssign?: (supervisorId: string | null) => void
  readonly onRetry?: () => void
  readonly onClose?: () => void
}

/** The band's supervisor fact: the person and where from ("this order" / "customer default"), or "Not set"; nothing for no customer order. */
export type SupervisorFact =
  | { readonly kind: 'none' }
  | { readonly kind: 'notSet' }
  | { readonly kind: 'person'; readonly name: string; readonly active: boolean; readonly from: 'ORDER' | 'BRAND'; readonly me: boolean; readonly muted: boolean }

interface RecordFacts {
  readonly orders: readonly unknown[]
  readonly partyId?: string | null
  readonly supervisor?: { readonly name: string; readonly active: boolean; readonly from: 'ORDER' | 'BRAND'; readonly me: boolean } | null
  readonly youMuted?: boolean | null
}

/**
 * The work order's supervisor as the band says it: none for a work order of no customer order (no supervisor exists then), or an
 * older answer without the field; "Not set"; the person with "this order" or "customer default", "no longer active", and — only to
 * the supervisor himself — "You muted this order" when he muted its thread (a muted follow stays muted).
 */
export function supervisorFactOf(record: RecordFacts): SupervisorFact {
  if (record.orders.length === 0 || !record.partyId || record.supervisor === undefined) return { kind: 'none' }
  if (record.supervisor === null) return { kind: 'notSet' }
  return { kind: 'person', name: record.supervisor.name, active: record.supervisor.active, from: record.supervisor.from, me: record.supervisor.me, muted: record.supervisor.me && record.youMuted === true }
}
