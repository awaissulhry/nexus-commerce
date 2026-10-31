import type { Prisma } from '../src/generated/prisma/client'
import { seedUuid, type SeedContext } from '../src/seeding'

/**
 * The numbering module's synthetic seed, for each company of seed/_core.ts: a yearly invoice series that issued two
 * numbers (with their NumberAllocation rows, for made-up invoice ids), a yearly DDT series that starts at 143 as if a
 * paper booklet had used 1-142, yearly quote, sales order, purchase order, goods receipt, PPE register, inspection and
 * release series, and lot, shipment, work order and batch series that never reset. Company A's inspection series issued
 * one number (for a made-up inspection id), so the ledger holds a number of a floor document kind (the floor's policies
 * see only those: the generated isolation tests read and copy it). Written in the tenant's office scope, as the app
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
    const inspections = id(`series:${company}:INSPECTION:MAIN:${YEAR}`)
    series.push(
      { id: invoices, companyId, kind: 'INVOICE', code: 'MAIN', scopeKey: YEAR, reset: 'YEARLY', pattern: 'FT-{YYYY}-{N:5}', fiscal: true, startValue: 1, nextValue: 3, lastIssuedDate: ISSUED_ON, createdById: actorId },
      { id: id(`series:${company}:DDT:MAIN:${YEAR}`), companyId, kind: 'DDT', code: 'MAIN', scopeKey: YEAR, reset: 'YEARLY', pattern: '{N}/{YYYY}', fiscal: true, startValue: 143, nextValue: 143, createdById: actorId },
      // A lot's code is unique in the tenant (factory-db Lot), so each company's lot series prints its own prefix.
      { id: id(`series:${company}:LOT:MAIN:ALL`), companyId, kind: 'LOT', code: 'MAIN', scopeKey: 'ALL', reset: 'NEVER', pattern: `L${company}-{N:6}`, fiscal: false, createdById: actorId },
      // Shipments are numbered from it (apps/factory-api modules/shipping): without one, creating a shipment is refused.
      { id: id(`series:${company}:SHIPMENT:MAIN:ALL`), companyId, kind: 'SHIPMENT', code: 'MAIN', scopeKey: 'ALL', reset: 'NEVER', pattern: 'SH-{N:5}', fiscal: false, createdById: actorId },
      // Work orders are numbered from the first and get their batch number (MES-076) from the second at release
      // (apps/factory-api modules/production/work-orders): without them, making or releasing one is refused. A batch
      // number is unique in the tenant, so each company's batch series prints its own prefix.
      { id: id(`series:${company}:WORK_ORDER:MAIN:ALL`), companyId, kind: 'WORK_ORDER', code: 'MAIN', scopeKey: 'ALL', reset: 'NEVER', pattern: 'WO-{N:5}', fiscal: false, createdById: actorId },
      { id: id(`series:${company}:BATCH:MAIN:ALL`), companyId, kind: 'BATCH', code: 'MAIN', scopeKey: 'ALL', reset: 'NEVER', pattern: `B${company}-{N:5}`, fiscal: false, createdById: actorId },
      // Sales orders are numbered from it when a quote is accepted (apps/factory-api modules/sales/orders): without one,
      // the acceptance makes the deposit request and the order waits. Its id starts with eight f's (still derived from
      // the namespace), so the series that sort first stay the ones the generated isolation tests copy.
      { id: `ffffffff${id(`series:${company}:SALES_ORDER:MAIN:${YEAR}`).slice(8)}`, companyId, kind: 'SALES_ORDER', code: 'MAIN', scopeKey: YEAR, reset: 'YEARLY', pattern: 'SO-{YYYY}-{N:4}', fiscal: false, createdById: actorId },
      // Purchase orders are numbered from it (apps/factory-api modules/purchasing): without one, a new order or a "Draft
      // PO" from the plan is refused. Eight f's as above.
      { id: `ffffffff${id(`series:${company}:PURCHASE_ORDER:MAIN:${YEAR}`).slice(8)}`, companyId, kind: 'PURCHASE_ORDER', code: 'MAIN', scopeKey: YEAR, reset: 'YEARLY', pattern: 'PO-{YYYY}-{N:4}', fiscal: false, createdById: actorId },
      // Goods receipts are numbered from it (apps/factory-api modules/inventory/receipts): without one, recording a receipt
      // is refused. Eight f's as above.
      { id: `ffffffff${id(`series:${company}:GOODS_RECEIPT:MAIN:${YEAR}`).slice(8)}`, companyId, kind: 'GOODS_RECEIPT', code: 'MAIN', scopeKey: YEAR, reset: 'YEARLY', pattern: 'GR-{YYYY}-{N:4}', fiscal: false, createdById: actorId },
      // PPE register entries take their reference from it (apps/factory-api modules/compliance/register; Reg. 2016/425 art.
      // 8(4)): without one, recording an entry is refused. Eight f's as above.
      { id: `ffffffff${id(`series:${company}:PPE_REGISTER:MAIN:${YEAR}`).slice(8)}`, companyId, kind: 'PPE_REGISTER', code: 'MAIN', scopeKey: YEAR, reset: 'YEARLY', pattern: 'REG-{YYYY}-{N:4}', fiscal: false, createdById: actorId },
      // Final inspections and quality releases take their numbers from these (apps/factory-api modules/quality/final, office
      // and bench): without them, opening an inspection or releasing garments is refused. Inspection.number and
      // QualityRelease.number are unique in the tenant, so each company prints its own prefix. Company A's release series
      // starts with eight zeros: the series the generated isolation tests copy, for the floor too, is then one of the floor's
      // kinds, of the floor's company (plant A1) and unused (a tablet adds only a fresh year of a series).
      { id: inspections, companyId, kind: 'INSPECTION', code: 'MAIN', scopeKey: YEAR, reset: 'YEARLY', pattern: `INS-${company}-{YYYY}-{N:4}`, fiscal: false, nextValue: company === 'A' ? 2 : 1, lastIssuedDate: company === 'A' ? ISSUED_ON : null, createdById: actorId },
      { id: company === 'A' ? `00000000${id(`series:${company}:RELEASE:MAIN:${YEAR}`).slice(8)}` : id(`series:${company}:RELEASE:MAIN:${YEAR}`), companyId, kind: 'RELEASE', code: 'MAIN', scopeKey: YEAR, reset: 'YEARLY', pattern: `REL-${company}-{YYYY}-{N:4}`, fiscal: false, createdById: actorId },
      // Quotes are numbered from it (apps/factory-api modules/sales/quotes): without one, a new quote is refused. The
      // kind's own pattern, as POST /numbering/series makes it. Eight f's as above.
      { id: `ffffffff${id(`series:${company}:QUOTE:MAIN:${YEAR}`).slice(8)}`, companyId, kind: 'QUOTE', code: 'MAIN', scopeKey: YEAR, reset: 'YEARLY', pattern: 'QT-{YYYY}-{N:5}', fiscal: false, createdById: actorId },
      // Return authorisations, repair orders and complaints take their numbers from these (apps/factory-api modules/sales/
      // returns and repairs, modules/quality/complaints; W2a): without them, a new RMA, repair or complaint is refused.
      // Eight f's as above.
      { id: `ffffffff${id(`series:${company}:RETURN:MAIN:${YEAR}`).slice(8)}`, companyId, kind: 'RETURN', code: 'MAIN', scopeKey: YEAR, reset: 'YEARLY', pattern: 'RMA-{YYYY}-{N:4}', fiscal: false, createdById: actorId },
      { id: `ffffffff${id(`series:${company}:REPAIR:MAIN:${YEAR}`).slice(8)}`, companyId, kind: 'REPAIR', code: 'MAIN', scopeKey: YEAR, reset: 'YEARLY', pattern: 'REP-{YYYY}-{N:4}', fiscal: false, createdById: actorId },
      { id: `ffffffff${id(`series:${company}:COMPLAINT:MAIN:${YEAR}`).slice(8)}`, companyId, kind: 'COMPLAINT', code: 'MAIN', scopeKey: YEAR, reset: 'YEARLY', pattern: 'CMP-{YYYY}-{N:4}', fiscal: false, createdById: actorId },
      // W2a wave 3: supplier claims and subcontract orders are numbered from these (apps/factory-api modules/purchasing
      // claims and subcontracting): without them, opening one is refused. Eight f's as above.
      { id: `ffffffff${id(`series:${company}:CLAIM:MAIN:${YEAR}`).slice(8)}`, companyId, kind: 'CLAIM', code: 'MAIN', scopeKey: YEAR, reset: 'YEARLY', pattern: 'CLM-{YYYY}-{N:4}', fiscal: false, createdById: actorId },
      { id: `ffffffff${id(`series:${company}:SUBCONTRACT:MAIN:${YEAR}`).slice(8)}`, companyId, kind: 'SUBCONTRACT', code: 'MAIN', scopeKey: YEAR, reset: 'YEARLY', pattern: 'SC-{YYYY}-{N:4}', fiscal: false, createdById: actorId },
      // W2a wave 4: stock counts and the year-end inventory are numbered from it (apps/factory-api modules/inventory/counts):
      // without one, opening a count is refused. Eight f's as above.
      { id: `ffffffff${id(`series:${company}:COUNT:MAIN:${YEAR}`).slice(8)}`, companyId, kind: 'COUNT', code: 'MAIN', scopeKey: YEAR, reset: 'YEARLY', pattern: 'CNT-{YYYY}-{N:4}', fiscal: false, createdById: actorId },
      // W2a wave 6: nonconformance reports and maintenance jobs are numbered from these (apps/factory-api modules/quality/ncr,
      // modules/plant): without them, raising an NCR or making a job is refused. Eight f's as above.
      { id: `ffffffff${id(`series:${company}:NCR:MAIN:${YEAR}`).slice(8)}`, companyId, kind: 'NCR', code: 'MAIN', scopeKey: YEAR, reset: 'YEARLY', pattern: 'NCR-{YYYY}-{N:4}', fiscal: false, createdById: actorId },
      { id: `ffffffff${id(`series:${company}:MAINTENANCE_JOB:MAIN:${YEAR}`).slice(8)}`, companyId, kind: 'MAINTENANCE_JOB', code: 'MAIN', scopeKey: YEAR, reset: 'YEARLY', pattern: 'MJ-{YYYY}-{N:4}', fiscal: false, createdById: actorId },
      // W2a wave 7: accounting exports are numbered from it (apps/factory-api modules/accounting): without one, an export
      // cannot be made. Eight f's as above.
      { id: `ffffffff${id(`series:${company}:ACCOUNTING_EXPORT:MAIN:${YEAR}`).slice(8)}`, companyId, kind: 'ACCOUNTING_EXPORT', code: 'MAIN', scopeKey: YEAR, reset: 'YEARLY', pattern: 'EXP-{YYYY}-{N:4}', fiscal: false, createdById: actorId },
      // W2b wave 2: quality holds are numbered from it (a floor document kind: the bench numbers the hold it places).
      // Eight f's as above.
      { id: `ffffffff${id(`series:${company}:HOLD:MAIN:${YEAR}`).slice(8)}`, companyId, kind: 'HOLD', code: 'MAIN', scopeKey: YEAR, reset: 'YEARLY', pattern: 'HLD-{YYYY}-{N:4}', fiscal: false, createdById: actorId },
    )
    if (company === 'A') {
      allocations.push({
        id: id(`allocation:${company}:INSPECTION:1`),
        companyId,
        seriesId: inspections,
        kind: 'INSPECTION',
        value: 1,
        formatted: `INS-${company}-${YEAR}-0001`,
        documentDate: ISSUED_ON,
        recordType: 'Inspection',
        recordId: id(`inspection:${company}:1`),
        allocatedAt: ISSUED_AT,
        allocatedById: actorId,
        requestId: `seed-numbering-${company}-inspection-1`,
      })
    }
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
