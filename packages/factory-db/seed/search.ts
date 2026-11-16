import type { Prisma } from '../src/generated/prisma/client'
import { seedUuid, takenBy, type SeedContext } from '../src/seeding'

/**
 * The search seed (B-W2a-32's table), per tenant of seed/_core.ts: the entries the indexers would write for the parties
 * seed's customer SEED-C1 and supplier SEED-S1 and the sales seed's order SEED-SO-0001, each with its scopes and view
 * permission. Records are named by type and id (no reference: the indexers rewrite an entry from its record). Written in
 * the tenant's office scope; idempotent (upserts by id).
 * B-W2b-GS1: also on a tenant the app has used: an entry is unique per record, and the indexers write one with an id of
 * their own (the worker's first start builds a tenant's index; every record's events rewrite its entry). An entry the app
 * made first for a record is the app's, kept from the record as it is now: the seed leaves it and writes only its own.
 */

const AT = new Date('2026-10-30T09:00:00.000Z')

export async function seed({ db, namespace }: SeedContext): Promise<void> {
  const id = (key: string): string => seedUuid(namespace, key)
  const firstId = (key: string): string => `00000000${id(key).slice(8)}`
  const tenantId = id('tenant')
  const actorId = id('actor')
  const companyA = id('company:A')

  const entries: (Prisma.SearchEntryUncheckedCreateInput & { id: string })[] = [
    {
      id: firstId('search:party:P1'),
      partyId: id('party:P1'),
      recordType: 'Party',
      recordId: id('party:P1'),
      number: 'SEED-C1',
      title: 'Seed Customer One S.r.l.',
      subtitle: 'Seed Racing',
      status: 'ACTIVE',
      area: 'sales',
      viewPermission: 'parties.view',
      searchText: 'seed-c1 seed customer one s.r.l. seed racing',
      indexedAt: AT,
    },
    {
      id: id('search:party:P2'),
      companyId: companyA,
      partyId: id('party:P2'),
      recordType: 'Party',
      recordId: id('party:P2'),
      number: 'SEED-S1',
      title: 'Seed Leather Supplier S.p.A.',
      status: 'ACTIVE',
      area: 'purchasing',
      viewPermission: 'parties.view',
      searchText: 'seed-s1 seed leather supplier s.p.a.',
      indexedAt: AT,
    },
    {
      id: id('search:order:SO1'),
      companyId: companyA,
      partyId: id('party:P1'),
      recordType: 'SalesOrder',
      recordId: id('sales:SO1'),
      number: 'SEED-SO-0001',
      title: 'Seed Customer One S.r.l.',
      subtitle: 'Sample jackets',
      status: 'CONFIRMED',
      area: 'sales',
      viewPermission: 'sales.orders.view',
      searchText: 'seed-so-0001 seed customer one s.r.l. sample jackets',
      indexedAt: AT,
    },
  ]

  await db.withScope({ audience: 'office', tenantId, actorId }, (client) =>
    client.$transaction(async (tx) => {
      const indexed = await tx.searchEntry.findMany({ where: { OR: entries.map(({ recordType, recordId }) => ({ recordType, recordId })) }, select: { id: true, recordType: true, recordId: true } })
      const taken = takenBy(entries, indexed, (row) => `${row.recordType}:${row.recordId}`)
      for (const { id: entryId, ...data } of entries) {
        if (taken.has(entryId)) continue
        await tx.searchEntry.upsert({ where: { id: entryId }, create: { id: entryId, ...data, createdAt: AT, updatedAt: AT }, update: data, select: { id: true } })
      }
    }),
  )
}
