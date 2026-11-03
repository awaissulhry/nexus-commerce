import type { Prisma } from '@nexus/factory-db'
import { ForbiddenError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { canonicalJson } from '@nexus/factory-domain/accounting/manifest'
import type { PlanChange } from '@nexus/factory-domain/quality-plans/events'
import {
  approvalSha256,
  approverRefusal,
  checkContentOf,
  checksProblems,
  contentProblems,
  PLAN_LIMITS,
  planDraftProblems,
  samplingProblems,
  type CheckContent,
  type CheckDraft,
  type Chip,
  type PlanStage,
  type SamplingDraft,
  type VersionStatus,
} from '@nexus/factory-domain/quality/plans/rules'
import { missingStarterPlans, STARTER_CODES, starterPlan, type StarterPlan } from '@nexus/factory-domain/quality/plans/starter'
import { command, StaleVersionError, type CommandCaller, type CommandTools } from '../../../core/command'
import { planRecordIn } from './plans'
import {
  assertManage,
  contentOfCheck,
  editorsOf,
  mayApprove,
  mayView,
  officeOf,
  PLAN_COLUMNS,
  PLAN_RECORD,
  PlanRefusedError,
  readChecks,
  readPlan,
  readVersion,
  samplingOf,
  VERSION_COLUMNS,
  VERSION_RECORD,
  versionFacts,
  versionView,
  type Db,
  type PlanDbRow,
  type VersionDbRow,
} from './store'

/**
 * The inspection plans' writes (B-W2b-92; QHS-008, QHS-009, QHS-016): one command() each with an Idempotency-Key, an audit
 * row per record it changes and one `inspection_plan.changed` (or `.version_approved`).
 *
 *   POST  /quality/plans                                  a plan with its version 1 DRAFT: blank, from the starter set or a
 *                                                         copy of a version; code and stage fixed from now on
 *   PATCH /quality/plans/:planId                          name, owner, where it applies (at the plan's version)
 *   POST  /quality/plans/:planId/versions                 the next DRAFT, copied from the approved version (or the one
 *                                                         named); one draft at a time
 *   PUT   /quality/plans/:planId/versions/:versionId      the builder's save of a DRAFT: change note, sampling, the whole
 *                                                         list of checks in order (codes kept, added, removed)
 *   POST  …/submit                                        the author asks for approval: the draft must be approvable
 *   POST  …/approve                                       a second person approves (step-up, in routes.ts): never the author
 *                                                         nor anyone who saved a change to the draft (QHS-016); the version
 *                                                         in force is retired first, then this one APPROVED with the
 *                                                         SHA-256 of what was signed, all in one transaction
 *   POST  …/retire                                        a draft nobody wants, or the version in force (refused while a
 *                                                         rule of "When inspections are created" still uses the plan)
 *   POST  /quality/plans/starter                          the starter plans the company lacks, each a DRAFT v1
 *
 * A version row is locked FOR UPDATE and its version compared inside the command (not command()'s record guard: a retired
 * or approved version refuses the bare version bump, and a refusal must be in words). Locks, in order: the company's plan
 * list (advisory, new plans), the plan row, the version row.
 */

type Tools = CommandTools
const asDb = (tx: Tools['tx']): Db => tx
/** The office person the command runs for (every write here is the office's). */
const actorIdOf = (tools: Pick<Tools, 'context'>): string => officeOf({ factoryContext: tools.context }).actorId

const refuse = (problems: readonly Issue[], words: string, prefix = 'body'): never => {
  throw new ValidationError(problems.length === 1 ? problems[0]!.message : words, problems.map((problem) => ({ ...problem, path: `${prefix}/${problem.path}` })))
}

const lockCompanyPlans = (tx: Tools['tx'], companyId: string) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.inspection-plans', current_setting('factory.tenant_id', true), ${companyId}::text), 0))`

const changed = (tools: Tools, plan: Pick<PlanDbRow, 'id' | 'companyId' | 'code' | 'stage'>, change: PlanChange, version: Pick<VersionDbRow, 'id' | 'number'> | null) =>
  tools.emit({ type: 'inspection_plan.changed', subject: plan.id, companyId: plan.companyId, siteId: null, payload: { planId: plan.id, code: plan.code, stage: plan.stage, change, versionId: version?.id ?? null, number: version?.number ?? null } })

const auditedPlan = (plan: Pick<PlanDbRow, 'code' | 'stage' | 'name' | 'ownerId' | 'appliesTo'>) => ({ code: plan.code, stage: plan.stage, name: plan.name, ownerId: plan.ownerId, appliesTo: plan.appliesTo })
const auditedVersion = (row: VersionDbRow, checks?: readonly CheckContent[]) => ({
  number: row.number,
  status: row.status,
  changeNote: row.changeNote,
  sampling: samplingOf(row),
  ...(checks ? { checks: checks.map((check) => check.code) } : {}),
})

/** The version row, locked, at the version the caller read. */
async function lockVersion(tx: Tools['tx'], plan: Pick<PlanDbRow, 'id'>, versionId: string, expected: number): Promise<VersionDbRow> {
  const [locked] = await tx.$queryRaw<{ version: number }[]>`SELECT "version" FROM "InspectionPlanVersion" WHERE "id" = ${versionId}::uuid AND "planId" = ${plan.id}::uuid FOR UPDATE`
  if (!locked) throw new NotFoundError('Plan version not found.')
  if (locked.version !== expected) throw new StaleVersionError('InspectionPlanVersion', versionId, locked.version, expected)
  return (await tx.inspectionPlanVersion.findUnique({ where: { id: versionId }, select: VERSION_COLUMNS }))!
}

const lockPlanRow = (tx: Tools['tx'], planId: string) => tx.$queryRaw`SELECT 1 FROM "InspectionPlan" WHERE "id" = ${planId}::uuid FOR UPDATE`

function notDraft(row: VersionDbRow): PlanRefusedError {
  return row.status === 'APPROVED'
    ? new PlanRefusedError('NOT_DRAFT', `Version ${row.number} is approved: it is frozen with its checks (QHS-016). Draft a new version to change it.`)
    : new PlanRefusedError('NOT_DRAFT', `Version ${row.number} is retired: a retired version never changes.`)
}

// ---- references --------------------------------------------------------------------------------------------------------

/** The records the chips name exist, are the company's own or the group's, and play the part (a supplier, a customer). */
async function chipRefsProblems(db: Pick<Db, 'style' | 'item' | 'party' | 'operation'>, companyId: string, chips: readonly Chip[]): Promise<Issue[]> {
  const problems: Issue[] = []
  const ours = (row: { companyId: string | null } | null | undefined) => !!row && (row.companyId === null || row.companyId === companyId)
  for (const [index, chip] of chips.entries()) {
    const at = `appliesTo/${index}/value`
    if (chip.kind === 'CATEGORY' || !isUuid(chip.value)) continue
    if (chip.kind === 'STYLE' && !ours(await db.style.findUnique({ where: { id: chip.value }, select: { companyId: true } }))) problems.push({ path: at, message: 'Not a style of this company.' })
    if (chip.kind === 'MATERIAL' && !ours(await db.item.findUnique({ where: { id: chip.value }, select: { companyId: true } }))) problems.push({ path: at, message: 'Not a material of this company.' })
    if (chip.kind === 'OPERATION' && !ours(await db.operation.findUnique({ where: { id: chip.value }, select: { companyId: true } }))) problems.push({ path: at, message: 'Not an operation of this company.' })
    if (chip.kind === 'SUPPLIER' || chip.kind === 'CUSTOMER') {
      const party = await db.party.findUnique({ where: { id: chip.value }, select: { roles: true } })
      const roles: readonly string[] = party?.roles ?? []
      if (chip.kind === 'SUPPLIER' && !roles.includes('SUPPLIER') && !roles.includes('SUBCONTRACTOR')) problems.push({ path: at, message: 'Not a supplier.' })
      if (chip.kind === 'CUSTOMER' && !roles.includes('CUSTOMER') && !roles.includes('BRAND')) problems.push({ path: at, message: 'Not a customer or a brand.' })
    }
  }
  return problems
}

async function ownerProblems(db: Pick<Db, 'user'>, ownerId: string | null | undefined): Promise<Issue[]> {
  if (!ownerId) return []
  const user = await db.user.findUnique({ where: { id: ownerId }, select: { status: true } })
  return user?.status === 'ACTIVE' ? [] : [{ path: 'ownerId', message: 'Pick an active person of the office.' }]
}

/** A profile the version names: the plan's company's and in use (B-W2b-93 keeps them). */
async function profileProblems(db: Pick<Db, 'aqlProfile'>, companyId: string, profileId: string | null | undefined): Promise<Issue[]> {
  if (!profileId) return []
  const profile = await db.aqlProfile.findUnique({ where: { id: profileId }, select: { companyId: true, active: true, code: true } })
  if (!profile || profile.companyId !== companyId) return [{ path: 'sampling/aqlProfileId', message: 'Not an AQL profile of this company.' }]
  if (!profile.active) return [{ path: 'sampling/aqlProfileId', message: `AQL profile ${profile.code} is retired: pick one in use.` }]
  return []
}

// ---- writing a version's content ---------------------------------------------------------------------------------------

const samplingData = (sampling: SamplingDraft) => ({
  samplingMethod: sampling.samplingMethod,
  aqlProfileId: sampling.samplingMethod === 'AQL_PROFILE' ? (sampling.aqlProfileId ?? null) : null,
  fixedSampleSize: sampling.samplingMethod === 'FIXED' ? (sampling.fixedSampleSize ?? null) : null,
  frequency: sampling.frequency ?? null,
  frequencyValue: sampling.frequency ? (sampling.frequencyValue ?? null) : null,
  stopAtReject: sampling.stopAtReject ?? null,
})

const checkData = (check: CheckContent) => ({
  labelIt: check.labelIt,
  labelEn: check.labelEn,
  labelI18n: { ...check.labelI18n },
  type: check.type,
  checkClass: check.checkClass,
  mandatory: check.mandatory,
  photoRequired: check.photoRequired,
  nominal: check.nominal,
  tolerance: check.tolerance,
  uom: check.uom,
  choices: [...check.choices],
})

/** The draft's checks become this list, in this order: codes kept are updated in place, new ones added, the rest removed. */
async function writeChecks(tools: Tools, versionId: string, list: readonly CheckContent[]): Promise<void> {
  const { tx, now } = tools
  const existing = new Map((await readChecks(asDb(tx), [versionId])).map((row) => [row.code, row] as const))
  const keep = new Set(list.map((check) => check.code))
  for (const row of existing.values()) if (!keep.has(row.code)) await tx.inspectionPlanCheck.delete({ where: { id: row.id }, select: { id: true } })
  for (const [index, check] of list.entries()) {
    const sortOrder = (index + 1) * 10
    const old = existing.get(check.code)
    if (old) {
      const before = contentOfCheck(old)
      if (old.sortOrder === sortOrder && canonicalJson(checkData(before)) === canonicalJson(checkData(check))) continue
      await tx.inspectionPlanCheck.update({ where: { id: old.id }, data: { ...checkData(check), sortOrder, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    } else {
      await tx.inspectionPlanCheck.create({ data: { id: newId(), planVersionId: versionId, code: check.code, sortOrder, ...checkData(check), createdAt: now, updatedAt: now, createdById: actorIdOf(tools) }, select: { id: true } })
    }
  }
}

/** A new version row, DRAFT, with its sampling and checks. */
async function createVersion(tools: Tools, plan: Pick<PlanDbRow, 'id' | 'companyId'>, number: number, content: { sampling: SamplingDraft; checks: readonly CheckContent[]; changeNote: string | null }): Promise<VersionDbRow> {
  const { tx, now } = tools
  const id = newId()
  const actorId = actorIdOf(tools)
  const row = await tx.inspectionPlanVersion.create({
    data: { id, companyId: plan.companyId, planId: plan.id, number, status: 'DRAFT', changeNote: content.changeNote, authorId: actorId, ...samplingData(content.sampling), createdAt: now, updatedAt: now, createdById: actorId },
    select: VERSION_COLUMNS,
  })
  await writeChecks(tools, id, content.checks)
  return row
}

const starterContent = (starter: StarterPlan) => ({ sampling: starter.sampling, checks: starter.checks.map(checkContentOf), changeNote: null })

// ---- a new plan --------------------------------------------------------------------------------------------------------

export interface CreatePlanBody {
  readonly companyId: string
  readonly code: string
  readonly stage: PlanStage
  readonly name: string
  readonly ownerId?: string | null | undefined
  readonly appliesTo?: readonly Chip[] | undefined
  readonly startFrom?: { readonly kind: 'BLANK' } | { readonly kind: 'STARTER'; readonly code: string } | { readonly kind: 'COPY'; readonly versionId: string } | undefined
}

/** POST /quality/plans. */
export async function createPlan(caller: CommandCaller, body: CreatePlanBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  assertManage(context, body.companyId)
  const code = body.code.trim().toUpperCase()
  const appliesTo = body.appliesTo ?? []
  const problems = planDraftProblems({ code, name: body.name, appliesTo }, true)
  if (problems.length > 0) refuse(problems, 'The plan is not valid.')
  const start = body.startFrom ?? { kind: 'BLANK' as const }
  const content = await caller.withClient(async (client) => {
    const db = client as unknown as Db
    const found = [...(await chipRefsProblems(db, body.companyId, appliesTo)), ...(await ownerProblems(db, body.ownerId))]
    if (found.length > 0) refuse(found, 'The plan is not valid.')
    if (start.kind === 'STARTER') {
      const starter = starterPlan(start.code)
      if (!starter) refuse([{ path: 'startFrom/code', message: `Not a plan of the starter set: ${STARTER_CODES.join(', ')}.` }], 'Not a starter plan.')
      if (starter!.stage !== body.stage) refuse([{ path: 'startFrom/code', message: `${starter!.code} is a plan of another stage.` }], 'Not a starter plan of this stage.')
      return starterContent(starter!)
    }
    if (start.kind === 'COPY') {
      const source = await db.inspectionPlanVersion.findUnique({ where: { id: start.versionId }, select: VERSION_COLUMNS })
      if (!source || !mayView(context, source.companyId)) throw new NotFoundError('The version to copy was not found.')
      const checks = (await readChecks(db, [source.id])).map(contentOfCheck)
      const sampling = samplingOf(source)
      // Another company's profile is not this company's: the copy takes the one that applies.
      return { sampling: source.companyId === body.companyId ? sampling : { ...sampling, aqlProfileId: null }, checks, changeNote: null }
    }
    return { sampling: { samplingMethod: 'AQL_PROFILE' as const }, checks: [] as CheckContent[], changeNote: null }
  })
  const planId = newId()
  const { result } = await command(caller, { name: 'quality.createPlan', idempotencyKey, input: { ...body, code } }, async (tools) => {
    const { tx, now } = tools
    await lockCompanyPlans(tx, body.companyId)
    if ((await tx.inspectionPlan.count({ where: { companyId: body.companyId } })) >= PLAN_LIMITS.plansPerCompany) throw new PlanRefusedError('TOO_MANY', `A company keeps at most ${PLAN_LIMITS.plansPerCompany} plans: retire the old ones' versions and reuse their codes.`)
    if (await tx.inspectionPlan.findFirst({ where: { companyId: body.companyId, code }, select: { id: true } })) throw new PlanRefusedError('CODE_TAKEN', `Plan code ${code} is taken in this company.`, [{ path: 'body/code', message: 'Taken.' }])
    const plan = await tx.inspectionPlan.create({
      data: { id: planId, companyId: body.companyId, code, stage: body.stage, name: body.name.trim(), ownerId: body.ownerId ?? null, appliesTo: appliesTo.map((chip) => ({ kind: chip.kind, value: chip.value })), createdAt: now, updatedAt: now, createdById: context.actorId },
      select: PLAN_COLUMNS,
    })
    const version = await createVersion(tools, plan, 1, content)
    tools.audit({ recordType: PLAN_RECORD, recordId: plan.id, companyId: plan.companyId, after: { ...auditedPlan(plan), startFrom: start } })
    tools.audit({ recordType: VERSION_RECORD, recordId: version.id, companyId: plan.companyId, after: auditedVersion(version, content.checks) })
    changed(tools, plan, 'CREATED', version)
    return { planId: plan.id }
  })
  // A repeated key answers the plan its first request made.
  return caller.withClient((client) => planRecordIn(client as unknown as Db, context, result.planId))
}

// ---- name, owner, where it applies ---------------------------------------------------------------------------------------

export interface EditPlanBody {
  readonly version: number
  readonly name?: string | undefined
  readonly ownerId?: string | null | undefined
  readonly appliesTo?: readonly Chip[] | undefined
}

/** PATCH /quality/plans/:planId. */
export async function editPlan(caller: CommandCaller, planId: string, body: EditPlanBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  const before = await caller.withClient((client) => readPlan(client as unknown as Db, context, planId))
  assertManage(context, before.companyId)
  const problems = planDraftProblems({ name: body.name, appliesTo: body.appliesTo }, false)
  if (problems.length > 0) refuse(problems, 'The change is not valid.')
  await caller.withClient(async (client) => {
    const db = client as unknown as Db
    const found = [...(body.appliesTo ? await chipRefsProblems(db, before.companyId, body.appliesTo) : []), ...(body.ownerId !== undefined ? await ownerProblems(db, body.ownerId) : [])]
    if (found.length > 0) refuse(found, 'The change is not valid.')
  })
  await command(caller, { name: 'quality.editPlan', idempotencyKey, input: { planId, ...body }, record: { type: 'InspectionPlan', id: before.id, expectedVersion: body.version } }, async (tools) => {
    const { tx, now } = tools
    const current = (await tx.inspectionPlan.findUnique({ where: { id: before.id }, select: PLAN_COLUMNS }))!
    const data: Prisma.InspectionPlanUncheckedUpdateInput = { updatedAt: now }
    if (body.name !== undefined) data.name = body.name.trim()
    if (body.ownerId !== undefined) data.ownerId = body.ownerId
    if (body.appliesTo !== undefined) data.appliesTo = body.appliesTo.map((chip) => ({ kind: chip.kind, value: chip.value }))
    const after = await tx.inspectionPlan.update({ where: { id: current.id }, data, select: PLAN_COLUMNS })
    tools.audit({ recordType: PLAN_RECORD, recordId: after.id, companyId: after.companyId, before: auditedPlan(current), after: auditedPlan(after) })
    changed(tools, after, 'EDITED', null)
    return { planId: after.id }
  })
  return caller.withClient((client) => planRecordIn(client as unknown as Db, context, planId))
}

// ---- the next draft ----------------------------------------------------------------------------------------------------

export interface DraftBody {
  readonly version: number
  readonly fromVersionId?: string | undefined
  readonly changeNote?: string | null | undefined
}

/** POST /quality/plans/:planId/versions. */
export async function draftVersion(caller: CommandCaller, planId: string, body: DraftBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  const plan = await caller.withClient((client) => readPlan(client as unknown as Db, context, planId))
  assertManage(context, plan.companyId)
  const note = body.changeNote?.trim() || null
  if (note && note.length > PLAN_LIMITS.changeNote) refuse([{ path: 'changeNote', message: `At most ${PLAN_LIMITS.changeNote} characters.` }], 'The change note is too long.')
  const { result } = await command(caller, { name: 'quality.draftPlanVersion', idempotencyKey, input: { planId, ...body }, record: { type: 'InspectionPlan', id: plan.id, expectedVersion: body.version } }, async (tools) => {
    const { tx } = tools
    const versions = await tx.inspectionPlanVersion.findMany({ where: { planId: plan.id }, select: VERSION_COLUMNS, orderBy: { number: 'desc' } })
    const open = versions.find((row) => row.status === 'DRAFT')
    if (open) throw new PlanRefusedError('DRAFT_EXISTS', `Version ${open.number} is being written already: change it, or retire it first.`)
    const source = body.fromVersionId ? versions.find((row) => row.id === body.fromVersionId) : (versions.find((row) => row.status === 'APPROVED') ?? versions[0])
    if (body.fromVersionId && !source) refuse([{ path: 'fromVersionId', message: 'Not a version of this plan.' }], 'Not a version of this plan.')
    const checks = source ? (await readChecks(asDb(tx), [source.id])).map(contentOfCheck) : []
    const sampling: SamplingDraft = source ? samplingOf(source) : { samplingMethod: 'AQL_PROFILE' }
    // A retired profile is not carried into a new draft: the one that applies until another is named.
    const profile = sampling.aqlProfileId ? await tx.aqlProfile.findUnique({ where: { id: sampling.aqlProfileId }, select: { active: true } }) : null
    const number = (versions[0]?.number ?? 0) + 1
    const row = await createVersion(tools, plan, number, { sampling: profile && !profile.active ? { ...sampling, aqlProfileId: null } : sampling, checks, changeNote: note })
    tools.audit({ recordType: VERSION_RECORD, recordId: row.id, companyId: plan.companyId, after: { ...auditedVersion(row, checks), from: source ? source.number : null } })
    changed(tools, plan, 'VERSION_DRAFTED', row)
    const facts = await versionFacts(asDb(tx), [row], row.id)
    return { version: versionView(row, facts) }
  })
  return result
}

// ---- the builder's save ------------------------------------------------------------------------------------------------

export interface SaveBody {
  readonly version: number
  readonly changeNote?: string | null | undefined
  readonly sampling?: SamplingDraft | undefined
  readonly checks?: readonly CheckDraft[] | undefined
}

/** PUT /quality/plans/:planId/versions/:versionId. */
export async function saveVersion(caller: CommandCaller, planId: string, versionId: string, body: SaveBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  const { plan, before } = await caller.withClient(async (client) => {
    const db = client as unknown as Db
    const plan = await readPlan(db, context, planId)
    return { plan, before: await readVersion(db, plan, versionId) }
  })
  assertManage(context, plan.companyId)
  if (before.status !== 'DRAFT') throw notDraft(before)
  const problems: Issue[] = []
  const note = body.changeNote === undefined ? undefined : body.changeNote?.trim() || null
  if (note && note.length > PLAN_LIMITS.changeNote) problems.push({ path: 'changeNote', message: `At most ${PLAN_LIMITS.changeNote} characters.` })
  if (body.checks) problems.push(...checksProblems(body.checks))
  if (body.sampling) problems.push(...samplingProblems(body.sampling))
  if (body.sampling) problems.push(...(await caller.withClient((client) => profileProblems(client as unknown as Db, plan.companyId, body.sampling!.samplingMethod === 'AQL_PROFILE' ? body.sampling!.aqlProfileId : null))))
  if (problems.length > 0) refuse(problems, 'The version is not valid.')
  const list = body.checks?.map(checkContentOf)
  const { result } = await command(caller, { name: 'quality.savePlanVersion', idempotencyKey, input: { planId, versionId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const current = await lockVersion(tx, plan, versionId, body.version)
    if (current.status !== 'DRAFT') throw notDraft(current)
    const checksBefore = (await readChecks(asDb(tx), [current.id])).map(contentOfCheck)
    const data: Prisma.InspectionPlanVersionUncheckedUpdateInput = { version: { increment: 1 }, updatedAt: now }
    if (note !== undefined) data.changeNote = note
    if (body.sampling) Object.assign(data, samplingData(body.sampling))
    const after = await tx.inspectionPlanVersion.update({ where: { id: current.id }, data, select: VERSION_COLUMNS })
    if (list) await writeChecks(tools, current.id, list)
    tools.audit({ recordType: VERSION_RECORD, recordId: after.id, companyId: plan.companyId, before: auditedVersion(current, checksBefore), after: auditedVersion(after, list ?? checksBefore) })
    changed(tools, plan, 'VERSION_SAVED', after)
    const facts = await versionFacts(asDb(tx), [after], after.id)
    return { version: versionView(after, facts) }
  })
  return result
}

// ---- asking for approval -----------------------------------------------------------------------------------------------

/** POST …/submit: the draft must be approvable; the ask is an audit row (no column keeps it: see the notes). */
export async function submitVersion(caller: CommandCaller, planId: string, versionId: string, body: { readonly version: number; readonly note?: string | null | undefined }, idempotencyKey?: string) {
  const context = officeOf(caller)
  const plan = await caller.withClient((client) => readPlan(client as unknown as Db, context, planId))
  assertManage(context, plan.companyId)
  const note = body.note?.trim() || null
  if (note && note.length > PLAN_LIMITS.reason) refuse([{ path: 'note', message: `At most ${PLAN_LIMITS.reason} characters.` }], 'The note is too long.')
  const { result } = await command(caller, { name: 'quality.submitPlanVersion', idempotencyKey, input: { planId, versionId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const current = await lockVersion(tx, plan, versionId, body.version)
    if (current.status !== 'DRAFT') throw notDraft(current)
    const checks = await readChecks(asDb(tx), [current.id])
    const problems = contentProblems({ number: current.number, checks: checks.map(contentOfCheck), sampling: samplingOf(current) })
    if (problems.length > 0) throw new PlanRefusedError('NOT_READY', `Version ${current.number} is not ready for approval: ${problems[0]!.message}`, problems.map((problem) => ({ path: `version/${problem.path}`, message: problem.message })))
    const after = await tx.inspectionPlanVersion.update({ where: { id: current.id }, data: { version: { increment: 1 }, updatedAt: now }, select: VERSION_COLUMNS })
    // atVersion: the row version the ask leaves; a later save bumps it, and the ask no longer stands (store.ts submittedOf).
    tools.audit({ recordType: VERSION_RECORD, recordId: after.id, companyId: plan.companyId, after: { number: after.number, submitted: true, atVersion: after.version }, ...(note ? { reason: note } : {}) })
    changed(tools, plan, 'SUBMITTED', after)
    const facts = await versionFacts(asDb(tx), [after])
    return { version: versionView(after, { ...facts, submitted: { by: context.actorId, at: now, note }, names: new Map([...facts.names, ...(await namesOf(tx, [context.actorId]))]) }) }
  })
  return result
}

const namesOf = async (tx: Tools['tx'], ids: readonly string[]) => (await tx.user.findMany({ where: { id: { in: [...ids] } }, select: { id: true, displayName: true } })).map((user) => [user.id, user.displayName] as const)

// ---- approving (QHS-016) -----------------------------------------------------------------------------------------------

/** POST …/approve (the route asks the step-up first). */
export async function approveVersion(caller: CommandCaller, planId: string, versionId: string, body: { readonly version: number }, idempotencyKey?: string) {
  const context = officeOf(caller)
  const plan = await caller.withClient((client) => readPlan(client as unknown as Db, context, planId))
  if (!mayApprove(context, plan.companyId)) throw new ForbiddenError('You approve plan versions only for the companies your role reaches (quality.plans.approve).')
  const { result } = await command(caller, { name: 'quality.approvePlanVersion', idempotencyKey, input: { planId, versionId, ...body } }, async (tools) => {
    const { tx, now } = tools
    // One approval of a plan at a time: the one-APPROVED index is never met by two at once.
    await lockPlanRow(tx, plan.id)
    const current = await lockVersion(tx, plan, versionId, body.version)
    const editors = (await editorsOf(asDb(tx), [current.id])).get(current.id) ?? []
    const refusal = approverRefusal({ number: current.number, status: current.status as VersionStatus, authorId: current.authorId, editorIds: editors, approverId: context.actorId })
    if (refusal) throw new PlanRefusedError(refusal.code, refusal.message)
    const checks = (await readChecks(asDb(tx), [current.id])).map(contentOfCheck)
    const sampling = samplingOf(current)
    const problems = contentProblems({ number: current.number, checks, sampling })
    if (problems.length > 0) throw new PlanRefusedError('NOT_READY', `Version ${current.number} is not ready for approval: ${problems[0]!.message}`, problems.map((problem) => ({ path: `version/${problem.path}`, message: problem.message })))
    if (sampling.aqlProfileId) {
      const profile = await tx.aqlProfile.findUnique({ where: { id: sampling.aqlProfileId }, select: { active: true, code: true } })
      if (profile && !profile.active) throw new PlanRefusedError('PROFILE_RETIRED', `AQL profile ${profile.code} is retired: name a profile in use (or the one that applies) before approving.`)
    }
    const old = await tx.inspectionPlanVersion.findFirst({ where: { planId: plan.id, status: 'APPROVED' }, select: VERSION_COLUMNS })
    if (old) {
      await tx.inspectionPlanVersion.update({ where: { id: old.id }, data: { status: 'RETIRED', retiredById: context.actorId, retiredAt: now, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
      tools.audit({ action: 'quality.retirePlanVersion', recordType: VERSION_RECORD, recordId: old.id, companyId: plan.companyId, before: { number: old.number, status: old.status }, after: { number: old.number, status: 'RETIRED', replacedBy: current.number }, reason: `Version ${current.number} approved.` })
    }
    const signature = approvalSha256({ planId: plan.id, planCode: plan.code, stage: plan.stage as PlanStage, versionId: current.id, number: current.number, approvedById: context.actorId, approvedAt: toUtcIso(now), sampling, checks })
    const after = await tx.inspectionPlanVersion.update({
      where: { id: current.id },
      data: { status: 'APPROVED', approvedById: context.actorId, approvedAt: now, approvalSha256: signature, version: { increment: 1 }, updatedAt: now },
      select: VERSION_COLUMNS,
    })
    tools.audit({ recordType: VERSION_RECORD, recordId: after.id, companyId: plan.companyId, before: { number: current.number, status: current.status }, after: { number: after.number, status: after.status, approvalSha256: signature, checks: checks.map((check) => check.code), retired: old?.number ?? null } })
    tools.emit({ type: 'inspection_plan.version_approved', subject: plan.id, companyId: plan.companyId, siteId: null, payload: { planId: plan.id, code: plan.code, stage: plan.stage, versionId: after.id, number: after.number, retiredVersionId: old?.id ?? null } })
    const facts = await versionFacts(asDb(tx), [after])
    return { version: versionView(after, facts), retired: old ? { id: old.id, number: old.number } : null }
  })
  return result
}

// ---- retiring ----------------------------------------------------------------------------------------------------------

/** POST …/retire. */
export async function retireVersion(caller: CommandCaller, planId: string, versionId: string, body: { readonly version: number; readonly reason: string }, idempotencyKey?: string) {
  const context = officeOf(caller)
  const plan = await caller.withClient((client) => readPlan(client as unknown as Db, context, planId))
  assertManage(context, plan.companyId)
  const reason = body.reason.trim()
  if (reason === '') refuse([{ path: 'reason', message: 'Say why the version is retired.' }], 'Say why the version is retired.')
  if (reason.length > PLAN_LIMITS.reason) refuse([{ path: 'reason', message: `At most ${PLAN_LIMITS.reason} characters.` }], 'The reason is too long.')
  const { result } = await command(caller, { name: 'quality.retirePlanVersion', idempotencyKey, input: { planId, versionId, ...body } }, async (tools) => {
    const { tx, now } = tools
    await lockPlanRow(tx, plan.id)
    const current = await lockVersion(tx, plan, versionId, body.version)
    if (current.status === 'RETIRED') throw new PlanRefusedError('ALREADY_RETIRED', `Version ${current.number} is retired already.`)
    if (current.status === 'APPROVED') {
      const rules = await tx.inspectionTrigger.count({ where: { planId: plan.id, active: true } })
      if (rules > 0) throw new PlanRefusedError('RULES_USE_PLAN', `${rules} ${rules === 1 ? 'rule' : 'rules'} of "When inspections are created" ${rules === 1 ? 'uses' : 'use'} ${plan.code}: switch ${rules === 1 ? 'it' : 'them'} off or point ${rules === 1 ? 'it' : 'them'} to another plan first, or approve a new version instead.`)
    }
    const after = await tx.inspectionPlanVersion.update({ where: { id: current.id }, data: { status: 'RETIRED', retiredById: context.actorId, retiredAt: now, version: { increment: 1 }, updatedAt: now }, select: VERSION_COLUMNS })
    tools.audit({ recordType: VERSION_RECORD, recordId: after.id, companyId: plan.companyId, before: { number: current.number, status: current.status }, after: { number: after.number, status: 'RETIRED' }, reason })
    changed(tools, plan, 'VERSION_RETIRED', after)
    const facts = await versionFacts(asDb(tx), [after])
    return { version: versionView(after, facts) }
  })
  return result
}

// ---- the starter set ---------------------------------------------------------------------------------------------------

/** POST /quality/plans/starter: the starter plans the company lacks (or those of `codes`), each a DRAFT v1 by the caller. */
export async function addStarterPlans(caller: CommandCaller, body: { readonly companyId: string; readonly language?: 'it' | 'en' | undefined; readonly codes?: readonly string[] | undefined }, idempotencyKey?: string) {
  const context = officeOf(caller)
  assertManage(context, body.companyId)
  const unknown = (body.codes ?? []).flatMap((code, index) => (STARTER_CODES.includes(code) ? [] : [{ path: `codes/${index}`, message: `Not a plan of the starter set: ${STARTER_CODES.join(', ')}.` }]))
  if (unknown.length > 0) refuse(unknown, 'Not a plan of the starter set.')
  const language = body.language ?? 'it'
  const { result } = await command(caller, { name: 'quality.addStarterPlans', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    await lockCompanyPlans(tx, body.companyId)
    const taken = new Set((await tx.inspectionPlan.findMany({ where: { companyId: body.companyId }, select: { code: true } })).map((row) => row.code))
    const wanted = missingStarterPlans(taken).filter((starter) => !body.codes || body.codes.includes(starter.code))
    const added: { planId: string; code: string; versionId: string }[] = []
    for (const starter of wanted) {
      const plan = await tx.inspectionPlan.create({
        data: { id: newId(), companyId: body.companyId, code: starter.code, stage: starter.stage, name: starter.name[language], ownerId: context.actorId, createdAt: now, updatedAt: now, createdById: context.actorId },
        select: PLAN_COLUMNS,
      })
      const content = starterContent(starter)
      const version = await createVersion(tools, plan, 1, content)
      tools.audit({ recordType: PLAN_RECORD, recordId: plan.id, companyId: plan.companyId, after: { ...auditedPlan(plan), startFrom: { kind: 'STARTER', code: starter.code } } })
      tools.audit({ recordType: VERSION_RECORD, recordId: version.id, companyId: plan.companyId, after: auditedVersion(version, content.checks) })
      changed(tools, plan, 'CREATED', version)
      added.push({ planId: plan.id, code: plan.code, versionId: version.id })
    }
    if (added.length === 0) tools.audit({ recordType: 'Company', recordId: body.companyId, companyId: body.companyId, after: { starterPlans: 'nothing missing' } })
    return { added }
  })
  return result
}

