import type { Words } from './rules'

/**
 * The ONE lines table's line moves and facts (owb- order workflow, S1 po1.3 + po1.1; design order-workflow § 5zi B "Copy · take
 * away: a line can be copied. A line that is taken away can come back: Put it back"; the build's word table: "A thing leaves a list
 * and stays in the history: Take out"). Pure.
 *
 *   copy        a line of a draft is copied whole (its model, material, sizes, choices, note, own column values; never its people,
 *               files or a reorder's source), at the end of the draft
 *   take out    a soft remove (`removedAt`): its sizes, choices, people, files and own values stay; it counts nowhere until it is put
 *               back (the record lists it in `removedLines`, a draft's only)
 *   put back    the line comes back where it was (its place is kept), as it was
 *
 * Material (the S1 lead's settle 4: no new column): the line's existing open choice whose topic is a material ("Material",
 * "Leather", … — the web writes MATERIAL_TOPIC), its pick; else the catalogue colourway's name; else none.
 * The model of a line (the sheet's C row, the ONE table's Model cell): OWN (the customer's own label), RANGE (the factory's
 * collection), NEW (a new design: a garment type), TEXT ("as in my message": the customer's words only).
 */

export const LINE_MOVE_WORDS = Object.freeze({
  NOT_TAKEN_OUT: { en: 'This line is on the order: there is nothing to put back.', it: 'Questa riga è sull’ordine: non c’è niente da rimettere.' },
  TOO_MANY: (max: number): Words => ({ en: `At most ${max} lines per order: take one out first.`, it: `Al massimo ${max} righe per ordine: togliete prima una riga.` }),
})

/** The topic the web writes for a line's material (the od- lane's choices: names only, never a price). */
export const MATERIAL_TOPIC = 'Material'

/** Topics read as the material of a line, whatever the case (English and Italian). */
const MATERIAL_TOPICS: readonly string[] = ['material', 'materiale', 'leather', 'pelle', 'fabric', 'tessuto']

export const isMaterialTopic = (topic: string): boolean => MATERIAL_TOPICS.includes(topic.trim().toLocaleLowerCase('en'))

export interface MaterialFacts {
  /** The line's open choices (names only); null: none. */
  readonly choices: readonly { readonly topic: string; readonly picked: string | null }[] | null
  /** The catalogue colourway's name (a catalogue line, or a custom line that names one); null: none. */
  readonly colourwayName: string | null
}

/** The line's material in words (settle 4), or null. */
export function materialOf(facts: MaterialFacts): string | null {
  const chosen = (facts.choices ?? []).find((choice) => isMaterialTopic(choice.topic) && choice.picked !== null && choice.picked.trim() !== '')
  if (chosen) return chosen.picked!.trim()
  const colourway = facts.colourwayName?.trim() ?? ''
  return colourway === '' ? null : colourway
}

export const LINE_MODEL_KINDS = ['OWN', 'RANGE', 'NEW', 'TEXT'] as const
export type LineModelKind = (typeof LINE_MODEL_KINDS)[number]

export interface LineModel {
  readonly kind: LineModelKind
  /** The style's code and name, else the customer's words (a described line), else null. */
  readonly words: string | null
  /** A new design's garment type (a measurement template's code), else null. */
  readonly garmentType: string | null
}

export interface LineModelFacts {
  /** The style the line names (null: none). */
  readonly styleId: string | null
  /** That style's brand (its customer's own label) — null: the factory's own collection. Read only when the style is named. */
  readonly styleBrandPartyId: string | null
  /** The style's code and name ("SEED-JKT-02 Racing jacket"), when named and readable. */
  readonly styleWords: string | null
  readonly description: string | null
  readonly garmentType: string | null
}

const text = (value: string | null): string | null => (value === null || value.trim() === '' ? null : value.trim())

/** The model of a line for the customer `partyId` (see the file's head). */
export function lineModelOf(facts: LineModelFacts, partyId: string): LineModel {
  const garmentType = text(facts.garmentType)
  if (facts.styleId !== null) return { kind: facts.styleBrandPartyId === partyId ? 'OWN' : 'RANGE', words: text(facts.styleWords) ?? text(facts.description), garmentType }
  if (garmentType !== null) return { kind: 'NEW', words: text(facts.description), garmentType }
  return { kind: 'TEXT', words: text(facts.description), garmentType: null }
}

/** A line's sizes in words: "50 × 2 · 52 × 3" (in the order given); none: null. */
export function sizesText(sizes: readonly { readonly size: string | null; readonly quantity: number }[]): string | null {
  const shown = sizes.filter((row) => row.quantity > 0).map((row) => (row.size === null || row.size.trim() === '' ? `${row.quantity}` : `${row.size.trim()} × ${row.quantity}`))
  return shown.length === 0 ? null : shown.join(' · ')
}

/** What a line taken out is called on the "Put it back" row: its style, else its words, else its garment type, else its place. */
export function removedLineWords(facts: { readonly seq: number; readonly styleWords: string | null; readonly description: string | null; readonly garmentType: string | null }): string {
  return text(facts.styleWords) ?? text(facts.description) ?? text(facts.garmentType) ?? `#${facts.seq}`
}
