import { createHash, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedFiles } from '../seed/files'
import { seed as seedFloorAuth } from '../seed/floor-auth'
import { seed as seedIntegration } from '../seed/integration'
import { seed as seedParties } from '../seed/parties'
import { cutoffDay, seed as seedPrivacyOps, type PrivacyOpsSeed } from '../seed/privacy-ops'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'

/**
 * Privacy duties and what fails at the edges (W2b-6, schema wave 53/57, B-W2b-375, …_privacy_integration_w2b_guards) on a
 * database built from the migrations and seeded twice, through the real login and its scopes:
 *   - data requests: the person by the record of their kind, of the request's company; due 30 days (720 hours) after
 *     receipt, extended once with the reason; the identity check once; RECEIVED → IN_PROGRESS → DONE | REFUSED | WITHDRAWN,
 *     then frozen; DONE with the identity checked, an access request with its package, an erasure with its records; never
 *     deleted;
 *   - erasure records: of an erasure request in progress or an applying sweep, columns of the record's table (names only),
 *     what stays with why; append-only;
 *   - retention rules (GATE-PRIVACY: only report until switched on) and their sweeps: a REPORT applies nothing, an APPLY
 *     only on a rule switched on; the cut-off from the business day; finished once; never deleted;
 *   - the error queue: of a source row that failed, born OPEN, RETRIED and open again with one more try, DISMISSED with a
 *     reason; deleted only closed and 30 days after;
 *   - job runs: one per tick (the key), finished once, the error exactly when FAILED; deleted only 7 days after;
 *   - the outside doors of safety reports, per company, only with its SAFETY_REPORT notice published;
 *   - a view of a safety report's injury (PRODUCT_SAFETY_INJURY) names no employee; the read log takes DataRequest.
 * The refusals are check_violation (23514) in words, the unique key's 23505, or the grants' permission denied.
 */

const NS = 'w2b-375-a'

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let s: PrivacyOpsSeed

const key = (name: string): string => seedUuid(NS, name)
const A = {
  companyA: key('company:A'),
  companyB: key('company:B'),
  workerA1: key('worker:A1:operator'),
  workerB1: key('worker:B1:operator'),
  member: key('user:member'),
  store: key('files:account:r2'),
  sdiCall: key('integration:call:refused'),
  okCall: key('integration:call:ok'),
  rejected: key('integration:inbound:rejected'),
  received: key('integration:inbound:received'),
}
const office = (): FactoryScope => ({ audience: 'office', tenantId: a.tenantId, actorId: a.actorId })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const run = (text: string, ...values: unknown[]) => as(office(), (client) => client.$executeRawUnsafe(text, ...values))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, unknown>[]
const insertSql = (table: string, row: Record<string, unknown>): [string, string] => {
  const columns = Object.keys(row)
    .map((column) => `"${column}"`)
    .join(', ')
  return [`INSERT INTO "${table}" (${columns}) SELECT ${columns} FROM jsonb_populate_record(NULL::"${table}", $1::jsonb)`, JSON.stringify(row)]
}
const insert = (table: string, row: Record<string, unknown>) => run(...insertSql(table, row))
/** Runs `work` as the owner login with every trigger off for its own transaction (fixtures of other waves only). */
async function asReplica(work: () => Promise<unknown>): Promise<void> {
  await db.admin.query('BEGIN')
  try {
    await db.admin.query("SET LOCAL session_replication_role = 'replica'")
    await work()
    await db.admin.query('COMMIT')
  } catch (error) {
    await db.admin.query('ROLLBACK')
    throw error
  }
}
const HOUR = 3_600_000
const ago = (hours: number): string => new Date(Date.now() - hours * HOUR).toISOString()
const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

/** A RECEIVED access request of worker A1-1 at company A, received `hours` ago (and its row's extra columns). */
async function request(extra: Record<string, unknown> = {}, hours = 48): Promise<string> {
  const id = randomUUID()
  const receivedAt = extra.receivedAt ? String(extra.receivedAt) : ago(hours)
  const row = {
    id,
    companyId: A.companyA,
    personKind: 'WORKER',
    personRecordType: 'Worker',
    personRecordId: A.workerA1,
    kind: 'ACCESS',
    receivedAt,
    dueAt: new Date(Date.parse(receivedAt) + 720 * HOUR).toISOString(),
    ...extra,
  }
  expect(await insert('DataRequest', row)).toBe(1)
  return id
}
const setRequest = (id: string, assignments: string, ...values: unknown[]) => run(`UPDATE "DataRequest" SET ${assignments} WHERE id = $1::uuid`, id, ...values)
const checkIdentity = (id: string) => setRequest(id, `"identityCheckedAt" = now(), "identityCheckedById" = $2::uuid`, a.actorId)
/** An AVAILABLE file of a record (the package of an access request). */
async function file(recordType: string, recordId: string, status = 'AVAILABLE'): Promise<string> {
  const id = randomUUID()
  await insert('StoredFile', {
    id,
    companyId: A.companyA,
    recordType,
    recordId,
    kind: 'DOCUMENT',
    originalName: 'Test access copy.pdf',
    contentType: 'application/pdf',
    sizeBytes: 1024,
    sha256: sha(id),
    storeAccountId: A.store,
    storageKey: `t/${a.tenantId}/c/${A.companyA}/2026/${randomUUID()}`,
    status,
    ...(status === 'AVAILABLE' ? { availableAt: new Date().toISOString() } : {}),
  })
  return id
}
/** A retention rule (company A's own unless `companyId` is given) of a record type, that only reports. */
async function rule(recordType: string, extra: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID()
  const companyId = 'companyId' in extra ? (extra.companyId as string | null) : A.companyA
  expect(
    await insert('RetentionRule', {
      id,
      companyId,
      key: `retention:${recordType}:${companyId ?? 'all'}`,
      recordType,
      keepMonths: 12,
      thenAction: 'DELETE',
      legalReason: 'A made-up period for a test.',
      ...extra,
    }),
  ).toBe(1)
  return id
}
const switchOn = (ruleId: string) => run(`UPDATE "RetentionRule" SET "applyOn" = true, "applyOnAt" = now(), "applyOnById" = $2::uuid WHERE id = $1::uuid`, ruleId, a.actorId)
/** A RUNNING sweep of a rule (its period and action given as the rule's), started now. */
async function sweep(ruleId: string, mode: 'REPORT' | 'APPLY', months = 12, action = 'DELETE', extra: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID()
  const startedAt = new Date()
  expect(
    await insert('RetentionSweep', {
      id,
      ruleId,
      mode,
      keepMonths: months,
      thenAction: action,
      cutoffOn: cutoffDay(startedAt, months).toISOString().slice(0, 10),
      startedAt: startedAt.toISOString(),
      ...extra,
    }),
  ).toBe(1)
  return id
}
const erasure = (row: Record<string, unknown>) =>
  insert('ErasureRecord', { id: randomUUID(), companyId: A.companyA, recordType: 'PartyContact', recordId: s.formerContactId, method: 'ANONYMISED', erasedFields: ['name'], erasedById: a.actorId, ...row })

beforeAll(async () => {
  db = await migratedDatabase('privacyopsw2b')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: NS })
  await seedFloorAuth({ db: factory, namespace: NS })
  await seedParties({ db: factory, namespace: NS })
  await seedFiles({ db: factory, namespace: NS })
  await seedIntegration({ db: factory, namespace: NS })
  s = await seedPrivacyOps({ db: factory, namespace: NS })
  // Run twice: every seed is idempotent.
  await seedPrivacyOps({ db: factory, namespace: NS })
}, 300_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

describe('the seed', () => {
  it('runs twice and leaves one of each row; nothing is switched on, nothing applied', async () => {
    const counts = await admin(
      `SELECT (SELECT count(*)::int FROM "DataRequest" WHERE "tenantId" = $1::uuid) AS requests,
              (SELECT count(*)::int FROM "ErasureRecord" WHERE "tenantId" = $1::uuid) AS erasures,
              (SELECT count(*)::int FROM "RetentionRule" WHERE "tenantId" = $1::uuid) AS rules,
              (SELECT count(*)::int FROM "RetentionRule" WHERE "tenantId" = $1::uuid AND "applyOn") AS "rulesOn",
              (SELECT count(*)::int FROM "RetentionSweep" WHERE "tenantId" = $1::uuid) AS sweeps,
              (SELECT count(*)::int FROM "RetentionSweep" WHERE "tenantId" = $1::uuid AND mode = 'APPLY') AS applied,
              (SELECT count(*)::int FROM "IntegrationErrorItem" WHERE "tenantId" = $1::uuid) AS errors,
              (SELECT count(*)::int FROM "CronRun" WHERE "tenantId" = $1::uuid) AS runs`,
      [a.tenantId],
    )
    expect(counts[0]).toEqual({ requests: 5, erasures: 1, rules: 6, rulesOn: 0, sweeps: 3, applied: 0, errors: 4, runs: 4 })
    const states = await admin(`SELECT status::text FROM "DataRequest" WHERE "tenantId" = $1::uuid ORDER BY id`, [a.tenantId])
    expect(states.map((row) => row.status).sort()).toEqual(['DONE', 'IN_PROGRESS', 'IN_PROGRESS', 'RECEIVED', 'REFUSED'])
  })
})

describe('data requests (PLT-202, PLT-203)', () => {
  it('name the person by the record of their kind, of the request\'s company, that exists', async () => {
    await expect(request({ personKind: 'USER' })).rejects.toThrow(/names the person by the record of their kind/)
    await expect(request({ personRecordId: randomUUID() })).rejects.toThrow(/names a Worker .* that does not exist/)
    await expect(request({ personRecordId: A.workerB1 })).rejects.toThrow(/is made to the company of the person's Worker/)
    await expect(request({ personKind: 'REPORTER', personRecordType: 'ProductSafetyReport', personRecordId: randomUUID() })).rejects.toThrow(/does not exist/)
    expect(await request({ personKind: 'CONTACT', personRecordType: 'PartyContact', personRecordId: s.formerContactId, kind: 'ERASURE' })).toBeTruthy()
    expect(await request({ personKind: 'USER', personRecordType: 'User', personRecordId: A.member, kind: 'CORRECTION' })).toBeTruthy()
  })

  it('come in RECEIVED, never in the future, due exactly 30 days (720 hours) later', async () => {
    await expect(request({ status: 'IN_PROGRESS' })).rejects.toThrow(/is recorded as it comes in \(RECEIVED\)/)
    const future = new Date(Date.now() + 2 * HOUR).toISOString()
    await expect(request({ receivedAt: future })).rejects.toThrow(/did not come in in the future/)
    const receivedAt = ago(5)
    await expect(request({ receivedAt, dueAt: new Date(Date.parse(receivedAt) + 30 * 24 * HOUR + 1000).toISOString() })).rejects.toThrow(/due 30 days after it came in \(GDPR art\. 12\(3\)\)/)
  })

  it('are extended once, by up to two further months, with the reason; then the extension never changes', async () => {
    const id = await request({}, 24)
    const received = Date.parse(String((await admin(`SELECT "receivedAt" FROM "DataRequest" WHERE id = $1`, [id]))[0]!.receivedAt))
    const at = (hours: number) => new Date(received + hours * HOUR).toISOString()
    await expect(setRequest(id, `"extendedDueAt" = $2::timestamptz`, at(1000))).rejects.toThrow(/extended once by up to two further months/)
    await expect(setRequest(id, `"extendedDueAt" = $2::timestamptz, "extensionReason" = 'Many records.'`, at(720))).rejects.toThrow(/after its due time/)
    await expect(setRequest(id, `"extendedDueAt" = $2::timestamptz, "extensionReason" = 'Many records.'`, at(2161))).rejects.toThrow(/at most 90 days after it came in/)
    await expect(setRequest(id, `"extendedDueAt" = $2::timestamptz, "extensionReason" = 'no'`, at(1500))).rejects.toThrow(/with the reason \(3 to 1000 characters\)/)
    expect(await setRequest(id, `"extendedDueAt" = $2::timestamptz, "extensionReason" = 'Records of three companies to collect.'`, at(2160))).toBe(1)
    await expect(setRequest(id, `"extendedDueAt" = $2::timestamptz`, at(2000))).rejects.toThrow(/was extended once; the extension never changes/)
    await expect(setRequest(id, `"dueAt" = "dueAt" + interval '1 day'`)).rejects.toThrow(/the clock of data request .* never change/)
  })

  it('record the identity check once, and move RECEIVED → IN_PROGRESS → DONE, or to REFUSED or WITHDRAWN while open', async () => {
    const id = await request()
    await expect(setRequest(id, `"identityCheckedAt" = now()`)).rejects.toThrow(/has when and by whom, both or neither/)
    expect(await checkIdentity(id)).toBe(1)
    await expect(setRequest(id, `"identityCheckedById" = $2::uuid`, A.member)).rejects.toThrow(/identity check .* is recorded once, never changed/)
    await expect(setRequest(id, `status = 'DONE', "decidedAt" = now(), "decidedById" = $2::uuid`, a.actorId)).rejects.toThrow(/moves RECEIVED → IN_PROGRESS → DONE/)
    expect(await setRequest(id, `status = 'IN_PROGRESS'`)).toBe(1)
    await expect(setRequest(id, `status = 'RECEIVED'`)).rejects.toThrow(/not IN_PROGRESS → RECEIVED/)
    await expect(setRequest(id, `status = 'WITHDRAWN'`)).rejects.toThrow(/names when and by whom it was closed exactly once/)
    expect(await setRequest(id, `status = 'WITHDRAWN', "decidedAt" = now(), "decidedById" = $2::uuid`, a.actorId)).toBe(1)
    await expect(setRequest(id, `note = 'later'`)).rejects.toThrow(/is closed \(WITHDRAWN\): it changes no more/)
  })

  it('are refused with the reason (GDPR art. 12(4)), straight from RECEIVED too', async () => {
    const id = await request()
    await expect(setRequest(id, `status = 'REFUSED', "decidedAt" = now(), "decidedById" = $2::uuid`, a.actorId)).rejects.toThrow(/names why it was refused .* exactly when REFUSED/)
    await expect(setRequest(id, `"refusalReason" = 'Not yet.'`)).rejects.toThrow(/exactly when REFUSED/)
    expect(await setRequest(id, `status = 'REFUSED', "decidedAt" = now(), "decidedById" = $2::uuid, "refusalReason" = 'The identity could not be checked.'`, a.actorId)).toBe(1)
  })

  it('are done with the identity checked and, for an access request, the package: an available file of the request', async () => {
    const id = await request()
    expect(await setRequest(id, `status = 'IN_PROGRESS'`)).toBe(1)
    const done = () => setRequest(id, `status = 'DONE', "decidedAt" = now(), "decidedById" = $2::uuid`, a.actorId)
    await expect(done()).rejects.toThrow(/done only once the person's identity was checked \(GDPR art\. 12\(6\)\)/)
    expect(await checkIdentity(id)).toBe(1)
    await expect(done()).rejects.toThrow(/access request .* is done with the package handed over/)
    const other = await file('DataRequest', randomUUID())
    await expect(setRequest(id, `"packageFileId" = $2::uuid`, other)).rejects.toThrow(/is an available file of the request/)
    const pending = await file('DataRequest', id, 'PENDING_UPLOAD')
    await expect(setRequest(id, `"packageFileId" = $2::uuid`, pending)).rejects.toThrow(/is an available file of the request/)
    const own = await file('DataRequest', id)
    expect(await setRequest(id, `"packageFileId" = $2::uuid`, own)).toBe(1)
    expect(await done()).toBe(1)
    // Only an access request has a package.
    const erasureRequest = await request({ kind: 'ERASURE' })
    await expect(setRequest(erasureRequest, `"packageFileId" = $2::uuid`, await file('DataRequest', erasureRequest))).rejects.toThrow(/only an access request has a package/)
  })

  it('of erasure are done once each record looked at is recorded', async () => {
    const id = await request({ personKind: 'CONTACT', personRecordType: 'PartyContact', personRecordId: s.formerContactId, kind: 'ERASURE' })
    expect(await setRequest(id, `status = 'IN_PROGRESS', "identityCheckedAt" = now(), "identityCheckedById" = $2::uuid`, a.actorId)).toBe(1)
    const done = () => setRequest(id, `status = 'DONE', "decidedAt" = now(), "decidedById" = $2::uuid`, a.actorId)
    await expect(done()).rejects.toThrow(/erasure request .* is done once each record looked at is recorded/)
    expect(await erasure({ dataRequestId: id, method: 'KEPT', erasedFields: [], keptFields: ['partyId'], keptWhy: 'The quotes that named the contact keep their own copies.' })).toBe(1)
    expect(await done()).toBe(1)
    // Closed: no further erasure is recorded for it.
    await expect(erasure({ dataRequestId: id })).rejects.toThrow(/is done for an erasure request of its company that is in progress/)
  })

  it('are never deleted or truncated, by any login', async () => {
    await expect(run(`DELETE FROM "DataRequest" WHERE id = $1::uuid`, s.requestIds.workerAccess)).rejects.toThrow(/permission denied/)
    await expect(admin(`DELETE FROM "DataRequest" WHERE id = $1::uuid`, [s.requestIds.workerAccess])).rejects.toThrow(/is kept, never deleted/)
    await expect(admin(`TRUNCATE "DataRequest" CASCADE`)).rejects.toThrow(/TRUNCATE on "(DataRequest|ErasureRecord)" is refused/)
  })
})

describe('erasure records (PLT-203)', () => {
  it('are done for exactly one erasure request in progress of the company, by an office person', async () => {
    const R = s.requestIds
    await expect(erasure({})).rejects.toThrow(/exactly one erasure request or one sweep/)
    await expect(erasure({ dataRequestId: R.memberAccess })).rejects.toThrow(/is done for an erasure request of its company that is in progress \(request .* is a ACCESS request, DONE/)
    await expect(erasure({ dataRequestId: R.contactErasure, erasedById: null })).rejects.toThrow(/names the office person who did it/)
    await expect(erasure({ dataRequestId: R.contactErasure, companyId: A.companyB })).rejects.toThrow(/of company/)
  })

  it('name columns of the record\'s table only (never values), each once, never both erased and kept, and why something stays', async () => {
    const id = s.requestIds.contactErasure
    await expect(erasure({ dataRequestId: id, erasedFields: ['Anna Bianchi'] })).rejects.toThrow(/names columns of the PartyContact table only/)
    await expect(erasure({ dataRequestId: id, erasedFields: ['name', 'name'] })).rejects.toThrow(/each once/)
    await expect(erasure({ dataRequestId: id, erasedFields: ['id'] })).rejects.toThrow(/never its id or tenant/)
    await expect(erasure({ dataRequestId: id, recordType: 'NoSuchTable' })).rejects.toThrow(/by a table of the database/)
    await expect(erasure({ dataRequestId: id, keptFields: ['name'], keptWhy: 'The law keeps it.' })).rejects.toThrow(/never names a column both erased and kept/)
    await expect(erasure({ dataRequestId: id, erasedFields: [] })).rejects.toThrow(/names the columns it erased when ANONYMISED \(at least one\)/)
    await expect(erasure({ dataRequestId: id, method: 'DELETED', keptFields: ['phone'], keptWhy: 'Kept.' , erasedFields: [] })).rejects.toThrow(/DELETED \(which keeps none\)/)
    await expect(erasure({ dataRequestId: id, method: 'KEPT', erasedFields: [] })).rejects.toThrow(/says why something stays .* exactly when a column or the record is kept/)
    await expect(erasure({ dataRequestId: id, keptWhy: 'Nothing is kept.' })).rejects.toThrow(/exactly when a column or the record is kept/)
    expect(await erasure({ dataRequestId: id, erasedFields: ['email'], keptFields: ['language'], keptWhy: 'The language of documents already sent stays with them.' })).toBe(1)
  })

  it('are append-only for every login', async () => {
    const first = s.erasureIds[0]!
    await expect(run(`UPDATE "ErasureRecord" SET "keptWhy" = 'x' WHERE id = $1::uuid`, first)).rejects.toThrow(/permission denied/)
    await expect(run(`DELETE FROM "ErasureRecord" WHERE id = $1::uuid`, first)).rejects.toThrow(/permission denied/)
    await expect(admin(`UPDATE "ErasureRecord" SET "keptWhy" = 'x' WHERE id = $1::uuid`, [first])).rejects.toThrow(/append-only: UPDATE on "ErasureRecord" is refused/)
    await expect(admin(`DELETE FROM "ErasureRecord" WHERE id = $1::uuid`, [first])).rejects.toThrow(/append-only: DELETE on "ErasureRecord" is refused/)
    await expect(admin(`TRUNCATE "ErasureRecord"`)).rejects.toThrow(/append-only: TRUNCATE on "ErasureRecord" is refused/)
  })
})

describe('retention rules and sweeps (PLT-204; GATE-PRIVACY)', () => {
  it('keep a record type that is a table, by its key, 1 to 1200 months, for a legal reason; never deleted', async () => {
    await expect(rule('NoSuchTable')).rejects.toThrow(/for a record type that is a table of the database/)
    await expect(rule('Message', { key: 'retention:Message:other' })).rejects.toThrow(/retention:<record type>:<company or all>/)
    await expect(rule('Message', { keepMonths: 0 })).rejects.toThrow(/1 to 1200 months/)
    await expect(rule('Message', { legalReason: 'x' })).rejects.toThrow(/legal reason in 3 to 1000 characters/)
    const id = await rule('Message')
    // Each record type once per company and once for every company (the key).
    await expect(rule('Message')).rejects.toThrow(/RetentionRule_tenantId_key_key|Unique constraint/)
    expect(await rule('Message', { companyId: null })).toBeTruthy()
    await expect(run(`UPDATE "RetentionRule" SET "recordType" = 'Thread' WHERE id = $1::uuid`, id)).rejects.toThrow(/record type and the creation of retention rule .* never change/)
    await expect(run(`DELETE FROM "RetentionRule" WHERE id = $1::uuid`, id)).rejects.toThrow(/permission denied/)
    await expect(admin(`DELETE FROM "RetentionRule" WHERE id = $1::uuid`, [id])).rejects.toThrow(/is kept, never deleted/)
  })

  it('are switched on by a person, only while active; until then a sweep only reports', async () => {
    const id = await rule('AuditLog', { companyId: null })
    await expect(sweep(id, 'APPLY')).rejects.toThrow(/only reports until a person switches it on \(GATE-PRIVACY\)/)
    await expect(run(`UPDATE "RetentionRule" SET "applyOn" = true WHERE id = $1::uuid`, id)).rejects.toThrow(/when and by whom it was switched on exactly while it is on/)
    expect(await switchOn(id)).toBe(1)
    await expect(run(`UPDATE "RetentionRule" SET "applyOnById" = $2::uuid WHERE id = $1::uuid`, id, A.member)).rejects.toThrow(/that stays while it is on/)
    await expect(run(`UPDATE "RetentionRule" SET active = false WHERE id = $1::uuid`, id)).rejects.toThrow(/switched off, so it is not applied either/)
    expect(await sweep(id, 'APPLY')).toBeTruthy()
    expect(await run(`UPDATE "RetentionRule" SET active = false, "applyOn" = false, "applyOnAt" = NULL, "applyOnById" = NULL WHERE id = $1::uuid`, id)).toBe(1)
    await expect(sweep(id, 'REPORT')).rejects.toThrow(/is switched off: it is not swept/)
  })

  it('sweep with the rule\'s period and the cut-off of its business day, count, finish once, never delete', async () => {
    const id = await rule('Thread', { keepMonths: 6, thenAction: 'ANONYMISE' })
    await expect(sweep(id, 'REPORT', 12, 'ANONYMISE')).rejects.toThrow(/keeps the period and the action of its rule as they stand \(6 months, then ANONYMISE\)/)
    await expect(sweep(id, 'REPORT', 6, 'ANONYMISE', { cutoffOn: '2001-01-01' })).rejects.toThrow(/is the business day it started on less its 6 months/)
    await expect(sweep(id, 'REPORT', 6, 'ANONYMISE', { dueCount: 1, appliedCount: 1 })).rejects.toThrow(/only reports: it applies nothing/)
    await expect(sweep(id, 'REPORT', 6, 'ANONYMISE', { dueCount: 1, heldCount: 2 })).rejects.toThrow(/at most what was due/)
    await expect(sweep(id, 'REPORT', 6, 'ANONYMISE', { failures: [{ code: 'x', value: 'Anna' }] })).rejects.toThrow(/a list of at most 100 codes/)
    const sweepId = await sweep(id, 'REPORT', 6, 'ANONYMISE', { dueCount: 4 })
    const set = (assignments: string) => run(`UPDATE "RetentionSweep" SET ${assignments} WHERE id = $1::uuid`, sweepId)
    await expect(set(`"dueCount" = 3`)).rejects.toThrow(/never go down/)
    await expect(set(`status = 'DONE'`)).rejects.toThrow(/names when it finished exactly once it is DONE or FAILED/)
    await expect(set(`status = 'FAILED', "finishedAt" = now()`)).rejects.toThrow(/at least one when it FAILED/)
    expect(await set(`"heldCount" = 1, status = 'DONE', "finishedAt" = now()`)).toBe(1)
    await expect(set(`"failedCount" = 1`)).rejects.toThrow(/is finished \(DONE\): it changes no more/)
    await expect(admin(`DELETE FROM "RetentionSweep" WHERE id = $1::uuid`, [sweepId])).rejects.toThrow(/is kept, never deleted/)
    // A month end is clamped: 31 March less a month is 28 February (in Europe/Rome's calendar).
    expect(cutoffDay(new Date('2026-03-31T10:00:00Z'), 1).toISOString().slice(0, 10)).toBe('2026-02-28')
    expect(cutoffDay(new Date('2026-03-31T23:30:00Z'), 1).toISOString().slice(0, 10)).toBe('2026-03-01')
    const [pg] = await admin(`SELECT ("factory_money_rome_day"('2026-03-31T10:00:00Z'::timestamptz) - make_interval(months => 1))::date::text AS day`)
    expect(pg).toEqual({ day: '2026-02-28' })
  })

  it('erase through an applying sweep only what its rule says, of its record type and company', async () => {
    const id = await rule('PartyContact', { thenAction: 'ANONYMISE', companyId: null })
    const report = await sweep(id, 'REPORT', 12, 'ANONYMISE')
    await expect(erasure({ sweepId: report, erasedById: null })).rejects.toThrow(/by a sweep that applies its rule and is running/)
    expect(await switchOn(id)).toBe(1)
    const apply = await sweep(id, 'APPLY', 12, 'ANONYMISE')
    await expect(erasure({ sweepId: apply, erasedById: null, method: 'DELETED', erasedFields: [] })).rejects.toThrow(/does what its sweep's rule says \(ANONYMISE: the record DELETED\)/)
    await expect(erasure({ sweepId: apply, erasedById: null, recordType: 'User', recordId: A.member, erasedFields: ['displayName'] })).rejects.toThrow(/is of a record of its sweep's rule/)
    expect(await erasure({ sweepId: apply, erasedById: null, erasedFields: ['phone'] })).toBe(1)
    expect(await run(`UPDATE "RetentionSweep" SET "dueCount" = 1, "appliedCount" = 1, status = 'DONE', "finishedAt" = now() WHERE id = $1::uuid`, apply)).toBe(1)
    await expect(erasure({ sweepId: apply, erasedById: null, erasedFields: ['email'] })).rejects.toThrow(/is a APPLY, DONE/)
  })
})

describe('the error queue (PLT-201)', () => {
  const item = (row: Record<string, unknown>) => {
    const id = randomUUID()
    const failedAt = ago(1)
    return insert('IntegrationErrorItem', {
      id,
      companyId: A.companyA,
      key: `call:${A.sdiCall}-${id.slice(0, 8)}`,
      source: 'CALL',
      sourceId: A.sdiCall,
      provider: 'SDI',
      operation: 'sdi.send_invoice',
      reasonCode: 'account_paused',
      firstFailedAt: failedAt,
      lastFailedAt: failedAt,
      ...row,
    }).then((n) => (n === 1 ? id : ''))
  }

  it('is born OPEN, of a source row of this tenant that failed, with its service, operation and company', async () => {
    await expect(item({ sourceId: A.okCall, key: `call:${A.okCall}`, provider: 'SES', operation: 'mail.send', companyId: null })).rejects.toThrow(/of a CALL that failed \(it is SUCCEEDED\)/)
    await expect(item({ sourceId: randomUUID() })).rejects.toThrow(/names a CALL row .* that does not exist/)
    await expect(item({ provider: 'SES' })).rejects.toThrow(/names the service of its CALL \(SDI\)/)
    await expect(item({ operation: 'sdi.receive' })).rejects.toThrow(/for a call, its operation \(sdi\.send_invoice\)/)
    await expect(item({ companyId: A.companyB })).rejects.toThrow(/is of the company of its CALL/)
    await expect(item({ source: 'WEBHOOK', sourceId: A.received, key: `webhook:${A.received}` })).rejects.toThrow(/of a WEBHOOK that failed \(it is RECEIVED\)/)
    await expect(item({ key: 'call:something-else' })).rejects.toThrow(/<outbox, webhook or call>:<its source row>/)
    await expect(item({ state: 'RETRIED', retriedAt: ago(0.5), retriedById: a.actorId })).rejects.toThrow(/is born OPEN, never retried yet/)
    await expect(item({ reasonCode: 'not a code' })).rejects.toThrow(/says why as a code/)
    await expect(item({ recordType: 'Invoice' })).rejects.toThrow(/names its record by a table of the database and its id, both or neither/)
    expect(await item({ source: 'WEBHOOK', sourceId: A.rejected, key: `webhook:${A.rejected}-x`, operation: 'webhook.process', reasonCode: 'signature_mismatch' })).toBeTruthy()
    // One item per source row: the seed's key is taken.
    await expect(item({ key: `call:${A.sdiCall}` })).rejects.toThrow(/IntegrationErrorItem_tenantId_key_key|Unique constraint/)
  })

  it('is retried, open again with one more try when the retry failed, dismissed with a reason, then frozen', async () => {
    const id = await item({})
    const set = (assignments: string, ...values: unknown[]) => run(`UPDATE "IntegrationErrorItem" SET ${assignments} WHERE id = $1::uuid`, id, ...values)
    await expect(set(`state = 'RETRIED'`)).rejects.toThrow(/is sent again after its latest failure, with when and by whom/)
    await expect(set(`"retriedAt" = now(), "retriedById" = $2::uuid`, a.actorId)).rejects.toThrow(/a retry of failed message .* marks it RETRIED/)
    expect(await set(`state = 'RETRIED', "retriedAt" = now(), "retriedById" = $2::uuid`, a.actorId)).toBe(1)
    await expect(set(`state = 'OPEN'`)).rejects.toThrow(/is open again only when its retry failed too/)
    await expect(set(`"retriedAt" = now() + interval '1 second'`)).rejects.toThrow(/fails again \(back to OPEN\) or is dismissed before another retry/)
    expect(await set(`state = 'OPEN', tries = 2, "lastFailedAt" = now(), "reasonCode" = 'timeout'`)).toBe(1)
    await expect(set(`tries = 1`)).rejects.toThrow(/never go down/)
    await expect(set(`operation = 'sdi.other'`)).rejects.toThrow(/what failed, its record and its first failure .* never change/)
    await expect(set(`state = 'DISMISSED', "dismissedAt" = now(), "dismissedById" = $2::uuid`, a.actorId)).rejects.toThrow(/with when, by whom and why \(3 to 500 characters\)/)
    expect(await set(`state = 'DISMISSED', "dismissedAt" = now(), "dismissedById" = $2::uuid, "dismissReason" = 'Sent by hand through the SDI portal.'`, a.actorId)).toBe(1)
    await expect(set(`"dismissReason" = 'Other words.'`)).rejects.toThrow(/was dismissed: it changes no more/)
  })

  it('is deleted only once closed, 30 days after it closed; never truncated', async () => {
    const open = s.errorIds.sdiRefused
    await expect(run(`DELETE FROM "IntegrationErrorItem" WHERE id = $1::uuid`, open)).rejects.toThrow(/an open one is never deleted, a closed one only 30 days after it closed/)
    // The seed's dismissal is recent: kept.
    await expect(run(`DELETE FROM "IntegrationErrorItem" WHERE id = $1::uuid`, s.errorIds.webhookRejected)).rejects.toThrow(/only 30 days after it closed/)
    const old = await item({ firstFailedAt: ago(40 * 24), lastFailedAt: ago(40 * 24) })
    expect(await run(`UPDATE "IntegrationErrorItem" SET state = 'DISMISSED', "dismissedAt" = $2::timestamptz, "dismissedById" = $3::uuid, "dismissReason" = 'Old.' WHERE id = $1::uuid`, old, ago(31 * 24), a.actorId)).toBe(1)
    expect(await run(`DELETE FROM "IntegrationErrorItem" WHERE id = $1::uuid`, old)).toBe(1)
    await expect(admin(`TRUNCATE "IntegrationErrorItem"`)).rejects.toThrow(/TRUNCATE on "IntegrationErrorItem" is refused/)
  })
})

describe('job runs (PLT-221)', () => {
  const tickRow = (jobKey: string, scheduledAt: Date, extra: Record<string, unknown> = {}) => ({
    id: randomUUID(),
    jobKey,
    trigger: 'SCHEDULE',
    key: `${jobKey}@${Math.floor(scheduledAt.getTime() / 1000)}`,
    scheduledAt: scheduledAt.toISOString(),
    startedAt: scheduledAt.toISOString(),
    ranOn: 'test-scheduler (pid 1)',
    ...extra,
  })

  it('are one per tick and tenant, by a key the tick makes; a run a person asked for names them', async () => {
    const at = new Date(Math.floor(Date.now() / 60_000) * 60_000 - 10 * 60_000)
    await expect(insert('CronRun', tickRow('nodots', at))).rejects.toThrow(/by its cron name/)
    await expect(insert('CronRun', tickRow('test.job', at, { key: 'test.job@1' }))).rejects.toThrow(/<job>@<the tick's epoch seconds>/)
    expect(await insert('CronRun', tickRow('test.job', at))).toBe(1)
    // A second replica recording the same tick: the unique key.
    await expect(insert('CronRun', tickRow('test.job', at))).rejects.toThrow(/CronRun_tenantId_key_key|Unique constraint/)
    await expect(insert('CronRun', tickRow('test.job', at, { trigger: 'RUN_NOW', key: `test.job@now:${randomUUID()}` }))).rejects.toThrow(/names who asked for it exactly when a person asked/)
    await expect(insert('CronRun', tickRow('test.job', at, { trigger: 'RUN_NOW', key: 'test.job@now:', requestedById: a.actorId }))).rejects.toThrow(/<job>@now:<request>/)
    expect(await insert('CronRun', tickRow('test.job', at, { trigger: 'RUN_NOW', key: `test.job@now:${randomUUID()}`, requestedById: a.actorId }))).toBe(1)
    await expect(insert('CronRun', tickRow('test.job', new Date(Date.now() + 3_600_000)))).rejects.toThrow(/was not due nor started in the future/)
  })

  it('finish once, the error exactly when FAILED, then stay as they are', async () => {
    const row = tickRow('test.finish', new Date(Math.floor(Date.now() / 60_000) * 60_000 - 5 * 60_000))
    expect(await insert('CronRun', row)).toBe(1)
    const set = (assignments: string) => run(`UPDATE "CronRun" SET ${assignments} WHERE id = $1::uuid`, row.id)
    await expect(set(`status = 'FAILED', "finishedAt" = now()`)).rejects.toThrow(/keeps its error .* exactly when it FAILED/)
    await expect(set(`status = 'SUCCEEDED'`)).rejects.toThrow(/names when it finished exactly once/)
    await expect(set(`"ranOn" = 'another replica'`)).rejects.toThrow(/the replica of run .* never change/)
    expect(await set(`status = 'FAILED', "finishedAt" = now(), error = 'The database did not answer.'`)).toBe(1)
    await expect(set(`error = 'Other words.'`)).rejects.toThrow(/is finished \(FAILED\): it changes no more/)
  })

  it('are deleted only once finished, 7 days after; never truncated', async () => {
    const running = tickRow('test.delete', new Date(Math.floor(Date.now() / 60_000) * 60_000 - 60_000))
    expect(await insert('CronRun', running)).toBe(1)
    await expect(run(`DELETE FROM "CronRun" WHERE id = $1::uuid`, running.id)).rejects.toThrow(/deleted only once finished, 7 days after it finished/)
    await expect(run(`DELETE FROM "CronRun" WHERE id = $1::uuid`, s.runIds[0])).rejects.toThrow(/7 days after it finished/)
    const old = new Date(Math.floor(Date.now() / 60_000) * 60_000 - 8 * 24 * HOUR)
    const finished = tickRow('test.delete', old, { status: 'SUCCEEDED', finishedAt: new Date(old.getTime() + 1000).toISOString() })
    expect(await insert('CronRun', finished)).toBe(1)
    expect(await run(`DELETE FROM "CronRun" WHERE id = $1::uuid`, finished.id)).toBe(1)
    await expect(admin(`TRUNCATE "CronRun"`)).rejects.toThrow(/TRUNCATE on "CronRun" is refused/)
  })
})

describe('the outside doors of safety reports (B-W2b-351, -357; GATE-PRIVACY)', () => {
  it('open per company, only once its SAFETY_REPORT notice is published; switching off is always allowed', async () => {
    const settings = (id: string, companyId: string | null) => insert('SalesSettings', { id, companyId, marginFloorPct: 20, discountLimitPct: 10, defaultValidityDays: 30 })
    expect(await settings(a.tenantId, null)).toBe(1)
    expect(await settings(A.companyA, A.companyA)).toBe(1)
    const on = (id: string) => run(`UPDATE "SalesSettings" SET "safetyReportFormOn" = true WHERE id = $1::uuid`, id)
    await expect(on(a.tenantId)).rejects.toThrow(/switched on per company, never in the tenant-wide sales settings/)
    await expect(on(A.companyA)).rejects.toThrow(/open only once its safety-report privacy notice is published \(GATE-PRIVACY\)/)
    // The company's SAFETY_REPORT notice: a draft is not enough.
    const noticeId = randomUUID()
    expect(await insert('PrivacyNotice', { id: noticeId, companyId: A.companyA, kind: 'SAFETY_REPORT', versionNo: 1, label: 'T-1' })).toBe(1)
    const body = 'SAMPLE - a made-up safety-report notice for tests.'
    expect(await insert('PrivacyNoticeText', { id: randomUUID(), noticeId, locale: 'it', body, sha256: sha(body) })).toBe(1)
    await expect(on(A.companyA)).rejects.toThrow(/open only once its safety-report privacy notice is published/)
    expect(await run(`UPDATE "PrivacyNotice" SET status = 'PUBLISHED', "publishedAt" = now(), "publishedById" = $2::uuid WHERE id = $1::uuid`, noticeId, a.actorId)).toBe(1)
    expect(await on(A.companyA)).toBe(1)
    expect(await run(`UPDATE "SalesSettings" SET "safetyReportFormOn" = false WHERE id = $1::uuid`, A.companyA)).toBe(1)
  })
})

describe('protected views and the read log', () => {
  it('log a view of a safety report\'s injury with no employee, of the injury\'s company; never as a list', async () => {
    // A report and its injury of company A, written with the triggers off (their own rules are wave 43's, tested there).
    const reportId = randomUUID()
    const injuryId = randomUUID()
    await asReplica(async () => {
      await db.admin.query(
        `INSERT INTO "ProductSafetyReport" (id, "tenantId", "companyId", number, source, "receivedAt", "whatHappened") VALUES ($1, $2, $3, $4, 'OFFICE', now(), 'A made-up report for a test.')`,
        [reportId, a.tenantId, A.companyA, `T-PSR-${reportId.slice(0, 8)}`],
      )
      await db.admin.query(`INSERT INTO "ProductSafetyInjury" (id, "tenantId", "companyId", "reportId", key, injured) VALUES ($1, $2, $3, $4, $5, true)`, [
        injuryId,
        a.tenantId,
        A.companyA,
        reportId,
        `injury:${reportId}`,
      ])
    })
    const view = (row: Record<string, unknown>) => insert('ProtectedView', { id: randomUUID(), companyId: A.companyA, recordType: 'PRODUCT_SAFETY_INJURY', recordId: injuryId, what: 'OPEN', viewerId: a.actorId, ...row })
    await expect(view({ employeeId: key('people:employee:A1:operator') })).rejects.toThrow(/names no employee \(the person hurt is outside the company\)|violates foreign key/)
    await expect(view({ what: 'LIST' })).rejects.toThrow(/names the record, and is OPEN, COPY or PRINT/)
    await expect(view({ companyId: A.companyB })).rejects.toThrow(/names the company and the person of the PRODUCT_SAFETY_INJURY it is of/)
    expect(await view({})).toBe(1)
    expect(await view({ what: 'COPY' })).toBe(1)
    // A data request asked for it (REPORTER): the report is the person's record.
    expect(await request({ personKind: 'REPORTER', personRecordType: 'ProductSafetyReport', personRecordId: reportId, kind: 'ERASURE' })).toBeTruthy()
  })

  it('takes the download of a person\'s access package (DataRequest) as a read of a sensitive record', async () => {
    const read = (recordType: string) => insert('ReadLog', { id: randomUUID(), userId: a.actorId, recordType, recordId: s.requestIds.memberAccess, action: 'DOWNLOAD', surface: 'OFFICE' })
    expect(await read('DataRequest')).toBe(1)
    await expect(read('RetentionRule')).rejects.toThrow(/not a sensitive one of the list/)
  })
})
