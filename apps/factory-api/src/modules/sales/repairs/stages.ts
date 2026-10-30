import type { Prisma } from '@nexus/factory-db'
import { InvalidStateError, NotFoundError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { parseInstant, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { SALES_REPAIRS_MANAGE, SALES_REPAIRS_RECEIVE } from '@nexus/factory-domain/sales/repairs/permissions'
import {
  cancelProblems,
  cancelWarning,
  isFinalRepair,
  NO_INBOUND_DDT_WORDS,
  noteNeeded,
  OPEN_REPAIR_STAGES,
  receiveHeld,
  REPAIR_LIMITS,
  stageMoveProblems,
  stageWords,
  type HandMove,
  type RepairKind,
  type RepairStage,
} from '@nexus/factory-domain/sales/repairs/rules'
import { command, StaleVersionError, type CommandCaller, type CommandTools } from '../../../core/command'
import { officeRepair } from './access'
import { blank, garmentAudit, planGarment, recordOf, refuse } from './create'
import { asDay, dayOrNull, liveDdtOf, readRepair, REPAIR_COLUMNS, workOrderOf, type RepairRow, type RepairView } from './store'

/**
 * A repair's record and its moves (B-W2a-57; SAL-390 "Repair stages"; design repair.work "Move to next stage", repair.intake
 * "Received with repair DDT"): read it, change its header, record the garment's arrival, move it (estimated, approved, in
 * repair, repaired, back into repair), cancel it. Every write is ONE command(): the repair's row locked first (FOR UPDATE,
 * at the version the screen read; a shipped or cancelled one is refused in words, since its guard refuses even a version
 * bump), the refusals in words before the …_sales_w2a_guards triggers would refuse the same, the repair's version moved
 * on by every change, and for a stage change its RepairStageEvent row AFTER the move (the deferred trigger checks it at
 * commit), audit rows and events.
 *
 *   in repair   once its repair work order (B-W2a-12) is released; repaired once that work order is completed (the
 *               repair's garment is done on it); back into repair from repaired with what still needs doing (the
 *               repaired time cleared: the safety check is made again after the next repair).
 *   estimated   with what was estimated; approved with how the customer approved (the estimate sheet is W2b).
 *   cancel      before the garment arrived, or once it is approved or in repair with no live work order or DDT; a
 *               garment that is here goes back unrepaired instead (./ship.ts).
 */

const tooLong = (value: string | null | undefined, max: number): boolean => (value ?? '').trim().length > max

/** command()'s record guard by hand: the repair's row FOR UPDATE, not final, at the version the caller read. */
export async function lockRepair(tools: Pick<CommandTools, 'tx'>, repairId: string, expectedVersion: number | undefined): Promise<RepairRow> {
  const [locked] = await tools.tx.$queryRaw<{ version: number; stage: RepairStage; number: string }[]>`SELECT "version", "stage"::text AS "stage", "number" FROM "RepairOrder" WHERE "id" = ${repairId}::uuid FOR UPDATE`
  if (!locked) throw new NotFoundError('Repair not found.')
  if (isFinalRepair(locked.stage)) throw new InvalidStateError(`Repair ${locked.number} is ${stageWords(locked.stage)}: it changes no more.`)
  if (expectedVersion !== undefined && locked.version !== expectedVersion) throw new StaleVersionError('RepairOrder', repairId, locked.version, expectedVersion)
  return (await readRepair(tools.tx, repairId))!
}

/** Moves the repair's version on (every change of it), with other columns when given. */
export async function touchRepair(tools: Pick<CommandTools, 'tx' | 'now'>, repair: Pick<RepairRow, 'id'>, data: Prisma.RepairOrderUncheckedUpdateInput = {}): Promise<RepairRow> {
  return tools.tx.repairOrder.update({ where: { id: repair.id }, data: { ...data, updatedAt: tools.now, version: { increment: 1 } }, select: REPAIR_COLUMNS })
}

const actorIdOf = (tools: Pick<CommandTools, 'context'>): string | null => (tools.context.audience === 'office' ? tools.context.actorId : null)

/**
 * A stage move inside the caller's command: the repair moved (with its times), THEN its RepairStageEvent at the new
 * version (the trigger refuses it before the move), the audit row and repair.stage_changed.
 */
export async function moveStageInCommand(
  tools: CommandTools,
  repair: RepairRow,
  to: RepairStage,
  input: { readonly data?: Prisma.RepairOrderUncheckedUpdateInput; readonly note: string | null; readonly ddtId?: string | null; readonly audit?: Record<string, unknown> },
): Promise<RepairRow> {
  const after = await touchRepair(tools, repair, { ...input.data, stage: to })
  await tools.tx.repairStageEvent.create({
    data: { id: newId(), siteId: repair.siteId, repairId: repair.id, fromStage: repair.stage, stage: to, repairVersion: after.version, at: tools.now, note: input.note, requestId: tools.context.requestId, createdAt: tools.now, createdById: actorIdOf(tools) },
    select: { id: true },
  })
  tools.audit({
    recordType: 'RepairOrder',
    recordId: repair.id,
    companyId: repair.companyId,
    siteId: repair.siteId,
    before: { stage: repair.stage, version: repair.version },
    after: { stage: to, version: after.version, ...input.audit },
    ...(input.note ? { reason: input.note } : {}),
  })
  tools.emit({
    type: 'repair.stage_changed',
    subject: repair.id,
    companyId: repair.companyId,
    siteId: repair.siteId,
    payload: { repairId: repair.id, number: repair.number, from: repair.stage, to, workOrderId: repair.workOrderId, ddtId: input.ddtId ?? null },
  })
  return after
}

function noteOf(value: string | null | undefined, needed: string | null): string | null {
  const note = blank(value)
  if (note && note.length > REPAIR_LIMITS.note) refuse([{ path: 'body/note', message: `At most ${REPAIR_LIMITS.note} characters.` }], 'The note is too long.')
  if (!note && needed) refuse([{ path: 'body/note', message: needed }], needed)
  return note
}

/** GET /sales/repairs/:repairId */
export async function getRepair(caller: CommandCaller, repairId: string): Promise<{ repair: RepairView }> {
  const { repair } = await officeRepair(caller, repairId)
  return { repair: await recordOf(caller, repair.id) }
}

// ---- the garment's arrival ----------------------------------------------------------------------------------------------

export interface ReceiveBody {
  readonly version: number
  readonly at?: string | undefined
  readonly inboundDdtNumber?: string | null | undefined
  readonly inboundDdtDate?: BusinessDate | null | undefined
  readonly note?: string | null | undefined
}

/** POST /sales/repairs/:repairId/receive: AWAITING_GOODS → RECEIVED, with the customer's DDT (DPR 472/1996). */
export async function receiveRepair(caller: CommandCaller, repairId: string, body: ReceiveBody, idempotencyKey?: string): Promise<{ repair: RepairView; warnings: Issue[] }> {
  const { repair: seen } = await officeRepair(caller, repairId, SALES_REPAIRS_RECEIVE)
  const { result } = await command(caller, { name: 'repairs.receive', idempotencyKey, input: { repairId, ...body } }, async (tools) => {
    const { now } = tools
    const repair = await lockRepair(tools, seen.id, body.version)
    const held = receiveHeld(repair.number, repair.stage as RepairStage)
    if (held) throw new InvalidStateError(held)
    const at = body.at ? parseInstant(body.at)! : now
    const number = blank(body.inboundDdtNumber)
    const date = body.inboundDdtDate ?? null
    const problems: Issue[] = []
    if (at.getTime() > now.getTime() + 5 * 60_000) problems.push({ path: 'body/at', message: 'The garment arrived now or earlier.' })
    if (tooLong(number, REPAIR_LIMITS.ddtNumber)) problems.push({ path: 'body/inboundDdtNumber', message: `At most ${REPAIR_LIMITS.ddtNumber} characters.` })
    if (date && !number) problems.push({ path: 'body/inboundDdtNumber', message: "The customer's DDT number, with its date." })
    if (date && date > at.toISOString().slice(0, 10)) problems.push({ path: 'body/inboundDdtDate', message: "The customer's DDT is dated on or before the day the garment arrived." })
    if (problems.length > 0) refuse(problems, 'The arrival cannot be recorded like this.')
    const note = noteOf(body.note, null)
    await moveStageInCommand(tools, repair, 'RECEIVED', {
      data: { receivedAt: at, inboundDdtNumber: number, inboundDdtDate: date ? asDay(date) : null },
      note,
      audit: { receivedAt: toUtcIso(at), inboundDdtNumber: number, inboundDdtDate: date },
    })
    return { warnings: number ? [] : [{ path: 'body/inboundDdtNumber', message: NO_INBOUND_DDT_WORDS }] }
  })
  return { repair: await recordOf(caller, seen.id), warnings: result.warnings }
}

// ---- the hand moves ---------------------------------------------------------------------------------------------------

/** POST /sales/repairs/:repairId/stage: estimated, approved, in repair, repaired (and back into repair). */
export async function moveRepair(caller: CommandCaller, repairId: string, body: { readonly version: number; readonly to: HandMove; readonly note?: string | null | undefined }, idempotencyKey?: string): Promise<{ repair: RepairView }> {
  const { repair: seen } = await officeRepair(caller, repairId, SALES_REPAIRS_MANAGE)
  await command(caller, { name: 'repairs.move', idempotencyKey, input: { repairId, ...body } }, async (tools) => {
    const repair = await lockRepair(tools, seen.id, body.version)
    const from = repair.stage as RepairStage
    const workOrder = await workOrderOf(tools.tx, repair)
    const problems = stageMoveProblems(body.to, { number: repair.number, stage: from, workOrder: workOrder.live })
    if (problems.length > 0) throw new InvalidStateError(problems.join(' '))
    const note = noteOf(body.note, noteNeeded(from, body.to))
    const data: Prisma.RepairOrderUncheckedUpdateInput = body.to === 'REPAIRED' ? { repairedAt: tools.now } : from === 'REPAIRED' ? { repairedAt: null } : {}
    await moveStageInCommand(tools, repair, body.to, {
      data,
      note,
      audit: { ...(workOrder.any ? { workOrder: workOrder.any.number, workOrderStatus: workOrder.any.status } : {}), ...('repairedAt' in data ? { repairedAt: data.repairedAt ? toUtcIso(tools.now) : null } : {}) },
    })
    return { stage: body.to }
  })
  return { repair: await recordOf(caller, seen.id) }
}

// ---- cancel -------------------------------------------------------------------------------------------------------------

/** POST /sales/repairs/:repairId/cancel */
export async function cancelRepair(caller: CommandCaller, repairId: string, body: { readonly version: number; readonly reason: string }, idempotencyKey?: string): Promise<{ repair: RepairView; warnings: Issue[] }> {
  const { repair: seen } = await officeRepair(caller, repairId, SALES_REPAIRS_MANAGE)
  const { result } = await command(caller, { name: 'repairs.cancel', idempotencyKey, input: { repairId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const repair = await lockRepair(tools, seen.id, body.version)
    const workOrder = await workOrderOf(tx, repair)
    const problems = cancelProblems({ number: repair.number, stage: repair.stage as RepairStage, workOrder: workOrder.live, liveDdt: await liveDdtOf(tx, repair.id) })
    if (problems.length > 0) throw new InvalidStateError(problems.join(' '))
    const reason = blank(body.reason)
    if (!reason || reason.length > REPAIR_LIMITS.reason) refuse([{ path: 'body/reason', message: `Say why the repair is cancelled (at most ${REPAIR_LIMITS.reason} characters).` }], 'A reason is needed.')
    await moveStageInCommand(tools, repair, 'CANCELLED', { data: { cancelledAt: now, cancelReason: reason }, note: reason, audit: { cancelledAt: toUtcIso(now) } })
    const site = await tx.site.findUniqueOrThrow({ where: { id: repair.siteId }, select: { code: true } })
    const warning = cancelWarning(repair.receivedAt, site.code)
    return { warnings: warning ? [{ path: 'garment', message: warning }] : [] }
  })
  return { repair: await recordOf(caller, seen.id), warnings: result.warnings }
}

// ---- the header ---------------------------------------------------------------------------------------------------------

export interface HeaderBody {
  readonly version: number
  readonly kind?: RepairKind | undefined
  readonly problem?: string | undefined
  readonly serial?: string | null | undefined
  readonly styleId?: string | null | undefined
  readonly colourwayId?: string | null | undefined
  readonly size?: string | null | undefined
  readonly ownerId?: string | null | undefined
  readonly internalNote?: string | null | undefined
  readonly inboundDdtNumber?: string | null | undefined
  readonly inboundDdtDate?: BusinessDate | null | undefined
}

const GARMENT_FIELDS = ['serial', 'styleId', 'colourwayId', 'size'] as const
/** The garment changes only while nothing was made for it yet: before its work, with no live work order. */
const GARMENT_STAGES: readonly RepairStage[] = Object.freeze(['AWAITING_GOODS', 'RECEIVED', 'ESTIMATED', 'APPROVED'])

/**
 * PATCH /sales/repairs/:repairId: the kind, the problem, the owner and the internal note while it is open; the garment
 * (serial, style, colourway, size: the safety rule follows the style) before its work starts, with no live work order,
 * and not for a repair of an RMA line (the line names the garment); the customer's DDT once the garment arrived, until
 * our DDT printed it.
 */
export async function changeRepair(caller: CommandCaller, repairId: string, body: HeaderBody, idempotencyKey?: string): Promise<{ repair: RepairView; warnings: Issue[] }> {
  const { repair: seen } = await officeRepair(caller, repairId, SALES_REPAIRS_MANAGE)
  const { result } = await command(caller, { name: 'repairs.change', idempotencyKey, input: { repairId, ...body } }, async (tools) => {
    const { tx } = tools
    const tenantId = 'tenantId' in tools.context ? tools.context.tenantId : null
    const garmentAsked = GARMENT_FIELDS.some((field) => body[field] !== undefined)
    if (garmentAsked && body.serial !== undefined && blank(body.serial)) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.repair-serial', ${tenantId}::text, ${blank(body.serial)}::text), 0))`
    }
    const repair = await lockRepair(tools, seen.id, body.version)
    const problems: Issue[] = []
    const warnings: Issue[] = []
    const data: Prisma.RepairOrderUncheckedUpdateInput = {}
    const before: Record<string, unknown> = {}
    const after: Record<string, unknown> = {}
    const set = <K extends keyof RepairRow>(field: K & string, value: RepairRow[K], shown: unknown = value) => {
      if (value === repair[field] || (value instanceof Date && repair[field] instanceof Date && value.getTime() === (repair[field] as Date).getTime())) return
      ;(data as Record<string, unknown>)[field] = value
      before[field] = repair[field] instanceof Date ? dayOrNull(repair[field] as Date) : repair[field]
      after[field] = shown
    }

    if (body.kind !== undefined) set('kind', body.kind)
    if (body.problem !== undefined) {
      const problem = blank(body.problem)
      if (!problem || problem.length > REPAIR_LIMITS.problem) problems.push({ path: 'body/problem', message: `Say what is wrong (at most ${REPAIR_LIMITS.problem} characters).` })
      else set('problem', problem)
    }
    if (body.internalNote !== undefined) {
      if (tooLong(body.internalNote, REPAIR_LIMITS.internalNote)) problems.push({ path: 'body/internalNote', message: `At most ${REPAIR_LIMITS.internalNote} characters.` })
      else set('internalNote', blank(body.internalNote))
    }
    if (body.ownerId !== undefined) {
      if (body.ownerId !== null) {
        const owner = isUuid(body.ownerId) ? await tx.user.findUnique({ where: { id: body.ownerId }, select: { status: true } }) : null
        if (!owner || owner.status !== 'ACTIVE') problems.push({ path: 'body/ownerId', message: 'An active person of the office.' })
      }
      set('ownerId', body.ownerId)
    }

    if (garmentAsked) {
      const workOrder = await workOrderOf(tx, repair)
      if (repair.returnLineId) problems.push({ path: 'body/serial', message: 'The garment of a repair made from a return line is the line’s.' })
      else if (!GARMENT_STAGES.includes(repair.stage as RepairStage)) problems.push({ path: 'body/serial', message: `Repair ${repair.number} is ${stageWords(repair.stage as RepairStage)}: its garment no longer changes.` })
      else if (workOrder.live) problems.push({ path: 'body/serial', message: `Repair work order ${workOrder.live.number} is made for this garment: cancel it first to change the garment.` })
      else {
        const styleChanged = body.styleId !== undefined && body.styleId !== repair.styleId
        const garment = await planGarment(
          tx,
          {
            serial: body.serial !== undefined ? blank(body.serial) : repair.serial,
            styleId: body.styleId !== undefined ? body.styleId : repair.styleId,
            colourwayId: body.colourwayId !== undefined ? body.colourwayId : styleChanged ? null : repair.colourwayId,
            size: body.size !== undefined ? blank(body.size) : repair.size,
          },
          repair.partyId,
          problems,
          warnings,
        )
        if (garment.serial && garment.serial !== repair.serial) {
          const open = await tx.repairOrder.findFirst({ where: { serial: garment.serial, stage: { in: [...OPEN_REPAIR_STAGES] }, id: { not: repair.id } }, select: { number: true } })
          if (open) problems.push({ path: 'body/serial', message: `Repair ${open.number} is open for serial ${garment.serial}: one repair at a time per garment.` })
        }
        set('serial', garment.serial)
        set('styleId', garment.styleId)
        set('colourwayId', garment.colourwayId)
        set('size', garment.size)
        set('safetyCheckRequired', garment.safetyCheckRequired)
      }
    }

    if (body.inboundDdtNumber !== undefined || body.inboundDdtDate !== undefined) {
      const live = await liveDdtOf(tx, repair.id)
      const number = body.inboundDdtNumber !== undefined ? blank(body.inboundDdtNumber) : repair.inboundDdtNumber
      const date = body.inboundDdtDate !== undefined ? body.inboundDdtDate : dayOrNull(repair.inboundDdtDate)
      if (!repair.receivedAt) problems.push({ path: 'body/inboundDdtNumber', message: "The garment has not arrived yet: the customer's DDT is recorded with its arrival." })
      else if (live) problems.push({ path: 'body/inboundDdtNumber', message: `DDT ${live.number} printed the customer's DDT as its reference: cancel it first to change it.` })
      else {
        if (tooLong(number, REPAIR_LIMITS.ddtNumber)) problems.push({ path: 'body/inboundDdtNumber', message: `At most ${REPAIR_LIMITS.ddtNumber} characters.` })
        if (date && !number) problems.push({ path: 'body/inboundDdtNumber', message: "The customer's DDT number, with its date." })
        if (date && date > repair.receivedAt.toISOString().slice(0, 10)) problems.push({ path: 'body/inboundDdtDate', message: "The customer's DDT is dated on or before the day the garment arrived." })
        set('inboundDdtNumber', number)
        set('inboundDdtDate', date ? asDay(date) : null, date)
      }
    }
    if (problems.length > 0) refuse(problems, 'The repair cannot be changed like this.')
    const fields = Object.keys(after)
    await touchRepair(tools, repair, data)
    tools.audit({ recordType: 'RepairOrder', recordId: repair.id, companyId: repair.companyId, siteId: repair.siteId, before, after: { ...after, ...(GARMENT_FIELDS.some((field) => field in after) ? { garment: garmentAudit({ ...repair, ...(data as object) } as RepairRow) } : {}) } })
    if (fields.length > 0) tools.emit({ type: 'repair.changed', subject: repair.id, companyId: repair.companyId, siteId: repair.siteId, payload: { repairId: repair.id, number: repair.number, fields } })
    return { warnings }
  })
  return { repair: await recordOf(caller, seen.id), warnings: result.warnings }
}
