import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { can } from '@nexus/factory-domain/core/permissions'
import { shadeLotKey, type ShadeFacts } from '@nexus/factory-domain/inventory/reservations/shade'
import { shadeSummary } from '@nexus/factory-domain/production/cutboard/shade'
import { WORKORDERS_VIEW } from '@nexus/factory-domain/production/work-orders/permissions'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { readAtWorkOrder } from '../../inventory/issue/store'
import { shadeFactsOf, shadeRuleFor } from '../../inventory/reservations/shade'
import { officeContextOf } from '../reports/daily'
import { liveEntries } from '../yield/views'
import type { AreaUom } from './board'

/**
 * GET /production/cutboard/work-orders/:workOrderId/leather (B-W2b-130; SCM-206; design production.workorders "Materials & leather"
 * › Leather: "lot(s) and shade group (W1 the cutter keeps one dye batch by hand; W2b one shade lot rule) · hides"). For each leather
 * (an article tracked by the hide) of the work order's materials: the shade lots of the hides it holds (issued less returned above
 * 0), has reserved (ACTIVE HIDE reservations) and has cut (its live cut log), with the hides of each, and whether they keep the
 * site's shade rule (factory-domain production/cutboard/shade). Office, workorders.view on the work order. No money, no person.
 */

const unique = (values: readonly (string | null | undefined)[]): string[] => [...new Set(values.filter((value): value is string => typeof value === 'string'))]
const materialKey = (itemId: string, itemColourId: string | null) => `${itemId}|${itemColourId ?? '-'}`

/** GET /production/cutboard/work-orders/:workOrderId/leather. */
export async function workOrderLeather(caller: CommandCaller, workOrderId: string) {
  const context = officeContextOf(caller)
  return caller.withClient(async (db) => {
    const workOrder = await db.workOrder.findUnique({ where: { id: workOrderId }, select: { id: true, number: true, status: true, companyId: true, siteId: true } })
    if (!workOrder || !can(actorOf(context), WORKORDERS_VIEW, workOrder)) throw new NotFoundError('Work order not found.')
    const rule = await shadeRuleFor(db, workOrder.siteId)

    // The leathers of the work order: its planned materials tracked by the hide.
    const planned = await db.workOrderMaterial.findMany({ where: { workOrderId }, select: { itemId: true, itemColourId: true } })
    const items = new Map(
      (await db.item.findMany({ where: { id: { in: unique(planned.map((row) => row.itemId)) }, tracking: 'HIDE' }, select: { id: true, code: true, name: true, baseUom: true } })).map((row) => [row.id, row]),
    )
    const leathers = new Map<string, { itemId: string; itemColourId: string | null }>()
    for (const row of planned) if (items.has(row.itemId)) leathers.set(materialKey(row.itemId, row.itemColourId), { itemId: row.itemId, itemColourId: row.itemColourId })
    if (leathers.size === 0) return { workOrder: { id: workOrder.id, number: workOrder.number, status: workOrder.status }, rule, materials: [] }

    // The hides it holds, has reserved and has cut, each with its material.
    const held = (await readAtWorkOrder(db, workOrder.siteId, workOrder.id, { hideId: { not: null } }))
      .filter((row) => row.hideId !== null && new Dec(row.quantity).greaterThan(0))
      .map((row) => ({ hideId: row.hideId!, key: materialKey(row.itemId, row.itemColourId) }))
    const reserved = (
      await db.reservation.findMany({ where: { workOrderId, status: 'ACTIVE', kind: 'HIDE', hideId: { not: null } }, select: { hideId: true, itemId: true, itemColourId: true } })
    ).map((row) => ({ hideId: row.hideId!, key: materialKey(row.itemId, row.itemColourId) }))
    const entries = await liveEntries(db, { workOrderId })
    const cutHides = await db.hide.findMany({ where: { id: { in: unique(entries.map((entry) => entry.hideId)) } }, select: { id: true, itemId: true, lotId: true } })
    const cutLots = new Map((await db.lot.findMany({ where: { id: { in: unique(cutHides.map((hide) => hide.lotId)) } }, select: { id: true, itemColourId: true } })).map((row) => [row.id, row.itemColourId]))
    const cut = cutHides.map((hide) => ({ hideId: hide.id, key: materialKey(hide.itemId, cutLots.get(hide.lotId) ?? null) }))

    const facts = await shadeFactsOf(db, unique([...held, ...reserved, ...cut].map((row) => row.hideId)))
    const lotRefs = new Map(
      (await db.lot.findMany({ where: { id: { in: unique([...facts.values()].map((fact) => fact.lotId)) } }, select: { id: true, code: true, supplierLotRef: true } })).map((row) => [row.id, row]),
    )
    const colours = new Map((await db.itemColour.findMany({ where: { id: { in: unique([...leathers.values()].map((row) => row.itemColourId)) } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, row]))

    const materials = [...leathers.entries()].map(([key, material]) => {
      const item = items.get(material.itemId)!
      const lots = new Map<string, { fact: ShadeFacts; held: Set<string>; reserved: Set<string>; cut: Set<string> }>()
      const add = (rows: readonly { hideId: string; key: string }[], into: 'held' | 'reserved' | 'cut') => {
        for (const row of rows.filter((entry) => entry.key === key)) {
          const fact = facts.get(row.hideId)
          if (!fact) continue
          const shadeKey = shadeLotKey(fact)
          const lot = lots.get(shadeKey) ?? { fact, held: new Set<string>(), reserved: new Set<string>(), cut: new Set<string>() }
          lot[into].add(row.hideId)
          lots.set(shadeKey, lot)
        }
      }
      add(held, 'held')
      add(reserved, 'reserved')
      add(cut, 'cut')
      const summary = shadeSummary(rule, [...lots.entries()].map(([shadeKey, lot]) => ({ key: shadeKey, outOfShade: lot.fact.outOfShade })))
      const all = (into: 'held' | 'reserved' | 'cut') => new Set([...lots.values()].flatMap((lot) => [...lot[into]])).size
      return {
        item: { id: item.id, code: item.code, name: item.name, uom: item.baseUom as AreaUom },
        colour: material.itemColourId ? (colours.get(material.itemColourId) ?? null) : null,
        ...summary,
        lots: [...lots.entries()].map(([shadeKey, lot]) => ({
          key: shadeKey,
          lot: { id: lot.fact.lotId, code: lotRefs.get(lot.fact.lotId)?.code ?? lot.fact.lotCode, supplierLotRef: lotRefs.get(lot.fact.lotId)?.supplierLotRef ?? null },
          shade: lot.fact.shadeLabel,
          outOfShade: lot.fact.outOfShade,
          held: lot.held.size,
          reserved: lot.reserved.size,
          cut: lot.cut.size,
        })),
        hides: { held: all('held'), reserved: all('reserved'), cut: all('cut') },
      }
    })
    return { workOrder: { id: workOrder.id, number: workOrder.number, status: workOrder.status }, rule, materials }
  })
}
