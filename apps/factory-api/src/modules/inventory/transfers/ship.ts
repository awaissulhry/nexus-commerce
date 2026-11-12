import type { Prisma } from '@nexus/factory-db'
import type { DocumentLanguage } from '@nexus/factory-domain/documents/model'
import type { ShipAnswer, ShipBody } from '@nexus/factory-domain/inventory/transfers/contracts'
import { DEFAULT_APPEARANCE } from '@nexus/factory-domain/inventory/transfers/ddt'
import { problem, quantityOut, shipProblems, typedQuantity, type TransferProblem, type TransferStatus } from '@nexus/factory-domain/inventory/transfers/rules'
import { command, type CommandCaller } from '../../../core/command'
import { companyLegalOf } from '../../../platform/documents/documents'
import type { FilesRuntime } from '../../../platform/files/service'
import { printTransferDdt, transferDdtFactsOf, transferDdtProblems } from '../../shipping/ddt/transfer'
import { officeContextOf } from '../ledger/access'
import { InsufficientStockError, postMoves, type MoveDraft } from '../ledger/post-moves'
import { balancesAt, dayOf, decOf, invalid, keyText, LINE_SELECT, mustManage, refuse, today, toDay, visibleTransfer } from './store'
import { transferChanged, transferNumberOf, transferRecord } from './transfers'

/**
 * Ship a transfer (B-W2b-326; SCM-219, SCM-220; design warehouse.transfers pop-up "Ship transfer": "posts moves to the
 * in-transit location; issues the DDT number (never reused)"). inventory.transfers.manage at the sending site; office only.
 *
 * Before the command: the draft's lines, each with its place and the stock it takes; the DDT's fields (a carrier named for
 * CARRIER, words for OTHER, an expected day not before today); the DDT's layout (composeDocument's check: the companies'
 * legal data and the recipient's address), so a refusal takes no number. ONE command on the transfer's version: a TRANSFER
 * per line from its pick place onto the transit place naming the line (postMoves; never below zero: 409), each line's
 * shippedQuantity, the DDT's number from the sending company's DDT series (allocateNumber: gapless, never reused, a
 * rollback takes none), the header SHIPPED with the whole DDT (shipOn = today), its audit row and
 * inventory.transfer_changed. After the commit: the PDF (shipping/ddt/transfer.ts), whose failure leaves it shipped.
 */

const carrierProblems = (body: ShipBody) => {
  const fields: { path: string; message: string }[] = []
  if (body.transportBy === 'CARRIER' && !body.carrierName?.trim()) fields.push({ path: 'carrierName', message: 'Name the carrier that carries the goods.' })
  if ((body.reason ?? 'TRANSFER') === 'OTHER' && !body.reasonText?.trim()) fields.push({ path: 'reasonText', message: 'Say the reason in words.' })
  const weight = typedQuantity(body.grossWeightKg)
  if (!weight) fields.push({ path: 'grossWeightKg', message: 'The gross weight in kilograms, above 0.' })
  return fields
}

export async function shipTransfer(files: FilesRuntime, caller: CommandCaller, transferId: string, body: ShipBody, idempotencyKey?: string, onPdfError?: (error: unknown) => void): Promise<ShipAnswer> {
  const context = officeContextOf(caller)
  const language: DocumentLanguage = body.language ?? 'it'
  const now = new Date()
  const day = today(now)
  const checked = await caller.withClient(async (client) => {
    const row = await visibleTransfer(client, context, transferId)
    mustManage(context, row, 'from')
    invalid(carrierProblems(body))
    const expectedOn = body.expectedOn !== undefined ? body.expectedOn : dayOf(row.expectedOn)
    if (expectedOn && expectedOn < day) invalid([{ path: 'expectedOn', message: 'The day it is expected is today or later.' }])
    const lines = await client.transferLine.findMany({ where: { transferId }, select: LINE_SELECT, orderBy: [{ seq: 'asc' }, { id: 'asc' }] })
    const balances = lines.length > 0 ? await balancesAt(client, row.fromSiteId, { itemId: { in: [...new Set(lines.map((line) => line.itemId))] } }) : new Map()
    refuse(
      shipProblems(
        row.status as TransferStatus,
        lines.map((line) => {
          const place = line.fromLocationId ?? row.fromLocationId
          return {
            seq: line.seq,
            pickPlaceId: place,
            quantity: decOf(line.baseQuantity),
            available: place ? (balances.get(keyText({ locationId: place, itemId: line.itemId, itemColourId: line.itemColourId, lotId: line.lotId, hideId: line.hideId })) ?? decOf(null)) : decOf(null),
            hide: line.hideId !== null,
          }
        }),
      ),
    )
    const settings = await client.shippingSettings.findFirst({ where: { siteId: row.fromSiteId }, select: { defaultGoodsAppearance: true } })
    const appearance = body.appearance?.trim() || settings?.defaultGoodsAppearance?.trim() || DEFAULT_APPEARANCE[language]
    const carrier = body.transportBy === 'CARRIER' && body.carrierName ? { name: body.carrierName.trim(), vatNumber: body.carrierVatNumber?.trim() || null } : null
    const draft = { reason: body.reason ?? 'TRANSFER', reasonText: body.reasonText?.trim() || null, transportBy: body.transportBy, carrier, appearance, packages: body.packages, grossWeightKg: quantityOut(typedQuantity(body.grossWeightKg)!), language, date: day, startAt: now.toISOString() } as const
    const facts = await transferDdtFactsOf(client, transferId, language, draft)
    return { row, lines, draft, facts, expectedOn }
  })
  // The DDT's layout, before a number is taken.
  const company = await companyLegalOf(caller, checked.row.companyId)
  const layout = transferDdtProblems(checked.facts, company)
  if (layout.length > 0) refuse(layout.map((issue): TransferProblem => problem('DDT_NOT_PRINTABLE', `${issue.message} (${issue.path})`)))

  const { row, lines, draft } = checked
  await command(caller, { name: 'inventory.transfers.ship', idempotencyKey, input: { transferId, ...body }, record: { type: 'TransferOrder', id: transferId, expectedVersion: body.version } }, async (tools) => {
    const current = await tools.tx.transferOrder.findUniqueOrThrow({ where: { id: transferId }, select: { status: true } })
    if (current.status !== 'DRAFT') refuse([problem('NOT_DRAFT')])
    const now = await tools.tx.transferLine.findMany({ where: { transferId }, select: { id: true, version: true }, orderBy: [{ seq: 'asc' }, { id: 'asc' }] })
    if (now.length !== lines.length || now.some((line, index) => line.id !== lines[index]!.id || line.version !== lines[index]!.version)) refuse([problem('NOT_DRAFT', 'Its lines changed meanwhile: read the transfer again.')])
    const drafts: MoveDraft[] = lines.map((line) => ({
      siteId: row.fromSiteId,
      reason: 'TRANSFER',
      itemId: line.itemId,
      itemColourId: line.itemColourId,
      lotId: line.lotId,
      hideId: line.hideId,
      fromLocationId: line.fromLocationId ?? row.fromLocationId,
      toLocationId: row.transitLocationId,
      quantity: line.baseQuantity.toString(),
      uom: line.uom,
      baseQuantity: line.baseQuantity.toString(),
      transferLineId: line.id,
      reference: row.number,
    }))
    try {
      // A transfer ships once: its moves' keys are its own.
      await postMoves(tools, drafts, { key: `inventory.transfers.ship:${transferId}`, issuePath: (index) => `lines/${index}` })
    } catch (error) {
      if (error instanceof InsufficientStockError) refuse([problem('NOT_ENOUGH_STOCK', error.message)])
      throw error
    }
    for (const line of lines) await tools.tx.transferLine.update({ where: { id: line.id }, data: { shippedQuantity: line.baseQuantity }, select: { id: true } })
    const number = await transferNumberOf(tools, row.companyId, 'DDT', { type: 'TransferOrder', id: transferId, date: day })
    const data: Prisma.TransferOrderUncheckedUpdateInput = {
      status: 'SHIPPED',
      shipOn: toDay(day),
      expectedOn: checked.expectedOn ? toDay(checked.expectedOn) : null,
      shippedAt: tools.now,
      shippedById: context.actorId,
      ddtNumberSeriesId: number.seriesId,
      ddtNumber: number.formatted,
      ddtDate: toDay(number.documentDate),
      ddtReason: draft.reason,
      ddtReasonText: draft.reasonText,
      transportBy: draft.transportBy,
      ...(draft.carrier ? { carrier: draft.carrier as Prisma.InputJsonValue } : {}),
      packages: draft.packages,
      grossWeightKg: draft.grossWeightKg,
      appearance: draft.appearance,
      ...(body.trackingRef !== undefined ? { trackingRef: body.trackingRef?.trim() || null } : {}),
      ...(body.trackingUrl !== undefined ? { trackingUrl: body.trackingUrl?.trim() || null } : {}),
    }
    await tools.tx.transferOrder.update({ where: { id: transferId }, data, select: { id: true } })
    tools.audit({
      recordType: 'TransferOrder',
      recordId: transferId,
      companyId: row.companyId,
      siteId: row.fromSiteId,
      before: { status: 'DRAFT' },
      after: {
        status: 'SHIPPED',
        ddtNumber: number.formatted,
        ddtDate: number.documentDate,
        ddtReason: draft.reason,
        transportBy: draft.transportBy,
        carrier: draft.carrier?.name ?? null,
        packages: draft.packages,
        grossWeightKg: draft.grossWeightKg,
        appearance: draft.appearance,
        lines: lines.map((line) => ({ lineId: line.id, shipped: quantityOut(decOf(line.baseQuantity)) })),
      },
    })
    transferChanged(tools, row, 'SHIPPED', 'SHIPPED', 'DRAFT', { ddtNumber: number.formatted })
    return { id: transferId, ddtNumber: number.formatted }
  })
  const printed = await printTransferDdt(files, caller, transferId, { language, safe: true, onError: onPdfError })
  return { transfer: await transferRecord(caller, transferId), fileId: printed.fileId, pdfProblem: printed.pdfProblem }
}

/** The DDT's PDF again (a shipped transfer whose PDF was not stored); the stored one when it is. */
export async function printDdtAgain(files: FilesRuntime, caller: CommandCaller, transferId: string, body: { readonly language?: DocumentLanguage | undefined }): Promise<{ fileId: string; created: boolean }> {
  const context = officeContextOf(caller)
  const row = await caller.withClient((client) => visibleTransfer(client, context, transferId))
  if (!row.ddtNumber) refuse([problem('NO_DDT')])
  const printed = await printTransferDdt(files, caller, transferId, { language: body.language ?? 'it' })
  return { fileId: printed.fileId!, created: printed.created }
}
