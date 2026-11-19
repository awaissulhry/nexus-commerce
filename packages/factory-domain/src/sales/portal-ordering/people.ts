import type { Words } from './rules'

/**
 * B-CP-075 (customer page plan C5, 12 §2 part 4 "People & sizes"; review A5, F2; lead pick: "Saved measurements" comes later): the
 * people on a by-person line of a draft order (PortalOrderRequestPerson) — a rider, a team member. Pure: apps/factory-api's
 * modules/sales/portal-ordering/people.ts reads and writes them; the …_customer_page_guards trigger holds the same shapes.
 *
 *   a person    a name (1 to 120), maybe a number (a race or shirt number, up to 10), a note (up to 1000), and ONE way to be
 *               measured: SIZE (a size of the range, 1 to 40), SHEET (a measurement sheet the customer uploaded to this draft:
 *               a MEASUREMENTS file of this request or one of its lines) or LATER (the customer sends it later)
 *   a roster    at most PEOPLE_LIMITS.perLine people on one line, each in its place (seq: rows never jump); a measurement sheet on
 *               the line stands for a roster not typed ("People: in the attached sheet", review A5)
 *
 * Personal data of the people named (GDPR art. 6(1)(b): what the order needs): the customer's own and the office's to read, the
 * floor's never; a measurement sheet stays body data (named and opened in the office only with sales.measurements.view); the
 * party's privacy export lists the roster names (platform/privacy erasure/sources/records.ts).
 */

/** How a person is measured (PortalOrderRequestPerson.measureBy). No PROFILE: "Saved measurements" comes later (review F2). */
export const MEASURE_BY = ['SIZE', 'SHEET', 'LATER'] as const
export type MeasureBy = (typeof MEASURE_BY)[number]

export const PEOPLE_LIMITS = Object.freeze({ name: 120, number: 10, size: 40, note: 1000, perLine: 500 })

export interface PersonInput {
  readonly name: string
  readonly number?: string | null | undefined
  readonly measureBy: MeasureBy
  readonly size?: string | null | undefined
  readonly measurementFileId?: string | null | undefined
  readonly note?: string | null | undefined
}

const blank = (value: string | null | undefined): boolean => value === undefined || value === null || value.trim() === ''

/** The problems of a person's own shape (before it is written), in words for 400 issues. */
export function personShapeProblems(person: PersonInput): string[] {
  const out: string[] = []
  const name = person.name.trim()
  if (name === '' || name.length > PEOPLE_LIMITS.name) out.push(`A name is 1 to ${PEOPLE_LIMITS.name} characters.`)
  if (!blank(person.number) && person.number!.trim().length > PEOPLE_LIMITS.number) out.push(`A number is at most ${PEOPLE_LIMITS.number} characters.`)
  if (!blank(person.note) && person.note!.trim().length > PEOPLE_LIMITS.note) out.push(`A note is at most ${PEOPLE_LIMITS.note} characters.`)
  if (person.measureBy === 'SIZE') {
    if (blank(person.size) || person.size!.trim().length > PEOPLE_LIMITS.size) out.push(`Give the size (1 to ${PEOPLE_LIMITS.size} characters).`)
    if (!blank(person.measurementFileId)) out.push('A person measured by a size names no measurement sheet.')
  } else if (person.measureBy === 'SHEET') {
    if (blank(person.measurementFileId)) out.push('Choose the measurement sheet of this draft that holds the measures.')
    if (!blank(person.size)) out.push('A person measured by a sheet names no size.')
  } else if (!blank(person.size) || !blank(person.measurementFileId)) {
    out.push('A person whose measures come later names no size and no sheet.')
  }
  return out
}

/** The person as it is written: trimmed, blanks as null, only the field of its way of being measured. */
export function personRow(person: PersonInput): { name: string; number: string | null; measureBy: MeasureBy; size: string | null; measurementFileId: string | null; note: string | null } {
  return {
    name: person.name.trim(),
    number: blank(person.number) ? null : person.number!.trim(),
    measureBy: person.measureBy,
    size: person.measureBy === 'SIZE' && !blank(person.size) ? person.size!.trim() : null,
    measurementFileId: person.measureBy === 'SHEET' && !blank(person.measurementFileId) ? person.measurementFileId! : null,
    note: blank(person.note) ? null : person.note!.trim(),
  }
}

/** The ways of being measured in the customer's words (the draft page's `draftPage.measure.*` say the same). */
export const MEASURE_BY_WORDS: Readonly<Record<MeasureBy, Words>> = Object.freeze({
  SIZE: { it: 'Taglia', en: 'Size' },
  SHEET: { it: 'Scheda misure', en: 'Measurement sheet' },
  LATER: { it: 'Le mandiamo dopo', en: 'Sending later' },
})

/** A by-person line whose people are in the measurement sheet on it (no roster typed). */
export const PEOPLE_IN_SHEET: Words = Object.freeze({ it: 'Persone: nella scheda allegata', en: 'People: in the attached sheet' })

/** The refusals of a roster write, in the portal's words ("voi"): never naming another customer. */
export const PEOPLE_WORDS = Object.freeze({
  NOT_BY_PERSON: { it: 'Questa riga non è per persona: le sue quantità sono nelle taglie o nel totale.', en: 'This line is not by person: its pieces are in its sizes or its total.' },
  TOO_MANY: { it: `Al massimo ${PEOPLE_LIMITS.perLine} persone su una riga: allegate una scheda misure per le altre.`, en: `At most ${PEOPLE_LIMITS.perLine} people on a line: attach a measurement sheet for the others.` },
  NOT_A_SHEET: { it: 'Scegliete una scheda misure caricata su questa bozza.', en: 'Choose a measurement sheet uploaded to this draft.' },
} satisfies Record<string, Words>)
