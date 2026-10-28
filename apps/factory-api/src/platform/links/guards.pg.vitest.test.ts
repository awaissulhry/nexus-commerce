import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import { linkTokenHash, mintLinkToken } from '@nexus/factory-domain/links/token'

/**
 * The database guards of one-off links (the …_links_guards migration), on the local stack: a link is fixed once made
 * but for its uses (up one at a time, never past the limit, never on a revoked link), its revocation (final) and its
 * note; it is never deleted; its evidence is append-only. They hold for the owner login (the test's superuser, which
 * skips row-level security and grants) as for the runtime roles.
 */

let db: MigratedDatabase
let database: FactoryDatabase
const tenantId = newId()
const companyId = newId()
const partyId = newId()
const actorId = newId()
let linkId: string

const admin = (sql: string, values: unknown[] = []) => db.admin.query(sql, values)
const office = <T>(work: (client: Parameters<Parameters<FactoryDatabase['withScope']>[1]>[0]) => Promise<T>) =>
  database.withScope({ audience: 'office', tenantId, actorId }, work)

async function insertLink(values: Record<string, unknown> = {}): Promise<string> {
  const id = newId()
  const row = {
    id,
    tenantId,
    companyId,
    partyId,
    purpose: 'QUOTE_ACCEPT',
    recordType: 'Quote',
    recordId: newId(),
    tokenHash: linkTokenHash(mintLinkToken({ tenantId, partyId, linkId: id }).value),
    expiresAt: '2026-12-01T00:00:00.000Z',
    maxUses: 2,
    uses: 0,
    version: 1,
    createdAt: '2026-10-28T09:00:00.000Z',
    updatedAt: '2026-10-28T09:00:00.000Z',
    createdById: actorId,
    ...values,
  }
  await admin(`INSERT INTO "OneOffLink" SELECT * FROM jsonb_populate_record(NULL::"OneOffLink", $1::jsonb)`, [JSON.stringify(row)])
  return id
}

beforeAll(async () => {
  db = await migratedDatabase('link_guards')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 2 } })
  await admin('INSERT INTO "Tenant" (id, slug, name) VALUES ($1, $2, $2)', [tenantId, 'link-guards'])
  await admin('INSERT INTO "Company" (id, "tenantId", code, "legalName") VALUES ($1, $2, $3, $3)', [companyId, tenantId, 'LG'])
}, 60_000)

afterAll(async () => {
  await database?.close()
  await db?.close()
})

beforeEach(async () => {
  linkId = await insertLink()
})

const FIXED = /links: link .* is fixed once made/

describe('OneOffLink', () => {
  it.each([
    ['purpose', `"purpose" = 'PO_CONFIRM'`],
    ['record', `"recordId" = gen_random_uuid()`],
    ['record type', `"recordType" = 'PurchaseOrder'`],
    ['expiry', `"expiresAt" = "expiresAt" + interval '1 day'`],
    ['use limit', `"maxUses" = 9`],
    ['token hash', `"tokenHash" = repeat('0', 64)`],
    ['address', `"email" = 'other@example.com'`],
    ['party', `"partyId" = gen_random_uuid()`],
    ['company', `"companyId" = gen_random_uuid()`],
    ['maker', `"createdById" = gen_random_uuid()`],
  ])('keeps its %s fixed, for the owner and the office role', async (_label, change) => {
    await expect(admin(`UPDATE "OneOffLink" SET ${change} WHERE id = $1`, [linkId])).rejects.toThrow(FIXED)
    if (_label !== 'company') {
      await expect(office((client) => client.$executeRawUnsafe(`UPDATE "OneOffLink" SET ${change} WHERE id = $1::uuid`, linkId))).rejects.toThrow(FIXED)
    }
  })

  it('counts uses one at a time, never down and never past the limit', async () => {
    await expect(admin('UPDATE "OneOffLink" SET uses = 2 WHERE id = $1', [linkId])).rejects.toThrow(/go up one at a time/)
    await admin('UPDATE "OneOffLink" SET uses = 1 WHERE id = $1', [linkId])
    await expect(admin('UPDATE "OneOffLink" SET uses = 0 WHERE id = $1', [linkId])).rejects.toThrow(/go up one at a time/)
    await admin('UPDATE "OneOffLink" SET uses = 2 WHERE id = $1', [linkId])
    await expect(admin('UPDATE "OneOffLink" SET uses = 3 WHERE id = $1', [linkId])).rejects.toThrow(/go up one at a time, to at most 2/)
  })

  it('keeps a revocation final, and a revoked link unused', async () => {
    await expect(admin('UPDATE "OneOffLink" SET "revokedById" = $2 WHERE id = $1', [linkId, actorId])).rejects.toThrow(/is not revoked/)
    await admin('UPDATE "OneOffLink" SET "revokedAt" = now(), "revokedById" = $2 WHERE id = $1', [linkId, actorId])
    await expect(admin('UPDATE "OneOffLink" SET "revokedAt" = NULL, "revokedById" = NULL WHERE id = $1', [linkId])).rejects.toThrow(/revocation .* is final/)
    await expect(admin('UPDATE "OneOffLink" SET "revokedAt" = now() + interval \'1 hour\' WHERE id = $1', [linkId])).rejects.toThrow(/revocation .* is final/)
    await expect(admin('UPDATE "OneOffLink" SET uses = 1 WHERE id = $1', [linkId])).rejects.toThrow(/is revoked; it is not used any more/)
    // Its note may still change (the office's own remark).
    await office((client) => client.oneOffLink.update({ where: { id: linkId }, data: { note: 'revoked after the call' }, select: { id: true } }))
  })

  it('moves its version up by one at most', async () => {
    await admin('UPDATE "OneOffLink" SET version = version + 1 WHERE id = $1', [linkId])
    await expect(admin('UPDATE "OneOffLink" SET version = version + 2 WHERE id = $1', [linkId])).rejects.toThrow(/version of link .* goes up by one/)
    await expect(admin('UPDATE "OneOffLink" SET version = 1 WHERE id = $1', [linkId])).rejects.toThrow(/version of link .* goes up by one/)
  })

  it('is born unused and live, and is never deleted or truncated', async () => {
    await expect(insertLink({ uses: 1 })).rejects.toThrow(/a new link is unused/)
    await expect(insertLink({ revokedAt: '2026-10-28T10:00:00.000Z' })).rejects.toThrow(/a new link is unused/)
    await expect(insertLink({ maxUses: 0 })).rejects.toThrow(/allows at least one use/)
    await expect(insertLink({ expiresAt: '2026-10-28T09:00:00.000Z' })).rejects.toThrow(/expires after it was made/)
    await expect(admin('DELETE FROM "OneOffLink" WHERE id = $1', [linkId])).rejects.toThrow(/is never deleted; revoke it/)
    await expect(office((client) => client.$executeRawUnsafe('DELETE FROM "OneOffLink" WHERE id = $1::uuid', linkId))).rejects.toThrow(/permission denied/)
    await expect(admin('TRUNCATE "OneOffLink" CASCADE')).rejects.toThrow(/TRUNCATE on "OneOffLink" is refused/)
  })
})

describe('LinkEvidence', () => {
  it('is append-only for every login', async () => {
    const evidenceId = newId()
    await database.withScope({ audience: 'partner', tenantId, actorId: linkId, partyId }, (client) =>
      client.linkEvidence.createMany({
        data: [{ id: evidenceId, partyId, linkId, action: 'OPENED', emailCheck: 'NOT_ASKED', at: new Date('2026-10-28T09:05:00.000Z'), requestId: 'guard-test' }],
      }),
    )
    await expect(admin(`UPDATE "LinkEvidence" SET "typedName" = 'Someone Else' WHERE id = $1`, [evidenceId])).rejects.toThrow(/append-only/)
    await expect(admin('DELETE FROM "LinkEvidence" WHERE id = $1', [evidenceId])).rejects.toThrow(/append-only/)
    await expect(admin('TRUNCATE "LinkEvidence"')).rejects.toThrow(/append-only/)
    await expect(office((client) => client.$executeRawUnsafe(`UPDATE "LinkEvidence" SET "typedName" = 'x' WHERE id = $1::uuid`, evidenceId))).rejects.toThrow(/permission denied/)
  })

  it('points only at a link of its own party', async () => {
    const otherParty = newId()
    await expect(
      database.withScope({ audience: 'partner', tenantId, actorId: linkId, partyId: otherParty }, (client) =>
        client.linkEvidence.createMany({
          data: [{ id: newId(), partyId: otherParty, linkId, action: 'OPENED', emailCheck: 'NOT_ASKED', at: new Date('2026-10-28T09:05:00.000Z'), requestId: 'guard-test' }],
        }),
      ),
    ).rejects.toThrow(/Foreign key constraint violated on the constraint: `LinkEvidence_tenantId_partyId_linkId_fkey`/)
  })
})
