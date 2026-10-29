import type { Uom } from '@nexus/factory-db'
import { DomainError, ForbiddenError, InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { businessDate, parseInstant } from '@nexus/factory-domain/core/time'
import { quantityText } from '@nexus/factory-domain/inventory/ledger/moves'
import { baseQuantityOf } from '@nexus/factory-domain/inventory/ledger/units'
import { INVENTORY_RECEIVE, INVENTORY_STOCK_VIEW } from '@nexus/factory-domain/inventory/permissions'
import {
  differenceWords,
  dyeBatchNote,
  expectedBaseOf,
  hideAreaUnit,
  hideCountNote,
  hideLineUnit,
  isAreaUnit,
  lineDifference,
  lineShapeProblems,
  lotStart,
  lotStateWords,
  orderStatusAfter,
  RECEIPT_LIMITS,
  receivingProblem,
  thicknessNote,
  unitCostPerBase,
  type LotStart,
  type ReceiptNote,
} from '@nexus/factory-domain/inventory/receipts/rules'
import { Dec, parseDecimal, ZERO, type Decimal } from '@nexus/factory-domain/tax/decimal'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { allocateScanIds } from '../../../platform/numbering/scan-ids'
import { lockOrderForReceipt, setOrderReceiptProgress } from '../../purchasing/receiving'
import { officeContextOf, postedBy, stockContextOf } from '../ledger/access'
import { postMoves, type MoveDraft, type PostedMove } from '../ledger/post-moves'
import { lotNumber, receiptNumber } from './numbers'
import { receiptDetail } from './read'
import { readColours, readEarlierLots, readItems, readOrderLines, RECEIPT_COLUMNS, type ItemRow, type OrderLineRow } from './store'

/**
 * Record a goods receipt against a purchase order (B-W1-32; SCM-113, SCM-116, SCM-117, SCM-187, SCM-232, SCM-233,
 * SCM-247; PLAN §4.7 stage 09a-receive): ONE command() that writes the receipt, its lines, its lots (numbered from the
 * company's LOT series) and hides one by one (tagged with the tenant's HIDE scan ids), posts one RECEIPT move per hide,
 * lot or untracked line through the ledger's postMoves (valued at the order line's price per base unit: the cost
 * grain), posts the receipt and moves the order on (PARTLY_RECEIVED or RECEIVED). The rules are factory-domain
 * inventory/receipts/rules.
 *
 * Lock order: the order's row (its version bump: a cancel or send decided on the version it read fails) → the order's
 * receiving lock (the cancel takes it too) → the number series (numbers.ts: the receipt's GOODS_RECEIPT series, then
 * every lot's LOT series, before any hide tag, as opening stock does) → the tenant's HIDE scan-id counter
 * (allocateScanIds, its `factory.scan-ids` lock) → the ledger (postMoves; a receipt only puts stock in, so it waits for
 * no stock lock).
 *
 * The office records it in W1 (inventory.receive over the order's company and site). `recordReceiptInCommand` is the
 * command's work, for the floor's receiving screen (B-W1-33) once the floor may move the order (its role reads the
 * order only): the floor numbers receipts and lots already (numbers.ts `numberReceipt`); see apps/factory-api/CLAUDE.md
 * and the step notes.
 */

export interface HideBody {
  readonly supplierCode?: string | null | undefined
  readonly area: string
  readonly areaUom?: Uom | undefined
  readonly grade?: string | null | undefined
  readonly shade?: string | null | undefined
  readonly thicknessMm?: string | null | undefined
  readonly defects?: string | null | undefined
}
export interface LotBody {
  readonly supplierLotRef?: string | null | undefined
  readonly dyeBatch?: string | null | undefined
  readonly shade?: string | null | undefined
  readonly quantity?: string | undefined
  readonly baseQuantity?: string | undefined
  readonly holdReason?: string | undefined
  readonly hides?: readonly HideBody[] | undefined
}
export interface LineBody {
  readonly purchaseOrderLineId: string
  readonly quantity?: string | undefined
  readonly uom?: Uom | undefined
  readonly baseQuantity?: string | undefined
  readonly lots?: readonly LotBody[] | undefined
  readonly differenceReason?: string | undefined
  readonly note?: string | null | undefined
}
export interface ReceiptBody {
  readonly purchaseOrderId: string
  readonly locationId?: string | undefined
  readonly supplierDdtNumber?: string | null | undefined
  readonly supplierDdtDate?: string | null | undefined
  readonly receivedAt?: string | undefined
  readonly note?: string | null | undefined
  readonly lines: readonly LineBody[]
}

const blank = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())
const keyFor = (key: string | undefined) => `inventory.receive:${key ?? `g-${newId()}`}`
const unitsOf = (item: ItemRow) => ({ baseUom: item.baseUom, purchaseUom: item.purchaseUom, purchaseFactor: item.purchaseFactor.toString(), consumptionUom: item.consumptionUom, consumptionFactor: item.consumptionFactor.toString() })
/** A receipt may say it came a few minutes "later" than the server's clock (a tablet's), never more. */
const CLOCK_SLACK_MS = 5 * 60 * 1000

/** One hide as it is written: its unit, base area and thickness worked out. */
interface PlannedHide {
  readonly body: HideBody
  readonly areaUom: Uom
  readonly area: string
  readonly baseArea: string
  readonly thicknessMm: string | null
}
interface PlannedLot {
  readonly body: LotBody
  readonly start: LotStart
  readonly quantity: string | null
  readonly baseQuantity: string
  readonly hides: readonly PlannedHide[]
}
interface PlannedLine {
  readonly index: number
  readonly seq: number
  readonly body: LineBody
  readonly orderLine: OrderLineRow
  readonly item: ItemRow
  readonly label: string
  readonly uom: Uom
  readonly quantity: string
  readonly baseQuantity: string
  readonly lots: readonly PlannedLot[]
}

export interface RecordResult {
  readonly receipt: Awaited<ReturnType<typeof receiptDetail>>
  readonly notes: ReceiptNote[]
  readonly moves: PostedMove[]
}

/** POST /inventory/receipts (inventory.receive over the order's company and site; office in W1). */
export async function recordReceipt(caller: CommandCaller, body: ReceiptBody, idempotencyKey?: string): Promise<RecordResult> {
  const context = officeContextOf(caller)
  const order = isUuid(body.purchaseOrderId)
    ? await caller.withClient((client) => client.purchaseOrder.findUnique({ where: { id: body.purchaseOrderId }, select: { companyId: true, siteId: true } }))
    : null
  const actor = actorOf(context)
  const scope = order ? { companyId: order.companyId, siteId: order.siteId } : null
  if (!scope || !(can(actor, INVENTORY_RECEIVE, scope) || can(actor, INVENTORY_STOCK_VIEW, scope))) {
    throw new NotFoundError('Purchase order not found.')
  }
  if (!can(actor, INVENTORY_RECEIVE, scope)) throw new ForbiddenError('Receiving goods at this site needs inventory.receive.')
  const { result } = await command(caller, { name: 'inventory.receive', idempotencyKey, input: body }, (tools) => recordReceiptInCommand(tools, body, keyFor(idempotencyKey)))
  return result
}

/**
 * The receipt's work, INSIDE the caller's command: the order locked, the lines checked against it, the receipt with its
 * lines, lots and hides written, its moves posted and valued, the receipt POSTED, the order moved on, the audit rows and
 * `inventory.receipt_posted`. `key` is the command's (its moves' keys are `<key>:<n>`).
 */
export async function recordReceiptInCommand(tools: CommandTools, body: ReceiptBody, key: string): Promise<RecordResult> {
  const context = stockContextOf({ factoryContext: tools.context, withClient: () => Promise.reject(new Error('inside a command')) })
  if (context.audience === 'floor') {
    // B-W1-33: the floor's role reads the order only (see the step notes). Its numbers are ready: the receipt's and the
    // lots' through numbers.ts (allocateNumber serves a floor command for these kinds), hide tags from the HIDE counter
    // (allocateScanIds online, useScanIds for tags printed offline).
    throw new ForbiddenError('Goods are received on the floor through the floor\'s receiving screen.')
  }
  const { tx, now } = tools
  const by = postedBy(context)

  // 1. The order, locked; may it receive goods now?
  const order = await lockOrderForReceipt(tools, body.purchaseOrderId)
  if (!order) throw new NotFoundError('Purchase order not found.')
  const problem = receivingProblem(order.status)
  if (problem) throw new InvalidStateError(problem)

  // 2. When, and where the goods go.
  const receivedAt = body.receivedAt ? parseInstant(body.receivedAt)! : now
  if (receivedAt.getTime() > now.getTime() + CLOCK_SLACK_MS) throw new ValidationError('The goods cannot arrive in the future.', [{ path: 'body/receivedAt', message: 'Now or earlier.' }])
  const location = await locationFor(tools, order.siteId, body.locationId)

  // 3. The lines against the order's lines, with each material's rules.
  const { lines: orderLines, received } = await readOrderLines(tx, order.id)
  const prices = new Map((await tx.purchaseOrderLine.findMany({ where: { purchaseOrderId: order.id }, select: { id: true, unitPrice: true } })).map((row) => [row.id, row.unitPrice.toString()]))
  const items = await readItems(tx, orderLines.map((line) => line.itemId))
  const colours = await readColours(tx, orderLines.map((line) => line.itemColourId))
  const planned = planLines(body, orderLines, items, colours)
  const moveCount = planned.reduce((sum, line) => sum + (line.lots.length === 0 ? 1 : line.lots.reduce((count, lot) => count + Math.max(1, lot.hides.length), 0)), 0)
  if (moveCount > RECEIPT_LIMITS.moves) {
    throw new ValidationError(`One receipt posts at most ${RECEIPT_LIMITS.moves} hides and lots; this one has ${moveCount}. Split the delivery into two receipts.`, [{ path: 'body/lines', message: `At most ${RECEIPT_LIMITS.moves}.` }])
  }

  // 4. What came against what each order line expects: beyond its tolerance over, the receiver says why.
  const notes: ReceiptNote[] = []
  const refusals: Issue[] = []
  const earlier = await readEarlierLots(tx, planned.map((line) => line.orderLine.id))
  for (const line of planned) {
    const expected = expectedBaseOf({ quantity: line.orderLine.quantity.toString(), baseQuantity: line.orderLine.baseQuantity.toString(), confirmedQuantity: line.orderLine.confirmedQuantity?.toString() ?? null })
    const difference = lineDifference({ expected, receivedBefore: received.get(line.orderLine.id) ?? ZERO, receiving: line.baseQuantity, tolerancePct: line.orderLine.areaTolerancePct?.toString() ?? null })
    const words = differenceWords(line.label, difference, line.item.baseUom)
    if (difference.kind === 'OVER' && !blank(line.body.differenceReason)) {
      refusals.push({ path: `body/lines/${line.index}/differenceReason`, message: `${words} Give the reason the extra is taken, or receive only what was ordered.` })
    }
    if (difference.kind !== 'EXACT') notes.push({ code: difference.kind, seq: line.seq, message: words })
    const before = earlier.get(line.orderLine.id)
    if (line.item.tracking === 'HIDE') {
      const hides = line.lots.reduce((sum, lot) => sum + lot.hides.length, 0)
      const estimate = line.orderLine.estimatedHides === null ? null : Math.max(0, line.orderLine.estimatedHides - (before?.hides ?? 0))
      const count = hideCountNote(line.label, hides, estimate)
      if (count) notes.push({ code: 'HIDE_COUNT', seq: line.seq, message: count })
      const thickness = thicknessNote(
        line.label,
        { min: line.orderLine.thicknessMinMm?.toFixed(2) ?? null, max: line.orderLine.thicknessMaxMm?.toFixed(2) ?? null },
        line.lots.flatMap((lot, lotIndex) => lot.hides.map((hide, hideIndex) => ({ code: hide.body.supplierCode ?? `lot ${lotIndex + 1} hide ${hideIndex + 1}`, thicknessMm: hide.thicknessMm }))),
      )
      if (thickness) notes.push({ code: 'THICKNESS', seq: line.seq, message: thickness })
    }
    const batches = dyeBatchNote(line.label, line.orderLine.oneDyeBatch, [...(before?.dyeBatches ?? []), ...line.lots.map((lot) => lot.body.dyeBatch ?? null)])
    if (batches) notes.push({ code: 'ONE_DYE_BATCH', seq: line.seq, message: batches })
    if (order.currency !== line.item.currency) {
      notes.push({ code: 'NOT_AT_ORDER_PRICE', seq: line.seq, message: `${line.label}: the order is in ${order.currency} and the material is kept in ${line.item.currency}; its stock is valued at the material's own cost, not the order's price.` })
    }
  }
  if (refusals.length > 0) {
    throw new DomainError('conflict', refusals.length === 1 ? refusals[0]!.message : `${refusals.length} lines bring more than their order line's tolerance: give each the reason.`, refusals)
  }
  if (!blank(body.supplierDdtNumber)) notes.unshift({ code: 'NO_SUPPLIER_DDT', seq: null, message: 'No supplier DDT number: add the transport document\'s number and date to the receipt (DPR 472/1996).' })

  // 5. The receipt and its lines.
  const receiptId = newId()
  const number = await receiptNumber(tools, { companyId: order.companyId, receiptId, date: businessDate(receivedAt) })
  await tx.goodsReceipt.create({
    data: {
      id: receiptId,
      companyId: order.companyId,
      siteId: order.siteId,
      number,
      supplierId: order.partyId,
      purchaseOrderId: order.id,
      supplierDdtNumber: blank(body.supplierDdtNumber),
      supplierDdtDate: body.supplierDdtDate ? new Date(`${body.supplierDdtDate}T00:00:00.000Z`) : null,
      receivedAt,
      note: blank(body.note),
      createdAt: now,
      updatedAt: now,
      createdById: by.createdById,
    },
    select: { id: true },
  })
  const lineIds = new Map<number, string>()
  for (const line of planned) {
    const id = newId()
    lineIds.set(line.index, id)
    const reason = blank(line.body.differenceReason)
    await tx.goodsReceiptLine.create({
      data: {
        id,
        siteId: order.siteId,
        receiptId,
        seq: line.seq,
        purchaseOrderLineId: line.orderLine.id,
        itemId: line.item.id,
        itemColourId: line.orderLine.itemColourId,
        quantity: line.quantity,
        uom: line.uom,
        baseQuantity: line.baseQuantity,
        hideCount: line.item.tracking === 'HIDE' ? line.lots.reduce((sum, lot) => sum + lot.hides.length, 0) : null,
        note: [blank(line.body.note), reason ? `Difference from the order: ${reason}` : null].filter(Boolean).join(' · ') || null,
        createdAt: now,
        updatedAt: now,
        createdById: by.createdById,
      },
      select: { id: true },
    })
  }

  // 6. Lots (our numbers) and hides (the tenant's tags), then one RECEIPT move per hide, lot or untracked line.
  // Lot numbers first (the LOT series, before the HIDE counter: the lock order of every receipt and opening line).
  const lotIds = planned.map((line) => line.lots.map(() => newId()))
  const lotCodes = new Map<string, string>()
  for (const lotId of lotIds.flat()) lotCodes.set(lotId, await lotNumber(tools, { companyId: order.companyId, lotId, date: businessDate(receivedAt) }))
  // Hide tags: the tenant's HIDE scan ids, from its tenant-wide counter (one ONLINE block for the receipt's hides).
  const hideCount = planned.reduce((sum, line) => sum + line.lots.reduce((count, lot) => count + lot.hides.length, 0), 0)
  const tags = hideCount > 0 ? (await allocateScanIds(tools, 'HIDE', hideCount)).codes : []
  let nextTag = 0
  const drafts: MoveDraft[] = []
  const lotRows: { id: string; code: string; quarantined: boolean; seq: number; words: string }[] = []
  let hideTotal = 0
  for (const [lineIndex, line] of planned.entries()) {
    const lineId = lineIds.get(line.index)!
    const unitCost = order.currency === line.item.currency ? unitCostPerBase({ unitPrice: prices.get(line.orderLine.id) ?? '0', quantity: line.orderLine.quantity.toString(), baseQuantity: line.orderLine.baseQuantity.toString() }) : null
    const move = (fields: Pick<MoveDraft, 'lotId' | 'hideId' | 'quantity' | 'uom' | 'baseQuantity'>): MoveDraft => ({
      siteId: order.siteId,
      reason: 'RECEIPT',
      itemId: line.item.id,
      itemColourId: line.orderLine.itemColourId,
      toLocationId: location.id,
      receiptLineId: lineId,
      reference: blank(body.supplierDdtNumber) ?? number,
      occurredAt: receivedAt,
      cost: unitCost ? { method: 'PURCHASE_PRICE', unitCost } : null,
      ...fields,
    })
    if (line.lots.length === 0) {
      drafts.push(move({ lotId: null, hideId: null, quantity: line.quantity, uom: line.uom, baseQuantity: line.baseQuantity }))
      continue
    }
    for (const [lotIndex, lot] of line.lots.entries()) {
      const lotId = lotIds[lineIndex]![lotIndex]!
      const code = lotCodes.get(lotId)!
      const shade = blank(lot.body.shade)
      const hold = blank(lot.body.holdReason)
      const released = lot.start.qualityStatus === 'RELEASED'
      await tx.lot.create({
        data: {
          id: lotId,
          companyId: order.companyId,
          siteId: order.siteId,
          itemId: line.item.id,
          itemColourId: line.orderLine.itemColourId,
          code,
          supplierId: order.partyId,
          supplierLotRef: blank(lot.body.supplierLotRef),
          dyeBatch: blank(lot.body.dyeBatch),
          shade,
          receiptLineId: lineId,
          receivedAt,
          qualityStatus: lot.start.qualityStatus,
          qualityNote: released ? 'Released at receipt: no chromium VI test, certificate check or quality hold needed.' : hold,
          qualityDecidedAt: released ? now : null,
          qualityDecidedById: released ? by.createdById : null,
          requiresCrViTest: lot.start.requiresCrViTest,
          crViLimitMgKg: lot.start.crViLimitMgKg,
          crViStatus: lot.start.crViStatus,
          createdAt: now,
          updatedAt: now,
          createdById: by.createdById,
        },
        select: { id: true },
      })
      const words = lotStateWords({ qualityStatus: lot.start.qualityStatus, requiresCrViTest: lot.start.requiresCrViTest, crViStatus: lot.start.crViStatus, crViLimitMgKg: lot.start.crViLimitMgKg, holdNote: hold, isPpeComponent: line.item.isPpeComponent })
      lotRows.push({ id: lotId, code, quarantined: !released, seq: line.seq, words })
      tools.audit({
        action: 'inventory.lotReceived',
        recordType: 'Lot',
        recordId: lotId,
        companyId: order.companyId,
        siteId: order.siteId,
        after: { code, receiptId, receiptLineId: lineId, itemId: line.item.id, itemColourId: line.orderLine.itemColourId, supplierLotRef: blank(lot.body.supplierLotRef), dyeBatch: blank(lot.body.dyeBatch), shade, ...lot.start },
        ...(hold ? { reason: hold } : {}),
      })
      if (lot.hides.length === 0) {
        drafts.push(move({ lotId, hideId: null, quantity: lot.quantity!, uom: line.uom, baseQuantity: lot.baseQuantity }))
        continue
      }
      for (const hide of lot.hides) {
        const hideId = newId()
        const tag = tags[nextTag++]!
        await tx.hide.create({
          data: {
            id: hideId,
            siteId: order.siteId,
            lotId,
            itemId: line.item.id,
            code: tag,
            supplierCode: blank(hide.body.supplierCode),
            area: hide.area,
            areaUom: hide.areaUom,
            baseArea: hide.baseArea,
            grade: blank(hide.body.grade),
            shade: blank(hide.body.shade) ?? shade,
            thicknessMm: hide.thicknessMm,
            defects: blank(hide.body.defects),
            createdAt: now,
            updatedAt: now,
            createdById: by.createdById,
          },
          select: { id: true },
        })
        hideTotal += 1
        tools.audit({
          action: 'inventory.hideReceived',
          recordType: 'Hide',
          recordId: hideId,
          companyId: order.companyId,
          siteId: order.siteId,
          after: { code: tag, lotId, supplierCode: blank(hide.body.supplierCode), area: hide.area, areaUom: hide.areaUom, baseArea: hide.baseArea, grade: blank(hide.body.grade), thicknessMm: hide.thicknessMm },
        })
        drafts.push(move({ lotId, hideId, quantity: hide.area, uom: hide.areaUom, baseQuantity: hide.baseArea }))
      }
    }
  }
  const moves = await postMoves(tools, drafts, { key, issuePath: (index) => `body/moves/${index}` })

  // 7. Posted: the ledger now holds exactly its lines (the deferred check at commit); the order moves on.
  await tx.goodsReceipt.update({ where: { id: receiptId }, data: { status: 'POSTED', postedAt: now, postedById: by.createdById }, select: { id: true } })
  const after = await readOrderLines(tx, order.id)
  const to = orderStatusAfter(
    { status: order.status, confirmed: order.confirmed },
    after.lines.map((line) => ({
      expected: expectedBaseOf({ quantity: line.quantity.toString(), baseQuantity: line.baseQuantity.toString(), confirmedQuantity: line.confirmedQuantity?.toString() ?? null }),
      received: after.received.get(line.id) ?? ZERO,
      tolerancePct: line.areaTolerancePct?.toString() ?? null,
    })),
  )
  await setOrderReceiptProgress(tools, order, to, { id: receiptId, number, reversed: false })
  for (const lot of lotRows.filter((entry) => entry.quarantined)) notes.push({ code: 'QUARANTINE', seq: lot.seq, message: `Lot ${lot.code}: ${lot.words}` })

  tools.audit({
    action: 'inventory.receive',
    recordType: 'GoodsReceipt',
    recordId: receiptId,
    companyId: order.companyId,
    siteId: order.siteId,
    after: {
      number,
      status: 'POSTED',
      purchaseOrderId: order.id,
      purchaseOrderStatus: to,
      supplierDdtNumber: blank(body.supplierDdtNumber),
      receivedAt: receivedAt.toISOString(),
      locationId: location.id,
      lines: planned.map((line) => ({ seq: line.seq, purchaseOrderLineId: line.orderLine.id, quantity: line.quantity, uom: line.uom, baseQuantity: line.baseQuantity })),
      lotIds: lotRows.map((lot) => lot.id),
      hides: hideTotal,
    },
    ...(planned.some((line) => blank(line.body.differenceReason)) ? { reason: planned.map((line) => blank(line.body.differenceReason)).filter(Boolean).join(' · ') } : {}),
  })
  tools.emit({
    type: 'inventory.receipt_posted',
    subject: receiptId,
    companyId: order.companyId,
    siteId: order.siteId,
    payload: {
      receiptId,
      number,
      purchaseOrderId: order.id,
      purchaseOrderStatus: to,
      lotIds: lotRows.map((lot) => lot.id),
      quarantinedLotIds: lotRows.filter((lot) => lot.quarantined).map((lot) => lot.id),
      hides: hideTotal,
      moveIds: moves.map((posted) => posted.id),
      postedBy: by.audience,
    },
  })
  const receipt = (await tx.goodsReceipt.findUnique({ where: { id: receiptId }, select: RECEIPT_COLUMNS }))!
  return { receipt: await receiptDetail(tx, tools.context, receipt), notes, moves }
}

/** The location the goods go to: the one named (of the order's site, active), else the site's one goods-in dock. */
async function locationFor(tools: CommandTools, siteId: string, locationId: string | undefined): Promise<{ id: string; code: string }> {
  if (locationId) {
    const location = isUuid(locationId) ? await tools.tx.location.findUnique({ where: { id: locationId }, select: { id: true, siteId: true, code: true, status: true } }) : null
    if (!location || location.siteId !== siteId) throw new ValidationError('That is not a location of the order\'s delivery site.', [{ path: 'body/locationId', message: 'A location of the delivery site.' }])
    if (location.status !== 'ACTIVE') throw new ValidationError(`Location ${location.code} is ${location.status.toLowerCase()}: it takes no stock.`, [{ path: 'body/locationId', message: 'An active location.' }])
    return location
  }
  const docks = await tools.tx.location.findMany({ where: { siteId, kind: 'RECEIVING', status: 'ACTIVE' }, select: { id: true, code: true }, orderBy: { code: 'asc' }, take: 2 })
  if (docks.length !== 1) {
    throw new ValidationError(docks.length === 0 ? 'The delivery site has no goods-in dock: name the location the goods go to.' : 'The delivery site has several goods-in docks: name the one the goods go to.', [{ path: 'body/locationId', message: 'Name the location.' }])
  }
  return docks[0]!
}

/**
 * Every line of the body against the order's lines and its material's tracking, with the units and base quantities
 * worked out (factory-domain units). All problems at once: a 400 with each path.
 */
function planLines(body: ReceiptBody, orderLines: readonly OrderLineRow[], items: Map<string, ItemRow>, colours: Map<string, { code: string }>): PlannedLine[] {
  const problems: Issue[] = []
  const seen = new Set<string>()
  const planned: PlannedLine[] = []
  body.lines.forEach((line, index) => {
    const at = `body/lines/${index}`
    const orderLine = orderLines.find((entry) => entry.id === line.purchaseOrderLineId)
    if (!orderLine) {
      problems.push({ path: `${at}/purchaseOrderLineId`, message: 'Not a line of this purchase order.' })
      return
    }
    if (seen.has(orderLine.id)) {
      problems.push({ path: `${at}/purchaseOrderLineId`, message: `Order line ${orderLine.seq} is on the receipt already: put all its lots on one line.` })
      return
    }
    seen.add(orderLine.id)
    const item = items.get(orderLine.itemId)!
    const colour = orderLine.itemColourId ? colours.get(orderLine.itemColourId) : undefined
    const label = `Line ${(index + 1) * 10} (${item.code}${colour ? ` ${colour.code}` : ''})`
    const shape = lineShapeProblems(line, item.tracking, item.code)
    if (shape.length > 0) {
      problems.push(...shape.map((issue) => ({ path: `${at}/${issue.path}`, message: issue.message })))
      return
    }
    const units = unitsOf(item)
    const base = (quantity: string, uom: Uom, baseQuantity: string | undefined, path: string): string | null => {
      const result = baseQuantityOf({ quantity, uom, baseQuantity: baseQuantity ?? null }, units)
      if (result.problem) {
        problems.push({ path: `${path}/${result.problem.path}`, message: result.problem.message })
        return null
      }
      return quantityText(result.baseQuantity)
    }
    const startOf = (lot: LotBody) =>
      lotStart({
        itemRequiresCrViTest: item.requiresCrViTest,
        itemCrViLimitMgKg: item.crViLimitMgKg?.toString() ?? null,
        lineRequiresCrViTest: orderLine.requiresCrViTest,
        isPpeComponent: item.isPpeComponent,
        holdReason: lot.holdReason ?? null,
      })
    const seq = (index + 1) * 10
    if (item.tracking === 'HIDE') {
      const lots: PlannedLot[] = (line.lots ?? []).map((lot, lotIndex) => {
        const hides = (lot.hides ?? []).flatMap((hide, hideIndex): PlannedHide[] => {
          const path = `${at}/lots/${lotIndex}/hides/${hideIndex}`
          const areaUom = hideAreaUnit(hide, orderLine.uom, item.baseUom)
          if (!isAreaUnit(areaUom)) {
            problems.push({ path: `${path}/areaUom`, message: 'Give the unit the hide is measured in: m², dm² or ft².' })
            return []
          }
          const baseArea = base(hide.area, areaUom, undefined, path)
          if (baseArea === null) return []
          const thickness = blank(hide.thicknessMm) === null ? null : parseDecimal(hide.thicknessMm!)
          return [{ body: hide, areaUom, area: quantityText(hide.area), baseArea, thicknessMm: thickness === null ? null : thickness.toFixed(2) }]
        })
        return { body: lot, start: startOf(lot), quantity: null, baseQuantity: quantityText(sum(hides.map((hide) => hide.baseArea))), hides }
      })
      // The line is in the unit its hides share (else the base unit): its quantity their sum in it.
      const all = lots.flatMap((lot) => lot.hides)
      const uom = hideLineUnit(all.map((hide) => hide.areaUom), item.baseUom)
      const baseQuantity = quantityText(sum(all.map((hide) => hide.baseArea)))
      const quantity = all.every((hide) => hide.areaUom === uom) ? quantityText(sum(all.map((hide) => hide.area))) : baseQuantity
      planned.push({ index, seq, body: line, orderLine, item, label, uom, quantity, baseQuantity, lots })
    } else if (item.tracking === 'LOT') {
      const uom = line.uom ?? orderLine.uom
      const lots = (line.lots ?? []).flatMap((lot, lotIndex): PlannedLot[] => {
        const baseQuantity = base(lot.quantity!, uom, lot.baseQuantity, `${at}/lots/${lotIndex}`)
        return baseQuantity === null ? [] : [{ body: lot, start: startOf(lot), quantity: quantityText(lot.quantity!), baseQuantity, hides: [] }]
      })
      planned.push({ index, seq, body: line, orderLine, item, label, uom, quantity: quantityText(sum(lots.map((lot) => lot.quantity!))), baseQuantity: quantityText(sum(lots.map((lot) => lot.baseQuantity))), lots })
    } else {
      const uom = line.uom ?? orderLine.uom
      const baseQuantity = base(line.quantity!, uom, line.baseQuantity, at)
      if (baseQuantity !== null) planned.push({ index, seq, body: line, orderLine, item, label, uom, quantity: quantityText(line.quantity!), baseQuantity, lots: [] })
    }
  })
  if (problems.length > 0) throw new ValidationError(problems.length === 1 ? problems[0]!.message : 'The receipt\'s lines break the receiving rules.', problems)
  return planned
}

const sum = (values: readonly string[]): Decimal => values.reduce((total, value) => total.plus(new Dec(value)), ZERO)
