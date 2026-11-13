import { can } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { daysUntil, dayOf } from '@nexus/factory-domain/files/expiry/rules'
import { FILES_UPLOAD } from '@nexus/factory-domain/auth/permissions/catalogue'
import { PARTIES_VIEW } from '@nexus/factory-domain/parties/permissions'
import { SUPPLIER_CHANGES_DECIDE, SUPPLIER_DOCUMENTS_REVIEW } from '@nexus/factory-domain/purchasing/portal-profile/permissions'
import { LAW } from '@nexus/factory-domain/purchasing/qualification/gate'
import { PURCHASING_QUALIFICATION_MANAGE } from '@nexus/factory-domain/purchasing/qualification/permissions'
import { askedOf, askStateOf, bestDocument, documentStateOf, unlocksWords, VAULT_CATEGORIES } from '@nexus/factory-domain/purchasing/qualification/vault'
import { documentsFor } from '../suppliers/document-types'
import { hasSupplierRole, type SupplierKind } from '@nexus/factory-domain/purchasing/suppliers-depth/rules'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { officeContextOf, type Reader } from '../store'
import { readSupplier, type SupplierRow } from '../suppliers-depth/store'
import { certificatesFor, vaultFilesOf, type VaultFile } from './store'

/**
 * The supplier document vault (B-W2b-315; SCM-020; follow-up VN2:01 "The office review of supplier documents and profile
 * changes gets its screen (Supplier › Documents & qualification)"; design purchasing.suppliers › Documents & qualification
 * › Documents "Type, issuer, number, issued, expires (Countdown), file; Status: Valid · Expires in 30 days · Expired ·
 * Missing (required by a material); Gate sentence: 'POs for A12 and A14 need a valid chromium VI test to be sent'"):
 *
 *   GET /purchasing/suppliers/:partyId/documents      what we ask of it (per kind, per material it sells us), what is in
 *                                                     force and until when, what each unlocks; and the office review: its
 *                                                     uploads waiting for our check and its profile changes waiting
 *                                                     (decided with B-W2b-189's routes, named in `review`)
 *   GET /purchasing/suppliers/documents-summary       per supplier: documents valid, expiring in 30 days, expired, missing
 *                                                     (the list's Documents column and its "Documents expiring in 30 days")
 *
 * parties.view over the supplier's company and the supplier; no money.
 */

const EXPIRING_DAYS = 30

interface MaterialRow {
  readonly itemId: string
  readonly code: string
  readonly name: string
  readonly kind: string
  readonly articleCodes: string[]
  readonly requiresCrViTest: boolean
  readonly isPpeComponent: boolean
}

/** The materials the supplier sells us: its ACTIVE approved sources and the materials it is the default supplier of. */
async function materialsOf(db: Reader, partyId: string): Promise<MaterialRow[]> {
  const sources = await db.supplierItem.findMany({ where: { partyId, status: 'ACTIVE' }, select: { itemId: true, supplierArticleCode: true }, take: 500 })
  const defaults = await db.item.findMany({ where: { defaultSupplierId: partyId, status: 'ACTIVE' }, select: { id: true }, take: 500 })
  const ids = [...new Set([...sources.map((row) => row.itemId), ...defaults.map((row) => row.id)])]
  if (ids.length === 0) return []
  const items = await db.item.findMany({ where: { id: { in: ids } }, select: { id: true, code: true, name: true, kind: true, supplierArticleCode: true, requiresCrViTest: true, isPpeComponent: true }, orderBy: [{ code: 'asc' }, { id: 'asc' }] })
  return items.map((item) => ({
    itemId: item.id,
    code: item.code,
    name: item.name,
    kind: item.kind,
    articleCodes: [...new Set([item.code, item.supplierArticleCode, ...sources.filter((row) => row.itemId === item.id).map((row) => row.supplierArticleCode)].filter((code): code is string => !!code))],
    requiresCrViTest: item.requiresCrViTest,
    isPpeComponent: item.isPpeComponent,
  }))
}

const documentView = (doc: VaultFile, today: BusinessDate) => ({
  fileId: doc.fileId,
  category: doc.category,
  // B-W2b-377: what document it is (null: nobody said; it still meets its category's asks).
  documentTypeCode: doc.documentTypeCode,
  name: doc.name,
  issuer: doc.issuer,
  number: doc.number,
  issuedOn: doc.issuedOn,
  expiresOn: doc.expiresOn,
  daysLeft: doc.expiresOn ? daysUntil(doc.expiresOn, today) : null,
  state: documentStateOf(doc.expiresOn, today),
  source: doc.source,
  uploadId: doc.uploadId,
  articleCodes: [...doc.articleCodes],
  addedAt: toUtcIso(doc.addedAt),
})

/** GET /purchasing/suppliers/:partyId/documents. */
export async function getVault(caller: CommandCaller, partyId: string) {
  const supplier = await readSupplier(caller, partyId)
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  const today = businessDate(serverClock.now())
  const read = await caller.withClient(async (client) => {
    const files = await vaultFilesOf(client, supplier.id)
    const materials = await materialsOf(client, supplier.id)
    const certificates = await certificatesFor(client, materials.filter((row) => row.isPpeComponent).map((row) => row.itemId), supplier.id, supplier.companyId, today)
    const yearAgo = new Date(serverClock.now().getTime() - 365 * 86_400_000)
    const uploads = await client.supplierDocumentUpload.findMany({
      where: { partyId: supplier.id, status: 'WAITING', receivedAt: { not: null, gte: yearAgo } },
      select: { id: true, fileId: true, companyId: true, recordType: true, recordId: true, recordLabel: true, category: true, issuer: true, documentNumber: true, issuedOn: true, expiresOn: true, articleCodes: true, lotCodes: true, note: true, replacesFileId: true, uploadedByName: true, receivedAt: true, version: true },
      orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
      take: 100,
    })
    const changes = await client.partyChangeRequest.findMany({ where: { partyId: supplier.id, status: 'OPEN' }, select: { id: true, companyId: true, summary: true, requestedByName: true, createdAt: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 50 })
    const responses = await client.supplierQuestionnaireResponse.findMany({ where: { partyId: supplier.id }, select: { id: true, companyId: true, decision: true, submittedAt: true, reviewedAt: true }, orderBy: [{ submittedAt: 'desc' }, { id: 'desc' }], take: 10 })
    return { files, materials, certificates, uploads, changes, responses }
  })
  const kinds = [...supplier.supplierKinds] as SupplierKind[]
  const waitingCategories = new Set(read.uploads.map((upload) => upload.category))
  const crViMaterials = read.materials.filter((row) => row.requiresCrViTest)
  const asked = askedOf(kinds).map((entry) => {
    // B-W2b-377: a document meets an ask by its type (or untyped, by its category as before).
    const doc = bestDocument(documentsFor(read.files, entry.codes), entry.category, today)
    const unlocks = entry.category === 'TEST_REPORT' ? unlocksWords(crViMaterials.map((row) => row.code), 'a valid chromium VI test report') : null
    return { ...entry, codes: [...entry.codes], laws: [...entry.laws], state: askStateOf(doc, today), fileId: doc?.fileId ?? null, expiresOn: doc?.expiresOn ?? null, waiting: waitingCategories.has(entry.category), unlocks: unlocks || null }
  })
  const materials = read.materials.flatMap((row) => {
    const out = []
    if (row.requiresCrViTest) {
      const doc = bestDocument(documentsFor(read.files, ['CR_VI_TEST_REPORT']), 'TEST_REPORT', today, row.articleCodes)
      const state = askStateOf(doc, today)
      const checked = kinds.includes('TANNERY')
      out.push({ itemId: row.itemId, code: row.code, name: row.name, kind: row.kind, needs: 'CR_VI_TEST_REPORT' as const, law: LAW.CR_VI_TEST_REPORT, state, fileId: doc?.fileId ?? null, certificate: null, expiresOn: doc?.expiresOn ?? null, checkedAtSend: checked, heldAtSend: checked && (state === 'MISSING' || state === 'EXPIRED') })
    }
    if (row.isPpeComponent) {
      const certificate = read.certificates.get(row.itemId) ?? null
      const state = certificate ? askStateOf({ expiresOn: certificate.validTo }, today) : 'MISSING'
      const checked = kinds.includes('PROTECTOR_MAKER')
      out.push({ itemId: row.itemId, code: row.code, name: row.name, kind: row.kind, needs: 'PPE_CERTIFICATE' as const, law: LAW.PPE_CERTIFICATE, state, fileId: null, certificate: certificate ? { id: certificate.id, number: certificate.number, standard: certificate.standard } : null, expiresOn: certificate?.validTo ?? null, checkedAtSend: checked, heldAtSend: checked && state === 'MISSING' })
    }
    return out
  })
  const heldCrVi = materials.filter((row) => row.needs === 'CR_VI_TEST_REPORT' && row.heldAtSend).map((row) => row.code)
  const heldPpe = materials.filter((row) => row.needs === 'PPE_CERTIFICATE' && row.heldAtSend).map((row) => row.code)
  const gateSentences = [unlocksWords(heldCrVi, 'a valid chromium VI test report'), unlocksWords(heldPpe, 'a valid certificate in the register')].filter((words) => words !== '')
  const documents = read.files.map((doc) => documentView(doc, today))
  const expiring = documents.filter((doc) => doc.state === 'EXPIRING').length
  const missingRequired = asked.filter((entry) => entry.required && (entry.state === 'MISSING' || entry.state === 'EXPIRED')).length
  const place = { companyId: supplier.companyId, partyId: supplier.id }
  return {
    supplier: { id: supplier.id, code: supplier.code, name: supplier.tradeName ?? supplier.legalName, kinds, roles: [...supplier.roles] },
    asked,
    materials,
    documents,
    gateSentences,
    nextStep:
      missingRequired > 0
        ? `${missingRequired} document${missingRequired === 1 ? '' : 's'} we ask for ${missingRequired === 1 ? 'is' : 'are'} missing or expired.`
        : expiring > 0
          ? `${expiring} document${expiring === 1 ? '' : 's'} expire${expiring === 1 ? 's' : ''} in ${EXPIRING_DAYS} days.`
          : 'Nothing waiting.',
    nextExpiry: documents.filter((doc) => doc.expiresOn !== null && doc.state !== 'EXPIRED').map((doc) => doc.expiresOn!).sort()[0] ?? null,
    emptyWords: documents.length === 0 ? 'No documents. Materials that need one will be held at PO send.' : null,
    review: {
      uploads: read.uploads.map((upload) => ({
        uploadId: upload.id,
        fileId: upload.fileId,
        companyId: upload.companyId,
        record: { type: upload.recordType, id: upload.recordId, label: upload.recordLabel },
        category: upload.category,
        issuer: upload.issuer,
        number: upload.documentNumber,
        issuedOn: upload.issuedOn ? dayOf(upload.issuedOn) : null,
        expiresOn: upload.expiresOn ? dayOf(upload.expiresOn) : null,
        articleCodes: [...upload.articleCodes],
        lotCodes: [...upload.lotCodes],
        note: upload.note,
        replacesFileId: upload.replacesFileId,
        uploadedByName: upload.uploadedByName,
        receivedAt: upload.receivedAt ? toUtcIso(upload.receivedAt) : null,
        version: upload.version,
      })),
      changes: read.changes.map((change) => ({ requestId: change.id, companyId: change.companyId, summary: change.summary, requestedByName: change.requestedByName, sentAt: toUtcIso(change.createdAt) })),
      /** B-W2b-189's routes decide them: POST /purchasing/supplier-documents/:fileId/accept|refuse, /purchasing/supplier-changes/:requestId/approve|refuse. */
      routes: { accept: '/purchasing/supplier-documents/:fileId/accept', refuse: '/purchasing/supplier-documents/:fileId/refuse', approveChange: '/purchasing/supplier-changes/:requestId/approve', refuseChange: '/purchasing/supplier-changes/:requestId/refuse' },
    },
    questionnaire: read.responses.map((row) => ({ responseId: row.id, companyId: row.companyId, decision: row.decision, submittedAt: toUtcIso(row.submittedAt), reviewedAt: row.reviewedAt ? toUtcIso(row.reviewedAt) : null })),
    may: {
      review: can(actor, SUPPLIER_DOCUMENTS_REVIEW, place),
      decideChanges: can(actor, SUPPLIER_CHANGES_DECIDE, place),
      upload: can(actor, FILES_UPLOAD, place),
      qualify: can(actor, PURCHASING_QUALIFICATION_MANAGE, place),
    },
  }
}

/** The counts of one supplier's vault on a day. */
function countsOf(row: Pick<SupplierRow, 'supplierKinds'>, files: readonly VaultFile[], today: BusinessDate) {
  const states = files.map((doc) => documentStateOf(doc.expiresOn, today))
  const missing = askedOf([...row.supplierKinds] as SupplierKind[]).filter((entry) => entry.required && askStateOf(bestDocument(documentsFor(files, entry.codes), entry.category, today), today) === 'MISSING').length
  return { valid: states.filter((state) => state === 'VALID').length, expiring: states.filter((state) => state === 'EXPIRING').length, expired: states.filter((state) => state === 'EXPIRED').length, missing }
}

/** GET /purchasing/suppliers/documents-summary?companyId= (parties.view per supplier). */
export async function vaultSummary(caller: CommandCaller, query: { readonly companyId?: string | undefined }) {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  const today = businessDate(serverClock.now())
  return caller.withClient(async (client) => {
    const parties = await client.party.findMany({
      where: { roles: { hasSome: ['SUPPLIER', 'SUBCONTRACTOR', 'CARRIER'] }, ...(query.companyId ? { OR: [{ companyId: query.companyId }, { companyId: null }] } : {}) },
      select: { id: true, code: true, companyId: true, roles: true, supplierKinds: true },
      orderBy: [{ code: 'asc' }, { id: 'asc' }],
      take: 2000,
    })
    const seen = parties.filter((row) => hasSupplierRole(row.roles) && can(actor, PARTIES_VIEW, { companyId: row.companyId, partyId: row.id }))
    const files = seen.length === 0 ? [] : await client.storedFile.findMany({ where: { recordType: 'Party', recordId: { in: seen.map((row) => row.id) }, status: 'AVAILABLE', supersededAt: null, category: { in: [...VAULT_CATEGORIES] } }, select: { id: true, recordId: true, category: true, expiresOn: true, documentTypeCode: true } })
    const byParty = new Map<string, VaultFile[]>()
    for (const file of files) {
      const doc = { fileId: file.id, category: file.category as VaultFile['category'], documentTypeCode: file.documentTypeCode, expiresOn: file.expiresOn ? dayOf(file.expiresOn) : null, articleCodes: [], name: '', addedAt: new Date(0), issuer: null, number: null, issuedOn: null, source: 'OFFICE' as const, uploadId: null, seriesId: file.id }
      byParty.set(file.recordId, [...(byParty.get(file.recordId) ?? []), doc])
    }
    const suppliers = seen.map((row) => ({ partyId: row.id, code: row.code, ...countsOf(row, byParty.get(row.id) ?? [], today) }))
    return { suppliers, expiringIn30Days: suppliers.filter((row) => row.expiring > 0).length }
  })
}
