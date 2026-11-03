import type { Prisma } from '@nexus/factory-db'
import { FILES_UPLOAD } from '@nexus/factory-domain/auth/permissions/catalogue'
import { ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { markMoney } from '@nexus/factory-domain/money/marked'
import { addDays } from '@nexus/factory-domain/safety/calendar/rules'
import { SAFETY_VIEW } from '@nexus/factory-domain/safety/organisation/permissions'
import { SAFETY_RISK_MANAGE } from '@nexus/factory-domain/safety/risk/permissions'
import { farRefusal, isFinal, measureProblems, moveRefusal, OPEN_MEASURE_STATUSES, OWNER_MOVES, PLAN_LAW, RISK_LIMITS, type MeasureSource, type MeasureStatus, type RiskRefusal } from '@nexus/factory-domain/safety/risk/rules'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import { assertMayAt, assertMayWriteAt, assertVersion, bodyIssue, dateOf, dayOrNull, mayAt, officeOf, problemsError, refuse, siteScope, todayOf } from '../organisation/access'
import { MEASURE_SELECT, measureViews, ownersAt, readAssessment, readMeasure, type AssessmentRow, type MeasureRow } from './store'

/**
 * The improvement plan (B-W2b-122; QHS-234; D.Lgs. 81/2008 art. 28 c.2 c-d; design plant.risk "Improvement plan, all sites",
 * the record's Improvement plan tab, the pop-up Add measure), office only, each write one command with an Idempotency-Key:
 *
 *   GET   /safety/risk/measures                every measure the caller reaches (default the open ones), by due day
 *   GET   /safety/risk/measures/:id            one measure with its evidence files
 *   GET   /safety/risk/owners?companyId        who may own one: active office people who read the safety pages there
 *   POST  /safety/risk/measures                add one to an assessment (safety.risk.manage): what, the risk or area, the
 *                                              roles of the site, owner, due, cost (cost grain), where it came from (a DVR
 *                                              version, an incident, an inspection, a meeting)
 *   PATCH /safety/risk/measures/:id            change it (safety.risk.manage); a verified or cancelled one only its note
 *   POST  /safety/risk/measures/:id/status     move it: its owner starts it, sends it back to planned, marks it done (with
 *                                              what was done) or back from done; a manager also verifies or cancels it
 *
 * The evidence files are files of the measure (the generic files routes, record type RiskMeasure). The cost is the cost
 * grain (the contract drops it from an answer and refuses it in a request without money.cost). "Each measure is a task in its
 * owner's My work" is the tasks platform's (see the step's notes). `addMeasureInCommand` is the seam for another step's
 * command (an incident's "Add to improvement plan").
 */

const MANAGE_WORDS = 'The improvement plan of this site is kept by a role that keeps the risk assessment (safety.risk.manage).'

const refuseWith = (refusal: RiskRefusal | null): void => {
  if (refusal) refuse(refusal.code, refusal.message, refusal.field)
}

export type MeasuresView = 'open' | 'overdue' | 'dueSoon' | 'mine' | 'done' | 'cancelled' | 'all'

function viewWhere(view: MeasuresView, context: OfficeContext, today: BusinessDate): Prisma.RiskMeasureWhereInput {
  const open = { status: { in: [...OPEN_MEASURE_STATUSES] } } as Prisma.RiskMeasureWhereInput
  switch (view) {
    case 'overdue':
      return { ...open, dueOn: { lt: dateOf(today) } }
    case 'dueSoon':
      return { ...open, dueOn: { gte: dateOf(today), lte: dateOf(addDays(today, 30)) } }
    case 'mine':
      return { ...open, ownerId: context.actorId }
    case 'done':
      return { status: { in: ['DONE', 'VERIFIED'] } }
    case 'cancelled':
      return { status: 'CANCELLED' }
    case 'all':
      return {}
    default:
      return open
  }
}

/** GET /safety/risk/measures. */
export async function listMeasures(caller: CommandCaller, query: { readonly companyId?: string | undefined; readonly siteId?: string | undefined; readonly assessmentId?: string | undefined; readonly view?: MeasuresView | undefined; readonly limit?: number | undefined }, now: Date = new Date()) {
  const context = officeOf(caller)
  const today = todayOf(now)
  const limit = query.limit ?? RISK_LIMITS.list
  return caller.withClient(async (client) => {
    const rows = (await client.riskMeasure.findMany({
      where: {
        AND: [
          siteScope(context, SAFETY_VIEW) as Prisma.RiskMeasureWhereInput,
          { ...(query.companyId ? { companyId: query.companyId } : {}), ...(query.siteId ? { siteId: query.siteId } : {}), ...(query.assessmentId ? { assessmentId: query.assessmentId } : {}) },
          viewWhere(query.view ?? 'open', context, today),
        ],
      },
      orderBy: [{ dueOn: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }, { id: 'asc' }],
      take: limit + 1,
      select: MEASURE_SELECT,
    })) as MeasureRow[]
    return { measures: await measureViews(client, context, rows.slice(0, limit), today), complete: rows.length <= limit, law: PLAN_LAW, today }
  })
}

/** GET /safety/risk/measures/:measureId. */
export async function measureRecord(caller: CommandCaller, measureId: string, now: Date = new Date()) {
  const context = officeOf(caller)
  return caller.withClient(async (client) => {
    const row = isUuid(measureId) ? await readMeasure(client, measureId) : null
    if (!row) throw new NotFoundError('Measure not found.')
    assertMayAt(context, SAFETY_VIEW, row, 'Measure')
    return { measure: (await measureViews(client, context, [row], todayOf(now)))[0]!, canUpload: mayAt(context, FILES_UPLOAD, { companyId: row.companyId, siteId: null }), today: todayOf(now) }
  })
}

/** GET /safety/risk/owners?companyId. */
export async function measureOwners(caller: CommandCaller, query: { readonly companyId: string }, now: Date = new Date()) {
  const context = officeOf(caller)
  return caller.withClient(async (client) => {
    const company = isUuid(query.companyId) ? await client.company.findUnique({ where: { id: query.companyId }, select: { id: true } }) : null
    if (!company) throw new NotFoundError('Company not found.')
    assertMayAt(context, SAFETY_RISK_MANAGE, { companyId: company.id, siteId: null }, 'Company')
    return { owners: await ownersAt(client, context, company.id, now) }
  })
}

async function checkRoleSheets(tools: Pick<CommandTools, 'tx'>, siteId: string, roleSheetIds: readonly string[]): Promise<void> {
  if (roleSheetIds.length === 0) return
  const found = await tools.tx.roleSheet.count({ where: { id: { in: [...roleSheetIds] }, siteId } })
  if (found !== roleSheetIds.length) refuse('ROLE_SHEET_OTHER_SITE', 'A measure names role sheets of its own site only.', 'roleSheetIds')
}

async function checkOwner(tools: Pick<CommandTools, 'tx' | 'context' | 'now'>, companyId: string, ownerId: string): Promise<void> {
  const owners = await ownersAt(tools.tx, tools.context as OfficeContext, companyId, tools.now)
  if (!owners.some((owner) => owner.id === ownerId)) refuse('OWNER_NOT_ALLOWED', 'The owner is an active office person who reads the safety pages of this company.', 'ownerId')
}

export interface MeasureBody {
  readonly assessmentId: string
  readonly title: string
  readonly risk?: string | null | undefined
  readonly roleSheetIds?: readonly string[] | undefined
  readonly ownerId?: string | null | undefined
  readonly dueOn?: BusinessDate | null | undefined
  readonly cost?: number | null | undefined
  readonly source: MeasureSource
  readonly versionId?: string | null | undefined
  readonly sourceRecordType?: string | null | undefined
  readonly sourceRecordId?: string | null | undefined
  readonly status?: 'PLANNED' | 'IN_PROGRESS' | undefined
  readonly note?: string | null | undefined
}

/**
 * A measure added inside the caller's command (POST /safety/risk/measures, or another step's command: an incident's "Add to
 * improvement plan" names its Incident). The caller checked who may; this checks what the measure says, writes it, its audit
 * row and its event, and answers its id.
 */
export async function addMeasureInCommand(tools: CommandTools, assessment: Pick<AssessmentRow, 'id' | 'companyId' | 'siteId'>, body: MeasureBody, id: string = newId()): Promise<string> {
  const { tx, now } = tools
  const problems = measureProblems(body)
  if (problems.length > 0) throw problemsError(problems, 'The measure is not complete.')
  refuseWith(farRefusal(body.dueOn, todayOf(now), 'dueOn'))
  const roleSheetIds = [...(body.roleSheetIds ?? [])]
  await checkRoleSheets(tools, assessment.siteId, roleSheetIds)
  if (body.ownerId) await checkOwner(tools, assessment.companyId, body.ownerId)
  let versionId: string | null = null
  if (body.source === 'DVR') {
    if (body.versionId) {
      const version = await tx.riskAssessmentVersion.findUnique({ where: { id: body.versionId }, select: { assessmentId: true, status: true } })
      if (!version || version.assessmentId !== assessment.id || version.status === 'WITHDRAWN') refuse('VERSION_OTHER_ASSESSMENT', 'A measure from the DVR names a version of this assessment that was not withdrawn.', 'versionId')
      versionId = body.versionId
    } else {
      const latest = await tx.riskAssessmentVersion.findMany({ where: { assessmentId: assessment.id, status: { in: ['SIGNED', 'AWAITING_SIGNATURES'] } }, orderBy: [{ versionNo: 'desc' }], select: { id: true, status: true } })
      const chosen = latest.find((version) => version.status === 'SIGNED') ?? latest[0]
      if (!chosen) throw bodyIssue('versionId', 'This assessment has no version yet: freeze the DVR first, or name another source.')
      versionId = chosen.id
    }
  }
  if (body.sourceRecordType === 'Incident' && body.sourceRecordId) {
    // The protected schema's incident: only its site is read.
    const incident = await tx.incident.findUnique({ where: { id: body.sourceRecordId }, select: { siteId: true } })
    if (!incident || incident.siteId !== assessment.siteId) refuse('SOURCE_NOT_FOUND', 'The incident is one of this site’s.', 'sourceRecordId')
  }
  if (body.sourceRecordType === 'SafetyDeadline' && body.sourceRecordId) {
    const deadline = await tx.safetyDeadline.findUnique({ where: { id: body.sourceRecordId }, select: { companyId: true, siteId: true } })
    if (!deadline || deadline.companyId !== assessment.companyId || (deadline.siteId !== null && deadline.siteId !== assessment.siteId)) refuse('SOURCE_NOT_FOUND', 'The deadline is one of the safety calendar of this site (or of the whole company).', 'sourceRecordId')
  }
  const status = body.status ?? 'PLANNED'
  const title = body.title.trim()
  await tx.riskMeasure.create({
    data: {
      id,
      companyId: assessment.companyId,
      siteId: assessment.siteId,
      assessmentId: assessment.id,
      title,
      risk: body.risk?.trim() || null,
      roleSheetIds,
      ownerId: body.ownerId ?? null,
      dueOn: body.dueOn ? dateOf(body.dueOn) : null,
      cost: body.cost ?? null,
      status,
      source: body.source,
      versionId,
      sourceRecordType: body.sourceRecordType ?? null,
      sourceRecordId: body.sourceRecordId ?? null,
      note: body.note?.trim() || null,
      createdAt: now,
      updatedAt: now,
      createdById: tools.context.audience === 'office' ? (tools.context as OfficeContext).actorId : null,
    },
    select: { id: true },
  })
  tools.audit({
    action: 'safety.addMeasure',
    recordType: 'RiskMeasure',
    recordId: id,
    companyId: assessment.companyId,
    siteId: assessment.siteId,
    after: { assessmentId: assessment.id, title, risk: body.risk?.trim() || null, roleSheetIds, ownerId: body.ownerId ?? null, dueOn: body.dueOn ?? null, cost: markMoney('cost', body.cost ?? null), status, source: body.source, versionId, sourceRecordType: body.sourceRecordType ?? null, sourceRecordId: body.sourceRecordId ?? null },
  })
  tools.emit({ type: 'risk_measure.changed', subject: id, companyId: assessment.companyId, siteId: assessment.siteId, payload: { measureId: id, assessmentId: assessment.id, change: 'ADDED', status } })
  return id
}

async function viewOf(tools: Pick<CommandTools, 'tx' | 'context' | 'now'>, id: string) {
  return (await measureViews(tools.tx, tools.context as OfficeContext, [(await readMeasure(tools.tx, id))!], todayOf(tools.now)))[0]!
}

/** POST /safety/risk/measures. */
export async function addMeasure(caller: CommandCaller, body: MeasureBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  const assessment = isUuid(body.assessmentId) ? await caller.withClient((client) => readAssessment(client, body.assessmentId)) : null
  if (!assessment) throw bodyIssue('assessmentId', 'Choose a risk assessment of a site you keep.')
  assertMayAt(context, SAFETY_VIEW, assessment, 'Risk assessment')
  assertMayWriteAt(context, SAFETY_RISK_MANAGE, assessment, MANAGE_WORDS)
  const id = newId()
  const { result, replayed } = await command(caller, { name: 'safety.addMeasure', idempotencyKey, input: body }, async (tools) => {
    await addMeasureInCommand(tools, assessment, body, id)
    return { measure: await viewOf(tools, id) }
  })
  return { ...result, replayed }
}

async function lockMeasure(tools: Pick<CommandTools, 'tx'>, measureId: string, version: number): Promise<MeasureRow> {
  await tools.tx.$queryRaw`SELECT "id" FROM "RiskMeasure" WHERE "id" = ${measureId}::uuid FOR UPDATE`
  const row = (await readMeasure(tools.tx, measureId))!
  assertVersion('measure', row.version, version)
  return row
}

async function knownMeasure(caller: CommandCaller, measureId: string): Promise<{ context: OfficeContext; row: MeasureRow }> {
  const context = officeOf(caller)
  const row = isUuid(measureId) ? await caller.withClient((client) => readMeasure(client, measureId)) : null
  if (!row) throw new NotFoundError('Measure not found.')
  assertMayAt(context, SAFETY_VIEW, row, 'Measure')
  return { context, row }
}

export interface MeasureEdit {
  readonly version: number
  readonly title?: string | undefined
  readonly risk?: string | null | undefined
  readonly roleSheetIds?: readonly string[] | undefined
  readonly ownerId?: string | null | undefined
  readonly dueOn?: BusinessDate | null | undefined
  readonly cost?: number | null | undefined
  readonly note?: string | null | undefined
}

/** PATCH /safety/risk/measures/:measureId: its fields while it is not verified or cancelled; its note at any time. */
export async function editMeasure(caller: CommandCaller, measureId: string, body: MeasureEdit, idempotencyKey?: string) {
  const { context, row: seen } = await knownMeasure(caller, measureId)
  assertMayWriteAt(context, SAFETY_RISK_MANAGE, seen, MANAGE_WORDS)
  const problems = measureProblems({ ...(body.title !== undefined ? { title: body.title } : {}), ...(body.risk !== undefined ? { risk: body.risk } : {}), ...(body.roleSheetIds !== undefined ? { roleSheetIds: body.roleSheetIds } : {}), ...(body.cost !== undefined ? { cost: body.cost } : {}) })
  if (problems.length > 0) throw problemsError(problems, 'The measure is not complete.')
  const { result } = await command(caller, { name: 'safety.editMeasure', idempotencyKey, input: { measureId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const row = await lockMeasure(tools, measureId, body.version)
    const fields = (['title', 'risk', 'roleSheetIds', 'ownerId', 'dueOn', 'cost'] as const).filter((field) => body[field] !== undefined)
    if (fields.length > 0 && isFinal(row.status as MeasureStatus)) refuse('MEASURE_FINAL', `This measure is ${row.status === 'VERIFIED' ? 'verified' : 'cancelled'}: only its note changes.`)
    if (body.dueOn !== undefined) refuseWith(farRefusal(body.dueOn, todayOf(now), 'dueOn'))
    if (body.roleSheetIds !== undefined) await checkRoleSheets(tools, row.siteId, body.roleSheetIds)
    if (body.ownerId) await checkOwner(tools, row.companyId, body.ownerId)
    const data: Prisma.RiskMeasureUncheckedUpdateInput = {
      ...(body.title !== undefined ? { title: body.title.trim() } : {}),
      ...(body.risk !== undefined ? { risk: body.risk?.trim() || null } : {}),
      ...(body.roleSheetIds !== undefined ? { roleSheetIds: [...body.roleSheetIds] } : {}),
      ...(body.ownerId !== undefined ? { ownerId: body.ownerId } : {}),
      ...(body.dueOn !== undefined ? { dueOn: body.dueOn ? dateOf(body.dueOn) : null } : {}),
      ...(body.cost !== undefined ? { cost: body.cost } : {}),
      ...(body.note !== undefined ? { note: body.note?.trim() || null } : {}),
    }
    await tx.riskMeasure.update({ where: { id: measureId }, data: { ...data, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    const before = { title: row.title, risk: row.risk, roleSheetIds: row.roleSheetIds, ownerId: row.ownerId, dueOn: dayOrNull(row.dueOn), cost: markMoney('cost', row.cost), note: row.note }
    const after = {
      ...before,
      ...(body.title !== undefined ? { title: body.title.trim() } : {}),
      ...(body.risk !== undefined ? { risk: body.risk?.trim() || null } : {}),
      ...(body.roleSheetIds !== undefined ? { roleSheetIds: [...body.roleSheetIds] } : {}),
      ...(body.ownerId !== undefined ? { ownerId: body.ownerId } : {}),
      ...(body.dueOn !== undefined ? { dueOn: body.dueOn } : {}),
      ...(body.cost !== undefined ? { cost: markMoney('cost', body.cost) } : {}),
      ...(body.note !== undefined ? { note: body.note?.trim() || null } : {}),
    }
    tools.audit({ action: 'safety.editMeasure', recordType: 'RiskMeasure', recordId: measureId, companyId: row.companyId, siteId: row.siteId, before, after })
    tools.emit({ type: 'risk_measure.changed', subject: measureId, companyId: row.companyId, siteId: row.siteId, payload: { measureId, assessmentId: row.assessmentId, change: 'EDITED', status: row.status as MeasureStatus } })
    return { measure: await viewOf(tools, measureId) }
  })
  return result
}

/** POST /safety/risk/measures/:measureId/status: its owner moves it along; a manager also verifies or cancels it. */
export async function moveMeasure(caller: CommandCaller, measureId: string, body: { readonly version: number; readonly status: MeasureStatus; readonly evidenceNote?: string | null | undefined; readonly reason?: string | null | undefined }, idempotencyKey?: string) {
  const { context, row: seen } = await knownMeasure(caller, measureId)
  const mayMove = (row: MeasureRow): void => {
    if (mayAt(context, SAFETY_RISK_MANAGE, row)) return
    if (row.ownerId !== context.actorId) throw new ForbiddenError('A measure is moved by its owner, or by a role that keeps the improvement plan (safety.risk.manage).')
    if (!OWNER_MOVES.includes(body.status)) throw new ForbiddenError('Verifying or cancelling a measure is for a role that keeps the improvement plan (safety.risk.manage).')
  }
  mayMove(seen)
  if (body.status === 'CANCELLED' && !body.reason?.trim()) throw bodyIssue('reason', 'Say why the measure is cancelled.')
  const { result } = await command(caller, { name: 'safety.moveMeasure', idempotencyKey, input: { measureId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const row = await lockMeasure(tools, measureId, body.version)
    mayMove(row)
    const from = row.status as MeasureStatus
    refuseWith(moveRefusal(from, body.status))
    const data: Prisma.RiskMeasureUncheckedUpdateInput =
      body.status === 'DONE'
        ? { status: 'DONE', doneAt: now, doneById: context.actorId, evidenceNote: body.evidenceNote?.trim() || row.evidenceNote }
        : body.status === 'VERIFIED'
          ? { status: 'VERIFIED', verifiedAt: now, verifiedById: context.actorId }
          : body.status === 'CANCELLED'
            ? { status: 'CANCELLED', cancelledAt: now, cancelReason: body.reason!.trim() }
            : { status: body.status, doneAt: null, doneById: null }
    await tx.riskMeasure.update({ where: { id: measureId }, data: { ...data, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    tools.audit({
      action: 'safety.moveMeasure',
      recordType: 'RiskMeasure',
      recordId: measureId,
      companyId: row.companyId,
      siteId: row.siteId,
      before: { status: from },
      after: { status: body.status, ...(body.status === 'DONE' ? { evidenceNote: body.evidenceNote?.trim() || row.evidenceNote } : {}) },
      ...(body.status === 'CANCELLED' ? { reason: body.reason!.trim() } : {}),
    })
    tools.emit({ type: 'risk_measure.changed', subject: measureId, companyId: row.companyId, siteId: row.siteId, payload: { measureId, assessmentId: row.assessmentId, change: 'MOVED', status: body.status } })
    return { measure: await viewOf(tools, measureId) }
  })
  return result
}
