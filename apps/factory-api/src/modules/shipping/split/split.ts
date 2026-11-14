import type { Prisma } from '@nexus/factory-db'
import { DomainError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { addressUseProblem } from '@nexus/factory-domain/parties/address-approval'
import { carrierNameFor } from '@nexus/factory-domain/shipping/labels/labels'
import { SHIPPING_MANAGE, SHIPPING_VIEW } from '@nexus/factory-domain/shipping/permissions'
import { earliestDay } from '@nexus/factory-domain/shipping/queue/risk'
import {
  garmentsLeft,
  groupsByPromise,
  movableOf,
  moveProblems,
  reasonProblems,
  SPLIT_REASONS,
  SPLIT_RULES,
  type DeliveryChoice,
  type MoveAsk,
  type SplitReason,
  type SplitRefusalCode,
  type SplitRule,
} from '@nexus/factory-domain/shipping/split/split'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { allocateNumber } from '../../../platform/numbering/allocate'
import { assertMay, mayOn, officeContextOf } from '../access'
import { lockCells, tenantOf } from '../cells'
import { carryHoldsInCommand, lockShipmentRow } from '../holds/store'
import { syncSystemHoldsInCommand } from '../holds/system'
import { shipByLookup } from '../queue/promise'
import { shipmentDetail } from '../shipments/shipments'
import { readShipment, type ShipmentHeader } from '../store'

/**
 * Split one order into several shipments (B-W2b-386; LOG-005; rules factory-domain shipping/split). Office: shipping.view
 * reads what can move and the rule's proposal; shipping.manage splits. ONE command on the shipment split from (its version
 * guards it and locks its row): the cells' shipping locks (sorted, as W1's line writes take them), then each new DRAFT shipment
 * of the same order, site and customer (its number from the company's SHIPMENT series; splitFromId + splitReason; its own
 * carrier, service, who carries it or delivery address), its lines (garments taken off the old lines first, so a cell's
 * garments on shipments never pass its releases), the holds carried over and the system's holds settled, audit rows and
 * events (W1's shipment.created and shipment.packing_changed, and shipment.split).
 */

type Reader = CommandTx

function refused(code: SplitRefusalCode, message: string): never {
  throw new DomainError('conflict', message, [{ path: `refusal/${code}`, message }])
}

interface LineFacts {
  readonly id: string
  readonly quantity: number
  readonly parcelId: string | null
  readonly workOrderId: string
  readonly workOrderSizeId: string
  readonly salesOrderLineId: string
  readonly size: string
  readonly packed: number
  readonly serials: number
  readonly label: string
}

/** The shipment's lines with what is packed into cartons and the serials each holds. */
async function readLines(db: Reader, shipmentId: string): Promise<LineFacts[]> {
  const lines = await db.shipmentLine.findMany({
    where: { shipmentId },
    select: { id: true, quantity: true, parcelId: true, workOrderId: true, workOrderSizeId: true, salesOrderLineId: true, size: true, workOrderSize: { select: { workOrder: { select: { number: true, style: { select: { code: true } } } }, colourway: { select: { code: true } } } } },
    orderBy: { id: 'asc' },
  })
  const packed = await db.parcelLine.groupBy({ by: ['shipmentLineId'], where: { shipmentId }, _sum: { quantity: true } })
  const serials = await db.garmentSerial.groupBy({ by: ['shipmentLineId'], where: { shipmentLine: { shipmentId } }, _count: { _all: true } })
  const packedBy = new Map(packed.map((row) => [row.shipmentLineId, row._sum.quantity ?? 0]))
  const serialsBy = new Map(serials.map((row) => [row.shipmentLineId, row._count._all]))
  return lines.map((line) => ({
    id: line.id,
    quantity: line.quantity,
    parcelId: line.parcelId,
    workOrderId: line.workOrderId,
    workOrderSizeId: line.workOrderSizeId,
    salesOrderLineId: line.salesOrderLineId,
    size: line.size,
    packed: packedBy.get(line.id) ?? 0,
    serials: serialsBy.get(line.id) ?? 0,
    label: `${line.workOrderSize.workOrder.style.code} ${line.workOrderSize.colourway.code} ${line.size} (${line.workOrderSize.workOrder.number})`,
  }))
}

/** GET /shipping/shipments/:shipmentId/split (shipping.view): what can move, by line, and what the rule would do. */
export async function splitPreview(caller: CommandCaller, shipmentId: string) {
  const context = officeContextOf(caller)
  const shipment = await caller.withClient((client) => readShipment(client, shipmentId))
  assertMay(context, SHIPPING_VIEW, SHIPPING_VIEW, shipment)
  return caller.withClient(async (client) => {
    const lines = await readLines(client, shipment!.id)
    const shipBy = await shipByLookup(client, lines)
    const dated = lines.map((line) => ({ ...line, shipBy: shipBy(line.salesOrderLineId, line.size) }))
    const rule = groupsByPromise(dated)
    const held = await client.shipmentHold.count({ where: { shipmentId: shipment!.id, releasedAt: null } })
    return {
      shipmentId: shipment!.id,
      number: shipment!.number,
      status: shipment!.status,
      version: shipment!.version,
      /** Only a DRAFT shipment's garments move (a PACKED one is unpacked first). */
      splittable: shipment!.status === 'DRAFT',
      held: held > 0,
      lines: dated.map((line) => ({ id: line.id, label: line.label, workOrderSizeId: line.workOrderSizeId, size: line.size, quantity: line.quantity, packed: line.packed, serials: line.serials, movable: movableOf(line), shipBy: line.shipBy })),
      reasons: [...SPLIT_REASONS],
      rules: [{ rule: 'PROMISE_DATE' as const, stays: rule.stays, shipments: rule.groups.map((group) => ({ shipBy: group.shipBy, garments: group.garments, lines: [...group.moves] })), kept: [...rule.kept] }],
      mayManage: mayOn(context, SHIPPING_MANAGE, shipment!),
    }
  })
}

export interface DeliveryInput {
  readonly transportBy?: 'CARRIER' | 'SENDER' | 'RECIPIENT' | undefined
  readonly carrierCode?: string | null | undefined
  readonly serviceCode?: string | null | undefined
  readonly shipToAddressId?: string | undefined
}

export interface SplitBody extends DeliveryInput {
  readonly version?: number | undefined
  readonly reason: SplitReason
  readonly lines: readonly MoveAsk[]
}

const blankToNull = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())

/** The ship-to snapshot of a customer's delivery address (W1's shape of SalesOrder.shipTo); 400 when it is not one. */
async function shipToOf(db: Reader, partyId: string, addressId: string): Promise<Record<string, string>> {
  const address = isUuid(addressId)
    ? await db.partyAddress.findUnique({ where: { id: addressId }, select: { partyId: true, kinds: true, status: true, approvalStatus: true, name: true, line1: true, line2: true, postalCode: true, city: true, province: true, country: true, contactName: true, phone: true } })
    : null
  if (!address || address.partyId !== partyId || address.status !== 'ACTIVE' || !address.kinds.includes('SHIP_TO')) {
    throw new ValidationError('Not a delivery address of this customer.', [{ path: 'body/shipToAddressId', message: "Expected an active delivery (SHIP_TO) address of the order's party." }])
  }
  const unchecked = addressUseProblem(address.approvalStatus)
  if (unchecked) throw new ValidationError(unchecked, [{ path: 'body/shipToAddressId', message: unchecked }])
  const { partyId: _party, kinds: _kinds, status: _status, approvalStatus: _approval, ...fields } = address
  return Object.fromEntries(Object.entries(fields).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== ''))
}

interface Group {
  readonly reason: SplitReason
  readonly moves: readonly MoveAsk[]
  readonly delivery: DeliveryChoice
  readonly shipTo: Prisma.InputJsonValue | null
}

/** Inside the command: the new shipments with their lines, holds and events; their ids. */
async function splitInCommand(tools: CommandTools, parent: ShipmentHeader, groups: readonly Group[], byRule: boolean): Promise<string[]> {
  const { tx } = tools
  const lines = await readLines(tx, parent.id)
  const byId = new Map(lines.map((line) => [line.id, line]))
  const asks = groups.flatMap((group) => group.moves)
  // Checked again under the lock: what was read before may have moved.
  const problems = moveProblems(lines, asks)
  if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems.map((issue) => ({ path: `body/${issue.path}`, message: issue.message })))
  if (garmentsLeft(lines, asks) < 1) refused('NOTHING_STAYS', `Something stays on shipment ${parent.number}: to send all of it another way, change its carrier or delivery address instead.`)
  await lockCells(tx, tenantOf(tools.context), asks.map((ask) => byId.get(ask.lineId)!.workOrderSizeId))
  const facts = await tx.shipment.findUniqueOrThrow({ where: { id: parent.id }, select: { integrationAccountId: true, express: true, dutyPayer: true, paperless: true, transportMode: true } })
  const actorId = tools.context.audience === 'office' ? tools.context.actorId : null
  const from = await lockShipmentRow(tx, parent.id)
  const made: string[] = []
  for (const group of groups) {
    // Garments come off the old lines first: a cell's lines over every shipment never pass its releases (the triggers).
    for (const move of group.moves) {
      const line = byId.get(move.lineId)!
      if (move.quantity === line.quantity) await tx.shipmentLine.delete({ where: { id: line.id }, select: { id: true } })
      else await tx.shipmentLine.update({ where: { id: line.id }, data: { quantity: line.quantity - move.quantity, version: { increment: 1 } }, select: { id: true } })
      tools.audit({ action: 'shipping.splitLine', recordType: 'ShipmentLine', recordId: line.id, companyId: parent.companyId, siteId: parent.siteId, before: { quantity: line.quantity }, after: { quantity: line.quantity - move.quantity } })
    }
    const id = newId()
    const number = await allocateNumber(tools, { companyId: parent.companyId, kind: 'SHIPMENT' }, { type: 'Shipment', id })
    const delivery = group.delivery
    await tx.shipment.create({
      data: {
        id,
        companyId: parent.companyId,
        siteId: parent.siteId,
        partyId: parent.partyId,
        salesOrderId: parent.salesOrderId,
        number: number.formatted,
        shipToAddressId: delivery.shipToAddressId,
        shipTo: group.shipTo ?? (parent.shipTo as Prisma.InputJsonValue),
        transportBy: delivery.transportBy,
        carrierCode: delivery.carrierCode,
        carrierName: carrierNameFor(delivery.transportBy, delivery.carrierCode),
        serviceCode: delivery.serviceCode,
        integrationAccountId: delivery.transportBy === 'CARRIER' ? facts.integrationAccountId : null,
        express: facts.express,
        dutyPayer: facts.dutyPayer,
        paperless: facts.paperless,
        transportMode: facts.transportMode,
        splitFromId: parent.id,
        splitReason: group.reason,
        createdById: actorId,
      },
      select: { id: true },
    })
    const added: { lineId: string; workOrderSizeId: string; quantity: number }[] = []
    for (const move of group.moves) {
      const line = byId.get(move.lineId)!
      const lineId = newId()
      await tx.shipmentLine.create({
        data: { id: lineId, siteId: parent.siteId, partyId: parent.partyId, shipmentId: id, workOrderId: line.workOrderId, workOrderSizeId: line.workOrderSizeId, salesOrderLineId: line.salesOrderLineId, size: line.size, quantity: move.quantity, createdById: actorId },
        select: { id: true },
      })
      added.push({ lineId, workOrderSizeId: line.workOrderSizeId, quantity: move.quantity })
    }
    const garments = added.reduce((sum, line) => sum + line.quantity, 0)
    tools.audit({
      recordType: 'Shipment',
      recordId: id,
      companyId: parent.companyId,
      siteId: parent.siteId,
      after: { number: number.formatted, status: 'DRAFT', salesOrderId: parent.salesOrderId, splitFromId: parent.id, splitReason: group.reason, byRule, ...delivery, lines: added },
    })
    tools.audit({ action: 'shipping.split', recordType: 'Shipment', recordId: parent.id, companyId: parent.companyId, siteId: parent.siteId, after: { into: { shipmentId: id, number: number.formatted }, reason: group.reason, byRule, moved: group.moves } })
    tools.emit({ type: 'shipment.created', subject: id, companyId: parent.companyId, siteId: parent.siteId, payload: { shipmentId: id, number: number.formatted, salesOrderId: parent.salesOrderId, siteId: parent.siteId, lines: added.length, garments } })
    tools.emit({ type: 'shipment.split', subject: id, companyId: parent.companyId, siteId: parent.siteId, payload: { shipmentId: id, number: number.formatted, splitFromId: parent.id, fromNumber: parent.number, reason: group.reason, byRule, lines: added.length, garments } })
    tools.emit({ type: 'shipment.packing_changed', subject: id, companyId: parent.companyId, siteId: parent.siteId, payload: { shipmentId: id, number: number.formatted, status: 'DRAFT', change: 'lines' } })
    const to = await lockShipmentRow(tx, id)
    await carryHoldsInCommand(tools, from, to)
    made.push(id)
  }
  tools.emit({ type: 'shipment.packing_changed', subject: parent.id, companyId: parent.companyId, siteId: parent.siteId, payload: { shipmentId: parent.id, number: parent.number, status: 'DRAFT', change: 'lines' } })
  // The system's holds of the new shipments settle as their causes stand (most were carried over already).
  await syncSystemHoldsInCommand(tools, made)
  return made
}

/** The parent the office may split (shipping.manage over it), as read before the command. */
async function splittable(caller: CommandCaller, shipmentId: string): Promise<ShipmentHeader> {
  const context = officeContextOf(caller)
  const shipment = await caller.withClient((client) => readShipment(client, shipmentId))
  assertMay(context, SHIPPING_VIEW, SHIPPING_MANAGE, shipment)
  return shipment!
}

/** The new shipment's delivery: what the body says, else the parent's (a new carrier drops the parent's service). */
function deliveryOf(parent: ShipmentHeader, body: DeliveryInput): DeliveryChoice {
  const transportBy = body.transportBy ?? parent.transportBy
  const carrierCode = body.carrierCode !== undefined ? blankToNull(body.carrierCode) : transportBy === parent.transportBy ? parent.carrierCode : null
  const sameCarrier = transportBy === parent.transportBy && carrierCode === parent.carrierCode
  const serviceCode = body.serviceCode !== undefined ? blankToNull(body.serviceCode) : sameCarrier ? parent.serviceCode : null
  return { transportBy, carrierCode: transportBy === 'CARRIER' ? carrierCode : null, serviceCode: transportBy === 'CARRIER' ? serviceCode : null, shipToAddressId: body.shipToAddressId ?? parent.shipToAddressId }
}

const fromOf = (parent: ShipmentHeader): DeliveryChoice => ({ transportBy: parent.transportBy, carrierCode: parent.carrierCode, serviceCode: parent.serviceCode, shipToAddressId: parent.shipToAddressId })

/** POST /shipping/shipments/:shipmentId/split (shipping.manage): garments named by hand onto a new shipment. */
export async function splitShipment(caller: CommandCaller, shipmentId: string, body: SplitBody, idempotencyKey?: string) {
  const parent = await splittable(caller, shipmentId)
  const delivery = deliveryOf(parent, body)
  const reasonIssues: Issue[] = reasonProblems(body.reason, fromOf(parent), delivery)
  if (reasonIssues.length > 0) throw new ValidationError(reasonIssues[0]!.message, reasonIssues.map((issue) => ({ path: `body/${issue.path}`, message: issue.message })))
  const shipTo = body.shipToAddressId ? ((await caller.withClient((client) => shipToOf(client, parent.partyId, body.shipToAddressId!))) as Prisma.InputJsonValue) : null
  const { result } = await command(caller, { name: 'shipping.split', idempotencyKey, input: { shipmentId, ...body }, record: { type: 'Shipment', id: parent.id, expectedVersion: body.version } }, async (tools) => {
    const current = (await readShipment(tools.tx, parent.id))!
    if (current.status !== 'DRAFT') refused('NOT_DRAFT', `Shipment ${current.number} is ${current.status}: only a DRAFT shipment's garments move onto another (unpack it first).`)
    const [id] = await splitInCommand(tools, current, [{ reason: body.reason, moves: body.lines, delivery, shipTo }], false)
    return { shipment: await shipmentDetail(tools.tx, (await readShipment(tools.tx, id!))!), from: await shipmentDetail(tools.tx, (await readShipment(tools.tx, current.id))!) }
  })
  return result
}

export interface SplitRuleBody {
  readonly version?: number | undefined
  readonly rule: SplitRule
}

/** POST /shipping/shipments/:shipmentId/split-by-rule (shipping.manage): the rule's new shipments, in ONE command. */
export async function splitByRule(caller: CommandCaller, shipmentId: string, body: SplitRuleBody, idempotencyKey?: string) {
  const parent = await splittable(caller, shipmentId)
  if (!(SPLIT_RULES as readonly string[]).includes(body.rule)) throw new ValidationError('Not a split rule.', [{ path: 'body/rule', message: `One of ${SPLIT_RULES.join(', ')}.` }])
  const { result } = await command(caller, { name: 'shipping.splitByRule', idempotencyKey, input: { shipmentId, ...body }, record: { type: 'Shipment', id: parent.id, expectedVersion: body.version } }, async (tools) => {
    const current = (await readShipment(tools.tx, parent.id))!
    if (current.status !== 'DRAFT') refused('NOT_DRAFT', `Shipment ${current.number} is ${current.status}: only a DRAFT shipment's garments move onto another (unpack it first).`)
    const lines = await readLines(tools.tx, current.id)
    const shipBy = await shipByLookup(tools.tx, lines)
    const dated = lines.map((line) => ({ ...line, shipBy: shipBy(line.salesOrderLineId, line.size) }))
    const rule = groupsByPromise(dated)
    if (rule.groups.length === 0) {
      const days = new Set(dated.map((line) => line.shipBy).filter((day) => day !== null))
      if (days.size <= 1) refused('ONE_DAY', `Every garment of shipment ${current.number} is promised for ${earliestDay(dated.map((line) => line.shipBy)) ?? 'no known day'}: nothing to split by promise date.`)
      refused('NOTHING_TO_MOVE', `The garments promised later on shipment ${current.number} are in cartons or carry serials: take them out first.`)
    }
    const delivery = fromOf(current)
    const ids = await splitInCommand(tools, current, rule.groups.map((group) => ({ reason: 'PROMISE_DATE' as const, moves: group.moves, delivery, shipTo: null })), true)
    const shipments = []
    for (const id of ids) shipments.push(await shipmentDetail(tools.tx, (await readShipment(tools.tx, id))!))
    return { shipments, from: await shipmentDetail(tools.tx, (await readShipment(tools.tx, current.id))!) }
  })
  return result
}
