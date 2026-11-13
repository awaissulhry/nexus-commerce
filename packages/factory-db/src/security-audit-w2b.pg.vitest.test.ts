import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedFloorAuth } from '../seed/floor-auth'
import { seed as seedParties } from '../seed/parties'
import { seed as seedSecurity, type SecuritySeed } from '../seed/security'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'

/**
 * Security and audit in depth (W2b-6, schema wave 52/57, B-W2b-373, …_security_audit_w2b_guards) on a database built from
 * the migrations and seeded twice, through the real login and its scopes:
 *   - the security settings: the session lengths per audience (a portal session never beyond A1's 30 minutes and 12 hours),
 *     the step-up rules, the creation fixed, never deleted;
 *   - a custom role archived (by whom, only while nobody holds it, frozen until restored), never given while archived (an
 *     office assignment or a worker's floor role), never deleted; a system role never archived;
 *   - a session's device, browser and place set once;
 *   - step-up tries: the fingerprint of the code that worked (a code works once per person), the lock after the tenant's
 *     failures in a row within its lock time, LOCKED only while locked; append-only;
 *   - security events: the site of a floor event, the party of a portal event, nobody known only for a failed sign-in or an
 *     API key, the address as its keyed hash, details as codes; each audience adds its own; append-only;
 *   - reads of sensitive records: only the listed record types, only an office person's; append-only.
 * The refusals are check_violation (23514) in words, the unique key's 23505, or the policies' row-level security.
 */

const NS = 'w2b-373-a'

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let s: SecuritySeed

const key = (name: string): string => seedUuid(NS, name)
const ownerId = (): string => a.actorId
const memberId = (): string => key('user:member')
const office = (): FactoryScope => ({ audience: 'office', tenantId: a.tenantId, actorId: a.actorId })
const floorA1 = (): FactoryScope => ({ audience: 'floor', tenantId: a.tenantId, actorId: a.actorId, siteId: a.sites[0]!.id })
const partnerP1 = (): FactoryScope => ({ audience: 'partner', tenantId: a.tenantId, actorId: a.actorId, partyId: p1 })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const run = (text: string, ...values: unknown[]) => as(office(), (client) => client.$executeRawUnsafe(text, ...values))
const runAs = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$executeRawUnsafe(text, ...values))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, unknown>[]
/** The seed's fixed instant plus `n` minutes (the seed's own clock), as ISO text. */
const at = (n: number): string => new Date(Date.parse('2026-11-12T08:00:00.000Z') + n * 60_000).toISOString()
const HASH = 'ab'.repeat(32)

/** P1 (the parties seed's customer) and a partner user of it: a read of a sensitive record is never theirs. */
let p1: string
let partnerUser: string

beforeAll(async () => {
  db = await migratedDatabase('securityauditw2b')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: NS })
  await seedFloorAuth({ db: factory, namespace: NS })
  p1 = (await seedParties({ db: factory, namespace: NS })).customerId
  s = await seedSecurity({ db: factory, namespace: NS })
  // Run twice: every seed is idempotent.
  await seedSecurity({ db: factory, namespace: NS })
  partnerUser = randomUUID()
  await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status, audience, "partyId", "partnerKind") VALUES ($1::uuid, $2::uuid, $3, 'Seed portal buyer', 'ACTIVE', 'PARTNER', $4::uuid, 'CUSTOMER')`, [
    partnerUser,
    a.tenantId,
    `buyer.${partnerUser.slice(0, 8)}@example.com`,
    p1,
  ])
}, 300_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

describe('the seed', () => {
  it('runs twice and leaves one of each row', async () => {
    const counts = await admin(
      `SELECT (SELECT count(*)::int FROM "SecuritySettings" WHERE "tenantId" = $1::uuid) AS settings,
              (SELECT count(*)::int FROM "Role" WHERE "tenantId" = $1::uuid AND "archivedAt" IS NOT NULL) AS archived,
              (SELECT count(*)::int FROM "Session" WHERE "tenantId" = $1::uuid AND "deviceLabel" IS NOT NULL) AS sessions,
              (SELECT count(*)::int FROM "StepUpAttempt" WHERE "tenantId" = $1::uuid) AS attempts,
              (SELECT count(*)::int FROM "SecurityEvent" WHERE "tenantId" = $1::uuid) AS events,
              (SELECT count(*)::int FROM "ReadLog" WHERE "tenantId" = $1::uuid) AS reads`,
      [a.tenantId],
    )
    expect(counts[0]).toEqual({ settings: 1, archived: 1, sessions: 2, attempts: 8, events: 12, reads: 3 })
    expect(s.settingsId).toBe(a.tenantId)
  })
})

describe('security settings (PLT-063, PLT-068)', () => {
  const set = (assignments: string, ...values: unknown[]) => run(`UPDATE "SecuritySettings" SET ${assignments} WHERE id = $1::uuid`, s.settingsId, ...values)

  it('keep each session length within its audience, a portal session never beyond 30 minutes and 12 hours', async () => {
    await expect(set(`"officeIdleMinutes" = 10`)).rejects.toThrow(/office session .* 15 minutes to 24 hours without use/)
    await expect(set(`"officeLongestHours" = 721`)).rejects.toThrow(/1 hour to 30 days after sign-in/)
    await expect(set(`"officeIdleMinutes" = 600, "officeLongestHours" = 8`)).rejects.toThrow(/never sooner than its idle time/)
    await expect(set(`"portalIdleMinutes" = 31`)).rejects.toThrow(/portal session .* 5 to 30 minutes without use and 1 to 12 hours/)
    await expect(set(`"portalLongestHours" = 13`)).rejects.toThrow(/A1 §3\.10/)
    expect(await set(`"officeIdleMinutes" = 540, "portalIdleMinutes" = 20, "portalLongestHours" = 8`)).toBe(1)
    expect(await set(`"officeIdleMinutes" = 480, "portalIdleMinutes" = 30, "portalLongestHours" = 12`)).toBe(1)
  })

  it('keep the step-up rules: 3 to 10 failures, 5 minutes to a day, each action switched off once by its key', async () => {
    await expect(set(`"stepUpMaxFailures" = 2`)).rejects.toThrow(/3 to 10 failures in a row/)
    await expect(set(`"stepUpLockMinutes" = 1441`)).rejects.toThrow(/5 minutes to 24 hours/)
    await expect(set(`"stepUpOff" = ARRAY['parties.bank.change', 'parties.bank.change']`)).rejects.toThrow(/each by its key \(dotted words\) and once/)
    await expect(set(`"stepUpOff" = ARRAY['Delete everything']`)).rejects.toThrow(/each by its key/)
    await expect(set(`"stepUpOff" = NULL`)).rejects.toThrow(/each by its key/)
    expect(await set(`"stepUpOff" = ARRAY['people.workers.pinReset']`)).toBe(1)
    expect(await set(`"stepUpOff" = '{}'`)).toBe(1)
  })

  it('keep their creation; never deleted or truncated, by any login', async () => {
    await expect(set(`"createdById" = $2::uuid`, memberId())).rejects.toThrow(/creation of security settings .* never changes/)
    await expect(run(`DELETE FROM "SecuritySettings" WHERE id = $1::uuid`, s.settingsId)).rejects.toThrow(/permission denied/)
    await expect(admin(`DELETE FROM "SecuritySettings" WHERE id = $1::uuid`, [s.settingsId])).rejects.toThrow(/kept, never deleted/)
    await expect(admin(`TRUNCATE "SecuritySettings"`)).rejects.toThrow(/TRUNCATE on "SecuritySettings" is refused/)
  })
})

describe('custom roles kept and archived (PLT-031)', () => {
  const newRole = async (system = false, audience = 'OFFICE'): Promise<string> => {
    const roleId = randomUUID()
    await run(
      `INSERT INTO "Role" (id, key, name, system, audience, permissions, grains) VALUES ($1::uuid, $2, 'Test role', $3, $4::"RoleAudience", '{audit.read}', '{}')`,
      roleId,
      `${system ? 'test' : 'custom.test'}_${roleId.slice(0, 8)}`,
      system,
      audience,
    )
    return roleId
  }
  const assign = (roleId: string, assignmentId: string = randomUUID()) =>
    run(`INSERT INTO "RoleAssignment" (id, "userId", "roleId", "allCompanies", "validFrom") VALUES ($1::uuid, $2::uuid, $3::uuid, true, now())`, assignmentId, memberId(), roleId)
  const archive = (roleId: string, when = 'now()', by: string | null = ownerId()) =>
    run(`UPDATE "Role" SET "archivedAt" = ${when}, "archivedById" = $2::uuid, version = version + 1 WHERE id = $1::uuid`, roleId, by)

  it('archives a custom role by someone, only while nobody holds it; a system role never', async () => {
    const roleId = await newRole()
    const assignment = randomUUID()
    expect(await assign(roleId, assignment)).toBe(1)
    await expect(archive(roleId)).rejects.toThrow(/role .* is still held: end its assignments first/)
    await expect(archive(roleId, 'now()', null)).rejects.toThrow(/archived and by whom, both or neither/)
    await run(`UPDATE "RoleAssignment" SET "endedAt" = now(), "endedById" = $2::uuid WHERE id = $1::uuid`, assignment, ownerId())
    await expect(archive(roleId, `now() + interval '1 hour'`)).rejects.toThrow(/not archived in the future/)
    expect(await archive(roleId)).toBe(1)
    const system = await newRole(true)
    await expect(archive(system)).rejects.toThrow(/system role .* is never archived/)
  })

  it('freezes an archived role until it is restored on its own, and gives it to nobody', async () => {
    const roleId = await newRole()
    expect(await archive(roleId)).toBe(1)
    await expect(run(`UPDATE "Role" SET name = 'Renamed' WHERE id = $1::uuid`, roleId)).rejects.toThrow(/role .* is archived: it changes no more \(restore it first\)/)
    await expect(assign(roleId)).rejects.toThrow(/role .* is archived: it is given to nobody/)
    // A past assignment may be recorded (history); it is never made live again while the role is archived.
    const ended = randomUUID()
    expect(await run(`INSERT INTO "RoleAssignment" (id, "userId", "roleId", "allCompanies", "validFrom", "endedAt") VALUES ($1::uuid, $2::uuid, $3::uuid, true, now() - interval '2 days', now() - interval '1 day')`, ended, memberId(), roleId)).toBe(1)
    await expect(run(`UPDATE "RoleAssignment" SET "endedAt" = NULL WHERE id = $1::uuid`, ended)).rejects.toThrow(/is given to nobody/)
    await expect(run(`UPDATE "Role" SET "archivedAt" = NULL, "archivedById" = NULL, name = 'Back' WHERE id = $1::uuid`, roleId)).rejects.toThrow(/archived or restored on its own, with no other change/)
    expect(await run(`UPDATE "Role" SET "archivedAt" = NULL, "archivedById" = NULL, version = version + 1 WHERE id = $1::uuid`, roleId)).toBe(1)
    expect(await assign(roleId)).toBe(1)
  })

  it('never gives an archived floor role to a worker', async () => {
    const roleId = await newRole(false, 'FLOOR')
    expect(await archive(roleId)).toBe(1)
    await expect(
      run(`INSERT INTO "WorkerRole" (id, "siteId", "workerId", "roleId", "grantedById") VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid)`, randomUUID(), a.sites[0]!.id, key('worker:A1:operator'), roleId, ownerId()),
    ).rejects.toThrow(/role .* is archived: it is given to nobody \(floor role/)
  })

  it('never deletes a custom role, by any login; a system role may go with its template', async () => {
    await expect(admin(`DELETE FROM "Role" WHERE id = $1::uuid`, [s.archivedRoleId])).rejects.toThrow(/custom role .* is archived, never deleted/)
    const system = await newRole(true)
    await expect(admin(`DELETE FROM "Role" WHERE id = $1::uuid RETURNING id`, [system])).resolves.toEqual([{ id: system }])
  })
})

describe("a session's device and place (PLT-064)", () => {
  const newSession = async (): Promise<string> => {
    const sessionId = randomUUID()
    await run(
      `INSERT INTO "Session" (id, "userId", "tokenHash", "lastSeenAt", "idleExpiresAt", "absoluteExpiresAt") VALUES ($1::uuid, $2::uuid, $3, now(), now() + interval '8 hours', now() + interval '7 days')`,
      sessionId,
      memberId(),
      `test-not-a-token:${sessionId}`,
    )
    return sessionId
  }

  it('sets the device, browser, country and city once, in their shape', async () => {
    const sessionId = await newSession()
    const set = (assignments: string) => run(`UPDATE "Session" SET ${assignments} WHERE id = $1::uuid`, sessionId)
    await expect(set(`"deviceLabel" = '${'x'.repeat(81)}'`)).rejects.toThrow(/names its device and browser in 1 to 80 characters/)
    await expect(set(`"ipCountry" = 'ita'`)).rejects.toThrow(/a country \(two capitals, ISO 3166-1\)/)
    await expect(set(`"ipCity" = 'Seedville'`)).rejects.toThrow(/and, with it, a city/)
    expect(await set(`"deviceLabel" = 'iPhone', browser = 'Safari 18', "ipCountry" = 'IT', "ipCity" = 'Seedville'`)).toBe(1)
    await expect(set(`browser = 'Chrome 131'`)).rejects.toThrow(/device, browser and place of session .* are set once, never changed/)
    await expect(set(`"ipCity" = NULL`)).rejects.toThrow(/set once, never changed/)
    expect(await set(`"revokedAt" = now(), "revokedReason" = 'ENDED_BY_ADMIN'`)).toBe(1)
  })
})

describe('step-up tries (PLT-063)', () => {
  const attempt = (userId: string, sessionId: string, when: string, result: string, fingerprint: string | null = null, action: string | null = null) =>
    run(
      `INSERT INTO "StepUpAttempt" (id, "userId", "sessionId", at, result, action, "codeFingerprint") VALUES ($1::uuid, $2::uuid, $3::uuid, $4::timestamptz, $5::"StepUpResult", $6, $7)`,
      randomUUID(),
      userId,
      sessionId,
      when,
      result,
      action,
      fingerprint,
    )

  it("keep the fingerprint of the code that worked, never the code, once per person; on the person's own session", async () => {
    const owner = s.sessionIds.ownerLaptop
    await expect(attempt(ownerId(), owner, at(12), 'SUCCESS')).rejects.toThrow(/fingerprint of its code exactly when the code worked/)
    await expect(attempt(ownerId(), owner, at(12), 'WRONG_CODE', HASH)).rejects.toThrow(/fingerprint of its code exactly when the code worked/)
    await expect(attempt(ownerId(), owner, at(12), 'SUCCESS', '1'.repeat(40))).rejects.toThrow(/keyed hash of its code .*, never the code/)
    await expect(attempt(ownerId(), owner, at(12), 'WRONG_CODE', null, 'Change bank details')).rejects.toThrow(/names its action by its key/)
    await expect(attempt(ownerId(), s.sessionIds.memberPc, at(12), 'WRONG_CODE')).rejects.toThrow(/on a session of its own person/)
    await expect(attempt(ownerId(), owner, new Date(Date.now() + 3_600_000).toISOString(), 'WRONG_CODE')).rejects.toThrow(/step-up try .* is not in the future/)
    expect(await attempt(ownerId(), owner, at(13), 'SUCCESS', HASH, 'parties.bank.change')).toBe(1)
    await expect(attempt(ownerId(), owner, at(14), 'SUCCESS', HASH, 'parties.bank.change')).rejects.toThrow(/StepUpAttempt_tenantId_userId_codeFingerprint_key|duplicate key/)
  })

  it("lock after the tenant's failures in a row within its lock time; while locked a try is only LOCKED", async () => {
    const member = s.sessionIds.memberPc
    // The seed's five wrong codes at 120-124 minutes: locked until 135.
    await expect(attempt(memberId(), member, at(130), 'WRONG_CODE')).rejects.toThrow(/step-up of person .* is locked until .* \(5 failures in a row\): try .* is recorded as LOCKED/)
    await expect(attempt(memberId(), member, at(130), 'SUCCESS', 'cd'.repeat(32))).rejects.toThrow(/is locked until/)
    expect(await attempt(memberId(), member, at(131), 'LOCKED')).toBe(1)
    // Past the lock time only four of them are within it.
    await expect(attempt(memberId(), member, at(136), 'LOCKED')).rejects.toThrow(/is not locked: try .* LOCKED only while step-up is locked/)
    expect(await attempt(memberId(), member, at(136), 'WRONG_CODE')).toBe(1)
    // A code that worked starts the count again.
    expect(await attempt(memberId(), member, at(137), 'SUCCESS', 'ef'.repeat(32))).toBe(1)
    for (const n of [138, 139, 140, 141]) expect(await attempt(memberId(), member, at(n), 'REUSED_CODE')).toBe(1)
    expect(await attempt(memberId(), member, at(142), 'WRONG_CODE')).toBe(1)
    await expect(attempt(memberId(), member, at(143), 'WRONG_CODE')).rejects.toThrow(/is locked until/)
  })

  it("follow the tenant's settings: three failures lock it", async () => {
    const owner = s.sessionIds.ownerLaptop
    await run(`UPDATE "SecuritySettings" SET "stepUpMaxFailures" = 3 WHERE id = $1::uuid`, s.settingsId)
    try {
      for (const n of [400, 401, 402]) expect(await attempt(ownerId(), owner, at(n), 'WRONG_CODE')).toBe(1)
      await expect(attempt(ownerId(), owner, at(403), 'WRONG_CODE')).rejects.toThrow(/\(3 failures in a row\)/)
    } finally {
      await run(`UPDATE "SecuritySettings" SET "stepUpMaxFailures" = 5 WHERE id = $1::uuid`, s.settingsId)
    }
  })

  it('are append-only for every login', async () => {
    const [first] = s.attemptIds
    await expect(run(`UPDATE "StepUpAttempt" SET action = NULL WHERE id = $1::uuid`, first)).rejects.toThrow(/permission denied/)
    await expect(admin(`UPDATE "StepUpAttempt" SET action = NULL WHERE id = $1::uuid`, [first])).rejects.toThrow(/append-only: UPDATE on "StepUpAttempt" is refused/)
    await expect(admin(`DELETE FROM "StepUpAttempt" WHERE id = $1::uuid`, [first])).rejects.toThrow(/append-only: DELETE on "StepUpAttempt" is refused/)
    await expect(admin(`TRUNCATE "StepUpAttempt"`)).rejects.toThrow(/append-only: TRUNCATE on "StepUpAttempt" is refused/)
  })
})

describe('security events (PLT-075)', () => {
  const insert = (scope: FactoryScope, kind: string, surface: string, columns: Record<string, unknown> = {}) => {
    const row: Record<string, unknown> = { id: randomUUID(), kind, surface, actorId: ownerId(), details: {}, ...columns }
    return runAs(scope, `INSERT INTO "SecurityEvent" SELECT * FROM jsonb_populate_record(NULL::"SecurityEvent", $1::jsonb || jsonb_build_object('tenantId', $2::text, 'at', now()::text))`, JSON.stringify(row), a.tenantId)
  }

  it('name the site of a floor event, the party of a portal or link event, and who unless nobody is known', async () => {
    await expect(insert(office(), 'SIGN_IN_FAILED', 'FLOOR')).rejects.toThrow(/names a site exactly when it came from a floor device/)
    await expect(insert(office(), 'SIGN_IN', 'OFFICE', { siteId: a.sites[0]!.id })).rejects.toThrow(/names a site exactly when/)
    await expect(insert(office(), 'SIGN_IN', 'OFFICE', { partyId: p1 })).rejects.toThrow(/names a party only when it came from a portal or a link/)
    await expect(insert(office(), 'API_KEY_USED', 'OFFICE', { actorId: null })).rejects.toThrow(/the use of an API key .* comes in through the API/)
    await expect(insert(office(), 'SIGN_IN', 'OFFICE', { actorId: null })).rejects.toThrow(/names who; only a failed sign-in or an API key's use may have nobody known/)
    expect(await insert(office(), 'SIGN_IN_FAILED', 'OFFICE', { actorId: null, details: { reason: 'UNKNOWN_ACCOUNT' } })).toBe(1)
    expect(await insert(office(), 'API_KEY_USED', 'API', { actorId: null })).toBe(1)
  })

  it('keep the address as its keyed hash, the record both or neither, the details as codes', async () => {
    await expect(insert(office(), 'SIGN_IN', 'OFFICE', { ipHash: '192.168.0.1' })).rejects.toThrow(/keeps the address as its keyed hash .*, never the address/)
    await expect(insert(office(), 'SIGN_IN', 'OFFICE', { ipCountry: 'Italy' })).rejects.toThrow(/its country as two capitals/)
    await expect(insert(office(), 'ROLE_CHANGED', 'OFFICE', { recordType: 'Role' })).rejects.toThrow(/names its record by its model name \("Role"\) and id, both or neither/)
    await expect(insert(office(), 'ROLE_CHANGED', 'OFFICE', { recordType: 'role', recordId: s.archivedRoleId })).rejects.toThrow(/both or neither/)
    for (const details of [[], { reason: { nested: 'NO' } }, { address: 'someone@example.com' }, { reason: '' }, Object.fromEntries([...Array(21).keys()].map((n) => [`k${n}`, n]))]) {
      await expect(insert(office(), 'SIGN_IN', 'OFFICE', { details })).rejects.toThrow(/the details of security event .* are an object of at most 20 keys/)
    }
    expect(await insert(office(), 'ROLE_CHANGED', 'OFFICE', { recordType: 'Role', recordId: s.archivedRoleId, ipHash: HASH, ipCountry: 'IT', details: { change: 'EDITED', added: ['audit.read'], count: 1, raised: true } })).toBe(1)
  })

  it('are added by each audience in its own scope: a floor device for its site, a portal session for its party', async () => {
    expect(await insert(floorA1(), 'SIGN_IN_FAILED', 'FLOOR', { siteId: a.sites[0]!.id, actorId: null, details: { reason: 'UNKNOWN_BADGE' } })).toBe(1)
    await expect(insert(floorA1(), 'SIGN_IN_FAILED', 'FLOOR', { siteId: a.sites[1]!.id, actorId: null })).rejects.toThrow(/row-level security/)
    expect(await insert(partnerP1(), 'PERMISSION_DENIED', 'PORTAL', { partyId: p1, actorId: partnerUser, details: { permission: 'portal.salesOrders.view' } })).toBe(1)
    await expect(insert(partnerP1(), 'PERMISSION_DENIED', 'PORTAL', { partyId: randomUUID(), actorId: partnerUser })).rejects.toThrow(/row-level security/)
    await expect(as(floorA1(), (client) => client.$queryRawUnsafe(`SELECT id FROM "SecurityEvent" LIMIT 1`))).rejects.toThrow(/permission denied/)
  })

  it('are append-only for every login', async () => {
    const [first] = s.eventIds
    await expect(run(`DELETE FROM "SecurityEvent" WHERE id = $1::uuid`, first)).rejects.toThrow(/permission denied/)
    await expect(admin(`UPDATE "SecurityEvent" SET details = '{}' WHERE id = $1::uuid`, [first])).rejects.toThrow(/append-only: UPDATE on "SecurityEvent" is refused/)
    await expect(admin(`DELETE FROM "SecurityEvent" WHERE id = $1::uuid`, [first])).rejects.toThrow(/append-only: DELETE on "SecurityEvent" is refused/)
    await expect(admin(`TRUNCATE "SecurityEvent"`)).rejects.toThrow(/append-only: TRUNCATE on "SecurityEvent" is refused/)
  })
})

describe('reads of sensitive records (PLT-074; Owner answer question 3 = A)', () => {
  const read = (userId: string, recordType: string, surface = 'OFFICE', when = 'now()') =>
    run(`INSERT INTO "ReadLog" (id, "userId", "recordType", "recordId", action, surface, at) VALUES ($1::uuid, $2::uuid, $3, $4::uuid, 'VIEW', $5::"SecuritySurface", ${when})`, randomUUID(), userId, recordType, randomUUID(), surface)

  it('keep only the sensitive record types of the list, read by an office person in the Office, the API or a job', async () => {
    await expect(read(ownerId(), 'Invoice')).rejects.toThrow(/names a record type that is not a sensitive one of the list \(Invoice\)/)
    await expect(read(ownerId(), 'Worker', 'FLOOR')).rejects.toThrow(/is an office person's: in the Office, through the API or sent by a job, never FLOOR/)
    await expect(read(partnerUser, 'Certificate')).rejects.toThrow(/is an office person's; person .* is a PARTNER person/)
    await expect(read(ownerId(), 'Employee', 'OFFICE', `now() + interval '1 hour'`)).rejects.toThrow(/read .* is not in the future/)
    for (const recordType of ['CostSheet', 'Employee', 'PartyContact', 'MeasurementProfile', 'TrainingRecord', 'PayrollExport']) expect(await read(ownerId(), recordType)).toBe(1)
    expect(await read(memberId(), 'ExportJob', 'SYSTEM')).toBe(1)
  })

  it('are append-only for every login', async () => {
    const [first] = s.readIds
    await expect(run(`UPDATE "ReadLog" SET action = 'EXPORT' WHERE id = $1::uuid`, first)).rejects.toThrow(/permission denied/)
    await expect(admin(`UPDATE "ReadLog" SET action = 'EXPORT' WHERE id = $1::uuid`, [first])).rejects.toThrow(/append-only: UPDATE on "ReadLog" is refused/)
    await expect(admin(`DELETE FROM "ReadLog" WHERE id = $1::uuid`, [first])).rejects.toThrow(/append-only: DELETE on "ReadLog" is refused/)
    await expect(admin(`TRUNCATE "ReadLog"`)).rejects.toThrow(/append-only: TRUNCATE on "ReadLog" is refused/)
  })
})
