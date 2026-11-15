import { DomainError, ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { holds, type Permission } from '@nexus/factory-domain/core/permissions'
import { toMinorUnits } from '@nexus/factory-domain/core/money'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { composeDocument } from '@nexus/factory-domain/documents/compose'
import { addressLine, legalProblems } from '@nexus/factory-domain/documents/legal'
import { isDocumentLanguage, type DocumentLanguage, type DocumentReference } from '@nexus/factory-domain/documents/model'
import { eventFor } from '@nexus/factory-domain/events/define'
import { COMMERCIAL_INVOICE_KIND, commercialInvoiceDocument, commercialInvoiceFingerprint, commercialInvoiceProblems, customsLineProblems } from '@nexus/factory-domain/shipping/customs/commercial-invoice'
import { events as customsEvents } from '@nexus/factory-domain/shipping-customs/events'
import { SHIPPING_CUSTOMS_MANAGE } from '@nexus/factory-domain/shipping/customs/permissions'
import { POSTAL_FORM_LAYOUT, postalFormFingerprint, type PostalFormDocument, type PostalParcel } from '@nexus/factory-domain/shipping/customs/postal-forms'
import { CN23_BECAUSE_WORDS, CUSTOMS_REFUSAL_WORDS, customsRefusalPath, postalFormOf, type Cn23Because, type CustomsRefusal, type ExportReason, type PostalForm } from '@nexus/factory-domain/shipping/customs/rules'
import { SHIPPING_VIEW } from '@nexus/factory-domain/shipping/permissions'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import { command, type CommandCaller, type CommandTx } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { companyLegalOf, documentFileName } from '../../../platform/documents/documents'
import { renderDocumentPdf } from '../../../platform/documents/pdf'
import { putGeneratedFile, recordGeneratedFile, storeCall } from '../../../platform/files/files'
import type { FilesRuntime } from '../../../platform/files/service'
import { renderPostalFormPdf } from '../../../platform/print/layouts/cn22'
import { officeContextOf } from '../access'
import { officeShipment } from '../shipments/shipments'
import type { ShipmentHeader } from '../store'
import { customsFactsOf, type CustomsFacts } from './facts'

/**
 * A shipment's customs papers (B-W2b-409; LOG-086 the commercial invoice, LOG-087 the CN 22 / CN 23, LOG-095 the EORI on them;
 * factory-domain shipping/customs). Office only; making one is shipping.customs.manage on the shipment's company, site and
 * party AND the price grain (the papers declare values); reading the PDF is shipping.view and the price grain.
 *
 *   commercial invoice   the documents framework's COMMERCIAL_INVOICE (letterhead, it/en), numbered with the shipment's own
 *                        number, the PDF painted and put OUTSIDE any transaction, then ONE command `shipping.commercialInvoiceMade`
 *                        writes the StoredFile (office only), the GeneratedDocument version, the audit and customs.document_made
 *   CN 22 / CN 23        platform/print/layouts/cn22.ts, one page per parcel; the form the parcels need (rules postalFormOf), or
 *                        CN 23 when asked (always accepted); a CN 22 asked for parcels that need a CN 23 is refused in words
 *
 * Only an export (outside the EU) has these papers; the company's EORI, each style's HS code and origin and every line's price
 * are needed first; the same contents and language give the newest version back (200, made false). Refusals are 409 in words
 * (`refusal/<CODE>`); nothing reaches customs, a broker or a carrier.
 */

const customsMade = customsEvents.find((event) => event.type === 'customs.document_made')!

export const CUSTOMS_KINDS = ['COMMERCIAL_INVOICE', 'CN22', 'CN23'] as const
export type CustomsKind = (typeof CUSTOMS_KINDS)[number]

export function refused(code: CustomsRefusal, message: string = CUSTOMS_REFUSAL_WORDS[code]): never {
  throw new DomainError('conflict', message, [{ path: customsRefusalPath(code), message }])
}

/** The office caller may do `permission` on the shipment (404 out of its reach, 403 without it). */
export async function customsShipment(caller: CommandCaller, shipmentId: string, permission: Permission = SHIPPING_VIEW): Promise<{ context: OfficeContext; shipment: ShipmentHeader }> {
  const context = officeContextOf(caller)
  const shipment = await officeShipment(caller, shipmentId, permission)
  return { context, shipment }
}

export const seesValuesOf = (context: OfficeContext): boolean => holds(actorOf(context), 'money.price')

function needValues(context: OfficeContext): void {
  if (!seesValuesOf(context)) throw new ForbiddenError('Customs papers declare the goods\' values: they need the price grain.')
}

const DOC_SELECT = { id: true, kind: true, version: true, number: true, language: true, fingerprint: true, fileId: true, createdAt: true } as const

/** The shipment's customs papers, newest version first per kind. */
export const customsDocumentsOf = (db: CommandTx, shipmentId: string) =>
  db.generatedDocument.findMany({ where: { recordType: 'Shipment', recordId: shipmentId, kind: { in: [...CUSTOMS_KINDS] } }, select: DOC_SELECT, orderBy: [{ kind: 'asc' }, { version: 'desc' }] })

type DocRow = Awaited<ReturnType<typeof customsDocumentsOf>>[number]

export const documentView = (row: DocRow, current: boolean) => ({
  documentId: row.id,
  kind: row.kind as CustomsKind,
  version: row.version,
  number: row.number ?? '',
  language: (isDocumentLanguage(row.language) ? row.language : 'it') as DocumentLanguage,
  fileId: row.fileId,
  createdAt: toUtcIso(row.createdAt),
  current,
})

/** The newest version of the kind(s), or undefined. */
async function newestOf(db: CommandTx, shipmentId: string, kinds: readonly CustomsKind[]): Promise<DocRow | undefined> {
  return (await db.generatedDocument.findMany({ where: { recordType: 'Shipment', recordId: shipmentId, kind: { in: [...kinds] } }, select: DOC_SELECT, orderBy: [{ createdAt: 'desc' }, { version: 'desc' }], take: 1 }))[0]
}

const lockPapers = (tx: CommandTx, shipmentId: string) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.customs-papers', ${shipmentId}::uuid), 0))`

/** What stops every customs paper of the shipment (the refusal, or null). */
export function papersHeld(shipment: ShipmentHeader, facts: CustomsFacts): CustomsRefusal | null {
  if (shipment.status === 'CANCELLED') return 'CANCELLED'
  if (facts.destination === null) return 'NO_DESTINATION'
  if (facts.destination !== 'EXPORT') return 'NOT_EXPORT'
  if (facts.eori === null) return 'NO_EORI'
  if (facts.lines.length === 0) return 'NO_LINES'
  const lines = customsLineProblems(facts.lines)
  if (lines.customsData.length > 0) return 'CUSTOMS_DATA'
  if (lines.unpriced.length > 0) return 'NO_PRICE'
  return null
}

/** The refusal with its details in words (the lines without HS code or origin, without a price). */
export function heldWords(code: CustomsRefusal, facts: CustomsFacts): string {
  const lines = customsLineProblems(facts.lines)
  if (code === 'CUSTOMS_DATA') return `${CUSTOMS_REFUSAL_WORDS.CUSTOMS_DATA} ${lines.customsData.join('; ')}.`
  if (code === 'NO_PRICE') return `${CUSTOMS_REFUSAL_WORDS.NO_PRICE} ${lines.unpriced.join(', ')}.`
  return CUSTOMS_REFUSAL_WORDS[code]
}

/** The invoice the declaration names, as a reference (the tax invoice of the export), or null. */
async function invoiceReferenceOf(db: CommandTx, shipmentId: string): Promise<{ number: string; date: string | null } | null> {
  const declaration = await db.customsDeclaration.findFirst({ where: { shipmentId, invoiceId: { not: null } }, select: { invoiceId: true } })
  if (!declaration?.invoiceId) return null
  const invoice = await db.invoice.findUnique({ where: { id: declaration.invoiceId }, select: { number: true, issueDate: true } })
  return invoice?.number ? { number: invoice.number, date: invoice.issueDate ? invoice.issueDate.toISOString().slice(0, 10) : null } : null
}

export interface PaperBody {
  readonly language?: DocumentLanguage | undefined
  readonly reason?: ExportReason | undefined
  readonly reasonText?: string | undefined
  readonly notes?: string | undefined
}

/** POST /shipping/shipments/:shipmentId/export/commercial-invoice. */
export async function makeCommercialInvoice(files: FilesRuntime, caller: CommandCaller, shipmentId: string, body: PaperBody, idempotencyKey?: string) {
  const { context, shipment } = await customsShipment(caller, shipmentId, SHIPPING_CUSTOMS_MANAGE)
  needValues(context)
  const facts = await caller.withClient((db) => customsFactsOf(db, shipment))
  const held = papersHeld(shipment, facts)
  if (held) refused(held, heldWords(held, facts))
  const problems = commercialInvoiceProblems(facts)
  if (problems.length > 0) refused('NO_LINES', problems.join(' '))
  const company = await companyLegalOf(caller, shipment.companyId)
  const letterhead = legalProblems(company)
  if (letterhead.length > 0) refused('LETTERHEAD', letterhead.length === 1 ? letterhead[0]!.message : CUSTOMS_REFUSAL_WORDS.LETTERHEAD)
  const reason: ExportReason = body.reason ?? 'SALE_OF_GOODS'
  if (reason === 'OTHER' && !body.reasonText?.trim()) throw new ValidationError('Say the reason in words.', [{ path: 'body/reasonText', message: 'OTHER needs its words.' }])
  const language = body.language ?? facts.language
  const invoice = await caller.withClient((db) => invoiceReferenceOf(db, shipment.id))
  const references: DocumentReference[] = [...facts.references, ...(invoice ? [{ kind: 'INVOICE' as const, number: invoice.number, date: invoice.date }] : [])]
  const document = commercialInvoiceDocument({
    number: shipment.number,
    date: businessDate(serverClock.now()),
    language,
    currency: facts.currency,
    party: facts.party,
    deliverTo: facts.deliverTo,
    references,
    lines: facts.lines,
    deliveryTerms: facts.deliveryTerms,
    paymentTerms: facts.paymentTerms,
    notes: body.notes?.trim() || null,
    facts: {
      exporterEori: facts.eori!,
      reason,
      reasonText: reason === 'OTHER' ? body.reasonText!.trim() : null,
      destinationCountry: facts.country!,
      packages: facts.parcels.length > 0 ? facts.parcels.length : null,
      grossWeightKg: facts.grossKg && facts.grossKg.greaterThan(0) ? facts.grossKg.toFixed(4) : null,
      netWeightKg: facts.netKg ? facts.netKg.toFixed(4) : null,
      origin: facts.origin,
      nonTaxableExport: true,
    },
  })
  const fingerprint = commercialInvoiceFingerprint(document)
  const newest = await caller.withClient((db) => newestOf(db, shipment.id, ['COMMERCIAL_INVOICE']))
  if (newest && newest.fingerprint === fingerprint && newest.language === language) return { status: 200 as const, document: { ...documentView(newest, true), made: false } }

  const composed = composeDocument({ ...document, company, sample: false })
  const pdf = await renderDocumentPdf(composed)
  return storePaper(files, caller, context, shipment, {
    kind: COMMERCIAL_INVOICE_KIND,
    fingerprint,
    language,
    layout: composed.layout,
    fileName: documentFileName(composed),
    pdf,
    commandName: 'shipping.commercialInvoiceMade',
    idempotencyKey,
    input: { shipmentId, ...body, fingerprint },
    details: { reason, lines: document.lines.length },
  })
}

export interface PostalFormBody {
  readonly form?: PostalForm | undefined
  readonly language?: DocumentLanguage | undefined
  readonly reason?: ExportReason | undefined
  readonly reasonText?: string | undefined
  readonly comments?: string | undefined
}

/** The form the shipment's parcels need now (null: no parcel), with why a CN 23. */
export function postalChoiceOf(facts: CustomsFacts): { readonly form: PostalForm; readonly because: Cn23Because[]; readonly words: string[] } | null {
  if (facts.parcels.length === 0) return null
  const choice = postalFormOf(
    facts.parcels.map((parcel) => ({ grossKg: parcel.grossKg, value: parcel.items.reduce((sum, item) => sum.plus(item.value ?? new Dec(0)), new Dec(0)) })),
    facts.currency,
  )
  return { form: choice.form, because: [...choice.because], words: choice.because.map((reason) => CN23_BECAUSE_WORDS[reason]) }
}

/** POST /shipping/shipments/:shipmentId/export/postal-form. */
export async function makePostalForm(files: FilesRuntime, caller: CommandCaller, shipmentId: string, body: PostalFormBody, idempotencyKey?: string) {
  const { context, shipment } = await customsShipment(caller, shipmentId, SHIPPING_CUSTOMS_MANAGE)
  needValues(context)
  const facts = await caller.withClient((db) => customsFactsOf(db, shipment))
  const held = papersHeld(shipment, facts)
  if (held) refused(held, heldWords(held, facts))
  if (facts.unpacked > 0 || facts.parcels.length === 0 || facts.parcels.some((parcel) => parcel.items.length === 0)) refused('NOT_PACKED')
  if (facts.parcels.some((parcel) => parcel.grossKg === null)) refused('NOT_WEIGHED')
  const noMass = [...new Set(facts.parcels.flatMap((parcel) => parcel.items.filter((item) => item.netKg === null).map((item) => item.code)))]
  if (noMass.length > 0) refused('CUSTOMS_DATA', `Every style on a CN 22 or CN 23 needs its net weight: ${noMass.join(', ')}.`)
  const choice = postalChoiceOf(facts)!
  const form: PostalForm = body.form ?? choice.form
  if (form === 'CN22' && choice.form === 'CN23') refused('CN22_LIMIT', `${CUSTOMS_REFUSAL_WORDS.CN22_LIMIT} ${choice.words.join(' ')}`)
  const reason: ExportReason = body.reason ?? 'SALE_OF_GOODS'
  if (reason === 'OTHER' && !body.reasonText?.trim()) throw new ValidationError('Say the reason in words.', [{ path: 'body/reasonText', message: 'OTHER needs its words.' }])
  const language = body.language ?? facts.language
  const company = await companyLegalOf(caller, shipment.companyId)
  const invoice = await caller.withClient((db) => invoiceReferenceOf(db, shipment.id))
  const parcels: PostalParcel[] = facts.parcels.map((parcel) => ({
    seq: parcel.seq,
    grossKg: parcel.grossKg!.toFixed(4),
    items: parcel.items.map((item) => ({
      description: item.goods,
      quantity: item.quantity,
      netKg: item.netKg!.toFixed(4),
      valueMinor: toMinorUnits(item.value!, facts.currency),
      hsCode: item.hsCode!.trim(),
      originCountry: item.originCountry!,
    })),
  }))
  const document: PostalFormDocument = {
    form,
    language,
    number: shipment.number,
    date: businessDate(serverClock.now()),
    currency: facts.currency,
    sender: { name: company.tradeName?.trim() || company.legalName, lines: company.address ? [addressLine(company.address, language)] : [], eori: facts.eori! },
    addressee: { name: facts.deliverTo?.name ?? facts.party.name, lines: facts.deliverTo ? [addressLine(facts.deliverTo, language)] : facts.party.address ? [addressLine(facts.party.address, language)] : [] },
    reason,
    reasonText: reason === 'OTHER' ? body.reasonText!.trim() : null,
    invoiceNumber: form === 'CN23' ? (invoice?.number ?? shipment.number) : null,
    comments: form === 'CN23' ? body.comments?.trim() || null : null,
    parcels,
  }
  const fingerprint = postalFormFingerprint(document)
  const newest = await caller.withClient((db) => newestOf(db, shipment.id, [form]))
  if (newest && newest.fingerprint === fingerprint && newest.language === language) return { status: 200 as const, document: { ...documentView(newest, true), made: false } }
  const pdf = await renderPostalFormPdf(document)
  return storePaper(files, caller, context, shipment, {
    kind: form,
    fingerprint,
    language,
    layout: POSTAL_FORM_LAYOUT[form],
    fileName: `${form} ${shipment.number.replace(/[\\/]/g, '-')}.pdf`,
    pdf,
    commandName: 'shipping.postalFormMade',
    idempotencyKey,
    input: { shipmentId, ...body, form, fingerprint },
    details: { reason, parcels: parcels.length, suggested: choice.form },
  })
}

interface StoreSpec {
  readonly kind: CustomsKind
  readonly fingerprint: string
  readonly language: DocumentLanguage
  readonly layout: string
  readonly fileName: string
  readonly pdf: Buffer
  readonly commandName: 'shipping.commercialInvoiceMade' | 'shipping.postalFormMade'
  readonly idempotencyKey: string | undefined
  readonly input: Record<string, unknown>
  readonly details: Readonly<Record<string, string | number | boolean | null>>
}

/** The PDF put in the store (outside any transaction), then ONE command writes the file, the version, the audit and the event. */
async function storePaper(files: FilesRuntime, caller: CommandCaller, context: OfficeContext, shipment: ShipmentHeader, spec: StoreSpec) {
  const prepared = await putGeneratedFile(files, caller, {
    companyId: shipment.companyId,
    recordType: 'Shipment',
    recordId: shipment.id,
    kind: 'DOCUMENT',
    originalName: spec.fileName,
    contentType: 'application/pdf',
    body: spec.pdf,
    // Values for customs: the office's only (the broker's link serves it through its own route).
    visibility: ['OFFICE'],
  })
  const { result } = await command(caller, { name: spec.commandName, idempotencyKey: spec.idempotencyKey, input: spec.input }, async (tools) => {
    const { tx, audit, emit, now } = tools
    await lockPapers(tx, shipment.id)
    const last = await newestOf(tx, shipment.id, [spec.kind])
    if (last && last.fingerprint === spec.fingerprint && last.language === spec.language) {
      // Made meanwhile by another press with the same contents: that version stands; the file put above is never named.
      audit({ action: spec.commandName, recordType: 'Shipment', recordId: shipment.id, companyId: shipment.companyId, siteId: shipment.siteId, after: { documentId: last.id, kind: spec.kind, version: last.version, unchanged: true } })
      return { status: 200 as const, view: documentView(last, true), made: false }
    }
    const file = await recordGeneratedFile(tools, prepared, { details: { documentType: spec.kind, number: shipment.number, layout: spec.layout, language: spec.language } })
    const id = newId()
    const version = (last?.version ?? 0) + 1
    const row = await tx.generatedDocument.create({
      data: { id, companyId: shipment.companyId, siteId: shipment.siteId, recordType: 'Shipment', recordId: shipment.id, kind: spec.kind, version, fingerprint: spec.fingerprint, language: spec.language, layout: spec.layout, number: shipment.number, fileId: file.id, createdAt: now, createdById: context.actorId },
      select: DOC_SELECT,
    })
    audit({ action: spec.commandName, recordType: 'Shipment', recordId: shipment.id, companyId: shipment.companyId, siteId: shipment.siteId, after: { documentId: id, kind: spec.kind, version, language: spec.language, layout: spec.layout, fileId: file.id, fingerprint: spec.fingerprint, ...spec.details } })
    emit(eventFor(customsMade, { subject: shipment.id, companyId: shipment.companyId, siteId: shipment.siteId, payload: { shipmentId: shipment.id, number: shipment.number, kind: spec.kind, documentId: id, version } }))
    return { status: 201 as const, view: documentView(row, true), made: true }
  })
  return { status: result.status, document: { ...result.view, made: result.made } }
}

/** The most bytes a customs paper read here may have. */
const PAPER_MAX = 20 * 1024 * 1024

/** GET /shipping/shipments/:shipmentId/export/documents/:documentId/pdf: the paper's bytes (the Commercial invoice PDF window). */
export async function customsPaperPdf(files: FilesRuntime, caller: CommandCaller, shipmentId: string, documentId: string): Promise<{ body: Buffer; fileName: string }> {
  const { context, shipment } = await customsShipment(caller, shipmentId)
  needValues(context)
  const found = isUuid(documentId)
    ? await caller.withClient(async (db) => {
        const row = await db.generatedDocument.findFirst({ where: { id: documentId, recordType: 'Shipment', recordId: shipment.id, kind: { in: [...CUSTOMS_KINDS] } }, select: { fileId: true } })
        return row ? db.storedFile.findFirst({ where: { id: row.fileId, status: 'AVAILABLE' }, select: { storeAccountId: true, storageKey: true, originalName: true } }) : null
      })
    : null
  if (!found) throw new NotFoundError('Customs paper not found.')
  const body = await storeCall(() => files.storage.read(caller, found.storeAccountId, found.storageKey, PAPER_MAX))
  if (!body) throw new NotFoundError('The paper is missing from the file store: make it again.')
  return { body, fileName: found.originalName }
}
