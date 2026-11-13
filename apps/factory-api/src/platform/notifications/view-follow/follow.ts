import { ConflictError, DomainError, ForbiddenError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { can, type Actor } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { VIEW_FOLLOW_LIMITS, viewFingerprint, viewFollowKey } from '@nexus/factory-domain/notifications/preferences/view-follow'
import { viewStateSchema } from '@nexus/factory-domain/views/state'
import type { Prisma } from '@nexus/factory-db'
import { command, type CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { exportSourceOf } from '../../exports/registry'
import { rowIdOf, type AnyExportSource } from '../../exports/source'
import { readerOf, readVisible } from '../../views/views'
import { officeOf } from '../notifications'

/**
 * Follow a saved view (B-W2b-385; PLT-151; design home.today "My saved views with live counts", "Changed since you looked"):
 *
 *   GET    /notifications/following/views            the views I follow: name, list, rows when last counted, since when
 *   PUT    /notifications/following/views/:viewId    follow a view I see (mine, everyone's, my roles'): counted now, AS ME
 *   DELETE /notifications/following/views/:viewId    stop following it
 *
 * A view is counted through its list's export source (platform/exports): the list's own read as the person, with the view's
 * address terms, so the count is exactly the rows the screen shows them, never more. A list without an export source cannot
 * be followed yet (said in words). The scheduler counts again every quarter of an hour (evaluate.ts) and tells the person
 * when the rows changed.
 */

const STATE = (value: Prisma.JsonValue) => {
  const parsed = viewStateSchema.safeParse(value)
  return parsed.success ? parsed.data : { query: '' }
}

/** Why a person may not follow (or have counted) a list's view, in words; null: they may. */
export function followRefusal(source: AnyExportSource | undefined, actor: Actor, companyId: string | null): string | null {
  if (!source) return 'This list cannot be followed yet: a view is counted through the list’s export, and this list has none.'
  if (!can(actor, source.permission, companyId ? { companyId } : {})) return 'You may not see this list, so you cannot follow its view.'
  return source.refusal?.(actor) ?? null
}

/**
 * The view's row ids as its reader sees them (the list's own read, page by page), at most VIEW_FOLLOW_LIMITS.maxRows; `capped`
 * when there are more.
 */
export async function viewIds(reader: CommandCaller, source: AnyExportSource, state: Prisma.JsonValue): Promise<{ readonly ids: string[]; readonly capped: boolean }> {
  const query = source.query(new URLSearchParams(STATE(state).query))
  const ids: string[] = []
  let cursor: string | null = null
  do {
    const page = await source.read(reader, query, cursor, VIEW_FOLLOW_LIMITS.page, { locale: 'en' })
    for (const row of page.rows) {
      const id = rowIdOf(source, row)
      if (id !== null) ids.push(id)
    }
    cursor = page.next
  } while (cursor !== null && ids.length <= VIEW_FOLLOW_LIMITS.maxRows)
  const unique = [...new Set(ids)]
  return { ids: unique.slice(0, VIEW_FOLLOW_LIMITS.maxRows), capped: unique.length > VIEW_FOLLOW_LIMITS.maxRows }
}

/** GET /notifications/following/views. */
export async function listFollowedViews(caller: CommandCaller) {
  const context = officeOf(caller)
  return caller.withClient(async (client) => {
    const rows = await client.viewFollower.findMany({
      where: { userId: context.actorId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: VIEW_FOLLOW_LIMITS.perPerson,
      select: { id: true, viewId: true, lastCount: true, lastCountedAt: true, createdAt: true, view: { select: { name: true, listKey: true, companyId: true } } },
    })
    return {
      views: rows.map((row) => ({
        followId: row.id,
        viewId: row.viewId,
        name: row.view.name,
        listKey: row.view.listKey,
        companyId: row.view.companyId,
        /** Rows when last counted for me (null: not counted yet); `capped` when the view holds more than are counted. */
        count: row.lastCount,
        capped: row.lastCount !== null && row.lastCount >= VIEW_FOLLOW_LIMITS.maxRows,
        countedAt: row.lastCountedAt ? toUtcIso(row.lastCountedAt) : null,
        since: toUtcIso(row.createdAt),
      })),
      max: VIEW_FOLLOW_LIMITS.perPerson,
    }
  })
}

/** PUT /notifications/following/views/:viewId: follow a view I see, counted now as me. Already followed: nothing changes. */
export async function followView(caller: CommandCaller, viewId: string, idempotencyKey?: string) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  const view = await caller.withClient(async (client) => readVisible(client, viewId, await readerOf(client, context)))
  const source = exportSourceOf(view.listKey)
  const refusal = followRefusal(source, actor, view.companyId)
  if (refusal) throw source ? new ForbiddenError(refusal) : new DomainError('conflict', refusal, [{ path: 'views/NOT_FOLLOWABLE', message: refusal }])
  // Counted BEFORE the command, as me (the list's read is its own; the follow row then starts from what I see now).
  const counted = await viewIds(caller, source!, view.state)
  await command(caller, { name: 'notifications.followView', idempotencyKey, input: { viewId } }, async (tools) => {
    const { tx, now } = tools
    const key = viewFollowKey(viewId, context.actorId)
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}::text))`
    const existing = await tx.viewFollower.findFirst({ where: { key }, select: { id: true } })
    if (existing) {
      tools.audit({ recordType: 'ViewFollower', recordId: existing.id, after: { viewId, again: true } })
      return null
    }
    if ((await tx.viewFollower.count({ where: { userId: context.actorId } })) >= VIEW_FOLLOW_LIMITS.perPerson) throw new ConflictError(`You follow ${VIEW_FOLLOW_LIMITS.perPerson} views already: stop following one first.`)
    const id = newId()
    await tx.viewFollower.create({ data: { id, userId: context.actorId, viewId, key, lastFingerprint: viewFingerprint(counted.ids), lastCount: counted.ids.length, lastCountedAt: now, createdAt: now, updatedAt: now }, select: { id: true } })
    tools.audit({ recordType: 'ViewFollower', recordId: id, after: { viewId, listKey: view.listKey, count: counted.ids.length, capped: counted.capped } })
    return null
  })
  return listFollowedViews(caller)
}

/** DELETE /notifications/following/views/:viewId: stop following (not followed: nothing changes). */
export async function unfollowView(caller: CommandCaller, viewId: string, idempotencyKey?: string) {
  const context = officeOf(caller)
  await command(caller, { name: 'notifications.unfollowView', idempotencyKey, input: { viewId } }, async (tools) => {
    const existing = await tools.tx.viewFollower.findFirst({ where: { key: viewFollowKey(viewId, context.actorId) }, select: { id: true, lastCount: true } })
    if (existing) await tools.tx.viewFollower.delete({ where: { id: existing.id }, select: { id: true } })
    tools.audit({ recordType: 'SavedView', recordId: viewId, before: { following: existing !== null }, after: { following: false } })
    return null
  })
  return listFollowedViews(caller)
}
