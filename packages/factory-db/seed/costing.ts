import type { Prisma } from '../src/generated/prisma/client'
import { seedUuid, type SeedContext } from '../src/seeding'

/**
 * The costing seed, per tenant of seed/_core.ts: one made-up, tenant-wide cost per standard minute for every kind of
 * work centre, in force from 1 January 2026 (sewing planned at 80 % efficiency, the others at 100 %), and tenant-wide
 * costing settings with 0 % overhead (the row keyed by the tenant's own id). With them the product seed's jacket has a
 * complete cost sheet. Written in the tenant's office scope. Made up and harmless; a second run adds nothing
 * (INSERT … ON CONFLICT DO NOTHING).
 */

const AT = new Date('2026-10-28T08:00:00.000Z')
const FROM = new Date('2026-01-01T00:00:00.000Z')

/** Made-up costs per standard minute (EUR) and planned efficiency per kind of work centre. */
const RATES = [
  { kind: 'CUTTING', costPerMinute: '0.500000', efficiency: '100' },
  { kind: 'SEWING', costPerMinute: '0.400000', efficiency: '80' },
  { kind: 'ASSEMBLY', costPerMinute: '0.420000', efficiency: '100' },
  { kind: 'FINISHING', costPerMinute: '0.380000', efficiency: '100' },
  { kind: 'INSPECTION', costPerMinute: '0.450000', efficiency: '100' },
  { kind: 'PACKING', costPerMinute: '0.300000', efficiency: '100' },
  { kind: 'SUBCONTRACT', costPerMinute: '0.550000', efficiency: '100' },
] as const

export async function seed({ db, namespace }: SeedContext): Promise<void> {
  const id = (key: string): string => seedUuid(namespace, key)
  const tenantId = id('tenant')
  const actorId = id('actor')
  const stamp = { createdAt: AT, updatedAt: AT, createdById: actorId }

  const rates: Prisma.LabourRateCreateManyInput[] = RATES.map((rate) => ({
    id: id(`costing:rate:${rate.kind}`),
    companyId: null,
    workCentreKind: rate.kind,
    costPerMinute: rate.costPerMinute,
    currency: 'EUR',
    plannedEfficiencyPct: rate.efficiency,
    validFrom: FROM,
    note: 'Seed rate (made up).',
    ...stamp,
  }))
  const settings: Prisma.CostingSettingsCreateManyInput = { id: tenantId, companyId: null, overheadPct: '0', ...stamp }

  await db.withScope({ audience: 'office', tenantId, actorId }, (client) =>
    client.$transaction(async (tx) => {
      await tx.labourRate.createMany({ data: rates, skipDuplicates: true })
      await tx.costingSettings.createMany({ data: [settings], skipDuplicates: true })
    }),
  )
}
