import { createHash, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
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
 * The safety at work schema (W2b schema wave 15/16, B-W2b-87, …_safety_w2b_guards) on a database built from the migrations and
 * seeded, through the real login and the scoped client:
 *   - grants: the organisation, deadlines, the DVR and its measures are the office's; the floor reads its role sheets, kits,
 *     sessions and instruction entries, the catalogue, requirements and training records (tenant-wide, without the trainer or
 *     the reasons) and PPE items without cost or supplier; the partner reads nothing; the personal columns are tagged SAFETY
 *     (EMPLOYMENT for the HR record), never PERFORMANCE;
 *   - the organisation, the RLS notice, typed deadlines with their evidence and next occurrence;
 *   - DVR versions frozen until signed by every signer, the certain date the day of the last signature, signatures append-only
 *     and one per role, the improvement plan's moves;
 *   - role sheets, their items, kits and requirements; a person's role sheet;
 *   - attendance signed with the person's own PIN on the floor and countersigned once by the trainer; training records
 *     append-only, valid for the refresher period or with a reason, corrected once; the instruction register;
 *   - PPE received with the person's PIN in one of the item's sizes, voided once by the office, never changed; the receipt's
 *     and the frozen DVR's documents of their record's company and site.
 * The refusals are check_violation (SQLSTATE 23514); their messages are read through raw SQL. Dates count from today (Rome).
 */

const NS = 'w2b-87-a'
const DENIED = /permission denied/
const DAY_MS = 86_400_000

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let people: PeopleSeed
let seeded: SafetySeed

const key = (name: string): string => seedUuid(NS, name)
const A = {
  company: key('company:A'),
  site: key('site:A1'),
  companyB: key('company:B'),
  siteB: key('site:B1'),
  operator: key('worker:A1:operator'),
  lead: key('worker:A1:lead'),
  device: key('device:A1:cutting'),
  store: key('files:account:r2'),
}
const office = (): FactoryScope => ({ audience: 'office', tenantId: a.tenantId, actorId: a.actorId })
const floorAs = (worker: string): FactoryScope => ({ audience: 'floor', tenantId: a.tenantId, actorId: worker, siteId: A.site })
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
const sha = (text: string): string => createHash('sha256').update(text).digest('hex')
const today = (): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
const day = (offset: number): string => new Date(Date.parse(`${today()}T00:00:00.000Z`) + offset * DAY_MS).toISOString().slice(0, 10)
const now = () => new Date().toISOString()
/** An uploaded file of a record (office). */
const storeFile = async (recordType: string, recordId: string, companyId = A.company): Promise<string> => {
  const id = randomUUID()
  await insert(office(), 'StoredFile', {
    id, companyId, recordType, recordId, kind: 'DOCUMENT', originalName: 'test.pdf', contentType: 'application/pdf', sizeBytes: 10, sha256: sha(id), storeAccountId: A.store,
    storageKey: `t/${a.tenantId}/test/${id}`, status: 'AVAILABLE', availableAt: now(), visibility: ['OFFICE'],
  })
  return id
}

beforeAll(async () => {
  db = await migratedDatabase('safetyw2b')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: NS })
  await seedNumbering({ db: factory, namespace: NS })
  people = await seedPeople({ db: factory, namespace: NS })
  seeded = await seedSafety({ db: factory, namespace: NS })
}, 1_500_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

describe('grants and the seed', () => {
  it('classifies the eighteen models of the file, none for the partner; personal columns are SAFETY or EMPLOYMENT, never PERFORMANCE', () => {
    const ownership = loadOwnership()
    const models = classifiedModels(loadSchema(), ownership).filter(({ model }) => model.file === 'safety.prisma')
    expect(models.map(({ model }) => model.name).sort()).toEqual([
      'InstructionRecord', 'PpeIssue', 'PpeItem', 'PpeKitLine', 'RiskAssessment', 'RiskAssessmentSignature', 'RiskAssessmentVersion', 'RiskMeasure', 'RlsNotice', 'RoleSheet',
      'RoleSheetItem', 'SafetyAppointment', 'SafetyCourse', 'SafetyDeadline', 'TrainingAttendance', 'TrainingRecord', 'TrainingRequirement', 'TrainingSession',
    ])
    for (const { ownership: entry } of models) expect(Object.keys(entry.access)).not.toContain('factory_partner_runtime')
    const names = new Set(models.map(({ model }) => model.name))
    const personal = personalDataOf(loadSchema(), ownership)
    const mine = personal.filter((entry) => names.has(entry.model))
    expect(mine.map((entry) => entry.model).sort()).toEqual(['InstructionRecord', 'PpeIssue', 'RiskAssessmentSignature', 'SafetyAppointment', 'TrainingAttendance', 'TrainingRecord'])
    for (const entry of mine) for (const purposes of Object.values(entry.columns)) for (const purpose of purposes) expect(['SAFETY', 'EMPLOYMENT']).toContain(purpose)
    expect(personal.find((entry) => entry.model === 'Employee')?.columns.roleSheetId).toEqual(['EMPLOYMENT', 'SAFETY'])
  })

  it('keeps the organisation, deadlines and the DVR from the floor; the floor reads its registers without cost, supplier or reasons; the partner nothing', async () => {
    for (const table of ['SafetyAppointment', 'RlsNotice', 'SafetyDeadline', 'RiskAssessment', 'RiskAssessmentVersion', 'RiskAssessmentSignature', 'RiskMeasure', 'RoleSheetItem']) {
      await expect(sql(floorAs(A.operator), `SELECT id FROM "${table}"`)).rejects.toThrow(DENIED)
    }
    for (const table of ['RoleSheet', 'PpeKitLine', 'TrainingSession', 'TrainingAttendance', 'InstructionRecord']) {
      const rows = await sql(floorAs(A.operator), `SELECT "siteId"::text AS site FROM "${table}"`)
      expect(rows.length, table).toBeGreaterThan(0)
      expect(new Set(rows.map((row) => row.site))).toEqual(new Set([A.site]))
    }
    for (const table of ['SafetyCourse', 'TrainingRequirement', 'PpeItem']) expect((await sql(floorAs(A.operator), `SELECT id FROM "${table}"`)).length, table).toBeGreaterThan(0)
    // Training records tenant-wide: a person who moved site keeps their courses (B1's EB1 shows at A1's tablets, without a name).
    expect((await sql(floorAs(A.operator), `SELECT id FROM "TrainingRecord" WHERE "employeeId" = $1::uuid`, people.employeeIds.eb1)).length).toBe(1)
    for (const [table, column] of [
      ['PpeItem', 'unitCost'],
      ['PpeItem', 'supplierPartyId'],
      ['TrainingRecord', 'trainerName'],
      ['TrainingRecord', 'correctionReason'],
      ['TrainingAttendance', 'voidReason'],
      ['PpeIssue', 'voidReason'],
    ] as const) {
      await expect(sql(floorAs(A.operator), `SELECT "${column}" FROM "${table}"`), `${table}.${column}`).rejects.toThrow(DENIED)
    }
    await expect(run(floorAs(A.operator), `UPDATE "TrainingRecord" SET note = 'x' WHERE false`)).rejects.toThrow(DENIED)
    await expect(run(floorAs(A.operator), `UPDATE "PpeIssue" SET size = 'x' WHERE false`)).rejects.toThrow(DENIED)
    await expect(run(floorAs(A.operator), `DELETE FROM "PpeKitLine" WHERE false`)).rejects.toThrow(DENIED)
    for (const { model } of classifiedModels(loadSchema(), loadOwnership()).filter(({ model }) => model.file === 'safety.prisma')) {
      await expect(sql(partner(), `SELECT id FROM "${model.table}"`), model.name).rejects.toThrow(DENIED)
    }
    for (const table of ['RiskAssessmentSignature', 'TrainingRecord', 'PpeIssue']) {
      await expect(run(office(), `UPDATE "${table}" SET "createdAt" = now() WHERE false`)).rejects.toThrow(DENIED)
      await expect(run(office(), `DELETE FROM "${table}" WHERE false`)).rejects.toThrow(DENIED)
    }
  })

  it('seeds a signed DVR on the day of its last signature, a version waiting, people in roles, a voided issue; a second run writes nothing', async () => {
    expect(await value(`SELECT status::text FROM "RiskAssessmentVersion" WHERE id = $1`, [seeded.versionIds.v1])).toBe('SIGNED')
    expect(await value(`SELECT ("certainDateOn" = (SELECT max("signedOn") FROM "RiskAssessmentSignature" s WHERE s."versionId" = v.id)) FROM "RiskAssessmentVersion" v WHERE id = $1`, [seeded.versionIds.v1])).toBe(true)
    expect(await value(`SELECT status::text FROM "RiskAssessmentVersion" WHERE id = $1`, [seeded.versionIds.v2])).toBe('AWAITING_SIGNATURES')
    expect(await value(`SELECT "roleSheetId"::text FROM "Employee" WHERE id = $1`, [people.employeeIds.e1])).toBe(seeded.roleSheetIds.cutter)
    expect(await value(`SELECT count(*)::int FROM "PpeIssue" WHERE "voidsId" = $1`, [seeded.issueIds.e2Voided])).toBe(1)
    const counted = () =>
      admin(`SELECT (SELECT count(*) FROM "TrainingRecord") r, (SELECT count(*) FROM "PpeIssue") i, (SELECT count(*) FROM "TrainingAttendance") t, (SELECT count(*) FROM "SafetyAppointment") s`)
    const before = await counted()
    await seedSafety({ db: factory, namespace: NS })
    expect(await counted()).toEqual(before)
  })
})

describe('the organisation, the RLS notice and deadlines', () => {
  it('appoints an RLS among the people, an RLST from outside, a team per shift; signs once; never deletes', async () => {
    const appointment = (row: Record<string, unknown>) => insert(office(), 'SafetyAppointment', { id: randomUUID(), companyId: A.company, fromDate: day(-1), ...row })
    await expect(appointment({ role: 'RLS', outsideName: 'Someone outside' })).rejects.toThrow(/an RLS is a person of the company/)
    await expect(appointment({ role: 'RLST', employeeId: people.employeeIds.e1 })).rejects.toThrow(/territorial RLS \(RLST, art\. 48\) is an outside contact/)
    await expect(appointment({ role: 'RSPP', employeeId: people.employeeIds.e1, outsideName: 'Both' })).rejects.toThrow(/exactly one/)
    const shift = await value(`SELECT "shiftPatternId"::text FROM "SafetyAppointment" WHERE "shiftPatternId" IS NOT NULL LIMIT 1`)
    await expect(appointment({ role: 'SUPERVISOR', employeeId: people.employeeIds.e1, shiftPatternId: shift })).rejects.toThrow(/only a first-aid or fire and emergency team/)
    await expect(appointment({ role: 'RSPP', outsideName: 'X', signedAt: now(), signMethod: 'FLOOR_PIN', signedName: 'X', signedById: a.actorId })).rejects.toThrow(/OFFICE or PAPER/)
    await expect(appointment({ role: 'ASPP', employeeId: people.employeeIds.e5 })).rejects.toThrow(/works for the company/)
    expect(await appointment({ role: 'FIRE_EMERGENCY', ...{ siteId: A.site }, employeeId: people.employeeIds.e1, shiftPatternId: shift })).toBe(1)
    await expect(run(office(), `UPDATE "SafetyAppointment" SET "signedName" = 'Another' WHERE id = $1::uuid`, seeded.appointmentIds.rls)).rejects.toThrow(/written once/)
    await expect(run(office(), `UPDATE "SafetyAppointment" SET role = 'RSPP' WHERE id = $1::uuid`, seeded.appointmentIds.rls)).rejects.toThrow(/never change/)
    expect(await run(office(), `UPDATE "SafetyAppointment" SET "untilDate" = $2::date, "endReason" = 'Re-elected later (test)' WHERE id = $1::uuid`, seeded.appointmentIds.rls, day(30))).toBe(1)
    await expect(admin(`DELETE FROM "SafetyAppointment" WHERE id = $1`, [seeded.appointmentIds.rls])).rejects.toThrow(/never deleted/)
  })

  it('files a notice of an RLS with INAIL’s reference; a filed notice changes no more', async () => {
    await expect(insert(office(), 'RlsNotice', { id: randomUUID(), companyId: A.company, appointmentId: seeded.appointmentIds.rspp, dueOn: day(10) })).rejects.toThrow(/notifies an RLS or RLST appointment/)
    const pending = await value(`SELECT id::text FROM "RlsNotice" WHERE status = 'PENDING' AND "appointmentId" = $1`, [seeded.appointmentIds.rlstB])
    await expect(run(office(), `UPDATE "RlsNotice" SET status = 'FILED', "filedOn" = $2::date, "filedById" = $3::uuid WHERE id = $1::uuid`, pending, day(0), a.actorId)).rejects.toThrow(/INAIL's reference|INAIL''s reference/)
    expect(await run(office(), `UPDATE "RlsNotice" SET status = 'FILED', "filedOn" = $2::date, reference = 'TEST-1', "filedById" = $3::uuid WHERE id = $1::uuid`, pending, day(0), a.actorId)).toBe(1)
    await expect(run(office(), `UPDATE "RlsNotice" SET "dueOn" = $2::date WHERE id = $1::uuid`, pending, day(5))).rejects.toThrow(/only its note changes/)
    expect(await run(office(), `UPDATE "RlsNotice" SET note = 'Receipt filed (test)' WHERE id = $1::uuid`, pending)).toBe(1)
  })

  it('marks a deadline done with its evidence when asked; the next one follows a done one, once', async () => {
    const deadline = randomUUID()
    expect(await insert(office(), 'SafetyDeadline', { id: deadline, companyId: A.company, title: 'Fire extinguisher round', kind: 'INSPECTION', dueOn: day(3), evidenceRequired: true, repeatEvery: 6, repeatUnit: 'MONTH' })).toBe(1)
    await expect(insert(office(), 'SafetyDeadline', { id: randomUUID(), companyId: A.company, title: 'x', kind: 'OTHER', dueOn: day(3), repeatEvery: 6 })).rejects.toThrow(/both or neither/)
    const done = () => run(office(), `UPDATE "SafetyDeadline" SET status = 'DONE', "doneAt" = now(), "doneById" = $2::uuid WHERE id = $1::uuid`, deadline, a.actorId)
    await expect(done()).rejects.toThrow(/asks for evidence/)
    await storeFile('SafetyDeadline', deadline)
    expect(await done()).toBe(1)
    await expect(run(office(), `UPDATE "SafetyDeadline" SET title = 'Other' WHERE id = $1::uuid`, deadline)).rejects.toThrow(/only its note changes/)
    const next = (previousId: string, kind = 'INSPECTION') => insert(office(), 'SafetyDeadline', { id: randomUUID(), companyId: A.company, title: 'Fire extinguisher round', kind, dueOn: day(180), previousId })
    const openMeeting = await value(`SELECT id::text FROM "SafetyDeadline" WHERE kind = 'MEETING' AND status = 'OPEN' LIMIT 1`)
    await expect(next(openMeeting as string, 'MEETING')).rejects.toThrow(/done or cancelled/)
    await expect(next(deadline, 'DRILL')).rejects.toThrow(/of its company and kind/)
    expect(await next(deadline)).toBe(1)
    await expect(next(deadline)).rejects.toThrow(/SafetyDeadline_one_next|duplicate key/)
    await expect(admin('TRUNCATE "SafetyDeadline" CASCADE')).rejects.toThrow(/refused/)
  })
})

describe('the risk assessment', () => {
  const signature = (role: string, changes: Record<string, unknown> = {}) => ({
    id: randomUUID(), companyId: A.company, siteId: A.site, versionId: seeded.versionIds.v2, key: `signature:${seeded.versionIds.v2}:${role}`, role, signerName: 'Test signer', signedOn: day(0),
    signedAt: now(), method: 'OFFICE', signedById: a.actorId, ...changes,
  })
  const v2Sha = async () => (await value(`SELECT sha256 FROM "RiskAssessmentVersion" WHERE id = $1`, [seeded.versionIds.v2])) as string

  it('keeps a signature for good, one per role, of the version’s own SHA-256, by one of its signers, while it waits', async () => {
    const first = await value(`SELECT id::text FROM "RiskAssessmentSignature" WHERE "versionId" = $1 AND role = 'EMPLOYER'`, [seeded.versionIds.v2])
    await expect(admin(`UPDATE "RiskAssessmentSignature" SET "signerName" = 'x' WHERE id = $1`, [first])).rejects.toThrow(/never changed or removed/)
    await expect(admin(`DELETE FROM "RiskAssessmentSignature" WHERE id = $1`, [first])).rejects.toThrow(/never changed or removed/)
    await expect(admin('TRUNCATE "RiskAssessmentSignature"')).rejects.toThrow(/never changed or removed/)
    const hash = await v2Sha()
    await expect(insert(office(), 'RiskAssessmentSignature', signature('EMPLOYER', { signatureSha256: hash }))).rejects.toThrow(/duplicate key|RiskAssessmentSignature_tenantId_key_key/)
    await expect(insert(office(), 'RiskAssessmentSignature', signature('ASPP', { signatureSha256: hash }))).rejects.toThrow(/is not signed by the ASPP/)
    await expect(insert(office(), 'RiskAssessmentSignature', signature('RSPP', { signatureSha256: sha('another pdf') }))).rejects.toThrow(/signs the version's SHA-256/)
    await expect(insert(office(), 'RiskAssessmentSignature', signature('RSPP', { signatureSha256: hash, key: `signature:${seeded.versionIds.v1}:RSPP` }))).rejects.toThrow(/has the key signature/)
    await expect(insert(office(), 'RiskAssessmentSignature', signature('RSPP', { signatureSha256: hash, signedOn: day(1) }))).rejects.toThrow(/today at the latest/)
    await expect(insert(office(), 'RiskAssessmentSignature', signature('RSPP', { signatureSha256: hash, method: 'FLOOR_PIN' }))).rejects.toThrow(/exactly one/)
    await expect(insert(office(), 'RiskAssessmentSignature', signature('RSPP', { signatureSha256: hash, appointmentId: seeded.appointmentIds.doctor }))).rejects.toThrow(/names an appointment to that role/)
    const v1Sha = await value(`SELECT sha256 FROM "RiskAssessmentVersion" WHERE id = $1`, [seeded.versionIds.v1])
    await expect(
      insert(office(), 'RiskAssessmentSignature', signature('RSPP', { versionId: seeded.versionIds.v1, key: `signature:${seeded.versionIds.v1}:RSPP:2`, signatureSha256: v1Sha })),
    ).rejects.toThrow(/takes no more signatures/)
  })

  it('numbers a version above the earlier ones, from an uploaded file of its assessment', async () => {
    const version = (changes: Record<string, unknown>) => copyRow(office(), 'RiskAssessmentVersion', seeded.versionIds.v2, { id: randomUUID(), createdAt: now(), ...changes })
    await expect(version({ versionNo: 2 })).rejects.toThrow(/numbered above every earlier version/)
    const otherFile = await storeFile('RiskAssessmentVersion', seeded.versionIds.v2)
    await expect(version({ versionNo: 3, fileId: otherFile })).rejects.toThrow(/file of its assessment and company/)
    await expect(version({ versionNo: 3, signersRequired: ['RSPP', 'RLS'] })).rejects.toThrow(/signed by the employer/)
    await expect(version({ versionNo: 3, signersRequired: ['EMPLOYER', 'RLS', 'RLST'] })).rejects.toThrow(/RLS or RLST/)
    await expect(version({ versionNo: 3, status: 'SIGNED', certainDateOn: day(0), signedAt: now() })).rejects.toThrow(/starts AWAITING_SIGNATURES/)
  })

  it('freezes a version until every signer signed; the certain date is the day of the last signature; then it changes no more', async () => {
    const v2 = seeded.versionIds.v2
    await expect(run(office(), `UPDATE "RiskAssessmentVersion" SET label = 'v2b' WHERE id = $1::uuid`, v2)).rejects.toThrow(/is frozen/)
    const sign = () => run(office(), `UPDATE "RiskAssessmentVersion" SET status = 'SIGNED', "certainDateOn" = $2::date, "signedAt" = now() WHERE id = $1::uuid`, v2, day(0))
    await expect(sign()).rejects.toThrow(/once each of its signers .* has signed/)
    const hash = await v2Sha()
    expect(await insert(office(), 'RiskAssessmentSignature', signature('RSPP', { method: 'PAPER', signatureSha256: hash, appointmentId: seeded.appointmentIds.rspp }))).toBe(1)
    expect(await insert(office(), 'RiskAssessmentSignature', signature('DOCTOR', { signatureSha256: hash, appointmentId: seeded.appointmentIds.doctor }))).toBe(1)
    await expect(run(office(), `UPDATE "RiskAssessmentVersion" SET status = 'SIGNED', "certainDateOn" = $2::date, "signedAt" = now() WHERE id = $1::uuid`, v2, day(-1))).rejects.toThrow(
      /day of its last signature/,
    )
    expect(await sign()).toBe(1)
    await expect(run(office(), `UPDATE "RiskAssessmentVersion" SET status = 'WITHDRAWN', "certainDateOn" = NULL, "signedAt" = NULL, "withdrawnAt" = now(), "withdrawnReason" = 'x' WHERE id = $1::uuid`, v2)).rejects.toThrow(
      /changes no more/,
    )
    await expect(admin(`DELETE FROM "RiskAssessmentVersion" WHERE id = $1`, [v2])).rejects.toThrow(/never deleted/)
  })

  it('moves a measure along the plan; a verified one stays; it names its source and role sheets of its own site', async () => {
    const measure = (changes: Record<string, unknown>) =>
      insert(office(), 'RiskMeasure', { id: randomUUID(), companyId: A.company, siteId: A.site, assessmentId: seeded.assessmentId, title: 'Test measure', source: 'OTHER', ...changes })
    await expect(measure({ source: 'DVR' })).rejects.toThrow(/names its source/)
    await expect(measure({ source: 'INCIDENT' })).rejects.toThrow(/names its source/)
    await expect(measure({ roleSheetIds: [seeded.roleSheetIds.machinistB] })).rejects.toThrow(/role sheets of its own site only/)
    await expect(measure({ cost: -1 })).rejects.toThrow(/a cost from 0/)
    await expect(measure({ status: 'DONE', doneAt: now(), doneById: a.actorId })).rejects.toThrow(/starts PLANNED or IN_PROGRESS/)
    const id = randomUUID()
    expect(await measure({ id, roleSheetIds: [seeded.roleSheetIds.cutter] })).toBe(1)
    await expect(run(office(), `UPDATE "RiskMeasure" SET status = 'VERIFIED', "doneAt" = now(), "doneById" = $2::uuid, "verifiedAt" = now(), "verifiedById" = $2::uuid WHERE id = $1::uuid`, id, a.actorId)).rejects.toThrow(
      /cannot move from PLANNED to VERIFIED/,
    )
    await expect(run(office(), `UPDATE "RiskMeasure" SET status = 'DONE' WHERE id = $1::uuid`, id)).rejects.toThrow(/wrong times/)
    expect(await run(office(), `UPDATE "RiskMeasure" SET status = 'DONE', "doneAt" = now(), "doneById" = $2::uuid WHERE id = $1::uuid`, id, a.actorId)).toBe(1)
    expect(await run(office(), `UPDATE "RiskMeasure" SET status = 'VERIFIED', "verifiedAt" = now(), "verifiedById" = $2::uuid WHERE id = $1::uuid`, id, a.actorId)).toBe(1)
    await expect(run(office(), `UPDATE "RiskMeasure" SET title = 'Other' WHERE id = $1::uuid`, id)).rejects.toThrow(/only its note changes/)
    await expect(run(office(), `UPDATE "RiskMeasure" SET source = 'MEETING' WHERE id = $1::uuid`, id)).rejects.toThrow(/never change/)
  })
})

describe('role sheets, kits and requirements', () => {
  it('archives a sheet nobody active is in; a person gets an ACTIVE sheet of their own site; an archived sheet changes no more', async () => {
    await expect(run(office(), `UPDATE "RoleSheet" SET status = 'ARCHIVED' WHERE id = $1::uuid`, seeded.roleSheetIds.cutter)).rejects.toThrow(/nobody active is in the role/)
    await expect(run(office(), `UPDATE "RoleSheet" SET code = 'CUTTER' WHERE id = $1::uuid`, seeded.roleSheetIds.cutter)).rejects.toThrow(/never change/)
    await expect(insert(office(), 'RoleSheet', { id: randomUUID(), companyId: A.company, siteId: A.site, code: 'A B', name: 'x' })).rejects.toThrow(/no spaces/)
    const sheet = randomUUID()
    expect(await insert(office(), 'RoleSheet', { id: sheet, companyId: A.company, siteId: A.site, code: 'PACK', name: 'Packer', nameI18n: { it: 'Imballatore' } })).toBe(1)
    expect(await run(office(), `UPDATE "RoleSheet" SET status = 'ARCHIVED' WHERE id = $1::uuid`, sheet)).toBe(1)
    await expect(run(office(), `UPDATE "Employee" SET "roleSheetId" = $2::uuid WHERE id = $1::uuid`, people.employeeIds.e3, sheet)).rejects.toThrow(/ACTIVE role sheet/)
    await expect(run(office(), `UPDATE "Employee" SET "roleSheetId" = $2::uuid WHERE id = $1::uuid`, people.employeeIds.e3, seeded.roleSheetIds.machinistB)).rejects.toThrow(/foreign key/)
    await expect(insert(office(), 'RoleSheetItem', { id: randomUUID(), siteId: A.site, roleSheetId: sheet, seq: 1, kind: 'RISK', title: 'x' })).rejects.toThrow(/archived; its risks/)
    await expect(insert(office(), 'PpeKitLine', { id: randomUUID(), siteId: A.site, roleSheetId: sheet, seq: 1, ppeItemId: seeded.ppeItemIds.shoes, whenToWear: 'x' })).rejects.toThrow(/its kit no longer changes/)
    await expect(admin(`DELETE FROM "RoleSheet" WHERE id = $1`, [sheet])).rejects.toThrow(/never deleted/)
  })

  it('a kit takes an ACTIVE item of the sheet’s company; a requirement names one source and keeps its course', async () => {
    await expect(insert(office(), 'PpeKitLine', { id: randomUUID(), siteId: A.site, roleSheetId: seeded.roleSheetIds.cutter, seq: 9, ppeItemId: seeded.ppeItemIds.apron, whenToWear: 'x' })).rejects.toThrow(
      /ACTIVE PPE item of its company/,
    )
    await expect(insert(office(), 'PpeKitLine', { id: randomUUID(), siteId: A.site, roleSheetId: seeded.roleSheetIds.cutter, seq: 9, ppeItemId: seeded.ppeItemIds.shoes, whenToWear: 'x', quantity: 100 })).rejects.toThrow(
      /1 to 99/,
    )
    const requirement = await value(`SELECT id::text FROM "TrainingRequirement" WHERE source = 'MACHINE_CLASS' LIMIT 1`)
    await expect(copyRow(office(), 'TrainingRequirement', requirement as string, { id: randomUUID(), roleSheetId: seeded.roleSheetIds.cutter })).rejects.toThrow(/exactly one/)
    await expect(run(office(), `UPDATE "TrainingRequirement" SET "courseId" = $2::uuid WHERE id = $1::uuid`, requirement, seeded.courseIds.general)).rejects.toThrow(/keeps its source and course/)
    expect(await run(office(), `UPDATE "TrainingRequirement" SET "withinDays" = 30 WHERE id = $1::uuid`, requirement)).toBe(1)
    await expect(run(office(), `UPDATE "SafetyCourse" SET type = 'OTHER' WHERE id = $1::uuid`, seeded.courseIds.general)).rejects.toThrow(/never change/)
    await expect(run(office(), `UPDATE "SafetyCourse" SET "refresherHours" = 4 WHERE id = $1::uuid`, seeded.courseIds.general)).rejects.toThrow(/its hours only with it/)
  })
})

describe('training', () => {
  const session = randomUUID()
  const attendance = (worker: string | null, employeeId: string, changes: Record<string, unknown> = {}) => ({
    id: randomUUID(), siteId: A.site, sessionId: session, employeeId, key: `attendance:${session}:${employeeId}`, method: worker ? 'FLOOR_PIN' : 'PAPER', signedAt: now(),
    ...(worker ? { signedByWorkerId: worker, deviceId: A.device, clientEventId: randomUUID(), signatureSha256: sha(`${session}${employeeId}`) } : {}),
    ...changes,
  })

  it('signs attendance on the floor with the person’s own PIN, once; the office records only paper', async () => {
    expect(
      await insert(office(), 'TrainingSession', {
        id: session, companyId: A.company, siteId: A.site, courseId: seeded.courseIds.general, heldOn: day(0), hours: 4, language: 'it', trainerEmployeeId: people.employeeIds.e2, trainerName: 'Seed Employee Two', openedById: a.actorId,
      }),
    ).toBe(1)
    const e1 = attendance(A.operator, people.employeeIds.e1)
    expect(await insert(floorAs(A.operator), 'TrainingAttendance', e1)).toBe(1)
    await expect(insert(floorAs(A.operator), 'TrainingAttendance', attendance(A.operator, people.employeeIds.e3))).rejects.toThrow(/signed by the person themselves/)
    await expect(insert(floorAs(A.operator), 'TrainingAttendance', attendance(null, people.employeeIds.e3))).rejects.toThrow(/recorded from paper only by the office/)
    await expect(insert(office(), 'TrainingAttendance', attendance(A.lead, people.employeeIds.e2))).rejects.toThrow(/recorded from paper only by the office/)
    await expect(insert(floorAs(A.operator), 'TrainingAttendance', { ...attendance(A.operator, people.employeeIds.e1) })).rejects.toThrow(/duplicate key/)
    await expect(insert(office(), 'TrainingAttendance', attendance(null, people.employeeIds.e5))).rejects.toThrow(/works for the session's company/)
    await expect(insert(office(), 'TrainingAttendance', attendance(null, people.employeeIds.eb1))).rejects.toThrow(/works for the session's company/)
    await expect(insert(office(), 'TrainingAttendance', attendance(null, people.employeeIds.e3, { method: 'OFFICE' }))).rejects.toThrow(/badge and PIN/)
    expect(await insert(office(), 'TrainingAttendance', attendance(null, people.employeeIds.e3))).toBe(1)
    // A floor row at another site is the policies' to refuse, whatever it says.
    const b1 = { siteId: A.siteB, sessionId: seeded.sessionIds.b1, key: `attendance:${seeded.sessionIds.b1}:${people.employeeIds.eb1}:x` }
    await expect(insert(floorAs(A.operator), 'TrainingAttendance', attendance(null, people.employeeIds.eb1, b1))).rejects.toThrow(/row-level security/)
  })

  it('is countersigned once by the session’s trainer; the floor changes nothing else; a closed session stops signing', async () => {
    const e1 = (await value(`SELECT id::text FROM "TrainingAttendance" WHERE "sessionId" = $1 AND "employeeId" = $2`, [session, people.employeeIds.e1])) as string
    const countersign = (worker: string) =>
      run(floorAs(worker), `UPDATE "TrainingAttendance" SET "countersignedAt" = now(), "countersignMethod" = 'FLOOR_PIN', "countersignedByWorkerId" = $2::uuid, "languageUnderstood" = true WHERE id = $1::uuid`, e1, worker)
    await expect(countersign(A.operator)).rejects.toThrow(/countersigned on the floor by the session's trainer/)
    await expect(run(floorAs(A.lead), `UPDATE "TrainingAttendance" SET "signedAt" = now() WHERE id = $1::uuid`, e1)).rejects.toThrow(/never change/)
    expect(await countersign(A.lead)).toBe(1)
    await expect(countersign(A.lead)).rejects.toThrow(/countersigned once/)
    await expect(run(floorAs(A.lead), `UPDATE "TrainingAttendance" SET "voidedAt" = now() WHERE id = $1::uuid`, e1)).rejects.toThrow(/voided exactly with/)
    const e3 = (await value(`SELECT id::text FROM "TrainingAttendance" WHERE "sessionId" = $1 AND "employeeId" = $2`, [session, people.employeeIds.e3])) as string
    await expect(run(office(), `UPDATE "TrainingAttendance" SET "countersignedAt" = now(), "countersignMethod" = 'FLOOR_PIN', "countersignedByWorkerId" = $2::uuid WHERE id = $1::uuid`, e3, A.lead)).rejects.toThrow(
      /the office records OFFICE or PAPER/,
    )
    expect(await run(office(), `UPDATE "TrainingAttendance" SET "voidedAt" = now(), "voidedById" = $2::uuid, "voidReason" = 'Was not there (test)' WHERE id = $1::uuid`, e3, a.actorId)).toBe(1)
    await expect(run(office(), `UPDATE "TrainingAttendance" SET "languageUnderstood" = true WHERE id = $1::uuid`, e3)).rejects.toThrow(/voided; it changes no more/)
    await expect(admin(`DELETE FROM "TrainingAttendance" WHERE id = $1`, [e3])).rejects.toThrow(/never deleted/)
    expect(await run(office(), `UPDATE "TrainingSession" SET status = 'CLOSED', "closedAt" = now(), "closedById" = $2::uuid WHERE id = $1::uuid`, session, a.actorId)).toBe(1)
    await expect(insert(floorAs(A.lead), 'TrainingAttendance', attendance(A.lead, people.employeeIds.e2))).rejects.toThrow(/signing has stopped/)
    await expect(run(office(), `UPDATE "TrainingSession" SET hours = 5 WHERE id = $1::uuid`, session)).rejects.toThrow(/only its note changes/)
  })

  it('keeps training records for good: valid for the refresher period or with a reason, from a countersigned attendance once, corrected once', async () => {
    const months = async (from: string, count: number): Promise<string> => (await value(`SELECT ($1::date + make_interval(months => $2))::date::text`, [from, count])) as string
    const until60 = await months(day(-10), 60)
    const record = (changes: Record<string, unknown>) =>
      insert(office(), 'TrainingRecord', {
        id: randomUUID(), companyId: A.company, employeeId: people.employeeIds.e2, courseId: seeded.courseIds.specificHigh, completedOn: day(-10), hours: 12, trainerName: 'Test trainer', result: 'PASSED',
        validUntil: until60, language: 'it', ...changes,
      })
    await expect(admin(`UPDATE "TrainingRecord" SET note = 'x' WHERE id = $1`, [seeded.recordIds.first])).rejects.toThrow(/never changed or removed/)
    await expect(admin('TRUNCATE "TrainingRecord" CASCADE')).rejects.toThrow(/never changed or removed/)
    expect(await record({})).toBe(1)
    const shorter = await months(day(-10), 12)
    await expect(record({ validUntil: shorter })).rejects.toThrow(/plus the course's refresher period/)
    expect(await record({ validUntil: shorter, validUntilReason: 'The certificate says one year (test)' })).toBe(1)
    await expect(record({ validUntilReason: 'Not needed' })).rejects.toThrow(/the reason only then/)
    await expect(record({ completedOn: day(1) })).rejects.toThrow(/today at the latest/)
    await expect(record({ result: 'FAILED' })).rejects.toThrow(/valid for nothing/)
    await expect(record({ result: 'VOID', validUntil: null, hours: 0 })).rejects.toThrow(/VOID is only a correction/)
    await expect(record({ courseId: seeded.courseIds.general, correctsId: seeded.recordIds.e1Expired, correctionReason: 'x', validUntil: null })).rejects.toThrow(/same person and course/)
    const corrected = await value(`SELECT "correctsId"::text FROM "TrainingRecord" WHERE "correctsId" IS NOT NULL AND result = 'PASSED' LIMIT 1`)
    const original = await admin(`SELECT "employeeId"::text AS e, "courseId"::text AS c, "completedOn"::text AS d FROM "TrainingRecord" WHERE id = $1`, [corrected])
    await expect(
      record({ employeeId: original[0]!.e, courseId: original[0]!.c, result: 'VOID', hours: 0, validUntil: null, correctsId: corrected, correctionReason: 'Again (test)' }),
    ).rejects.toThrow(/corrected_once|duplicate key/)
    // S1's attendance of E1 is not countersigned yet; S0's of E1 already has its record.
    await expect(
      record({ employeeId: people.employeeIds.e1, sessionId: seeded.sessionIds.open, attendanceId: seeded.attendanceIds.e1Open, completedOn: day(0), validUntil: await months(day(0), 60) }),
    ).rejects.toThrow(/countersigned by the trainer/)
    await expect(
      record({ employeeId: people.employeeIds.e1, courseId: seeded.courseIds.general, sessionId: seeded.sessionIds.closed, attendanceId: seeded.attendanceIds.e1Closed, completedOn: day(-30), validUntil: null }),
    ).rejects.toThrow(/one_per_attendance|duplicate key/)
    await expect(record({ attendanceId: seeded.attendanceIds.e1Closed })).rejects.toThrow(/attendance with its session/)
  })

  it('lets the person sign an instruction entry on the floor, once; the office writes and voids it', async () => {
    const entry = seeded.instructionIds.unsigned
    const signAs = (worker: string) =>
      run(floorAs(worker), `UPDATE "InstructionRecord" SET "signedAt" = now(), "signMethod" = 'FLOOR_PIN', "signedByWorkerId" = $2::uuid, "signatureSha256" = $3 WHERE id = $1::uuid`, entry, worker, sha(entry))
    await expect(signAs(A.lead)).rejects.toThrow(/not their floor sign-in/)
    await expect(run(floorAs(A.operator), `UPDATE "InstructionRecord" SET minutes = 10 WHERE id = $1::uuid`, entry)).rejects.toThrow(/only signed by the person/)
    expect(await signAs(A.operator)).toBe(1)
    await expect(signAs(A.operator)).rejects.toThrow(/only voided now/)
    await expect(run(office(), `UPDATE "InstructionRecord" SET minutes = 10 WHERE id = $1::uuid`, entry)).rejects.toThrow(/only voided now/)
    const fresh = randomUUID()
    expect(
      await insert(office(), 'InstructionRecord', {
        id: fresh, companyId: A.company, siteId: A.site, employeeId: people.employeeIds.e1, instructedOn: day(0), task: 'Use the press two-hand control', instructorEmployeeId: people.employeeIds.e2,
        instructorName: 'Seed Employee Two', minutes: 20, language: 'it',
      }),
    ).toBe(1)
    await expect(copyRow(office(), 'InstructionRecord', fresh, { id: randomUUID(), instructorEmployeeId: people.employeeIds.e1 })).rejects.toThrow(/never the person instructed/)
    await expect(copyRow(office(), 'InstructionRecord', fresh, { id: randomUUID(), instructedOn: day(1) })).rejects.toThrow(/today at the latest/)
    await expect(run(office(), `UPDATE "InstructionRecord" SET "signedAt" = now(), "signMethod" = 'FLOOR_PIN', "signedByWorkerId" = $2::uuid, "signatureSha256" = $3 WHERE id = $1::uuid`, fresh, A.operator, sha(fresh))).rejects.toThrow(
      /on the floor with the PIN/,
    )
    await expect(run(floorAs(A.operator), `UPDATE "InstructionRecord" SET "voidedAt" = now() WHERE id = $1::uuid`, fresh)).rejects.toThrow(/voided exactly with/)
    expect(await run(office(), `UPDATE "InstructionRecord" SET "voidedAt" = now(), "voidedById" = $2::uuid, "voidReason" = 'Typed for the wrong day (test)' WHERE id = $1::uuid`, fresh, a.actorId)).toBe(1)
    await expect(run(office(), `UPDATE "InstructionRecord" SET note = 'x' WHERE id = $1::uuid`, fresh)).rejects.toThrow(/voided; it changes no more/)
  })
})

describe('PPE for workers', () => {
  const floorIssue = (changes: Record<string, unknown>) => ({
    id: randomUUID(), companyId: A.company, siteId: A.site, kind: 'ISSUE', employeeId: people.employeeIds.e1, ppeItemId: seeded.ppeItemIds.gloves, size: '8', quantity: 1, reason: 'REPLACEMENT', issuedAt: now(),
    method: 'FLOOR_PIN', signedByWorkerId: A.operator, deviceId: A.device, clientEventId: randomUUID(), signatureSha256: sha(randomUUID()), ...changes,
  })

  it('takes PPE received on the floor with the person’s own PIN, in one of the item’s sizes; the office records paper', async () => {
    await expect(insert(floorAs(A.operator), 'PpeIssue', floorIssue({ size: '11' }))).rejects.toThrow(/one of item SEED-PPE-GLOVES-CUT's sizes/)
    await expect(insert(floorAs(A.operator), 'PpeIssue', floorIssue({ ppeItemId: seeded.ppeItemIds.earDefenders, size: 'M' }))).rejects.toThrow(/one-size/)
    await expect(insert(floorAs(A.operator), 'PpeIssue', floorIssue({ signedByWorkerId: A.lead }))).rejects.toThrow(/not their floor sign-in/)
    await expect(insert(floorAs(A.operator), 'PpeIssue', floorIssue({ reason: null }))).rejects.toThrow(/its reason and its receipt/)
    await expect(insert(floorAs(A.operator), 'PpeIssue', floorIssue({ quantity: 100 }))).rejects.toThrow(/1 to 99/)
    const paper = { method: 'PAPER', signedByWorkerId: null, deviceId: null, clientEventId: null, signatureSha256: null }
    await expect(insert(floorAs(A.operator), 'PpeIssue', floorIssue(paper))).rejects.toThrow(/the office records only a paper receipt/)
    await expect(insert(office(), 'PpeIssue', floorIssue({}))).rejects.toThrow(/the office records only a paper receipt/)
    await expect(insert(office(), 'PpeIssue', floorIssue({ ...paper, employeeId: people.employeeIds.e5 }))).rejects.toThrow(/works for the company/)
    expect(await insert(floorAs(A.operator), 'PpeIssue', floorIssue({ issuedByWorkerId: A.lead }))).toBe(1)
    expect(await insert(office(), 'PpeIssue', floorIssue({ ...paper, issuedById: a.actorId }))).toBe(1)
    // A floor row at another site is the policies' to refuse, whatever it says.
    await expect(insert(floorAs(A.operator), 'PpeIssue', floorIssue({ ...paper, companyId: A.companyB, siteId: A.siteB, employeeId: people.employeeIds.eb1, ppeItemId: seeded.ppeItemIds.apron, size: 'M' }))).rejects.toThrow(
      /row-level security/,
    )
  })

  it('voids an issue once, by the office, copying it; never changes or removes one', async () => {
    const issued = seeded.issueIds.e1Floor
    const voidRow = (changes: Record<string, unknown> = {}) => ({
      id: randomUUID(), companyId: A.company, siteId: A.site, kind: 'VOID', employeeId: people.employeeIds.e1, ppeItemId: seeded.ppeItemIds.gloves, size: '9', quantity: 2, issuedAt: now(),
      voidsId: issued, voidReason: 'Handed to the wrong person (test)', ...changes,
    })
    await expect(insert(office(), 'PpeIssue', voidRow({ size: '10' }))).rejects.toThrow(/copies its person, item, size and quantity/)
    await expect(insert(office(), 'PpeIssue', voidRow({ voidReason: ' ' }))).rejects.toThrow(/names the issue it voids and why/)
    await expect(insert(office(), 'PpeIssue', voidRow({ reason: 'NEW' }))).rejects.toThrow(/nothing of a receipt/)
    const { voidReason: _reason, ...withoutReason } = voidRow()
    await expect(insert(floorAs(A.operator), 'PpeIssue', withoutReason)).rejects.toThrow(/names the issue it voids and why/)
    expect(await insert(office(), 'PpeIssue', voidRow())).toBe(1)
    await expect(insert(office(), 'PpeIssue', voidRow())).rejects.toThrow(/PpeIssue_voided_once|duplicate key/)
    await expect(admin(`UPDATE "PpeIssue" SET quantity = 3 WHERE id = $1`, [issued])).rejects.toThrow(/never changed or removed/)
    await expect(admin(`DELETE FROM "PpeIssue" WHERE id = $1`, [issued])).rejects.toThrow(/never changed or removed/)
    await expect(admin('TRUNCATE "PpeIssue" CASCADE')).rejects.toThrow(/never changed or removed/)
  })

  it('keeps a PPE receipt and a frozen DVR to their record’s company and site', async () => {
    const document = (recordType: string, recordId: string, kind: string, companyId: string, siteId: string, fileId: string) =>
      insert(office(), 'GeneratedDocument', { id: randomUUID(), companyId, siteId, recordType, recordId, kind, version: 9, fingerprint: sha(randomUUID()), language: 'it', fileId })
    const b1File = await storeFile('PpeIssue', seeded.issueIds.b1Paper, A.companyB)
    await expect(document('PpeIssue', seeded.issueIds.b1Paper, 'PPE_RECEIPT', A.company, A.site, b1File)).rejects.toThrow(/company and site of its PpeIssue/)
    expect(await document('PpeIssue', seeded.issueIds.b1Paper, 'PPE_RECEIPT', A.companyB, A.siteB, b1File)).toBe(1)
    const v1File = await storeFile('RiskAssessmentVersion', seeded.versionIds.v1)
    await expect(document('RiskAssessmentVersion', seeded.versionIds.v1, 'DVR_FROZEN', A.companyB, A.siteB, v1File)).rejects.toThrow(/company and site of its RiskAssessmentVersion/)
    await expect(document('RiskAssessmentVersion', seeded.versionIds.v1, 'PPE_RECEIPT', A.company, A.site, v1File)).rejects.toThrow(/a PPE receipt a PpeIssue's/)
    expect(await document('RiskAssessmentVersion', seeded.versionIds.v1, 'DVR_FROZEN', A.company, A.site, v1File)).toBe(1)
    for (const table of ['PpeKitLine', 'RoleSheetItem', 'InstructionRecord', 'RlsNotice']) await expect(admin(`TRUNCATE "${table}"`), table).rejects.toThrow(/refused/)
    // B-W2b-91: an incident action references a measure, so RiskMeasure is truncated only together with IncidentAction (refused too).
    await expect(admin('TRUNCATE "RiskMeasure", "IncidentAction"'), 'RiskMeasure').rejects.toThrow(/refused/)
  })
})
