import type { Prisma } from '../src/generated/prisma/client'
import { seedUuid, type SeedContext } from '../src/seeding'

/**
 * The numbering module's synthetic seed, for each company of seed/_core.ts: a yearly invoice series that issued two
 * numbers (with their NumberAllocation rows, for made-up invoice ids), a yearly DDT series that starts at 143 as if a
 * paper booklet had used 1-142, and lot, shipment, work order and batch series that never reset. Written in the tenant's office scope, as the app
 * writes it.
 *
 * NumberAllocation is append-only and a used series' counter never moves back, so the seed only inserts and skips
 * rows that exist (INSERT … ON CONFLICT DO NOTHING): a second run adds nothing.
 */

const YEAR = '2026'
const ISSUED_ON = new Date('2026-10-28T00:00:00.000Z')
const ISSUED_AT = new Date('2026-10-28T08:00:00.000Z')

export async function seed({ db, namespace }: SeedContext): Promise<void> {
  const id = (key: string): string => seedUuid(namespace, key)
  const tenantId = id('tenant')
  const actorId = id('actor')

  const series: Prisma.NumberSeriesCreateManyInput[] = []
  const allocations: Prisma.NumberAllocationCreateManyInput[] = []
  for (const company of ['A', 'B']) {
    const companyId = id(`company:${company}`)
    const invoices = id(`series:${company}:INVOICE:MAIN:${YEAR}`)
    series.push(
      { id: invoices, companyId, kind: 'INVOICE', code: 'MAIN', scopeKey: YEAR, reset: 'YEARLY', pattern: 'FT-{YYYY}-{N:5}', fiscal: true, startValue: 1, nextValue: 3, lastIssuedDate: ISSUED_ON, createdById: actorId },
      { id: id(`series:${company}:DDT:MAIN:${YEAR}`), companyId, kind: 'DDT', code: 'MAIN', scopeKey: YEAR, reset: 'YEARLY', pattern: '{N}/{YYYY}', fiscal: true, startValue: 143, nextValue: 143, createdById: actorId },
      { id: id(`series:${company}:LOT:MAIN:ALL`), companyId, kind: 'LOT', code: 'MAIN', scopeKey: 'ALL', reset: 'NEVER', pattern: 'LOT-{N:6}', fiscal: false, createdById: actorId },
      // Shipments are numbered from it (apps/factory-api modules/shipping): without one, creating a shipment is refused.
      { id: id(`series:${company}:SHIPMENT:MAIN:ALL`), companyId, kind: 'SHIPMENT', code: 'MAIN', scopeKey: 'ALL', reset: 'NEVER', pattern: 'SH-{N:5}', fiscal: false, createdById: actorId },
      // Work orders are numbered from the first and get their batch number (MES-076) from the second at release
      // (apps/factory-api modules/production/work-orders): without them, making or releasing one is refused. A batch
      // number is unique in the tenant, so each company's batch series prints its own prefix.
      { id: id(`series:${company}:WORK_ORDER:MAIN:ALL`), companyId, kind: 'WORK_ORDER', code: 'MAIN', scopeKey: 'ALL', reset: 'NEVER', pattern: 'WO-{N:5}', fiscal: false, createdById: actorId },
      { id: id(`series:${company}:BATCH:MAIN:ALL`), companyId, kind: 'BATCH', code: 'MAIN', scopeKey: 'ALL', reset: 'NEVER', pattern: `B${company}-{N:5}`, fiscal: false, createdById: actorId },
    )
    for (const value of [1, 2]) {
      allocations.push({
        id: id(`allocation:${company}:INVOICE:${value}`),
        companyId,
        seriesId: invoices,
        kind: 'INVOICE',
        value,
        formatted: `FT-${YEAR}-${String(value).padStart(5, '0')}`,
        documentDate: ISSUED_ON,
        recordType: 'Invoice',
        recordId: id(`invoice:${company}:${value}`),
        allocatedAt: ISSUED_AT,
        allocatedById: actorId,
        requestId: `seed-numbering-${company}-${value}`,
      })
    }
  }

  await db.withScope({ audience: 'office', tenantId, actorId }, (client) =>
    client.$transaction(async (tx) => {
      await tx.numberSeries.createMany({ data: series, skipDuplicates: true })
      await tx.numberAllocation.createMany({ data: allocations, skipDuplicates: true })
    }),
  )
}
