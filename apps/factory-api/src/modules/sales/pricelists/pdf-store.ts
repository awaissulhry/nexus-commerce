import { heldGrains } from '@nexus/factory-domain/auth/grains/grains'
import { can } from '@nexus/factory-domain/core/permissions'
import { DomainError, ForbiddenError, InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { legalFooter, legalLines, legalName, legalProblems } from '@nexus/factory-domain/documents/legal'
import type { DocumentLanguage } from '@nexus/factory-domain/documents/model'
import { PRICE_LIST_PDF_KIND, PRICE_LIST_PDF_RECORD, priceListMail, priceListPdfFingerprint, priceListPdfNumber, priceListReport, type PriceListPdfInput } from '@nexus/factory-domain/prices-followups/price-list-pdf'
import { PRICE_LISTS_MANAGE } from '@nexus/factory-domain/sales/pricelists/permissions'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { companyLegalOf } from '../../../platform/documents/documents'
import { sendEmail } from '../../../platform/email-out/outbound'
import { prepareFileCopy, putGeneratedFile, recordGeneratedFile, type PreparedGeneratedFile } from '../../../platform/files/files'
import { processFiles } from '../../../platform/files/service'
import { renderEightD } from '../../quality/capa/report-pdf'
import { readVersionFor } from '../pricing-depth/store'
import { officeContextOf, type Reader } from '../quotes/store'
import { assertMayChangeList, dayText, priceOf, type ListRow, type ListVersionRow } from './store'

/**
 * The price list PDF kept for mail (B-W2b-380, XF6:01; design sales.pricelists tab pricelists.pdf "Sent to a customer or
 * printed for a fair"; B-W2b-343 left it a browser print view). A version per price list version (GeneratedDocument
 * PRICE_LIST 1, 2, …; recordType PriceListVersion, the company whose letterhead it carries: the list's, or one the person
 * names for a list of every company; no site) with its PDF, a StoredFile of the version, so the mail attaches that same file:
 *
 *   GET  /sales/price-lists/:listId/versions/:versionId/pdf        pricelists.view + the price grain: the kept PDFs (newest
 *                                                                  first), whether the newest still shows the version as it is
 *   POST /sales/price-lists/:listId/versions/:versionId/pdf        pricelists.manage + the price grain: keeps the version as it is
 *                                                                  ({language?, companyId?}); the same contents as the newest give
 *                                                                  it back (made: false)
 *   POST /sales/price-lists/:listId/versions/:versionId/pdf/send   the same: mails the newest showing the version as it is (one is
 *                                                                  kept first when none does) to a customer ({partyId, to?, cc?,
 *                                                                  subject?, message?, language?}; to: its contact by default) on
 *                                                                  the customer's thread; FAKE locally
 *
 * The mail of a record goes on a thread that has its party (threads.ts: a shared message needs one), and a list prices many
 * customers: the mail goes on the CUSTOMER's thread, with a copy of the kept PDF on the customer (prepareFileCopy: the same bytes,
 * checked by SHA-256, `sourceFileId` naming the kept file — B-W1-49's DoC copy: the copy is the evidence of what travelled).
 *
 * Making one, as the MTM worksheet: the facts read and composed (factory-domain prices-followups/price-list-pdf); the
 * fingerprint against the newest; the PDF painted by the CAPA module's renderer and put in the store OUTSIDE any transaction;
 * ONE command under the version's PDF lock: the StoredFile row, the GeneratedDocument row, audit, price_list.pdf_kept. Prices
 * only (no cost, no margin); the company's letterhead must be complete (c.c. art. 2250), refused in words otherwise.
 */

const VERSION_COLUMNS = { id: true, version: true, companyId: true, fingerprint: true, language: true, number: true, fileId: true, createdAt: true, createdById: true } as const

const noPrice = (): ForbiddenError => new ForbiddenError("A price list's PDF holds its prices: your role does not see prices.")
const refusal = (issues: readonly { path: string; message: string }[]) => new DomainError('conflict', issues.length === 1 ? issues[0]!.message : "The company's letterhead is not complete: the price list cannot be printed.", [...issues])

/** A version the caller may see with prices (pricelists.view over the list's company + the price grain); `manage` to change. */
async function versionFor(caller: CommandCaller, listId: string, versionId: string, manage: boolean) {
  const context = officeContextOf(caller)
  const { list, version } = await readVersionFor(caller, listId, versionId)
  if (!heldGrains(actorOf(context)).has('price')) throw noPrice()
  if (manage) assertMayChangeList(context, PRICE_LISTS_MANAGE, list.companyId)
  return { context, list, version }
}

async function versionsOf(db: Reader, versionId: string) {
  return db.generatedDocument.findMany({ where: { recordType: PRICE_LIST_PDF_RECORD, recordId: versionId, kind: PRICE_LIST_PDF_KIND }, select: VERSION_COLUMNS, orderBy: { version: 'desc' } })
}

const KINDS = ['BASE', 'CUSTOMER', 'GROUP', 'CONTRACT'] as const
const label = (row: { code: string; name: string } | undefined): string => (row ? `${row.code} · ${row.name}` : '')

/** What the PDF prints of the version on `date` (read with the caller's client). */
async function inputOf(db: Reader, list: ListRow, version: ListVersionRow, company: Awaited<ReturnType<typeof companyLegalOf>>, language: DocumentLanguage, pdfVersion: number, date: string): Promise<PriceListPdfInput> {
  const entries = await db.priceListEntry.findMany({ where: { versionId: version.id }, select: { id: true, styleId: true, colourwayId: true, unitPrice: true, validFrom: true, validTo: true } })
  const breaks = await db.priceBreak.findMany({ where: { versionId: version.id }, select: { entryId: true, minQuantity: true, unitPrice: true, discountPct: true } })
  const surcharges = await db.sizeSurcharge.findMany({ where: { versionId: version.id }, select: { styleId: true, size: true, surchargeAmount: true, surchargePct: true } })
  const styleIds = [...new Set([...entries.map((entry) => entry.styleId), ...surcharges.flatMap((row) => (row.styleId ? [row.styleId] : []))])]
  const colourwayIds = [...new Set(entries.flatMap((entry) => (entry.colourwayId ? [entry.colourwayId] : [])))]
  const styles = new Map((styleIds.length === 0 ? [] : await db.style.findMany({ where: { id: { in: styleIds } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, row]))
  const colourways = new Map((colourwayIds.length === 0 ? [] : await db.colourway.findMany({ where: { id: { in: colourwayIds } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, row]))
  const day = (value: Date | null) => dayText(value)
  const sorted = [...entries].sort((a, b) => (styles.get(a.styleId)?.code ?? '').localeCompare(styles.get(b.styleId)?.code ?? '') || (a.colourwayId === null ? -1 : b.colourwayId === null ? 1 : (colourways.get(a.colourwayId)?.code ?? '').localeCompare(colourways.get(b.colourwayId)?.code ?? '')) || (day(a.validFrom) ?? '').localeCompare(day(b.validFrom) ?? ''))
  const entryOf = new Map(entries.map((entry) => [entry.id, entry]))
  const breakOf = (entryId: string | null): string | null => {
    const entry = entryId === null ? null : entryOf.get(entryId)
    if (!entry) return null
    const colour = entry.colourwayId ? colourways.get(entry.colourwayId)?.code : null
    return `${styles.get(entry.styleId)?.code ?? ''}${colour ? ` · ${colour}` : ''}`
  }
  return {
    language,
    date,
    version: pdfVersion,
    company: { name: legalName(company, language), lines: legalLines(company, language), legal: legalFooter(company, language) },
    list: { code: list.code, name: list.name, kind: (KINDS as readonly string[]).includes(list.kind) ? (list.kind as (typeof KINDS)[number]) : 'BASE', currency: list.currency, showDiscount: list.showDiscount },
    priceVersion: { revision: version.revision, draft: version.status === 'DRAFT', validFrom: day(version.validFrom), validTo: day(version.validTo) },
    prices: sorted.map((entry) => ({ style: label(styles.get(entry.styleId)), colourway: entry.colourwayId ? label(colourways.get(entry.colourwayId)) : null, validFrom: day(entry.validFrom), validTo: day(entry.validTo), unitPrice: priceOf(entry.unitPrice) })),
    breaks: [...breaks]
      .sort((a, b) => (breakOf(a.entryId) ?? '').localeCompare(breakOf(b.entryId) ?? '') || a.minQuantity - b.minQuantity)
      .map((row) => ({ of: breakOf(row.entryId), minQuantity: row.minQuantity, unitPrice: row.unitPrice === null ? null : priceOf(row.unitPrice), discountPct: row.discountPct === null ? null : row.discountPct.toString() })),
    surcharges: surcharges.map((row) => ({ style: row.styleId ? (styles.get(row.styleId)?.code ?? '') : null, size: row.size, amount: row.surchargeAmount === null ? null : priceOf(row.surchargeAmount), pct: row.surchargePct === null ? null : row.surchargePct.toString() })),
  }
}

/** The company whose letterhead it carries: the list's; for a list of every company, the one named (a company of the tenant). */
async function companyOf(caller: CommandCaller, list: ListRow, asked: string | null | undefined): Promise<string> {
  if (list.companyId !== null) return list.companyId
  if (!asked) throw new ValidationError('A list of every company is printed on the letterhead of one company: name it.', [{ path: 'body/companyId', message: 'Name the company whose letterhead it carries.' }])
  const found = await caller.withClient((db) => db.company.findUnique({ where: { id: asked }, select: { id: true } }))
  if (!found) throw new ValidationError('Not a company of yours.', [{ path: 'body/companyId', message: 'Not a company of yours.' }])
  return found.id
}

interface Prepared {
  readonly fingerprint: string
  readonly language: DocumentLanguage
  readonly companyId: string
  readonly current: { readonly id: string; readonly version: number; readonly fileId: string } | null
  readonly file: PreparedGeneratedFile | null
}

/** Prepares the version's PDF OUTSIDE any transaction (the store put); the newest when it shows the version as it is. */
async function prepare(caller: CommandCaller, list: ListRow, version: ListVersionRow, companyId: string, asked: DocumentLanguage | undefined): Promise<Prepared> {
  const company = await companyLegalOf(caller, companyId)
  const problems = legalProblems(company)
  if (problems.length > 0) throw refusal(problems)
  const language: DocumentLanguage = asked ?? 'it'
  const date = businessDate(serverClock.now())
  const { input, versions } = await caller.withClient(async (db) => {
    const rows = await versionsOf(db, version.id)
    return { versions: rows, input: await inputOf(db, list, version, company, language, (rows[0]?.version ?? 0) + 1, date) }
  })
  const fingerprint = priceListPdfFingerprint(input)
  const newest = versions[0]
  if (newest && newest.fingerprint === fingerprint && newest.language === language && newest.companyId === companyId) return { fingerprint, language, companyId, current: { id: newest.id, version: newest.version, fileId: newest.fileId }, file: null }
  const report = priceListReport(input)
  const file = await putGeneratedFile(processFiles(), caller, {
    companyId,
    recordType: PRICE_LIST_PDF_RECORD,
    recordId: version.id,
    kind: 'DOCUMENT',
    originalName: report.fileName,
    contentType: 'application/pdf',
    body: await renderEightD(report),
    // The office's file; a mail attaches it from the version's thread.
    visibility: ['OFFICE'],
  })
  return { fingerprint, language, companyId, current: null, file }
}

/** Keeps a prepared PDF in the caller's command (the version's PDF lock), or answers the newest unchanged. */
async function keepInCommand(tools: CommandTools, list: ListRow, version: ListVersionRow, prepared: Prepared): Promise<{ id: string; version: number; fileId: string; made: boolean }> {
  const { tx } = tools
  if (prepared.current) return { ...prepared.current, made: false }
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.price-list-pdf', ${version.id}::uuid), 0))`
  const last = await tx.generatedDocument.findFirst({ where: { recordType: PRICE_LIST_PDF_RECORD, recordId: version.id, kind: PRICE_LIST_PDF_KIND }, select: VERSION_COLUMNS, orderBy: { version: 'desc' } })
  if (last && last.fingerprint === prepared.fingerprint && last.language === prepared.language && last.companyId === prepared.companyId) return { id: last.id, version: last.version, fileId: last.fileId, made: false }
  const file = await recordGeneratedFile(tools, prepared.file!)
  const id = newId()
  const pdfVersion = (last?.version ?? 0) + 1
  await tx.generatedDocument.create({
    data: { id, companyId: prepared.companyId, siteId: null, recordType: PRICE_LIST_PDF_RECORD, recordId: version.id, kind: PRICE_LIST_PDF_KIND, version: pdfVersion, fingerprint: prepared.fingerprint, language: prepared.language, layout: null, number: priceListPdfNumber(list.code, version.revision, pdfVersion), fileId: file.id, createdAt: tools.now, createdById: tools.context.audience === 'office' ? tools.context.actorId : null },
    select: { id: true },
  })
  tools.audit({ action: 'priceLists.keepPdf', recordType: 'PriceList', recordId: list.id, companyId: list.companyId, after: { versionId: version.id, revision: version.revision, generatedDocumentId: id, pdfVersion, language: prepared.language, fileId: file.id, fingerprint: prepared.fingerprint } })
  tools.emit({ type: 'price_list.pdf_kept', subject: list.id, companyId: list.companyId, payload: { listId: list.id, versionId: version.id, revision: version.revision, pdfVersion, generatedDocumentId: id, fileId: file.id } })
  return { id, version: pdfVersion, fileId: file.id, made: true }
}

/** The kept PDFs and whether the newest still shows the version as it is (null: none kept). */
async function readState(caller: CommandCaller, list: ListRow, version: ListVersionRow) {
  const rows = await caller.withClient((db) => versionsOf(db, version.id))
  const newest = rows[0]
  let upToDate: boolean | null = null
  if (newest) {
    const company = await companyLegalOf(caller, newest.companyId)
    const language: DocumentLanguage = newest.language === 'en' ? 'en' : 'it'
    upToDate = await caller.withClient(async (db) => priceListPdfFingerprint(await inputOf(db, list, version, company, language, newest.version, businessDate(serverClock.now()))) === newest.fingerprint)
  }
  const names = await caller.withClient(async (db) => new Map((await db.user.findMany({ where: { id: { in: rows.flatMap((row) => (row.createdById ? [row.createdById] : [])) } }, select: { id: true, displayName: true } })).map((row) => [row.id, row.displayName])))
  return {
    listId: list.id,
    versionId: version.id,
    revision: version.revision,
    upToDate,
    /** A list of every company names the company whose letterhead it carries. */
    needsCompany: list.companyId === null,
    pdfs: rows.map((row) => ({ id: row.id, version: row.version, number: row.number, language: row.language, companyId: row.companyId, fileId: row.fileId, createdAt: toUtcIso(row.createdAt), createdBy: row.createdById ? (names.get(row.createdById) ?? null) : null })),
  }
}

/** GET /sales/price-lists/:listId/versions/:versionId/pdf */
export async function getPriceListPdfs(caller: CommandCaller, listId: string, versionId: string) {
  const { list, version } = await versionFor(caller, listId, versionId, false)
  return { pdf: await readState(caller, list, version) }
}

/** POST /sales/price-lists/:listId/versions/:versionId/pdf */
export async function keepPriceListPdf(caller: CommandCaller, listId: string, versionId: string, body: { readonly language?: DocumentLanguage | undefined; readonly companyId?: string | null | undefined }, idempotencyKey?: string) {
  const { list, version } = await versionFor(caller, listId, versionId, true)
  const prepared = await prepare(caller, list, version, await companyOf(caller, list, body.companyId), body.language)
  const kept = prepared.current ? { ...prepared.current, made: false } : (await command(caller, { name: 'priceLists.keepPdf', idempotencyKey, input: { listId, versionId, ...body } }, (tools) => keepInCommand(tools, list, version, prepared))).result
  return { made: kept.made, version: kept.version, fileId: kept.fileId, pdf: await readState(caller, list, version) }
}

export interface SendPriceListBody {
  /** The customer it goes to (of the list's company, or of every company). */
  readonly partyId: string
  /** Default: the customer's first active contact with an e-mail (its orders contact first). */
  readonly to?: readonly string[] | undefined
  readonly cc?: readonly string[] | undefined
  readonly subject?: string | null | undefined
  readonly message?: string | null | undefined
  readonly language?: DocumentLanguage | undefined
  /** B-TH-004: the person ticked "Send outside this customer". */
  readonly sendOutside?: boolean | undefined
}

/** POST /sales/price-lists/:listId/versions/:versionId/pdf/send */
export async function sendPriceListPdf(caller: CommandCaller, listId: string, versionId: string, body: SendPriceListBody, idempotencyKey?: string) {
  const { context, list, version } = await versionFor(caller, listId, versionId, true)
  // The mail leaves from the list's company (its sending address); a list of every company has none of its own.
  if (list.companyId === null) throw new InvalidStateError(`${list.code} is a list of every company: it has no company to send from. Keep its PDF on a company's letterhead and send it from that company's mail.`)
  const facts = await caller.withClient(async (db) => {
    const party = await db.party.findUnique({ where: { id: body.partyId }, select: { id: true, code: true, companyId: true } })
    const contact = party
      ? await db.partyContact.findFirst({ where: { partyId: party.id, status: 'ACTIVE', email: { not: null } }, select: { email: true, roles: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }).then(async (first) => (await db.partyContact.findFirst({ where: { partyId: party.id, status: 'ACTIVE', roles: { has: 'ORDERS' }, email: { not: null } }, select: { email: true, roles: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })) ?? first)
      : null
    const sender = await db.user.findUnique({ where: { id: context.actorId }, select: { id: true, displayName: true, email: true } })
    // The list's company sends it (a customer of every company has a thread without a company: its address is named here).
    const identity = await db.emailIdentity.findFirst({ where: { companyId: list.companyId!, kind: 'CONVERSATION', isDefault: true, status: 'ACTIVE' }, select: { id: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
    return { party, contact, sender, identity }
  })
  if (!facts.party) throw new ValidationError('Not a customer of yours.', [{ path: 'body/partyId', message: 'Not a customer of yours.' }])
  if (facts.party.companyId !== null && facts.party.companyId !== list.companyId) throw new ValidationError(`${facts.party.code} is a customer of another company than ${list.code}.`, [{ path: 'body/partyId', message: "A customer of the list's company." }])
  if (!can(actorOf(context), PRICE_LISTS_MANAGE, { companyId: list.companyId, partyId: facts.party.id })) throw new ForbiddenError()
  const to = body.to && body.to.length > 0 ? [...body.to] : facts.contact?.email ? [facts.contact.email] : []
  if (to.length === 0) throw new ValidationError('The customer has no active contact with an e-mail address: give the address to send to.', [{ path: 'body/to', message: 'Give at least one address.' }])
  if (!facts.sender) throw new NotFoundError('Your user was not found.')
  const party = facts.party
  const sender = facts.sender
  const prepared = await prepare(caller, list, version, list.companyId, body.language)
  // Kept first (its own command; the same contents give the newest back), then copied onto the customer outside any transaction.
  const kept = prepared.current ? { ...prepared.current, made: false } : (await command(caller, { name: 'priceLists.keepPdf', idempotencyKey: idempotencyKey ? `${idempotencyKey}:keep` : undefined, input: { listId, versionId, language: prepared.language } }, (tools) => keepInCommand(tools, list, version, prepared))).result
  const copy = await prepareFileCopy(processFiles(), caller, kept.fileId, { companyId: list.companyId, recordType: 'Party', recordId: party.id, kind: 'DOCUMENT', visibility: ['OFFICE', 'PARTNER'], partyId: party.id })
  const { result } = await command(caller, { name: 'priceLists.sendPdf', idempotencyKey, input: { listId, versionId, ...body } }, async (tools) => {
    const file = await recordGeneratedFile(tools, copy)
    const mail = priceListMail({ language: prepared.language, code: list.code, name: list.name, revision: version.revision, message: body.message ?? null })
    const sent = await sendEmail(tools, {
      record: { type: 'Party', id: party.id },
      sender: { userId: sender.id, name: sender.displayName, email: sender.email },
      identityId: facts.identity?.id ?? null,
      to,
      cc: body.cc,
      sendOutside: body.sendOutside, // B-TH-004
      subject: body.subject?.trim() ? body.subject.trim() : mail.subject,
      body: mail.body,
      attachments: [file.id],
      locale: prepared.language,
    })
    tools.audit({ action: 'priceLists.sendPdf', recordType: 'PriceList', recordId: list.id, companyId: list.companyId, after: { versionId: version.id, revision: version.revision, pdfVersion: kept.version, fileId: kept.fileId, copyId: file.id, partyId: party.id, outboundId: sent.outbound.id, to } })
    tools.emit({ type: 'price_list.pdf_sent', subject: list.id, companyId: list.companyId, payload: { listId: list.id, versionId: version.id, revision: version.revision, pdfVersion: kept.version, partyId: party.id, outboundId: sent.outbound.id } })
    return { version: kept.version, made: kept.made, fileId: kept.fileId, copyId: file.id, outboundId: sent.outbound.id, threadId: sent.thread.id }
  })
  return { ...result, pdf: await readState(caller, list, version) }
}
