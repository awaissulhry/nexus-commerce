import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { sessionGrants } from '@nexus/factory-domain/auth/roles/roles'
import { FILES_UPLOAD } from '@nexus/factory-domain/auth/permissions/catalogue'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can, type Actor } from '@nexus/factory-domain/core/permissions'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { SAFETY_CALENDAR_MANAGE } from '@nexus/factory-domain/safety/calendar/permissions'
import { addDays, DEADLINE_LIMITS, deadlineProblems, doneRefusal, itemStateOf, nextDueOf, openRefusal, type DeadlineKind, type DeadlineRefusal, type DeadlineStatus, type RepeatUnit } from '@nexus/factory-domain/safety/calendar/rules'
import { SAFETY_VIEW } from '@nexus/factory-domain/safety/organisation/permissions'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import { heldRoles } from '../../../platform/auth/roles/access'
import { userNames } from '../../people/employees/employees'
import { actorIdOf, assertMayAt, assertMayWriteAt, assertVersion, dateOf, dayOf, mayAt, officeOf, problemsError, refuse, todayOf } from '../organisation/access'

/**
 * The deadlines typed on the safety calendar (B-W2b-120; QHS-227; factory-db SafetyDeadline; design plant.calendar pop-ups
 * Add deadline and Deadline), office only, each write one command with an Idempotency-Key, safety.calendar.manage over the
 * deadline's company (and site):
 *
 *   GET   /safety/deadlines/:id          the deadline with its evidence files and the occurrences before it
 *   GET   /safety/deadlines/owners       who may own one at a company: active office people who read the calendar there
 *   POST  /safety/deadlines              add one (title, kind, due, repeat, owner, evidence required)
 *   PATCH /safety/deadlines/:id          change it while open (its note always)
 *   POST  /safety/deadlines/:id/done     done (after its evidence when asked); a repeating one makes its next occurrence in
 *                                        the same command, from its due day (each occurrence keeps its own evidence)
 *   POST  /safety/deadlines/:id/cancel   cancelled with the reason (a repeating one stops repeating)
 *
 * The evidence is a file of the deadline (the generic files routes, record type SafetyDeadline). factory-db's guard holds the
 * same rules for every login (…_safety_w2b_guards: done only with an AVAILABLE file when evidence is asked, one next per
 * occurrence); these answer first, in words.
 */

type Client = FactoryClient | CommandTx

const MANAGE_WORDS = 'The deadlines of this company are kept by a role that keeps the safety calendar (safety.calendar.manage).'

const DEADLINE_SELECT = {
  id: true,
  companyId: true,
  siteId: true,
  title: true,
  kind: true,
  dueOn: true,
  repeatEvery: true,
  repeatUnit: true,
  ownerId: true,
  evidenceRequired: true,
  status: true,
  doneAt: true,
  doneById: true,
  doneNote: true,
  cancelledAt: true,
  cancelReason: true,
  previousId: true,
  note: true,
  version: true,
  company: { select: { code: true, legalName: true } },
  site: { select: { code: true, name: true } },
  next: { select: { id: true }, take: 1 },
} as const satisfies Prisma.SafetyDeadlineSelect
type DeadlineRow = Prisma.SafetyDeadlineGetPayload<{ select: typeof DEADLINE_SELECT }>

const refuseWith = (refusal: DeadlineRefusal | null): void => {
  if (refusal) refuse(refusal.code, refusal.message, refusal.field)
}

async function deadlineViews(client: Client, context: OfficeContext, rows: readonly DeadlineRow[], today: BusinessDate) {
  const files = await client.storedFile.findMany({
    where: { recordType: 'SafetyDeadline', recordId: { in: rows.map((row) => row.id) }, status: 'AVAILABLE' },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true, recordId: true, originalName: true, kind: true, createdAt: true },
  })
  const names = await userNames(client, rows.flatMap((row) => [row.ownerId, row.doneById]))
  return rows.map((row) => {
    const evidence = files.filter((file) => file.recordId === row.id).map((file) => ({ fileId: file.id, name: file.originalName, kind: file.kind, at: file.createdAt.toISOString() }))
    const dueOn = dayOf(row.dueOn)
    return {
      id: row.id,
      companyId: row.companyId,
      company: { code: row.company.code, name: row.company.legalName },
      siteId: row.siteId,
      site: row.site ? { code: row.site.code, name: row.site.name } : null,
      title: row.title,
      kind: row.kind as DeadlineKind,
      dueOn,
      repeatEvery: row.repeatEvery,
      repeatUnit: row.repeatUnit as RepeatUnit | null,
      ownerId: row.ownerId,
      owner: row.ownerId ? (names.get(row.ownerId) ?? null) : null,
      evidenceRequired: row.evidenceRequired,
      evidence,
      status: row.status as DeadlineStatus,
      state: itemStateOf({ dueOn, done: row.status === 'DONE', cancelled: row.status === 'CANCELLED' }, today),
      doneAt: row.doneAt?.toISOString() ?? null,
      doneBy: row.doneById ? (names.get(row.doneById) ?? null) : null,
      doneNote: row.doneNote,
      cancelledAt: row.cancelledAt?.toISOString() ?? null,
      cancelReason: row.cancelReason,
      previousId: row.previousId,
      nextId: row.next[0]?.id ?? null,
      note: row.note,
      version: row.version,
      canManage: mayAt(context, SAFETY_CALENDAR_MANAGE, { companyId: row.companyId, siteId: row.siteId }),
    }
  })
}

const readRow = (client: Client, id: string): Promise<DeadlineRow | null> => client.safetyDeadline.findUnique({ where: { id }, select: DEADLINE_SELECT }) as Promise<DeadlineRow | null>
const viewOf = async (client: Client, context: OfficeContext, id: string, today: BusinessDate) => (await deadlineViews(client, context, [(await readRow(client, id))!], today))[0]!

/** GET /safety/deadlines/:deadlineId. */
export async function deadlineRecord(caller: CommandCaller, deadlineId: string, now: Date = new Date()) {
  const context = officeOf(caller)
  const today = todayOf(now)
  return caller.withClient(async (client) => {
    const row = isUuid(deadlineId) ? await readRow(client, deadlineId) : null
    if (!row) throw new NotFoundError('Deadline not found.')
    assertMayAt(context, SAFETY_VIEW, row, 'Deadline')
    // The occurrences before it (a repeating deadline's history, newest first; at most 20).
    const earlier: { id: string; dueOn: string; status: DeadlineStatus; doneAt: string | null }[] = []
    let previous = row.previousId
    while (previous && earlier.length < 20) {
      const before = await client.safetyDeadline.findUnique({ where: { id: previous }, select: { id: true, dueOn: true, status: true, doneAt: true, previousId: true } })
      if (!before) break
      earlier.push({ id: before.id, dueOn: dayOf(before.dueOn), status: before.status as DeadlineStatus, doneAt: before.doneAt?.toISOString() ?? null })
      previous = before.previousId
    }
    return { deadline: (await deadlineViews(client, context, [row], today))[0]!, earlier, canUpload: mayAt(context, FILES_UPLOAD, { companyId: row.companyId, siteId: null }), today }
  })
}

const MAX_PEOPLE = 500

/** The office people who may own a deadline at a company: ACTIVE, reading the calendar there (safety.view). */
async function ownersAt(client: Client, context: OfficeContext, companyId: string, now: Date) {
  const users = await client.user.findMany({ where: { status: 'ACTIVE' }, orderBy: [{ displayName: 'asc' }, { id: 'asc' }], take: MAX_PEOPLE, select: { id: true, displayName: true } })
  const owners: { id: string; name: string; me: boolean }[] = []
  for (const user of users) {
    const reader: Actor = { audience: 'office', tenantId: context.tenantId, grants: sessionGrants({ requireMfa: false }, await heldRoles(client, user.id, now), true) }
    if (can(reader, SAFETY_VIEW, { companyId })) owners.push({ id: user.id, name: user.displayName, me: user.id === context.actorId })
  }
  return [...owners.filter((owner) => owner.me), ...owners.filter((owner) => !owner.me)]
}

/** GET /safety/deadlines/owners?companyId. */
export async function deadlineOwners(caller: CommandCaller, query: { readonly companyId: string }, now: Date = new Date()) {
  const context = officeOf(caller)
  return caller.withClient(async (client) => {
    const company = isUuid(query.companyId) ? await client.company.findUnique({ where: { id: query.companyId }, select: { id: true } }) : null
    if (!company) throw new NotFoundError('Company not found.')
    assertMayAt(context, SAFETY_CALENDAR_MANAGE, { companyId: company.id, siteId: null }, 'Company')
    return { owners: await ownersAt(client, context, company.id, now) }
  })
}

async function checkOwner(tx: CommandTx, context: OfficeContext, companyId: string, ownerId: string, now: Date): Promise<void> {
  const owners = await ownersAt(tx, context, companyId, now)
  if (!owners.some((owner) => owner.id === ownerId)) refuse('OWNER_NOT_ALLOWED', 'The owner is an active office person who reads the safety calendar of this company.', 'ownerId')
}

const checkDue = (dueOn: BusinessDate, today: BusinessDate): void => {
  if (dueOn > addDays(today, DEADLINE_LIMITS.daysAhead)) refuse('DUE_TOO_FAR', `A deadline is due at most ${DEADLINE_LIMITS.daysAhead} days ahead.`, 'dueOn')
}

export interface DeadlineBody {
  readonly companyId: string
  readonly siteId?: string | null | undefined
  readonly title: string
  readonly kind: DeadlineKind
  readonly dueOn: BusinessDate
  readonly repeatEvery?: number | null | undefined
  readonly repeatUnit?: RepeatUnit | null | undefined
  readonly ownerId?: string | null | undefined
  readonly evidenceRequired: boolean
  readonly note?: string | undefined
}

/** POST /safety/deadlines. */
export async function addDeadline(caller: CommandCaller, body: DeadlineBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  const place = { companyId: body.companyId, siteId: body.siteId ?? null }
  assertMayWriteAt(context, SAFETY_CALENDAR_MANAGE, place, MANAGE_WORDS)
  const problems = deadlineProblems(body)
  if (problems.length > 0) throw problemsError(problems, 'The deadline is not complete.')
  const id = newId()
  const { result, replayed } = await command(caller, { name: 'safety.addDeadline', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    const today = todayOf(now)
    checkDue(body.dueOn, today)
    if (place.siteId) {
      const site = await tx.site.findUnique({ where: { id: place.siteId }, select: { companyId: true } })
      if (!site || site.companyId !== body.companyId) refuse('SITE_OTHER_COMPANY', 'The site is one of the company’s sites (or the whole company).', 'siteId')
    }
    if (body.ownerId) await checkOwner(tx, tools.context as OfficeContext, body.companyId, body.ownerId, now)
    const actorId = actorIdOf(tools.context)
    await tx.safetyDeadline.create({
      data: {
        id,
        companyId: body.companyId,
        siteId: place.siteId,
        title: body.title.trim(),
        kind: body.kind,
        dueOn: dateOf(body.dueOn),
        repeatEvery: body.repeatEvery ?? null,
        repeatUnit: body.repeatUnit ?? null,
        ownerId: body.ownerId ?? null,
        evidenceRequired: body.evidenceRequired,
        note: body.note?.trim() || null,
        createdAt: now,
        updatedAt: now,
        createdById: actorId,
      },
      select: { id: true },
    })
    tools.audit({ action: 'safety.addDeadline', recordType: 'SafetyDeadline', recordId: id, companyId: body.companyId, siteId: place.siteId, after: { title: body.title.trim(), kind: body.kind, dueOn: body.dueOn, repeatEvery: body.repeatEvery ?? null, repeatUnit: body.repeatUnit ?? null, ownerId: body.ownerId ?? null, evidenceRequired: body.evidenceRequired } })
    tools.emit({ type: 'safety_deadline.changed', subject: id, companyId: body.companyId, siteId: place.siteId, payload: { deadlineId: id, kind: body.kind, change: 'ADDED', nextId: null } })
    return { deadline: await viewOf(tx, tools.context as OfficeContext, id, today) }
  })
  return { ...result, replayed }
}

async function writable(caller: CommandCaller, deadlineId: string): Promise<DeadlineRow> {
  const context = officeOf(caller)
  const row = isUuid(deadlineId) ? await caller.withClient((client) => readRow(client, deadlineId)) : null
  if (!row) throw new NotFoundError('Deadline not found.')
  assertMayAt(context, SAFETY_VIEW, row, 'Deadline')
  assertMayWriteAt(context, SAFETY_CALENDAR_MANAGE, row, MANAGE_WORDS)
  return row
}

async function locked(tools: CommandTools, deadlineId: string, version: number): Promise<DeadlineRow> {
  await tools.tx.$queryRaw`SELECT "id" FROM "SafetyDeadline" WHERE "id" = ${deadlineId}::uuid FOR UPDATE`
  const row = (await readRow(tools.tx, deadlineId))!
  assertVersion('deadline', row.version, version)
  return row
}

export interface DeadlineEdit {
  readonly version: number
  readonly title?: string | undefined
  readonly dueOn?: BusinessDate | undefined
  readonly repeatEvery?: number | null | undefined
  readonly repeatUnit?: RepeatUnit | null | undefined
  readonly ownerId?: string | null | undefined
  readonly evidenceRequired?: boolean | undefined
  readonly note?: string | null | undefined
}

/** PATCH /safety/deadlines/:deadlineId: while open, its fields; its note at any time. */
export async function editDeadline(caller: CommandCaller, deadlineId: string, body: DeadlineEdit, idempotencyKey?: string) {
  await writable(caller, deadlineId)
  const { result } = await command(caller, { name: 'safety.editDeadline', idempotencyKey, input: { deadlineId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const row = await locked(tools, deadlineId, body.version)
    const today = todayOf(now)
    const fields = (['title', 'dueOn', 'repeatEvery', 'repeatUnit', 'ownerId', 'evidenceRequired'] as const).filter((field) => body[field] !== undefined)
    if (fields.length > 0) refuseWith(openRefusal(row.status as DeadlineStatus))
    const repeatEvery = body.repeatEvery !== undefined ? body.repeatEvery : row.repeatEvery
    const repeatUnit = body.repeatUnit !== undefined ? body.repeatUnit : (row.repeatUnit as RepeatUnit | null)
    const problems = deadlineProblems({ ...(body.title !== undefined ? { title: body.title } : {}), repeatEvery, repeatUnit })
    if (problems.length > 0) throw problemsError(problems, 'The deadline is not complete.')
    if (body.dueOn !== undefined) checkDue(body.dueOn, today)
    if (body.ownerId) await checkOwner(tx, tools.context as OfficeContext, row.companyId, body.ownerId, now)
    const data: Prisma.SafetyDeadlineUncheckedUpdateInput = {
      ...(body.title !== undefined ? { title: body.title.trim() } : {}),
      ...(body.dueOn !== undefined ? { dueOn: dateOf(body.dueOn) } : {}),
      ...(body.repeatEvery !== undefined || body.repeatUnit !== undefined ? { repeatEvery, repeatUnit } : {}),
      ...(body.ownerId !== undefined ? { ownerId: body.ownerId } : {}),
      ...(body.evidenceRequired !== undefined ? { evidenceRequired: body.evidenceRequired } : {}),
      ...(body.note !== undefined ? { note: body.note?.trim() || null } : {}),
    }
    await tx.safetyDeadline.update({ where: { id: deadlineId }, data: { ...data, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    const before = { title: row.title, dueOn: dayOf(row.dueOn), repeatEvery: row.repeatEvery, repeatUnit: row.repeatUnit, ownerId: row.ownerId, evidenceRequired: row.evidenceRequired, note: row.note }
    tools.audit({ action: 'safety.editDeadline', recordType: 'SafetyDeadline', recordId: deadlineId, companyId: row.companyId, siteId: row.siteId, before, after: { ...before, ...Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'version')) } })
    tools.emit({ type: 'safety_deadline.changed', subject: deadlineId, companyId: row.companyId, siteId: row.siteId, payload: { deadlineId, kind: row.kind as DeadlineKind, change: 'EDITED', nextId: null } })
    return { deadline: await viewOf(tx, tools.context as OfficeContext, deadlineId, today) }
  })
  return result
}

/** POST /safety/deadlines/:deadlineId/done: done; a repeating one makes its next occurrence in the same command. */
export async function markDone(caller: CommandCaller, deadlineId: string, body: { readonly version: number; readonly note?: string | undefined }, idempotencyKey?: string) {
  await writable(caller, deadlineId)
  const nextId = newId()
  const { result } = await command(caller, { name: 'safety.deadlineDone', idempotencyKey, input: { deadlineId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const row = await locked(tools, deadlineId, body.version)
    const today = todayOf(now)
    const evidenceOnFile = (await tx.storedFile.count({ where: { recordType: 'SafetyDeadline', recordId: deadlineId, status: 'AVAILABLE' } })) > 0
    refuseWith(doneRefusal({ status: row.status as DeadlineStatus, evidenceRequired: row.evidenceRequired, evidenceOnFile }))
    const actorId = actorIdOf(tools.context)
    await tx.safetyDeadline.update({ where: { id: deadlineId }, data: { status: 'DONE', doneAt: now, doneById: actorId, doneNote: body.note?.trim() || null, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    tools.audit({ action: 'safety.deadlineDone', recordType: 'SafetyDeadline', recordId: deadlineId, companyId: row.companyId, siteId: row.siteId, before: { status: row.status }, after: { status: 'DONE', evidenceOnFile, note: body.note?.trim() || null } })
    let next = null
    if (row.repeatEvery !== null && row.repeatUnit !== null) {
      const dueOn = nextDueOf(dayOf(row.dueOn), row.repeatEvery, row.repeatUnit as RepeatUnit)
      await tx.safetyDeadline.create({
        data: { id: nextId, companyId: row.companyId, siteId: row.siteId, title: row.title, kind: row.kind, dueOn: dateOf(dueOn), repeatEvery: row.repeatEvery, repeatUnit: row.repeatUnit, ownerId: row.ownerId, evidenceRequired: row.evidenceRequired, previousId: row.id, createdAt: now, updatedAt: now, createdById: actorId },
        select: { id: true },
      })
      tools.audit({ action: 'safety.addDeadline', recordType: 'SafetyDeadline', recordId: nextId, companyId: row.companyId, siteId: row.siteId, after: { previousId: row.id, dueOn, repeatEvery: row.repeatEvery, repeatUnit: row.repeatUnit } })
      next = await viewOf(tx, tools.context as OfficeContext, nextId, today)
    }
    tools.emit({ type: 'safety_deadline.changed', subject: deadlineId, companyId: row.companyId, siteId: row.siteId, payload: { deadlineId, kind: row.kind as DeadlineKind, change: 'DONE', nextId: next ? nextId : null } })
    return { deadline: await viewOf(tx, tools.context as OfficeContext, deadlineId, today), next }
  })
  return result
}

/** POST /safety/deadlines/:deadlineId/cancel: with the reason (a repeating one stops repeating). */
export async function cancelDeadline(caller: CommandCaller, deadlineId: string, body: { readonly version: number; readonly reason: string }, idempotencyKey?: string) {
  await writable(caller, deadlineId)
  const { result } = await command(caller, { name: 'safety.cancelDeadline', idempotencyKey, input: { deadlineId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const row = await locked(tools, deadlineId, body.version)
    refuseWith(openRefusal(row.status as DeadlineStatus))
    await tx.safetyDeadline.update({ where: { id: deadlineId }, data: { status: 'CANCELLED', cancelledAt: now, cancelReason: body.reason.trim(), version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    tools.audit({ action: 'safety.cancelDeadline', recordType: 'SafetyDeadline', recordId: deadlineId, companyId: row.companyId, siteId: row.siteId, before: { status: row.status }, after: { status: 'CANCELLED' }, reason: body.reason })
    tools.emit({ type: 'safety_deadline.changed', subject: deadlineId, companyId: row.companyId, siteId: row.siteId, payload: { deadlineId, kind: row.kind as DeadlineKind, change: 'CANCELLED', nextId: null } })
    return { deadline: await viewOf(tx, tools.context as OfficeContext, deadlineId, todayOf(now)) }
  })
  return result
}

