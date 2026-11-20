import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedBrandProduction, type BrandProductionSeed } from '../seed/brand-production'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedPortalSales, type PortalSalesSeed } from '../seed/portal-sales'
import { seed as seedSamples, type SamplesSeed } from '../seed/samples'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { PARTNER_ROLE, RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'
import { seedSecondBrand, type SecondBrand } from './testing/second-brand'

/**
 * B-PR-23 (production plan, schema wave 4/5; lead picks L18, L26, R-50, R-65; review fixes R-09, R-14, R-35, R-36): a customer's
 * asks and our answers, on a database built from the migrations and seeded (portal-sales: P1's change requests; brand-production:
 * P1's "Urgent – asked" on SEED-SO-0004; samples: SEED-SR-0001…0004, their swatches, gates and P1's OPEN SAMPLE approval; Seed
 * Brand Two), through the real login and the scoped client.
 *   - PW-12 (DB part): P2's partner role reads no P1 request or approval, nor does the second brand; who countered, who decided
 *     for the party and who reversed (counteredById, decidedForPartyById, reversedById) have no partner grant; a batch never
 *     spans two customers or two kinds;
 *   - the guards (…_brand_asks_guards), for every login: the production asks' own columns; a PARTLY_SHIPPED order's asks; a
 *     RESUME after an ACCEPTED HOLD; the impact (no number: never an amount); the counter-offer (OPEN → COUNTERED by the office
 *     with its COUNTER_OFFER approval → ACCEPTED exactly after the customer's yes); the lines (another colourway, a split's first
 *     part, one line of a sample round, none on a rush, pause or resume); decided for the party (exactly one answerer of three,
 *     never the asker, never on a CONCESSION, REVISED_ORDER, SIGNATURE or PROOF) and reversed once; FABRIC and TRIM swatches of
 *     their materials; a SIZE_SET gate of a SIZE_SET round.
 * The refusals are check_violation (SQLSTATE 23514); their messages are read through raw SQL. Not run in the build (Owner rule
 * 2026-11-17: checks at the end).
 */

const NS = 'pr23-asks'
const DENIED = /permission denied/
const PER_KIND = /a code only on a cancel or a pause, a date only on a change, a rush or a split shipment/
const BATCH = /a batch holds the requests of one customer and one kind/

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let sales: PortalSalesSeed
let production: BrandProductionSeed
let samples: SamplesSeed
let second: SecondBrand

const key = (name: string): string => seedUuid(NS, name)
const P1 = key('party:P1')
const P2 = key('party:P2')
const buyer = key('portal:user:P1:buyer')
const p2Person = key('portal:user:P2:orders')
const office = (): FactoryScope => ({ audience: 'office', tenantId: a.tenantId, actorId: a.actorId })
const partnerOf = (partyId: string, actorId: string): FactoryScope => ({ audience: 'partner', tenantId: a.tenantId, actorId, partyId })
const p1 = (): FactoryScope => partnerOf(P1, buyer)
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const run = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$executeRawUnsafe(text, ...values))
const sql = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$queryRawUnsafe<Record<string, unknown>[]>(text, ...values))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, unknown>[]
const update = (scope: FactoryScope, table: string, id: string, set: string, ...values: unknown[]) => run(scope, `UPDATE "${table}" SET ${set} WHERE id = $1::uuid`, id, ...values)
/** The columns the partner role may not write, of the tables a partner copies here (ownership/*.json). */
const PARTNER_HIDDEN: Readonly<Record<string, readonly string[]>> = { OrderChangeRequest: ['answeredById', 'counteredById'] }
/**
 * INSERT a copy of row `id` of `table` with `changes`, in `scope`: the row is read as the owner, and a partner writes only the
 * columns it has a grant on (a hidden column takes its default), as the generated isolation tests do.
 */
async function copyRow(table: string, id: string, changes: Record<string, unknown>, scope: FactoryScope = office()): Promise<number> {
  const [source] = await admin(`SELECT to_jsonb(r) AS row FROM "${table}" r WHERE r.id = $1::uuid`, [id])
  const hidden = scope.audience === 'partner' ? (PARTNER_HIDDEN[table] ?? []) : []
  const names = await admin(`SELECT column_name AS name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`, [table])
  const columns = names.map((row) => row.name as string).filter((name) => !hidden.includes(name)).map((name) => `"${name}"`).join(', ')
  return run(scope, `INSERT INTO "${table}" (${columns}) SELECT ${columns} FROM jsonb_populate_record(NULL::"${table}", $1::jsonb)`, JSON.stringify({ ...(source!.row as object), ...changes }))
}
/** The same copy as the owner with every trigger off (set-up only: an order in a state the guards reach only with time). */
async function plant(table: string, id: string, changes: Record<string, unknown>): Promise<void> {
  await db.admin.query('BEGIN')
  try {
    await db.admin.query("SET LOCAL session_replication_role = 'replica'")
    await db.admin.query(`INSERT INTO "${table}" SELECT * FROM jsonb_populate_record(NULL::"${table}", (SELECT to_jsonb(r) || $1::jsonb FROM "${table}" r WHERE r.id = $2::uuid))`, [JSON.stringify(changes), id])
    await db.admin.query('COMMIT')
  } catch (error) {
    await db.admin.query('ROLLBACK')
    throw error
  }
}
/** The database server's clock, `ms` later (the container's clock drifts from the host's: portal-sales-w2b.pg's note). */
const serverNow = async (ms = 0): Promise<string> =>
  ((await admin(`SELECT clock_timestamp() + $1::int * interval '1 millisecond' AS at`, [ms]))[0]!.at as Date).toISOString()
/** A week from now (a date not before any day the test writes, in Rome or anywhere). */
const NEXT_WEEK = () => new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10)

/** An insert of the row's columns only (the others take their defaults). */
const insert = (scope: FactoryScope, table: string, row: Record<string, unknown>) => {
  const columns = Object.keys(row).map((column) => `"${column}"`).join(', ')
  return run(scope, `INSERT INTO "${table}" (${columns}) SELECT ${columns} FROM jsonb_populate_record(NULL::"${table}", $1::jsonb)`, JSON.stringify(row))
}
/** A person of the tenant (office scope): an ACTIVE office one by default; returns its id (brand-limits.pg's helper). */
const person = async (changes: Record<string, unknown> = {}): Promise<string> => {
  const id = randomUUID()
  await insert(office(), 'User', { id, email: `u.${id}@example.com`, displayName: 'Test Person', status: 'ACTIVE', ...changes })
  return id
}
/** A CONFIRMED order of P1 (a copy of SEED-SO-0004, its rules not under test), in `status`. */
const newOrder = async (status = 'CONFIRMED'): Promise<string> => {
  const id = randomUUID()
  await plant('SalesOrder', production.urgentAsk.orderId, { id, number: `T-PR23-${id.slice(0, 8)}`, customerSeq: null, status })
  return id
}
/** A new OPEN request of P1, asked by its buyer from the seed's OPEN change (its words kept), with `changes`. */
async function ask(changes: Record<string, unknown> = {}, scope: FactoryScope = p1()): Promise<string> {
  const id = randomUUID()
  const at = await serverNow()
  await copyRow('OrderChangeRequest', sales.changes.open, { id, createdAt: at, updatedAt: at, ...changes }, scope)
  return id
}
/** A line of request `requestId`, written by P1's buyer from the seed's first asked cell, with `changes`. */
async function cell(requestId: string, changes: Record<string, unknown>): Promise<string> {
  const id = randomUUID()
  const [first] = await admin(`SELECT id::text AS id FROM "OrderChangeRequestLine" WHERE "requestId" = $1::uuid ORDER BY id LIMIT 1`, [sales.changes.open])
  await copyRow('OrderChangeRequestLine', first!.id as string, { id, requestId, size: null, createdAt: await serverNow(), ...changes }, p1())
  return id
}
/** An OPEN approval request of P1 made by the office from the seed's SAMPLE one, with `changes`. */
async function approval(changes: Record<string, unknown>): Promise<string> {
  const id = randomUUID()
  const at = await serverNow()
  await copyRow('ApprovalRequest', samples.approvalRequestId, { id, createdAt: at, updatedAt: at, dueAt: `${NEXT_WEEK()}T12:00:00.000Z`, version: 1, ...changes })
  return id
}
const answerAs = (scope: FactoryScope, id: string, status: 'APPROVED' | 'REFUSED', userId: string) =>
  update(scope, 'ApprovalRequest', id, `status = '${status}', answer = ${status === 'REFUSED' ? `'Too expensive'` : 'NULL'}, "typedName" = 'Bea Buyer', "answeredAt" = now(), "answeredByUserId" = $2::uuid, "answerRequestId" = 'req-t', version = version + 1`, userId)

const U = { office: '', other: '', suspended: '' }
/** A P1 order line whose style has another colourway, on an order a change is asked of. */
let line: { id: string; orderId: string; styleId: string; colourwayId: string; other: string }

beforeAll(async () => {
  db = await migratedDatabase('brandasks')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: NS })
  sales = await seedPortalSales({ db: factory, namespace: NS })
  production = await seedBrandProduction({ db: factory, namespace: NS })
  samples = await seedSamples({ db: factory, namespace: NS })
  second = await seedSecondBrand({ db: factory, namespace: NS })
  U.office = await person()
  U.other = await person()
  U.suspended = await person({ status: 'SUSPENDED' })
  const [found] = await admin(
    `SELECT l.id::text AS id, l."orderId"::text AS "orderId", l."styleId"::text AS "styleId", l."colourwayId"::text AS "colourwayId",
            (SELECT w.id::text FROM "Colourway" w WHERE w."tenantId" = l."tenantId" AND w."styleId" = l."styleId" AND w.id <> l."colourwayId" ORDER BY w.id LIMIT 1) AS other
       FROM "SalesOrderLine" l JOIN "SalesOrder" o ON o.id = l."orderId"
      WHERE o."tenantId" = $1::uuid AND o."partyId" = $2::uuid AND o.status::text IN ('CONFIRMED', 'IN_PRODUCTION', 'READY')
        AND EXISTS (SELECT 1 FROM "Colourway" w WHERE w."tenantId" = l."tenantId" AND w."styleId" = l."styleId" AND w.id <> l."colourwayId")
      ORDER BY o.number, l.seq LIMIT 1`,
    [a.tenantId, P1],
  )
  line = found as typeof line
}, 1_500_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 120_000)

// ---------------------------------------------------------------------------------------------------------------------------
describe('what the partner role reads (PW-12, DB part)', () => {
  it('never who countered, who decided for the party or who reversed; it reads the counter, the reasons and when', async () => {
    for (const [table, column] of [['OrderChangeRequest', 'counteredById'], ['ApprovalRequest', 'decidedForPartyById'], ['ApprovalRequest', 'reversedById']] as const) {
      const [grant] = await admin(`SELECT has_column_privilege($1, $2, $3, 'SELECT') AS granted`, [PARTNER_ROLE, `"${table}"`, column])
      expect(grant!.granted, `${table}.${column}`).toBe(false)
      await expect(sql(p1(), `SELECT "${column}" FROM "${table}" LIMIT 1`), `${table}.${column}`).rejects.toThrow(DENIED)
      // Nor writes it: the partner can never name the office person.
      await expect(run(p1(), `UPDATE "${table}" SET "${column}" = NULL WHERE false`), `${table}.${column}`).rejects.toThrow(DENIED)
    }
    for (const column of ['counterApprovalId', 'counteredAt', 'counterDate', 'counterFee', 'counterNote', 'impact', 'sampleKind', 'sampleRoundId', 'batchId']) {
      const [grant] = await admin(`SELECT has_column_privilege($1, '"OrderChangeRequest"', $2, 'SELECT') AS granted`, [PARTNER_ROLE, column])
      expect(grant!.granted, column).toBe(true)
    }
    for (const column of ['decidedForPartyReason', 'reversedAt', 'reverseReason']) {
      const [grant] = await admin(`SELECT has_column_privilege($1, '"ApprovalRequest"', $2, 'SELECT') AS granted`, [PARTNER_ROLE, column])
      expect(grant!.granted, column).toBe(true)
    }
    for (const column of ['styleId', 'colourwayId']) {
      const [grant] = await admin(`SELECT has_column_privilege($1, '"OrderChangeRequestLine"', $2, 'SELECT') AS granted`, [PARTNER_ROLE, column])
      expect(grant!.granted, column).toBe(true)
    }
  })

  it('P2 reads no P1 request or approval; the second brand reads none of P1’s asks (the "Urgent – asked" either)', async () => {
    const asked = await ask({ kind: 'RUSH', requestedDate: NEXT_WEEK() })
    const counter = await approval({ kind: 'COUNTER_OFFER', recordType: 'OrderChangeRequest', recordId: asked })
    expect(await sql(partnerOf(P2, p2Person), `SELECT id FROM "OrderChangeRequest"`)).toEqual([])
    expect(await sql(partnerOf(P2, p2Person), `SELECT id FROM "ApprovalRequest" WHERE id IN ($1::uuid, $2::uuid)`, counter, samples.approvalRequestId)).toEqual([])
    expect(await sql(partnerOf(second.partyId, second.userId), `SELECT id FROM "OrderChangeRequest"`)).toEqual([])
    expect(await sql(partnerOf(second.partyId, second.userId), `SELECT id FROM "ApprovalRequest" WHERE id IN ($1::uuid, $2::uuid)`, counter, samples.approvalRequestId)).toEqual([])
    // Not vacuous: P1 reads them.
    const own = (await sql(p1(), `SELECT id::text AS id FROM "OrderChangeRequest"`)).map((row) => row.id)
    expect(own).toEqual(expect.arrayContaining([asked, production.urgentAsk.requestId, sales.changes.open]))
    expect((await sql(p1(), `SELECT id::text AS id FROM "ApprovalRequest" WHERE id = $1::uuid`, counter)).map((row) => row.id)).toEqual([counter])
  })
})

// ---------------------------------------------------------------------------------------------------------------------------
describe('the seeded "Urgent – asked" (R-57)', () => {
  it('P1’s buyer asked SEED-SO-0004 urgent with a need-by date: an OPEN RUSH, no lines, no batch, on a CONFIRMED order', async () => {
    const [row] = await sql(p1(), `SELECT kind::text AS kind, status::text AS status, "orderId"::text AS "orderId", "requestedDate" IS NOT NULL AS dated, "batchId", impact, "createdById"::text AS by FROM "OrderChangeRequest" WHERE id = $1::uuid`, production.urgentAsk.requestId)
    expect(row).toEqual({ kind: 'RUSH', status: 'OPEN', orderId: production.urgentAsk.orderId, dated: true, batchId: null, impact: null, by: buyer })
    expect(await admin(`SELECT count(*)::int AS n FROM "OrderChangeRequestLine" WHERE "requestId" = $1::uuid`, [production.urgentAsk.requestId])).toEqual([{ n: 0 }])
    expect(await admin(`SELECT status::text AS status, "partyId"::text AS party FROM "SalesOrder" WHERE id = $1::uuid`, [production.urgentAsk.orderId])).toEqual([{ status: 'CONFIRMED', party: P1 }])
  })
})

// ---------------------------------------------------------------------------------------------------------------------------
describe('the production asks’ own columns', () => {
  it('a code only on a cancel or a pause; a date on a change, a rush or a split shipment; an address on a change only', async () => {
    expect(await ask({ kind: 'RUSH', requestedDate: NEXT_WEEK() })).toBeTruthy()
    expect(await ask({ kind: 'RUSH' })).toBeTruthy()
    await expect(ask({ kind: 'RUSH', reasonCode: 'LEAD_TIME' })).rejects.toThrow(PER_KIND)
    expect(await ask({ kind: 'HOLD', reasonCode: 'LEAD_TIME' })).toBeTruthy()
    await expect(ask({ kind: 'HOLD', requestedDate: NEXT_WEEK() })).rejects.toThrow(PER_KIND)
    await expect(ask({ kind: 'SAMPLE_ROUND', sampleKind: 'SIZE_SET', requestedDate: NEXT_WEEK() })).rejects.toThrow(PER_KIND)
    expect(await ask({ kind: 'SPLIT_SHIPMENT', requestedDate: NEXT_WEEK() })).toBeTruthy()
    await expect(ask({ kind: 'SPLIT_SHIPMENT', reasonCode: 'LEAD_TIME' })).rejects.toThrow(PER_KIND)
    const [address] = await admin(`SELECT id::text AS id FROM "PartyAddress" WHERE "partyId" = $1::uuid AND 'SHIP_TO' = ANY (kinds) AND status::text = 'ACTIVE' ORDER BY id LIMIT 1`, [P1])
    await expect(ask({ kind: 'RUSH', shipToAddressId: address!.id })).rejects.toThrow(PER_KIND)
    // A cancel keeps its own rule: a code, no date.
    await expect(ask({ kind: 'CANCEL' })).rejects.toThrow(/a cancel gives a code of the CANCEL reason list/)
  })

  it('the kind of round exactly on a sample round, one of the four a customer asks; the round it made only once accepted', async () => {
    await expect(ask({ kind: 'SAMPLE_ROUND' })).rejects.toThrow(PER_KIND)
    await expect(ask({ kind: 'SAMPLE_ROUND', sampleKind: 'PROTO' })).rejects.toThrow(PER_KIND)
    await expect(ask({ kind: 'CHANGE', sampleKind: 'SIZE_SET' })).rejects.toThrow(PER_KIND)
    for (const sampleKind of ['PRE_PRODUCTION', 'SIZE_SET', 'TOP_OF_PRODUCTION', 'BRAND']) expect(await ask({ kind: 'SAMPLE_ROUND', sampleKind })).toBeTruthy()
    // A new request names no round: the round comes with the office's acceptance.
    await expect(ask({ kind: 'SAMPLE_ROUND', sampleKind: 'PRE_PRODUCTION', sampleRoundId: samples.roundIds.pp })).rejects.toThrow(/a new change request is OPEN, unanswered, at version 1/)
    // Accepted, it names the round it made once: of the kind asked, for its customer, made after it was asked.
    const asked = await ask({ kind: 'SAMPLE_ROUND', sampleKind: 'SIZE_SET' })
    expect(await update(office(), 'OrderChangeRequest', asked, `status = 'ACCEPTED', "answeredAt" = now(), "answeredById" = $2::uuid, version = version + 1`, U.office)).toBe(1)
    await expect(update(office(), 'OrderChangeRequest', asked, `"sampleRoundId" = $2::uuid, version = version + 1`, samples.roundIds.pp)).rejects.toThrow(/names the sample round it made: of the kind asked/)
    const round = randomUUID()
    expect(await copyRow('SampleRound', samples.roundIds.fit, { id: round, number: `T-SR-${round.slice(0, 8)}`, kind: 'SIZE_SET', approvalRequestId: null, createdAt: await serverNow(), updatedAt: await serverNow() })).toBe(1)
    expect(await update(office(), 'OrderChangeRequest', asked, `"sampleRoundId" = $2::uuid, version = version + 1`, round)).toBe(1)
    await expect(update(office(), 'OrderChangeRequest', asked, `"sampleRoundId" = $2::uuid, version = version + 1`, samples.roundIds.fit)).rejects.toThrow(/never changes again/)
  })

  it('a PARTLY_SHIPPED order still asks a cancel, a rush, a pause or a resume; never a change', async () => {
    const shipped = await newOrder('PARTLY_SHIPPED')
    await expect(ask({ kind: 'CHANGE', orderId: shipped })).rejects.toThrow(/a PARTLY_SHIPPED order: a cancel, a rush, a pause or a resume/)
    await expect(ask({ kind: 'SPLIT_SHIPMENT', orderId: shipped })).rejects.toThrow(/a PARTLY_SHIPPED order/)
    expect(await ask({ kind: 'RUSH', orderId: shipped })).toBeTruthy()
    expect(await ask({ kind: 'HOLD', orderId: shipped })).toBeTruthy()
    expect(await ask({ kind: 'CANCEL', reasonCode: 'LEAD_TIME', reason: 'Seed: the rest is no longer needed.', orderId: shipped })).toBeTruthy()
    const shippedWhole = await newOrder('SHIPPED')
    await expect(ask({ kind: 'RUSH', orderId: shippedWhole })).rejects.toThrow(/is SHIPPED/)
  })

  it('a resume only of an order whose pause was accepted', async () => {
    const order = await newOrder()
    await expect(ask({ kind: 'RESUME', orderId: order })).rejects.toThrow(/whose pause was never accepted/)
    const pause = await ask({ kind: 'HOLD', orderId: order })
    await expect(ask({ kind: 'RESUME', orderId: order })).rejects.toThrow(/whose pause was never accepted/)
    expect(await update(office(), 'OrderChangeRequest', pause, `status = 'ACCEPTED', "answeredAt" = now(), "answeredById" = $2::uuid, version = version + 1`, U.office)).toBe(1)
    expect(await ask({ kind: 'RESUME', orderId: order })).toBeTruthy()
  })

  it('keeps the impact shown at Send: an object of words, dates and yes or no — no number, so never an amount — never changed', async () => {
    const shown = await ask({ kind: 'RUSH', impact: { priced: true, frozen: ['SIZES', 'COLOUR'], earliestDate: NEXT_WEEK(), words: { en: 'A price may apply' } } })
    await expect(ask({ kind: 'RUSH', impact: { priced: true, fee: { amount: 1500, currency: 'EUR' } } })).rejects.toThrow(/no number in it, so never an amount/)
    await expect(ask({ kind: 'RUSH', impact: { lines: [{ asked: 2 }] } })).rejects.toThrow(/no number in it/)
    await expect(ask({ kind: 'RUSH', impact: ['priced'] })).rejects.toThrow(/as a JSON object/)
    await expect(update(office(), 'OrderChangeRequest', shown, `impact = '{"priced": false}'::jsonb`)).rejects.toThrow(/never change/)
  })
})

// ---------------------------------------------------------------------------------------------------------------------------
describe('the batch of a bulk ask (L26, R-65)', () => {
  it('holds the requests of one customer and one kind, whatever the order; never changes', async () => {
    const batch = randomUUID()
    const first = await ask({ kind: 'HOLD', batchId: batch })
    expect(await ask({ kind: 'HOLD', batchId: batch, orderId: production.urgentAsk.orderId })).toBeTruthy()
    await expect(ask({ kind: 'CANCEL', reasonCode: 'LEAD_TIME', batchId: batch })).rejects.toThrow(BATCH)
    await expect(update(office(), 'OrderChangeRequest', first, `"batchId" = $2::uuid`, randomUUID())).rejects.toThrow(/never change/)
    await expect(update(office(), 'OrderChangeRequest', first, `"batchId" = NULL`)).rejects.toThrow(/never change/)
  })

  it('never spans two customers: the second brand cannot join P1’s batch, and the words name no other customer', async () => {
    const batch = randomUUID()
    await ask({ kind: 'HOLD', batchId: batch })
    const [order] = await admin(`SELECT "companyId"::text AS company FROM "SalesOrder" WHERE id = $1::uuid`, [second.salesOrderId])
    const theirs = { kind: 'HOLD', batchId: batch, partyId: second.partyId, companyId: order!.company, orderId: second.salesOrderId, shipToAddressId: null, createdById: second.userId }
    const refusal = await ask(theirs, partnerOf(second.partyId, second.userId)).catch((error: unknown) => error as Error)
    expect(refusal).toBeInstanceOf(Error)
    expect((refusal as Error).message).toMatch(BATCH)
    for (const named of [P1, 'Seed Racing', 'Brand Alpha']) expect((refusal as Error).message).not.toContain(named)
    // Their own batch, of their own customer, is theirs to make.
    expect(await ask({ ...theirs, batchId: randomUUID() }, partnerOf(second.partyId, second.userId))).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------------------------------------------------------
describe('the counter-offer', () => {
  it('the office counters an OPEN request with its COUNTER_OFFER approval; the customer’s yes makes it ACCEPTED', async () => {
    const asked = await ask({ kind: 'RUSH', requestedDate: NEXT_WEEK() })
    // The approval counters an OPEN change request of its own customer, by its record.
    await expect(approval({ kind: 'COUNTER_OFFER', recordType: 'SalesOrder', recordId: asked })).rejects.toThrow(/a COUNTER_OFFER request names a change request/)
    const counter = await approval({ kind: 'COUNTER_OFFER', recordType: 'OrderChangeRequest', recordId: asked })
    const countered = `status = 'COUNTERED', "counterApprovalId" = $2::uuid, "counteredAt" = now(), "counteredById" = $3::uuid, "counterDate" = $4::date, "counterNote" = 'Seed: two weeks sooner for a fee', version = version + 1`
    // Only the office counters (the partner cannot even name who countered).
    await expect(update(p1(), 'OrderChangeRequest', asked, `status = 'COUNTERED', "counterApprovalId" = $2::uuid, "counteredAt" = now(), version = version + 1`, counter)).rejects.toThrow(/the office counters change request|counter-offer/)
    await expect(update(office(), 'OrderChangeRequest', asked, `status = 'COUNTERED', version = version + 1`)).rejects.toThrow(/with the wrong counter-offer/)
    await expect(update(office(), 'OrderChangeRequest', asked, countered, samples.approvalRequestId, U.office, NEXT_WEEK())).rejects.toThrow(/countered by an OPEN COUNTER_OFFER approval request about it|foreign key/)
    await expect(update(office(), 'OrderChangeRequest', asked, countered, counter, U.suspended, NEXT_WEEK())).rejects.toThrow(/countered by an active office person/)
    await expect(update(office(), 'OrderChangeRequest', asked, `status = 'COUNTERED', "counterApprovalId" = $2::uuid, "counteredAt" = now(), "counteredById" = $3::uuid, version = version + 1`, counter, U.office)).rejects.toThrow(/at least one/)
    await expect(update(office(), 'OrderChangeRequest', asked, `status = 'COUNTERED', "counterApprovalId" = $2::uuid, "counteredAt" = now(), "counteredById" = $3::uuid, "counterFee" = -1, version = version + 1`, counter, U.office)).rejects.toThrow(/a fee of 0 or more/)
    await expect(update(office(), 'OrderChangeRequest', asked, `status = 'COUNTERED', "counterApprovalId" = $2::uuid, "counteredAt" = now(), "counteredById" = $3::uuid, "counterDate" = '2020-01-01', version = version + 1`, counter, U.office)).rejects.toThrow(/not before the day it was countered/)
    expect(await update(office(), 'OrderChangeRequest', asked, countered, counter, U.office, NEXT_WEEK())).toBe(1)
    // The counter is written once.
    await expect(update(office(), 'OrderChangeRequest', asked, `"counterNote" = 'other words', version = version + 1`)).rejects.toThrow(/changes only by its answer or its withdrawal/)
    // ACCEPTED exactly after the customer's yes.
    await expect(update(office(), 'OrderChangeRequest', asked, `status = 'ACCEPTED', "answeredAt" = now(), "answeredById" = $2::uuid, version = version + 1`, U.office)).rejects.toThrow(/ACCEPTED exactly when the customer said yes to its counter-offer/)
    // The customer answers the counter in the portal; the office records the request ACCEPTED (the customer never answers it).
    expect(await answerAs(p1(), counter, 'APPROVED', buyer)).toBe(1)
    await expect(update(p1(), 'OrderChangeRequest', asked, `status = 'ACCEPTED', "answeredAt" = now(), version = version + 1`)).rejects.toThrow(/the office answers change request/)
    await expect(update(office(), 'OrderChangeRequest', asked, `status = 'REFUSED', answer = 'No', "answeredAt" = now(), "answeredById" = $2::uuid, version = version + 1`, U.office)).rejects.toThrow(/ACCEPTED exactly when the customer said yes/)
    expect(await update(office(), 'OrderChangeRequest', asked, `status = 'ACCEPTED', "answeredAt" = now(), "answeredById" = $2::uuid, version = version + 1`, U.office)).toBe(1)
    // The counter stays, the customer reads it (never who countered).
    const [seen] = await sql(p1(), `SELECT status::text AS status, "counterApprovalId"::text AS counter, "counterNote" AS note, "counterDate" IS NOT NULL AS dated FROM "OrderChangeRequest" WHERE id = $1::uuid`, asked)
    expect(seen).toEqual({ status: 'ACCEPTED', counter, note: 'Seed: two weeks sooner for a fee', dated: true })
  })

  it('a refused counter-offer leaves the request to be withdrawn (or refused by us), never accepted; one counter per request', async () => {
    const asked = await ask({ kind: 'HOLD' })
    const counter = await approval({ kind: 'COUNTER_OFFER', recordType: 'OrderChangeRequest', recordId: asked })
    expect(await update(office(), 'OrderChangeRequest', asked, `status = 'COUNTERED', "counterApprovalId" = $2::uuid, "counteredAt" = now(), "counteredById" = $3::uuid, "counterFee" = 2500, version = version + 1`, counter, U.office)).toBe(1)
    // A second request cannot take the same counter-offer (one per request), nor may another counter be asked of this one.
    const other = await ask({ kind: 'HOLD' })
    await expect(update(office(), 'OrderChangeRequest', other, `status = 'COUNTERED', "counterApprovalId" = $2::uuid, "counteredAt" = now(), "counteredById" = $3::uuid, "counterFee" = 0, version = version + 1`, counter, U.office)).rejects.toThrow(/counterApprovalId|countered by an OPEN COUNTER_OFFER/)
    await expect(approval({ kind: 'COUNTER_OFFER', recordType: 'OrderChangeRequest', recordId: asked })).rejects.toThrow(/while it is OPEN/)
    expect(await answerAs(p1(), counter, 'REFUSED', buyer)).toBe(1)
    await expect(update(office(), 'OrderChangeRequest', asked, `status = 'ACCEPTED', "answeredAt" = now(), "answeredById" = $2::uuid, version = version + 1`, U.office)).rejects.toThrow(/ACCEPTED exactly when the customer said yes/)
    expect(await update(p1(), 'OrderChangeRequest', asked, `status = 'WITHDRAWN', "withdrawnAt" = now(), version = version + 1`)).toBe(1)
    await expect(update(office(), 'OrderChangeRequest', asked, `"counterFee" = 0, version = version + 1`)).rejects.toThrow(/never changes again/)
  })
})

// ---------------------------------------------------------------------------------------------------------------------------
describe('the lines of an ask', () => {
  it('a change asks a different number, or the same number in another colourway of the line’s own style', async () => {
    expect(line, 'a P1 order line whose style has two colourways').toBeTruthy()
    const change = await ask({ kind: 'CHANGE', orderId: line.orderId })
    expect(await cell(change, { orderLineId: line.id, quantityBefore: 2, quantity: 2, styleId: line.styleId, colourwayId: line.other })).toBeTruthy()
    await expect(cell(change, { orderLineId: line.id, size: 'X1', quantityBefore: 2, quantity: 2 })).rejects.toThrow(/a change a different number/)
    await expect(cell(change, { orderLineId: line.id, size: 'X2', quantityBefore: 2, quantity: 2, styleId: line.styleId, colourwayId: line.colourwayId })).rejects.toThrow(/another colourway only on a change/)
    await expect(cell(change, { orderLineId: line.id, size: 'X3', quantityBefore: 2, quantity: 3, colourwayId: line.other })).rejects.toThrow(/another colourway only on a change/)
    const cancel = await ask({ kind: 'CANCEL', reasonCode: 'LEAD_TIME', orderId: line.orderId })
    await expect(cell(cancel, { orderLineId: line.id, quantityBefore: 2, quantity: 0, styleId: line.styleId, colourwayId: line.other })).rejects.toThrow(/another colourway only on a change/)
  })

  it('a rush, a pause or a resume asks for the whole order; a split’s first part ships 1 to the pieces; a sample round names one line', async () => {
    for (const kind of ['RUSH', 'HOLD']) {
      const whole = await ask({ kind, orderId: line.orderId })
      await expect(cell(whole, { orderLineId: line.id, quantityBefore: 2, quantity: 2 })).rejects.toThrow(/a rush, a pause or a resume asks for the whole order/)
    }
    const split = await ask({ kind: 'SPLIT_SHIPMENT', orderId: line.orderId })
    await expect(cell(split, { orderLineId: line.id, quantityBefore: 2, quantity: 0 })).rejects.toThrow(/first part ships 1 to the pieces of each cell/)
    await expect(cell(split, { orderLineId: line.id, size: 'X4', quantityBefore: 2, quantity: 3 })).rejects.toThrow(/first part ships 1 to the pieces/)
    expect(await cell(split, { orderLineId: line.id, size: 'X5', quantityBefore: 2, quantity: 1 })).toBeTruthy()
    const round = await ask({ kind: 'SAMPLE_ROUND', sampleKind: 'SIZE_SET', orderId: line.orderId })
    expect(await cell(round, { orderLineId: line.id, quantityBefore: 2, quantity: 1 })).toBeTruthy()
    await expect(cell(round, { orderLineId: line.id, size: 'X6', quantityBefore: 2, quantity: 1 })).rejects.toThrow(/a sample round names one line/)
  })
})

// ---------------------------------------------------------------------------------------------------------------------------
describe('decided for the party and reversed (ApprovalRequest)', () => {
  const decide = (id: string, by: string, extra = '') =>
    update(office(), 'ApprovalRequest', id, `status = 'APPROVED', "typedName" = 'Otto Office', "answeredAt" = now(), "answerRequestId" = 'req-decide', "decidedForPartyById" = $2::uuid, "decidedForPartyReason" = 'Seed: the brand said yes on the phone'${extra}, version = version + 1`, by)

  it('exactly one answerer of three; never the person who asked; with why; an active office person', async () => {
    const asked = await approval({})
    const [row] = await admin(`SELECT "createdById"::text AS asker FROM "ApprovalRequest" WHERE id = $1::uuid`, [asked])
    expect(row!.asker).toBeTruthy()
    await expect(decide(asked, row!.asker as string)).rejects.toThrow(/decided for its party only by someone who did not ask it/)
    await expect(decide(asked, U.office, `, "answeredByUserId" = '${buyer}'`)).rejects.toThrow(/one answerer exactly when answered/)
    await expect(update(office(), 'ApprovalRequest', asked, `status = 'APPROVED', "typedName" = 'Otto Office', "answeredAt" = now(), "answerRequestId" = 'req-decide', "decidedForPartyById" = $2::uuid, version = version + 1`, U.office)).rejects.toThrow(/with why/)
    await expect(decide(asked, U.suspended)).rejects.toThrow(/decided for its party by an active office person/)
    // The partner never decides for itself (no grant on the column), and answers only as itself.
    await expect(run(p1(), `UPDATE "ApprovalRequest" SET "decidedForPartyById" = $2::uuid WHERE id = $1::uuid`, asked, U.office)).rejects.toThrow(DENIED)
    expect(await decide(asked, U.office)).toBe(1)
    const [seen] = await sql(p1(), `SELECT status::text AS status, "decidedForPartyReason" AS reason, "answeredByUserId" AS "user", "answeredViaLinkId" AS link FROM "ApprovalRequest" WHERE id = $1::uuid`, asked)
    expect(seen).toEqual({ status: 'APPROVED', reason: 'Seed: the brand said yes on the phone', user: null, link: null })
    // Nothing of a decision on a request that is not answered.
    const open = await approval({})
    await expect(update(office(), 'ApprovalRequest', open, `"decidedForPartyById" = $2::uuid, "decidedForPartyReason" = 'x'`, U.office)).rejects.toThrow(/one answerer exactly when answered/)
  })

  it('never on a concession, a revised order, a signature or a proof', async () => {
    const proof = await approval({ kind: 'PROOF', recordType: 'SalesOrderLine', recordId: randomUUID() })
    await expect(decide(proof, U.office)).rejects.toThrow(/never on a concession, a revised order, a signature or a proof/)
    const revised = await approval({ kind: 'REVISED_ORDER', recordType: 'SalesOrderAmendment', recordId: randomUUID() })
    await expect(decide(revised, U.office)).rejects.toThrow(/never on a concession, a revised order, a signature or a proof/)
  })

  it('reversed once, with when, by whom and why, only once answered; the answer itself never changes', async () => {
    const asked = await approval({})
    await expect(update(office(), 'ApprovalRequest', asked, `"reversedAt" = now(), "reversedById" = $2::uuid, "reverseReason" = 'too early'`, U.office)).rejects.toThrow(/only once answered/)
    expect(await answerAs(p1(), asked, 'APPROVED', buyer)).toBe(1)
    await expect(run(p1(), `UPDATE "ApprovalRequest" SET "reversedById" = $2::uuid WHERE id = $1::uuid`, asked, buyer)).rejects.toThrow(DENIED)
    await expect(update(p1(), 'ApprovalRequest', asked, `"reverseReason" = 'we changed our mind', "reversedAt" = now(), version = version + 1`)).rejects.toThrow(/never changes again|only answers/)
    await expect(update(office(), 'ApprovalRequest', asked, `"reversedAt" = now(), "reversedById" = $2::uuid, version = version + 1`, U.office)).rejects.toThrow(/reversed with when, by whom and why/)
    await expect(update(office(), 'ApprovalRequest', asked, `"reversedAt" = '2020-01-01T00:00:00Z', "reversedById" = $2::uuid, "reverseReason" = 'too early', version = version + 1`, U.office)).rejects.toThrow(/only once answered/)
    await expect(update(office(), 'ApprovalRequest', asked, `"reversedAt" = now(), "reversedById" = $2::uuid, "reverseReason" = 'too early', version = version + 1`, U.suspended)).rejects.toThrow(/reversed by an active office person/)
    await expect(update(office(), 'ApprovalRequest', asked, `"reversedAt" = now(), "reversedById" = $2::uuid, "reverseReason" = 'too early', answer = 'other words', version = version + 1`, U.office)).rejects.toThrow(/never changes again/)
    expect(await update(office(), 'ApprovalRequest', asked, `"reversedAt" = now(), "reversedById" = $2::uuid, "reverseReason" = 'Seed: approved too early', version = version + 1`, U.office)).toBe(1)
    await expect(update(office(), 'ApprovalRequest', asked, `"reverseReason" = 'other words', version = version + 1`)).rejects.toThrow(/never changes again/)
    await expect(update(office(), 'ApprovalRequest', asked, `status = 'REFUSED', version = version + 1`)).rejects.toThrow(/never changes again/)
    const [seen] = await sql(p1(), `SELECT status::text AS status, "reverseReason" AS reason, "reversedAt" IS NOT NULL AS reversed FROM "ApprovalRequest" WHERE id = $1::uuid`, asked)
    expect(seen).toEqual({ status: 'APPROVED', reason: 'Seed: approved too early', reversed: true })
    const proof = await approval({ kind: 'PROOF', recordType: 'SalesOrderLine', recordId: randomUUID() })
    expect(await answerAs(p1(), proof, 'APPROVED', buyer)).toBe(1)
    await expect(update(office(), 'ApprovalRequest', proof, `"reversedAt" = now(), "reversedById" = $2::uuid, "reverseReason" = 'too early', version = version + 1`, U.office)).rejects.toThrow(/never on a concession, a revised order, a signature or a proof/)
  })

  it('a REPROMISE asks about a sales order of its own customer', async () => {
    await expect(approval({ kind: 'REPROMISE', recordType: 'OrderChangeRequest', recordId: sales.changes.open })).rejects.toThrow(/a REPROMISE request names a sales order/)
    await expect(approval({ kind: 'REPROMISE', recordType: 'SalesOrder', recordId: second.salesOrderId })).rejects.toThrow(/of its own company and customer/)
    expect(await approval({ kind: 'REPROMISE', recordType: 'SalesOrder', recordId: production.urgentAsk.orderId })).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------------------------------------------------------
describe('the new sample kinds: fabric and trim swatches, size set and top of production rounds, the size set gate', () => {
  const material = async (code: string) => (await admin(`SELECT id::text AS id FROM "Item" WHERE "tenantId" = $1::uuid AND code = $2`, [a.tenantId, code]))[0]!.id as string
  const colourOf = async (itemId: string, code: string) => (await admin(`SELECT id::text AS id FROM "ItemColour" WHERE "itemId" = $1::uuid AND code = $2`, [itemId, code]))[0]!.id as string
  const swatch = (changes: Record<string, unknown>) => copyRow('SampleSwatch', samples.swatchIds.colour, { id: randomUUID(), sentAt: null, approvalRequestId: null, decision: null, decisionComments: null, decidedAt: null, decidedVia: null, decidedById: null, ...changes })

  it('a FABRIC swatch is of a textile, lining, membrane or padding; a TRIM swatch of a trim, hardware, thread or label', async () => {
    const lining = await material('SEED-LIN-200')
    const leather = await material('SEED-LEA-100')
    expect(await swatch({ kind: 'FABRIC', itemId: lining, itemColourId: await colourOf(lining, 'GRY'), lotSiteId: null, lotId: null })).toBe(1)
    await expect(swatch({ kind: 'FABRIC', itemId: leather, itemColourId: await colourOf(leather, 'BLK'), lotSiteId: null, lotId: null })).rejects.toThrow(/a FABRIC swatch .* is of a textile, lining, membrane or padding/)
    await expect(swatch({ kind: 'TRIM', itemId: lining, itemColourId: await colourOf(lining, 'GRY'), lotSiteId: null, lotId: null })).rejects.toThrow(/a TRIM swatch .* is of a trim, hardware, thread or label/)
    // The leather rule stands as it was.
    await expect(swatch({ kind: 'LEATHER', itemId: lining, itemColourId: await colourOf(lining, 'GRY'), lotSiteId: null, lotId: null })).rejects.toThrow(/a LEATHER swatch .* is of a leather material/)
  })

  it('size set and top of production rounds; a SIZE_SET gate waits for a SIZE_SET round, one per order', async () => {
    const at = await serverNow()
    const sizeSet = randomUUID()
    expect(await copyRow('SampleRound', samples.roundIds.fit, { id: sizeSet, number: `T-SR-${sizeSet.slice(0, 8)}`, kind: 'SIZE_SET', approvalRequestId: null, createdAt: at, updatedAt: at })).toBe(1)
    const top = randomUUID()
    expect(await copyRow('SampleRound', samples.roundIds.fit, { id: top, number: `T-SR-${top.slice(0, 8)}`, kind: 'TOP_OF_PRODUCTION', approvalRequestId: null, createdAt: at, updatedAt: at })).toBe(1)
    const gate = (salesOrderId: string, changes: Record<string, unknown>) =>
      copyRow('OrderGate', samples.gateIds.other, { id: randomUUID(), salesOrderId, label: null, passedAt: null, passedById: null, overriddenAt: null, overriddenById: null, overrideReason: null, ...changes })
    const order = await newOrder()
    expect(await gate(order, { kind: 'SIZE_SET', sampleRoundId: sizeSet })).toBe(1)
    await expect(gate(order, { kind: 'SIZE_SET', sampleRoundId: null })).rejects.toThrow(/OrderGate_one_per_kind|duplicate key/)
    const another = await newOrder()
    await expect(gate(another, { kind: 'SIZE_SET', sampleRoundId: samples.roundIds.pp })).rejects.toThrow(/waits for a SIZE_SET round/)
    await expect(gate(another, { kind: 'PP_SAMPLE', sampleRoundId: sizeSet })).rejects.toThrow(/waits for a PRE_PRODUCTION round/)
    await expect(gate(another, { kind: 'LAB_PASSED', sampleRoundId: sizeSet })).rejects.toThrow(/only a sample gate \(SAMPLE_APPROVED, PP_SAMPLE, SIZE_SET\) names a sample round/)
    // It passes once its round is approved (the size set round is not decided yet).
    const [made] = await admin(`SELECT id::text AS id FROM "OrderGate" WHERE "salesOrderId" = $1::uuid AND kind::text = 'SIZE_SET'`, [order])
    await expect(update(office(), 'OrderGate', made!.id as string, `"passedAt" = now(), "passedById" = $2::uuid`, U.office)).rejects.toThrow(/passes once its sample round is approved/)
  })
})
