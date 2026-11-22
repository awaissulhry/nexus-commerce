import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedAuth } from '../seed/auth'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedFiles } from '../seed/files'
import { seed as seedPeople, type PeopleSeed } from '../seed/people'
import { seed as seedProduction, type ProductionSeed } from '../seed/production'
import { seed as seedRoles } from '../seed/roles'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'
import { seedSecondBrand, type SecondBrand } from './testing/second-brand'

/**
 * B-OF-030 (order files tab, schema wave "order files 1/1"; design order-files-2026-11-22 13-backend §1, lead L1; Owner D2, D3):
 * the 11 rules of …_order_files_guards on a database built from the migrations and seeded, through the real login and the scoped
 * client. P1's SEED-SO-0002 with its two lines (seed/production.ts), SEED-WO-0001 at plant A1 (its step 20) and the draft
 * SEED-WO-0002, A1's team L1-A and B1's team L1-B (seed/people.ts), the system roles (seed/roles.ts), Seed Brand Two's order and
 * its file (testing/second-brand.ts). Each rule refused in words, and passed in its good form:
 *    1 never deleted, TRUNCATE refused (and no DELETE grant);       7 one line of 1-500 words; reasons 3-500; the kind asked for;
 *    2 born OPEN with nothing else;                                 8 what it is about never changes; words, due, who only while OPEN;
 *    3 the order's company and customer; none on a closed order;    9 the states and each move's own columns;
 *    4 where it lands (order, line of it, work order of it, step);  10 the files: of the target record, not deleted, not infected;
 *    5 exactly one addressee, each of its kind;                        accepted only when every one is AVAILABLE;
 *    6 the floor only on a work order, never prices or body data;   11 the chase only moves later, only while OPEN.
 * And the backstops beside them: an active office person asks, answers, accepts, cancels; the Tasks named are about its own order.
 * Office only: the partner and the floor are denied. The refusals are check_violation (SQLSTATE 23514; a key a foreign_key_violation,
 * a grant "permission denied"); their words name no customer (the brand wall) and no worker. Rows only time reaches (a closed order,
 * a cancelled work order, a deleted, held or infected file) are planted by the owner with triggers off. Every name is made up.
 * Not run in the build (Owner rule: checks at the end).
 */

const NS = 'of030-order-files'
const DENIED = /permission denied/
const FOREIGN = /_fkey|foreign key/i
const TRUNCATE = /TRUNCATE on .* is refused/
// Rules 1-2
const NEVER_DELETED = /is accepted or cancelled, never deleted/
const BORN_OPEN = /a new ask \(.*\) is OPEN: no files, answer, decision, cancel, chase, round or check task yet/
const ASKER = /is made by an active office person/
const LISTS = /keeps its files and tasks as lists \(empty, never NULL\)/
// Rule 3
const ORDER_KEY = /carries its order's company and customer/
const ORDER_CLOSED = /: no new asks/
// Rule 4
const LANDS_ORDER = /lands on the order itself: no line, work order, step or site/
const LANDS_LINE = /lands on a line: the line only, no work order, step or site/
const LINE_OF_ORDER = /lands on a line of its own order/
const LANDS_WORK_ORDER = /lands on a work order: the work order and its site, no line/
const WORK_ORDER_KEY = /lands on a work order of its order's company and customer, on that work order's site/
const WORK_ORDER_STATE = /no asks land on it/
const MAKES_LINE = /lands on a work order that makes a line of its own order/
const STEP_OF_WORK_ORDER = /names a step of its own work order/
// Rules 5-6
const PERSON_ONLY = /to a person names the person only \(no role, no team\)/
const OFFICE_PERSON = /to a person is to an active office person/
const ROLE_ONLY = /to a role names the role only \(no person, no team\)/
const ROLE_AUDIENCE = /names a live role of that audience/
const TEAM_ONLY = /to a team names the team only \(no person, no role\)/
const TEAM_SITE = /to a team names an active team of the work order's site/
const STEP_ONLY = /to whoever works a step names the step, and no person, role or team/
const FLOOR_ON_WORK_ORDER = /to the floor \(a floor team, a floor role or whoever works a step\) lands on a work order/
const FLOOR_NO_PRICES = /to the floor never asks for a file with prices or body data/
// Rule 7
const WORDS = /says what is needed in one line of 1 to 500 characters/
const KIND = /asks for a DOCUMENT, a PHOTO or an ATTACHMENT/
const AGAIN_REASON = /is asked again with a reason in one line of 3 to 500 characters/
const CANCEL_REASON = /is cancelled with a reason in one line of 3 to 500 characters/
// Rules 8-9, 11
const FROZEN = /where it lands, its kind, its prices and body data marks, who asked and when never change/
const FINAL = /\(final\): nothing of it changes/
const CANNOT_MOVE = /cannot move from .* to .*/
const ONLY_ITS_COLUMNS = /changes only /
const ROUND = /asked again counts one more round/
const REASON_EXACTLY = /carries the newest reason exactly once it was asked again/
const OPEN_SHAPE = /is OPEN: no files, no answer, no decision, not cancelled/
const ARRIVED_SHAPE = /: 1 to 10 files and when they arrived, not cancelled/
const ACCEPTED_SHAPE = /is accepted \(when and by whom, both\) exactly when ACCEPTED/
const CANCELLED_SHAPE = /is cancelled with when, by whom and why, all three/
const BY_OFFICE = /is answered, accepted or cancelled by an active office person/
const CHASE = /the chase only moves later/
// Rule 10, tasks
const FILES_OF_TARGET = /is answered with files of the record it lands on/
const FILES_ONCE = /is answered with each file once/
const INFECTED = /the virus scan found something in a file sent for ask/
const HELD = /is accepted only once every file sent for it is available/
const TASKS_ONCE = /names each of its tasks once/
const TASKS_OF_ORDER = /names tasks about its own order only/
const CHECK_TASK = /names a check task about its own order/

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let production: ProductionSeed
let people: PeopleSeed
let second: SecondBrand

const key = (name: string): string => seedUuid(NS, name)
const firstId = (name: string): string => `00000000${key(name).slice(8)}`
const P1 = key('party:P1')
const P2 = key('party:P2')
const companyA = key('company:A')
const siteA1 = key('site:A1')
const siteB1 = key('site:B1')
const member = key('user:member')
const invited = key('user:invited')
const lineIds = [key('production:sales-order:SO-0002:10'), key('production:sales-order:SO-0002:20')] as const
const office = (): FactoryScope => ({ audience: 'office', tenantId: a.tenantId, actorId: a.actorId })
const floor = (): FactoryScope => ({ audience: 'floor', tenantId: a.tenantId, actorId: randomUUID(), siteId: siteA1 })
const p1 = (): FactoryScope => ({ audience: 'partner', tenantId: a.tenantId, actorId: randomUUID(), partyId: P1 })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const run = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$executeRawUnsafe(text, ...values))
const sql = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$queryRawUnsafe<Record<string, unknown>[]>(text, ...values))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, unknown>[]
/** An insert of the row's columns only (the others take their defaults). */
const insert = (scope: FactoryScope, table: string, row: Record<string, unknown>) => {
  const columns = Object.keys(row).map((column) => `"${column}"`).join(', ')
  return run(scope, `INSERT INTO "${table}" (${columns}) SELECT ${columns} FROM jsonb_populate_record(NULL::"${table}", $1::jsonb)`, JSON.stringify(row))
}
/** UPDATE the ask `id` with `changes` (office): each column from the JSON object, so lists, dates and NULLs go as they are. */
const change = (id: string, changes: Record<string, unknown>, scope: FactoryScope = office()) => {
  const sets = Object.keys(changes).map((column) => `"${column}" = r."${column}"`).join(', ')
  return run(scope, `UPDATE "FileAsk" t SET ${sets} FROM jsonb_populate_record(NULL::"FileAsk", $1::jsonb) r WHERE t.id = $2::uuid`, JSON.stringify(changes), id)
}
/** The owner, with every trigger off for one statement (set-up only: rows only time reaches). */
async function replica(text: string, values: unknown[]): Promise<void> {
  await db.admin.query('BEGIN')
  try {
    await db.admin.query("SET LOCAL session_replication_role = 'replica'")
    await db.admin.query(text, values)
    await db.admin.query('COMMIT')
  } catch (error) {
    await db.admin.query('ROLLBACK')
    throw error
  }
}
/** A copy of row `id` of `table` with `changes`, planted. */
const plant = (table: string, id: string, changes: Record<string, unknown>) =>
  replica(`INSERT INTO "${table}" SELECT * FROM jsonb_populate_record(NULL::"${table}", (SELECT to_jsonb(r) || $1::jsonb FROM "${table}" r WHERE r.id = $2::uuid))`, [JSON.stringify(changes), id])
const tag = (prefix: string): string => `${prefix}-${randomUUID().slice(0, 8)}`
const refusalOf = (work: Promise<unknown>): Promise<string | null> => work.then(() => null, (error: Error) => error.message)
const NOW = () => new Date().toISOString()
/** A week from now. */
const NEXT_WEEK = () => new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10)
/** Neutral words: no customer id, code or name in a refusal (the brand wall). */
async function expectNeutral(words: string | null): Promise<void> {
  expect(words).not.toBeNull()
  const parties = await admin(`SELECT id::text AS id, code, "legalName" AS legal, coalesce("tradeName", '') AS trade FROM "Party" WHERE id IN ($1::uuid, $2::uuid)`, [P1, second.partyId])
  for (const party of parties) for (const word of [party.id, party.code, party.legal, party.trade].map(String).filter((entry) => entry.length > 0)) expect(words).not.toContain(word)
}

/** SEED-SO-0002 (P1's, open). */
const order = (): string => production.salesOrderId
/** An order of P1: a copy of SEED-SO-0002 in `status` (no lines unless given), planted; its id. */
async function orderIn(status: string): Promise<string> {
  const id = randomUUID()
  const now = NOW()
  await plant('SalesOrder', order(), {
    id,
    number: tag('T-SO'),
    customerSeq: null,
    status,
    closedAt: status === 'CLOSED' || status === 'CANCELLED' ? now : null,
    cancelReason: status === 'CANCELLED' ? 'Made-up: the customer withdrew it.' : null,
    deliveredAt: status === 'DELIVERED' ? now : null,
    confirmationSentAt: null,
    confirmationVersion: null,
    targetMarginPct: null,
  })
  return id
}
/** A copy of SEED-WO-0001 (plant A1) with `changes` and no cells, planted; its id. */
async function workOrderLike(changes: Record<string, unknown>): Promise<string> {
  const id = randomUUID()
  await plant('WorkOrder', production.workOrderId, { id, number: tag('T-WO'), batchNumber: null, splitFromId: null, ...changes })
  return id
}
/** A file of `recordType` / `recordId`: a copy of the seeded office file, AVAILABLE and scanned clean unless `changes` say otherwise. */
async function fileOf(recordType: string, recordId: string, changes: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID()
  await plant('StoredFile', key('files:office'), {
    id,
    companyId: companyA,
    recordType,
    recordId,
    storageKey: `t/${a.tenantId}/c/${companyA}/2026/${id}`,
    status: 'AVAILABLE',
    scanStatus: 'CLEAN',
    visibility: ['OFFICE'],
    floorSiteId: null,
    partyId: null,
    seriesId: null,
    versionNo: 1,
    supersededAt: null,
    sourceFileId: null,
    thumbnailKey: null,
    exifStrippedAt: null,
    deletedAt: null,
    ...changes,
  })
  return id
}
/** A Task about `orderId` (planted: the ask names it by id). */
async function taskAbout(orderId: string): Promise<string> {
  const id = randomUUID()
  await replica(`INSERT INTO "Task" (id, "tenantId", title, "recordType", "recordId") VALUES ($1::uuid, $2::uuid, $3, 'SalesOrder', $4::uuid)`, [id, a.tenantId, 'Upload: a made-up file', orderId])
  return id
}
/** A role of the tenant of `audience`, live. */
async function roleOf(audience: 'OFFICE' | 'FLOOR'): Promise<string> {
  const [row] = await admin(`SELECT id::text AS id FROM "Role" WHERE "tenantId" = $1::uuid AND audience = $2::"RoleAudience" AND "archivedAt" IS NULL ORDER BY key LIMIT 1`, [a.tenantId, audience])
  expect(row, `a live ${audience} role (seed/roles.ts)`).toBeDefined()
  return String(row!.id)
}
/** A person of the tenant (office scope): an office one by default; its id. */
async function person(changes: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID()
  await insert(office(), 'User', { id, email: `u.${id}@example.com`, displayName: 'Test Person', status: 'ACTIVE', ...changes })
  return id
}

/** An ask on SEED-SO-0002 itself to the seed's office member, with `extra`. */
const ask = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: randomUUID(),
  companyId: companyA,
  partyId: P1,
  salesOrderId: order(),
  target: 'SALES_ORDER',
  words: 'Made-up: the signed order confirmation.',
  fileKind: 'DOCUMENT',
  addressee: 'PERSON',
  addresseeUserId: member,
  dueOn: NEXT_WEEK(),
  askedById: a.actorId,
  ...extra,
})
/** An ask on SEED-WO-0001 (plant A1) to A1's team L1-A for photos of step 20, with `extra`. */
const floorAsk = (extra: Record<string, unknown> = {}): Record<string, unknown> =>
  ask({
    siteId: siteA1,
    target: 'WORK_ORDER',
    workOrderId: production.workOrderId,
    workOrderOperationId: production.operationIds.sew,
    words: 'Made-up: photos of step 20.',
    fileKind: 'PHOTO',
    addressee: 'FLOOR_TEAM',
    addresseeUserId: null,
    addresseeTeamId: people.teamIds.a,
    ...extra,
  })
/** An ask written by the office; its id. */
async function made(row: Record<string, unknown>): Promise<string> {
  expect(await insert(office(), 'FileAsk', row)).toBe(1)
  return row.id as string
}
/** The ask's files arrive (an office person sent them unless `by` is null: the floor). */
const arrive = (id: string, fileIds: readonly string[], by: string | null = member) => change(id, { status: 'ARRIVED', fileIds, answeredAt: NOW(), answeredById: by })
const statusOf = async (id: string): Promise<string> => String((await admin(`SELECT status::text AS status FROM "FileAsk" WHERE id = $1::uuid`, [id]))[0]!.status)

beforeAll(async () => {
  db = await migratedDatabase('orderfiles')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: NS })
  await seedAuth({ db: factory, namespace: NS })
  production = await seedProduction({ db: factory, namespace: NS })
  people = await seedPeople({ db: factory, namespace: NS })
  await seedRoles({ db: factory, namespace: NS })
  await seedFiles({ db: factory, namespace: NS })
  second = await seedSecondBrand({ db: factory, namespace: NS })
}, 1_500_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 120_000)

// ---------------------------------------------------------------------------------------------------------------------------
describe('born OPEN, never deleted, office only (rules 1, 2)', () => {
  it('an ask is born OPEN with nothing else; the asker an active office person', async () => {
    const id = await made(ask())
    expect(await statusOf(id)).toBe('OPEN')
    // An UPDATE that changes nothing passes.
    expect(await change(id, { companyId: companyA })).toBe(1)
    for (const born of [
      { status: 'ARRIVED', fileIds: [randomUUID()], answeredAt: NOW() },
      { lastChasedAt: NOW() },
      { rounds: 1, lastReason: 'Made-up: born asked again.' },
      { checkTaskId: randomUUID() },
      { cancelledAt: NOW(), cancelledById: a.actorId, cancelReason: 'Made-up: born cancelled.' },
    ]) {
      await expect(insert(office(), 'FileAsk', ask(born)), JSON.stringify(born)).rejects.toThrow(BORN_OPEN)
    }
    await expect(insert(office(), 'FileAsk', ask({ askedById: invited }))).rejects.toThrow(ASKER)
    await expect(insert(office(), 'FileAsk', ask({ fileIds: null }))).rejects.toThrow(LISTS)
  })

  it('never deleted (no DELETE grant; the guard for the owner); TRUNCATE refused', async () => {
    const id = await made(ask())
    await expect(run(office(), `DELETE FROM "FileAsk" WHERE id = $1::uuid`, id)).rejects.toThrow(DENIED)
    await expect(admin(`DELETE FROM "FileAsk" WHERE id = $1::uuid`, [id])).rejects.toThrow(NEVER_DELETED)
    await expect(admin(`TRUNCATE "FileAsk"`)).rejects.toThrow(TRUNCATE)
  })

  it('office only: the partner and the floor are denied', async () => {
    await expect(sql(p1(), `SELECT id FROM "FileAsk" LIMIT 1`)).rejects.toThrow(DENIED)
    await expect(insert(p1(), 'FileAsk', ask())).rejects.toThrow(DENIED)
    await expect(sql(floor(), `SELECT id FROM "FileAsk" LIMIT 1`)).rejects.toThrow(DENIED)
    await expect(insert(floor(), 'FileAsk', floorAsk())).rejects.toThrow(DENIED)
  })
})

// ---------------------------------------------------------------------------------------------------------------------------
describe('its order (rule 3)', () => {
  it("carries the order's company and customer; the words name no customer", async () => {
    await expect(insert(office(), 'FileAsk', ask({ partyId: second.partyId }))).rejects.toThrow(ORDER_KEY)
    await expectNeutral(await refusalOf(insert(office(), 'FileAsk', ask({ partyId: second.partyId }))))
    // Another brand's order with P1's key: refused the same way.
    await expect(insert(office(), 'FileAsk', ask({ salesOrderId: second.salesOrderId }))).rejects.toThrow(ORDER_KEY)
  })

  it('no new ask on a CLOSED or CANCELLED order (L1); every open state takes one', async () => {
    for (const status of ['CLOSED', 'CANCELLED']) {
      const o = await orderIn(status)
      await expect(insert(office(), 'FileAsk', ask({ salesOrderId: o })), status).rejects.toThrow(ORDER_CLOSED)
    }
    for (const status of ['PENDING_APPROVAL', 'CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED', 'SHIPPED', 'DELIVERED']) {
      expect(await insert(office(), 'FileAsk', ask({ salesOrderId: await orderIn(status) })), status).toBe(1)
    }
  })

  it('an ask made while the order was open is still cancelled after it closed (read at the ask only)', async () => {
    const o = await orderIn('DELIVERED')
    const id = await made(ask({ salesOrderId: o }))
    await replica(`UPDATE "SalesOrder" SET status = 'CLOSED', "closedAt" = now() WHERE id = $1::uuid`, [o])
    expect(await change(id, { status: 'CANCELLED', cancelledAt: NOW(), cancelledById: a.actorId, cancelReason: 'Made-up: the order closed.' })).toBe(1)
  })
})

// ---------------------------------------------------------------------------------------------------------------------------
describe('where it lands (rule 4)', () => {
  it('the order itself: no line, work order, step or site', async () => {
    await expect(insert(office(), 'FileAsk', ask({ salesOrderLineId: lineIds[0] }))).rejects.toThrow(LANDS_ORDER)
    await expect(insert(office(), 'FileAsk', ask({ siteId: siteA1 }))).rejects.toThrow(LANDS_ORDER)
  })

  it('a line of this order, and only the line', async () => {
    expect(await insert(office(), 'FileAsk', ask({ target: 'SALES_ORDER_LINE', salesOrderLineId: lineIds[1] }))).toBe(1)
    await expect(insert(office(), 'FileAsk', ask({ target: 'SALES_ORDER_LINE' }))).rejects.toThrow(LANDS_LINE)
    await expect(insert(office(), 'FileAsk', ask({ target: 'SALES_ORDER_LINE', salesOrderLineId: lineIds[0], siteId: siteA1, workOrderId: production.workOrderId }))).rejects.toThrow(LANDS_LINE)
    // A line of another order of the same customer (its copy on a planted order).
    const other = await orderIn('CONFIRMED')
    const foreignLine = randomUUID()
    await plant('SalesOrderLine', lineIds[0], { id: foreignLine, orderId: other })
    await expect(insert(office(), 'FileAsk', ask({ target: 'SALES_ORDER_LINE', salesOrderLineId: foreignLine }))).rejects.toThrow(LINE_OF_ORDER)
  })

  it('a work order of this order (its company, customer and site; one of its lines; not cancelled, not a repair), a step of it', async () => {
    expect(await insert(office(), 'FileAsk', floorAsk())).toBe(1)
    expect(await insert(office(), 'FileAsk', floorAsk({ workOrderOperationId: null }))).toBe(1)
    await expect(insert(office(), 'FileAsk', floorAsk({ siteId: null }))).rejects.toThrow(LANDS_WORK_ORDER)
    await expect(insert(office(), 'FileAsk', floorAsk({ salesOrderLineId: lineIds[0] }))).rejects.toThrow(LANDS_WORK_ORDER)
    // Another customer's work order (a copy at A1 for Seed Brand Two).
    const theirs = await workOrderLike({ partyId: second.partyId })
    await expect(insert(office(), 'FileAsk', floorAsk({ workOrderId: theirs, workOrderOperationId: null }))).rejects.toThrow(WORK_ORDER_KEY)
    await expectNeutral(await refusalOf(insert(office(), 'FileAsk', floorAsk({ workOrderId: theirs, workOrderOperationId: null }))))
    // The work order's site, not another (the guard speaks before the key).
    await expect(insert(office(), 'FileAsk', floorAsk({ siteId: siteB1, workOrderOperationId: null, addresseeTeamId: people.teamIds.b }))).rejects.toThrow(new RegExp(`${WORK_ORDER_KEY.source}|${FOREIGN.source}`, 'i'))
    // Cancelled, or a repair: no ask lands on it.
    for (const changes of [{ status: 'CANCELLED', cancelledAt: NOW(), cancelReason: 'Made-up: not needed.' }, { kind: 'REPAIR' }]) {
      const wo = await workOrderLike(changes)
      await expect(insert(office(), 'FileAsk', floorAsk({ workOrderId: wo, workOrderOperationId: null })), JSON.stringify(changes)).rejects.toThrow(WORK_ORDER_STATE)
    }
    // A work order of the customer that makes none of this order's lines (no cells).
    const idle = await workOrderLike({})
    await expect(insert(office(), 'FileAsk', floorAsk({ workOrderId: idle, workOrderOperationId: null }))).rejects.toThrow(MAKES_LINE)
    // A step of the draft SEED-WO-0002 on SEED-WO-0001's ask (the guard speaks before the key).
    await expect(insert(office(), 'FileAsk', floorAsk({ workOrderOperationId: firstId('production:WO-0002:operation:20') }))).rejects.toThrow(new RegExp(`${STEP_OF_WORK_ORDER.source}|${FOREIGN.source}`, 'i'))
  })
})

// ---------------------------------------------------------------------------------------------------------------------------
describe('exactly one addressee, each of its kind (rule 5)', () => {
  it('a person: the person only, an active office person', async () => {
    expect(await insert(office(), 'FileAsk', ask())).toBe(1)
    await expect(insert(office(), 'FileAsk', ask({ addresseeRoleId: await roleOf('OFFICE') }))).rejects.toThrow(PERSON_ONLY)
    await expect(insert(office(), 'FileAsk', ask({ addresseeUserId: null }))).rejects.toThrow(PERSON_ONLY)
    await expect(insert(office(), 'FileAsk', ask({ addresseeUserId: invited }))).rejects.toThrow(OFFICE_PERSON)
    const portal = await person({ audience: 'PARTNER', partyId: P2, partnerKind: 'SUPPLIER' })
    await expect(insert(office(), 'FileAsk', ask({ addresseeUserId: portal }))).rejects.toThrow(OFFICE_PERSON)
  })

  it('an office role or a floor role: the role only, live, of that audience', async () => {
    const officeRole = await roleOf('OFFICE')
    const floorRole = await roleOf('FLOOR')
    expect(await insert(office(), 'FileAsk', ask({ addressee: 'OFFICE_ROLE', addresseeUserId: null, addresseeRoleId: officeRole }))).toBe(1)
    expect(await insert(office(), 'FileAsk', floorAsk({ addressee: 'FLOOR_ROLE', addresseeTeamId: null, addresseeRoleId: floorRole }))).toBe(1)
    await expect(insert(office(), 'FileAsk', ask({ addressee: 'OFFICE_ROLE', addresseeRoleId: officeRole }))).rejects.toThrow(ROLE_ONLY)
    await expect(insert(office(), 'FileAsk', ask({ addressee: 'OFFICE_ROLE', addresseeUserId: null, addresseeRoleId: floorRole }))).rejects.toThrow(ROLE_AUDIENCE)
    await expect(insert(office(), 'FileAsk', floorAsk({ addressee: 'FLOOR_ROLE', addresseeTeamId: null, addresseeRoleId: officeRole }))).rejects.toThrow(ROLE_AUDIENCE)
    const archived = randomUUID()
    await plant('Role', officeRole, { id: archived, key: `custom.${tag('archived').replace('-', '_')}`, system: false, archivedAt: NOW(), archivedById: a.actorId })
    await expect(insert(office(), 'FileAsk', ask({ addressee: 'OFFICE_ROLE', addresseeUserId: null, addresseeRoleId: archived }))).rejects.toThrow(ROLE_AUDIENCE)
  })

  it("a floor team: the team only, an active team of the work order's site", async () => {
    await expect(insert(office(), 'FileAsk', floorAsk({ addresseeUserId: member }))).rejects.toThrow(TEAM_ONLY)
    await expect(insert(office(), 'FileAsk', floorAsk({ addresseeTeamId: null }))).rejects.toThrow(TEAM_ONLY)
    // B1's team on an A1 work order (the guard speaks before the key).
    await expect(insert(office(), 'FileAsk', floorAsk({ addresseeTeamId: people.teamIds.b }))).rejects.toThrow(new RegExp(`${TEAM_SITE.source}|${FOREIGN.source}`, 'i'))
    const archived = randomUUID()
    await plant('Team', people.teamIds.a, { id: archived, code: tag('T-ARCH'), status: 'ARCHIVED' })
    await expect(insert(office(), 'FileAsk', floorAsk({ addresseeTeamId: archived }))).rejects.toThrow(TEAM_SITE)
  })

  it('whoever works a step: the step, and no person, role or team', async () => {
    expect(await insert(office(), 'FileAsk', floorAsk({ addressee: 'STEP', addresseeTeamId: null }))).toBe(1)
    await expect(insert(office(), 'FileAsk', floorAsk({ addressee: 'STEP', addresseeTeamId: null, workOrderOperationId: null }))).rejects.toThrow(STEP_ONLY)
    await expect(insert(office(), 'FileAsk', floorAsk({ addressee: 'STEP' }))).rejects.toThrow(STEP_ONLY)
  })
})

// ---------------------------------------------------------------------------------------------------------------------------
describe('the floor walls (rule 6)', () => {
  it('a floor team, a floor role or a step only on a work order', async () => {
    const floorRole = await roleOf('FLOOR')
    await expect(insert(office(), 'FileAsk', ask({ addressee: 'FLOOR_TEAM', addresseeUserId: null, addresseeTeamId: people.teamIds.a }))).rejects.toThrow(FLOOR_ON_WORK_ORDER)
    await expect(insert(office(), 'FileAsk', ask({ target: 'SALES_ORDER_LINE', salesOrderLineId: lineIds[0], addressee: 'FLOOR_ROLE', addresseeUserId: null, addresseeRoleId: floorRole }))).rejects.toThrow(FLOOR_ON_WORK_ORDER)
    await expect(insert(office(), 'FileAsk', ask({ addressee: 'STEP', addresseeUserId: null }))).rejects.toThrow(FLOOR_ON_WORK_ORDER)
  })

  it('never a file with prices or body data asked of the floor; the office may be asked for one', async () => {
    await expect(insert(office(), 'FileAsk', floorAsk({ priced: true }))).rejects.toThrow(FLOOR_NO_PRICES)
    await expect(insert(office(), 'FileAsk', floorAsk({ addressee: 'STEP', addresseeTeamId: null, bodyData: true }))).rejects.toThrow(FLOOR_NO_PRICES)
    await expect(insert(office(), 'FileAsk', floorAsk({ addressee: 'FLOOR_ROLE', addresseeTeamId: null, addresseeRoleId: await roleOf('FLOOR'), priced: true }))).rejects.toThrow(FLOOR_NO_PRICES)
    expect(await insert(office(), 'FileAsk', ask({ priced: true }))).toBe(1)
    expect(await insert(office(), 'FileAsk', ask({ bodyData: true }))).toBe(1)
  })

  it('a priced ask on a work order is never reassigned to the floor; to an office role it may be', async () => {
    const id = await made(floorAsk({ addressee: 'PERSON', addresseeTeamId: null, addresseeUserId: member, priced: true }))
    await expect(change(id, { addressee: 'FLOOR_TEAM', addresseeUserId: null, addresseeTeamId: people.teamIds.a })).rejects.toThrow(FLOOR_NO_PRICES)
    expect(await change(id, { addressee: 'OFFICE_ROLE', addresseeUserId: null, addresseeRoleId: await roleOf('OFFICE'), version: 2 })).toBe(1)
  })
})

// ---------------------------------------------------------------------------------------------------------------------------
describe('words, reasons and the kind asked for (rule 7)', () => {
  it('what is needed: one line of 1 to 500 characters', async () => {
    expect(await insert(office(), 'FileAsk', ask({ words: 'x'.repeat(500) }))).toBe(1)
    for (const words of ['', '   ', 'x'.repeat(501), 'Two\nlines']) await expect(insert(office(), 'FileAsk', ask({ words })), JSON.stringify(words)).rejects.toThrow(WORDS)
    const id = await made(ask())
    await expect(change(id, { words: '  ' })).rejects.toThrow(WORDS)
  })

  it('a DOCUMENT, a PHOTO or an ATTACHMENT; never a fiscal paper or a certificate', async () => {
    expect(await insert(office(), 'FileAsk', ask({ fileKind: 'ATTACHMENT' }))).toBe(1)
    for (const fileKind of ['FISCAL_ARCHIVE', 'CERTIFICATE', 'AUDIO']) await expect(insert(office(), 'FileAsk', ask({ fileKind })), fileKind).rejects.toThrow(KIND)
  })

  it('asked again and cancelled with a reason of 3 to 500 characters in one line', async () => {
    const file = await fileOf('SalesOrder', order())
    const id = await made(ask())
    expect(await arrive(id, [file])).toBe(1)
    await expect(change(id, { status: 'OPEN', fileIds: [], answeredAt: null, answeredById: null, rounds: 1, lastReason: 'ab' })).rejects.toThrow(AGAIN_REASON)
    await expect(change(id, { status: 'OPEN', fileIds: [], answeredAt: null, answeredById: null, rounds: 1, lastReason: 'The wrong\nsize' })).rejects.toThrow(AGAIN_REASON)
    await expect(change(id, { status: 'CANCELLED', cancelledAt: NOW(), cancelledById: a.actorId, cancelReason: '  ' })).rejects.toThrow(CANCEL_REASON)
    expect(await change(id, { status: 'CANCELLED', cancelledAt: NOW(), cancelledById: a.actorId, cancelReason: 'Made-up: found it ourselves.' })).toBe(1)
  })
})

// ---------------------------------------------------------------------------------------------------------------------------
describe('what an ask is about never changes (rule 8)', () => {
  it('order, target, line, work order, step, kind, marks, asker and making are frozen; words, due and who change while OPEN', async () => {
    const id = await made(ask())
    for (const frozen of [
      { target: 'SALES_ORDER_LINE', salesOrderLineId: lineIds[0] },
      { priced: true },
      { bodyData: true },
      { fileKind: 'PHOTO' },
      { askedById: member },
      { createdAt: '2026-11-01T08:00:00.000Z' },
    ]) {
      await expect(change(id, frozen), JSON.stringify(frozen)).rejects.toThrow(FROZEN)
    }
    expect(await change(id, { words: 'Made-up: the countersigned confirmation.', dueOn: NEXT_WEEK(), version: 2 })).toBe(1)
    expect(await change(id, { addressee: 'OFFICE_ROLE', addresseeUserId: null, addresseeRoleId: await roleOf('OFFICE'), version: 3 })).toBe(1)
    // Once files arrived, the words, the due day and the addressee stay as they are.
    expect(await arrive(id, [await fileOf('SalesOrder', order())])).toBe(1)
    await expect(change(id, { words: 'Made-up: something else.' })).rejects.toThrow(ONLY_ITS_COLUMNS)
    await expect(change(id, { dueOn: '2027-01-15' })).rejects.toThrow(ONLY_ITS_COLUMNS)
  })
})

// ---------------------------------------------------------------------------------------------------------------------------
describe('the states and each move (rule 9)', () => {
  it('OPEN → ARRIVED → asked again (OPEN, round 1) → ARRIVED → ACCEPTED; then final', async () => {
    const id = await made(ask())
    const first = await fileOf('SalesOrder', order())
    expect(await arrive(id, [first])).toBe(1)
    expect(await change(id, { status: 'OPEN', fileIds: [], answeredAt: null, answeredById: null, rounds: 1, lastReason: 'Made-up: the wrong size.' })).toBe(1)
    const second_ = await fileOf('SalesOrder', order())
    expect(await arrive(id, [second_])).toBe(1)
    expect(await change(id, { status: 'ACCEPTED', acceptedAt: NOW(), acceptedById: a.actorId })).toBe(1)
    expect(await statusOf(id)).toBe('ACCEPTED')
    await expect(change(id, { version: 9 })).rejects.toThrow(FINAL)
    await expect(change(id, { status: 'CANCELLED', cancelledAt: NOW(), cancelledById: a.actorId, cancelReason: 'Made-up: too late.' })).rejects.toThrow(FINAL)
  })

  it('no other move: OPEN → ACCEPTED is refused; each move changes only its own columns', async () => {
    const id = await made(ask())
    await expect(change(id, { status: 'ACCEPTED', acceptedAt: NOW(), acceptedById: a.actorId })).rejects.toThrow(CANNOT_MOVE)
    // OPEN → OPEN never takes files or a round.
    await expect(change(id, { fileIds: [await fileOf('SalesOrder', order())] })).rejects.toThrow(ONLY_ITS_COLUMNS)
    await expect(change(id, { rounds: 1, lastReason: 'Made-up: early.' })).rejects.toThrow(ONLY_ITS_COLUMNS)
    // OPEN → ARRIVED never reassigns.
    await expect(change(id, { status: 'ARRIVED', fileIds: [await fileOf('SalesOrder', order())], answeredAt: NOW(), answeredById: member, addresseeUserId: a.actorId })).rejects.toThrow(ONLY_ITS_COLUMNS)
  })

  it('ARRIVED: 1 to 10 files and when they arrived; who sent them an active office person, or no one (the floor)', async () => {
    const id = await made(ask())
    const file = await fileOf('SalesOrder', order())
    await expect(change(id, { status: 'ARRIVED', fileIds: [], answeredAt: NOW(), answeredById: member })).rejects.toThrow(ARRIVED_SHAPE)
    await expect(change(id, { status: 'ARRIVED', fileIds: [file], answeredAt: null, answeredById: member })).rejects.toThrow(ARRIVED_SHAPE)
    // Planted one after another: each plant is a transaction of the owner's one connection.
    const eleven: string[] = []
    for (let n = 0; n < 11; n++) eleven.push(await fileOf('SalesOrder', order()))
    await expect(arrive(id, eleven)).rejects.toThrow(ARRIVED_SHAPE)
    await expect(arrive(id, [file], invited)).rejects.toThrow(BY_OFFICE)
    // The floor answers as the floor: no one named.
    expect(await arrive(id, [file], null)).toBe(1)
  })

  it('asked again: one more round, its reason, the files and the answer cleared', async () => {
    const id = await made(ask())
    expect(await arrive(id, [await fileOf('SalesOrder', order())])).toBe(1)
    await expect(change(id, { status: 'OPEN', fileIds: [], answeredAt: null, answeredById: null, rounds: 0, lastReason: 'Made-up: blurred.' })).rejects.toThrow(ROUND)
    await expect(change(id, { status: 'OPEN', fileIds: [], answeredAt: null, answeredById: null, rounds: 2, lastReason: 'Made-up: blurred.' })).rejects.toThrow(ROUND)
    await expect(change(id, { status: 'OPEN', fileIds: [], answeredAt: null, answeredById: null, rounds: 1, lastReason: null })).rejects.toThrow(REASON_EXACTLY)
    await expect(change(id, { status: 'OPEN', answeredAt: null, answeredById: null, rounds: 1, lastReason: 'Made-up: blurred.' })).rejects.toThrow(OPEN_SHAPE)
    expect(await change(id, { status: 'OPEN', fileIds: [], answeredAt: null, answeredById: null, rounds: 1, lastReason: 'Made-up: blurred.' })).toBe(1)
  })

  it('ACCEPTED: when and by whom, both, an active office person; the files kept', async () => {
    const id = await made(ask())
    expect(await arrive(id, [await fileOf('SalesOrder', order())])).toBe(1)
    await expect(change(id, { status: 'ACCEPTED', acceptedAt: NOW() })).rejects.toThrow(ACCEPTED_SHAPE)
    await expect(change(id, { status: 'ACCEPTED', acceptedAt: NOW(), acceptedById: invited })).rejects.toThrow(BY_OFFICE)
    await expect(change(id, { status: 'ACCEPTED', acceptedAt: NOW(), acceptedById: a.actorId, fileIds: [await fileOf('SalesOrder', order())] })).rejects.toThrow(ONLY_ITS_COLUMNS)
    expect(await change(id, { status: 'ACCEPTED', acceptedAt: NOW(), acceptedById: a.actorId })).toBe(1)
  })

  it('CANCELLED from OPEN or ARRIVED: when, by whom and why, all three; the files it had kept; then final', async () => {
    const open = await made(ask())
    await expect(change(open, { status: 'CANCELLED', cancelledAt: NOW(), cancelledById: a.actorId })).rejects.toThrow(CANCELLED_SHAPE)
    await expect(change(open, { status: 'CANCELLED', cancelledAt: NOW(), cancelledById: invited, cancelReason: 'Made-up: not needed.' })).rejects.toThrow(BY_OFFICE)
    expect(await change(open, { status: 'CANCELLED', cancelledAt: NOW(), cancelledById: a.actorId, cancelReason: 'Made-up: not needed.' })).toBe(1)
    await expect(change(open, { cancelReason: 'Made-up: another reason.' })).rejects.toThrow(FINAL)
    const arrived = await made(ask())
    const file = await fileOf('SalesOrder', order())
    expect(await arrive(arrived, [file])).toBe(1)
    await expect(change(arrived, { status: 'CANCELLED', cancelledAt: NOW(), cancelledById: a.actorId, cancelReason: 'Made-up: not needed.', fileIds: [] })).rejects.toThrow(ONLY_ITS_COLUMNS)
    expect(await change(arrived, { status: 'CANCELLED', cancelledAt: NOW(), cancelledById: a.actorId, cancelReason: 'Made-up: not needed.' })).toBe(1)
    expect((await admin(`SELECT "fileIds"::text[] AS files FROM "FileAsk" WHERE id = $1::uuid`, [arrived]))[0]!.files).toEqual([file])
  })
})

// ---------------------------------------------------------------------------------------------------------------------------
describe('the files sent for it (rule 10)', () => {
  it('files of the record it lands on, each once, none deleted', async () => {
    const id = await made(ask())
    // Another brand's order file, a file of the work order, a file of a line: not the order's.
    for (const foreign of [second.fileId, await fileOf('WorkOrder', production.workOrderId), await fileOf('SalesOrderLine', lineIds[0])]) {
      await expect(arrive(id, [foreign])).rejects.toThrow(FILES_OF_TARGET)
    }
    await expectNeutral(await refusalOf(arrive(id, [second.fileId])))
    await expect(arrive(id, [await fileOf('SalesOrder', order(), { status: 'DELETED', deletedAt: NOW() })])).rejects.toThrow(FILES_OF_TARGET)
    const file = await fileOf('SalesOrder', order())
    await expect(arrive(id, [file, file])).rejects.toThrow(FILES_ONCE)
    expect(await arrive(id, [file])).toBe(1)
  })

  it('a line ask takes the line’s files; a work-order ask the work order’s (a floor photo: no one named)', async () => {
    const lineAsk = await made(ask({ target: 'SALES_ORDER_LINE', salesOrderLineId: lineIds[0] }))
    await expect(arrive(lineAsk, [await fileOf('SalesOrder', order())])).rejects.toThrow(FILES_OF_TARGET)
    expect(await arrive(lineAsk, [await fileOf('SalesOrderLine', lineIds[0])])).toBe(1)
    const floorOne = await made(floorAsk())
    await expect(arrive(floorOne, [await fileOf('SalesOrder', order())], null)).rejects.toThrow(FILES_OF_TARGET)
    expect(await arrive(floorOne, [await fileOf('WorkOrder', production.workOrderId, { kind: 'PHOTO', visibility: ['OFFICE', 'FLOOR'], floorSiteId: siteA1 })], null)).toBe(1)
  })

  it('never a file the virus scan found something in', async () => {
    const id = await made(ask())
    const infected = await fileOf('SalesOrder', order(), { status: 'QUARANTINED', quarantineReason: 'scan_pending', scanStatus: 'INFECTED', scannedAt: NOW(), scanEngine: 'Made-up scanner', scanFinding: 'Made-up.Test.Signature' })
    await expect(arrive(id, [infected])).rejects.toThrow(INFECTED)
  })

  it('a file still held by the scan arrives, but the ask is accepted only once every file is AVAILABLE', async () => {
    const id = await made(ask())
    const held = await fileOf('SalesOrder', order(), { status: 'QUARANTINED', quarantineReason: 'scan_pending', scanStatus: 'PENDING', availableAt: null })
    const clean = await fileOf('SalesOrder', order())
    expect(await arrive(id, [clean, held])).toBe(1)
    await expect(change(id, { status: 'ACCEPTED', acceptedAt: NOW(), acceptedById: a.actorId })).rejects.toThrow(HELD)
    await replica(`UPDATE "StoredFile" SET status = 'AVAILABLE', "scanStatus" = 'CLEAN', "quarantineReason" = NULL, "availableAt" = now(), "scannedAt" = now() WHERE id = $1::uuid`, [held])
    expect(await change(id, { status: 'ACCEPTED', acceptedAt: NOW(), acceptedById: a.actorId })).toBe(1)
  })
})

// ---------------------------------------------------------------------------------------------------------------------------
describe('the chase (rule 11)', () => {
  it('only later, only while OPEN', async () => {
    const id = await made(ask())
    const at = new Date(Date.now() - 3_600_000).toISOString()
    expect(await change(id, { lastChasedAt: at, version: 2 })).toBe(1)
    expect(await change(id, { lastChasedAt: NOW(), version: 3 })).toBe(1)
    await expect(change(id, { lastChasedAt: at })).rejects.toThrow(CHASE)
    await expect(change(id, { lastChasedAt: null })).rejects.toThrow(CHASE)
    expect(await arrive(id, [await fileOf('SalesOrder', order())])).toBe(1)
    await expect(change(id, { lastChasedAt: new Date(Date.now() + 60_000).toISOString() })).rejects.toThrow(ONLY_ITS_COLUMNS)
  })
})

// ---------------------------------------------------------------------------------------------------------------------------
describe('the Tasks it names (backstop)', () => {
  it('Tasks about its own order, each once; the check task too', async () => {
    const mine = await taskAbout(order())
    const theirs = await taskAbout(second.salesOrderId)
    expect(await insert(office(), 'FileAsk', ask({ taskIds: [mine] }))).toBe(1)
    await expect(insert(office(), 'FileAsk', ask({ taskIds: [theirs] }))).rejects.toThrow(TASKS_OF_ORDER)
    await expect(insert(office(), 'FileAsk', ask({ taskIds: [mine, mine] }))).rejects.toThrow(TASKS_ONCE)
    // A reassign writes new Tasks (while OPEN).
    const id = await made(ask())
    expect(await change(id, { taskIds: [mine], version: 2 })).toBe(1)
    await expect(change(id, { taskIds: [theirs] })).rejects.toThrow(TASKS_OF_ORDER)
    // The asker's check Task, once the files arrived.
    expect(await change(id, { status: 'ARRIVED', fileIds: [await fileOf('SalesOrder', order())], answeredAt: NOW(), answeredById: member, checkTaskId: await taskAbout(order()) })).toBe(1)
    await expect(change(id, { checkTaskId: theirs })).rejects.toThrow(CHECK_TASK)
    expect(await change(id, { checkTaskId: await taskAbout(order()), version: 3 })).toBe(1)
  })
})
