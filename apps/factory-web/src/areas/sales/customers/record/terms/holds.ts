import type { HoldReason } from '../../depth/api'
import type { Read } from '../../depth/model'
import { holdAnchor, kitProblemOf, said, text, waitAnchor, type Said, type TermsCan } from './model'

/**
 * F-CT-103 (customer page › TERMS & REQUIREMENTS tab, lane ct-; 10-design §5.1; 18-lead-settles Z6, Z10, Z22, Z27, Z31) — section 1,
 * Hold (#party-hold), pure: ALWAYS first; one quiet line when no hold is in force ("Not on hold: new orders and shipments go ahead" +
 * "Released before (n) ›"); the whole section while one is: what stops (and what goes on), each hold with its reason, company, words,
 * since when and by whom, its Release… and — for missing data while no tax identity exists — its cause as a door; the accepted quotes
 * that wait for the release, each with its reason (S4), or their count and the door to Quotes › Order waits while the server does not
 * say why yet (Z6). Put on hold… is in the head only while nothing is in force (Z22); then "Put on hold for another reason…" is in its ⋯.
 * Every act is HIDDEN without its right (the server's `mayPlace` / `mayRelease` first, the session's right as fallback) and held with
 * words only by state (an archived customer). The windows are the depth provider's own (HoldDialogView, the one Money opens).
 */

/** A hold as the holds read gives it (R7; `mayRelease` from S3 — absent before ct-s). */
export interface HoldFacts {
  readonly id: string
  readonly companyId: string | null
  readonly company: { readonly code: string; readonly name: string } | null
  readonly reason: HoldReason
  readonly words: string
  readonly inForce: boolean
  readonly placedAt: string
  readonly placedBy: string | null
  readonly releasedAt: string | null
  readonly releasedBy: string | null
  readonly releaseWords: string | null
  readonly version: number
  readonly mayRelease?: boolean | undefined
}

/** Why an accepted quote has no order yet (S4: `orderWaitFor`'s order — the hold first, then a missing PO number). */
export type WaitsFor = 'ACCOUNT_ON_HOLD' | 'PO_NUMBER_REQUIRED' | null

export interface WaitingFacts {
  readonly quoteId: string
  readonly number: string
  readonly revision: number
  readonly quoteVersionId: string
  readonly companyId: string
  readonly customerRef: string | null
  /** S4; absent before ct-s (then nobody can say why it waits). */
  readonly waitsFor?: WaitsFor | undefined
}

export interface HoldsFacts {
  readonly onHold: boolean
  readonly holds: readonly HoldFacts[]
  /** S4: left out for a reader without quotes.view (the count stays). */
  readonly ordersWaiting: readonly WaitingFacts[]
  readonly mayPlace: boolean
  /** S4: the counts over every waiting quote; absent before ct-s. */
  readonly ordersWaitingCount?: { readonly onHold: number; readonly poNumber: number; readonly other: number } | undefined
}

/** An act's state on the tab: drawn (its right) and, by state only, held with its words. */
export interface Act {
  readonly shown: boolean
  readonly held: Said | null
}
export const HIDDEN: Act = { shown: false, held: null }

/** "Archived: reactivate it to change its terms" — the one state that holds an act of this tab (besides a check running, a credit limit). */
export const ARCHIVED_HELD: Said = said('terms.held.archived')
export const actOf = (shown: boolean, archived: boolean): Act => (shown ? { shown: true, held: archived ? ARCHIVED_HELD : null } : HIDDEN)

export interface HoldRow {
  readonly id: string
  readonly anchor: string
  readonly reason: HoldReason
  /** The company it holds; null: every company. */
  readonly company: string | null
  readonly words: string
  readonly since: string
  /** Who placed it; null: a credit check (the system). */
  readonly by: string | null
  readonly release: Act
  /** "Its cause: no tax identity ↓": missing data while no tax identity exists (P19) — a door to #party-identity. */
  readonly cause: boolean
  /** The hold as its window takes it (Release… opens HoldDialogView with it). */
  readonly hold: HoldFacts
}

export interface ReleasedRow {
  readonly id: string
  readonly reason: HoldReason
  readonly company: string | null
  readonly releasedAt: string
  readonly releasedBy: string | null
  readonly releaseWords: string | null
  readonly placedAt: string
  readonly placedBy: string | null
  readonly words: string
}

export interface WaitingRow {
  readonly id: string
  readonly anchor: string
  /** "Q-2026-0118 rev. 2" — with quotes.view only (else no row is drawn). */
  readonly quote: Said
  readonly href: string
  /** The customer's own PO reference, else null ("No PO number yet"). */
  readonly ref: string | null
  readonly company: string
  readonly waitsFor: 'HOLD' | 'PO' | 'OTHER'
}

export interface WaitingModel {
  /** The server says why each quote waits (S4 on main); false: only how many wait, with the door to Quotes › Order waits (Z6). */
  readonly byReason: boolean
  /** The quote numbers are drawn (quotes.view); else only the counts. */
  readonly rowsShown: boolean
  readonly hold: readonly WaitingRow[]
  readonly po: readonly WaitingRow[]
  /** How many wait for the hold · for a PO number · for something else (S4's counts; null without S4). */
  readonly counts: { readonly hold: number; readonly po: number; readonly other: number } | null
  /** Every accepted quote without its order (the fallback count). */
  readonly total: number
  /** Quotes › Order waits of this customer. */
  readonly door: string
}

export interface HoldSectionModel {
  /** The read is still out (the section's skeleton; the head still draws). */
  readonly reading: boolean
  /** The read failed (a kit key), else null. */
  readonly problem: string | null
  readonly answer: Said | null
  readonly inForce: readonly HoldRow[]
  readonly released: readonly ReleasedRow[]
  readonly releasedOpen: boolean
  /** The danger line while a hold is in force: who waits, and what goes on. */
  readonly stops: { readonly title: Said; readonly desc: Said } | null
  readonly waiting: WaitingModel
  /** "Waiting for the release: {n} accepted quotes have no order yet" (the count of the hold's waiting quotes; 0: no block). */
  readonly waitingForHold: number
  /** Put on hold… — in the head while nothing is in force; "Put on hold for another reason…" in the ⋯ while one is (Z22). */
  readonly place: Act
  readonly placeInHead: boolean
}

export interface HoldsInput {
  readonly read: Read<HoldsFacts> | null
  readonly can: TermsCan
  readonly archived: boolean
  /** A tax identity is in force (the cause door of a missing-data hold is drawn only without one, P19). */
  readonly hasIdentity: boolean
  readonly customer: string
  /** Our companies' names by id (the session's and the company-terms read's). */
  readonly companyNames: Readonly<Record<string, string>>
  readonly prefix: string
  readonly partyId: string
  readonly releasedOpen: boolean
}

const enc = encodeURIComponent

/** The door to Quotes › Order waits of this customer (the group that mixes every reason; L9). */
export const orderWaitsHref = (prefix: string, partyId: string): string => `${prefix}/sales/customers/${enc(partyId)}?tab=quotes&group=ORDER_WAITS`

/** The accepted quotes that wait, by reason (S4), or their count while the server does not say why. */
export function waitingOf(read: HoldsFacts | null, can: TermsCan, names: Readonly<Record<string, string>>, prefix: string, partyId: string): WaitingModel {
  const rows = read?.ordersWaiting ?? []
  const byReason = read !== null && (read.ordersWaitingCount !== undefined || rows.some((row) => row.waitsFor !== undefined))
  const rowOf = (row: WaitingFacts): WaitingRow => ({
    id: row.quoteId,
    anchor: waitAnchor(row.quoteId),
    quote: said('sales-customers-depth:hold.quoteRev', { params: { number: row.number, revision: row.revision } }),
    href: `${prefix}/sales/quotes/${enc(row.quoteId)}`,
    ref: row.customerRef,
    company: names[row.companyId] ?? '',
    waitsFor: row.waitsFor === 'ACCOUNT_ON_HOLD' ? 'HOLD' : row.waitsFor === 'PO_NUMBER_REQUIRED' ? 'PO' : 'OTHER',
  })
  // The quote numbers only with quotes.view (the server leaves the rows out without it after S4; before it, the web does).
  const drawn = can.quotes ? rows.map(rowOf) : []
  const counts = byReason
    ? (read?.ordersWaitingCount ?? {
        onHold: rows.filter((row) => row.waitsFor === 'ACCOUNT_ON_HOLD').length,
        poNumber: rows.filter((row) => row.waitsFor === 'PO_NUMBER_REQUIRED').length,
        other: rows.filter((row) => !row.waitsFor).length,
      })
    : null
  return {
    byReason,
    rowsShown: can.quotes,
    hold: byReason ? drawn.filter((row) => row.waitsFor === 'HOLD') : [],
    po: byReason ? drawn.filter((row) => row.waitsFor === 'PO') : [],
    counts: counts ? { hold: counts.onHold, po: counts.poNumber, other: counts.other } : null,
    total: counts ? counts.onHold + counts.poNumber + counts.other : rows.length,
    door: orderWaitsHref(prefix, partyId),
  }
}

/** The reason in small letters inside a sentence ("on hold since 2 Nov (credit)"). */
const reasonWords = (reason: HoldReason): Said => said(`sales-customers-depth:reason.${reason}`)

/** The Hold section's answer: one quiet line when none is in force, else since when, for whom, why. */
export function holdAnswer(inForce: readonly HoldRow[]): Said {
  if (inForce.length === 0) return said('ct.hold.none')
  if (inForce.length === 1) {
    const one = inForce[0]!
    return one.company === null
      ? said('ct.hold.answer.every', { days: { date: one.since }, lower: { reason: reasonWords(one.reason) } })
      : said('ct.hold.answer.with', { days: { date: one.since }, params: { company: one.company }, lower: { reason: reasonWords(one.reason) } })
  }
  const items = inForce.map((row) => (row.company === null ? said('ct.hold.answer.itemEvery', { lower: { reason: reasonWords(row.reason) } }) : said('ct.hold.answer.item', { params: { company: row.company }, lower: { reason: reasonWords(row.reason) } })))
  return said('ct.hold.answer.many', { params: { count: inForce.length }, saidLists: { holds: items } })
}

/** The Hold section's model (pure). */
export function holdSection(input: HoldsInput): HoldSectionModel {
  const { can, archived } = input
  const read = input.read?.status === 'ready' ? input.read.value : null
  const name = (hold: HoldFacts): string | null => (hold.companyId === null ? null : (hold.company?.name ?? input.companyNames[hold.companyId] ?? hold.company?.code ?? null))
  const inForce: HoldRow[] = (read?.holds ?? [])
    .filter((hold) => hold.inForce)
    .map((hold) => ({
      id: hold.id,
      anchor: holdAnchor(hold.id),
      reason: hold.reason,
      company: name(hold),
      words: hold.words,
      since: hold.placedAt,
      by: hold.placedBy,
      // The server's per-hold answer first (S3), the session's right as the fallback.
      release: actOf(can.hold && (hold.mayRelease ?? true), archived),
      cause: hold.reason === 'DATA_MISSING' && !input.hasIdentity,
      hold,
    }))
  const released: ReleasedRow[] = (read?.holds ?? [])
    .filter((hold) => !hold.inForce && hold.releasedAt !== null)
    .map((hold) => ({ id: hold.id, reason: hold.reason, company: name(hold), releasedAt: hold.releasedAt!, releasedBy: hold.releasedBy, releaseWords: hold.releaseWords, placedAt: hold.placedAt, placedBy: hold.placedBy, words: hold.words }))
  const every = inForce.some((row) => row.company === null)
  const companies = [...new Set(inForce.flatMap((row) => (row.company === null ? [] : [row.company])))]
  const waiting = waitingOf(read, can, input.companyNames, input.prefix, input.partyId)
  return {
    reading: input.read === null || input.read.status === 'loading',
    problem: input.read?.status === 'error' ? kitProblemOf(input.read.problem) : null,
    answer: read ? holdAnswer(inForce) : null,
    inForce,
    released,
    releasedOpen: input.releasedOpen,
    stops:
      inForce.length > 0
        ? { title: every ? said('ct.hold.stops.every', { params: { customer: input.customer } }) : said('ct.hold.stops.with', { lists: { companies } }), desc: said('ct.hold.stops.desc') }
        : null,
    waiting,
    waitingForHold: waiting.counts?.hold ?? 0,
    place: actOf(can.hold && (read?.mayPlace ?? true), archived),
    placeInHead: inForce.length === 0,
  }
}

/** A released hold's line: "Released on {date} by {name}: “{words}”" (no dangling " · ": release words are required). */
export function releasedLine(row: ReleasedRow): Said {
  const by = row.releasedBy ? text(row.releasedBy) : said('sales-customers-depth:hold.system')
  return row.releaseWords ? said('ct.hold.releasedOn', { days: { date: row.releasedAt }, words: { name: by }, params: { words: row.releaseWords } }) : said('ct.hold.releasedOnBare', { days: { date: row.releasedAt }, words: { name: by } })
}

/** Its sub-line: "Placed on {date} by {name}: “{words}”" (a credit check placed it: "by a credit check"). */
export function placedLine(row: ReleasedRow): Said {
  return row.placedBy ? said('ct.hold.placedOn', { days: { date: row.placedAt }, params: { name: row.placedBy, words: row.words } }) : said('ct.hold.placedOnCheck', { days: { date: row.placedAt }, params: { words: row.words } })
}
