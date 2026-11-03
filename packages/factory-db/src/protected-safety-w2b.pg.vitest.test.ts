import { createHash, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedHealth, type HealthSeed } from '../seed/health'
import { seed as seedNumbering } from '../seed/numbering'
import { seed as seedPeople, type PeopleSeed } from '../seed/people'
import { seed as seedSafety, type SafetySeed } from '../seed/safety'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { classifiedModels, personalDataOf } from './ownership'
import { RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'
import { loadOwnership, loadSchema } from './tools'

/**
 * The protected safety data schema (W2b schema wave 16/16, B-W2b-91, …_protected_safety_w2b_guards) on a database built from the
 * migrations and seeded, through the real login and the scoped client:
 *   - grants: the health and incident tables are the office's; the floor INSERTS a report and its people and reads none of
 *     them (not even its own), nor any health table; it reads its site's chemicals and data sheets; the partner reads nothing;
 *     every personal column is tagged SAFETY only; INCIDENT is a floor document kind;
 *   - plans per role, visits (a return carries only the absence's length), fitness judgements (the outcome and the task limits,
 *     voided once, one live per visit), the view log append-only;
 *   - incidents (a nameless report holds no reporter, creator or tablet; closing held while an action or a filing waits), the
 *     people involved, actions made into a job, a measure or a session, INAIL filings due 48 hours after the certificate;
 *   - chemicals as CLP codes, data sheets one current per language; protected files are the office's only, protected records
 *     are never indexed for search.
 * The refusals are check_violation (SQLSTATE 23514); their messages are read through raw SQL. Dates count from today (Rome).
 */

const NS = 'w2b-91-a'
const DENIED = /permission denied/
const DAY_MS = 86_400_000

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let people: PeopleSeed
let safety: SafetySeed
let seeded: HealthSeed

const key = (name: string): string => seedUuid(NS, name)
const A = {
  company: key('company:A'),
  site: key('site:A1'),
  companyB: key('company:B'),
  siteB: key('site:B1'),
  operator: key('worker:A1:operator'),
  device: key('device:A1:cutting'),
  cutStation: key('site:A1:station:CUT-01'),
  store: key('files:account:r2'),
}
const office = (): FactoryScope => ({ audience: 'office', tenantId: a.tenantId, actorId: a.actorId })
const floor = (): FactoryScope => ({ audience: 'floor', tenantId: a.tenantId, actorId: A.operator, siteId: A.site })
const partner = (): FactoryScope => ({ audience: 'partner', tenantId: a.tenantId, actorId: a.actorId, partyId: key('party:P1') })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const run = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$executeRawUnsafe(text, ...values))
const sql = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$queryRawUnsafe<Record<string, unknown>[]>(text, ...values))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, unknown>[]
const value = async (text: string, values: unknown[] = []): Promise<unknown> => Object.values((await admin(text, values))[0] ?? {})[0]
/** INSERT a copy of row `id` of `table` with `changes` (an office scope: every column). */
const copyRow = (scope: FactoryScope, table: string, id: string, changes: Record<string, unknown>) =>
  run(
    scope,
    `INSERT INTO "${table}" SELECT * FROM jsonb_populate_record(NULL::"${table}", (SELECT to_jsonb(r) || $1::jsonb FROM "${table}" r WHERE r.id = $2::uuid))`,
    JSON.stringify(changes),
    id,
  )
/** An insert of the row's columns only (the others take their defaults): what a floor session may name. */
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
const today = (): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
const day = (offset: number): string => new Date(Date.parse(`${today()}T00:00:00.000Z`) + offset * DAY_MS).toISOString().slice(0, 10)
const now = () => new Date().toISOString()
/** A stored file of a record (office). */
const storeFile = async (recordType: string, recordId: string, extra: Record<string, unknown> = {}): Promise<string> => {
  const id = randomUUID()
  await insert(office(), 'StoredFile', {
    id, companyId: A.company, recordType, recordId, kind: 'DOCUMENT', originalName: 'test.pdf', contentType: 'application/pdf', sizeBytes: 10, sha256: sha(id), storeAccountId: A.store,
    storageKey: `t/${a.tenantId}/test/${id}`, status: 'AVAILABLE', availableAt: now(), visibility: ['OFFICE'], ...extra,
  })
  return id
}
/** A fresh office incident of plant A1 (OPEN), with its number. */
const newIncident = async (changes: Record<string, unknown> = {}): Promise<string> => {
  const id = randomUUID()
  const at = now()
  await insert(office(), 'Incident', {
    id, companyId: A.company, siteId: A.site, number: `T-INC-${id.slice(0, 8)}`, kind: 'INJURY', occurredAt: at, reportedAt: at, what: 'Test incident', stationId: A.cutStation,
    reportedVia: 'OFFICE', reportedById: a.actorId, ...changes,
  })
  return id
}

beforeAll(async () => {
  db = await migratedDatabase('protectedw2b')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: NS })
  await seedNumbering({ db: factory, namespace: NS })
  people = await seedPeople({ db: factory, namespace: NS })
  safety = await seedSafety({ db: factory, namespace: NS })
  seeded = await seedHealth({ db: factory, namespace: NS })
}, 1_500_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

describe('grants and the seed', () => {
  it('classifies the ten models of the file: no partner; the floor inserts reports and reads chemicals only; personal columns are SAFETY only', () => {
    const models = classifiedModels(loadSchema(), loadOwnership()).filter(({ model }) => model.file === 'health.prisma')
    expect(models.map(({ model }) => model.name).sort()).toEqual([
      'Chemical', 'FitnessJudgement', 'HealthPlan', 'HealthVisit', 'InailFiling', 'Incident', 'IncidentAction', 'IncidentPerson', 'ProtectedView', 'SafetyDataSheet',
    ])
    const floorOf = Object.fromEntries(models.map(({ model, ownership }) => [model.name, ownership.access.factory_floor_runtime?.privileges ?? []]))
    expect(floorOf).toEqual({
      Chemical: ['select'], FitnessJudgement: [], HealthPlan: [], HealthVisit: [], InailFiling: [], Incident: ['insert'], IncidentAction: [], IncidentPerson: ['insert'], ProtectedView: [], SafetyDataSheet: ['select'],
    })
    for (const { ownership } of models) {
      expect(Object.keys(ownership.access)).not.toContain('factory_partner_runtime')
      expect(Object.keys(ownership.access)).not.toContain('factory_platform')
    }
    const personal = personalDataOf(loadSchema(), loadOwnership()).filter((entry) => models.some(({ model }) => model.name === entry.model))
    expect(personal.map((entry) => entry.model).sort()).toEqual(['FitnessJudgement', 'HealthVisit', 'InailFiling', 'IncidentPerson', 'ProtectedView'])
    for (const entry of personal) for (const purposes of Object.values(entry.columns)) expect(purposes).toEqual(['SAFETY'])
  })

  it('keeps every health and incident table from the floor and the partner; the floor reads its own site\'s chemicals and data sheets', async () => {
    for (const table of ['HealthPlan', 'HealthVisit', 'FitnessJudgement', 'ProtectedView', 'Incident', 'IncidentPerson', 'IncidentAction', 'InailFiling']) {
      await expect(sql(floor(), `SELECT id FROM "${table}" LIMIT 1`)).rejects.toThrow(DENIED)
      await expect(sql(partner(), `SELECT id FROM "${table}" LIMIT 1`)).rejects.toThrow(DENIED)
    }
    for (const table of ['Chemical', 'SafetyDataSheet']) await expect(sql(partner(), `SELECT id FROM "${table}" LIMIT 1`)).rejects.toThrow(DENIED)
    const chemicals = await sql(floor(), 'SELECT id::text AS id FROM "Chemical" ORDER BY id')
    expect(chemicals.map((row) => row.id).sort()).toEqual([seeded.chemicalIds.glue, seeded.chemicalIds.edgePaint, seeded.chemicalIds.solvent].sort())
    expect(await sql(floor(), 'SELECT count(*)::int AS n FROM "SafetyDataSheet"')).toEqual([{ n: 4 }])
    await expect(run(floor(), 'UPDATE "Chemical" SET name = name WHERE false')).rejects.toThrow(DENIED)
  })

  it('wrote what the seed says: a nameless hazard, an injury from the tablet, a filing 48 hours after the certificate, a voided judgement', async () => {
    expect(await admin(`SELECT "reportedVia"::text AS via, "reporterAnonymous" AS anonymous, "reportedByWorkerId" AS worker, "deviceId" AS device, "createdById" AS creator FROM "Incident" WHERE id = $1`, [seeded.incidentIds.anonymousHazard]))
      .toEqual([{ via: 'FLOOR', anonymous: true, worker: null, device: null, creator: null }])
    expect(await admin(`SELECT "reportedByWorkerId"::text AS worker, severity::text, "createdById" AS creator FROM "Incident" WHERE id = $1`, [seeded.incidentIds.cut])).toEqual([{ worker: A.operator, severity: 'LOST_DAYS', creator: null }])
    expect(await value(`SELECT extract(epoch FROM "dueAt" - "certificateReceivedAt")::int FROM "InailFiling" WHERE id = $1`, [seeded.filingId])).toBe(48 * 3600)
    expect(await admin(`SELECT "voidReason"::text AS reason FROM "FitnessJudgement" WHERE id = $1`, [seeded.judgementIds.e3Voided])).toEqual([{ reason: 'WRONG_DETAILS' }])
    expect(await value(`SELECT count(*)::int FROM "SafetyDataSheet" WHERE status = 'CURRENT'`)).toBe(4)
  })
})

describe('the floor reports without reading', () => {
  it('inserts an incident and its person, reads neither back, and may not name an office column', async () => {
    const incidentId = randomUUID()
    const at = now()
    const report = {
      id: incidentId, companyId: A.company, siteId: A.site, number: `T-INC-F-${incidentId.slice(0, 6)}`, kind: 'INJURY', occurredAt: at, reportedAt: at, what: 'Bumped an arm on the trolley',
      stationId: A.cutStation, reportedVia: 'FLOOR', reportedByWorkerId: A.operator, deviceId: A.device,
    }
    expect(await insert(floor(), 'Incident', report)).toBe(1)
    expect(
      await insert(floor(), 'IncidentPerson', { id: randomUUID(), siteId: A.site, incidentId, involvement: 'INJURED', employeeId: people.employeeIds.e1, bodyParts: ['ARM'], nature: 'BRUISE', firstAidGiven: true }),
    ).toBe(1)
    await expect(sql(floor(), 'SELECT id FROM "Incident" WHERE id = $1::uuid', incidentId)).rejects.toThrow(DENIED)
    await expect(sql(floor(), 'SELECT id FROM "IncidentPerson" WHERE "incidentId" = $1::uuid', incidentId)).rejects.toThrow(DENIED)
    await expect(insert(floor(), 'Incident', { ...report, id: randomUUID(), number: 'T-INC-F-SEV', severity: 'NONE' })).rejects.toThrow(DENIED)
    await expect(insert(floor(), 'Incident', { ...report, id: randomUUID(), number: 'T-INC-F-CRE', createdById: a.actorId })).rejects.toThrow(DENIED)
    // RETURNING reads: a floor insert asks no row back.
    await expect(run(floor(), `INSERT INTO "Incident" (id, "companyId", "siteId", number, kind, "occurredAt", what, place, "reportedVia", "reporterAnonymous") VALUES ($1::uuid, $2::uuid, $3::uuid, 'T-INC-F-RET', 'HAZARD', now(), 'x', 'y', 'FLOOR', true) RETURNING id`, randomUUID(), A.company, A.site)).rejects.toThrow(DENIED)
  })

  it('a hazard or near miss may stay unnamed (no reporter, creator or tablet); an injury may not; a floor report comes from a floor session', async () => {
    const at = now()
    const nameless = { companyId: A.company, siteId: A.site, kind: 'HAZARD', occurredAt: at, reportedAt: at, what: 'Loose cable', place: 'Corridor', reportedVia: 'FLOOR', reporterAnonymous: true }
    expect(await insert(floor(), 'Incident', { ...nameless, id: randomUUID(), number: 'T-INC-ANON-1' })).toBe(1)
    await expect(insert(floor(), 'Incident', { ...nameless, id: randomUUID(), number: 'T-INC-ANON-2', deviceId: A.device })).rejects.toThrow(/no reporter, creator or tablet/)
    await expect(insert(floor(), 'Incident', { ...nameless, id: randomUUID(), number: 'T-INC-ANON-3', reportedByWorkerId: A.operator })).rejects.toThrow(/no reporter, creator or tablet/)
    await expect(insert(floor(), 'Incident', { ...nameless, id: randomUUID(), number: 'T-INC-ANON-4', kind: 'INJURY' })).rejects.toThrow(/only a near miss or a hazard may be sent without a name/)
    await expect(insert(floor(), 'Incident', { ...nameless, id: randomUUID(), number: 'T-INC-ANON-5', reportedVia: 'OFFICE' })).rejects.toThrow(/a floor report is sent from a floor session/)
    await expect(copyRow(office(), 'Incident', seeded.incidentIds.cut, { id: randomUUID(), number: 'T-INC-COPY', seenAt: null, seenById: null, severity: null })).rejects.toThrow(/a floor report is sent from a floor session/)
    await expect(insert(floor(), 'Incident', { ...nameless, id: randomUUID(), number: 'T-INC-ANON-6', place: null })).rejects.toThrow(/says where it happened/)
    await expect(insert(floor(), 'Incident', { ...nameless, id: randomUUID(), number: 'T-INC-ANON-7', reportedAt: new Date(Date.now() - 60_000).toISOString() })).rejects.toThrow(/at the latest when it was reported/)
    await expect(insert(floor(), 'Incident', { ...nameless, id: randomUUID(), number: '' })).rejects.toThrow(/has its number/)
  })

  it('numbers an incident from the INCIDENT series of its site\'s company: a floor document kind', async () => {
    const [series] = await sql(floor(), `SELECT id::text AS id, pattern, "nextValue" AS next FROM "NumberSeries" WHERE kind = 'INCIDENT' AND "companyId" = $1::uuid`, A.company)
    expect(series).toMatchObject({ pattern: 'INC-{YYYY}-{N:4}', next: 1 })
    await as(floor(), (client) =>
      client.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `INSERT INTO "NumberAllocation" (id, "companyId", "seriesId", kind, value, formatted, "documentDate", "recordType", "recordId", "allocatedAt", "allocatedById", "requestId")
           VALUES ($1::uuid, $2::uuid, $3::uuid, 'INCIDENT', 1, 'INC-2026-0001', $4::date, 'Incident', $5::uuid, now(), $6::uuid, 'test')`,
          randomUUID(),
          A.company,
          series!.id,
          today(),
          randomUUID(),
          a.actorId,
        )
        await tx.$executeRawUnsafe(`UPDATE "NumberSeries" SET "nextValue" = "nextValue" + 1 WHERE id = $1::uuid`, series!.id)
      }),
    )
    expect(await value(`SELECT "nextValue" FROM "NumberSeries" WHERE id = $1`, [series!.id])).toBe(2)
  })
})

describe('health surveillance', () => {
  it('a plan per role: its key, a frequency exactly when needed, the doctor\'s appointment; archived, never deleted', async () => {
    await expect(copyRow(office(), 'HealthPlan', seeded.planIds.cutter, { id: randomUUID(), key: `plan:${safety.roleSheetIds.machinist}` })).rejects.toThrow(/key plan:<its role sheet>/)
    await expect(update('HealthPlan', seeded.planIds.machinistB, { frequencyMonths: 12 })).rejects.toThrow(/every 1 to 60 months when the role needs surveillance/)
    await expect(update('HealthPlan', seeded.planIds.cutter, { frequencyMonths: 61 })).rejects.toThrow(/every 1 to 60 months/)
    await expect(update('HealthPlan', seeded.planIds.cutter, { doctorAppointmentId: safety.appointmentIds.rspp })).rejects.toThrow(/occupational doctor's appointment, not a RSPP one/)
    await expect(update('HealthPlan', seeded.planIds.cutter, { setOn: day(1) })).rejects.toThrow(/today at the latest/)
    await expect(update('HealthPlan', seeded.planIds.cutter, { roleSheetId: safety.roleSheetIds.machinist, key: `plan:${safety.roleSheetIds.machinist}` })).rejects.toThrow(/never change/)
    expect(await update('HealthPlan', seeded.planIds.cutter, { frequencyMonths: 6 })).toBe(1)
    // No delete grant for the office; the trigger refuses every login, the owner included.
    await expect(run(office(), 'DELETE FROM "HealthPlan" WHERE id = $1::uuid', seeded.planIds.cutter)).rejects.toThrow(DENIED)
    await expect(db.admin.query('DELETE FROM "HealthPlan" WHERE id = $1', [seeded.planIds.cutter])).rejects.toThrow(/archived, never deleted/)
  })

  it('a visit: a return carries only the absence\'s length (over 60 days), a change of task its role; DUE ↔ BOOKED → DONE | CANCELLED, final', async () => {
    const base = { companyId: A.company, employeeId: people.employeeIds.e2, dueOn: day(30) }
    await expect(insert(office(), 'HealthVisit', { ...base, id: randomUUID(), type: 'RETURN_AFTER_ABSENCE' })).rejects.toThrow(/absence's length in days exactly when it is a return/)
    await expect(insert(office(), 'HealthVisit', { ...base, id: randomUUID(), type: 'RETURN_AFTER_ABSENCE', absenceDays: 60 })).rejects.toThrow(/above 60/)
    await expect(insert(office(), 'HealthVisit', { ...base, id: randomUUID(), type: 'PERIODIC', absenceDays: 90 })).rejects.toThrow(/exactly when it is a return/)
    await expect(insert(office(), 'HealthVisit', { ...base, id: randomUUID(), type: 'CHANGE_OF_TASK' })).rejects.toThrow(/names the new role sheet/)
    await expect(insert(office(), 'HealthVisit', { ...base, id: randomUUID(), type: 'PERIODIC', status: 'BOOKED' })).rejects.toThrow(/BOOKED with its day/)
    await expect(insert(office(), 'HealthVisit', { ...base, id: randomUUID(), type: 'PERIODIC', planId: seeded.planIds.machinistB, companyId: A.companyB, employeeId: people.employeeIds.eb1 })).rejects.toThrow(/a plan that asks visits/)
    await expect(insert(office(), 'HealthVisit', { ...base, id: randomUUID(), type: 'PERIODIC', status: 'CANCELLED', cancelledAt: now(), cancelledById: a.actorId, cancelReason: 'MISTAKE' })).rejects.toThrow(/starts DUE, BOOKED or DONE/)

    const visit = randomUUID()
    expect(await insert(office(), 'HealthVisit', { ...base, id: visit, type: 'RETURN_AFTER_ABSENCE', absenceDays: 61 })).toBe(1)
    expect(await update('HealthVisit', visit, { status: 'BOOKED', bookedOn: day(5), bookedPlace: 'Clinic', bookedAt: now(), bookedById: a.actorId })).toBe(1)
    expect(await update('HealthVisit', visit, { status: 'DUE', bookedOn: null, bookedPlace: null, bookedAt: null, bookedById: null })).toBe(1)
    await expect(update('HealthVisit', visit, { absenceDays: 70 })).rejects.toThrow(/never change/)
    await expect(update('HealthVisit', visit, { status: 'DONE', doneOn: day(1) })).rejects.toThrow(/today at the latest/)
    await expect(update('HealthVisit', visit, { status: 'CANCELLED', cancelledAt: now(), cancelledById: a.actorId })).rejects.toThrow(/CANCELLED exactly with when, by whom and the reason/)
    expect(await update('HealthVisit', visit, { status: 'DONE', doneOn: day(0) })).toBe(1)
    await expect(update('HealthVisit', visit, { dueOn: day(40) })).rejects.toThrow(/is DONE; it no longer changes/)
    // No delete grant for the office; the trigger refuses every login, the owner included.
    await expect(run(office(), 'DELETE FROM "HealthVisit" WHERE id = $1::uuid', visit)).rejects.toThrow(DENIED)
    await expect(db.admin.query('DELETE FROM "HealthVisit" WHERE id = $1', [visit])).rejects.toThrow(/never deleted/)
  })

  it('a judgement holds the outcome only: task limits exactly with FIT_WITH_LIMITS, an until-day with TEMPORARILY_UNFIT, no expiry for UNFIT', async () => {
    const base = { companyId: A.company, employeeId: people.employeeIds.e2, judgedOn: day(0) }
    await expect(insert(office(), 'FitnessJudgement', { ...base, id: randomUUID(), outcome: 'FIT', taskLimits: 'none' })).rejects.toThrow(/task limits .* exactly when it is FIT_WITH_LIMITS/)
    await expect(insert(office(), 'FitnessJudgement', { ...base, id: randomUUID(), outcome: 'FIT_WITH_LIMITS' })).rejects.toThrow(/exactly when it is FIT_WITH_LIMITS/)
    await expect(insert(office(), 'FitnessJudgement', { ...base, id: randomUUID(), outcome: 'FIT_WITH_LIMITS', taskLimits: 'x'.repeat(1001) })).rejects.toThrow(/at most 1000 characters/)
    await expect(insert(office(), 'FitnessJudgement', { ...base, id: randomUUID(), outcome: 'TEMPORARILY_UNFIT' })).rejects.toThrow(/until when exactly when it is TEMPORARILY_UNFIT/)
    await expect(insert(office(), 'FitnessJudgement', { ...base, id: randomUUID(), outcome: 'TEMPORARILY_UNFIT', unfitUntil: day(0) })).rejects.toThrow(/a day after the judgement's/)
    await expect(insert(office(), 'FitnessJudgement', { ...base, id: randomUUID(), outcome: 'UNFIT', expiresOn: day(100) })).rejects.toThrow(/an UNFIT judgement does not expire/)
    await expect(insert(office(), 'FitnessJudgement', { ...base, id: randomUUID(), outcome: 'FIT', judgedOn: day(1) })).rejects.toThrow(/today at the latest/)
    await expect(insert(office(), 'FitnessJudgement', { ...base, id: randomUUID(), outcome: 'FIT', doctorAppointmentId: safety.appointmentIds.rspp })).rejects.toThrow(/occupational doctor's appointment/)
    // The visit is the same person's (the reference), not cancelled, and has one judgement not voided.
    await expect(insert(office(), 'FitnessJudgement', { ...base, id: randomUUID(), outcome: 'FIT', visitId: seeded.visitIds.e1Due })).rejects.toThrow(/foreign key/)
    await expect(insert(office(), 'FitnessJudgement', { ...base, id: randomUUID(), outcome: 'FIT', employeeId: people.employeeIds.e3, visitId: seeded.visitIds.e3Preventive })).rejects.toThrow(/FitnessJudgement_one_per_visit/)
    await expect(insert(office(), 'FitnessJudgement', { ...base, id: randomUUID(), outcome: 'FIT', employeeId: people.employeeIds.e5, visitId: seeded.visitIds.e5Cancelled })).rejects.toThrow(/not from cancelled visit/)
  })

  it('a judgement never changes; voided once (its task limits may be cleared then), never deleted', async () => {
    const judgement = randomUUID()
    expect(await insert(office(), 'FitnessJudgement', { id: judgement, companyId: A.company, employeeId: people.employeeIds.e1, outcome: 'FIT_WITH_LIMITS', taskLimits: 'No night shifts.', judgedOn: day(-1) })).toBe(1)
    await expect(update('FitnessJudgement', judgement, { outcome: 'FIT', taskLimits: null })).rejects.toThrow(/never changes/)
    await expect(update('FitnessJudgement', judgement, { taskLimits: 'No lifting.' })).rejects.toThrow(/never changes/)
    await expect(update('FitnessJudgement', judgement, { taskLimits: null })).rejects.toThrow(/exactly when it is FIT_WITH_LIMITS/)
    await expect(update('FitnessJudgement', judgement, { voidedAt: now(), voidedById: a.actorId })).rejects.toThrow(/the reason, all together/)
    expect(await update('FitnessJudgement', judgement, { voidedAt: now(), voidedById: a.actorId, voidReason: 'WRONG_PERSON', taskLimits: null })).toBe(1)
    expect(await admin(`SELECT "taskLimits" FROM "FitnessJudgement" WHERE id = $1`, [judgement])).toEqual([{ taskLimits: null }])
    await expect(update('FitnessJudgement', judgement, { voidReason: 'DUPLICATE' })).rejects.toThrow(/never changes/)
    // No delete grant for the office; the trigger refuses every login, the owner included.
    await expect(run(office(), 'DELETE FROM "FitnessJudgement" WHERE id = $1::uuid', judgement)).rejects.toThrow(DENIED)
    await expect(db.admin.query('DELETE FROM "FitnessJudgement" WHERE id = $1', [judgement])).rejects.toThrow(/voided, never deleted/)
  })

  it('every view of a protected record is a row that is never changed or removed, of the record\'s company and person', async () => {
    const base = { companyId: A.company, viewerId: a.actorId }
    expect(await insert(office(), 'ProtectedView', { ...base, id: randomUUID(), recordType: 'FITNESS_JUDGEMENT', recordId: seeded.judgementIds.e2Unfit, employeeId: people.employeeIds.e2, what: 'COPY' })).toBe(1)
    await expect(insert(office(), 'ProtectedView', { ...base, id: randomUUID(), recordType: 'FITNESS_JUDGEMENT', recordId: seeded.judgementIds.e2Unfit, employeeId: people.employeeIds.e1, what: 'OPEN' })).rejects.toThrow(/company and the person/)
    await expect(insert(office(), 'ProtectedView', { ...base, id: randomUUID(), recordType: 'INAIL_FILING', recordId: seeded.filingId, employeeId: null, what: 'OPEN' })).rejects.toThrow(/company and the person/)
    expect(await insert(office(), 'ProtectedView', { ...base, id: randomUUID(), recordType: 'INAIL_FILING', recordId: seeded.filingId, employeeId: people.employeeIds.e1, what: 'OPEN' })).toBe(1)
    await expect(insert(office(), 'ProtectedView', { ...base, id: randomUUID(), recordType: 'HEALTH_VISIT', what: 'OPEN' })).rejects.toThrow(/names the record/)
    await expect(insert(office(), 'ProtectedView', { ...base, id: randomUUID(), recordType: 'INCIDENT_PEOPLE_LIST', recordId: seeded.incidentIds.cut, what: 'LIST' })).rejects.toThrow(/names no record/)
    await expect(insert(office(), 'ProtectedView', { ...base, id: randomUUID(), recordType: 'HEALTH_VISIT_LIST', what: 'OPEN' })).rejects.toThrow(/LIST or a PRINT/)
    const viewId = String(await value(`SELECT id FROM "ProtectedView" ORDER BY "viewedAt" LIMIT 1`))
    // No update or delete grant for the office; the triggers refuse every login, the owner included.
    await expect(run(office(), 'UPDATE "ProtectedView" SET what = what WHERE id = $1::uuid', viewId)).rejects.toThrow(DENIED)
    await expect(run(office(), 'DELETE FROM "ProtectedView" WHERE id = $1::uuid', viewId)).rejects.toThrow(DENIED)
    await expect(db.admin.query(`UPDATE "ProtectedView" SET what = 'PRINT' WHERE id = $1`, [viewId])).rejects.toThrow(/never changed or removed/)
    await expect(db.admin.query('DELETE FROM "ProtectedView" WHERE id = $1', [viewId])).rejects.toThrow(/never changed or removed/)
    await expect(db.admin.query('TRUNCATE "ProtectedView"')).rejects.toThrow(/never changed or removed/)
  })
})

describe('incidents', () => {
  it('closing waits for the actions and the INAIL filings; a closed incident is reopened to change; cancelled is final; the number and the reporter never change', async () => {
    const incident = await newIncident()
    const person = randomUUID()
    expect(await insert(office(), 'IncidentPerson', { id: person, siteId: A.site, incidentId: incident, involvement: 'INJURED', employeeId: people.employeeIds.e3, bodyParts: ['FOOT'], nature: 'CRUSH' })).toBe(1)
    const action = randomUUID()
    expect(await insert(office(), 'IncidentAction', { id: action, siteId: A.site, incidentId: incident, seq: 1, title: 'Fit toe guards' })).toBe(1)
    const filing = randomUUID()
    expect(await insert(office(), 'InailFiling', { id: filing, siteId: A.site, incidentId: incident, incidentPersonId: person, type: 'STATISTICAL', key: `inail:${person}:STATISTICAL`, expectedAbsenceDays: 2 })).toBe(1)
    const close = { status: 'CLOSED', closedAt: now(), closedById: a.actorId }
    await expect(update('Incident', incident, close)).rejects.toThrow(/held open while one of its actions is open/)
    expect(await update('IncidentAction', action, { status: 'DONE', doneAt: now(), doneById: a.actorId })).toBe(1)
    await expect(update('Incident', incident, close)).rejects.toThrow(/held open while an INAIL filing of it waits/)
    const received = new Date(Date.now() - 3_600_000)
    expect(await update('InailFiling', filing, { status: 'DUE', certificateReceivedAt: received.toISOString(), dueAt: new Date(received.getTime() + 48 * 3_600_000).toISOString() })).toBe(1)
    expect(await update('InailFiling', filing, { status: 'FILED', filedAt: now(), filedById: a.actorId, protocolNumber: 'T-PROT-1' })).toBe(1)
    expect(await update('Incident', incident, close)).toBe(1)
    await expect(update('Incident', incident, { what: 'Changed' })).rejects.toThrow(/reopening it changes nothing else|reopen it first/)
    await expect(update('IncidentPerson', person, { nature: 'CUT' })).rejects.toThrow(/change only while it is OPEN/)
    await expect(insert(office(), 'IncidentAction', { id: randomUUID(), siteId: A.site, incidentId: incident, seq: 2, title: 'Late' })).rejects.toThrow(/change only while it is OPEN/)
    expect(await update('Incident', incident, { status: 'OPEN', closedAt: null, closedById: null })).toBe(1)
    await expect(update('Incident', incident, { number: 'T-INC-OTHER' })).rejects.toThrow(/number, reporter, .* never change/)
    await expect(update('Incident', incident, { reportedById: people.employeeIds.e1 })).rejects.toThrow(/reporter, tablet, report time and creation .* never change/)
    await expect(update('Incident', incident, { kind: 'NEAR_MISS' })).rejects.toThrow(/stays an injury while a person is injured in it/)
    expect(await update('Incident', incident, { seenAt: now(), seenById: a.actorId })).toBe(1)
    await expect(update('Incident', incident, { seenAt: now(), seenById: people.employeeIds.e1 })).rejects.toThrow(/seen by safety once/)
    await expect(update('Incident', incident, { status: 'CANCELLED', cancelledAt: now(), cancelledById: a.actorId })).rejects.toThrow(/CANCELLED exactly with when, by whom and the reason/)
    expect(await update('Incident', incident, { status: 'CANCELLED', cancelledAt: now(), cancelledById: a.actorId, cancelReason: 'Test' })).toBe(1)
    await expect(update('Incident', incident, { status: 'OPEN', cancelledAt: null, cancelledById: null, cancelReason: null })).rejects.toThrow(/CANCELLED; it no longer changes/)
    // No delete grant for the office; the trigger refuses every login, the owner included.
    await expect(run(office(), 'DELETE FROM "Incident" WHERE id = $1::uuid', incident)).rejects.toThrow(DENIED)
    await expect(db.admin.query('DELETE FROM "Incident" WHERE id = $1', [incident])).rejects.toThrow(/never deleted/)
  })

  it('a person involved: of the company or by name, exactly one; injured only in an injury; involved carries no injury; removed by the office while open', async () => {
    const nearMiss = await newIncident({ kind: 'NEAR_MISS' })
    const base = { siteId: A.site, incidentId: nearMiss }
    await expect(insert(office(), 'IncidentPerson', { ...base, id: randomUUID(), involvement: 'INJURED', employeeId: people.employeeIds.e1 })).rejects.toThrow(/is an injury, not a NEAR_MISS/)
    await expect(insert(office(), 'IncidentPerson', { ...base, id: randomUUID(), involvement: 'INVOLVED', employeeId: people.employeeIds.e1, firstAidGiven: true })).rejects.toThrow(/involved, not hurt/)
    await expect(insert(office(), 'IncidentPerson', { ...base, id: randomUUID(), involvement: 'INVOLVED', employeeId: people.employeeIds.e1, outsideName: 'Visitor' })).rejects.toThrow(/exactly one/)
    await expect(insert(office(), 'IncidentPerson', { ...base, id: randomUUID(), involvement: 'INVOLVED', outsideName: 'Visitor', bodySide: 'LEFT' })).rejects.toThrow(/a side only with the parts/)
    const visitor = randomUUID()
    expect(await insert(office(), 'IncidentPerson', { ...base, id: visitor, involvement: 'INVOLVED', outsideName: 'Seed visitor (made-up)' })).toBe(1)
    const injury = await newIncident()
    await expect(insert(office(), 'IncidentPerson', { id: randomUUID(), siteId: A.site, incidentId: injury, involvement: 'INJURED', employeeId: people.employeeIds.e1, bodyParts: ['HAND', 'HAND'] })).rejects.toThrow(/each body part once/)
    expect(await run(office(), 'DELETE FROM "IncidentPerson" WHERE id = $1::uuid', visitor)).toBe(1)
    // A person with a filing is held by it (the filing's reference).
    await expect(run(office(), 'DELETE FROM "IncidentPerson" WHERE id = $1::uuid', seeded.personIds.e1Injured)).rejects.toThrow(/foreign key/)
  })

  it('an action names exactly what it was made into, once; a measure made from it names this incident; done is final', async () => {
    const incident = await newIncident({ kind: 'HAZARD' })
    const base = { siteId: A.site, incidentId: incident, title: 'Act' }
    await expect(insert(office(), 'IncidentAction', { ...base, id: randomUUID(), seq: 1, madeInto: 'MAINTENANCE_JOB' })).rejects.toThrow(/names exactly the record it was made into/)
    await expect(insert(office(), 'IncidentAction', { ...base, id: randomUUID(), seq: 1, trainingSessionId: safety.sessionIds.open })).rejects.toThrow(/names exactly the record it was made into/)
    // The seeded measure from an incident names the seeded cut as its source, not this one.
    await expect(insert(office(), 'IncidentAction', { ...base, id: randomUUID(), seq: 1, madeInto: 'RISK_MEASURE', riskMeasureId: key('safety:measure:A1:incident') })).rejects.toThrow(/whose source is this incident/)
    await expect(insert(office(), 'IncidentAction', { ...base, id: randomUUID(), seq: 1, status: 'DONE', doneAt: now(), doneById: a.actorId })).rejects.toThrow(/starts OPEN/)
    const action = randomUUID()
    expect(await insert(office(), 'IncidentAction', { ...base, id: action, seq: 1 })).toBe(1)
    expect(await update('IncidentAction', action, { madeInto: 'TRAINING_SESSION', trainingSessionId: safety.sessionIds.open })).toBe(1)
    await expect(update('IncidentAction', action, { madeInto: null, trainingSessionId: null })).rejects.toThrow(/made into its TRAINING_SESSION once/)
    await expect(update('IncidentAction', action, { seq: 9 })).rejects.toThrow(/never change/)
    expect(await update('IncidentAction', action, { status: 'CANCELLED', cancelledAt: now(), cancelReason: 'Not needed' })).toBe(1)
    await expect(update('IncidentAction', action, { title: 'Again' })).rejects.toThrow(/CANCELLED; it no longer changes/)
    // No delete grant for the office; the trigger refuses every login, the owner included.
    await expect(run(office(), 'DELETE FROM "IncidentAction" WHERE id = $1::uuid', action)).rejects.toThrow(DENIED)
    await expect(db.admin.query('DELETE FROM "IncidentAction" WHERE id = $1', [action])).rejects.toThrow(/never deleted/)
  })

  it('an INAIL filing: one of each type per person, for an injured person of the company, due 48 hours after the certificate, FILED with its protocol, final', async () => {
    const nearMiss = await newIncident({ kind: 'NEAR_MISS' })
    const involved = randomUUID()
    expect(await insert(office(), 'IncidentPerson', { id: involved, siteId: A.site, incidentId: nearMiss, involvement: 'INVOLVED', employeeId: people.employeeIds.e1 })).toBe(1)
    await expect(insert(office(), 'InailFiling', { id: randomUUID(), siteId: A.site, incidentId: nearMiss, incidentPersonId: involved, type: 'STATISTICAL', key: `inail:${involved}:STATISTICAL` })).rejects.toThrow(/for an injured person of the company in an injury/)
    const filing = seeded.filingId
    const person = seeded.personIds.e1Injured
    await expect(copyRow(office(), 'InailFiling', filing, { id: randomUUID(), key: `inail:${person}:STATISTICAL` })).rejects.toThrow(/key inail:<its person>:<its type>/)
    await expect(copyRow(office(), 'InailFiling', filing, { id: randomUUID(), key: `inail:${person}:INSURANCE` })).rejects.toThrow(/InailFiling_tenantId_key_key/)
    await expect(update('InailFiling', filing, { dueAt: now() })).rejects.toThrow(/48 hours after the medical certificate/)
    await expect(update('InailFiling', filing, { status: 'WAITING_CERTIFICATE' })).rejects.toThrow(/48 hours after the medical certificate/)
    await expect(update('InailFiling', filing, { status: 'FILED', filedAt: now(), filedById: a.actorId })).rejects.toThrow(/FILED exactly with when .* protocol number/)
    await expect(update('InailFiling', filing, { status: 'FILED', filedAt: '2020-01-01T00:00:00.000Z', filedById: a.actorId, protocolNumber: 'P' })).rejects.toThrow(/not before the certificate/)
    await expect(update('InailFiling', filing, { expectedAbsenceDays: -1 })).rejects.toThrow(/0 to 3650/)
    await expect(update('InailFiling', filing, { type: 'STATISTICAL', key: `inail:${person}:STATISTICAL` })).rejects.toThrow(/never change/)
    expect(await update('InailFiling', filing, { status: 'FILED', filedAt: now(), filedById: a.actorId, protocolNumber: 'SEED-PROT-0001' })).toBe(1)
    await expect(update('InailFiling', filing, { actualAbsenceDays: 6 })).rejects.toThrow(/FILED; it no longer changes/)
    // No delete grant for the office; the trigger refuses every login, the owner included.
    await expect(run(office(), 'DELETE FROM "InailFiling" WHERE id = $1::uuid', filing)).rejects.toThrow(DENIED)
    await expect(db.admin.query('DELETE FROM "InailFiling" WHERE id = $1', [filing])).rejects.toThrow(/never deleted/)
  })
})

describe('chemicals and data sheets', () => {
  it('a chemical lists CLP codes each once, a maximum with its unit, role sheets of its site and PPE of its company', async () => {
    const glue = seeded.chemicalIds.glue
    await expect(update('Chemical', glue, { hazardStatements: ['H225', 'flammable'] })).rejects.toThrow(/as CLP codes, each once/)
    await expect(update('Chemical', glue, { precautionStatements: ['P210', 'P210'] })).rejects.toThrow(/as CLP codes, each once/)
    await expect(update('Chemical', glue, { ghsPictograms: ['GHS02', 'GHS02'] })).rejects.toThrow(/each pictogram once/)
    expect(await update('Chemical', glue, { hazardStatements: ['H225', 'H319', 'H336', 'EUH066', 'H361d'], precautionStatements: ['P210', 'P303+P361+P353'] })).toBe(1)
    await expect(update('Chemical', glue, { maxQuantityUnit: null })).rejects.toThrow(/above 0 with its unit/)
    await expect(update('Chemical', glue, { maxQuantity: '0' })).rejects.toThrow(/above 0 with its unit/)
    await expect(update('Chemical', glue, { roleSheetIds: [safety.roleSheetIds.machinistB] })).rejects.toThrow(/role sheets of its own site/)
    await expect(update('Chemical', glue, { ppeItemIds: [safety.ppeItemIds.apron] })).rejects.toThrow(/PPE items of its own company/)
    await expect(update('Chemical', glue, { cabinetCode: 'CAB 1' })).rejects.toThrow(/a code without spaces/)
    await expect(update('Chemical', glue, { supplierName: 'Both' })).rejects.toThrow(/at most one/)
    await expect(update('Chemical', glue, { companyId: A.companyB, siteId: A.siteB })).rejects.toThrow(/./)
    // No delete grant for the office; the trigger refuses every login, the owner included.
    await expect(run(office(), 'DELETE FROM "Chemical" WHERE id = $1::uuid', glue)).rejects.toThrow(DENIED)
    await expect(db.admin.query('DELETE FROM "Chemical" WHERE id = $1', [glue])).rejects.toThrow(/archived, never deleted/)
  })

  it('a data sheet is a file of its chemical; one CURRENT per chemical and language; superseded once and kept', async () => {
    const glue = seeded.chemicalIds.glue
    const itCurrent = key('health:sds:A1:glue:v3.1:it')
    const pdf = await storeFile('Chemical', glue)
    const sheet = { siteId: A.site, chemicalId: glue, versionLabel: '3.2', revisedOn: day(-1), language: 'it', fileId: pdf }
    await expect(insert(office(), 'SafetyDataSheet', { ...sheet, id: randomUUID() })).rejects.toThrow(/SafetyDataSheet_one_current/)
    await expect(insert(office(), 'SafetyDataSheet', { ...sheet, id: randomUUID(), language: 'ita' })).rejects.toThrow(/ISO 639-1/)
    await expect(insert(office(), 'SafetyDataSheet', { ...sheet, id: randomUUID(), revisedOn: day(1) })).rejects.toThrow(/today at the latest/)
    const other = await storeFile('Chemical', seeded.chemicalIds.edgePaint)
    await expect(insert(office(), 'SafetyDataSheet', { ...sheet, id: randomUUID(), language: 'de', fileId: other })).rejects.toThrow(/a file of its chemical/)
    await expect(insert(office(), 'SafetyDataSheet', { ...sheet, id: randomUUID(), chemicalId: seeded.chemicalIds.solvent, language: 'de', fileId: await storeFile('Chemical', seeded.chemicalIds.solvent) })).rejects.toThrow(/an ACTIVE chemical/)
    await expect(update('SafetyDataSheet', itCurrent, { status: 'SUPERSEDED' })).rejects.toThrow(/SUPERSEDED exactly with when and by whom/)
    expect(await update('SafetyDataSheet', itCurrent, { status: 'SUPERSEDED', supersededAt: now(), supersededById: a.actorId })).toBe(1)
    const replacement = randomUUID()
    expect(await insert(office(), 'SafetyDataSheet', { ...sheet, id: replacement })).toBe(1)
    await expect(update('SafetyDataSheet', itCurrent, { status: 'CURRENT', supersededAt: null, supersededById: null })).rejects.toThrow(/only SUPERSEDED by a newer one/)
    await expect(update('SafetyDataSheet', replacement, { versionLabel: '3.3' })).rejects.toThrow(/never changes/)
    // No delete grant for the office; the trigger refuses every login, the owner included.
    await expect(run(office(), 'DELETE FROM "SafetyDataSheet" WHERE id = $1::uuid', replacement)).rejects.toThrow(DENIED)
    await expect(db.admin.query('DELETE FROM "SafetyDataSheet" WHERE id = $1', [replacement])).rejects.toThrow(/never deleted/)
  })
})

describe('protected records stay out of files shared beyond the office and out of search', () => {
  it('a judgement copy, an incident photo or a filing receipt is the office\'s only', async () => {
    expect(await storeFile('FitnessJudgement', seeded.judgementIds.e1Limits)).toBeTruthy()
    await expect(storeFile('FitnessJudgement', seeded.judgementIds.e1Limits, { visibility: ['OFFICE', 'FLOOR'], floorSiteId: A.site })).rejects.toThrow(/protected safety data: the office's only/)
    await expect(storeFile('Incident', seeded.incidentIds.cut, { visibility: ['OFFICE', 'FLOOR'], floorSiteId: A.site })).rejects.toThrow(/the office's only/)
    const receipt = await storeFile('InailFiling', seeded.filingId)
    await expect(run(office(), `UPDATE "StoredFile" SET visibility = ARRAY['OFFICE','LINK']::"FileAudience"[], "partyId" = $2::uuid WHERE id = $1::uuid`, receipt, key('party:P1'))).rejects.toThrow(/the office's only/)
    // A chemical's data sheet is shared with the floor (the cabinet QR).
    expect(await storeFile('Chemical', seeded.chemicalIds.glue, { visibility: ['OFFICE', 'FLOOR'], floorSiteId: A.site })).toBeTruthy()
  })

  it('never indexes a health record, a view, a person involved or a filing; an incident may be found by its number', async () => {
    const entry = (recordType: string, recordId: string) => ({
      id: randomUUID(), companyId: A.company, recordType, recordId, title: 'x', area: 'plant', viewPermission: 'plant.view', searchText: 'x', indexedAt: now(),
    })
    for (const [recordType, recordId] of [
      ['HealthPlan', seeded.planIds.cutter],
      ['HealthVisit', seeded.visitIds.e1Due],
      ['FitnessJudgement', seeded.judgementIds.e1Limits],
      ['ProtectedView', randomUUID()],
      ['IncidentPerson', seeded.personIds.e1Injured],
      ['InailFiling', seeded.filingId],
    ] as const) {
      await expect(insert(office(), 'SearchEntry', entry(recordType, recordId))).rejects.toThrow(/protected safety data and is never indexed/)
    }
    expect(await insert(office(), 'SearchEntry', entry('Incident', seeded.incidentIds.pressGuard))).toBe(1)
  })
})
