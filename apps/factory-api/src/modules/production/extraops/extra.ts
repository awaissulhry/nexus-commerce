import { InvalidStateError } from '@nexus/factory-domain/core/errors'
import { newId, isUuid } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { EXTRA_OPERATION_ACTION, EXTRA_REASONS, extraOperationProblem, extraReasonText, type ExtraReasonCode } from '@nexus/factory-domain/production/extraops/rules'
import { PRODUCTION_EXTRAOPS_ADD } from '@nexus/factory-domain/production/extraops/permissions'
import { isOpen } from '@nexus/factory-domain/production/scans/rules'
import { WORKORDERS_VIEW } from '@nexus/factory-domain/production/work-orders/permissions'
import type { WorkCentreKind } from '@nexus/factory-domain/product/routing/operations'
import { command, type CommandCaller } from '../../../core/command'
import { floorOrOffice, scanWorkOrder, systemView } from '../scans/access'
import { readHeader, readOperations, type Reader, type ScanHeader } from '../scans/store'

/**
 * An unplanned operation (B-W2b-47; MES-086 "add an unplanned operation to a work order with a reason"; factory-domain
 * extraops/rules, which says what it is today and is not). Each add is ONE command (the floor's key: its Idempotency-Key), a
 * row of the audit log on the work order with its facts, and production.extra_operation_added. The floor role reads no
 * audit row, so the list is read as the tenant's system caller, after the caller's own check of the work order.
 */

const OPERATION = { id: true, code: true, name: true, companyId: true, status: true, workCentreKind: true, standardMinutes: true } as const

interface ExtraRecord {
  readonly id: string
  readonly at: string
  readonly operation: { readonly id: string; readonly code: string; readonly name: string; readonly workCentreKind: WorkCentreKind; readonly standardMinutes: string }
  readonly reasonCode: ExtraReasonCode
  readonly reason: string | null
  readonly addedOn: 'FLOOR' | 'OFFICE'
}

const objectOf = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {})

async function readAdded(db: Reader, workOrderId: string): Promise<ExtraRecord[]> {
  const rows = await db.auditLog.findMany({ where: { recordType: 'WorkOrder', recordId: workOrderId, action: EXTRA_OPERATION_ACTION }, select: { at: true, audience: true, after: true, reason: true }, orderBy: [{ at: 'asc' }, { id: 'asc' }] })
  return rows.map((row) => {
    const after = objectOf(row.after)
    return { id: after.recordId as string, at: toUtcIso(row.at), operation: objectOf(after.operation) as unknown as ExtraRecord['operation'], reasonCode: after.reasonCode as ExtraReasonCode, reason: row.reason, addedOn: row.audience === 'FLOOR' ? 'FLOOR' : 'OFFICE' }
  })
}

const workOrderRef = (workOrder: Pick<ScanHeader, 'id' | 'number'>) => ({ id: workOrder.id, number: workOrder.number })
const operationOf = (row: { readonly id: string; readonly code: string; readonly name: string; readonly workCentreKind: string; readonly standardMinutes: { toString(): string } }) => ({ id: row.id, code: row.code, name: row.name, workCentreKind: row.workCentreKind as WorkCentreKind, standardMinutes: row.standardMinutes.toString() })

/** GET …/work-orders/:workOrderId (office): the unplanned operations of the work order. */
export async function listExtraOperations(caller: CommandCaller, workOrderId: string) {
  const workOrder = await scanWorkOrder(caller, workOrderId, WORKORDERS_VIEW)
  return { workOrder: workOrderRef(workOrder), added: await caller.withClient((db) => readAdded(db, workOrder.id)) }
}

/** GET …/work-orders/:workOrderId/choices: what may be added, why, and what was. */
export async function extraChoices(caller: CommandCaller, workOrderId: string) {
  const workOrder = await scanWorkOrder(caller, workOrderId, PRODUCTION_EXTRAOPS_ADD)
  const operations = await caller.withClient(async (db) => {
    const planned = new Set((await readOperations(db, workOrder.id)).map((operation) => operation.code))
    const library = await db.operation.findMany({ where: { status: 'ACTIVE', OR: [{ companyId: null }, { companyId: workOrder.companyId }] }, select: OPERATION, orderBy: { code: 'asc' } })
    return library.filter((operation) => !planned.has(operation.code)).map(operationOf)
  })
  return {
    workOrder: workOrderRef(workOrder),
    operations,
    reasons: EXTRA_REASONS.map((reason) => ({ code: reason.code, label: reason.label, needsNote: reason.needsNote })),
    added: await systemView(caller).withClient((db) => readAdded(db, workOrder.id)),
  }
}

export interface ExtraInput {
  readonly operationId: string
  readonly reasonCode: ExtraReasonCode
  readonly note?: string | undefined
}

/** POST …/work-orders/:workOrderId: the record, with its reason, on a RELEASED or IN_PROGRESS work order. */
export async function addExtraOperation(caller: CommandCaller, workOrderId: string, input: ExtraInput, idempotencyKey?: string) {
  const context = floorOrOffice(caller)
  const found = await scanWorkOrder(caller, workOrderId, PRODUCTION_EXTRAOPS_ADD)
  const note = input.note?.trim() || null
  const { result, replayed } = await command(caller, { name: 'production.addExtraOperation', idempotencyKey, input: { workOrderId: found.id, ...input } }, async (tools) => {
    const { tx } = tools
    const workOrder = (await readHeader(tx, found.id))!
    const row = isUuid(input.operationId) ? await tx.operation.findUnique({ where: { id: input.operationId }, select: OPERATION }) : null
    const planned = row !== null && (await readOperations(tx, workOrder.id)).some((operation) => operation.code === row.code)
    const problem = extraOperationProblem({
      workOrder: { number: workOrder.number, open: isOpen(workOrder.status) },
      operation: row ? { code: row.code, active: row.status === 'ACTIVE' && (row.companyId === null || row.companyId === workOrder.companyId) } : null,
      planned,
      reasonCode: input.reasonCode,
      note,
    })
    if (problem) throw new InvalidStateError(problem)
    const operation = operationOf(row!)
    const id = newId()
    const reason = extraReasonText(input.reasonCode, note)
    tools.audit({ action: EXTRA_OPERATION_ACTION, recordType: 'WorkOrder', recordId: workOrder.id, companyId: workOrder.companyId, siteId: workOrder.siteId, after: { recordId: id, operation, reasonCode: input.reasonCode }, reason })
    tools.emit({
      type: 'production.extra_operation_added',
      subject: workOrder.id,
      companyId: workOrder.companyId,
      siteId: workOrder.siteId,
      payload: { workOrderId: workOrder.id, number: workOrder.number, siteId: workOrder.siteId, recordId: id, operationId: operation.id, code: operation.code, reasonCode: input.reasonCode },
    })
    return { id, at: toUtcIso(tools.now), operation, reasonCode: input.reasonCode, reason, addedOn: context.audience === 'floor' ? ('FLOOR' as const) : ('OFFICE' as const) } satisfies ExtraRecord
  })
  return { record: result, replayed }
}
