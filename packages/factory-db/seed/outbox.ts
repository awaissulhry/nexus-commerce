import type { FactoryClient, FactoryScope } from '../src/client'
import { seedUuid, type SeedContext } from '../src/seeding'

/**
 * The outbox's synthetic seed: one pending event per writing audience and tenant, written the way command() writes
 * them, each through the scope of its audience (office; the floor device of each plant; the made-up portal party of
 * seed/audit.ts). Runs after seed/_core.ts and uses its tenant, actor, companies and sites (the same derived ids).
 *
 * The event type `seed.example` is not in the event catalogue on purpose: a relay that publishes these rows finds no
 * handler and no live-screen rule for it, so nothing reacts. Rows are only inserted (floor and partner may only insert)
 * and existing ones skipped (INSERT … ON CONFLICT DO NOTHING): a second run adds nothing.
 */

/** A fixed instant, so the seed never depends on the clock. */
const OCCURRED_AT = new Date('2026-10-28T08:00:00.000Z')

export async function seed({ db, namespace }: SeedContext): Promise<void> {
  const id = (key: string): string => seedUuid(namespace, key)
  const tenantId = id('tenant')
  const actorId = id('actor')
  const partyId = id('party:P1')
  const plants = [
    { companyId: id('company:A'), siteId: id('site:A1'), code: 'A1' },
    { companyId: id('company:B'), siteId: id('site:B1'), code: 'B1' },
  ]

  type Writer = { scope: FactoryScope; key: string; companyId: string | null; siteId: string | null; partyId: string | null }
  const writers: Writer[] = [
    { scope: { audience: 'office', tenantId, actorId }, key: 'office', companyId: plants[0]!.companyId, siteId: null, partyId: null },
    ...plants.map(
      (plant): Writer => ({
        scope: { audience: 'floor', tenantId, actorId, siteId: plant.siteId },
        key: `floor:${plant.code}`,
        companyId: plant.companyId,
        siteId: plant.siteId,
        partyId: null,
      }),
    ),
    { scope: { audience: 'partner', tenantId, actorId, partyId }, key: 'partner', companyId: null, siteId: null, partyId },
  ]

  for (const writer of writers) {
    await db.withScope(writer.scope, (client: FactoryClient) =>
      client.outboxEvent.createMany({
        data: [
          {
            id: id(`outbox:${writer.key}`),
            companyId: writer.companyId,
            siteId: writer.siteId,
            partyId: writer.partyId,
            type: 'seed.example',
            version: 1,
            context: 'seed',
            subject: writer.siteId ?? plants[0]!.siteId,
            correlationId: `seed-${writer.key}`,
            source: 'seed.example',
            occurredAt: OCCURRED_AT,
            payload: { seeded: true },
          },
        ],
        skipDuplicates: true,
      }),
    )
  }
}
