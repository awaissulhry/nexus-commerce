import type { MentionPerson } from './model'

/**
 * Mention tags (B-TH-208, agreed with the production-page lane's T7): a module may give the people of a record type a small
 * label ("Supervisor") that MentionInput shows beside the name and lists first. The thread never imports that module: the
 * module registers its source here, once, when it loads —
 *
 *   registerMentionTagSource('WorkOrder', (people, record) => ({ [supervisorId]: 'Supervisor' }))
 *
 * — and the container passes its people through `withMentionTags` before drawing MentionInput. A tag the API sends on the
 * person itself (GET /threads/<type>/<id>/people, when the back end adds it) wins over a source's. Without any source or
 * tag, MentionInput works exactly as before. A source must be pure and fast (it runs on every draw of the people list).
 */

export type MentionTagSource = (people: readonly Pick<MentionPerson, 'id' | 'name'>[], record: { readonly type: string; readonly id: string }) => Readonly<Record<string, string>>

const SOURCES = new Map<string, MentionTagSource[]>()

/** Registers a tag source for a record type; returns the call that removes it again (tests, hot reload). */
export function registerMentionTagSource(recordType: string, source: MentionTagSource): () => void {
  SOURCES.set(recordType, [...(SOURCES.get(recordType) ?? []), source])
  return () => {
    const left = (SOURCES.get(recordType) ?? []).filter((one) => one !== source)
    if (left.length > 0) SOURCES.set(recordType, left)
    else SOURCES.delete(recordType)
  }
}

/** The people with their tags: the API's own tag first, else the first source that names them; a failing source is skipped. */
export function withMentionTags(record: { readonly type: string; readonly id: string }, people: readonly MentionPerson[]): MentionPerson[] {
  const sources = SOURCES.get(record.type) ?? []
  if (sources.length === 0) return [...people]
  const tags: Record<string, string> = {}
  for (const source of sources) {
    let given: Readonly<Record<string, string>> = {}
    try {
      given = source(people, record)
    } catch {
      continue
    }
    for (const [personId, tag] of Object.entries(given)) if (!(personId in tags) && typeof tag === 'string' && tag.trim() !== '') tags[personId] = tag.trim()
  }
  return people.map((person) => (person.tag || !tags[person.id] ? person : { ...person, tag: tags[person.id]! }))
}
