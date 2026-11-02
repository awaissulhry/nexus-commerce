import { randomUUID } from 'node:crypto'
import { formatScanId, parseScanId, tenantTag } from '@nexus/factory-domain/numbering/scan-id'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedAndon, type AndonSeed } from '../seed/andon'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedLabour, type LabourSeed } from '../seed/labour'
import { seed as seedNumberingBlocks } from '../seed/numbering-blocks'
import { seed as seedPay, type PaySeed } from '../seed/pay'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { classifiedModels } from './ownership'
import { FLOOR_ROLE, OFFICE_ROLE, PARTNER_ROLE, RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'
import { loadOwnership, loadSchema } from './tools'

/**
 * W2b schema wave 8/16 (the floor follow-ups of W2b-1, B-W2b-74) beyond the generated isolation tests, on a database built
 * from the migrations and seeded twice (tenants A and B), through the real login and the scoped client. One test per item:
 * the qualification rule, scrap approvals, the COUPON scan kind (an old BN- coupon stays valid), unplanned operations as
 * real steps (MES-005's freeze stays for the routing's copies), the floor deciding a correction (the four-eyes check runs
 * in a floor session, which may not name Worker.userId), parallel groups and their frozen copy, a BOM line's step,
 * off-standard time per work order, what a material call asks, a scrap reason's fault. Refusals are check_violation
 * (23514) and read through raw SQL.
 */

const NS = 'w2b74-a'
const key = (name: string): string => seedUuid(NS, name)
const A = { company: key('company:A'), site: key('site:A1'), line: key('site:A1:line:L1'), sew1: key('site:A1:station:SEW-01') }
const E = { operator: `00000000${key('people:employee:A1:1').slice(8)}` }

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let labour: LabourSeed
let andon: AndonSeed
let pay: PaySeed

const office = (): FactoryScope => ({ audience: 'office', tenantId: a.tenantId, actorId: a.actorId })
const floorAs = (actorId: string): FactoryScope => ({ audience: 'floor', tenantId: a.tenantId, actorId, siteId: A.site })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const run = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$executeRawUnsafe(text, ...values))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, unknown>[]
const count = async (text: string, values: unknown[] = []) => Number((await admin(text, values))[0]!.n)
const insert = (scope: FactoryScope, table: string, row: Record<string, unknown>) => {
  const columns = Object.keys(row)
    .map((column) => `"${column}"`)
    .join(', ')
  return run(scope, `INSERT INTO "${table}" (${columns}) SELECT ${columns} FROM jsonb_populate_record(NULL::"${table}", $1::jsonb)`, JSON.stringify(row))
}
const tag = (): string => randomUUID().slice(0, 8)

beforeAll(async () => {
  db = await migratedDatabase('followupsfloorw2b')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: NS })
  await seedCore({ db: factory, namespace: 'w2b74-b' })
  andon = await seedAndon({ db: factory, namespace: NS })
  labour = await seedLabour({ db: factory, namespace: NS })
  await seedAndon({ db: factory, namespace: 'w2b74-b' })
  await seedLabour({ db: factory, namespace: 'w2b74-b' })
  await seedNumberingBlocks({ db: factory, namespace: NS })
  pay = await seedPay({ db: factory, namespace: NS }, { piecePay: true })
}, 300_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

const p = () => labour.production
const operator = () => p().operatorId
const lead = () => p().leadId
const asOperator = () => floorAs(operator())
const asLead = () => floorAs(lead())

/** Good until nothing is left: every report goes to a new bundle-operation pair (seq increases by one per use). */
const scanRow = (bundleId: string, operationId: string, extra: Record<string, unknown>) => ({
  id: randomUUID(),
  siteId: A.site,
  workOrderId: p().workOrderId,
  workOrderOperationId: operationId,
  bundleId,
  workerId: operator(),
  deviceId: p().deviceId,
  createdById: operator(),
  clientScanId: `s-${tag()}-${tag()}`,
  ...extra,
})
/** A floor report; returns its id. */
async function report(bundleId: string, operationId: string, counts: Record<string, unknown>): Promise<string> {
  const row = scanRow(bundleId, operationId, { kind: 'REPORT', ...counts })
  await insert(asOperator(), 'OperationScan', row)
  return row.id
}
const undo = (scanId: string, bundleId: string, operationId: string) => insert(asOperator(), 'OperationScan', scanRow(bundleId, operationId, { kind: 'UNDO', correctsId: scanId, reason: 'Wrong bundle.' }))

/** A fresh bundle of WO-0001, as the office makes one: tests that report need bundle-operation pairs nobody used. */
async function freshBundle(quantity = 4): Promise<string> {
  const id = randomUUID()
  await admin(
    `INSERT INTO "Bundle" (id, "tenantId", "siteId", "workOrderId", "workOrderSizeId", code, part, quantity, "cutLogIds", "createdAt", "updatedAt")
     SELECT $1::uuid, b."tenantId", b."siteId", b."workOrderId", b."workOrderSizeId", $2, b.part, $3, b."cutLogIds", now(), now() FROM "Bundle" b WHERE b.id = $4::uuid`,
    [id, `T-BN-${tag()}`, quantity, p().bundleIds[0]],
  )
  return id
}

const anOfficeUser = async () => (await admin(`SELECT id FROM "User" WHERE "tenantId" = $1 ORDER BY id LIMIT 1`, [a.tenantId]))[0]!.id as string
const library = async () => (await admin(`SELECT id, code, name, "standardMinutes", "workCentreKind"::text AS kind FROM "Operation" WHERE "tenantId" = $1 AND code = 'SEED-PACK'`, [a.tenantId]))[0]!
const centreOfKind = async (kind: string) => (await admin(`SELECT id FROM "WorkCentre" WHERE "siteId" = $1 AND kind = $2::"WorkCentreKind" LIMIT 1`, [A.site, kind]))[0]!.id as string
const revisionOf = async (workOrderId: string) => (await admin(`SELECT "styleRevisionId" AS id FROM "WorkOrder" WHERE id = $1`, [workOrderId]))[0]!.id as string
let nextSeq = 500
async function unplanned(extra: Record<string, unknown> = {}) {
  const op = await library()
  return {
    id: randomUUID(),
    siteId: A.site,
    workOrderId: p().workOrderId,
    styleRevisionId: await revisionOf(p().workOrderId),
    seq: ++nextSeq,
    operationId: op.id,
    unplannedReason: 'QUALITY_FIX',
    code: op.code,
    name: op.name,
    standardMinutes: op.standardMinutes,
    workCentreId: await centreOfKind(String(op.kind)),
    ...extra,
  }
}

describe('the walls', () => {
  const classified = classifiedModels(loadSchema(), loadOwnership())
  const entry = (name: string) => classified.find(({ model }) => model.name === name)!

  it('the floor decides corrections and scrap and adds an unplanned operation; a partner reads none of it; no money column', () => {
    expect(entry('ScanCorrectionRequest').ownership.access[FLOOR_ROLE]?.privileges).toEqual(['select', 'insert', 'update'])
    expect(entry('WorkOrderOperation').ownership.access[FLOOR_ROLE]?.privileges).toEqual(['select', 'insert'])
    const approval = entry('ScrapApproval')
    expect(approval.model.file).toBe('labour.prisma')
    expect(approval.ownership.access[OFFICE_ROLE]?.privileges).toEqual(['select', 'insert', 'update'])
    expect(approval.ownership.access[FLOOR_ROLE]).toMatchObject({ privileges: ['select', 'insert', 'update'], scopedBy: ['site'] })
    expect(approval.ownership.access[PARTNER_ROLE]).toBeUndefined()
    expect(approval.model.columns.filter((column) => /cost|margin|price|amount|total|wage|earning|efficien|productiv|score|bonus/i.test(column))).toEqual([])
  })
})

describe('the qualification rule of a site', () => {
  it('is WARN, what the API has answered so far, until the office changes it; the floor reads it', async () => {
    expect(await admin(`SELECT "qualificationRule"::text AS rule FROM "ProductionSettings" WHERE id = $1`, [A.site])).toEqual([{ rule: 'WARN' }])
    await run(office(), `UPDATE "ProductionSettings" SET "qualificationRule" = 'STRICT' WHERE id = $1::uuid`, A.site)
    expect(await as(asOperator(), (client) => client.productionSettings.findUnique({ where: { id: A.site }, select: { qualificationRule: true } }))).toEqual({ qualificationRule: 'STRICT' })
    await expect(run(asOperator(), `UPDATE "ProductionSettings" SET "qualificationRule" = 'FREE' WHERE id = $1::uuid`, A.site)).rejects.toThrow(/permission denied/)
    await run(office(), `UPDATE "ProductionSettings" SET "qualificationRule" = 'WARN' WHERE id = $1::uuid`, A.site)
  })
})

describe('COUPON, a scan-id kind', () => {
  it('has a tenant-wide counter of its own, starts above its own blocks only, and never gets a series', async () => {
    const seeded = await admin(`SELECT "fromRef", "toRef" FROM "NumberBlock" WHERE "tenantId" = $1 AND kind = 'COUPON' ORDER BY "fromRef"`, [a.tenantId])
    expect(seeded.length).toBeGreaterThan(0)
    const row = { kind: 'COUPON', purpose: 'ONLINE', requestId: `t-${tag()}`, fromRef: 1, toRef: 5, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
    await expect(insert(office(), 'NumberBlock', { id: randomUUID(), ...row })).rejects.toThrow(/handed out already/)
    const fromRef = Number(seeded.at(-1)!.toRef) + 1
    expect(await insert(asOperator(), 'NumberBlock', { id: randomUUID(), ...row, fromRef, toRef: fromRef + 4 })).toBe(1)
    await expect(
      insert(office(), 'NumberSeries', { id: randomUUID(), companyId: A.company, kind: 'COUPON', code: 'MAIN', scopeKey: 'ALL', reset: 'NEVER', pattern: 'CP-{N:6}', fiscal: false }),
    ).rejects.toThrow(/scan-id kind/)
  })

  it('prints CP- codes; a coupon printed as BN- from the bundle counter stays valid beside them', async () => {
    const tenant = tenantTag(a.tenantId)
    const printed = formatScanId({ type: 'COUPON', tenantTag: tenant, ref: 7 })
    expect(printed).toMatch(/^CP-/)
    expect(parseScanId(printed, { tenantTag: tenant })).toMatchObject({ ok: true, type: 'COUPON', ref: 7 })
    const old = formatScanId({ type: 'BUNDLE', tenantTag: tenant, ref: 7 })
    expect(parseScanId(old, { tenantTag: tenant })).toMatchObject({ ok: true, type: 'BUNDLE' })
    const coupon = (code: string, operation: 'qc' | 'pack') => ({ id: randomUUID(), siteId: A.site, workOrderId: p().workOrderId, bundleId: p().bundleIds[0], workOrderOperationId: p().operationIds[operation], code })
    expect(await insert(office(), 'BundleCoupon', coupon(old, 'qc'))).toBe(1)
    expect(await insert(office(), 'BundleCoupon', coupon(printed, 'pack'))).toBe(1)
    expect(await count(`SELECT count(*)::int AS n FROM "BundleCoupon" WHERE code IN ($1, $2) AND status = 'ACTIVE'`, [old, printed])).toBe(2)
  })
})

describe('an unplanned operation (MES-086)', () => {
  it('is added to an open work order by the office or a floor session, scanned and frozen like a step', async () => {
    const byOffice = await unplanned()
    expect(await insert(office(), 'WorkOrderOperation', byOffice)).toBe(1)
    const byFloor = await unplanned({ unplannedReason: 'MATERIAL_ISSUE' })
    expect(await insert(asLead(), 'WorkOrderOperation', byFloor)).toBe(1)
    const bundleId = await freshBundle()
    expect(await report(bundleId, byFloor.id, { goodQuantity: 4 })).toBeTruthy()
    await expect(run(office(), `UPDATE "WorkOrderOperation" SET name = 'Another' WHERE id = $1::uuid`, byOffice.id)).rejects.toThrow(/frozen \(MES-005\)/)
    await expect(run(office(), `DELETE FROM "WorkOrderOperation" WHERE id = $1::uuid`, byOffice.id)).rejects.toThrow(/frozen \(MES-005\)/)
    // Only its work centre moves, to another of the operation's kind.
    await expect(run(office(), `UPDATE "WorkOrderOperation" SET "workCentreId" = $2::uuid WHERE id = $1::uuid`, byOffice.id, await centreOfKind('CUTTING'))).rejects.toThrow(/kind PACKING/)
    expect(await run(office(), `UPDATE "WorkOrderOperation" SET "workCentreId" = $2::uuid, version = version + 1 WHERE id = $1::uuid`, byOffice.id, await centreOfKind('PACKING'))).toBe(1)
  })

  it('is refused on a DRAFT work order, without a reason or its library operation, and when it is no copy of an active one', async () => {
    const draft = p().draftWorkOrderId
    await expect(insert(office(), 'WorkOrderOperation', await unplanned({ workOrderId: draft }))).rejects.toThrow(/is DRAFT; an unplanned operation/)
    await expect(insert(office(), 'WorkOrderOperation', await unplanned({ unplannedReason: null }))).rejects.toThrow(/names its operation of the library and why/)
    await expect(insert(office(), 'WorkOrderOperation', await unplanned({ unplannedReason: 'two words' }))).rejects.toThrow(/names its operation of the library and why/)
    await expect(insert(office(), 'WorkOrderOperation', await unplanned({ operationId: null }))).rejects.toThrow(/names its operation of the library and why/)
    await expect(insert(office(), 'WorkOrderOperation', await unplanned({ parallelGroup: 2 }))).rejects.toThrow(/in no parallel group/)
    await expect(insert(office(), 'WorkOrderOperation', await unplanned({ name: 'Something else' }))).rejects.toThrow(/copy of operation/)
    await expect(insert(office(), 'WorkOrderOperation', await unplanned({ workCentreId: await centreOfKind('CUTTING') }))).rejects.toThrow(/work centre of kind PACKING/)
    const op = await library()
    await admin(`UPDATE "Operation" SET status = 'ARCHIVED' WHERE id = $1`, [op.id])
    try {
      await expect(insert(office(), 'WorkOrderOperation', await unplanned())).rejects.toThrow(/active operation of the library/)
    } finally {
      await admin(`UPDATE "Operation" SET status = 'ACTIVE' WHERE id = $1`, [op.id])
    }
  })

  it('MES-005 stays: a routing copy is added only while DRAFT, and a floor session adds none, ever', async () => {
    const routing = async (workOrderId: string) => {
      const [row] = await admin(`SELECT "siteId", "styleRevisionId", code, name, "standardMinutes", "workCentreId", "routingSeq" FROM "WorkOrderOperation" WHERE "workOrderId" = $1 ORDER BY seq LIMIT 1`, [workOrderId])
      return { id: randomUUID(), workOrderId, seq: ++nextSeq, ...row }
    }
    await expect(insert(office(), 'WorkOrderOperation', await routing(p().workOrderId))).rejects.toThrow(/frozen \(MES-005\)/)
    await expect(insert(asLead(), 'WorkOrderOperation', await routing(p().draftWorkOrderId))).rejects.toThrow(/adds only an unplanned operation/)
    await expect(run(asLead(), `DELETE FROM "WorkOrderOperation" WHERE id = $1::uuid`, p().operationIds.pack)).rejects.toThrow(/permission denied/)
    await expect(run(asLead(), `UPDATE "WorkOrderOperation" SET name = name WHERE id = $1::uuid`, p().operationIds.pack)).rejects.toThrow(/permission denied/)
    // Nor does a routing copy name a library operation or a reason.
    await expect(run(office(), `UPDATE "WorkOrderOperation" SET "unplannedReason" = 'QUALITY_FIX' WHERE "workOrderId" = $1::uuid AND seq = 10`, p().draftWorkOrderId)).rejects.toThrow(/only an unplanned operation names/)
  })

  it('pays the rate of its own library operation, no other (the pay check compares through the routing step)', async () => {
    const op = await library()
    const row = await unplanned()
    await insert(office(), 'WorkOrderOperation', row)
    const scanId = await report(await freshBundle(1), row.id, { goodQuantity: 1 })
    const entry = (rateEntryId: string) => ({
      id: randomUUID(),
      companyId: A.company,
      siteId: A.site,
      payPeriodId: pay.periodIds.november,
      employeeId: pay.employeeIds.operator,
      workerId: operator(),
      kind: 'SCAN',
      workDate: '2026-11-18',
      operationScanId: scanId,
      rateEntryId,
      pieces: 1,
      rate: '0.500000',
      amount: 50,
      currency: 'EUR',
      idempotencyKey: `scan:${tag()}`,
    })
    await expect(insert(office(), 'EarningsEntry', entry(pay.rateEntryIds.sew))).rejects.toThrow(/rate of another operation/)
    expect((await admin(`SELECT "operationId" AS id FROM "PieceRateEntry" WHERE id = $1`, [pay.rateEntryIds.pack]))[0]!.id).toBe(op.id)
    expect(await insert(office(), 'EarningsEntry', entry(pay.rateEntryIds.pack))).toBe(1)
  })
})

describe('the floor decides a correction', () => {
  async function asked(bundleId: string) {
    const operationId = p().operationIds.qc
    const scanId = await report(bundleId, operationId, { goodQuantity: 2 })
    const requestId = randomUUID()
    await insert(asOperator(), 'ScanCorrectionRequest', {
      id: requestId,
      siteId: A.site,
      workOrderId: p().workOrderId,
      bundleId,
      workOrderOperationId: operationId,
      scanId,
      goodQuantity: 1,
      scrapQuantity: 1,
      reason: 'One is stained.',
      askedById: operator(),
      deviceId: p().deviceId,
      clientRequestId: `ask-${tag()}`,
      createdById: operator(),
    })
    return { scanId, requestId, operationId }
  }
  const decide = (scope: FactoryScope, set: string, ...values: unknown[]) => run(scope, `UPDATE "ScanCorrectionRequest" SET ${set}`, ...values)

  it('a team leader approves one with the CORRECTION scan, or refuses it with a note', async () => {
    const { scanId, requestId, operationId } = await asked(await freshBundle(2))
    const bundleId = (await admin(`SELECT "bundleId" FROM "OperationScan" WHERE id = $1`, [scanId]))[0]!.bundleId as string
    const correction = scanRow(bundleId, operationId, { kind: 'CORRECTION', correctsId: scanId, goodQuantity: 1, scrapQuantity: 1, reason: 'One is stained.', approvedById: lead(), createdById: lead() })
    expect(await insert(asLead(), 'OperationScan', correction)).toBe(1)
    expect(await decide(asLead(), `status = 'APPROVED', "decidedById" = $2::uuid, "decidedAt" = now(), "correctionScanId" = $3::uuid, version = version + 1 WHERE id = $1::uuid`, requestId, lead(), correction.id)).toBe(1)
    expect(await admin(`SELECT status::text FROM "ScanCorrectionRequest" WHERE id = $1`, [requestId])).toEqual([{ status: 'APPROVED' }])
    await expect(decide(asLead(), `"decisionNote" = 'Changed my mind.' WHERE id = $1::uuid`, requestId)).rejects.toThrow(/a decision is final/)

    const second = await asked(await freshBundle(2))
    await expect(decide(asLead(), `status = 'REFUSED', "decidedById" = $2::uuid, "decidedAt" = now() WHERE id = $1::uuid`, second.requestId, lead())).rejects.toThrow(/says why/)
    expect(await decide(asLead(), `status = 'REFUSED', "decidedById" = $2::uuid, "decidedAt" = now(), "decisionNote" = 'The stain cleans off.' WHERE id = $1::uuid`, second.requestId, lead())).toBe(1)
  })

  it('never by who took the scan or asked (four eyes), and only its decision changes', async () => {
    const { requestId } = await asked(await freshBundle(2))
    // The check runs in a floor session (Worker.userId is hidden from it: no permission error, the refusal in words).
    await expect(decide(asOperator(), `status = 'REFUSED', "decidedById" = $2::uuid, "decidedAt" = now(), "decisionNote" = 'No.' WHERE id = $1::uuid`, requestId, operator())).rejects.toThrow(/four eyes/)
    await expect(decide(asLead(), `reason = 'Other words' WHERE id = $1::uuid`, requestId)).rejects.toThrow(/changes only by its decision/)
    await expect(decide(asLead(), `"goodQuantity" = 2, "scrapQuantity" = 0 WHERE id = $1::uuid`, requestId)).rejects.toThrow(/changes only by its decision/)
    // The office keeps its check of the worker's office account.
    const operatorUser = await anOfficeUser()
    await admin(`UPDATE "Worker" SET "userId" = $2 WHERE id = $1`, [operator(), operatorUser])
    try {
      await expect(decide(office(), `status = 'REFUSED', "decidedById" = $2::uuid, "decidedAt" = now(), "decisionNote" = 'No.' WHERE id = $1::uuid`, requestId, operatorUser)).rejects.toThrow(/four eyes/)
    } finally {
      await admin(`UPDATE "Worker" SET "userId" = NULL WHERE id = $1`, [operator()])
    }
  })

  it('a site never reaches another site\'s request', async () => {
    const { requestId } = await asked(await freshBundle(2))
    const other: FactoryScope = { audience: 'floor', tenantId: a.tenantId, actorId: lead(), siteId: key('site:B1') }
    expect(await decide(other, `status = 'REFUSED', "decidedById" = $2::uuid, "decidedAt" = now(), "decisionNote" = 'No.' WHERE id = $1::uuid`, requestId, lead())).toBe(0)
  })
})

describe('a scrap approval (MES-128)', () => {
  const approvalOf = (scanId: string, extra: Record<string, unknown> = {}) => ({ id: randomUUID(), siteId: A.site, scanId, limitPieces: 2, key: `scrap:${scanId}`, ...extra })
  const over = async () => {
    const bundleId = await freshBundle(4)
    const operationId = p().operationIds.qc
    return { bundleId, operationId, scanId: await report(bundleId, operationId, { scrapQuantity: 3, goodQuantity: 1 }) }
  }
  const decide = (scope: FactoryScope, set: string, ...values: unknown[]) => run(scope, `UPDATE "ScrapApproval" SET ${set}`, ...values)
  const refuse = `status = 'REFUSED', "decidedOn" = 'FLOOR', "decidedAt" = now(), "decidedById" = $2::uuid, "reasonCode" = 'WRONG_COUNT' WHERE id = $1::uuid`
  const approve = `status = 'APPROVED', "decidedOn" = 'FLOOR', "decidedAt" = now(), "decidedById" = $2::uuid WHERE id = $1::uuid`

  it('waits on a floor report above the limit, one per scan, and the team leader decides it once', async () => {
    const { scanId } = await over()
    const row = approvalOf(scanId)
    expect(await insert(asOperator(), 'ScrapApproval', row)).toBe(1)
    expect((await admin(`SELECT status::text FROM "ScrapApproval" WHERE id = $1`, [row.id]))[0]).toEqual({ status: 'WAITING' })
    await expect(insert(asOperator(), 'ScrapApproval', approvalOf(scanId))).rejects.toThrow(/duplicate key|Unique/i)
    expect(await decide(asLead(), approve, row.id, lead())).toBe(1)
    await expect(decide(asLead(), refuse, row.id, lead())).rejects.toThrow(/a decision is final/)
  })

  it('is asked only of a report from a tablet above the limit, and keeps a limit from 1', async () => {
    const under = await report(await freshBundle(4), p().operationIds.qc, { scrapQuantity: 2, goodQuantity: 2 })
    await expect(insert(asOperator(), 'ScrapApproval', approvalOf(under))).rejects.toThrow(/above the limit/)
    expect(await insert(asOperator(), 'ScrapApproval', approvalOf(under, { limitPieces: 1 }))).toBe(1)
    await expect(insert(asOperator(), 'ScrapApproval', approvalOf(under, { limitPieces: 0, key: `scrap:${under}-2` }))).rejects.toThrow(/from 1 piece/)
    await expect(insert(asOperator(), 'ScrapApproval', approvalOf(under, { key: 'scrap:another' }))).rejects.toThrow(/from 1 piece, and the key/)
    const undone = p().overLimitScanId
    const voiding = (await admin(`SELECT id FROM "OperationScan" WHERE "correctsId" = $1`, [undone]))[0]!.id as string
    await expect(insert(asOperator(), 'ScrapApproval', approvalOf(voiding))).rejects.toThrow(/floor report/)
  })

  it('is decided with its columns exact: a refusal with its reason, where and who, never by who took the scan', async () => {
    const { scanId } = await over()
    const row = approvalOf(scanId)
    await insert(asOperator(), 'ScrapApproval', row)
    await expect(decide(asLead(), `status = 'REFUSED', "decidedOn" = 'FLOOR', "decidedAt" = now(), "decidedById" = $2::uuid WHERE id = $1::uuid`, row.id, lead())).rejects.toThrow(/wrong columns/)
    await expect(decide(asLead(), `status = 'APPROVED' WHERE id = $1::uuid`, row.id)).rejects.toThrow(/wrong columns/)
    await expect(decide(asLead(), `"note" = 'Early words.' WHERE id = $1::uuid`, row.id)).rejects.toThrow(/wrong columns/)
    await expect(decide(asLead(), `status = 'REFUSED', "decidedOn" = 'FLOOR', "decidedAt" = now(), "decidedById" = $2::uuid, "reasonCode" = 'two words' WHERE id = $1::uuid`, row.id, lead())).rejects.toThrow(/wrong columns/)
    await expect(decide(asLead(), `"limitPieces" = 1 WHERE id = $1::uuid`, row.id)).rejects.toThrow(/changes only by its decision/)
    await expect(decide(asOperator(), refuse, row.id, operator())).rejects.toThrow(/four eyes/)
    await expect(decide(asLead(), `status = 'APPROVED', "decidedOn" = 'OFFICE', "decidedAt" = now(), "decidedById" = $2::uuid WHERE id = $1::uuid`, row.id, lead())).rejects.toThrow(/writes no office decision/)
    const operatorUser = await anOfficeUser()
    await admin(`UPDATE "Worker" SET "userId" = $2 WHERE id = $1`, [operator(), operatorUser])
    try {
      await expect(decide(office(), `status = 'APPROVED', "decidedOn" = 'OFFICE', "decidedAt" = now(), "decidedById" = $2::uuid WHERE id = $1::uuid`, row.id, operatorUser)).rejects.toThrow(/four eyes/)
    } finally {
      await admin(`UPDATE "Worker" SET "userId" = NULL WHERE id = $1`, [operator()])
    }
    expect(await decide(office(), `status = 'APPROVED', "decidedOn" = 'OFFICE', "decidedAt" = now(), "decidedById" = $2::uuid, note = 'Seen it.' WHERE id = $1::uuid`, row.id, a.actorId)).toBe(1)
  })

  it('waits for nothing once its scan is voided, and is never deleted', async () => {
    const { scanId, bundleId, operationId } = await over()
    const row = approvalOf(scanId)
    await insert(asOperator(), 'ScrapApproval', row)
    await undo(scanId, bundleId, operationId)
    await expect(decide(asLead(), approve, row.id, lead())).rejects.toThrow(/waits for nothing/)
    await expect(run(asLead(), `DELETE FROM "ScrapApproval" WHERE id = $1::uuid`, row.id)).rejects.toThrow(/permission denied/)
    await expect(admin(`DELETE FROM "ScrapApproval" WHERE id = $1`, [row.id])).rejects.toThrow(/never deleted/)
    await expect(admin(`TRUNCATE "ScrapApproval"`)).rejects.toThrow(/refused/)
  })

  it('an approval decided already may be written whole, as the audit rows\' decisions move here', async () => {
    const { scanId } = await over()
    const decided = { status: 'REFUSED', decidedOn: 'OFFICE', decidedAt: new Date().toISOString(), decidedById: a.actorId, reasonCode: 'WRONG_REASON' }
    expect(await insert(office(), 'ScrapApproval', approvalOf(scanId, decided))).toBe(1)
  })
})

describe('parallel operations and a BOM line\'s step', () => {
  const stepOf = async (revisionId: string, seq: number) => (await admin(`SELECT id FROM "RoutingOperation" WHERE "revisionId" = $1 AND seq = $2`, [revisionId, seq]))[0]!.id as string
  const draftRevision = () => key('product:revision:JKT-01:1')

  it('a routing step names a group from 1; a frozen copy takes it and stays equal to it', async () => {
    const step = await stepOf(draftRevision(), 20)
    await expect(run(office(), `UPDATE "RoutingOperation" SET "parallelGroup" = 0 WHERE id = $1::uuid`, step)).rejects.toThrow(/number from 1/)
    expect(await run(office(), `UPDATE "RoutingOperation" SET "parallelGroup" = 1 WHERE id = $1::uuid`, step)).toBe(1)
    await run(office(), `UPDATE "RoutingOperation" SET "parallelGroup" = NULL WHERE id = $1::uuid`, step)

    // A released revision's routing is frozen; here the test's superuser stands in for a revision released with a group.
    const revisionId = await revisionOf(p().draftWorkOrderId)
    const released = await stepOf(revisionId, 20)
    const [draftOp] = await admin(`SELECT id FROM "WorkOrderOperation" WHERE "workOrderId" = $1 AND "routingSeq" = 20`, [p().draftWorkOrderId])
    await admin(`ALTER TABLE "RoutingOperation" DISABLE TRIGGER USER`)
    await admin(`UPDATE "RoutingOperation" SET "parallelGroup" = 3 WHERE id = $1`, [released])
    await admin(`ALTER TABLE "RoutingOperation" ENABLE TRIGGER USER`)
    try {
      await run(office(), `UPDATE "WorkOrderOperation" SET version = version + 1 WHERE id = $1::uuid`, draftOp!.id)
      expect(await admin(`SELECT "parallelGroup" FROM "WorkOrderOperation" WHERE id = $1`, [draftOp!.id])).toEqual([{ parallelGroup: 3 }])
      await expect(run(office(), `UPDATE "WorkOrderOperation" SET "parallelGroup" = 9 WHERE id = $1::uuid`, draftOp!.id)).rejects.toThrow(/parallel group/)
    } finally {
      await admin(`ALTER TABLE "WorkOrderOperation" DISABLE TRIGGER USER`)
      await admin(`UPDATE "WorkOrderOperation" SET "parallelGroup" = NULL WHERE id = $1`, [draftOp!.id])
      await admin(`ALTER TABLE "WorkOrderOperation" ENABLE TRIGGER USER`)
      await admin(`ALTER TABLE "RoutingOperation" DISABLE TRIGGER USER`)
      await admin(`UPDATE "RoutingOperation" SET "parallelGroup" = NULL WHERE id = $1`, [released])
      await admin(`ALTER TABLE "RoutingOperation" ENABLE TRIGGER USER`)
    }
  })

  it('a BOM line names a step of its own revision; a renumbered step takes it along, a step in use stays', async () => {
    const revisionId = draftRevision()
    const line = (await admin(`SELECT id FROM "BomLine" WHERE "revisionId" = $1 ORDER BY seq LIMIT 1`, [revisionId]))[0]!.id as string
    await expect(run(office(), `UPDATE "BomLine" SET "routingSeq" = 999 WHERE id = $1::uuid`, line)).rejects.toThrow(/foreign key|violates/i)
    expect(await run(office(), `UPDATE "BomLine" SET "routingSeq" = 20 WHERE id = $1::uuid`, line)).toBe(1)
    const step = await stepOf(revisionId, 20)
    await run(office(), `UPDATE "RoutingOperation" SET seq = 25 WHERE id = $1::uuid`, step)
    expect(await admin(`SELECT "routingSeq" FROM "BomLine" WHERE id = $1`, [line])).toEqual([{ routingSeq: 25 }])
    await expect(run(office(), `DELETE FROM "RoutingOperation" WHERE id = $1::uuid`, step)).rejects.toThrow(/foreign key|violates/i)
    await run(office(), `UPDATE "BomLine" SET "routingSeq" = NULL WHERE id = $1::uuid`, line)
    await run(office(), `UPDATE "RoutingOperation" SET seq = 20 WHERE id = $1::uuid`, step)
    // The seed's released revision says which step uses each material, and it is frozen with the rest.
    expect(await admin(`SELECT seq, "routingSeq" FROM "BomLine" WHERE "revisionId" = $1 ORDER BY seq`, [await revisionOf(p().workOrderId)])).toEqual([
      { seq: 10, routingSeq: 10 },
      { seq: 20, routingSeq: 20 },
      { seq: 30, routingSeq: 20 },
    ])
  })
})

describe('off-standard time per work order', () => {
  const entry = (extra: Record<string, unknown> = {}) => ({
    id: randomUUID(),
    companyId: A.company,
    siteId: A.site,
    lineId: A.line,
    stationId: A.sew1,
    workerId: operator(),
    employeeId: E.operator,
    codeId: labour.codeIds.CLEANING,
    source: 'FLOOR',
    workDate: '2026-11-20',
    startedAt: '2026-11-20T08:00:00.000Z',
    endedAt: '2026-11-20T08:10:00.000Z',
    status: 'APPROVED',
    approvedAt: '2026-11-20T08:10:00.000Z',
    ...extra,
  })

  it('names an open work order of its site, not a draft; after the block ended a change comes with a labour edit', async () => {
    const seeded = await admin(`SELECT "workOrderId" FROM "OffStandardEntry" WHERE id = $1`, [labour.blockIds[0]])
    expect(seeded).toEqual([{ workOrderId: p().workOrderId }])
    const row = entry({ workOrderId: p().workOrderId })
    expect(await insert(asOperator(), 'OffStandardEntry', row)).toBe(1)
    await expect(insert(asOperator(), 'OffStandardEntry', entry({ workOrderId: p().draftWorkOrderId, startedAt: '2026-11-20T09:00:00.000Z', endedAt: '2026-11-20T09:10:00.000Z' }))).rejects.toThrow(/which is DRAFT/)
    await expect(run(asOperator(), `UPDATE "OffStandardEntry" SET "workOrderId" = NULL WHERE id = $1::uuid`, row.id)).rejects.toThrow(/write its LabourEdit/)
  })
})

describe('what a material call asks (MES-137)', () => {
  const call = async (typeId: string, extra: Record<string, unknown> = {}) => {
    const row = { id: randomUUID(), siteId: A.site, typeId, stationId: key('site:A1:station:SEW-02'), lineId: A.line, sentAt: new Date(Date.now() - 60_000).toISOString(), ...extra }
    await insert(asOperator(), 'HelpCall', row)
    return row
  }

  it('a reason and a quantity, told once while the call is open; a quantity only on a material call', async () => {
    const seeded = await admin(`SELECT "reasonCode", "requestedQuantity"::text AS quantity FROM "HelpCall" WHERE id = $1`, [andon.callIds[0]])
    expect(seeded).toEqual([{ reasonCode: 'MATERIAL_SHORT', quantity: '4.0000' }])
    const row = await call(andon.typeIds.material)
    expect(await run(asOperator(), `UPDATE "HelpCall" SET "reasonCode" = 'THREAD_OUT', "requestedQuantity" = 2.5 WHERE id = $1::uuid`, row.id)).toBe(1)
    await expect(run(asOperator(), `UPDATE "HelpCall" SET "requestedQuantity" = 3 WHERE id = $1::uuid`, row.id)).rejects.toThrow(/set once/)
    await expect(run(asOperator(), `UPDATE "HelpCall" SET "reasonCode" = 'OTHER' WHERE id = $1::uuid`, row.id)).rejects.toThrow(/set once/)
    await run(asLead(), `UPDATE "HelpCall" SET status = 'CANCELLED', "cancelledAt" = now(), "cancelledById" = $2::uuid WHERE id = $1::uuid`, row.id, lead())

    await expect(call(andon.typeIds.material, { requestedQuantity: 0 })).rejects.toThrow(/above 0/)
    await expect(call(andon.typeIds.material, { reasonCode: 'two words' })).rejects.toThrow(/no spaces/)
    await expect(call(andon.typeIds.teamLeader, { requestedQuantity: 1 })).rejects.toThrow(/only a material call asks a quantity/)
    const closed = await call(andon.typeIds.teamLeader)
    await run(asLead(), `UPDATE "HelpCall" SET status = 'CANCELLED', "cancelledAt" = now(), "cancelledById" = $2::uuid WHERE id = $1::uuid`, closed.id, lead())
    await expect(run(asOperator(), `UPDATE "HelpCall" SET "reasonCode" = 'LATE' WHERE id = $1::uuid`, closed.id)).rejects.toThrow(/while it is open/)
  })
})

describe('a scrap reason\'s fault', () => {
  it('is UNKNOWN until the office says, the seed\'s placeholders apart, and the floor reads it', async () => {
    const rows = await admin(`SELECT code, fault::text FROM "ScrapReason" WHERE "tenantId" = $1 AND kind = 'SCRAP' AND code IN ('LEATHER_FLAW', 'CUT_WRONG', 'STAIN') ORDER BY code`, [a.tenantId])
    expect(rows).toEqual([
      { code: 'CUT_WRONG', fault: 'OWN' },
      { code: 'LEATHER_FLAW', fault: 'OTHERS' },
      { code: 'STAIN', fault: 'UNKNOWN' },
    ])
    expect(await run(office(), `UPDATE "ScrapReason" SET fault = 'OTHERS' WHERE "tenantId" = $1::uuid AND kind = 'SCRAP' AND code = 'STAIN'`, a.tenantId)).toBe(1)
    expect(await as(asOperator(), (client) => client.scrapReason.findFirst({ where: { kind: 'SCRAP', code: 'STAIN' }, select: { fault: true } }))).toEqual({ fault: 'OTHERS' })
    await run(office(), `UPDATE "ScrapReason" SET fault = 'UNKNOWN' WHERE "tenantId" = $1::uuid AND kind = 'SCRAP' AND code = 'STAIN'`, a.tenantId)
  })
})

describe('the seed', () => {
  it('leaves every count as it was: the over-limit report is undone, its approval refused on the tablet; a second run adds nothing', async () => {
    expect(await admin(`SELECT status::text, "decidedOn"::text AS "decidedOn", "limitPieces", "reasonCode" FROM "ScrapApproval" WHERE id = $1`, [p().scrapApprovalId])).toEqual([{ status: 'REFUSED', decidedOn: 'FLOOR', limitPieces: 1, reasonCode: 'WRONG_COUNT' }])
    expect(await count(`SELECT count(*)::int AS n FROM "OperationScan" WHERE "correctsId" = $1 AND kind = 'UNDO'`, [p().overLimitScanId])).toBe(1)
    const tables = ['ScrapApproval', 'OperationScan', 'NumberBlock', 'HelpCall', 'OffStandardEntry']
    const sizes = async () => Promise.all(tables.map((table) => count(`SELECT count(*)::int AS n FROM "${table}"`)))
    const before = await sizes()
    await seedAndon({ db: factory, namespace: NS })
    await seedLabour({ db: factory, namespace: NS })
    await seedNumberingBlocks({ db: factory, namespace: NS })
    expect(await sizes()).toEqual(before)
  }, 120_000)
})
