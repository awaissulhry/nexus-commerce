import type { Translate } from '../../../../../lib/i18n/messages'
import { rightRef } from '../../../../../lib/i18n/rights' // F-OO-133: the right that choosing who answers needs, in words
import type { People } from './api'
import type { ProductionState } from './model'

/**
 * F-OO-100 (order overview lane: one file per section) — People, its rules moved out of model.ts unchanged (F-SA-233: places
 * only, never an operator; Statuto art. 4).
 */

// ---- F-OO-134 (order overview lane; 10-design §3.2; B-OO-008): Where it is made — one line per place, plant or outside told apart ----
/** One line of "Where it is made": a plant's site › line · team in words, or an outside workshop and the day its job went out. */
export type PlaceLine =
  | { readonly kind: 'PLANT'; readonly words: string }
  | { readonly kind: 'WORKSHOP'; readonly name: string; readonly since: string | null }

/**
 * Where the order is made, one line per place — places only, never an operator (Statuto art. 4; F-SA-233). A plant line reads
 * "Seed plant A1 › Line 2 · Team Blu" (each part by its name, else its code; a part not planned is left out); an outside workshop
 * keeps its name and the day its first job still out there was issued (B-OO-008's `since`). The kind is the API's (B-OO-008: only the
 * LIVE work orders name a place); an older answer without it: a place with a workshop is outside. Derived from the plan, never set
 * here. None: [] (the card says "Not planned yet").
 */
export function placeLinesOf(places: People['places']): PlaceLine[] {
  return places.map((place): PlaceLine => {
    const outside = place.kind ? place.kind === 'WORKSHOP' : !!place.workshop
    if (outside) return { kind: 'WORKSHOP', name: place.workshop?.name ?? '', since: place.since ?? null }
    const part = (value: { readonly code: string; readonly name: string } | null) => (value ? value.name || value.code : null)
    const site = part(place.site)
    const rest = [part(place.line), part(place.team)].filter((words): words is string => !!words).join(' · ')
    return { kind: 'PLANT', words: site && rest ? `${site} › ${rest}` : (site ?? rest) }
  })
}

/** A place line in words: the plant's as it is; outside "Outside: {name} · since {date}" (no day known: "Outside: {name}"). */
export function placeLineWords(line: PlaceLine, t: Translate, day: (value: string) => string): string {
  if (line.kind === 'PLANT') return line.words
  return line.since ? t('people.outsideSince', { name: line.name, date: day(line.since) }) : t('people.outside', { name: line.name })
}

/** The work orders that name no place (B-OO-008: production-read's NO_PLACE_WORK_ORDERS) — Planning's board is not opened at one. */
const NO_PLACE_STATUSES: readonly string[] = ['CANCELLED', 'CLOSED']

/**
 * "Open in Planning ›" (planning.view): the planning board at the order's first live work order — where the line, the workshop and
 * the start are planned (they are Planning's, never set here). No live work order, or a final order: no link (the band's ⋯ rule).
 */
export function planningWorkOrderOf(workOrders: readonly { readonly id: string; readonly status: string }[], may: { readonly plan: boolean; readonly final: boolean }): string | null {
  if (!may.plan || may.final) return null
  return workOrders.find((workOrder) => !NO_PLACE_STATUSES.includes(workOrder.status))?.id ?? null
}
// ---- end F-OO-134

// ---- F-OO-131 (order overview lane; 10-design §3): People as one aligned list — what the card draws from the read --------------
/**
 * The People card's state: still read; the read failed (only this card says so, with Try again — never an empty card); the people
 * part withheld (no workorders.view: the card's one sentence and its Followers head); or read. The API sends `people: null` only for
 * a part it did not keep for this reader (production-read.ts), so null is said as withheld too — never "Not set" for a fact not read.
 */
export type PeopleView =
  | { readonly status: 'loading' }
  | { readonly status: 'failed'; readonly problem: string }
  | { readonly status: 'withheld' }
  | { readonly status: 'ready'; readonly people: People }

export function peopleViewOf(state: ProductionState | null | undefined): PeopleView {
  if (!state || state.status === 'loading') return { status: 'loading' }
  if (state.status === 'failed') return { status: 'failed', problem: state.problem }
  const people = state.read.people ?? null
  if (!people || state.read.withheld.includes('people')) return { status: 'withheld' }
  return { status: 'ready', people }
}
// ---- end F-OO-131

// ---- F-OO-133 (order overview lane; 10-design §3.2, review F1; B-OO-008): Answers the customer — who, and why -------------------------
/** The thread head's catalogue: "Answers the customer" says who and why in the head's own words (one wording for one fact). */
export const OWNER_WORDS_NS = 'record-thread-head'

/**
 * Who answers the customer, in words: the person the conversation's owner chain names (B-OO-008: chosen on the thread, else the
 * order's supervisor, else who made the order) and why, in the thread head's words (`owner.source.*`; an older answer without its
 * source: the name alone). An inactive person stays named, marked inactive (`owner.inactive`). Nobody (a portal-made order without a
 * supervisor): the head's own "No owner yet" — never "—".
 */
export function answererWordsOf(person: People['answersCustomer'], head: Translate): string {
  if (!person) return head('owner.nobody')
  const name = person.active ? person.name : head('owner.inactive', { name: person.name })
  return person.source ? `${name} · ${head(`owner.source.${person.source}`)}` : name
}

/** What holds "Answers the customer · Change…", in its catalogue's words; null: nothing holds it. */
export type AnswerHeld =
  | { readonly ns: 'orders'; readonly key: 'waiting.noThread' }
  | { readonly ns: typeof OWNER_WORDS_NS; readonly key: 'held.noRight'; readonly params: { readonly right: string } }

/**
 * Change… opens the conversation's owner dialog (the frame's owner door), so it is held where that door cannot save, never hidden:
 * the page shows this person no conversation ("The conversation is not on this page"), or the person may not write in it — choosing
 * who answers needs threads.post (the API refuses it, platform/threads/owner.ts), said in the dock's own words for the same door
 * (record-thread-head `held.noRight` with the right). `mayWrite` null: the page did not say (a design case) — nothing held.
 */
export function answerHeldOf(input: { readonly thread: boolean; readonly mayWrite: boolean | null }): AnswerHeld | null {
  if (!input.thread) return { ns: 'orders', key: 'waiting.noThread' }
  if (input.mayWrite === false) return { ns: OWNER_WORDS_NS, key: 'held.noRight', params: { right: rightRef('threads.post') } }
  return null
}
// ---- end F-OO-133
