import type { FactoryClient } from '@nexus/factory-db'
import type { CommandTx } from '../../core/command'

/**
 * T7 (production lane agreement 2026-11-17; threads plan B-TH-208, MentionInput "tagged people first"): a module may give some
 * people of a record a small tag in the @ list of a note — the production page's "Supervisor" on a sales order and a work order.
 * The thread never imports that module: the module registers its tagger here, once, when it loads (its routes file):
 *
 *   registerPeopleTagger('SalesOrder', 'production.supervisor', async (client, record) => new Map([[userId, { it, en }]]))
 *
 * GET /threads/<type>/<id>/people (threads.ts mentionablePeople) then carries `tag` on each tagged person (none on the
 * others) and lists the tagged people first, each group in the list's own order (by name). A tag only marks a person the list
 * already holds (a reader of the record): it never adds one, so it tells nothing beyond the record the writer reads. The words
 * are the reader's language (User.locale; Italian by default). A tagger that fails is skipped: the list always answers.
 * Office only, as the list.
 */

type Reader = FactoryClient | CommandTx

/** A tag's words (factory-domain keeps them in both languages). */
export interface TagWords {
  readonly it: string
  readonly en: string
}

/** The people a record's tagger marks: user id → the tag's words. */
export type PeopleTagger = (client: Reader, record: { readonly type: string; readonly id: string }) => Promise<ReadonlyMap<string, TagWords>>

/** The registered taggers per record type, in registration order, each by its name (registering a name again replaces it). */
const TAGGERS = new Map<string, { readonly name: string; readonly tag: PeopleTagger }[]>()

/** Registers a module's tagger for a record type (idempotent by name); answers the call that removes it again (tests). */
export function registerPeopleTagger(recordType: string, name: string, tag: PeopleTagger): () => void {
  TAGGERS.set(recordType, [...(TAGGERS.get(recordType) ?? []).filter((entry) => entry.name !== name), { name, tag }])
  return () => {
    const left = (TAGGERS.get(recordType) ?? []).filter((entry) => entry.name !== name || entry.tag !== tag)
    if (left.length > 0) TAGGERS.set(recordType, left)
    else TAGGERS.delete(recordType)
  }
}

/** The reader's language of a tag: English for an English locale, else Italian (the company's). */
export const tagLanguageOf = (locale: string | null | undefined): 'it' | 'en' => (locale?.toLowerCase().startsWith('en') ? 'en' : 'it')

/** Every tag of a record's people: the first tagger that names a person wins; a failing tagger is skipped. */
export async function peopleTagsOf(client: Reader, record: { readonly type: string; readonly id: string }): Promise<Map<string, TagWords>> {
  const out = new Map<string, TagWords>()
  for (const entry of TAGGERS.get(record.type) ?? []) {
    let found: ReadonlyMap<string, TagWords>
    try {
      found = await entry.tag(client, record)
    } catch {
      continue
    }
    for (const [userId, words] of found) if (!out.has(userId) && words.it.trim() !== '' && words.en.trim() !== '') out.set(userId, words)
  }
  return out
}

/** A person of the @ list (threads.ts mentionablePeople), with the tag when one is given. */
export interface TaggedPerson {
  readonly id: string
  readonly name: string
  readonly tag?: string
}

/** The list with its tags (a person without one carries none), the tagged people first, each group in the list's own order. Pure. */
export function taggedFirst(people: readonly { readonly id: string; readonly name: string }[], tags: ReadonlyMap<string, TagWords>, language: 'it' | 'en'): TaggedPerson[] {
  const tagged: TaggedPerson[] = []
  const others: TaggedPerson[] = []
  for (const person of people) {
    const words = tags.get(person.id)
    if (words) tagged.push({ id: person.id, name: person.name, tag: words[language] })
    else others.push({ id: person.id, name: person.name })
  }
  return [...tagged, ...others]
}
