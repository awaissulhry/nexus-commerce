import type { Prisma, Uom } from '@nexus/factory-db'
import { InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { quantityText } from '@nexus/factory-domain/inventory/ledger/moves'
import { INVENTORY_STOCK_VIEW } from '@nexus/factory-domain/inventory/permissions'
import {
  DISCREPANCY_LIMITS,
  DISCREPANCY_REASON_LIST,
  discrepancyEditProblem,
  discrepancyNote,
  discrepancyQuantityProblems,
  kindAndReason,
  nextDiscrepancySeq,
  readDiscrepancyNote,
  settleProblems,
  type DiscrepancyKind,
  type DiscrepancyStatus,
  type SettleStatus,
} from '@nexus/factory-domain/inventory/receipts/discrepancies'
import { INVENTORY_DISCREPANCIES_MANAGE } from '@nexus/factory-domain/inventory/receipts/permissions'
import { baseFactor, dimensionOf } from '@nexus/factory-domain/product/units/units'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { activeReasonCodes, reasonWords, type ReasonFact } from '../../../platform/reasons/service'
import { visibleReceipt } from './read'
import { byId, ids, readItems, type Reader, type ReceiptRow } from './store'

/**
 * What was wrong with a delivery (B-W2a-31; SCM-118; design warehouse.receipts rec "Discrepancies", pop rc-disc-new),
 * office only. The rules are factory-domain inventory/receipts/discrepancies; the …_supply_w2a_guards trigger holds the
 * states for every login (claims.prisma ReceiptDiscrepancy).
 *
 *   GET    /inventory/receipts/:receiptId/discrepancies                      inventory.stock.view
 *   POST   /inventory/receipts/:receiptId/discrepancies                      inventory.discrepancies.manage
 *   PATCH  /inventory/receipts/:receiptId/discrepancies/:discrepancyId       inventory.discrepancies.manage (OPEN only)
 *   DELETE /inventory/receipts/:receiptId/discrepancies/:discrepancyId       inventory.discrepancies.manage (OPEN only)
 *   POST   …/:discrepancyId/status {version, to: AGREED|CREDITED|CLOSED}     inventory.discrepancies.manage
 *
 * Every write is ONE command() (audit, Idempotency-Key): a new one under the receipt's advisory lock
 * `factory.receipt-discrepancy|company|receipt` (its number 10, 20 … and the per-receipt limit), a change, a removal and
 * a settle on the discrepancy's version (the record guard). Its reason code leads the note (`DAMAGED: …`): the list's
 * active codes are checked inside the command (platform/reasons). Photos: ./photos.ts. The report to the supplier:
 * ./report.ts. A supplier claim (B-W2a-44) points at a discrepancy through SupplierClaimLine.discrepancyId: the view
 * names those claims. Event `inventory.receipt_discrepancy_changed`. No price, no cost anywhere.
 */

export const DISCREPANCY_RECORD = 'ReceiptDiscrepancy'

export const DISCREPANCY_COLUMNS = {
  id: true,
  siteId: true,
  receiptId: true,
  seq: true,
  receiptLineId: true,
  supplierId: true,
  kind: true,
  quantity: true,
  uom: true,
  note: true,
  status: true,
  sentAt: true,
  sentById: true,
  closedAt: true,
  resolutionNote: true,
  version: true,
  createdAt: true,
  createdById: true,
} as const satisfies Prisma.ReceiptDiscrepancySelect
export type DiscrepancyRow = Prisma.ReceiptDiscrepancyGetPayload<{ select: typeof DISCREPANCY_COLUMNS }>

export interface DiscrepancyBody {
  readonly kind?: DiscrepancyKind | undefined
  readonly reasonCode?: string | null | undefined
  readonly receiptLineId?: string | null | undefined
  readonly quantity?: string | null | undefined
  readonly uom?: Uom | null | undefined
  readonly note?: string | null | undefined
}

const iso = (value: Date | null): string | null => (value === null ? null : toUtcIso(value))

/** The receipt's lines as a discrepancy names them (material, colour, the order line). */
async function receiptLines(db: Reader, receiptId: string) {
  const lines = await db.goodsReceiptLine.findMany({ where: { receiptId }, select: { id: true, seq: true, itemId: true, itemColourId: true, purchaseOrderLineId: true }, orderBy: { seq: 'asc' } })
  const items = await readItems(db, lines.map((line) => line.itemId))
  const colours = byId(await db.itemColour.findMany({ where: { id: { in: ids(lines.map((line) => line.itemColourId)) } }, select: { id: true, code: true, name: true } }))
  return { lines, items, colours }
}

/** The discrepancies of a receipt as every route answers them (inside a command too: no relation select). */
export async function discrepancyViews(db: Reader, receiptId: string, only?: readonly string[]) {
  const rows = await db.receiptDiscrepancy.findMany({ where: { receiptId, ...(only ? { id: { in: [...only] } } : {}) }, select: DISCREPANCY_COLUMNS, orderBy: { seq: 'asc' } })
  const { lines, items, colours } = await receiptLines(db, receiptId)
  const words = await reasonWords(db as CommandTx, DISCREPANCY_REASON_LIST)
  const photos = await db.storedFile.findMany({
    where: { recordType: DISCREPANCY_RECORD, recordId: { in: rows.map((row) => row.id) }, kind: 'PHOTO', status: { not: 'DELETED' } },
    select: { id: true, recordId: true, originalName: true, contentType: true, sizeBytes: true, status: true, createdAt: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  const claimLines = await db.supplierClaimLine.findMany({ where: { discrepancyId: { in: rows.map((row) => row.id) } }, select: { discrepancyId: true, claimId: true } })
  const claims = byId(await db.supplierClaim.findMany({ where: { id: { in: ids(claimLines.map((line) => line.claimId)) } }, select: { id: true, number: true, status: true } }))
  return rows.map((row) => viewOf(row, { lines, items, colours, words, photos, claimLines, claims }))
}

function viewOf(
  row: DiscrepancyRow,
  facts: {
    readonly lines: Awaited<ReturnType<typeof receiptLines>>['lines']
    readonly items: Awaited<ReturnType<typeof readItems>>
    readonly colours: Map<string, { id: string; code: string; name: string }>
    readonly words: Map<string, ReasonFact>
    readonly photos: readonly { id: string; recordId: string; originalName: string; contentType: string; sizeBytes: number; status: string; createdAt: Date }[]
    readonly claimLines: readonly { discrepancyId: string | null; claimId: string }[]
    readonly claims: Map<string, { id: string; number: string; status: string }>
  },
) {
  const { reasonCode, note } = readDiscrepancyNote(row.note, new Set(facts.words.keys()))
  const reason = reasonCode ? facts.words.get(reasonCode) : undefined
  const line = row.receiptLineId ? facts.lines.find((entry) => entry.id === row.receiptLineId) : undefined
  const item = line ? facts.items.get(line.itemId) : undefined
  const colour = line?.itemColourId ? facts.colours.get(line.itemColourId) : undefined
  return {
    id: row.id,
    receiptId: row.receiptId,
    seq: row.seq,
    status: row.status,
    kind: row.kind,
    reasonCode,
    reason: reason ? { code: reason.code, labelIt: reason.labelIt, labelEn: reason.labelEn, active: reason.active } : null,
    receiptLine:
      line && item
        ? { id: line.id, seq: line.seq, purchaseOrderLineId: line.purchaseOrderLineId, item: { id: item.id, code: item.code, name: item.name, baseUom: item.baseUom }, colour: colour ? { id: colour.id, code: colour.code, name: colour.name } : null }
        : null,
    quantity: row.quantity === null ? null : quantityText(row.quantity.toString()),
    uom: row.uom,
    note,
    sentAt: iso(row.sentAt),
    sentById: row.sentById,
    closedAt: iso(row.closedAt),
    resolutionNote: row.resolutionNote,
    photos: facts.photos.filter((file) => file.recordId === row.id).map((file) => ({ id: file.id, originalName: file.originalName, contentType: file.contentType, sizeBytes: file.sizeBytes, status: file.status, createdAt: toUtcIso(file.createdAt) })),
    claims: [...new Set(facts.claimLines.filter((entry) => entry.discrepancyId === row.id).map((entry) => entry.claimId))].flatMap((claimId) => {
      const claim = facts.claims.get(claimId)
      return claim ? [{ id: claim.id, number: claim.number, status: claim.status }] : []
    }),
    version: row.version,
    createdAt: toUtcIso(row.createdAt),
    createdById: row.createdById,
  }
}
export type DiscrepancyView = ReturnType<typeof viewOf>

/** GET /inventory/receipts/:receiptId/discrepancies */
export async function listDiscrepancies(caller: CommandCaller, receiptId: string) {
  const { receipt } = await visibleReceipt(caller, receiptId, INVENTORY_STOCK_VIEW)
  return caller.withClient(async (client) => ({
    receiptId: receipt.id,
    number: receipt.number,
    status: receipt.status,
    /** May discrepancies be recorded on it (OPEN or POSTED). */
    open: receipt.status === 'OPEN' || receipt.status === 'POSTED',
    discrepancies: await discrepancyViews(client, receipt.id),
  }))
}

/** The receipt a write reaches (inventory.discrepancies.manage at its company and site), else not found. */
async function writableReceipt(caller: CommandCaller, receiptId: string): Promise<ReceiptRow> {
  return (await visibleReceipt(caller, receiptId, INVENTORY_DISCREPANCIES_MANAGE)).receipt
}

const lockReceipt = (tools: CommandTools, receipt: ReceiptRow) =>
  tools.tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.receipt-discrepancy', ${receipt.companyId}::uuid, ${receipt.id}::uuid), 0))`

/** What a body says, checked against the receipt (its line, the line's units) and the reason list: every problem at once. */
async function planned(tx: CommandTx, receipt: ReceiptRow, body: DiscrepancyBody, current: DiscrepancyRow | null) {
  const problems: Issue[] = []
  const active = await activeReasonCodes(tx, DISCREPANCY_REASON_LIST)
  const known = new Set((await reasonWords(tx, DISCREPANCY_REASON_LIST)).keys())
  const before = current ? readDiscrepancyNote(current.note, known) : { reasonCode: null, note: null }
  // A change keeps what it does not name (a reason no longer active may stay, it was valid when recorded).
  const reasonCode = body.reasonCode !== undefined ? body.reasonCode : before.reasonCode
  const kept = current !== null && body.reasonCode === undefined && reasonCode !== null && !active.has(reasonCode)
  const resolved = kindAndReason({ kind: body.kind ?? current?.kind ?? null, reasonCode }, kept ? new Set([...active, reasonCode!]) : active)
  if (resolved.problems) problems.push(...resolved.problems)
  const lineId = body.receiptLineId !== undefined ? body.receiptLineId : (current?.receiptLineId ?? null)
  const quantity = body.quantity !== undefined ? body.quantity : current?.quantity ? current.quantity.toString() : null
  const uom = body.uom !== undefined ? body.uom : (current?.uom ?? null)
  const note = body.note !== undefined ? body.note : before.note
  problems.push(...discrepancyQuantityProblems(quantity, uom))
  let line: { id: string; itemId: string } | null = null
  if (lineId !== null) {
    line = isUuid(lineId) ? await tx.goodsReceiptLine.findFirst({ where: { id: lineId, receiptId: receipt.id }, select: { id: true, itemId: true } }) : null
    if (!line) problems.push({ path: 'body/receiptLineId', message: 'Not a line of this receipt.' })
    else if (uom !== null && uom !== undefined) {
      const item = (await readItems(tx, [line.itemId])).get(line.itemId)!
      const units = { baseUom: item.baseUom, purchaseUom: item.purchaseUom, purchaseFactor: item.purchaseFactor.toString(), consumptionUom: item.consumptionUom, consumptionFactor: item.consumptionFactor.toString() }
      if (dimensionOf(uom) !== 'ITEM' && baseFactor(uom, units) === null) problems.push({ path: 'body/uom', message: `${item.code} is not counted in ${uom}: use its base unit ${item.baseUom} or a unit it converts.` })
    }
  }
  const stored = 'problems' in resolved && resolved.problems ? null : discrepancyNote((resolved as { reasonCode: string | null }).reasonCode, note)
  if (stored !== null && stored.length > DISCREPANCY_LIMITS.note) problems.push({ path: 'body/note', message: `At most ${DISCREPANCY_LIMITS.note} characters.` })
  if (problems.length > 0 || resolved.problems) throw new ValidationError(problems.length === 1 ? problems[0]!.message : 'The discrepancy is not complete.', problems)
  return { kind: resolved.kind, reasonCode: resolved.reasonCode, receiptLineId: line?.id ?? null, quantity: quantity === null || quantity === undefined || quantity.trim() === '' ? null : quantity.trim(), uom: uom ?? null, note: stored }
}

function emitChange(tools: CommandTools, receipt: ReceiptRow, row: { id: string; seq: number; kind: DiscrepancyKind; status: DiscrepancyStatus | 'REMOVED' }, change: 'RECORDED' | 'CHANGED' | 'REMOVED' | 'SETTLED') {
  tools.emit({
    type: 'inventory.receipt_discrepancy_changed',
    subject: receipt.id,
    companyId: receipt.companyId,
    siteId: receipt.siteId,
    payload: { receiptId: receipt.id, discrepancyId: row.id, seq: row.seq, kind: row.kind, status: row.status, change },
  })
}

/** POST /inventory/receipts/:receiptId/discrepancies */
export async function recordDiscrepancy(caller: CommandCaller, receiptId: string, body: DiscrepancyBody, idempotencyKey?: string) {
  const receipt = await writableReceipt(caller, receiptId)
  const { result } = await command(caller, { name: 'inventory.recordDiscrepancy', idempotencyKey, input: { receiptId, ...body } }, async (tools) => {
    const { tx, now } = tools
    await lockReceipt(tools, receipt)
    const current = (await tx.goodsReceipt.findUnique({ where: { id: receipt.id }, select: { status: true } }))!
    if (current.status !== 'OPEN' && current.status !== 'POSTED') {
      throw new InvalidStateError(`Receipt ${receipt.number} is ${current.status.toLowerCase()}: its goods are no longer in stock as received, so no discrepancy is recorded on it.`)
    }
    const taken = await tx.receiptDiscrepancy.findMany({ where: { receiptId: receipt.id }, select: { seq: true } })
    if (taken.length >= DISCREPANCY_LIMITS.perReceipt) throw new InvalidStateError(`Receipt ${receipt.number} holds ${DISCREPANCY_LIMITS.perReceipt} discrepancies already.`)
    const values = await planned(tx, receipt, body, null)
    const id = newId()
    const seq = nextDiscrepancySeq(taken.map((row) => row.seq))
    await tx.receiptDiscrepancy.create({
      data: { id, siteId: receipt.siteId, receiptId: receipt.id, seq, receiptLineId: values.receiptLineId, supplierId: receipt.supplierId, kind: values.kind, quantity: values.quantity, uom: values.uom, note: values.note, createdAt: now, updatedAt: now, createdById: tools.context.audience === 'office' ? tools.context.actorId : null },
      select: { id: true },
    })
    tools.audit({ action: 'inventory.discrepancyRecorded', recordType: DISCREPANCY_RECORD, recordId: id, companyId: receipt.companyId, siteId: receipt.siteId, after: { receiptId: receipt.id, seq, ...values, status: 'OPEN' } })
    emitChange(tools, receipt, { id, seq, kind: values.kind, status: 'OPEN' }, 'RECORDED')
    return { discrepancy: (await discrepancyViews(tx, receipt.id, [id]))[0]! }
  })
  return result
}

/** The discrepancy of this receipt (any state), else not found. */
async function discrepancyOf(caller: CommandCaller, receipt: ReceiptRow, discrepancyId: string): Promise<DiscrepancyRow> {
  const row = isUuid(discrepancyId) ? await caller.withClient((client) => client.receiptDiscrepancy.findFirst({ where: { id: discrepancyId, receiptId: receipt.id }, select: DISCREPANCY_COLUMNS })) : null
  if (!row) throw new NotFoundError('Discrepancy not found.')
  return row
}

/** PATCH /inventory/receipts/:receiptId/discrepancies/:discrepancyId (OPEN only). */
export async function changeDiscrepancy(caller: CommandCaller, receiptId: string, discrepancyId: string, body: DiscrepancyBody & { readonly version: number }, idempotencyKey?: string) {
  const receipt = await writableReceipt(caller, receiptId)
  const row = await discrepancyOf(caller, receipt, discrepancyId)
  const { version, ...change } = body
  const { result } = await command(
    caller,
    { name: 'inventory.changeDiscrepancy', idempotencyKey, input: { receiptId, discrepancyId, ...body }, record: { type: 'ReceiptDiscrepancy', id: row.id, expectedVersion: version } },
    async (tools) => {
      const { tx } = tools
      const current = (await tx.receiptDiscrepancy.findUnique({ where: { id: row.id }, select: DISCREPANCY_COLUMNS }))!
      const problem = discrepancyEditProblem(current.status, 'change')
      if (problem) throw new InvalidStateError(problem)
      const values = await planned(tx, receipt, change, current)
      await tx.receiptDiscrepancy.update({ where: { id: row.id }, data: { kind: values.kind, receiptLineId: values.receiptLineId, quantity: values.quantity, uom: values.uom, note: values.note }, select: { id: true } })
      tools.audit({
        action: 'inventory.discrepancyChanged',
        recordType: DISCREPANCY_RECORD,
        recordId: row.id,
        companyId: receipt.companyId,
        siteId: receipt.siteId,
        before: { kind: current.kind, receiptLineId: current.receiptLineId, quantity: current.quantity?.toString() ?? null, uom: current.uom, note: current.note },
        after: { kind: values.kind, receiptLineId: values.receiptLineId, quantity: values.quantity, uom: values.uom, note: values.note },
      })
      emitChange(tools, receipt, { id: row.id, seq: current.seq, kind: values.kind, status: current.status }, 'CHANGED')
      return { discrepancy: (await discrepancyViews(tx, receipt.id, [row.id]))[0]! }
    },
  )
  return result
}

/** DELETE /inventory/receipts/:receiptId/discrepancies/:discrepancyId?version= (OPEN only: recorded by mistake). */
export async function removeDiscrepancy(caller: CommandCaller, receiptId: string, discrepancyId: string, query: { readonly version: number }, idempotencyKey?: string) {
  const receipt = await writableReceipt(caller, receiptId)
  const row = await discrepancyOf(caller, receipt, discrepancyId)
  const { result } = await command(
    caller,
    { name: 'inventory.removeDiscrepancy', idempotencyKey, input: { receiptId, discrepancyId, ...query }, record: { type: 'ReceiptDiscrepancy', id: row.id, expectedVersion: query.version } },
    async (tools) => {
      const { tx } = tools
      const current = (await tx.receiptDiscrepancy.findUnique({ where: { id: row.id }, select: DISCREPANCY_COLUMNS }))!
      const problem = discrepancyEditProblem(current.status, 'remove')
      if (problem) throw new InvalidStateError(problem)
      const photos = await tx.storedFile.count({ where: { recordType: DISCREPANCY_RECORD, recordId: row.id, status: { not: 'DELETED' } } })
      if (photos > 0) throw new InvalidStateError(`Discrepancy ${current.seq} has ${photos === 1 ? 'a photo' : `${photos} photos`}: delete ${photos === 1 ? 'it' : 'them'} first, or close the discrepancy with why it is not pursued.`)
      await tx.receiptDiscrepancy.delete({ where: { id: row.id }, select: { id: true } })
      tools.audit({ action: 'inventory.discrepancyRemoved', recordType: DISCREPANCY_RECORD, recordId: row.id, companyId: receipt.companyId, siteId: receipt.siteId, before: { receiptId: receipt.id, seq: current.seq, kind: current.kind, status: current.status, note: current.note } })
      emitChange(tools, receipt, { id: row.id, seq: current.seq, kind: current.kind, status: 'REMOVED' }, 'REMOVED')
      return { removed: { id: row.id, seq: current.seq } }
    },
  )
  return result
}

/** POST /inventory/receipts/:receiptId/discrepancies/:discrepancyId/status {version, to, note?}: the supplier's answer, or closed. */
export async function settleDiscrepancy(caller: CommandCaller, receiptId: string, discrepancyId: string, body: { readonly version: number; readonly to: SettleStatus; readonly note?: string | null | undefined }, idempotencyKey?: string) {
  const receipt = await writableReceipt(caller, receiptId)
  const row = await discrepancyOf(caller, receipt, discrepancyId)
  const { result } = await command(
    caller,
    { name: 'inventory.settleDiscrepancy', idempotencyKey, input: { receiptId, discrepancyId, ...body }, record: { type: 'ReceiptDiscrepancy', id: row.id, expectedVersion: body.version } },
    async (tools) => {
      const { tx, now } = tools
      const current = (await tx.receiptDiscrepancy.findUnique({ where: { id: row.id }, select: DISCREPANCY_COLUMNS }))!
      const problems = settleProblems(current.status, body.to, body.note)
      if (problems.length > 0) throw new (problems[0]!.path === 'body/note' ? ValidationError : InvalidStateError)(problems[0]!.message, problems)
      const note = body.note?.trim() ? body.note.trim().slice(0, DISCREPANCY_LIMITS.resolution) : null
      // The answers so far, in order (the supplier agreed …, credit note …, closed because …).
      const resolution = [current.resolutionNote, note].filter((part): part is string => part !== null && part !== '').join(' · ').slice(0, DISCREPANCY_LIMITS.resolution) || null
      await tx.receiptDiscrepancy.update({ where: { id: row.id }, data: { status: body.to, resolutionNote: resolution, ...(body.to === 'CLOSED' ? { closedAt: now } : {}) }, select: { id: true } })
      tools.audit({
        action: 'inventory.discrepancySettled',
        recordType: DISCREPANCY_RECORD,
        recordId: row.id,
        companyId: receipt.companyId,
        siteId: receipt.siteId,
        before: { status: current.status, resolutionNote: current.resolutionNote },
        after: { status: body.to, resolutionNote: resolution },
        ...(note ? { reason: note } : {}),
      })
      emitChange(tools, receipt, { id: row.id, seq: current.seq, kind: current.kind, status: body.to }, 'SETTLED')
      return { discrepancy: (await discrepancyViews(tx, receipt.id, [row.id]))[0]! }
    },
  )
  return result
}
