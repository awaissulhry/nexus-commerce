import { createHash } from 'node:crypto'
import { CrViEvidence, CrViEvidenceRule, LabTest, LabVerdict, LotDocumentKind } from '../src/generated/prisma/enums'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedFiles } from './files'
import { seed as seedInventory } from './inventory'

/**
 * The lab step's seed (B-W1-34), per tenant of seed/_core.ts, written in the tenant's office scope as the app does:
 *
 *   rule      the tenant-wide Cr VI evidence rule (Q14 (a), the default): a QualitySettings row whose id is the tenant's.
 *   result    SEED-LOT-LEA-01's lab result (the inventory seed's lot and its Cr VI columns): 1.2 mg/kg against its
 *             3 mg/kg limit, PASS, by EN ISO 17075-1, a lab report on the lot, with its report file.
 *   document  the tannery's LWG certificate as a supplier document of that lot, valid to the end of 2027.
 *
 * The files are rows only, like the files seed's (no object in any store), CERTIFICATE files of the lot; their ids start
 * with eight f's so StoredFile's first row stays the files seed's (the generated isolation tests copy the first row).
 * A seed of its own, not the quality seed's: the shipping seed runs that one, and tests that run it bring their own file
 * store. Every name and number is invented. Idempotent: a second run adds nothing.
 */

const AT = new Date('2026-11-13T12:00:00.000Z')

export async function seed(context: SeedContext): Promise<void> {
  const { db, namespace } = context
  // The CLI runs the seeds in name order (files and inventory before this one); run them first anyway (idempotent).
  await seedFiles(context)
  await seedInventory(context)
  const id = (key: string): string => seedUuid(namespace, key)
  const lastId = (key: string): string => `ffffffff${id(key).slice(8)}`
  const tenantId = id('tenant')
  const actorId = id('actor')
  const companyA = id('company:A')
  const siteA = id('site:A1')
  const leather = id('product:item:leather')
  const lotId = id('inventory:lot:LEA-01')
  const reportFileId = lastId('quality:file:lab-report:LEA-01')
  const lwgFileId = lastId('quality:file:lwg:LEA-01')
  const stamp = { createdAt: AT, updatedAt: AT, createdById: actorId }
  const sha = (name: string): string => createHash('sha256').update(`seed lab file ${namespace} ${name}`).digest('hex')
  const file = (fileId: string, name: string, originalName: string) => ({
    id: fileId,
    companyId: companyA,
    recordType: 'Lot',
    recordId: lotId,
    kind: 'CERTIFICATE' as const,
    originalName,
    contentType: 'application/pdf',
    sizeBytes: 3072,
    sha256: sha(name),
    storeAccountId: id('files:account:r2'),
    storageKey: `t/${tenantId}/c/${companyA}/2026/${id(`quality:file-key:${name}`)}`,
    status: 'AVAILABLE' as const,
    visibility: ['OFFICE' as const],
    retainUntil: new Date('2036-11-13T00:00:00.000Z'),
    availableAt: AT,
    ...stamp,
  })

  await db.withScope({ audience: 'office', tenantId, actorId }, (client) =>
    client.$transaction(async (tx) => {
      await tx.qualitySettings.createMany({ data: [{ id: tenantId, companyId: null, crViEvidenceRule: CrViEvidenceRule.SUPPLIER_REPORT_ACCEPTED, ...stamp }], skipDuplicates: true })
      await tx.storedFile.createMany({ data: [file(reportFileId, 'lab-report', 'Seed lab report LEA-01.pdf'), file(lwgFileId, 'lwg', 'Seed LWG certificate.pdf')], skipDuplicates: true })
      await tx.labResult.createMany({
        data: [
          {
            id: id('quality:lab-result:LEA-01'),
            companyId: companyA,
            siteId: siteA,
            itemId: leather,
            lotId,
            test: LabTest.CR_VI,
            method: 'EN ISO 17075-1',
            valueMgKg: '1.200',
            unit: 'mg/kg',
            limitMgKg: '3.000',
            verdict: LabVerdict.PASS,
            lab: 'Seed Test Lab',
            reportNumber: 'SEED-LAB-0001',
            testedOn: new Date('2026-11-13T00:00:00.000Z'),
            evidence: CrViEvidence.LOT_REPORT,
            fileId: reportFileId,
            createdAt: AT,
            createdById: actorId,
          },
        ],
        skipDuplicates: true,
      })
      await tx.lotDocument.createMany({
        data: [{ id: id('quality:lot-document:LEA-01:LWG'), companyId: companyA, siteId: siteA, itemId: leather, lotId, kind: LotDocumentKind.LWG_CERTIFICATE, fileId: lwgFileId, validTo: new Date('2027-12-31T00:00:00.000Z'), ...stamp }],
        skipDuplicates: true,
      })
    }),
  )
}
