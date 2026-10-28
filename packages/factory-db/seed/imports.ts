import { createHash } from 'node:crypto'
import type { Prisma } from '../src/generated/prisma/client'
import { seedUuid, type SeedContext } from '../src/seeding'

/**
 * The imports module's synthetic seed, per tenant of seed/_core.ts: one import job of company A, already planned (a dry
 * run of a made-up "widgets" sheet: one row to create, one to update with a marked price, one unchanged, one with an
 * error), and its sheet as a stored file owned by the job (the files seed's FAKE store; the object itself is in no
 * store). Written in the tenant's office scope. Made up and harmless; a second run adds nothing (ON CONFLICT DO NOTHING).
 */

/** A fixed instant, so the seed never depends on the clock. */
const AT = new Date('2026-10-28T09:00:00.000Z')

export async function seed({ db, namespace }: SeedContext): Promise<void> {
  const id = (key: string): string => seedUuid(namespace, key)
  const tenantId = id('tenant')
  const actorId = id('actor')
  const companyA = id('company:A')
  const jobId = id('imports:job')
  const fileId = id('imports:file')

  const file: Prisma.StoredFileCreateManyInput = {
    id: fileId,
    companyId: companyA,
    recordType: 'ImportJob',
    recordId: jobId,
    kind: 'DOCUMENT',
    originalName: 'Seed widgets.csv',
    contentType: 'text/csv',
    sizeBytes: 256,
    sha256: createHash('sha256').update(`seed import ${namespace}`).digest('hex'),
    storeAccountId: id('files:account:r2'),
    storageKey: `t/${tenantId}/c/${companyA}/2026/${id('imports:key')}`,
    status: 'AVAILABLE',
    visibility: ['OFFICE'],
    availableAt: AT,
    createdAt: AT,
    updatedAt: AT,
    createdById: actorId,
  }
  const job: Prisma.ImportJobCreateManyInput = {
    id: jobId,
    companyId: companyA,
    importerKey: 'seed.widgets',
    fileId,
    layout: {
      format: 'csv',
      encoding: 'utf-8',
      delimiter: ';',
      headers: ['Codice', 'Descrizione', 'Prezzo'],
      columns: [
        { index: 0, header: 'Codice', column: 'code' },
        { index: 1, header: 'Descrizione', column: 'name' },
        { index: 2, header: 'Prezzo', column: 'unitPrice' },
      ],
      ignored: [],
    },
    grains: ['price'],
    status: 'PLANNED',
    rowCount: 4,
    createCount: 1,
    updateCount: 1,
    unchangedCount: 1,
    errorCount: 1,
    plannedAt: AT,
    createdAt: AT,
    updatedAt: AT,
    createdById: actorId,
  }
  const price = (value: string) => ({ $money: 'price', value })
  const rows: Prisma.ImportRowCreateManyInput[] = [
    { id: id('imports:row:2'), jobId, rowNumber: 2, action: 'CREATE', key: '["SEED-1"]', after: { code: 'SEED-1', name: 'Seed bolt', unitPrice: price('1.5') } },
    { id: id('imports:row:3'), jobId, rowNumber: 3, action: 'UPDATE', key: '["SEED-2"]', recordId: id('imports:record:2'), before: { unitPrice: price('0.25') }, after: { unitPrice: price('0.3') } },
    { id: id('imports:row:4'), jobId, rowNumber: 4, action: 'UNCHANGED', key: '["SEED-3"]', recordId: id('imports:record:3') },
    { id: id('imports:row:5'), jobId, rowNumber: 5, action: 'ERROR', key: '["SEED-4"]', errors: [{ column: 'name', message: 'Name is required.' }] },
  ].map((row) => ({ ...row, createdAt: AT, updatedAt: AT }) as Prisma.ImportRowCreateManyInput)

  await db.withScope({ audience: 'office', tenantId, actorId }, (client) =>
    client.$transaction(async (tx) => {
      await tx.storedFile.createMany({ data: [file], skipDuplicates: true })
      await tx.importJob.createMany({ data: [job], skipDuplicates: true })
      await tx.importRow.createMany({ data: rows, skipDuplicates: true })
    }),
  )
}
