import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { parseInstant, toUtcIso } from '@nexus/factory-domain/core/time'
import { PRODUCTION_INSTRUCTIONS_PEOPLE } from '@nexus/factory-domain/production/instructions/permissions'
import { ACK_LANGUAGE, acknowledgementDue, notPublishedRefusal, type AckDue } from '@nexus/factory-domain/production/instructions/rules'
import { clientIdReusedRefusal } from '@nexus/factory-domain/production/scans/rules'
import { command, IdempotencyKeyReusedError, type CommandCaller, type CommandTools } from '../../../core/command'
import type { FloorContext } from '../../../core/context'
import { floorOf, refuse as refuseScan, systemView } from '../scans/access'
import { acknowledgementsOf } from './office'
import { ACK_RECORD, assertMay, inWords, officeOf, operationsOf, readInstruction, readVersion, refuse, statusOf, type Db } from './store'

/**
 * Seen (B-W2b-214; MES-119; design floor.instructions "Seen: store that a changed instruction was seen", production.instructions
 * › Acknowledgements): a training record (D.Lgs. 81/2008 art. 37), never a figure per worker (Owner answers F2, H3, W1).
 *
 *   POST /production/instructions/floor/seen        the signed-in worker saw a published (or since superseded) version on this
 *                                                   tablet, in this language: ONE row per worker and version (under a lock;
 *                                                   a second Seen answers the first), keyed `<device>.<clientEventId>`;
 *                                                   offline it queues as production.instruction.ack
 *   GET  /production/instructions/floor/mine        the person's own: what they saw, and what waits for them (the published
 *                                                   versions of the operations they hold a skill of or saw before, not seen)
 *   POST …/:id/versions/:versionId/acknowledgements the office records an acknowledgement signed on paper (HR,
 *                                                   production.instructions.people)
 *
 * The floor inserts an acknowledgement and never reads one (its grant): whether one is there is read in the tenant's system
 * scope, on its own connection, while the command holds the worker's and version's lock (any earlier Seen has committed).
 */

/** One Seen per worker and version at a time. */
const lockSeen = (tx: CommandTools['tx'], versionId: string, workerId: string) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.instruction-seen', current_setting('factory.tenant_id', true), ${versionId}::text, ${workerId}::text), 0))`

export interface SeenState {
  readonly due: AckDue | null
  readonly seenAt: string | null
}

/** A worker's acknowledgements of an instruction (by the worker's sign-in, or by their employee across sites), read in the system scope. */
async function seenRows(caller: CommandCaller, worker: { readonly id: string; readonly employeeId: string | null }, versionIds: readonly string[]) {
  if (versionIds.length === 0) return []
  return systemView(caller).withClient((db) =>
    db.instructionAcknowledgement.findMany({
      where: { versionId: { in: [...versionIds] }, OR: [{ workerId: worker.id }, ...(worker.employeeId ? [{ employeeId: worker.employeeId }] : [])] },
      select: { id: true, versionId: true, acknowledgedAt: true },
      orderBy: { acknowledgedAt: 'asc' },
    }),
  )
}

/** Whether the version in force waits for the worker's Seen, and when they saw it. */
export async function seenStateOf(caller: CommandCaller, worker: { readonly id: string; readonly employeeId: string | null }, version: { readonly id: string; readonly instructionId: string; readonly acknowledgementRequired: boolean }): Promise<SeenState> {
  const versionIds = (await systemView(caller).withClient((db) => db.workInstructionVersion.findMany({ where: { instructionId: version.instructionId, status: { in: ['PUBLISHED', 'SUPERSEDED'] } }, select: { id: true } }))).map((row) => row.id)
  const rows = await seenRows(caller, worker, versionIds)
  const own = rows.find((row) => row.versionId === version.id)
  return { due: acknowledgementDue({ required: version.acknowledgementRequired, seenThis: !!own, seenEarlier: rows.some((row) => row.versionId !== version.id) }), seenAt: own ? toUtcIso(own.acknowledgedAt) : null }
}

export async function workerOf(db: Db, workerId: string) {
  const worker = await db.worker.findUnique({ where: { id: workerId }, select: { id: true, employeeId: true, locale: true, siteId: true } })
  if (!worker) throw new NotFoundError('Worker not found.')
  return worker
}

/** A worker's language as an acknowledgement records it (ISO 639-1). */
const languageOf = (locale: string): string => locale.slice(0, 2).toLowerCase()

// ---- Seen on a tablet --------------------------------------------------------------------------------------------------------

export interface SeenBody {
  readonly clientEventId: string
  readonly versionId: string
  /** The language it was shown in; default the worker's own. */
  readonly locale?: string | undefined
  readonly occurredAt?: string | undefined
}

export interface SeenAnswer {
  readonly acknowledgement: { readonly id: string; readonly versionId: string; readonly versionNumber: number; readonly at: string }
}

/** The Seen that stands (thrown out of the command: nothing is written again). */
class AlreadySeen extends Error {
  constructor(readonly answer: SeenAnswer) {
    super('Seen already.')
  }
}

const keyOf = (context: FloorContext, clientEventId: string) => `${context.deviceId}.${clientEventId}`

/** POST /production/instructions/floor/seen (and the queued production.instruction.ack). */
export async function acknowledge(caller: CommandCaller, body: SeenBody): Promise<SeenAnswer & { readonly replayed: boolean }> {
  const context = floorOf(caller)
  const facts = await caller.withClient(async (client) => {
    const db = client as Db
    // The floor reads only the versions it shows (published, superseded): any other is not there for it.
    const version = isUuid(body.versionId) ? await db.workInstructionVersion.findUnique({ where: { id: body.versionId }, select: { id: true, instructionId: true, number: true, status: true } }) : null
    if (!version) throw new NotFoundError('This instruction version is not shown on the floor.')
    if (version.status !== 'PUBLISHED' && version.status !== 'SUPERSEDED') refuse(notPublishedRefusal(version.number))
    const instruction = await db.workInstruction.findUnique({ where: { id: version.instructionId }, select: { id: true, number: true, companyId: true } })
    const site = await db.site.findUnique({ where: { id: context.siteId }, select: { companyId: true } })
    if (!instruction || !site || instruction.companyId !== site.companyId) throw new NotFoundError('This instruction version is not shown on the floor.')
    return { version, instruction, worker: await workerOf(db, context.actorId) }
  })
  const locale = body.locale ?? languageOf(facts.worker.locale)
  if (!ACK_LANGUAGE.test(locale)) throw new ValidationError('The language is its ISO 639-1 code (it, en, ro).', [{ path: 'body/locale', message: 'Expected two lower-case letters.' }])
  const deviceTime = body.occurredAt ? parseInstant(body.occurredAt) : null
  try {
    const { result, replayed } = await inWords(() =>
      command(caller, { name: 'production.acknowledgeInstruction', idempotencyKey: keyOf(context, body.clientEventId), input: { ...body, locale }, ...(deviceTime ? { deviceTime } : {}) }, async (tools): Promise<SeenAnswer> => {
        const { tx, now } = tools
        await lockSeen(tx, facts.version.id, facts.worker.id)
        const [earlier] = await seenRows(caller, facts.worker, [facts.version.id])
        if (earlier) throw new AlreadySeen({ acknowledgement: { id: earlier.id, versionId: facts.version.id, versionNumber: facts.version.number, at: toUtcIso(earlier.acknowledgedAt) } })
        const id = newId()
        // The floor role inserts and cannot read the row back: no RETURNING.
        await tx.instructionAcknowledgement.createMany({
          data: [{ id, siteId: context.siteId, versionId: facts.version.id, workerId: facts.worker.id, employeeId: facts.worker.employeeId, locale, deviceId: context.deviceId, clientEventId: body.clientEventId, deviceTime, acknowledgedAt: now, createdById: facts.worker.id }],
        })
        tools.audit({ recordType: ACK_RECORD, recordId: id, companyId: facts.instruction.companyId, siteId: context.siteId, after: { instructionId: facts.instruction.id, versionId: facts.version.id, versionNumber: facts.version.number, workerId: facts.worker.id, locale, way: 'FLOOR' } })
        tools.emit({ type: 'production.instruction_acknowledged', subject: facts.instruction.id, companyId: facts.instruction.companyId, siteId: context.siteId, payload: { instructionId: facts.instruction.id, number: facts.instruction.number, versionId: facts.version.id, versionNumber: facts.version.number, siteId: context.siteId, way: 'FLOOR' } })
        return { acknowledgement: { id, versionId: facts.version.id, versionNumber: facts.version.number, at: toUtcIso(now) } }
      }),
    )
    return { ...result, replayed }
  } catch (error) {
    if (error instanceof AlreadySeen) return { ...error.answer, replayed: true }
    if (error instanceof IdempotencyKeyReusedError) refuseScan(clientIdReusedRefusal(body.clientEventId))
    throw error
  }
}

// ---- the person's own ---------------------------------------------------------------------------------------------------------

/** GET /production/instructions/floor/mine: what the signed-in worker saw, and what waits for their Seen (MES-119; My work's count). */
export async function floorMine(caller: CommandCaller) {
  const context = floorOf(caller)
  const worker = await caller.withClient((client) => workerOf(client as Db, context.actorId))
  return systemView(caller).withClient(async (client) => {
    const db = client as Db
    const site = await db.site.findUnique({ where: { id: context.siteId }, select: { companyId: true } })
    if (!site) throw new NotFoundError('Site not found.')
    const own = await db.instructionAcknowledgement.findMany({ where: { OR: [{ workerId: worker.id }, ...(worker.employeeId ? [{ employeeId: worker.employeeId }] : [])] }, select: { versionId: true, acknowledgedAt: true, locale: true }, orderBy: { acknowledgedAt: 'desc' }, take: 500 })
    const seenVersions = await db.workInstructionVersion.findMany({ where: { id: { in: [...new Set(own.map((row) => row.versionId))] } }, select: { id: true, instructionId: true, number: true } })
    // The operations the person works: the skills they hold here.
    const skills = worker.employeeId ? await db.employeeSkill.findMany({ where: { employeeId: worker.employeeId, siteId: context.siteId, removedAt: null }, select: { skillId: true } }) : []
    const skilled = skills.length === 0 ? [] : (await db.skill.findMany({ where: { id: { in: skills.map((row) => row.skillId) }, operationId: { not: null } }, select: { operationId: true } })).map((row) => row.operationId!)
    const instructions = await db.workInstruction.findMany({
      where: { companyId: site.companyId, status: 'ACTIVE', OR: [{ operationId: { in: skilled } }, { id: { in: [...new Set(seenVersions.map((row) => row.instructionId))] } }] },
      select: { id: true, number: true, operationId: true, styleRevisionId: true },
    })
    const published = await db.workInstructionVersion.findMany({ where: { instructionId: { in: instructions.map((row) => row.id) }, status: 'PUBLISHED' }, select: { id: true, instructionId: true, number: true, publishedAt: true, acknowledgementRequired: true } })
    const allSeen = new Map(seenVersions.map((row) => [row.id, row]))
    const everSeen = new Set(seenVersions.map((row) => row.instructionId))
    const operations = await operationsOf(db, instructions.map((row) => row.operationId))
    const byId = new Map(instructions.map((row) => [row.id, row]))
    const due = published.flatMap((version) => {
      const instruction = byId.get(version.instructionId)!
      const reason = acknowledgementDue({ required: version.acknowledgementRequired, seenThis: allSeen.has(version.id), seenEarlier: everSeen.has(instruction.id) && !allSeen.has(version.id) })
      const operation = operations.get(instruction.operationId)
      return reason ? [{ instructionId: instruction.id, number: instruction.number, forRevision: instruction.styleRevisionId !== null, operation: { id: instruction.operationId, code: operation?.code ?? '', name: operation?.name ?? '' }, versionId: version.id, versionNumber: version.number, publishedAt: version.publishedAt ? toUtcIso(version.publishedAt) : null, reason }] : []
    })
    const numbers = new Map((await db.workInstruction.findMany({ where: { id: { in: [...everSeen] } }, select: { id: true, number: true } })).map((row) => [row.id, row.number]))
    return {
      due,
      seen: own.slice(0, 50).flatMap((row) => {
        const version = allSeen.get(row.versionId)
        return version ? [{ instructionId: version.instructionId, number: numbers.get(version.instructionId) ?? '', versionId: version.id, versionNumber: version.number, at: toUtcIso(row.acknowledgedAt), locale: row.locale }] : []
      }),
    }
  })
}

// ---- a paper acknowledgement, recorded by the office -----------------------------------------------------------------------------

export interface PaperBody {
  readonly workerId: string
  readonly locale: string
  /** When it was signed; default now. */
  readonly acknowledgedAt?: string | undefined
}

/** POST /production/instructions/:instructionId/versions/:versionId/acknowledgements. */
export async function recordPaper(caller: CommandCaller, instructionId: string, versionId: string, body: PaperBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  const facts = await caller.withClient(async (client) => {
    const db = client as Db
    const instruction = await readInstruction(db, context, instructionId)
    assertMay(context, PRODUCTION_INSTRUCTIONS_PEOPLE, instruction.companyId, 'Acknowledgements are a training record: HR records them (production.instructions.people).')
    const version = await readVersion(db, instruction, versionId)
    if (statusOf(version) !== 'PUBLISHED' && statusOf(version) !== 'SUPERSEDED') refuse(notPublishedRefusal(version.number))
    const worker = isUuid(body.workerId) ? await db.worker.findUnique({ where: { id: body.workerId }, select: { id: true, siteId: true, companyId: true, employeeId: true, status: true } }) : null
    if (!worker || worker.companyId !== instruction.companyId) throw new ValidationError('Not a floor worker of this company.', [{ path: 'body/workerId', message: 'Pick a floor worker of the instruction’s company.' }])
    return { instruction, version, worker }
  })
  if (!ACK_LANGUAGE.test(body.locale)) throw new ValidationError('The language is its ISO 639-1 code (it, en, ro).', [{ path: 'body/locale', message: 'Expected two lower-case letters.' }])
  const at = body.acknowledgedAt ? parseInstant(body.acknowledgedAt) : null
  await inWords(() =>
    command(caller, { name: 'production.recordInstructionPaper', idempotencyKey, input: { instructionId, versionId, ...body } }, async (tools) => {
      const { tx, now } = tools
      const signed = at ?? now
      if (signed.getTime() > now.getTime()) throw new ValidationError('A paper is signed today or before.', [{ path: 'body/acknowledgedAt', message: 'Not in the future.' }])
      if (facts.version.publishedAt && signed.getTime() < facts.version.publishedAt.getTime()) throw new ValidationError(`Version ${facts.version.number} was published on ${toUtcIso(facts.version.publishedAt).slice(0, 10)}: nobody saw it before.`, [{ path: 'body/acknowledgedAt', message: 'Before the version was published.' }])
      await lockSeen(tx, facts.version.id, facts.worker.id)
      const earlier = await tx.instructionAcknowledgement.findFirst({ where: { versionId: facts.version.id, workerId: facts.worker.id }, select: { acknowledgedAt: true } })
      if (earlier) refuse({ code: 'SEEN_ALREADY', message: `This person saw version ${facts.version.number} already (${toUtcIso(earlier.acknowledgedAt).slice(0, 10)}): one acknowledgement per version.` })
      const id = newId()
      await tx.instructionAcknowledgement.create({ data: { id, siteId: facts.worker.siteId, versionId: facts.version.id, workerId: facts.worker.id, employeeId: facts.worker.employeeId, locale: body.locale, acknowledgedAt: signed, createdById: context.actorId }, select: { id: true } })
      tools.audit({ recordType: ACK_RECORD, recordId: id, companyId: facts.instruction.companyId, siteId: facts.worker.siteId, after: { instructionId: facts.instruction.id, versionId: facts.version.id, versionNumber: facts.version.number, workerId: facts.worker.id, locale: body.locale, acknowledgedAt: toUtcIso(signed), way: 'PAPER' } })
      tools.emit({ type: 'production.instruction_acknowledged', subject: facts.instruction.id, companyId: facts.instruction.companyId, siteId: facts.worker.siteId, payload: { instructionId: facts.instruction.id, number: facts.instruction.number, versionId: facts.version.id, versionNumber: facts.version.number, siteId: facts.worker.siteId, way: 'PAPER' } })
      return { id }
    }),
  )
  return acknowledgementsOf(caller, instructionId)
}
