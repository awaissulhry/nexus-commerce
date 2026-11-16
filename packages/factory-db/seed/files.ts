import type { Prisma } from '../src/generated/prisma/client'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seedFile } from '../src/seed-files' // B-W2b-F59: seeded files with their bytes

/**
 * The files module's synthetic seed, per tenant of seed/_core.ts: the tenant's file store (an R2 account in FAKE mode,
 * the local folder: no network) and one file row of each kind of sharing — office only, the floor of each plant, the
 * portal of party P1 (the audit seed's party), a link of party P2, a fiscal archive file and an upload still pending.
 * Written in the tenant's office scope. Rows only: the objects are put in a seeded stack's store afterwards (B-W2b-F59,
 * seed-files.ts: `npm run seed:files -w @nexus/factory-api`). Made up and harmless; a second run adds nothing (INSERT …
 * ON CONFLICT DO NOTHING).
 */

/** Fixed instants, so the seed never depends on the clock. */
const AT = new Date('2026-10-28T08:00:00.000Z')
const TEN_YEARS_LATER = new Date('2036-10-28T08:00:00.000Z')

export async function seed({ db, namespace }: SeedContext): Promise<void> {
  const id = (key: string): string => seedUuid(namespace, key)
  const tenantId = id('tenant')
  const actorId = id('actor')
  const companyA = id('company:A')
  const companyB = id('company:B')
  const store = id('files:account:r2')
  const key = (companyId: string | null, name: string, legal = false): string =>
    `${legal ? 'legal/' : ''}t/${tenantId}/${companyId ? `c/${companyId}` : 'tenant'}/2026/${id(`files:key:${name}`)}`
  const available = { status: 'AVAILABLE', availableAt: AT, storeAccountId: store, createdAt: AT, updatedAt: AT, createdById: actorId } as const

  // B-W2b-F59: every row with the SHA-256 of its seeded bytes (seed-files.ts), its key checked against the files platform's rule.
  const rows: Omit<Prisma.StoredFileCreateManyInput, 'sha256'>[] = [
    {
      id: id('files:office'),
      companyId: companyA,
      recordType: 'Company',
      recordId: companyA,
      kind: 'DOCUMENT',
      originalName: 'Seed cost sheet.pdf',
      contentType: 'application/pdf',
      sizeBytes: 2048,
      storageKey: key(companyA, 'office'),
      visibility: ['OFFICE'],
      ...available,
    },
    ...(
      [
        ['A1', companyA],
        ['B1', companyB],
      ] as const
    ).map(
      ([site, companyId]): Omit<Prisma.StoredFileCreateManyInput, 'sha256'> => ({
        id: id(`files:floor:${site}`),
        companyId,
        recordType: 'Site',
        recordId: id(`site:${site}`),
        kind: 'PHOTO',
        originalName: `Seed bench photo ${site}.jpg`,
        contentType: 'image/jpeg',
        sizeBytes: 4096,
        storageKey: key(companyId, `floor:${site}`),
        visibility: ['OFFICE', 'FLOOR'],
        floorSiteId: id(`site:${site}`),
        ...available,
      }),
    ),
    {
      id: id('files:partner:P1'),
      companyId: companyA,
      recordType: 'Company',
      recordId: companyA,
      kind: 'CERTIFICATE',
      originalName: 'Seed test report.pdf',
      contentType: 'application/pdf',
      sizeBytes: 3072,
      storageKey: key(companyA, 'partner:P1'),
      visibility: ['OFFICE', 'PARTNER'],
      partyId: id('party:P1'),
      ...available,
    },
    {
      id: id('files:link:P2'),
      companyId: companyA,
      recordType: 'Company',
      recordId: companyA,
      kind: 'DOCUMENT',
      originalName: 'Seed packing list.pdf',
      contentType: 'application/pdf',
      sizeBytes: 1024,
      storageKey: key(companyA, 'link:P2'),
      visibility: ['OFFICE', 'LINK'],
      partyId: id('party:P2'),
      ...available,
    },
    {
      id: id('files:fiscal'),
      companyId: companyA,
      recordType: 'Company',
      recordId: companyA,
      kind: 'FISCAL_ARCHIVE',
      originalName: 'Seed invoice.xml',
      contentType: 'application/xml',
      sizeBytes: 5120,
      storageKey: key(companyA, 'fiscal', true),
      visibility: ['OFFICE'],
      retainUntil: TEN_YEARS_LATER,
      ...available,
    },
    {
      id: id('files:pending'),
      companyId: null,
      recordType: 'Tenant',
      recordId: tenantId,
      kind: 'ATTACHMENT',
      originalName: 'Seed import.csv',
      contentType: 'text/csv',
      sizeBytes: 512,
      storageKey: key(null, 'pending'),
      visibility: ['OFFICE'],
      status: 'PENDING_UPLOAD',
      storeAccountId: store,
      createdAt: AT,
      updatedAt: AT,
      createdById: actorId,
    },
  ]
  const files = rows.map((row) => seedFile(tenantId, row))

  await db.withScope({ audience: 'office', tenantId, actorId }, (client) =>
    client.$transaction(async (tx) => {
      await tx.integrationAccount.createMany({
        data: [{ id: store, companyId: null, provider: 'R2', code: 'files', label: 'Files (fake: the local folder)', mode: 'FAKE', createdById: actorId }],
        skipDuplicates: true,
      })
      await tx.storedFile.createMany({ data: files, skipDuplicates: true })
    }),
  )
}
