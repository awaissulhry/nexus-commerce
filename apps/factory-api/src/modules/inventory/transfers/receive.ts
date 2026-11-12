import type { Prisma } from '@nexus/factory-db'
import { InvalidStateError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import type { ReceiveBody, SettleBody, TransferView } from '@nexus/factory-domain/inventory/transfers/contracts'
import {
  problem,
  quantityOut,
  receiveProblems,
  settleProblems,
  statusAfterReceipt,
  typedQuantity,
  type ReceiveLineFacts,
  type TransferStatus,
} from '@nexus/factory-domain/inventory/transfers/rules'
import { Dec, ZERO, type Decimal } from '@nexus/factory-domain/tax/decimal'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { allocateScanIds } from '../../../platform/numbering/scan-ids'
import { officeContextOf } from '../ledger/access'
import { InsufficientStockError, postMoves, type MoveDraft } from '../ledger/post-moves'
import { lotNumber } from '../receipts/numbers'
import { decOf, differenceReasons, inTransitByLine, invalid, LINE_SELECT, lineMoves, mustManage, refuse, today, visibleTransfer, type LineRowData, type Reader, type TransferRowData } from './store'
import { transferChanged, transferRecord } from './transfers'

/**
 * Receive a transfer at the other site, and settle a difference (B-W2b-326; SCM-219, SCM-220; design warehouse.transfers
 * pop-up "Receive transfer": "received quantity per line; hides scanned one by one; difference reason"; the Received tab's
 * "resolved by"). inventory.transfers.manage at the RECEIVING site; office only (the database refuses a floor session).
 *
 * Receive, ONE command on the transfer's version, per line that arrives now:
 *   1. what the goods arrive as at the receiving site, named on the line first (the trigger compares the TRANSFER_IN with
 *      it): a lot of the receiving site, one per lot sent (a new number from the RECEIVING company's LOT series; its
 *      supplier, dye batch, shade, quality status and Cr VI result copied from the lot sent: the same goods), a hide with a
 *      new tag (the tag is unique in the tenant: the hide is re-tagged at the other site; its area, grade and shade copied);
 *   2. a TRANSFER_OUT off the transit place at the sending site (the sending lot and hide), valued at the sending site;
 *   3. a TRANSFER_IN into the receiving place at the receiving site (the lot and hide made there), valued at what the
 *      TRANSFER_OUT left at (LOT_COST; an item without a cost stays unvalued);
 *   4. the line's received quantity (and its reason when it is short), then the header: RECEIVED once every line arrived in
 *      full or says why not, else PARTLY_RECEIVED.
 * What did not arrive stays on the transit place (the sending site's stock) until it is settled:
 *   ADJUSTMENT / CARRIER_CLAIM   an ADJUSTMENT off the transit place naming the line (valued), with its reason code
 *   SENT_BACK                    the ship of the line reversed (back to its pick place): only while nothing of it arrived
 * then the line's resolution and when, once (the database: a difference is settled once, after its reason).
 */

const SOURCE_LOT = {
  id: true,
  code: true,
  itemColourId: true,
  supplierId: true,
  supplierLotRef: true,
  ownerPartyId: true,
  dyeBatch: true,
  shade: true,
  qualityStatus: true,
  qualityNote: true,
  requiresCrViTest: true,
  crViLimitMgKg: true,
  crViStatus: true,
  crViMgKg: true,
  crViEvidence: true,
  crViTestedAt: true,
  attributes: true,
  variantCode: true,
} as const satisfies Prisma.LotSelect

const SOURCE_HIDE = { id: true, code: true, supplierCode: true, area: true, areaUom: true, baseArea: true, grade: true, gradeId: true, shade: true, shadeGroupId: true, thicknessMm: true, defects: true, state: true } as const satisfies Prisma.HideSelect

interface Entry {
  readonly line: LineRowData
  readonly quantity: Decimal
  readonly place: string | null
  readonly reason: string | null
  readonly note: string | null | undefined
}

function factsOf(row: TransferRowData, lines: readonly LineRowData[], transit: ReadonlyMap<string, Decimal>, places: ReadonlyMap<string, string | null>): ReceiveLineFacts[] {
  return lines.map((line) => ({
    id: line.id,
    seq: line.seq,
    hide: line.hideId !== null,
    shippedQuantity: decOf(line.shippedQuantity),
    receivedQuantity: decOf(line.receivedQuantity),
    inTransit: transit.get(line.id) ?? ZERO,
    differenceReasonCode: line.differenceReasonCode,
    putPlaceId: places.get(line.id) ?? line.toLocationId ?? row.toLocationId,
  }))
}

/** A receiving place named by the request: a place of the receiving site, active, not a transit place. */
async function receivingPlace(client: Reader, siteId: string, locationId: string, index: number): Promise<string> {
  const place = await client.location.findUnique({ where: { id: locationId }, select: { siteId: true, kind: true, status: true } })
  if (!place || place.siteId !== siteId) invalid([{ path: `lines/${index}/toLocationId`, message: 'Not a place of the receiving site.' }])
  if (place!.kind === 'TRANSIT' || place!.status !== 'ACTIVE') refuse([problem('PLACE_NOT_USABLE')])
  return locationId
}

async function checkedEntries(client: Reader, row: TransferRowData, body: ReceiveBody) {
  const lines = await client.transferLine.findMany({ where: { transferId: row.id }, select: LINE_SELECT, orderBy: [{ seq: 'asc' }, { id: 'asc' }] })
  const transit = await inTransitByLine(client, row.transitLocationId, lines.map((line) => line.id))
  const places = new Map<string, string | null>()
  const fields: { path: string; message: string }[] = []
  const quantities: Decimal[] = []
  for (const [index, entry] of body.lines.entries()) {
    if (entry.toLocationId) places.set(entry.lineId, await receivingPlace(client, row.toSiteId, entry.toLocationId, index))
    const quantity = typedQuantity(entry.quantity, true)
    if (quantity === null) fields.push({ path: `lines/${index}/quantity`, message: 'What arrived: 0 or more, at most 4 decimals.' })
    quantities.push(quantity ?? ZERO)
  }
  invalid(fields)
  if (new Set(body.lines.map((entry) => entry.lineId)).size !== body.lines.length) invalid([{ path: 'lines', message: 'Each line once.' }])
  const known = new Set((await differenceReasons(client)).map((reason) => reason.code))
  const checked = receiveProblems(
    row.status as TransferStatus,
    factsOf(row, lines, transit, places),
    body.lines.map((entry, index) => ({ lineId: entry.lineId, quantity: quantities[index]!, differenceReasonCode: entry.differenceReasonCode?.trim() || null })),
    known,
  )
  refuse(checked.refusals)
  invalid(checked.fields)
  const byId = new Map(lines.map((line) => [line.id, line]))
  const entries: Entry[] = body.lines.map((entry, index) => {
    const line = byId.get(entry.lineId)!
    return { line, quantity: quantities[index]!, place: places.get(line.id) ?? line.toLocationId ?? row.toLocationId, reason: entry.differenceReasonCode?.trim() || null, note: entry.differenceNote }
  })
  return { lines, entries }
}

/** The lot the goods of a line arrive as at the receiving site: the line's own, a sibling line's of the same lot, or a new one. */
async function arrivingLot(tools: CommandTools, row: TransferRowData, line: LineRowData, made: Map<string, string>): Promise<string | null> {
  if (!line.lotId) return null
  if (line.toLotId) return line.toLotId
  const known = made.get(line.lotId)
  if (known) return known
  const sibling = await tools.tx.transferLine.findFirst({ where: { transferId: row.id, lotId: line.lotId, toLotId: { not: null } }, select: { toLotId: true } })
  if (sibling?.toLotId) {
    made.set(line.lotId, sibling.toLotId)
    return sibling.toLotId
  }
  const source = await tools.tx.lot.findUniqueOrThrow({ where: { id: line.lotId }, select: SOURCE_LOT })
  const lotId = newId()
  let code: string
  try {
    code = await lotNumber(tools, { companyId: row.toCompanyId, lotId, date: today(tools.now) })
  } catch (error) {
    // receipts/numbers.ts says a missing LOT series in words ("… (lots are numbered from it).").
    if (error instanceof InvalidStateError && error.message.includes('numbered from it')) refuse([problem('NO_LOT_SERIES', `${problem('NO_LOT_SERIES').message} (${error.message})`)])
    throw error
  }
  const decided = source.qualityStatus !== 'QUARANTINE'
  await tools.tx.lot.create({
    data: {
      id: lotId,
      companyId: row.toCompanyId,
      siteId: row.toSiteId,
      itemId: line.itemId,
      itemColourId: source.itemColourId,
      code,
      supplierId: source.supplierId,
      supplierLotRef: source.supplierLotRef,
      ownerPartyId: source.ownerPartyId,
      dyeBatch: source.dyeBatch,
      shade: source.shade,
      receivedAt: tools.now,
      // The same goods: their quality decision and Cr VI evidence travel with them (a blocked or rejected lot never left).
      qualityStatus: source.qualityStatus === 'RELEASED' ? 'RELEASED' : 'QUARANTINE',
      qualityNote: `Arrived by transfer ${row.number} from lot ${source.code}.`,
      qualityDecidedAt: decided && source.qualityStatus === 'RELEASED' ? tools.now : null,
      qualityDecidedById: null,
      requiresCrViTest: source.requiresCrViTest,
      crViLimitMgKg: source.crViLimitMgKg,
      crViStatus: source.crViStatus,
      crViMgKg: source.crViMgKg,
      crViEvidence: source.crViEvidence,
      crViTestedAt: source.crViTestedAt,
      attributes: source.attributes as Prisma.InputJsonValue,
      variantCode: source.variantCode,
      createdAt: tools.now,
      updatedAt: tools.now,
      createdById: tools.context.audience === 'office' ? tools.context.actorId : null,
    },
    select: { id: true },
  })
  tools.audit({ action: 'inventory.lotByTransfer', recordType: 'Lot', recordId: lotId, companyId: row.toCompanyId, siteId: row.toSiteId, after: { code, transferId: row.id, transfer: row.number, fromLotId: source.id, fromLot: source.code, qualityStatus: source.qualityStatus, crViStatus: source.crViStatus } })
  made.set(line.lotId, lotId)
  return lotId
}

/** inventory.transfers.manage at the receiving site: what arrived now, line by line (see the file's comment). */
export async function receiveTransfer(caller: CommandCaller, transferId: string, body: ReceiveBody, idempotencyKey?: string): Promise<TransferView> {
  const context = officeContextOf(caller)
  const before = await caller.withClient(async (client) => {
    const row = await visibleTransfer(client, context, transferId)
    mustManage(context, row, 'to')
    await checkedEntries(client, row, body)
    return row
  })
  const keyBase = `inventory.transfers.receive:${idempotencyKey ?? newId()}`
  await command(caller, { name: 'inventory.transfers.receive', idempotencyKey, input: { transferId, ...body }, record: { type: 'TransferOrder', id: transferId, expectedVersion: body.version } }, async (tools) => {
    const row = await tools.tx.transferOrder.findUniqueOrThrow({ where: { id: transferId }, select: { status: true } })
    const current = { ...before, status: row.status }
    const { entries } = await checkedEntries(tools.tx, current, body)
    const arriving = entries.filter((entry) => !entry.quantity.isZero())
    const lots = new Map<string, string>()
    const hideTags = arriving.filter((entry) => entry.line.hideId && !entry.line.toHideId).length
    const tags = hideTags > 0 ? (await allocateScanIds(tools, 'HIDE', hideTags)).codes : []
    let nextTag = 0
    const named = new Map<string, { toLotId: string | null; toHideId: string | null; toLocationId: string }>()
    for (const entry of arriving) {
      const toLotId = await arrivingLot(tools, current, entry.line, lots)
      let toHideId = entry.line.toHideId
      if (entry.line.hideId && !toHideId) {
        const source = await tools.tx.hide.findUniqueOrThrow({ where: { id: entry.line.hideId }, select: SOURCE_HIDE })
        toHideId = newId()
        const tag = tags[nextTag++]!
        await tools.tx.hide.create({
          data: {
            id: toHideId,
            siteId: current.toSiteId,
            lotId: toLotId!,
            itemId: entry.line.itemId,
            code: tag,
            supplierCode: source.supplierCode,
            area: source.area,
            areaUom: source.areaUom,
            baseArea: source.baseArea,
            grade: source.grade,
            gradeId: source.gradeId,
            shade: source.shade,
            shadeGroupId: source.shadeGroupId,
            thicknessMm: source.thicknessMm,
            defects: source.defects,
            state: source.state === 'PARTLY_CUT' ? 'PARTLY_CUT' : 'FULL',
            createdAt: tools.now,
            updatedAt: tools.now,
            createdById: context.actorId,
          },
          select: { id: true },
        })
        tools.audit({ action: 'inventory.hideByTransfer', recordType: 'Hide', recordId: toHideId, companyId: current.toCompanyId, siteId: current.toSiteId, after: { code: tag, lotId: toLotId, transferId: current.id, transfer: current.number, fromHideId: source.id, fromHide: source.code } })
      }
      named.set(entry.line.id, { toLotId, toHideId, toLocationId: entry.place! })
      // Named on the line before its moves (the TRANSFER_IN is compared with it).
      const data: Prisma.TransferLineUncheckedUpdateInput = {}
      if (toLotId && !entry.line.toLotId) data.toLotId = toLotId
      if (toHideId && !entry.line.toHideId) data.toHideId = toHideId
      if (!entry.line.toLocationId) data.toLocationId = entry.place
      if (Object.keys(data).length > 0) await tools.tx.transferLine.update({ where: { id: entry.line.id }, data: { ...data, version: { increment: 1 } }, select: { id: true } })
    }

    const outs: MoveDraft[] = arriving.map((entry) => ({
      siteId: current.fromSiteId,
      reason: 'TRANSFER_OUT',
      itemId: entry.line.itemId,
      itemColourId: entry.line.itemColourId,
      lotId: entry.line.lotId,
      hideId: entry.line.hideId,
      fromLocationId: current.transitLocationId,
      toLocationId: null,
      quantity: quantityOut(entry.quantity),
      baseQuantity: quantityOut(entry.quantity),
      transferLineId: entry.line.id,
      reference: current.number,
    }))
    try {
      const out = arriving.length > 0 ? await postMoves(tools, outs, { key: `${keyBase}:out`, issuePath: (index) => `lines/${index}` }) : []
      const valuations = out.length > 0 ? await tools.tx.stockValuation.findMany({ where: { moveId: { in: out.map((move) => move.id) } }, select: { moveId: true, unitCost: true } }) : []
      const costOf = new Map(valuations.map((valuation) => [valuation.moveId, valuation.unitCost.toString()]))
      const ins: MoveDraft[] = arriving.map((entry, index) => {
        const target = named.get(entry.line.id)!
        const unitCost = costOf.get(out[index]!.id)
        return {
          siteId: current.toSiteId,
          reason: 'TRANSFER_IN',
          itemId: entry.line.itemId,
          itemColourId: entry.line.itemColourId,
          lotId: target.toLotId,
          hideId: target.toHideId,
          fromLocationId: null,
          toLocationId: target.toLocationId,
          quantity: quantityOut(entry.quantity),
          baseQuantity: quantityOut(entry.quantity),
          transferLineId: entry.line.id,
          reference: current.number,
          cost: unitCost ? { method: 'LOT_COST', unitCost } : null,
        }
      })
      if (ins.length > 0) await postMoves(tools, ins, { key: `${keyBase}:in`, issuePath: (index) => `lines/${index}` })
    } catch (error) {
      if (error instanceof InsufficientStockError) refuse([problem('MORE_THAN_IN_TRANSIT', error.message)])
      throw error
    }

    for (const entry of entries) {
      const data: Prisma.TransferLineUncheckedUpdateInput = {}
      if (!entry.quantity.isZero()) data.receivedQuantity = quantityOut(decOf(entry.line.receivedQuantity).plus(entry.quantity))
      if (entry.reason) data.differenceReasonCode = entry.reason
      if (entry.note !== undefined) data.differenceNote = entry.note?.trim() || null
      if (Object.keys(data).length > 0) await tools.tx.transferLine.update({ where: { id: entry.line.id }, data: { ...data, version: { increment: 1 } }, select: { id: true } })
    }
    const lines = await tools.tx.transferLine.findMany({ where: { transferId }, select: { shippedQuantity: true, receivedQuantity: true, differenceReasonCode: true } })
    const previous = current.status as TransferStatus
    const status = statusAfterReceipt(
      previous,
      lines.map((line) => ({ shippedQuantity: line.shippedQuantity?.toString() ?? null, receivedQuantity: line.receivedQuantity.toString(), differenceReasonCode: line.differenceReasonCode })),
    )
    if (status !== previous) {
      await tools.tx.transferOrder.update({ where: { id: transferId }, data: { status, ...(status === 'RECEIVED' ? { receivedAt: tools.now, receivedById: context.actorId } : {}) }, select: { id: true } })
    }
    tools.audit({
      recordType: 'TransferOrder',
      recordId: transferId,
      companyId: current.companyId,
      siteId: current.fromSiteId,
      before: { status: previous },
      after: {
        status,
        received: entries.map((entry) => ({ lineId: entry.line.id, quantity: quantityOut(entry.quantity), toLocationId: entry.place, ...(entry.reason ? { differenceReasonCode: entry.reason } : {}), ...(named.get(entry.line.id) ?? {}) })),
      },
    })
    transferChanged(tools, current, 'RECEIVED', status, previous, { ddtNumber: current.ddtNumber })
    return { id: transferId, status }
  })
  return transferRecord(caller, transferId)
}

/** inventory.transfers.manage at the receiving site: a short line's difference settled (see the file's comment). */
export async function settleDifference(caller: CommandCaller, transferId: string, lineId: string, body: SettleBody, idempotencyKey?: string): Promise<TransferView> {
  const context = officeContextOf(caller)
  const check = async (client: Reader, row: TransferRowData) => {
    const line = isUuid(lineId) ? await client.transferLine.findFirst({ where: { id: lineId, transferId }, select: LINE_SELECT }) : null
    if (!line) throw new NotFoundError('Line not found.')
    const inTransit = (await inTransitByLine(client, row.transitLocationId, [line.id])).get(line.id) ?? ZERO
    refuse(
      settleProblems(
        { status: row.status as TransferStatus, shipped: line.shippedQuantity !== null, differenceReasonCode: line.differenceReasonCode, resolvedAt: line.resolvedAt ? line.resolvedAt.toISOString() : null, receivedQuantity: decOf(line.receivedQuantity), inTransit },
        body.resolution,
      ),
    )
    return { line, inTransit }
  }
  const before = await caller.withClient(async (client) => {
    const row = await visibleTransfer(client, context, transferId)
    mustManage(context, row, 'to')
    await check(client, row)
    return row
  })
  await command(caller, { name: 'inventory.transfers.settle', idempotencyKey, input: { transferId, lineId, ...body }, record: { type: 'TransferOrder', id: transferId, expectedVersion: body.version } }, async (tools) => {
    const status = (await tools.tx.transferOrder.findUniqueOrThrow({ where: { id: transferId }, select: { status: true } })).status
    const row = { ...before, status }
    const { line, inTransit } = await check(tools.tx, row)
    const words = `Transfer ${row.number}, line ${line.seq}: ${body.resolution === 'SENT_BACK' ? 'sent back' : body.resolution === 'CARRIER_CLAIM' ? 'claimed from the carrier, written off' : 'written off'} (${line.differenceReasonCode}).${body.note?.trim() ? ` ${body.note.trim()}` : ''}`
    let move: MoveDraft
    if (body.resolution === 'SENT_BACK') {
      const ship = (await lineMoves(tools.tx, [line.id])).get(line.id)?.find((one) => one.reason === 'TRANSFER' && one.reversalOfId === null && one.toLocationId === row.transitLocationId)
      if (!ship || !new Dec(ship.baseQuantity.toString()).equals(inTransit)) refuse([problem('SENT_BACK_PART')])
      move = {
        siteId: row.fromSiteId,
        reason: 'TRANSFER',
        itemId: line.itemId,
        itemColourId: line.itemColourId,
        lotId: line.lotId,
        hideId: line.hideId,
        fromLocationId: row.transitLocationId,
        toLocationId: ship!.fromLocationId,
        quantity: quantityOut(inTransit),
        baseQuantity: quantityOut(inTransit),
        transferLineId: line.id,
        reversalOfId: ship!.id,
        reference: row.number,
        note: words,
      }
    } else {
      move = {
        siteId: row.fromSiteId,
        reason: 'ADJUSTMENT',
        itemId: line.itemId,
        itemColourId: line.itemColourId,
        lotId: line.lotId,
        hideId: line.hideId,
        fromLocationId: row.transitLocationId,
        toLocationId: null,
        quantity: quantityOut(inTransit),
        baseQuantity: quantityOut(inTransit),
        transferLineId: line.id,
        reference: row.number,
        note: words,
        reasonCode: line.differenceReasonCode,
      }
    }
    try {
      await postMoves(tools, [move], { key: `inventory.transfers.settle:${line.id}` })
    } catch (error) {
      if (error instanceof InsufficientStockError) refuse([problem('NOTHING_TO_SETTLE', error.message)])
      throw error
    }
    await tools.tx.transferLine.update({ where: { id: line.id }, data: { differenceResolution: body.resolution, resolvedAt: tools.now, resolvedById: context.actorId, version: { increment: 1 } }, select: { id: true } })
    tools.audit({ action: 'inventory.transfers.settle', recordType: 'TransferLine', recordId: line.id, companyId: row.toCompanyId, siteId: row.toSiteId, after: { transferId, seq: line.seq, resolution: body.resolution, quantity: quantityOut(inTransit), differenceReasonCode: line.differenceReasonCode }, ...(body.note?.trim() ? { reason: body.note.trim() } : {}) })
    transferChanged(tools, row, 'SETTLED', status as TransferStatus, status as TransferStatus, { ddtNumber: row.ddtNumber, lineId: line.id, resolution: body.resolution })
    return { id: line.id }
  })
  return transferRecord(caller, transferId)
}
