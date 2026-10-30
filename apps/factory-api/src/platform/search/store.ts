import { newId } from '@nexus/factory-domain/core/ids'
import { searchTextOf } from '@nexus/factory-domain/search/text'
import type { CommandTx } from '../../core/command'
import type { SearchDocument, SearchIndexer } from './indexer'

/**
 * The index's writes (SearchEntry, search.prisma; B-W2a-32), always inside a command of the tenant's system (the
 * worker's handlers, the rebuild): one entry per record, upserted on (record type, record id), rewritten only when
 * something it shows or searches changed — so a replayed event or a second rebuild writes nothing new, not even its
 * time. An entry whose record is gone (or no longer searchable) is deleted.
 */

export interface WriteCount {
  written: number
  unchanged: number
  removed: number
}

export const noWrites = (): WriteCount => ({ written: 0, unchanged: 0, removed: 0 })
export const addWrites = (into: WriteCount, more: WriteCount): WriteCount => {
  into.written += more.written
  into.unchanged += more.unchanged
  into.removed += more.removed
  return into
}

const clean = (value: string | null | undefined): string | null => {
  const text = value?.replace(/\s+/g, ' ').trim()
  return text ? text : null
}

/** The row an indexer's document becomes (what the entry stores). */
export function entryOf(indexer: SearchIndexer, document: SearchDocument) {
  const number = clean(document.number)
  const title = clean(document.title) ?? number ?? indexer.recordType
  const subtitle = clean(document.subtitle)
  return {
    companyId: document.companyId,
    siteId: document.siteId,
    partyId: document.partyId,
    number,
    title,
    subtitle,
    status: clean(document.status),
    area: document.area ?? indexer.area,
    viewPermission: indexer.viewPermission as string,
    searchText: searchTextOf({ number, title, subtitle, words: document.words ?? [] }),
  }
}
type EntryRow = ReturnType<typeof entryOf>
const FIELDS = ['companyId', 'siteId', 'partyId', 'number', 'title', 'subtitle', 'status', 'area', 'viewPermission', 'searchText'] as const satisfies readonly (keyof EntryRow)[]

/** Upserts the documents' entries; an entry that would not change is left as it is. */
export async function writeDocuments(tx: CommandTx, indexer: SearchIndexer, documents: readonly SearchDocument[], now: Date): Promise<WriteCount> {
  const count = noWrites()
  if (documents.length === 0) return count
  const existing = await tx.searchEntry.findMany({
    where: { recordType: indexer.recordType, recordId: { in: documents.map((document) => document.recordId) } },
    select: { id: true, recordId: true, companyId: true, siteId: true, partyId: true, number: true, title: true, subtitle: true, status: true, area: true, viewPermission: true, searchText: true },
  })
  const byRecord = new Map(existing.map((row) => [row.recordId, row]))
  for (const document of documents) {
    const row = entryOf(indexer, document)
    const before = byRecord.get(document.recordId)
    if (before && FIELDS.every((field) => before[field] === row[field])) {
      count.unchanged++
      continue
    }
    if (before) await tx.searchEntry.update({ where: { id: before.id }, data: { ...row, indexedAt: now } })
    else await tx.searchEntry.create({ data: { id: newId(), recordType: indexer.recordType, recordId: document.recordId, ...row, indexedAt: now } })
    count.written++
  }
  return count
}

/** Deletes the entries of these records of one type (records that are gone or no longer searchable). */
export async function removeEntries(tx: CommandTx, recordType: string, recordIds: readonly string[]): Promise<number> {
  if (recordIds.length === 0) return 0
  const { count } = await tx.searchEntry.deleteMany({ where: { recordType, recordId: { in: [...recordIds] } } })
  return count
}

/**
 * The rebuild's sweep of one page: deletes the entries of `recordType` whose record id lies after `after` and up to
 * `through` (or past `after` with no end, on the last page) but was not read on that page — their records are gone.
 */
export async function removeUnread(tx: CommandTx, recordType: string, range: { after: string | null; through: string | null }, read: readonly string[]): Promise<number> {
  const bounds = { ...(range.after ? { gt: range.after } : {}), ...(range.through ? { lte: range.through } : {}) }
  const { count } = await tx.searchEntry.deleteMany({
    where: { recordType, ...(Object.keys(bounds).length > 0 ? { recordId: bounds } : {}), ...(read.length > 0 ? { NOT: { recordId: { in: [...read] } } } : {}) },
  })
  return count
}
