import { ForbiddenError, NotFoundError, UnauthenticatedError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { SALES_RETURNS_INSPECT, SALES_RETURNS_RECEIVE } from '@nexus/factory-domain/sales/returns/permissions'
import {
  DECIDING_STATUSES,
  isSafetyReturn,
  PARCEL_CONDITIONS,
  RECEIVING_STATUSES,
  restockHeldWords,
  RETURN_LIMITS,
  RETURN_REASON_LIST,
  suggestedOutcome,
  type ParcelCondition,
  type ReturnCause,
  type ReturnGrade,
  type ReturnStatus,
} from '@nexus/factory-domain/sales/returns/rules'
import { command, type CommandCaller } from '../../../core/command'
import { actorOf, type FloorContext, type OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { reasonWords } from '../../../platform/reasons/service'
import { asTenantSystem } from '../../production/bundles/codes'
import { defaultPlaceOf, finishedPlaces } from '../../inventory/finished/post'
import { actorIdOf, dockReturn } from './access'
import { lockReturn, touchReturn } from './rma'
import { asDay, FLOOR_LINE_COLUMNS, FLOOR_RMA_COLUMNS, lineKeyOf, lineMoves, LINE_RECORD, photoCounts, RECEIPT_COLUMNS, RECEIPT_RECORD, soldFactsOf, type FloorRmaRow, type Reader } from './store'

/**
 * The dock (B-W2a-43; LOG-114 "Receive a return at the dock", QHS-117 "Return inspection and grading"; design
 * floor.returnsin SCR-180 for B-W2a-76, and the office's rma.lines "Received qty" / rma.inspection). The same routes for
 * the office and the dock's tablet (the floor at its own site only; it reads no price, discount, credit or internal note
 * and writes only what the …_sales_w2a_guards triggers let the floor write):
 *
 *   find     GET /sales/returns/dock?code=   the open RMA (AUTHORISED, RECEIVED, INSPECTED) a scanned or typed number
 *                                            names, at the device's site; else 404 in the design's words
 *   read     GET /sales/returns/:id/dock     what the dock needs: the lines expected and received, their grade, the
 *                                            suggested outcome, where the goods go, the receipts, the site's places
 *   receive  POST /sales/returns/:id/receipts  ONE command: the RMA row locked at the version read (AUTHORISED, RECEIVED
 *                                            or INSPECTED), the receipt (parcels, condition, carrier, the customer's DDT),
 *                                            each line's pieces (never more than it still expects; a graded line takes
 *                                            no more: split lines on a partial receipt are W2b, SAL-350), the RMA →
 *                                            RECEIVED (first time: receivedAt; from INSPECTED: more goods came)
 *   grade    POST /sales/returns/:id/grades    ONE command: received lines graded (grade, cause, condition); a decided line
 *                                            keeps its grade
 *
 * The photos of a receipt and of a line are photos.ts. The worker who receives or grades is the command's actor (the
 * audit row and the line's inspector, inside the one record only; never in a list).
 */

const NOT_OPEN = 'No open return with this code. Put the parcel aside and tell customer service.'

function dockContext(caller: CommandCaller): OfficeContext | FloorContext {
  const context = caller.factoryContext
  if (!context) throw new UnauthenticatedError()
  if (context.audience !== 'office' && context.audience !== 'floor') throw new ForbiddenError()
  return context
}

/** The site's places the dock names: where goods wait for the inspection, the finished goods' place, the quarantine. */
async function placesOf(db: Reader, siteId: string) {
  const rows = await db.location.findMany({ where: { siteId, status: 'ACTIVE', kind: { in: ['QUARANTINE', 'RECEIVING'] } }, select: { id: true, code: true, name: true, kind: true }, orderBy: { code: 'asc' } })
  const quarantine = rows.filter((row) => row.kind === 'QUARANTINE')
  const finished = defaultPlaceOf(await finishedPlaces(db, siteId))
  const place = (row: { id: string; code: string; name: string } | null | undefined) => (row ? { id: row.id, code: row.code, name: row.name } : null)
  return {
    inspection: place(quarantine[0] ?? rows.find((row) => row.kind === 'RECEIVING')),
    quarantine: place(quarantine.length === 1 ? quarantine[0] : null),
    finishedGoods: place(finished),
  }
}

/** What the dock shows of the garments each line names: style, colourway, whether it is PPE (never a price). */
type Garments = Map<string, { readonly style: { readonly code: string; readonly name: string } | null; readonly colourway: { readonly code: string; readonly name: string } | null; readonly ppe: boolean }>

async function garmentsOf(db: Reader, returnId: string): Promise<Garments> {
  const lines = await db.returnLine.findMany({ where: { returnId }, select: { id: true, salesOrderLineId: true, invoiceLineId: true } })
  const sold = await soldFactsOf(db, lines)
  return new Map(
    lines.map((line) => {
      const facts = sold.get(lineKeyOf(line))
      return [line.id, { style: facts?.style ? { code: facts.style.code, name: facts.style.name } : null, colourway: facts?.colourway ? { code: facts.colourway.code, name: facts.colourway.name } : null, ppe: facts?.style?.ppe ?? false }] as const
    }),
  )
}

/**
 * The dock's view of one RMA. The floor reads no sales order or invoice (its role has no grant on them): the garments'
 * style and colourway come from the tenant's system scope, for this RMA's lines only (as receiving reads the supplier's
 * name), and never a price.
 */
async function dockOf(caller: CommandCaller, returnId: string): Promise<DockView> {
  const context = dockContext(caller)
  const garments = await (context.audience === 'floor' ? asTenantSystem(caller, context) : caller).withClient((client) => garmentsOf(client, returnId))
  return caller.withClient(async (client) => {
    const rma = await client.returnAuthorisation.findUnique({ where: { id: returnId }, select: FLOOR_RMA_COLUMNS })
    if (!rma) throw new NotFoundError('Return not found.')
    return dockView(client, rma, garments)
  })
}

async function dockView(db: Reader, rma: FloorRmaRow, garments: Garments) {
  const lines = await db.returnLine.findMany({ where: { returnId: rma.id }, select: FLOOR_LINE_COLUMNS, orderBy: { seq: 'asc' } })
  const receipts = await db.returnReceipt.findMany({ where: { returnId: rma.id }, select: RECEIPT_COLUMNS, orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }] })
  const reasons = await reasonWords(db, RETURN_REASON_LIST)
  const linePhotos = await photoCounts(db, LINE_RECORD, lines.map((line) => line.id))
  const receiptPhotos = await photoCounts(db, RECEIPT_RECORD, receipts.map((receipt) => receipt.id))
  const moves = await lineMoves(db, lines.map((line) => line.id))
  const places = await placesOf(db, rma.siteId)
  const site = await db.site.findUnique({ where: { id: rma.siteId }, select: { id: true, code: true, name: true } })
  return {
    id: rma.id,
    number: rma.number,
    siteId: rma.siteId,
    site,
    customerRef: rma.customerRef,
    status: rma.status,
    goodsDueBy: rma.goodsDueBy ? rma.goodsDueBy.toISOString().slice(0, 10) : null,
    receivedAt: rma.receivedAt ? toUtcIso(rma.receivedAt) : null,
    lines: lines.map((line) => {
      const garment = garments.get(line.id)
      const ppe = garment?.ppe ?? false
      const reason = reasons.get(line.reasonCode)
      const graded = line.grade ? { grade: line.grade as ReturnGrade, cause: line.cause as ReturnCause | null, ppe, reasonCode: line.reasonCode } : null
      const stock = moves.get(line.id) ?? []
      return {
        id: line.id,
        seq: line.seq,
        description: line.description,
        style: garment?.style ?? null,
        colourway: garment?.colourway ?? null,
        size: line.size,
        serial: line.serial,
        batchNumber: line.batchNumber,
        ppe,
        safety: isSafetyReturn({ ppe, reasonCode: line.reasonCode, cause: line.cause as ReturnCause | null }),
        reasonCode: line.reasonCode,
        reason: reason ? { labelIt: reason.labelIt, labelEn: reason.labelEn } : null,
        reasonNote: line.reasonNote,
        quantity: line.quantity,
        receivedQuantity: line.receivedQuantity,
        expected: line.quantity - line.receivedQuantity,
        grade: line.grade,
        cause: line.cause,
        conditionNote: line.conditionNote,
        photos: linePhotos.get(line.id) ?? 0,
        suggestedOutcome: graded ? suggestedOutcome(graded) : null,
        restockHeld: graded ? restockHeldWords(graded) : null,
        disposition: line.disposition,
        goodsOutcome: line.goodsOutcome,
        /** Where the goods go: the decided outcome's place, else (received) the inspection place. */
        place: stock[0]?.locationCode ?? (line.receivedQuantity > 0 && line.disposition === null ? (places.inspection?.code ?? null) : null),
        version: line.version,
      }
    }),
    receipts: receipts.map((receipt) => ({ id: receipt.id, receivedAt: toUtcIso(receipt.receivedAt), parcels: receipt.parcels, parcelCondition: receipt.parcelCondition, customerDdtNumber: receipt.customerDdtNumber, photos: receiptPhotos.get(receipt.id) ?? 0 })),
    places,
    version: rma.version,
  }
}

export type DockView = Awaited<ReturnType<typeof dockView>>

/** GET /sales/returns/dock?code=: the open RMA a number names (the floor: at its own site). */
export async function findAtDock(caller: CommandCaller, code: string): Promise<{ return: DockView }> {
  const context = dockContext(caller)
  const number = code.trim()
  if (number === '' || number.length > 60) throw new ValidationError('Scan or type the return number.', [{ path: 'querystring/code', message: 'The RMA number from its sheet or box label.' }])
  return caller.withClient(async (client) => {
    const scope = scopeWhere(actorOf(context), SALES_RETURNS_RECEIVE, { company: 'companyId', site: 'siteId', party: 'partyId' })
    const rows = await client.returnAuthorisation.findMany({
      where: { AND: [scope, { number: { equals: number, mode: 'insensitive' } }, { status: { in: [...RECEIVING_STATUSES] } }, context.audience === 'floor' ? { siteId: context.siteId } : {}] },
      select: FLOOR_RMA_COLUMNS,
      take: 2,
    })
    if (rows.length !== 1) throw new NotFoundError(NOT_OPEN)
    return rows[0]!.id
  }).then(async (id) => ({ return: await dockOf(caller, id) }))
}

/** GET /sales/returns/:returnId/dock */
export async function getDock(caller: CommandCaller, returnId: string): Promise<{ return: DockView }> {
  const { rma } = await dockReturn(caller, returnId, SALES_RETURNS_RECEIVE)
  return { return: await dockOf(caller, rma.id) }
}

// ---- receive --------------------------------------------------------------------------------------------------------

export interface ReceiptBody {
  readonly version: number
  readonly parcels: number
  readonly parcelCondition: ParcelCondition
  readonly carrierName?: string | null | undefined
  readonly trackingNumber?: string | null | undefined
  readonly customerDdtNumber?: string | null | undefined
  readonly customerDdtDate?: BusinessDate | null | undefined
  readonly note?: string | null | undefined
  readonly lines: readonly { readonly lineId: string; readonly quantity: number }[]
}

const blank = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())
const tooLong = (value: string | null | undefined, max: number): boolean => (value ?? '').trim().length > max

function refuse(problems: readonly Issue[], words: string): never {
  throw new ValidationError(problems.length === 1 ? problems[0]!.message : words, problems)
}

export async function receiveReturn(caller: CommandCaller, returnId: string, body: ReceiptBody, idempotencyKey?: string): Promise<{ return: DockView; receiptId: string }> {
  const context = dockContext(caller)
  const { rma: seen } = await dockReturn(caller, returnId, SALES_RETURNS_RECEIVE)
  const problems: Issue[] = []
  if (!Number.isInteger(body.parcels) || body.parcels < 1 || body.parcels > RETURN_LIMITS.parcels) problems.push({ path: 'body/parcels', message: `1 to ${RETURN_LIMITS.parcels} parcels.` })
  if (!PARCEL_CONDITIONS.includes(body.parcelCondition)) problems.push({ path: 'body/parcelCondition', message: 'Box fine, box damaged or opened.' })
  if (tooLong(body.carrierName, RETURN_LIMITS.carrierName)) problems.push({ path: 'body/carrierName', message: `At most ${RETURN_LIMITS.carrierName} characters.` })
  if (tooLong(body.trackingNumber, RETURN_LIMITS.trackingNumber)) problems.push({ path: 'body/trackingNumber', message: `At most ${RETURN_LIMITS.trackingNumber} characters.` })
  if (tooLong(body.customerDdtNumber, RETURN_LIMITS.ddtNumber)) problems.push({ path: 'body/customerDdtNumber', message: `At most ${RETURN_LIMITS.ddtNumber} characters.` })
  if (tooLong(body.note, RETURN_LIMITS.receiptNote)) problems.push({ path: 'body/note', message: `At most ${RETURN_LIMITS.receiptNote} characters.` })
  if (body.customerDdtDate && body.customerDdtDate > businessDate(serverClock.now())) problems.push({ path: 'body/customerDdtDate', message: 'The DDT is dated today or earlier.' })
  if (body.customerDdtDate && !blank(body.customerDdtNumber)) problems.push({ path: 'body/customerDdtNumber', message: "The customer's DDT number, with its date." })
  if (body.lines.length === 0) problems.push({ path: 'body/lines', message: 'Receive at least one piece: scan or pick the lines that came.' })
  if (problems.length > 0) refuse(problems, 'The receipt is not valid.')
  const { result } = await command(caller, { name: 'returns.receive', idempotencyKey, input: { returnId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const rma = await lockReturn(tools, seen.id, body.version, RECEIVING_STATUSES, 'goods are received')
    const lines = await tx.returnLine.findMany({ where: { returnId: rma.id }, select: FLOOR_LINE_COLUMNS, orderBy: { seq: 'asc' } })
    const byId = new Map(lines.map((line) => [line.id, line]))
    const seenLines = new Set<string>()
    const lineProblems: Issue[] = []
    for (const [index, entry] of body.lines.entries()) {
      const line = byId.get(entry.lineId)
      const at = `body/lines/${index}`
      if (!line) lineProblems.push({ path: `${at}/lineId`, message: 'Not a line of this return.' })
      else if (seenLines.has(line.id)) lineProblems.push({ path: `${at}/lineId`, message: `Line ${line.seq} is named twice.` })
      else if (line.grade !== null) lineProblems.push({ path: `${at}/lineId`, message: `Line ${line.seq} is graded already: what else comes of it goes on a new return.` })
      else if (!Number.isInteger(entry.quantity) || entry.quantity < 1) lineProblems.push({ path: `${at}/quantity`, message: 'One piece or more.' })
      else if (entry.quantity > line.quantity - line.receivedQuantity) lineProblems.push({ path: `${at}/quantity`, message: line.quantity === line.receivedQuantity ? `Every piece of line ${line.seq} arrived already.` : `Line ${line.seq} still expects ${line.quantity - line.receivedQuantity} of ${line.quantity}.` })
      if (line) seenLines.add(line.id)
    }
    if (lineProblems.length > 0) refuse(lineProblems, 'Some lines cannot be received like this.')
    const receiptId = newId()
    const actorId = actorIdOf(context)
    await tx.returnReceipt.create({
      data: {
        id: receiptId,
        siteId: rma.siteId,
        returnId: rma.id,
        receivedAt: now,
        parcels: body.parcels,
        parcelCondition: body.parcelCondition,
        carrierName: blank(body.carrierName),
        trackingNumber: blank(body.trackingNumber),
        customerDdtNumber: blank(body.customerDdtNumber),
        customerDdtDate: body.customerDdtDate ? asDay(body.customerDdtDate) : null,
        note: blank(body.note),
        requestId: context.requestId,
        createdAt: now,
        createdById: actorId,
      },
      select: { id: true },
    })
    tools.audit({ recordType: 'ReturnReceipt', recordId: receiptId, companyId: rma.companyId, siteId: rma.siteId, after: { returnId: rma.id, parcels: body.parcels, parcelCondition: body.parcelCondition, carrierName: blank(body.carrierName), trackingNumber: blank(body.trackingNumber), customerDdtNumber: blank(body.customerDdtNumber), customerDdtDate: body.customerDdtDate ?? null, lines: body.lines.map((entry) => ({ lineId: entry.lineId, quantity: entry.quantity })) } })
    let pieces = 0
    for (const entry of body.lines) {
      const line = byId.get(entry.lineId)!
      const received = line.receivedQuantity + entry.quantity
      pieces += entry.quantity
      await tx.returnLine.update({ where: { id: line.id }, data: { receivedQuantity: received, receivedAt: line.receivedAt ?? now, receiptId, updatedAt: now, version: { increment: 1 } }, select: { id: true } })
      tools.audit({ action: 'returns.receiveLine', recordType: 'ReturnLine', recordId: line.id, companyId: rma.companyId, siteId: rma.siteId, before: { receivedQuantity: line.receivedQuantity }, after: { receivedQuantity: received, receiptId } })
    }
    const first = rma.receivedAt === null
    const to: ReturnStatus = 'RECEIVED'
    const moved = rma.status !== to
    await touchReturn(tools, rma, { ...(moved ? { status: to } : {}), ...(first ? { receivedAt: now } : {}), ...(rma.status === 'INSPECTED' ? { inspectedAt: null } : {}) })
    if (moved) {
      tools.audit({ action: 'returns.statusChanged', recordType: 'ReturnAuthorisation', recordId: rma.id, companyId: rma.companyId, siteId: rma.siteId, before: { status: rma.status }, after: { status: to, ...(first ? { receivedAt: toUtcIso(now) } : {}) } })
      tools.emit({ type: 'return.status_changed', subject: rma.id, companyId: rma.companyId, siteId: rma.siteId, payload: { returnId: rma.id, number: rma.number, from: rma.status as ReturnStatus, to } })
    }
    tools.emit({ type: 'return.received', subject: rma.id, companyId: rma.companyId, siteId: rma.siteId, payload: { returnId: rma.id, number: rma.number, receiptId, lineIds: body.lines.map((entry) => entry.lineId), pieces, first } })
    return { receiptId }
  })
  return { return: await dockOf(caller, seen.id), receiptId: result.receiptId }
}

// ---- grade ----------------------------------------------------------------------------------------------------------

export interface GradesBody {
  readonly version: number
  readonly lines: readonly { readonly lineId: string; readonly grade: ReturnGrade; readonly cause?: ReturnCause | null | undefined; readonly conditionNote?: string | null | undefined }[]
}

export async function gradeReturn(caller: CommandCaller, returnId: string, body: GradesBody, idempotencyKey?: string): Promise<{ return: DockView }> {
  const context = dockContext(caller)
  const { rma: seen } = await dockReturn(caller, returnId, SALES_RETURNS_INSPECT)
  if (body.lines.length === 0) refuse([{ path: 'body/lines', message: 'Grade at least one line.' }], 'Nothing to grade.')
  await command(caller, { name: 'returns.grade', idempotencyKey, input: { returnId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const rma = await lockReturn(tools, seen.id, body.version, DECIDING_STATUSES, 'lines are graded')
    const lines = await tx.returnLine.findMany({ where: { returnId: rma.id }, select: FLOOR_LINE_COLUMNS })
    const byId = new Map(lines.map((line) => [line.id, line]))
    const problems: Issue[] = []
    const seenLines = new Set<string>()
    for (const [index, entry] of body.lines.entries()) {
      const line = byId.get(entry.lineId)
      const at = `body/lines/${index}`
      if (!line) problems.push({ path: `${at}/lineId`, message: 'Not a line of this return.' })
      else if (seenLines.has(line.id)) problems.push({ path: `${at}/lineId`, message: `Line ${line.seq} is named twice.` })
      else if (line.receivedQuantity === 0) problems.push({ path: `${at}/lineId`, message: `Nothing of line ${line.seq} arrived yet: receive it first.` })
      else if (line.disposition !== null) problems.push({ path: `${at}/lineId`, message: `Line ${line.seq} is decided: it keeps its grade.` })
      if (tooLong(entry.conditionNote, RETURN_LIMITS.conditionNote)) problems.push({ path: `${at}/conditionNote`, message: `At most ${RETURN_LIMITS.conditionNote} characters.` })
      if (line) seenLines.add(line.id)
    }
    if (problems.length > 0) refuse(problems, 'Some lines cannot be graded.')
    const actorId = actorIdOf(context)
    for (const entry of body.lines) {
      const line = byId.get(entry.lineId)!
      const after = { grade: entry.grade, cause: entry.cause ?? null, conditionNote: blank(entry.conditionNote) }
      await tx.returnLine.update({ where: { id: line.id }, data: { ...after, inspectedAt: now, inspectedById: actorId, updatedAt: now, version: { increment: 1 } }, select: { id: true } })
      tools.audit({ action: 'returns.gradeLine', recordType: 'ReturnLine', recordId: line.id, companyId: rma.companyId, siteId: rma.siteId, before: { grade: line.grade, cause: line.cause, conditionNote: line.conditionNote }, after })
    }
    await touchReturn(tools, rma)
    tools.emit({ type: 'return.graded', subject: rma.id, companyId: rma.companyId, siteId: rma.siteId, payload: { returnId: rma.id, number: rma.number, lineIds: body.lines.map((entry) => entry.lineId) } })
    return { graded: body.lines.length }
  })
  return { return: await dockOf(caller, seen.id) }
}

