import { InvalidStateError } from '@nexus/factory-domain/core/errors'
import type { LibrarySettingsBody, LibrarySettingsView } from '@nexus/factory-domain/product/routing-depth/contracts'
import { sameSettings } from '@nexus/factory-domain/product/routing-depth/rules'
import { PRODUCT_OPERATIONS_MANAGE } from '@nexus/factory-domain/product/routing/permissions'
import { command, type CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { mayWrite } from '../materials/store'
import { assertMayWrite, contextOf, readOperation } from '../operations/store'
import { plannedSettings, replaceSettings } from './depth'
import { auditedSettings, depthGuarded, readMachineClasses, readSettings, settingDataOf, settingViewOf, type Db } from './store'

/**
 * A library operation's machine and stitch settings (B-W2b-225; PRD-118; design products.operations › Machine & settings:
 * needle, stitches per cm, thread ticket, attachment). The operation's default: a step copies it ("Copy from library",
 * ./depth setStepSettings fromLibrary) and keeps its own copy, frozen with its revision; a later library change leaves
 * every routing as it is (as the library's minutes, W1).
 *
 *   GET /product/operations/:operationId/settings    product.routing.view over the operation's company
 *   PUT /product/operations/:operationId/settings    product.operations.manage: the whole list under the OPERATION's
 *                                                    version (the command's record guard: a stale one is a 409); an
 *                                                    archived operation is not changed. Audit on the operation, W1's
 *                                                    `operation.updated` with the field `machineSettings`.
 */

async function viewOf(db: Db, operationId: string, may: boolean): Promise<LibrarySettingsView> {
  const operation = await db.operation.findUniqueOrThrow({ where: { id: operationId }, select: { id: true, code: true, name: true, companyId: true, status: true, version: true } })
  const rows = (await readSettings(db, 'operation', [operationId])).get(operationId) ?? []
  const classes = await readMachineClasses(db, rows.map((row) => row.machineClassId))
  const steps = await db.routingOperation.findMany({ where: { operationId, revision: { status: 'DRAFT' } }, select: { id: true } })
  const withOwn = new Set((await readSettings(db, 'step', steps.map((step) => step.id))).keys())
  return {
    operation: { ...operation },
    settings: rows.map((row) => settingViewOf(row, classes)),
    draftStepsWithout: steps.filter((step) => !withOwn.has(step.id)).length,
    may: { manage: may && operation.status === 'ACTIVE' },
  }
}

export async function getLibrarySettings(caller: CommandCaller, operationId: string): Promise<LibrarySettingsView> {
  const seen = await readOperation(caller, operationId)
  const may = mayWrite(actorOf(contextOf(caller)), PRODUCT_OPERATIONS_MANAGE, seen.companyId)
  return caller.withClient((client) => viewOf(client, operationId, may))
}

/** product.operations.setSettings: the library operation's default settings, the whole list. */
export async function setLibrarySettings(caller: CommandCaller, operationId: string, body: LibrarySettingsBody, idempotencyKey?: string): Promise<LibrarySettingsView> {
  const seen = await readOperation(caller, operationId)
  assertMayWrite(contextOf(caller), seen.companyId)
  const { result } = await depthGuarded(() =>
    command(
      caller,
      { name: 'product.operations.setSettings', idempotencyKey, input: { operationId, ...body }, record: { type: 'Operation', id: operationId, expectedVersion: body.version } },
      async (tools) => {
        const { tx } = tools
        const row = await tx.operation.findUniqueOrThrow({ where: { id: operationId }, select: { code: true, companyId: true, status: true } })
        if (row.status !== 'ACTIVE') throw new InvalidStateError(`Operation ${row.code} is archived: reactivate it to change its settings.`)
        const current = (await readSettings(tx, 'operation', [operationId])).get(operationId)?.map(settingDataOf) ?? []
        const next = await plannedSettings(tx, body.settings, current)
        if (!sameSettings(current, next)) {
          await replaceSettings(tools, { operationId }, next)
          tools.audit({ recordType: 'Operation', recordId: operationId, companyId: row.companyId, before: { machineSettings: auditedSettings(current) }, after: { machineSettings: auditedSettings(next) } })
          tools.emit({ type: 'operation.updated', subject: operationId, companyId: row.companyId, payload: { operationId, code: row.code, fields: ['machineSettings'] } })
        }
        return viewOf(tx, operationId, true)
      },
    ),
  )
  return result
}
