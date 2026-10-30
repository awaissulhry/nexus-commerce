import type { Prisma } from '@nexus/factory-db'
import { ConflictError, InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { scopeWhere, type Permission } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { SHIPPING_MANAGE, SHIPPING_VIEW } from '@nexus/factory-domain/shipping/permissions'
import { carrierNameFor } from '@nexus/factory-domain/shipping/labels/labels'
import { lineProblems, lineQuantityProblems, shipmentMachine, type ShipmentStatus, type TransportBy } from '@nexus/factory-domain/shipping/shipments'
import { assertTransition } from '@nexus/factory-domain/state/machine'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { allocateNumber } from '../../../platform/numbering/allocate'
import { assertMay, mayOn, officeContextOf } from '../access'
import { lockCells, reserveReleased, tenantOf } from '../cells'
import { contentsView, headerView, lockedStatus, readShipment, shipmentFacts, type ShipmentHeader } from '../store'
import { assertOrderCaps, capRequestsOf } from './backorder'
import { freightView } from './freight'

/**
 * The office's shipments (B-W1-46; LOG-001, LOG-002, LOG-039, GAP-002; A2 SCR-066, SCR-067): plan a DRAFT shipment
 * from a sales order's released garments, change its lines (only while a DRAFT) and delivery details, cancel it. Every
 * write is one command() on the Shipment record: its version is the edit-conflict guard and its bump locks the row
 * first, then the cells' shipping locks are taken, sorted (the triggers' order), and what can ship is read under them
 * (cells.ts). Leaving (SHIPPED, with its DDT) is B-W1-47's; labels and tracking B-W1-48's.
 */

// ---- reading ------------------------------------------------------------------------------------------------------

/** The office's shipment record: header, order, party and contents (inside a command or in a scoped client). */
export async function shipmentDetail(db: CommandTx, shipment: ShipmentHeader) {
  // One query after another (B-W2a-48): a transaction's client has one connection.
  const order = await db.salesOrder.findUnique({ where: { id: shipment.salesOrderId }, select: { number: true, customerRef: true, status: true } })
  const party = await db.party.findUnique({ where: { id: shipment.partyId }, select: { code: true, legalName: true } })
  const contents = await contentsView(db, shipment.id)
  // B-W2a-48: the freight charged (money.price) and the intra-EU transport evidence's state; office reads only.
  const freight = await freightView(db, shipment)
  const evidence = await db.shipment.findUnique({ where: { id: shipment.id }, select: { transportEvidence: true, transportEvidenceAt: true } })
  return {
    ...headerView(shipment),
    party: party ?? { code: '', legalName: '' },
    salesOrder: { number: order?.number ?? '', customerRef: order?.customerRef ?? null, status: order?.status ?? '' },
    ...contents,
    freight,
    transportEvidence: { status: evidence?.transportEvidence ?? 'NOT_NEEDED', completedAt: evidence?.transportEvidenceAt ? toUtcIso(evidence.transportEvidenceAt) : null },
  }
}

export type ShipmentDetail = Awaited<ReturnType<typeof shipmentDetail>>

/** The shipment the office may see (else 404) and act on with `permission` (else 403). */
export async function officeShipment(caller: CommandCaller, shipmentId: string, permission: Permission = SHIPPING_VIEW): Promise<ShipmentHeader> {
  const context = officeContextOf(caller)
  const shipment = await caller.withClient((client) => readShipment(client, shipmentId))
  assertMay(context, SHIPPING_VIEW, permission, shipment)
  return shipment!
}

export async function getShipment(caller: CommandCaller, shipmentId: string): Promise<{ shipment: ShipmentDetail }> {
  const shipment = await officeShipment(caller, shipmentId)
  return { shipment: await caller.withClient((client) => shipmentDetail(client, shipment)) }
}

export interface ListShipmentsQuery {
  readonly status?: ShipmentStatus | undefined
  readonly open?: 'true' | 'false' | undefined
  readonly q?: string | undefined
  readonly siteId?: string | undefined
  readonly salesOrderId?: string | undefined
  readonly partyId?: string | undefined
  /** B-W2a-48 (LOG-090): the transport evidence's state; `open` = AWAITED or PARTIAL (what is still to collect). */
  readonly evidence?: 'NOT_NEEDED' | 'AWAITED' | 'PARTIAL' | 'COMPLETE' | 'open' | undefined
  readonly cursor?: string | undefined
  readonly limit: number
}

/** The shipments the caller may see (its companies, sites and parties), newest first, with SCR-066's filters. */
export async function listShipments(caller: CommandCaller, query: ListShipmentsQuery) {
  const context = officeContextOf(caller)
  const where: Prisma.ShipmentWhereInput = {
    AND: [
      scopeWhere(actorOf(context), SHIPPING_VIEW, { company: 'companyId', site: 'siteId', party: 'partyId' }) as Prisma.ShipmentWhereInput,
      query.status ? { status: query.status } : {},
      query.open === 'true' ? { status: { in: ['DRAFT', 'PACKED'] } } : query.open === 'false' ? { status: { notIn: ['DRAFT', 'PACKED'] } } : {},
      query.q
        ? {
            OR: [
              { number: { contains: query.q, mode: 'insensitive' } },
              { salesOrder: { number: { contains: query.q, mode: 'insensitive' } } },
              { salesOrder: { customerRef: { contains: query.q, mode: 'insensitive' } } },
              { salesOrder: { party: { legalName: { contains: query.q, mode: 'insensitive' } } } },
              { parcels: { some: { trackingNumber: { contains: query.q, mode: 'insensitive' } } } },
            ],
          }
        : {},
      query.siteId ? { siteId: query.siteId } : {},
      query.salesOrderId ? { salesOrderId: query.salesOrderId } : {},
      query.partyId ? { partyId: query.partyId } : {},
      query.evidence === 'open' ? { transportEvidence: { in: ['AWAITED', 'PARTIAL'] } } : query.evidence ? { transportEvidence: query.evidence } : {},
      query.cursor ? { id: { lt: query.cursor } } : {},
    ],
  }
  const rows = await caller.withClient((client) =>
    client.shipment.findMany({
      where,
      orderBy: { id: 'desc' },
      take: query.limit + 1,
      select: {
        id: true,
        number: true,
        status: true,
        version: true,
        companyId: true,
        siteId: true,
        partyId: true,
        salesOrderId: true,
        transportBy: true,
        carrierCode: true,
        carrierName: true,
        serviceCode: true,
        shipTo: true,
        packedAt: true,
        shippedAt: true,
        cancelledAt: true,
        createdAt: true,
        // B-W2a-48: the freight charged (money.price in the answer) and the transport evidence's state.
        freightCharge: true,
        transportEvidence: true,
        salesOrder: { select: { number: true, currency: true, party: { select: { legalName: true } } } },
        lines: { select: { quantity: true } },
        parcels: { select: { seq: true, grossWeightKg: true, trackingNumber: true, labelledAt: true }, orderBy: { seq: 'asc' } },
        ddts: { where: { cancellations: { none: {} } }, select: { id: true, number: true }, take: 1 },
      },
    }),
  )
  const page = rows.slice(0, query.limit)
  const at = (value: Date | null) => (value ? toUtcIso(value) : null)
  const place = (shipTo: unknown) => {
    const value = shipTo && typeof shipTo === 'object' ? (shipTo as Record<string, unknown>) : {}
    return { city: typeof value.city === 'string' && value.city !== '' ? value.city : null, country: typeof value.country === 'string' && value.country !== '' ? value.country : null }
  }
  // Decimal arithmetic (factory-db exports Prisma's types, not its runtime Decimal: the first weight starts the sum).
  const weight = (parcels: readonly { grossWeightKg: Prisma.Decimal | null }[]) => {
    const weights = parcels.flatMap((parcel) => (parcel.grossWeightKg === null ? [] : [parcel.grossWeightKg]))
    const [first, ...rest] = weights
    if (!first || weights.length < parcels.length) return null
    return rest.reduce((sum, value) => sum.plus(value), first).toFixed(4)
  }
  return {
    shipments: page.map((row) => ({
      id: row.id,
      number: row.number,
      status: row.status,
      version: row.version,
      companyId: row.companyId,
      siteId: row.siteId,
      partyId: row.partyId,
      partyName: row.salesOrder.party.legalName,
      salesOrderId: row.salesOrderId,
      salesOrderNumber: row.salesOrder.number,
      transportBy: row.transportBy,
      carrierCode: row.carrierCode,
      carrierName: row.carrierName,
      serviceCode: row.serviceCode,
      shipTo: place(row.shipTo),
      lines: row.lines.length,
      garments: row.lines.reduce((garments, line) => garments + line.quantity, 0),
      parcels: row.parcels.length,
      grossWeightKg: weight(row.parcels),
      labelled: row.parcels.filter((parcel) => parcel.trackingNumber !== null && parcel.labelledAt !== null).length,
      trackingNumbers: row.parcels.flatMap((parcel) => (parcel.trackingNumber ? [parcel.trackingNumber] : [])).slice(0, 3),
      ddt: row.ddts[0] ? { id: row.ddts[0].id, number: row.ddts[0].number } : null,
      packedAt: at(row.packedAt),
      shippedAt: at(row.shippedAt),
      cancelledAt: at(row.cancelledAt),
      createdAt: toUtcIso(row.createdAt),
      freightCharge: asMoney('price', row.freightCharge),
      currency: row.salesOrder.currency,
      transportEvidence: row.transportEvidence,
    })),
    nextCursor: rows.length > query.limit ? page[page.length - 1]!.id : null,
  }
}

// ---- the cells a request names ------------------------------------------------------------------------------------

const CELL_SELECT = {
  id: true,
  siteId: true,
  partyId: true,
  size: true,
  salesOrderLineId: true,
  salesOrderLine: { select: { orderId: true } },
  workOrder: { select: { id: true, number: true, kind: true } },
  colourway: { select: { code: true } },
} as const satisfies Prisma.WorkOrderSizeSelect

type CellRow = Prisma.WorkOrderSizeGetPayload<{ select: typeof CELL_SELECT }>

const cellLabel = (cell: CellRow): string => `${cell.workOrder.number} ${cell.colourway.code} ${cell.size}`

/** The requested garments per cell (a cell named twice adds up), in request order. */
function garmentsByCell(lines: readonly { readonly workOrderSizeId: string; readonly quantity: number }[]): Map<string, { quantity: number; index: number }> {
  const byCell = new Map<string, { quantity: number; index: number }>()
  lines.forEach((line, index) => {
    const entry = byCell.get(line.workOrderSizeId)
    byCell.set(line.workOrderSizeId, { quantity: (entry?.quantity ?? 0) + line.quantity, index: entry?.index ?? index })
  })
  return byCell
}

/** Reads the cells and checks each against the shipment (party, order, site, DRAFT): 400 with every problem. */
async function cellsFor(
  db: CommandTx,
  shipment: { siteId: string; partyId: string; salesOrderId: string; status: ShipmentStatus },
  byCell: ReadonlyMap<string, { quantity: number; index: number }>,
  path: string,
): Promise<Map<string, CellRow>> {
  const rows = await db.workOrderSize.findMany({ where: { id: { in: [...byCell.keys()] } }, select: CELL_SELECT })
  const cells = new Map(rows.map((row) => [row.id, row]))
  const problems: Issue[] = []
  for (const [cellId, { quantity, index }] of byCell) {
    const cell = cells.get(cellId)
    const at = `${path}/${index}`
    if (!cell) {
      problems.push({ path: `${at}/workOrderSizeId`, message: 'Not a work order cell.' })
      continue
    }
    // B-W2a-12 / B-W2a-48: a repaired garment goes back with its repair's DDT (B-W2a-17), never on a shipment of the order.
    if (cell.workOrder.kind === 'REPAIR') {
      problems.push({ path: `${at}/workOrderSizeId`, message: `${cell.workOrder.number} is a repair work order: its garment goes back with the repair's DDT, never on a shipment of the order.` })
      continue
    }
    problems.push(...lineProblems(shipment, { siteId: cell.siteId, partyId: cell.partyId, salesOrderId: cell.salesOrderLine.orderId }, quantity, at))
  }
  if (problems.length > 0) throw new ValidationError(problems.length === 1 ? problems[0]!.message : 'These lines cannot ship on this shipment.', problems)
  return cells
}

/**
 * Adds garments to the shipment's lines: each cell's unpacked line grows, or a new line is made. Under the cells'
 * shipping locks, with a 409 before any write when a cell has not that many released garments left.
 */
async function addGarments(tools: CommandTools, shipment: { id: string; siteId: string; partyId: string; companyId: string }, byCell: ReadonlyMap<string, { quantity: number }>, cells: ReadonlyMap<string, CellRow>) {
  const { tx, context } = tools
  const more = new Map([...byCell].map(([cellId, entry]) => [cellId, entry.quantity]))
  await reserveReleased(tx, tenantOf(context), more, new Map([...cells].map(([cellId, cell]) => [cellId, cellLabel(cell)])))
  // B-W2a-48 (LOG-004 with SAL-210): never more than the order line ordered of a size, nothing of a line closed short.
  await assertOrderCaps(tx, tenantOf(context), [...more].map(([cellId, garments]) => ({ salesOrderLineId: cells.get(cellId)!.salesOrderLineId, size: cells.get(cellId)!.size, more: garments })))
  const unpacked = new Map(
    (await tx.shipmentLine.findMany({ where: { shipmentId: shipment.id, workOrderSizeId: { in: [...more.keys()] }, parcelId: null }, select: { id: true, workOrderSizeId: true, quantity: true } })).map((line) => [line.workOrderSizeId, line]),
  )
  const added: { lineId: string; workOrderSizeId: string; quantity: number }[] = []
  for (const [cellId, garments] of [...more].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const cell = cells.get(cellId)!
    const existing = unpacked.get(cellId)
    if (existing) {
      await tx.shipmentLine.update({ where: { id: existing.id }, data: { quantity: existing.quantity + garments, version: { increment: 1 } }, select: { id: true } })
      tools.audit({ action: 'shipping.changeLine', recordType: 'ShipmentLine', recordId: existing.id, companyId: shipment.companyId, siteId: shipment.siteId, before: { quantity: existing.quantity }, after: { quantity: existing.quantity + garments } })
      added.push({ lineId: existing.id, workOrderSizeId: cellId, quantity: garments })
    } else {
      const lineId = newId()
      await tx.shipmentLine.create({
        data: {
          id: lineId,
          siteId: shipment.siteId,
          partyId: shipment.partyId,
          shipmentId: shipment.id,
          workOrderId: cell.workOrder.id,
          workOrderSizeId: cellId,
          salesOrderLineId: cell.salesOrderLineId,
          size: cell.size,
          quantity: garments,
          createdById: actorIdOf(tools),
        },
        select: { id: true },
      })
      tools.audit({ action: 'shipping.addLine', recordType: 'ShipmentLine', recordId: lineId, companyId: shipment.companyId, siteId: shipment.siteId, after: { shipmentId: shipment.id, workOrderSizeId: cellId, quantity: garments } })
      added.push({ lineId, workOrderSizeId: cellId, quantity: garments })
    }
  }
  return added
}

const actorIdOf = (tools: Pick<CommandTools, 'context'>): string | null => (tools.context.audience === 'office' || tools.context.audience === 'floor' ? tools.context.actorId : null)

/** The ship-to snapshot of a party's delivery address (the shape of SalesOrder.shipTo). */
const SHIP_TO_SELECT = { partyId: true, kinds: true, status: true, name: true, line1: true, line2: true, postalCode: true, city: true, province: true, country: true, contactName: true, phone: true } as const

async function shipToOf(db: CommandTx, partyId: string, addressId: string, path: string): Promise<Record<string, string>> {
  const address = isUuid(addressId) ? await db.partyAddress.findUnique({ where: { id: addressId }, select: SHIP_TO_SELECT }) : null
  if (!address || address.partyId !== partyId || address.status !== 'ACTIVE' || !address.kinds.includes('SHIP_TO')) {
    throw new ValidationError('Not a delivery address of this customer.', [{ path, message: "Expected an active delivery (SHIP_TO) address of the order's party." }])
  }
  const { partyId: _party, kinds: _kinds, status: _status, ...fields } = address
  return Object.fromEntries(Object.entries(fields).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== ''))
}

const blankToNull = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())

const changed = (tools: CommandTools, shipment: { id: string; number: string; companyId: string; siteId: string }, status: ShipmentStatus, change: 'lines' | 'parcels' | 'serials' | 'details' | 'status') =>
  tools.emit({ type: 'shipment.packing_changed', subject: shipment.id, companyId: shipment.companyId, siteId: shipment.siteId, payload: { shipmentId: shipment.id, number: shipment.number, status, change } })

// ---- create ---------------------------------------------------------------------------------------------------------

export interface CreateShipmentInput {
  readonly salesOrderId: string
  readonly siteId?: string | undefined
  readonly shipToAddressId?: string | undefined
  readonly transportBy?: TransportBy | undefined
  readonly carrierCode?: string | null | undefined
  readonly serviceCode?: string | null | undefined
  readonly internalNote?: string | null | undefined
  readonly lines?: readonly { readonly workOrderSizeId: string; readonly quantity: number }[] | undefined
}

/**
 * shipping.manage: a DRAFT shipment of a sales order from one site (LOG-001), numbered from the company's SHIPMENT
 * series, to the order's ship-to (or another delivery address of its party), with the site's default carrier and
 * service (LOG-117), and optionally its first lines (released garments only).
 */
export async function createShipment(caller: CommandCaller, body: CreateShipmentInput, idempotencyKey?: string): Promise<{ shipment: ShipmentDetail }> {
  const context = officeContextOf(caller)
  const byCell = garmentsByCell(body.lines ?? [])
  const plan = await caller.withClient(async (client) => {
    const order = await client.salesOrder.findUnique({ where: { id: body.salesOrderId }, select: { id: true, companyId: true, partyId: true, status: true, shipTo: true } })
    if (!order || !mayOn(context, SHIPPING_VIEW, { companyId: order.companyId, partyId: order.partyId })) throw new NotFoundError('Sales order not found.')
    const cellRows = await client.workOrderSize.findMany({ where: { id: { in: [...byCell.keys()] } }, select: { siteId: true } })
    const sites = new Set(cellRows.map((cell) => cell.siteId))
    const siteId = body.siteId ?? (sites.size === 1 ? [...sites][0]! : null)
    if (!siteId) throw new ValidationError('Name the site the goods leave from.', [{ path: 'body/siteId', message: 'Required when the lines do not name one site.' }])
    const site = await client.site.findUnique({ where: { id: siteId }, select: { id: true, companyId: true } })
    if (!site || site.companyId !== order.companyId) throw new ValidationError("Not a site of the order's company.", [{ path: 'body/siteId', message: "Expected a site of the order's company." }])
    assertMay(context, SHIPPING_VIEW, SHIPPING_MANAGE, { companyId: order.companyId, siteId, partyId: order.partyId }, 'Sales order')
    if (order.status === 'CANCELLED' || order.status === 'CLOSED') throw new InvalidStateError(`The sales order is ${order.status}; nothing more ships for it.`)
    const shipment = { siteId, partyId: order.partyId, salesOrderId: order.id, status: 'DRAFT' as const }
    const cells = byCell.size > 0 ? await cellsFor(client, shipment, byCell, 'body/lines') : new Map<string, CellRow>()
    const shipTo = body.shipToAddressId ? await shipToOf(client, order.partyId, body.shipToAddressId, 'body/shipToAddressId') : (order.shipTo as Prisma.InputJsonValue)
    const settings = await client.shippingSettings.findUnique({ where: { id: siteId }, select: { defaultTransportBy: true, defaultCarrierCode: true, defaultServiceCode: true, integrationAccountId: true } })
    return { order, siteId, cells, shipTo, settings }
  })
  const { order, siteId, cells, shipTo, settings } = plan
  const carrierCode = body.carrierCode !== undefined ? blankToNull(body.carrierCode) : (settings?.defaultCarrierCode ?? null)
  const serviceCode = body.serviceCode !== undefined ? blankToNull(body.serviceCode) : carrierCode === settings?.defaultCarrierCode ? (settings?.defaultServiceCode ?? null) : null
  const transportBy = body.transportBy ?? settings?.defaultTransportBy ?? 'CARRIER'
  // The carrier's name follows the carrier chosen (B-W1-48): the DDT's default carrier.
  const carrierName = carrierNameFor(transportBy, carrierCode)

  const { result } = await command(caller, { name: 'shipping.create', idempotencyKey, input: body }, async (tools) => {
    const id = newId()
    const number = await allocateNumber(tools, { companyId: order.companyId, kind: 'SHIPMENT' }, { type: 'Shipment', id })
    await tools.tx.shipment.create({
      data: {
        id,
        companyId: order.companyId,
        siteId,
        partyId: order.partyId,
        salesOrderId: order.id,
        number: number.formatted,
        shipToAddressId: body.shipToAddressId ?? null,
        shipTo,
        transportBy,
        carrierCode,
        carrierName,
        serviceCode,
        integrationAccountId: transportBy === 'CARRIER' ? (settings?.integrationAccountId ?? null) : null,
        internalNote: blankToNull(body.internalNote),
        createdById: context.actorId,
      },
      select: { id: true },
    })
    const scope = { id, number: number.formatted, companyId: order.companyId, siteId, partyId: order.partyId }
    const added = byCell.size > 0 ? await addGarments(tools, scope, byCell, cells) : []
    const garments = added.reduce((sum, line) => sum + line.quantity, 0)
    tools.audit({
      recordType: 'Shipment',
      recordId: id,
      companyId: order.companyId,
      siteId,
      after: { number: number.formatted, status: 'DRAFT', salesOrderId: order.id, siteId, transportBy, carrierCode, carrierName, serviceCode, shipToAddressId: body.shipToAddressId ?? null, lines: added },
    })
    tools.emit({ type: 'shipment.created', subject: id, companyId: order.companyId, siteId, payload: { shipmentId: id, number: number.formatted, salesOrderId: order.id, siteId, lines: added.length, garments } })
    changed(tools, scope, 'DRAFT', 'lines')
    return { shipment: await shipmentDetail(tools.tx, (await readShipment(tools.tx, id))!) }
  })
  return result
}

// ---- lines (only while a DRAFT) -------------------------------------------------------------------------------------

/** A command on the shipment: its version guards it and locks its row; the work sees it as it is now. */
async function onShipment<Result>(
  caller: CommandCaller,
  shipment: ShipmentHeader,
  spec: { name: `shipping.${string}`; idempotencyKey: string | undefined; input: unknown; version: number | undefined },
  work: (tools: CommandTools) => Promise<Result>,
): Promise<Result> {
  const { result } = await command(caller, { name: spec.name, idempotencyKey: spec.idempotencyKey, input: spec.input, record: { type: 'Shipment', id: shipment.id, expectedVersion: spec.version } }, work)
  return result
}

export async function addLines(caller: CommandCaller, shipmentId: string, body: { version?: number | undefined; lines: readonly { workOrderSizeId: string; quantity: number }[] }, idempotencyKey?: string) {
  const shipment = await officeShipment(caller, shipmentId, SHIPPING_MANAGE)
  const byCell = garmentsByCell(body.lines)
  const cells = await caller.withClient((client) => cellsFor(client, { ...shipment, status: 'DRAFT' }, byCell, 'body/lines'))
  return onShipment(caller, shipment, { name: 'shipping.addLines', idempotencyKey, input: { shipmentId, ...body }, version: body.version }, async (tools) => {
    const current = await lockedStatus(tools, shipment.id, ['DRAFT'], 'its lines change')
    const added = await addGarments(tools, current, byCell, cells)
    tools.audit({ recordType: 'Shipment', recordId: current.id, companyId: current.companyId, siteId: current.siteId, after: { lines: added } })
    changed(tools, current, current.status, 'lines')
    return { shipment: await shipmentDetail(tools.tx, (await readShipment(tools.tx, current.id))!) }
  })
}

async function lineOf(tx: CommandTx, shipmentId: string, lineId: string) {
  const line = isUuid(lineId)
    ? await tx.shipmentLine.findFirst({ where: { id: lineId, shipmentId }, select: { id: true, quantity: true, workOrderSizeId: true, parcelId: true, serials: { select: { id: true, serial: true } }, workOrderSize: { select: { size: true, workOrder: { select: { number: true } }, colourway: { select: { code: true } } } } } })
    : null
  if (!line) throw new NotFoundError('Shipment line not found.')
  return line
}

/** shipping.manage: a line's garments, more (released ones only) or fewer (never below the serials it holds). */
export async function changeLine(caller: CommandCaller, shipmentId: string, lineId: string, body: { version?: number | undefined; quantity: number }, idempotencyKey?: string) {
  const shipment = await officeShipment(caller, shipmentId, SHIPPING_MANAGE)
  return onShipment(caller, shipment, { name: 'shipping.changeLine', idempotencyKey, input: { shipmentId, lineId, ...body }, version: body.version }, async (tools) => {
    const current = await lockedStatus(tools, shipment.id, ['DRAFT'], 'its lines change')
    const line = await lineOf(tools.tx, current.id, lineId)
    const problems = lineQuantityProblems({ id: line.id, workOrderSizeId: line.workOrderSizeId, parcelId: line.parcelId, quantity: line.quantity, serials: line.serials.length, serialTracked: false }, body.quantity)
    if (problems.length > 0) throw new ConflictError(problems.join(' '))
    const label = `${line.workOrderSize.workOrder.number} ${line.workOrderSize.colourway.code} ${line.workOrderSize.size}`
    if (body.quantity > line.quantity) {
      await reserveReleased(tools.tx, tenantOf(tools.context), new Map([[line.workOrderSizeId, body.quantity - line.quantity]]), new Map([[line.workOrderSizeId, label]]))
      // B-W2a-48: the order line's size and its short close hold too.
      await assertOrderCaps(tools.tx, tenantOf(tools.context), await capRequestsOf(tools.tx, new Map([[line.workOrderSizeId, body.quantity - line.quantity]])))
    } else await lockCells(tools.tx, tenantOf(tools.context), [line.workOrderSizeId])
    if (body.quantity !== line.quantity) await tools.tx.shipmentLine.update({ where: { id: line.id }, data: { quantity: body.quantity, version: { increment: 1 } }, select: { id: true } })
    tools.audit({ recordType: 'ShipmentLine', recordId: line.id, companyId: current.companyId, siteId: current.siteId, before: { quantity: line.quantity }, after: { quantity: body.quantity } })
    changed(tools, current, current.status, 'lines')
    return { shipment: await shipmentDetail(tools.tx, (await readShipment(tools.tx, current.id))!) }
  })
}

/** Unpacks the serials of these lines (allowed only while the shipment is a DRAFT), one audit row each. */
export async function unpackSerialsOf(tools: CommandTools, shipment: { companyId: string; siteId: string }, serials: readonly { id: string; serial: string; lineId: string }[]): Promise<void> {
  for (const serial of serials) {
    await tools.tx.garmentSerial.update({ where: { id: serial.id }, data: { shipmentLineId: null, version: { increment: 1 } }, select: { id: true } })
    tools.audit({ action: 'shipping.unpackSerial', recordType: 'GarmentSerial', recordId: serial.id, companyId: shipment.companyId, siteId: shipment.siteId, before: { shipmentLineId: serial.lineId }, after: { shipmentLineId: null } })
  }
}

/** shipping.manage: removes a line (its serials are unpacked first, in the same command). */
export async function removeLine(caller: CommandCaller, shipmentId: string, lineId: string, query: { version?: number | undefined }, idempotencyKey?: string) {
  const shipment = await officeShipment(caller, shipmentId, SHIPPING_MANAGE)
  return onShipment(caller, shipment, { name: 'shipping.removeLine', idempotencyKey, input: { shipmentId, lineId, ...query }, version: query.version }, async (tools) => {
    const current = await lockedStatus(tools, shipment.id, ['DRAFT'], 'its lines change')
    const line = await lineOf(tools.tx, current.id, lineId)
    await lockCells(tools.tx, tenantOf(tools.context), [line.workOrderSizeId])
    await unpackSerialsOf(tools, current, line.serials.map((serial) => ({ ...serial, lineId: line.id })))
    await tools.tx.shipmentLine.delete({ where: { id: line.id }, select: { id: true } })
    tools.audit({ recordType: 'ShipmentLine', recordId: line.id, companyId: current.companyId, siteId: current.siteId, before: { shipmentId: current.id, workOrderSizeId: line.workOrderSizeId, quantity: line.quantity, parcelId: line.parcelId } })
    changed(tools, current, current.status, 'lines')
    return { shipment: await shipmentDetail(tools.tx, (await readShipment(tools.tx, current.id))!) }
  })
}

// ---- details and cancelling ---------------------------------------------------------------------------------------

export interface UpdateShipmentInput {
  readonly version?: number | undefined
  readonly shipToAddressId?: string | undefined
  readonly transportBy?: TransportBy | undefined
  readonly carrierCode?: string | null | undefined
  readonly serviceCode?: string | null | undefined
  readonly internalNote?: string | null | undefined
}

/**
 * shipping.manage: the delivery details (address, who carries, carrier and service) while the goods are planned or
 * packed and nothing was declared yet (no carrier label, no live DDT); the internal note at any time.
 */
export async function updateShipment(caller: CommandCaller, shipmentId: string, body: UpdateShipmentInput, idempotencyKey?: string) {
  const shipment = await officeShipment(caller, shipmentId, SHIPPING_MANAGE)
  const delivery = body.shipToAddressId !== undefined || body.transportBy !== undefined || body.carrierCode !== undefined || body.serviceCode !== undefined
  const shipTo = body.shipToAddressId ? await caller.withClient((client) => shipToOf(client, shipment.partyId, body.shipToAddressId!, 'body/shipToAddressId')) : undefined
  return onShipment(caller, shipment, { name: 'shipping.update', idempotencyKey, input: { shipmentId, ...body }, version: body.version }, async (tools) => {
    const current = (await readShipment(tools.tx, shipment.id))!
    if (delivery) {
      if (current.status !== 'DRAFT' && current.status !== 'PACKED') throw new InvalidStateError(`The shipment is ${current.status}; its delivery details change only until it leaves.`)
      const facts = await shipmentFacts(tools.tx, current.id)
      if (facts.parcels.some((parcel) => parcel.labelled) || facts.liveDdts > 0) throw new InvalidStateError('A carrier label or a DDT names these delivery details: void the labels and cancel the DDT first.')
    }
    const data: Prisma.ShipmentUncheckedUpdateInput = {
      ...(body.shipToAddressId ? { shipToAddressId: body.shipToAddressId, shipTo } : {}),
      ...(body.transportBy ? { transportBy: body.transportBy } : {}),
      ...(body.carrierCode !== undefined ? { carrierCode: blankToNull(body.carrierCode) } : {}),
      // A new carrier (or who carries) gives the carrier's name again: the DDT's default carrier (B-W1-48).
      ...(body.carrierCode !== undefined || body.transportBy !== undefined
        ? { carrierName: carrierNameFor(body.transportBy ?? current.transportBy, body.carrierCode !== undefined ? blankToNull(body.carrierCode) : current.carrierCode) }
        : {}),
      ...(body.serviceCode !== undefined ? { serviceCode: blankToNull(body.serviceCode) } : {}),
      ...(body.internalNote !== undefined ? { internalNote: blankToNull(body.internalNote) } : {}),
    }
    const before = { shipToAddressId: current.shipToAddressId, transportBy: current.transportBy, carrierCode: current.carrierCode, carrierName: current.carrierName, serviceCode: current.serviceCode, internalNote: current.internalNote }
    await tools.tx.shipment.update({ where: { id: current.id }, data, select: { id: true } })
    const after = (await readShipment(tools.tx, current.id))!
    tools.audit({ recordType: 'Shipment', recordId: current.id, companyId: current.companyId, siteId: current.siteId, before, after: { shipToAddressId: after.shipToAddressId, transportBy: after.transportBy, carrierCode: after.carrierCode, carrierName: after.carrierName, serviceCode: after.serviceCode, internalNote: after.internalNote } })
    changed(tools, current, current.status, 'details')
    return { shipment: await shipmentDetail(tools.tx, after) }
  })
}

/**
 * shipping.manage: cancels a DRAFT or PACKED shipment with its reason, when no carrier label and no live DDT name it.
 * Its serials are unpacked in the same command (a serial leaves a line only while the shipment is a DRAFT, so a PACKED
 * one is unpacked first): they can go on another shipment, or be taken back by a reversal. The office only; never the
 * floor. Its lines stay as they were and no longer count against the cells' released garments.
 */
export async function cancelShipment(caller: CommandCaller, shipmentId: string, body: { version?: number | undefined; reason: string }, idempotencyKey?: string) {
  const shipment = await officeShipment(caller, shipmentId, SHIPPING_MANAGE)
  return onShipment(caller, shipment, { name: 'shipping.cancel', idempotencyKey, input: { shipmentId, ...body }, version: body.version }, async (tools) => {
    const current = await lockedStatus(tools, shipment.id, ['DRAFT', 'PACKED'], 'it is cancelled')
    const facts = await shipmentFacts(tools.tx, current.id)
    assertTransition(shipmentMachine, current.status, 'CANCELLED', facts)
    const serials = await tools.tx.garmentSerial.findMany({ where: { shipmentLine: { shipmentId: current.id } }, select: { id: true, serial: true, shipmentLineId: true } })
    if (serials.length > 0) {
      if (current.status === 'PACKED') await tools.tx.shipment.update({ where: { id: current.id }, data: { status: 'DRAFT', packedAt: null }, select: { id: true } })
      await unpackSerialsOf(tools, current, serials.map((serial) => ({ id: serial.id, serial: serial.serial, lineId: serial.shipmentLineId! })))
    }
    await tools.tx.shipment.update({ where: { id: current.id }, data: { status: 'CANCELLED', cancelledAt: tools.now, cancelReason: body.reason }, select: { id: true } })
    tools.audit({ recordType: 'Shipment', recordId: current.id, companyId: current.companyId, siteId: current.siteId, before: { status: current.status }, after: { status: 'CANCELLED', unpackedSerials: serials.map((serial) => serial.serial) }, reason: body.reason })
    tools.emit({ type: 'shipment.status_changed', subject: current.id, companyId: current.companyId, siteId: current.siteId, payload: { shipmentId: current.id, number: current.number, from: current.status, to: 'CANCELLED' } })
    changed(tools, current, 'CANCELLED', 'status')
    return { shipment: await shipmentDetail(tools.tx, (await readShipment(tools.tx, current.id))!) }
  })
}
