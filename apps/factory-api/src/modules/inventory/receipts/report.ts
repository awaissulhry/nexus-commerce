import PDFDocument from 'pdfkit'
import { DomainError, InvalidStateError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { addressLine, legalFooter, legalLines, legalName, legalProblems } from '@nexus/factory-domain/documents/legal'
import type { DocumentLanguage } from '@nexus/factory-domain/documents/model'
import { INVENTORY_STOCK_VIEW } from '@nexus/factory-domain/inventory/permissions'
import { DISCREPANCY_LIMITS, reportSelection, type DiscrepancyStatus } from '@nexus/factory-domain/inventory/receipts/discrepancies'
import { INVENTORY_DISCREPANCIES_REPORT } from '@nexus/factory-domain/inventory/receipts/permissions'
import { discrepancyReport, discrepancyReportMail, type DiscrepancyReport, type ReportLine } from '@nexus/factory-domain/inventory/receipts/report'
import { identityAt } from '@nexus/factory-domain/parties/tax'
import { supplierLanguageOf } from '@nexus/factory-domain/purchasing/orders'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { companyLegalOf } from '../../../platform/documents/documents'
import { PDF_CREATOR, winAnsi } from '../../../platform/documents/pdf'
import { sendEmail } from '../../../platform/email-out/outbound'
import { putGeneratedFile, recordGeneratedFile, type PreparedGeneratedFile } from '../../../platform/files/files'
import { processFiles } from '../../../platform/files/service'
import { TAX_COLUMNS, taxFieldsOf } from '../../parties/store'
import type { OfficeContext } from '../../../core/context'
import { DISCREPANCY_COLUMNS, discrepancyViews, type DiscrepancyView } from './discrepancies'
import { visibleReceipt } from './read'
import { byId, ids, type Reader, type ReceiptRow } from './store'

/**
 * The discrepancy report to the supplier (B-W2a-31; SCM-118; design warehouse.receipts pop rc-disc-send "the PDF preview
 * · recipients from the supplier's contacts · message", tab rc-tab-disc): the receipt's discrepancies as a PDF without
 * prices (Owner answer C2), composed in the supplier's language by factory-domain inventory/receipts/report and painted
 * here on A4 with pdfkit (the documents platform's standard fonts and WinAnsi rule), sent by e-mail on the receipt's
 * thread (GoodsReceipt: the supplier's party, so its reply comes back to the receipt). E-mail leaves through email out
 * (the worker delivers a QUEUED mail; FAKE SES locally and in tests): this step adds no real provider.
 *
 *   GET  /inventory/receipts/:receiptId/discrepancy-report?ids=&language=   inventory.stock.view: the PDF, with the
 *        "preview" banner, made in memory and stored nowhere (default: the OPEN discrepancies, the supplier's language)
 *   GET  /inventory/receipts/:receiptId/discrepancy-report/check?ids=       inventory.discrepancies.report: what the send
 *        would do — the discrepancies, the supplier's contacts with an e-mail (QUALITY and ORDERS first), the language,
 *        the subject and the standard text, and why it cannot go yet
 *   POST /inventory/receipts/:receiptId/discrepancy-report                  inventory.discrepancies.report:
 *        {discrepancyIds?, contactIds, cc?, subject?, message?, language?}
 *
 * The send: (1) outside any transaction, the PDF (sample false) put in the file store as a DOCUMENT of the GoodsReceipt
 * shared with the supplier's party (it is the mail's attachment); (2) ONE command under the receipt's discrepancy lock
 * (`factory.receipt-discrepancy|company|receipt`, as a new discrepancy): the discrepancies read again — any that changed
 * since the PDF was made refuses the send (409, send it again) — the file's row, every OPEN one it names moved to SENT
 * (sentAt, sentById), one already SENT left as it is (a reminder), the mail QUEUED on the receipt's thread with the PDF,
 * `inventory.receipt_discrepancies_reported`. A repeated Idempotency-Key answers the first send (no second mail).
 */

const REGULAR = 'Helvetica'
const BOLD = 'Helvetica-Bold'
const TEXT = '#111111'
const MUTED = '#555555'
const RULE = '#9a9a9a'
const SHADE = '#ececec'
const MARGIN = { top: 40, bottom: 60, left: 42, right: 42 } as const
const FOOTER_TOP = 50

/** The report's PDF (the same report gives the same bytes). */
export async function renderDiscrepancyReport(report: DiscrepancyReport): Promise<Buffer> {
  const pdf = new PDFDocument({
    size: 'A4',
    margins: MARGIN,
    bufferPages: true,
    compress: true,
    lang: report.language,
    displayTitle: true,
    info: { Title: winAnsi(report.meta.title), Subject: winAnsi(report.meta.subject), Creator: PDF_CREATOR, Producer: PDF_CREATOR, CreationDate: new Date(report.meta.createdAt) },
  })
  const chunks: Buffer[] = []
  pdf.on('data', (chunk: Buffer) => chunks.push(chunk))
  const ended = new Promise<void>((resolve, reject) => {
    pdf.on('end', () => resolve())
    pdf.on('error', reject)
  })
  paint(pdf, report)
  pdf.end()
  await ended
  return Buffer.concat(chunks)
}

function paint(pdf: PDFKit.PDFDocument, report: DiscrepancyReport): void {
  const left = MARGIN.left
  const right = pdf.page.width - MARGIN.right
  const width = right - left
  const bottom = (): number => pdf.page.height - MARGIN.bottom
  const text = (value: string, x: number, y: number, options: PDFKit.Mixins.TextOptions & { font?: string; size?: number; color?: string } = {}): number => {
    const { font = REGULAR, size = 9, color = TEXT, ...rest } = options
    pdf.font(font).fontSize(size).fillColor(color).text(winAnsi(value), x, y, { lineGap: 1, ...rest })
    return pdf.y
  }
  const heightOf = (value: string, w: number, font = REGULAR, size = 9): number => pdf.font(font).fontSize(size).heightOfString(winAnsi(value), { width: w, lineGap: 1 })

  // Our company and its art. 2250 lines; the title on the right.
  const companyWidth = Math.round(width * 0.55)
  let y: number = MARGIN.top
  y = text(report.company.name, left, y, { font: BOLD, size: 12, width: companyWidth })
  for (const line of report.company.lines) y = text(line, left, y + 0.5, { size: 7.5, color: MUTED, width: companyWidth })
  const titleLeft = left + companyWidth + 12
  const titleY = text(report.title, titleLeft, MARGIN.top, { font: BOLD, size: 13, width: right - titleLeft, align: 'right' })
  y = Math.max(y, titleY) + 10

  if (report.sample) {
    const height = heightOf(report.sample, width - 12, BOLD, 10) + 10
    pdf.save().rect(left, y, width, height).fillColor('#fde8e8').fill().restore()
    text(report.sample, left + 6, y + 5, { font: BOLD, size: 10, color: '#a40000', width: width - 12, align: 'center' })
    y += height + 8
  }

  // The supplier on the left, the receipt's facts on the right.
  const halfWidth = (width - 16) / 2
  const supplierTop = y
  let supplierY = text(report.supplier.label, left, y, { size: 7, color: MUTED, width: halfWidth })
  for (const [index, line] of report.supplier.lines.entries()) supplierY = text(line, left, supplierY + 1, { font: index === 0 ? BOLD : REGULAR, size: index === 0 ? 10 : 8.5, width: halfWidth })
  let factsY = supplierTop
  const factsLeft = left + halfWidth + 16
  for (const fact of report.facts) {
    text(fact.label, factsLeft, factsY, { size: 7.5, color: MUTED, width: halfWidth * 0.42 })
    factsY = Math.max(factsY + heightOf(fact.label, halfWidth * 0.42, REGULAR, 7.5), text(fact.value, factsLeft + halfWidth * 0.44, factsY, { font: BOLD, size: 8.5, width: halfWidth * 0.56 })) + 2
  }
  y = Math.max(supplierY, factsY) + 12
  y = text(report.intro, left, y, { size: 9, width }) + 10

  const columns = report.columns.map((column) => ({ ...column, width: width * column.width }))
  const header = (at: number): number => {
    const height = Math.max(...columns.map((column) => heightOf(column.label, column.width - 6, BOLD, 8))) + 6
    pdf.save().rect(left, at, width, height).fillColor(SHADE).fill().restore()
    let x = left
    for (const column of columns) {
      text(column.label, x + 3, at + 3, { font: BOLD, size: 8, width: column.width - 6, align: column.align })
      x += column.width
    }
    return at + height
  }
  const newPage = (): number => {
    pdf.addPage()
    return text(`${report.company.name} · ${report.title}`, left, MARGIN.top, { size: 8, color: MUTED, width }) + 8
  }
  y = header(y)
  for (const row of report.rows) {
    const height = Math.max(...columns.map((column) => heightOf(row[column.key], column.width - 6, REGULAR, 8.5))) + 6
    if (y + height > bottom()) y = header(newPage())
    let x = left
    for (const column of columns) {
      text(row[column.key], x + 3, y + 3, { size: 8.5, width: column.width - 6, align: column.align })
      x += column.width
    }
    y += height
    pdf.save().moveTo(left, y).lineTo(right, y).lineWidth(0.4).strokeColor(RULE).stroke().restore()
  }
  y += 12
  if (y + heightOf(report.closing, width, REGULAR, 8.5) > bottom()) y = newPage()
  text(report.closing, left, y, { size: 8.5, color: MUTED, width })

  const range = pdf.bufferedPageRange()
  for (let index = range.start; index < range.start + range.count; index++) {
    pdf.switchToPage(index)
    const savedBottom = pdf.page.margins.bottom
    pdf.page.margins.bottom = 0
    const top = pdf.page.height - FOOTER_TOP
    pdf.save().moveTo(left, top).lineTo(right, top).lineWidth(0.4).strokeColor(RULE).stroke().restore()
    text(report.company.legal, left, top + 4, { size: 6.5, color: MUTED, width: width - 90 })
    text(report.page(index - range.start + 1, range.count), right - 86, top + 4, { size: 7.5, color: MUTED, width: 86, align: 'right' })
    pdf.page.margins.bottom = savedBottom
  }
}

/** The PDF shown in the page (a new tab opens it too): inline, with the report's own file name (as the PO preview's). */
export function inlineDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  const encoded = encodeURIComponent(fileName).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  return `inline; filename="${ascii}"; filename*=UTF-8''${encoded}`
}

// ---- the facts ---------------------------------------------------------------------------------------------------------------

/** The discrepancies a report names (`ids`, else every OPEN one) and the receipt's facts it prints. */
async function reportFacts(db: Reader, receipt: ReceiptRow, ids_: readonly string[] | null) {
  const views = await discrepancyViews(db, receipt.id)
  const selection = reportSelection(views.map((view) => ({ id: view.id, seq: view.seq, status: view.status as DiscrepancyStatus })), ids_)
  const site = await db.site.findUniqueOrThrow({ where: { id: receipt.siteId }, select: { code: true, name: true } })
  const party = await db.party.findUniqueOrThrow({ where: { id: receipt.supplierId }, select: { id: true, legalName: true, language: true, status: true } })
  const addresses = await db.partyAddress.findMany({
    where: { partyId: party.id, status: 'ACTIVE' },
    select: { kinds: true, isDefaultBillTo: true, line1: true, line2: true, postalCode: true, city: true, province: true, country: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  const address = addresses.find((row) => row.kinds.includes('REGISTERED')) ?? addresses.find((row) => row.isDefaultBillTo) ?? addresses[0] ?? null
  const identity = identityAt((await db.partyTaxIdentity.findMany({ where: { partyId: party.id }, select: TAX_COLUMNS })).map(taxFieldsOf), businessDate(serverClock.now()))
  const contacts = await db.partyContact.findMany({ where: { partyId: party.id, status: 'ACTIVE', email: { not: null } }, select: { id: true, name: true, email: true, roles: true, language: true }, orderBy: [{ name: 'asc' }, { id: 'asc' }] })
  const order = receipt.purchaseOrderId ? await db.purchaseOrder.findUnique({ where: { id: receipt.purchaseOrderId }, select: { number: true } }) : null
  // The order line and the supplier's article code each discrepancy's line received against.
  const lineIds = ids(views.map((view) => view.receiptLine?.purchaseOrderLineId))
  const orderLines = byId(await db.purchaseOrderLine.findMany({ where: { id: { in: lineIds } }, select: { id: true, seq: true, supplierArticleCode: true } }))
  return { views, selection, site, party, address, identity, contacts, order, orderLines }
}
type Facts = Awaited<ReturnType<typeof reportFacts>>

const QUALITY_FIRST = (roles: readonly string[]) => (roles.includes('QUALITY') ? 0 : roles.includes('ORDERS') ? 1 : 2)

function reportOf(receipt: ReceiptRow, facts: Facts, company: Awaited<ReturnType<typeof companyLegalOf>>, language: DocumentLanguage, sample: boolean, chosen: readonly string[], photos: ReadonlyMap<string, number>): DiscrepancyReport {
  const lines: ReportLine[] = facts.views
    .filter((view) => chosen.includes(view.id))
    .map((view) => {
      const orderLine = view.receiptLine?.purchaseOrderLineId ? facts.orderLines.get(view.receiptLine.purchaseOrderLineId) : undefined
      return {
        seq: view.seq,
        kind: view.kind,
        reason: view.reason ? (language === 'it' ? view.reason.labelIt : view.reason.labelEn) : null,
        material: view.receiptLine
          ? { code: view.receiptLine.item.code, name: view.receiptLine.item.name, colour: view.receiptLine.colour?.name ?? null, orderLine: orderLine?.seq ?? null, supplierCode: orderLine?.supplierArticleCode ?? null }
          : null,
        quantity: view.quantity,
        uom: view.uom,
        note: view.note,
        photos: photos.get(view.id) ?? 0,
      }
    })
  return discrepancyReport({
    language,
    date: businessDate(serverClock.now()),
    company: { name: legalName(company, language), lines: legalLines(company, language), legal: legalFooter(company, language) },
    supplier: { name: facts.party.legalName, address: facts.address ? addressLine(facts.address, language) : null, vatNumber: facts.identity?.vatNumber ?? null },
    receipt: {
      number: receipt.number,
      receivedOn: businessDate(receipt.receivedAt),
      site: `${facts.site.code} ${facts.site.name}`,
      supplierDdtNumber: receipt.supplierDdtNumber,
      supplierDdtDate: receipt.supplierDdtDate ? businessDate(receipt.supplierDdtDate, 'UTC') : null,
      purchaseOrderNumber: facts.order?.number ?? null,
    },
    lines,
    sample,
  })
}

const photoCounts = (views: readonly DiscrepancyView[]): Map<string, number> => new Map(views.map((view) => [view.id, view.photos.filter((photo) => photo.status === 'AVAILABLE').length]))

const refusal = (issues: readonly Issue[]) => new DomainError('conflict', issues.length === 1 ? issues[0]!.message : 'The report cannot be made as asked.', [...issues])

// ---- the preview and the check ---------------------------------------------------------------------------------------------

/** GET /inventory/receipts/:receiptId/discrepancy-report: the PDF as the supplier would get it, with the preview banner. */
export async function previewReport(caller: CommandCaller, receiptId: string, query: { readonly ids?: readonly string[] | undefined; readonly language?: DocumentLanguage | undefined }) {
  const { receipt } = await visibleReceipt(caller, receiptId, INVENTORY_STOCK_VIEW)
  const company = await companyLegalOf(caller, receipt.companyId)
  const legal = legalProblems(company)
  if (legal.length > 0) throw refusal(legal)
  const facts = await caller.withClient((client) => reportFacts(client, receipt, query.ids ?? null))
  if (facts.selection.problems.length > 0) throw refusal(facts.selection.problems)
  const language = query.language ?? supplierLanguageOf(null, facts.party.language)
  const report = reportOf(receipt, facts, company, language, true, facts.selection.chosen, photoCounts(facts.views))
  return { pdf: await renderDiscrepancyReport(report), fileName: report.fileName }
}

/** GET /inventory/receipts/:receiptId/discrepancy-report/check: what the send would do now, and why it cannot yet. */
export async function reportCheck(caller: CommandCaller, receiptId: string, query: { readonly ids?: readonly string[] | undefined }) {
  const { receipt } = await visibleReceipt(caller, receiptId, INVENTORY_DISCREPANCIES_REPORT)
  const company = await companyLegalOf(caller, receipt.companyId)
  const facts = await caller.withClient((client) => reportFacts(client, receipt, query.ids ?? null))
  const contacts = [...facts.contacts].sort((a, b) => QUALITY_FIRST(a.roles) - QUALITY_FIRST(b.roles))
  const suggested = contacts[0] ?? null
  const language = supplierLanguageOf(suggested?.language ?? null, facts.party.language)
  const mail = discrepancyReportMail({ language, receiptNumber: receipt.number, supplierDdtNumber: receipt.supplierDdtNumber, count: facts.selection.chosen.length, recipientName: suggested?.name ?? null, message: null })
  const problems: Issue[] = [
    ...facts.selection.problems,
    ...legalProblems(company),
    ...(contacts.length === 0 ? [{ path: 'contactIds', message: `${facts.party.legalName} has no active contact with an e-mail: add one to the supplier first.` }] : []),
  ]
  return {
    ready: problems.length === 0,
    problems,
    discrepancyIds: facts.selection.chosen,
    /** The OPEN ones it would move to SENT. */
    sendsIds: facts.selection.toSend,
    recipients: contacts.map((contact) => ({ contactId: contact.id, name: contact.name, email: contact.email!, roles: contact.roles, language: contact.language, suggested: contact.id === suggested?.id })),
    language,
    subject: mail.subject,
    message: mail.body,
  }
}

// ---- the send -------------------------------------------------------------------------------------------------------------------

export interface ReportBody {
  readonly discrepancyIds?: readonly string[] | undefined
  readonly contactIds: readonly string[]
  readonly cc?: readonly string[] | undefined
  readonly subject?: string | null | undefined
  /** The office's own words in place of the standard text. */
  readonly message?: string | null | undefined
  readonly language?: DocumentLanguage | undefined
}

interface ReportPlan {
  readonly file: PreparedGeneratedFile
  readonly chosen: readonly string[]
  /** Each chosen discrepancy's status and version when the PDF was made. */
  readonly seen: ReadonlyMap<string, { readonly status: DiscrepancyStatus; readonly version: number }>
  readonly to: readonly string[]
  readonly language: DocumentLanguage
  readonly subject: string
  readonly body: string
}

const senderOf = async (db: Reader, context: OfficeContext) => {
  const user = await db.user.findUnique({ where: { id: context.actorId }, select: { displayName: true, email: true } })
  return { userId: context.actorId, name: user?.displayName ?? 'Magazzino', email: user?.email ?? null }
}

/** POST /inventory/receipts/:receiptId/discrepancy-report: the PDF to the supplier's contacts (see the module comment). */
export async function sendReport(caller: CommandCaller, receiptId: string, body: ReportBody, idempotencyKey?: string) {
  const { context, receipt } = await visibleReceipt(caller, receiptId, INVENTORY_DISCREPANCIES_REPORT)
  const office = context as OfficeContext
  const company = await companyLegalOf(caller, receipt.companyId)
  const legal = legalProblems(company)
  if (legal.length > 0) throw refusal(legal)
  const facts = await caller.withClient((client) => reportFacts(client, receipt, body.discrepancyIds ?? null))
  if (facts.selection.problems.length > 0) throw refusal(facts.selection.problems)
  // The recipients: active contacts of the supplier with an e-mail.
  const problems: Issue[] = []
  const contacts = [...new Set(body.contactIds)].flatMap((contactId, index) => {
    const contact = isUuid(contactId) ? facts.contacts.find((entry) => entry.id === contactId) : undefined
    if (!contact) problems.push({ path: `body/contactIds/${index}`, message: `Not an active contact of ${facts.party.legalName} with an e-mail.` })
    return contact ? [contact] : []
  })
  if (body.contactIds.length === 0) problems.push({ path: 'body/contactIds', message: 'Choose who gets the report.' })
  if (contacts.length > DISCREPANCY_LIMITS.reportRecipients) problems.push({ path: 'body/contactIds', message: `At most ${DISCREPANCY_LIMITS.reportRecipients} recipients.` })
  if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems)
  const first = contacts[0]!
  const language = body.language ?? supplierLanguageOf(first.language, facts.party.language)
  const report = reportOf(receipt, facts, company, language, false, facts.selection.chosen, photoCounts(facts.views))
  const pdf = await renderDiscrepancyReport(report)
  const file = await putGeneratedFile(processFiles(), caller, {
    companyId: receipt.companyId,
    recordType: 'GoodsReceipt',
    recordId: receipt.id,
    kind: 'DOCUMENT',
    originalName: report.fileName,
    contentType: 'application/pdf',
    body: pdf,
    // The mail's attachment: shared with the supplier's party (no price on it).
    visibility: ['OFFICE', 'PARTNER'],
    partyId: receipt.supplierId,
  })
  const mail = discrepancyReportMail({ language, receiptNumber: receipt.number, supplierDdtNumber: receipt.supplierDdtNumber, count: facts.selection.chosen.length, recipientName: contacts.length === 1 ? first.name : null, message: body.message ?? null })
  const seen = new Map(facts.views.filter((view) => facts.selection.chosen.includes(view.id)).map((view) => [view.id, { status: view.status as DiscrepancyStatus, version: view.version }]))
  const plan: ReportPlan = { file, chosen: facts.selection.chosen, seen, to: contacts.map((contact) => contact.email!), language, subject: body.subject?.trim() ? body.subject.trim() : mail.subject, body: mail.body }

  const { result } = await command(caller, { name: 'inventory.reportDiscrepancies', idempotencyKey, input: { receiptId, ...body } }, async (tools) => reportInCommand(tools, receipt, office, plan, body.cc ?? []))
  return result
}

async function reportInCommand(tools: CommandTools, receipt: ReceiptRow, context: OfficeContext, plan: ReportPlan, cc: readonly string[]) {
  const { tx, now } = tools
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.receipt-discrepancy', ${receipt.companyId}::uuid, ${receipt.id}::uuid), 0))`
  const rows = await tx.receiptDiscrepancy.findMany({ where: { id: { in: [...plan.chosen] }, receiptId: receipt.id }, select: DISCREPANCY_COLUMNS })
  const changed = plan.chosen.filter((id) => {
    const row = rows.find((entry) => entry.id === id)
    const seen = plan.seen.get(id)
    return !row || !seen || row.status !== seen.status || row.version !== seen.version
  })
  if (changed.length > 0) throw new InvalidStateError('A discrepancy of the report changed while the report was being made: look at the list again and send it again.')
  const file = await recordGeneratedFile(tools, plan.file, { details: { documentType: 'DISCREPANCY_REPORT', number: receipt.number, language: plan.language, discrepancies: plan.chosen.length } })
  const toSend = rows.filter((row) => row.status === 'OPEN')
  for (const row of toSend) {
    await tx.receiptDiscrepancy.update({ where: { id: row.id }, data: { status: 'SENT', sentAt: now, sentById: context.actorId, version: { increment: 1 } }, select: { id: true } })
    tools.audit({ action: 'inventory.discrepancyReported', recordType: 'ReceiptDiscrepancy', recordId: row.id, companyId: receipt.companyId, siteId: receipt.siteId, before: { status: 'OPEN' }, after: { status: 'SENT', documentFileId: file.id } })
  }
  const mail = await sendEmail(tools, {
    record: { type: 'GoodsReceipt', id: receipt.id },
    sender: await senderOf(tx, context),
    to: [...plan.to],
    cc: [...cc],
    subject: plan.subject,
    body: plan.body,
    attachments: [file.id],
    locale: plan.language,
  })
  tools.audit({
    action: 'inventory.reportDiscrepancies',
    recordType: 'GoodsReceipt',
    recordId: receipt.id,
    companyId: receipt.companyId,
    siteId: receipt.siteId,
    after: { discrepancyIds: [...plan.chosen], sentIds: toSend.map((row) => row.id), documentFileId: file.id, documentSha256: plan.file.sha256, outboundId: mail.outbound.id, recipients: plan.to.length + cc.length, language: plan.language },
  })
  tools.emit({
    type: 'inventory.receipt_discrepancies_reported',
    subject: receipt.id,
    companyId: receipt.companyId,
    siteId: receipt.siteId,
    payload: { receiptId: receipt.id, number: receipt.number, discrepancyIds: [...plan.chosen], sentIds: toSend.map((row) => row.id), documentFileId: file.id, outboundId: mail.outbound.id, recipients: plan.to.length + cc.length },
  })
  return {
    report: { documentFileId: file.id, fileName: file.originalName, emailId: mail.outbound.id, threadId: mail.thread.id, to: [...plan.to], cc: [...cc], language: plan.language, sentAt: toUtcIso(now), discrepancyIds: [...plan.chosen], sentIds: toSend.map((row) => row.id) },
    discrepancies: await discrepancyViews(tx, receipt.id),
  }
}
