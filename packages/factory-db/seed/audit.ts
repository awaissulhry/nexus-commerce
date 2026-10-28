import { AuditAudience } from '../src/generated/prisma/enums'
import type { FactoryClient, FactoryScope } from '../src/client'
import { seedUuid, type SeedContext } from '../src/seeding'

/**
 * The audit module's synthetic seed: a few audit rows and idempotency receipts per tenant, written the way the app
 * writes them, each through the scope of its audience (office; the floor device of each plant; one made-up portal
 * party). Runs after seed/_core.ts and uses its tenant, actor, companies and sites (the same derived ids).
 *
 * Both tables are append-only (no update, no delete), so the seed only inserts and skips rows that exist
 * (INSERT … ON CONFLICT DO NOTHING): a second run adds nothing.
 */

export interface AuditSeed {
  /** The made-up portal party of the partner rows (the parties module brings real ones). */
  readonly partyId: string
}

/** Receipts of the seed stay valid for a year after this fixed instant (a seed never depends on the clock). */
const SEEDED_AT = new Date('2026-10-28T08:00:00.000Z')
const EXPIRES_AT = new Date('2027-10-28T08:00:00.000Z')

export async function seed({ db, namespace }: SeedContext): Promise<AuditSeed> {
  const id = (key: string): string => seedUuid(namespace, key)
  const tenantId = id('tenant')
  const actorId = id('actor')
  const partyId = id('party:P1')
  // seed/_core.ts: company A with plant A1, company B with plant B1.
  const plants = [
    { companyId: id('company:A'), siteId: id('site:A1'), code: 'A1' },
    { companyId: id('company:B'), siteId: id('site:B1'), code: 'B1' },
  ]

  type Writer = { scope: FactoryScope; audience: AuditAudience; key: string; companyId?: string; siteId?: string; partyId?: string }
  const writers: Writer[] = [
    { scope: { audience: 'office', tenantId, actorId }, audience: AuditAudience.OFFICE, key: 'office', companyId: plants[0]!.companyId },
    ...plants.map(
      (plant): Writer => ({
        scope: { audience: 'floor', tenantId, actorId, siteId: plant.siteId },
        audience: AuditAudience.FLOOR,
        key: `floor:${plant.code}`,
        companyId: plant.companyId,
        siteId: plant.siteId,
      }),
    ),
    { scope: { audience: 'partner', tenantId, actorId, partyId }, audience: AuditAudience.PARTNER, key: 'partner', partyId },
  ]

  for (const writer of writers) {
    const recordId = writer.siteId ?? plants[0]!.siteId
    const requestId = `seed-${writer.key}`
    const key = `seed-key-${writer.key}`
    await db.withScope(writer.scope, (client: FactoryClient) =>
      client.$transaction(async (tx) => {
        await tx.auditLog.createMany({
          data: [
            {
              id: id(`audit:${writer.key}`),
              companyId: writer.companyId ?? null,
              siteId: writer.siteId ?? null,
              partyId: writer.partyId ?? null,
              at: SEEDED_AT,
              audience: writer.audience,
              actorId,
              action: 'seed.example',
              recordType: 'Site',
              recordId,
              before: { name: 'Seed plant (before)' },
              after: { name: 'Seed plant (after)' },
              requestId,
              idempotencyKey: key,
            },
          ],
          skipDuplicates: true,
        })
        await tx.idempotencyReceipt.createMany({
          data: [
            {
              id: id(`receipt:${writer.key}`),
              siteId: writer.siteId ?? null,
              partyId: writer.partyId ?? null,
              scope: 'seed.example',
              key,
              requestHash: '0'.repeat(64),
              response: { seeded: true },
              actorId,
              requestId,
              createdAt: SEEDED_AT,
              expiresAt: EXPIRES_AT,
            },
          ],
          skipDuplicates: true,
        })
      }),
    )
  }
  return { partyId }
}
