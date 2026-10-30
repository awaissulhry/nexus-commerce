import { FACTORY_PERMISSIONS } from '@nexus/factory-domain/auth/permissions/catalogue'
import type { Permission } from '@nexus/factory-domain/core/permissions'
import { EVENT_CATALOGUE } from '@nexus/factory-domain/events/catalogue'
import type { EventEnvelope } from '@nexus/factory-domain/events/envelope'
import { RECORD_TYPE } from '@nexus/factory-domain/search/contracts'
import type { CommandTx } from '../../core/command'

/**
 * What a search indexer is (B-W2a-32; PLT-153): ONE file per record type in `./indexers/` (`sales-order.ts`,
 * `party.ts` …), default-exporting `defineIndexer({…})`. The folder is the registry (./indexer-files.ts finds the files
 * for the worker, the tests and the build alike): a step that makes a record type searchable adds its file and edits
 * no list.
 *
 *   recordType      the API's model name (`SalesOrder`): the entry's record type, the web's RECORD_PAGES key
 *   area            the area it opens in (`sales`): shown on the result row
 *   viewPermission  what a reader needs to see it: the permission its own list asks (`orders.view`)
 *   on              the record events that change its number, name or status → the records each names (default: the
 *                   event's subject, which is the record's id for nearly every event). A record that shows another's
 *                   name (an order shows its customer's) also follows that one's events, naming its own records
 *                   (`bySubjectIn`, at most CASCADE_MAX per event; the rebuild mends the rest)
 *   read            the documents of the records `filter` selects, read in the tenant's system scope:
 *                     - `{ ids }`  those records (an event's), any that is gone or not searchable is simply not returned;
 *                     - `{ after }` the next page in id order (the rebuild), after that id, at most `take`.
 *                   ONE document per record read, in id order, never more than `take` (the rebuild pages on it): leave a
 *                   record out in the `where`, never after reading it.
 *
 * A document's company, site and party are the record's own scope columns as its module filters its list (scopeWhere):
 * a column the module does not scope by stays null (null reaches every grant). Its words are codes and references people
 * type. NEVER money (no amount, price, cost or margin) and NEVER a worker's name (Statuto dei Lavoratori art. 4):
 * factory-domain `searchTextOf` refuses an amount with its currency as a last guard.
 */

export interface SearchDocument {
  readonly recordId: string
  readonly companyId: string | null
  readonly siteId: string | null
  readonly partyId: string | null
  /** Its number or code as people type it; null when it has none. */
  readonly number: string | null
  /** Its name; never blank (the entry falls back to its number). */
  readonly title: string
  readonly subtitle: string | null
  /** Its status code (a factory-domain code), or null. */
  readonly status: string | null
  /** The area, when it is not the indexer's own (a supplier opens in purchasing, a customer in sales). */
  readonly area?: string
  /** More words people may type (codes, references, a VAT number). */
  readonly words?: readonly (string | null | undefined)[]
}

/** The records an event names. */
export type RecordsOf = 'subject' | ((event: EventEnvelope, tx: CommandTx) => readonly string[] | Promise<readonly string[]>)

export type ReadFilter = { readonly ids: readonly string[] } | { readonly after: string | null }

export interface SearchIndexer {
  readonly recordType: string
  readonly area: string
  readonly viewPermission: Permission
  readonly on: Readonly<Record<string, RecordsOf>>
  read(tx: CommandTx, filter: ReadFilter, take: number): Promise<SearchDocument[]>
}

export class IndexerConfigError extends Error {
  override name = 'IndexerConfigError'
}

/** The most records one event re-indexes through another record (a customer renamed: its orders). */
export const CASCADE_MAX = 500

const AREA = /^[a-z][a-z0-9_-]*$/
/** The entry's view permission as the database holds it (…_platform_w2a_guards): lower case words. */
const VIEW_PERMISSION = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/

/** Declares an indexer; a bad record type, area or permission, or an undeclared event, throws at once. */
export function defineIndexer(spec: SearchIndexer): SearchIndexer {
  const name = JSON.stringify(spec?.recordType)
  if (!RECORD_TYPE.test(spec?.recordType ?? '')) throw new IndexerConfigError(`Indexer ${name}: the record type is the API's model name (SalesOrder)`)
  if (!AREA.test(spec.area)) throw new IndexerConfigError(`Indexer ${name}: area ${JSON.stringify(spec.area)} is not an area id`)
  if (!VIEW_PERMISSION.test(spec.viewPermission) || !FACTORY_PERMISSIONS.isDeclared(spec.viewPermission)) throw new IndexerConfigError(`Indexer ${name}: ${spec.viewPermission} is not a declared lower-case permission`)
  const types = Object.keys(spec.on ?? {})
  if (types.length === 0) throw new IndexerConfigError(`Indexer ${name} follows no event`)
  const declared = new Set(EVENT_CATALOGUE.types())
  for (const type of types) if (!declared.has(type)) throw new IndexerConfigError(`Indexer ${name}: event ${type} is not declared in the event catalogue`)
  if (typeof spec.read !== 'function') throw new IndexerConfigError(`Indexer ${name} has no read`)
  return Object.freeze({ recordType: spec.recordType, area: spec.area, viewPermission: spec.viewPermission, on: Object.freeze({ ...spec.on }), read: spec.read })
}

/** The Prisma `where` on the record's id for a read filter (combine it with the indexer's own conditions). */
export function idWhere(filter: ReadFilter): { id?: { in: string[] } | { gt: string } } {
  if ('ids' in filter) return { id: { in: [...filter.ids] } }
  return filter.after ? { id: { gt: filter.after } } : {}
}

/** The records of `model` that name the event's subject in `field` (a party's orders, quotes, …), at most CASCADE_MAX. */
export function bySubjectIn(find: (tx: CommandTx, subject: string, take: number) => Promise<readonly { id: string }[]>): RecordsOf {
  return async (event, tx) => (await find(tx, event.subject, CASCADE_MAX)).map((row) => row.id)
}

/** A payload's list of ids (`lotIds` of a receipt), or none. */
export function payloadIds(key: string): RecordsOf {
  return (event) => {
    const value = (event.payload as Record<string, unknown> | null)?.[key]
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
  }
}

/** A party's name as records show it: the trade name when it has one, else the legal name. */
export const partyName = (party: { readonly legalName: string; readonly tradeName: string | null } | null | undefined): string | null =>
  party ? party.tradeName?.trim() || party.legalName : null
