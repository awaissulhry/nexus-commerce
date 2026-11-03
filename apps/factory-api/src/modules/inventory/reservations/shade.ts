import { ForbiddenError, ValidationError } from '@nexus/factory-domain/core/errors'
import { can } from '@nexus/factory-domain/core/permissions'
import { INVENTORY_SHADE_OVERRIDE } from '@nexus/factory-domain/inventory/reservations/permissions'
import { DEFAULT_SHADE_RULE, shadeReasonProblem, type ShadeFacts, type ShadeRule } from '@nexus/factory-domain/inventory/reservations/shade'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import type { CommandTx } from '../../../core/command'
import { actorOf, type RequestContext } from '../../../core/context'
import { readAtWorkOrder, type Reader } from '../issue/store'

/**
 * One shade lot per order, as the API reads it (B-W2b-100; SCM-206; factory-domain inventory/reservations/shade): the rule of
 * a site, the shade facts of hides (lot code, shade group label or W1 text, out of shade), the hides an order holds (issued
 * less returned above 0) or has reserved (ACTIVE HIDE reservations), and who may let a refused hide through.
 *
 * The rule has no column yet (schema need: a site's or company's setting, e.g. ProductionSettings.shadeRule): shadeRuleFor
 * answers DEFAULT_SHADE_RULE for every site. It is the one place to read it, so the setting step changes only this.
 */

/** The shade rule of a site (no setting column yet: the default, ORDER). */
export async function shadeRuleFor(_db: Reader, _siteId: string): Promise<ShadeRule> {
  return DEFAULT_SHADE_RULE
}

/** The shade facts of these hides (their lot's code, their group's label and out-of-shade flag, else the W1 text). */
export async function shadeFactsOf(db: Pick<CommandTx, 'hide' | 'lot' | 'shadeGroup'>, hideIds: readonly string[]): Promise<Map<string, ShadeFacts>> {
  const facts = new Map<string, ShadeFacts>()
  const ids = [...new Set(hideIds)]
  if (ids.length === 0) return facts
  const hides = await db.hide.findMany({ where: { id: { in: ids } }, select: { id: true, code: true, lotId: true, shade: true, shadeGroupId: true } })
  const lots = new Map((await db.lot.findMany({ where: { id: { in: [...new Set(hides.map((hide) => hide.lotId))] } }, select: { id: true, code: true } })).map((lot) => [lot.id, lot.code]))
  const groupIds = [...new Set(hides.flatMap((hide) => (hide.shadeGroupId ? [hide.shadeGroupId] : [])))]
  const groups = new Map((groupIds.length ? await db.shadeGroup.findMany({ where: { id: { in: groupIds } }, select: { id: true, label: true, outOfShade: true } }) : []).map((group) => [group.id, group]))
  for (const hide of hides) {
    const group = hide.shadeGroupId ? groups.get(hide.shadeGroupId) : undefined
    facts.set(hide.id, {
      hideId: hide.id,
      hideCode: hide.code,
      lotId: hide.lotId,
      lotCode: lots.get(hide.lotId) ?? '',
      shadeGroupId: hide.shadeGroupId,
      shadeLabel: group?.label ?? hide.shade,
      outOfShade: group?.outOfShade ?? false,
    })
  }
  return facts
}

/** The order a shade check is about: a work order or an order line, with the item and colour of the leather. */
export interface ShadeDemand {
  readonly siteId: string
  readonly workOrderId: string | null
  readonly salesOrderLineId: string | null
  readonly itemId: string
  readonly itemColourId: string | null
}

/**
 * The hides an order holds of this leather (issued less returned above 0, a work order only) and has reserved (ACTIVE HIDE
 * reservations), with their shade facts. Read inside the caller's command, under its locks.
 */
export async function heldShades(db: Pick<CommandTx, 'hide' | 'lot' | 'shadeGroup' | 'stockMove' | 'reservation'>, demand: ShadeDemand): Promise<ShadeFacts[]> {
  const issued = demand.workOrderId
    ? (await readAtWorkOrder(db as Reader, demand.siteId, demand.workOrderId, { itemId: demand.itemId, itemColourId: demand.itemColourId, hideId: { not: null } }))
        .filter((row) => row.hideId !== null && new Dec(row.quantity).greaterThan(0))
        .map((row) => row.hideId!)
    : []
  const reserved = (
    await db.reservation.findMany({
      where: { status: 'ACTIVE', kind: 'HIDE', itemId: demand.itemId, itemColourId: demand.itemColourId, hideId: { not: null }, ...(demand.workOrderId ? { workOrderId: demand.workOrderId } : { salesOrderLineId: demand.salesOrderLineId }) },
      select: { hideId: true },
    })
  ).map((row) => row.hideId!)
  const facts = await shadeFactsOf(db, [...issued, ...reserved])
  return [...facts.values()]
}

/**
 * An override's reason, checked: none → null; a reason from someone without inventory.shade.override (or not the office) →
 * 403; a reason too short or long → 400 at `path`.
 */
export function shadeOverrideOf(context: RequestContext, scope: { readonly companyId: string; readonly siteId: string }, reason: string | null | undefined, path: string): string | null {
  if (reason === null || reason === undefined) return null
  const problem = shadeReasonProblem(reason)
  if (problem) throw new ValidationError(problem, [{ path, message: problem }])
  if (context.audience !== 'office' || !can(actorOf(context), INVENTORY_SHADE_OVERRIDE, scope)) {
    throw new ForbiddenError('Overriding the shade rule is for a person allowed to (inventory.shade.override), in the office.')
  }
  return reason.trim()
}
