import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedPay, type PaySeed } from '../seed/pay'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { classifiedModels } from './ownership'
import { FLOOR_ROLE, PARTNER_ROLE, RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'
import { loadOwnership, loadSchema } from './tools'

/**
 * W2b schema wave 6/7 (piece pay and the payroll export) beyond the generated isolation tests, on a database built from
 * the migrations and seeded, through the real login and the scoped client (…_pay_w2b_guards):
 *   - the walls: office only, but the floor reads its site's rate publications (not who made them) and records a
 *     worker's reading; every rate and amount is `@grain wages`; the personal columns are tagged; no name, tax code,
 *     IBAN or birth date is kept; the legal switch ships OFF;
 *   - rate versions leave DRAFT only once published to the workers on or before their first day (c.c. art. 2101), never
 *     overlap, never change after; their rates are exact; publications go to ACTIVE workers of the site; receipts are
 *     append-only;
 *   - incentive schemes: their shapes, a guaranteed pay before ACTIVE, no overlap;
 *   - the legal switch: ON only with every precondition on record (CCNL, notice, DPIA, consultant, scheme, the site's
 *     legal basis for naming workers), never from a day in the past, frozen while ON, its windows kept;
 *   - the earnings ledger: append-only for every login; a scan pays only once (standing, of its worker, at a rate in
 *     force for its operation, not held); nothing outside the switch's windows; corrections are mirrored reversals and
 *     late work names the LOCKED period it corrects;
 *   - periods lock only with no scan held and an APPROVED statement for every worker paid; statements and held scans;
 *   - payroll layouts as data; exports frozen once exported, blocking checks passed, one first export per month,
 *     corrections in order; files only while a draft; the code mapping;
 *   - the seeds are idempotent.
 * The refusals are check_violation (SQLSTATE 23514); their messages are read through raw SQL.
 */

const NS = 'w2b8-a'
const DENIED = /permission denied/
const FILE = 'pay.prisma'
const TABLES = [
  'PieceRateTable',
  'PieceRateVersion',
  'PieceRateEntry',
  'RatePublication',
  'RateAcknowledgement',
  'IncentiveScheme',
  'PiecePaySwitch',
  'PayPeriod',
  'EarningsEntry',
  'HeldScan',
  'WorkerStatement',
  'PayrollExportLayout',
  'PayrollExport',
  'PayrollExportFile',
  'PayrollCodeMapping',
] as const

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let pay: PaySeed

const key = (name: string): string => seedUuid(NS, name)
const A = {
  companyA: key('company:A'),
  companyB: key('company:B'),
  siteA: key('site:A1'),
  siteB: key('site:B1'),
  lineA: key('site:A1:line:L1'),
  sew: key('product:operation:SEW'),
  pack: key('product:operation:PACK'),
  workerB: key('worker:B1:operator'),
  officeFile: key('files:office'),
  store: key('files:account:r2'),
}

const office = (actorId: string = a.actorId): FactoryScope => ({ audience: 'office', tenantId: a.tenantId, actorId })
const floor = (): FactoryScope => ({ audience: 'floor', tenantId: a.tenantId, actorId: randomUUID(), siteId: A.siteA })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const sql = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$queryRawUnsafe<Record<string, unknown>[]>(text, ...values))
const run = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$executeRawUnsafe(text, ...values))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, unknown>[]
const count = async (table: string) => Number((await admin(`SELECT count(*) AS n FROM "${table}" WHERE "tenantId" = $1`, [a.tenantId]))[0]!.n)
const insertSql = (table: string, row: Record<string, unknown>): [string, string] => {
  const columns = Object.keys(row)
    .map((column) => `"${column}"`)
    .join(', ')
  return [`INSERT INTO "${table}" (${columns}) SELECT ${columns} FROM jsonb_populate_record(NULL::"${table}", $1::jsonb)`, JSON.stringify(row)]
}
const insert = (scope: FactoryScope, table: string, row: Record<string, unknown>) => run(scope, ...insertSql(table, row))
const update = (table: string, id: string, set: Record<string, unknown>, scope: FactoryScope = office()) => {
  const columns = Object.keys(set)
  const assignments = columns.map((column) => `"${column}" = r."${column}"`).join(', ')
  return run(scope, `UPDATE "${table}" t SET ${assignments} FROM jsonb_populate_record(NULL::"${table}", $1::jsonb) r WHERE t.id = $2::uuid`, JSON.stringify(set), id)
}
const one = async (table: string, id: string, columns: string): Promise<Record<string, unknown>> => (await admin(`SELECT ${columns} FROM "${table}" WHERE id = $1`, [id]))[0]!
const tag = (): string => randomUUID().slice(0, 8)
/** The runtime role has no DELETE (or UPDATE) grant; the owner meets the trigger's refusal. */
const refusedToAll = async (statement: string, id: string, refusal: RegExp) => {
  await expect(run(office(), statement, id)).rejects.toThrow(DENIED)
  await expect(admin(statement.replace('$1::uuid', '$1'), [id])).rejects.toThrow(refusal)
}
const now = '2026-11-20T08:00:00.000Z'

beforeAll(async () => {
  db = await migratedDatabase('payw2b')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: NS })
  pay = await seedPay({ db: factory, namespace: NS })
}, 180_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

// --- rows as the API writes them ------------------------------------------------------------------------------------

const tableRow = (extra: Record<string, unknown> = {}) => ({ id: randomUUID(), companyId: A.companyA, siteId: A.siteA, code: `T-${tag()}`, name: 'Test rates', ...extra })
const versionRow = (tableId: string, extra: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  companyId: A.companyA,
  siteId: A.siteA,
  tableId,
  versionNo: 1,
  changeReason: 'NEW',
  effectiveFrom: '2027-03-01',
  ...extra,
})
const entryRow = (versionId: string, extra: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  siteId: A.siteA,
  versionId,
  operationId: A.sew,
  basis: 'FIXED',
  ratePerPiece: '1.000000',
  ...extra,
})
const publicationRow = (versionId: string, extra: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  companyId: A.companyA,
  siteId: A.siteA,
  versionId,
  workerIds: [pay.production.operatorId],
  publishedAt: '2027-02-27T10:00:00.000Z',
  publishedById: a.actorId,
  ...extra,
})
const receiptRow = (extra: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  siteId: A.siteA,
  publicationId: pay.publicationId,
  versionId: pay.rateVersionIds.published,
  workerId: pay.production.operatorId,
  channel: 'DEVICE',
  deviceId: pay.production.deviceId,
  clientEventId: `test-${tag()}`,
  ...extra,
})
const schemeRow = (extra: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  companyId: A.companyA,
  name: `Scheme ${tag()}`,
  kind: 'PIECE_RATE',
  validFrom: '2027-02-01',
  ...extra,
})
const earningRow = (extra: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  companyId: A.companyA,
  siteId: A.siteA,
  payPeriodId: pay.periodIds.november,
  workerId: pay.production.operatorId,
  workDate: '2026-11-20',
  kind: 'MAKE_UP',
  minutes: '60.000',
  rate: '0.150000',
  amount: 900,
  idempotencyKey: `test:${tag()}`,
  ...extra,
})
const periodRow = (first: string, last: string, extra: Record<string, unknown> = {}) => ({ id: randomUUID(), companyId: A.companyA, periodStart: first, periodEnd: last, ...extra })
const fileRow = (recordType: string, recordId: string) => ({
  id: randomUUID(),
  companyId: A.companyA,
  recordType,
  recordId,
  kind: 'DOCUMENT',
  originalName: `test-${tag()}.csv`,
  contentType: 'text/csv',
  sizeBytes: 10,
  sha256: 'a'.repeat(64),
  storeAccountId: A.store,
  storageKey: `t/${a.tenantId}/c/${A.companyA}/2026/${randomUUID()}`,
  status: 'AVAILABLE',
  availableAt: now,
  visibility: ['OFFICE'],
})

/** A table at A1 with a version PUBLISHED from `from` (one fixed rate, published two days before). */
async function publishedVersion(from: string): Promise<{ tableId: string; versionId: string; entryId: string }> {
  const table = tableRow()
  const version = versionRow(table.id, { effectiveFrom: from })
  const entry = entryRow(version.id)
  await insert(office(), 'PieceRateTable', table)
  await insert(office(), 'PieceRateVersion', version)
  await insert(office(), 'PieceRateEntry', entry)
  const before = new Date(`${from}T10:00:00.000Z`)
  before.setUTCDate(before.getUTCDate() - 2)
  await insert(office(), 'RatePublication', publicationRow(version.id, { publishedAt: before.toISOString() }))
  await update('PieceRateVersion', version.id, { status: 'PUBLISHED' })
  return { tableId: table.id, versionId: version.id, entryId: entry.id }
}

// --- the seeds and the walls ----------------------------------------------------------------------------------------

describe('the seeds and the walls', () => {
  it('the seeds are idempotent: a second run writes nothing new', async () => {
    const before = await Promise.all(TABLES.map(count))
    await seedPay({ db: factory, namespace: NS })
    expect(await Promise.all(TABLES.map(count))).toEqual(before)
    expect(before.every((n) => n > 0)).toBe(true)
  })

  it('the office keeps every table; the floor reads its site’s publications (not who made them) and records a reading; no portal', async () => {
    const models = classifiedModels(loadSchema(), loadOwnership()).filter(({ model }) => model.file === FILE)
    expect(models.map(({ model }) => model.name).sort()).toEqual([...TABLES].sort())
    for (const { model, ownership } of models) {
      expect(ownership.access[PARTNER_ROLE], model.name).toBeUndefined()
      if (model.name === 'RatePublication' || model.name === 'RateAcknowledgement') continue
      expect(ownership.access[FLOOR_ROLE], model.name).toBeUndefined()
      await expect(sql(floor(), `SELECT id FROM "${model.table}" LIMIT 1`), model.name).rejects.toThrow(DENIED)
    }
    expect(await sql(floor(), `SELECT id::text AS id, "workerIds" AS workers FROM "RatePublication"`)).toEqual([{ id: pay.publicationId, workers: [pay.production.operatorId] }])
    await expect(sql(floor(), `SELECT "publishedById" FROM "RatePublication"`)).rejects.toThrow(DENIED)
    expect((await sql(floor(), `SELECT id::text AS id FROM "RateAcknowledgement"`)).map((row) => row.id)).toContain(pay.acknowledgementId)
  })

  it('every rate and amount is a wages figure; the personal columns are tagged; no name, tax code, IBAN or birth date is kept', async () => {
    const models = loadSchema().filter((model) => model.file === FILE)
    const tagged = (grain: string) => models.flatMap((model) => model.fields.filter((field) => field.tags.includes(grain)).map((field) => `${model.name}.${field.name}`))
    expect(tagged('@grain wages').sort()).toEqual(
      [
        'EarningsEntry.amount',
        'EarningsEntry.rate',
        'IncentiveScheme.guaranteedHourlyRate',
        'IncentiveScheme.traineeHourlyRate',
        'PayrollExport.values',
        'PieceRateEntry.ratePerMinute',
        'PieceRateEntry.ratePerPiece',
        'WorkerStatement.earningsAmount',
        'WorkerStatement.makeUpAmount',
        'WorkerStatement.summary',
      ].sort(),
    )
    expect(models.flatMap((model) => model.fields.filter((field) => field.tags.some((t) => t.startsWith('@grain') && t !== '@grain wages')).map((field) => field.name))).toEqual([])
    expect(tagged('@personal piece-pay').sort()).toEqual(
      [
        'EarningsEntry.workerId',
        'HeldScan.workerId',
        'PayrollExport.values',
        'RateAcknowledgement.workerId',
        'RatePublication.workerIds',
        'WorkerStatement.summary',
        'WorkerStatement.workerId',
      ].sort(),
    )
    const columns = await admin(`SELECT table_name AS t, column_name AS c FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ANY($1::text[])`, [[...TABLES]])
    expect(columns.filter((column) => /displayName|firstName|lastName|fiscal|taxCode|iban|birth|address|photo/i.test(String(column.c)))).toEqual([])
  })

  it('the legal switch ships OFF: the column’s default, B1’s seeded row, and a new row', async () => {
    const [column] = await admin(`SELECT column_default AS d FROM information_schema.columns WHERE table_name = 'PiecePaySwitch' AND column_name = 'state'`)
    expect(String(column!.d)).toMatch(/^'OFF'/)
    expect(await one('PiecePaySwitch', pay.switchIds.off, `state::text AS state, "onFrom" AS "onFrom"`)).toEqual({ state: 'OFF', onFrom: null })
    expect(await one('PiecePaySwitch', pay.switchIds.on, `state::text AS state, "onFrom"::text AS "onFrom"`)).toEqual({ state: 'ON', onFrom: '2026-11-13' })
  })
})

// --- rates, publications and receipts -------------------------------------------------------------------------------

describe('rate versions and their rates', () => {
  it('a version leaves DRAFT only with a rate and a publication dated on or before its first day (c.c. art. 2101)', async () => {
    const table = tableRow()
    await insert(office(), 'PieceRateTable', table)
    await expect(insert(office(), 'PieceRateVersion', versionRow(table.id, { status: 'PUBLISHED' }))).rejects.toThrow(/starts as a DRAFT/)
    await expect(insert(office(), 'PieceRateVersion', versionRow(table.id, { provisional: true }))).rejects.toThrow(/trial end \(after its first day\) exactly when provisional/)
    await expect(insert(office(), 'PieceRateVersion', versionRow(table.id, { provisional: true, trialEndsOn: '2027-03-01' }))).rejects.toThrow(/trial end/)
    const version = versionRow(table.id)
    await insert(office(), 'PieceRateVersion', version)
    await expect(update('PieceRateVersion', version.id, { status: 'PUBLISHED' })).rejects.toThrow(/has no rate/)
    await insert(office(), 'PieceRateEntry', entryRow(version.id))
    await expect(update('PieceRateVersion', version.id, { status: 'PUBLISHED' })).rejects.toThrow(/was not published to the workers on or before its first day/)
    await insert(office(), 'RatePublication', publicationRow(version.id, { publishedAt: '2027-03-02T10:00:00.000Z' }))
    await expect(update('PieceRateVersion', version.id, { status: 'PUBLISHED' })).rejects.toThrow(/was not published to the workers on or before its first day/)
    // Published late on the evening of its first day (Rome) still counts as that day.
    await insert(office(), 'RatePublication', publicationRow(version.id, { publishedAt: '2027-03-01T21:00:00.000Z' }))
    await expect(update('PieceRateVersion', version.id, { status: 'PROVISIONAL' })).rejects.toThrow(/wrong columns/)
    expect(await update('PieceRateVersion', version.id, { status: 'PUBLISHED' })).toBe(1)
    // A provisional draft is published as PROVISIONAL, never straight to PUBLISHED.
    const provisional = versionRow(table.id, { versionNo: 2, changeReason: 'METHOD_CHANGED', effectiveFrom: '2028-01-01', provisional: true, trialEndsOn: '2028-02-01' })
    await insert(office(), 'PieceRateVersion', provisional)
    await insert(office(), 'PieceRateEntry', entryRow(provisional.id))
    await insert(office(), 'RatePublication', publicationRow(provisional.id, { publishedAt: '2027-12-20T10:00:00.000Z' }))
    await expect(update('PieceRateVersion', provisional.id, { status: 'PUBLISHED' })).rejects.toThrow(/published as PROVISIONAL and confirmed after its trial/)
  })

  it('rates are exact (SMV × rate per minute rounded to six decimals, or a fixed rate) and written only while the version is a DRAFT', async () => {
    const table = tableRow()
    const version = versionRow(table.id)
    await insert(office(), 'PieceRateTable', table)
    await insert(office(), 'PieceRateVersion', version)
    await expect(insert(office(), 'PieceRateEntry', entryRow(version.id, { basis: 'SMV_RATE', standardMinutes: '10.500', ratePerMinute: '0.123457', ratePerPiece: '1.296300' }))).rejects.toThrow(/exactly their product rounded/)
    expect(await insert(office(), 'PieceRateEntry', entryRow(version.id, { basis: 'SMV_RATE', standardMinutes: '10.500', ratePerMinute: '0.123457', ratePerPiece: '1.296299' }))).toBe(1)
    await expect(insert(office(), 'PieceRateEntry', entryRow(version.id, { basis: 'SMV_RATE', operationId: A.pack, standardMinutes: '0', ratePerMinute: '0.1', ratePerPiece: '0' }))).rejects.toThrow(/standard minutes above 0/)
    await expect(insert(office(), 'PieceRateEntry', entryRow(version.id, { operationId: A.pack, ratePerMinute: '0.1' }))).rejects.toThrow(/fixed per piece/)
    await expect(insert(office(), 'PieceRateEntry', entryRow(version.id, { operationId: A.pack, ratePerPiece: '-0.1' }))).rejects.toThrow(/fixed per piece/)
    await expect(insert(office(), 'PieceRateEntry', entryRow(version.id, { operationId: A.pack, sizeBand: ' ' }))).rejects.toThrow(/size band/)
    // The seeded version 1 is PUBLISHED: its rates never change, and nothing is added.
    await expect(run(office(), `UPDATE "PieceRateEntry" SET "ratePerPiece" = 99 WHERE id = $1::uuid`, pay.rateEntryIds.pack)).rejects.toThrow(/written only while it is a DRAFT/)
    await expect(run(office(), `DELETE FROM "PieceRateEntry" WHERE id = $1::uuid`, pay.rateEntryIds.pack)).rejects.toThrow(/written only while it is a DRAFT/)
    await expect(insert(office(), 'PieceRateEntry', entryRow(pay.rateVersionIds.published, { operationId: key('product:operation:QC') }))).rejects.toThrow(/written only while it is a DRAFT/)
  })

  it('versions of a table never overlap; from PROVISIONAL on only the status, the last day (once) and the confirmation change; only an unpublished draft is deleted', async () => {
    const first = await publishedVersion('2027-03-01')
    const second = versionRow(first.tableId, { versionNo: 2, changeReason: 'EQUIPMENT_CHANGED', effectiveFrom: '2027-06-01', provisional: true, trialEndsOn: '2027-07-31' })
    await insert(office(), 'PieceRateVersion', second)
    await insert(office(), 'PieceRateEntry', entryRow(second.id))
    await insert(office(), 'RatePublication', publicationRow(second.id, { publishedAt: '2027-05-01T08:00:00.000Z' }))
    await expect(update('PieceRateVersion', second.id, { status: 'PROVISIONAL' })).rejects.toThrow(/overlaps version 1 of the same table/)
    expect(await update('PieceRateVersion', first.versionId, { effectiveTo: '2027-05-31' })).toBe(1)
    await expect(update('PieceRateVersion', first.versionId, { effectiveTo: '2027-05-30' })).rejects.toThrow(/set once/)
    await expect(update('PieceRateVersion', first.versionId, { changeNote: 'edited' })).rejects.toThrow(/its rates and days never change/)
    expect(await update('PieceRateVersion', second.id, { status: 'PROVISIONAL' })).toBe(1)
    await expect(update('PieceRateVersion', first.versionId, { status: 'SUPERSEDED' })).rejects.toThrow(/wrong columns/)
    expect(await update('PieceRateVersion', first.versionId, { status: 'SUPERSEDED', supersededAt: now })).toBe(1)
    await expect(update('PieceRateVersion', first.versionId, { supersededAt: '2027-06-02T08:00:00.000Z' })).rejects.toThrow(/never changes again/)
    await expect(update('PieceRateVersion', second.id, { status: 'PUBLISHED' })).rejects.toThrow(/wrong columns/)
    expect(await update('PieceRateVersion', second.id, { status: 'PUBLISHED', confirmedAt: '2027-08-01T08:00:00.000Z', confirmedById: a.actorId })).toBe(1)
    await expect(update('PieceRateVersion', second.id, { status: 'DRAFT' })).rejects.toThrow(/cannot move from PUBLISHED to DRAFT/)
    // Deletes: never a version in force, never a published draft; an unpublished draft (its rates first).
    await expect(run(office(), `DELETE FROM "PieceRateVersion" WHERE id = $1::uuid`, second.id)).rejects.toThrow(/only a DRAFT that was never published/)
    const published = versionRow(first.tableId, { versionNo: 3, changeReason: 'CORRECTION', effectiveFrom: '2028-01-01' })
    await insert(office(), 'PieceRateVersion', published)
    await insert(office(), 'RatePublication', publicationRow(published.id, { publishedAt: '2027-12-01T08:00:00.000Z' }))
    await expect(run(office(), `DELETE FROM "PieceRateVersion" WHERE id = $1::uuid`, published.id)).rejects.toThrow(/only a DRAFT that was never published/)
    const draft = versionRow(first.tableId, { versionNo: 4, changeReason: 'CORRECTION', effectiveFrom: '2029-01-01' })
    const draftEntry = entryRow(draft.id)
    await insert(office(), 'PieceRateVersion', draft)
    await insert(office(), 'PieceRateEntry', draftEntry)
    expect(await run(office(), `DELETE FROM "PieceRateEntry" WHERE id = $1::uuid`, draftEntry.id)).toBe(1)
    expect(await run(office(), `DELETE FROM "PieceRateVersion" WHERE id = $1::uuid`, draft.id)).toBe(1)
    // A table with rates in force keeps its style, line and currency.
    await expect(update('PieceRateTable', first.tableId, { currency: 'USD' })).rejects.toThrow(/keeps|stay as they were/)
    await refusedToAll(`DELETE FROM "PieceRateTable" WHERE id = $1::uuid`, first.tableId, /archived, never deleted/)
  })
})

describe('publications and receipts', () => {
  it('a publication goes to ACTIVE workers of its site, each once, on the floor or on paper; it is withdrawn only while its version is a DRAFT; never deleted', async () => {
    const table = tableRow()
    const draft = versionRow(table.id)
    await insert(office(), 'PieceRateTable', table)
    await insert(office(), 'PieceRateVersion', draft)
    await expect(insert(office(), 'RatePublication', publicationRow(draft.id, { workerIds: [] }))).rejects.toThrow(/at least one worker/)
    await expect(insert(office(), 'RatePublication', publicationRow(draft.id, { workerIds: [pay.production.operatorId, pay.production.operatorId] }))).rejects.toThrow(/each once/)
    await expect(insert(office(), 'RatePublication', publicationRow(draft.id, { workerIds: [A.workerB] }))).rejects.toThrow(/ACTIVE worker of its site \(0 of 1/)
    await expect(insert(office(), 'RatePublication', publicationRow(draft.id, { onFloor: false, printed: false }))).rejects.toThrow(/on the floor, on paper or both/)
    await expect(insert(office(), 'RatePublication', publicationRow(draft.id, { status: 'WITHDRAWN', withdrawnAt: now, withdrawnById: a.actorId, withdrawReason: 'x' }))).rejects.toThrow(/starts PUBLISHED/)
    const publication = publicationRow(draft.id, { workerIds: [pay.production.operatorId, pay.production.leadId] })
    expect(await insert(office(), 'RatePublication', publication)).toBe(1)
    await expect(update('RatePublication', publication.id, { workerIds: [pay.production.leadId] })).rejects.toThrow(/never changes/)
    await expect(update('RatePublication', publication.id, { sheetFileId: A.officeFile })).rejects.toThrow(/a stored file of the publication/)
    await expect(update('RatePublication', publication.id, { status: 'WITHDRAWN' })).rejects.toThrow(/wrong columns/)
    expect(await update('RatePublication', publication.id, { status: 'WITHDRAWN', withdrawnAt: now, withdrawnById: a.actorId, withdrawReason: 'Wrong line' })).toBe(1)
    await expect(update('RatePublication', publication.id, { withdrawReason: 'Other' })).rejects.toThrow(/withdrawn; that is final/)
    // The seeded publication's version is PUBLISHED: it stands.
    await expect(update('RatePublication', pay.publicationId, { status: 'WITHDRAWN', withdrawnAt: now, withdrawnById: a.actorId, withdrawReason: 'x' })).rejects.toThrow(/its publications stand/)
    await refusedToAll(`DELETE FROM "RatePublication" WHERE id = $1::uuid`, pay.publicationId, /never deleted/)
    // A superseded or cancelled version is published no more.
    await update('PieceRateVersion', draft.id, { status: 'CANCELLED', cancelledAt: now, cancelReason: 'Not needed' })
    await expect(insert(office(), 'RatePublication', publicationRow(draft.id))).rejects.toThrow(/is CANCELLED; it is published no more/)
    // A withdrawn publication is acknowledged by nobody.
    await expect(insert(office(), 'RateAcknowledgement', receiptRow({ publicationId: publication.id, versionId: draft.id, workerId: pay.production.leadId }))).rejects.toThrow(/nobody acknowledges it/)
  })

  it('receipts are append-only for every login; the floor records the signed-in worker’s reading of a publication made to them', async () => {
    const id = pay.acknowledgementId
    await expect(run(office(), `UPDATE "RateAcknowledgement" SET "serverTime" = now() WHERE id = $1::uuid`, id)).rejects.toThrow(DENIED)
    await expect(run(floor(), `DELETE FROM "RateAcknowledgement" WHERE id = $1::uuid`, id)).rejects.toThrow(DENIED)
    await expect(admin(`UPDATE "RateAcknowledgement" SET "serverTime" = now() WHERE id = $1`, [id])).rejects.toThrow(/append-only: UPDATE on "RateAcknowledgement" is refused/)
    await expect(admin(`DELETE FROM "RateAcknowledgement" WHERE id = $1`, [id])).rejects.toThrow(/append-only: DELETE/)
    await expect(admin(`TRUNCATE "RateAcknowledgement"`)).rejects.toThrow(/TRUNCATE on "RateAcknowledgement" is refused/)
    expect(await insert(floor(), 'RateAcknowledgement', receiptRow())).toBe(1)
    await expect(insert(floor(), 'RateAcknowledgement', receiptRow({ workerId: pay.production.leadId }))).rejects.toThrow(/one of the workers it went to/)
    await expect(insert(floor(), 'RateAcknowledgement', receiptRow({ versionId: pay.rateVersionIds.draft }))).rejects.toThrow(/names the version of publication/)
    await expect(insert(floor(), 'RateAcknowledgement', receiptRow({ deviceId: null }))).rejects.toThrow(/on a device names the device/)
    await expect(insert(office(), 'RateAcknowledgement', receiptRow({ channel: 'PAPER' }))).rejects.toThrow(/on paper it names no device/)
    expect(await insert(office(), 'RateAcknowledgement', receiptRow({ channel: 'PAPER', deviceId: null, clientEventId: null }))).toBe(1)
    await expect(insert(office(), 'RateAcknowledgement', receiptRow({ channel: 'PAPER', deviceId: null, clientEventId: null, paperFileId: A.officeFile }))).rejects.toThrow(/signed copy .* stored file of publication/)
    // A resent reading is recorded once (per device and event id).
    const resent = receiptRow()
    await insert(floor(), 'RateAcknowledgement', resent)
    await expect(insert(floor(), 'RateAcknowledgement', { ...resent, id: randomUUID() })).rejects.toThrow(/unique|duplicate/i)
  })
})

// --- schemes ------------------------------------------------------------------------------------------------------

describe('incentive schemes', () => {
  it('have the shape their kind asks; become ACTIVE only with a guaranteed pay and without overlapping; then change only their end; only a draft is deleted', async () => {
    await expect(insert(office(), 'IncentiveScheme', schemeRow({ status: 'ACTIVE', activatedAt: now, activatedById: a.actorId }))).rejects.toThrow(/starts as a DRAFT/)
    await expect(insert(office(), 'IncentiveScheme', schemeRow({ kind: 'STANDARD_MINUTE_BONUS' }))).rejects.toThrow(/threshold .* exactly for a standard-minute bonus/)
    await expect(insert(office(), 'IncentiveScheme', schemeRow({ efficiencyThresholdPct: '90' }))).rejects.toThrow(/threshold/)
    await expect(insert(office(), 'IncentiveScheme', schemeRow({ kind: 'STANDARD_MINUTE_BONUS', efficiencyThresholdPct: '250' }))).rejects.toThrow(/threshold/)
    await expect(insert(office(), 'IncentiveScheme', schemeRow({ kind: 'TEAM_INCENTIVE' }))).rejects.toThrow(/team split exactly for a team incentive/)
    await expect(insert(office(), 'IncentiveScheme', schemeRow({ reworkOwnFault: 'REDUCED_RATE' }))).rejects.toThrow(/reduced own-fault rate/)
    await expect(insert(office(), 'IncentiveScheme', schemeRow({ reworkOwnFault: 'REDUCED_RATE', ownFaultRatePct: '100' }))).rejects.toThrow(/reduced own-fault rate/)
    await expect(insert(office(), 'IncentiveScheme', schemeRow({ lineId: A.lineA }))).rejects.toThrow(/a line exactly with its site/)
    await expect(insert(office(), 'IncentiveScheme', schemeRow({ guaranteedHourlyRate: '-1' }))).rejects.toThrow(/no negative rate/)
    await expect(insert(office(), 'IncentiveScheme', schemeRow({ companyId: A.companyB, siteId: A.siteA, lineId: A.lineA }))).rejects.toThrow(/site of another company/)
    // Waiting is always paid: there is no unpaid choice.
    await expect(insert(office(), 'IncentiveScheme', schemeRow({ waitingPay: 'UNPAID' }))).rejects.toThrow(/invalid input value for enum/)
    const undecided = schemeRow({ siteId: A.siteA, lineId: A.lineA, kind: 'TEAM_INCENTIVE', teamSplit: 'SKILL_WEIGHT' })
    await insert(office(), 'IncentiveScheme', undecided)
    await expect(update('IncentiveScheme', undecided.id, { status: 'ACTIVE', activatedAt: now, activatedById: a.actorId })).rejects.toThrow(/no guaranteed pay yet/)
    // The company's own scheme is ACTIVE from 2026-11-01 (open): another company-wide one overlaps it.
    const overlapping = schemeRow({ guaranteedBasis: 'AGREED_HOURLY', guaranteedHourlyRate: '9.5', validFrom: '2026-12-01' })
    await insert(office(), 'IncentiveScheme', overlapping)
    await expect(update('IncentiveScheme', overlapping.id, { status: 'ACTIVE', activatedAt: now, activatedById: a.actorId })).rejects.toThrow(/overlaps scheme/)
    expect(await run(office(), `DELETE FROM "IncentiveScheme" WHERE id = $1::uuid`, overlapping.id)).toBe(1)
    // The line's own one does not overlap the company's (it wins on its line).
    expect(await update('IncentiveScheme', undecided.id, { guaranteedBasis: 'CCNL_MINIMUM', guaranteedHourlyRate: '9.0', status: 'ACTIVE', activatedAt: now, activatedById: a.actorId })).toBe(1)
    await expect(update('IncentiveScheme', undecided.id, { name: 'Renamed' })).rejects.toThrow(/changes only by a later scheme/)
    await expect(update('IncentiveScheme', undecided.id, { status: 'RETIRED' })).rejects.toThrow(/wrong columns/)
    expect(await update('IncentiveScheme', undecided.id, { validTo: '2027-12-31' })).toBe(1)
    await expect(update('IncentiveScheme', undecided.id, { validTo: '2027-11-30' })).rejects.toThrow(/set once/)
    expect(await update('IncentiveScheme', undecided.id, { status: 'RETIRED' })).toBe(1)
    await expect(update('IncentiveScheme', undecided.id, { note: 'x' })).rejects.toThrow(/RETIRED; it never changes again/)
    await expect(run(office(), `DELETE FROM "IncentiveScheme" WHERE id = $1::uuid`, undecided.id)).rejects.toThrow(/only a DRAFT is deleted/)
  })
})

// --- the earnings ledger --------------------------------------------------------------------------------------------

describe('the earnings ledger', () => {
  const [misScan, undo, report] = [0, 1, 2] as const
  const scanEntry = (extra: Record<string, unknown> = {}) =>
    earningRow({ kind: 'SCAN', operationScanId: pay.production.scanIds[report], rateEntryId: pay.rateEntryIds.sew, pieces: 2, rate: '11.580000', amount: 2316, minutes: null, workDate: '2026-11-17', ...extra })

  it('is append-only for every login, the owner included', async () => {
    const id = pay.entryIds.scan
    await expect(run(office(), `UPDATE "EarningsEntry" SET amount = 1 WHERE id = $1::uuid`, id)).rejects.toThrow(DENIED)
    await expect(run(office(), `DELETE FROM "EarningsEntry" WHERE id = $1::uuid`, id)).rejects.toThrow(DENIED)
    await expect(admin(`UPDATE "EarningsEntry" SET amount = 1 WHERE id = $1`, [id])).rejects.toThrow(/append-only: UPDATE on "EarningsEntry" is refused/)
    await expect(admin(`DELETE FROM "EarningsEntry" WHERE id = $1`, [id])).rejects.toThrow(/append-only: DELETE/)
    await expect(admin(`TRUNCATE "EarningsEntry" CASCADE`)).rejects.toThrow(/TRUNCATE on "EarningsEntry" is refused/)
  })

  it('pays a scan once: a standing report of its worker, at a rate in force for its operation, never while held', async () => {
    // The seeded entry already paid the standing report: one entry per event.
    await expect(insert(office(), 'EarningsEntry', scanEntry({ idempotencyKey: `scan:${pay.production.scanIds[report]}` }))).rejects.toThrow(/unique|duplicate/i)
    await expect(insert(office(), 'EarningsEntry', scanEntry({ rateEntryId: null }))).rejects.toThrow(/names its scan and rate/)
    await expect(insert(office(), 'EarningsEntry', scanEntry({ amount: -1 }))).rejects.toThrow(/of 0 or more/)
    await expect(insert(office(), 'EarningsEntry', scanEntry({ sharePct: '50' }))).rejects.toThrow(/share .* exactly for a team split/)
    await expect(insert(office(), 'EarningsEntry', scanEntry({ operationScanId: pay.production.scanIds[undo] }))).rejects.toThrow(/standing report or correction \(scan .* is a UNDO/)
    await expect(insert(office(), 'EarningsEntry', scanEntry({ operationScanId: pay.production.scanIds[misScan] }))).rejects.toThrow(/voided/)
    await expect(insert(office(), 'EarningsEntry', scanEntry({ workerId: pay.production.leadId }))).rejects.toThrow(/of another worker/)
    await expect(insert(office(), 'EarningsEntry', scanEntry({ rateEntryId: pay.rateEntryIds.pack }))).rejects.toThrow(/rate of another operation or style/)
    await expect(insert(office(), 'EarningsEntry', scanEntry({ rateEntryId: pay.rateEntryIds.sew2 }))).rejects.toThrow(/its version is DRAFT .* rates apply only once published/)
    await expect(insert(office(), 'EarningsEntry', scanEntry({ heldScanId: pay.heldScanIds.open }))).rejects.toThrow(/which is no COUNTED hold of scan/)
    // A team split pays another worker their share of the same scan.
    expect(await insert(office(), 'EarningsEntry', scanEntry({ kind: 'TEAM_SPLIT', workerId: pay.production.leadId, sharePct: '40', amount: 926, heldScanId: pay.heldScanIds.counted }))).toBe(1)
    await expect(insert(office(), 'EarningsEntry', scanEntry({ kind: 'TEAM_SPLIT', workerId: pay.production.leadId, sharePct: '0' }))).rejects.toThrow(/share \(above 0/)
    // A new hold of the paid scan stops any further pay for it until it is counted.
    const hold = { id: randomUUID(), companyId: A.companyA, siteId: A.siteA, payPeriodId: pay.periodIds.november, workerId: pay.production.operatorId, operationScanId: pay.production.scanIds[report], reason: 'ON_BREAK', heldAt: now, key: `held:test:${tag()}` }
    await insert(office(), 'HeldScan', hold)
    await expect(insert(office(), 'EarningsEntry', scanEntry({ kind: 'TEAM_SPLIT', workerId: pay.production.leadId, sharePct: '10', amount: 231 }))).rejects.toThrow(/is held .* pays nothing until it is counted/)
    await update('HeldScan', hold.id, { status: 'NOT_PAID', resolvedAt: now, resolvedById: a.actorId, resolutionNote: 'On a break: not paid (test)' })
    await expect(insert(office(), 'EarningsEntry', scanEntry({ kind: 'TEAM_SPLIT', workerId: pay.production.leadId, sharePct: '10', amount: 231 }))).rejects.toThrow(/is held/)
  })

  it('records nothing outside the site’s piece-pay window, and checks each kind’s shape', async () => {
    await expect(insert(office(), 'EarningsEntry', earningRow({ workDate: '2026-11-12' }))).rejects.toThrow(/piece pay is not ON at site .* on 2026-11-12/)
    expect(await insert(office(), 'EarningsEntry', earningRow())).toBe(1)
    await expect(insert(office(), 'EarningsEntry', earningRow({ minutes: '0' }))).rejects.toThrow(/make-up .* minutes above 0/)
    await expect(insert(office(), 'EarningsEntry', earningRow({ operationScanId: pay.production.scanIds[report] }))).rejects.toThrow(/make-up .* names no scan/)
    await expect(insert(office(), 'EarningsEntry', earningRow({ kind: 'OFF_STANDARD' }))).rejects.toThrow(/off-standard entry .* names its source record/)
    expect(await insert(office(), 'EarningsEntry', earningRow({ kind: 'OFF_STANDARD', sourceType: 'OffStandardEntry', sourceId: randomUUID() }))).toBe(1)
    await expect(insert(office(), 'EarningsEntry', earningRow({ sourceType: 'OffStandardEntry' }))).rejects.toThrow(/a source exactly with its id/)
    await expect(insert(office(), 'EarningsEntry', earningRow({ kind: 'ADJUSTMENT', minutes: null, rate: null, amount: -300 }))).rejects.toThrow(/adjustment .* says why/)
    // An adjustment corrects: it needs no switch window (B1 never had one), but a worker of its site.
    expect(await insert(office(), 'EarningsEntry', earningRow({ kind: 'ADJUSTMENT', minutes: null, rate: null, amount: -300, reason: 'Overpaid make-up (test)', workDate: '2026-11-12' }))).toBe(1)
    await expect(insert(office(), 'EarningsEntry', earningRow({ siteId: A.siteB, companyId: A.companyB }))).rejects.toThrow(/violates foreign key|not ON at site/)
    await expect(insert(office(), 'EarningsEntry', earningRow({ currency: 'eur' }))).rejects.toThrow(/an ISO currency/)
  })

  it('corrects by mirrored reversals, once, with a reason', async () => {
    const original = earningRow({ amount: 1200, minutes: '80.000' })
    await insert(office(), 'EarningsEntry', original)
    const reversal = earningRow({ reversalOfId: original.id, amount: -1200, minutes: '-80.000', reason: 'Wrong minutes', idempotencyKey: `reversal:${original.id}` })
    await expect(insert(office(), 'EarningsEntry', { ...reversal, amount: -1000 })).rejects.toThrow(/mirrors entry/)
    await expect(insert(office(), 'EarningsEntry', { ...reversal, kind: 'ADJUSTMENT' })).rejects.toThrow(/mirrors entry/)
    await expect(insert(office(), 'EarningsEntry', { ...reversal, workerId: pay.production.leadId })).rejects.toThrow(/mirrors entry/)
    await expect(insert(office(), 'EarningsEntry', { ...reversal, reason: null })).rejects.toThrow(/says why/)
    expect(await insert(office(), 'EarningsEntry', reversal)).toBe(1)
    await expect(insert(office(), 'EarningsEntry', { ...reversal, id: randomUUID(), idempotencyKey: `test:${tag()}` })).rejects.toThrow(/EarningsEntry_reversed_once|duplicate key/)
    await expect(insert(office(), 'EarningsEntry', earningRow({ reversalOfId: reversal.id, amount: 1200, minutes: '80.000', reason: 'x' }))).rejects.toThrow(/reverses no reversal/)
    // The seeded reversal mirrors the seeded adjustment.
    expect(await one('EarningsEntry', pay.entryIds.reversal, `amount, "reversalOfId"::text AS r`)).toEqual({ amount: -500, r: pay.entryIds.adjustment })
  })
})

// --- periods, holds, statements -----------------------------------------------------------------------------------

describe('pay periods, held scans and statements', () => {
  const december = periodRow('2026-12-01', '2026-12-31')
  const lockDecember = () => update('PayPeriod', december.id, { status: 'LOCKED', lockedAt: now, lockedById: a.actorId })

  it('a period is one whole month, starts OPEN and moves OPEN → PREVIEW ⇄ REVIEW → LOCKED, with its columns', async () => {
    await expect(insert(office(), 'PayPeriod', periodRow('2027-01-02', '2027-01-31'))).rejects.toThrow(/one whole month/)
    await expect(insert(office(), 'PayPeriod', periodRow('2027-01-01', '2027-02-28'))).rejects.toThrow(/one whole month/)
    await expect(insert(office(), 'PayPeriod', periodRow('2027-01-01', '2027-01-31', { status: 'PREVIEW', previewedAt: now, previewedById: a.actorId }))).rejects.toThrow(/starts OPEN/)
    await insert(office(), 'PayPeriod', december)
    await expect(update('PayPeriod', december.id, { status: 'REVIEW', previewedAt: now, previewedById: a.actorId, reviewStartedAt: now, reviewStartedById: a.actorId })).rejects.toThrow(/cannot move from OPEN to REVIEW/)
    await expect(update('PayPeriod', december.id, { status: 'PREVIEW' })).rejects.toThrow(/wrong columns/)
    expect(await update('PayPeriod', december.id, { status: 'PREVIEW', previewedAt: now, previewedById: a.actorId })).toBe(1)
    expect(await update('PayPeriod', december.id, { status: 'REVIEW', reviewStartedAt: now, reviewStartedById: a.actorId })).toBe(1)
    await expect(update('PayPeriod', december.id, { periodStart: '2027-01-01', periodEnd: '2027-01-31' })).rejects.toThrow(/month and creation .* never change/)
    await refusedToAll(`DELETE FROM "PayPeriod" WHERE id = $1::uuid`, december.id, /never deleted/)
  })

  it('locks only with no scan held and an APPROVED statement for every worker paid in it; then nothing in it changes', async () => {
    await insert(office(), 'EarningsEntry', earningRow({ payPeriodId: december.id, workDate: '2026-12-05' }))
    await expect(lockDecember()).rejects.toThrow(/0 scan\(s\) still held, 0 statement\(s\) in DRAFT, 1 worker\(s\) paid without an APPROVED statement/)
    const hold = { id: randomUUID(), companyId: A.companyA, siteId: A.siteA, payPeriodId: december.id, workerId: pay.production.operatorId, operationScanId: pay.production.scanIds[2], reason: 'NOT_CLOCKED_IN', heldAt: now, key: `held:test:${tag()}` }
    await insert(office(), 'HeldScan', hold)
    const statement = { id: randomUUID(), companyId: A.companyA, siteId: A.siteA, payPeriodId: december.id, workerId: pay.production.operatorId }
    await insert(office(), 'WorkerStatement', statement)
    await expect(lockDecember()).rejects.toThrow(/1 scan\(s\) still held, 1 statement\(s\) in DRAFT, 1 worker\(s\) paid/)
    await expect(update('WorkerStatement', statement.id, { status: 'APPROVED', approvedAt: now, approvedById: a.actorId })).rejects.toThrow(/wrong columns/)
    expect(await update('WorkerStatement', statement.id, { status: 'APPROVED', approvedAt: now, approvedById: a.actorId, summary: { lines: [] }, earningsAmount: 900, makeUpAmount: 0 })).toBe(1)
    await expect(update('WorkerStatement', statement.id, { earningsAmount: 901 })).rejects.toThrow(/APPROVED; it never changes/)
    await expect(update('HeldScan', hold.id, { status: 'COUNTED', resolvedAt: now, resolvedById: a.actorId })).rejects.toThrow(/wrong columns/)
    await expect(update('HeldScan', hold.id, { status: 'NOT_PAID', resolvedAt: now, resolvedById: a.actorId })).rejects.toThrow(/wrong columns/)
    await expect(lockDecember()).rejects.toThrow(/1 scan\(s\) still held, 0 statement/)
    expect(await update('HeldScan', hold.id, { status: 'NOT_PAID', resolvedAt: now, resolvedById: a.actorId, resolutionNote: 'Not at work (test)' })).toBe(1)
    await expect(update('HeldScan', hold.id, { status: 'COUNTED', fixRecordType: 'AttendanceDay', fixRecordId: randomUUID() })).rejects.toThrow(/decided .* final/)
    expect(await lockDecember()).toBe(1)
    await expect(update('PayPeriod', december.id, { lockNote: 'x' })).rejects.toThrow(/LOCKED; it never changes/)
    await expect(insert(office(), 'EarningsEntry', earningRow({ payPeriodId: december.id, workDate: '2026-12-06' }))).rejects.toThrow(/is LOCKED; a change is paid in a later period/)
    await expect(insert(office(), 'WorkerStatement', { ...statement, id: randomUUID(), revision: 2 })).rejects.toThrow(/LOCKED; no statement is added/)
    await expect(update('WorkerStatement', statement.id, { status: 'SUPERSEDED', supersededAt: now })).rejects.toThrow(/is final \(its period is LOCKED/)
    await expect(insert(office(), 'HeldScan', { ...hold, id: randomUUID(), status: 'OPEN', resolvedAt: null, resolvedById: null, resolutionNote: null, key: `held:test:${tag()}` })).rejects.toThrow(/LOCKED; its held scans are decided before the lock/)
  })

  it('late work of a LOCKED period is paid in a later one that names it, and only then', async () => {
    const january = periodRow('2027-01-01', '2027-01-31')
    await insert(office(), 'PayPeriod', january)
    const late = earningRow({ payPeriodId: january.id, workDate: '2026-12-07', kind: 'ADJUSTMENT', minutes: null, rate: null, amount: 150, reason: 'Late bonus (test)' })
    await expect(insert(office(), 'EarningsEntry', late)).rejects.toThrow(/outside its period .* names the LOCKED earlier period/)
    await expect(insert(office(), 'EarningsEntry', { ...late, correctsPeriodId: pay.periodIds.october })).rejects.toThrow(/names the LOCKED earlier period/)
    await expect(insert(office(), 'EarningsEntry', { ...late, workDate: '2026-11-25', correctsPeriodId: pay.periodIds.november })).rejects.toThrow(/names the LOCKED earlier period/)
    expect(await insert(office(), 'EarningsEntry', { ...late, correctsPeriodId: december.id })).toBe(1)
    await expect(insert(office(), 'EarningsEntry', earningRow({ payPeriodId: january.id, workDate: '2027-01-05', correctsPeriodId: december.id }))).rejects.toThrow(/corrects no other period/)
  })

  it('a held scan holds a report of its own worker, starts OPEN and is decided once; a statement is a DRAFT until approved, its PDF named once', async () => {
    const base = { companyId: A.companyA, siteId: A.siteA, payPeriodId: pay.periodIds.november, operationScanId: pay.production.scanIds[2], reason: 'NOT_CLOCKED_IN', heldAt: now }
    await expect(insert(office(), 'HeldScan', { ...base, id: randomUUID(), workerId: pay.production.leadId, key: `held:test:${tag()}` })).rejects.toThrow(/of its own worker/)
    await expect(insert(office(), 'HeldScan', { ...base, id: randomUUID(), workerId: pay.production.operatorId, operationScanId: pay.production.scanIds[1], key: `held:test:${tag()}` })).rejects.toThrow(/of its own worker/)
    await expect(insert(office(), 'HeldScan', { ...base, id: randomUUID(), workerId: pay.production.operatorId, key: ' ' })).rejects.toThrow(/starts OPEN, with its key/)
    await expect(update('HeldScan', pay.heldScanIds.open, { reason: 'ON_BREAK' })).rejects.toThrow(/changes only by its decision/)
    await refusedToAll(`DELETE FROM "HeldScan" WHERE id = $1::uuid`, pay.heldScanIds.open, /never deleted/)
    // Statements.
    const statement = { id: randomUUID(), companyId: A.companyA, siteId: A.siteA, payPeriodId: pay.periodIds.november, workerId: pay.production.leadId, revision: 3 }
    await expect(insert(office(), 'WorkerStatement', { ...statement, status: 'APPROVED' })).rejects.toThrow(/starts as a DRAFT/)
    await insert(office(), 'WorkerStatement', statement)
    await expect(update('WorkerStatement', statement.id, { makeUpAmount: -1 })).rejects.toThrow(/make-up 0 or more/)
    await expect(update('WorkerStatement', statement.id, { revision: 4 })).rejects.toThrow(/revision and creation .* never change/)
    await expect(update('WorkerStatement', statement.id, { fileId: A.officeFile })).rejects.toThrow(/a stored file of the statement/)
    const pdf = fileRow('WorkerStatement', statement.id)
    await insert(office(), 'StoredFile', pdf)
    expect(await update('WorkerStatement', statement.id, { fileId: pdf.id })).toBe(1)
    await expect(update('WorkerStatement', statement.id, { fileId: null })).rejects.toThrow(/named once/)
    expect(await update('WorkerStatement', statement.id, { status: 'SUPERSEDED', supersededAt: now })).toBe(1)
    await expect(update('WorkerStatement', statement.id, { summary: { x: 1 } })).rejects.toThrow(/is final/)
    await refusedToAll(`DELETE FROM "WorkerStatement" WHERE id = $1::uuid`, statement.id, /never deleted/)
  })
})

// --- the legal switch ---------------------------------------------------------------------------------------------

describe('the legal switch', () => {
  it('turns ON only with every precondition on record and the site’s legal basis for naming workers, from a day not in the past', async () => {
    const site = { id: randomUUID(), companyId: A.companyA, code: `S${tag()}`, name: 'Test plant', kind: 'PLANT' }
    await insert(office(), 'Site', site)
    const sw = { id: site.id, companyId: A.companyA, siteId: site.id }
    await expect(insert(office(), 'PiecePaySwitch', { ...sw, id: randomUUID(), state: 'ON', onFrom: '2026-12-01', switchedOnAt: now, switchedOnById: a.actorId })).rejects.toThrow(/needs the CCNL/)
    await insert(office(), 'PiecePaySwitch', sw)
    const on = { state: 'ON', onFrom: '2026-12-01', switchedOnAt: now, switchedOnById: a.actorId }
    await expect(update('PiecePaySwitch', sw.id, on)).rejects.toThrow(/needs the CCNL and its article/)
    await update('PiecePaySwitch', sw.id, { ccnlName: 'CCNL TEST', ccnlArticle: 'Art. 1' })
    await expect(update('PiecePaySwitch', sw.id, on)).rejects.toThrow(/needs the company's PUBLISHED worker notice/)
    const privacy = await admin(`SELECT id::text AS id FROM "PrivacyNotice" WHERE "tenantId" = $1 AND "companyId" = $2 AND kind = 'WORKER_FLOOR' AND status = 'DRAFT'`, [a.tenantId, A.companyA])
    await update('PiecePaySwitch', sw.id, { workerNoticeId: privacy[0]!.id })
    await expect(update('PiecePaySwitch', sw.id, on)).rejects.toThrow(/PUBLISHED worker notice/)
    await update('PiecePaySwitch', sw.id, { workerNoticeId: pay.production.workerNoticeId })
    await expect(update('PiecePaySwitch', sw.id, on)).rejects.toThrow(/STORED DPIA/)
    const dpias = await admin(`SELECT id::text AS id, status::text AS status FROM "PrivacyDpia" WHERE "tenantId" = $1 AND "companyId" = $2 ORDER BY "versionNo"`, [a.tenantId, A.companyA])
    await update('PiecePaySwitch', sw.id, { dpiaId: dpias.find((d) => d.status === 'DRAFT')!.id })
    await expect(update('PiecePaySwitch', sw.id, on)).rejects.toThrow(/STORED DPIA/)
    await update('PiecePaySwitch', sw.id, { dpiaId: dpias.find((d) => d.status === 'STORED')!.id })
    await expect(update('PiecePaySwitch', sw.id, on)).rejects.toThrow(/labour consultant's agreement/)
    await update('PiecePaySwitch', sw.id, { consultantName: 'Studio Test', consultantAgreedOn: '2026-11-21' })
    await expect(update('PiecePaySwitch', sw.id, on)).rejects.toThrow(/labour consultant's agreement/)
    await update('PiecePaySwitch', sw.id, { consultantAgreedOn: '2026-11-19' })
    await expect(update('PiecePaySwitch', sw.id, on)).rejects.toThrow(/ACTIVE incentive scheme/)
    await update('PiecePaySwitch', sw.id, { schemeId: pay.schemeIds.draft })
    await expect(update('PiecePaySwitch', sw.id, on)).rejects.toThrow(/ACTIVE incentive scheme/)
    await update('PiecePaySwitch', sw.id, { schemeId: pay.schemeIds.active })
    await expect(update('PiecePaySwitch', sw.id, on)).rejects.toThrow(/floor rules to name workers with a legal basis/)
    await insert(office(), 'ProductionSettings', { id: site.id, companyId: A.companyA, siteId: site.id, scanSubject: 'STATION' })
    await expect(update('PiecePaySwitch', sw.id, on)).rejects.toThrow(/floor rules to name workers/)
    await update('ProductionSettings', site.id, { scanSubject: 'WORKER' })
    await expect(update('PiecePaySwitch', sw.id, on)).rejects.toThrow(/floor rules to name workers/)
    await update('ProductionSettings', site.id, { monitoringBasis: 'UNION_AGREEMENT', monitoringReference: 'Accordo RSU (test)', monitoringRecordedAt: now, monitoringRecordedById: a.actorId })
    await expect(update('PiecePaySwitch', sw.id, { ...on, onFrom: '2026-11-19' })).rejects.toThrow(/never in the past/)
    expect(await update('PiecePaySwitch', sw.id, on)).toBe(1)
    // While ON its basis never changes; its note may.
    await expect(update('PiecePaySwitch', sw.id, { ccnlArticle: 'Art. 2' })).rejects.toThrow(/never change while it runs/)
    expect(await update('PiecePaySwitch', sw.id, { preconditionsNote: 'Checked again (test)' })).toBe(1)
    // A second site's switch made straight ON passes the same gate (its floor rules name no workers: refused).
    await expect(insert(office(), 'PiecePaySwitch', { ...(await one('PiecePaySwitch', sw.id, `"ccnlName", "ccnlArticle", "workerNoticeId"::text AS "workerNoticeId", "dpiaId"::text AS "dpiaId", "consultantName", "consultantAgreedOn"::text AS "consultantAgreedOn", "schemeId"::text AS "schemeId"`)), id: A.siteB, companyId: A.companyB, siteId: A.siteB, ...on })).rejects.toThrow(/violates foreign key|worker notice|DPIA|scheme|floor rules/)
    await refusedToAll(`DELETE FROM "PiecePaySwitch" WHERE id = $1::uuid`, sw.id, /never deleted/)
  })

  it('turns OFF from a day not before its start nor in the past; keeps the record of its window; turning on again keeps the earlier windows', async () => {
    const switchId = pay.switchIds.on
    const off = { state: 'OFF', offFrom: '2027-04-01', switchedOffAt: '2027-03-25T08:00:00.000Z', switchedOffById: a.actorId, offReason: 'Season ends (test)' }
    await expect(update('PiecePaySwitch', switchId, { ...off, offFrom: '2027-03-20' })).rejects.toThrow(/stops from a day not before its start .* never in the past/)
    await expect(update('PiecePaySwitch', switchId, { ...off, offReason: null })).rejects.toThrow(/wrong columns/)
    await expect(update('PiecePaySwitch', switchId, { ...off, onFrom: '2026-11-14' })).rejects.toThrow(/changes only the off columns/)
    expect(await update('PiecePaySwitch', switchId, off)).toBe(1)
    await expect(update('PiecePaySwitch', switchId, { offReason: 'Changed (test)' })).rejects.toThrow(/record of its last window never changes/)
    expect(await update('PiecePaySwitch', switchId, { consultantName: 'Studio Esempio Due (test)' })).toBe(1)
    // November's work stays payable (its window), April's is not.
    expect(await insert(office(), 'EarningsEntry', earningRow({ workDate: '2026-11-23' }))).toBe(1)
    const april = periodRow('2027-04-01', '2027-04-30')
    await insert(office(), 'PayPeriod', april)
    await expect(insert(office(), 'EarningsEntry', earningRow({ payPeriodId: april.id, workDate: '2027-04-15' }))).rejects.toThrow(/piece pay is not ON at site/)
    // On again from May: not before the last window ended, with the closed window kept.
    const on = { state: 'ON', onFrom: '2027-05-03', switchedOnAt: '2027-04-28T08:00:00.000Z', switchedOnById: a.actorId, offFrom: null, switchedOffAt: null, switchedOffById: null, offReason: null }
    await expect(update('PiecePaySwitch', switchId, on)).rejects.toThrow(/keeps its earlier windows and appends the one just closed/)
    await expect(update('PiecePaySwitch', switchId, { ...on, onFrom: '2027-03-31', switchedOnAt: '2027-03-30T08:00:00.000Z', earlierWindows: [{ from: '2026-11-13', to: '2027-04-01' }] })).rejects.toThrow(/nor before its last window ended/)
    expect(await update('PiecePaySwitch', switchId, { ...on, earlierWindows: [{ from: '2026-11-13', to: '2027-04-01' }] })).toBe(1)
    expect(await insert(office(), 'EarningsEntry', earningRow({ workDate: '2026-11-24' }))).toBe(1)
    await expect(insert(office(), 'EarningsEntry', earningRow({ payPeriodId: april.id, workDate: '2027-04-30' }))).rejects.toThrow(/piece pay is not ON at site/)
  })
})

// --- the payroll export -------------------------------------------------------------------------------------------

describe('the payroll export', () => {
  const exportRow = (extra: Record<string, unknown> = {}) => ({
    id: randomUUID(),
    companyId: A.companyA,
    periodStart: '2026-12-01',
    periodEnd: '2026-12-31',
    layoutId: pay.layoutId,
    layoutSnapshot: { format: 'DELIMITED', definition: { columns: [{ key: 'employeeCode' }] } },
    checks: [{ code: 'MONTH_CLOSED', blocking: true, passed: true }],
    ...extra,
  })
  const exported = (number: string) => ({ status: 'EXPORTED', numberSeriesId: pay.exportSeriesId, number, exportedAt: now, exportedById: a.actorId })
  const dataFile = async (exportId: string, seq = 1) => {
    const file = fileRow('PayrollExport', exportId)
    await insert(office(), 'StoredFile', file)
    return insert(office(), 'PayrollExportFile', { id: randomUUID(), exportId, seq, kind: 'DATA', fileId: file.id, format: 'CSV', rowCount: 3 })
  }

  it('a layout is data: at least one column with a key, fixed widths for a fixed-width file; archived, never deleted', async () => {
    const layout = { id: randomUUID(), companyId: A.companyA, name: `Consultant ${tag()}`, format: 'FIXED_WIDTH', provider: 'Consultant software (test)' }
    await expect(insert(office(), 'PayrollExportLayout', { ...layout, definition: { columns: [] } })).rejects.toThrow(/at least one column/)
    await expect(insert(office(), 'PayrollExportLayout', { ...layout, definition: { columns: [{ key: 'employeeCode' }] } })).rejects.toThrow(/a whole width above 0/)
    await expect(insert(office(), 'PayrollExportLayout', { ...layout, definition: { columns: [{ key: 'employeeCode', width: 2.5 }] } })).rejects.toThrow(/a whole width above 0/)
    await expect(insert(office(), 'PayrollExportLayout', { ...layout, provider: ' ', definition: { columns: [{ key: 'employeeCode', width: 8 }] } })).rejects.toThrow(/no blank provider/)
    expect(await insert(office(), 'PayrollExportLayout', { ...layout, definition: { columns: [{ key: 'employeeCode', width: 8 }, { key: 'code', width: 4 }] } })).toBe(1)
    expect(await update('PayrollExportLayout', layout.id, { status: 'ARCHIVED' })).toBe(1)
    await expect(insert(office(), 'PayrollExport', exportRow({ layoutId: layout.id }))).rejects.toThrow(/uses an ACTIVE layout/)
    await expect(update('PayrollExportLayout', layout.id, { companyId: A.companyB })).rejects.toThrow(/company and creation .* never change/)
    await refusedToAll(`DELETE FROM "PayrollExportLayout" WHERE id = $1::uuid`, layout.id, /archived, never deleted/)
  })

  it('is exported with a data file, every blocking check passed and its pay period LOCKED; then never changes; one first export per month', async () => {
    await expect(insert(office(), 'PayrollExport', exportRow({ status: 'EXPORTED' }))).rejects.toThrow(/starts as a DRAFT/)
    await expect(insert(office(), 'PayrollExport', exportRow({ periodEnd: '2027-01-31' }))).rejects.toThrow(/one whole month/)
    await expect(insert(office(), 'PayrollExport', exportRow({ revision: 2 }))).rejects.toThrow(/revision 1 exactly when it corrects nothing/)
    await expect(insert(office(), 'PayrollExport', exportRow({ payPeriodId: pay.periodIds.november }))).rejects.toThrow(/the pay period of its own month/)
    const december = await admin(`SELECT id::text AS id FROM "PayPeriod" WHERE "tenantId" = $1 AND "periodStart" = '2026-12-01'`, [a.tenantId])
    const draft = exportRow({ payPeriodId: december[0]!.id, checks: [{ code: 'MONTH_CLOSED', blocking: true, passed: false }, { code: 'AGENCY_WORKERS_LEFT_OUT', blocking: false, passed: false }] })
    await insert(office(), 'PayrollExport', draft)
    await expect(update('PayrollExport', draft.id, exported('PAY-2026-0101'))).rejects.toThrow(/has no data file/)
    await dataFile(draft.id)
    await expect(update('PayrollExport', draft.id, exported('PAY-2026-0101'))).rejects.toThrow(/blocking check that did not pass/)
    await update('PayrollExport', draft.id, { checks: [{ code: 'MONTH_CLOSED', blocking: true, passed: true }, { code: 'AGENCY_WORKERS_LEFT_OUT', blocking: false, passed: false }] })
    await expect(update('PayrollExport', draft.id, { ...exported('PAY-2026-0101'), numberSeriesId: null })).rejects.toThrow(/wrong columns/)
    expect(await update('PayrollExport', draft.id, exported('PAY-2026-0101'))).toBe(1)
    await expect(update('PayrollExport', draft.id, { note: 'x' })).rejects.toThrow(/it never changes \(a correction export corrects/)
    await refusedToAll(`DELETE FROM "PayrollExport" WHERE id = $1::uuid`, draft.id, /never deleted/)
    // A second first export of December cannot be exported.
    const twin = exportRow()
    await insert(office(), 'PayrollExport', twin)
    await dataFile(twin.id)
    await expect(update('PayrollExport', twin.id, exported('PAY-2026-0102'))).rejects.toThrow(/PayrollExport_one_first_export_per_month|duplicate key/)
    expect(await update('PayrollExport', twin.id, { status: 'CANCELLED', cancelledAt: now, cancelReason: 'Made twice (test)' })).toBe(1)
    // November's pay period is OPEN: its export cannot go out yet.
    await update('PayrollExport', pay.draftExportId, { checks: [{ code: 'MONTH_CLOSED', blocking: true, passed: true }] })
    await expect(update('PayrollExport', pay.draftExportId, exported('PAY-2026-0103'))).rejects.toThrow(/pay period .* which is OPEN \(lock it first\)/)
    // A number from another kind of series is refused.
    const wrongSeries = await admin(`SELECT id::text AS id FROM "NumberSeries" WHERE "tenantId" = $1 AND "companyId" = $2 AND kind = 'ACCOUNTING_EXPORT'`, [a.tenantId, A.companyA])
    const other = exportRow({ periodStart: '2027-02-01', periodEnd: '2027-02-28' })
    await insert(office(), 'PayrollExport', other)
    await dataFile(other.id)
    await expect(update('PayrollExport', other.id, { ...exported('PAY-2026-0104'), numberSeriesId: wrongSeries[0]!.id })).rejects.toThrow(/PAYROLL_EXPORT series, not from a ACCOUNTING_EXPORT/)
  })

  it('a correction corrects an EXPORTED export of the same month as its revision + 1, and each export is corrected once', async () => {
    await expect(insert(office(), 'PayrollExport', exportRow({ periodStart: '2026-10-01', periodEnd: '2026-10-31', correctionOfId: pay.exportedId, revision: 3 }))).rejects.toThrow(/as its revision \+ 1/)
    await expect(insert(office(), 'PayrollExport', exportRow({ correctionOfId: pay.exportedId, revision: 2 }))).rejects.toThrow(/of the same company and month/)
    await expect(insert(office(), 'PayrollExport', exportRow({ periodStart: '2027-02-01', periodEnd: '2027-02-28', correctionOfId: pay.draftExportId, revision: 2 }))).rejects.toThrow(/which is EXPORTED/)
    const correction = exportRow({ periodStart: '2026-10-01', periodEnd: '2026-10-31', payPeriodId: pay.periodIds.october, correctionOfId: pay.exportedId, revision: 2, values: [{ employeeCode: 'SEED-A1-1', code: 'PIECE', amount: 100 }] })
    await insert(office(), 'PayrollExport', correction)
    await dataFile(correction.id)
    expect(await update('PayrollExport', correction.id, exported('PAY-2026-0110'))).toBe(1)
    const again = { ...correction, id: randomUUID() }
    await insert(office(), 'PayrollExport', again)
    await dataFile(again.id)
    await expect(update('PayrollExport', again.id, exported('PAY-2026-0111'))).rejects.toThrow(/PayrollExport_one_correction_each|duplicate key/)
  })

  it('files are added only while the export is a DRAFT, are stored files of it, and never change; the code mapping keeps its identity', async () => {
    await expect(dataFile(pay.exportedId, 9)).rejects.toThrow(/is EXPORTED; its files are added/)
    await expect(insert(office(), 'PayrollExportFile', { id: randomUUID(), exportId: pay.draftExportId, seq: 7, kind: 'SUMMARY', fileId: A.officeFile, format: 'PDF' })).rejects.toThrow(/a stored file of the export/)
    await expect(insert(office(), 'PayrollExportFile', { id: randomUUID(), exportId: pay.draftExportId, seq: 8, kind: 'SUMMARY', fileId: A.officeFile, format: 'DOCX' })).rejects.toThrow(/a format CSV, XLSX, TXT or PDF/)
    await refusedToAll(`UPDATE "PayrollExportFile" SET "rowCount" = 9 WHERE id = $1::uuid`, pay.draftFileId, /never changes/)
    await expect(run(office(), `DELETE FROM "PayrollExportFile" WHERE id = $1::uuid`, pay.exportedFileIds[0])).rejects.toThrow(/is EXPORTED/)
    expect(await run(office(), `DELETE FROM "PayrollExportFile" WHERE id = $1::uuid`, pay.draftFileId)).toBe(1)
    // The code mapping.
    const [mapping] = pay.mappingIds
    await expect(update('PayrollCodeMapping', mapping!, { ourCode: 'ORD2' })).rejects.toThrow(/our code and creation .* never change/)
    await expect(update('PayrollCodeMapping', mapping!, { providerCode: ' ' })).rejects.toThrow(/not blank when given/)
    expect(await update('PayrollCodeMapping', mapping!, { providerCode: 'ESEMPIO-002' })).toBe(1)
    await expect(insert(office(), 'PayrollCodeMapping', { id: randomUUID(), companyId: A.companyA, kind: 'HOUR', ourCode: 'ORD', meaning: 'Again' })).rejects.toThrow(/unique|duplicate/i)
    await refusedToAll(`DELETE FROM "PayrollCodeMapping" WHERE id = $1::uuid`, mapping!, /archived, never deleted/)
    // Every company has its PAYROLL_EXPORT series; the seeded export took its first number.
    const series = await admin(`SELECT "companyId"::text AS company, pattern, "nextValue" AS next FROM "NumberSeries" WHERE "tenantId" = $1 AND kind = 'PAYROLL_EXPORT' ORDER BY pattern, "companyId"`, [a.tenantId])
    expect(series.map((row) => row.company).sort()).toEqual([A.companyA, A.companyB].sort())
    expect(series.find((row) => row.company === A.companyA)).toEqual({ company: A.companyA, pattern: 'PAY-{YYYY}-{N:4}', next: 2 })
  })
})
