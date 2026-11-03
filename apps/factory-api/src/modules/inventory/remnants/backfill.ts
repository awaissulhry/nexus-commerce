import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { quantityText } from '@nexus/factory-domain/inventory/ledger/moves'
import { INVENTORY_ISSUE } from '@nexus/factory-domain/inventory/permissions'
import { backfillRefusal } from '@nexus/factory-domain/inventory/remnants/rules'
import { Dec, ZERO } from '@nexus/factory-domain/tax/decimal'
import { command, type CommandCaller } from '../../../core/command'
import { mayAt, officeContextOf } from '../ledger/access'
import { lockHideCuts, readItems, readSiteStock } from '../issue/store'
import { RemnantRefusedError, tagRemnantInCommand, REMNANT_SELECT } from './lifecycle'

/**
 * Tagging a W1 remnant (B-W2b-100; SCM-254; B-W2b-80's note: "a Remnant may name their RETURN move, once"): before W2b a cut
 * hide came back as a RETURN and its state REMNANT, with no tag of its own. The office (inventory.issue, the warehouse that
 * takes returns) gives it one: ONE command under the hide's cut lock, the hide's last move into stock from a work order (not
 * reversed), what of the hide is in stock now (at most that move), a Remnant naming the move at the move's place, then moved
 * to where the hide's stock lies now when it was carried elsewhere. Refused in words: not a remnant, nothing in stock, no
 * such return, a tag already (409 `refusal/<CODE>`).
 */

export interface BackfillInput {
  readonly hideId: string
  readonly note?: string | null | undefined
}

export async function tagW1Remnant(caller: CommandCaller, body: BackfillInput, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const hide = isUuid(body.hideId) ? await caller.withClient((client) => client.hide.findUnique({ where: { id: body.hideId }, select: { id: true, code: true, siteId: true, lotId: true, itemId: true, state: true, lot: { select: { companyId: true } } } })) : null
  if (!hide || !mayAt(context, INVENTORY_ISSUE, { companyId: hide.lot.companyId, siteId: hide.siteId })) throw new NotFoundError('Hide not found.')
  const { result } = await command(caller, { name: 'inventory.tagRemnant', idempotencyKey, input: body }, async (tools) => {
    const { tx } = tools
    await lockHideCuts(tx, context.tenantId, hide.siteId, hide.id)
    const item = (await readItems(tx, [hide.itemId])).get(hide.itemId)!
    const stock = await readSiteStock(tx, hide.siteId, { itemIds: [hide.itemId], hideId: hide.id })
    const onHand = stock.reduce((sum, balance) => sum.plus(balance.onHand), ZERO)
    const last = await tx.stockMove.findFirst({ where: { hideId: hide.id, reason: { in: ['RETURN', 'REMNANT'] }, reversalOfId: null, workOrderId: { not: null }, toLocationId: { not: null } }, orderBy: { id: 'desc' } })
    const reversed = last ? (await tx.stockMove.count({ where: { reversalOfId: last.id } })) > 0 : false
    const liveTags = last ? await tx.remnant.count({ where: { moveId: last.id, state: { not: 'VOID' } } }) : 0
    const live = await tx.remnant.count({ where: { hideId: hide.id, state: { in: ['IN_STOCK', 'ISSUED'] } } })
    const refusal = backfillRefusal({ hideCode: hide.code, hideState: hide.state, onHand, lastReturn: last ? { reversed } : null, liveTags: liveTags + live })
    if (refusal) throw new RemnantRefusedError(refusal.code, refusal.message)
    const move = last!
    const baseArea = Dec.min(onHand, new Dec(move.baseQuantity.toString()))
    if (!baseArea.greaterThan(0)) throw new ValidationError(`None of hide ${hide.code} is in stock.`, [{ path: 'body/hideId', message: 'Nothing in stock.' }])
    let row = await tagRemnantInCommand(tools, {
      move: { id: move.id, companyId: move.companyId, siteId: move.siteId, toLocationId: move.toLocationId, quantity: move.quantity.toString(), uom: move.uom, baseQuantity: move.baseQuantity.toString(), workOrderId: move.workOrderId },
      hide: { id: hide.id, lotId: hide.lotId, itemId: hide.itemId },
      baseUom: item.baseUom,
      source: 'BACKFILL',
      ...(baseArea.equals(new Dec(move.baseQuantity.toString())) ? {} : { baseArea: quantityText(baseArea) }),
      note: body.note ?? null,
    })
    // Carried elsewhere since: the tag says where the hide's stock lies now (the one place that holds it).
    const holding = stock.filter((balance) => balance.onHand.greaterThan(0))
    if (holding.length === 1 && holding[0]!.locationId !== row.locationId) {
      row = await tx.remnant.update({ where: { id: row.id }, data: { locationId: holding[0]!.locationId, version: { increment: 1 }, updatedAt: tools.now }, select: REMNANT_SELECT })
      tools.audit({ action: 'inventory.remnantPlace', recordType: 'Remnant', recordId: row.id, companyId: row.companyId, siteId: row.siteId, before: { locationId: move.toLocationId }, after: { locationId: row.locationId } })
    }
    return { remnantId: row.id, code: row.code }
  })
  return result
}
