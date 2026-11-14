import type { Prisma } from '@nexus/factory-db'
import { EMAIL_TRIAGE } from '@nexus/factory-domain/auth/permissions/catalogue'
import { sessionGrants } from '@nexus/factory-domain/auth/roles/roles'
import { NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can, holds, type Actor } from '@nexus/factory-domain/core/permissions'
import { eventFor } from '@nexus/factory-domain/events/define'
import { events as mailDepthEvents } from '@nexus/factory-domain/mail-depth/events'
import { EMAIL_INBOXES_MANAGE } from '@nexus/factory-domain/mail-depth/permissions'
import { inboxNameProblem, localPartProblem, TEAM_INBOX_LIMITS } from '@nexus/factory-domain/mail-depth/rules'
import { command, type CommandCaller } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { heldRoles } from '../../auth/roles/access'
import type { TeamInboxView } from './contract'
import { mailRefusal, officeOf, receivingDomainOf, type Reader } from './store'

/**
 * Team inboxes (B-W2b-394; COL-027; design home.mail "Team inboxes (W2b: orders@, quotes@)"): a company's shared mailboxes.
 * Mail to `<local part>@<the company's receiving domain>` lands in one (the worker's routing, ./route.ts); its members take
 * it, close it, snooze it and ask for follow-ups (./work.ts). Setting them up is email.inboxes.manage over the company:
 *
 *   GET  /email/team-inboxes                  the inboxes the person works (all of a company for a manager), with counts
 *   POST /email/team-inboxes                  a new inbox (name, the address before the @, members)
 *   PUT  /email/team-inboxes/:teamInboxId     change it, or switch it off / on (never deleted: it keeps its mail)
 *   GET  /email/team-inboxes/people           who may be a member (names only)
 *
 * A member is an ACTIVE office person whose live roles sort mail of the company (email.triage). The database (B-W2b-366's
 * TeamInbox guard) repeats the format, the uniqueness in the company and that each new member is an office user.
 */

const [inboxChanged] = mailDepthEvents

export const INBOX_COLUMNS = { id: true, companyId: true, name: true, localPart: true, memberIds: true, active: true, version: true } as const satisfies Prisma.TeamInboxSelect
export type InboxRow = Prisma.TeamInboxGetPayload<{ select: typeof INBOX_COLUMNS }>

export const mayManage = (actor: Actor, companyId: string): boolean => can(actor, EMAIL_INBOXES_MANAGE, { companyId })

/** May the person work this inbox's mail: they sort the company's mail and are a member (or set up its inboxes). */
export const mayWork = (context: OfficeContext, inbox: Pick<InboxRow, 'companyId' | 'memberIds'>): boolean =>
  can(actorOf(context), EMAIL_TRIAGE, { companyId: inbox.companyId }) && (inbox.memberIds.includes(context.actorId) || mayManage(actorOf(context), inbox.companyId))

/** May this person (by their live roles now) work a company's mail: ACTIVE, an office user, email.triage over it. */
export async function maySortMail(db: Reader, tenantId: string, userId: string, companyId: string, now: Date): Promise<boolean> {
  const user = isUuid(userId) ? await db.user.findUnique({ where: { id: userId }, select: { status: true, audience: true } }) : null
  if (!user || user.status !== 'ACTIVE' || user.audience !== 'OFFICE') return false
  const grants = sessionGrants({ requireMfa: false }, await heldRoles(db, userId, now), true)
  return can({ audience: 'office', tenantId, grants }, EMAIL_TRIAGE, { companyId })
}

/** The names of some people (display name, else their address's local part). */
export async function namesOf(db: Reader, ids: readonly string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return new Map()
  const rows = await db.user.findMany({ where: { id: { in: unique } }, select: { id: true, displayName: true, email: true } })
  return new Map(rows.map((row) => [row.id, row.displayName?.trim() || row.email.split('@')[0]!]))
}

/** The counts of an inbox's mail now (REJECTED mail is never counted). */
async function countsOf(db: Reader, inboxId: string, me: string, now: Date) {
  const base: Prisma.InboundEmailWhereInput = { teamInboxId: inboxId, status: { not: 'REJECTED' } }
  const open: Prisma.InboundEmailWhereInput = { ...base, closedAt: null, OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: now } }] }
  const [openCount, unassigned, mine, snoozed, followUp] = await Promise.all([
    db.inboundEmail.count({ where: open }),
    db.inboundEmail.count({ where: { ...open, assigneeId: null } }),
    db.inboundEmail.count({ where: { ...open, assigneeId: me } }),
    db.inboundEmail.count({ where: { ...base, closedAt: null, snoozedUntil: { gt: now } } }),
    db.inboundEmail.count({ where: { ...base, followUpUntil: { not: null } } }),
  ])
  return { open: openCount, unassigned, mine, snoozed, followUp }
}

export async function inboxView(db: Reader, context: OfficeContext, row: InboxRow, now: Date, domains: Map<string, string | null> = new Map()): Promise<TeamInboxView> {
  if (!domains.has(row.companyId)) domains.set(row.companyId, await receivingDomainOf(db, row.companyId))
  const domain = domains.get(row.companyId) ?? null
  const names = await namesOf(db, row.memberIds)
  return {
    id: row.id,
    companyId: row.companyId,
    name: row.name,
    localPart: row.localPart,
    address: domain ? `${row.localPart}@${domain}` : null,
    active: row.active,
    members: row.memberIds.map((id) => ({ id, name: names.get(id) ?? '—' })),
    member: row.memberIds.includes(context.actorId),
    counts: await countsOf(db, row.id, context.actorId, now),
    version: row.version,
  }
}

/** GET /email/team-inboxes */
export async function listInboxes(caller: CommandCaller, query: { readonly companyId?: string | undefined; readonly includeOff?: 'true' | 'false' | undefined }) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  const now = serverClock.now()
  return caller.withClient(async (db) => {
    const rows = await db.teamInbox.findMany({
      where: { ...(query.companyId ? { companyId: query.companyId } : {}), ...(query.includeOff === 'true' ? {} : { active: true }) },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      select: INBOX_COLUMNS,
      take: 500,
    })
    const seen = rows.filter((row) => mayWork(context, row))
    const domains = new Map<string, string | null>()
    const inboxes: TeamInboxView[] = []
    for (const row of seen) inboxes.push(await inboxView(db, context, row, now, domains))
    return { inboxes, mayManage: query.companyId ? mayManage(actor, query.companyId) : holds(actor, EMAIL_INBOXES_MANAGE) }
  })
}

/** The problems of an inbox's fields and members (members: ACTIVE office people who sort the company's mail). */
async function fieldProblems(db: Reader, context: OfficeContext, companyId: string, fields: { readonly name?: string | undefined; readonly localPart?: string | undefined; readonly memberIds?: readonly string[] | undefined }, now: Date, members: readonly string[] = []): Promise<Issue[]> {
  const problems: Issue[] = []
  if (fields.name !== undefined) {
    const problem = inboxNameProblem(fields.name)
    if (problem) problems.push({ path: 'body/name', message: problem })
  }
  if (fields.localPart !== undefined) {
    const problem = localPartProblem(fields.localPart)
    if (problem) problems.push({ path: 'body/localPart', message: problem })
  }
  if (fields.memberIds !== undefined) {
    if (new Set(fields.memberIds).size !== fields.memberIds.length) problems.push({ path: 'body/memberIds', message: 'Each person once.' })
    // Only the members it gains are checked: one who lost a role since stays until taken off (the guard checks new ones too).
    for (const [index, userId] of fields.memberIds.entries()) {
      if (!members.includes(userId) && !(await maySortMail(db, context.tenantId, userId, companyId, now))) problems.push({ path: `body/memberIds/${index}`, message: 'An active office person whose roles sort mail of this company.' })
    }
  }
  return problems
}

const refuseProblems = (problems: readonly Issue[]): void => {
  if (problems.length > 0) throw new ValidationError(problems.length === 1 ? problems[0]!.message : 'The team inbox cannot be saved like this.', problems)
}

/** POST /email/team-inboxes */
export async function createInbox(caller: CommandCaller, body: { readonly companyId: string; readonly name: string; readonly localPart: string; readonly memberIds: readonly string[] }, idempotencyKey?: string) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  if (!mayManage(actor, body.companyId)) throw new NotFoundError('Company not found.')
  const now = serverClock.now()
  const name = body.name.trim()
  const localPart = body.localPart.trim().toLowerCase()
  await caller.withClient(async (db) => {
    if (!(await db.company.findUnique({ where: { id: body.companyId }, select: { id: true } }))) throw new NotFoundError('Company not found.')
    const problems = await fieldProblems(db, context, body.companyId, { name, localPart, memberIds: body.memberIds }, now)
    if ((await db.teamInbox.count({ where: { companyId: body.companyId } })) >= TEAM_INBOX_LIMITS.perCompany) problems.push({ path: 'body/companyId', message: `A company keeps at most ${TEAM_INBOX_LIMITS.perCompany} team inboxes.` })
    if (await db.teamInbox.findFirst({ where: { companyId: body.companyId, name }, select: { id: true } })) problems.push({ path: 'body/name', message: 'Another team inbox of this company has this name.' })
    if (await db.teamInbox.findFirst({ where: { companyId: body.companyId, localPart }, select: { id: true } })) problems.push({ path: 'body/localPart', message: 'Another team inbox of this company has this address.' })
    refuseProblems(problems)
  })
  const { result } = await command(caller, { name: 'emailIn.createTeamInbox', idempotencyKey, input: { ...body, name, localPart } }, async (tools) => {
    const id = newId()
    const row = await tools.tx.teamInbox.create({
      data: { id, companyId: body.companyId, name, localPart, memberIds: [...body.memberIds], active: true, createdAt: tools.now, updatedAt: tools.now, createdById: context.actorId },
      select: INBOX_COLUMNS,
    })
    tools.audit({ recordType: 'TeamInbox', recordId: id, companyId: body.companyId, after: { name, localPart, memberIds: row.memberIds, active: true } })
    tools.emit(eventFor(inboxChanged, { subject: id, companyId: body.companyId, payload: { teamInboxId: id, change: 'CREATED' } }))
    return { inbox: await inboxView(tools.tx, context, row, tools.now) }
  }).catch(mailRefusal)
  return result
}

/** PUT /email/team-inboxes/:teamInboxId */
export async function updateInbox(
  caller: CommandCaller,
  inboxId: string,
  body: { readonly version: number; readonly name?: string | undefined; readonly localPart?: string | undefined; readonly memberIds?: readonly string[] | undefined; readonly active?: boolean | undefined },
  idempotencyKey?: string,
) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  const now = serverClock.now()
  const before = isUuid(inboxId) ? await caller.withClient((db) => db.teamInbox.findUnique({ where: { id: inboxId }, select: INBOX_COLUMNS })) : null
  if (!before || !mayManage(actor, before.companyId)) throw new NotFoundError('Team inbox not found.')
  const name = body.name?.trim()
  const localPart = body.localPart?.trim().toLowerCase()
  await caller.withClient(async (db) => {
    const problems = await fieldProblems(db, context, before.companyId, { name, localPart, memberIds: body.memberIds }, now, before.memberIds)
    if (name !== undefined && name !== before.name && (await db.teamInbox.findFirst({ where: { companyId: before.companyId, name, id: { not: before.id } }, select: { id: true } }))) problems.push({ path: 'body/name', message: 'Another team inbox of this company has this name.' })
    if (localPart !== undefined && localPart !== before.localPart && (await db.teamInbox.findFirst({ where: { companyId: before.companyId, localPart, id: { not: before.id } }, select: { id: true } }))) {
      problems.push({ path: 'body/localPart', message: 'Another team inbox of this company has this address.' })
    }
    refuseProblems(problems)
  })
  const { result } = await command(caller, { name: 'emailIn.updateTeamInbox', idempotencyKey, input: { inboxId, ...body }, record: { type: 'TeamInbox', id: inboxId, expectedVersion: body.version } }, async (tools) => {
    const { tx, now: at } = tools
    const current = await tx.teamInbox.findUniqueOrThrow({ where: { id: inboxId }, select: INBOX_COLUMNS })
    const data = {
      ...(name !== undefined && name !== current.name ? { name } : {}),
      ...(localPart !== undefined && localPart !== current.localPart ? { localPart } : {}),
      ...(body.memberIds !== undefined ? { memberIds: [...body.memberIds] } : {}),
      ...(body.active !== undefined && body.active !== current.active ? { active: body.active } : {}),
    }
    const row = await tx.teamInbox.update({ where: { id: inboxId }, data: { ...data, updatedAt: at }, select: INBOX_COLUMNS })
    tools.audit({
      recordType: 'TeamInbox',
      recordId: inboxId,
      companyId: current.companyId,
      before: { name: current.name, localPart: current.localPart, memberIds: current.memberIds, active: current.active },
      after: { name: row.name, localPart: row.localPart, memberIds: row.memberIds, active: row.active },
    })
    const change = body.active === false && current.active ? 'SWITCHED_OFF' : body.active === true && !current.active ? 'SWITCHED_ON' : 'CHANGED'
    tools.emit(eventFor(inboxChanged, { subject: inboxId, companyId: current.companyId, payload: { teamInboxId: inboxId, change } }))
    return { inbox: await inboxView(tx, context, row, at) }
  }).catch(mailRefusal)
  return result
}

/** GET /email/team-inboxes/people: who may be a member or an assignee (ACTIVE office people who sort the company's mail). */
export async function inboxPeople(caller: CommandCaller, companyId: string) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  if (!mayManage(actor, companyId) && !can(actor, EMAIL_TRIAGE, { companyId })) throw new NotFoundError('Company not found.')
  const now = serverClock.now()
  return caller.withClient(async (db) => {
    const users = await db.user.findMany({ where: { status: 'ACTIVE', audience: 'OFFICE' }, orderBy: [{ displayName: 'asc' }, { id: 'asc' }], take: 500, select: { id: true } })
    const people: string[] = []
    for (const user of users) if (await maySortMail(db, context.tenantId, user.id, companyId, now)) people.push(user.id)
    const names = await namesOf(db, people)
    return { people: people.map((id) => ({ id, name: names.get(id) ?? '—' })) }
  })
}
