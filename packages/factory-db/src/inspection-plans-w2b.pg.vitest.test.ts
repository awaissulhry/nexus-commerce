import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedInspectionPlans, type InspectionPlansSeed } from '../seed/inspection-plans'
import { seed as seedPeople, type PeopleSeed } from '../seed/people'
import { seed as seedSubcontractReceipts, type SubcontractReceiptsSeed } from '../seed/subcontract-receipts'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { classifiedModels, personalDataOf } from './ownership'
import { RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'
import { loadOwnership, loadSchema } from './tools'

/**
 * The inspection plans and records schema (W2b schema wave 10/16, B-W2b-76, …_inspection_plans_w2b_guards) on a database
 * built from the migrations and seeded, through the real login and the scoped client:
 *   - grants: the office keeps plans, the floor reads them and records on its site, neither the partner nor the floor sees
 *     a trigger rule or an amendment;
 *   - plans: a version approved by a second person and then frozen with its checks, one APPROVED per plan;
 *   - AQL: critical locked at 0, one default per company, one active assignment per subject;
 *   - a final inspection keeps W1's rules and gains the frozen version; an inspection without a plan is decided as before;
 *   - incoming inspections: subject, sample, the three quantities add up, the computed result, whole-lot rules; hides,
 *     rolls and components only while OPEN;
 *   - in-process checks: where, outcome per kind, the first-piece hold on a scan, the operator only behind the gate;
 *   - results and measurements: one record, its frozen version, values by type, the verdict from the numbers;
 *   - amendments: append-only, on a signed record, signed by a second person, one answer per request;
 *   - INCOMING_INSPECTION is a floor document kind.
 * The refusals are check_violation (SQLSTATE 23514); their messages are read through raw SQL.
 */

const NS = 'w2b-76-a'

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let plans: InspectionPlansSeed
let people: PeopleSeed
let receipts: SubcontractReceiptsSeed

const key = (name: string): string => seedUuid(NS, name)
const A = { company: key('company:A'), site: key('site:A1') }
const office = (): FactoryScope => ({ audience: 'office', tenantId: a.tenantId, actorId: a.actorId })
const floor = (): FactoryScope => ({ audience: 'floor', tenantId: a.tenantId, actorId: randomUUID(), siteId: A.site })
const partner = (): FactoryScope => ({ audience: 'partner', tenantId: a.tenantId, actorId: a.actorId, partyId: key('party:P1') })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const run = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$executeRawUnsafe(text, ...values))
const sql = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$queryRawUnsafe<Record<string, unknown>[]>(text, ...values))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, unknown>[]
/** INSERT a copy of row `id` of `table` with `changes` (a jsonb object of columns). */
const copyRow = (scope: FactoryScope, table: string, id: string, changes: Record<string, unknown>) =>
  run(scope, `INSERT INTO "${table}" SELECT * FROM jsonb_populate_record(NULL::"${table}", (SELECT to_jsonb(r) || $1::jsonb FROM "${table}" r WHERE r.id = $2::uuid))`, JSON.stringify(changes), id)
/** A write past the database's guards (the seed's facts only: never what the test then proves). */
async function force(text: string, values: unknown[] = []): Promise<void> {
  await admin('SET session_replication_role = replica')
  try {
    await admin(text, values)
  } finally {
    await admin('SET session_replication_role = DEFAULT')
  }
}
const SHA = 'a'.repeat(64)
const AT = '2026-11-20T10:00:00.000Z'

/** A fresh DRAFT version of the incoming plan, with one check. */
async function draftVersion(): Promise<{ versionId: string; checkId: string }> {
  const versionId = randomUUID()
  const checkId = randomUUID()
  await copyRow(office(), 'InspectionPlanVersion', plans.versionIds.finalDraft, { id: versionId, planId: plans.planIds.incoming, number: Math.floor(Math.random() * 1_000_000) + 100 })
  await copyRow(office(), 'InspectionPlanCheck', plans.checkIds.draft, { id: checkId, planVersionId: versionId, code: `C${randomUUID().slice(0, 8)}` })
  return { versionId, checkId }
}
const approve = (versionId: string, by: string) =>
  run(office(), `UPDATE "InspectionPlanVersion" SET status = 'APPROVED', "approvedById" = $1::uuid, "approvedAt" = now(), "approvalSha256" = $2 WHERE id = $3::uuid`, by, SHA, versionId)

/** A fresh OPEN incoming inspection of the seeded lot, with no units or results. */
async function openIncoming(changes: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID()
  await copyRow(office(), 'IncomingInspection', plans.openIncomingId, { id, number: `T-IIN-${id.slice(0, 8)}`, ...changes })
  return id
}
const decideIncoming = (id: string, accepted: number, rejected: number, toSort: number, extra = '') =>
  run(
    office(),
    `UPDATE "IncomingInspection" SET status = 'DECIDED', "decidedAt" = now(), "signatureSha256" = $1, "acceptedQuantity" = $2, "rejectedQuantity" = $3, "toSortQuantity" = $4 ${extra} WHERE id = $5::uuid`,
    SHA,
    accepted,
    rejected,
    toSort,
    id,
  )
/** A result of the incoming plan's shade check on an incoming inspection. */
const shadeResult = (incomingInspectionId: string, outcome = 'PASS', value = '1') =>
  copyRow(office(), 'InspectionCheckResult', plansRow('result'), { id: randomUUID(), incomingInspectionId, outcome, value })
let plansRowIds: Record<string, string>
const plansRow = (name: string): string => plansRowIds[name] as string

/** A fresh in-process check, a copy of the seeded roving check. */
async function check(changes: Record<string, unknown>, scope: FactoryScope = office()): Promise<string> {
  const id = randomUUID()
  await copyRow(scope, 'InProcessCheck', plans.rovingId, { id, ...changes })
  return id
}
const firstPiece = (workOrderOperationId: string, bundleId: string, extra: Record<string, unknown> = {}) =>
  check({ kind: 'FIRST_PIECE', status: 'OPEN', outcome: null, decidedAt: null, pieces: 0, bundleId, workOrderOperationId, ...extra })

/** What a floor scan of this kind says: null when it goes through, the refusal otherwise. */
async function scanError(kind: string, bundleId: string, workOrderOperationId: string): Promise<string | null> {
  try {
    await copyRow(floor(), 'OperationScan', plansRow('scan'), {
      id: randomUUID(),
      kind,
      workOrderId: plans.workOrderId,
      bundleId,
      workOrderOperationId,
      clientScanId: randomUUID(),
      correctsId: null,
      reason: null,
      approvedById: null,
    })
    return null
  } catch (error) {
    return (error as Error).message
  }
}

beforeAll(async () => {
  db = await migratedDatabase('inspectionplansw2b')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: NS })
  plans = await seedInspectionPlans({ db: factory, namespace: NS })
  people = await seedPeople({ db: factory, namespace: NS })
  receipts = await seedSubcontractReceipts({ db: factory, namespace: NS })
  const [{ id: result } = {}] = await admin(`SELECT id::text AS id FROM "InspectionCheckResult" WHERE "incomingInspectionId" = $1 LIMIT 1`, [plans.openIncomingId])
  const [{ id: scan } = {}] = await admin(`SELECT id::text AS id FROM "OperationScan" WHERE "tenantId" = $1 AND kind = 'REPORT' ORDER BY id LIMIT 1`, [a.tenantId])
  plansRowIds = { result: String(result), scan: String(scan) }
}, 180_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

describe('grants', () => {
  it('classifies the fourteen models of the file, none with a partner grant, and only the operator of a check as personal data', () => {
    const models = classifiedModels(loadSchema(), loadOwnership()).filter(({ model }) => model.file === 'inspection-plans.prisma')
    expect(models.map(({ model }) => model.name).sort()).toEqual([
      'AqlProfile',
      'AqlProfileAssignment',
      'InProcessCheck',
      'IncomingComponentResult',
      'IncomingHideResult',
      'IncomingInspection',
      'IncomingRollResult',
      'InspectionAmendment',
      'InspectionCheckResult',
      'InspectionMeasurement',
      'InspectionPlan',
      'InspectionPlanCheck',
      'InspectionPlanVersion',
      'InspectionTrigger',
    ])
    for (const { ownership } of models) expect(Object.keys(ownership.access)).not.toContain('factory_partner_runtime')
    expect(personalDataOf(loadSchema(), loadOwnership()).filter((entry) => entry.table === 'InProcessCheck')).toEqual([
      expect.objectContaining({ subject: 'employeeId', columns: { workerId: ['PRODUCTION', 'PERFORMANCE'] } }),
    ])
  })

  it('the floor reads plans and profiles, never writes them, and never sees a rule or an amendment', async () => {
    expect((await sql(floor(), 'SELECT id FROM "InspectionPlan"')).length).toBe(3)
    expect((await sql(floor(), 'SELECT id FROM "AqlProfile"')).length).toBe(2)
    await expect(run(floor(), `UPDATE "InspectionPlan" SET name = 'x' WHERE id = $1::uuid`, plans.planIds.final)).rejects.toThrow(/permission denied/)
    await expect(sql(floor(), 'SELECT id FROM "InspectionTrigger"')).rejects.toThrow(/permission denied/)
    await expect(sql(floor(), 'SELECT id FROM "InspectionAmendment"')).rejects.toThrow(/permission denied/)
  })

  it('portal and link sessions read nothing here', async () => {
    for (const table of ['InspectionPlan', 'IncomingInspection', 'InProcessCheck', 'InspectionCheckResult', 'InspectionAmendment']) {
      await expect(sql(partner(), `SELECT id FROM "${table}"`)).rejects.toThrow(/permission denied/)
    }
  })
})

describe('plans and versions (QHS-008, QHS-009, QHS-016)', () => {
  it('the seed tells its story and the plan stays of its stage', async () => {
    expect(await admin(`SELECT p.code, v.number, v.status::text AS status FROM "InspectionPlanVersion" v JOIN "InspectionPlan" p ON p.id = v."planId" WHERE v."tenantId" = $1 ORDER BY 1, 2`, [a.tenantId])).toEqual([
      { code: 'FIN-JACKET', number: 1, status: 'APPROVED' },
      { code: 'FIN-JACKET', number: 2, status: 'DRAFT' },
      { code: 'INC-LEATHER', number: 1, status: 'APPROVED' },
      { code: 'INL-FIRST', number: 1, status: 'APPROVED' },
    ])
    await expect(run(office(), `UPDATE "InspectionPlan" SET stage = 'INCOMING' WHERE id = $1::uuid`, plans.planIds.final)).rejects.toThrow(/never change/)
    await expect(run(office(), `UPDATE "InspectionPlan" SET code = 'OTHER' WHERE id = $1::uuid`, plans.planIds.final)).rejects.toThrow(/never change/)
    await expect(run(office(), `UPDATE "InspectionPlan" SET "appliesTo" = '[{"kind":"PLANET","value":"x"}]' WHERE id = $1::uuid`, plans.planIds.final)).rejects.toThrow(/\{ kind, value \} chips/)
    await expect(run(office(), `UPDATE "InspectionPlan" SET "appliesTo" = '{}' WHERE id = $1::uuid`, plans.planIds.final)).rejects.toThrow(/\{ kind, value \} chips/)
    expect(await run(office(), `UPDATE "InspectionPlan" SET "appliesTo" = '[{"kind":"CATEGORY","value":"JACKET"},{"kind":"CUSTOMER","value":"x"}]' WHERE id = $1::uuid`, plans.planIds.final)).toBe(1)
    await expect(admin(`DELETE FROM "InspectionPlan" WHERE id = $1`, [plans.planIds.final])).rejects.toThrow(/never deleted/)
  })

  it('a version starts DRAFT, and its sampling and frequency must make sense', async () => {
    const copy = (changes: Record<string, unknown>) => copyRow(office(), 'InspectionPlanVersion', plans.versionIds.finalDraft, { id: randomUUID(), number: 500, ...changes })
    await expect(copy({ status: 'APPROVED' })).rejects.toThrow(/starts DRAFT/)
    await expect(copy({ samplingMethod: 'FIXED' })).rejects.toThrow(/AQL profile or a fixed number/)
    await expect(copy({ fixedSampleSize: 3 })).rejects.toThrow(/AQL profile or a fixed number/)
    await expect(copy({ samplingMethod: 'FIXED', fixedSampleSize: 3, aqlProfileId: plans.profileIds.standard })).rejects.toThrow(/AQL profile or a fixed number/)
    await expect(copy({ frequency: 'PERCENT_OF_OPERATIONS' })).rejects.toThrow(/percent from 1 to 100/)
    await expect(copy({ frequency: 'PERCENT_OF_OPERATIONS', frequencyValue: 101 })).rejects.toThrow(/percent from 1 to 100/)
    await expect(copy({ frequency: 'EVERY_LOT', frequencyValue: 5 })).rejects.toThrow(/percent from 1 to 100/)
    await expect(copy({ frequencyValue: 5 })).rejects.toThrow(/percent from 1 to 100/)
  })

  it('the author never approves; a second person does, then the version is frozen with its checks', async () => {
    const { versionId, checkId } = await draftVersion()
    await expect(approve(versionId, a.actorId)).rejects.toThrow(/author of plan version .* does not approve/)
    await expect(run(office(), `UPDATE "InspectionPlanVersion" SET status = 'APPROVED' WHERE id = $1::uuid`, versionId)).rejects.toThrow(/wrong approval/)
    await expect(run(office(), `UPDATE "InspectionPlanVersion" SET "approvedById" = $1::uuid, "approvedAt" = now(), "approvalSha256" = $2 WHERE id = $3::uuid`, plans.approverId, SHA, versionId)).rejects.toThrow(/wrong approval/)

    // Only one APPROVED per plan: the old one is retired first.
    await expect(approve(versionId, plans.approverId)).rejects.toThrow(/InspectionPlanVersion_one_approved|Unique constraint/)
    await run(office(), `UPDATE "InspectionPlanVersion" SET status = 'RETIRED', "retiredById" = $1::uuid, "retiredAt" = now() WHERE id = $2::uuid`, a.actorId, plans.versionIds.incoming)
    expect(await approve(versionId, plans.approverId)).toBe(1)

    await expect(run(office(), `UPDATE "InspectionPlanCheck" SET "labelEn" = 'x' WHERE id = $1::uuid`, checkId)).rejects.toThrow(/changes? only while it is DRAFT/)
    await expect(run(office(), `DELETE FROM "InspectionPlanCheck" WHERE id = $1::uuid`, checkId)).rejects.toThrow(/change only while it is DRAFT/)
    await expect(copyRow(office(), 'InspectionPlanCheck', checkId, { id: randomUUID(), code: 'MORE' })).rejects.toThrow(/change only while it is DRAFT/)
    await expect(run(office(), `UPDATE "InspectionPlanVersion" SET "changeNote" = 'x' WHERE id = $1::uuid`, versionId)).rejects.toThrow(/frozen with its checks/)
    await expect(run(office(), `UPDATE "InspectionPlanVersion" SET status = 'DRAFT', "approvedById" = NULL, "approvedAt" = NULL, "approvalSha256" = NULL WHERE id = $1::uuid`, versionId)).rejects.toThrow(/frozen with its checks/)
    await expect(run(office(), `UPDATE "InspectionPlanVersion" SET status = 'RETIRED' WHERE id = $1::uuid`, versionId)).rejects.toThrow(/set exactly when RETIRED/)

    // The seeded record of the retired version keeps it, and the plan has the new one in force; back to the seed's for the
    // tests below: a retired version never comes back, so they use the new one.
    await expect(run(office(), `UPDATE "InspectionPlanVersion" SET status = 'APPROVED' WHERE id = $1::uuid`, plans.versionIds.incoming)).rejects.toThrow(/RETIRED; a retired version never changes/)
    expect(await admin(`SELECT "planVersionId"::text AS v FROM "IncomingInspection" WHERE id = $1`, [plans.openIncomingId])).toEqual([{ v: plans.versionIds.incoming }])
    expect(await admin(`SELECT count(*)::int AS n FROM "InspectionPlanVersion" WHERE "planId" = $1 AND status = 'APPROVED'`, [plans.planIds.incoming])).toEqual([{ n: 1 }])

    // A record opened now takes the version in force, never the retired one.
    await expect(openIncoming()).rejects.toThrow(/runs on an APPROVED plan version/)
    expect(await run(office(), `UPDATE "InspectionPlanVersion" SET "approvedAt" = "approvedAt" WHERE id = $1::uuid`, versionId)).toBe(1)
    await force(`UPDATE "InspectionPlanVersion" SET status = 'RETIRED', "retiredById" = $1, "retiredAt" = now() WHERE id = $2`, [a.actorId, versionId])
    await force(`UPDATE "InspectionPlanVersion" SET status = 'APPROVED', "retiredById" = NULL, "retiredAt" = NULL WHERE id = $1`, [plans.versionIds.incoming])
  })

  it('a version with nothing to check is not approved; a draft nobody wants is retired, never deleted', async () => {
    const versionId = randomUUID()
    await copyRow(office(), 'InspectionPlanVersion', plans.versionIds.finalDraft, { id: versionId, number: 700 })
    await expect(approve(versionId, plans.approverId)).rejects.toThrow(/nothing to check/)
    await copyRow(office(), 'InspectionPlanCheck', plans.checkIds.draft, { id: randomUUID(), planVersionId: versionId, code: 'READ', type: 'INSTRUCTION', mandatory: false, checkClass: null })
    await expect(approve(versionId, plans.approverId)).rejects.toThrow(/nothing to check/)
    await expect(admin(`DELETE FROM "InspectionPlanVersion" WHERE id = $1`, [versionId])).rejects.toThrow(/never deleted/)
    expect(await run(office(), `UPDATE "InspectionPlanVersion" SET status = 'RETIRED', "retiredById" = $1::uuid, "retiredAt" = now() WHERE id = $2::uuid`, a.actorId, versionId)).toBe(1)
  })

  it('a check says what its type needs', async () => {
    const copy = (changes: Record<string, unknown>) => copyRow(office(), 'InspectionPlanCheck', plans.checkIds.draft, { id: randomUUID(), code: `K${randomUUID().slice(0, 8)}`, ...changes })
    await expect(copy({ code: 'A B' })).rejects.toThrow(/code without spaces/)
    await expect(copy({ labelEn: ' ' })).rejects.toThrow(/Italian and English words/)
    await expect(copy({ labelI18n: { fr: '' } })).rejects.toThrow(/Italian and English words/)
    await expect(copy({ nominal: 1 })).rejects.toThrow(/only a measurement/)
    await expect(copy({ type: 'MEASUREMENT', nominal: 1 })).rejects.toThrow(/nominal, a tolerance from 0 and a unit/)
    await expect(copy({ type: 'MEASUREMENT', nominal: 1, tolerance: -1, uom: 'CM' })).rejects.toThrow(/nominal, a tolerance from 0 and a unit/)
    await expect(copy({ type: 'CHOICE', choices: ['A'] })).rejects.toThrow(/at least two choices/)
    await expect(copy({ type: 'CHOICE', choices: ['A', 'A'] })).rejects.toThrow(/at least two choices/)
    await expect(copy({ choices: ['A', 'B'] })).rejects.toThrow(/only a choice/)
    await expect(copy({ type: 'INSTRUCTION' })).rejects.toThrow(/takes no result/)
    expect(await copy({ type: 'MEASUREMENT', checkClass: null })).toBe(1) // no nominal: the size's graded spec
    expect(await copy({ type: 'CHOICE', choices: ['A', 'B'] })).toBe(1)
  })
})

describe('AQL profiles (QHS-021)', () => {
  it('critical is locked at 0, one default per company, a default is in use', async () => {
    const copy = (changes: Record<string, unknown>) => copyRow(office(), 'AqlProfile', plans.profileIds.customer, { id: randomUUID(), code: `P${randomUUID().slice(0, 8)}`, ...changes })
    await expect(copy({ aqlCritical: 0.1 })).rejects.toThrow(/critical at 0/)
    await expect(run(office(), `UPDATE "AqlProfile" SET "aqlCritical" = 0.1 WHERE id = $1::uuid`, plans.profileIds.standard)).rejects.toThrow(/critical at 0/)
    await expect(copy({ aqlMajor: -1 })).rejects.toThrow(/from 0 to 1000/)
    await expect(copy({ aqlMinor: 1001 })).rejects.toThrow(/from 0 to 1000/)
    await expect(copy({ isDefault: true })).rejects.toThrow(/AqlProfile_one_default|Unique constraint/)
    await expect(copy({ isDefault: true, active: false })).rejects.toThrow(/retired; the company default/)
    await expect(run(office(), `UPDATE "AqlProfile" SET code = 'X' WHERE id = $1::uuid`, plans.profileIds.standard)).rejects.toThrow(/never change/)
    await expect(admin(`DELETE FROM "AqlProfile" WHERE id = $1`, [plans.profileIds.customer])).rejects.toThrow(/never deleted/)
  })

  it('an assignment is for a customer or a style, once while active, and keeps its subject', async () => {
    const [{ id: seeded } = {}] = await admin(`SELECT id::text AS id FROM "AqlProfileAssignment" WHERE "tenantId" = $1 AND active`, [a.tenantId])
    const copy = (changes: Record<string, unknown>) => copyRow(office(), 'AqlProfileAssignment', String(seeded), { id: randomUUID(), ...changes })
    await expect(copy({ customerId: null })).rejects.toThrow(/customer, a style or both/)
    await expect(copy({})).rejects.toThrow(/AqlProfileAssignment_one_active|Unique constraint/)
    await expect(copy({ customerId: key('party:P2') })).rejects.toThrow(/is not a customer/)
    expect(await copy({ styleId: key('production:style:JKT-02') })).toBe(1) // the customer's style: a pair of its own
    await expect(run(office(), `UPDATE "AqlProfileAssignment" SET "profileId" = $1::uuid WHERE id = $2::uuid`, plans.profileIds.standard, String(seeded))).rejects.toThrow(/keeps its profile and subject/)
    await expect(admin(`DELETE FROM "AqlProfileAssignment" WHERE id = $1`, [seeded])).rejects.toThrow(/never deleted/)
  })

  it('a retired profile takes no new subject or record', async () => {
    const profile = randomUUID()
    await copyRow(office(), 'AqlProfile', plans.profileIds.customer, { id: profile, code: `R${profile.slice(0, 8)}`, active: false })
    const [{ id: seeded } = {}] = await admin(`SELECT id::text AS id FROM "AqlProfileAssignment" WHERE "tenantId" = $1 AND active LIMIT 1`, [a.tenantId])
    await expect(copyRow(office(), 'AqlProfileAssignment', String(seeded), { id: randomUUID(), profileId: profile, customerId: null, styleId: key('production:style:JKT-02') })).rejects.toThrow(/is retired/)
    await expect(openIncoming({ aqlProfileId: profile })).rejects.toThrow(/is retired/)
  })
})

describe('when inspections are created (QHS-010, QHS-011)', () => {
  it('a rule has its chips and the frequency’s number; it may be removed', async () => {
    const [{ id: rule } = {}] = await admin(`SELECT id::text AS id FROM "InspectionTrigger" WHERE "tenantId" = $1 ORDER BY "sortOrder" LIMIT 1`, [a.tenantId])
    const copy = (changes: Record<string, unknown>) => copyRow(office(), 'InspectionTrigger', String(rule), { id: randomUUID(), ...changes })
    await expect(copy({ frequency: 'EVERY_NTH_BUNDLE' })).rejects.toThrow(/percent from 1 to 100/)
    await expect(copy({ frequency: 'PERCENT_OF_OPERATIONS', frequencyValue: 0 })).rejects.toThrow(/percent from 1 to 100/)
    await expect(copy({ appliesTo: 'nope' })).rejects.toThrow(/\{ kind, value \} chips/)
    const id = randomUUID()
    expect(await copyRow(office(), 'InspectionTrigger', String(rule), { id, frequency: 'EVERY_NTH_BUNDLE', frequencyValue: 5 })).toBe(1)
    expect(await run(office(), `DELETE FROM "InspectionTrigger" WHERE id = $1::uuid`, id)).toBe(1)
  })
})

describe('a final inspection on a plan (QHS-016); W1 unchanged', () => {
  const copy = (changes: Record<string, unknown>) => copyRow(office(), 'Inspection', plans.inspectionId, { id: randomUUID(), number: `T-INS-${randomUUID().slice(0, 8)}`, ...changes })

  it('takes an APPROVED version of a FINAL plan, a known code letter', async () => {
    await expect(copy({ planVersionId: plans.versionIds.finalDraft })).rejects.toThrow(/runs on an APPROVED plan version/)
    await expect(copy({ planVersionId: plans.versionIds.inLine })).rejects.toThrow(/runs on a plan of stage FINAL/)
    await expect(copy({ codeLetter: 'I' })).rejects.toThrow(/ISO 2859-1 code letter/)
    await expect(copy({ codeLetter: 'S' })).rejects.toThrow(/ISO 2859-1 code letter/)
    expect(await copy({ codeLetter: 'R' })).toBe(1)
  })

  it('keeps the version frozen on it; an older one takes a plan once while OPEN', async () => {
    await expect(run(office(), `UPDATE "Inspection" SET "planVersionId" = NULL WHERE id = $1::uuid`, plans.inspectionId)).rejects.toThrow(/keeps the plan version frozen/)
    const id = randomUUID()
    await copyRow(office(), 'Inspection', plans.inspectionId, { id, number: `T-INS-${id.slice(0, 8)}`, planVersionId: null, aqlProfileId: null, codeLetter: null })
    expect(await run(office(), `UPDATE "Inspection" SET "planVersionId" = $1::uuid WHERE id = $2::uuid`, plans.versionIds.final, id)).toBe(1)
  })

  it('the profile is frozen once counting starts', async () => {
    await expect(run(office(), `UPDATE "Inspection" SET "codeLetter" = 'B' WHERE id = $1::uuid`, plans.inspectionId)).rejects.toThrow(/frozen once counting starts/)
    const id = randomUUID()
    await copy({ id })
    expect(await run(office(), `UPDATE "Inspection" SET "codeLetter" = 'B', "aqlProfileId" = $1::uuid WHERE id = $2::uuid`, plans.profileIds.customer, id)).toBe(1)
  })

  it('PASSED on a plan needs every mandatory result and no failed critical check; W1’s rules still decide the rest', async () => {
    const id = randomUUID()
    await copy({ id })
    const pass = () =>
      run(office(), `UPDATE "Inspection" SET status = 'PASSED', "decidedAt" = now(), "signatureSha256" = $1, checklist = '[{"code":"CE_MARK","ok":true}]', "notMakerStatement" = true WHERE id = $2::uuid`, SHA, id)
    await expect(pass()).rejects.toThrow(/does not PASS on its plan: mandatory check CE_MARK has no result/)
    const ce = randomUUID()
    const [{ id: seededCe } = {}] = await admin(`SELECT id::text AS id FROM "InspectionCheckResult" WHERE "inspectionId" = $1`, [plans.inspectionId])
    const [{ id: seededChest } = {}] = await admin(`SELECT id::text AS id FROM "InspectionMeasurement" WHERE "inspectionId" = $1`, [plans.inspectionId])
    await copyRow(office(), 'InspectionCheckResult', String(seededCe), { id: ce, inspectionId: id, outcome: 'FAIL' })
    await copyRow(office(), 'InspectionMeasurement', String(seededChest), { id: randomUUID(), inspectionId: id })
    await expect(pass()).rejects.toThrow(/does not PASS on its plan: critical check CE_MARK failed/)
    await run(office(), `UPDATE "InspectionCheckResult" SET outcome = 'PASS' WHERE id = $1::uuid`, ce)
    expect(await pass()).toBe(1)
    expect(await admin(`SELECT status::text AS status, "computedResult"::text AS computed FROM "Inspection" WHERE id = $1`, [id])).toEqual([{ status: 'PASSED', computed: 'PASS' }])

    // Decided: W1's guard freezes the new columns too, and its results stay.
    await expect(run(office(), `UPDATE "Inspection" SET "codeLetter" = 'C' WHERE id = $1::uuid`, id)).rejects.toThrow(/decided or cancelled inspection never changes/)
    await expect(run(office(), `UPDATE "InspectionCheckResult" SET note = 'x' WHERE id = $1::uuid`, ce)).rejects.toThrow(/waits for an OPEN record/)
    await expect(run(office(), `DELETE FROM "InspectionCheckResult" WHERE id = $1::uuid`, ce)).rejects.toThrow(/stays: its record is PASSED/)
  })

  it('an inspection with no plan is decided as in W1: no results are asked', async () => {
    const id = randomUUID()
    await copy({ id, planVersionId: null, aqlProfileId: null, codeLetter: null })
    expect(await run(office(), `UPDATE "Inspection" SET status = 'PASSED', "decidedAt" = now(), "signatureSha256" = $1, checklist = '[{"code":"CE_MARK","ok":true}]', "notMakerStatement" = true WHERE id = $2::uuid`, SHA, id)).toBe(1)
  })
})

describe('incoming inspections (QHS-025 … QHS-036)', () => {
  it('starts OPEN, of a lot or a workshop’s receipt, on an INCOMING plan, with a sample that fits', async () => {
    await expect(openIncoming({ status: 'DECIDED' })).rejects.toThrow(/starts OPEN/)
    await expect(openIncoming({ lotId: null, itemId: null })).rejects.toThrow(/exactly one of the two/)
    await expect(openIncoming({ itemId: null })).rejects.toThrow(/exactly one of the two/)
    await expect(openIncoming({ subcontractReceiptId: receipts.receiptId, workOrderId: plans.workOrderId })).rejects.toThrow(/exactly one of the two/)
    await expect(openIncoming({ planVersionId: plans.versionIds.final })).rejects.toThrow(/runs on a plan of stage INCOMING/)
    await expect(openIncoming({ sampleSize: 3 })).rejects.toThrow(/a sample from 1 up to the lot/)
    await expect(openIncoming({ lotSize: 0, sampleSize: 0 })).rejects.toThrow(/a sample from 1 up to the lot/)
    await expect(openIncoming({ acceptMajor: null })).rejects.toThrow(/sampling plan whole or not at all/)
    await expect(openIncoming({ foundMajor: 3 })).rejects.toThrow(/from 0 up to its sample/)
    await expect(openIncoming({ codeLetter: 'O' })).rejects.toThrow(/ISO 2859-1 code letter/)
    await expect(openIncoming({ inspectorUserId: a.actorId })).rejects.toThrow(/names one inspector/)
    await expect(openIncoming({ number: ' ' })).rejects.toThrow(/has its number/)

    const workshop = await openIncoming({ lotId: null, itemId: null, subcontractReceiptId: receipts.receiptId, workOrderId: plans.workOrderId })
    expect(await admin(`SELECT "subcontractReceiptId"::text AS r FROM "IncomingInspection" WHERE id = $1`, [workshop])).toEqual([{ r: receipts.receiptId }])
  })

  it('a floor session names a worker only, on its own site', async () => {
    const id = randomUUID()
    expect(await copyRow(floor(), 'IncomingInspection', plans.openIncomingId, { id, number: `T-IIN-${id.slice(0, 8)}` })).toBe(1)
    await expect(run(floor(), `UPDATE "IncomingInspection" SET "inspectorWorkerId" = NULL, "inspectorUserId" = $1::uuid WHERE id = $2::uuid`, a.actorId, id)).rejects.toThrow(/the floor records the inspection of a worker/)
  })

  it('the three quantities add up to the lot, every unit has its decision; the result is computed, a decided one frozen', async () => {
    const id = await openIncoming()
    await shadeResult(id)
    await expect(decideIncoming(id, 1, 0, 0)).rejects.toThrow(/adding up to the lot of 2/)
    await expect(decideIncoming(id, 3, -1, 0)).rejects.toThrow(/adding up to the lot of 2/)
    await expect(run(office(), `UPDATE "IncomingInspection" SET status = 'DECIDED' WHERE id = $1::uuid`, id)).rejects.toThrow(/set exactly when DECIDED/)
    const unit = randomUUID()
    await copyRow(office(), 'IncomingHideResult', (await firstOf('IncomingHideResult', plans.openIncomingId)), { id: unit, incomingInspectionId: id, seq: 9 })
    await expect(decideIncoming(id, 1, 1, 0)).rejects.toThrow(/a decision on every hide, roll and component/)
    await run(office(), `UPDATE "IncomingHideResult" SET decision = 'TO_SORT' WHERE id = $1::uuid`, unit)
    expect(await decideIncoming(id, 1, 0, 1, `, "computedResult" = 'FAIL'`)).toBe(1) // whatever is sent, the database writes it
    expect(await admin(`SELECT "computedResult"::text AS computed FROM "IncomingInspection" WHERE id = $1`, [id])).toEqual([{ computed: 'PASS' }])

    await expect(run(office(), `UPDATE "IncomingInspection" SET note = 'x' WHERE id = $1::uuid`, id)).rejects.toThrow(/decided or cancelled inspection never changes/)
    await expect(run(office(), `UPDATE "IncomingInspection" SET number = 'X' WHERE id = $1::uuid`, id)).rejects.toThrow(/never changes/)
    await expect(run(office(), `UPDATE "IncomingHideResult" SET note = 'x' WHERE id = $1::uuid`, unit)).rejects.toThrow(/changes only while it is OPEN/)
    await expect(run(office(), `DELETE FROM "IncomingHideResult" WHERE id = $1::uuid`, unit)).rejects.toThrow(/changes only while it is OPEN/)
    await expect(copyRow(office(), 'IncomingRollResult', await firstOf('IncomingRollResult', plans.openIncomingId), { id: randomUUID(), incomingInspectionId: id })).rejects.toThrow(/changes only while it is OPEN/)
    await expect(admin(`DELETE FROM "IncomingInspection" WHERE id = $1`, [id])).rejects.toThrow(/never deleted/)
  })

  it('the whole lot is never accepted over a critical defect or a missing mandatory check; a whole-lot decision against the result says why', async () => {
    const missing = await openIncoming()
    await expect(decideIncoming(missing, 2, 0, 0)).rejects.toThrow(/does not accept the whole lot: mandatory check SHADE has no result/)
    // A rejected lot need not finish its checks.
    expect(await decideIncoming(missing, 0, 2, 0, `, "overrideReason" = 'Wet hides'`)).toBe(1)

    const critical = await openIncoming({ foundCritical: 1 })
    await shadeResult(critical)
    await expect(decideIncoming(critical, 2, 0, 0, `, "overrideReason" = 'x'`)).rejects.toThrow(/a critical defect is never accepted/)
    expect(await decideIncoming(critical, 1, 1, 0)).toBe(1)
    expect(await admin(`SELECT "computedResult"::text AS computed FROM "IncomingInspection" WHERE id = $1`, [critical])).toEqual([{ computed: 'FAIL' }])

    const over = await openIncoming({ foundMajor: 2 })
    await shadeResult(over)
    await expect(decideIncoming(over, 2, 0, 0)).rejects.toThrow(/reason exactly when the whole lot is decided against/)
    expect(await decideIncoming(over, 2, 0, 0, `, "overrideReason" = 'Customer accepts'`)).toBe(1)

    const fine = await openIncoming()
    await shadeResult(fine)
    await expect(decideIncoming(fine, 2, 0, 0, `, "overrideReason" = 'Why not'`)).rejects.toThrow(/reason exactly when the whole lot is decided against/)
    await expect(decideIncoming(fine, 0, 2, 0)).rejects.toThrow(/reason exactly when the whole lot is decided against/)
    expect(await decideIncoming(fine, 2, 0, 0)).toBe(1)
  })

  it('cancelled with when and why, from OPEN; the AQL profile is frozen once counting starts', async () => {
    const id = await openIncoming()
    await expect(run(office(), `UPDATE "IncomingInspection" SET status = 'CANCELLED' WHERE id = $1::uuid`, id)).rejects.toThrow(/set exactly when CANCELLED/)
    expect(await run(office(), `UPDATE "IncomingInspection" SET "codeLetter" = 'B', "aqlProfileId" = $1::uuid WHERE id = $2::uuid`, plans.profileIds.customer, id)).toBe(1)
    await run(office(), `UPDATE "IncomingInspection" SET "foundMinor" = 1 WHERE id = $1::uuid`, id)
    await expect(run(office(), `UPDATE "IncomingInspection" SET "codeLetter" = 'C' WHERE id = $1::uuid`, id)).rejects.toThrow(/frozen once counting starts/)
    expect(await run(office(), `UPDATE "IncomingInspection" SET status = 'CANCELLED', "cancelledAt" = now(), "cancelReason" = 'Opened by mistake' WHERE id = $1::uuid`, id)).toBe(1)
    await expect(run(office(), `UPDATE "IncomingInspection" SET note = 'x' WHERE id = $1::uuid`, id)).rejects.toThrow(/decided or cancelled inspection never changes/)
  })

  it('a hide is of the lot, its marks are on the map, its links both or neither, and it has one decided row', async () => {
    const id = await openIncoming()
    const from = await firstOf('IncomingHideResult', plans.openIncomingId)
    const copy = (changes: Record<string, unknown>) => copyRow(office(), 'IncomingHideResult', from, { id: randomUUID(), incomingInspectionId: id, seq: Math.floor(Math.random() * 100000) + 1, ...changes })
    await expect(copy({ measuredArea: 0 })).rejects.toThrow(/areas above 0/)
    await expect(copy({ areaUom: 'M' })).rejects.toThrow(/areas above 0/)
    await expect(copy({ marks: [{ x: 2, y: 0 }] })).rejects.toThrow(/x and y from 0 to 1/)
    await expect(copy({ marks: [{ x: 0.2 }] })).rejects.toThrow(/x and y from 0 to 1/)
    await expect(copy({ marks: {} })).rejects.toThrow(/x and y from 0 to 1/)
    await expect(copy({ shadeRecordType: 'ShadeGroup' })).rejects.toThrow(/type and id, both or neither/)
    await expect(copy({ gradeRecordId: randomUUID() })).rejects.toThrow(/type and id, both or neither/)
    expect(await copy({ shadeRecordType: 'ShadeGroup', shadeRecordId: randomUUID(), gradeRecordType: 'LeatherGrade', gradeRecordId: randomUUID(), decision: 'ACCEPTED' })).toBe(1)
    await expect(copy({ decision: 'REJECTED' })).rejects.toThrow(/IncomingHideResult_one_decided|Unique constraint/)
    await expect(copy({ hideId: randomUUID() })).rejects.toThrow(/foreign key|Foreign key/)
  })

  it('the database works out a roll’s points; a component checks its counts', async () => {
    const id = await openIncoming()
    const rollId = randomUUID()
    const roll = await firstOf('IncomingRollResult', plans.openIncomingId)
    await expect(copyRow(office(), 'IncomingRollResult', roll, { id: randomUUID(), incomingInspectionId: id, rollRef: 'R-X', widthCm: 0 })).rejects.toThrow(/width and a length above 0/)
    await expect(copyRow(office(), 'IncomingRollResult', roll, { id: randomUUID(), incomingInspectionId: id, rollRef: 'R-Y', onePoint: -1 })).rejects.toThrow(/counters from 0/)
    await expect(copyRow(office(), 'IncomingRollResult', roll, { id: randomUUID(), incomingInspectionId: id, rollRef: 'R-Z', recordType: 'FabricRoll' })).rejects.toThrow(/type and id, both or neither/)
    // 100 m × 100 cm is 119.599 square yards; 12 points on it are 10.03 per 100.
    await copyRow(office(), 'IncomingRollResult', roll, { id: rollId, incomingInspectionId: id, rollRef: 'R-1', onePoint: 0, twoPoint: 0, threePoint: 0, fourPoint: 3, widthCm: 100, lengthM: 100, pointsPer100SqYd: 999 })
    expect(await admin(`SELECT "pointsPer100SqYd"::text AS points FROM "IncomingRollResult" WHERE id = $1`, [rollId])).toEqual([{ points: '10.03' }])
    await run(office(), `UPDATE "IncomingRollResult" SET "fourPoint" = 6 WHERE id = $1::uuid`, rollId)
    expect(await admin(`SELECT "pointsPer100SqYd"::text AS points FROM "IncomingRollResult" WHERE id = $1`, [rollId])).toEqual([{ points: '20.07' }])

    const component = await firstOf('IncomingComponentResult', plans.openIncomingId)
    await expect(copyRow(office(), 'IncomingComponentResult', component, { id: randomUUID(), incomingInspectionId: id, seq: 2, defectiveQuantity: 6 })).rejects.toThrow(/those not right from 0 up to them/)
    await expect(copyRow(office(), 'IncomingComponentResult', component, { id: randomUUID(), incomingInspectionId: id, seq: 3, kind: 'ZIP' })).rejects.toThrow(/only a protector has a type/)
  })
})

/** The first row of `table` that hangs on incoming inspection `incomingInspectionId`. */
async function firstOf(table: string, incomingInspectionId: string): Promise<string> {
  const [row] = await admin(`SELECT id::text AS id FROM "${table}" WHERE "incomingInspectionId" = $1 ORDER BY id LIMIT 1`, [incomingInspectionId])
  return String(row?.id)
}

describe('in-process checks (QHS-039 … QHS-042)', () => {
  it('names its place, and an outcome that fits its kind', async () => {
    await expect(check({ bundleId: plans.bundleIds[0], workOrderId: null, workOrderOperationId: null })).rejects.toThrow(/names the work order of its bundle or operation/)
    await expect(check({ workOrderOperationId: plans.sewingOperationId, workOrderId: null })).rejects.toThrow(/names the work order of its bundle or operation/)
    await expect(check({ kind: 'FIRST_PIECE', outcome: 'APPROVED', bundleId: null })).rejects.toThrow(/without its place/)
    await expect(check({ kind: 'CUTTING', outcome: 'PASS', workOrderId: null, workOrderOperationId: null })).rejects.toThrow(/without its place/)
    await expect(check({ lineId: null, workOrderId: null, workOrderOperationId: null })).rejects.toThrow(/without its place/)
    await expect(check({ outcome: 'PASS' })).rejects.toThrow(/a ROVING check is not PASS/)
    await expect(check({ kind: 'END_OF_LINE', outcome: 'GREEN' })).rejects.toThrow(/a END_OF_LINE check is not GREEN/)
    await expect(check({ kind: 'CUTTING', outcome: 'APPROVED' })).rejects.toThrow(/a CUTTING check is not APPROVED/)
    await expect(check({ kind: 'FIRST_PIECE', outcome: 'PASS', bundleId: plans.bundleIds[0], signatureSha256: SHA })).rejects.toThrow(/a FIRST_PIECE check is not PASS/)
    await expect(check({ pieces: 2, defectivePieces: 3 })).rejects.toThrow(/those with a defect up to them/)
    await expect(check({ pieces: 0 })).rejects.toThrow(/pieces from 1 are set exactly when DECIDED/)
    await expect(check({ status: 'OPEN' })).rejects.toThrow(/set exactly when DECIDED/)
    await expect(check({ inspectorWorkerId: null, inspectorUserId: null })).rejects.toThrow(/set exactly when DECIDED/)
    await expect(check({ status: 'CANCELLED', outcome: null, decidedAt: null, cancelledAt: AT, cancelReason: 'x' })).rejects.toThrow(/starts OPEN, or DECIDED at once/)
    await expect(check({ planVersionId: plans.versionIds.final })).rejects.toThrow(/runs on a plan of stage IN_LINE/)
    await expect(check({ inspectorUserId: a.actorId, inspectorWorkerId: null }, floor())).rejects.toThrow(/the floor records the check of a worker/)
    expect(await check({ kind: 'END_OF_LINE', outcome: 'PASS' }, floor())).toEqual(expect.any(String))
  })

  it('decided: frozen; on a plan a pass needs its mandatory results; a first piece carries the signature', async () => {
    const id = await firstPiece(plans.operationIds.qc, plans.bundleIds[1], { planVersionId: plans.versionIds.inLine })
    const decide = (outcome: string, signature: string | null) =>
      run(office(), `UPDATE "InProcessCheck" SET status = 'DECIDED', outcome = $1::"InProcessOutcome", pieces = 1, "decidedAt" = now(), "signatureSha256" = $2 WHERE id = $3::uuid`, outcome, signature, id)
    await expect(decide('APPROVED', null)).rejects.toThrow(/a first piece always then/)
    await expect(decide('APPROVED', SHA)).rejects.toThrow(/is not APPROVED on its plan: mandatory check SEAM has no result/)
    const [{ id: seam } = {}] = await admin(`SELECT id::text AS id FROM "InspectionCheckResult" WHERE "inProcessCheckId" = $1`, [plans.firstPieceId])
    const result = randomUUID()
    await copyRow(office(), 'InspectionCheckResult', String(seam), { id: result, inProcessCheckId: id, outcome: 'FAIL' })
    await expect(decide('APPROVED', SHA)).rejects.toThrow(/is not APPROVED on its plan: critical check SEAM failed/)
    expect(await decide('REJECTED', SHA)).toBe(1) // a rejected first piece needs no complete checklist
    await expect(run(office(), `UPDATE "InProcessCheck" SET note = 'x' WHERE id = $1::uuid`, id)).rejects.toThrow(/decided or cancelled check never changes/)
    await expect(admin(`DELETE FROM "InProcessCheck" WHERE id = $1`, [id])).rejects.toThrow(/never deleted/)
    await force(`UPDATE "InProcessCheck" SET status = 'CANCELLED', outcome = NULL, "decidedAt" = NULL, "signatureSha256" = NULL, "cancelledAt" = now(), "cancelReason" = 'test' WHERE id = $1`, [id])
  })

  it('a first piece holds its run until one is APPROVED; the first bundle, a pause and a correction pass; a cancelled one holds nothing', async () => {
    const op = plans.operationIds.qc
    const [first, other] = [plans.bundleIds[0], plans.bundleIds[1]]
    expect(await scanError('START', other, op)).not.toMatch(/first piece/)

    const id = await firstPiece(op, first)
    const held = /waits for its first piece/
    expect(await scanError('START', other, op)).toMatch(held)
    expect(await scanError('REPORT', other, op)).toMatch(held)
    expect(await scanError('RESUME', other, op)).toMatch(held)
    expect(await scanError('PARTIAL', other, op)).toMatch(held)
    // The first bundle itself; stopping the clock and mending the record; another operation of the work order.
    expect(await scanError('START', first, op)).not.toMatch(held)
    expect(await scanError('PAUSE', other, op)).not.toMatch(held)
    expect(await scanError('HAND_BACK', other, op)).not.toMatch(held)
    expect(await scanError('UNDO', other, op)).not.toMatch(held)
    expect(await scanError('CORRECTION', other, op)).not.toMatch(held)
    expect(await scanError('START', other, plans.operationIds.pack)).not.toMatch(held)

    // REJECTED: still held, until a new first piece is APPROVED.
    await run(office(), `UPDATE "InProcessCheck" SET status = 'DECIDED', outcome = 'REJECTED', pieces = 1, "decidedAt" = now(), "signatureSha256" = $1 WHERE id = $2::uuid`, SHA, id)
    expect(await scanError('START', other, op)).toMatch(held)
    const again = await firstPiece(op, first)
    expect(await scanError('START', other, op)).toMatch(held)
    await run(office(), `UPDATE "InProcessCheck" SET status = 'DECIDED', outcome = 'APPROVED', pieces = 1, "decidedAt" = now(), "signatureSha256" = $1 WHERE id = $2::uuid`, SHA, again)
    expect(await scanError('START', other, op)).not.toMatch(held)

    // Naming no operation, it holds every operation of the work order; cancelled, none.
    const whole = await firstPiece(null as unknown as string, first)
    expect(await scanError('START', other, plans.operationIds.pack)).toMatch(held)
    await run(office(), `UPDATE "InProcessCheck" SET status = 'CANCELLED', "cancelledAt" = now(), "cancelReason" = 'Wrong run' WHERE id = $1::uuid`, whole)
    expect(await scanError('START', other, plans.operationIds.pack)).not.toMatch(held)
  })

  it('names an operator only behind the PERFORMANCE gate, never from a floor session', async () => {
    const operator = plans.operatorId
    const [{ employeeId } = {}] = await admin(`SELECT "employeeId"::text AS "employeeId" FROM "Worker" WHERE id = $1`, [operator])
    await expect(check({ workerId: operator, employeeId }, floor())).rejects.toThrow(/a floor session never names the operator/)
    await expect(check({ workerId: operator, employeeId })).rejects.toThrow(/only while the site's PERFORMANCE legal gate is switched on/)
    await expect(check({ employeeId: people.employeeIds.e1 })).rejects.toThrow(/an employee only with their worker/)

    const gate = randomUUID()
    await force(
      `INSERT INTO "PeopleLegalGate" SELECT * FROM jsonb_populate_record(NULL::"PeopleLegalGate", (SELECT to_jsonb(g) || $1::jsonb FROM "PeopleLegalGate" g WHERE g."tenantId" = $2 AND g.purpose = 'ATTENDANCE' LIMIT 1))`,
      [JSON.stringify({ id: gate, purpose: 'PERFORMANCE', basis: 'UNION_AGREEMENT', switchedOffAt: null, switchedOffById: null, switchOffReason: null }), a.tenantId],
    )
    expect(await check({ workerId: operator, employeeId })).toEqual(expect.any(String))
    await expect(check({ workerId: operator, employeeId: randomUUID() })).rejects.toThrow(/keeps the operator's own employee|foreign key/i)
    await expect(check({ workerId: operator, employeeId }, floor())).rejects.toThrow(/a floor session never names the operator/)
    await force(`DELETE FROM "PeopleLegalGate" WHERE id = $1`, [gate])
  })
})

describe('results and measurements', () => {
  const result = (changes: Record<string, unknown>) => copyRow(office(), 'InspectionCheckResult', plansRow('result'), { id: randomUUID(), ...changes })
  const measurement = async (changes: Record<string, unknown>) => copyRow(office(), 'InspectionMeasurement', await firstOf('InspectionMeasurement', plans.openIncomingId), { id: randomUUID(), ...changes })

  it('a result is of exactly one record, on the version frozen on it', async () => {
    const id = await openIncoming()
    await expect(result({ incomingInspectionId: id, inspectionId: plans.inspectionId, sampleIndex: 2 })).rejects.toThrow(/exactly one record/)
    await expect(result({ incomingInspectionId: null })).rejects.toThrow(/exactly one record/)
    await expect(result({ incomingInspectionId: id, planCheckId: plans.checkIds.ce })).rejects.toThrow(/plan version frozen on its record/)
    await expect(result({ incomingInspectionId: id, sampleIndex: 0 })).rejects.toThrow(/a unit of the sample from 1/)
    await expect(result({ incomingInspectionId: id, recordedById: a.actorId })).rejects.toThrow(/at most one person/)
    await expect(result({ incomingInspectionId: id, recordedById: null, recordedByWorkerId: null, deviceId: null })).rejects.toThrow(/at most one person/)
    await expect(copyRow(floor(), 'InspectionCheckResult', plansRow('result'), { id: randomUUID(), incomingInspectionId: id, recordedById: a.actorId, recordedByWorkerId: null })).rejects.toThrow(/the floor records a worker/)
    expect(await result({ incomingInspectionId: id })).toBe(1)
    await expect(result({ incomingInspectionId: id })).rejects.toThrow(/Unique constraint|duplicate key/)
    expect(await result({ incomingInspectionId: id, sampleIndex: 2 })).toBe(1)
  })

  it('a value fits its check; a measurement’s verdict comes from the numbers', async () => {
    const id = await openIncoming()
    // SHADE is a CHOICE of 1, 2, 3.
    await expect(result({ incomingInspectionId: id, value: '7' })).rejects.toThrow(/a CHOICE check takes its value/)
    await expect(result({ incomingInspectionId: id, value: null })).rejects.toThrow(/a CHOICE check takes its value/)
    expect(await result({ incomingInspectionId: id, value: null, outcome: 'NOT_APPLICABLE' })).toBe(1)
    // THICKNESS is a MEASUREMENT of 1.200 ± 0.200 as a result too.
    await expect(result({ incomingInspectionId: id, planCheckId: plans.checkIds.thickness, value: 'thick', sampleIndex: 3 })).rejects.toThrow(/a MEASUREMENT check takes its value/)
    await expect(result({ incomingInspectionId: id, planCheckId: plans.checkIds.thickness, value: '1.5', sampleIndex: 3 })).rejects.toThrow(/is a FAIL, by the numbers/)
    await expect(result({ incomingInspectionId: id, planCheckId: plans.checkIds.thickness, value: '1.3', outcome: 'FAIL', sampleIndex: 3 })).rejects.toThrow(/is a PASS, by the numbers/)
    expect(await result({ incomingInspectionId: id, planCheckId: plans.checkIds.thickness, value: '1.4', sampleIndex: 3 })).toBe(1)

    const instruction = await admin(`SELECT id::text AS id FROM "InspectionPlanCheck" WHERE "planVersionId" = $1 AND type = 'INSTRUCTION'`, [plans.versionIds.final])
    await expect(result({ incomingInspectionId: null, inspectionId: plans.inspectionId, planCheckId: instruction[0]!.id })).rejects.toThrow(/an instruction takes no result/)
  })

  it('a measurement: the database writes pass, the check’s numbers stay, a record stays open for it', async () => {
    const id = await openIncoming()
    const rowId = randomUUID()
    await expect(measurement({ incomingInspectionId: id, nominal: 2 })).rejects.toThrow(/keeps its check's nominal/)
    await expect(measurement({ incomingInspectionId: id, planCheckId: plans.checkIds.shade })).rejects.toThrow(/answers a MEASUREMENT check/)
    await expect(measurement({ incomingInspectionId: id, pointCode: 'A B' })).rejects.toThrow(/point code without spaces/)
    await expect(measurement({ incomingInspectionId: id, measured: -1 })).rejects.toThrow(/nominal, tolerance and value from 0/)
    await expect(measurement({ incomingInspectionId: null })).rejects.toThrow(/exactly one record/)
    expect(await measurement({ id: rowId, incomingInspectionId: id, measured: 1.4, pass: false })).toBe(1)
    const passOf = async () => (await admin(`SELECT pass FROM "InspectionMeasurement" WHERE id = $1`, [rowId]))[0]!.pass
    expect(await passOf()).toBe(true)
    await run(office(), `UPDATE "InspectionMeasurement" SET measured = 1.401 WHERE id = $1::uuid`, rowId)
    expect(await passOf()).toBe(false)
    await expect(run(office(), `UPDATE "InspectionMeasurement" SET "pointCode" = 'OTHER' WHERE id = $1::uuid`, rowId)).rejects.toThrow(/never change/)
    // From the graded spec: no plan check, its own numbers.
    expect(await measurement({ incomingInspectionId: id, planCheckId: null, pointCode: 'SPEC', nominal: 60, tolerance: 1, measured: 60.5, uom: 'CM', size: '50' })).toBe(1)
    await expect(measurement({ incomingInspectionId: plans.decidedIncomingId })).rejects.toThrow(/waits for an OPEN record/)
  })
})

describe('amendments (QHS-145)', () => {
  const ask = (changes: Record<string, unknown>) => copyRow(office(), 'InspectionAmendment', plans.amendmentId, { id: randomUUID(), ...changes })

  it('are of a signed record, asked with the field, the value and the reason', async () => {
    await expect(ask({ incomingInspectionId: plans.openIncomingId })).rejects.toThrow(/amended once it is signed/)
    await expect(ask({ incomingInspectionId: null, inspectionId: plans.decidedIncomingId })).rejects.toThrow(/foreign key|Foreign key/i)
    await expect(ask({ inspectionId: plans.inspectionId })).rejects.toThrow(/exactly one record/)
    await expect(ask({ reason: ' ' })).rejects.toThrow(/field, the value after and the reason/)
    await expect(ask({ field: null })).rejects.toThrow(/field, the value after and the reason/)
    await expect(ask({ after: null })).rejects.toThrow(/field, the value after and the reason/)
    await expect(ask({ recordType: 'InspectionCheckResult' })).rejects.toThrow(/type and id, both or neither/)
    await expect(ask({ requestId: plans.amendmentId })).rejects.toThrow(/field, the value after and the reason/)
    await expect(ask({ signatureSha256: ' ' })).rejects.toThrow(/carries its signature/)
  })

  it('wait for a second person, once', async () => {
    const asked = randomUUID()
    await ask({ id: asked, field: 'measured', recordType: 'InspectionMeasurement', recordId: randomUUID(), before: '1.2', after: '1.3' })
    const answer = (changes: Record<string, unknown>) => copyRow(office(), 'InspectionAmendment', plans.amendmentId, { id: randomUUID(), kind: 'SIGNED', requestId: asked, field: null, after: null, before: null, reason: null, signedById: plans.approverId, ...changes })
    await expect(answer({ signedById: a.actorId })).rejects.toThrow(/does not sign it/)
    await expect(answer({ field: 'x' })).rejects.toThrow(/says nothing of its own/)
    await expect(answer({ requestId: null })).rejects.toThrow(/says nothing of its own/)
    await expect(answer({ kind: 'REFUSED' })).rejects.toThrow(/with the reason/)
    const [{ id: signedSeed } = {}] = await admin(`SELECT id::text AS id FROM "InspectionAmendment" WHERE "requestId" = $1`, [plans.amendmentId])
    await expect(answer({ requestId: signedSeed })).rejects.toThrow(/answers a request of its own record/)
    const other = await openIncoming()
    await shadeResult(other)
    await decideIncoming(other, 2, 0, 0)
    await expect(answer({ incomingInspectionId: other })).rejects.toThrow(/answers a request of its own record/)
    expect(await answer({ kind: 'REFUSED', reason: 'The value was right' })).toBe(1)
    await expect(answer({})).rejects.toThrow(/Unique constraint|duplicate key/)
  })

  it('never change, for any login', async () => {
    await expect(run(office(), `UPDATE "InspectionAmendment" SET reason = 'x' WHERE id = $1::uuid`, plans.amendmentId)).rejects.toThrow(/permission denied/)
    await expect(run(office(), `DELETE FROM "InspectionAmendment" WHERE id = $1::uuid`, plans.amendmentId)).rejects.toThrow(/permission denied/)
    await expect(admin(`UPDATE "InspectionAmendment" SET reason = 'x' WHERE id = $1`, [plans.amendmentId])).rejects.toThrow(/append-only/)
    await expect(admin(`DELETE FROM "InspectionAmendment" WHERE id = $1`, [plans.amendmentId])).rejects.toThrow(/append-only/)
    await expect(admin(`TRUNCATE "InspectionAmendment" CASCADE`)).rejects.toThrow(/refused/)
  })
})

describe('TRUNCATE and numbering', () => {
  it('TRUNCATE is refused on every table of the wave, for the owner too', async () => {
    for (const table of ['InspectionPlan', 'InspectionPlanVersion', 'InspectionPlanCheck', 'AqlProfile', 'AqlProfileAssignment', 'InspectionTrigger', 'IncomingInspection', 'IncomingHideResult', 'IncomingRollResult', 'IncomingComponentResult', 'InProcessCheck', 'InspectionCheckResult', 'InspectionMeasurement']) {
      await expect(admin(`TRUNCATE "${table}" CASCADE`)).rejects.toThrow(/TRUNCATE on|refused/)
    }
  })

  it('INCOMING_INSPECTION is a floor document kind: a tablet reads, moves and records its series', async () => {
    const seriesId = `ffffffff${key('series:A:INCOMING_INSPECTION:MAIN:2026').slice(8)}`
    expect(await sql(floor(), `SELECT kind::text AS kind, pattern FROM "NumberSeries" WHERE id = $1::uuid`, seriesId)).toEqual([{ kind: 'INCOMING_INSPECTION', pattern: 'IIN-{YYYY}-{N:4}' }])
    const record = randomUUID()
    await as(floor(), (client) =>
      client.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `INSERT INTO "NumberAllocation" (id, "companyId", "seriesId", kind, value, formatted, "documentDate", "recordType", "recordId", "allocatedAt", "allocatedById", "requestId")
           VALUES ($1::uuid, $2::uuid, $3::uuid, 'INCOMING_INSPECTION', 1, 'IIN-2026-0001', '2026-11-20', 'IncomingInspection', $4::uuid, now(), $5::uuid, 'test')`,
          randomUUID(),
          A.company,
          seriesId,
          record,
          a.actorId,
        )
        await tx.$executeRawUnsafe(`UPDATE "NumberSeries" SET "nextValue" = "nextValue" + 1 WHERE id = $1::uuid`, seriesId)
      }),
    )
    expect(await admin(`SELECT "nextValue" FROM "NumberSeries" WHERE id = $1`, [seriesId])).toEqual([{ nextValue: 2 }])
  })
})
