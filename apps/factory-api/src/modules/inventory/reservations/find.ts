import type { FactoryClient, Uom } from '@nexus/factory-db'
import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { gradeOfHide } from '@nexus/factory-domain/inventory/hides/usable'
import { quantityText } from '@nexus/factory-domain/inventory/ledger/moves'
import { baseQuantityOf } from '@nexus/factory-domain/inventory/ledger/units'
import { INVENTORY_STOCK_VIEW } from '@nexus/factory-domain/inventory/permissions'
import { findHides, type FindHide } from '@nexus/factory-domain/inventory/reservations/find'
import { Dec, ZERO } from '@nexus/factory-domain/tax/decimal'
import type { CommandCaller } from '../../../core/command'
import { mayAt, officeContextOf, siteFor } from '../ledger/access'
import { gradesOf } from '../hides/facts'
import { itemUnitsOf, readAtWorkOrder, readItems, readLocations, readSiteStock, type Reader } from '../issue/store'
import { liveTagsOf } from '../remnants/lifecycle'
import { heldShades, shadeFactsOf, shadeRuleFor } from './shade'
import { readKeyFacts } from './store'

/**
 * Find hides for a job (B-W2b-100; SCM-257, SCM-206; design warehouse.hides "Find hides for a job", production.cutting
 * "Allocate hides…", production.workorders "Reserve leather…"; one dialog for all three, built by B-W2b-131): office,
 * inventory.stock.view at the site. By a work order: its leather line (the one it plans by the hide; `itemId` picks one
 * when it plans several), what it still needs = planned − issued (net of returns) − what its ACTIVE reservations still
 * hold, and the shade lots it holds or has reserved (its own lot comes first). Or by article and colour with an area. Then
 * the hides available at the site (on hand, of a released lot not on hold, reserved for nobody), filtered by shade group and
 * by the minimum grade (by record, else the W1 text; an ungraded hide only when no minimum is asked), grouped by shade lot
 * with the proposal of ONE lot (factory-domain inventory/reservations/find). Reserving the proposal is POST
 * /inventory/reservations with its hides (the rule is checked again there). Read only; no money.
 */

export interface FindQuery {
  readonly siteId?: string | undefined
  readonly workOrderId?: string | undefined
  readonly itemId?: string | undefined
  readonly itemColourId?: string | undefined
  readonly shadeGroupId?: string | undefined
  readonly minGradeId?: string | undefined
  readonly area?: string | undefined
  readonly uom?: Uom | undefined
}

export async function findHidesForJob(caller: CommandCaller, query: FindQuery) {
  const context = officeContextOf(caller)
  let siteId: string
  let workOrder: { id: string; number: string; companyId: string; siteId: string } | null = null
  if (query.workOrderId) {
    const row = isUuid(query.workOrderId) ? await caller.withClient((client) => client.workOrder.findUnique({ where: { id: query.workOrderId! }, select: { id: true, number: true, companyId: true, siteId: true } })) : null
    if (!row || !mayAt(context, INVENTORY_STOCK_VIEW, row)) throw new NotFoundError('Work order not found.')
    workOrder = row
    siteId = row.siteId
  } else {
    if (!query.itemId) throw new ValidationError('Name a work order, or the article to find.', [{ path: 'query/itemId', message: 'A work order or an article.' }])
    siteId = (await siteFor(caller, query.siteId, INVENTORY_STOCK_VIEW, 'query/siteId')).id
  }
  return caller.withClient(async (client) => {
    const db = client as Reader
    // The leather line: the work order's (planned by the hide), or the article asked.
    let itemId = query.itemId ?? null
    let itemColourId = query.itemColourId ?? null
    let planned: string | null = null
    let issued: string | null = null
    let reserved: string | null = null
    let choices: { itemId: string; itemColourId: string | null }[] = []
    if (workOrder) {
      const lines = await client.workOrderMaterial.groupBy({ by: ['itemId', 'itemColourId'], where: { workOrderId: workOrder.id }, _sum: { baseQuantity: true } })
      const items = await readItems(db, [...new Set(lines.map((line) => line.itemId))])
      const leather = lines.filter((line) => items.get(line.itemId)?.tracking === 'HIDE')
      choices = leather.map((line) => ({ itemId: line.itemId, itemColourId: line.itemColourId }))
      const chosen = leather.filter((line) => (!itemId || line.itemId === itemId) && (query.itemColourId === undefined || line.itemColourId === query.itemColourId))
      if (chosen.length !== 1) {
        throw new ValidationError(
          leather.length === 0 ? `Work order ${workOrder.number} plans no leather by the hide.` : `Work order ${workOrder.number} plans ${leather.length} leathers by the hide: name the article (and colour).`,
          [{ path: 'query/itemId', message: leather.length === 0 ? 'No leather by the hide.' : 'Which leather?' }],
        )
      }
      itemId = chosen[0]!.itemId
      itemColourId = chosen[0]!.itemColourId
      planned = new Dec((chosen[0]!._sum.baseQuantity ?? ZERO).toString()).toFixed(4)
      const at = await readAtWorkOrder(db, siteId, workOrder.id, { itemId, itemColourId })
      issued = at.reduce((sum, row) => sum.plus(new Dec(row.quantity)), ZERO).toFixed(4)
      const open = await client.reservation.findMany({ where: { workOrderId: workOrder.id, itemId, itemColourId, status: 'ACTIVE' }, select: { quantity: true, issuedQuantity: true } })
      reserved = open.reduce((sum, row) => sum.plus(new Dec(row.quantity.toString()).minus(row.issuedQuantity.toString())), ZERO).toFixed(4)
    }
    const item = (await readItems(db, [itemId!])).get(itemId!)
    if (!item) throw new NotFoundError('Material not found.')
    if (item.tracking !== 'HIDE') throw new ValidationError(`${item.code} is not tracked hide by hide: there are no hides to find.`, [{ path: 'query/itemId', message: 'Not leather by the hide.' }])
    const colour = itemColourId ? await client.itemColour.findUnique({ where: { id: itemColourId }, select: { id: true, code: true, name: true, itemId: true } }) : null
    if (itemColourId && colour?.itemId !== item.id) throw new NotFoundError('Colour not found.')

    // The need: the area asked, else what the work order still needs.
    let need: string | null = null
    let needSource: 'ASKED' | 'WORK_ORDER' | null = null
    if (query.area !== undefined) {
      const base = baseQuantityOf({ quantity: query.area, uom: query.uom ?? item.baseUom, baseQuantity: null }, itemUnitsOf(item))
      if (base.problem) throw new ValidationError(base.problem.message, [{ path: `query/${base.problem.path === 'quantity' ? 'area' : base.problem.path}`, message: base.problem.message }])
      need = quantityText(base.baseQuantity)
      needSource = 'ASKED'
    } else if (planned !== null) {
      need = quantityText(Dec.max(ZERO, new Dec(planned).minus(issued!).minus(reserved!)))
      needSource = 'WORK_ORDER'
    }

    // The available hides: on hand, not held, reserved for nobody (availableHides below, shared with the leather plan).
    if (query.minGradeId && !(await gradesOf(client)).some((grade) => grade.id === query.minGradeId)) throw new ValidationError('Not a leather grade of the tenant.', [{ path: 'query/minGradeId', message: 'Not a grade.' }])
    const hides = await availableHides(client, { siteId, itemId: item.id, itemColourId, shadeGroupId: query.shadeGroupId, minGradeId: query.minGradeId })
    const rule = await shadeRuleFor(db, siteId)
    const held = workOrder ? await heldShades(client, { siteId, workOrderId: workOrder.id, salesOrderLineId: null, itemId: item.id, itemColourId }) : []
    const result = findHides({ need, baseUom: item.baseUom, rule, held, hides })
    const hideView = (hide: (typeof result.lots)[number]['hides'][number]) => ({
      hideId: hide.hideId,
      hideCode: hide.hideCode,
      lotId: hide.lotId,
      lotCode: hide.lotCode,
      shadeGroupId: hide.shadeGroupId,
      shadeLabel: hide.shadeLabel,
      outOfShade: hide.outOfShade,
      grade: hide.gradeCode,
      state: hide.state,
      left: hide.left,
      running: hide.running,
      proposed: hide.proposed,
      locationCodes: [...hide.locationCodes],
      remnant: hide.remnant,
    })
    return {
      site: { id: siteId },
      item: { id: item.id, code: item.code, name: item.name, baseUom: item.baseUom },
      colour: colour ? { id: colour.id, code: colour.code, name: colour.name } : null,
      workOrder: workOrder ? { id: workOrder.id, number: workOrder.number, planned, issued, reserved } : null,
      leathers: choices,
      need: { baseArea: result.need, source: needSource },
      rule,
      ordersShadeLots: held.length > 0 ? [...new Map(held.map((hide) => [`${hide.lotId}|${hide.shadeGroupId ?? hide.shadeLabel ?? '-'}`, { lotCode: hide.lotCode, shadeLabel: hide.shadeLabel }])).values()] : [],
      lots: result.lots.map((lot) => ({ key: lot.key, lotId: lot.lotId, lotCode: lot.lotCode, shadeGroupId: lot.shadeGroupId, shadeLabel: lot.shadeLabel, words: lot.words, count: lot.count, total: lot.total, covers: lot.covers, ordersOwn: lot.ordersOwn, shadeWarning: lot.shadeWarning, hides: lot.hides.map(hideView) })),
      outOfShade: result.outOfShade.map(hideView),
      proposal: result.proposal,
    }
  })
}

/**
 * The hides of one article and colour available at a site (B-W2b-100's find, extracted by B-W2b-132 so the leather plan
 * reads the same hides): on hand, of a released lot not on hold, reserved for nobody, not used up; by shade group and minimum
 * grade (by record, else the W1 text; an ungraded hide only when no minimum is asked) when asked. No permission is checked:
 * the caller checked the site.
 */
export async function availableHides(client: FactoryClient, scope: { readonly siteId: string; readonly itemId: string; readonly itemColourId: string | null; readonly shadeGroupId?: string | undefined; readonly minGradeId?: string | undefined }): Promise<FindHide[]> {
  const db = client as Reader
  const facts = await readKeyFacts(db, { siteId: scope.siteId, itemId: scope.itemId, itemColourId: scope.itemColourId }, { withOrders: false })
  const taken = new Set(facts.rows.filter((row) => row.hideId && new Dec(row.quantity.toString()).greaterThan(row.issuedQuantity.toString())).map((row) => row.hideId!))
  const parts = facts.stock.filter((part) => part.hideId && !part.held && !taken.has(part.hideId) && new Dec(part.onHand).greaterThan(0))
  const hideIds = parts.map((part) => part.hideId!)
  const hideRows = new Map((hideIds.length ? await client.hide.findMany({ where: { id: { in: hideIds } }, select: { id: true, code: true, state: true, grade: true, gradeId: true, lotId: true } }) : []).map((row) => [row.id, row]))
  const lotRows = new Map((await client.lot.findMany({ where: { id: { in: [...new Set([...hideRows.values()].map((row) => row.lotId))] } }, select: { id: true, receivedAt: true } })).map((row) => [row.id, row]))
  const shades = await shadeFactsOf(client, hideIds)
  const grades = await gradesOf(client)
  const minimum = scope.minGradeId ? grades.find((grade) => grade.id === scope.minGradeId) : undefined
  const balances = await readSiteStock(db, scope.siteId, { itemIds: [scope.itemId], itemColourId: scope.itemColourId, hideId: undefined })
  const locations = await readLocations(db, [...new Set(balances.filter((balance) => balance.hideId && hideRows.has(balance.hideId)).map((balance) => balance.locationId))])
  const tags = await liveTagsOf(client, hideIds)
  const hides: FindHide[] = []
  for (const part of parts) {
    const hide = hideRows.get(part.hideId!)
    const shade = shades.get(part.hideId!)
    if (!hide || !shade || hide.state === 'CONSUMED' || hide.state === 'SCRAPPED' || hide.state === 'RETURNED') continue
    if (scope.shadeGroupId && shade.shadeGroupId !== scope.shadeGroupId) continue
    const grade = gradeOfHide(hide, grades).grade
    if (minimum && (!grade || grade.sortOrder > minimum.sortOrder)) continue
    const tag = tags.get(hide.id)
    hides.push({
      ...shade,
      receivedAt: lotRows.get(hide.lotId)?.receivedAt ? toUtcIso(lotRows.get(hide.lotId)!.receivedAt!) : null,
      gradeId: grade?.id ?? null,
      gradeCode: grade?.code ?? (hide.grade?.trim() || null),
      state: hide.state,
      left: part.onHand,
      locationCodes: [...new Set(balances.filter((balance) => balance.hideId === hide.id).map((balance) => locations.get(balance.locationId)?.code ?? ''))].filter(Boolean).sort(),
      remnant: tag && tag.state === 'IN_STOCK' ? { id: tag.id, code: tag.code } : null,
    })
  }
  return hides
}
