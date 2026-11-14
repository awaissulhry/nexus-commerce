import { DomainError, InvalidStateError } from '@nexus/factory-domain/core/errors'
import { eventFor } from '@nexus/factory-domain/events/define'
import { carrierAddressOf } from '@nexus/factory-domain/shipping/labels/labels'
import {
  addressComplete,
  carrierCodeOf,
  makeHeldOf,
  RETURN_LABEL_REFUSAL_WORDS,
  returnLabelFileName,
  returnLabelRefusalPath,
  returnLabelRequestOf,
  type ReturnLabelRefusal,
  type SwapFacts,
} from '@nexus/factory-domain/shipping/return-labels/rules'
import { events as deliveryEvents } from '@nexus/factory-domain/shipping-delivery/events'
import type { CommandCaller, CommandTools, CommandTx } from '../../../core/command'
import { putGeneratedFile, recordGeneratedFile, type PreparedGeneratedFile } from '../../../platform/files/files'
import type { FilesRuntime } from '../../../platform/files/service'
import { carrierAccountIdOf } from '../labels/store'
import { carrierProblem, type CarrierRuntime } from '../labels/carrier'

/**
 * Booking a return label (B-W2b-398; LOG-112; factory-domain shipping/return-labels): what a label needs (the return, the
 * shipment it swaps, the site's test mode, address and carrier account), the carrier booking through the gateway outside
 * any transaction (the reference is the label's own, so asking again answers the same label: never booked twice) and the
 * label PDF put in the file store, then the rows written inside the caller's command (the file of the return, shared with
 * the customer's portal and links; the ReturnLabel BOOKED; return_label.changed).
 */

export const labelChanged = deliveryEvents.find((event) => event.type === 'return_label.changed')!

const RETURN_SELECT = { id: true, number: true, status: true, companyId: true, siteId: true, partyId: true, salesOrderId: true, contactId: true, customerRef: true, goodsDueBy: true } as const

export type ReturnRow = NonNullable<Awaited<ReturnType<typeof readReturn>>>

export const readReturn = (db: CommandTx, returnId: string) => db.returnAuthorisation.findUnique({ where: { id: returnId }, select: RETURN_SELECT })

/** A refusal in words, 409 with `refusal/<CODE>`. */
export function refused(code: ReturnLabelRefusal, message: string = RETURN_LABEL_REFUSAL_WORDS[code]): never {
  throw new DomainError('conflict', message, [{ path: returnLabelRefusalPath(code), message }])
}

/** The customer's address on a shipment's ship-to: its own name, else the customer's (as the outbound label names them). */
async function customerAddressOf(db: CommandTx, shipment: { readonly partyId: string; readonly shipTo: unknown }): Promise<unknown> {
  const shipTo = shipment.shipTo as Record<string, unknown> | null
  if (!shipTo || typeof shipTo !== 'object' || (typeof shipTo.name === 'string' && shipTo.name.trim() !== '')) return shipment.shipTo
  const party = await db.party.findUnique({ where: { id: shipment.partyId }, select: { legalName: true, tradeName: true } })
  return party ? { ...shipTo, name: party.tradeName ?? party.legalName } : shipment.shipTo
}

/** What a return label of this return needs, read now (the office's client, a link's system scope or the command's). */
export async function labelFactsOf(db: CommandTx, rma: ReturnRow, shipmentId?: string) {
  const shipments = rma.salesOrderId
    ? await db.shipment.findMany({
        where: { salesOrderId: rma.salesOrderId, partyId: rma.partyId, status: { in: ['SHIPPED', 'DELIVERED', 'RETURNED'] } },
        select: { id: true, number: true, companyId: true, siteId: true, partyId: true, shipTo: true, carrierCode: true, serviceCode: true, integrationAccountId: true, shippedAt: true },
        orderBy: [{ shippedAt: 'desc' }, { number: 'desc' }],
      })
    : []
  const shipment = shipmentId ? (shipments.find((row) => row.id === shipmentId) ?? null) : (shipments[0] ?? null)
  const settings = await db.shippingSettings.findUnique({ where: { id: rma.siteId }, select: { senderAddress: true, returnAddress: true, integrationAccountId: true, defaultCarrierCode: true, defaultServiceCode: true, testMode: true } })
  const accountId = shipment ? await carrierAccountIdOf(db, { companyId: rma.companyId, siteId: rma.siteId, integrationAccountId: shipment.companyId === rma.companyId ? shipment.integrationAccountId : null }, settings?.integrationAccountId ?? null) : null
  const account = accountId ? await db.integrationAccount.findUnique({ where: { id: accountId }, select: { id: true, provider: true, status: true } }) : null
  const usable = account !== null && account.provider === 'SENDCLOUD' && account.status !== 'DISABLED'
  const parcel = shipment ? await db.parcel.findFirst({ where: { shipmentId: shipment.id }, select: { grossWeightKg: true }, orderBy: { seq: 'asc' } }) : null
  const customerAddress = shipment ? await customerAddressOf(db, shipment) : null
  const siteAddress = settings ? (settings.returnAddress ?? settings.senderAddress) : null
  const carrierCode = carrierCodeOf(shipment?.carrierCode) ?? carrierCodeOf(settings?.defaultCarrierCode)
  const serviceCode = shipment?.serviceCode ?? settings?.defaultServiceCode ?? null
  const hasAddress = customerAddress !== null && siteAddress !== null && addressComplete(carrierAddressOf(customerAddress)) && addressComplete(carrierAddressOf(siteAddress))
  const held = makeHeldOf({ returnStatus: rma.status, testMode: settings?.testMode ?? true, hasShipment: shipment !== null, hasAccount: usable, hasAddress, hasService: carrierCode !== null && serviceCode !== null })
  return {
    held,
    shipments: shipments.map((row) => ({ id: row.id, number: row.number })),
    shipment: shipment ? { id: shipment.id, number: shipment.number } : null,
    accountId: usable ? account!.id : null,
    carrierCode,
    serviceCode,
    swap: (labelId: string): SwapFacts => ({
      returnNumber: rma.number,
      labelId,
      customerAddress,
      siteAddress,
      carrierCode,
      serviceCode,
      weightKg: parcel?.grossWeightKg ? parcel.grossWeightKg.toFixed(4) : null,
    }),
  }
}

export interface Booked {
  readonly trackingNumber: string
  readonly prepared: PreparedGeneratedFile
}

/**
 * The carrier booking and the label PDF (outside any transaction; the system or an office caller): one gateway call to
 * book (the reference `return-label:<label id>`), one for the PDF, the file put in the store. A refusal in words.
 */
export async function bookCarrier(runtime: { readonly carrier: CarrierRuntime; readonly files: FilesRuntime }, caller: CommandCaller, rma: ReturnRow, facts: Awaited<ReturnType<typeof labelFactsOf>>, labelId: string): Promise<Booked> {
  if (facts.held) refused(facts.held)
  const request = returnLabelRequestOf(facts.swap(labelId))
  let trackingNumber: string
  let body: Uint8Array
  try {
    const label = await runtime.carrier.createLabel(caller, facts.accountId!, request)
    const document = await runtime.carrier.labelDocument(caller, facts.accountId!, label.providerId, 'PDF')
    if (document.format !== 'PDF') refused('CARRIER', 'The carrier gave the return label only as printer text (ZPL): a customer prints a PDF. Choose another carrier service.')
    trackingNumber = label.trackingNumber
    body = document.body
  } catch (error) {
    if (error instanceof DomainError) throw error
    refused('CARRIER', `${RETURN_LABEL_REFUSAL_WORDS.CARRIER} ${carrierProblem(error)}`)
  }
  const prepared = await putGeneratedFile(runtime.files, caller, {
    companyId: rma.companyId,
    recordType: 'ReturnAuthorisation',
    recordId: rma.id,
    kind: 'DOCUMENT',
    originalName: returnLabelFileName(rma.number, trackingNumber!),
    contentType: 'application/pdf',
    body: body!,
    visibility: ['PARTNER', 'LINK'],
    partyId: rma.partyId,
  })
  return { trackingNumber: trackingNumber!, prepared }
}

/** Inside a command: a label made BOOKED at once (the file recorded, the row, its audit row and event). */
export async function insertBookedInCommand(tools: CommandTools, rma: ReturnRow, labelId: string, carrierCode: string, booked: Booked): Promise<void> {
  const { tx, now } = tools
  const current = await lockReturn(tx, rma.id)
  if (current.status !== 'AUTHORISED' && current.status !== 'RECEIVED') refused('RETURN_CLOSED')
  const file = await recordGeneratedFile(tools, booked.prepared)
  await tx.returnLabel.create({
    data: { id: labelId, companyId: rma.companyId, siteId: rma.siteId, partyId: rma.partyId, returnId: rma.id, carrierCode, status: 'BOOKED', bookingReference: booked.trackingNumber, labelFileId: file.id, createdAt: now, updatedAt: now, createdById: tools.context.audience === 'office' ? tools.context.actorId : null },
    select: { id: true },
  })
  tools.audit({ action: 'shipping.returnLabel', recordType: 'ReturnAuthorisation', recordId: rma.id, companyId: rma.companyId, siteId: rma.siteId, after: { labelId, status: 'BOOKED', carrierCode, bookingReference: booked.trackingNumber, fileId: file.id } })
  tools.emit(eventFor(labelChanged, { subject: rma.id, companyId: rma.companyId, siteId: rma.siteId, payload: { returnId: rma.id, number: rma.number, labelId, status: 'BOOKED', via: 'OFFICE' } }))
}

/** Inside a command: an OFFERED label booked by its link (the row FOR UPDATE; still OFFERED, else refused). */
export async function bookOfferedInCommand(tools: CommandTools, rma: ReturnRow, labelId: string, booked: Booked): Promise<void> {
  const { tx, now } = tools
  await lockReturn(tx, rma.id)
  await tx.$queryRaw`SELECT 1 FROM "ReturnLabel" WHERE "id" = ${labelId}::uuid FOR UPDATE`
  const row = await tx.returnLabel.findUnique({ where: { id: labelId }, select: { status: true, version: true } })
  if (!row || row.status !== 'OFFERED') refused('NOT_OFFERED')
  const file = await recordGeneratedFile(tools, booked.prepared)
  await tx.returnLabel.update({ where: { id: labelId }, data: { status: 'BOOKED', bookingReference: booked.trackingNumber, labelFileId: file.id, updatedAt: now, version: { increment: 1 } }, select: { id: true } })
  tools.audit({ action: 'shipping.returnLabelBooked', recordType: 'ReturnAuthorisation', recordId: rma.id, companyId: rma.companyId, siteId: rma.siteId, before: { status: 'OFFERED' }, after: { labelId, status: 'BOOKED', bookingReference: booked.trackingNumber, fileId: file.id, via: 'LINK' } })
  tools.emit(eventFor(labelChanged, { subject: rma.id, companyId: rma.companyId, siteId: rma.siteId, payload: { returnId: rma.id, number: rma.number, labelId, status: 'BOOKED', via: 'LINK' } }))
}

/** The return's row FOR UPDATE (labels of one return are made one at a time), read again. */
export async function lockReturn(tx: CommandTx, returnId: string) {
  await tx.$queryRaw`SELECT 1 FROM "ReturnAuthorisation" WHERE "id" = ${returnId}::uuid FOR UPDATE`
  const row = await readReturn(tx, returnId)
  if (!row) throw new InvalidStateError('The return is gone.')
  return row
}
