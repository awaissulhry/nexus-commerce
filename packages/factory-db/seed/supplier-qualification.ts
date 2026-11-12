import { createHash } from 'node:crypto'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedPortalFollowups } from './portal-followups'

/**
 * The supplier qualification seed (B-W2b-315; SCM-020, SCM-022), per tenant of seed/_core.ts: the tannery P2's chromium VI
 * test report in its document vault, so a purchase order of its leather passes the compliance gate on a PO at Send (a
 * TANNERY owes its leathers' chromium VI test report: REACH Annex XVII entry 47). A Party file of P2, tagged TEST_REPORT, in
 * force until the end of 2027, kept by the office (not shared with the supplier's portal). It runs the portal follow-ups
 * seed (the files store, party P2) first; the suppliers-depth seed makes P2 a TANNERY. Made up: a row only, no object in any
 * store. Idempotent: written once, skipped when it exists.
 */

const AT = new Date('2026-10-28T10:00:00.000Z')
const VALID_UNTIL = new Date('2027-12-31T00:00:00.000Z')

export interface SupplierQualificationSeed {
  readonly testReportFileId: string
}

export async function seed(context: SeedContext): Promise<SupplierQualificationSeed> {
  const { db, namespace } = context
  await seedPortalFollowups(context)
  const id = (key: string): string => seedUuid(namespace, key)
  const tenantId = id('tenant')
  const companyA = id('company:A')
  const partyP2 = id('party:P2')
  const actorId = id('actor')
  const fileId = id('supplier-qualification:file:P2:cr6')
  const office = { audience: 'office', tenantId, actorId } as const
  const exists = await db.withScope(office, (client) => client.storedFile.findUnique({ where: { id: fileId }, select: { id: true } }))
  if (!exists) {
    await db.withScope(office, (client) =>
      client.storedFile.create({
        data: {
          id: fileId,
          companyId: companyA,
          recordType: 'Party',
          recordId: partyP2,
          kind: 'CERTIFICATE',
          category: 'TEST_REPORT',
          expiresOn: VALID_UNTIL,
          visibility: ['OFFICE'],
          originalName: 'Seed tannery chromium VI test report 2026.pdf',
          contentType: 'application/pdf',
          sizeBytes: 4096,
          sha256: createHash('sha256').update(`seed file ${namespace} supplier-qualification ${fileId}`).digest('hex'),
          storageKey: `t/${tenantId}/c/${companyA}/2026/${id('supplier-qualification:key:P2:cr6')}`,
          status: 'AVAILABLE',
          availableAt: AT,
          storeAccountId: id('files:account:r2'),
          createdAt: AT,
          updatedAt: AT,
          createdById: actorId,
        },
        select: { id: true },
      }),
    )
  }
  return { testReportFileId: fileId }
}
