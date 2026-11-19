/**
 * B-CP-078 (customer page plan C7, D12; 12 §5; review C4, F7; lead pick: no step-up — a name, no money, no access): the factory
 * designer of a customer — the ONE office person (and a backup) its portal people may ask in a thread ("Ask Giulia Verdi, factory
 * designer"; B-CP-079). Pure: apps/factory-api's platform/auth/partners/designer.ts applies these rules; the database holds the
 * slot's shape too (factory_portal_settings_guard: both-or-neither with since when, a backup only beside a designer and never the
 * same person, active office people, a customer or a brand only).
 *
 *   who      an ACTIVE office person holding threads.read AND threads.post over the customer at every company it works with (the
 *            designer reads and answers its threads); the office role "Factory designer" is an offer, not a condition (review F7)
 *   slot     a designer, maybe a backup; the backup only beside a designer, never the same person
 *   brand    sees the display name only — the designer's while active, else the backup's while active, else none; never an id, an
 *            e-mail, a role or whether two names exist (W-CP-5). The supervisor and its backup stay hidden (R-41): the brand sees the
 *            factory designer's name, nothing else of ours.
 */

/** Why a person may not be named in the slot, or why the slot is refused, at its field. */
export const DESIGNER_REFUSALS = ['NOT_OFFICE', 'NOT_ACTIVE', 'NO_REACH', 'BACKUP_ALONE', 'SAME_PERSON'] as const
export type DesignerRefusal = (typeof DESIGNER_REFUSALS)[number]

/** A named person's state as the office card shows it ("No longer reaches Brand Alpha"). */
export const DESIGNER_STATES = ['OK', 'NOT_ACTIVE', 'NO_REACH'] as const
export type DesignerState = (typeof DESIGNER_STATES)[number]

export interface Words {
  readonly it: string
  readonly en: string
}

/** The office's words ("tu"); {customer} is the customer's name (the office's own reading: it names no other customer). */
export const DESIGNER_WORDS = Object.freeze({
  NOT_OFFICE: { it: "Solo una persona dell'ufficio può essere il designer della fabbrica.", en: 'Only a person of the office can be the factory designer.' },
  NOT_ACTIVE: { it: 'Questa persona non è più attiva.', en: 'This person is no longer active.' },
  NO_REACH: { it: 'Questa persona non raggiunge {customer}: deve poter leggere e scrivere nelle sue conversazioni.', en: 'This person does not reach {customer}: they must read and write its threads.' },
  BACKUP_ALONE: { it: 'Indica prima il designer della fabbrica, poi il sostituto.', en: 'Name the factory designer before a backup.' },
  SAME_PERSON: { it: 'Il sostituto è una persona diversa dal designer della fabbrica.', en: 'The backup is another person than the factory designer.' },
  NO_LONGER_ACTIVE: { it: 'Non più attiva', en: 'No longer active' },
  NO_LONGER_REACHES: { it: 'Non raggiunge più {customer}', en: 'No longer reaches {customer}' },
  ONLY_CUSTOMERS: { it: 'Il designer della fabbrica si indica solo per un cliente o un marchio.', en: 'A factory designer is named only for a customer or a brand.' },
  NOTHING_CHANGES: { it: 'Non cambia nulla: sono già il designer e il sostituto.', en: 'Nothing changes: these are the factory designer and the backup already.' },
} satisfies Record<string, Words>)
export type DesignerWord = keyof typeof DESIGNER_WORDS

/** A word in the office's language with the customer's name in it. */
export function designerWords(word: DesignerWord, customer: string): Words {
  const words = DESIGNER_WORDS[word]
  return { it: words.it.replaceAll('{customer}', customer), en: words.en.replaceAll('{customer}', customer) }
}

/** A person as the rule reads them: their account and whether their live grants read and write the customer's threads everywhere. */
export interface DesignerCandidate {
  readonly audience: string
  readonly status: string
  /** threads.read AND threads.post over the customer at every company it works with. */
  readonly reaches: boolean
}

/** Why the person may not be newly named (empty: they may); "not office" alone says it all; null: no such person (not office). */
export function personRefusals(candidate: DesignerCandidate | null): DesignerRefusal[] {
  if (!candidate || candidate.audience !== 'OFFICE') return ['NOT_OFFICE']
  const out: DesignerRefusal[] = []
  if (candidate.status !== 'ACTIVE') out.push('NOT_ACTIVE')
  if (!candidate.reaches) out.push('NO_REACH')
  return out
}

/** The slot's own shape: a backup only beside a designer, never the same person (at the backup's field). */
export function slotRefusals(slot: { readonly designerId: string | null; readonly backupId: string | null }): DesignerRefusal[] {
  if (slot.backupId === null) return []
  if (slot.designerId === null) return ['BACKUP_ALONE']
  return slot.backupId === slot.designerId ? ['SAME_PERSON'] : []
}

/** A named person's state on the office card: still reaching the customer, or why not (a person stays named until changed). */
export function designerState(candidate: DesignerCandidate | null): DesignerState {
  if (!candidate || candidate.audience !== 'OFFICE' || candidate.status !== 'ACTIVE') return 'NOT_ACTIVE'
  return candidate.reaches ? 'OK' : 'NO_REACH'
}

/** What the brand reads: the designer's display name while active, else the backup's while active, else none (never two). */
export function portalDesignerName(slot: { readonly designer: { readonly name: string; readonly active: boolean } | null; readonly backup: { readonly name: string; readonly active: boolean } | null }): string | null {
  if (slot.designer?.active) return slot.designer.name
  if (slot.backup?.active) return slot.backup.name
  return null
}
