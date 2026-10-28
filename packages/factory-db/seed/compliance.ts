import type { Prisma } from '../src/generated/prisma/client'
import { CertificateStatus, ComplianceDocumentKind, ComplianceDocumentStatus, LabelTemplateStatus, StyleRevisionStatus } from '../src/generated/prisma/enums'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedProduct } from './product'

/**
 * The compliance seed, per tenant of seed/_core.ts: the PPE paperwork of the product seed's jacket, as with a brand
 * label (PLAN §2.8, the Q9 default): the brand P1 is the legal maker and the certificate holder.
 *
 *   certificates  an EN 17092-3 class AA certificate covering the jacket in every colourway and size, made-to-measure
 *                 units included (VALID); the shoulder protector's EN 1621-1 level 2 certificate, held by its supplier P2
 *                 (VALID)
 *   label         the jacket's garment label template, revision 1 (ACTIVE), which revision 1 of the style carries
 *   documents     the jacket's Declaration of Conformity in English, revision 1 (DRAFT: it is signed when the style is
 *                 released)
 *
 * The notified body, its number "0000" and every certificate number are invented. Written in the tenant's office
 * scope. Idempotent: rows are upserted with fixed values (an upsert of an unchanged registered row changes nothing, so
 * the triggers let it through); the style revision gets its label only while it is a draft.
 */

/** Fixed instants, so the seed never depends on the clock. */
const AT = new Date('2026-10-28T08:00:00.000Z')

export interface ComplianceSeed {
  readonly certificateId: string
  readonly labelTemplateId: string
}

export async function seed(context: SeedContext): Promise<ComplianceSeed> {
  const { db, namespace } = context
  // The CLI runs the seeds in name order, so this one runs before the product seed it documents: run that first.
  const product = await seedProduct(context)
  const id = (key: string): string => seedUuid(namespace, key)
  const tenantId = id('tenant')
  const actorId = id('actor')
  const brandId = id('party:P1')
  const supplierId = id('party:P2')
  const stamp = { createdAt: AT, updatedAt: AT, createdById: actorId }
  const maker = { makerPartyId: brandId, makerName: 'Seed Customer One S.r.l.', makerAddress: 'Via Esempio 10, 00000 Seedville (MI), Italy' }

  const certificate = { jacket: id('compliance:certificate:JKT-01'), protector: id('compliance:certificate:PRO-300') }
  const certificates: (Prisma.CertificateCreateManyInput & { id: string })[] = [
    {
      id: certificate.jacket,
      holderPartyId: brandId,
      standard: 'EN 17092-3:2020',
      ppeClass: 'AA',
      number: 'SEED-CERT-0001',
      notifiedBodyName: 'Seed Notified Body',
      notifiedBodyNumber: '0000',
      modelReference: 'SEED-JKT-01',
      validFrom: new Date('2026-01-15T00:00:00.000Z'),
      validTo: new Date('2031-01-14T00:00:00.000Z'),
      status: CertificateStatus.VALID,
      statusChangedAt: AT,
      ...stamp,
    },
    {
      id: certificate.protector,
      holderPartyId: supplierId,
      standard: 'EN 1621-1:2012',
      ppeClass: '2',
      number: 'SEED-CERT-0002',
      notifiedBodyName: 'Seed Notified Body',
      notifiedBodyNumber: '0000',
      modelReference: 'SEED-PRO-300',
      validFrom: new Date('2025-06-01T00:00:00.000Z'),
      validTo: new Date('2030-05-31T00:00:00.000Z'),
      status: CertificateStatus.VALID,
      statusChangedAt: AT,
      ...stamp,
    },
  ]
  const coverage: (Prisma.CertificateCoverageCreateManyInput & { id: string })[] = [
    { id: id('compliance:coverage:JKT-01'), certificateId: certificate.jacket, styleId: product.styleId, allowsMadeToMeasure: true, ...stamp },
    { id: id('compliance:coverage:PRO-300'), certificateId: certificate.protector, itemId: product.protectorId, ...stamp },
  ]

  const labelTemplateId = id('compliance:label:JKT-01:1')
  const label: Prisma.LabelTemplateCreateManyInput & { id: string } = {
    id: labelTemplateId,
    code: 'SEED-LBL-JKT-01',
    revision: 1,
    name: 'Seed jacket garment label',
    styleId: product.styleId,
    status: LabelTemplateStatus.ACTIVE,
    languages: ['it', 'en'],
    ...maker,
    composition: [{ part: 'lining', fibres: [{ fibre: 'polyester', percent: '100' }] }],
    animalOriginPhrase: true,
    care: [{ symbol: 'wash-not' }, { symbol: 'bleach-not' }, { symbol: 'iron-not' }, { symbol: 'dryclean-professional' }],
    layout: { fields: ['ceMark', 'maker', 'model', 'batchOrSerial', 'size', 'bodyMeasures', 'pictogram', 'class', 'standard', 'composition', 'care'] },
    widthMm: '50.00',
    heightMm: '80.00',
    ...stamp,
  }

  const doc: Prisma.ComplianceDocumentCreateManyInput & { id: string } = {
    id: id('compliance:document:JKT-01:DOC:en:1'),
    styleId: product.styleId,
    kind: ComplianceDocumentKind.DECLARATION_OF_CONFORMITY,
    language: 'en',
    revision: 1,
    number: 'SEED-DOC-0001',
    status: ComplianceDocumentStatus.DRAFT,
    certificateId: certificate.jacket,
    ...maker,
    productIdentification: 'Seed leather jacket SEED-JKT-01, sizes 50-54, every colourway',
    standards: ['EN 17092-1:2020', 'EN 17092-3:2020', 'EN 1621-1:2012'],
    ...stamp,
  }

  await db.withScope({ audience: 'office', tenantId, actorId }, (client) =>
    client.$transaction(async (tx) => {
      for (const { id: rowId, ...data } of certificates) await tx.certificate.upsert({ where: { id: rowId }, create: { id: rowId, ...data }, update: data })
      for (const { id: rowId, ...data } of coverage) await tx.certificateCoverage.upsert({ where: { id: rowId }, create: { id: rowId, ...data }, update: data })
      {
        const { id: rowId, ...data } = label
        await tx.labelTemplate.upsert({ where: { id: rowId }, create: { id: rowId, ...data }, update: data })
      }
      {
        const { id: rowId, ...data } = doc
        await tx.complianceDocument.upsert({ where: { id: rowId }, create: { id: rowId, ...data }, update: data })
      }
      // Revision 1 carries this label; a released revision is frozen (it already has its label).
      await tx.styleRevision.updateMany({ where: { id: product.revisionId, status: StyleRevisionStatus.DRAFT }, data: { labelTemplateId, updatedAt: AT } })
    }),
  )
  return { certificateId: certificate.jacket, labelTemplateId }
}
