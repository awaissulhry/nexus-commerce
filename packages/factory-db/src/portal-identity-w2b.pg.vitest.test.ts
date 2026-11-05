import { createHash, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedFiles } from '../seed/files'
import { seed as seedPortalAuth, type PortalAuthSeed } from '../seed/portal-auth'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { classifiedModels } from './ownership'
import { RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'
import { loadOwnership, loadSchema } from './tools'

/**
 * The portal identity schema (W2b schema wave 17/22, B-W2b-152, …_portal_identity_w2b_guards) on a database built from the
 * migrations and seeded, through the real login and the scoped client:
 *   - grants: the partner role reads only the User and Session rows of its own party, never a credential or an address hash,
 *     and writes nothing; it reaches no invitation, role, assignment, code, portal setting, branding or terms acknowledgement;
 *     every party's portal ships OFF, production progress OFF (Owner answer C1);
 *   - partner users (one party, a kind that fits it, never a password: Owner answer C3; a guest's access ends), partner
 *     sessions (bound to the person's party, 30 minutes idle, 12 hours at most; office previews), partner invitations;
 *   - the PARTNER role audience (at most the price grain) and assignments bound to the person's own party;
 *   - sign-in codes: 15 minutes, 5 tries, hashes only, one live per person and purpose, never opened again once dead;
 *   - portal settings, company branding, the portal terms acknowledged append-only.
 * The refusals are check_violation (SQLSTATE 23514); their messages are read through raw SQL.
 */

const NS = 'w2b-152-a'
const DENIED = /permission denied/
const MINUTE = 60_000

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let seeded: PortalAuthSeed

const key = (name: string): string => seedUuid(NS, name)
const A = {
  company: key('company:A'),
  companyB: key('company:B'),
  site: key('site:A1'),
  store: key('files:account:r2'),
  p1: key('party:P1'),
  p2: key('party:P2'),
  p3: key('party:P3'),
  member: key('user:member'),
}
const office = (): FactoryScope => ({ audience: 'office', tenantId: a.tenantId, actorId: a.actorId })
const partnerOf = (partyId: string, actorId: string): FactoryScope => ({ audience: 'partner', tenantId: a.tenantId, actorId, partyId })
const p1 = (): FactoryScope => partnerOf(A.p1, seeded.userIds.p1Buyer)
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const run = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$executeRawUnsafe(text, ...values))
const sql = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$queryRawUnsafe<Record<string, unknown>[]>(text, ...values))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, unknown>[]
/** An insert of the row's columns only (the others take their defaults). */
const insert = (scope: FactoryScope, table: string, row: Record<string, unknown>) => {
  const columns = Object.keys(row).map((column) => `"${column}"`).join(', ')
  return run(scope, `INSERT INTO "${table}" (${columns}) SELECT ${columns} FROM jsonb_populate_record(NULL::"${table}", $1::jsonb)`, JSON.stringify(row))
}
/** UPDATE row `id` of `table` with `changes` (office). */
const update = (table: string, id: string, changes: Record<string, unknown>) => {
  const sets = Object.keys(changes).map((column) => `"${column}" = r."${column}"`).join(', ')
  return run(office(), `UPDATE "${table}" t SET ${sets} FROM jsonb_populate_record(NULL::"${table}", $1::jsonb) r WHERE t.id = $2::uuid`, JSON.stringify(changes), id)
}
const sha = (text: string): string => createHash('sha256').update(text).digest('hex')
const iso = (at: number): string => new Date(at).toISOString()
const hash = (): string => `test-hash:${randomUUID()}`

/** A partner user of `partyId` (office scope); returns its id. */
const partnerUser = async (partyId: string, changes: Record<string, unknown> = {}): Promise<string> => {
  const id = randomUUID()
  await insert(office(), 'User', { id, email: `p.${id}@example.com`, displayName: 'Test Partner', status: 'ACTIVE', audience: 'PARTNER', partyId, partnerKind: 'CUSTOMER', ...changes })
  return id
}
/** A live code of a partner user, made now (office scope); returns its id. */
const newCode = async (userId: string, changes: Record<string, unknown> = {}): Promise<string> => {
  const id = randomUUID()
  const now = Date.now()
  await insert(office(), 'PortalSignInCode', { id, userId, purpose: 'SIGN_IN', codeHash: hash(), linkTokenHash: hash(), createdAt: iso(now), expiresAt: iso(now + 15 * MINUTE), ...changes })
  return id
}
/** A partner session of `userId` and `partyId`, made now (office scope). */
const partnerSession = (userId: string, partyId: string, changes: Record<string, unknown> = {}) => {
  const now = Date.now()
  return insert(office(), 'Session', {
    id: randomUUID(), userId, tokenHash: hash(), lastSeenAt: iso(now), createdAt: iso(now), idleExpiresAt: iso(now + 30 * MINUTE), absoluteExpiresAt: iso(now + 12 * 60 * MINUTE), audience: 'PARTNER', partyId, ...changes,
  })
}
/** A stored file of company A or B (office). */
const storeFile = async (changes: Record<string, unknown> = {}): Promise<string> => {
  const id = randomUUID()
  await insert(office(), 'StoredFile', {
    id, companyId: A.company, recordType: 'CompanyBranding', recordId: A.company, kind: 'PHOTO', originalName: 'logo.png', contentType: 'image/png', sizeBytes: 10, sha256: sha(id), storeAccountId: A.store,
    storageKey: `t/${a.tenantId}/test/${id}`, status: 'AVAILABLE', availableAt: new Date().toISOString(), visibility: ['OFFICE'], ...changes,
  })
  return id
}

beforeAll(async () => {
  db = await migratedDatabase('portalw2b')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: NS })
  await seedFiles({ db: factory, namespace: NS })
  seeded = await seedPortalAuth({ db: factory, namespace: NS })
  // A second run changes nothing (idempotent).
  await seedPortalAuth({ db: factory, namespace: NS })
}, 1_500_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

describe('grants and the seed', () => {
  it('classifies the new models office-only; the partner reads User and Session by party only, without credentials', () => {
    const models = classifiedModels(loadSchema(), loadOwnership())
    const of = (name: string) => models.find(({ model }) => model.name === name)!.ownership
    for (const name of ['PortalSignInCode', 'PortalSettings', 'CompanyBranding', 'PartnerNoticeAck', 'Invitation', 'Role', 'RoleAssignment', 'PasswordReset']) {
      expect(Object.keys(of(name).access).filter((role) => role !== 'factory_runtime' && role !== 'factory_floor_runtime'), name).toEqual([])
    }
    for (const name of ['PortalSignInCode', 'PortalSettings', 'CompanyBranding', 'PartnerNoticeAck']) expect(Object.keys(of(name).access)).toEqual(['factory_runtime'])
    expect(of('User').access.factory_partner_runtime).toEqual({
      privileges: ['select'],
      scopedBy: ['party'],
      hiddenColumns: ['passwordHash', 'passwordChangedAt', 'mustChangePassword', 'failedAttempts', 'lockedUntil', 'totpSecretEnc', 'totpPendingSecretEnc', 'totpLastStep', 'recoveryCodeHashes', 'createdById'],
    })
    expect(of('Session').access.factory_partner_runtime).toEqual({ privileges: ['select'], scopedBy: ['party'], hiddenColumns: ['ipHash'] })
    expect(of('PartnerNoticeAck').access.factory_runtime!.privileges).toEqual(['select', 'insert'])
  })

  it('a portal session reads its own party\'s people and sessions only, never a credential, and writes nothing', async () => {
    const people = await sql(p1(), 'SELECT id::text AS id FROM "User" ORDER BY id')
    expect(people.map((row) => row.id).sort()).toEqual([seeded.userIds.p1Buyer, seeded.userIds.p1Viewer].sort())
    const sessions = await sql(p1(), 'SELECT id::text AS id, "previewById"::text AS preview FROM "Session" ORDER BY id')
    expect(sessions.map((row) => row.id).sort()).toEqual([seeded.sessionIds.p1Buyer, seeded.sessionIds.p1Preview].sort())
    // P2's order desk sees only P2.
    expect(await sql(partnerOf(A.p2, seeded.userIds.p2Orders), 'SELECT id::text AS id FROM "User"')).toEqual([{ id: seeded.userIds.p2Orders }])
    // The authenticator finds its session by the token's hash in its party's scope; another party's finds nothing.
    const token = (await admin('SELECT "tokenHash" FROM "Session" WHERE id = $1', [seeded.sessionIds.p2Orders]))[0]!.tokenHash
    expect(await sql(p1(), 'SELECT id FROM "Session" WHERE "tokenHash" = $1', token)).toEqual([])
    for (const column of ['passwordHash', 'totpSecretEnc', 'totpPendingSecretEnc', 'recoveryCodeHashes', 'lockedUntil', 'createdById']) {
      await expect(sql(p1(), `SELECT "${column}" FROM "User" LIMIT 1`)).rejects.toThrow(DENIED)
    }
    await expect(sql(p1(), 'SELECT "ipHash" FROM "Session" LIMIT 1')).rejects.toThrow(DENIED)
    await expect(as(p1(), (client) => client.user.findMany())).rejects.toThrow(DENIED)
    await expect(run(p1(), 'UPDATE "User" SET "displayName" = "displayName" WHERE false')).rejects.toThrow(DENIED)
    await expect(run(p1(), 'UPDATE "Session" SET "revokedAt" = now() WHERE false')).rejects.toThrow(DENIED)
    await expect(run(p1(), 'INSERT INTO "User" (id) VALUES (NULL)')).rejects.toThrow(DENIED)
    for (const table of ['Invitation', 'PasswordReset', 'Role', 'RoleAssignment', 'PortalSignInCode', 'PortalSettings', 'CompanyBranding', 'PartnerNoticeAck']) {
      await expect(sql(p1(), `SELECT id FROM "${table}" LIMIT 1`), table).rejects.toThrow(DENIED)
    }
  })

  it('ships every portal OFF and production progress OFF; a new row starts OFF too (Owner answer C1)', async () => {
    expect(await admin('SELECT "portalOn", "progressShared", count(*)::int AS n FROM "PortalSettings" GROUP BY 1, 2')).toEqual([{ portalOn: false, progressShared: false, n: 2 }])
    await insert(office(), 'PortalSettings', { id: A.p3, partyId: A.p3 })
    expect(await admin('SELECT "portalOn", "progressShared", "maxUsers", "allowedRoleKeys" FROM "PortalSettings" WHERE id = $1', [A.p3])).toEqual([{ portalOn: false, progressShared: false, maxUsers: null, allowedRoleKeys: [] }])
    // Every seeded code is dead, every seeded session ended.
    expect(await admin(`SELECT count(*)::int AS n FROM "PortalSignInCode" WHERE "usedAt" IS NULL AND "revokedAt" IS NULL AND tries < 5 AND "expiresAt" > now()`)).toEqual([{ n: 0 }])
    expect(await admin(`SELECT count(*)::int AS n FROM "Session" WHERE "revokedAt" IS NULL`)).toEqual([{ n: 0 }])
  })
})

describe('partner users', () => {
  it('one party and a fitting kind, never a password, a guest with an end of access; office people have none of it', async () => {
    expect(await partnerUser(A.p1)).toBeTruthy()
    expect(await partnerUser(A.p2, { partnerKind: 'SUPPLIER' })).toBeTruthy()
    expect(await partnerUser(A.p2, { partnerKind: 'SUBCONTRACTOR', status: 'INVITED' })).toBeTruthy()
    await expect(partnerUser(A.p2, { partnerKind: 'CUSTOMER' })).rejects.toThrow(/a customer portal needs a customer or a brand/)
    await expect(partnerUser(A.p1, { partnerKind: 'SUPPLIER' })).rejects.toThrow(/cannot use the SUPPLIER portal/)
    await expect(partnerUser(A.p1, { partnerKind: 'GUEST', accessUntil: iso(Date.now() + 86_400_000) })).rejects.toThrow(/a guest login a consultant/)
    await expect(partnerUser(A.p1, { partyId: null })).rejects.toThrow(/names their party and their partner kind/)
    await expect(partnerUser(A.p1, { partnerKind: null })).rejects.toThrow(/names their party and their partner kind/)
    await expect(partnerUser(A.p1, { passwordHash: '$scrypt$ln=15,r=8,p=1$c2FsdA$aGFzaA' })).rejects.toThrow(/e-mail code only, never a password/)
    await expect(partnerUser(A.p1, { mustChangePassword: true })).rejects.toThrow(/never a password/)
    // A guest: an outside adviser (a CONSULTANT party), always time-boxed.
    const consultant = randomUUID()
    await insert(office(), 'Party', { id: consultant, code: `T-CONS-${consultant.slice(0, 6)}`, kind: 'ORGANISATION', legalName: 'Test Studio', roles: ['CONSULTANT'] })
    await expect(partnerUser(consultant, { partnerKind: 'GUEST' })).rejects.toThrow(/guest .* has an end of access/)
    expect(await partnerUser(consultant, { partnerKind: 'GUEST', accessUntil: iso(Date.now() + 30 * 86_400_000) })).toBeTruthy()
    // Office people: no party, kind or end of access.
    const officeId = randomUUID()
    await expect(insert(office(), 'User', { id: officeId, email: `o.${officeId}@example.com`, displayName: 'Test Office', partyId: A.p1 })).rejects.toThrow(/office person .* has no party/)
    await expect(update('User', A.member, { accessUntil: iso(Date.now() + 86_400_000) })).rejects.toThrow(/office person .* has no party, partner kind or end of access/)
  })

  it('the audience and the party never change; a partner person never gets a password later', async () => {
    const id = await partnerUser(A.p1)
    await expect(update('User', id, { partyId: A.p3 })).rejects.toThrow(/stays with party/)
    await expect(update('User', id, { audience: 'OFFICE', partyId: null, partnerKind: null })).rejects.toThrow(/audience of person .* never changes/)
    await expect(update('User', A.member, { audience: 'PARTNER', partyId: A.p1, partnerKind: 'CUSTOMER' })).rejects.toThrow(/never changes/)
    await expect(update('User', id, { passwordHash: '$scrypt$x' })).rejects.toThrow(/never a password/)
    await expect(update('User', id, { partnerKind: 'SUPPLIER' })).rejects.toThrow(/cannot use the SUPPLIER portal/)
    expect(await update('User', id, { displayName: 'Renamed', status: 'SUSPENDED', accessUntil: iso(Date.now() + 86_400_000) })).toBe(1)
    expect(await update('User', id, { accessUntil: null })).toBe(1)
  })
})

describe('sessions', () => {
  it('a partner session is bound to its person\'s party, 30 minutes idle and 12 hours at most; an office session has none', async () => {
    const buyer = seeded.userIds.p1Buyer
    expect(await partnerSession(buyer, A.p1)).toBe(1)
    await expect(partnerSession(buyer, A.p2)).rejects.toThrow(/bound to the party of its person/)
    await expect(partnerSession(buyer, A.p1, { partyId: null })).rejects.toThrow(/bound to one party/)
    await expect(partnerSession(a.actorId, A.p1)).rejects.toThrow(/bound to the party of its person/)
    await expect(partnerSession(buyer, A.p1, { absoluteExpiresAt: iso(Date.now() + 12 * 60 * MINUTE + MINUTE) })).rejects.toThrow(/12 hours after sign-in at the latest/)
    await expect(partnerSession(buyer, A.p1, { idleExpiresAt: iso(Date.now() + 31 * MINUTE) })).rejects.toThrow(/30 minutes after its last use/)
    // An office session of a partner person: refused; of an office person with a party: refused.
    await expect(partnerSession(buyer, A.p1, { audience: 'OFFICE', partyId: null })).rejects.toThrow(/never to the Office/)
    await expect(partnerSession(a.actorId, A.p1, { audience: 'OFFICE' })).rejects.toThrow(/office session .* has no party/)
  })

  it('an office preview names the party it shows and the office person previewing, both or neither; only an office person previews', async () => {
    const owner = a.actorId
    expect(await partnerSession(owner, A.p1, { previewOfPartyId: A.p1, previewById: owner })).toBe(1)
    await expect(partnerSession(owner, A.p1, { previewOfPartyId: A.p1 })).rejects.toThrow(/both or neither/)
    await expect(partnerSession(owner, A.p1, { previewOfPartyId: A.p2, previewById: owner })).rejects.toThrow(/both or neither/)
    await expect(partnerSession(owner, A.p1, { previewOfPartyId: A.p1, previewById: A.member })).rejects.toThrow(/both or neither/)
    const buyer = seeded.userIds.p1Buyer
    await expect(partnerSession(buyer, A.p1, { previewOfPartyId: A.p1, previewById: buyer })).rejects.toThrow(/only an office person previews/)
  })

  it('the person, audience, party and preview never change; the idle end slides within 30 minutes; revoking works', async () => {
    const id = seeded.sessionIds.p1Buyer
    await expect(update('Session', id, { partyId: A.p2 })).rejects.toThrow(/never change/)
    await expect(update('Session', id, { previewOfPartyId: A.p1, previewById: a.actorId })).rejects.toThrow(/never change/)
    const [row] = await admin('SELECT "lastSeenAt" FROM "Session" WHERE id = $1', [id])
    const lastSeen = (row!.lastSeenAt as Date).getTime()
    await expect(update('Session', id, { idleExpiresAt: iso(lastSeen + 45 * MINUTE) })).rejects.toThrow(/30 minutes after its last use/)
    expect(await update('Session', id, { lastSeenAt: iso(lastSeen + 5 * MINUTE), idleExpiresAt: iso(lastSeen + 35 * MINUTE) })).toBe(1)
    // The office's own sessions are untouched by the partner rules (8 hours idle, 7 days).
    const officeId = randomUUID()
    const now = Date.now()
    expect(await insert(office(), 'Session', { id: officeId, userId: A.member, tokenHash: hash(), lastSeenAt: iso(now), idleExpiresAt: iso(now + 8 * 60 * MINUTE), absoluteExpiresAt: iso(now + 7 * 86_400_000) })).toBe(1)
  })
})

describe('invitations', () => {
  it('a partner invitation names the party of its person and at least one partner role; an office one none of it', async () => {
    const viewer = seeded.userIds.p1Viewer
    const base = { userId: viewer, email: 'viewer@example.com', tokenHash: hash(), invitedById: a.actorId, expiresAt: iso(Date.now() + 86_400_000), audience: 'PARTNER', partyId: A.p1, partnerRoleKeys: ['customer-viewer'] }
    expect(await insert(office(), 'Invitation', { ...base, id: randomUUID() })).toBe(1)
    expect(await insert(office(), 'Invitation', { ...base, id: randomUUID(), tokenHash: hash(), partnerRoleKeys: ['customer-viewer', 'custom.colour-check'], accessUntil: iso(Date.now() + 90 * 86_400_000) })).toBe(1)
    await expect(insert(office(), 'Invitation', { ...base, id: randomUUID(), tokenHash: hash(), partnerRoleKeys: [] })).rejects.toThrow(/at least one partner role/)
    await expect(insert(office(), 'Invitation', { ...base, id: randomUUID(), tokenHash: hash(), partnerRoleKeys: ['Buyer!'] })).rejects.toThrow(/by their keys, each once/)
    await expect(insert(office(), 'Invitation', { ...base, id: randomUUID(), tokenHash: hash(), partnerRoleKeys: ['a', 'a'] })).rejects.toThrow(/by their keys, each once/)
    await expect(insert(office(), 'Invitation', { ...base, id: randomUUID(), tokenHash: hash(), partyId: A.p2 })).rejects.toThrow(/for a person of its own audience and party/)
    await expect(insert(office(), 'Invitation', { ...base, id: randomUUID(), tokenHash: hash(), accessUntil: iso(Date.now() - 86_400_000) })).rejects.toThrow(/comes after it was made/)
    // An office invitation of a partner person, and a partner invitation of an office person.
    await expect(insert(office(), 'Invitation', { ...base, id: randomUUID(), tokenHash: hash(), audience: 'OFFICE', partyId: null, partnerRoleKeys: [] })).rejects.toThrow(/for a person of its own audience and party/)
    await expect(insert(office(), 'Invitation', { ...base, id: randomUUID(), tokenHash: hash(), userId: A.member })).rejects.toThrow(/for a person of its own audience and party/)
    await expect(insert(office(), 'Invitation', { ...base, id: randomUUID(), tokenHash: hash(), audience: 'OFFICE', userId: A.member, partnerRoleKeys: [] })).rejects.toThrow(/office invitation .* names no party/)
  })

  it('its roles and end of access change only while it is open; the person, audience and party never', async () => {
    const id = randomUUID()
    await insert(office(), 'Invitation', {
      id, userId: seeded.userIds.p1Viewer, email: 'viewer@example.com', tokenHash: hash(), invitedById: a.actorId, expiresAt: iso(Date.now() + 86_400_000), audience: 'PARTNER', partyId: A.p1, partnerRoleKeys: ['customer-viewer'],
    })
    expect(await update('Invitation', id, { partnerRoleKeys: ['customer-buyer'] })).toBe(1)
    await expect(update('Invitation', id, { partyId: A.p3 })).rejects.toThrow(/never change/)
    expect(await update('Invitation', id, { revokedAt: new Date().toISOString() })).toBe(1)
    await expect(update('Invitation', id, { partnerRoleKeys: ['customer-viewer'] })).rejects.toThrow(/change only while it is open/)
  })
})

describe('partner roles and their assignments', () => {
  const role = async (audience: string, grains: string[]): Promise<string> => {
    const id = randomUUID()
    await insert(office(), 'Role', { id, key: `custom.t-${id.slice(0, 8)}`, name: `Test ${audience}`, audience, grains, permissions: [] })
    return id
  }
  const assign = (userId: string, roleId: string, changes: Record<string, unknown> = {}) =>
    insert(office(), 'RoleAssignment', { id: randomUUID(), userId, roleId, allCompanies: true, validFrom: new Date().toISOString(), ...changes })

  it('a partner role holds at most the price grain, and its audience never changes to or from PARTNER', async () => {
    expect(await role('PARTNER', ['price'])).toBeTruthy()
    const viewer = await role('PARTNER', [])
    for (const grain of ['cost', 'margin', 'wages', 'pay']) await expect(role('PARTNER', ['price', grain])).rejects.toThrow(/at most the price grain/)
    await expect(update('Role', viewer, { grains: ['margin'] })).rejects.toThrow(/at most the price grain/)
    await expect(update('Role', viewer, { audience: 'OFFICE' })).rejects.toThrow(/keeps its audience/)
    const staff = await role('OFFICE', ['cost'])
    await expect(update('Role', staff, { audience: 'PARTNER', grains: [] })).rejects.toThrow(/keeps its audience/)
  })

  it('a partner role goes only to a partner person, bound to their own party with no site limit; an office role never to a partner', async () => {
    const buyerRole = await role('PARTNER', ['price'])
    const staffRole = await role('OFFICE', [])
    const buyer = seeded.userIds.p1Buyer
    expect(await assign(buyer, buyerRole, { partyIds: [A.p1] })).toBe(1)
    await expect(assign(buyer, buyerRole)).rejects.toThrow(/bound to their own party/)
    await expect(assign(buyer, buyerRole, { partyIds: [A.p2] })).rejects.toThrow(/bound to their own party/)
    await expect(assign(buyer, buyerRole, { partyIds: [A.p1, A.p2] })).rejects.toThrow(/bound to their own party/)
    await expect(assign(buyer, buyerRole, { partyIds: [A.p1], siteIds: [A.site] })).rejects.toThrow(/no site limit/)
    await expect(assign(buyer, staffRole, { partyIds: [A.p1] })).rejects.toThrow(/a partner person holds only partner roles/)
    await expect(assign(A.member, buyerRole)).rejects.toThrow(/a partner role goes only to a partner person/)
    expect(await assign(A.member, staffRole)).toBe(1)
    const [own] = await admin('SELECT id::text AS id FROM "RoleAssignment" WHERE "userId" = $1 AND "roleId" = $2', [buyer, buyerRole])
    await expect(update('RoleAssignment', own!.id as string, { partyIds: [A.p2] })).rejects.toThrow(/bound to their own party/)
    expect(await update('RoleAssignment', own!.id as string, { endedAt: new Date().toISOString(), endedById: a.actorId })).toBe(1)
  })
})

describe('sign-in codes', () => {
  it('lives at most 15 minutes with 5 tries, stored as hashes; a sign-in code with its link, a step-up without; partner people only', async () => {
    const user = await partnerUser(A.p1)
    const now = Date.now()
    await expect(newCode(user, { expiresAt: iso(now + 16 * MINUTE) })).rejects.toThrow(/at most 15 minutes/)
    await expect(newCode(user, { expiresAt: iso(now) })).rejects.toThrow(/at most 15 minutes/)
    await expect(newCode(user, { tries: 6 })).rejects.toThrow(/5 tries/)
    await expect(newCode(user, { codeHash: '123456' })).rejects.toThrow(/stored as a hash/)
    await expect(newCode(user, { codeHash: ' 0123456789012345678901234567890123456789 ' })).rejects.toThrow(/never the digits themselves/)
    await expect(newCode(user, { codeHash: 'short-hash' })).rejects.toThrow(/stored as a hash/)
    await expect(newCode(user, { linkTokenHash: null })).rejects.toThrow(/sign-in code comes with the hash of its e-mail link/)
    await expect(newCode(user, { purpose: 'STEP_UP' })).rejects.toThrow(/a step-up code without one/)
    await expect(newCode(A.member)).rejects.toThrow(/codes are for partner people/)
    expect(await newCode(user, { purpose: 'STEP_UP', linkTokenHash: null })).toBeTruthy()
  })

  it('one live code per person and purpose: a new one replaces the live one', async () => {
    const user = await partnerUser(A.p1)
    const first = await newCode(user)
    expect(await newCode(user, { purpose: 'STEP_UP', linkTokenHash: null })).toBeTruthy()
    await expect(newCode(user)).rejects.toThrow(/PortalSignInCode_one_live|Unique constraint|duplicate key/)
    expect(await update('PortalSignInCode', first, { revokedAt: new Date().toISOString() })).toBe(1)
    expect(await newCode(user)).toBeTruthy()
  })

  it('a live code counts wrong tries and is used once; used, tried out, replaced or expired, it never opens again', async () => {
    const user = await partnerUser(A.p1)
    const code = await newCode(user)
    expect(await update('PortalSignInCode', code, { tries: 1 })).toBe(1)
    await expect(update('PortalSignInCode', code, { tries: 0 })).rejects.toThrow(/counts its tries up only/)
    await expect(update('PortalSignInCode', code, { codeHash: hash() })).rejects.toThrow(/keeps its person, purpose, hashes/)
    await expect(update('PortalSignInCode', code, { expiresAt: iso(Date.now() + 14 * MINUTE) })).rejects.toThrow(/keeps its person, purpose, hashes, times/)
    expect(await update('PortalSignInCode', code, { usedAt: new Date().toISOString() })).toBe(1)
    await expect(update('PortalSignInCode', code, { tries: 2 })).rejects.toThrow(/never opens again/)
    await expect(update('PortalSignInCode', code, { usedAt: null })).rejects.toThrow(/used or replaced once/)
    await expect(update('PortalSignInCode', code, { revokedAt: new Date().toISOString() })).rejects.toThrow(/neither replaced nor tried out/)

    // Five wrong tries kill it.
    const tried = await newCode(user)
    expect(await update('PortalSignInCode', tried, { tries: 5 })).toBe(1)
    await expect(update('PortalSignInCode', tried, { usedAt: new Date().toISOString() })).rejects.toThrow(/never opens again/)
    expect(await newCode(user)).toBeTruthy()

    // An expired code: neither tried nor used; it is replaced to free its place.
    const other = await partnerUser(A.p1)
    const made = Date.now() - 20 * MINUTE
    const expired = await newCode(other, { createdAt: iso(made), expiresAt: iso(made + 15 * MINUTE) })
    await expect(update('PortalSignInCode', expired, { usedAt: new Date().toISOString() })).rejects.toThrow(/never opens again/)
    await expect(update('PortalSignInCode', expired, { tries: 1 })).rejects.toThrow(/never opens again/)
    await expect(newCode(other)).rejects.toThrow(/PortalSignInCode_one_live|Unique constraint|duplicate key/)
    expect(await update('PortalSignInCode', expired, { revokedAt: new Date().toISOString() })).toBe(1)
    await expect(update('PortalSignInCode', expired, { revokedAt: null })).rejects.toThrow(/used or replaced once/)
    expect(await newCode(other)).toBeTruthy()
    // The purge job deletes dead codes.
    expect(await run(office(), 'DELETE FROM "PortalSignInCode" WHERE id = $1::uuid', expired)).toBe(1)
  })
})

describe('portal settings and branding', () => {
  it('production progress only for a customer or a brand; 1 to 1000 people or no limit; role keys each once; the party never changes; never deleted', async () => {
    await expect(update('PortalSettings', seeded.settingsIds.p2, { progressShared: true })).rejects.toThrow(/only with a customer or a brand/)
    expect(await update('PortalSettings', seeded.settingsIds.p1, { progressShared: true, portalOn: true })).toBe(1)
    expect(await update('PortalSettings', seeded.settingsIds.p1, { progressShared: false, portalOn: false })).toBe(1)
    await expect(update('PortalSettings', seeded.settingsIds.p1, { maxUsers: 0 })).rejects.toThrow(/1 to 1000 people/)
    await expect(update('PortalSettings', seeded.settingsIds.p1, { maxUsers: 1001 })).rejects.toThrow(/1 to 1000 people/)
    await expect(update('PortalSettings', seeded.settingsIds.p1, { allowedRoleKeys: ['customer-buyer', 'customer-buyer'] })).rejects.toThrow(/each once/)
    await expect(update('PortalSettings', seeded.settingsIds.p1, { partyId: A.p3 })).rejects.toThrow(/never change/)
    await expect(run(office(), 'DELETE FROM "PortalSettings" WHERE id = $1::uuid', seeded.settingsIds.p1)).rejects.toThrow(DENIED)
    await expect(db.admin.query('DELETE FROM "PortalSettings" WHERE id = $1', [seeded.settingsIds.p1])).rejects.toThrow(/never deleted/)
  })

  it('an accent in #rrggbb, a sender name fit for a mail header, a label, logos that are the company\'s pictures', async () => {
    const id = seeded.brandingId
    for (const accentColour of ['blue', '#1F5FA8', '#12345']) await expect(update('CompanyBranding', id, { accentColour })).rejects.toThrow(/#rrggbb in lower case/)
    for (const senderDisplayName of ['', '   ', 'Seed\r\nBcc: x@example.com', 'Seed <x@example.com>', 'x'.repeat(81)]) {
      await expect(update('CompanyBranding', id, { senderDisplayName })).rejects.toThrow(/sender name/)
    }
    await expect(update('CompanyBranding', id, { portalLabel: 'x'.repeat(61) })).rejects.toThrow(/portal label/)
    const photo = await storeFile()
    const document = await storeFile({ kind: 'DOCUMENT', originalName: 'logo.pdf', contentType: 'application/pdf' })
    const otherCompany = await storeFile({ companyId: A.companyB })
    await expect(update('CompanyBranding', id, { logoDarkFileId: photo })).rejects.toThrow(/only beside a logo for light ones/)
    await expect(update('CompanyBranding', id, { logoFileId: document })).rejects.toThrow(/a picture \(PHOTO\) of its company/)
    await expect(update('CompanyBranding', id, { logoFileId: otherCompany })).rejects.toThrow(/a picture \(PHOTO\) of its company/)
    expect(await update('CompanyBranding', id, { logoFileId: photo, logoDarkFileId: await storeFile(), accentColour: '#0b5cad', senderDisplayName: "Seed Factory A (l'ufficio)" })).toBe(1)
    await expect(update('CompanyBranding', id, { companyId: A.companyB })).rejects.toThrow(/never change/)
    await expect(db.admin.query('DELETE FROM "CompanyBranding" WHERE id = $1', [id])).rejects.toThrow(/never deleted/)
    // Company B is unbranded: no row, the DS colours.
    expect(await admin('SELECT count(*)::int AS n FROM "CompanyBranding" WHERE "companyId" = $1', [A.companyB])).toEqual([{ n: 0 }])
  })
})

describe('the portal terms (GATE-PRIVACY)', () => {
  const ack = (changes: Record<string, unknown>) =>
    insert(office(), 'PartnerNoticeAck', {
      id: randomUUID(), companyId: A.company, noticeId: seeded.termsNoticeId, userId: seeded.userIds.p2Orders, partyId: A.p2, noticeVersion: '2026-11', locale: 'it', ...changes,
    })

  it('an ACTIVE partner person of its party acknowledges the terms in force, with the fingerprint shown; never changed or removed', async () => {
    const [text] = await admin('SELECT sha256 FROM "PrivacyNoticeText" WHERE "noticeId" = $1 AND locale = $2', [seeded.termsNoticeId, 'it'])
    const shown = text!.sha256 as string
    expect(await ack({ noticeSha256: shown })).toBe(1)
    await expect(ack({ noticeSha256: shown })).rejects.toThrow(/Unique constraint|duplicate key/)
    await expect(ack({ noticeSha256: sha('another text'), noticeVersion: '2026-11b' })).rejects.toThrow(/stores the fingerprint/)
    await expect(ack({ noticeSha256: shown, userId: seeded.userIds.p1Viewer, partyId: A.p1 })).rejects.toThrow(/ACTIVE partner person/)
    await expect(ack({ noticeSha256: shown, userId: seeded.userIds.p1Buyer, partyId: A.p2, noticeVersion: 'x' })).rejects.toThrow(/ACTIVE partner person of the acknowledgement's party/)
    await expect(ack({ noticeSha256: shown, userId: A.member, partyId: A.p1, noticeVersion: 'y' })).rejects.toThrow(/ACTIVE partner person/)
    // Another kind of notice, or one not in force, is no portal terms.
    expect(await admin(`SELECT id::text AS id, status::text FROM "PrivacyNotice" WHERE kind = 'PORTAL_TERMS'`)).toEqual([{ id: seeded.termsNoticeId, status: 'PUBLISHED' }])
    const draftId = randomUUID()
    await insert(office(), 'PrivacyNotice', { id: draftId, companyId: A.company, kind: 'OFFICE_STAFF', versionNo: 9, label: 'T-9' })
    await expect(ack({ noticeId: draftId, noticeSha256: shown, noticeVersion: 'T-9' })).rejects.toThrow(/portal terms in force/)
    // Append-only, for every login.
    await expect(run(office(), `UPDATE "PartnerNoticeAck" SET locale = 'en' WHERE id = $1::uuid`, seeded.termsAckId)).rejects.toThrow(DENIED)
    await expect(db.admin.query(`UPDATE "PartnerNoticeAck" SET locale = 'en' WHERE id = $1`, [seeded.termsAckId])).rejects.toThrow(/append-only/)
    await expect(db.admin.query('DELETE FROM "PartnerNoticeAck" WHERE id = $1', [seeded.termsAckId])).rejects.toThrow(/append-only/)
    await expect(db.admin.query('TRUNCATE "PartnerNoticeAck"')).rejects.toThrow(/append-only/)
  })
})
