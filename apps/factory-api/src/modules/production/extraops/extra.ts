import { InvalidStateError } from '@nexus/factory-domain/core/errors'
import { newId, isUuid } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { paysOn, rateFor } from '@nexus/factory-domain/people/earnings/rules'
import { EXTRA_OPERATION_ACTION, EXTRA_REASONS, extraOperationProblem, extraPayOf, extraReasonText, unplannedSeq, type ExtraPay, type ExtraReasonCode } from '@nexus/factory-domain/production/extraops/rules'
import { PRODUCTION_EXTRAOPS_ADD } from '@nexus/factory-domain/production/extraops/permissions'
import { isOpen } from '@nexus/factory-domain/production/scans/rules'
import { WORKORDERS_VIEW } from '@nexus/factory-domain/production/work-orders/permissions'
import type { WorkCentreKind } from '@nexus/factory-domain/product/routing/operations'
import { command, type CommandCaller, type CommandTx } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { PayFacts } from '../../people/earnings/store'
import { floorOrOffice, scanWorkOrder, systemView } from '../scans/access'
import { readHeader, readOperations, scanWorkOrderLock, type Reader, type ScanHeader } from '../scans/store'

/**
 * An unplanned operation (B-W2b-47, B-W2b-82; MES-086 "add an unplanned operation to a work order with a reason"; factory-
 * domain extraops/rules says what it is). Each add is ONE command (the floor's key: its Idempotency-Key): the
 * WorkOrderOperation row a bundle is scanned at, a row of the audit log on the work order with who, where and the words of
 * "Other", and production.extra_operation_added. The list comes from the audit log, so records from before B-W2b-82 stay
 * (`workOrderOperationId` null: a record only); the floor role reads no audit row, so a tablet's read goes through the
 * tenant's system caller, after the caller's own check of the work order. Whether a rate pays it is read the same way.
 */

const OPERATION = { id: true, code: true, name: true, companyId: true, status: true, workCentreKind: true, standardMinutes: true } as const

interface ExtraRecord {
  readonly id: string
  /** The step a bundle is scanned at; null: a record from before B-W2b-82. */
  readonly workOrderOperationId: string | null
  /** Its place in the work order. */
  readonly seq: number | null
  readonly at: string
  readonly operation: { readonly id: string; readonly code: string; readonly name: string; readonly workCentreKind: WorkCentreKind; readonly standardMinutes: string }
  readonly reasonCode: ExtraReasonCode
  readonly reason: string | null
  readonly addedOn: 'FLOOR' | 'OFFICE'
}

const objectOf = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {})

async function readAdded(db: Reader, workOrderId: string): Promise<ExtraRecord[]> {
  const rows = await db.auditLog.findMany({ where: { recordType: 'WorkOrder', recordId: workOrderId, action: EXTRA_OPERATION_ACTION }, select: { at: true, audience: true, after: true, reason: true }, orderBy: [{ at: 'asc' }, { id: 'asc' }] })
  const steps = new Map((await db.workOrderOperation.findMany({ where: { workOrderId, routingSeq: null }, select: { id: true, seq: true } })).map((row) => [row.id, row.seq]))
  return rows.map((row) => {
    const after = objectOf(row.after)
    const id = after.recordId as string
    return { id, workOrderOperationId: steps.has(id) ? id : null, seq: steps.get(id) ?? null, at: toUtcIso(row.at), operation: objectOf(after.operation) as unknown as ExtraRecord['operation'], reasonCode: after.reasonCode as ExtraReasonCode, reason: row.reason, addedOn: row.audience === 'FLOOR' ? 'FLOOR' : 'OFFICE' }
  })
}

/**
 * What a report at each library operation pays at the work order's site today (no figure): read like pay reads it, by the
 * library operation, the work order's style and sizes, any line (a rate of one line pays there). Read as the tenant's
 * system caller: a tablet has no right to a rate.
 */
async function paysOf(caller: CommandCaller, workOrder: Pick<ScanHeader, 'id' | 'siteId' | 'styleId'>, operationIds: readonly string[]): Promise<Map<string, ExtraPay>> {
  return systemView(caller).withClient(async (db) => {
    const now = serverClock.now()
    const facts = new PayFacts(db, now)
    const site = await facts.site(workOrder.siteId)
    const day = await facts.dayAt(workOrder.siteId, now)
    const piecePayOn = paysOn(site.windows, day)
    if (!piecePayOn) return new Map(operationIds.map((id) => [id, extraPayOf({ piecePayOn, rated: false })]))
    const rates = (await facts.ratesAt(workOrder.siteId)).map((rate) => ({ ...rate, lineId: null }))
    const sizes = (await db.workOrderSize.findMany({ where: { workOrderId: workOrder.id }, select: { size: true } })).map((row) => row.size)
    const rated = (operationId: string) => sizes.some((size) => rateFor(rates, { day, operationId, styleId: workOrder.styleId, lineId: null, size }) !== null)
    return new Map(operationIds.map((id) => [id, extraPayOf({ piecePayOn, rated: rated(id) })]))
  })
}

/** One add at a time per work order: its place and "once per operation" are read under this lock (scans wait for nothing). */
async function lockAdds(tx: CommandTx, tenantId: string, workOrderId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.extra-operation', ${tenantId}::uuid, ${workOrderId}::uuid), 0))`
}

/** The work centre it runs at: the work order's own of that kind, else the site's first active one (as a release maps a step). */
async function centreOf(db: Reader, workOrder: Pick<ScanHeader, 'siteId'>, kind: string, operations: Awaited<ReturnType<typeof readOperations>>): Promise<string | null> {
  const own = operations.find((operation) => operation.workCentreKind === kind)
  if (own) return own.workCentreId
  const centre = await db.workCentre.findFirst({ where: { siteId: workOrder.siteId, status: 'ACTIVE', kind: kind as WorkCentreKind }, select: { id: true }, orderBy: { code: 'asc' } })
  return centre?.id ?? null
}

const workOrderRef = (workOrder: Pick<ScanHeader, 'id' | 'number'>) => ({ id: workOrder.id, number: workOrder.number })
const operationOf = (row: { readonly id: string; readonly code: string; readonly name: string; readonly workCentreKind: string; readonly standardMinutes: { toString(): string } }) => ({ id: row.id, code: row.code, name: row.name, workCentreKind: row.workCentreKind as WorkCentreKind, standardMinutes: row.standardMinutes.toString() })

/** GET …/work-orders/:workOrderId (office): the unplanned operations of the work order. */
export async function listExtraOperations(caller: CommandCaller, workOrderId: string) {
  const workOrder = await scanWorkOrder(caller, workOrderId, WORKORDERS_VIEW)
  return { workOrder: workOrderRef(workOrder), added: await caller.withClient((db) => readAdded(db, workOrder.id)) }
}

/** GET …/work-orders/:workOrderId/choices: what may be added, what it would pay, why, and what was. */
export async function extraChoices(caller: CommandCaller, workOrderId: string) {
  const workOrder = await scanWorkOrder(caller, workOrderId, PRODUCTION_EXTRAOPS_ADD)
  const operations = await caller.withClient(async (db) => {
    const planned = new Set((await readOperations(db, workOrder.id)).map((operation) => operation.code))
    const library = await db.operation.findMany({ where: { status: 'ACTIVE', OR: [{ companyId: null }, { companyId: workOrder.companyId }] }, select: OPERATION, orderBy: { code: 'asc' } })
    return library.filter((operation) => !planned.has(operation.code)).map(operationOf)
  })
  const pays = await paysOf(caller, workOrder, operations.map((operation) => operation.id))
  return {
    workOrder: workOrderRef(workOrder),
    operations: operations.map((operation) => ({ ...operation, pays: pays.get(operation.id)! })),
    reasons: EXTRA_REASONS.map((reason) => ({ code: reason.code, label: reason.label, needsNote: reason.needsNote })),
    added: await systemView(caller).withClient((db) => readAdded(db, workOrder.id)),
  }
}

export interface ExtraInput {
  readonly operationId: string
  readonly reasonCode: ExtraReasonCode
  readonly note?: string | undefined
}

/** POST …/work-orders/:workOrderId: the step and its record, with its reason, on a RELEASED or IN_PROGRESS work order. */
export async function addExtraOperation(caller: CommandCaller, workOrderId: string, input: ExtraInput, idempotencyKey?: string) {
  const context = floorOrOffice(caller)
  const found = await scanWorkOrder(caller, workOrderId, PRODUCTION_EXTRAOPS_ADD)
  const note = input.note?.trim() || null
  const { result, replayed } = await command(caller, { name: 'production.addExtraOperation', idempotencyKey, input: { workOrderId: found.id, ...input } }, async (tools) => {
    const { tx } = tools
    // Lock order of a scan (scans/store): a status move of the work order waits for this add, and it for the move.
    await scanWorkOrderLock(tx, context.tenantId, found.id)
    await lockAdds(tx, context.tenantId, found.id)
    const workOrder = (await readHeader(tx, found.id))!
    const row = isUuid(input.operationId) ? await tx.operation.findUnique({ where: { id: input.operationId }, select: OPERATION }) : null
    const operations = await readOperations(tx, workOrder.id)
    const same = row ? operations.find((operation) => operation.code === row.code) : undefined
    const centreId = row ? await centreOf(tx, workOrder, row.workCentreKind, operations) : null
    const problem = extraOperationProblem({
      workOrder: { number: workOrder.number, open: isOpen(workOrder.status) },
      operation: row ? { code: row.code, active: row.status === 'ACTIVE' && (row.companyId === null || row.companyId === workOrder.companyId) } : null,
      planned: same !== undefined && !same.unplanned,
      added: same?.unplanned === true,
      centre: row ? { kind: row.workCentreKind, found: centreId !== null } : null,
      reasonCode: input.reasonCode,
      note,
    })
    if (problem) throw new InvalidStateError(problem)
    const operation = operationOf(row!)
    const id = newId()
    const seq = unplannedSeq(operations.map((entry) => entry.seq))
    const { styleRevisionId } = await tx.workOrder.findUniqueOrThrow({ where: { id: workOrder.id }, select: { styleRevisionId: true } })
    // The tablet's lead stays out of the row, as a floor record at a station site does; the audit row says who.
    await tx.workOrderOperation.create({
      data: { id, siteId: workOrder.siteId, workOrderId: workOrder.id, styleRevisionId: styleRevisionId!, seq, routingSeq: null, operationId: row!.id, unplannedReason: input.reasonCode, code: row!.code, name: row!.name, standardMinutes: row!.standardMinutes, scanRequired: false, workCentreId: centreId!, createdById: context.audience === 'office' ? context.actorId : null },
      select: { id: true },
    })
    const reason = extraReasonText(input.reasonCode, note)
    tools.audit({ action: EXTRA_OPERATION_ACTION, recordType: 'WorkOrder', recordId: workOrder.id, companyId: workOrder.companyId, siteId: workOrder.siteId, after: { recordId: id, seq, operation, reasonCode: input.reasonCode }, reason })
    tools.emit({
      type: 'production.extra_operation_added',
      subject: workOrder.id,
      companyId: workOrder.companyId,
      siteId: workOrder.siteId,
      payload: { workOrderId: workOrder.id, number: workOrder.number, siteId: workOrder.siteId, recordId: id, operationId: operation.id, code: operation.code, reasonCode: input.reasonCode },
    })
    return { id, workOrderOperationId: id, seq, at: toUtcIso(tools.now), operation, reasonCode: input.reasonCode, reason, addedOn: context.audience === 'floor' ? ('FLOOR' as const) : ('OFFICE' as const) } satisfies ExtraRecord
  })
  const pays = (await paysOf(caller, found, [result.operation.id])).get(result.operation.id)!
  return { record: { ...result, pays }, replayed }
}
