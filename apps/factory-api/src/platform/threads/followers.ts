import type { FactoryClient } from '@nexus/factory-db'
import { THREADS_POST, THREADS_READ } from '@nexus/factory-domain/auth/permissions/catalogue'
import { sessionGrants } from '@nexus/factory-domain/auth/roles/roles'
import { ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { can, type Actor, type ScopedRecord } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { eventFor } from '@nexus/factory-domain/events/define'
import { events as threadEvents } from '@nexus/factory-domain/threads/events'
import { FOLLOWERS_SHOWN, followChange, type FollowReason } from '@nexus/factory-domain/threads/followers'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../core/command'
import { actorOf } from '../../core/context'
import { heldRoles } from '../auth/roles/access'
import { contextOf, officeRecord, type RecordRef } from './threads'

/**
 * Followers of a record (B-W2a-20; COL-011; design shell.panels popup followers, the band's Follow toggle,
 * home.notifications "M — mute this record"; rules factory-domain threads/followers). Storage: RecordFollower (collab.prisma).
 *
 *   GET  /threads/<type>/<id>/followers       who follows and why, and my own follow (threads.read over the record)
 *   PUT  /threads/<type>/<id>/followers/me    follow, unfollow (the row is removed) or mute my follow (threads.read)
 *   POST /threads/<type>/<id>/followers       add a colleague who may read the record's thread (threads.post)
 *
 * The seam `followInCommand` makes an automatic follow inside another command (a mention, an assignment, a record's
 * creation): only when the person has no row, so a muted follow stays muted and an unfollow lasts until the next mention.
 * The fan-out (platform/notifications) reads `followersOf` for a record's news.
 */

const followersChanged = threadEvents.find((event) => event.type === 'thread.followers_changed')!

export type FollowTools = Pick<CommandTools, 'tx' | 'now' | 'audit' | 'emit'>

/** Where the record sits (its company and site, for the audit row and the live message). */
export interface FollowedRecord extends RecordRef {
  readonly companyId: string | null
  readonly siteId: string | null
}

/**
 * Inside a command: the person follows the record for this reason, unless they have a follow row already (muted or not).
 * True when a row was added. No permission check: the caller checked that the person may read the record's thread.
 */
export async function followInCommand(tools: FollowTools, record: FollowedRecord, userId: string, reason: FollowReason, createdById: string | null): Promise<boolean> {
  const id = newId()
  const { count } = await tools.tx.recordFollower.createMany({
    data: [{ id, recordType: record.type, recordId: record.id, userId, reason, createdAt: tools.now, updatedAt: tools.now, createdById }],
    skipDuplicates: true,
  })
  if (count === 0) return false
  tools.audit({ action: 'threads.follow', recordType: 'RecordFollower', recordId: id, companyId: record.companyId, siteId: record.siteId, after: { recordType: record.type, recordId: record.id, userId, reason } })
  tools.emit(eventFor(followersChanged, { subject: record.id, companyId: record.companyId, siteId: record.siteId, payload: { recordType: record.type, recordId: record.id } }))
  return true
}

/** The people who follow a record and did not mute it (the fan-out's readers of its news). */
export async function followersOf(client: FactoryClient | CommandTx, record: RecordRef): Promise<string[]> {
  const rows = await client.recordFollower.findMany({ where: { recordType: record.type, recordId: record.id, muted: false }, orderBy: { createdAt: 'asc' }, select: { userId: true } })
  return rows.map((row) => row.userId)
}

/** Whether a person (by their live office roles, two-factor taken as proved) may read the thread of a record in this scope. */
export async function personReads(client: FactoryClient | CommandTx, tenantId: string, userId: string, scope: ScopedRecord, now: Date): Promise<boolean> {
  const reader: Actor = { audience: 'office', tenantId, grants: sessionGrants({ requireMfa: false }, await heldRoles(client, userId, now), true) }
  return can(reader, THREADS_READ, scope)
}

const recordOf = (record: RecordRef, scope: ScopedRecord): FollowedRecord => ({ ...record, companyId: scope.companyId ?? null, siteId: scope.siteId ?? null })

/** GET /threads/<type>/<id>/followers. */
export async function listFollowers(caller: CommandCaller, record: RecordRef) {
  const context = contextOf(caller)
  if (context.audience !== 'office') throw new ForbiddenError()
  const actor = actorOf(context)
  return caller.withClient(async (client) => {
    const { scope } = await officeRecord(client, record)
    if (!can(actor, THREADS_READ, scope)) throw new NotFoundError('Record not found.')
    const where = { recordType: record.type, recordId: record.id }
    // One after another: a scoped client is one transaction (no Promise.all on it).
    const rows = await client.recordFollower.findMany({ where, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: FOLLOWERS_SHOWN, select: { userId: true, reason: true, muted: true, createdAt: true, createdById: true } })
    const count = await client.recordFollower.count({ where })
    const mine = await client.recordFollower.findFirst({ where: { ...where, userId: context.actorId }, select: { muted: true, reason: true } })
    const names = new Map(
      (await client.user.findMany({ where: { id: { in: [...new Set(rows.flatMap((row) => [row.userId, row.createdById]).filter((id): id is string => id !== null))] } }, select: { id: true, displayName: true } })).map((user) => [user.id, user.displayName]),
    )
    return {
      record: { type: record.type, id: record.id },
      count,
      me: { following: mine !== null, muted: mine?.muted ?? false, reason: mine?.reason ?? null },
      followers: rows.map((row) => ({
        userId: row.userId,
        name: names.get(row.userId) ?? '',
        me: row.userId === context.actorId,
        reason: row.reason,
        muted: row.muted,
        since: toUtcIso(row.createdAt),
        addedBy: row.createdById && row.createdById !== row.userId ? { id: row.createdById, name: names.get(row.createdById) ?? '' } : null,
      })),
    }
  })
}

/** PUT /threads/<type>/<id>/followers/me: follow (CHOSE), unfollow (the row goes), mute or unmute. */
export async function setMyFollow(caller: CommandCaller, record: RecordRef, body: { readonly following: boolean; readonly muted: boolean }, idempotencyKey?: string) {
  const context = contextOf(caller)
  if (context.audience !== 'office') throw new ForbiddenError()
  const actor = actorOf(context)
  const { scope } = await caller.withClient((client) => officeRecord(client, record))
  if (!can(actor, THREADS_READ, scope)) throw new NotFoundError('Record not found.')
  const followed = recordOf(record, scope)
  await command(caller, { name: 'threads.follow', idempotencyKey, input: { recordType: record.type, recordId: record.id, ...body } }, async (tools) => {
    const { tx, now } = tools
    await tx.$queryRaw`SELECT id FROM "RecordFollower" WHERE "recordType" = ${record.type} AND "recordId" = ${record.id}::uuid AND "userId" = ${context.actorId}::uuid FOR UPDATE`
    const existing = await tx.recordFollower.findFirst({ where: { recordType: record.type, recordId: record.id, userId: context.actorId }, select: { id: true, muted: true, version: true, reason: true } })
    const change = followChange(existing, body)
    const audit = (action: string, recordId: string, after: unknown, before?: unknown) =>
      tools.audit({ action, recordType: 'RecordFollower', recordId, companyId: followed.companyId, siteId: followed.siteId, after, ...(before === undefined ? {} : { before }) })
    if (change === null) {
      audit('threads.followUnchanged', existing?.id ?? record.id, { following: existing !== null, muted: existing?.muted ?? false })
      return null
    }
    if (change === 'ADD') {
      const id = newId()
      await tx.recordFollower.create({ data: { id, recordType: record.type, recordId: record.id, userId: context.actorId, reason: 'CHOSE', muted: body.muted, createdAt: now, updatedAt: now, createdById: context.actorId }, select: { id: true } })
      audit('threads.follow', id, { recordType: record.type, recordId: record.id, userId: context.actorId, reason: 'CHOSE', muted: body.muted })
    } else if (change === 'REMOVE') {
      await tx.recordFollower.delete({ where: { id: existing!.id } })
      audit('threads.unfollow', existing!.id, { following: false }, { reason: existing!.reason, muted: existing!.muted })
    } else {
      await tx.recordFollower.update({ where: { id: existing!.id }, data: { muted: change === 'MUTE', version: existing!.version + 1, updatedAt: now }, select: { id: true } })
      audit(change === 'MUTE' ? 'threads.mute' : 'threads.unmute', existing!.id, { muted: change === 'MUTE' }, { muted: existing!.muted })
    }
    tools.emit(eventFor(followersChanged, { subject: record.id, companyId: followed.companyId, siteId: followed.siteId, payload: { recordType: record.type, recordId: record.id } }))
    return null
  })
  return listFollowers(caller, record)
}

/** POST /threads/<type>/<id>/followers: add a colleague who may read the record's thread (they chose nothing: CHOSE, made by me). */
export async function addFollower(caller: CommandCaller, record: RecordRef, body: { readonly userId: string }, idempotencyKey?: string) {
  const context = contextOf(caller)
  if (context.audience !== 'office') throw new ForbiddenError()
  const actor = actorOf(context)
  const { scope } = await caller.withClient((client) => officeRecord(client, record))
  if (!can(actor, THREADS_READ, scope)) throw new NotFoundError('Record not found.')
  if (!can(actor, THREADS_POST, scope)) throw new ForbiddenError()
  const followed = recordOf(record, scope)
  await command(caller, { name: 'threads.addFollower', idempotencyKey, input: { recordType: record.type, recordId: record.id, userId: body.userId } }, async (tools) => {
    const user = await tools.tx.user.findFirst({ where: { id: body.userId, status: 'ACTIVE' }, select: { id: true } })
    if (!user || !(await personReads(tools.tx, context.tenantId, user.id, scope, tools.now))) {
      const message = 'This person cannot read this record: only someone who may see it can follow it.'
      throw new ValidationError(message, [{ path: 'body/userId', message }])
    }
    const added = await followInCommand(tools, followed, user.id, 'CHOSE', context.actorId)
    if (!added) tools.audit({ action: 'threads.followUnchanged', recordType: 'RecordFollower', recordId: record.id, companyId: followed.companyId, siteId: followed.siteId, after: { userId: user.id, following: true } })
    return null
  })
  return listFollowers(caller, record)
}
