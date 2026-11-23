import type { Prisma } from '@nexus/factory-db'
import { ConflictError, DomainError, ForbiddenError, InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import {
  citableOnInvoice,
  coveringReleaseAt,
  documentsLineOf,
  earliestLeaving,
  ELSEWHERE_WORDS,
  elsewhereProblems,
  elsewhereRefusalPath,
  holdRefusal,
  isHeld,
  overrideLineOf,
  paperDdtNumber,
  type ElsewhereCell,
  type ElsewhereHolds,
  type ElsewhereRefusalCode,
} from '@nexus/factory-domain/shipping/elsewhere'
import { SHIPPING_HOLDS_RELEASE } from '@nexus/factory-domain/shipping/holds/permissions'
import { SHIPPING_DDT_ISSUE, SHIPPING_MANAGE, SHIPPING_VIEW } from '@nexus/factory-domain/shipping/permissions'
import { shippable } from '@nexus/factory-domain/shipping/shipments'
import type { Permission } from '@nexus/factory-domain/core/permissions'
import { cleanBody } from '@nexus/factory-domain/threads/rules'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { allocateNumber } from '../../../platform/numbering/allocate'
import { ensureThread, writeMessage } from '../../../platform/threads/threads'
import { holdWordsAt } from '../../parties/holds/stops'
import { holdOnPacking } from '../../quality/holds/checks'
import { planCredit } from '../../sales/credit/check'
import { mayOn, officeContextOf, assertMay } from '../access'
import { cellCounts } from '../cells'
import { shipGoods } from '../ddt/ddt'
import { shipmentDocumentBlockers } from '../documents/read'
import { joinShipmentFacts, ordersChanged, ordersOfShipment } from '../shipments/orders-of'
import { addGarments, cellLabel, cellsFor, garmentsByCell, otherOrdersOf, packingChanged, shipmentDetail, shipToOf, type ShippableCell } from '../shipments/shipments'
import { readShipment } from '../store'
import type { ElsewhereBody } from './contract'

/**
 * B-OP-032 (order page N5; review R-2, R-9, R-10, R-23): "Record a shipment made elsewhere". Goods that left with a paper DDT
 * written outside Nexus are recorded in ONE command, as a shipment made here is planned (the same order, site, ship-to and
 * cell checks — modules/shipping/shipments — and the same release cap under the cells' locks):
 *
 *   1. a DRAFT shipment, origin ELSEWHERE, with its paper DDT (number and date, or none when an immediate invoice travelled
 *      instead), how it travelled (a carrier booked by hand with its tracking number, our van, the customer), numbered from
 *      the company's SHIPMENT series
 *   2. its lines (released garments only), each serial-tracked garment's serial (Q31); goods on a quality hold refuse it, as
 *      packing them would (modules/quality/holds/checks)
 *   3. SHIPPED at the time it left (ddt/ddt.ts shipGoods: packedAt = shippedAt, the event from DRAFT; R-2): its serials, the
 *      garments out of finished goods and the cost of sales posted NOW, on the recording day (D5: the audit names both days),
 *      the freight by the site's rule, the intra-EU evidence awaited.
 *
 * Refused in words (R-9) while the customer's account is on hold or its credit is held — unless the person may release holds
 * (shipping.holds.release) and says why: then it is recorded over them (the audit's `shipping.recordedElsewhere` and an office
 * line on each order's thread). No system hold is synced onto it (holds/system.ts skips ELSEWHERE). PPE documents not on file
 * never refuse a fact that already happened: recorded, with a warning line on the thread. The same paper DDT is recorded once
 * per customer (R-10, words that name no customer). Several orders of the customer: by the join rules (B-OP-047: N6 on).
 * The wall: an order the caller may not see — another customer's — is answered as an unknown one, before anything else.
 */

type Reader = CommandTx

interface Plan {
  readonly order: { readonly id: string; readonly number: string; readonly companyId: string; readonly partyId: string }
  readonly siteId: string
  readonly shipTo: Prisma.InputJsonValue
  readonly others: string[]
  readonly byCell: Map<string, { quantity: number; index: number }>
  readonly cells: Map<string, ShippableCell>
  readonly lines: ElsewhereCell[]
  readonly serials: Map<string, string[]>
  readonly problems: ReturnType<typeof elsewhereProblems>
  readonly holds: ElsewhereHolds & { readonly mayRelease: boolean }
  readonly ddtUsed: boolean
  readonly noticeOn: boolean
}

const refused = (code: ElsewhereRefusalCode, message: string): never => {
  throw new DomainError('conflict', message, [{ path: elsewhereRefusalPath(code), message }])
}

const day = (date: string): Date => new Date(`${date}T00:00:00.000Z`)
const blankToNull = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())

/** The customer's holds now (its account hold's words for shipping; its credit HOLD at the shipment step). */
async function holdsOf(db: Reader, at: { readonly partyId: string; readonly companyId: string }, now: Date): Promise<ElsewhereHolds> {
  const accountHold = await holdWordsAt(db, at, 'SHIPMENT')
  const credit = await planCredit(db, { step: 'SHIPMENT', partyId: at.partyId, companyId: at.companyId, now, askers: [] })
  return { accountHold, creditHeld: credit?.result === 'HOLD' }
}

/** What the recording would be, read in the caller's scope (nothing written): the preview's answer and the command's plan. */
async function planOf(caller: CommandCaller, body: ElsewhereBody, permission: Permission): Promise<Plan> {
  const context = officeContextOf(caller)
  const byCell = garmentsByCell(body.lines)
  const serials = new Map<string, string[]>()
  for (const line of body.lines) serials.set(line.workOrderSizeId, [...(serials.get(line.workOrderSizeId) ?? []), ...(line.serials ?? [])])
  const now = serverClock.now()
  return caller.withClient(async (client) => {
    // The wall first: an order the caller may not see is an unknown one (another customer's, for a person limited to some).
    const order = await client.salesOrder.findUnique({ where: { id: body.salesOrderId }, select: { id: true, number: true, companyId: true, partyId: true, status: true, shipTo: true } })
    if (!order || !mayOn(context, SHIPPING_VIEW, { companyId: order.companyId, partyId: order.partyId })) throw new NotFoundError('Sales order not found.')
    const cellSites = await client.workOrderSize.findMany({ where: { id: { in: [...byCell.keys()] } }, select: { siteId: true } })
    const sites = new Set(cellSites.map((cell) => cell.siteId))
    const siteId = body.siteId ?? (sites.size === 1 ? [...sites][0]! : null)
    if (!siteId) throw new ValidationError('Name the site the goods leave from.', [{ path: 'body/siteId', message: 'Required when the lines do not name one site.' }])
    const site = await client.site.findUnique({ where: { id: siteId }, select: { id: true, companyId: true } })
    if (!site || site.companyId !== order.companyId) throw new ValidationError("Not a site of the order's company.", [{ path: 'body/siteId', message: "Expected a site of the order's company." }])
    assertMay(context, SHIPPING_VIEW, permission, { companyId: order.companyId, siteId, partyId: order.partyId }, 'Sales order')
    if (order.status === 'CANCELLED' || order.status === 'CLOSED') throw new InvalidStateError(`The sales order is ${order.status}; nothing more ships for it.`)
    if (order.status === 'PENDING_APPROVAL') throw new InvalidStateError('The sales order waits for a yes; nothing ships for it until it is confirmed.')
    const shipTo = body.shipToAddressId ? await shipToOf(client, order.partyId, body.shipToAddressId, 'body/shipToAddressId') : (order.shipTo as Prisma.InputJsonValue)
    // B-OP-040 (N6): the other orders asked, each checked against the first (B-OP-047: the real join rules only).
    const join = await joinShipmentFacts(client, { number: null, status: 'DRAFT', siteId, salesOrderId: order.id, shipTo })
    const others = await otherOrdersOf(client, context, { salesOrderId: order.id, salesOrderIds: body.salesOrderIds }, order.id, join)
    const cells = await cellsFor(client, { siteId, partyId: order.partyId, salesOrderId: order.id, status: 'DRAFT', salesOrderIds: [order.id, ...others], join }, byCell, 'body/lines')
    // Each cell: what it can still ship, the release that covers these garments, whether its style is serial-tracked.
    const ids = [...byCell.keys()]
    const counts = await cellCounts(client, ids)
    const releases = await client.qualityRelease.findMany({ where: { workOrderSizeId: { in: ids } }, select: { workOrderSizeId: true, quantity: true, releasedAt: true } })
    const tracking = await client.workOrderSize.findMany({ where: { id: { in: ids } }, select: { id: true, workOrder: { select: { style: { select: { garmentTracking: true } } } } } })
    const serialTracked = new Set(tracking.filter((row) => row.workOrder.style.garmentTracking === 'SERIAL').map((row) => row.id))
    const lines: ElsewhereCell[] = [...byCell.entries()]
      .sort(([, a], [, b]) => a.index - b.index)
      .map(([cellId, { quantity }]) => {
        const count = counts.get(cellId) ?? { released: 0, reversed: 0, onShipments: 0 }
        const own = releases.filter((release) => release.workOrderSizeId === cellId).map((release) => ({ quantity: release.quantity, at: toUtcIso(release.releasedAt) }))
        return {
          workOrderSizeId: cellId,
          label: cellLabel(cells.get(cellId)!),
          quantity,
          shippable: shippable(count),
          releasedAt: coveringReleaseAt(own, count.onShipments + quantity),
          serialTracked: serialTracked.has(cellId),
          serials: serials.get(cellId)?.length ?? 0,
        }
      })
    const externalDdt = body.externalDdt ? { number: paperDdtNumber(body.externalDdt.number), date: body.externalDdt.date } : null
    const problems = elsewhereProblems({ shippedAt: body.shippedAt, externalDdt, ddtRequired: body.ddtRequired, cells: lines }, now)
    const holds = await holdsOf(client, { partyId: order.partyId, companyId: order.companyId }, now)
    // R-10: the same paper DDT once per customer (the unique key holds the party: the conflict is always the customer's own).
    const used = externalDdt
      ? await client.shipment.findFirst({ where: { companyId: order.companyId, partyId: order.partyId, externalDdtNumber: externalDdt.number, externalDdtDate: day(externalDdt.date) }, select: { id: true } })
      : null
    const settings = await client.shippingSettings.findUnique({ where: { id: siteId }, select: { customerNoticeOn: true } })
    return {
      order: { id: order.id, number: order.number, companyId: order.companyId, partyId: order.partyId },
      siteId,
      shipTo,
      others,
      byCell,
      cells,
      lines,
      serials,
      problems,
      holds: { ...holds, mayRelease: mayOn(context, SHIPPING_HOLDS_RELEASE, { companyId: order.companyId, siteId, partyId: order.partyId }) },
      ddtUsed: used !== null,
      noticeOn: settings?.customerNoticeOn === true,
    }
  })
}

// ---- POST /shipping/shipments/elsewhere/preview ------------------------------------------------------------------------

/** shipping.view: what the recording would say now (nothing written). */
export async function previewElsewhere(caller: CommandCaller, body: ElsewhereBody) {
  const plan = await planOf(caller, body, SHIPPING_VIEW)
  return {
    order: { id: plan.order.id, number: plan.order.number },
    siteId: plan.siteId,
    lines: plan.lines.map((line) => ({ workOrderSizeId: line.workOrderSizeId, label: line.label, quantity: line.quantity, shippable: line.shippable, releasedAt: line.releasedAt, serialTracked: line.serialTracked })),
    earliest: earliestLeaving(plan.lines),
    problems: plan.problems.map((problem) => ({ code: problem.code, path: problem.path, message: problem.message })),
    holds: { held: isHeld(plan.holds), accountHold: plan.holds.accountHold, creditHeld: plan.holds.creditHeld, mayRelease: plan.holds.mayRelease },
    ddtUsed: plan.ddtUsed,
    noticeOn: plan.noticeOn,
    ddtCitable: body.externalDdt ? citableOnInvoice(paperDdtNumber(body.externalDdt.number)) : true,
  }
}

// ---- POST /shipping/shipments/elsewhere --------------------------------------------------------------------------------

const isUniqueViolation = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === 'P2002' || (error as { meta?: { driverAdapterError?: { cause?: { originalCode?: unknown } } } } | null)?.meta?.driverAdapterError?.cause?.originalCode === '23505'

/** Each serial-tracked line takes the serials named for its cell: RELEASED, on no shipment, of that cell (Q31). */
async function placeSerials(tools: CommandTools, shipment: { readonly id: string; readonly companyId: string; readonly siteId: string }, added: readonly { readonly lineId: string; readonly workOrderSizeId: string }[], serials: ReadonlyMap<string, readonly string[]>, plan: Plan): Promise<string[]> {
  const ids: string[] = []
  for (const line of added) {
    const asked = serials.get(line.workOrderSizeId) ?? []
    if (asked.length === 0) continue
    const index = plan.byCell.get(line.workOrderSizeId)?.index ?? 0
    const rows = await tools.tx.garmentSerial.findMany({ where: { serial: { in: [...asked] }, workOrderSizeId: line.workOrderSizeId }, select: { id: true, serial: true, status: true, shipmentLineId: true } })
    for (const serial of asked) {
      const row = rows.find((entry) => entry.serial === serial)
      const path = `body/lines/${index}/serials`
      if (!row) throw new ValidationError(`Serial ${serial} is not a garment of ${plan.lines.find((entry) => entry.workOrderSizeId === line.workOrderSizeId)?.label ?? 'this line'}.`, [{ path, message: `Serial ${serial} is not of this cell.` }])
      if (row.status !== 'RELEASED') throw new ConflictError(`Serial ${row.serial} is ${row.status}: only garments quality released ship (QHS-073).`)
      if (row.shipmentLineId !== null) throw new ConflictError(`Serial ${row.serial} is on another shipment.`)
      await tools.tx.garmentSerial.update({ where: { id: row.id }, data: { shipmentLineId: line.lineId, version: { increment: 1 } }, select: { id: true } })
      tools.audit({ action: 'shipping.packSerial', recordType: 'GarmentSerial', recordId: row.id, companyId: shipment.companyId, siteId: shipment.siteId, before: { shipmentLineId: null }, after: { shipmentLineId: line.lineId, shipmentId: shipment.id } })
      ids.push(row.id)
    }
  }
  return ids
}

/** One office line (INTERNAL_NOTE, by the system) on each order's thread, in the company's language. */
async function noteOnOrders(tools: CommandTools, orderIds: readonly string[], companyId: string, text: (locale: 'it' | 'en') => string): Promise<void> {
  const company = await tools.tx.company.findUnique({ where: { id: companyId }, select: { locale: true } })
  const locale = company?.locale === 'en' ? 'en' : 'it'
  for (const orderId of [...new Set(orderIds)].sort()) {
    const { thread } = await ensureThread(tools, { type: 'SalesOrder', id: orderId }, null)
    await writeMessage(tools, thread, { direction: 'INTERNAL_NOTE', channel: 'APP', author: { kind: 'SYSTEM', id: null, name: null }, bodyText: cleanBody(text(locale)) })
  }
}

/**
 * shipping.manage + shipping.ddt.issue: records the shipment made elsewhere (see the file's comment). 400 with every field
 * problem; 409 in words while the customer is held (HELD, REASON_REQUIRED), for a paper DDT recorded already
 * (DDT_NUMBER_USED), for garments on a quality hold or not released.
 */
export async function recordElsewhere(caller: CommandCaller, body: ElsewhereBody, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const plan = await planOf(caller, body, SHIPPING_MANAGE)
  const scope = { companyId: plan.order.companyId, siteId: plan.siteId, partyId: plan.order.partyId }
  if (!mayOn(context, SHIPPING_DDT_ISSUE, scope)) throw new ForbiddenError("Recording the goods' paper DDT needs the right to issue DDTs too.")
  // The refusals of the whole first (that paper DDT is recorded already; the customer is held), then every field problem.
  if (plan.ddtUsed) refused('DDT_NUMBER_USED', ELSEWHERE_WORDS.DDT_NUMBER_USED)
  const hold = holdRefusal(plan.holds, { mayRelease: plan.holds.mayRelease, reason: body.holdReason })
  if (hold) refused(hold.code, hold.message)
  if (plan.problems.length > 0) throw new ValidationError(plan.problems.length === 1 ? plan.problems[0]!.message : 'This shipment cannot be recorded as it is.', plan.problems.map((problem) => ({ path: problem.path, message: problem.message })))
  const paper = body.externalDdt ? { number: paperDdtNumber(body.externalDdt.number), date: body.externalDdt.date } : null
  const carrier = body.transportBy === 'CARRIER' ? { carrierName: blankToNull(body.carrierName), manualTrackingNumber: blankToNull(body.trackingNumber) } : { carrierName: null, manualTrackingNumber: null }
  const shippedAt = new Date(body.shippedAt)

  const { result } = await command(caller, { name: 'shipping.recordElsewhere', idempotencyKey, input: body }, async (tools) => {
    // The holds again under the command: one placed meanwhile refuses it (R-9) unless overridden with the reason.
    const holds = await holdsOf(tools.tx, { partyId: plan.order.partyId, companyId: plan.order.companyId }, tools.now)
    const again = holdRefusal(holds, { mayRelease: plan.holds.mayRelease, reason: body.holdReason })
    if (again) refused(again.code, again.message)
    const overridden = isHeld(holds)

    const id = newId()
    const number = await allocateNumber(tools, { companyId: plan.order.companyId, kind: 'SHIPMENT' }, { type: 'Shipment', id })
    try {
      await tools.tx.shipment.create({
        data: {
          id,
          companyId: plan.order.companyId,
          siteId: plan.siteId,
          partyId: plan.order.partyId,
          salesOrderId: plan.order.id,
          number: number.formatted,
          shipToAddressId: body.shipToAddressId ?? null,
          shipTo: plan.shipTo,
          transportBy: body.transportBy,
          carrierName: carrier.carrierName,
          manualTrackingNumber: carrier.manualTrackingNumber,
          // B-OP-005 / B-OP-032: made elsewhere, with its paper DDT (R-23: none when an immediate invoice travelled instead).
          origin: 'ELSEWHERE',
          externalDdtNumber: paper?.number ?? null,
          externalDdtDate: paper ? day(paper.date) : null,
          ddtRequired: body.ddtRequired,
          internalNote: blankToNull(body.internalNote),
          createdById: context.actorId,
        },
        select: { id: true },
      })
    } catch (error) {
      if (isUniqueViolation(error)) refused('DDT_NUMBER_USED', ELSEWHERE_WORDS.DDT_NUMBER_USED)
      throw error
    }
    const made = { id, number: number.formatted, companyId: plan.order.companyId, siteId: plan.siteId, partyId: plan.order.partyId }
    const added = await addGarments(tools, made, plan.byCell, plan.cells)
    const serialIds = await placeSerials(tools, made, added, plan.serials, plan)
    // Goods on a quality hold never leave (as packing them would be refused).
    const onHold = await holdOnPacking(tools.tx, tools.context, { shipmentId: id, workOrderIds: [...new Set([...plan.cells.values()].map((cell) => cell.workOrder.id))], serialIds })
    if (onHold) throw new ConflictError(onHold)
    // PPE documents not on file: recorded with a warning line, never refused (the goods left already).
    const missing = (await shipmentDocumentBlockers(tools.tx, id)).map((check) => check.message)
    const garments = added.reduce((sum, line) => sum + line.quantity, 0)
    tools.audit({
      recordType: 'Shipment',
      recordId: id,
      companyId: made.companyId,
      siteId: made.siteId,
      after: { number: made.number, status: 'DRAFT', origin: 'ELSEWHERE', salesOrderId: plan.order.id, siteId: made.siteId, transportBy: body.transportBy, carrierName: carrier.carrierName, shipToAddressId: body.shipToAddressId ?? null, externalDdt: paper, ddtRequired: body.ddtRequired, lines: added },
    })
    tools.emit({ type: 'shipment.created', subject: id, companyId: made.companyId, siteId: made.siteId, payload: { shipmentId: id, number: made.number, salesOrderId: plan.order.id, siteId: made.siteId, lines: added.length, garments, partyId: made.partyId } })
    packingChanged(tools, made, 'DRAFT', 'lines')
    if (plan.others.length > 0) ordersChanged(tools, made, [plan.order.id], await ordersOfShipment(tools.tx, { id, salesOrderId: plan.order.id }), { atCreation: true } /* B-CW-040 */)

    // Leaves at the time it left (R-2): DRAFT → SHIPPED, packed then too; stock and cost of sales post now (D5).
    const header = (await readShipment(tools.tx, id))!
    const shippedSerials = await shipGoods(tools, header, { from: 'DRAFT', shippedAt, periodLockOverride: body.periodLockOverride, elsewhere: { holdsOverridden: overridden } })
    const orders = await ordersOfShipment(tools.tx, { id, salesOrderId: plan.order.id })
    const reason = overridden ? body.holdReason!.trim() : null
    tools.audit({
      action: 'shipping.recordedElsewhere',
      recordType: 'Shipment',
      recordId: id,
      companyId: made.companyId,
      siteId: made.siteId,
      before: { status: 'DRAFT' },
      after: {
        status: 'SHIPPED',
        shippedAt: shippedAt.toISOString(),
        recordedAt: tools.now.toISOString(),
        externalDdt: paper,
        ddtRequired: body.ddtRequired,
        serials: shippedSerials,
        salesOrderIds: orders,
        holds: overridden ? { accountHold: holds.accountHold, creditHeld: holds.creditHeld, reason } : null,
        missingDocuments: missing,
      },
      ...(reason ? { reason } : {}),
    })
    const warnings: string[] = []
    if (reason) await noteOnOrders(tools, orders, made.companyId, (locale) => overrideLineOf({ shipment: made.number, reason, ddt: paper?.number ?? null }, locale))
    if (missing.length > 0) {
      await noteOnOrders(tools, orders, made.companyId, (locale) => documentsLineOf({ shipment: made.number, missing }, locale))
      warnings.push(...missing)
    }
    return { shipment: await shipmentDetail(tools.tx, (await readShipment(tools.tx, id))!), warnings }
  })
  return result
}
