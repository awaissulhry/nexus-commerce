import type { Uom } from '@nexus/factory-db'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { quantityText } from '@nexus/factory-domain/inventory/ledger/moves'
import { baseQuantityOf } from '@nexus/factory-domain/inventory/ledger/units'
import { INVENTORY_RESERVE } from '@nexus/factory-domain/inventory/reservations/permissions'
import {
  isOpenOrder,
  isOpenWorkOrder,
  kindFor,
  MAX_RESERVATION_LINES,
  releaseReasonProblem,
  releaseRefusal,
  reserveRefusals,
  type ReservationKind,
  type ReserveRequest,
} from '@nexus/factory-domain/inventory/reservations/rules'
import { isHeld, type LotQualityStatus } from '@nexus/factory-domain/inventory/stock/overview'
import { Dec, ZERO } from '@nexus/factory-domain/tax/decimal'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { officeContextOf, siteFor } from '../ledger/access'
import { itemUnitsOf, readHides, readItems, readLots, type HideRow, type ItemRow, type LotRow } from '../issue/store'
import { viewsOf, type ReservationView } from './read'
import { demandWords, lockReservations, readKeyFacts, reserveKeyOf, RESERVATION_COLUMNS, type ReserveKey } from './store'

/**
 * Reserve and release (B-W2a-11; SCM-205, SCM-209, SCM-210; design warehouse.stock "Reserved", warehouse.hides "Reserve to
 * a work order…", production.workorders "Reserve leather…"). Office only, inventory.reserve at the site. Each is ONE
 * command():
 *
 *   reserve   for ONE demand — a work order of the site that is still open (DRAFT, RELEASED, IN_PROGRESS, ON_HOLD) or a
 *             line of an open sales order of the site's company made here — one or more lines: a named hide (whole, HIDE),
 *             an area of leather from a lot or from any lot of a colour (AREA), a quantity of anything else from a lot or
 *             any lot (QUANTITY). Under the reserve lock of each item and colour (store.ts) every line is checked against
 *             what is available now (on hand − held − reserved, for the item and colour and for its lot) and against the
 *             lines before it; a refusal is a 409 whose issues name each line (`body/lines/<i>/refusal/<CODE>`). A work
 *             order that plans its materials takes only those (item and colour). The need date defaults to the work
 *             order's due date, the order line's promised (else requested) date.
 *   release   one or many reservations (each with the version read), with the reason (SCM-210): ACTIVE → RELEASED, by
 *             whom and when; what they still held is available again. An ISSUED or RELEASED one is a 409 in words.
 *
 * Audit rows per reservation; events `inventory.reserved`, `inventory.reservations_released`. The database (the
 * …_stock_plan_w2a_guards trigger, one ACTIVE reservation per hide) stays the last word.
 */

export interface ReserveLineInput {
  readonly itemId?: string | undefined
  readonly itemColourId?: string | null | undefined
  readonly lotId?: string | undefined
  readonly hideId?: string | undefined
  readonly quantity?: string | undefined
  readonly uom?: Uom | undefined
  readonly baseQuantity?: string | undefined
}

export interface ReserveInput {
  readonly siteId: string
  readonly workOrderId?: string | undefined
  readonly salesOrderLineId?: string | undefined
  readonly needDate?: string | undefined
  readonly note?: string | null | undefined
  readonly lines: readonly ReserveLineInput[]
}

export class ReservationRefusedError extends ConflictError {
  override name = 'ReservationRefusedError'
  override readonly issues: readonly Issue[]
  constructor(message: string, issues: readonly Issue[]) {
    super(message)
    this.issues = issues
  }
}

interface Resolved {
  readonly index: number
  readonly item: ItemRow
  readonly itemColourId: string | null
  readonly lot: LotRow | null
  readonly hide: HideRow | null
  readonly kind: ReservationKind
  /** Base unit; a hide's is read from the ledger under the lock. */
  readonly baseQuantity: string | null
}

const isUniqueViolation = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === 'P2002'

/** The lines' rows (item, colour, lot, hide) and their shape problems; quantities sized to the base unit. */
async function resolveLines(tools: CommandTools, siteId: string, lines: readonly ReserveLineInput[]): Promise<{ resolved: Resolved[]; problems: Issue[] }> {
  const { tx } = tools
  const problems: Issue[] = []
  const at = (index: number, field: string) => `body/lines/${index}/${field}`
  const hides = await readHides(tx, lines.flatMap((line) => (line.hideId && isUuid(line.hideId) ? [line.hideId] : [])))
  const lots = await readLots(tx, [...lines.flatMap((line) => (line.lotId && isUuid(line.lotId) ? [line.lotId] : [])), ...[...hides.values()].map((hide) => hide.lotId)])
  const items = await readItems(tx, [...lines.flatMap((line) => (line.itemId && isUuid(line.itemId) ? [line.itemId] : [])), ...[...lots.values()].map((lot) => lot.itemId)])
  const coloured = new Set((await tx.itemColour.findMany({ where: { itemId: { in: [...items.keys()] } }, select: { itemId: true, id: true } })).map((row) => `${row.itemId}|${row.id}`))
  const hasColours = new Set([...coloured].map((key) => key.split('|')[0]!))
  const resolved: Resolved[] = []
  lines.forEach((line, index) => {
    const named = [line.hideId, line.lotId, line.itemId].filter((value) => value !== undefined).length
    if (named !== 1) {
      problems.push({ path: `body/lines/${index}`, message: 'Name the stock once: a hide, a lot, or a material (with its colour).' })
      return
    }
    if (line.itemColourId !== undefined && !line.itemId) {
      problems.push({ path: at(index, 'itemColourId'), message: 'A lot or a hide has its own colour: leave it out.' })
      return
    }
    const hide = line.hideId ? (hides.get(line.hideId) ?? null) : null
    if (line.hideId && (!hide || hide.siteId !== siteId)) {
      problems.push({ path: at(index, 'hideId'), message: 'Not a hide of this site.' })
      return
    }
    const lot = hide ? (lots.get(hide.lotId) ?? null) : line.lotId ? (lots.get(line.lotId) ?? null) : null
    if (line.lotId && (!lot || lot.siteId !== siteId)) {
      problems.push({ path: at(index, 'lotId'), message: 'Not a lot of this site.' })
      return
    }
    const item = items.get(hide?.itemId ?? lot?.itemId ?? line.itemId ?? '')
    if (!item) {
      problems.push({ path: at(index, 'itemId'), message: 'Not a material of the tenant.' })
      return
    }
    const itemColourId = lot ? lot.itemColourId : (line.itemColourId ?? null)
    if (!lot && itemColourId === null && hasColours.has(item.id)) {
      problems.push({ path: at(index, 'itemColourId'), message: `${item.code} comes in colours: name the colour to reserve.` })
      return
    }
    if (!lot && itemColourId !== null && !coloured.has(`${item.id}|${itemColourId}`)) {
      problems.push({ path: at(index, 'itemColourId'), message: `Not a colour of ${item.code}.` })
      return
    }
    const kind = kindFor(item.tracking, hide !== null)
    if (!kind) {
      problems.push({ path: at(index, 'hideId'), message: `${item.code} is not tracked hide by hide.` })
      return
    }
    if (kind === 'HIDE') {
      if (line.quantity !== undefined || line.baseQuantity !== undefined) problems.push({ path: at(index, 'quantity'), message: 'A hide is reserved whole, with what it holds: leave the quantity out.' })
      else resolved.push({ index, item, itemColourId, lot, hide, kind, baseQuantity: null })
      return
    }
    if (line.quantity === undefined) {
      problems.push({ path: at(index, 'quantity'), message: kind === 'AREA' ? 'How much leather (the area)?' : 'How much?' })
      return
    }
    const base = baseQuantityOf({ quantity: line.quantity, uom: line.uom ?? item.baseUom, baseQuantity: line.baseQuantity ?? null }, itemUnitsOf(item))
    if (base.problem) {
      problems.push({ path: at(index, base.problem.path), message: base.problem.message })
      return
    }
    if (!new Dec(base.baseQuantity).greaterThan(0)) {
      problems.push({ path: at(index, 'quantity'), message: 'Above 0.' })
      return
    }
    resolved.push({ index, item, itemColourId, lot, hide, kind, baseQuantity: quantityText(base.baseQuantity) })
  })
  return { resolved, problems }
}

interface Demand {
  readonly workOrderId: string | null
  readonly salesOrderLineId: string | null
  readonly partyId: string | null
  readonly needDate: Date | null
  readonly words: string
  /** The work order's planned materials (item|colour), when it plans any. */
  readonly planned: ReadonlySet<string> | null
}

/** The demand of a request, read and checked: a work order of the site, open; or an order line of an open order of the company, made here. */
async function readDemand(tools: CommandTools, site: { id: string; companyId: string }, body: ReserveInput): Promise<Demand> {
  const { tx } = tools
  if (body.workOrderId) {
    const workOrder = isUuid(body.workOrderId) ? await tx.workOrder.findUnique({ where: { id: body.workOrderId }, select: { id: true, siteId: true, number: true, status: true, dueDate: true } }) : null
    if (!workOrder || workOrder.siteId !== site.id) throw new ValidationError('Not a work order of this site.', [{ path: 'body/workOrderId', message: 'Not a work order of this site.' }])
    if (!isOpenWorkOrder(workOrder.status)) throw new ConflictError(`Work order ${workOrder.number} is ${workOrder.status}: stock is reserved only for an open work order.`)
    const materials = await tx.workOrderMaterial.findMany({ where: { workOrderId: workOrder.id }, select: { itemId: true, itemColourId: true }, distinct: ['itemId', 'itemColourId'] })
    return {
      workOrderId: workOrder.id,
      salesOrderLineId: null,
      partyId: null,
      needDate: workOrder.dueDate,
      words: `work order ${workOrder.number}`,
      planned: materials.length > 0 ? new Set(materials.map((row) => `${row.itemId}|${row.itemColourId ?? '-'}`)) : null,
    }
  }
  const line = isUuid(body.salesOrderLineId ?? '')
    ? await tx.salesOrderLine.findUnique({ where: { id: body.salesOrderLineId! }, select: { id: true, companyId: true, siteId: true, partyId: true, seq: true, orderId: true, promiseDate: true, requestedDate: true } })
    : null
  const order = line ? await tx.salesOrder.findUnique({ where: { id: line.orderId }, select: { number: true, status: true, promiseDate: true } }) : null
  if (!line || !order || line.companyId !== site.companyId) throw new ValidationError('Not an order line of this company.', [{ path: 'body/salesOrderLineId', message: 'Not an order line of the site\'s company.' }])
  if (line.siteId && line.siteId !== site.id) throw new ConflictError(`Order ${order.number} line ${line.seq} is made at another site: reserve there.`)
  if (!isOpenOrder(order.status)) throw new ConflictError(`Order ${order.number} is ${order.status}: stock is reserved only for an open order.`)
  return {
    workOrderId: null,
    salesOrderLineId: line.id,
    partyId: line.partyId,
    needDate: line.promiseDate ?? order.promiseDate ?? line.requestedDate,
    words: `order ${order.number} line ${line.seq}`,
    planned: null,
  }
}

/** POST /inventory/reservations: one demand, its lines, each from what is available (SCM-205, SCM-209). */
export async function reserve(caller: CommandCaller, body: ReserveInput, idempotencyKey?: string): Promise<{ reservations: ReservationView[] }> {
  const context = officeContextOf(caller)
  const site = await siteFor(caller, body.siteId, INVENTORY_RESERVE, 'body/siteId')
  if (Boolean(body.workOrderId) === Boolean(body.salesOrderLineId)) {
    throw new ValidationError('Reserve for one work order or one order line.', [{ path: 'body/workOrderId', message: 'Exactly one of workOrderId and salesOrderLineId.' }])
  }
  if (body.lines.length === 0 || body.lines.length > MAX_RESERVATION_LINES) throw new ValidationError(`Reserve 1 to ${MAX_RESERVATION_LINES} lines at once.`, [{ path: 'body/lines', message: `1 to ${MAX_RESERVATION_LINES} lines.` }])
  try {
    const { result } = await command(caller, { name: 'inventory.reserve', idempotencyKey, input: body }, async (tools) => {
      const demand = await readDemand(tools, site, body)
      const { resolved, problems } = await resolveLines(tools, site.id, body.lines)
      for (const line of resolved) {
        if (demand.planned && !demand.planned.has(`${line.item.id}|${line.itemColourId ?? '-'}`)) {
          problems.push({ path: `body/lines/${line.index}/itemId`, message: `${demand.words} does not plan ${line.item.code} in this colour: reserve what it uses.` })
        }
      }
      if (problems.length > 0) throw new ValidationError(problems.length === 1 ? problems[0]!.message : 'These lines cannot be reserved as they are.', problems)

      const keys = new Map<string, ReserveKey>(resolved.map((line) => {
        const key = { siteId: site.id, itemId: line.item.id, itemColourId: line.itemColourId }
        return [reserveKeyOf(key), key]
      }))
      await lockReservations(tools.tx, context.tenantId, [...keys.values()])
      const sized = new Map<number, string>()
      const refusals: Issue[] = []
      for (const [id, key] of keys) {
        const facts = await readKeyFacts(tools.tx, key, { withOrders: true })
        const requests: ReserveRequest[] = resolved
          .filter((line) => reserveKeyOf({ siteId: site.id, itemId: line.item.id, itemColourId: line.itemColourId }) === id)
          .map((line) => {
            const quantity = line.hide ? quantityText(facts.stock.filter((part) => part.hideId === line.hide!.id).reduce((sum, part) => sum.plus(new Dec(part.onHand)), ZERO)) : line.baseQuantity!
            sized.set(line.index, quantity)
            return {
              index: line.index,
              kind: line.kind,
              lotId: line.lot?.id ?? null,
              hideId: line.hide?.id ?? null,
              baseQuantity: quantity,
              label: [line.item.code, line.lot ? `lot ${line.lot.code}` : null, line.hide ? `hide ${line.hide.code}` : null].filter(Boolean).join(', '),
              lotCode: line.lot?.code ?? null,
              lotHeld: line.lot ? isHeld(line.lot.qualityStatus as LotQualityStatus) : false,
              hideCode: line.hide?.code ?? null,
              baseUom: line.item.baseUom,
            }
          })
        for (const refusal of reserveRefusals(facts.stock, facts.reservations, requests, (reservation) => demandWords(facts.rows.find((row) => row.id === reservation.id)!, facts.demands))) {
          refusals.push({ path: `body/lines/${refusal.index}/refusal/${refusal.code}`, message: refusal.message })
        }
      }
      if (refusals.length > 0) {
        refusals.sort((a, b) => (a.path < b.path ? -1 : 1))
        throw new ReservationRefusedError(refusals.length === 1 ? refusals[0]!.message : `${refusals.length} lines cannot be reserved: ${refusals[0]!.message}`, refusals)
      }

      const needDate = body.needDate ? new Date(`${body.needDate}T00:00:00.000Z`) : demand.needDate
      const ids: string[] = []
      for (const line of [...resolved].sort((a, b) => a.index - b.index)) {
        const id = newId()
        const row = await tools.tx.reservation.create({
          data: {
            id,
            companyId: site.companyId,
            siteId: site.id,
            kind: line.kind,
            itemId: line.item.id,
            itemColourId: line.itemColourId,
            lotId: line.lot?.id ?? null,
            hideId: line.hide?.id ?? null,
            quantity: sized.get(line.index)!,
            workOrderId: demand.workOrderId,
            salesOrderLineId: demand.salesOrderLineId,
            partyId: demand.partyId,
            needDate,
            note: body.note?.trim() || null,
            createdAt: tools.now,
            updatedAt: tools.now,
            createdById: context.actorId,
          },
          select: RESERVATION_COLUMNS,
        })
        ids.push(id)
        tools.audit({
          action: 'inventory.reserve',
          recordType: 'Reservation',
          recordId: id,
          companyId: site.companyId,
          siteId: site.id,
          after: {
            kind: row.kind,
            itemId: row.itemId,
            itemColourId: row.itemColourId,
            lotId: row.lotId,
            hideId: row.hideId,
            quantity: row.quantity.toFixed(4),
            workOrderId: row.workOrderId,
            salesOrderLineId: row.salesOrderLineId,
            needDate: body.needDate ?? (needDate ? needDate.toISOString().slice(0, 10) : null),
          },
        })
      }
      tools.emit({
        type: 'inventory.reserved',
        subject: demand.workOrderId ?? demand.salesOrderLineId!,
        companyId: site.companyId,
        siteId: site.id,
        payload: {
          reservationIds: ids,
          workOrderId: demand.workOrderId,
          salesOrderLineId: demand.salesOrderLineId,
          itemIds: [...new Set(resolved.map((line) => line.item.id))],
          hideIds: resolved.flatMap((line) => (line.hide ? [line.hide.id] : [])),
        },
      })
      const rows = await tools.tx.reservation.findMany({ where: { id: { in: ids } }, select: RESERVATION_COLUMNS, orderBy: { id: 'asc' } })
      return { reservations: await viewsOf(tools.tx, rows, { withOrders: true }) }
    })
    return result
  } catch (error) {
    // Another request reserved one of these hides meanwhile (the partial unique index; the lock makes it rare).
    if (isUniqueViolation(error)) throw new ConflictError('A hide of this request was reserved meanwhile by another request: read the stock again.')
    throw error
  }
}

// ---- release -------------------------------------------------------------------------------------------------------------

export interface ReleaseInput {
  readonly reservations: readonly { readonly id: string; readonly version: number }[]
  readonly reason: string
}

/** POST /inventory/reservations/release: one or many, with the reason (SCM-210). */
export async function release(caller: CommandCaller, body: ReleaseInput, idempotencyKey?: string): Promise<{ reservations: ReservationView[] }> {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  const problem = releaseReasonProblem(body.reason)
  if (problem) throw new ValidationError(problem, [{ path: 'body/reason', message: problem }])
  if (body.reservations.length === 0 || body.reservations.length > MAX_RESERVATION_LINES) {
    throw new ValidationError(`Release 1 to ${MAX_RESERVATION_LINES} reservations at once.`, [{ path: 'body/reservations', message: `1 to ${MAX_RESERVATION_LINES}.` }])
  }
  const wanted = [...new Set(body.reservations.map((entry) => entry.id))]
  if (wanted.length !== body.reservations.length) throw new ValidationError('A reservation is named twice.', [{ path: 'body/reservations', message: 'Each reservation once.' }])
  const seen = await caller.withClient((client) => client.reservation.findMany({ where: { id: { in: wanted.filter(isUuid) } }, select: { id: true, companyId: true, siteId: true } }))
  const visible = new Map(seen.map((row) => [row.id, row]))
  for (const [index, entry] of body.reservations.entries()) {
    const row = visible.get(entry.id)
    if (!row) throw new NotFoundError(`Reservation not found (body/reservations/${index}).`)
    if (!can(actor, INVENTORY_RESERVE, { companyId: row.companyId, siteId: row.siteId })) throw new ForbiddenError()
  }
  const reason = body.reason.trim()
  const { result } = await command(caller, { name: 'inventory.releaseReservations', idempotencyKey, input: body }, async (tools) => {
    const before = await tools.tx.reservation.findMany({ where: { id: { in: wanted } }, select: RESERVATION_COLUMNS })
    await lockReservations(tools.tx, context.tenantId, before.map((row) => ({ siteId: row.siteId, itemId: row.itemId, itemColourId: row.itemColourId })))
    const rows = new Map((await tools.tx.reservation.findMany({ where: { id: { in: wanted } }, select: RESERVATION_COLUMNS })).map((row) => [row.id, row]))
    const issues: Issue[] = []
    for (const [index, entry] of body.reservations.entries()) {
      const row = rows.get(entry.id)!
      const refusal = releaseRefusal(row, `Reservation ${row.id.slice(-8)}`)
      if (refusal) issues.push({ path: `body/reservations/${index}`, message: refusal })
      else if (row.version !== entry.version) issues.push({ path: `body/reservations/${index}/version`, message: 'It changed since you read it (an issue counted against it): read it again.' })
    }
    if (issues.length > 0) throw new ReservationRefusedError(issues.length === 1 ? issues[0]!.message : `${issues.length} reservations cannot be released: ${issues[0]!.message}`, issues)
    for (const entry of body.reservations) {
      const row = rows.get(entry.id)!
      const changed = await tools.tx.reservation.updateMany({
        where: { id: row.id, status: 'ACTIVE', version: row.version },
        data: { status: 'RELEASED', releasedAt: tools.now, releasedById: context.actorId, releaseReason: reason, version: { increment: 1 }, updatedAt: tools.now },
      })
      if (changed.count !== 1) throw new ConflictError('A reservation changed while it was released: read it again.')
      tools.audit({
        action: 'inventory.releaseReservation',
        recordType: 'Reservation',
        recordId: row.id,
        companyId: row.companyId,
        siteId: row.siteId,
        before: { status: row.status, issuedQuantity: row.issuedQuantity.toFixed(4) },
        after: { status: 'RELEASED', released: quantityText(row.quantity.minus(row.issuedQuantity)) },
        reason,
      })
    }
    const list = [...rows.values()]
    const sites = [...new Set(list.map((row) => row.siteId))]
    const companies = [...new Set(list.map((row) => row.companyId))]
    tools.emit({
      type: 'inventory.reservations_released',
      subject: list[0]!.id,
      companyId: companies.length === 1 ? companies[0]! : null,
      siteId: sites.length === 1 ? sites[0]! : null,
      payload: {
        reservationIds: wanted,
        workOrderIds: [...new Set(list.flatMap((row) => (row.workOrderId ? [row.workOrderId] : [])))],
        salesOrderLineIds: [...new Set(list.flatMap((row) => (row.salesOrderLineId ? [row.salesOrderLineId] : [])))],
        itemIds: [...new Set(list.map((row) => row.itemId))],
        hideIds: [...new Set(list.flatMap((row) => (row.hideId ? [row.hideId] : [])))],
      },
    })
    const after = await tools.tx.reservation.findMany({ where: { id: { in: wanted } }, select: RESERVATION_COLUMNS, orderBy: { id: 'asc' } })
    return { reservations: await viewsOf(tools.tx, after, { withOrders: true }) }
  })
  return result
}
