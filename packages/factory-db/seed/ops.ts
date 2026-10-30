import type { Prisma } from '../src/generated/prisma/client'
import { seedUuid, type SeedContext } from '../src/seeding'

/**
 * The restore drills seed (B-W2a-36's table), per tenant of seed/_core.ts: a drill on a local copy that passed (every
 * key total's checksum matched) and an earlier one on staging that failed on the stock value. Checksums are made-up hex,
 * never totals. Written in the tenant's office scope; idempotent (append-only: INSERT … ON CONFLICT DO NOTHING).
 */

const AT = new Date('2026-10-15T16:00:00.000Z')

export async function seed({ db, namespace }: SeedContext): Promise<void> {
  const id = (key: string): string => seedUuid(namespace, key)
  const firstId = (key: string): string => `00000000${id(key).slice(8)}`
  const tenantId = id('tenant')
  const actorId = id('actor')
  const sum = (key: string): string => id(`ops:checksum:${key}`).replace(/-/g, '')

  const drills: Prisma.RestoreDrillCreateManyInput[] = [
    {
      id: firstId('ops:drill:2026-10-15'),
      drilledOn: new Date('2026-10-15T00:00:00.000Z'),
      environment: 'a local copy',
      backupAt: new Date('2026-10-15T03:00:00.000Z'),
      checks: ['orders', 'stockValue', 'invoices'].map((key) => ({ key, source: sum(key), restored: sum(key), match: true })),
      result: 'PASSED',
      durationMinutes: 18,
      notes: 'Restored the 03:00 backup; every key total matched.',
      performedById: actorId,
      requestId: 'seed-ops',
      createdAt: AT,
    },
    {
      id: id('ops:drill:2026-09-30'),
      drilledOn: new Date('2026-09-30T00:00:00.000Z'),
      environment: 'staging',
      backupAt: new Date('2026-09-30T03:00:00.000Z'),
      checks: [
        { key: 'orders', source: sum('sep:orders'), restored: sum('sep:orders'), match: true },
        { key: 'stockValue', source: sum('sep:stock'), restored: sum('sep:stock:restored'), match: false },
        { key: 'invoices', source: sum('sep:invoices'), restored: sum('sep:invoices'), match: true },
      ],
      result: 'FAILED',
      durationMinutes: 25,
      notes: 'The stock value differed: the valuation of the last day was not in the backup. Drill again after the fix.',
      performedById: actorId,
      requestId: 'seed-ops',
      createdAt: new Date('2026-09-30T16:00:00.000Z'),
    },
  ]

  await db.withScope({ audience: 'office', tenantId, actorId }, (client) => client.restoreDrill.createMany({ data: drills, skipDuplicates: true }))
}
