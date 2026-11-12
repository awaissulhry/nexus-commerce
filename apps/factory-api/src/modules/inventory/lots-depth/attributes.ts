import type { Prisma } from '@nexus/factory-db'
import { InvalidStateError, ValidationError } from '@nexus/factory-domain/core/errors'
import { attributesProblems, changedAttributes, mergeAttributes } from '@nexus/factory-domain/inventory/lots-depth/attributes'
import { INVENTORY_LOTS_MANAGE } from '@nexus/factory-domain/inventory/lots-depth/permissions'
import { command, type CommandCaller } from '../../../core/command'
import { readLotView } from './page'
import { lotFor, readLot } from './store'

/**
 * A lot's attributes, typed per material kind (B-W2b-313; SCM-185; design warehouse.lots lt-facts "W2b attributes:
 * thickness range, finish, tannage, grade, origin"). PATCH /inventory/lots/:lotId/attributes {version, attributes}: a key
 * with a value sets it, a key with null removes it, a key left out stays; the whole result checked against the lot's kind
 * (factory-domain inventory/lots-depth attributes.ts: the database's factory_lot_attributes_problem, in words at
 * `body/attributes/<key>`), ONE command on the Lot at the version read, `inventory.lotAttributes` audited (before → after) and
 * `lot.attributes_changed` (the keys only). A rejected lot changes no more (its quality note and lifecycle only).
 */
export async function changeAttributes(
  caller: CommandCaller,
  lotId: string,
  body: { readonly version: number; readonly attributes: Readonly<Record<string, unknown>> },
  idempotencyKey?: string,
) {
  const { lot } = await lotFor(caller, lotId, INVENTORY_LOTS_MANAGE)
  await command(caller, { name: 'inventory.lotAttributes', idempotencyKey, input: { lotId, ...body }, record: { type: 'Lot', id: lot.id, expectedVersion: body.version } }, async (tools) => {
    const current = (await readLot(tools.tx, lot.id))!
    if (current.qualityStatus === 'REJECTED') throw new InvalidStateError(`Lot ${current.code} is rejected: it changes no more.`)
    const before = (current.attributes ?? {}) as Record<string, unknown>
    const after = mergeAttributes(before, body.attributes)
    const problems = attributesProblems(current.item.kind, after, 'body/attributes')
    if (problems.length > 0) throw new ValidationError(problems.length === 1 ? problems[0]!.message : 'The attributes are not valid.', problems)
    const keys = changedAttributes(before, after)
    if (keys.length === 0) throw new ValidationError(`Nothing changes: lot ${current.code} says this already.`, [{ path: 'body/attributes', message: 'Nothing changes.' }])
    await tools.tx.lot.update({ where: { id: current.id }, data: { attributes: after as Prisma.InputJsonValue, updatedAt: tools.now }, select: { id: true } })
    tools.audit({ action: 'inventory.lotAttributes', recordType: 'Lot', recordId: current.id, companyId: current.companyId, siteId: current.siteId, before: { attributes: before }, after: { attributes: after } })
    tools.emit({ type: 'lot.attributes_changed', subject: current.id, companyId: current.companyId, siteId: current.siteId, payload: { lotId: current.id, code: current.code, keys } })
    return { lotId: current.id }
  })
  return readLotView(caller, lot.id)
}
