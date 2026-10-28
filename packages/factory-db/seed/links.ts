import { createHash } from 'node:crypto'
import type { Prisma } from '../src/generated/prisma/client'
import { seedUuid, type SeedContext } from '../src/seeding'

/**
 * The one-off links' synthetic seed, per tenant of seed/_core.ts: for company A, a QUOTE_ACCEPT link for the made-up
 * portal party P1 (the one seed/audit.ts writes its partner rows for) and a PO_CONFIRM link for a second made-up party
 * P2, each opened once (an OPENED evidence row, written by the link session in its party's scope, as the app does).
 * The links are made in the office scope.
 *
 * The seeded links open nothing: their stored hash is SHA-256 of a text that is not a token, so no token matches it.
 * Real links get their token from apps/factory-api's platform/links, shown once and never stored. The record ids are
 * made up (the quote and purchase order modules bring the records). Links are fixed once made and evidence is
 * append-only, so the seed only inserts and skips rows that exist: a second run adds nothing.
 */

/** Fixed instants, so the seed never depends on the clock. */
const MADE_AT = new Date('2026-10-28T08:00:00.000Z')
const OPENED_AT = new Date('2026-10-28T08:30:00.000Z')
const EXPIRES_AT = new Date('2027-10-28T08:00:00.000Z')

const notAToken = (linkId: string): string => createHash('sha256').update(`seed link ${linkId}: no token opens it`).digest('hex')

export async function seed({ db, namespace }: SeedContext): Promise<void> {
  const id = (key: string): string => seedUuid(namespace, key)
  const tenantId = id('tenant')
  const actorId = id('actor')
  const companyA = id('company:A')
  const links = [
    { key: 'P1', partyId: id('party:P1'), purpose: 'QUOTE_ACCEPT' as const, recordType: 'Quote', email: 'buyer.p1@example.com' },
    { key: 'P2', partyId: id('party:P2'), purpose: 'PO_CONFIRM' as const, recordType: 'PurchaseOrder', email: null },
  ].map((link) => ({ ...link, id: id(`link:${link.key}`), recordId: id(`link:${link.key}:record`) }))

  const rows: Prisma.OneOffLinkCreateManyInput[] = links.map((link) => ({
    id: link.id,
    companyId: companyA,
    partyId: link.partyId,
    purpose: link.purpose,
    recordType: link.recordType,
    recordId: link.recordId,
    tokenHash: notAToken(link.id),
    email: link.email,
    note: `Seed link for party ${link.key}`,
    expiresAt: EXPIRES_AT,
    maxUses: 1,
    createdAt: MADE_AT,
    updatedAt: MADE_AT,
    createdById: actorId,
  }))
  await db.withScope({ audience: 'office', tenantId, actorId }, (client) => client.oneOffLink.createMany({ data: rows, skipDuplicates: true }))

  for (const link of links) {
    await db.withScope({ audience: 'partner', tenantId, actorId: link.id, partyId: link.partyId }, (client) =>
      client.linkEvidence.createMany({
        data: [
          {
            id: id(`link:${link.key}:opened`),
            partyId: link.partyId,
            linkId: link.id,
            action: 'OPENED',
            useNumber: null,
            typedName: null,
            emailCheck: 'NOT_ASKED',
            ipHash: null,
            userAgent: 'Seed browser',
            at: OPENED_AT,
            requestId: `seed-link-${link.key}`,
          },
        ],
        skipDuplicates: true,
      }),
    )
  }
}
