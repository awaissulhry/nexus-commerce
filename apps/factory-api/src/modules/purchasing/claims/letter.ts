import { createHash } from 'node:crypto'
import { DomainError, type Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { addressLine, legalFooter, legalLines, legalName, legalProblems } from '@nexus/factory-domain/documents/legal'
import type { CompanyLegal, DocumentLanguage } from '@nexus/factory-domain/documents/model'
import { identityAt } from '@nexus/factory-domain/parties/tax'
import { claimLetter, letterFingerprintText, type ClaimLetterInput } from '@nexus/factory-domain/purchasing/claims/letter'
import { PURCHASING_CLAIMS_MANAGE } from '@nexus/factory-domain/purchasing/claims/permissions'
import { CLAIM_REASON_LIST, claimReasonOf, type ClaimFoundAt, type ClaimKind, type ClaimRemedy } from '@nexus/factory-domain/purchasing/claims/rules'
import { supplierLanguageOf } from '@nexus/factory-domain/purchasing/orders'
import { PURCHASING_VIEW } from '@nexus/factory-domain/purchasing/permissions'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { companyLegalOf } from '../../../platform/documents/documents'
import { putGeneratedFile, recordGeneratedFile, type PreparedGeneratedFile } from '../../../platform/files/files'
import type { FilesRuntime } from '../../../platform/files/service'
import { renderDiscrepancyReport } from '../../inventory/receipts/report'
import { TAX_COLUMNS, taxFieldsOf } from '../../parties/store'
import type { Reader } from '../store'
import { CLAIM_RECORD, claimInCommand, officeClaim, readLines, type ClaimRow } from './store'

/**
 * The claim letter to the supplier (B-W2b-14; SCM-135; Z1:08; design purchasing.claims rec "Supplier claim › Claim":
 * "what is wrong, with evidence and the remedy asked"): a PDF without prices (Owner answer C2) composed in the supplier's
 * language by factory-domain purchasing/claims/letter and painted with the discrepancy report's A4 renderer. Each
 * version kept is a GeneratedDocument CLAIM_LETTER of the claim (version 1, 2, … per claim; the newest is the current
 * one) with its StoredFile — a DOCUMENT of the SupplierClaim shared with the supplier's party, so the claim's mail can
 * carry it (platform/threads: only a file of the record shared with its party is attached).
 *
 *   GET  /purchasing/claims/:claimId/letter?language=   purchasing.view: the PDF with the "preview" banner, made in memory
 *                                                        and stored nowhere (default: the supplier's language)
 *   POST /purchasing/claims/:claimId/letter {language?}  purchasing.claims.manage: keeps a version (to print or post by
 *                                                        hand); the same contents as the newest give it back unchanged
 *   the send (send.ts)                                   a mail to the supplier carries the current letter, made then
 *
 * Making a version: (1) the facts read and the letter composed; its fingerprint = SHA-256 of the letter's contents
 * (factory-domain letterFingerprintText: the same claim, words and language give the same text, whatever the day);
 * (2) the same as the newest version: nothing is written; the same as an earlier one: a new version naming that
 * version's file; else the PDF is put in the file store OUTSIDE any transaction (putGeneratedFile); (3) ONE command under
 * the claim's letter lock (`factory.claim-letter|claim`): the next version number, the StoredFile row (recordGeneratedFile),
 * the GeneratedDocument row, the audit row and `supplier_claim.updated` {fields: ['letter']}. The company's letterhead
 * must be complete (c.c. art. 2250): refused in words otherwise, and a send then mails without the letter.
 */

export const LETTER_KIND = 'CLAIM_LETTER' as const

/** The facts the letter prints, read with the caller's client (a scoped client or a command's transaction). */
async function letterInputOf(db: Reader, claim: ClaimRow, company: CompanyLegal, options: { readonly language: DocumentLanguage; readonly sample: boolean; readonly remedy?: ClaimRemedy | null | undefined }): Promise<ClaimLetterInput> {
  const language = options.language
  const lines = await readLines(db, claim.id)
  const items = new Map((await db.item.findMany({ where: { id: { in: [...new Set(lines.map((line) => line.itemId))] } }, select: { id: true, code: true, name: true, nameI18n: true } })).map((row) => [row.id, row]))
  const colours = new Map((await db.itemColour.findMany({ where: { id: { in: lines.flatMap((line) => (line.itemColourId ? [line.itemColourId] : [])) } }, select: { id: true, name: true } })).map((row) => [row.id, row.name]))
  const lots = new Map((await db.lot.findMany({ where: { id: { in: lines.flatMap((line) => (line.lotId ? [line.lotId] : [])) } }, select: { id: true, code: true, supplierLotRef: true } })).map((row) => [row.id, row]))
  const hides = new Map((await db.hide.findMany({ where: { id: { in: lines.flatMap((line) => (line.hideId ? [line.hideId] : [])) } }, select: { id: true, code: true, supplierCode: true } })).map((row) => [row.id, row]))
  const discrepancies = new Map((await db.receiptDiscrepancy.findMany({ where: { id: { in: lines.flatMap((line) => (line.discrepancyId ? [line.discrepancyId] : [])) } }, select: { id: true, seq: true } })).map((row) => [row.id, row.seq]))
  const { code, note } = claimReasonOf(claim)
  const reason = code ? await db.reasonCode.findFirst({ where: { list: CLAIM_REASON_LIST, code }, select: { labelIt: true, labelEn: true } }) : null
  const receipt = claim.goodsReceiptId ? await db.goodsReceipt.findUnique({ where: { id: claim.goodsReceiptId }, select: { number: true, supplierDdtNumber: true, supplierDdtDate: true } }) : null
  const order = claim.purchaseOrderId ? await db.purchaseOrder.findUnique({ where: { id: claim.purchaseOrderId }, select: { number: true } }) : null
  const party = await db.party.findUniqueOrThrow({ where: { id: claim.partyId }, select: { id: true, legalName: true } })
  const addresses = await db.partyAddress.findMany({
    where: { partyId: party.id, status: 'ACTIVE' },
    select: { kinds: true, isDefaultBillTo: true, line1: true, line2: true, postalCode: true, city: true, province: true, country: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  const address = addresses.find((row) => row.kinds.includes('REGISTERED')) ?? addresses.find((row) => row.isDefaultBillTo) ?? addresses[0] ?? null
  const identity = identityAt((await db.partyTaxIdentity.findMany({ where: { partyId: party.id }, select: TAX_COLUMNS })).map(taxFieldsOf), businessDate(serverClock.now()))
  const ddts = await db.ddt.findMany({ where: { sourceType: CLAIM_RECORD, sourceId: claim.id, cancellations: { none: {} } }, select: { number: true }, orderBy: { id: 'asc' } })
  const photos = await db.storedFile.count({ where: { recordType: CLAIM_RECORD, recordId: claim.id, kind: 'PHOTO', status: 'AVAILABLE' } })
  const named = (names: unknown, fallback: string) => {
    const value = names !== null && typeof names === 'object' ? (names as Record<string, unknown>)[language] : null
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
  }
  return {
    language,
    date: businessDate(serverClock.now()),
    company: { name: legalName(company, language), lines: legalLines(company, language), legal: legalFooter(company, language) },
    supplier: { name: party.legalName, address: address ? addressLine(address, language) : null, vatNumber: identity?.vatNumber ?? null },
    number: claim.number,
    kind: claim.kind as ClaimKind,
    foundAt: claim.foundAt as ClaimFoundAt,
    remedy: (options.remedy !== undefined ? options.remedy : claim.remedy) as ClaimRemedy | null,
    reason: { label: reason ? (language === 'it' ? reason.labelIt : reason.labelEn) : null, note: code ? note : claim.reason },
    receiptNumber: receipt?.number ?? null,
    supplierDdtNumber: receipt?.supplierDdtNumber ?? null,
    supplierDdtDate: receipt?.supplierDdtDate ? businessDate(receipt.supplierDdtDate, 'UTC') : null,
    orderNumber: order?.number ?? null,
    returnDdts: ddts.map((ddt) => ddt.number),
    lines: lines.map((line) => {
      const item = items.get(line.itemId)
      const lot = line.lotId ? lots.get(line.lotId) : undefined
      const hide = line.hideId ? hides.get(line.hideId) : undefined
      return {
        seq: line.seq,
        code: item?.code ?? '',
        name: item ? named(item.nameI18n, item.name) : '',
        colour: line.itemColourId ? (colours.get(line.itemColourId) ?? null) : null,
        // The supplier's own references beside ours: its lot and the tannery's hide number.
        lot: lot ? (lot.supplierLotRef ? `${lot.code} / ${lot.supplierLotRef}` : lot.code) : null,
        hide: hide ? (hide.supplierCode ? `${hide.code} / ${hide.supplierCode}` : hide.code) : null,
        quantity: line.quantity.toFixed(4),
        uom: line.uom,
        reason: line.reason,
        note: line.note,
        discrepancySeq: line.discrepancyId ? (discrepancies.get(line.discrepancyId) ?? null) : null,
      }
    }),
    photos,
    sample: options.sample,
  }
}

/** The supplier's language for the letter: its first contact's (QUALITY, then ORDERS), else the party's. */
async function supplierLanguage(db: Reader, partyId: string): Promise<DocumentLanguage> {
  const party = await db.party.findUniqueOrThrow({ where: { id: partyId }, select: { language: true } })
  const contacts = await db.partyContact.findMany({ where: { partyId, status: 'ACTIVE', email: { not: null } }, select: { roles: true, language: true }, orderBy: [{ name: 'asc' }, { id: 'asc' }] })
  const rank = (roles: readonly string[]) => (roles.includes('QUALITY') ? 0 : roles.includes('ORDERS') ? 1 : 2)
  const first = [...contacts].sort((a, b) => rank(a.roles) - rank(b.roles))[0]
  return supplierLanguageOf(first?.language ?? null, party.language)
}

const refusal = (issues: readonly Issue[]) => new DomainError('conflict', issues.length === 1 ? issues[0]!.message : 'The claim letter cannot be made as it stands.', [...issues])

/** GET /purchasing/claims/:claimId/letter: the PDF as the supplier would get it, with the preview banner. */
export async function previewLetter(caller: CommandCaller, claimId: string, query: { readonly language?: DocumentLanguage | undefined }): Promise<{ pdf: Buffer; fileName: string }> {
  const { claim } = await officeClaim(caller, claimId, PURCHASING_VIEW)
  const company = await companyLegalOf(caller, claim.companyId)
  const legal = legalProblems(company)
  if (legal.length > 0) throw refusal(legal)
  const report = await caller.withClient(async (client) => claimLetter(await letterInputOf(client, claim, company, { language: query.language ?? (await supplierLanguage(client, claim.partyId)), sample: true })))
  return { pdf: await renderDiscrepancyReport(report), fileName: report.fileName }
}

/** A letter ready to be kept: its fingerprint and language, and either the file put in the store or an earlier version's file. */
export interface PreparedLetter {
  readonly fingerprint: string
  readonly language: DocumentLanguage
  readonly number: string
  /** The newest version already shows exactly this: nothing to write. */
  readonly current: { readonly id: string; readonly version: number; readonly fileId: string } | null
  /** An earlier version with the same contents (its file is named again by a new version). */
  readonly earlierFileId: string | null
  /** The PDF put in the store (neither above). */
  readonly file: PreparedGeneratedFile | null
}

/**
 * Prepares the claim's letter OUTSIDE any transaction (the store put): null when the company's letterhead is incomplete
 * (`problems` says why). `remedy`: the remedy the send chooses now (a draft that asked for nothing yet).
 */
export async function prepareLetter(files: FilesRuntime, caller: CommandCaller, claim: ClaimRow, options: { readonly language?: DocumentLanguage | undefined; readonly remedy?: ClaimRemedy | null | undefined } = {}): Promise<{ letter: PreparedLetter | null; problems: Issue[] }> {
  const company = await companyLegalOf(caller, claim.companyId)
  const problems = legalProblems(company)
  if (problems.length > 0) return { letter: null, problems }
  const { input, versions } = await caller.withClient(async (client) => {
    const language = options.language ?? (await supplierLanguage(client, claim.partyId))
    return {
      input: await letterInputOf(client, claim, company, { language, sample: false, remedy: options.remedy }),
      versions: await client.generatedDocument.findMany({ where: { recordType: CLAIM_RECORD, recordId: claim.id, kind: LETTER_KIND }, select: { id: true, version: true, fingerprint: true, language: true, fileId: true }, orderBy: { version: 'desc' } }),
    }
  })
  const fingerprint = createHash('sha256').update(letterFingerprintText(input)).digest('hex')
  const newest = versions[0]
  if (newest && newest.fingerprint === fingerprint && newest.language === input.language) {
    return { letter: { fingerprint, language: input.language, number: claim.number, current: { id: newest.id, version: newest.version, fileId: newest.fileId }, earlierFileId: null, file: null }, problems: [] }
  }
  const earlier = versions.find((version) => version.fingerprint === fingerprint && version.language === input.language)
  if (earlier) return { letter: { fingerprint, language: input.language, number: claim.number, current: null, earlierFileId: earlier.fileId, file: null }, problems: [] }
  const report = claimLetter(input)
  const pdf = await renderDiscrepancyReport(report)
  const file = await putGeneratedFile(files, caller, {
    companyId: claim.companyId,
    recordType: CLAIM_RECORD,
    recordId: claim.id,
    kind: 'DOCUMENT',
    originalName: report.fileName,
    contentType: 'application/pdf',
    body: pdf,
    // The claim mail's attachment: shared with the supplier's party (no price on it).
    visibility: ['OFFICE', 'PARTNER'],
    partyId: claim.partyId,
  })
  return { letter: { fingerprint, language: input.language, number: claim.number, current: null, earlierFileId: null, file }, problems: [] }
}

/**
 * Keeps a prepared letter inside the caller's command (the claim's row is held by it, or the letter lock is taken
 * here): the file's row when it was put now, the next version, the audit row and the event. Answers the version kept.
 */
export async function keepLetterInCommand(tools: CommandTools, claimId: string, letter: PreparedLetter): Promise<{ id: string; version: number; fileId: string; made: boolean }> {
  const { tx } = tools
  if (letter.current) return { ...letter.current, made: false }
  const claim = await claimInCommand(tx, claimId)
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.claim-letter', ${claim.id}::uuid), 0))`
  const last = await tx.generatedDocument.findFirst({ where: { recordType: CLAIM_RECORD, recordId: claim.id, kind: LETTER_KIND }, select: { id: true, version: true, fingerprint: true, language: true, fileId: true }, orderBy: { version: 'desc' } })
  // Made meanwhile by someone else with the same contents: that one (audited as kept unchanged).
  if (last && last.fingerprint === letter.fingerprint && last.language === letter.language) {
    tools.audit({ action: 'purchasing.claims.letter', recordType: CLAIM_RECORD, recordId: claim.id, companyId: claim.companyId, siteId: claim.siteId, after: { generatedDocumentId: last.id, version: last.version, unchanged: true } })
    return { id: last.id, version: last.version, fileId: last.fileId, made: false }
  }
  const fileId = letter.file ? (await recordGeneratedFile(tools, letter.file, { details: { documentType: LETTER_KIND, number: claim.number, language: letter.language } })).id : letter.earlierFileId!
  const id = newId()
  const version = (last?.version ?? 0) + 1
  await tx.generatedDocument.create({
    data: { id, companyId: claim.companyId, siteId: claim.siteId, recordType: CLAIM_RECORD, recordId: claim.id, kind: LETTER_KIND, version, fingerprint: letter.fingerprint, language: letter.language, number: claim.number, fileId, createdAt: tools.now, createdById: tools.context.audience === 'office' ? tools.context.actorId : null },
    select: { id: true },
  })
  tools.audit({ action: 'purchasing.claims.letter', recordType: CLAIM_RECORD, recordId: claim.id, companyId: claim.companyId, siteId: claim.siteId, after: { generatedDocumentId: id, version, language: letter.language, fileId, fingerprint: letter.fingerprint, reused: letter.file === null } })
  tools.emit({ type: 'supplier_claim.updated', subject: claim.id, companyId: claim.companyId, siteId: claim.siteId, payload: { supplierClaimId: claim.id, number: claim.number, status: claim.status as never, fields: ['letter'] } })
  return { id, version, fileId, made: true }
}

/** POST /purchasing/claims/:claimId/letter: keeps the current letter as a version (see the file's comment). */
export async function makeLetter(files: FilesRuntime, caller: CommandCaller, claimId: string, body: { readonly language?: DocumentLanguage | undefined }, idempotencyKey?: string) {
  const { claim } = await officeClaim(caller, claimId, PURCHASING_CLAIMS_MANAGE)
  const { letter, problems } = await prepareLetter(files, caller, claim, { language: body.language })
  if (!letter) throw refusal(problems)
  // The newest version shows exactly this already: nothing to write.
  const result = letter.current ? { ...letter.current, made: false } : (await command(caller, { name: 'purchasing.claims.letter', idempotencyKey, input: { claimId, ...body } }, async (tools) => keepLetterInCommand(tools, claimId, letter))).result
  const row = await caller.withClient((client) => client.generatedDocument.findUniqueOrThrow({ where: { id: result.id }, select: { id: true, version: true, language: true, number: true, fileId: true, createdAt: true, createdById: true } }))
  return { letter: { ...row, createdAt: toUtcIso(row.createdAt) }, made: result.made }
}
