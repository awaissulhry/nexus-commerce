import { createHash } from 'node:crypto'
import type { Prisma } from '../src/generated/prisma/client'
import {
  AnnexIIIPoint,
  ComplianceDocumentKind,
  ComplianceDocumentOrigin,
  ComplianceDocumentStatus,
  ComplianceTranslationStatus,
  ControlTestResult,
  EvidencePackPurpose,
  EvidencePackStatus,
  GarmentLabelSpoilKind,
  GeneratedDocumentKind,
  LabelArtworkStatus,
  LabelQrTarget,
  LabelTemplateKind,
  LabelTemplateStatus,
  ProductHazard,
  ProductionControlFrequency,
  ProductionControlTestKind,
  ProductRiskAssessmentStatus,
  ResidualRisk,
  TechnicalFileItemState,
  TechnicalFileStatus,
} from '../src/generated/prisma/enums'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedComplianceRules } from './compliance-rules'
import { seed as seedFiles } from './files'
import { seed as seedShipping } from './shipping'

/**
 * The declarations, technical files and labels seed (W2b-4, schema wave 32/33, B-W2b-218), per tenant of seed/_core.ts,
 * written in the tenant's office scope (the spoiled labels on plant A1's floor), as the app does. The CLI runs the seed files
 * in name order; this one runs the shipping seed (and through it quality, production and numbering), the compliance rule
 * library (markets, the register) and the files seed (the store account) first, all idempotent. Every name, number,
 * address and figure is made up.
 *
 *   documents     SEED-JKT-03's signed Italian DoC, revision 1 (ISSUED with its signed PDF, the live route) and its German
 *                 translation (ISSUED with its PDF, CHECKED by a second person, for the DE market); beside the signed one a
 *                 GENERATED Italian DoC of the same revision with its Annex IX points and their sources, and a GENERATED
 *                 Italian user information with its sections, protector positions and spare protectors, and its English
 *                 translation in translation: drafts until GATE-PPE-TEXTS. The brand P1 is the maker (it sells the style
 *                 under its own name). SEED-JKT-03, not SEED-JKT-01 or -02: the golden flows upload those two styles' signed
 *                 documents for revision 1 themselves.
 *   batches       revision 1 went with the typed batch SEED-BT-LEGACY-01, with WO-0003's batch SEED-BT-0003, and with that
 *                 batch in shipment SH-0002 (in Italian and German).
 *   files         SEED-JKT-01's first file ARCHIVED (kept ten years); SEED-JKT-02's OPEN, its Annex III items mixed (reviewed,
 *                 linked, missing, not applicable); SEED-JKT-03's COMPLETE (every point reviewed or not applicable).
 *   assessments   SEED-JKT-02: revision 1 SIGNED, revision 2 a DRAFT; SEED-JKT-03: revision 1 SIGNED.
 *   tests         a yearly seam strength test due; WO-0001's pocket retention PASS with its lab report; the typed batch's label
 *                 durability FAIL; a zip pull test (OTHER) due for WO-0001.
 *   packs         an authority pack BUILDING (German), one BUILT (Italian, PDF and ZIP, with its generated document), a customer
 *                 pack that FAILED, and SH-0002's shipment pack BUILT (with the shipment's compliance pack document).
 *   labels        a glove marking and a fibre and care label template (DRAFT: GPSR contact, origin claim, QR targets); the
 *                 jacket label's artwork: version 1 approved then retired, version 2 approved by a second person, version 3 a
 *                 draft.
 *   spoiled       on WO-0003's label print (three serial labels): one spoiled while sewing, one handed back.
 *
 * The generated isolation tests (src/isolation.pg.vitest.test.ts) copy the FIRST row of each table by id and insert the copy:
 * so the first batch record (a typed batch, no work order or shipment), technical file (ARCHIVED: one live per style), item (of
 * the OPEN file), risk assessment (a DRAFT) and its row, test (due), pack (BUILDING), artwork version (a DRAFT) and spoiled
 * labels get ids that start with eight zeros; the documents and templates get eight f's (W1's rows stay the first). Written
 * once, skipped when SEED-JKT-02's technical file exists.
 */

/** Fixed instants and days, so the seed never depends on the clock (and no test day lies ahead of today). */
const T = {
  legacy: new Date('2026-10-20T09:00:00.000Z'),
  issued: new Date('2026-10-28T10:00:00.000Z'),
  checked: new Date('2026-10-29T15:00:00.000Z'),
  recorded: new Date('2026-11-02T08:30:00.000Z'),
  tested: new Date('2026-11-02T14:00:00.000Z'),
  generated: new Date('2026-11-03T09:00:00.000Z'),
  signed: new Date('2026-11-04T11:00:00.000Z'),
  reviewed: new Date('2026-11-05T16:00:00.000Z'),
  built: new Date('2026-11-06T10:00:00.000Z'),
  approved: new Date('2026-11-06T12:00:00.000Z'),
  retired: new Date('2026-11-07T09:00:00.000Z'),
  spoiled: new Date('2026-11-07T10:30:00.000Z'),
}
const day = (date: string): Date => new Date(`${date}T00:00:00.000Z`)

export interface TechfilesSeed {
  readonly documentIds: { readonly docIt1: string; readonly docDe1: string; readonly docIt2: string; readonly infoIt1: string; readonly infoEn1: string }
  readonly batchIds: { readonly legacy: string; readonly made: string; readonly shipped: string; readonly shippedDe: string }
  readonly technicalFileIds: { readonly archived: string; readonly open: string; readonly complete: string }
  readonly itemIds: { readonly description: string; readonly missing: string; readonly notApplicable: string }
  readonly assessmentIds: { readonly signed: string; readonly draft: string; readonly completeSigned: string }
  readonly riskRowIds: { readonly draftRow: string; readonly signedRow: string }
  readonly testIds: { readonly due: string; readonly passed: string; readonly failed: string; readonly other: string }
  readonly packIds: { readonly building: string; readonly built: string; readonly failed: string; readonly shipment: string }
  readonly templateIds: { readonly glove: string; readonly care: string; readonly jacket: string }
  readonly artworkIds: { readonly retired: string; readonly approved: string; readonly draft: string }
  readonly spoilIds: { readonly spoiled: string; readonly returned: string }
  readonly printId: string
  /** Made-up people: the translation's checker and the artwork's author (neither the seed's actor). */
  readonly checkerId: string
  readonly designerId: string
}

export async function seed(context: SeedContext): Promise<TechfilesSeed> {
  const { db, namespace } = context
  const shipping = await seedShipping(context)
  const rules = await seedComplianceRules(context)
  // The file store account the made-up PDFs name.
  await seedFiles(context)
  const quality = shipping.quality
  const production = quality.production
  const id = (key: string): string => seedUuid(namespace, key)
  const firstId = (key: string): string => `00000000${id(key).slice(8)}`
  const lastId = (key: string): string => `ffffffff${id(key).slice(8)}`
  const sha = (key: string): string => createHash('sha256').update(`seed techfiles ${key} (${namespace})`).digest('hex')
  const tenantId = id('tenant')
  const actorId = id('actor')
  const companyA = id('company:A')
  const siteA = id('site:A1')
  const brandId = id('party:P1')
  const checkerId = id('techfiles:user:checker')
  const designerId = id('techfiles:user:designer')
  /** The product seed's SEED-JKT-01, certified by seed/compliance.ts's SEED-CERT-0001. */
  const jkt01 = id('product:style:JKT-01')
  const jkt01CertificateId = id('compliance:certificate:JKT-01')
  const stamp = (at: Date, by: string = actorId) => ({ createdAt: at, updatedAt: at, createdById: by })
  const maker = { makerPartyId: brandId, makerName: 'Seed Customer One S.r.l.', makerAddress: 'Via Esempio 10, 00000 Seedville (MI), Italy' }
  const keptFrom = (at: Date): Date => day(`${at.getUTCFullYear() + 10}-${String(at.getUTCMonth() + 1).padStart(2, '0')}-${String(at.getUTCDate()).padStart(2, '0')}`)

  const result: TechfilesSeed = {
    documentIds: {
      docIt1: lastId('techfiles:document:JKT-03:DOC:it:1'),
      docDe1: lastId('techfiles:document:JKT-03:DOC:de:1'),
      docIt2: lastId('techfiles:document:JKT-03:DOC:it:1:generated'),
      infoIt1: lastId('techfiles:document:JKT-03:INFO:it:1'),
      infoEn1: lastId('techfiles:document:JKT-03:INFO:en:1'),
    },
    batchIds: {
      legacy: firstId('techfiles:batch:LEGACY-01'),
      made: id('techfiles:batch:BT-0003'),
      shipped: id('techfiles:batch:BT-0003:SH-0002'),
      shippedDe: id('techfiles:batch:BT-0003:SH-0002:de'),
    },
    technicalFileIds: { archived: firstId('techfiles:file:JKT-01'), open: id('techfiles:file:JKT-02'), complete: id('techfiles:file:JKT-03') },
    itemIds: { description: firstId('techfiles:item:JKT-02:A'), missing: id('techfiles:item:JKT-02:J'), notApplicable: id('techfiles:item:JKT-02:L') },
    assessmentIds: { signed: id('techfiles:risk:JKT-02:1'), draft: firstId('techfiles:risk:JKT-02:2'), completeSigned: id('techfiles:risk:JKT-03:1') },
    riskRowIds: { draftRow: firstId('techfiles:risk-row:JKT-02:2:1'), signedRow: id('techfiles:risk-row:JKT-02:1:1') },
    testIds: { due: firstId('techfiles:test:JKT-02:seam'), passed: id('techfiles:test:WO-0001:pocket'), failed: id('techfiles:test:LEGACY-01:label'), other: id('techfiles:test:WO-0001:zip') },
    packIds: { building: firstId('techfiles:pack:1'), built: id('techfiles:pack:2'), failed: id('techfiles:pack:3'), shipment: id('techfiles:pack:SH-0002') },
    templateIds: { glove: lastId('techfiles:label:GLOVE-01:1'), care: lastId('techfiles:label:CARE-01:1'), jacket: production.labelTemplateId },
    artworkIds: { retired: id('techfiles:artwork:JKT-02:1'), approved: id('techfiles:artwork:JKT-02:2'), draft: firstId('techfiles:artwork:JKT-02:3') },
    spoilIds: { spoiled: firstId('techfiles:spoil:WO-0003:1'), returned: id('techfiles:spoil:WO-0003:2') },
    printId: firstId('quality:label-print:WO-0003:1'),
    checkerId,
    designerId,
  }
  const doc = result.documentIds
  const tf = result.technicalFileIds
  const pack = result.packIds

  /** A made-up PDF (or ZIP) of a record. */
  const fileRow = (fileId: string, recordType: string, recordId: string, originalName: string, key: string, at: Date, contentType = 'application/pdf') => ({
    id: fileId,
    companyId: companyA,
    recordType,
    recordId,
    kind: 'DOCUMENT' as const,
    originalName,
    contentType,
    sizeBytes: 4096,
    sha256: sha(`file:${key}`),
    storeAccountId: id('files:account:r2'),
    storageKey: `t/${tenantId}/c/${companyA}/2026/${id(`techfiles:file:${key}:key`)}`,
    status: 'AVAILABLE' as const,
    availableAt: at,
    visibility: ['OFFICE' as const],
    ...stamp(at),
  })
  const fileIds = {
    typeTest: id('techfiles:stored:type-test'),
    labReport: id('techfiles:stored:lab-report'),
    packPdf: id('techfiles:stored:pack-2:pdf'),
    packZip: id('techfiles:stored:pack-2:zip'),
    shipmentPackPdf: id('techfiles:stored:pack-SH-0002:pdf'),
    shipmentCompliancePack: id('techfiles:stored:SH-0002:compliance-pack'),
    signedIt: id('techfiles:stored:doc-it-1'),
    signedDe: id('techfiles:stored:doc-de-1'),
    proof1: id('techfiles:stored:artwork:1'),
    proof2: id('techfiles:stored:artwork:2'),
    proof3: id('techfiles:stored:artwork:3'),
  }
  const source = (kind: string, recordType?: string, recordId?: string) => ({ kind, ...(recordType ? { recordType } : {}), ...(recordId ? { recordId } : {}) })

  await db.withScope({ audience: 'office', tenantId, actorId }, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.technicalFile.findUnique({ where: { id: tf.open }, select: { id: true } })) return

      // --- Files ------------------------------------------------------------------------------------------------------
      await tx.storedFile.createMany({
        data: [
          fileRow(fileIds.typeTest, 'TechnicalFile', tf.open, 'SEED type-examination test report.pdf', 'type-test', T.reviewed),
          fileRow(fileIds.labReport, 'ProductionControlTest', result.testIds.passed, 'SEED-LAB-2026-0101.pdf', 'lab-report', T.tested),
          fileRow(fileIds.packPdf, 'EvidencePack', pack.built, 'SEED-EP-0002.pdf', 'pack-2-pdf', T.built),
          fileRow(fileIds.packZip, 'EvidencePack', pack.built, 'SEED-EP-0002.zip', 'pack-2-zip', T.built, 'application/zip'),
          fileRow(fileIds.shipmentPackPdf, 'EvidencePack', pack.shipment, 'SEED-EP-0004.pdf', 'pack-sh-pdf', T.built),
          fileRow(fileIds.shipmentCompliancePack, 'Shipment', shipping.draftShipmentId, 'SEED-SH-0002 compliance pack.pdf', 'sh-compliance-pack', T.built),
          // The signed PDFs of the live route (W1's upload: a file of the document, kind DOCUMENT, a confirmed PDF).
          fileRow(fileIds.signedIt, 'ComplianceDocument', doc.docIt1, 'SEED-DOC-0301 signed.pdf', 'doc-it-1', T.issued),
          fileRow(fileIds.signedDe, 'ComplianceDocument', doc.docDe1, 'SEED-DOC-0301-DE signed.pdf', 'doc-de-1', T.checked),
          fileRow(fileIds.proof1, 'LabelTemplate', production.labelTemplateId, 'SEED-LBL-JKT-02 proof 1.pdf', 'proof-1', T.generated),
          fileRow(fileIds.proof2, 'LabelTemplate', production.labelTemplateId, 'SEED-LBL-JKT-02 proof 2.pdf', 'proof-2', T.signed),
          fileRow(fileIds.proof3, 'LabelTemplate', production.labelTemplateId, 'SEED-LBL-JKT-02 proof 3.pdf', 'proof-3', T.retired),
        ],
        skipDuplicates: true,
      })

      // --- Declarations and user information --------------------------------------------------------------------------
      const docBase = { styleId: quality.serialStyleId, kind: ComplianceDocumentKind.DECLARATION_OF_CONFORMITY, certificateId: quality.certificateId, ...maker }
      const standards = ['EN 17092-1:2020', 'EN 17092-3:2020', 'EN 1621-1:2012']
      const signed = { signedByName: 'Seed Signatory', signedByFunction: 'Legal representative (made up)', signedPlace: 'Seedville', signedOn: day('2026-10-28') }
      const points = [
        { point: '1', text: 'Giacca moto in pelle SEED-JKT-03, numeri di serie SEED-SN-…', source: source('STYLE', 'Style', quality.serialStyleId) },
        { point: '2', text: 'Seed Customer One S.r.l., Via Esempio 10, 00000 Seedville (MI), Italia', source: source('OPERATOR', 'Party', brandId) },
        { point: '3', text: 'La presente dichiarazione è rilasciata sotto la responsabilità esclusiva del fabbricante.', source: source('PHRASE') },
        { point: '4', text: 'Giacca SEED-JKT-03, taglie 50-54', source: source('STYLE_REVISION', 'StyleRevision', quality.serialRevisionId) },
        { point: '5', text: 'Regolamento (UE) 2016/425', source: source('REGISTER', 'RegulationOrStandard', rules.regulationIds.ppe) },
        { point: '6', text: 'EN 17092-1:2020, EN 17092-3:2020, EN 1621-1:2012', source: source('REGISTER', 'RegulationOrStandard', rules.regulationIds.en17092_3) },
        { point: '7', text: 'Organismo notificato 0000 (seed), certificato SEED-CERT-0003', source: source('CERTIFICATE', 'Certificate', quality.certificateId) },
        { point: '9', text: 'Firmato a nome e per conto di: Seed Signatory, legale rappresentante', source: source('TYPED') },
      ]
      const sections = {
        sections: [
          { key: 'maker', text: 'Seed Customer One S.r.l., Via Esempio 10, 00000 Seedville (MI), Italia', source: source('OPERATOR', 'Party', brandId) },
          { key: 'use', text: 'Giacca protettiva per motociclisti, classe AA (EN 17092-3).', source: source('STYLE', 'Style', quality.serialStyleId) },
          { key: 'storage', text: 'Conservare in luogo asciutto, lontano dalla luce del sole.', source: source('PHRASE') },
          { key: 'protectors', text: 'Protezioni di spalla e gomito estraibili: rimetterle prima dell\'uso.', source: source('TYPED') },
        ],
        protectorPositions: [{ zone: 'shoulder', standard: 'EN 1621-1:2012', level: '2' }, { zone: 'elbow', standard: 'EN 1621-1:2012', level: '2' }],
        spareProtectors: [{ name: 'Seed shoulder protector L2', standard: 'EN 1621-1:2012', level: '2' }],
      }
      const documents: (Prisma.ComplianceDocumentCreateManyInput & { id: string })[] = [
        { id: doc.docIt1, ...docBase, language: 'it', revision: 1, number: 'SEED-DOC-0301', status: ComplianceDocumentStatus.ISSUED, productIdentification: 'Giacca moto in pelle SEED-JKT-03, taglie 50-54', standards, ...signed, issuedAt: T.issued, marketCode: 'IT', ...stamp(T.issued) },
        {
          id: doc.docIt2,
          ...docBase,
          language: 'it',
          revision: 1,
          origin: ComplianceDocumentOrigin.GENERATED,
          productIdentification: 'Giacca moto in pelle SEED-JKT-03, taglie 50-54',
          standards,
          content: { points },
          ...stamp(T.generated),
        },
        {
          id: doc.infoIt1,
          ...docBase,
          kind: ComplianceDocumentKind.USER_INFORMATION,
          language: 'it',
          revision: 1,
          origin: ComplianceDocumentOrigin.GENERATED,
          sections,
          ...stamp(T.generated),
        },
      ]
      await tx.complianceDocument.createMany({ data: documents })
      await tx.complianceDocument.createMany({
        data: [
          {
            id: doc.docDe1,
            ...docBase,
            language: 'de',
            revision: 1,
            number: 'SEED-DOC-0301-DE',
            status: ComplianceDocumentStatus.ISSUED,
            productIdentification: 'Motorrad-Lederjacke SEED-JKT-03, Größen 50-54',
            standards,
            ...signed,
            issuedAt: T.checked,
            translationOfId: doc.docIt1,
            translationStatus: ComplianceTranslationStatus.CHECKED,
            translationCheckedAt: T.checked,
            translationCheckedById: checkerId,
            marketCode: 'DE',
            ...stamp(T.issued),
          },
          {
            id: doc.infoEn1,
            ...docBase,
            kind: ComplianceDocumentKind.USER_INFORMATION,
            language: 'en',
            revision: 1,
            origin: ComplianceDocumentOrigin.GENERATED,
            sections: { ...sections, sections: sections.sections.map((part) => ({ ...part, text: `[en, in translation] ${part.text}` })) },
            translationOfId: doc.infoIt1,
            translationStatus: ComplianceTranslationStatus.IN_TRANSLATION,
            ...stamp(T.generated),
          },
        ],
      })

      // --- Which revision went with which batch -----------------------------------------------------------------------
      const batch = result.batchIds
      const recordedFor = (at: Date) => ({ createdAt: at, createdById: actorId, retainUntil: keptFrom(at) })
      await tx.complianceDocumentBatch.createMany({
        data: [
          { id: batch.legacy, companyId: companyA, styleId: quality.serialStyleId, documentId: doc.docIt1, batchNumber: 'SEED-BT-LEGACY-01', note: 'Seed: a batch made before Nexus.', ...recordedFor(T.recorded) },
          { id: batch.made, companyId: companyA, styleId: quality.serialStyleId, documentId: doc.docIt1, siteId: siteA, workOrderId: quality.serialWorkOrderId, batchNumber: 'SEED-BT-0003', ...recordedFor(T.recorded) },
          { id: batch.shipped, companyId: companyA, styleId: quality.serialStyleId, documentId: doc.docIt1, siteId: siteA, workOrderId: quality.serialWorkOrderId, batchNumber: 'SEED-BT-0003', shipmentId: shipping.draftShipmentId, ...recordedFor(T.recorded) },
          { id: batch.shippedDe, companyId: companyA, styleId: quality.serialStyleId, documentId: doc.docDe1, siteId: siteA, workOrderId: quality.serialWorkOrderId, batchNumber: 'SEED-BT-0003', shipmentId: shipping.draftShipmentId, ...recordedFor(T.recorded) },
        ],
      })

      // --- Technical files ----------------------------------------------------------------------------------------------
      await tx.technicalFile.createMany({
        data: [
          {
            id: tf.archived,
            companyId: companyA,
            number: 'SEED-TF-0001',
            styleId: jkt01,
            certificateId: jkt01CertificateId,
            status: TechnicalFileStatus.ARCHIVED,
            archivedAt: T.legacy,
            archivedById: actorId,
            archiveReason: 'Seed: the first edition left the market; a new file follows with the next certificate.',
            retainUntil: keptFrom(T.legacy),
            ...stamp(T.legacy),
          },
          { id: tf.open, companyId: companyA, number: 'SEED-TF-0002', styleId: production.styleId, certificateId: quality.certificateId, keeperId: actorId, ...stamp(T.recorded) },
          { id: tf.complete, companyId: companyA, number: 'SEED-TF-0003', styleId: quality.serialStyleId, certificateId: quality.certificateId, keeperId: actorId, ...stamp(T.recorded) },
        ],
      })

      // --- Risk assessments (each written as a DRAFT, then signed) ------------------------------------------------------
      const a = result.assessmentIds
      await tx.productRiskAssessment.createMany({
        data: [
          { id: a.signed, technicalFileId: tf.open, revision: 1, classReasoning: 'Seed: class AA, touring use (EN 17092-3).', ...stamp(T.recorded) },
          { id: a.completeSigned, technicalFileId: tf.complete, revision: 1, classReasoning: 'Seed: class AA, serial garments.', ...stamp(T.recorded) },
        ],
      })
      const risk = (hazard: ProductHazard, zone: string | null, control: string) => ({
        hazard,
        garmentZone: zone,
        intendedUse: 'Seed: riding a motorcycle on the road.',
        foreseeableMisuse: 'Seed: worn without the protectors in place.',
        control,
        standardClause: 'EN 17092-3:2020 6',
        standardId: rules.regulationIds.en17092_3,
        residualRisk: ResidualRisk.LOW,
      })
      await tx.productRiskRow.createMany({
        data: [
          { id: result.riskRowIds.signedRow, assessmentId: a.signed, seq: 1, ...risk(ProductHazard.ABRASION, 'back-upper', 'Seed: 1.2 mm cowhide in the impact zones.'), ...stamp(T.recorded) },
          { id: id('techfiles:risk-row:JKT-02:1:2'), assessmentId: a.signed, seq: 2, ...risk(ProductHazard.IMPACT, 'shoulder', 'Seed: EN 1621-1 level 2 protectors.'), ...stamp(T.recorded) },
          { id: id('techfiles:risk-row:JKT-03:1:1'), assessmentId: a.completeSigned, seq: 1, ...risk(ProductHazard.SEAM_BURST, null, 'Seed: triple stitched main seams.'), ...stamp(T.recorded) },
        ],
      })
      const signedBy = { status: ProductRiskAssessmentStatus.SIGNED, signedAt: T.signed, signedById: actorId, signedByName: 'Seed Quality Manager', signedByFunction: 'Quality manager (made up)', updatedAt: T.signed }
      await tx.productRiskAssessment.update({ where: { id: a.signed }, data: signedBy, select: { id: true } })
      await tx.productRiskAssessment.update({ where: { id: a.completeSigned }, data: signedBy, select: { id: true } })
      await tx.productRiskAssessment.create({ data: { id: a.draft, technicalFileId: tf.open, revision: 2, note: 'Seed: the next revision, adding the visibility hazard.', ...stamp(T.reviewed) }, select: { id: true } })
      await tx.productRiskRow.create({
        data: { id: result.riskRowIds.draftRow, assessmentId: a.draft, seq: 1, ...risk(ProductHazard.VISIBILITY, 'back-upper', 'Seed: a reflective panel on the back.'), ...stamp(T.reviewed) },
        select: { id: true },
      })

      // --- Annex III items --------------------------------------------------------------------------------------------
      const review = { reviewedAt: T.reviewed, reviewedById: actorId }
      const items: Prisma.TechnicalFileItemCreateManyInput[] = [
        { id: result.itemIds.description, technicalFileId: tf.open, point: AnnexIIIPoint.A_DESCRIPTION, seq: 1, state: TechnicalFileItemState.REVIEWED, recordType: 'Style', recordId: production.styleId, ...review, ...stamp(T.reviewed) },
        { id: id('techfiles:item:JKT-02:B'), technicalFileId: tf.open, point: AnnexIIIPoint.B_RISK_ASSESSMENT, seq: 1, state: TechnicalFileItemState.LINKED, recordType: 'ProductRiskAssessment', recordId: a.signed, ...stamp(T.reviewed) },
        { id: id('techfiles:item:JKT-02:D'), technicalFileId: tf.open, point: AnnexIIIPoint.D_DRAWINGS, seq: 1, state: TechnicalFileItemState.LINKED, recordType: 'StyleRevision', recordId: production.revisionId, ...stamp(T.reviewed) },
        { id: id('techfiles:item:JKT-02:F'), technicalFileId: tf.open, point: AnnexIIIPoint.F_STANDARDS, seq: 1, state: TechnicalFileItemState.REVIEWED, recordType: 'RegulationOrStandard', recordId: rules.regulationIds.en17092_3, ...review, ...stamp(T.reviewed) },
        { id: id('techfiles:item:JKT-02:I'), technicalFileId: tf.open, point: AnnexIIIPoint.I_TEST_REPORTS, seq: 1, state: TechnicalFileItemState.LINKED, fileId: fileIds.typeTest, note: 'Seed: the notified body\'s type test report.', ...stamp(T.reviewed) },
        { id: result.itemIds.missing, technicalFileId: tf.open, point: AnnexIIIPoint.J_PRODUCTION_CONTROL, seq: 1, ...stamp(T.reviewed) },
        { id: id('techfiles:item:JKT-02:K'), technicalFileId: tf.open, point: AnnexIIIPoint.K_USER_INFORMATION, seq: 1, note: 'Seed: the leaflet is being written.', ...stamp(T.reviewed) },
        { id: result.itemIds.notApplicable, technicalFileId: tf.open, point: AnnexIIIPoint.L_SINGLE_UNIT, seq: 1, state: TechnicalFileItemState.NOT_APPLICABLE, note: 'Seed: made in series, never to one rider\'s measures.', ...review, ...stamp(T.reviewed) },
        { id: id('techfiles:item:JKT-02:M'), technicalFileId: tf.open, point: AnnexIIIPoint.M_SERIES_FITTED, seq: 1, state: TechnicalFileItemState.NOT_APPLICABLE, note: 'Seed: no item is fitted to its rider.', ...review, ...stamp(T.reviewed) },
        // SEED-JKT-03: every point reviewed or not applicable.
        ...Object.values(AnnexIIIPoint).map((point): Prisma.TechnicalFileItemCreateManyInput => {
          const base = { id: id(`techfiles:item:JKT-03:${point}`), technicalFileId: tf.complete, point, seq: 1, ...review, ...stamp(T.reviewed) }
          if (point === AnnexIIIPoint.L_SINGLE_UNIT || point === AnnexIIIPoint.M_SERIES_FITTED) {
            return { ...base, state: TechnicalFileItemState.NOT_APPLICABLE, note: 'Seed: not made to measure.' }
          }
          if (point === AnnexIIIPoint.B_RISK_ASSESSMENT) return { ...base, state: TechnicalFileItemState.REVIEWED, recordType: 'ProductRiskAssessment', recordId: a.completeSigned }
          if (point === AnnexIIIPoint.I_TEST_REPORTS) return { ...base, state: TechnicalFileItemState.REVIEWED, recordType: 'Certificate', recordId: quality.certificateId }
          return { ...base, state: TechnicalFileItemState.REVIEWED, recordType: 'Style', recordId: quality.serialStyleId }
        }),
      ]
      await tx.technicalFileItem.createMany({ data: items })
      await tx.technicalFile.update({
        where: { id: tf.complete },
        data: { status: TechnicalFileStatus.COMPLETE, completedAt: T.reviewed, completedById: actorId, updatedAt: T.reviewed },
        select: { id: true },
      })

      // --- Production-control tests -----------------------------------------------------------------------------------
      const t = result.testIds
      await tx.productionControlTest.createMany({
        data: [
          { id: t.due, companyId: companyA, styleId: production.styleId, test: ProductionControlTestKind.SEAM_STRENGTH, testName: 'Main back seam', frequency: ProductionControlFrequency.YEARLY, dueOn: day('2027-01-15'), ...stamp(T.recorded) },
          {
            id: t.passed,
            companyId: companyA,
            styleId: production.styleId,
            siteId: siteA,
            workOrderId: production.workOrderId,
            test: ProductionControlTestKind.POCKET_RETENTION,
            standardClause: 'EN 17092-1:2020 5.4',
            frequency: ProductionControlFrequency.EVERY_BATCH,
            dueOn: day('2026-11-02'),
            sample: 'Seed: size 52, one jacket from the end of the batch.',
            result: ControlTestResult.PASS,
            testedOn: day('2026-11-02'),
            testedBy: 'Seed Test Lab S.r.l. (made up)',
            labReportFileId: fileIds.labReport,
            reportNumber: 'SEED-LAB-2026-0101',
            resultNote: 'Seed: the shoulder protector stayed in place.',
            retainUntil: day('2036-11-02'),
            ...stamp(T.tested),
          },
          {
            id: t.failed,
            companyId: companyA,
            styleId: production.styleId,
            batchNumber: 'SEED-BT-LEGACY-01',
            test: ProductionControlTestKind.LABEL_DURABILITY,
            frequency: ProductionControlFrequency.EVERY_BATCH,
            dueOn: day('2026-10-20'),
            result: ControlTestResult.FAIL,
            testedOn: day('2026-10-20'),
            testedBy: 'Seed quality office',
            resultNote: 'Seed: the care label faded after five washes (ten required).',
            retainUntil: day('2036-10-20'),
            ...stamp(T.legacy),
          },
          { id: t.other, companyId: companyA, styleId: production.styleId, siteId: siteA, workOrderId: production.workOrderId, test: ProductionControlTestKind.OTHER, testName: 'Zip pull strength', frequency: ProductionControlFrequency.EVERY_BATCH, dueOn: day('2026-11-30'), ...stamp(T.recorded) },
        ],
      })

      // --- Evidence packs (each started BUILDING, then built or failed) ----------------------------------------------
      const include = { include: ['DOC', 'CERTIFICATES', 'TEST_REPORTS', 'TECHNICAL_FILE_INDEX', 'USER_INFORMATION'] }
      await tx.evidencePack.createMany({
        data: [
          { id: pack.building, companyId: companyA, number: 'SEED-EP-0001', purpose: EvidencePackPurpose.AUTHORITY, technicalFileId: tf.open, scope: { ...include, batchNumbers: ['SEED-BT-0001'] }, language: 'de', recipient: 'Seed market surveillance authority (made up)', ...stamp(T.built) },
          { id: pack.built, companyId: companyA, number: 'SEED-EP-0002', purpose: EvidencePackPurpose.AUTHORITY, technicalFileId: tf.open, scope: include, language: 'it', recipient: 'Seed Italian authority (made up)', ...stamp(T.built) },
          { id: pack.failed, companyId: companyA, number: 'SEED-EP-0003', purpose: EvidencePackPurpose.CUSTOMER, technicalFileId: tf.open, scope: include, language: 'it', recipient: 'Seed Customer One S.r.l.', recipientPartyId: brandId, ...stamp(T.built) },
          { id: pack.shipment, companyId: companyA, number: 'SEED-EP-0004', purpose: EvidencePackPurpose.SHIPMENT, shipmentId: shipping.draftShipmentId, scope: { include: ['DOC', 'USER_INFORMATION', 'CERTIFICATES'] }, language: 'it', recipient: 'Seed Customer One S.r.l.', recipientPartyId: brandId, ...stamp(T.built) },
        ],
      })
      const certificateEntry = { title: 'Certificato SEED-CERT-0003', sha256: sha('contents:certificate'), recordType: 'Certificate', recordId: quality.certificateId }
      const contents = [
        certificateEntry,
        { title: 'Rapporto di prova di tipo', sha256: sha('contents:type-test'), fileId: fileIds.typeTest },
        { title: 'Valutazione dei rischi, revisione 1', sha256: sha('contents:risk-1'), recordType: 'ProductRiskAssessment', recordId: a.signed },
      ]
      const shipmentContents = [
        { title: 'Dichiarazione di conformità SEED-DOC-0301 (it, revisione 1)', sha256: sha('contents:doc-it-1'), recordType: 'ComplianceDocument', recordId: doc.docIt1, fileId: fileIds.signedIt },
        certificateEntry,
      ]
      await tx.evidencePack.update({
        where: { id: pack.built },
        data: { status: EvidencePackStatus.BUILT, contents, fingerprint: sha('pack-2'), fileId: fileIds.packPdf, zipFileId: fileIds.packZip, builtAt: T.built, retainUntil: keptFrom(T.built), updatedAt: T.built },
        select: { id: true },
      })
      await tx.evidencePack.update({
        where: { id: pack.failed },
        data: { status: EvidencePackStatus.FAILED, failureReason: 'Seed: a file of the pack could not be read; build it again.', builtAt: T.built, updatedAt: T.built },
        select: { id: true },
      })
      await tx.evidencePack.update({
        where: { id: pack.shipment },
        data: { status: EvidencePackStatus.BUILT, contents: shipmentContents, fingerprint: sha('pack-SH-0002'), fileId: fileIds.shipmentPackPdf, builtAt: T.built, retainUntil: keptFrom(T.built), updatedAt: T.built },
        select: { id: true },
      })
      await tx.generatedDocument.createMany({
        data: [
          { id: lastId('techfiles:gendoc:pack-2'), companyId: companyA, siteId: null, recordType: 'EvidencePack', recordId: pack.built, kind: GeneratedDocumentKind.EVIDENCE_PACK, version: 1, fingerprint: sha('pack-2'), language: 'it', number: 'SEED-EP-0002', fileId: fileIds.packPdf, createdAt: T.built, createdById: actorId },
          { id: lastId('techfiles:gendoc:SH-0002'), companyId: companyA, siteId: siteA, recordType: 'Shipment', recordId: shipping.draftShipmentId, kind: GeneratedDocumentKind.COMPLIANCE_PACK, version: 1, fingerprint: sha('sh-compliance-pack'), language: 'it', number: 'SEED-SH-0002', fileId: fileIds.shipmentCompliancePack, createdAt: T.built, createdById: actorId },
        ],
      })

      // --- Label kinds and artwork ------------------------------------------------------------------------------------
      const labelBase = {
        status: LabelTemplateStatus.DRAFT,
        languages: ['it', 'en'],
        makerName: 'Seed Factory S.p.A. (made up)',
        makerAddress: 'Via Esempio 1, 00000 Seedtown, Italy',
        widthMm: '40.00',
        heightMm: '60.00',
        ...stamp(T.generated),
      }
      await tx.labelTemplate.createMany({
        data: [
          { id: result.templateIds.glove, code: 'SEED-LBL-GLOVE-01', revision: 1, name: 'Seed glove marking', kind: LabelTemplateKind.GLOVE_MARKING, qrTarget: LabelQrTarget.STYLE_DOC, layout: { fields: ['ceMark', 'maker', 'model', 'size', 'pictogram', 'level', 'standard'] }, ...labelBase },
          {
            id: result.templateIds.care,
            code: 'SEED-LBL-CARE-01',
            revision: 1,
            name: 'Seed fibre and care label',
            kind: LabelTemplateKind.FIBRE_CARE,
            gpsrContact: 'Seed Factory S.p.A. (made up)\nVia Esempio 1, 00000 Seedtown, Italy\ninfo@example.com',
            qrTarget: LabelQrTarget.BATCH_DOC,
            originClaimKey: 'claim.made-in-italy',
            composition: [{ part: 'shell', fibres: [{ fibre: 'polyamide', percent: '100' }] }],
            care: [{ symbol: 'wash-30' }],
            layout: { fields: ['composition', 'care', 'origin', 'gpsrContact', 'qr'] },
            ...labelBase,
          },
        ],
      })
      const w = result.artworkIds
      const jacketLabel = production.labelTemplateId
      await tx.labelArtworkVersion.create({ data: { id: w.retired, templateId: jacketLabel, versionNo: 1, fileId: fileIds.proof1, authorId: designerId, ...stamp(T.generated) }, select: { id: true } })
      await tx.labelArtworkVersion.update({ where: { id: w.retired }, data: { status: LabelArtworkStatus.APPROVED, approvedAt: T.generated, approvedById: actorId, updatedAt: T.generated }, select: { id: true } })
      await tx.labelArtworkVersion.update({ where: { id: w.retired }, data: { status: LabelArtworkStatus.RETIRED, retiredAt: T.approved, updatedAt: T.approved }, select: { id: true } })
      await tx.labelArtworkVersion.create({ data: { id: w.approved, templateId: jacketLabel, versionNo: 2, fileId: fileIds.proof2, authorId: designerId, note: 'Seed: the class pictogram moved up.', ...stamp(T.signed) }, select: { id: true } })
      await tx.labelArtworkVersion.update({ where: { id: w.approved }, data: { status: LabelArtworkStatus.APPROVED, approvedAt: T.approved, approvedById: actorId, updatedAt: T.approved }, select: { id: true } })
      await tx.labelArtworkVersion.create({ data: { id: w.draft, templateId: jacketLabel, versionNo: 3, fileId: fileIds.proof3, authorId: designerId, ...stamp(T.retired) }, select: { id: true } })
    }),
  )

  // --- Spoiled and returned labels, on plant A1's floor (WO-0003's print of three serial labels) ------------------------
  await db.withScope({ audience: 'floor', tenantId, actorId: production.operatorId, siteId: siteA }, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.garmentLabelSpoil.findUnique({ where: { id: result.spoilIds.spoiled }, select: { id: true } })) return
      const base = { companyId: companyA, siteId: siteA, workOrderId: quality.serialWorkOrderId, printId: result.printId, quantity: 1, createdById: production.operatorId }
      await tx.garmentLabelSpoil.create({ data: { id: result.spoilIds.spoiled, kind: GarmentLabelSpoilKind.SPOILED, reason: 'Seed: torn while sewing it into the collar.', createdAt: T.spoiled, ...base }, select: { id: true } })
      await tx.garmentLabelSpoil.create({ data: { id: result.spoilIds.returned, kind: GarmentLabelSpoilKind.RETURNED, createdAt: T.spoiled, ...base }, select: { id: true } })
    }),
  )
  return result
}
