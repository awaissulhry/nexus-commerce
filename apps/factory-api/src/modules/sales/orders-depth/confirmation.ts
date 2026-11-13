import { DomainError, InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { composeDocument } from '@nexus/factory-domain/documents/compose'
import { formatMoney } from '@nexus/factory-domain/documents/format'
import { legalProblems } from '@nexus/factory-domain/documents/legal'
import type { DocumentLanguage, PostalAddress } from '@nexus/factory-domain/documents/model'
// B-W2b-374: the lines' options on the confirmation.
import { orderLinesPrinted } from '../configurator/printed'
import { CONFIRMATION_KIND, confirmationDocument, confirmationFingerprint, confirmationMail, confirmationNumber, ppeWords, type CustomerOrder } from '@nexus/factory-domain/sales/orders-depth/confirmation'
import { incotermWords } from '@nexus/factory-domain/sales/quote-terms/rules'
import { quoteDocumentNumber } from '@nexus/factory-domain/sales/quotes/document'
import { ORDERS_MANAGE } from '@nexus/factory-domain/sales/orders/permissions'
import { priceBasisOf, priceText } from '@nexus/factory-domain/sales/quotes/quotes'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { companyLegalOf, documentFileName } from '../../../platform/documents/documents'
import { renderDocumentPdf } from '../../../platform/documents/pdf'
import { sendEmail } from '../../../platform/email-out/outbound'
import { putGeneratedFile, recordGeneratedFile, type PreparedGeneratedFile } from '../../../platform/files/files'
import type { FilesRuntime } from '../../../platform/files/service'
import { ORDER_DEPOSIT_ONLY } from '../deposits/deposits'
import { officeContextOf } from '../orders/access'
import { officeOrder } from '../orders/moves'
import { readLines, readOrder, type OrderRow, type Reader } from '../orders/store'
import { discountShownFor } from '../pricing-depth/store'

/**
 * The order confirmation (B-W2b-303; SAL-208 "W1 emailed accepted quote confirms the order; confirmation PDF later"; design
 * order.docs.confirmation "PdfViewer of the latest · Sent to, when · Send… · Make confirmation"; orders list "Print
 * confirmation"). A version per order (GeneratedDocument ORDER_CONFIRMATION 1, 2, …) with its PDF (a StoredFile of the order,
 * shared with its customer so a mail may carry it); prices only, by the order's basis, the discount shown only where its price
 * list shows it (B-W2b-325's discountShownFor). Never while the order waits for a yes, nor for a cancelled one.
 *
 *   GET  /sales/orders/:orderId/confirmation        orders.view: the versions, which one was sent and when, whether the newest
 *                                                    still shows the order as it is now
 *   POST /sales/orders/:orderId/confirmation        orders.manage: keeps a version of the order as it is ({language?});
 *                                                    the same contents as the newest give it back (made: false)
 *   POST /sales/orders/:orderId/confirmation/send   orders.manage: mails a version on the order's thread (FAKE locally),
 *                                                    making one first when none shows the order as it is; then
 *                                                    confirmationSentAt + confirmationVersion together (never back)
 *
 * Making a version: the facts read and composed; its fingerprint (factory-domain confirmationFingerprint: without the day and
 * the version) against the newest; the PDF put in the store OUTSIDE any transaction; ONE command under the order's
 * confirmation lock: the StoredFile row, the GeneratedDocument row, audit and sales_order.confirmation_made.
 */

const NOT_NOW = new Set(['PENDING_APPROVAL', 'CANCELLED'])

const dayOf = (value: Date): BusinessDate => value.toISOString().slice(0, 10)

interface Snapshot {
  readonly legalName?: unknown
  readonly vatNumber?: unknown
  readonly fiscalCode?: unknown
  readonly address?: unknown
  readonly name?: unknown
}

const str = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null)

function postalOf(value: unknown): PostalAddress | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  const line1 = str(row.line1)
  const postalCode = str(row.postalCode)
  const city = str(row.city)
  const country = str(row.country)
  if (!line1 || !postalCode || !city || !country) return null
  return { line1, line2: str(row.line2), postalCode, city, province: str(row.province), country }
}

/** The order as its confirmation prints it on `date`, version `version`. */
async function customerOrderOf(db: Reader, order: OrderRow, version: number, date: BusinessDate, language: DocumentLanguage): Promise<CustomerOrder> {
  const extra = await db.salesOrder.findUniqueOrThrow({ where: { id: order.id }, select: { incoterm: true, incotermPlace: true, shipComplete: true, seasonId: true } })
  const lines = await readLines(db, order.id)
  const steps = new Map((lines.length === 0 ? [] : await db.salesOrderLine.findMany({ where: { id: { in: lines.map((line) => line.id) } }, select: { id: true, priceSteps: true } })).map((row) => [row.id, row.priceSteps]))
  const styles = new Map((await db.style.findMany({ where: { id: { in: [...new Set(lines.map((line) => line.styleId))] } }, select: { id: true, code: true, name: true, sizes: true, ppeCategory: true, ppeStandard: true, ppeClass: true } })).map((row) => [row.id, row]))
  const colourways = new Map((await db.colourway.findMany({ where: { id: { in: [...new Set(lines.map((line) => line.colourwayId))] } }, select: { id: true, code: true } })).map((row) => [row.id, row.code]))
  const deliveries = lines.length === 0 ? [] : await db.salesOrderLineDelivery.findMany({ where: { lineId: { in: lines.map((line) => line.id) } }, select: { lineId: true, deliveryDate: true, quantity: true }, orderBy: [{ deliveryDate: 'asc' }, { id: 'asc' }] })
  const version_ = order.quoteVersionId ? await db.quoteVersion.findUnique({ where: { id: order.quoteVersionId }, select: { revision: true, priceListVersionId: true, quote: { select: { number: true, contactId: true } } } }) : null
  const showDiscount = await discountShownFor(db, version_?.priceListVersionId ?? null)
  const season = extra.seasonId ? await db.season.findUnique({ where: { id: extra.seasonId }, select: { code: true, name: true } }) : null
  const contactId = version_?.quote.contactId ?? null
  const contact = contactId
    ? await db.partyContact.findUnique({ where: { id: contactId }, select: { email: true } })
    : await db.partyContact.findFirst({ where: { partyId: order.partyId, status: 'ACTIVE', roles: { has: 'ORDERS' }, email: { not: null } }, select: { email: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  const deposit = await db.depositRequest.findFirst({ where: { orderId: order.id, status: { in: ['OPEN', 'PAID'] }, ...ORDER_DEPOSIT_ONLY }, select: { amount: true, kind: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  const billTo = (order.billTo ?? {}) as Snapshot
  const shipTo = order.shipTo as Snapshot | null
  const shipAddress = postalOf(shipTo)
  const first = lines[0]
  // B-W2b-374 (XF3:03): the lines' options as printed (a line without any leaves the fingerprint as it was).
  const options = await orderLinesPrinted(db, lines.map((line) => line.id), language)
  return {
    number: order.number,
    version,
    date,
    language,
    currency: order.currency,
    priceBasis: priceBasisOf(order.taxMode),
    orderDate: dayOf(order.orderDate),
    customerRef: order.customerRef,
    quoteNumber: version_ ? quoteDocumentNumber(version_.quote.number, version_.revision) : null,
    promiseDate: order.promiseDate ? dayOf(order.promiseDate) : null,
    paymentTerms: order.paymentTerms,
    deliveryTerms: incotermWords(extra.incoterm, extra.incotermPlace, language),
    shipComplete: extra.shipComplete,
    season: season ? { code: season.code, name: season.name } : null,
    party: { name: str(billTo.legalName) ?? '', address: postalOf(billTo.address), vatNumber: str(billTo.vatNumber), fiscalCode: str(billTo.fiscalCode), email: contact?.email ?? null },
    shipTo: shipAddress ? { ...shipAddress, name: str(shipTo?.name) } : null,
    lines: lines.map((line) => {
      const style = styles.get(line.styleId)
      const range = style?.sizes ?? []
      const list = Array.isArray(steps.get(line.id)) ? (steps.get(line.id) as { kind?: unknown; unitPrice?: unknown }[])[0] : undefined
      return {
        seq: line.seq,
        code: [style?.code, colourways.get(line.colourwayId)].filter(Boolean).join(' '),
        description: line.description ?? style?.name ?? '',
        note: line.note,
        ppe: style ? ppeWords(style, language) : null,
        quantity: line.quantity,
        unitPrice: priceText(line.unitPrice.toString()),
        listUnitPrice: showDiscount && list?.kind === 'LIST' && typeof list.unitPrice === 'string' ? priceText(list.unitPrice) : null,
        netAmount: line.netAmount,
        vatAmount: line.vatAmount,
        sizes: [...line.sizes].sort((a, b) => range.indexOf(a.size) - range.indexOf(b.size)).map((size) => ({ size: size.size, quantity: size.quantity, unitPrice: size.unitPrice === null ? null : priceText(size.unitPrice.toString()) })),
        deliveries: deliveries.filter((row) => row.lineId === line.id).map((row) => ({ date: dayOf(row.deliveryDate), quantity: row.quantity })),
        ...(options.get(line.id)?.length ? { options: options.get(line.id)! } : {}),
      }
    }),
    totals: { net: order.netAmount, vat: first ? [{ rate: first.vatNature ? null : first.vatRatePct.toFixed(2), nature: first.vatNature, taxable: order.netAmount, vat: order.vatAmount }] : [], gross: order.grossAmount },
    deposit: deposit ? { amount: deposit.amount, kind: deposit.kind } : null,
  }
}

const languageOf = (order: Pick<OrderRow, 'language'>, asked?: DocumentLanguage): DocumentLanguage => asked ?? (order.language === 'en' ? 'en' : 'it')

interface Prepared {
  readonly fingerprint: string
  readonly language: DocumentLanguage
  readonly current: { readonly id: string; readonly version: number; readonly fileId: string } | null
  readonly file: PreparedGeneratedFile | null
  readonly layout: string | null
}

const VERSION_COLUMNS = { id: true, version: true, fingerprint: true, language: true, fileId: true, number: true, createdAt: true, createdById: true } as const

/** Prepares the order's confirmation OUTSIDE any transaction (the store put); refused in words while it may not have one. */
async function prepare(files: FilesRuntime, caller: CommandCaller, order: OrderRow, asked: DocumentLanguage | undefined): Promise<Prepared> {
  if (NOT_NOW.has(order.status)) throw new InvalidStateError(order.status === 'PENDING_APPROVAL' ? `${order.number} waits for a yes: its confirmation is made once it goes on.` : `${order.number} is cancelled: it has no confirmation.`)
  const company = await companyLegalOf(caller, order.companyId)
  const problems = legalProblems(company)
  if (problems.length > 0) throw new DomainError('conflict', problems.length === 1 ? problems[0]!.message : "The company's letterhead is not complete: the confirmation cannot be printed.", problems)
  const language = languageOf(order, asked)
  const today = businessDate(serverClock.now())
  const { versions, draft } = await caller.withClient(async (db) => {
    const rows = await db.generatedDocument.findMany({ where: { recordType: 'SalesOrder', recordId: order.id, kind: CONFIRMATION_KIND }, select: VERSION_COLUMNS, orderBy: { version: 'desc' } })
    return { versions: rows, draft: await customerOrderOf(db, order, (rows[0]?.version ?? 0) + 1, today, language) }
  })
  const fingerprint = confirmationFingerprint(draft)
  const newest = versions[0]
  if (newest && newest.fingerprint === fingerprint && newest.language === language) return { fingerprint, language, current: { id: newest.id, version: newest.version, fileId: newest.fileId }, file: null, layout: null }
  const composed = composeDocument({ ...confirmationDocument(draft, (minor) => formatMoney(minor, order.currency, language)), company, sample: false })
  const pdf = await renderDocumentPdf(composed)
  const file = await putGeneratedFile(files, caller, {
    companyId: order.companyId,
    recordType: 'SalesOrder',
    recordId: order.id,
    kind: 'DOCUMENT',
    originalName: documentFileName(composed),
    contentType: 'application/pdf',
    body: pdf,
    // The confirmation mail's attachment: shared with the customer's party (prices only).
    visibility: ['OFFICE', 'PARTNER'],
    partyId: order.partyId,
  })
  return { fingerprint, language, current: null, file, layout: composed.layout }
}

/** Keeps a prepared version in the caller's command (the order's confirmation lock), or answers the newest unchanged. */
async function keepInCommand(tools: CommandTools, order: OrderRow, prepared: Prepared): Promise<{ id: string; version: number; fileId: string; made: boolean }> {
  const { tx } = tools
  if (prepared.current) return { ...prepared.current, made: false }
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.order-confirmation', ${order.id}::uuid), 0))`
  const last = await tx.generatedDocument.findFirst({ where: { recordType: 'SalesOrder', recordId: order.id, kind: CONFIRMATION_KIND }, select: VERSION_COLUMNS, orderBy: { version: 'desc' } })
  if (last && last.fingerprint === prepared.fingerprint && last.language === prepared.language) return { id: last.id, version: last.version, fileId: last.fileId, made: false }
  const file = await recordGeneratedFile(tools, prepared.file!)
  const id = newId()
  const version = (last?.version ?? 0) + 1
  await tx.generatedDocument.create({
    data: { id, companyId: order.companyId, siteId: null, recordType: 'SalesOrder', recordId: order.id, kind: CONFIRMATION_KIND, version, fingerprint: prepared.fingerprint, language: prepared.language, layout: prepared.layout, number: confirmationNumber(order.number, version), fileId: file.id, createdAt: tools.now, createdById: tools.context.audience === 'office' ? tools.context.actorId : null },
    select: { id: true },
  })
  tools.audit({ action: 'orders.confirmation', recordType: 'SalesOrder', recordId: order.id, companyId: order.companyId, after: { generatedDocumentId: id, version, language: prepared.language, fileId: file.id, fingerprint: prepared.fingerprint } })
  tools.emit({ type: 'sales_order.confirmation_made', subject: order.id, companyId: order.companyId, payload: { orderId: order.id, number: order.number, version, generatedDocumentId: id, fileId: file.id } })
  return { id, version, fileId: file.id, made: true }
}

async function readState(caller: CommandCaller, order: OrderRow) {
  return caller.withClient(async (db) => {
    const rows = await db.generatedDocument.findMany({ where: { recordType: 'SalesOrder', recordId: order.id, kind: CONFIRMATION_KIND }, select: VERSION_COLUMNS, orderBy: { version: 'desc' } })
    const sent = await db.salesOrder.findUniqueOrThrow({ where: { id: order.id }, select: { confirmationSentAt: true, confirmationVersion: true, status: true, version: true } })
    const names = new Map((await db.user.findMany({ where: { id: { in: rows.flatMap((row) => (row.createdById ? [row.createdById] : [])) } }, select: { id: true, displayName: true } })).map((row) => [row.id, row.displayName]))
    let upToDate: boolean | null = null
    if (rows[0] && !NOT_NOW.has(sent.status)) {
      const fresh = (await readOrder(db, order.id))!
      upToDate = confirmationFingerprint(await customerOrderOf(db, fresh, rows[0].version, businessDate(serverClock.now()), rows[0].language === 'en' ? 'en' : 'it')) === rows[0].fingerprint
    }
    return {
      orderId: order.id,
      number: order.number,
      status: sent.status,
      orderVersion: sent.version,
      sentAt: sent.confirmationSentAt ? toUtcIso(sent.confirmationSentAt) : null,
      sentVersion: sent.confirmationVersion,
      upToDate,
      mayMake: !NOT_NOW.has(sent.status),
      versions: rows.map((row) => ({ id: row.id, version: row.version, number: row.number, language: row.language, fileId: row.fileId, createdAt: toUtcIso(row.createdAt), createdBy: row.createdById ? (names.get(row.createdById) ?? null) : null, sent: row.version === sent.confirmationVersion })),
    }
  })
}

/** GET /sales/orders/:orderId/confirmation */
export async function getConfirmation(caller: CommandCaller, orderId: string) {
  const order = await officeOrder(caller, orderId)
  return { confirmation: await readState(caller, order) }
}

/** POST /sales/orders/:orderId/confirmation */
export async function makeConfirmation(files: FilesRuntime, caller: CommandCaller, orderId: string, body: { readonly language?: DocumentLanguage | undefined }, idempotencyKey?: string) {
  const order = await officeOrder(caller, orderId, ORDERS_MANAGE)
  const prepared = await prepare(files, caller, order, body.language)
  const result = prepared.current ? { ...prepared.current, made: false } : (await command(caller, { name: 'orders.confirmation', idempotencyKey, input: { orderId, ...body } }, (tools) => keepInCommand(tools, order, prepared))).result
  return { made: result.made, version: result.version, fileId: result.fileId, confirmation: await readState(caller, order) }
}

export interface SendConfirmationBody {
  readonly to?: readonly string[] | undefined
  readonly cc?: readonly string[] | undefined
  readonly subject?: string | null | undefined
  readonly message?: string | null | undefined
  readonly language?: DocumentLanguage | undefined
}

/** POST /sales/orders/:orderId/confirmation/send */
export async function sendConfirmation(files: FilesRuntime, caller: CommandCaller, orderId: string, body: SendConfirmationBody, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const order = await officeOrder(caller, orderId, ORDERS_MANAGE)
  const prepared = await prepare(files, caller, order, body.language)
  const recipient = await caller.withClient(async (db) => {
    const version = order.quoteVersionId ? await db.quoteVersion.findUnique({ where: { id: order.quoteVersionId }, select: { quote: { select: { contactId: true } } } }) : null
    const contact = version?.quote.contactId
      ? await db.partyContact.findUnique({ where: { id: version.quote.contactId }, select: { name: true, email: true } })
      : await db.partyContact.findFirst({ where: { partyId: order.partyId, status: 'ACTIVE', roles: { has: 'ORDERS' }, email: { not: null } }, select: { name: true, email: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
    const sender = await db.user.findUnique({ where: { id: context.actorId }, select: { id: true, displayName: true, email: true } })
    return { contact, sender }
  })
  const to = body.to && body.to.length > 0 ? [...body.to] : recipient.contact?.email ? [recipient.contact.email] : []
  if (to.length === 0) throw new ValidationError("The customer has no orders contact with an e-mail address: give the address to send to.", [{ path: 'body/to', message: 'Give at least one address.' }])
  if (!recipient.sender) throw new NotFoundError('Your user was not found.')
  const { result } = await command(caller, { name: 'orders.sendConfirmation', idempotencyKey, input: { orderId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const locked = await tx.$queryRaw<{ status: string }[]>`SELECT status::text AS status FROM "SalesOrder" WHERE id = ${order.id}::uuid FOR UPDATE`
    if (!locked[0] || NOT_NOW.has(locked[0].status)) throw new InvalidStateError(`${order.number} may not be confirmed now.`)
    const kept = await keepInCommand(tools, order, prepared)
    const number = confirmationNumber(order.number, kept.version)
    const mail = confirmationMail({ language: prepared.language, number, recipientName: body.to && body.to.length > 0 ? null : (recipient.contact?.name ?? null), message: body.message ?? null })
    const sent = await sendEmail(tools, {
      record: { type: 'SalesOrder', id: order.id },
      sender: { userId: recipient.sender!.id, name: recipient.sender!.displayName, email: recipient.sender!.email },
      to,
      cc: body.cc,
      subject: body.subject?.trim() ? body.subject.trim() : mail.subject,
      body: mail.body,
      attachments: [kept.fileId],
      locale: prepared.language,
    })
    const before = await tx.salesOrder.findUniqueOrThrow({ where: { id: order.id }, select: { confirmationSentAt: true, confirmationVersion: true } })
    await tx.salesOrder.update({ where: { id: order.id }, data: { confirmationSentAt: now, confirmationVersion: kept.version, updatedAt: now, version: { increment: 1 } }, select: { id: true } })
    tools.audit({ action: 'orders.sendConfirmation', recordType: 'SalesOrder', recordId: order.id, companyId: order.companyId, before: { confirmationSentAt: before.confirmationSentAt ? toUtcIso(before.confirmationSentAt) : null, confirmationVersion: before.confirmationVersion }, after: { confirmationSentAt: toUtcIso(now), confirmationVersion: kept.version, outboundId: sent.outbound.id, to } })
    tools.emit({ type: 'sales_order.confirmation_sent', subject: order.id, companyId: order.companyId, payload: { orderId: order.id, number: order.number, version: kept.version, outboundId: sent.outbound.id } })
    return { version: kept.version, made: kept.made, outboundId: sent.outbound.id, threadId: sent.thread.id }
  })
  return { ...result, confirmation: await readState(caller, order) }
}
