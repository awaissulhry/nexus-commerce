import type { Prisma } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import { changeOperation, newOperation, type OperationFields } from '@nexus/factory-domain/product/routing/operations'
import { importRecordValues, operationInputOf, operationsImporter, patchOf } from '@nexus/factory-domain/product/routing/importer'
import { PRODUCT_OPERATIONS_MANAGE, PRODUCT_ROUTING_VIEW } from '@nexus/factory-domain/product/routing/permissions'
import { ApiError } from '../../../core/errors'
// Types only: platform/imports/registry.ts lists this adapter, so a value import back from it would be a cycle.
import type { ImportAdapter } from '../../../platform/imports/registry'
import { mayWrite } from '../materials/store'
import { clearNames, fieldsOf, OPERATION_COLUMNS } from './store'

/**
 * The operation library's import adapter (platform/imports; feature PRD-109; design products.operations "Import (W2a)"):
 * factory-domain's `operationsImporter` decides what each row does in the dry run; this loads the operations the codes
 * find and writes one planned row inside the batch's command, with its audit row and its event (`operation.created`,
 * `operation.updated`), as the library's routes do. Writing needs product.operations.manage, seeing the plans
 * product.routing.view (the engine checks both against the job's company); a job for every company needs
 * product.operations.manage over every company. A code of another company's operation is a row error, never a duplicate
 * insert. A routing never changes: its steps keep their copies.
 */

const ACTION = 'product.operations.import'

/** Stops the batch: the operation changed since the dry run in a way the row no longer fits. */
class ImportRowRefused extends ApiError {
  constructor(code: string, detail: string) {
    super('conflict', `The import row for ${code} no longer fits the operation: ${detail}. Run the dry run again.`)
  }
}

const audited = (fields: Partial<OperationFields>): Record<string, unknown> => ({ ...fields })

export const operationsImportAdapter = Object.freeze({
  importer: operationsImporter,
  permission: PRODUCT_OPERATIONS_MANAGE,
  viewPermission: PRODUCT_ROUTING_VIEW,

  authorize(actor, job) {
    if (job.companyId === null && !mayWrite(actor, PRODUCT_OPERATIONS_MANAGE, null)) {
      return [{ path: 'companyId', message: 'An operations import for every company needs product.operations.manage over every company; import for one company instead.' }]
    }
    return []
  },

  async load(client, keys, scope) {
    const codes = keys.map((key) => String(key.code))
    const rows = await client.operation.findMany({ where: { code: { in: codes } }, select: OPERATION_COLUMNS })
    const ids = rows.map((row) => row.id)
    const used = new Set(ids.length === 0 ? [] : (await client.routingOperation.findMany({ where: { operationId: { in: ids } }, select: { operationId: true }, distinct: ['operationId'] })).map((row) => row.operationId))
    return rows.map((row) => ({ id: row.id, values: importRecordValues({ fields: fieldsOf(row), status: row.status, foreign: row.companyId !== scope.companyId, used: used.has(row.id) }) }))
  },

  async write(tools, row, scope) {
    const { tx, now } = tools
    const code = String(row.key.code)
    if (row.action === 'CREATE') {
      const outcome = newOperation(operationInputOf(row.values))
      if (!outcome.ok) throw new ImportRowRefused(code, outcome.issues.map((issue) => issue.message).join(' '))
      const operation = outcome.operation
      if (await tx.operation.findFirst({ where: { code: operation.code }, select: { id: true } })) throw new ImportRowRefused(code, 'the code was taken since')
      const id = newId()
      await tx.operation.create({
        data: { ...operation, nameI18n: operation.nameI18n ?? undefined, id, companyId: scope.companyId, createdAt: now, updatedAt: now, createdById: tools.context.audience === 'office' ? tools.context.actorId : null },
        select: { id: true },
      })
      tools.audit({ action: ACTION, recordType: 'Operation', recordId: id, companyId: scope.companyId, after: { companyId: scope.companyId, ...audited(operation), status: 'ACTIVE' } })
      tools.emit({ type: 'operation.created', subject: id, companyId: scope.companyId, payload: { operationId: id, code: operation.code } })
      return { recordId: id }
    }

    const recordId = row.recordId!
    // The row FOR UPDATE: the library's own writes compare and set its version under the same lock.
    await tx.$queryRaw`SELECT "id" FROM "Operation" WHERE "id" = ${recordId}::uuid FOR UPDATE`
    const current = await tx.operation.findUniqueOrThrow({ where: { id: recordId }, select: OPERATION_COLUMNS })
    if (current.status !== 'ACTIVE' || current.companyId !== scope.companyId) throw new ImportRowRefused(code, 'it was archived or moved')
    const before = fieldsOf(current)
    const used = (await tx.routingOperation.count({ where: { operationId: recordId } })) > 0
    const change = changeOperation(before, patchOf(row.values, before.nameI18n), used)
    if (!change.ok) throw new ImportRowRefused(code, change.issues.map((issue) => issue.message).join(' '))
    const { operation: next, changed } = change
    if (changed.length > 0) {
      const data = Object.fromEntries(changed.filter((field) => !(field === 'nameI18n' && next.nameI18n === null)).map((field) => [field, next[field]])) as Prisma.OperationUncheckedUpdateInput
      // command() bumps only the record it guards (the import job): the operation's version moves here, so an open
      // edit of it sees the import as a newer version.
      await tx.operation.update({ where: { id: recordId }, data: { ...data, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
      if (changed.includes('nameI18n') && next.nameI18n === null) await clearNames(tx, recordId)
      tools.audit({
        action: ACTION,
        recordType: 'Operation',
        recordId,
        companyId: current.companyId,
        before: Object.fromEntries(changed.map((field) => [field, before[field]])),
        after: Object.fromEntries(changed.map((field) => [field, next[field]])),
      })
      tools.emit({ type: 'operation.updated', subject: recordId, companyId: current.companyId, payload: { operationId: recordId, code: next.code, fields: [...changed] } })
    }
    return { recordId }
  },
} satisfies ImportAdapter)
