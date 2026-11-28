import type { Prisma } from '@nexus/factory-db'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { LEG_ARRIVED_ACTION, LEG_FORWARDED_ACTION, LEG_LABEL_ACTION } from '@nexus/factory-domain/sales/order-log/faces'
import type { OrderWarningKind } from '@nexus/factory-domain/sales/warnings/kinds'
import { SHIPPING_MANAGE, SHIPPING_PLAN, SHIPPING_VIEW } from '@nexus/factory-domain/shipping/permissions'
import { legMayOf, legProblems, legStateOf, NO_LABEL_WARNING } from '@nexus/factory-domain/shipping/warehouse-leg/rules'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { checkWarnings, passedWarningsAfter } from '../../../platform/audit/passed-warnings'
import { mayOn, officeContextOf } from '../access'
import { liveDdtOf } from '../ddt/store'
import { orderRefsOfShipments, ordersOfShipment, shipmentsOfOrderWhere } from '../shipments/orders-of'
import { officeShipment, shipmentToPlan } from '../shipments/shipments'
import { readShipment, type ShipmentHeader } from '../store'
import { leavingWarningsOf } from './payment'
import { labelFileOf, labelsByCustomer, legOf, legsOf, orderNotFound, refusedLeg, refuseFirst } from './store'

/**
 * Our warehouse first (owb- order workflow, S3 ss1 step 1.2; settles L4, L5; rules factory-domain shipping/warehouse-leg; design
 * plan § 5n + § 7, prototype ship.js `arrive`, `sendOn`, core.js `label`). Office only:
 *
 *   POST /shipping/shipments/:shipmentId/arrived         shipping.manage: "It arrived at the warehouse" — while SHIPPED, once
 *   POST /shipping/shipments/:shipmentId/forward         shipping.manage: "Send on to the customer" — after it arrived, once; with
 *                                                        the live sale DDT unless it travels without one; a payment due is a
 *                                                        warning (PAYMENT_DUE_AT_SHIP, `overrides`); no label → allowed, logged
 *   POST /shipping/shipments/:shipmentId/customer-label  shipping.plan or shipping.manage: the customer's label, sent by the office
 *                                                        for the customer (a file the office put on the shipment)
 *   GET  /shipping/warehouse-legs?salesOrderId=          shipping.view: the legs of an order's shipments and what the reader may do
 *   GET  /shipping/our-warehouses                        shipping.view: each warehouse with what is there and what is on its way
 *
 * Each act is ONE command on the Shipment (its version — the shipment's, as every shipping act's — guards it and locks the row),
 * ONE audit row on the Shipment with the leg's columns before and after (actions shipping.warehouseLeg.arrived / .forwarded / .label:
 * the order log's faces know them), one event (ids only). The leg's own version goes up by one with each change (its guard).
 */

const iso = (value: Date): string => toUtcIso(value)

/** The leg facts the rules read, from the shipment and its leg. */
const factsOf = (shipment: Pick<ShipmentHeader, 'status'>, leg: { readonly arrivedAt: Date | null; readonly forwardedAt: Date | null }) => ({ shipmentStatus: shipment.status, arrived: leg.arrivedAt !== null, forwarded: leg.forwardedAt !== null })

const actorIdOf = (tools: Pick<CommandTools, 'context'>): string | null => (tools.context.audience === 'office' ? tools.context.actorId : null)

// ---- the acts -------------------------------------------------------------------------------------------------------------------

/** POST /shipping/shipments/:shipmentId/arrived (shipping.manage). */
export async function markArrived(caller: CommandCaller, shipmentId: string, body: { readonly version?: number | undefined }, idempotencyKey?: string) {
  const shipment = await officeShipment(caller, shipmentId, SHIPPING_MANAGE)
  const { result } = await command(caller, { name: LEG_ARRIVED_ACTION, idempotencyKey, input: { shipmentId, ...body }, record: { type: 'Shipment', id: shipment.id, expectedVersion: body.version } }, async (tools) => {
    const current = (await readShipment(tools.tx, shipment.id))!
    const leg = await legOf(tools.tx, current.id)
    if (!leg) refusedLeg('NO_LEG')
    refuseFirst(legProblems('ARRIVED', factsOf(current, leg)))
    await tools.tx.shipmentWarehouseLeg.update({ where: { id: leg.id }, data: { arrivedAt: tools.now, arrivedById: actorIdOf(tools), version: { increment: 1 } }, select: { id: true } })
    tools.audit({ action: LEG_ARRIVED_ACTION, recordType: 'Shipment', recordId: current.id, companyId: current.companyId, siteId: current.siteId, before: { arrivedAt: null }, after: { arrivedAt: iso(tools.now), warehouseSiteId: leg.warehouseSiteId } })
    tools.emit({ type: 'shipment.arrived_at_warehouse', subject: current.id, companyId: current.companyId, siteId: current.siteId, payload: { shipmentId: current.id, number: current.number, warehouseSiteId: leg.warehouseSiteId, salesOrderIds: await ordersOfShipment(tools.tx, current), partyId: current.partyId } })
    return { shipmentId: current.id, arrivedAt: iso(tools.now), version: tools.record!.version }
  })
  return result
}

export interface ForwardBody {
  readonly version?: number | undefined
  readonly carrier: string | null
  readonly trackingNumber: string | null
  readonly overrides?: readonly OrderWarningKind[] | undefined
}

/** POST /shipping/shipments/:shipmentId/forward (shipping.manage): Send on to the customer. */
export async function sendOn(caller: CommandCaller, shipmentId: string, body: ForwardBody, idempotencyKey?: string) {
  const shipment = await officeShipment(caller, shipmentId, SHIPPING_MANAGE)
  const carrier = body.carrier?.trim() ? body.carrier.trim() : null
  const trackingNumber = body.trackingNumber?.trim() ? body.trackingNumber.trim() : null
  const { result } = await command(caller, { name: LEG_FORWARDED_ACTION, idempotencyKey, input: { shipmentId, ...body }, record: { type: 'Shipment', id: shipment.id, expectedVersion: body.version } }, async (tools) => {
    const current = (await readShipment(tools.tx, shipment.id))!
    const leg = await legOf(tools.tx, current.id)
    if (!leg) refusedLeg('NO_LEG')
    // The newest live DDT (../ddt/store.ts liveDdtOf): the sale DDT of Send on once issued (a second live one, after the transfer).
    const live = await liveDdtOf(tools.tx, current.id)
    refuseFirst(legProblems('FORWARD', { ...factsOf(current, leg), ddtRequired: current.ddtRequired, liveDdtReason: live?.reason ?? null }))
    // settle L2 (R39 (a)): the goods leave to the customer now — a payment due is a warning the caller passes on (409 until then).
    const passed = checkWarnings(await leavingWarningsOf(tools.tx, current, { toOurWarehouse: false }), body.overrides)
    const withoutLabel = leg.customerLabelFileId === null
    await tools.tx.shipmentWarehouseLeg.update({
      where: { id: leg.id },
      data: { forwardedAt: tools.now, forwardedById: actorIdOf(tools), forwardedWithoutLabel: withoutLabel, version: { increment: 1 } },
      select: { id: true },
    })
    tools.audit({
      action: LEG_FORWARDED_ACTION,
      recordType: 'Shipment',
      recordId: current.id,
      companyId: current.companyId,
      siteId: current.siteId,
      before: { forwardedAt: null, forwardedWithoutLabel: false },
      after: {
        forwardedAt: iso(tools.now),
        forwardedWithoutLabel: withoutLabel,
        customerLabelFileId: leg.customerLabelFileId,
        ddt: live?.number ?? null,
        carrier,
        trackingNumber,
        // Sent on without the customer's label: allowed, with this warning in the history (design `sendOn`).
        ...(withoutLabel ? { warning: NO_LABEL_WARNING.en } : {}),
        ...passedWarningsAfter(passed),
      },
    })
    tools.emit({ type: 'shipment.forwarded', subject: current.id, companyId: current.companyId, siteId: current.siteId, payload: { shipmentId: current.id, number: current.number, warehouseSiteId: leg.warehouseSiteId, withoutLabel, salesOrderIds: await ordersOfShipment(tools.tx, current), partyId: current.partyId } })
    return { shipmentId: current.id, forwardedAt: iso(tools.now), forwardedWithoutLabel: withoutLabel, version: tools.record!.version }
  })
  return result
}

/**
 * Inside a command on the shipment (its row locked): the customer's label set on its leg — the file filed as CUSTOMER_LABEL (its
 * category, if not yet), the leg's label columns, ONE audit row, one event. `door` says who names the file (the portal: the
 * customer's own upload only); `byUserId` who gave it (a person of the customer, or of the office). Refusals in `locale`.
 */
export async function labelInCommand(tools: CommandTools, current: ShipmentHeader, input: { readonly fileId: string; readonly door: 'office' | 'portal'; readonly byUserId: string; readonly locale: 'en' | 'it' }): Promise<{ labelSentAt: string; byCustomer: boolean }> {
  const leg = await legOf(tools.tx, current.id)
  if (!leg) refusedLeg('NO_LEG', input.locale)
  const file = await labelFileOf(tools.tx, input.fileId)
  refuseFirst(legProblems('LABEL', { ...factsOf(current, leg), label: file, target: { shipmentId: current.id, partyId: current.partyId, door: input.door } }), input.locale)
  const label = file!
  if (label.category !== 'CUSTOMER_LABEL') await tools.tx.storedFile.update({ where: { id: label.id }, data: { category: 'CUSTOMER_LABEL', version: { increment: 1 }, updatedAt: tools.now }, select: { id: true } })
  await tools.tx.shipmentWarehouseLeg.update({ where: { id: leg.id }, data: { customerLabelFileId: label.id, customerLabelAt: tools.now, customerLabelById: input.byUserId, version: { increment: 1 } }, select: { id: true } })
  const byCustomer = !label.byOffice
  tools.audit({
    action: LEG_LABEL_ACTION,
    recordType: 'Shipment',
    recordId: current.id,
    companyId: current.companyId,
    siteId: current.siteId,
    before: { customerLabelFileId: leg.customerLabelFileId, customerLabelAt: leg.customerLabelAt ? iso(leg.customerLabelAt) : null },
    after: { customerLabelFileId: label.id, customerLabelAt: iso(tools.now), byCustomer, door: input.door, ...(label.category !== 'CUSTOMER_LABEL' ? { filedAs: 'CUSTOMER_LABEL' } : {}) },
  })
  tools.emit({ type: 'shipment.label_received', subject: current.id, companyId: current.companyId, siteId: current.siteId, payload: { shipmentId: current.id, number: current.number, byCustomer, salesOrderIds: await ordersOfShipment(tools.tx, current), partyId: current.partyId } })
  return { labelSentAt: iso(tools.now), byCustomer }
}

/** POST /shipping/shipments/:shipmentId/customer-label (shipping.plan or shipping.manage): the office sends the label for the customer. */
export async function officeLabel(caller: CommandCaller, shipmentId: string, body: { readonly version?: number | undefined; readonly fileId: string }, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const shipment = await shipmentToPlan(caller, shipmentId)
  const { result } = await command(caller, { name: LEG_LABEL_ACTION, idempotencyKey, input: { shipmentId, ...body }, record: { type: 'Shipment', id: shipment.id, expectedVersion: body.version } }, async (tools) => {
    const current = (await readShipment(tools.tx, shipment.id))!
    const { labelSentAt } = await labelInCommand(tools, current, { fileId: body.fileId, door: 'office', byUserId: context.actorId, locale: 'en' })
    return { shipmentId: current.id, labelSentAt, version: tools.record!.version }
  })
  return result
}

// ---- the reads ----------------------------------------------------------------------------------------------------------------

/** GET /shipping/warehouse-legs?salesOrderId= (shipping.view): the legs of the order's shipments (not cancelled) and what the reader may do. */
export async function orderLegs(caller: CommandCaller, query: { readonly salesOrderId: string }) {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  return caller.withClient(async (client) => {
    const order = await client.salesOrder.findUnique({ where: { id: query.salesOrderId }, select: { id: true, companyId: true, partyId: true } })
    if (!order || !mayOn(context, SHIPPING_VIEW, { companyId: order.companyId, partyId: order.partyId })) throw orderNotFound()
    const shipments = await client.shipment.findMany({
      where: {
        AND: [
          scopeWhere(actor, SHIPPING_VIEW, { company: 'companyId', site: 'siteId', party: 'partyId' }) as Prisma.ShipmentWhereInput,
          shipmentsOfOrderWhere(order.id),
          { warehouseLeg: { isNot: null } },
          { status: { not: 'CANCELLED' } },
        ],
      },
      select: { id: true, status: true, version: true, companyId: true, siteId: true, partyId: true },
      orderBy: { id: 'asc' },
    })
    const legs = await legsOf(client, shipments.map((shipment) => shipment.id))
    const sites = await client.site.findMany({ where: { id: { in: [...new Set([...legs.values()].map((leg) => leg.warehouseSiteId))] } }, select: { id: true, name: true, address: true } })
    const siteOf = new Map(sites.map((site) => [site.id, site]))
    const byCustomer = await labelsByCustomer(client, [...legs.values()].flatMap((leg) => (leg.customerLabelFileId ? [leg.customerLabelFileId] : [])))
    return {
      legs: shipments.flatMap((shipment) => {
        const leg = legs.get(shipment.id)
        if (!leg) return []
        const site = siteOf.get(leg.warehouseSiteId)
        const scope = { companyId: shipment.companyId, siteId: shipment.siteId, partyId: shipment.partyId }
        return [
          {
            shipmentId: shipment.id,
            version: shipment.version,
            warehouse: { siteId: leg.warehouseSiteId, name: site?.name ?? '', city: cityOf(site?.address) },
            state: legStateOf(leg),
            arrivedAt: leg.arrivedAt ? iso(leg.arrivedAt) : null,
            forwardedAt: leg.forwardedAt ? iso(leg.forwardedAt) : null,
            forwardedWithoutLabel: leg.forwardedWithoutLabel,
            label: leg.customerLabelFileId && leg.customerLabelAt ? { sentAt: iso(leg.customerLabelAt), byCustomer: byCustomer.get(leg.customerLabelFileId) ?? false, fileId: leg.customerLabelFileId } : null,
            may: legMayOf({ shipmentStatus: shipment.status, arrived: leg.arrivedAt !== null, forwarded: leg.forwardedAt !== null }, { manage: mayOn(context, SHIPPING_MANAGE, scope), plan: mayOn(context, SHIPPING_PLAN, scope) }),
          },
        ]
      }),
    }
  })
}

const cityOf = (address: unknown): string | null => {
  if (address === null || typeof address !== 'object') return null
  const city = (address as Record<string, unknown>).city
  return typeof city === 'string' && city.trim() !== '' ? city.trim() : null
}
const countryOf = (address: unknown): string => {
  if (address === null || typeof address !== 'object') return ''
  const country = (address as Record<string, unknown>).country
  return typeof country === 'string' ? country.trim() : ''
}

/** How many legs the page reads at most (the oldest first): a warehouse holds goods for days, not thousands of shipments. */
const OPEN_LEGS_LIMIT = 500

/**
 * GET /shipping/our-warehouses (shipping.view): each active warehouse site of the companies the reader reaches, with the shipments
 * there (arrived, not sent on) and on their way (left, not arrived) that the reader may see — customer, orders, pieces, since when,
 * whether the customer's label came.
 */
export async function ourWarehouses(caller: CommandCaller) {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  return caller.withClient(async (client) => {
    const sites = (await client.site.findMany({ where: { kind: 'WAREHOUSE', status: 'ACTIVE' }, select: { id: true, companyId: true, code: true, name: true, address: true }, orderBy: [{ code: 'asc' }, { id: 'asc' }] })).filter((site) =>
      mayOn(context, SHIPPING_VIEW, { companyId: site.companyId }),
    )
    if (sites.length === 0) return { warehouses: [] }
    const legs = await client.shipmentWarehouseLeg.findMany({
      where: {
        warehouseSiteId: { in: sites.map((site) => site.id) },
        forwardedAt: null,
        shipment: { AND: [scopeWhere(actor, SHIPPING_VIEW, { company: 'companyId', site: 'siteId', party: 'partyId' }) as Prisma.ShipmentWhereInput, { status: 'SHIPPED' }] },
      },
      select: { shipmentId: true, warehouseSiteId: true, arrivedAt: true, customerLabelAt: true, shipment: { select: { id: true, number: true, salesOrderId: true, partyId: true, shippedAt: true } } },
      orderBy: { createdAt: 'asc' },
      take: OPEN_LEGS_LIMIT,
    })
    const shipments = legs.map((leg) => leg.shipment)
    const orders = await orderRefsOfShipments(client, shipments)
    const parties = new Map((await client.party.findMany({ where: { id: { in: [...new Set(shipments.map((shipment) => shipment.partyId))] } }, select: { id: true, code: true, legalName: true } })).map((party) => [party.id, party]))
    const pieces = new Map(
      (await client.shipmentLine.groupBy({ by: ['shipmentId'], where: { shipmentId: { in: shipments.map((shipment) => shipment.id) } }, _sum: { quantity: true } })).map((row) => [row.shipmentId, row._sum.quantity ?? 0]),
    )
    const customerOf = (partyId: string) => {
      const party = parties.get(partyId)
      return { partyId, code: party?.code ?? '', name: party?.legalName ?? '' }
    }
    return {
      warehouses: sites.map((site) => {
        const here = legs.filter((leg) => leg.warehouseSiteId === site.id)
        return {
          siteId: site.id,
          code: site.code,
          name: site.name,
          city: cityOf(site.address),
          country: countryOf(site.address),
          atWarehouse: here
            .filter((leg) => leg.arrivedAt !== null)
            .map((leg) => ({
              shipmentId: leg.shipment.id,
              number: leg.shipment.number,
              customer: customerOf(leg.shipment.partyId),
              salesOrders: (orders.get(leg.shipment.id) ?? []).map((order) => ({ id: order.id, number: order.number })),
              pieces: pieces.get(leg.shipment.id) ?? 0,
              arrivedAt: iso(leg.arrivedAt!),
              labelSentAt: leg.customerLabelAt ? iso(leg.customerLabelAt) : null,
            })),
          onTheWay: here
            .filter((leg) => leg.arrivedAt === null && leg.shipment.shippedAt !== null)
            .map((leg) => ({
              shipmentId: leg.shipment.id,
              number: leg.shipment.number,
              customer: customerOf(leg.shipment.partyId),
              pieces: pieces.get(leg.shipment.id) ?? 0,
              shippedAt: iso(leg.shipment.shippedAt!),
            })),
        }
      }),
    }
  })
}
