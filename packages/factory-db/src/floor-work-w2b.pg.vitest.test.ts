import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedAndon, type AndonSeed } from '../seed/andon'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedLabour, type LabourSeed } from '../seed/labour'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { classifiedModels, partnerWalledColumns } from './ownership'
import { FLOOR_ROLE, OFFICE_ROLE, PARTNER_ROLE, RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'
import { loadOwnership, loadSchema } from './tools'

/**
 * W2b schema wave 7/7 (floor work, B-W2b-12) beyond the generated isolation tests, on a database built from the
 * migrations and seeded twice (tenants A and B), through the real login and the scoped client:
 *   - the walls: what the floor may do, no partner, no money column; the line's figures carry no person column; the
 *     three new ledgers are append-only for every login;
 *   - the timing of an operation: one open stretch per bundle and operation, of one worker; a pause says why; a partial
 *     stays below the bundle; a reported bundle does not start again; stopping the clock works on a held work order,
 *     starting does not; standard work and off-standard time never run at once (Statuto art. 4: the person is named
 *     only where the site records workers, having acknowledged the notice);
 *   - off-standard time: approval by someone else, the site's day, an ended block changed only with a labour edit in
 *     the same transaction, one running block per worker, nothing changes in a closed line day, which closes only once
 *     its time is coded;
 *   - labour edits and disputes; help calls (one open per station and type, forward only, the station's line, the
 *     caller only where workers are named) and their routing; dispatch, coupons, findings, targets, handover notes,
 *     crews and device modes; a work order's rush flag and split; the floor checks of a site;
 *   - the seeds are idempotent.
 * The refusals are check_violation (SQLSTATE 23514), a duplicate open row a unique violation (23505); their messages are
 * read through raw SQL.
 */

const DENIED = /permission denied/
const UNIQUE = /Unique constraint|duplicate key|unique/i
const FILES = new Set(['labour.prisma', 'andon.prisma'])

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let labour: LabourSeed
let andon: AndonSeed

const NS = 'w2b12-a'
const key = (name: string): string => seedUuid(NS, name)
const A = {
  company: key('company:A'),
  site: key('site:A1'),
  siteB: key('site:B1'),
  companyB: key('company:B'),
  line: key('site:A1:line:L1'),
  sew1: key('site:A1:station:SEW-01'),
  sew2: key('site:A1:station:SEW-02'),
  cut1: key('site:A1:station:CUT-01'),
  b1Station: key('site:B1:station:SEW-01'),
  b1Worker: key('worker:B1:operator'),
}

const office = (): FactoryScope => ({ audience: 'office', tenantId: a.tenantId, actorId: a.actorId })
const floorAs = (actorId: string): FactoryScope => ({ audience: 'floor', tenantId: a.tenantId, actorId, siteId: A.site })
const partner = (): FactoryScope => ({ audience: 'partner', tenantId: a.tenantId, actorId: randomUUID(), partyId: key('party:P1') })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const sql = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$queryRawUnsafe<Record<string, unknown>[]>(text, ...values))
const run = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$executeRawUnsafe(text, ...values))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, unknown>[]
const count = async (text: string, values: unknown[] = []) => Number((await admin(text, values))[0]!.n)
const insertSql = (table: string, row: Record<string, unknown>) => {
  const columns = Object.keys(row)
    .map((column) => `"${column}"`)
    .join(', ')
  return `INSERT INTO "${table}" (${columns}) SELECT ${columns} FROM jsonb_populate_record(NULL::"${table}", $1::jsonb)`
}
const insert = (scope: FactoryScope, table: string, row: Record<string, unknown>) => run(scope, insertSql(table, row), JSON.stringify(row))
const tag = (): string => randomUUID().slice(0, 8)

// Timing rows get server times one second apart (a stretch's rows are ordered by server time), from now on.
const START = Date.now()
let tick = 0
const nextTime = (): string => new Date(START + ++tick * 1000).toISOString()

beforeAll(async () => {
  db = await migratedDatabase('floorworkw2b')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: NS })
  await seedCore({ db: factory, namespace: 'w2b12-b' })
  andon = await seedAndon({ db: factory, namespace: NS })
  labour = await seedLabour({ db: factory, namespace: NS })
  await seedAndon({ db: factory, namespace: 'w2b12-b' })
  await seedLabour({ db: factory, namespace: 'w2b12-b' })
}, 240_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

const p = () => labour.production
const operator = () => p().operatorId
const lead = () => p().leadId
const asOperator = () => floorAs(operator())
const asLead = () => floorAs(lead())
/** A scan of WO-0001 from the cutting tablet, as the operator, at a server time after the previous one. */
const scan = (kind: string, bundle: 0 | 1, operation: 'cut' | 'qc' | 'pack', extra: Record<string, unknown> = {}) =>
  insert(asOperator(), 'OperationScan', {
    id: randomUUID(),
    siteId: A.site,
    workOrderId: p().workOrderId,
    workOrderOperationId: p().operationIds[operation],
    bundleId: p().bundleIds[bundle],
    kind,
    workerId: operator(),
    deviceId: p().deviceId,
    clientScanId: `t-${tag()}-${tag()}`,
    serverTime: nextTime(),
    ...extra,
  })
const block = (extra: Record<string, unknown> = {}) => {
  const id = randomUUID()
  return {
    id,
    row: {
      id,
      companyId: A.company,
      siteId: A.site,
      lineId: A.line,
      stationId: A.sew1,
      workerId: operator(),
      codeId: labour.codeIds.WAIT_MATERIAL,
      source: 'FLOOR',
      workDate: '2026-11-19',
      startedAt: '2026-11-19T08:00:00.000Z',
      ...extra,
    },
  }
}
const hold = (from: string) =>
  run(office(), `UPDATE "WorkOrder" SET status = 'ON_HOLD', "heldFromStatus" = $2::"WorkOrderStatus", "heldAt" = now(), "heldById" = $3::uuid, "holdReason" = 'Seam strength in doubt.' WHERE id = $1::uuid`, p().workOrderId, from, a.actorId)
const lift = (to: string) =>
  run(office(), `UPDATE "WorkOrder" SET status = $2::"WorkOrderStatus", "heldFromStatus" = NULL, "heldAt" = NULL, "heldById" = NULL, "holdReason" = NULL WHERE id = $1::uuid`, p().workOrderId, to)

// --- the walls ------------------------------------------------------------------------------------------------------

describe('the walls', () => {
  const models = classifiedModels(loadSchema(), loadOwnership()).filter(({ model }) => FILES.has(model.file))

  it('the floor records floor work at its site; no partner reads anything; no money column', async () => {
    const floorAccess = Object.fromEntries(models.map(({ model, ownership }) => [model.name, ownership.access[FLOOR_ROLE]?.privileges ?? []]))
    expect(floorAccess).toEqual({
      BundleCoupon: ['select', 'insert', 'update'],
      CrewMember: ['select', 'insert', 'update'],
      CrewSession: ['select', 'insert', 'update'],
      DispatchAssignment: ['select', 'insert', 'update'],
      HandoverNote: ['select', 'insert', 'update'],
      HelpCall: ['select', 'insert', 'update'],
      HelpCallType: ['select'],
      LabourDay: ['select'],
      LabourDispute: ['select', 'insert', 'update'],
      LabourEdit: ['select', 'insert'],
      LineTarget: ['select', 'update'],
      OffStandardCode: ['select'],
      OffStandardEntry: ['select', 'insert', 'update'],
      OperationChecklistResult: ['select', 'insert'],
      OperationScanMember: ['select', 'insert'],
      ScanPatternFinding: [],
    })
    for (const { model, ownership } of models) {
      expect(ownership.access[OFFICE_ROLE], model.name).toBeDefined()
      expect(ownership.access[PARTNER_ROLE], model.name).toBeUndefined()
      expect(partnerWalledColumns(model), model.name).toEqual([])
      await expect(sql(partner(), `SELECT 1 FROM "${model.table}" LIMIT 1`), model.name).rejects.toThrow(DENIED)
    }
    await expect(sql(asOperator(), 'SELECT 1 FROM "ScanPatternFinding" LIMIT 1')).rejects.toThrow(DENIED)
    await expect(run(asOperator(), 'DELETE FROM "DispatchAssignment" WHERE false')).rejects.toThrow(DENIED)
    await expect(run(asOperator(), `UPDATE "LabourDay" SET note = 'x' WHERE false`)).rejects.toThrow(DENIED)
  })

  it('the line figures name no person (Statuto art. 4; Owner answer F2)', () => {
    for (const name of ['LabourDay', 'LineTarget', 'ScanPatternFinding', 'HelpCallType', 'CrewSession']) {
      const model = models.find((entry) => entry.model.name === name)!.model
      expect(model.columns.filter((column) => /worker|employee|person/i.test(column)), name).toEqual([])
    }
  })

  it('the team members, ticked steps and labour edits are append-only for every login', async () => {
    for (const [table, id] of [
      ['OperationScanMember', labour.memberId],
      ['OperationChecklistResult', labour.tickIds[0]],
      ['LabourEdit', labour.labourEditId],
    ] as const) {
      await expect(admin(`UPDATE "${table}" SET "createdById" = NULL WHERE id = $1`, [id]), table).rejects.toThrow(/append-only/)
      await expect(admin(`DELETE FROM "${table}" WHERE id = $1`, [id]), table).rejects.toThrow(/append-only/)
      await expect(admin(`TRUNCATE "${table}"`), table).rejects.toThrow(/TRUNCATE/)
      await expect(run(office(), `UPDATE "${table}" SET "createdById" = NULL WHERE false`), table).rejects.toThrow(DENIED)
    }
  })
})

// --- the timing of an operation -------------------------------------------------------------------------------------

describe('the timing of an operation (MES-087…092, MES-117)', () => {
  it('start, pause with a reason, resume, hand back; then someone may start again', async () => {
    expect(await scan('START', 1, 'pack')).toBe(1)
    await expect(scan('PAUSE', 1, 'pack')).rejects.toThrow(/a PAUSE, and only a PAUSE, says why/)
    expect(await scan('PAUSE', 1, 'pack', { pauseReasonCode: 'MATERIAL_WAIT' })).toBe(1)
    await expect(scan('PAUSE', 1, 'pack', { pauseReasonCode: 'BREAK' })).rejects.toThrow(/only work that runs/)
    expect(await scan('RESUME', 1, 'pack')).toBe(1)
    await expect(scan('RESUME', 1, 'pack')).rejects.toThrow(/only work paused/)
    await expect(scan('START', 1, 'pack')).rejects.toThrow(/is RUNNING .*one open stretch per bundle and operation/)
    expect(await scan('HAND_BACK', 1, 'pack')).toBe(1)
    await expect(scan('HAND_BACK', 1, 'pack')).rejects.toThrow(/only open work/)
    // A REPORT names no pause reason; a timing scan carries no counts and voids nothing.
    await expect(scan('REPORT', 1, 'pack', { goodQuantity: 2, pauseReasonCode: 'BREAK' })).rejects.toThrow(/only a PAUSE names a pause reason/)
    await expect(scan('START', 1, 'pack', { goodQuantity: 1 })).rejects.toThrow(/carries no counts/)
    await expect(scan('START', 1, 'pack', { correctsId: labour.production.scanIds[2] })).rejects.toThrow(/names no scan it voids/)
  })

  it('only the same worker pauses or resumes a stretch; a worker is named only after the notice', async () => {
    // The team leader has not acknowledged the notice: no floor record names them.
    await expect(scan('START', 1, 'qc', { workerId: lead() })).rejects.toThrow(/has not acknowledged the information notice/)
    // Once they have (a copy of the operator's acknowledgement of the notice in force), the operator's stretch is not theirs.
    await run(
      asLead(),
      `INSERT INTO "WorkerNoticeAck" (id, "siteId", "workerId", "noticeId", "noticeVersion", locale, "noticeSha256", channel, "deviceId", "createdById")
       SELECT $1::uuid, "siteId", $2::uuid, "noticeId", "noticeVersion", locale, "noticeSha256", channel, "deviceId", $2::uuid FROM "WorkerNoticeAck" WHERE "workerId" = $3::uuid LIMIT 1`,
      randomUUID(),
      lead(),
      operator(),
    )
    expect(await scan('START', 1, 'qc')).toBe(1)
    await expect(scan('PAUSE', 1, 'qc', { workerId: lead(), pauseReasonCode: 'BREAK' })).rejects.toThrow(/only work that runs, started by the same worker/)
    await expect(scan('HAND_BACK', 1, 'qc', { workerId: lead() })).rejects.toThrow(/of the same worker/)
    expect(await scan('HAND_BACK', 1, 'qc')).toBe(1)
    // A team operation: the members are named on its START (or RESUME, PARTIAL, REPORT), never on a PAUSE.
    const started = randomUUID()
    expect(await scan('START', 1, 'qc', { id: started })).toBe(1)
    expect(await insert(asOperator(), 'OperationScanMember', { id: randomUUID(), siteId: A.site, scanId: started, workerId: lead() })).toBe(1)
    const paused = randomUUID()
    expect(await scan('PAUSE', 1, 'qc', { id: paused, pauseReasonCode: 'BREAK' })).toBe(1)
    await expect(insert(asOperator(), 'OperationScanMember', { id: randomUUID(), siteId: A.site, scanId: paused, workerId: lead() })).rejects.toThrow(/members are named on its START/)
    expect(await scan('HAND_BACK', 1, 'qc')).toBe(1)
  })

  it('a partial stays below the bundle; a reported bundle does not start again', async () => {
    // Bundle 2 (two sleeve sets) at cutting: one set so far, then a second "so far" would be the whole bundle.
    expect(await scan('START', 1, 'cut')).toBe(1)
    await expect(scan('PARTIAL', 1, 'cut', { goodQuantity: 2 })).rejects.toThrow(/from 1 to fewer than the 2 garment/)
    expect(await scan('PARTIAL', 1, 'cut', { goodQuantity: 1 })).toBe(1)
    expect(await scan('START', 1, 'cut')).toBe(1)
    await expect(scan('PARTIAL', 1, 'cut', { goodQuantity: 1 })).rejects.toThrow(/stay below its 2 garment/)
    expect(await scan('REPORT', 1, 'cut', { goodQuantity: 2 })).toBe(1)
    await expect(scan('START', 1, 'cut')).rejects.toThrow(/is reported at operation .* already/)
    // The seeded sewing report of bundle 2 stands too.
    await expect(
      insert(asOperator(), 'OperationScan', {
        id: randomUUID(),
        siteId: A.site,
        workOrderId: p().workOrderId,
        workOrderOperationId: p().operationIds.sew,
        bundleId: p().bundleIds[1],
        kind: 'START',
        workerId: operator(),
        deviceId: p().deviceId,
        clientScanId: `t-${tag()}`,
      }),
    ).rejects.toThrow(/is reported at operation .* already/)
  })

  it('a held work order: the clock stops, work does not start (MES-008)', async () => {
    expect(await scan('START', 0, 'qc')).toBe(1)
    await hold('IN_PROGRESS')
    try {
      expect(await scan('PAUSE', 0, 'qc', { pauseReasonCode: 'INSTRUCTIONS' })).toBe(1)
      await expect(scan('RESUME', 0, 'qc')).rejects.toThrow(/ON_HOLD/)
      expect(await scan('HAND_BACK', 0, 'qc')).toBe(1)
      await expect(scan('START', 0, 'pack')).rejects.toThrow(/ON_HOLD/)
    } finally {
      await lift('IN_PROGRESS')
    }
  })

  it('standard work and off-standard time never run at once (MES-156)', async () => {
    expect(await scan('START', 0, 'pack')).toBe(1)
    // A block that starts now, on today's site day (Rome).
    const [now] = await admin(`SELECT now() AS at, (now() AT TIME ZONE 'Europe/Rome')::date::text AS day`)
    const today = String(now!.day)
    const running = block({ startedAt: (now!.at as Date).toISOString(), workDate: today })
    await expect(insert(asOperator(), 'OffStandardEntry', running.row)).rejects.toThrow(/starts only when no bundle runs/)
    expect(await scan('PAUSE', 0, 'pack', { pauseReasonCode: 'MATERIAL_WAIT' })).toBe(1)
    expect(await insert(asOperator(), 'OffStandardEntry', running.row)).toBe(1)
    // One running block per worker.
    const second = block({ startedAt: (now!.at as Date).toISOString(), workDate: today })
    await expect(insert(asOperator(), 'OffStandardEntry', second.row)).rejects.toThrow(UNIQUE)
    await expect(scan('RESUME', 0, 'pack')).rejects.toThrow(/while off-standard block .* is open/)
    expect(await run(asOperator(), `UPDATE "OffStandardEntry" SET status = 'PENDING', "endedAt" = "startedAt" + interval '10 minutes' WHERE id = $1::uuid`, running.id)).toBe(1)
    expect(await scan('RESUME', 0, 'pack')).toBe(1)
    expect(await scan('HAND_BACK', 0, 'pack')).toBe(1)
  })

  it('a ticked step: on a released work order and an ACTIVE bundle, by its code (MES-102)', async () => {
    const tick = (extra: Record<string, unknown>) =>
      insert(asOperator(), 'OperationChecklistResult', {
        id: randomUUID(),
        siteId: A.site,
        workOrderId: p().workOrderId,
        workOrderOperationId: p().operationIds.pack,
        bundleId: p().bundleIds[0],
        stepCode: 'FOLD',
        workerId: operator(),
        deviceId: p().deviceId,
        clientEventId: `t-${tag()}`,
        ...extra,
      })
    expect(await tick({})).toBe(1)
    await expect(tick({ stepCode: 'fold the sleeves' })).rejects.toThrow(/a code without spaces/)
    await expect(tick({ workerId: null })).rejects.toThrow(/records the worker/)
    await hold('IN_PROGRESS')
    try {
      await expect(tick({})).rejects.toThrow(/ON_HOLD/)
    } finally {
      await lift('IN_PROGRESS')
    }
  })
})

// --- off-standard time, line days, edits, disputes ------------------------------------------------------------------

describe('off-standard time and line days (MES-155…157, MES-203, MES-204)', () => {
  it('a code keeps its company and code, is never deleted, and words its icon and colour', async () => {
    await expect(run(office(), `UPDATE "OffStandardCode" SET code = 'OTHER' WHERE id = $1::uuid`, labour.codeIds.CLEANING)).rejects.toThrow(/keeps its company and its code/)
    await expect(run(office(), `UPDATE "OffStandardCode" SET colour = 'green' WHERE id = $1::uuid`, labour.codeIds.CLEANING)).rejects.toThrow(/#RRGGBB/)
    await expect(admin('DELETE FROM "OffStandardCode" WHERE id = $1', [labour.codeIds.CLEANING])).rejects.toThrow(/never deleted/)
    expect(await run(office(), `UPDATE "OffStandardCode" SET active = false, "labelEn" = 'Cleaning the station' WHERE id = $1::uuid`, labour.codeIds.TRAINING)).toBe(1)
    await expect(insert(asOperator(), 'OffStandardEntry', block({ codeId: labour.codeIds.TRAINING, endedAt: '2026-11-19T08:20:00.000Z', status: 'PENDING' }).row)).rejects.toThrow(/is inactive/)
    await run(office(), `UPDATE "OffStandardCode" SET active = true WHERE id = $1::uuid`, labour.codeIds.TRAINING)
  })

  it("approval: by someone else, never on the way in for a code the team leader approves; the site's day", async () => {
    const ended = { endedAt: '2026-11-19T08:30:00.000Z' }
    await expect(insert(asOperator(), 'OffStandardEntry', block({ ...ended, status: 'APPROVED', approvedAt: '2026-11-19T08:30:00.000Z', approvedById: lead() }).row)).rejects.toThrow(/waits PENDING/)
    const pending = block({ ...ended, status: 'PENDING' })
    expect(await insert(asOperator(), 'OffStandardEntry', pending.row)).toBe(1)
    await expect(run(office(), `UPDATE "OffStandardEntry" SET status = 'APPROVED', "approvedAt" = now(), "approvedById" = $2::uuid WHERE id = $1::uuid`, pending.id, operator())).rejects.toThrow(/someone else than the worker/)
    expect(await run(asLead(), `UPDATE "OffStandardEntry" SET status = 'APPROVED', "approvedAt" = now(), "approvedById" = $2::uuid WHERE id = $1::uuid`, pending.id, lead())).toBe(1)
    // A code that needs no approval is approved as it ends.
    expect(await insert(asOperator(), 'OffStandardEntry', block({ ...ended, codeId: labour.codeIds.CLEANING, status: 'APPROVED', approvedAt: '2026-11-19T08:30:00.000Z' }).row)).toBe(1)
    // 23:30 UTC on 19 Nov is 00:30 on the 20th in Rome.
    await expect(insert(asOperator(), 'OffStandardEntry', block({ startedAt: '2026-11-19T23:30:00.000Z', endedAt: '2026-11-19T23:40:00.000Z', status: 'PENDING' }).row)).rejects.toThrow(/site's day it started in \(2026-11-20\)/)
    await expect(insert(asOperator(), 'OffStandardEntry', block({ endedAt: '2026-11-19T07:00:00.000Z', status: 'PENDING' }).row)).rejects.toThrow(/never ending before it started/)
    await expect(insert(asOperator(), 'OffStandardEntry', block({ ...ended, status: 'PENDING', source: 'HELP_CALL' }).row)).rejects.toThrow(/names a help call exactly when/)
    await expect(admin('DELETE FROM "OffStandardEntry" WHERE id = $1', [pending.id])).rejects.toThrow(/never deleted/)
  })

  it('an ended block changes only with a labour edit in the same transaction (MES-204)', async () => {
    const pending = block({ endedAt: '2026-11-19T09:00:00.000Z', status: 'PENDING', startedAt: '2026-11-19T08:40:00.000Z' })
    expect(await insert(asOperator(), 'OffStandardEntry', pending.row)).toBe(1)
    await expect(run(asLead(), `UPDATE "OffStandardEntry" SET "endedAt" = '2026-11-19T08:55:00Z' WHERE id = $1::uuid`, pending.id)).rejects.toThrow(/write its LabourEdit in the same command/)
    const edit = {
      id: randomUUID(),
      companyId: A.company,
      siteId: A.site,
      lineId: A.line,
      workDate: '2026-11-19',
      recordType: 'OffStandardEntry',
      recordId: pending.id,
      workerId: operator(),
      before: { endedAt: '2026-11-19T09:00:00.000Z' },
      after: { endedAt: '2026-11-19T08:55:00.000Z' },
      reason: 'The material came at 09:55.',
      createdById: lead(),
    }
    await as(asLead(), (client) =>
      client.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`UPDATE "OffStandardEntry" SET "endedAt" = '2026-11-19T08:55:00Z' WHERE id = $1::uuid`, pending.id)
        await tx.$executeRawUnsafe(insertSql('LabourEdit', edit), JSON.stringify(edit))
      }),
    )
    const [after] = await admin('SELECT "endedAt" FROM "OffStandardEntry" WHERE id = $1', [pending.id])
    expect((after!.endedAt as Date).toISOString()).toBe('2026-11-19T08:55:00.000Z')
    // The note and a decision are not facts: no edit needed.
    expect(await run(asLead(), `UPDATE "OffStandardEntry" SET note = 'Trolley late.' WHERE id = $1::uuid`, pending.id)).toBe(1)
  })

  it('a line day closes once its time is coded; then nothing of it changes until it is reopened with a reason', async () => {
    const day = randomUUID()
    const close = () =>
      insert(office(), 'LabourDay', { id: day, siteId: A.site, lineId: A.line, workDate: '2026-11-17', status: 'CLOSED', closedAt: '2026-10-01T17:00:00.000Z', closedById: a.actorId })
    // 17 Nov still has the seeded PENDING waiting for material.
    await expect(close()).rejects.toThrow(/closes once its off-standard time is coded .*1 block/)
    expect(await run(asLead(), `UPDATE "OffStandardEntry" SET status = 'APPROVED', "approvedAt" = now(), "approvedById" = $2::uuid WHERE id = $1::uuid`, labour.blockIds[0], lead())).toBe(1)
    expect(await close()).toBe(1)
    await expect(run(asLead(), `UPDATE "OffStandardEntry" SET note = 'late note' WHERE id = $1::uuid`, labour.blockIds[0])).rejects.toThrow(/is CLOSED .* reopened with a reason/)
    await expect(insert(asOperator(), 'OffStandardEntry', block({ workDate: '2026-11-17', startedAt: '2026-11-17T11:00:00.000Z', endedAt: '2026-11-17T11:10:00.000Z', status: 'PENDING' }).row)).rejects.toThrow(/is CLOSED/)
    await expect(run(office(), `UPDATE "LabourDay" SET status = 'OPEN', "closedAt" = NULL, "closedById" = NULL WHERE id = $1::uuid`, day)).rejects.toThrow(/records a new reopening/)
    await expect(run(office(), `UPDATE "LabourDay" SET "closedAt" = now() WHERE id = $1::uuid`, day)).rejects.toThrow(/only its note changes/)
    expect(
      await run(office(), `UPDATE "LabourDay" SET status = 'OPEN', "closedAt" = NULL, "closedById" = NULL, "reopenedAt" = now(), "reopenedById" = $2::uuid, "reopenReason" = 'A dispute to answer.' WHERE id = $1::uuid`, day, a.actorId),
    ).toBe(1)
    expect(await run(asLead(), `UPDATE "OffStandardEntry" SET note = 'late note' WHERE id = $1::uuid`, labour.blockIds[0])).toBe(1)
    await expect(admin('DELETE FROM "LabourDay" WHERE id = $1', [day])).rejects.toThrow(/never deleted/)
  })

  it('a labour edit keeps before and after with the same keys, why and who', async () => {
    const edit = (extra: Record<string, unknown>) =>
      insert(office(), 'LabourEdit', {
        id: randomUUID(),
        companyId: A.company,
        siteId: A.site,
        workDate: '2026-11-17',
        recordType: 'OperationScan',
        recordId: p().scanIds[2],
        workerId: operator(),
        before: { goodQuantity: 2 },
        after: { goodQuantity: 1 },
        reason: 'One set stained.',
        createdById: a.actorId,
        ...extra,
      })
    expect(await edit({})).toBe(1)
    await expect(edit({ after: { scrapQuantity: 1 } })).rejects.toThrow(/same keys/)
    await expect(edit({ after: { goodQuantity: 2 } })).rejects.toThrow(/not equal/)
    await expect(edit({ reason: ' ' })).rejects.toThrow(/says why and who/)
    await expect(edit({ createdById: null })).rejects.toThrow(/says why and who/)
    await expect(edit({ disputeId: labour.disputeIds[0], workerId: null })).rejects.toThrow(/another worker's record/)
  })

  it("a dispute: OPEN with the worker's words, answered by someone else, then final; never at a site that names no worker", async () => {
    const dispute = { siteId: A.site, workerId: operator(), workDate: '2026-11-17', recordType: 'OffStandardEntry', recordId: labour.blockIds[1], message: 'I cleaned for 20 minutes.' }
    const id = randomUUID()
    expect(await insert(asOperator(), 'LabourDispute', { id, ...dispute })).toBe(1)
    await expect(run(asOperator(), `UPDATE "LabourDispute" SET message = 'Something else.' WHERE id = $1::uuid`, id)).rejects.toThrow(/never change/)
    await expect(
      run(asOperator(), `UPDATE "LabourDispute" SET status = 'REJECTED', answer = 'No.', "answeredAt" = now(), "answeredById" = $2::uuid WHERE id = $1::uuid`, id, operator()),
    ).rejects.toThrow(/never by the worker who raised it/)
    await expect(run(office(), `UPDATE "LabourDispute" SET status = 'REJECTED', "answeredAt" = now(), "answeredById" = $2::uuid WHERE id = $1::uuid`, id, a.actorId)).rejects.toThrow(/exactly with the answer/)
    expect(await run(asOperator(), `UPDATE "LabourDispute" SET status = 'WITHDRAWN', "withdrawnAt" = now() WHERE id = $1::uuid`, id)).toBe(1)
    await expect(run(office(), `UPDATE "LabourDispute" SET status = 'OPEN', "withdrawnAt" = NULL WHERE id = $1::uuid`, id)).rejects.toThrow(/then final/)
    await expect(insert(office(), 'LabourDispute', { id: randomUUID(), ...dispute, status: 'UPHELD' })).rejects.toThrow(/starts OPEN/)
    // B1 records the station only: no record there names a worker, so none is disputed.
    await expect(insert(office(), 'LabourDispute', { id: randomUUID(), ...dispute, siteId: A.siteB, workerId: A.b1Worker })).rejects.toThrow(/records the station, not the worker/)
  })
})

// --- help calls -----------------------------------------------------------------------------------------------------

describe('help calls and their routing (MES-142…148)', () => {
  const call = (extra: Record<string, unknown> = {}) =>
    insert(asOperator(), 'HelpCall', { id: randomUUID(), siteId: A.site, typeId: andon.typeIds.maintenance, stationId: A.sew2, lineId: A.line, sentAt: new Date().toISOString(), ...extra })

  it("one open call per station and type; the station's line; the caller only where the site names workers", async () => {
    await expect(call()).rejects.toThrow(UNIQUE)
    expect(await call({ typeId: andon.typeIds.teamLeader, workerId: operator() })).toBe(1)
    await expect(call({ typeId: andon.typeIds.material, lineId: null })).rejects.toThrow(/carries the line of its station/)
    await expect(call({ typeId: andon.typeIds.material, stationId: A.cut1, lineId: null, bundleId: p().bundleIds[0] })).rejects.toThrow(/a bundle with its work order/)
    // A type at B1 (records stations): a call there names no worker.
    const typeB = randomUUID()
    expect(await insert(office(), 'HelpCallType', { id: typeB, companyId: A.companyB, siteId: A.siteB, code: 'MATERIAL', kind: 'MATERIAL' })).toBe(1)
    await expect(
      insert(office(), 'HelpCall', { id: randomUUID(), siteId: A.siteB, typeId: typeB, stationId: A.b1Station, lineId: key('site:B1:line:L1'), workerId: A.b1Worker, sentAt: new Date().toISOString() }),
    ).rejects.toThrow(/records the station, not the worker/)
    expect(await insert(office(), 'HelpCall', { id: randomUUID(), siteId: A.siteB, typeId: typeB, stationId: A.b1Station, lineId: key('site:B1:line:L1'), sentAt: new Date().toISOString() })).toBe(1)
  })

  it('Sent → Seen → On the way → Solved, forward only, each time once; solved and cancelled are final', async () => {
    const open = andon.callIds[1]
    await expect(run(asLead(), `UPDATE "HelpCall" SET status = 'SEEN' WHERE id = $1::uuid`, open)).rejects.toThrow(/each state with its time/)
    // The seeded call was sent at 13:05 Rome on 17 Nov.
    expect(await run(asLead(), `UPDATE "HelpCall" SET status = 'SEEN', "seenAt" = '2026-11-17T12:07:00Z', "seenById" = $2::uuid WHERE id = $1::uuid`, open, lead())).toBe(1)
    await expect(run(asLead(), `UPDATE "HelpCall" SET "seenAt" = '2026-11-17T12:08:00Z' WHERE id = $1::uuid`, open)).rejects.toThrow(/set once/)
    await expect(run(asLead(), `UPDATE "HelpCall" SET "workerId" = $2::uuid WHERE id = $1::uuid`, open, operator())).rejects.toThrow(/never change/)
    await expect(run(asLead(), `UPDATE "HelpCall" SET status = 'SOLVED', "solvedAt" = '2026-11-17T12:06:00Z' WHERE id = $1::uuid`, open)).rejects.toThrow(/each time after the one before/)
    expect(await run(asLead(), `UPDATE "HelpCall" SET status = 'SOLVED', "solvedAt" = '2026-11-17T12:30:00Z', "solvedById" = $2::uuid, "resolutionCode" = 'TIGHTENED' WHERE id = $1::uuid`, open, lead())).toBe(1)
    await expect(run(asLead(), `UPDATE "HelpCall" SET status = 'CANCELLED', "cancelledAt" = '2026-11-17T12:31:00Z' WHERE id = $1::uuid`, open)).rejects.toThrow(/it is final/)
    // What it led to is named once, even after it was solved.
    expect(await run(office(), `UPDATE "HelpCall" SET "outcomeRecordType" = 'MaintenanceJob', "outcomeRecordId" = $2::uuid WHERE id = $1::uuid`, open, randomUUID())).toBe(1)
    await expect(run(office(), `UPDATE "HelpCall" SET "outcomeRecordId" = $2::uuid WHERE id = $1::uuid`, open, randomUUID())).rejects.toThrow(/set once/)
    await expect(admin('DELETE FROM "HelpCall" WHERE id = $1', [open])).rejects.toThrow(/never deleted/)
    // A new call at SEW-02 may be sent now that the first is solved.
    expect(await call()).toBe(1)
  })

  it('a type: a code, a responder role of the tenant, escalation in range, the waiting on an OFF_STANDARD code', async () => {
    const type = (extra: Record<string, unknown>) => insert(office(), 'HelpCallType', { id: randomUUID(), companyId: A.company, siteId: A.site, code: `Q_${tag()}`, kind: 'QUALITY', ...extra })
    expect(await type({ responderRecordType: 'Role', responderRecordId: key('role:floor_inspector'), escalateAfterMinutes: 15, offStandardCodeId: labour.codeIds.WAIT_HELP })).toBe(1)
    await expect(type({ responderRecordType: 'Role', responderRecordId: randomUUID() })).rejects.toThrow(/not a role of the tenant/)
    await expect(type({ responderRecordType: 'Group', responderRecordId: randomUUID() })).rejects.toThrow(/Team or Role/)
    await expect(type({ escalateAfterMinutes: 0 })).rejects.toThrow(/1-240 minutes/)
    await expect(type({ offStandardCodeId: labour.codeIds.CLEANING })).rejects.toThrow(/ACTIVE OFF_STANDARD code/)
    await expect(run(office(), `UPDATE "HelpCallType" SET code = 'OTHER' WHERE id = $1::uuid`, andon.typeIds.material)).rejects.toThrow(/keeps its company, site and code/)
    await expect(admin('DELETE FROM "HelpCallType" WHERE id = $1', [andon.typeIds.material])).rejects.toThrow(/never deleted/)
  })
})

// --- dispatch, coupons, findings, targets, notes --------------------------------------------------------------------

describe('dispatch, coupons, findings, targets and handover notes', () => {
  it('a dispatch line: a station or an operation, an operator or an operation at a station, bundles of the work order', async () => {
    const line = (extra: Record<string, unknown>) => insert(office(), 'DispatchAssignment', { id: randomUUID(), siteId: A.site, workDate: '2026-11-19', ...extra })
    expect(await line({ workerId: operator(), workOrderId: p().workOrderId, workOrderOperationId: p().operationIds.pack, bundleIds: [p().bundleIds[0], p().bundleIds[1]] })).toBe(1)
    await expect(line({ workerId: operator() })).rejects.toThrow(/names a station or an operation/)
    await expect(line({ workOrderId: p().workOrderId, workOrderOperationId: p().operationIds.pack })).rejects.toThrow(/an operator or an operation queued at a station/)
    await expect(line({ stationId: A.sew1, workerId: operator(), bundleIds: [p().bundleIds[0]] })).rejects.toThrow(/bundles only with an operation/)
    await expect(line({ stationId: A.sew1, workerId: operator(), workOrderId: p().workOrderId, workOrderOperationId: p().operationIds.sew, bundleIds: [p().bundleIds[0], p().bundleIds[0]] })).rejects.toThrow(/each bundle once/)
    await expect(line({ stationId: A.sew1, workerId: operator(), workOrderId: p().workOrderId, workOrderOperationId: p().operationIds.sew, bundleIds: [randomUUID()] })).rejects.toThrow(/ACTIVE bundles of work order/)
    await expect(line({ stationId: A.cut1, lineId: A.line, workerId: operator() })).rejects.toThrow(/of its line when both are named/)
    await expect(line({ stationId: A.sew1, workerId: operator(), sequence: 0 })).rejects.toThrow(/a lane order from 1/)
    await expect(line({ stationId: A.sew1, workerId: operator(), overrideReason: 'Trained last week.' })).rejects.toThrow(/override with its reason and who/)
    // The team leader reassigns on the floor; the office removes a line.
    expect(await run(asLead(), `UPDATE "DispatchAssignment" SET "workerId" = $2::uuid WHERE id = $1::uuid`, labour.dispatchIds[0], lead())).toBe(1)
    expect(await run(office(), `DELETE FROM "DispatchAssignment" WHERE id = $1::uuid`, labour.dispatchIds[0])).toBe(1)
  })

  it('a coupon: one ACTIVE per bundle and operation, VOID with when and why, final; it replaces a VOID one', async () => {
    const coupon = (extra: Record<string, unknown>) =>
      insert(asOperator(), 'BundleCoupon', { id: randomUUID(), siteId: A.site, workOrderId: p().workOrderId, bundleId: p().bundleIds[0], workOrderOperationId: p().operationIds.sew, code: `SEED-CP-${tag()}`, ...extra })
    await expect(coupon({})).rejects.toThrow(UNIQUE)
    await expect(coupon({ workOrderOperationId: p().operationIds.qc, replacesId: labour.couponIds[1] })).rejects.toThrow(/replaces a coupon of the same bundle and operation/)
    await expect(run(asOperator(), `UPDATE "BundleCoupon" SET status = 'VOID' WHERE id = $1::uuid`, labour.couponIds[1])).rejects.toThrow(/VOID exactly with when and why/)
    await expect(run(asOperator(), `UPDATE "BundleCoupon" SET code = 'X' WHERE id = $1::uuid`, labour.couponIds[1])).rejects.toThrow(/only becomes VOID/)
    expect(await run(asOperator(), `UPDATE "BundleCoupon" SET status = 'VOID', "voidedAt" = now(), "voidReason" = 'Lost.' WHERE id = $1::uuid`, labour.couponIds[1])).toBe(1)
    await expect(run(asOperator(), `UPDATE "BundleCoupon" SET status = 'ACTIVE', "voidedAt" = NULL, "voidReason" = NULL WHERE id = $1::uuid`, labour.couponIds[1])).rejects.toThrow(/only becomes VOID/)
    expect(await coupon({ replacesId: labour.couponIds[1] })).toBe(1)
  })

  it('a scan finding: what it saw never changes; reviewed or dismissed (with why), then final; no person', async () => {
    const [open, reviewed] = labour.findingIds
    await expect(run(office(), `UPDATE "ScanPatternFinding" SET detail = '{"scans": 7}' WHERE id = $1::uuid`, open)).rejects.toThrow(/never changes/)
    await expect(run(office(), `UPDATE "ScanPatternFinding" SET status = 'DISMISSED', "reviewedAt" = now(), "reviewedById" = $2::uuid WHERE id = $1::uuid`, open, a.actorId)).rejects.toThrow(/a dismissal says why/)
    expect(await run(office(), `UPDATE "ScanPatternFinding" SET status = 'DISMISSED', "reviewedAt" = now(), "reviewedById" = $2::uuid, "reviewNote" = 'End of an order.' WHERE id = $1::uuid`, open, a.actorId)).toBe(1)
    await expect(run(office(), `UPDATE "ScanPatternFinding" SET "reviewNote" = 'changed' WHERE id = $1::uuid`, reviewed)).rejects.toThrow(/it is final/)
    await expect(
      insert(office(), 'ScanPatternFinding', { id: randomUUID(), siteId: A.site, workOrderId: p().workOrderId, bundleId: p().bundleIds[0], kind: 'MOVED_NOT_SCANNED', windowStart: '2026-11-19T10:00:00Z', windowEnd: '2026-11-19T09:00:00Z' }),
    ).rejects.toThrow(/ends after it starts/)
  })

  it('a target: the floor gives only the reason of a short hour, with when and who', async () => {
    const [eight] = andon.targetIds
    await expect(run(asLead(), `UPDATE "LineTarget" SET "targetPieces" = 4 WHERE id = $1::uuid`, eight)).rejects.toThrow(/set in the office/)
    await expect(run(asLead(), `UPDATE "LineTarget" SET "shortNote" = 'Slow start.' WHERE id = $1::uuid`, eight)).rejects.toThrow(/with when and who/)
    expect(await run(asLead(), `UPDATE "LineTarget" SET "shortNote" = 'Slow start.', "shortReasonAt" = now(), "shortReasonById" = $2::uuid WHERE id = $1::uuid`, eight, lead())).toBe(1)
    expect(await run(office(), `UPDATE "LineTarget" SET "targetPieces" = 5 WHERE id = $1::uuid`, eight)).toBe(1)
    await expect(run(office(), `UPDATE "LineTarget" SET hour = 9 WHERE id = $1::uuid`, eight)).rejects.toThrow(/never change/)
    await expect(insert(office(), 'LineTarget', { id: randomUUID(), siteId: A.site, lineId: A.line, workDate: '2026-11-19', hour: 8, targetPieces: -1 })).rejects.toThrow(/pieces from 0/)
  })

  it('a handover note: a topic or a text, each topic once, its shift fixed', async () => {
    const note = (extra: Record<string, unknown>) => insert(asLead(), 'HandoverNote', { id: randomUUID(), siteId: A.site, lineId: A.line, shiftDate: '2026-11-19', shiftLabel: `B-${tag()}`, ...extra })
    expect(await note({ text: 'All quiet.' })).toBe(1)
    await expect(note({})).rejects.toThrow(/a topic or a short text/)
    await expect(note({ topics: ['MACHINES', 'MACHINES'] })).rejects.toThrow(/each topic once/)
    await expect(note({ text: 'x'.repeat(1001) })).rejects.toThrow(/at most 1000 characters/)
    await expect(run(asLead(), `UPDATE "HandoverNote" SET "shiftLabel" = 'B' WHERE id = $1::uuid`, andon.handoverNoteId)).rejects.toThrow(/never change/)
    expect(await run(asLead(), `UPDATE "HandoverNote" SET text = 'SEW-02 fixed.' WHERE id = $1::uuid`, andon.handoverNoteId)).toBe(1)
  })
})

// --- crews, device modes, work orders, floor checks -----------------------------------------------------------------

describe('crews, device modes, work orders and the floor checks', () => {
  it('a crew: one open per station tablet, one active member, members leave before it ends (PLT-059)', async () => {
    const crew = randomUUID()
    const crewRow = { id: crew, siteId: A.site, deviceId: p().deviceId, startedAt: new Date(START - 3_600_000).toISOString() }
    expect(await insert(asOperator(), 'CrewSession', crewRow)).toBe(1)
    await expect(insert(asOperator(), 'CrewSession', { ...crewRow, id: randomUUID() })).rejects.toThrow(UNIQUE)
    const member = (workerId: string, extra: Record<string, unknown> = {}) => {
      const id = randomUUID()
      return { id, done: insert(asOperator(), 'CrewMember', { id, siteId: A.site, crewSessionId: crew, workerId, joinedAt: new Date(START - 1_800_000).toISOString(), ...extra }) }
    }
    const first = member(operator(), { active: true })
    expect(await first.done).toBe(1)
    const second = member(lead())
    expect(await second.done).toBe(1)
    await expect(member(operator()).done).rejects.toThrow(/in another open crew/)
    await expect(run(asOperator(), `UPDATE "CrewMember" SET active = true WHERE id = $1::uuid`, second.id)).rejects.toThrow(UNIQUE)
    await expect(run(asOperator(), `UPDATE "CrewSession" SET "endedAt" = now(), "endReason" = 'SIGNED_OUT' WHERE id = $1::uuid`, crew)).rejects.toThrow(/once every member has left/)
    await expect(run(asOperator(), `UPDATE "CrewMember" SET "leftAt" = now() WHERE id = $1::uuid`, first.id)).rejects.toThrow(/no longer the active one/)
    expect(await run(asOperator(), `UPDATE "CrewMember" SET "leftAt" = now(), active = false WHERE id IN ($1::uuid, $2::uuid)`, first.id, second.id)).toBe(2)
    await expect(run(asOperator(), `UPDATE "CrewMember" SET active = true WHERE id = $1::uuid`, first.id)).rejects.toThrow(/a member who left is final/)
    expect(await run(asOperator(), `UPDATE "CrewSession" SET "endedAt" = now(), "endReason" = 'SIGNED_OUT' WHERE id = $1::uuid`, crew)).toBe(1)
    await expect(run(asOperator(), `UPDATE "CrewSession" SET "endReason" = 'IDLE' WHERE id = $1::uuid`, crew)).rejects.toThrow(/an ended crew is final/)
    await expect(member(operator()).done).rejects.toThrow(/while it is open/)
  })

  it('a device mode: a line for LINE or DISPLAY, a worker for a PHONE, chosen in the office only', async () => {
    const device = p().deviceId
    await expect(run(office(), `UPDATE "Device" SET "lineId" = $2::uuid WHERE id = $1::uuid`, device, A.line)).rejects.toThrow(/a line is for a LINE or DISPLAY device/)
    await expect(run(office(), `UPDATE "Device" SET "personalWorkerId" = $2::uuid WHERE id = $1::uuid`, device, operator())).rejects.toThrow(/a personal worker only for a PHONE/)
    await expect(run(asOperator(), `UPDATE "Device" SET mode = 'DISPLAY' WHERE id = $1::uuid`, device)).rejects.toThrow(/never on the floor/)
    // The floor still records its last contact.
    expect(await run(asOperator(), `UPDATE "Device" SET "lastSeenAt" = now() WHERE id = $1::uuid`, device)).toBe(1)
    expect(await run(office(), `UPDATE "Device" SET mode = 'DISPLAY', "lineId" = $2::uuid WHERE id = $1::uuid`, device, A.line)).toBe(1)
    // A crew signs in only on a station tablet.
    await expect(insert(asOperator(), 'CrewSession', { id: randomUUID(), siteId: A.site, deviceId: device, startedAt: new Date().toISOString() })).rejects.toThrow(/in DISPLAY mode/)
    expect(await run(office(), `UPDATE "Device" SET mode = 'STATION', "lineId" = NULL WHERE id = $1::uuid`, device)).toBe(1)
  })

  it('a work order: the rush flag changes after release; a split names another work order of the same style, for good', async () => {
    expect(await run(office(), `UPDATE "WorkOrder" SET rush = true, priority = 5 WHERE id = $1::uuid`, p().workOrderId)).toBe(1)
    const draft = (await admin('SELECT "companyId", "styleId", kind::text AS kind FROM "WorkOrder" WHERE id = $1', [p().workOrderId]))[0]!
    const child = randomUUID()
    const order = (id: string, extra: Record<string, unknown>) =>
      insert(office(), 'WorkOrder', { id, companyId: draft.companyId, siteId: A.site, number: `WO-T-${tag()}`, kind: draft.kind, styleId: draft.styleId, splitFromId: p().workOrderId, ...extra })
    expect(await order(child, {})).toBe(1)
    const other = (await admin('SELECT id FROM "Style" WHERE "tenantId" = $1 AND id <> $2 LIMIT 1', [a.tenantId, draft.styleId]))[0]!.id
    await expect(order(randomUUID(), { styleId: other })).rejects.toThrow(/split from another work order of the same style and kind/)
    await expect(order(randomUUID(), { splitFromId: p().draftWorkOrderId, kind: 'MADE_TO_MEASURE' })).rejects.toThrow(/same style and kind/)
    await expect(run(office(), `UPDATE "WorkOrder" SET "splitFromId" = NULL WHERE id = $1::uuid`, child)).rejects.toThrow(/split and creation .* never change/)
    await run(office(), `UPDATE "WorkOrder" SET rush = false, priority = 0 WHERE id = $1::uuid`, p().workOrderId)
  })

  it('the floor checks of a site: defaults, a scrap limit from 1 piece, stuck after 1-720 hours', async () => {
    const [rules] = await admin(`SELECT "quantityGuard"::text AS q, "skippedOperationRule"::text AS s, "bundleCodeMode"::text AS m, "stuckBundleHours" AS h, "scrapApprovalLimit" AS l FROM "ProductionSettings" WHERE id = $1`, [A.site])
    expect(rules).toEqual({ q: 'STRICT', s: 'WARN', m: 'ONE_CODE', h: 4, l: null })
    await expect(run(office(), `UPDATE "ProductionSettings" SET "stuckBundleHours" = 0 WHERE id = $1::uuid`, A.site)).rejects.toThrow(/1-720 hours/)
    await expect(run(office(), `UPDATE "ProductionSettings" SET "scrapApprovalLimit" = 0 WHERE id = $1::uuid`, A.site)).rejects.toThrow(/from 1 scrapped piece/)
    expect(await run(office(), `UPDATE "ProductionSettings" SET "scrapApprovalLimit" = 3, "bundleCodeMode" = 'COUPON_PER_OPERATION' WHERE id = $1::uuid`, A.site)).toBe(1)
    await run(office(), `UPDATE "ProductionSettings" SET "scrapApprovalLimit" = NULL, "bundleCodeMode" = 'ONE_CODE' WHERE id = $1::uuid`, A.site)
  })
})

describe('the seeds', () => {
  it('are idempotent', async () => {
    const tables = ['OffStandardCode', 'OffStandardEntry', 'LabourEdit', 'LabourDispute', 'HelpCallType', 'HelpCall', 'LineTarget', 'HandoverNote', 'CrewSession', 'CrewMember', 'BundleCoupon', 'ScanPatternFinding', 'OperationScanMember', 'OperationChecklistResult']
    const before = await Promise.all(tables.map((table) => count(`SELECT count(*) AS n FROM "${table}"`)))
    await seedAndon({ db: factory, namespace: NS })
    await seedLabour({ db: factory, namespace: NS })
    expect(await Promise.all(tables.map((table) => count(`SELECT count(*) AS n FROM "${table}"`)))).toEqual(before)
  })
})
