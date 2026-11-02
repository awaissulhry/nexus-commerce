import { randomUUID } from 'node:crypto'
import { isCustomer, isSupplier, PARTY_ROLES } from '@nexus/factory-domain/parties/rules'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedPay, type PaySeed } from '../seed/pay'
import { seed as seedFollowups, type FollowupsPeopleSeed } from '../seed/w2b-followups-people'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { PartyRole } from './generated/prisma/enums'
import { partnerWalledColumns } from './ownership'
import { RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'
import { loadSchema } from './tools'

/**
 * The W2b-1 follow-ups for people and pay (B-W2b-75, W2b schema wave 9/16, …_followups_people_pay_w2b1_guards) on a database
 * built from the migrations and seeded, through the real login and the scoped client:
 *   - every figure of pay.prisma carries the pay grain, behind the partner wall, and no column carries wages any more;
 *   - EarningsKind BONUS: its shape, inside the legal switch's window like every piece-pay figure, reversed by a mirror;
 *   - PeopleSettings: the printer of statements, the standard review limits and the labour consultant, none of them
 *     read by the floor;
 *   - PayrollExport.correctionsCarried frozen with the export, the layout's confirmation, Company.payrollCode.
 * The refusals are check_violation (SQLSTATE 23514); their messages are read through raw SQL.
 */

const NS = 'w2b-75-a'
const DENIED = /permission denied/

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let pay: PaySeed
let followups: FollowupsPeopleSeed

const key = (name: string): string => seedUuid(NS, name)
const A = {
  companyA: key('company:A'),
  companyB: key('company:B'),
  siteA: key('site:A1'),
  siteB: key('site:B1'),
  customer: key('party:P1'),
  labelPrinter: key('print:printer:A1:LBL'),
  a4Printer: key('print:printer:A1:A4'),
}

const office = (): FactoryScope => ({ audience: 'office', tenantId: a.tenantId, actorId: a.actorId })
const floor = (): FactoryScope => ({ audience: 'floor', tenantId: a.tenantId, actorId: randomUUID(), siteId: A.siteA })
const partner = (): FactoryScope => ({ audience: 'partner', tenantId: a.tenantId, actorId: randomUUID(), partyId: A.customer })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const sql = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$queryRawUnsafe<Record<string, unknown>[]>(text, ...values))
const run = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$executeRawUnsafe(text, ...values))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, unknown>[]
const insert = (table: string, row: Record<string, unknown>) => {
  const columns = Object.keys(row)
    .map((column) => `"${column}"`)
    .join(', ')
  return run(office(), `INSERT INTO "${table}" (${columns}) SELECT ${columns} FROM jsonb_populate_record(NULL::"${table}", $1::jsonb)`, JSON.stringify(row))
}
const update = (table: string, id: string, set: Record<string, unknown>) => {
  const assignments = Object.keys(set)
    .map((column) => `"${column}" = r."${column}"`)
    .join(', ')
  return run(office(), `UPDATE "${table}" t SET ${assignments} FROM jsonb_populate_record(NULL::"${table}", $1::jsonb) r WHERE t.id = $2::uuid`, JSON.stringify(set), id)
}
const tag = (): string => randomUUID().slice(0, 8)
const settings = (set: Record<string, unknown>) => update('PeopleSettings', A.companyA, set)

beforeAll(async () => {
  db = await migratedDatabase('followupspeoplepay')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  const context = { db: factory, namespace: NS }
  a = await seedCore(context)
  // Piece pay ON: A1's PERFORMANCE gate, its switch ON from 2026-11-13, November OPEN (the seed's default leaves it OFF).
  pay = await seedPay(context, { piecePay: true })
  followups = await seedFollowups(context)
}, 180_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

describe('the pay grain', () => {
  it('no column of the schema carries wages any more; the grain stays declared and behind the wall for a column that would', () => {
    const models = loadSchema()
    expect(models.flatMap((model) => model.fields.filter((field) => field.tags.includes('@grain wages')).map((field) => `${model.name}.${field.name}`))).toEqual([])
    const paid = models.flatMap((model) => model.fields.filter((field) => field.tags.includes('@grain pay')).map((field) => `${model.name}.${field.column}`))
    expect(paid).toHaveLength(10)
    const walled = models.flatMap((model) => partnerWalledColumns(model).map(({ column }) => `${model.name}.${column}`))
    expect(walled).toEqual(expect.arrayContaining(paid))
  })
})

describe('EarningsKind BONUS (B-W2b-38, -43: the ledger had no kind for a standard-minute bonus)', () => {
  const bonus = (extra: Record<string, unknown> = {}) => ({
    id: randomUUID(),
    companyId: A.companyA,
    siteId: A.siteA,
    payPeriodId: pay.periodIds.november,
    employeeId: pay.employeeIds.operator,
    workerId: pay.production.operatorId,
    workDate: '2026-11-20',
    kind: 'BONUS',
    minutes: '120.000',
    amount: 1800,
    idempotencyKey: `bonus:${tag()}`,
    ...extra,
  })

  it('books the standard minutes above the threshold and an amount, with a rate only if one applies', async () => {
    expect(await insert('EarningsEntry', bonus())).toBe(1)
    expect(await insert('EarningsEntry', bonus({ rate: '0.150000' }))).toBe(1)
    expect(await insert('EarningsEntry', bonus({ amount: 0 }))).toBe(1)
  })

  it('names no scan, rate entry, hold, pieces or share, and pays no negative figure', async () => {
    const refused = /bonus .* names no scan, rate entry or hold/
    await expect(insert('EarningsEntry', bonus({ operationScanId: pay.production.scanIds[2] }))).rejects.toThrow(refused)
    await expect(insert('EarningsEntry', bonus({ rateEntryId: pay.rateEntryIds.sew }))).rejects.toThrow(refused)
    await expect(insert('EarningsEntry', bonus({ pieces: 1 }))).rejects.toThrow(refused)
    await expect(insert('EarningsEntry', bonus({ sharePct: '50' }))).rejects.toThrow(refused)
    await expect(insert('EarningsEntry', bonus({ minutes: null }))).rejects.toThrow(refused)
    await expect(insert('EarningsEntry', bonus({ minutes: '0' }))).rejects.toThrow(refused)
    await expect(insert('EarningsEntry', bonus({ amount: -1 }))).rejects.toThrow(refused)
    await expect(insert('EarningsEntry', bonus({ rate: '-0.100000' }))).rejects.toThrow(refused)
  })

  it('is a piece-pay figure: refused outside the site’s switch window, where an adjustment still passes', async () => {
    await expect(insert('EarningsEntry', bonus({ workDate: '2026-11-02' }))).rejects.toThrow(/piece pay is not ON at site/)
    expect(await insert('EarningsEntry', bonus({ workDate: '2026-11-02', kind: 'ADJUSTMENT', minutes: null, amount: 100, reason: 'Made-up correction' }))).toBe(1)
  })

  it('a correction is a mirror, and the ledger stays append-only for it', async () => {
    const original = bonus()
    await insert('EarningsEntry', original)
    const mirror = { ...original, id: randomUUID(), idempotencyKey: `bonus:${tag()}`, reversalOfId: original.id, minutes: '-120.000', amount: -1800 }
    await expect(insert('EarningsEntry', { ...mirror, reason: 'Made-up correction', amount: -1 })).rejects.toThrow(/mirrors entry/)
    await expect(insert('EarningsEntry', mirror)).rejects.toThrow(/says why/)
    expect(await insert('EarningsEntry', { ...mirror, reason: 'Made-up correction' })).toBe(1)
    await expect(admin(`UPDATE "EarningsEntry" SET amount = 1 WHERE id = $1`, [original.id])).rejects.toThrow(/append-only: UPDATE on "EarningsEntry" is refused/)
  })
})

describe('PeopleSettings: the statement printer (B-W2b-68)', () => {
  const printer = (extra: Record<string, unknown> = {}) => ({ id: randomUUID(), companyId: A.companyA, siteId: A.siteA, code: `P-${tag()}`, name: 'Made-up printer', kind: 'A4_PDF', relay: 'FAKE', relayTarget: 'made-up', ...extra })

  it('the seed names A1’s A4 printer for company A; company B names none', async () => {
    expect(await admin(`SELECT id, "statementPrinterId" FROM "PeopleSettings" WHERE "tenantId" = $1 ORDER BY id = $2 DESC`, [a.tenantId, A.companyA])).toEqual([
      { id: A.companyA, statementPrinterId: followups.statementPrinterId },
      { id: A.companyB, statementPrinterId: null },
    ])
    expect(followups.statementPrinterId).toBe(A.a4Printer)
  })

  it('refuses a label printer and a printer that is not ACTIVE', async () => {
    await expect(settings({ statementPrinterId: A.labelPrinter })).rejects.toThrow(/print statements on an ACTIVE A4 printer, not on a ACTIVE LABEL_ZPL one/)
    const paused = printer({ status: 'PAUSED' })
    await insert('Printer', paused)
    await expect(settings({ statementPrinterId: paused.id })).rejects.toThrow(/ACTIVE A4 printer, not on a PAUSED A4_PDF one/)
  })

  it('refuses another company’s printer by the key', async () => {
    const other = printer({ companyId: A.companyB, siteId: A.siteB })
    await insert('Printer', other)
    await expect(settings({ statementPrinterId: other.id })).rejects.toThrow(/foreign key/)
  })

  it('a printer archived later does not stop an edit of the other settings; the settings can name none', async () => {
    const named = printer()
    await insert('Printer', named)
    expect(await settings({ statementPrinterId: named.id })).toBe(1)
    expect(await update('Printer', named.id, { status: 'ARCHIVED' })).toBe(1)
    expect(await settings({ lateGraceMinutes: 7 })).toBe(1)
    await expect(settings({ statementPrinterId: A.labelPrinter })).rejects.toThrow(/ACTIVE A4 printer/)
    expect(await settings({ statementPrinterId: A.a4Printer })).toBe(1)
  })
})

describe('PeopleSettings: the standard review limits (B-W2b-44)', () => {
  it('default to the constants the review queue reads today', async () => {
    expect(await admin(`SELECT "standardReviewPercent", "standardReviewMinBundles" FROM "PeopleSettings" WHERE id = $1`, [A.companyB])).toEqual([{ standardReviewPercent: 10, standardReviewMinBundles: 5 }])
  })

  it('take 1 to 100 percent over 1 to 1000 bundles', async () => {
    for (const set of [{ standardReviewPercent: 0 }, { standardReviewPercent: 101 }, { standardReviewMinBundles: 0 }, { standardReviewMinBundles: 1001 }]) {
      await expect(settings(set)).rejects.toThrow(/the standard review of the people settings/)
    }
    expect(await settings({ standardReviewPercent: 1, standardReviewMinBundles: 1 })).toBe(1)
    expect(await settings({ standardReviewPercent: 100, standardReviewMinBundles: 1000 })).toBe(1)
    expect(await settings({ standardReviewPercent: 10, standardReviewMinBundles: 5 })).toBe(1)
  })

  it('the settings’ earlier rules still hold', async () => {
    await expect(settings({ roundingMinutes: 7 })).rejects.toThrow(/round clock events/)
    await expect(settings({ minimumGroupSize: 2 })).rejects.toThrow(/minimum group size/)
  })
})

describe('PartyRole CONSULTANT and the labour consultant (B-W2b-54)', () => {
  const party = (extra: Record<string, unknown> = {}) => ({ id: randomUUID(), code: `C-${tag()}`, kind: 'ORGANISATION', legalName: 'Made-up consultant', roles: ['CONSULTANT'], ...extra })
  const refused = /the labour consultant of the people settings .* is an ACTIVE party with the CONSULTANT role/

  it('the domain knows every role of the schema, and a consultant is neither a customer nor a supplier', () => {
    expect([...PARTY_ROLES].sort()).toEqual(Object.values(PartyRole).sort())
    expect(isCustomer(['CONSULTANT'])).toBe(false)
    expect(isSupplier(['CONSULTANT'])).toBe(false)
  })

  it('the seed names a made-up consultant for company A; the partner role reads no people settings', async () => {
    expect(await admin(`SELECT "payrollConsultantPartyId" FROM "PeopleSettings" WHERE id = $1`, [A.companyA])).toEqual([{ payrollConsultantPartyId: followups.consultantId }])
    expect(await admin(`SELECT roles::text[], "companyId" FROM "Party" WHERE id = $1`, [followups.consultantId])).toEqual([{ roles: ['CONSULTANT'], companyId: A.companyA }])
    await expect(sql(partner(), `SELECT "payrollConsultantPartyId" FROM "PeopleSettings"`)).rejects.toThrow(DENIED)
  })

  it('takes a consultant of the company or tenant-wide', async () => {
    const tenantWide = party()
    await insert('Party', tenantWide)
    expect(await settings({ payrollConsultantPartyId: tenantWide.id })).toBe(1)
    expect(await settings({ payrollConsultantPartyId: followups.consultantId })).toBe(1)
  })

  it('refuses a party without the role, another company’s, and one that is not ACTIVE', async () => {
    await expect(settings({ payrollConsultantPartyId: A.customer })).rejects.toThrow(refused)
    const other = party({ companyId: A.companyB })
    await insert('Party', other)
    await expect(settings({ payrollConsultantPartyId: other.id })).rejects.toThrow(refused)
    const blocked = party({ status: 'BLOCKED' })
    await insert('Party', blocked)
    await expect(settings({ payrollConsultantPartyId: blocked.id })).rejects.toThrow(refused)
  })

  it('a consultant blocked later does not stop an edit of the other settings', async () => {
    const later = party()
    await insert('Party', later)
    expect(await settings({ payrollConsultantPartyId: later.id })).toBe(1)
    expect(await update('Party', later.id, { status: 'BLOCKED' })).toBe(1)
    expect(await settings({ lateGraceMinutes: 8 })).toBe(1)
    expect(await settings({ payrollConsultantPartyId: followups.consultantId })).toBe(1)
  })
})

describe('the floor reads none of the new columns', () => {
  it('PeopleSettings: the clock’s settings still read, the printer, the review and the consultant refused', async () => {
    expect(await sql(floor(), `SELECT "fixedBreaks", "minimumGroupSize" FROM "PeopleSettings" WHERE id = $1::uuid`, A.companyA)).toHaveLength(1)
    for (const column of ['statementPrinterId', 'standardReviewPercent', 'standardReviewMinBundles', 'payrollConsultantPartyId']) {
      await expect(sql(floor(), `SELECT "${column}" FROM "PeopleSettings"`)).rejects.toThrow(DENIED)
    }
  })

  it('Company: the name reads, the payroll code does not', async () => {
    expect(await sql(floor(), `SELECT "legalName" FROM "Company" WHERE id = $1::uuid`, A.companyA)).toHaveLength(1)
    await expect(sql(floor(), `SELECT "payrollCode" FROM "Company"`)).rejects.toThrow(DENIED)
  })
})

describe('PayrollExport.correctionsCarried (B-W2b-54: the CARRIED row of checks)', () => {
  const ids = [randomUUID(), randomUUID()]

  it('starts empty, on the rows made before it too', async () => {
    expect(await admin(`SELECT "correctionsCarried" FROM "PayrollExport" WHERE id = $1`, [pay.exportedId])).toEqual([{ correctionsCarried: [] }])
  })

  it('a DRAFT takes the list; an EXPORTED export never changes it', async () => {
    expect(await run(office(), `UPDATE "PayrollExport" SET "correctionsCarried" = $1::uuid[] WHERE id = $2::uuid`, ids, pay.draftExportId)).toBe(1)
    expect(await admin(`SELECT "correctionsCarried" FROM "PayrollExport" WHERE id = $1`, [pay.draftExportId])).toEqual([{ correctionsCarried: ids }])
    await expect(run(office(), `UPDATE "PayrollExport" SET "correctionsCarried" = $1::uuid[] WHERE id = $2::uuid`, ids, pay.exportedId)).rejects.toThrow(/it never changes \(a correction export corrects an exported one\)/)
    await expect(admin(`UPDATE "PayrollExport" SET "correctionsCarried" = $1::uuid[] WHERE id = $2`, [ids, pay.exportedId])).rejects.toThrow(/it never changes/)
  })
})

describe('PayrollExportLayout: the confirmation (B-W2b-54: definition.confirmation)', () => {
  const layout = (set: Record<string, unknown>) => update('PayrollExportLayout', pay.layoutId, set)
  const none = { confirmedOn: null, confirmedById: null, confirmedByName: null }
  const refused = /the confirmation of payroll layout .* has its day exactly with who confirmed it/

  it('a layout starts unconfirmed', async () => {
    expect(await admin(`SELECT "confirmedOn", "confirmedById", "confirmedByName" FROM "PayrollExportLayout" WHERE id = $1`, [pay.layoutId])).toEqual([none])
  })

  it('has its day exactly with who confirmed it', async () => {
    await expect(layout({ ...none, confirmedOn: '2026-10-20' })).rejects.toThrow(refused)
    await expect(layout({ ...none, confirmedById: a.actorId })).rejects.toThrow(refused)
    await expect(layout({ ...none, confirmedByName: 'Made-up consultant' })).rejects.toThrow(refused)
    await expect(layout({ ...none, confirmedOn: '2026-10-20', confirmedByName: '  ' })).rejects.toThrow(refused)
  })

  it('takes the name alone (a row copied from the JSON), the user alone, or both; and it can be taken back', async () => {
    expect(await layout({ ...none, confirmedOn: '2026-10-20', confirmedByName: 'Made-up consultant' })).toBe(1)
    expect(await layout({ ...none, confirmedOn: '2026-10-20', confirmedById: a.actorId })).toBe(1)
    expect(await layout({ confirmedOn: '2026-10-21', confirmedById: a.actorId, confirmedByName: 'Made-up consultant' })).toBe(1)
    expect(await layout(none)).toBe(1)
  })

  it('the layout’s earlier rules still hold', async () => {
    await expect(layout({ definition: { columns: [] } })).rejects.toThrow(/at least one column/)
    await expect(admin(`DELETE FROM "PayrollExportLayout" WHERE id = $1`, [pay.layoutId])).rejects.toThrow(/archived, never deleted/)
  })
})

describe('Company.payrollCode (B-W2b-54: definition.companyCode)', () => {
  const code = (payrollCode: string | null) => run(office(), `UPDATE "Company" SET "payrollCode" = $1 WHERE id = $2::uuid`, payrollCode, A.companyB)
  const refused = /the payroll code of .* is not blank and at most 20 characters/

  it('the seed gives company A a made-up code; company B has none', async () => {
    expect(await admin(`SELECT id, "payrollCode" FROM "Company" WHERE "tenantId" = $1 ORDER BY id = $2 DESC`, [a.tenantId, A.companyA])).toEqual([
      { id: A.companyA, payrollCode: followups.payrollCode },
      { id: A.companyB, payrollCode: null },
    ])
  })

  it('is not blank and at most 20 characters; it can be cleared', async () => {
    await expect(code('   ')).rejects.toThrow(refused)
    await expect(code('x'.repeat(21))).rejects.toThrow(refused)
    expect(await code('x'.repeat(20))).toBe(1)
    expect(await code(null)).toBe(1)
  })
})

describe('the seed', () => {
  it('a second run changes nothing', async () => {
    const state = () =>
      admin(
        `SELECT (SELECT count(*) FROM "Party" WHERE "tenantId" = $1) AS parties,
                (SELECT row_to_json(p) FROM "PeopleSettings" p WHERE p.id = $2) AS settings,
                (SELECT "payrollCode" FROM "Company" WHERE id = $2) AS code`,
        [a.tenantId, A.companyA],
      )
    const before = await state()
    await seedFollowups({ db: factory, namespace: NS })
    expect(await state()).toEqual(before)
  }, 60_000)
})
