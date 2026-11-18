import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedBrandProduction, type BrandProductionSeed } from '../seed/brand-production'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedPortalSales, type PortalSalesSeed } from '../seed/portal-sales'
import { seed as seedSamples, type SamplesSeed } from '../seed/samples'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'

/**
 * B-PR-40 (production plan, schema wave 5/5): on a database built from the migrations and seeded (portal-sales: P1's change
 * requests; brand-production: SEED-SO-0004; samples: SEED-SR-0003 under review with its OPEN SAMPLE approval and the PP_SAMPLE
 * gate of SEED-SO-0002, whose work order is cut and bundled by the production seed), through the real login and the scoped
 * client, for every login:
 *   - …_production_wave5_schema / _guards: the old progress switch is gone (brand-limits.pg holds the level's own rule);
 *   - …_production_wave5_samples_guards (EXTRA 1): a DECIDED round goes back UNDER_REVIEW, a decided swatch is undecided and a
 *     gate passed by its round waits again ONLY by the reversal of the approval request whose answer decided them (and a gate
 *     only before work starts on its order); refused otherwise, with nothing else changed;
 *   - …_production_wave5_counter_guards (EXTRA 2): a COUNTERED request whose counter's yes was put back is refused (or
 *     withdrawn), never accepted; before that reversal it is accepted, never refused.
 * The refusals are check_violation (SQLSTATE 23514); their messages are read through raw SQL. Not run in the build (Owner rule
 * 2026-11-17: checks at the end).
 */

const NS = 'pr40-wave5'
const ROUND_BACK = /a decided round goes back under review only by the reversal of the approval request that decided it/
const SWATCH_BACK = /it is undecided again only by the reversal of the approval request that decided it/
const GATE_BACK = /waits again only by the reversal of the round's approval, before work starts on its order/
const COUNTER_YES = /ACCEPTED exactly when the customer said yes to its counter-offer, a yes we did not put back/

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let sales: PortalSalesSeed
let production: BrandProductionSeed
let samples: SamplesSeed

const key = (name: string): string => seedUuid(NS, name)
const P1 = key('party:P1')
const buyer = key('portal:user:P1:buyer')
const office = (): FactoryScope => ({ audience: 'office', tenantId: a.tenantId, actorId: a.actorId })
const p1 = (): FactoryScope => ({ audience: 'partner', tenantId: a.tenantId, actorId: buyer, partyId: P1 })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const run = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$executeRawUnsafe(text, ...values))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, unknown>[]
const update = (scope: FactoryScope, table: string, id: string, set: string, ...values: unknown[]) => run(scope, `UPDATE "${table}" SET ${set} WHERE id = $1::uuid`, id, ...values)
/** The columns the partner role may not write, of the tables a partner copies here (ownership/*.json). */
const PARTNER_HIDDEN: Readonly<Record<string, readonly string[]>> = { OrderChangeRequest: ['answeredById', 'counteredById'] }
/** INSERT a copy of row `id` of `table` with `changes`, in `scope` (brand-asks.pg's helper: a partner writes its granted columns). */
async function copyRow(table: string, id: string, changes: Record<string, unknown>, scope: FactoryScope = office()): Promise<number> {
  const [source] = await admin(`SELECT to_jsonb(r) AS row FROM "${table}" r WHERE r.id = $1::uuid`, [id])
  const hidden = scope.audience === 'partner' ? (PARTNER_HIDDEN[table] ?? []) : []
  const names = await admin(`SELECT column_name AS name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`, [table])
  const columns = names.map((row) => row.name as string).filter((name) => !hidden.includes(name)).map((name) => `"${name}"`).join(', ')
  return run(scope, `INSERT INTO "${table}" (${columns}) SELECT ${columns} FROM jsonb_populate_record(NULL::"${table}", $1::jsonb)`, JSON.stringify({ ...(source!.row as object), ...changes }))
}
/** The same copy as the owner with every trigger off (set-up only). */
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
/** The database server's clock, `ms` later (the container's clock drifts from the host's). */
const serverNow = async (ms = 0): Promise<string> =>
  ((await admin(`SELECT clock_timestamp() + $1::int * interval '1 millisecond' AS at`, [ms]))[0]!.at as Date).toISOString()
const NEXT_WEEK = () => new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10)
const insert = (scope: FactoryScope, table: string, row: Record<string, unknown>) => {
  const columns = Object.keys(row).map((column) => `"${column}"`).join(', ')
  return run(scope, `INSERT INTO "${table}" (${columns}) SELECT ${columns} FROM jsonb_populate_record(NULL::"${table}", $1::jsonb)`, JSON.stringify(row))
}
/** An ACTIVE office person of the tenant; returns its id. */
const person = async (): Promise<string> => {
  const id = randomUUID()
  await insert(office(), 'User', { id, email: `u.${id}@example.com`, displayName: 'Test Person', status: 'ACTIVE' })
  return id
}
/** A CONFIRMED order of P1 with no line (a copy of SEED-SO-0004): nothing can have started on it. */
const newOrder = async (): Promise<string> => {
  const id = randomUUID()
  await plant('SalesOrder', production.urgentAsk.orderId, { id, number: `T-PR40-${id.slice(0, 8)}`, customerSeq: null, status: 'CONFIRMED' })
  return id
}
/** An OPEN approval request of P1 made by the office from the seed's SAMPLE one, with `changes`. */
async function approval(changes: Record<string, unknown>): Promise<string> {
  const id = randomUUID()
  const at = await serverNow()
  await copyRow('ApprovalRequest', samples.approvalRequestId, { id, createdAt: at, updatedAt: at, dueAt: `${NEXT_WEEK()}T12:00:00.000Z`, version: 1, ...changes })
  return id
}
const answerAs = (id: string, status: 'APPROVED' | 'REFUSED') =>
  update(p1(), 'ApprovalRequest', id, `status = '${status}', answer = ${status === 'REFUSED' ? `'Made-up: too dark'` : 'NULL'}, "typedName" = 'Bea Buyer', "answeredAt" = now(), "answeredByUserId" = $2::uuid, "answerRequestId" = 'req-pr40', version = version + 1`, buyer)
const reverse = (id: string, by: string) => update(office(), 'ApprovalRequest', id, `"reversedAt" = now(), "reversedById" = $2::uuid, "reverseReason" = 'Made-up: the photos were of another sample', version = version + 1`, by)
/** The record decided as its request's portal answer: the same decision, at the answer's time, by the portal person. */
const decidedAsAnswer = (decision: 'APPROVED' | 'REJECTED', request: string) =>
  `decision = '${decision}', "decisionComments" = ${decision === 'REJECTED' ? `'Made-up: too dark'` : 'NULL'}, "decidedAt" = (SELECT "answeredAt" FROM "ApprovalRequest" WHERE id = '${request}'::uuid), "decidedVia" = 'PORTAL', "decidedById" = '${buyer}'::uuid, "approvalRequestId" = '${request}'::uuid, version = version + 1`
const CLEARED = `decision = NULL, "decisionComments" = NULL, "decidedAt" = NULL, "decidedVia" = NULL, "decidedById" = NULL, version = version + 1`
const roundOf = async (id: string) => (await admin(`SELECT stage::text AS stage, decision::text AS decision, "decidedAt" IS NOT NULL AS dated FROM "SampleRound" WHERE id = $1`, [id]))[0]
/** A new PRE_PRODUCTION round of P1, under review (a copy of SEED-SR-0003), asked with a SAMPLE request of its own. */
async function askedRound(): Promise<{ round: string; request: string }> {
  const round = randomUUID()
  const at = await serverNow()
  expect(await copyRow('SampleRound', samples.roundIds.pp, { id: round, number: `T-SR-${round.slice(0, 8)}`, approvalRequestId: null, createdAt: at, updatedAt: at })).toBe(1)
  const request = await approval({ kind: 'SAMPLE', recordType: 'SampleRound', recordId: round })
  expect(await update(office(), 'SampleRound', round, `"approvalRequestId" = $2::uuid, version = version + 1`, request)).toBe(1)
  return { round, request }
}

const U = { office: '' }

beforeAll(async () => {
  db = await migratedDatabase('wave5')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: NS })
  sales = await seedPortalSales({ db: factory, namespace: NS })
  production = await seedBrandProduction({ db: factory, namespace: NS })
  samples = await seedSamples({ db: factory, namespace: NS })
  U.office = await person()
}, 1_500_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 120_000)

// ---------------------------------------------------------------------------------------------------------------------------
describe('the old progress switch goes (…_production_wave5_schema)', () => {
  it('PortalSettings has no progressShared column; the level alone, and the guard no longer names the switch', async () => {
    expect(await admin(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'PortalSettings' AND column_name = 'progressShared'`)).toEqual([{ n: 0 }])
    const [body] = await admin(`SELECT prosrc FROM pg_proc WHERE proname = 'factory_portal_settings_guard'`)
    expect(String(body!.prosrc)).not.toContain('progressShared')
    expect(String(body!.prosrc)).toContain('production progress is shared only with a customer or a brand')
  })
})

describe('a sample decision put back (…_production_wave5_samples_guards, EXTRA 1)', () => {
  it('a DECIDED round goes back UNDER_REVIEW, its decision cleared and nothing else, only by the reversal of the request that decided it', async () => {
    const { round, request } = await askedRound()
    expect(await answerAs(request, 'APPROVED')).toBe(1)
    expect(await update(office(), 'SampleRound', round, `stage = 'DECIDED', ${decidedAsAnswer('APPROVED', request)}`)).toBe(1)
    // Before the reversal: refused, for every login (the owner included).
    await expect(update(office(), 'SampleRound', round, `stage = 'UNDER_REVIEW', ${CLEARED}`)).rejects.toThrow(ROUND_BACK)
    await expect(admin(`UPDATE "SampleRound" SET stage = 'UNDER_REVIEW', ${CLEARED} WHERE id = $1`, [round])).rejects.toThrow(ROUND_BACK)
    expect(await reverse(request, U.office)).toBe(1)
    // After it: only back to UNDER_REVIEW, the decision cleared, nothing else changed with it.
    await expect(update(office(), 'SampleRound', round, `stage = 'SENT', ${CLEARED}`)).rejects.toThrow(ROUND_BACK)
    await expect(update(office(), 'SampleRound', round, `stage = 'UNDER_REVIEW', ${CLEARED}, instructions = 'Made-up: other words'`)).rejects.toThrow(ROUND_BACK)
    await expect(update(office(), 'SampleRound', round, `stage = 'UNDER_REVIEW', version = version + 1`)).rejects.toThrow(/DECIDED exactly with its decision|goes back under review/)
    await expect(update(office(), 'SampleRound', round, `stage = 'UNDER_REVIEW', decision = NULL, version = version + 1`)).rejects.toThrow(/no decision yet: no words, time, way or decider/)
    expect(await update(office(), 'SampleRound', round, `stage = 'UNDER_REVIEW', ${CLEARED}`)).toBe(1)
    expect(await roundOf(round)).toEqual({ stage: 'UNDER_REVIEW', decision: null, dated: false })
    // It still names the reversed request; asked again with a new one, the brand's new yes decides it again.
    const again = await approval({ kind: 'SAMPLE', recordType: 'SampleRound', recordId: round })
    expect(await update(office(), 'SampleRound', round, `"approvalRequestId" = $2::uuid, version = version + 1`, again)).toBe(1)
    expect(await answerAs(again, 'APPROVED')).toBe(1)
    expect(await update(office(), 'SampleRound', round, `stage = 'DECIDED', ${decidedAsAnswer('APPROVED', again)}`)).toBe(1)
    // That decision is the new request's: the old reversal never opens it again.
    await expect(update(office(), 'SampleRound', round, `stage = 'UNDER_REVIEW', ${CLEARED}, "approvalRequestId" = $2::uuid`, request)).rejects.toThrow(ROUND_BACK)
  })

  it('a decision that is not the request\'s answer (recorded at another time) stays, the request reversed or not', async () => {
    const { round, request } = await askedRound()
    expect(await answerAs(request, 'REFUSED')).toBe(1)
    // An office decision on the same request, a minute later than the answer (the database allows an OFFICE decision with it).
    expect(await update(office(), 'SampleRound', round, `stage = 'DECIDED', decision = 'REJECTED', "decisionComments" = 'Made-up: ours', "decidedAt" = now() + interval '1 minute', "decidedVia" = 'OFFICE', "decidedById" = $2::uuid, version = version + 1`, U.office)).toBe(1)
    expect(await reverse(request, U.office)).toBe(1)
    await expect(update(office(), 'SampleRound', round, `stage = 'UNDER_REVIEW', ${CLEARED}`)).rejects.toThrow(ROUND_BACK)
    expect(await roundOf(round)).toEqual({ stage: 'DECIDED', decision: 'REJECTED', dated: true })
  })

  it('a decided swatch is undecided, its decision cleared and nothing else, only by that reversal; otherwise only its note changes', async () => {
    const swatch = randomUUID()
    expect(await copyRow('SampleSwatch', samples.swatchIds.colour, { id: swatch, sentAt: await serverNow(-60_000), approvalRequestId: null, decision: null, decisionComments: null, decidedAt: null, decidedVia: null, decidedById: null })).toBe(1)
    const request = await approval({ kind: 'COLOUR', recordType: 'SampleSwatch', recordId: swatch })
    expect(await update(office(), 'SampleSwatch', swatch, `"approvalRequestId" = $2::uuid, version = version + 1`, request)).toBe(1)
    expect(await answerAs(request, 'APPROVED')).toBe(1)
    expect(await update(office(), 'SampleSwatch', swatch, decidedAsAnswer('APPROVED', request))).toBe(1)
    await expect(update(office(), 'SampleSwatch', swatch, CLEARED)).rejects.toThrow(SWATCH_BACK)
    expect(await update(office(), 'SampleSwatch', swatch, `note = 'Made-up: approved in daylight', version = version + 1`)).toBe(1)
    expect(await reverse(request, U.office)).toBe(1)
    await expect(update(office(), 'SampleSwatch', swatch, `${CLEARED}, note = 'Made-up: other words'`)).rejects.toThrow(SWATCH_BACK)
    expect(await update(office(), 'SampleSwatch', swatch, CLEARED)).toBe(1)
    expect((await admin(`SELECT decision::text AS decision, "decidedAt", "approvalRequestId"::text AS request FROM "SampleSwatch" WHERE id = $1`, [swatch]))[0]).toEqual({ decision: null, decidedAt: null, request })
  })

  it('a gate passed by its round waits again only once the round is back by that reversal, and only before work starts on its order', async () => {
    const gate = async (salesOrderId: string, sampleRoundId: string) => {
      const id = randomUUID()
      expect(await copyRow('OrderGate', samples.gateIds.other, { id, salesOrderId, kind: 'PP_SAMPLE', sampleRoundId, label: null, passedAt: null, passedById: null, overriddenAt: null, overriddenById: null, overrideReason: null })).toBe(1)
      return id
    }
    const WAITS = `"passedAt" = NULL, "passedById" = NULL, version = version + 1`
    // An order nothing started on (no line): the gate waits again after the reversal and the round's return.
    const { round, request } = await askedRound()
    const fresh = await gate(await newOrder(), round)
    expect(await answerAs(request, 'APPROVED')).toBe(1)
    expect(await update(office(), 'SampleRound', round, `stage = 'DECIDED', ${decidedAsAnswer('APPROVED', request)}`)).toBe(1)
    expect(await update(office(), 'OrderGate', fresh, `"passedAt" = now(), "passedById" = $2::uuid, version = version + 1`, U.office)).toBe(1)
    await expect(update(office(), 'OrderGate', fresh, WAITS)).rejects.toThrow(GATE_BACK)
    expect(await reverse(request, U.office)).toBe(1)
    // The round still decided: the gate keeps its pass (the round goes back first).
    await expect(update(office(), 'OrderGate', fresh, WAITS)).rejects.toThrow(GATE_BACK)
    expect(await update(office(), 'SampleRound', round, `stage = 'UNDER_REVIEW', ${CLEARED}`)).toBe(1)
    await expect(update(office(), 'OrderGate', fresh, `${WAITS}, label = 'Made-up: other words'`)).rejects.toThrow(GATE_BACK)
    expect(await update(office(), 'OrderGate', fresh, WAITS)).toBe(1)
    expect((await admin(`SELECT "passedAt", "passedById" FROM "OrderGate" WHERE id = $1`, [fresh]))[0]).toEqual({ passedAt: null, passedById: null })

    // SEED-SO-0002, cut and bundled (the production seed): its PP_SAMPLE gate keeps its pass, the round goes back all the same.
    const pp = samples.roundIds.pp
    expect(await answerAs(samples.approvalRequestId, 'APPROVED')).toBe(1)
    expect(await update(office(), 'SampleRound', pp, `stage = 'DECIDED', ${decidedAsAnswer('APPROVED', samples.approvalRequestId)}`)).toBe(1)
    expect(await update(office(), 'OrderGate', samples.gateIds.pp, `"passedAt" = now(), "passedById" = $2::uuid, version = version + 1`, U.office)).toBe(1)
    expect(await reverse(samples.approvalRequestId, U.office)).toBe(1)
    expect(await update(office(), 'SampleRound', pp, `stage = 'UNDER_REVIEW', ${CLEARED}`)).toBe(1)
    await expect(update(office(), 'OrderGate', samples.gateIds.pp, WAITS)).rejects.toThrow(GATE_BACK)
    expect((await admin(`SELECT "passedAt" IS NOT NULL AS passed FROM "OrderGate" WHERE id = $1`, [samples.gateIds.pp]))[0]).toEqual({ passed: true })
  })
})

describe("a counter-offer's yes put back (…_production_wave5_counter_guards, EXTRA 2)", () => {
  /** A new OPEN request of P1 (a copy of the seed's OPEN change, by its buyer), countered by the office; returns both ids. */
  async function countered(): Promise<{ asked: string; counter: string }> {
    const asked = randomUUID()
    const at = await serverNow()
    await copyRow('OrderChangeRequest', sales.changes.open, { id: asked, createdAt: at, updatedAt: at }, p1())
    const counter = await approval({ kind: 'COUNTER_OFFER', recordType: 'OrderChangeRequest', recordId: asked })
    expect(await update(office(), 'OrderChangeRequest', asked, `status = 'COUNTERED', "counterApprovalId" = $2::uuid, "counteredAt" = now(), "counteredById" = $3::uuid, "counterDate" = $4::date, version = version + 1`, counter, U.office, NEXT_WEEK())).toBe(1)
    return { asked, counter }
  }
  const REFUSE = `status = 'REFUSED', answer = 'Made-up: we keep the order as it is', "answeredAt" = now(), "answeredById" = $2::uuid, version = version + 1`
  const ACCEPT = `status = 'ACCEPTED', "answeredAt" = now(), "answeredById" = $2::uuid, version = version + 1`

  it('after the yes: accepted, never refused; once the yes is put back: refused, never accepted', async () => {
    const { asked, counter } = await countered()
    expect(await answerAs(counter, 'APPROVED')).toBe(1)
    await expect(update(office(), 'OrderChangeRequest', asked, REFUSE, U.office)).rejects.toThrow(COUNTER_YES)
    expect(await reverse(counter, U.office)).toBe(1)
    await expect(update(office(), 'OrderChangeRequest', asked, ACCEPT, U.office)).rejects.toThrow(COUNTER_YES)
    await expect(admin(`UPDATE "OrderChangeRequest" SET ${ACCEPT} WHERE id = $1`, [asked, U.office])).rejects.toThrow(COUNTER_YES)
    expect(await update(office(), 'OrderChangeRequest', asked, REFUSE, U.office)).toBe(1)
    expect((await admin(`SELECT status::text AS status FROM "OrderChangeRequest" WHERE id = $1`, [asked]))[0]).toEqual({ status: 'REFUSED' })
  })

  it('a yes put back lets the customer withdraw it too (the partner reads the reversal); a yes that stands is accepted', async () => {
    const first = await countered()
    expect(await answerAs(first.counter, 'APPROVED')).toBe(1)
    expect(await reverse(first.counter, U.office)).toBe(1)
    expect(await update(p1(), 'OrderChangeRequest', first.asked, `status = 'WITHDRAWN', "withdrawnAt" = now(), version = version + 1`)).toBe(1)
    const second = await countered()
    expect(await answerAs(second.counter, 'APPROVED')).toBe(1)
    await expect(update(p1(), 'OrderChangeRequest', second.asked, `status = 'WITHDRAWN', "withdrawnAt" = now(), version = version + 1`)).rejects.toThrow(COUNTER_YES)
    expect(await update(office(), 'OrderChangeRequest', second.asked, ACCEPT, U.office)).toBe(1)
  })
})
