import type { Prisma } from '@nexus/factory-db'
import { heldGrains } from '@nexus/factory-domain/auth/grains/grains'
import { FILES_READ, THREADS_READ } from '@nexus/factory-domain/auth/permissions/catalogue'
import { ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { excerptOf } from '@nexus/factory-domain/threads/rules'
import { changeSummary, encodeCursor, mergeNewestFirst, type TimelineKind } from '@nexus/factory-domain/threads/timeline'
import type { CommandCaller } from '../../core/command'
import { actorOf } from '../../core/context'
import { workerGatesFor, workersAmong } from '../../modules/people/privacy/worker-gate'
import { AUDIT_READ, AUDIT_SCOPE_COLUMNS } from '../audit/read'
import type { TimelineEntryView } from './contract'
import { afterCursor, contextOf, cursorOf, officeRecord, type RecordRef } from './threads'
// B-W2b-371: a record type's thread gate (a rider's profile: sales.measurements.view).
import { mayOnThread } from './records'

/**
 * The record's timeline (feature COL-002; A2 SCR-006): one feed, newest first, of
 *   message   the messages of the record's thread (internal notes and shared mail alike: the timeline is office only)
 *   change    the record's audit rows: what was done, by whom, its status move and the names of the fields it changed;
 *             the values (before, after, reason) only for a reader with audit.read over the row, money only with its
 *             grain (the app's grain filter on grainedJson), and a money field is not even named without it
 *   file      the record's files, when each became available (a reader with files.read)
 * with filter chips (`kinds`). Nothing is stored for it: each source is read after the cursor (limit + 1 rows) and the
 * three are merged by (time, id). The record must be one the reader may see the thread of (can(threads.read)).
 *
 * A floor worker stays behind the site's PERFORMANCE gate (B-W2b-F4, worker-gate.ts): with the gate not open a floor actor's
 * row and a worker's message carry no id and no name (`actorHidden`, `authorHidden`: the row says a person did it), and the
 * values of a row that is a floor actor's or names a worker are not served: an audit row can name the worker in them even when
 * it was written as the system (a floor note). An office user's actor stays. GET /audit is another read and stays as it is.
 */

type Positioned<Entry> = { readonly at: Date; readonly id: string; readonly entry: Entry }

/** Every id in an audit row's values, at any depth. */
function idsIn(value: unknown, found: Set<string> = new Set()): Set<string> {
  if (typeof value === 'string') {
    if (isUuid(value)) found.add(value)
  } else if (Array.isArray(value)) {
    for (const entry of value) idsIn(entry, found)
  } else if (value !== null && typeof value === 'object') {
    for (const entry of Object.values(value)) idsIn(entry, found)
  }
  return found
}

export async function readTimeline(
  caller: CommandCaller,
  record: RecordRef,
  query: { readonly kinds: readonly TimelineKind[]; readonly cursor?: string | undefined; readonly limit: number },
): Promise<{ entries: TimelineEntryView[]; nextCursor: string | null }> {
  const context = contextOf(caller)
  if (context.audience !== 'office') throw new ForbiddenError()
  const actor = actorOf(context)
  const cursor = cursorOf(query.cursor)
  const kinds = new Set(query.kinds)
  const take = query.limit + 1
  const held = heldGrains(actor)
  const newest = (field: string) => [{ [field]: 'desc' as const }, { id: 'desc' as const }]

  return caller.withClient(async (client) => {
    const { thread, scope } = await officeRecord(client, record)
    if (!mayOnThread(actor, THREADS_READ, record.type, scope)) throw new NotFoundError('Record not found.')
    const sources: Positioned<TimelineEntryView>[][] = []

    const messages =
      kinds.has('message') && thread
        ? await client.message.findMany({
            where: { AND: [{ threadId: thread.id }, afterCursor(cursor, 'at') as Prisma.MessageWhereInput] },
            orderBy: newest('at') as Prisma.MessageOrderByWithRelationInput[],
            take,
            select: { id: true, at: true, direction: true, audience: true, channel: true, authorKind: true, authorId: true, authorName: true, bodyText: true, attachmentFileIds: true },
          })
        : []
    const changes = kinds.has('change')
      ? await client.auditLog.findMany({
          where: {
            AND: [
              scopeWhere(actor, THREADS_READ, AUDIT_SCOPE_COLUMNS) as Prisma.AuditLogWhereInput,
              { recordType: record.type, recordId: record.id },
              afterCursor(cursor, 'at') as Prisma.AuditLogWhereInput,
            ],
          },
          orderBy: newest('at') as Prisma.AuditLogOrderByWithRelationInput[],
          take,
          select: { id: true, at: true, audience: true, actorId: true, companyId: true, siteId: true, partyId: true, action: true, before: true, after: true, reason: true },
        })
      : []

    // Who stays behind the gate on this page: one look at the workers, one read of each site's gate.
    const detailed = (row: (typeof changes)[number]) => can(actor, AUDIT_READ, { companyId: row.companyId, siteId: row.siteId, partyId: row.partyId })
    const valueIds = new Map(changes.filter(detailed).map((row) => [row.id, idsIn([row.before, row.after])]))
    const workers = await workersAmong(client, [...valueIds.values()].flatMap((ids) => [...ids]))
    const onTheFloor = (row: (typeof changes)[number]) => row.audience === 'FLOOR' || [...(valueIds.get(row.id) ?? [])].some((id) => workers.has(id))
    const siteOf = (row: (typeof changes)[number]) => row.siteId ?? scope.siteId
    const gates = await workerGatesFor(client, [...(messages.some((row) => row.authorKind === 'WORKER') ? [scope.siteId] : []), ...changes.filter(onTheFloor).map(siteOf)])

    if (kinds.has('message') && thread) {
      sources.push(
        messages.map((row) => {
          const authorHidden = row.authorKind === 'WORKER' && !gates.at(scope.siteId).open
          return {
            at: row.at,
            id: row.id,
            entry: {
              kind: 'message',
              id: row.id,
              at: toUtcIso(row.at),
              direction: row.direction,
              audience: row.audience,
              channel: row.channel,
              author: { kind: row.authorKind, id: authorHidden ? null : row.authorId, name: authorHidden ? null : row.authorName },
              authorHidden,
              excerpt: excerptOf(row.bodyText),
              attachmentCount: row.attachmentFileIds.length,
            },
          }
        }),
      )
    }

    if (kinds.has('change')) {
      sources.push(
        changes.map((row) => {
          const summary = changeSummary(row.before, row.after, held)
          const details = detailed(row)
          const who = gates.at(siteOf(row))
          const author = who.author(row.actorId, row.audience === 'FLOOR')
          const values = details && (who.open || !onTheFloor(row))
          return {
            at: row.at,
            id: row.id,
            entry: {
              kind: 'change',
              id: row.id,
              at: toUtcIso(row.at),
              action: row.action,
              actor: { audience: row.audience, id: author.id },
              actorHidden: author.hidden,
              status: summary.status,
              fields: summary.fields,
              before: values ? (row.before ?? null) : null,
              after: values ? (row.after ?? null) : null,
              reason: details ? row.reason : null,
            },
          }
        }),
      )
    }

    if (kinds.has('file')) {
      const rows = await client.storedFile.findMany({
        where: {
          AND: [
            scopeWhere(actor, FILES_READ, { company: { field: 'companyId', nullable: true } }) as Prisma.StoredFileWhereInput,
            { recordType: record.type, recordId: record.id, availableAt: { not: null } },
            afterCursor(cursor, 'availableAt') as Prisma.StoredFileWhereInput,
          ],
        },
        orderBy: newest('availableAt') as Prisma.StoredFileOrderByWithRelationInput[],
        take,
        select: { id: true, availableAt: true, kind: true, originalName: true, status: true, visibility: true },
      })
      sources.push(
        rows.map((row) => ({
          at: row.availableAt!,
          id: row.id,
          entry: { kind: 'file', id: row.id, at: toUtcIso(row.availableAt!), fileKind: row.kind, originalName: row.originalName, status: row.status, visibility: row.visibility },
        })),
      )
    }

    const { items, more } = mergeNewestFirst(sources, query.limit)
    const last = items.at(-1)
    return { entries: items.map((item) => item.entry), nextCursor: more && last ? encodeCursor(last) : null }
  })
}
