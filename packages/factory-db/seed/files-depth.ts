import { createHash } from 'node:crypto'
import type { Prisma } from '../src/generated/prisma/client'
import { FileUploadStatus, PartyRole, RequiredDocumentLevel } from '../src/generated/prisma/enums'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedFiles } from './files'

/**
 * The files-in-depth seed (W2b schema wave 18/22, B-W2b-153), per tenant of seed/_core.ts, written in the tenant's office
 * scope as the app does (the API writes a partner's or a link's rows as the tenant's system caller too). The CLI runs the
 * seed files in name order and this one sorts before files.ts, so it runs the files seed first (idempotent): the tenant's
 * file store and its first files. Rows only: no object is in any store. Every name is made up. Expiry dates count from
 * today (Europe/Rome), so "expires in 20 days" stays true whenever it runs.
 *
 *   versions     party P1's (a tannery's) LWG certificate: v1 (expired 10 days ago) SUPERSEDED by v2 (expires in 20 days;
 *                its 30-day reminder went out 10 days ago), both shared with P1's portal; a sample photo v1 (with its
 *                thumbnail, EXIF stripped) SUPERSEDED by v2, the picture the office's markup made.
 *   copies       certificate v2 copied onto company A's own files (the same bytes, naming its source).
 *   uploads      a 20 MiB tech pack in 4 parts of 5 MiB: one just started (OPEN, no part yet), one resumable (OPEN, 2 of 4
 *                parts), one COMPLETED whose file is AVAILABLE.
 *   markups      an office overlay on page 1 of the company's cost sheet (a PDF), a link's overlay (party P1) on page 1 of
 *                P1's test report, and the office's circles on the sample photo (the new version above).
 *   rules        company A: a PO is CONFIRMED with the supplier's certificate (BLOCK), a supplier becomes ACTIVE with its
 *                questionnaire (WARN), a receipt is POSTED with its test report (WARN, any party), and a PO declaration rule
 *                switched off; company B: a PO declaration (WARN).
 *
 * The generated isolation tests (src/isolation.pg.vitest.test.ts) copy the FIRST row of each table by id and insert the
 * copy: so the first upload session is the OPEN one with no part (a copy of it is a second session of the pending file),
 * the first markup the office's PDF overlay (no new version: one markup makes one version), the first rule the one switched
 * off (one active rule per record type, document, status and party role).
 */

/** Fixed instants, so the rows never depend on the clock (expiry dates aside). */
const AT = new Date('2026-10-28T08:00:00.000Z')
const DAY_MS = 86_400_000
const MIB = 1_048_576
const PART = 5 * MIB
const TECH_PACK = 20 * MIB

/** Today in Europe/Rome as a UTC midnight. */
function romeToday(): Date {
  const iso = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  return new Date(`${iso}T00:00:00.000Z`)
}

export interface FilesDepthSeed {
  readonly files: {
    readonly certificateV1: string
    readonly certificateV2: string
    readonly certificateCopy: string
    readonly photoV1: string
    readonly photoV2: string
    readonly pendingTechPack: string
    readonly resumableTechPack: string
    readonly uploadedTechPack: string
    /** The files seed's: company A's cost sheet (a PDF, office only) and party P1's test report (a PDF, P1's portal). */
    readonly costSheet: string
    readonly partnerReport: string
  }
  readonly sessions: { readonly started: string; readonly resumable: string; readonly completed: string }
  readonly markups: { readonly officeOverlay: string; readonly partnerOverlay: string; readonly photo: string }
  readonly rules: { readonly off: string; readonly poCertificate: string; readonly supplierQuestionnaire: string; readonly receiptReport: string; readonly companyB: string }
}

export async function seed(context: SeedContext): Promise<FilesDepthSeed> {
  const { db, namespace } = context
  await seedFiles(context)
  const id = (key: string): string => seedUuid(namespace, key)
  const firstId = (key: string): string => `00000000${id(key).slice(8)}`
  const tenantId = id('tenant')
  const actorId = id('actor')
  const companyA = id('company:A')
  const companyB = id('company:B')
  const partyP1 = id('party:P1')
  const store = id('files:account:r2')
  const sha256 = (key: string): string => createHash('sha256').update(`seed file ${namespace} files-depth ${key}`).digest('hex')
  const key = (name: string): string => `t/${tenantId}/c/${companyA}/2026/${id(`files-depth:key:${name}`)}`
  const today = romeToday()
  const daysAgo = (days: number): Date => new Date(today.getTime() - days * DAY_MS)
  const daysAhead = (days: number): Date => new Date(today.getTime() + days * DAY_MS)

  const result: FilesDepthSeed = {
    files: {
      certificateV1: id('files-depth:certificate:v1'),
      certificateV2: id('files-depth:certificate:v2'),
      certificateCopy: id('files-depth:certificate:copy'),
      photoV1: id('files-depth:photo:v1'),
      photoV2: id('files-depth:photo:v2'),
      pendingTechPack: id('files-depth:tech-pack:started'),
      resumableTechPack: id('files-depth:tech-pack:resumable'),
      uploadedTechPack: id('files-depth:tech-pack:uploaded'),
      costSheet: id('files:office'),
      partnerReport: id('files:partner:P1'),
    },
    sessions: { started: firstId('files-depth:upload:started'), resumable: id('files-depth:upload:resumable'), completed: id('files-depth:upload:completed') },
    markups: { officeOverlay: firstId('files-depth:markup:office-overlay'), partnerOverlay: id('files-depth:markup:partner-overlay'), photo: id('files-depth:markup:photo') },
    rules: {
      off: firstId('files-depth:rule:po-declaration-off'),
      poCertificate: id('files-depth:rule:po-certificate'),
      supplierQuestionnaire: id('files-depth:rule:supplier-questionnaire'),
      receiptReport: id('files-depth:rule:receipt-report'),
      companyB: id('files-depth:rule:company-b-po-declaration'),
    },
  }
  const { files, sessions, markups, rules } = result
  const office = { audience: 'office', tenantId, actorId } as const
  const select = { id: true } as const

  const done = await db.withScope(office, (client) => client.fileMarkup.findUnique({ where: { id: markups.officeOverlay }, select }))
  if (done) return result

  const available = { status: 'AVAILABLE', availableAt: AT, storeAccountId: store, createdAt: AT, updatedAt: AT, createdById: actorId } as const
  const certificate = (version: 1 | 2): Prisma.StoredFileCreateManyInput => ({
    id: version === 1 ? files.certificateV1 : files.certificateV2,
    companyId: companyA,
    recordType: 'Party',
    recordId: partyP1,
    kind: 'CERTIFICATE',
    category: 'SUPPLIER_CERTIFICATE',
    originalName: `Seed tannery LWG certificate ${version === 1 ? 2025 : 2026}.pdf`,
    contentType: 'application/pdf',
    sizeBytes: version === 1 ? 4096 : 4608,
    sha256: sha256(`certificate v${version}`),
    storageKey: key(`certificate:v${version}`),
    visibility: ['OFFICE', 'PARTNER'],
    partyId: partyP1,
    expiresOn: version === 1 ? daysAgo(10) : daysAhead(20),
    ...(version === 2 ? { seriesId: files.certificateV1, versionNo: 2 } : {}),
    ...available,
    createdAt: version === 1 ? new Date(AT.getTime() - 365 * DAY_MS) : AT,
    availableAt: version === 1 ? new Date(AT.getTime() - 365 * DAY_MS) : AT,
  })
  const photo = (version: 1 | 2): Prisma.StoredFileCreateManyInput => ({
    id: version === 1 ? files.photoV1 : files.photoV2,
    companyId: companyA,
    recordType: 'Company',
    recordId: companyA,
    kind: 'PHOTO',
    category: 'SAMPLE_PHOTO',
    originalName: version === 1 ? 'Seed sample jacket front.jpg' : 'Seed sample jacket front (marked).png',
    contentType: version === 1 ? 'image/jpeg' : 'image/png',
    sizeBytes: version === 1 ? 6144 : 7168,
    sha256: sha256(`photo v${version}`),
    storageKey: key(`photo:v${version}`),
    visibility: ['OFFICE'],
    ...(version === 2 ? { seriesId: files.photoV1, versionNo: 2 } : {}),
    ...available,
  })
  const techPack = (fileId: string, name: string, keyName: string): Prisma.StoredFileCreateManyInput => ({
    id: fileId,
    companyId: companyA,
    recordType: 'Company',
    recordId: companyA,
    kind: 'DOCUMENT',
    originalName: name,
    contentType: 'application/pdf',
    sizeBytes: TECH_PACK,
    sha256: sha256(keyName),
    storageKey: key(keyName),
    visibility: ['OFFICE'],
    status: 'PENDING_UPLOAD',
    storeAccountId: store,
    createdAt: AT,
    updatedAt: AT,
    createdById: actorId,
  })
  const part = (partNumber: number) => ({ partNumber, etag: `"seed-${namespace}-part-${partNumber}"`, sizeBytes: PART })
  // An open session started two hours before the seed ran and lives the store's seven days, so it is still resumable for a
  // week after seeding (then the sweep gives it up); the completed one is of the fixed instant.
  const startedAt = new Date(Date.now() - 2 * 3_600_000)
  const session = (sessionId: string, fileId: string, name: string, at: Date): Prisma.FileUploadSessionCreateManyInput => ({
    id: sessionId,
    fileId,
    uploadId: `seed-multipart-${namespace}-${name}`,
    partSizeBytes: PART,
    expiresAt: new Date(at.getTime() + 7 * DAY_MS),
    createdAt: at,
    updatedAt: at,
    createdById: actorId,
  })
  const rule = (ruleId: string, companyId: string, recordType: string, category: Prisma.RequiredDocumentRuleCreateManyInput['category'], beforeStatus: string, partyRole: PartyRole | null, level: RequiredDocumentLevel, active = true): Prisma.RequiredDocumentRuleCreateManyInput => ({
    id: ruleId,
    companyId,
    recordType,
    category,
    beforeStatus,
    partyRole,
    level,
    active,
    createdAt: AT,
    updatedAt: AT,
    createdById: actorId,
  })

  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      // Versions: v2 is made, then v1 superseded (one current version per series at commit).
      await tx.storedFile.create({ data: certificate(1), select })
      await tx.storedFile.create({ data: certificate(2), select })
      await tx.storedFile.update({ where: { id: files.certificateV1 }, data: { supersededAt: AT, version: { increment: 1 } }, select })
      await tx.storedFile.update({ where: { id: files.certificateV2 }, data: { expiryRemindedAt: daysAgo(10), version: { increment: 1 } }, select })
      // A copy: the same bytes on another record, naming its source.
      const v2 = certificate(2)
      await tx.storedFile.create({
        data: {
          id: files.certificateCopy,
          companyId: companyA,
          recordType: 'Company',
          recordId: companyA,
          kind: 'DOCUMENT',
          originalName: 'Seed tannery LWG certificate 2026 (copy).pdf',
          contentType: v2.contentType,
          sizeBytes: v2.sizeBytes,
          sha256: v2.sha256,
          storageKey: key('certificate:copy'),
          visibility: ['OFFICE'],
          sourceFileId: files.certificateV2,
          ...available,
        },
        select,
      })
      // The sample photo: its thumbnail (EXIF stripped), then the office's markup making v2, then v1 superseded.
      await tx.storedFile.create({ data: photo(1), select })
      await tx.storedFile.update({ where: { id: files.photoV1 }, data: { thumbnailKey: key('photo:v1:thumbnail'), exifStrippedAt: AT, version: { increment: 1 } }, select })
      await tx.storedFile.create({ data: { ...photo(2), thumbnailKey: key('photo:v2:thumbnail'), exifStrippedAt: AT }, select })
      await tx.fileMarkup.createMany({
        data: [
          {
            id: markups.officeOverlay,
            fileId: files.costSheet,
            page: 1,
            shapes: [{ kind: 'CIRCLE', x: 0.62, y: 0.71, radius: 0.04, colour: 'danger' }],
            note: 'Check this total against the costing.',
            createdById: actorId,
            createdAt: AT,
          },
          {
            id: markups.partnerOverlay,
            fileId: files.partnerReport,
            page: 1,
            shapes: [{ kind: 'ARROW', from: { x: 0.2, y: 0.9 }, to: { x: 0.35, y: 0.82 }, colour: 'warning' }],
            note: 'The signed page is the second one.',
            partyId: partyP1,
            createdAt: AT,
          },
          {
            id: markups.photo,
            fileId: files.photoV1,
            shapes: [
              { kind: 'CIRCLE', x: 0.48, y: 0.33, radius: 0.06, colour: 'danger' },
              { kind: 'TEXT', x: 0.55, y: 0.28, text: 'Loose stitch', colour: 'danger' },
            ],
            note: 'Loose stitch on the collar seam.',
            resultFileId: files.photoV2,
            createdById: actorId,
            createdAt: AT,
          },
        ],
      })
      await tx.storedFile.update({ where: { id: files.photoV1 }, data: { supersededAt: AT, version: { increment: 1 } }, select })
      // Uploads in parts.
      await tx.storedFile.createMany({
        data: [
          techPack(files.pendingTechPack, 'Seed tech pack JKT-01.pdf', 'tech-pack:started'),
          techPack(files.resumableTechPack, 'Seed tech pack JKT-02.pdf', 'tech-pack:resumable'),
          techPack(files.uploadedTechPack, 'Seed tech pack JKT-03.pdf', 'tech-pack:uploaded'),
        ],
      })
      await tx.fileUploadSession.createMany({
        data: [
          session(sessions.started, files.pendingTechPack, 'started', startedAt),
          session(sessions.resumable, files.resumableTechPack, 'resumable', startedAt),
          session(sessions.completed, files.uploadedTechPack, 'completed', AT),
        ],
      })
      await tx.fileUploadSession.update({ where: { id: sessions.resumable }, data: { partsDone: [part(1), part(2)], version: { increment: 1 } }, select })
      await tx.fileUploadSession.update({ where: { id: sessions.completed }, data: { partsDone: [part(2), part(1), part(4), part(3)], version: { increment: 1 } }, select })
      await tx.fileUploadSession.update({
        where: { id: sessions.completed },
        data: { status: FileUploadStatus.COMPLETED, endedAt: new Date(AT.getTime() + 3_600_000), version: { increment: 1 } },
        select,
      })
      await tx.storedFile.update({ where: { id: files.uploadedTechPack }, data: { status: 'AVAILABLE', availableAt: new Date(AT.getTime() + 3_600_000), version: { increment: 1 } }, select })
      // Required documents.
      await tx.requiredDocumentRule.createMany({
        data: [
          rule(rules.off, companyA, 'PurchaseOrder', 'DECLARATION', 'CONFIRMED', PartyRole.SUPPLIER, RequiredDocumentLevel.WARN, false),
          rule(rules.poCertificate, companyA, 'PurchaseOrder', 'SUPPLIER_CERTIFICATE', 'CONFIRMED', PartyRole.SUPPLIER, RequiredDocumentLevel.BLOCK),
          rule(rules.supplierQuestionnaire, companyA, 'Party', 'QUESTIONNAIRE', 'ACTIVE', PartyRole.SUPPLIER, RequiredDocumentLevel.WARN),
          rule(rules.receiptReport, companyA, 'GoodsReceipt', 'TEST_REPORT', 'POSTED', null, RequiredDocumentLevel.WARN),
          rule(rules.companyB, companyB, 'PurchaseOrder', 'DECLARATION', 'CONFIRMED', PartyRole.SUPPLIER, RequiredDocumentLevel.WARN),
        ],
      })
    }),
  )
  return result
}
