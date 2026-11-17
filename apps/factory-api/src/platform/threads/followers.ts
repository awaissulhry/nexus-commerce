import type { FactoryClient } from '@nexus/factory-db'
import { THREADS_POST, THREADS_READ } from '@nexus/factory-domain/auth/permissions/catalogue'
import { sessionGrants } from '@nexus/factory-domain/auth/roles/roles'
import { ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Actor, ScopedRecord } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { eventFor } from '@nexus/factory-domain/events/define'
import { events as threadEvents } from '@nexus/factory-domain/threads/events'
import { addedReason, FOLLOWERS_SHOWN, followChange, type FollowReason } from '@nexus/factory-domain/threads/followers'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../core/command'
import { actorOf } from '../../core/context'
import { heldRoles } from '../auth/roles/access'
import { contextOf, officeRecord, type RecordRef } from './threads'
// B-W2b-371: a record type's thread gate (a rider's profile: sales.measurements.view).
import { mayOnThread } from './records'

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
// B-TH-068: a colleague added by hand is told (the notification centre's "added you").
const followerAdded = threadEvents.find((event) => event.type === 'thread.follower_added')!

export type FollowTools = Pick<CommandTools, 'tx' | 'now' | 'audit' | 'emit'>

/** Where the record sits (its company and site, for the audit row and the live message). */
export interface FollowedRecord extends RecordRef {
  readonly companyId: string | null
  readonly siteId: string | null
}

/**
 * Inside a command: the person follows the record for this reason, unless they have a follow row already (muted or not).
 * True when a row was added. No permission check: the caller checked that the person may read the record's thread.
 * B-TH-068: `partyId` is a portal person's party (a project member of its outside company, reason ADDED: the database refuses
 * any other); an office person's row names none.
 */
export async function followInCommand(tools: FollowTools, record: FollowedRecord, userId: string, reason: FollowReason, createdById: string | null, /* B-TH-068 */ partyId: string | null = null): Promise<boolean> {
  const id = newId()
  const { count } = await tools.tx.recordFollower.createMany({
    data: [{ id, recordType: record.type, recordId: record.id, userId, reason, createdAt: tools.now, updatedAt: tools.now, createdById, ...(partyId ? { partyId } : {}) }],
    skipDuplicates: true,
  })
  if (count === 0) return false
  tools.audit({ action: 'threads.follow', recordType: 'RecordFollower', recordId: id, companyId: record.companyId, siteId: record.siteId, after: { recordType: record.type, recordId: record.id, userId, reason, ...(partyId ? { partyId } : {}) } })
  tools.emit(eventFor(followersChanged, { subject: record.id, companyId: record.companyId, siteId: record.siteId, payload: { recordType: record.type, recordId: record.id } }))
  return true
}

// ---- B-PR-08a (T5) (production plan R-58; threads lead YES 2026-11-17): the other half of followInCommand's seam.
/** The reasons a command may take back: an automatic follow's (never the person's own choice, never a mention). */
export type AutomaticFollowReason = Extract<FollowReason, 'CREATOR' | 'ASSIGNEE'>

/**
 * Inside a command: the person stops following the record for this reason — their follow row goes, with the same audit row
 * (`threads.unfollow`, naming whose follow went) and `thread.followers_changed` event as their own unfollow — only when the row
 * was made for exactly that reason and is not muted. A follow they chose (CHOSE, also one a colleague added), a mention's
 * (MENTIONED), another reason's, and a muted row (their own word on the record: nothing follows or unfollows them on its own)
 * stay. True when the row went. No permission check: the caller decided (an assignment taken back, a supervisor replaced).
 */
export async function unfollowInCommand(tools: FollowTools, record: FollowedRecord, userId: string, reason: AutomaticFollowReason): Promise<boolean> {
  if (reason !== 'CREATOR' && reason !== 'ASSIGNEE') return false
  await tools.tx.$queryRaw`SELECT id FROM "RecordFollower" WHERE "recordType" = ${record.type} AND "recordId" = ${record.id}::uuid AND "userId" = ${userId}::uuid FOR UPDATE`
  const row = await tools.tx.recordFollower.findFirst({ where: { recordType: record.type, recordId: record.id, userId }, select: { id: true, reason: true, muted: true } })
  if (!row || row.reason !== reason || row.muted) return false
  await tools.tx.recordFollower.delete({ where: { id: row.id } })
  tools.audit({
    action: 'threads.unfollow',
    recordType: 'RecordFollower',
    recordId: row.id,
    companyId: record.companyId,
    siteId: record.siteId,
    before: { reason: row.reason, muted: row.muted },
    after: { following: false, recordType: record.type, recordId: record.id, userId },
  })
  tools.emit(eventFor(followersChanged, { subject: record.id, companyId: record.companyId, siteId: record.siteId, payload: { recordType: record.type, recordId: record.id } }))
  return true
}
// ---- end B-PR-08a (T5)

/**
 * The OFFICE people who follow a record and did not mute it (the fan-out's readers of its news). B-TH-068: a project's portal
 * members (rows that name their party) are never here: the portal's own news tells them (platform/portal/notifications), each by
 * their party's rules, never the office's fan-out.
 */
export async function followersOf(client: FactoryClient | CommandTx, record: RecordRef): Promise<string[]> {
  const rows = await client.recordFollower.findMany({ where: { recordType: record.type, recordId: record.id, muted: false, partyId: null }, orderBy: { createdAt: 'asc' }, select: { userId: true } })
  return rows.map((row) => row.userId)
}

/** Whether a person (by their live office roles, two-factor taken as proved) may read the thread of a record in this scope. */
export async function personReads(client: FactoryClient | CommandTx, tenantId: string, userId: string, scope: ScopedRecord, now: Date, /* B-W2b-371 */ recordType?: string): Promise<boolean> {
  const reader: Actor = { audience: 'office', tenantId, grants: sessionGrants({ requireMfa: false }, await heldRoles(client, userId, now), true) }
  return mayOnThread(reader, THREADS_READ, recordType, scope)
}

const recordOf = (record: RecordRef, scope: ScopedRecord): FollowedRecord => ({ ...record, companyId: scope.companyId ?? null, siteId: scope.siteId ?? null })

/** GET /threads/<type>/<id>/followers. */
export async function listFollowers(caller: CommandCaller, record: RecordRef) {
  const context = contextOf(caller)
  if (context.audience !== 'office') throw new ForbiddenError()
  const actor = actorOf(context)
  return caller.withClient(async (client) => {
    const { scope } = await officeRecord(client, record)
    if (!mayOnThread(actor, THREADS_READ, record.type, scope)) throw new NotFoundError('Record not found.')
    const where = { recordType: record.type, recordId: record.id }
    // One after another: a scoped client is one transaction (no Promise.all on it).
    const rows = await client.recordFollower.findMany({ where, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: FOLLOWERS_SHOWN, select: { userId: true, reason: true, muted: true, createdAt: true, createdById: true, partyId: true } })
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
        // B-TH-068: a portal person of the record's outside company (a project member), not one of our colleagues.
        outside: row.partyId !== null,
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
  if (!mayOnThread(actor, THREADS_READ, record.type, scope)) throw new NotFoundError('Record not found.')
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

/**
 * POST /threads/<type>/<id>/followers: add a colleague who may read the record's thread. B-TH-068 (PROJ-G04, PROJ-G05): they chose
 * nothing — reason ADDED, made by me ("added by Marco", not "chose to follow"), and they are told (thread.follower_added → the
 * notification centre's "added you", platform/notifications/rules/projects.ts); adding myself is my own choice (CHOSE).
 */
export async function addFollower(caller: CommandCaller, record: RecordRef, body: { readonly userId: string }, idempotencyKey?: string) {
  const context = contextOf(caller)
  if (context.audience !== 'office') throw new ForbiddenError()
  const actor = actorOf(context)
  const { scope } = await caller.withClient((client) => officeRecord(client, record))
  if (!mayOnThread(actor, THREADS_READ, record.type, scope)) throw new NotFoundError('Record not found.')
  if (!mayOnThread(actor, THREADS_POST, record.type, scope)) throw new ForbiddenError()
  const followed = recordOf(record, scope)
  await command(caller, { name: 'threads.addFollower', idempotencyKey, input: { recordType: record.type, recordId: record.id, userId: body.userId } }, async (tools) => {
    // B-TH-068: a colleague is an office person (a portal person joins a project only as its outside company's member: projects).
    const user = await tools.tx.user.findFirst({ where: { id: body.userId, status: 'ACTIVE', audience: 'OFFICE' }, select: { id: true } })
    if (!user || !(await personReads(tools.tx, context.tenantId, user.id, scope, tools.now, record.type))) {
      const message = 'This person cannot read this record: only someone who may see it can follow it.'
      throw new ValidationError(message, [{ path: 'body/userId', message }])
    }
    // ---- B-TH-068: ADDED by a colleague (the database requires the adder, someone else); my own follow stays CHOSE.
    const reason = addedReason(user.id, context.actorId)
    const added = await followInCommand(tools, followed, user.id, reason, context.actorId)
    if (added && reason === 'ADDED') tools.emit(eventFor(followerAdded, { subject: record.id, companyId: followed.companyId, siteId: followed.siteId, payload: { recordType: record.type, recordId: record.id, userId: user.id, byId: context.actorId } }))
    // ---- end B-TH-068
    if (!added) tools.audit({ action: 'threads.followUnchanged', recordType: 'RecordFollower', recordId: record.id, companyId: followed.companyId, siteId: followed.siteId, after: { userId: user.id, following: true } })
    return null
  })
  return listFollowers(caller, record)
}
