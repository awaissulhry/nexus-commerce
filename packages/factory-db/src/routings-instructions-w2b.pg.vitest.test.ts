import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedInstructions, type InstructionsSeed } from '../seed/instructions'
import { seed as seedNumbering } from '../seed/numbering'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { classifiedModels, personalDataOf } from './ownership'
import { RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'
import { loadOwnership, loadSchema } from './tools'

/**
 * Routings, standard minutes and work instructions (W2b-4 schema wave 25/33, B-W2b-205, …_routings_instructions_w2b_guards)
 * on a database built from the migrations and seeded, through the real login and the scoped client:
 *   - grants: the office keeps it all; the floor reads settings, size times, instructions and only PUBLISHED or SUPERSEDED
 *     versions with their steps and media, never an SMV version; it inserts acknowledgements and reads none; the partner
 *     reads nothing; an acknowledgement is personal data for SAFETY;
 *   - minutes: basic minutes and allowances give the SMV; a governed operation's SMV moves only to an approved version's;
 *     an SMV version is proposed, decided once by a second person, and never changed;
 *   - routing depth: the approved version a step copies, its cells, checkpoint and set-up minutes; size times and machine
 *     settings as parts of the revision, frozen once it is released;
 *   - a released revision freezes every column but its status and effectiveTo; its effective days;
 *   - work instructions: one ACTIVE per operation and revision, fixed identity, versions published by a second person and
 *     frozen with their steps and media, one PUBLISHED per instruction, the version's status carried to steps and media;
 *   - acknowledgements: of a published version, by the worker's own sign-in on a device, append-only for every login.
 * The refusals are check_violation (SQLSTATE 23514); their messages are read through raw SQL.
 */

const NS = 'w2b-205-a'

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let seed: InstructionsSeed

const key = (name: string): string => seedUuid(NS, name)
const A = { company: key('company:A'), companyB: key('company:B'), site: key('site:A1') }
const office = (): FactoryScope => ({ audience: 'office', tenantId: a.tenantId, actorId: a.actorId })
const floor = (): FactoryScope => ({ audience: 'floor', tenantId: a.tenantId, actorId: seed.operatorId, siteId: A.site })
const partner = (): FactoryScope => ({ audience: 'partner', tenantId: a.tenantId, actorId: a.actorId, partyId: key('party:P1') })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const run = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$executeRawUnsafe(text, ...values))
const sql = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$queryRawUnsafe<Record<string, unknown>[]>(text, ...values))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, unknown>[]
/** INSERT a copy of row `id` of `table` with `changes` (a jsonb object of columns). */
const copyRow = (scope: FactoryScope, table: string, id: string, changes: Record<string, unknown>) =>
  run(scope, `INSERT INTO "${table}" SELECT * FROM jsonb_populate_record(NULL::"${table}", (SELECT to_jsonb(r) || $1::jsonb FROM "${table}" r WHERE r.id = $2::uuid))`, JSON.stringify(changes), id)
const ids = (rows: Record<string, unknown>[]): string[] => rows.map((row) => String(row.id)).sort()
const tag = (): string => randomUUID().slice(0, 8)

/** A fresh library operation (a copy of the seed's sewing operation, never governed) with its SMV typed. */
async function freshOperation(changes: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID()
  await copyRow(office(), 'Operation', seed.operationIds.sew, { id, code: `T-OP-${tag()}`, ...changes })
  return id
}
/** A fresh PROPOSED SMV version of `operationId` (basic 10, allowances 5 + 5 + 5 → 11.500). */
async function propose(operationId: string, number: number, changes: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID()
  await copyRow(office(), 'OperationTimeVersion', seed.timeVersionIds.proposed, {
    id,
    operationId,
    number,
    basicMinutes: '10.000',
    personalPct: '5.0000',
    fatiguePct: '5.0000',
    delayPct: '5.0000',
    standardMinutes: '11.500',
    ...changes,
  })
  return id
}
const decide = (id: string, status: 'APPROVED' | 'REJECTED', by: string, note: string | null = null) =>
  run(office(), `UPDATE "OperationTimeVersion" SET status = $1::"OperationTimeVersionStatus", "decidedById" = $2::uuid, "decidedAt" = now(), "decisionNote" = $3 WHERE id = $4::uuid`, status, by, note, id)

/** A fresh DRAFT revision of the seed's tenant-wide jacket (SEED-JKT-01 has no released revision). */
async function draftRevision(): Promise<string> {
  const id = randomUUID()
  await copyRow(office(), 'StyleRevision', seed.draftRevisionId, { id, revision: Math.floor(Math.random() * 1_000_000) + 100, effectiveFrom: null })
  return id
}
const release = (revisionId: string, at = '2026-11-25T10:00:00.000Z') =>
  run(office(), `UPDATE "StyleRevision" SET status = 'RELEASED', "releasedAt" = $1::timestamptz, "releasedById" = $2::uuid WHERE id = $3::uuid`, at, a.actorId, revisionId)

/** A fresh DRAFT version of the seed's sewing instruction, with one step (a copy of the draft's). */
async function draftVersion(instructionId = seed.instructionIds.sewing): Promise<{ versionId: string; stepId: string }> {
  const versionId = randomUUID()
  const stepId = randomUUID()
  await copyRow(office(), 'WorkInstructionVersion', seed.versionIds.sewingDraft, { id: versionId, instructionId, number: Math.floor(Math.random() * 1_000_000) + 100 })
  await copyRow(office(), 'WorkInstructionStep', seed.stepIds.draft, { id: stepId, versionId })
  return { versionId, stepId }
}
const publish = (versionId: string, by: string = seed.approverId) =>
  run(office(), `UPDATE "WorkInstructionVersion" SET status = 'PUBLISHED', "approvedById" = $1::uuid, "publishedAt" = now() WHERE id = $2::uuid`, by, versionId)
const supersede = (versionId: string) => run(office(), `UPDATE "WorkInstructionVersion" SET status = 'SUPERSEDED', "supersededAt" = now() WHERE id = $1::uuid`, versionId)

beforeAll(async () => {
  db = await migratedDatabase('routingsinstructions')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: NS })
  seed = await seedInstructions({ db: factory, namespace: NS })
  await seedNumbering({ db: factory, namespace: NS })
}, 180_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

describe('grants', () => {
  it('classifies the eight models of the file, none for the partner, and the acknowledgement as personal data for SAFETY', () => {
    const models = classifiedModels(loadSchema(), loadOwnership()).filter(({ model }) => model.file === 'instructions.prisma')
    expect(models.map(({ model }) => model.name).sort()).toEqual([
      'InstructionAcknowledgement',
      'OperationMachineSetting',
      'OperationTimeVersion',
      'RoutingOperationSizeTime',
      'WorkInstruction',
      'WorkInstructionMedia',
      'WorkInstructionStep',
      'WorkInstructionVersion',
    ])
    for (const { ownership } of models) expect(Object.keys(ownership.access)).not.toContain('factory_partner_runtime')
    const [ack] = personalDataOf(loadSchema(), loadOwnership()).filter((entry) => entry.table === 'InstructionAcknowledgement')
    expect(ack).toMatchObject({ subject: 'employeeId' })
    expect(new Set(Object.values(ack!.columns).flat())).toEqual(new Set(['SAFETY']))
  })

  it('the floor reads instructions and only their published and superseded versions, steps and media', async () => {
    expect(ids(await sql(floor(), 'SELECT id FROM "WorkInstruction"'))).toEqual([seed.instructionIds.archived, seed.instructionIds.revision, seed.instructionIds.sewing].sort())
    expect(ids(await sql(floor(), 'SELECT id FROM "WorkInstructionVersion"'))).toEqual(
      [seed.versionIds.archivedV1, seed.versionIds.revisionV1, seed.versionIds.sewingV1, seed.versionIds.sewingV2].sort(),
    )
    const steps = ids(await sql(floor(), 'SELECT id FROM "WorkInstructionStep"'))
    expect(steps).toEqual(expect.arrayContaining([seed.stepIds.prepare, seed.stepIds.seam, seed.stepIds.check]))
    expect(steps).not.toContain(seed.stepIds.draft)
    expect(ids(await sql(floor(), 'SELECT id FROM "WorkInstructionMedia"'))).toEqual([seed.mediaIds.photo, seed.mediaIds.video].sort())
    expect((await sql(floor(), 'SELECT id FROM "OperationMachineSetting"')).length).toBe(2)
    expect((await sql(floor(), 'SELECT id FROM "RoutingOperationSizeTime"')).length).toBe(2)
    await expect(sql(floor(), 'SELECT id FROM "OperationTimeVersion"')).rejects.toThrow(/permission denied/)
    await expect(sql(floor(), 'SELECT id FROM "InstructionAcknowledgement"')).rejects.toThrow(/permission denied/)
    await expect(run(floor(), `UPDATE "WorkInstructionStep" SET "sortOrder" = 1 WHERE id = $1::uuid`, seed.stepIds.seam)).rejects.toThrow(/permission denied/)
  })

  it('portal and link sessions read nothing here', async () => {
    for (const table of ['OperationTimeVersion', 'OperationMachineSetting', 'WorkInstruction', 'WorkInstructionVersion', 'WorkInstructionStep', 'InstructionAcknowledgement']) {
      await expect(sql(partner(), `SELECT id FROM "${table}"`)).rejects.toThrow(/permission denied/)
    }
  })
})

describe('standard minutes (PRD-111, PRD-113)', () => {
  it('basic minutes and the three allowances give the SMV, all four or none', async () => {
    await expect(freshOperation({ basicMinutes: '10.000' })).rejects.toThrow(/together, or none of them/)
    await expect(freshOperation({ basicMinutes: '0.000', personalPct: '1', fatiguePct: '1', delayPct: '1', standardMinutes: '0.000' })).rejects.toThrow(/basic minutes .* are above 0/)
    await expect(freshOperation({ basicMinutes: '10.000', personalPct: '100', fatiguePct: '0', delayPct: '0', standardMinutes: '20.000' })).rejects.toThrow(/from 0 to below 100 percent/)
    await expect(freshOperation({ basicMinutes: '10.000', personalPct: '5', fatiguePct: '4', delayPct: '3', standardMinutes: '11.000' })).rejects.toThrow(/are 11\.200 \(basic 10\.000 × \(1 \+ \(5\.0000 \+ 4\.0000 \+ 3\.0000\) \/ 100\)\), not 11\.000/)
    const op = await freshOperation({ basicMinutes: '7.333', personalPct: '5', fatiguePct: '4', delayPct: '3.5', standardMinutes: '8.250' })
    // An operation never governed keeps W1's typed SMV, or drops its allowances.
    expect(await run(office(), `UPDATE "Operation" SET "basicMinutes" = NULL, "personalPct" = NULL, "fatiguePct" = NULL, "delayPct" = NULL, "standardMinutes" = 9 WHERE id = $1::uuid`, op)).toBe(1)
  })

  it('a governed operation changes its SMV only to an approved version, proposed by one person and approved by another', async () => {
    // SEED-CUT-LEA: v1 APPROVED (14.000), v2 PROPOSED (13.440).
    expect(await admin(`SELECT "standardMinutes"::text AS smv, "basicMinutes"::text AS basic FROM "Operation" WHERE id = $1`, [seed.operationIds.cut])).toEqual([{ smv: '14.000', basic: '12.500' }])
    await expect(run(office(), `UPDATE "Operation" SET "standardMinutes" = 15, "basicMinutes" = NULL, "personalPct" = NULL, "fatiguePct" = NULL, "delayPct" = NULL WHERE id = $1::uuid`, seed.operationIds.cut)).rejects.toThrow(/only to those of an APPROVED version/)
    const toV2 = () => run(office(), `UPDATE "Operation" SET "basicMinutes" = 12, "standardMinutes" = 13.44 WHERE id = $1::uuid`, seed.operationIds.cut)
    await expect(toV2()).rejects.toThrow(/only to those of an APPROVED version/)
    // Its other columns still change.
    expect(await run(office(), `UPDATE "Operation" SET skill = 'cutter, senior' WHERE id = $1::uuid`, seed.operationIds.cut)).toBe(1)

    // A fresh operation, governed from its first approval.
    const op = await freshOperation({ basicMinutes: '10.000', personalPct: '5', fatiguePct: '5', delayPct: '5', standardMinutes: '11.500' })
    const v1 = await propose(op, 1)
    await expect(decide(v1, 'APPROVED', a.actorId)).rejects.toThrow(/decided by someone who did not propose it/)
    expect(await decide(v1, 'APPROVED', seed.approverId, 'Agreed.')).toBe(1)
    await expect(run(office(), `UPDATE "Operation" SET "standardMinutes" = 12, "basicMinutes" = NULL, "personalPct" = NULL, "fatiguePct" = NULL, "delayPct" = NULL WHERE id = $1::uuid`, op)).rejects.toThrow(/only to those of an APPROVED version/)
    const v2 = await propose(op, 2, { basicMinutes: '11.000', standardMinutes: '12.650' })
    const toV2b = () => run(office(), `UPDATE "Operation" SET "basicMinutes" = 11, "standardMinutes" = 12.65 WHERE id = $1::uuid`, op)
    await expect(toV2b()).rejects.toThrow(/only to those of an APPROVED version/)
    expect(await decide(v2, 'APPROVED', seed.approverId)).toBe(1)
    expect(await toV2b()).toBe(1)
    // The older approval is superseded; the operation stays governed: no typed number, no way back to v1's numbers.
    expect(await run(office(), `UPDATE "OperationTimeVersion" SET status = 'SUPERSEDED' WHERE id = $1::uuid`, v1)).toBe(1)
    await expect(run(office(), `UPDATE "Operation" SET "basicMinutes" = 10, "standardMinutes" = 11.5 WHERE id = $1::uuid`, op)).rejects.toThrow(/only to those of an APPROVED version/)
  })

  it('an SMV version starts PROPOSED, is decided once, never changes its numbers and is never deleted', async () => {
    const op = await freshOperation()
    await expect(propose(op, 1, { status: 'APPROVED', decidedById: seed.approverId, decidedAt: new Date().toISOString() })).rejects.toThrow(/starts PROPOSED, with no decision/)
    await expect(propose(op, 1, { reason: '  ' })).rejects.toThrow(/says why it is proposed/)
    await expect(propose(op, 1, { standardMinutes: '11.000' })).rejects.toThrow(/standard minutes of SMV version .* are 11\.500/)
    const v1 = await propose(op, 1)
    await expect(run(office(), `UPDATE "OperationTimeVersion" SET "basicMinutes" = 9, "standardMinutes" = 10.35 WHERE id = $1::uuid`, v1)).rejects.toThrow(/never changes its operation, number, minutes/)
    await expect(run(office(), `UPDATE "OperationTimeVersion" SET "effectiveFrom" = '2027-01-01' WHERE id = $1::uuid`, v1)).rejects.toThrow(/never changes its operation, number, minutes/)
    await expect(run(office(), `UPDATE "OperationTimeVersion" SET status = 'APPROVED' WHERE id = $1::uuid`, v1)).rejects.toThrow(/with who decided it and when/)
    await expect(run(office(), `UPDATE "OperationTimeVersion" SET "decisionNote" = 'early' WHERE id = $1::uuid`, v1)).rejects.toThrow(/carries a decision only when APPROVED or REJECTED/)
    await expect(decide(v1, 'REJECTED', seed.approverId)).rejects.toThrow(/rejected with why/)
    expect(await decide(v1, 'REJECTED', seed.approverId, 'The study had two hides only.')).toBe(1)
    await expect(run(office(), `UPDATE "OperationTimeVersion" SET status = 'APPROVED' WHERE id = $1::uuid`, v1)).rejects.toThrow(/cannot move from REJECTED to APPROVED/)
    await expect(run(office(), `UPDATE "OperationTimeVersion" SET "decisionNote" = 'Changed my mind.' WHERE id = $1::uuid`, v1)).rejects.toThrow(/written once/)
    // A proposal replaced before any decision carries none.
    const v2 = await propose(op, 2)
    await expect(run(office(), `UPDATE "OperationTimeVersion" SET status = 'SUPERSEDED', "decidedById" = $1::uuid, "decidedAt" = now() WHERE id = $2::uuid`, seed.approverId, v2)).rejects.toThrow(/carries a decision only when/)
    expect(await run(office(), `UPDATE "OperationTimeVersion" SET status = 'SUPERSEDED' WHERE id = $1::uuid`, v2)).toBe(1)
    await expect(admin(`DELETE FROM "OperationTimeVersion" WHERE id = $1`, [v2])).rejects.toThrow(/kept, never deleted/)
    // TRUNCATE: refused by a statement trigger on every table of the file (a referenced table refuses it anyway).
    expect(
      await admin(
        `SELECT c.relname AS table FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
          WHERE NOT t.tgisinternal AND (t.tgtype & 32) <> 0 AND c.relname = ANY ($1) ORDER BY 1`,
        [['InstructionAcknowledgement', 'OperationMachineSetting', 'OperationTimeVersion', 'RoutingOperationSizeTime', 'WorkInstruction', 'WorkInstructionMedia', 'WorkInstructionStep', 'WorkInstructionVersion']],
      ),
    ).toEqual(
      ['InstructionAcknowledgement', 'OperationMachineSetting', 'OperationTimeVersion', 'RoutingOperationSizeTime', 'WorkInstruction', 'WorkInstructionMedia', 'WorkInstructionStep', 'WorkInstructionVersion'].map((table) => ({ table })),
    )
  })
})

describe('routing depth (PRD-114, PRD-118, PRD-119, PRD-124, PRD-126, PRD-128)', () => {
  /** A fresh step on the seed's draft revision of SEED-JKT-01 (a copy of its sewing step). */
  async function freshStep(changes: Record<string, unknown> = {}, revisionId = seed.draftRevisionId): Promise<string> {
    const id = randomUUID()
    await copyRow(office(), 'RoutingOperation', seed.routingStepIds.sew, { id, revisionId, seq: Math.floor(Math.random() * 1_000_000) + 1000, inspectionPlanId: null, ...changes })
    return id
  }

  it('a step copies an APPROVED version of its own operation with its numbers', async () => {
    const step = await freshStep({ operationId: seed.operationIds.cut, code: 'SEED-CUT-LEA', standardMinutes: '14.000' })
    const copyV1 = `UPDATE "RoutingOperation" SET "timeVersionId" = $1::uuid, "basicMinutes" = $2, "personalPct" = 5, "fatiguePct" = 4, "delayPct" = 3, "standardMinutes" = $3 WHERE id = $4::uuid`
    await expect(run(office(), copyV1, seed.timeVersionIds.proposed, '12', '13.44', step)).rejects.toThrow(/copies an APPROVED SMV version of its operation, not a PROPOSED one/)
    await expect(run(office(), copyV1, seed.timeVersionIds.approved, '12', '13.44', step)).rejects.toThrow(/so its minutes and allowances are that version's/)
    expect(await run(office(), copyV1, seed.timeVersionIds.approved, '12.5', '14', step)).toBe(1)
    // The reference keeps the version of the step's own operation.
    const sewStep = await freshStep()
    await expect(run(office(), copyV1, seed.timeVersionIds.approved, '12.5', '14', sewStep)).rejects.toThrow(/foreign key|RoutingOperation_tenantId_operationId_timeVersionId_fkey/)
  })

  it('a step is only for sizes of its range and colourways of its style, named once; set-up, wait and move from 0', async () => {
    const step = await freshStep()
    const cells = (sizes: string[], colourways: string[], options: string[] = []) =>
      run(office(), `UPDATE "RoutingOperation" SET "appliesToSizes" = $1::text[], "appliesToColourwayIds" = $2::uuid[], "appliesToOptionValueIds" = $3::uuid[] WHERE id = $4::uuid`, sizes, colourways, options, step)
    const [blk, red] = [key('product:colourway:JKT-01:BLK'), key('product:colourway:JKT-01:RED')]
    await expect(cells(['56'], [])).rejects.toThrow(/only for sizes of its style's range/)
    await expect(cells(['54', '54'], [])).rejects.toThrow(/once, a size by its code/)
    await expect(cells(['5 4'], [])).rejects.toThrow(/once, a size by its code/)
    await expect(cells([], [key('production:colourway:JKT-02:BLK')])).rejects.toThrow(/only for colourways of its own style/)
    // B-W2b-211 (wave 28): an option value is a value of the library, of a group the step's style offers.
    const [group, option] = [randomUUID(), randomUUID()]
    await run(office(), `INSERT INTO "OptionGroup" (id, code, name, kind) VALUES ($1::uuid, $2, 'Test group', 'MULTI')`, group, `T-OG-${group.slice(0, 8)}`)
    await run(office(), `INSERT INTO "OptionValue" (id, "groupId", code, name) VALUES ($1::uuid, $2::uuid, 'V1', 'Test value')`, option, group)
    await run(office(), `INSERT INTO "StyleOptionGroup" (id, "styleId", "groupId") SELECT $1::uuid, r."styleId", $2::uuid FROM "StyleRevision" r WHERE r.id = $3::uuid`, randomUUID(), group, seed.draftRevisionId)
    await expect(cells([], [], [option, option])).rejects.toThrow(/once, a size by its code/)
    expect(await cells(['52', '54'], [red, blk], [option])).toBe(1)
    await expect(run(office(), `UPDATE "RoutingOperation" SET "setupMinutes" = -1 WHERE id = $1::uuid`, step)).rejects.toThrow(/set-up, wait and move minutes .* are from 0/)
    expect(await run(office(), `UPDATE "RoutingOperation" SET "setupMinutes" = 0, "waitMinutes" = 30, "moveMinutes" = 2.5 WHERE id = $1::uuid`, step)).toBe(1)
  })

  it('a checkpoint is a plan of the work, of the style company when it has one', async () => {
    const step = await freshStep()
    const plan = (planId: string) => run(office(), `UPDATE "RoutingOperation" SET "inspectionPlanId" = $1::uuid WHERE id = $2::uuid`, planId, step)
    await expect(plan(key('inspection-plans:plan:INC-LEATHER'))).rejects.toThrow(/not an INCOMING plan/)
    expect(await plan(seed.inspectionPlanId)).toBe(1)
    expect(await plan(`00000000${key('inspection-plans:plan:FIN-JACKET').slice(8)}`)).toBe(1)
    // A style of company B takes no plan of company A.
    const styleB = randomUUID()
    await copyRow(office(), 'Style', seed.styleId, { id: styleB, code: `T-STY-${tag()}`, companyId: A.companyB, status: 'DRAFT' })
    const revisionB = randomUUID()
    await copyRow(office(), 'StyleRevision', seed.draftRevisionId, { id: revisionB, styleId: styleB, revision: 1, effectiveFrom: null })
    await expect(freshStep({ styleId: styleB, inspectionPlanId: seed.inspectionPlanId }, revisionB)).rejects.toThrow(/a plan of its style's company/)
  })

  it('extra minutes per size: a size code, not 0, leaving the step above 0; frozen with a released revision', async () => {
    const step = await freshStep({ standardMinutes: '5.000', basicMinutes: null, personalPct: null, fatiguePct: null, delayPct: null })
    const size = (code: string, extra: string, revisionId = seed.draftRevisionId, stepId = step) =>
      copyRow(office(), 'RoutingOperationSizeTime', seed.sizeTimeIds.size50, { id: randomUUID(), revisionId, routingOperationId: stepId, size: code, extraMinutes: extra })
    await expect(size('5 6', '1')).rejects.toThrow(/name a size by its code \(no spaces\) and are not 0/)
    await expect(size('54', '0')).rejects.toThrow(/are not 0/)
    await expect(size('50', '-5')).rejects.toThrow(/would take 0\.000 minutes/)
    expect(await size('54', '2.5')).toBe(1)
    // The production seed's released revision of SEED-JKT-02: its step takes no new row, and its own rows never change.
    await expect(size('54', '1', seed.releasedRevisionId, seed.releasedSewStepId)).rejects.toThrow(/is RELEASED; its "RoutingOperationSizeTime" rows never change/)
    await expect(run(office(), `UPDATE "RoutingOperation" SET "setupMinutes" = 10 WHERE id = $1::uuid`, seed.releasedSewStepId)).rejects.toThrow(/is RELEASED; its "RoutingOperation" rows never change/)
  })

  it('machine settings: a library operation or one step, never moved, saying something; a step removed takes its rows along', async () => {
    const setting = (changes: Record<string, unknown>) => copyRow(office(), 'OperationMachineSetting', seed.machineSettingIds.library, { id: randomUUID(), seq: Math.floor(Math.random() * 1_000_000) + 10, ...changes })
    await expect(setting({ revisionId: seed.draftRevisionId, routingOperationId: seed.routingStepIds.sew })).rejects.toThrow(/exactly one/)
    await expect(setting({ operationId: null })).rejects.toThrow(/exactly one/)
    await expect(setting({ operationId: null, routingOperationId: seed.routingStepIds.sew })).rejects.toThrow(/exactly one/)
    await expect(setting({ stitchType: null, needle: null, thread: null, tension: null, foot: null, notes: null, stitchesPerCm: null })).rejects.toThrow(/says something/)
    await expect(setting({ needle: ' ' })).rejects.toThrow(/empty rather than blank/)
    await expect(setting({ stitchesPerCm: '0' })).rejects.toThrow(/above 0/)
    expect(await setting({ machineClassId: null, needle: '134 LR, Nm 100' })).toBe(1)
    await expect(run(office(), `UPDATE "OperationMachineSetting" SET "operationId" = $1::uuid WHERE id = $2::uuid`, seed.operationIds.cut, seed.machineSettingIds.library)).rejects.toThrow(/never moves/)
    await expect(setting({ operationId: null, revisionId: seed.releasedRevisionId, routingOperationId: seed.releasedSewStepId })).rejects.toThrow(/is RELEASED; its "OperationMachineSetting" rows never change/)

    // A draft step with a size time and a setting: removing it removes them (the W1 delete of a draft step stays one call).
    const step = await freshStep()
    await copyRow(office(), 'RoutingOperationSizeTime', seed.sizeTimeIds.size50, { id: randomUUID(), routingOperationId: step, size: '52' })
    await copyRow(office(), 'OperationMachineSetting', seed.machineSettingIds.step, { id: randomUUID(), routingOperationId: step })
    expect(await run(office(), `DELETE FROM "RoutingOperation" WHERE id = $1::uuid`, step)).toBe(1)
    expect(await admin(`SELECT (SELECT count(*) FROM "RoutingOperationSizeTime" WHERE "routingOperationId" = $1)::int AS sizes, (SELECT count(*) FROM "OperationMachineSetting" WHERE "routingOperationId" = $1)::int AS settings`, [step])).toEqual([{ sizes: 0, settings: 0 }])
  })
})

describe('a released revision and its effective days (PRD-124)', () => {
  it('a release that names no day takes the release day in Rome; then every column but the status and effectiveTo is frozen', async () => {
    const [released] = await admin(`SELECT "effectiveFrom"::text AS day, ("releasedAt" AT TIME ZONE 'Europe/Rome')::date::text AS rome FROM "StyleRevision" WHERE id = $1`, [seed.releasedRevisionId])
    expect(released!.day).toBe(released!.rome)
    const revision = await draftRevision()
    // 23:30 UTC on 25 November is already the 26th in Rome.
    expect(await release(revision, '2026-11-25T23:30:00.000Z')).toBe(1)
    expect(await admin(`SELECT "effectiveFrom"::text AS day FROM "StyleRevision" WHERE id = $1`, [revision])).toEqual([{ day: '2026-11-26' }])
    await expect(run(office(), `UPDATE "StyleRevision" SET "effectiveFrom" = '2026-12-01' WHERE id = $1::uuid`, revision)).rejects.toThrow(/is RELEASED; it never changes, a change is a new revision/)
    await expect(run(office(), `UPDATE "StyleRevision" SET "changeNote" = 'x' WHERE id = $1::uuid`, revision)).rejects.toThrow(/is RELEASED; it never changes/)
    await expect(run(office(), `UPDATE "StyleRevision" SET "effectiveTo" = '2026-12-01' WHERE id = $1::uuid`, revision)).rejects.toThrow(/only once a released revision is OBSOLETE/)
    await expect(run(office(), `UPDATE "StyleRevision" SET status = 'OBSOLETE', "effectiveTo" = '2026-11-26' WHERE id = $1::uuid`, revision)).rejects.toThrow(/stops applying \(2026-11-26\) after it starts/)
    expect(await run(office(), `UPDATE "StyleRevision" SET status = 'OBSOLETE', "effectiveTo" = '2026-12-01' WHERE id = $1::uuid`, revision)).toBe(1)
    await expect(run(office(), `UPDATE "StyleRevision" SET "effectiveTo" = '2026-12-02' WHERE id = $1::uuid`, revision)).rejects.toThrow(/set once/)
  })

  it('a draft plans its day and has no end; a planned day stays at the release; an abandoned draft never ends', async () => {
    const revision = await draftRevision()
    await expect(run(office(), `UPDATE "StyleRevision" SET "effectiveTo" = '2027-01-01' WHERE id = $1::uuid`, revision)).rejects.toThrow(/only once a released revision is OBSOLETE/)
    expect(await run(office(), `UPDATE "StyleRevision" SET "effectiveFrom" = '2027-02-01' WHERE id = $1::uuid`, revision)).toBe(1)
    expect(await release(revision)).toBe(1)
    expect(await admin(`SELECT "effectiveFrom"::text AS day FROM "StyleRevision" WHERE id = $1`, [revision])).toEqual([{ day: '2027-02-01' }])
    await run(office(), `UPDATE "StyleRevision" SET status = 'OBSOLETE' WHERE id = $1::uuid`, revision)
    const abandoned = await draftRevision()
    await expect(run(office(), `UPDATE "StyleRevision" SET status = 'OBSOLETE', "effectiveTo" = '2027-01-01' WHERE id = $1::uuid`, abandoned)).rejects.toThrow(/only once a released revision is OBSOLETE/)
  })
})

describe('work instructions (PRD-117, MES-110)', () => {
  it('one ACTIVE instruction per operation, and per operation and revision; its identity never changes; never deleted', async () => {
    const copy = (changes: Record<string, unknown>) => copyRow(office(), 'WorkInstruction', seed.instructionIds.sewing, { id: randomUUID(), number: `T-WI-${tag()}`, ...changes })
    await expect(copy({})).rejects.toThrow(/WorkInstruction_one_active_per_operation|Unique constraint|duplicate key/)
    await expect(copy({ styleId: seed.releasedStyleId, styleRevisionId: seed.releasedRevisionId })).rejects.toThrow(/WorkInstruction_one_active_per_revision|Unique constraint|duplicate key/)
    expect(await copy({ status: 'ARCHIVED' })).toBe(1)
    await expect(copy({ status: 'ARCHIVED', styleId: seed.releasedStyleId })).rejects.toThrow(/with its style, or neither/)
    await expect(copy({ status: 'ARCHIVED', number: ' ' })).rejects.toThrow(/has its number/)
    // An operation of company B is not company A's to instruct.
    const opB = await freshOperation({ companyId: A.companyB })
    await expect(copy({ operationId: opB })).rejects.toThrow(/an operation of its company or a tenant-wide one/)
    await expect(run(office(), `UPDATE "WorkInstruction" SET "operationId" = $1::uuid WHERE id = $2::uuid`, seed.operationIds.cut, seed.instructionIds.sewing)).rejects.toThrow(/only its status changes/)
    await expect(run(office(), `UPDATE "WorkInstruction" SET number = 'X-1' WHERE id = $1::uuid`, seed.instructionIds.sewing)).rejects.toThrow(/never changes|only its status changes/)
    await expect(admin(`DELETE FROM "WorkInstruction" WHERE id = $1`, [seed.instructionIds.archived])).rejects.toThrow(/archived, never deleted/)
  })

  it('a version starts DRAFT and is published by someone who did not write it, with steps, then frozen with them', async () => {
    await expect(copyRow(office(), 'WorkInstructionVersion', seed.versionIds.sewingDraft, { id: randomUUID(), number: 900, status: 'PUBLISHED', approvedById: seed.approverId, publishedAt: new Date().toISOString() })).rejects.toThrow(/starts DRAFT/)
    const { versionId, stepId } = await draftVersion()
    await expect(publish(versionId, a.actorId)).rejects.toThrow(/approved by someone who did not write it/)
    await expect(run(office(), `UPDATE "WorkInstructionVersion" SET status = 'PUBLISHED' WHERE id = $1::uuid`, versionId)).rejects.toThrow(/published exactly with who approved it/)
    await expect(run(office(), `UPDATE "WorkInstructionVersion" SET "changeNote" = NULL WHERE id = $1::uuid`, versionId)).resolves.toBe(1)
    await expect(publish(versionId)).rejects.toThrow(/says what changed before it is published/)
    await run(office(), `UPDATE "WorkInstructionVersion" SET "changeNote" = 'Twelve millimetres.' WHERE id = $1::uuid`, versionId)
    // One PUBLISHED per instruction: the old one is superseded first.
    await expect(publish(versionId)).rejects.toThrow(/WorkInstructionVersion_one_published|Unique constraint|duplicate key/)
    expect(await supersede(seed.versionIds.sewingV2)).toBe(1)
    expect(await publish(versionId)).toBe(1)

    // The steps carry the version's status, so the floor sees them now; a published version and its steps never change.
    expect(await admin(`SELECT "versionStatus"::text AS s FROM "WorkInstructionStep" WHERE id = $1`, [stepId])).toEqual([{ s: 'PUBLISHED' }])
    expect(ids(await sql(floor(), `SELECT id FROM "WorkInstructionStep" WHERE "versionId" = $1::uuid`, versionId))).toEqual([stepId])
    expect(await admin(`SELECT "versionStatus"::text AS s FROM "WorkInstructionStep" WHERE id = $1`, [seed.stepIds.seam])).toEqual([{ s: 'SUPERSEDED' }])
    await expect(run(office(), `UPDATE "WorkInstructionStep" SET "textI18n" = '{"it":"x"}' WHERE id = $1::uuid`, stepId)).rejects.toThrow(/is PUBLISHED; its "WorkInstructionStep" rows never change/)
    await expect(run(office(), `DELETE FROM "WorkInstructionStep" WHERE id = $1::uuid`, stepId)).rejects.toThrow(/is PUBLISHED; its "WorkInstructionStep" rows never change/)
    await expect(copyRow(office(), 'WorkInstructionStep', seed.stepIds.draft, { id: randomUUID(), versionId, code: 'MORE' })).rejects.toThrow(/is PUBLISHED; its "WorkInstructionStep" rows never change/)
    await expect(copyRow(office(), 'WorkInstructionStep', seed.stepIds.draft, { id: randomUUID(), versionId, versionStatus: 'PUBLISHED', code: 'MORE' })).rejects.toThrow(/added only to a DRAFT version/)
    await expect(run(office(), `UPDATE "WorkInstructionVersion" SET "changeNote" = 'x' WHERE id = $1::uuid`, versionId)).rejects.toThrow(/is PUBLISHED; nothing but its status changes/)
    await expect(run(office(), `UPDATE "WorkInstructionVersion" SET status = 'DRAFT', "approvedById" = NULL, "publishedAt" = NULL WHERE id = $1::uuid`, versionId)).rejects.toThrow(/nothing but its status changes/)
    await expect(run(office(), `UPDATE "WorkInstructionVersion" SET status = 'SUPERSEDED' WHERE id = $1::uuid`, versionId)).rejects.toThrow(/superseded exactly with when/)
    await expect(run(office(), `UPDATE "WorkInstructionVersion" SET status = 'PUBLISHED' WHERE id = $1::uuid`, seed.versionIds.sewingV1)).rejects.toThrow(/cannot move from SUPERSEDED to PUBLISHED/)
    await expect(admin(`DELETE FROM "WorkInstructionVersion" WHERE id = $1`, [versionId])).rejects.toThrow(/kept, never deleted/)

    // Back to the seed's v2 for the tests below: the new version superseded, v2 published again (past the guards).
    await admin('SET session_replication_role = replica')
    try {
      await admin(`UPDATE "WorkInstructionVersion" SET status = 'SUPERSEDED', "supersededAt" = now() WHERE id = $1`, [versionId])
      await admin(`UPDATE "WorkInstructionVersion" SET status = 'PUBLISHED', "supersededAt" = NULL WHERE id = $1`, [seed.versionIds.sewingV2])
      await admin(`UPDATE "WorkInstructionStep" SET "versionStatus" = 'PUBLISHED' WHERE "versionId" = $1`, [seed.versionIds.sewingV2])
      await admin(`UPDATE "WorkInstructionMedia" SET "versionStatus" = 'PUBLISHED' WHERE "versionId" = $1`, [seed.versionIds.sewingV2])
    } finally {
      await admin('SET session_replication_role = DEFAULT')
    }
  })

  it('a version is published with steps, on an active instruction, with every photo available; a draft nobody wants is DISCARDED', async () => {
    const empty = randomUUID()
    await copyRow(office(), 'WorkInstructionVersion', seed.versionIds.sewingDraft, { id: empty, number: 777, instructionId: seed.instructionIds.archived })
    await expect(publish(empty)).rejects.toThrow(/only on an ACTIVE instruction/)
    const { versionId } = await draftVersion(seed.instructionIds.archived)
    await run(office(), `UPDATE "WorkInstruction" SET status = 'ACTIVE' WHERE id = $1::uuid`, seed.instructionIds.archived)
    await run(office(), `DELETE FROM "WorkInstructionStep" WHERE "versionId" = $1::uuid`, versionId)
    await expect(supersede(seed.versionIds.archivedV1).then(() => publish(versionId))).rejects.toThrow(/at least one step/)
    // A photo still uploading holds the publication.
    const pending = `ffffffff${randomUUID().slice(8)}`
    await copyRow(office(), 'StoredFile', seed.fileIds.photo, { id: pending, storageKey: `t/${a.tenantId}/c/${A.company}/2026/${randomUUID()}`, status: 'PENDING_UPLOAD', availableAt: null, sha256: 'b'.repeat(64) })
    const step = randomUUID()
    await copyRow(office(), 'WorkInstructionStep', seed.stepIds.draft, { id: step, versionId })
    await copyRow(office(), 'WorkInstructionMedia', seed.mediaIds.draft, { id: randomUUID(), versionId, stepId: step, fileId: pending })
    await expect(publish(versionId)).rejects.toThrow(/every photo and video of it is available/)
    expect(await run(office(), `UPDATE "WorkInstructionVersion" SET status = 'DISCARDED' WHERE id = $1::uuid`, versionId)).toBe(1)
    expect(await admin(`SELECT DISTINCT "versionStatus"::text AS s FROM "WorkInstructionMedia" WHERE "versionId" = $1`, [versionId])).toEqual([{ s: 'DISCARDED' }])
    await expect(run(office(), `UPDATE "WorkInstructionVersion" SET status = 'DRAFT' WHERE id = $1::uuid`, versionId)).rejects.toThrow(/nothing but its status changes|cannot move from DISCARDED/)
    await run(office(), `UPDATE "WorkInstruction" SET status = 'ARCHIVED' WHERE id = $1::uuid`, seed.instructionIds.archived)
  })

  it('steps and media: words per language, codes and icons without spaces, a photo is an image and a video a video', async () => {
    const step = (changes: Record<string, unknown>) => copyRow(office(), 'WorkInstructionStep', seed.stepIds.draft, { id: randomUUID(), code: `T${tag()}`, ...changes })
    await expect(step({ code: 'TWO WORDS' })).rejects.toThrow(/a code without spaces/)
    await expect(step({ icon: 'Needle Big' })).rejects.toThrow(/an icon key in lower case/)
    await expect(step({ textI18n: { it: ' ' } })).rejects.toThrow(/its words .* per language/)
    await expect(step({ textI18n: {} })).rejects.toThrow(/its words .* per language/)
    await expect(step({ textI18n: ['Cucire'] })).rejects.toThrow(/its words .* per language/)
    await expect(step({ textI18n: { Italian: 'Cucire' } })).rejects.toThrow(/its words .* per language/)
    await expect(step({ safetyNoteI18n: { it: 3 } })).rejects.toThrow(/its words .* per language/)
    expect(await step({ textI18n: { it: 'Cucire', 'zh-Hans': '缝' } })).toBe(1)
    // The version's status a step carries moves only with its version: the reference refuses another.
    await expect(run(office(), `UPDATE "WorkInstructionStep" SET "versionStatus" = 'PUBLISHED' WHERE id = $1::uuid`, seed.stepIds.draft)).rejects.toThrow(/foreign key|WorkInstructionStep_tenantId_versionId_versionStatus_fkey/)
    const medium = (changes: Record<string, unknown>) => copyRow(office(), 'WorkInstructionMedia', seed.mediaIds.draft, { id: randomUUID(), ...changes })
    await expect(medium({ kind: 'VIDEO' })).rejects.toThrow(/is a VIDEO, so its file is a video \(this one is image\/jpeg\)/)
    await expect(medium({ fileId: seed.fileIds.video })).rejects.toThrow(/is a PHOTO, so its file is an image/)
    await expect(medium({ captionI18n: { en: '' } })).rejects.toThrow(/its caption per language/)
    expect(await medium({ kind: 'VIDEO', fileId: seed.fileIds.video })).toBe(1)
    await expect(admin(`TRUNCATE "WorkInstructionMedia"`)).rejects.toThrow(/TRUNCATE on "WorkInstructionMedia" is refused/)
  })
})

describe('acknowledgements (MES-119): a training record, append-only', () => {
  /** An acknowledgement like the operator's seeded one of v2, written with its values (the floor reads none to copy). */
  const seen = async (scope: FactoryScope, changes: Record<string, unknown>) => {
    const [row] = await admin(`SELECT to_jsonb(r) AS row FROM "InstructionAcknowledgement" r WHERE r.id = $1`, [seed.ackIds.deviceV2])
    const values = { ...(row!.row as Record<string, unknown>), id: randomUUID(), clientEventId: `t-${tag()}`, ...changes }
    const columns = ['id', 'tenantId', 'siteId', 'versionId', 'workerId', 'employeeId', 'locale', 'deviceId', 'clientEventId', 'deviceTime', 'acknowledgedAt', 'createdById']
    const list = columns.map((column) => `"${column}"`).join(', ')
    return run(scope, `INSERT INTO "InstructionAcknowledgement" (${list}) SELECT ${list} FROM jsonb_populate_record(NULL::"InstructionAcknowledgement", $1::jsonb)`, JSON.stringify(values))
  }

  it('the worker acknowledges a published version on the tablet; never a draft, never without the device', async () => {
    expect(await seen(floor(), {})).toBe(1)
    expect(await seen(floor(), { versionId: seed.versionIds.sewingV1 })).toBe(1)
    await expect(seen(floor(), { versionId: seed.versionIds.sewingDraft })).rejects.toThrow(/of a published instruction version \(this one is not published\)/)
    await expect(seen(office(), { versionId: seed.versionIds.sewingDraft })).rejects.toThrow(/of a published instruction version \(this one is DRAFT\)/)
    await expect(seen(floor(), { deviceId: null, clientEventId: null, deviceTime: null })).rejects.toThrow(/from a floor session names the device/)
    await expect(seen(office(), { deviceId: null })).rejects.toThrow(/only with its device/)
    await expect(seen(floor(), { locale: 'ita' })).rejects.toThrow(/ISO 639-1/)
    await expect(seen(floor(), { employeeId: randomUUID() })).rejects.toThrow(/Worker\.employeeId|foreign key/)
    await expect(seen(floor(), { clientEventId: ' ' })).rejects.toThrow(/no blank client event id/)
    // The office records a paper acknowledgement (no device).
    expect(await seen(office(), { deviceId: null, clientEventId: null, deviceTime: null })).toBe(1)
    // A resent event is recorded once (the device's id for it is unique).
    await expect(seen(floor(), { clientEventId: 'seed-wi-2-v2' })).rejects.toThrow(/Unique constraint|duplicate key/)
  })

  it('nobody changes or removes one, the owner included', async () => {
    await expect(run(office(), `UPDATE "InstructionAcknowledgement" SET locale = 'en' WHERE id = $1::uuid`, seed.ackIds.paper)).rejects.toThrow(/permission denied/)
    await expect(admin(`UPDATE "InstructionAcknowledgement" SET locale = 'en' WHERE id = $1`, [seed.ackIds.paper])).rejects.toThrow(/append-only; UPDATE is refused/)
    await expect(admin(`DELETE FROM "InstructionAcknowledgement" WHERE id = $1`, [seed.ackIds.paper])).rejects.toThrow(/append-only; DELETE is refused/)
    await expect(admin(`TRUNCATE "InstructionAcknowledgement"`)).rejects.toThrow(/append-only; TRUNCATE is refused/)
  })
})

describe('numbering', () => {
  it('WORK_INSTRUCTION is an office document kind with a series per company that never resets', async () => {
    expect(await admin(`SELECT pattern, reset::text AS reset FROM "NumberSeries" WHERE "tenantId" = $1 AND kind = 'WORK_INSTRUCTION' AND "companyId" = $2`, [a.tenantId, A.company])).toEqual([{ pattern: 'WI-{N:4}', reset: 'NEVER' }])
  })
})
