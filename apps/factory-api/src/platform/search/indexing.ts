import type { FactoryDatabase } from '@nexus/factory-db'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import type { EventEnvelope } from '@nexus/factory-domain/events/envelope'
import { callerFor, command, type CommandCaller, type CommandTools } from '../../core/command'
import type { Log } from '../../core/queue'
import { defineHandler, type EventHandler } from '../outbox/dispatch'
import { activeTenants, asSystem, systemContext } from '../outbox/system'
import type { SearchIndexer } from './indexer'
import { followedEvents } from './registry'
import { addWrites, noWrites, removeEntries, removeUnread, writeDocuments, type WriteCount } from './store'

/**
 * Keeping the search index current (B-W2a-32; PLT-153; design shell.search "search index updates from the outbox"):
 *
 *   search.index    the worker's handler of every record event an indexer follows (./indexers/*): ONE command per event,
 *                   as the tenant's system, keyed by the event (`search-<event id>`: a repeated job answers from its
 *                   receipt), reads the records the event names with each interested indexer and upserts their entries;
 *                   an entry whose record is gone is removed. Its one audit row names the event and the counts, never a
 *                   record's words.
 *   search.rebuild  the handler of `search.rebuild_requested` (POST /search/rebuild): every indexer (or the types named)
 *                   reads ALL its records again, a page of PAGE per command (keyed by the event, the type and the page),
 *                   rewrites what changed and removes the entries of records that are gone. A second rebuild writes
 *                   nothing new.
 *   at start        the worker indexes every active tenant whose index was never built (a database that had records
 *                   before search existed), with the same rebuild.
 */

export const REBUILD_PAGE = 200
const EVENT_CHUNK = 200

export const INDEX_HANDLER = 'search.index'
export const REBUILD_HANDLER = 'search.rebuild'

const tenantOf = (tools: CommandTools): string | null => ('tenantId' in tools.context ? tools.context.tenantId : null)

/** The records one event names for one indexer (uuids only, each once). */
async function recordsOf(indexer: SearchIndexer, event: EventEnvelope, tools: CommandTools): Promise<string[]> {
  const rule = indexer.on[event.type]
  if (!rule) return []
  const ids = rule === 'subject' ? [event.subject] : await rule(event, tools.tx)
  return [...new Set(ids.filter((id) => isUuid(id)))].sort()
}

/** Re-reads these records of one indexer and writes their entries (inside a command). */
export async function indexRecords(tools: CommandTools, indexer: SearchIndexer, recordIds: readonly string[]): Promise<WriteCount> {
  const count = noWrites()
  for (let at = 0; at < recordIds.length; at += EVENT_CHUNK) {
    const chunk = recordIds.slice(at, at + EVENT_CHUNK)
    const documents = await indexer.read(tools.tx, { ids: chunk }, chunk.length)
    addWrites(count, await writeDocuments(tools.tx, indexer, documents, tools.now))
    const read = new Set(documents.map((document) => document.recordId))
    count.removed += await removeEntries(tools.tx, indexer.recordType, chunk.filter((id) => !read.has(id)))
  }
  return count
}

/** One event's index work (the handler's; tests call it with a system caller). */
export async function indexEvent(caller: CommandCaller, indexers: readonly SearchIndexer[], event: EventEnvelope): Promise<WriteCount & { replayed: boolean }> {
  const interested = indexers.filter((indexer) => indexer.on[event.type] !== undefined)
  if (interested.length === 0) return { ...noWrites(), replayed: false }
  const { result, replayed } = await command(
    caller,
    { name: 'search.index', idempotencyKey: `search-${event.eventId}`, input: { eventId: event.eventId, type: event.type }, causationId: event.eventId },
    async (tools) => {
      const count = noWrites()
      const types: string[] = []
      for (const indexer of interested) {
        const ids = await recordsOf(indexer, event, tools)
        if (ids.length === 0) continue
        types.push(indexer.recordType)
        addWrites(count, await indexRecords(tools, indexer, ids))
      }
      // The audit row names the event, the record types and how many entries changed: never a record's words.
      tools.audit({ action: 'search.index', recordType: 'OutboxEvent', recordId: event.eventId, companyId: event.companyId ?? null, siteId: event.siteId ?? null, after: { eventType: event.type, recordTypes: types, ...count } })
      return { ...count }
    },
  )
  return { ...result, replayed }
}

export interface RebuildOutcome extends WriteCount {
  readonly recordTypes: readonly string[]
  readonly pages: number
}

/**
 * Reads every record of the indexers (or of the types named) again, a page per command. `key` keys the pages (a retried
 * job answers each page done from its receipt and goes on).
 */
export async function rebuildIndex(caller: CommandCaller, indexers: readonly SearchIndexer[], options: { readonly recordTypes: readonly string[] | null; readonly key: string; readonly causationId?: string }): Promise<RebuildOutcome> {
  const chosen = options.recordTypes ? indexers.filter((indexer) => options.recordTypes!.includes(indexer.recordType)) : [...indexers]
  const count = noWrites()
  let pages = 0
  for (const indexer of chosen) {
    let after: string | null = null
    for (let page = 0; ; page++) {
      const from: string | null = after
      const { result }: { result: WriteCount & { last: string | null; done: boolean } } = await command(
        caller,
        { name: 'search.rebuild', idempotencyKey: `${options.key}-${indexer.recordType}-${page}`, input: { recordType: indexer.recordType, page, after: from }, ...(options.causationId ? { causationId: options.causationId } : {}) },
        async (tools) => {
          const documents = await indexer.read(tools.tx, { after: from }, REBUILD_PAGE)
          const written = await writeDocuments(tools.tx, indexer, documents, tools.now)
          const last = documents.length > 0 ? documents[documents.length - 1]!.recordId : null
          const done = documents.length < REBUILD_PAGE
          // The entries between the last page and this one's last record that were not read: their records are gone.
          written.removed += await removeUnread(tools.tx, indexer.recordType, { after: from, through: done ? null : last }, documents.map((document) => document.recordId))
          const tenantId = tenantOf(tools)
          tools.audit({ action: 'search.rebuild', recordType: 'Tenant', recordId: tenantId ?? newId(), companyId: null, after: { recordType: indexer.recordType, page, ...written } })
          return { last, done, ...written }
        },
      )
      addWrites(count, result)
      pages++
      if (result.done || result.last === null) break
      after = result.last
    }
  }
  return { ...count, recordTypes: chosen.map((indexer) => indexer.recordType), pages }
}

/** The worker's two handlers. */
export function searchHandlers(indexers: readonly SearchIndexer[]): EventHandler[] {
  const handlers: EventHandler[] = [
    defineHandler({
      name: REBUILD_HANDLER,
      events: ['search.rebuild_requested'],
      attempts: 3,
      async handle(event, tools) {
        const payload = event.payload as { recordTypes: string[] | null }
        await rebuildIndex(tools.caller, indexers, { recordTypes: payload.recordTypes, key: `search-rebuild-${event.eventId}`, causationId: event.eventId })
      },
    }),
  ]
  const events = followedEvents(indexers)
  if (events.length > 0) {
    handlers.unshift(
      defineHandler({
        name: INDEX_HANDLER,
        events,
        async handle(event, tools) {
          await indexEvent(tools.caller, indexers, event)
        },
      }),
    )
  }
  return handlers
}

/**
 * At the worker's start: every active tenant whose index was never built (no `search.rebuild` audit row: a database that
 * had records before search existed, or only the seed's sample entries) is indexed from its records. Logged, never thrown.
 */
export async function indexNewTenants(options: { readonly database: FactoryDatabase; readonly indexers: readonly SearchIndexer[]; readonly log: Log }): Promise<{ tenants: number; indexed: number; failed: number }> {
  if (options.indexers.length === 0) return { tenants: 0, indexed: 0, failed: 0 }
  const requestId = `search-start-${newId()}`
  const tenants = await activeTenants(options.database)
  let indexed = 0
  let failed = 0
  for (const tenantId of tenants) {
    try {
      // Built once: a tenant whose index was ever rebuilt (its `search.rebuild` audit rows) is kept current by the events.
      const built = await asSystem(options.database, tenantId, requestId, (client) => client.auditLog.findFirst({ where: { recordType: 'Tenant', recordId: tenantId, action: 'search.rebuild' }, select: { id: true } }))
      if (built) continue
      const outcome = await rebuildIndex(callerFor(options.database, systemContext(tenantId, requestId)), options.indexers, { recordTypes: null, key: requestId })
      if (outcome.written > 0) indexed++
    } catch (error) {
      failed++
      options.log.error({ err: error, tenantId }, "a tenant's empty search index could not be built")
    }
  }
  options.log.info({ tenants: tenants.length, indexed, failed }, 'search index built for tenants that had none')
  return { tenants: tenants.length, indexed, failed }
}
