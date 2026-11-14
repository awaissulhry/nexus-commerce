import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedCostSheets, type CostSheetsSeed } from '../seed/cost-sheets'
import { seed as seedOptions, type OptionsSeed } from '../seed/options'
import { seed as seedProduct, type ProductSeed } from '../seed/product'
import { seed as seedSalesIntake, type SalesIntakeSeed } from '../seed/sales-intake'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'

/**
 * Cost sheets in depth (W2b-6, schema wave 55/57, B-W2b-378, …_cost_sheets_w2b_guards) on a database built from the
 * migrations and seeded twice, through the real login and its scopes:
 *   - cost sheets: born DRAFT for a style of the company, an open season, the company's currency, a base size of the range;
 *     DRAFT → APPROVED (with lines, never by its maker, on its approval task's yes by the person who decided it) → FROZEN;
 *     an approved sheet is never edited, a frozen one never changes; one approved per series; only a draft is deleted;
 *   - lines: only while the sheet is a draft; cost = quantity × unit cost; percent lines; sizes of the range; the source
 *     record of the revision or its table; the source fits the category; leather and labour; piece rates behind
 *     GATE-PIECE-PAY (the costing settings' switch, on only while a site of the company has piece pay ON);
 *   - leather bases (the grade mix totalling 100), overhead rules (whole months, never overlapping), cost-per-minute
 *     calculations (the result, applied once as a matching labour rate), uplifts (one target), size weights;
 *   - an option's cost delta, which the floor never reads; the other sessions read nothing here.
 * The refusals are check_violation (23514) in words, a unique key's 23505, or the grants' permission denied.
 */

const NS = 'w2b-378-a'

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let s: CostSheetsSeed
let product: ProductSeed
let intake: SalesIntakeSeed
let options: OptionsSeed

const key = (name: string): string => seedUuid(NS, name)
const A = {
  companyA: key('company:A'),
  companyB: key('company:B'),
  siteA: key('site:A1'),
  sewA: key('site:A1:work-centre:SEW'),
  cutA: key('site:A1:work-centre:CUT'),
  owner: key('actor'),
  member: key('user:member'),
  lining: key('product:item:lining'),
  bomLeather: key('product:bom:JKT-01:1:10'),
  routingSew: key('product:routing:JKT-01:1:SEED-SEW-ASM'),
  brand: key('party:P1'),
  workshop: key('party:P2'),
}
const office = (actorId: string = A.owner): FactoryScope => ({ audience: 'office', tenantId: a.tenantId, actorId })
const floor = (): FactoryScope => ({ audience: 'floor', tenantId: a.tenantId, actorId: randomUUID(), siteId: A.siteA })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const runAs = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$executeRawUnsafe(text, ...values))
const run = (text: string, ...values: unknown[]) => runAs(office(), text, ...values)
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

/** A DRAFT sheet of the seed jacket for company A (no season unless given), made by the member. */
async function sheet(extra: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID()
  const seasonId = (extra.seasonId as string | null | undefined) ?? null
  const series = `costsheet:${product.styleId}:${A.companyA}:${seasonId ?? 'none'}`
  const version = 100 + Math.floor(Math.random() * 1_000_000)
  expect(
    await runAs(
      office(A.member),
      ...insertSql('CostSheet', {
        id,
        companyId: A.companyA,
        styleId: product.styleId,
        revisionId: product.revisionId,
        seasonId,
        key: series,
        sheetVersion: version,
        currency: 'EUR',
        baseSize: '52',
        createdById: A.member,
        ...extra,
      }),
    ),
  ).toBe(1)
  return id
}
/** A typed packaging line of a sheet (quantity 1 × the unit cost). */
const line = (sheetId: string, extra: Record<string, unknown> = {}) =>
  insert('CostSheetLine', { id: randomUUID(), costSheetId: sheetId, seq: 10, category: 'PACKAGING', source: 'TYPED', quantity: '1.0000', unitCost: '1.250000', cost: '1.250000', ...extra })
const approve = (sheetId: string, by: string = A.owner) =>
  run(`UPDATE "CostSheet" SET state = 'APPROVED', "approvedAt" = now(), "approvedById" = $2::uuid WHERE id = $1::uuid`, sheetId, by)

beforeAll(async () => {
  db = await migratedDatabase('costsheetsw2b')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: NS })
  product = await seedProduct({ db: factory, namespace: NS })
  intake = await seedSalesIntake({ db: factory, namespace: NS })
  options = await seedOptions({ db: factory, namespace: NS })
  s = await seedCostSheets({ db: factory, namespace: NS })
  // Run twice: every seed is idempotent.
  await seedCostSheets({ db: factory, namespace: NS })
}, 300_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

describe('the seed', () => {
  it('runs twice and leaves one of each row: the versions of a season, nothing applied, piece rates off', async () => {
    const [counts] = await admin(
      `SELECT (SELECT count(*)::int FROM "CostSheet" WHERE "tenantId" = $1::uuid) AS sheets,
              (SELECT count(*)::int FROM "CostSheetLine" WHERE "tenantId" = $1::uuid) AS lines,
              (SELECT count(*)::int FROM "LeatherCostBasis" WHERE "tenantId" = $1::uuid) AS bases,
              (SELECT count(*)::int FROM "OverheadRule" WHERE "tenantId" = $1::uuid) AS rules,
              (SELECT count(*)::int FROM "CostPerMinuteCalc" WHERE "tenantId" = $1::uuid AND "appliedAt" IS NULL) AS calcs,
              (SELECT count(*)::int FROM "MaterialCostUplift" WHERE "tenantId" = $1::uuid) AS uplifts,
              (SELECT count(*)::int FROM "SizeWeight" WHERE "tenantId" = $1::uuid) AS weights,
              (SELECT count(*)::int FROM "CostingSettings" WHERE "tenantId" = $1::uuid AND "pieceRateLabour") AS "pieceRates"`,
      [a.tenantId],
    )
    expect(counts).toEqual({ sheets: 4, lines: 38, bases: 3, rules: 4, calcs: 2, uplifts: 4, weights: 6, pieceRates: 0 })
    const states = await admin(`SELECT id::text, state::text, "sheetVersion" FROM "CostSheet" WHERE "tenantId" = $1::uuid ORDER BY id`, [a.tenantId])
    expect(states[0]).toMatchObject({ id: s.sheetIds.draftB, state: 'DRAFT', sheetVersion: 1 })
    expect(states.map((row) => row.state).sort()).toEqual(['APPROVED', 'DRAFT', 'DRAFT', 'FROZEN'])
  })
})

describe('CostSheet', () => {
  it('is born a DRAFT for a style of its company, an open season, the company currency and a base size of the range', async () => {
    await expect(sheet({ state: 'APPROVED', approvedAt: new Date().toISOString(), approvedById: A.owner })).rejects.toThrow(/made as a DRAFT/)
    await expect(sheet({ seasonId: intake.seasonIds.fw26 })).rejects.toThrow(/season that is closed/)
    await expect(sheet({ currency: 'USD' })).rejects.toThrow(/its company's currency is EUR/)
    await expect(sheet({ baseSize: '60' })).rejects.toThrow(/not in the style's size range/)
    await expect(sheet({ key: `costsheet:${product.styleId}:${A.companyB}:none` })).rejects.toThrow(/series is costsheet/)
    await expect(sheet({ targetMarginPct: '100.0000' })).rejects.toThrow(/target margin below 100/)
    await expect(sheet({ sizeWeights: { '60': '1.0000' } })).rejects.toThrow(/size weights/)
    await expect(sheet({ basedOnId: s.sheetIds.draftB })).rejects.toThrow(/lower version of the same style/)
    expect(await sheet({ seasonId: intake.seasonIds.fw27, targetPrice: '500.000000', sizeWeights: { '50': '1.0000', '52': '2.0000' } })).toBeTruthy()
  })

  it('is approved with lines, never by its maker, then never edited, only frozen; one approved per series', async () => {
    const id = await sheet()
    await expect(approve(id)).rejects.toThrow(/nothing to approve/)
    expect(await line(id)).toBe(1)
    await expect(approve(id, A.member)).rejects.toThrow(/someone other than the person who made it/)
    expect(await approve(id)).toBe(1)
    await expect(run(`UPDATE "CostSheet" SET note = 'changed' WHERE id = $1::uuid`, id)).rejects.toThrow(/approved and locked/)
    await expect(run(`UPDATE "CostSheet" SET state = 'DRAFT', "approvedAt" = NULL, "approvedById" = NULL WHERE id = $1::uuid`, id)).rejects.toThrow(/approved and locked/)
    await expect(line(id, { seq: 20 })).rejects.toThrow(/only while it is a DRAFT/)
    await expect(run(`UPDATE "CostSheetLine" SET "unitCost" = 2, cost = 2 WHERE "costSheetId" = $1::uuid`, id)).rejects.toThrow(/only while it is a DRAFT/)
    await expect(run(`DELETE FROM "CostSheetLine" WHERE "costSheetId" = $1::uuid`, id)).rejects.toThrow(/removed only while it is a DRAFT/)
    await expect(run(`DELETE FROM "CostSheet" WHERE id = $1::uuid`, id)).rejects.toThrow(/only a draft is deleted/)
    // A second approved sheet of the same series: the partial unique key.
    const [row] = await admin(`SELECT key FROM "CostSheet" WHERE id = $1::uuid`, [id])
    const twin = await sheet({ key: row!.key })
    await line(twin)
    await expect(approve(twin)).rejects.toThrow(/CostSheet_one_approved|duplicate key/)
    // Frozen (after its approval), then the twin goes through; a frozen sheet changes no more.
    await expect(run(`UPDATE "CostSheet" SET state = 'FROZEN', "frozenAt" = now() WHERE id = $1::uuid`, id)).rejects.toThrow(/when and why it was frozen/)
    expect(await run(`UPDATE "CostSheet" SET state = 'FROZEN', "frozenAt" = now(), "frozenReason" = 'SUPERSEDED' WHERE id = $1::uuid`, id)).toBe(1)
    expect(await approve(twin)).toBe(1)
    await expect(run(`UPDATE "CostSheet" SET "frozenReason" = 'WITHDRAWN' WHERE id = $1::uuid`, id)).rejects.toThrow(/frozen: it changes no more/)
    // A draft never jumps to FROZEN; a draft nobody needs is deleted with its lines.
    const draft = await sheet()
    await line(draft)
    await expect(run(`UPDATE "CostSheet" SET state = 'FROZEN', "frozenAt" = now(), "frozenReason" = 'WITHDRAWN' WHERE id = $1::uuid`, draft)).rejects.toThrow(/DRAFT → APPROVED → FROZEN/)
    expect(await run(`DELETE FROM "CostSheet" WHERE id = $1::uuid`, draft)).toBe(1)
    expect(await admin(`SELECT 1 FROM "CostSheetLine" WHERE "costSheetId" = $1::uuid`, [draft])).toHaveLength(0)
    // The seeded approved version stays as it was.
    await expect(run(`UPDATE "CostSheet" SET "targetPrice" = 1 WHERE id = $1::uuid`, s.sheetIds.approvedA)).rejects.toThrow(/approved and locked/)
  })

  it('with an approval request, is approved on its COST_SHEET yes by the person who decided it', async () => {
    // A season of its own: the sheets above left one approved in the series without a season.
    const id = await sheet({ seasonId: intake.seasonIds.ss28 })
    await line(id)
    const task = randomUUID()
    const other = randomUUID()
    await asReplica(async () => {
      for (const [taskId, kind, status, decidedAt, decidedById] of [
        [task, 'COST_SHEET', 'APPROVED', new Date().toISOString(), A.owner],
        [other, 'PURCHASE_ORDER', 'PENDING', null, null],
      ] as const)
        await db.admin.query(
          `INSERT INTO "ApprovalTask" (id, "tenantId", kind, "recordType", "recordId", "companyId", summary, preview, fingerprint, "requestedById", "approverUserId", status, "decidedAt", "decidedById")
           VALUES ($1, $2, $3::"ApprovalTaskKind", 'CostSheet', $4, $5, 'Cost sheet', '{"changes": []}', repeat('a', 64), $6, $7, $8::"ApprovalTaskStatus", $9::timestamptz, $10::uuid)`,
          [taskId, a.tenantId, kind, id, A.companyA, A.member, A.owner, status, decidedAt, decidedById],
        )
    })
    await expect(run(`UPDATE "CostSheet" SET "approvalTaskId" = $2::uuid WHERE id = $1::uuid`, id, other)).rejects.toThrow(/not a COST_SHEET request of this sheet/)
    expect(await run(`UPDATE "CostSheet" SET "approvalTaskId" = $2::uuid WHERE id = $1::uuid`, id, task)).toBe(1)
    const third = randomUUID()
    await expect(approve(id, third)).rejects.toThrow(/by the person who decided it/)
    expect(await approve(id, A.owner)).toBe(1)
  })
})

describe('CostSheetLine', () => {
  it('costs quantity × unit cost, a percent only for overhead, freight, duty or a commission, a size of the range', async () => {
    const id = await sheet()
    await expect(line(id, { cost: '1.250001' })).rejects.toThrow(/quantity × unit cost rounded to 6 places/)
    await expect(line(id, { quantity: '-1.0000', cost: '-1.250000' })).rejects.toThrow(/0 or more/)
    await expect(line(id, { pct: '3.0000' })).rejects.toThrow(/percent line only for overhead/)
    await expect(line(id, { category: 'FREIGHT', pct: '3.0000', quantity: '2.0000', cost: '2.500000' })).rejects.toThrow(/quantity 1/)
    await expect(line(id, { size: '60' })).rejects.toThrow(/not in the style's size range/)
    expect(await line(id, { seq: 11, size: '54', quantity: '3.3333', unitCost: '0.333333', cost: '1.111099' })).toBe(1)
    expect(await line(id, { seq: 12, category: 'COMMISSION', pct: '5.0000' })).toBe(1)
    await expect(run(`UPDATE "CostSheetLine" SET "costSheetId" = $2::uuid WHERE "costSheetId" = $1::uuid AND seq = 11`, id, s.sheetIds.draftB)).rejects.toThrow(/never moves/)
  })

  it('names its source record of the revision or its table, fitting the category; leather and labour name what they cost', async () => {
    const id = await sheet()
    const bomLeather = { category: 'LEATHER', source: 'BOM_LINE', sourceRecordType: 'BomLine', sourceRecordId: A.bomLeather, itemId: product.leatherId, uom: 'FT2' }
    await expect(line(id, { source: 'TYPED', sourceRecordType: 'BomLine', sourceRecordId: A.bomLeather })).rejects.toThrow(/a typed line names no record/)
    await expect(line(id, { ...bomLeather, sourceRecordType: 'RoutingOperation', sourceRecordId: A.routingSew })).rejects.toThrow(/BOM_LINE a BomLine/)
    await expect(line(id, { ...bomLeather, sourceRecordId: options.bomLineIds.shell })).rejects.toThrow(/not of the sheet's revision/)
    await expect(line(id, { ...bomLeather, sourceRecordType: 'BomLine', sourceRecordId: randomUUID() })).rejects.toThrow(/not of the sheet's revision/)
    await expect(line(id, { ...bomLeather, sourceRecordType: null })).rejects.toThrow(/both or neither/)
    await expect(line(id, { ...bomLeather, itemId: A.lining })).rejects.toThrow(/a LEATHER line a leather article/)
    await expect(line(id, { ...bomLeather, category: 'LABOUR' })).rejects.toThrow(/does not come from BOM_LINE/)
    await expect(line(id, { category: 'MATERIAL', source: 'BOM_LINE', sourceRecordType: 'BomLine', sourceRecordId: A.bomLeather })).rejects.toThrow(/the material it costs/)
    await expect(line(id, { category: 'PACKAGING', source: 'PACKAGING', sourceRecordType: 'NoSuchTable', sourceRecordId: randomUUID() })).rejects.toThrow(/not a table/)
    await expect(line(id, { category: 'OVERHEAD', source: 'OVERHEAD_RULE', sourceRecordType: 'OverheadRule', sourceRecordId: randomUUID() })).rejects.toThrow(/does not exist/)
    const labour = { category: 'LABOUR', source: 'ROUTING', sourceRecordType: 'RoutingOperation', sourceRecordId: A.routingSew, quantity: '96.5000', unitCost: '0.500000', cost: '48.250000' }
    await expect(line(id, labour)).rejects.toThrow(/names its kind of work centre/)
    await expect(line(id, { ...labour, workCentreKind: 'SEWING', uom: 'PCS' })).rejects.toThrow(/counts minutes/)
    expect(await line(id, { ...labour, workCentreKind: 'SEWING' })).toBe(1)
    expect(await line(id, { ...bomLeather, seq: 20, size: '50', quantity: '57.0000', unitCost: '4.200000', cost: '239.400000' })).toBe(1)
    expect(await line(id, { seq: 30, category: 'OVERHEAD', source: 'OVERHEAD_RULE', sourceRecordType: 'OverheadRule', sourceRecordId: s.overheadIds.labourA, pct: '25.0000', unitCost: '12.062500', cost: '12.062500' })).toBe(1)
  })

  it('costs labour by piece rate only behind GATE-PIECE-PAY: the costing switch, on only while a site of the company pays by the piece', async () => {
    const id = await sheet()
    const pieceRate = { seq: 40, category: 'LABOUR', source: 'PIECE_RATE', workCentreKind: 'SEWING', quantity: '1.0000', unitCost: '9.500000', cost: '9.500000' }
    await expect(line(id, pieceRate)).rejects.toThrow(/GATE-PIECE-PAY/)
    // Company A's own costing settings: switching piece rates on is refused while no site of the company has piece pay ON.
    expect(await insert('CostingSettings', { id: A.companyA, companyId: A.companyA, overheadPct: '0' })).toBe(1)
    const switchOn = () => run(`UPDATE "CostingSettings" SET "pieceRateLabour" = true, "pieceRateLabourAt" = now(), "pieceRateLabourById" = $2::uuid WHERE id = $1::uuid`, A.companyA, A.owner)
    await expect(switchOn()).rejects.toThrow(/piece pay ON at one of its sites/)
    await expect(run(`UPDATE "CostingSettings" SET "pieceRateLabour" = true WHERE id = $1::uuid`, A.companyA)).rejects.toThrow(/exactly with when and by whom/)
    await expect(
      run(`UPDATE "CostingSettings" SET "pieceRateLabour" = true, "pieceRateLabourAt" = now(), "pieceRateLabourById" = $2::uuid WHERE id = $1::uuid`, a.tenantId, A.owner),
    ).rejects.toThrow(/piece pay ON at one of its sites/)
    await asReplica(() =>
      db.admin.query(
        `INSERT INTO "PiecePaySwitch" (id, "tenantId", "companyId", "siteId", state, "onFrom", "switchedOnAt", "switchedOnById") VALUES ($1, $2, $3, $1, 'ON', current_date, now(), $4)`,
        [A.siteA, a.tenantId, A.companyA, A.owner],
      ),
    )
    expect(await switchOn()).toBe(1)
    await expect(run(`UPDATE "CostingSettings" SET "pieceRateLabourAt" = now() - interval '1 day' WHERE id = $1::uuid`, A.companyA)).rejects.toThrow(/never change/)
    expect(await line(id, pieceRate)).toBe(1)
    // Off is always allowed; then the gate is closed again.
    expect(await run(`UPDATE "CostingSettings" SET "pieceRateLabour" = false, "pieceRateLabourAt" = NULL, "pieceRateLabourById" = NULL WHERE id = $1::uuid`, A.companyA)).toBe(1)
    await expect(line(id, { ...pieceRate, seq: 41 })).rejects.toThrow(/GATE-PIECE-PAY/)
  })
})

describe('the inputs', () => {
  it('LeatherCostBasis: a leather article in FT2 or DM2, a yield up to 100 %, a grade mix of active grades totalling 100; never deleted', async () => {
    const basis = (extra: Record<string, unknown> = {}) => {
      const companyId = 'companyId' in extra ? (extra.companyId as string | null) : A.companyA
      const styleId = (extra.styleId as string | undefined) ?? null
      const itemId = (extra.itemId as string | undefined) ?? product.leatherId
      return insert('LeatherCostBasis', {
        id: randomUUID(),
        companyId,
        itemId,
        styleId,
        key: `leather:${itemId}:${styleId ?? 'all'}:${companyId ?? 'all'}`,
        areaUnit: 'DM2',
        expectedYieldPct: '84.0000',
        gradeMix: { A: '55.5000', B: '44.5000' },
        validFrom: '2026-12-01',
        ...extra,
      })
    }
    await expect(basis({ gradeMix: { A: '60.0000', B: '30.0000' } })).rejects.toThrow(/total exactly 100/)
    await expect(basis({ gradeMix: { A: '60.0000', Z: '40.0000' } })).rejects.toThrow(/an active grade of the tenant/)
    await expect(basis({ gradeMix: { A: 100 } })).rejects.toThrow(/an active grade of the tenant/)
    await expect(basis({ itemId: A.lining })).rejects.toThrow(/a leather article/)
    await expect(basis({ areaUnit: 'M2' })).rejects.toThrow(/FT2 or DM2/)
    await expect(basis({ expectedYieldPct: '100.5000' })).rejects.toThrow(/at most 100/)
    expect(await basis()).toBe(1)
    await expect(run(`UPDATE "LeatherCostBasis" SET "validFrom" = '2027-01-01' WHERE id = $1::uuid`, s.basisIds[0])).rejects.toThrow(/never change/)
    expect(await run(`UPDATE "LeatherCostBasis" SET status = 'ARCHIVED' WHERE id = $1::uuid`, s.basisIds[1])).toBe(1)
    // The office has no delete grant; the owner login meets the trigger.
    await expect(run(`DELETE FROM "LeatherCostBasis" WHERE id = $1::uuid`, s.basisIds[2])).rejects.toThrow(/permission denied/)
    await expect(admin(`DELETE FROM "LeatherCostBasis" WHERE id = $1::uuid`, [s.basisIds[2]])).rejects.toThrow(/archived, never deleted/)
  })

  it('OverheadRule: a percent or an amount with its currency, whole months, never overlapping in its key; never deleted', async () => {
    const rule = (extra: Record<string, unknown> = {}) =>
      insert('OverheadRule', { id: randomUUID(), companyId: A.companyA, key: `overhead:${A.companyA}:PER_UNIT:all`, basis: 'PER_UNIT', value: '1.500000', currency: 'EUR', periodStart: '2027-01-01', ...extra })
    await expect(rule({ currency: null })).rejects.toThrow(/with its ISO 4217 currency/)
    await expect(rule({ basis: 'PERCENT_OF_LABOUR', key: `overhead:${A.companyA}:PERCENT_OF_LABOUR:all`, periodStart: '2027-03-01' })).rejects.toThrow(/no currency/)
    await expect(rule({ periodStart: '2027-01-15' })).rejects.toThrow(/whole months/)
    await expect(rule({ periodEnd: '2027-02-27' })).rejects.toThrow(/whole months/)
    await expect(rule({ key: `overhead:all:PER_UNIT:all` })).rejects.toThrow(/key is overhead/)
    expect(await rule({ periodEnd: '2027-06-30' })).toBe(1)
    await expect(rule({ periodStart: '2027-06-01' })).rejects.toThrow(/overlaps another active rule/)
    expect(await rule({ periodStart: '2027-06-01', status: 'ARCHIVED' })).toBe(1)
    expect(await rule({ periodStart: '2027-07-01' })).toBe(1)
    // The company's percent of labour is open-ended from January: a new one must start after it ends.
    await expect(run(`UPDATE "OverheadRule" SET "periodStart" = '2026-02-01' WHERE id = $1::uuid`, s.overheadIds.labourA)).rejects.toThrow(/never change/)
    // The office has no delete grant; the owner login meets the trigger.
    await expect(run(`DELETE FROM "OverheadRule" WHERE id = $1::uuid`, s.overheadIds.unitH1)).rejects.toThrow(/permission denied/)
    await expect(admin(`DELETE FROM "OverheadRule" WHERE id = $1::uuid`, [s.overheadIds.unitH1])).rejects.toThrow(/archived, never deleted/)
  })

  it('CostPerMinuteCalc: the result is direct ÷ minutes + indirect + overhead; applied once as a matching labour rate, then frozen', async () => {
    const calc = (extra: Record<string, unknown> = {}) => {
      const id = randomUUID()
      return {
        id,
        write: () =>
          insert('CostPerMinuteCalc', {
            id,
            companyId: A.companyA,
            workCentreKind: 'SEWING',
            key: `cpm:${A.companyA}:SEWING:all`,
            periodStart: '2026-09-01',
            periodEnd: '2026-09-30',
            currency: 'EUR',
            directLabourCost: '40000.000000',
            availableMinutes: '96000.0000',
            indirectPerMinute: '0.050000',
            overheadPerMinute: '0.030000',
            costPerMinute: '0.496667',
            ...extra,
          }),
      }
    }
    await expect(calc({ costPerMinute: '0.496666' }).write()).rejects.toThrow(/rounded to 6 places/)
    await expect(calc({ availableMinutes: '0.0000' }).write()).rejects.toThrow(/minutes above 0/)
    await expect(calc({ siteId: A.siteA, workCentreId: A.cutA, key: `cpm:${A.companyA}:SEWING:${A.cutA}` }).write()).rejects.toThrow(/of its kind/)
    await expect(calc({ periodEnd: '2026-10-15' }).write()).rejects.toThrow(/whole months/)
    const good = calc({ siteId: A.siteA, workCentreId: A.sewA, key: `cpm:${A.companyA}:SEWING:${A.sewA}` })
    expect(await good.write()).toBe(1)
    // A rate of another kind or figure is no application of it.
    const rate = randomUUID()
    const wrong = randomUUID()
    expect(await insert('LabourRate', { id: rate, companyId: A.companyA, workCentreKind: 'SEWING', costPerMinute: '0.496667', currency: 'EUR', validFrom: '2026-12-01' })).toBe(1)
    expect(await insert('LabourRate', { id: wrong, companyId: A.companyA, workCentreKind: 'CUTTING', costPerMinute: '0.496667', currency: 'EUR', validFrom: '2026-12-01' })).toBe(1)
    const apply = (rateId: string) => run(`UPDATE "CostPerMinuteCalc" SET "labourRateId" = $2::uuid, "appliedAt" = now(), "appliedById" = $3::uuid WHERE id = $1::uuid`, good.id, rateId, A.owner)
    await expect(run(`UPDATE "CostPerMinuteCalc" SET "labourRateId" = $2::uuid WHERE id = $1::uuid`, good.id, rate)).rejects.toThrow(/all three or none/)
    await expect(apply(wrong)).rejects.toThrow(/labour rate of its company and department/)
    expect(await apply(rate)).toBe(1)
    await expect(run(`UPDATE "CostPerMinuteCalc" SET note = 'later' WHERE id = $1::uuid`, good.id)).rejects.toThrow(/changes no more/)
    await expect(run(`DELETE FROM "CostPerMinuteCalc" WHERE id = $1::uuid`, good.id)).rejects.toThrow(/applied as a labour rate and is kept/)
    // One applied per key and period.
    const twin = calc({ siteId: A.siteA, workCentreId: A.sewA, key: `cpm:${A.companyA}:SEWING:${A.sewA}` })
    expect(await twin.write()).toBe(1)
    await expect(run(`UPDATE "CostPerMinuteCalc" SET "labourRateId" = $2::uuid, "appliedAt" = now(), "appliedById" = $3::uuid WHERE id = $1::uuid`, twin.id, rate, A.owner)).rejects.toThrow(
      /CostPerMinuteCalc_one_applied|duplicate key/,
    )
    expect(await run(`DELETE FROM "CostPerMinuteCalc" WHERE id = $1::uuid`, twin.id)).toBe(1)
  })

  it('MaterialCostUplift: exactly one target; percents for a material, a transport per piece for a workshop; never deleted', async () => {
    const uplift = (extra: Record<string, unknown> = {}) =>
      insert('MaterialCostUplift', { id: randomUUID(), companyId: A.companyA, target: 'CATEGORY', itemKind: 'LINING', key: `uplift:${A.companyA}:kind:LINING`, freightPct: '4.0000', validFrom: '2027-01-01', ...extra })
    await expect(uplift({ itemId: A.lining })).rejects.toThrow(/exactly its target/)
    await expect(uplift({ freightPct: null })).rejects.toThrow(/at least one/)
    await expect(uplift({ freightPct: '120.0000' })).rejects.toThrow(/0 to 100/)
    await expect(uplift({ source: 'LANDED_COST' })).rejects.toThrow(/receipt days/)
    await expect(uplift({ source: 'LANDED_COST', landedFrom: '2026-10-01', landedTo: '2027-02-01' })).rejects.toThrow(/receipt days/)
    expect(await uplift({ source: 'LANDED_COST', landedFrom: '2026-10-01', landedTo: '2026-12-31' })).toBe(1)
    const workshop = (partyId: string, extra: Record<string, unknown> = {}) =>
      uplift({ target: 'WORKSHOP', itemKind: null, partyId, key: `uplift:${A.companyA}:workshop:${partyId}`, freightPct: null, transportOutPerPiece: '1.100000', currency: 'EUR', ...extra })
    await expect(workshop(A.brand)).rejects.toThrow(/SUBCONTRACTOR role/)
    await expect(workshop(A.workshop, { freightPct: '2.0000' })).rejects.toThrow(/no percent/)
    await expect(workshop(A.workshop, { currency: null })).rejects.toThrow(/ISO 4217/)
    expect(await workshop(A.workshop)).toBe(1)
    // The office has no delete grant; the owner login meets the trigger.
    await expect(run(`DELETE FROM "MaterialCostUplift" WHERE id = $1::uuid`, s.upliftIds.trims)).rejects.toThrow(/permission denied/)
    await expect(admin(`DELETE FROM "MaterialCostUplift" WHERE id = $1::uuid`, [s.upliftIds.trims])).rejects.toThrow(/archived, never deleted/)
  })

  it('SizeWeight: a size of the range, a weight above 0; only the weight changes; removed freely', async () => {
    const weight = (size: string, extra: Record<string, unknown> = {}) => {
      const id = randomUUID()
      return { id, write: () => insert('SizeWeight', { id, styleId: product.styleId, seasonId: null, key: `sizeweight:${product.styleId}:all:${size}`, size, weight: '2.0000', ...extra }) }
    }
    await expect(weight('60').write()).rejects.toThrow(/not in the style's size range/)
    await expect(weight('50', { weight: '0.0000' }).write()).rejects.toThrow(/above 0/)
    await expect(weight('50', { key: `sizeweight:${product.styleId}:all:52` }).write()).rejects.toThrow(/key is sizeweight/)
    const ok = weight('50')
    expect(await ok.write()).toBe(1)
    await expect(weight('50').write()).rejects.toThrow(/duplicate key|SizeWeight_tenantId_key_key/)
    expect(await run(`UPDATE "SizeWeight" SET weight = 3 WHERE id = $1::uuid`, ok.id)).toBe(1)
    await expect(run(`UPDATE "SizeWeight" SET size = '52' WHERE id = $1::uuid`, ok.id)).rejects.toThrow(/only the weight/)
    expect(await run(`DELETE FROM "SizeWeight" WHERE id = $1::uuid`, ok.id)).toBe(1)
  })
})

describe('an option value’s cost delta and who reads it', () => {
  it('a material cost with its currency and minutes, never 0', async () => {
    const value = options.valueIds.perfFront
    const set = (assignments: string) => run(`UPDATE "OptionValue" SET ${assignments} WHERE id = $1::uuid`, value)
    await expect(set(`"materialDelta" = 2.5`)).rejects.toThrow(/both or neither/)
    await expect(set(`"materialDelta" = 0, "materialDeltaCurrency" = 'EUR'`)).rejects.toThrow(/never 0/)
    await expect(set(`"materialDelta" = 2.5, "materialDeltaCurrency" = 'eur'`)).rejects.toThrow(/ISO 4217/)
    await expect(set(`"minutesDelta" = 0`)).rejects.toThrow(/never 0/)
    await expect(set(`"minutesDelta" = 10001`)).rejects.toThrow(/at most 10000/)
    expect(await set(`"materialDelta" = -1.25, "materialDeltaCurrency" = 'EUR', "minutesDelta" = 4.5`)).toBe(1)
  })

  it('the floor reads an option value but never its cost; the floor and portal read no cost sheet table', async () => {
    const rows = await as(floor(), (client) => client.optionValue.findMany({ where: { id: options.valueIds.linerYes }, select: { id: true, minutesDelta: true } }))
    expect(rows.map((row) => String(row.minutesDelta))).toEqual(['6'])
    await expect(as(floor(), (client) => client.$queryRawUnsafe(`SELECT "materialDelta" FROM "OptionValue" LIMIT 1`))).rejects.toThrow(/permission denied/)
    for (const table of ['CostSheet', 'CostSheetLine', 'LeatherCostBasis', 'OverheadRule', 'CostPerMinuteCalc', 'MaterialCostUplift', 'SizeWeight'])
      await expect(as(floor(), (client) => client.$queryRawUnsafe(`SELECT 1 FROM "${table}" LIMIT 1`)), table).rejects.toThrow(/permission denied/)
  })

  it('TRUNCATE is refused on every table of the wave, for every login', async () => {
    for (const table of ['CostSheet', 'CostSheetLine', 'LeatherCostBasis', 'OverheadRule', 'CostPerMinuteCalc', 'MaterialCostUplift', 'SizeWeight']) {
      await db.admin.query('BEGIN')
      try {
        await expect(db.admin.query(`TRUNCATE "${table}" CASCADE`), table).rejects.toThrow(/TRUNCATE on/)
      } finally {
        await db.admin.query('ROLLBACK')
      }
    }
  })
})

// The refusals above are all check_violation (or a unique key's 23505): one spot check of the SQLSTATE.
it('refuses with SQLSTATE 23514 (check_violation)', async () => {
  const error = await db.admin.query(`UPDATE "SizeWeight" SET weight = 0 WHERE id = $1::uuid`, [s.weightIds[0]]).catch((caught: unknown) => caught)
  expect((error as { code?: string }).code).toBe('23514')
})
