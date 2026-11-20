import type { Translate } from '../../../../../lib/i18n/messages'
import { rightRef } from '../../../../../lib/i18n/rights' // F-OO-133: the right that choosing who answers needs, in words
import type { OrderProduction, People } from './api'
import type { ProductionState } from './model'

/**
 * F-OO-100 (order overview lane: one file per section) — People, its rules moved out of model.ts unchanged (F-SA-233: places
 * only, never an operator; Statuto art. 4).
 */

/** Where the order is made, as places only (a site · a line · a team by name, or an outside workshop) — never an operator. */
export function placeWords(place: NonNullable<OrderProduction['people']>['places'][number]): string {
  if (place.workshop) return place.workshop.name
  return [place.site?.name ?? place.site?.code, place.line?.name ?? place.line?.code, place.team?.name ?? place.team?.code].filter((part): part is string => !!part).join(' · ')
}

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
