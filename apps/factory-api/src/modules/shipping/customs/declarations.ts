import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { parseInstant, toUtcIso } from '@nexus/factory-domain/core/time'
import { eventFor } from '@nexus/factory-domain/events/define'
import { events as customsEvents, type DECLARATION_CHANGES } from '@nexus/factory-domain/shipping-customs/events'
import { SHIPPING_CUSTOMS_MANAGE } from '@nexus/factory-domain/shipping/customs/permissions'
import { EXIT_ALERT_DAYS, mrnOf, type DeclarationStatus } from '@nexus/factory-domain/shipping/customs/rules'
import { command, StaleVersionError, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import type { ShipmentHeader } from '../store'
import { customsFactsOf } from './facts'
import { customsShipment, refused } from './papers'

/**
 * A shipment's export declaration (B-W2b-409; LOG-088 the declaration through a broker or the carrier with its MRN, LOG-089
 * the proof of exit against the invoice; factory-db customs.prisma CustomsDeclaration, its guards the last line). Office only,
 * shipping.customs.manage on the shipment's company, site and party; no values are read or written here.
 *
 *   open      the pack goes to the broker (a party) or the carrier files it (null): PACK_SENT, with after how many days a
 *             missing proof raises its alert; one declaration per shipment (the database keeps none: checked here under the
 *             shipment's customs lock); only for an export of a company with an EORI
 *   MRN       typed in (or answered by the broker's link: broker-pack/link.ts): FILED with its MRN, set once
 *   invoice   the issued invoice of the export (of the company, to the shipment's customer, not a draft), named once
 *   exit      the exit confirmed (when, not before the goods left nor in the future) with its proof, a file uploaded on the
 *             declaration first (POST /files, recordType CustomsDeclaration): EXITED, then frozen
 *   remove    a pack sent by mistake: the declaration deleted while PACK_SENT, its broker links revoked with it
 *
 * Each write is ONE command (the row FOR UPDATE, the version checked when given), audited on the Shipment, with
 * customs.declaration_changed. Refusals are 409 in words (`refusal/<CODE>`).
 */

export type DeclarationChange = (typeof DECLARATION_CHANGES)[number]

const declarationChanged = customsEvents.find((event) => event.type === 'customs.declaration_changed')!

export const DECLARATION_SELECT = {
  id: true,
  companyId: true,
  siteId: true,
  partyId: true,
  shipmentId: true,
  invoiceId: true,
  brokerPartyId: true,
  status: true,
  mrn: true,
  exitConfirmedAt: true,
  exitFileId: true,
  alertAfterDays: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const

export type DeclarationRow = NonNullable<Awaited<ReturnType<typeof declarationOf>>>

/** The shipment's declaration (one at most), or null. */
export const declarationOf = (db: CommandTx, shipmentId: string) => db.customsDeclaration.findFirst({ where: { shipmentId }, select: DECLARATION_SELECT, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })

const lockDeclaration = (tx: CommandTx, shipmentId: string) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.customs-declaration', ${shipmentId}::uuid), 0))`

/** The declaration FOR UPDATE inside a command (404 when gone), its version checked when given. */
async function lockedDeclaration(tx: CommandTx, shipmentId: string, version?: number): Promise<DeclarationRow> {
  await lockDeclaration(tx, shipmentId)
  const row = await declarationOf(tx, shipmentId)
  if (!row) throw new NotFoundError('This shipment has no export declaration.')
  await tx.$queryRaw`SELECT 1 FROM "CustomsDeclaration" WHERE "id" = ${row.id}::uuid FOR UPDATE`
  if (version !== undefined && version !== row.version) throw new StaleVersionError('CustomsDeclaration', row.id, row.version, version)
  return row
}

/** The database's clock (a guard refuses a time in the future by it), never later than the app's. */
async function databaseNow(tools: Pick<CommandTools, 'tx' | 'now'>): Promise<Date> {
  const at = (await tools.tx.$queryRaw<{ now: Date }[]>`SELECT now() AS "now"`)[0]!.now
  return tools.now.getTime() > at.getTime() ? at : tools.now
}

export function changed(tools: Pick<CommandTools, 'emit'>, shipment: Pick<ShipmentHeader, 'id' | 'number' | 'companyId' | 'siteId'>, declarationId: string, change: DeclarationChange, status: DeclarationStatus | null, via: 'OFFICE' | 'LINK'): void {
  tools.emit(eventFor(declarationChanged, { subject: shipment.id, companyId: shipment.companyId, siteId: shipment.siteId, payload: { shipmentId: shipment.id, number: shipment.number, declarationId, change, status, via } }))
}

export interface OpenBody {
  /** The customs broker (a party); null: the shipment's carrier files the declaration. */
  readonly brokerPartyId: string | null
  readonly alertAfterDays?: number | undefined
}

/** A party that may file the declaration: active, of the company (or every company's), a carrier or a supplier. */
export async function brokerOf(db: CommandTx, companyId: string, partyId: string) {
  if (!isUuid(partyId)) return null
  const party = await db.party.findUnique({ where: { id: partyId }, select: { id: true, companyId: true, legalName: true, tradeName: true, roles: true, status: true, language: true } })
  if (!party || party.status !== 'ACTIVE' || (party.companyId !== null && party.companyId !== companyId)) return null
  if (!party.roles.some((role) => role === 'CARRIER' || role === 'SUPPLIER')) return null
  return party
}

/** POST …/export/declaration: the declaration opened, its pack sent (PACK_SENT). */
export async function openDeclaration(caller: CommandCaller, shipmentId: string, body: OpenBody, idempotencyKey?: string) {
  const { context, shipment } = await customsShipment(caller, shipmentId, SHIPPING_CUSTOMS_MANAGE)
  const facts = await caller.withClient((db) => customsFactsOf(db, shipment))
  if (shipment.status === 'CANCELLED') refused('CANCELLED')
  if (facts.destination === null) refused('NO_DESTINATION')
  if (facts.destination !== 'EXPORT') refused('NOT_EXPORT')
  if (facts.eori === null) refused('NO_EORI')
  const days = body.alertAfterDays ?? EXIT_ALERT_DAYS.default
  if (body.brokerPartyId !== null && !(await caller.withClient((db) => brokerOf(db, shipment.companyId, body.brokerPartyId!)))) refused('BROKER')
  const { result } = await command(caller, { name: 'shipping.openCustomsDeclaration', idempotencyKey, input: { shipmentId, ...body, alertAfterDays: days } }, async (tools) => {
    const { tx, now } = tools
    await lockDeclaration(tx, shipment.id)
    if (await declarationOf(tx, shipment.id)) refused('DECLARED')
    const current = await tx.shipment.findUniqueOrThrow({ where: { id: shipment.id }, select: { status: true } })
    if (current.status === 'CANCELLED') refused('CANCELLED')
    const id = newId()
    await tx.customsDeclaration.create({
      data: { id, companyId: shipment.companyId, siteId: shipment.siteId, partyId: shipment.partyId, shipmentId: shipment.id, brokerPartyId: body.brokerPartyId, status: 'PACK_SENT', alertAfterDays: days, createdAt: now, updatedAt: now, createdById: context.actorId },
      select: { id: true },
    })
    tools.audit({ action: 'shipping.openCustomsDeclaration', recordType: 'Shipment', recordId: shipment.id, companyId: shipment.companyId, siteId: shipment.siteId, after: { declarationId: id, status: 'PACK_SENT', brokerPartyId: body.brokerPartyId, filedBy: body.brokerPartyId ? 'BROKER' : 'CARRIER', alertAfterDays: days } })
    changed(tools, shipment, id, 'OPENED', 'PACK_SENT', 'OFFICE')
    return { declarationId: id }
  })
  return result
}

/** FILED with its MRN inside a command (the office's, or the broker's answer in the tenant's system scope); answers whether it changed. */
export async function fileInCommand(tools: CommandTools, shipment: Pick<ShipmentHeader, 'id' | 'number' | 'companyId' | 'siteId'>, mrn: string, via: 'OFFICE' | 'LINK', version?: number): Promise<{ changed: boolean; declarationId: string }> {
  const row = await lockedDeclaration(tools.tx, shipment.id, version)
  if (row.status === 'EXITED') refused('EXITED')
  if (row.mrn !== null) {
    if (row.mrn !== mrn) refused('MRN_KEPT')
    // The same MRN again (a second press, the broker after the office): nothing changes; the try is kept.
    tools.audit({ action: 'shipping.recordMrn', recordType: 'Shipment', recordId: shipment.id, companyId: shipment.companyId, siteId: shipment.siteId, after: { declarationId: row.id, mrn, via, unchanged: true } })
    return { changed: false, declarationId: row.id }
  }
  await tools.tx.customsDeclaration.update({ where: { id: row.id }, data: { status: 'FILED', mrn, updatedAt: tools.now, version: { increment: 1 } }, select: { id: true } })
  tools.audit({ action: 'shipping.recordMrn', recordType: 'Shipment', recordId: shipment.id, companyId: shipment.companyId, siteId: shipment.siteId, before: { status: row.status }, after: { declarationId: row.id, status: 'FILED', mrn, via } })
  changed(tools, shipment, row.id, 'FILED', 'FILED', via)
  return { changed: true, declarationId: row.id }
}

/** POST …/export/declaration/mrn. */
export async function recordMrn(caller: CommandCaller, shipmentId: string, body: { readonly mrn: string; readonly version?: number | undefined }, idempotencyKey?: string) {
  const { shipment } = await customsShipment(caller, shipmentId, SHIPPING_CUSTOMS_MANAGE)
  const mrn = mrnOf(body.mrn)
  if (!mrn) throw new ValidationError('An MRN has 18 characters: two digits of the year, the country (two letters), then 14 letters or digits.', [{ path: 'body/mrn', message: 'Not an MRN.' }])
  const { result } = await command(caller, { name: 'shipping.recordMrn', idempotencyKey, input: { shipmentId, mrn, version: body.version } }, (tools) => fileInCommand(tools, shipment, mrn, 'OFFICE', body.version))
  return result
}

/** POST …/export/declaration/invoice: the issued invoice of the export named once. */
export async function nameInvoice(caller: CommandCaller, shipmentId: string, body: { readonly invoiceId: string; readonly version?: number | undefined }, idempotencyKey?: string) {
  const { shipment } = await customsShipment(caller, shipmentId, SHIPPING_CUSTOMS_MANAGE)
  const { result } = await command(caller, { name: 'shipping.nameCustomsInvoice', idempotencyKey, input: { shipmentId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const row = await lockedDeclaration(tx, shipment.id, body.version)
    if (row.status === 'EXITED') refused('EXITED')
    if (row.invoiceId !== null) {
      if (row.invoiceId !== body.invoiceId) refused('INVOICE_KEPT')
      tools.audit({ action: 'shipping.nameCustomsInvoice', recordType: 'Shipment', recordId: shipment.id, companyId: shipment.companyId, siteId: shipment.siteId, after: { declarationId: row.id, invoiceId: row.invoiceId, unchanged: true } })
      return { changed: false, declarationId: row.id }
    }
    const invoice = isUuid(body.invoiceId) ? await tx.invoice.findUnique({ where: { id: body.invoiceId }, select: { id: true, companyId: true, buyerPartyId: true, status: true, docType: true, number: true } }) : null
    if (!invoice || invoice.companyId !== row.companyId || invoice.buyerPartyId !== row.partyId || invoice.status === 'DRAFT' || (invoice.docType !== 'TD01' && invoice.docType !== 'TD24')) refused('INVOICE')
    await tx.customsDeclaration.update({ where: { id: row.id }, data: { invoiceId: invoice!.id, updatedAt: now, version: { increment: 1 } }, select: { id: true } })
    tools.audit({ action: 'shipping.nameCustomsInvoice', recordType: 'Shipment', recordId: shipment.id, companyId: shipment.companyId, siteId: shipment.siteId, after: { declarationId: row.id, invoiceId: invoice!.id, number: invoice!.number } })
    changed(tools, shipment, row.id, 'INVOICE_NAMED', row.status as DeclarationStatus, 'OFFICE')
    return { changed: true, declarationId: row.id }
  })
  return result
}

export interface ExitBody {
  /** When the customs office of exit confirmed it (ISO 8601 with a zone). */
  readonly exitConfirmedAt: string
  /** The proof: a file uploaded on the declaration (recordType CustomsDeclaration, recordId its id). */
  readonly fileId: string
  readonly version?: number | undefined
}

/** POST …/export/declaration/exit: EXITED with when and the proof, against the named invoice. */
export async function confirmExit(caller: CommandCaller, shipmentId: string, body: ExitBody, idempotencyKey?: string) {
  const { shipment } = await customsShipment(caller, shipmentId, SHIPPING_CUSTOMS_MANAGE)
  const at = parseInstant(body.exitConfirmedAt)
  if (!at) throw new ValidationError('Give when the exit was confirmed (date and time).', [{ path: 'body/exitConfirmedAt', message: 'Expected ISO 8601 with a zone.' }])
  const { result } = await command(caller, { name: 'shipping.confirmExit', idempotencyKey, input: { shipmentId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const row = await lockedDeclaration(tx, shipment.id, body.version)
    if (row.status === 'EXITED') {
      if (row.exitFileId !== body.fileId || row.exitConfirmedAt?.getTime() !== at.getTime()) refused('EXITED')
      tools.audit({ action: 'shipping.confirmExit', recordType: 'Shipment', recordId: shipment.id, companyId: shipment.companyId, siteId: shipment.siteId, after: { declarationId: row.id, unchanged: true } })
      return { changed: false, declarationId: row.id }
    }
    if (row.status !== 'FILED' || row.mrn === null) refused('NOT_FILED')
    if (row.invoiceId === null) refused('NO_INVOICE')
    const invoice = await tx.invoice.findUnique({ where: { id: row.invoiceId }, select: { status: true } })
    if (!invoice || invoice.status === 'DRAFT') refused('INVOICE')
    const current = await tx.shipment.findUniqueOrThrow({ where: { id: shipment.id }, select: { status: true, shippedAt: true } })
    if ((current.status !== 'SHIPPED' && current.status !== 'DELIVERED') || current.shippedAt === null) refused('NOT_LEFT')
    if (at.getTime() < current.shippedAt!.getTime() || at.getTime() > (await databaseNow(tools)).getTime()) refused('EXIT_TIME')
    const file = isUuid(body.fileId) ? await tx.storedFile.findFirst({ where: { id: body.fileId, recordType: 'CustomsDeclaration', recordId: row.id, companyId: row.companyId, status: 'AVAILABLE' }, select: { id: true, originalName: true } }) : null
    if (!file) refused('PROOF_FILE')
    await tx.customsDeclaration.update({ where: { id: row.id }, data: { status: 'EXITED', exitConfirmedAt: at, exitFileId: file!.id, updatedAt: now, version: { increment: 1 } }, select: { id: true } })
    tools.audit({ action: 'shipping.confirmExit', recordType: 'Shipment', recordId: shipment.id, companyId: shipment.companyId, siteId: shipment.siteId, before: { status: row.status }, after: { declarationId: row.id, status: 'EXITED', exitConfirmedAt: toUtcIso(at), exitFileId: file!.id, invoiceId: row.invoiceId } })
    changed(tools, shipment, row.id, 'EXITED', 'EXITED', 'OFFICE')
    return { changed: true, declarationId: row.id }
  })
  return result
}

/** DELETE …/export/declaration: a pack sent by mistake (PACK_SENT only), its broker links revoked with it. */
export async function removeDeclaration(caller: CommandCaller, shipmentId: string, query: { readonly version?: number | undefined; readonly reason?: string | undefined }, idempotencyKey?: string) {
  const { context, shipment } = await customsShipment(caller, shipmentId, SHIPPING_CUSTOMS_MANAGE)
  const reason = query.reason?.trim() ? query.reason.trim().slice(0, 500) : null
  const { result } = await command(caller, { name: 'shipping.removeCustomsDeclaration', idempotencyKey, input: { shipmentId, version: query.version, reason } }, async (tools) => {
    const { tx, now } = tools
    const row = await lockedDeclaration(tx, shipment.id, query.version)
    if (row.status !== 'PACK_SENT') refused(row.status === 'EXITED' ? 'EXITED' : 'KEPT')
    const links = await tx.oneOffLink.findMany({ where: { purpose: 'BROKER_PACK', recordType: 'CustomsDeclaration', recordId: row.id, revokedAt: null }, select: { id: true } })
    if (links.length > 0) {
      await tx.oneOffLink.updateMany({ where: { id: { in: links.map((link) => link.id) }, revokedAt: null }, data: { revokedAt: now, revokedById: context.actorId, updatedAt: now } })
      for (const link of links) tools.audit({ action: 'links.revoke', recordType: 'OneOffLink', recordId: link.id, companyId: row.companyId, after: { revokedAt: toUtcIso(now), by: 'shipping.removeCustomsDeclaration' } })
    }
    await tx.customsDeclaration.delete({ where: { id: row.id }, select: { id: true } })
    tools.audit({ action: 'shipping.removeCustomsDeclaration', recordType: 'Shipment', recordId: shipment.id, companyId: shipment.companyId, siteId: shipment.siteId, before: { declarationId: row.id, status: row.status, brokerPartyId: row.brokerPartyId }, after: { removed: true, linksRevoked: links.length }, ...(reason ? { reason } : {}) })
    changed(tools, shipment, row.id, 'REMOVED', null, 'OFFICE')
    return { removed: true, linksRevoked: links.length }
  })
  return result
}
