import type { Prisma } from '@nexus/factory-db'
import { NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import type { InstructionChange } from '@nexus/factory-domain/production-instructions/events'
import { PRODUCTION_INSTRUCTIONS_APPROVE, PRODUCTION_INSTRUCTIONS_MANAGE } from '@nexus/factory-domain/production/instructions/permissions'
import {
  asWords,
  INSTRUCTION_LIMITS,
  mediaTypeProblem,
  notDraftRefusal,
  publishRefusal,
  stepsProblems,
  trimmedWords,
  type MediaKind,
  type StepDraft,
} from '@nexus/factory-domain/production/instructions/rules'
import { command, StaleVersionError, type CommandCaller, type CommandTools } from '../../../core/command'
import { allocateNumber } from '../../../platform/numbering/allocate'
import { recordIn, versionRecord } from './office'
import {
  assertMay,
  FILE_RECORD,
  INSTRUCTION,
  INSTRUCTION_RECORD,
  inWords,
  mediaOf,
  officeOf,
  readInstruction,
  readVersion,
  refuse,
  statusOf,
  stepsOf,
  VERSION,
  VERSION_RECORD,
  versionsOf,
  wordsOrNull,
  type Db,
  type InstructionRow,
  type MediaRow,
  type StepRow,
  type VersionRow,
} from './store'

/**
 * The work instructions' writes (B-W2b-214; PRD-117; design production.instructions SCR-141): one command() each, with an
 * Idempotency-Key, an audit row per record it changes and one `production.instruction_changed` (or `_published`).
 *
 *   POST  /production/instructions                               an instruction of a library operation, for every style or
 *                                                                one style revision, numbered from the company's
 *                                                                WORK_INSTRUCTION series, with its version 1 DRAFT (blank,
 *                                                                or a copy of a version the caller may see)
 *   POST  …/:id/archive | …/:id/restore                          ACTIVE ⇄ ARCHIVED (restoring refused while another ACTIVE
 *                                                                one answers the same lookup)
 *   POST  …/:id/versions                                         the next DRAFT, a copy of the published one (or the one
 *                                                                named) with its steps and media; one draft at a time
 *   PUT   …/:id/versions/:versionId                              the editor's save of a DRAFT: change note, whether Seen is
 *                                                                asked, the whole list of steps in order with their media
 *   POST  …/versions/:versionId/publish                          a second person approves (never the author): the published
 *                                                                one is superseded, then this one published, in one
 *                                                                transaction; the floor shows it from now on
 *   POST  …/versions/:versionId/discard                          a draft nobody wants, with why
 *
 * A version row is locked FOR UPDATE and its version compared inside the command, so a refusal is in words; the instruction
 * row is locked first where the version list moves (a draft added, a version published). Every rule of the database's
 * guards (…_routings_instructions_w2b_guards) a write here can meet is said first; `inWords` turns any that still fires into
 * a 409 in the database's words, never a 500.
 */

type Tools = CommandTools

const actorOf = (tools: Pick<Tools, 'context'>): string => officeOf({ factoryContext: tools.context }).actorId

const lockInstructionRow = (tx: Tools['tx'], instructionId: string) => tx.$queryRaw`SELECT 1 FROM "WorkInstruction" WHERE "id" = ${instructionId}::uuid FOR UPDATE`

/** One lookup answer at a time: the instructions of a company's operation are made and restored under this key. */
const lockOperationInstructions = (tx: Tools['tx'], companyId: string, operationId: string) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.work-instructions', current_setting('factory.tenant_id', true), ${companyId}::text, ${operationId}::text), 0))`

/** The version row, locked, at the version the caller read. */
async function lockVersion(tx: Tools['tx'], instructionId: string, versionId: string, expected: number): Promise<VersionRow> {
  const [locked] = await tx.$queryRaw<{ version: number }[]>`SELECT "version" FROM "WorkInstructionVersion" WHERE "id" = ${versionId}::uuid AND "instructionId" = ${instructionId}::uuid FOR UPDATE`
  if (!locked) throw new NotFoundError('Version not found.')
  if (locked.version !== expected) throw new StaleVersionError('WorkInstructionVersion', versionId, locked.version, expected)
  return (await tx.workInstructionVersion.findUnique({ where: { id: versionId }, select: VERSION }))!
}

const changed = (tools: Tools, instruction: Pick<InstructionRow, 'id' | 'number' | 'companyId' | 'operationId'>, change: InstructionChange, version: Pick<VersionRow, 'id' | 'number'> | null) =>
  tools.emit({ type: 'production.instruction_changed', subject: instruction.id, companyId: instruction.companyId, siteId: null, payload: { instructionId: instruction.id, number: instruction.number, operationId: instruction.operationId, change, versionId: version?.id ?? null, versionNumber: version?.number ?? null } })

const auditedVersion = (row: VersionRow, steps?: readonly string[]) => ({ number: row.number, status: row.status, changeNote: row.changeNote, acknowledgementRequired: row.acknowledgementRequired, ...(steps ? { steps } : {}) })

const invalid = (problems: readonly Issue[], words: string): never => {
  throw new ValidationError(problems.length === 1 ? problems[0]!.message : words, problems.map((problem) => ({ ...problem, path: `body/${problem.path}` })))
}

// ---- a version's content ---------------------------------------------------------------------------------------------------

/** A step as stored, for a copy: the draft's words, marks and media. */
function draftOf(step: StepRow, media: readonly MediaRow[]): StepDraft {
  return {
    code: step.code,
    text: asWords(step.textI18n),
    critical: step.critical,
    safety: wordsOrNull(step.safetyNoteI18n),
    icon: step.icon,
    requiredTick: step.requiredTick,
    media: media.filter((medium) => medium.stepId === step.id).map((medium) => ({ fileId: medium.fileId, kind: medium.kind as MediaKind, caption: wordsOrNull(medium.captionI18n) })),
  }
}

/** The steps of a version, as drafts (in their order, with their media). */
async function contentOf(db: Db, versionId: string): Promise<StepDraft[]> {
  const steps = await stepsOf(db, [versionId])
  const media = await mediaOf(db, [versionId])
  return steps.map((step) => draftOf(step, media))
}

/** The draft's steps become this list, in this order, with their media (a version is written as a whole document). */
async function writeSteps(tools: Tools, versionId: string, steps: readonly StepDraft[]): Promise<void> {
  const { tx, now } = tools
  const by = actorOf(tools)
  // A step taken off takes its media along (the reference's ON DELETE CASCADE).
  await tx.workInstructionStep.deleteMany({ where: { versionId } })
  for (const [index, step] of steps.entries()) {
    const stepId = newId()
    const safety = step.safety && Object.keys(step.safety).length > 0 ? trimmedWords(step.safety) : null
    await tx.workInstructionStep.create({
      data: {
        id: stepId,
        versionId,
        sortOrder: (index + 1) * 10,
        code: step.code,
        textI18n: trimmedWords(step.text),
        critical: step.critical ?? false,
        ...(safety ? { safetyNoteI18n: safety } : {}),
        icon: step.icon ?? null,
        requiredTick: step.requiredTick ?? false,
        createdAt: now,
        updatedAt: now,
        createdById: by,
      },
      select: { id: true },
    })
    for (const [place, medium] of (step.media ?? []).entries()) {
      const caption = medium.caption && Object.keys(medium.caption).length > 0 ? trimmedWords(medium.caption) : null
      await tx.workInstructionMedia.create({
        data: { id: newId(), versionId, stepId, fileId: medium.fileId, kind: medium.kind, sortOrder: (place + 1) * 10, ...(caption ? { captionI18n: caption } : {}), createdAt: now, updatedAt: now, createdById: by },
        select: { id: true },
      })
    }
  }
}

/**
 * The media's files: each one of this instruction's own uploads (POST …/files), or a file a version of it names already (a
 * copy of another instruction's version names that one's files), a picture for a photo and a video for a video, not
 * deleted or held.
 */
async function mediaProblems(db: Db, instructionId: string, steps: readonly StepDraft[]): Promise<Issue[]> {
  const wanted = [...new Set(steps.flatMap((step) => (step.media ?? []).map((medium) => medium.fileId)))]
  if (wanted.length === 0) return []
  const files = new Map((await db.storedFile.findMany({ where: { id: { in: wanted.filter(isUuid) } }, select: { id: true, recordType: true, recordId: true, contentType: true, status: true } })).map((row) => [row.id, row]))
  const named = new Set((await mediaOf(db, (await versionsOf(db, [instructionId])).map((row) => row.id))).map((medium) => medium.fileId))
  const problems: Issue[] = []
  steps.forEach((step, index) =>
    (step.media ?? []).forEach((medium, place) => {
      const at = `steps/${index}/media/${place}`
      const file = files.get(medium.fileId)
      if (!file || !((file.recordType === FILE_RECORD && file.recordId === instructionId) || named.has(file.id))) return void problems.push({ path: `${at}/fileId`, message: 'Not a photo or video uploaded to this instruction: upload it here first.' })
      if (file.status === 'DELETED' || file.status === 'QUARANTINED') return void problems.push({ path: `${at}/fileId`, message: `This file is ${String(file.status).toLowerCase()}: upload it again.` })
      const wrong = mediaTypeProblem(medium.kind, file.contentType)
      if (wrong) problems.push({ path: `${at}/kind`, message: wrong })
    }),
  )
  return problems
}

// ---- a new instruction -------------------------------------------------------------------------------------------------------

export interface CreateBody {
  readonly companyId: string
  readonly operationId: string
  readonly styleRevisionId?: string | null | undefined
  /** A version to copy into the first draft (its steps and media), of an instruction of the same company. */
  readonly copyVersionId?: string | null | undefined
}

/** The ACTIVE instruction answering the same lookup (company, operation, revision or none), or null. */
const activeTwin = (db: Db, place: { readonly companyId: string; readonly operationId: string; readonly styleRevisionId: string | null }, except?: string) =>
  db.workInstruction.findFirst({ where: { companyId: place.companyId, operationId: place.operationId, styleRevisionId: place.styleRevisionId, status: 'ACTIVE', ...(except ? { NOT: { id: except } } : {}) }, select: { id: true, number: true } })

const twinRefusal = (number: string, forRevision: boolean) => ({
  code: 'ACTIVE_EXISTS',
  message: `${number} is the instruction in force of this operation ${forRevision ? 'for this style revision' : 'for every style'}: write a new version of it, or archive it first.`,
})

/** POST /production/instructions. */
export async function createInstruction(caller: CommandCaller, body: CreateBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  assertMay(context, PRODUCTION_INSTRUCTIONS_MANAGE, body.companyId, 'You write work instructions only for the companies your role reaches (production.instructions.manage).')
  const facts = await caller.withClient(async (client) => {
    const db = client as Db
    const company = await db.company.findUnique({ where: { id: body.companyId }, select: { id: true } })
    if (!company) throw new NotFoundError('Company not found.')
    const operation = await db.operation.findUnique({ where: { id: body.operationId }, select: { id: true, companyId: true, code: true, status: true } })
    if (!operation || (operation.companyId !== null && operation.companyId !== body.companyId)) invalid([{ path: 'operationId', message: 'Not an operation of the library of this company.' }], 'Not an operation of this company.')
    if (operation!.status !== 'ACTIVE') invalid([{ path: 'operationId', message: `${operation!.code} is archived in the library: an instruction is for an operation in use.` }], 'The operation is archived.')
    let styleId: string | null = null
    if (body.styleRevisionId) {
      const revision = await db.styleRevision.findUnique({ where: { id: body.styleRevisionId }, select: { id: true, styleId: true } })
      const style = revision ? await db.style.findUnique({ where: { id: revision.styleId }, select: { companyId: true } }) : null
      if (!revision || !style || (style.companyId !== null && style.companyId !== body.companyId)) invalid([{ path: 'styleRevisionId', message: 'Not a revision of a style of this company.' }], 'Not a style revision of this company.')
      styleId = revision!.styleId
    }
    const twin = await activeTwin(db, { companyId: body.companyId, operationId: body.operationId, styleRevisionId: body.styleRevisionId ?? null })
    if (twin) refuse(twinRefusal(twin.number, !!body.styleRevisionId))
    let copy: StepDraft[] = []
    if (body.copyVersionId) {
      const source = isUuid(body.copyVersionId) ? await db.workInstructionVersion.findUnique({ where: { id: body.copyVersionId }, select: { id: true, instructionId: true } }) : null
      const owner = source ? await db.workInstruction.findUnique({ where: { id: source.instructionId }, select: { companyId: true } }) : null
      if (!source || !owner || owner.companyId !== body.companyId) invalid([{ path: 'copyVersionId', message: 'Not a version of an instruction of this company.' }], 'The version to copy was not found.')
      copy = await contentOf(db, source!.id)
      return { styleId, copy, copyFrom: source!.instructionId }
    }
    return { styleId, copy, copyFrom: null as string | null }
  })
  const instructionId = newId()
  const { result } = await inWords(() =>
    command(caller, { name: 'production.createInstruction', idempotencyKey, input: body }, async (tools) => {
      const { tx, now } = tools
      await lockOperationInstructions(tx, body.companyId, body.operationId)
      const twin = await activeTwin(tx, { companyId: body.companyId, operationId: body.operationId, styleRevisionId: body.styleRevisionId ?? null })
      if (twin) refuse(twinRefusal(twin.number, !!body.styleRevisionId))
      const issued = await allocateNumber(tools, { companyId: body.companyId, kind: 'WORK_INSTRUCTION' }, { type: INSTRUCTION_RECORD, id: instructionId })
      const instruction = await tx.workInstruction.create({
        data: { id: instructionId, companyId: body.companyId, number: issued.formatted, operationId: body.operationId, styleId: facts.styleId, styleRevisionId: body.styleRevisionId ?? null, createdAt: now, updatedAt: now, createdById: context.actorId },
        select: INSTRUCTION,
      })
      const version = await tx.workInstructionVersion.create({ data: { id: newId(), instructionId, number: 1, authorId: context.actorId, createdAt: now, updatedAt: now, createdById: context.actorId }, select: VERSION })
      // A copy's media name the files of the instruction it copies (one file, two instructions of the same company).
      if (facts.copy.length > 0) await writeSteps(tools, version.id, facts.copy)
      tools.audit({ recordType: INSTRUCTION_RECORD, recordId: instruction.id, companyId: instruction.companyId, after: { number: instruction.number, operationId: instruction.operationId, styleRevisionId: instruction.styleRevisionId, copiedFrom: body.copyVersionId ?? null } })
      tools.audit({ recordType: VERSION_RECORD, recordId: version.id, companyId: instruction.companyId, after: auditedVersion(version, facts.copy.map((step) => step.code)) })
      changed(tools, instruction, 'CREATED', version)
      return { instructionId: instruction.id }
    }),
  )
  return caller.withClient((client) => recordIn(client as Db, context, result.instructionId))
}

// ---- archive and restore -----------------------------------------------------------------------------------------------------

/** POST …/archive | …/restore. */
export async function setInstructionStatus(caller: CommandCaller, instructionId: string, to: 'ACTIVE' | 'ARCHIVED', body: { readonly version: number; readonly reason?: string | null | undefined }, idempotencyKey?: string) {
  const context = officeOf(caller)
  const before = await caller.withClient((client) => readInstruction(client as Db, context, instructionId))
  assertMay(context, PRODUCTION_INSTRUCTIONS_MANAGE, before.companyId, 'You keep work instructions only for the companies your role reaches (production.instructions.manage).')
  const reason = body.reason?.trim() || null
  if (reason && reason.length > INSTRUCTION_LIMITS.reason) invalid([{ path: 'reason', message: `At most ${INSTRUCTION_LIMITS.reason} characters.` }], 'The reason is too long.')
  if (before.status === to) refuse({ code: to === 'ACTIVE' ? 'ALREADY_ACTIVE' : 'ALREADY_ARCHIVED', message: `${before.number} is ${to === 'ACTIVE' ? 'in use' : 'archived'} already.` })
  await inWords(() =>
    command(caller, { name: to === 'ACTIVE' ? 'production.restoreInstruction' : 'production.archiveInstruction', idempotencyKey, input: { instructionId, ...body }, record: { type: 'WorkInstruction', id: before.id, expectedVersion: body.version } }, async (tools) => {
      const { tx, now } = tools
      if (to === 'ACTIVE') {
        await lockOperationInstructions(tx, before.companyId, before.operationId)
        const twin = await activeTwin(tx, { companyId: before.companyId, operationId: before.operationId, styleRevisionId: before.styleRevisionId }, before.id)
        if (twin) refuse(twinRefusal(twin.number, before.styleRevisionId !== null))
      }
      const after = await tx.workInstruction.update({ where: { id: before.id }, data: { status: to, updatedAt: now }, select: INSTRUCTION })
      tools.audit({ recordType: INSTRUCTION_RECORD, recordId: after.id, companyId: after.companyId, before: { status: before.status }, after: { status: after.status }, ...(reason ? { reason } : {}) })
      changed(tools, after, to === 'ACTIVE' ? 'RESTORED' : 'ARCHIVED', null)
      return { instructionId: after.id }
    }),
  )
  return caller.withClient((client) => recordIn(client as Db, context, instructionId))
}

// ---- the next draft ------------------------------------------------------------------------------------------------------------

export interface DraftBody {
  /** The instruction row's version. */
  readonly version: number
  readonly fromVersionId?: string | null | undefined
  readonly changeNote?: string | null | undefined
}

/** POST /production/instructions/:instructionId/versions. */
export async function draftVersion(caller: CommandCaller, instructionId: string, body: DraftBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  const instruction = await caller.withClient((client) => readInstruction(client as Db, context, instructionId))
  assertMay(context, PRODUCTION_INSTRUCTIONS_MANAGE, instruction.companyId, 'You write work instructions only for the companies your role reaches (production.instructions.manage).')
  const note = body.changeNote?.trim() || null
  if (note && note.length > INSTRUCTION_LIMITS.changeNote) invalid([{ path: 'changeNote', message: `At most ${INSTRUCTION_LIMITS.changeNote} characters.` }], 'The change note is too long.')
  if (instruction.status !== 'ACTIVE') refuse({ code: 'ARCHIVED', message: `${instruction.number} is archived: restore it before writing a new version.` })
  const { result } = await inWords(() =>
    command(caller, { name: 'production.draftInstructionVersion', idempotencyKey, input: { instructionId, ...body }, record: { type: 'WorkInstruction', id: instruction.id, expectedVersion: body.version } }, async (tools) => {
      const { tx, now } = tools
      const versions = await versionsOf(tx, [instruction.id])
      const open = versions.find((row) => row.status === 'DRAFT')
      if (open) refuse({ code: 'DRAFT_EXISTS', message: `Version ${open.number} is being written already: change it, or discard it first.` })
      const source = body.fromVersionId ? versions.find((row) => row.id === body.fromVersionId) : (versions.find((row) => row.status === 'PUBLISHED') ?? versions.find((row) => row.status !== 'DISCARDED'))
      if (body.fromVersionId && !source) invalid([{ path: 'fromVersionId', message: 'Not a version of this instruction.' }], 'Not a version of this instruction.')
      const content = source ? await contentOf(tx, source.id) : []
      const number = (versions[0]?.number ?? 0) + 1
      const version = await tx.workInstructionVersion.create({ data: { id: newId(), instructionId: instruction.id, number, changeNote: note, authorId: context.actorId, createdAt: now, updatedAt: now, createdById: context.actorId }, select: VERSION })
      if (content.length > 0) await writeSteps(tools, version.id, content)
      tools.audit({ recordType: VERSION_RECORD, recordId: version.id, companyId: instruction.companyId, after: { ...auditedVersion(version, content.map((step) => step.code)), from: source?.number ?? null } })
      changed(tools, instruction, 'VERSION_DRAFTED', version)
      return { versionId: version.id }
    }),
  )
  return versionRecord(caller, instructionId, result.versionId, {})
}

// ---- the editor's save ---------------------------------------------------------------------------------------------------------

export interface SaveBody {
  /** The version row's version. */
  readonly version: number
  readonly changeNote?: string | null | undefined
  readonly acknowledgementRequired?: boolean | undefined
  readonly steps?: readonly StepDraft[] | undefined
}

/** PUT /production/instructions/:instructionId/versions/:versionId. */
export async function saveVersion(caller: CommandCaller, instructionId: string, versionId: string, body: SaveBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  const { instruction, before, problems } = await caller.withClient(async (client) => {
    const db = client as Db
    const instruction = await readInstruction(db, context, instructionId)
    const before = await readVersion(db, instruction, versionId)
    const problems: Issue[] = []
    const note = body.changeNote?.trim()
    if (note && note.length > INSTRUCTION_LIMITS.changeNote) problems.push({ path: 'changeNote', message: `At most ${INSTRUCTION_LIMITS.changeNote} characters.` })
    if (body.steps) {
      problems.push(...stepsProblems(body.steps))
      if (problems.length === 0) problems.push(...(await mediaProblems(db, instruction.id, body.steps)))
    }
    return { instruction, before, problems }
  })
  assertMay(context, PRODUCTION_INSTRUCTIONS_MANAGE, instruction.companyId, 'You write work instructions only for the companies your role reaches (production.instructions.manage).')
  if (statusOf(before) !== 'DRAFT') refuse(notDraftRefusal(before.number, statusOf(before)))
  if (problems.length > 0) invalid(problems, 'The version is not valid.')
  await inWords(() =>
    command(caller, { name: 'production.saveInstructionVersion', idempotencyKey, input: { instructionId, versionId, ...body } }, async (tools) => {
      const { tx, now } = tools
      const current = await lockVersion(tx, instruction.id, versionId, body.version)
      if (statusOf(current) !== 'DRAFT') refuse(notDraftRefusal(current.number, statusOf(current)))
      const stepsBefore = (await stepsOf(tx, [current.id])).map((step) => step.code)
      const data: Prisma.WorkInstructionVersionUncheckedUpdateInput = { version: { increment: 1 }, updatedAt: now }
      if (body.changeNote !== undefined) data.changeNote = body.changeNote?.trim() || null
      if (body.acknowledgementRequired !== undefined) data.acknowledgementRequired = body.acknowledgementRequired
      const after = await tx.workInstructionVersion.update({ where: { id: current.id }, data, select: VERSION })
      if (body.steps) await writeSteps(tools, current.id, body.steps)
      tools.audit({ recordType: VERSION_RECORD, recordId: after.id, companyId: instruction.companyId, before: auditedVersion(current, stepsBefore), after: auditedVersion(after, body.steps ? body.steps.map((step) => step.code) : stepsBefore) })
      changed(tools, instruction, 'VERSION_SAVED', after)
      return { versionId: after.id }
    }),
  )
  return versionRecord(caller, instructionId, versionId, {})
}

// ---- approving (publishing) -------------------------------------------------------------------------------------------------

/** POST …/versions/:versionId/publish: a second person approves the draft; the floor shows it from now on. */
export async function publishVersion(caller: CommandCaller, instructionId: string, versionId: string, body: { readonly version: number }, idempotencyKey?: string) {
  const context = officeOf(caller)
  const instruction = await caller.withClient((client) => readInstruction(client as Db, context, instructionId))
  assertMay(context, PRODUCTION_INSTRUCTIONS_APPROVE, instruction.companyId, 'You approve work instructions only for the companies your role reaches (production.instructions.approve).')
  const { result } = await inWords(() =>
    command(caller, { name: 'production.publishInstructionVersion', idempotencyKey, input: { instructionId, versionId, ...body } }, async (tools) => {
      const { tx, now } = tools
      // One publication of an instruction at a time: the one-PUBLISHED index is never met by two at once.
      await lockInstructionRow(tx, instruction.id)
      const fresh = (await tx.workInstruction.findUnique({ where: { id: instruction.id }, select: INSTRUCTION }))!
      const current = await lockVersion(tx, instruction.id, versionId, body.version)
      const steps = await stepsOf(tx, [current.id])
      const media = await mediaOf(tx, [current.id])
      const notReady = media.length === 0 ? 0 : await tx.storedFile.count({ where: { id: { in: [...new Set(media.map((medium) => medium.fileId))] }, NOT: { status: 'AVAILABLE' } } })
      const refusal = publishRefusal({
        number: current.number,
        status: statusOf(current),
        authorId: current.authorId,
        approverId: context.actorId,
        instructionNumber: fresh.number,
        instructionActive: fresh.status === 'ACTIVE',
        changeNote: current.changeNote,
        steps: steps.length,
        mediaNotReady: notReady,
      })
      if (refusal) refuse(refusal)
      const old = await tx.workInstructionVersion.findFirst({ where: { instructionId: instruction.id, status: 'PUBLISHED' }, select: VERSION })
      if (old) {
        await tx.workInstructionVersion.update({ where: { id: old.id }, data: { status: 'SUPERSEDED', supersededAt: now, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
        tools.audit({ action: 'production.supersedeInstructionVersion', recordType: VERSION_RECORD, recordId: old.id, companyId: fresh.companyId, before: { number: old.number, status: old.status }, after: { number: old.number, status: 'SUPERSEDED', replacedBy: current.number }, reason: `Version ${current.number} approved.` })
      }
      const after = await tx.workInstructionVersion.update({ where: { id: current.id }, data: { status: 'PUBLISHED', approvedById: context.actorId, publishedAt: now, version: { increment: 1 }, updatedAt: now }, select: VERSION })
      tools.audit({ recordType: VERSION_RECORD, recordId: after.id, companyId: fresh.companyId, before: { number: current.number, status: current.status }, after: { number: after.number, status: after.status, approvedById: context.actorId, steps: steps.map((step) => step.code), media: media.length, superseded: old?.number ?? null } })
      tools.emit({
        type: 'production.instruction_published',
        subject: fresh.id,
        companyId: fresh.companyId,
        siteId: null,
        payload: { instructionId: fresh.id, number: fresh.number, operationId: fresh.operationId, versionId: after.id, versionNumber: after.number, supersededVersionId: old?.id ?? null, acknowledgementRequired: after.acknowledgementRequired },
      })
      return { versionId: after.id, superseded: old ? { id: old.id, number: old.number } : null }
    }),
  )
  return { ...(await versionRecord(caller, instructionId, result.versionId, {})), superseded: result.superseded }
}

// ---- discarding ----------------------------------------------------------------------------------------------------------------

/** POST …/versions/:versionId/discard: a draft nobody wants, kept with why. */
export async function discardVersion(caller: CommandCaller, instructionId: string, versionId: string, body: { readonly version: number; readonly reason: string }, idempotencyKey?: string) {
  const context = officeOf(caller)
  const instruction = await caller.withClient((client) => readInstruction(client as Db, context, instructionId))
  assertMay(context, PRODUCTION_INSTRUCTIONS_MANAGE, instruction.companyId, 'You keep work instructions only for the companies your role reaches (production.instructions.manage).')
  const reason = body.reason.trim()
  if (reason === '') invalid([{ path: 'reason', message: 'Say why the draft is discarded.' }], 'Say why the draft is discarded.')
  if (reason.length > INSTRUCTION_LIMITS.reason) invalid([{ path: 'reason', message: `At most ${INSTRUCTION_LIMITS.reason} characters.` }], 'The reason is too long.')
  await inWords(() =>
    command(caller, { name: 'production.discardInstructionVersion', idempotencyKey, input: { instructionId, versionId, ...body } }, async (tools) => {
      const { tx, now } = tools
      const current = await lockVersion(tx, instruction.id, versionId, body.version)
      if (statusOf(current) !== 'DRAFT') refuse(notDraftRefusal(current.number, statusOf(current)))
      const after = await tx.workInstructionVersion.update({ where: { id: current.id }, data: { status: 'DISCARDED', version: { increment: 1 }, updatedAt: now }, select: VERSION })
      tools.audit({ recordType: VERSION_RECORD, recordId: after.id, companyId: instruction.companyId, before: { number: current.number, status: current.status }, after: { number: after.number, status: after.status }, reason })
      changed(tools, instruction, 'VERSION_DISCARDED', after)
      return { versionId: after.id }
    }),
  )
  return versionRecord(caller, instructionId, versionId, {})
}
