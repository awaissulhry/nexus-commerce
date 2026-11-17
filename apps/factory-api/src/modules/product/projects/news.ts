import type { FastifyRequest } from 'fastify'
import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { heldGrains } from '@nexus/factory-domain/auth/grains/grains'
import { THREADS_READ } from '@nexus/factory-domain/auth/permissions/catalogue'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { can, scopeWhere, type Actor } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { foldPerRecordDay, isLinkedNews, isProjectLinkType, PROJECT_LIMITS } from '@nexus/factory-domain/projects/rules'
import { changeSummary, encodeCursor, mergeNewestFirst, type TimelineCursor } from '@nexus/factory-domain/threads/timeline'
import type { CommandTx } from '../../../core/command'
import { AUDIT_SCOPE_COLUMNS } from '../../../platform/audit/read'
import { kindsOfSession, partnerCallerOf, partnerReaderOf } from '../../../platform/search/partner/session'
import { partnerViewOf, viewFits } from '../../../platform/search/partner/views'
import { recordLabelOf } from '../../../platform/threads/labels'
import { afterCursor, cursorOf } from '../../../platform/threads/threads'
import { factsOf, mayOpenRecord } from './links'

/**
 * Linked news (threads plan TH-5, B-TH-072; PROJ-G17; design PROJ.thread, PROJ.linked-F08 "View ▾ Linked news"): the state moves
 * and decisions of a project's linked records, merged into the project's feed WHEN READ — never copied into its thread. One line
 * per record per day (the newest; how many it folds). Each line is shown only to a reader who may open that record itself:
 *
 *   office   GET /threads/Project/<id>/timeline?kinds=linked (platform/threads/timeline.ts asks `linkedNewsOf`): the record's own
 *            view permission over its company and outside company (its THREAD_VIEW_GATES gate: a style needs product.styles.view,
 *            a measurement profile sales.measurements.view …), its audit rows within the reader's threads.read scope; the
 *            status move, the action and the office person by name — never a value (the record's own timeline has them)
 *   portal   GET /portal/projects/:projectId/news (a member of the project): only the linked records the person opens in their
 *            own portal (each record's partner view, with them as its reader: their orders, quotes, shipments, their own styles
 *            and rounds; never a PO of another party, a certificate, an internal record), status moves only, never who did it
 *
 * W38: the brand sees news only of the linked records it may open itself.
 */

type Client = FactoryClient | CommandTx

export interface LinkedNewsEntry {
  readonly kind: 'linked'
  readonly id: string
  readonly at: string
  readonly recordType: string
  readonly recordId: string
  readonly label: string
  readonly action: string
  readonly status: { readonly from: string | null; readonly to: string | null } | null
  readonly actorName: string | null
  /** How many moves of this record that day the line stands for. */
  readonly folded: number
}

const romeDay = (at: Date): string => businessDate(at)

/** Audit rows of these records, newest first after the cursor (one query; the caller's own scope filter beside). */
async function auditOf(client: Client, records: readonly { type: string; id: string }[], cursor: TimelineCursor | null, take: number, scope: Prisma.AuditLogWhereInput | null) {
  if (records.length === 0) return []
  const byType = new Map<string, string[]>()
  for (const record of records) byType.set(record.type, [...(byType.get(record.type) ?? []), record.id])
  return client.auditLog.findMany({
    where: {
      AND: [
        ...(scope ? [scope] : []),
        { OR: [...byType.entries()].map(([recordType, ids]) => ({ recordType, recordId: { in: ids } })) },
        afterCursor(cursor, 'at') as Prisma.AuditLogWhereInput,
      ],
    },
    orderBy: [{ at: 'desc' }, { id: 'desc' }],
    take,
    select: { id: true, at: true, audience: true, actorId: true, action: true, before: true, after: true, recordType: true, recordId: true },
  })
}

/** The office reader's linked news of a project, as timeline entries (platform/threads/timeline.ts merges them). */
export async function linkedNewsOf(client: Client, actor: Actor, projectId: string, cursor: TimelineCursor | null, take: number): Promise<Array<{ at: Date; id: string; entry: LinkedNewsEntry }>> {
  const links = await client.projectLink.findMany({ where: { projectId }, take: PROJECT_LIMITS.links, select: { recordType: true, recordId: true } })
  const open: { type: string; id: string }[] = []
  for (const link of links) {
    if (!isProjectLinkType(link.recordType)) continue
    const facts = await factsOf(client, link.recordType, link.recordId)
    if (facts && mayOpenRecord(actor, link.recordType, facts)) open.push({ type: link.recordType, id: link.recordId })
  }
  // Read more than a page: only moves and decisions are news, and a day's moves of one record fold into one line.
  const rows = await auditOf(client, open, cursor, take * 4, scopeWhere(actor, THREADS_READ, AUDIT_SCOPE_COLUMNS) as Prisma.AuditLogWhereInput)
  const held = heldGrains(actor)
  const news = rows.flatMap((row) => {
    const status = changeSummary(row.before, row.after, held).status
    return isLinkedNews(row.action, status) ? [{ ...row, status }] : []
  })
  const folded = foldPerRecordDay(news, romeDay)
  const officeActors = [...new Set(folded.filter((row) => row.audience === 'OFFICE').map((row) => row.actorId))]
  const names = new Map(officeActors.length === 0 ? [] : (await client.user.findMany({ where: { id: { in: officeActors } }, select: { id: true, displayName: true } })).map((user) => [user.id, user.displayName]))
  const labels = new Map<string, string>()
  for (const record of open) labels.set(`${record.type}:${record.id}`, (await recordLabelOf(client, record.type, record.id)) ?? record.type)
  return folded.slice(0, take).map((row) => ({
    at: row.at,
    id: row.id,
    entry: {
      kind: 'linked' as const,
      id: row.id,
      at: toUtcIso(row.at),
      recordType: row.recordType,
      recordId: row.recordId,
      label: labels.get(`${row.recordType}:${row.recordId}`) ?? row.recordType,
      action: row.action,
      status: row.status,
      // An office person by name; a floor worker or the system never (the record's own timeline keeps its gate).
      actorName: row.audience === 'OFFICE' ? (names.get(row.actorId) ?? null) : null,
      folded: row.folded,
    },
  }))
}

// ---- the portal's linked news --------------------------------------------------------------------------------------------

export interface PartnerNewsEntry {
  readonly id: string
  readonly at: string
  readonly recordType: string
  readonly recordId: string
  readonly theirRef: string | null
  readonly ourRef: string | null
  readonly status: { readonly from: string | null; readonly to: string | null }
  readonly folded: number
}

/** GET /portal/projects/:projectId/news: a member's linked news — only the records they open in their own portal. */
export async function partnerProjectNews(request: FastifyRequest, projectId: string, query: { readonly cursor?: string | undefined; readonly limit: number }): Promise<{ entries: PartnerNewsEntry[]; nextCursor: string | null }> {
  const caller = partnerCallerOf(request)
  const reader = partnerReaderOf(request, caller)
  const cursor = cursorOf(query.cursor)
  const opened = await request.withClient(async (client) => {
    const kinds = await kindsOfSession(client, caller)
    const projectView = partnerViewOf('Project')
    const [project] = projectView && viewFits(projectView, kinds) ? await projectView.read(client, [projectId], reader) : []
    if (!project || !can(caller.actor, THREADS_READ, { companyId: project.companyId, partyId: caller.context.partyId })) throw new NotFoundError('Project not found.')
    // The partner role reads the links of its own projects (by party); each record only through its own partner view.
    const links = await client.projectLink.findMany({ where: { projectId }, take: PROJECT_LIMITS.links, select: { recordType: true, recordId: true } })
    const records = new Map<string, { type: string; id: string; theirRef: string | null; ourRef: string | null }>()
    for (const type of new Set(links.map((link) => link.recordType))) {
      const view = partnerViewOf(type)
      if (!view || !viewFits(view, kinds)) continue
      for (const record of await view.read(client, links.filter((link) => link.recordType === type).map((link) => link.recordId), reader)) {
        if (can(caller.actor, THREADS_READ, { companyId: record.companyId, partyId: caller.context.partyId })) records.set(`${type}:${record.id}`, { type, id: record.id, theirRef: record.theirRef, ourRef: record.ourRef })
      }
    }
    return [...records.values()]
  })
  if (opened.length === 0) return { entries: [], nextCursor: null }
  // The audit rows in the tenant's scope (the partner role reads none), only for the records the person opened just now; status
  // moves only — never a value, an action name or who did it.
  const rows = await reader.inTenant((client) => auditOf(client, opened, cursor, (query.limit + 1) * 4, null))
  const held = heldGrains(caller.actor)
  const moves = rows.flatMap((row) => {
    const status = changeSummary(row.before, row.after, held).status
    return status ? [{ ...row, status }] : []
  })
  const folded = foldPerRecordDay(moves, romeDay)
  const byKey = new Map(opened.map((record) => [`${record.type}:${record.id}`, record]))
  const positioned = folded.map((row) => ({ at: row.at, id: row.id, row }))
  const { items, more } = mergeNewestFirst([positioned], query.limit)
  const last = items.at(-1)
  return {
    entries: items.map(({ row }) => {
      const record = byKey.get(`${row.recordType}:${row.recordId}`)
      return { id: row.id, at: toUtcIso(row.at), recordType: row.recordType, recordId: row.recordId, theirRef: record?.theirRef ?? null, ourRef: record?.ourRef ?? null, status: row.status, folded: row.folded }
    }),
    nextCursor: more && last ? encodeCursor(last) : null,
  }
}
