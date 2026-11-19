import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedChanges, type ChangesSeed } from '../seed/changes'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedCutting, type CuttingSeed } from '../seed/cutting'
import { seed as seedOrderApply, type OrderApplySeed } from '../seed/order-apply'
import { seed as seedPortalAuth, type PortalAuthSeed } from '../seed/portal-auth'
import { seed as seedPortalSales, type PortalSalesSeed } from '../seed/portal-sales'
import { seed as seedProduction, type ProductionSeed } from '../seed/production'
import { seed as seedSales, type SalesSeed } from '../seed/sales'
import { seed as seedTwoBrands, type TwoBrandsSeed } from '../seed/two-brands'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'

/**
 * B-SA-005 (sales page plan, schema wave "sales page 1/1"; lead picks P6', P7', P21, P26, R1, R3, R10): the wave's rules
 * (…_order_apply_guards), on a database built from the migrations and seeded, through the real login and the scoped client,
 * for every login. Two customers of tenant A: Brand Alpha (P1, the seeds' customer and brand: SEED-SO-0002, SEED-WO-0001, its
 * private-label style SEED-JKT-01) and Brand Beta (Seed Brand Two of seed/two-brands.ts: SEED-SO-B001, SEED-WO-B001, its own
 * label SEED-JKT-B2).
 *   - items 1, 2: a DESIGN request needs their words and at least one line (each once, as a whole, the pieces as they are); its
 *     files only on a DESIGN request, 0 to 10, each once, of its own order and customer, never changed;
 *   - item 5: the ask's own message — P1's INBOUND message on its own order's thread — named with the ask or once while it
 *     waits, never changed; one request per message; Beta's message never (the reference holds the party);
 *   - item 3: a product change request names a DESIGN request only from that customer, for its own private-label style of one
 *     of the request's lines, set once — Brand Beta's request never links Brand Alpha's style;
 *   - item 6: a message is about a part of its thread's own order, written once; a shared one never about a work order;
 *   - item 4: WorkOrderChange is office only, of the order's customer and a work order of that customer, its cells of its own
 *     order and work order; PROPOSED → APPLIED | DECLINED | STALE once, then frozen;
 *   - item 7: a RELEASED or IN_PROGRESS work order's cell goes down to what is cut, bundled or on a cut order, never below it and
 *     never up, and goes only when none of that is left; its planned materials follow it down; a DRAFT as before.
 * The refusals are check_violation (SQLSTATE 23514; a reference a foreign_key_violation, a grant "permission denied"); their
 * messages are read through raw SQL and name no customer. Not run in the build (Owner rule 2026-11-17: checks at the end).
 */

const NS = 'sa05-order-apply'
const DENIED = /permission denied/
const RLS = /row-level security/
const FROZEN = /its size quantities are frozen \(MES-005\)/
const MATERIALS_FROZEN = /its planned materials are frozen \(MES-005\)/
const BELOW = (floor: number) => new RegExp(`goes down only to what is already cut, bundled or on a cut order \\(${floor}\\), never below it`)
const DESIGN_WORDS = /a design change says in their words what should change/
const DESIGN_LINES = /names each of its lines once, as a whole \(no size\), the pieces as they are/
const OWN_FILES = /sends only available files of its own order or of its lines, shared with its own customer/
const ASK_MESSAGE = /names as its ask the customer's own message in its order's conversation/
const OWN_LABEL = /only for a style of that customer's own private label/
const ABOUT_SHAPE = /names what it is about by kind and id, both or neither/
const NOT_A_PART = /is about a part of its own order \(not a part of this record\)/

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let portal: PortalAuthSeed
let sales: PortalSalesSeed
let quotes: SalesSeed
let production: ProductionSeed
let changes: ChangesSeed
let cutting: CuttingSeed
let two: TwoBrandsSeed
let applied: OrderApplySeed

const key = (name: string): string => seedUuid(NS, name)
const P1 = key('party:P1')
const companyA = key('company:A')
const siteA1 = key('site:A1')
const office = (): FactoryScope => ({ audience: 'office', tenantId: a.tenantId, actorId: a.actorId })
const p1 = (): FactoryScope => ({ audience: 'partner', tenantId: a.tenantId, actorId: portal.userIds.p1Buyer, partyId: P1 })
const beta = (): FactoryScope => ({ audience: 'partner', tenantId: a.tenantId, actorId: two.portalUserIds.buyer, partyId: two.second.partyId })
const floor = (): FactoryScope => ({ audience: 'floor', tenantId: a.tenantId, actorId: randomUUID(), siteId: a.sites[0]!.id })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const run = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$executeRawUnsafe(text, ...values))
const sql = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$queryRawUnsafe<Record<string, unknown>[]>(text, ...values))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, unknown>[]
const update = (scope: FactoryScope, table: string, id: string, set: string, ...values: unknown[]) => run(scope, `UPDATE "${table}" SET ${set} WHERE id = $1::uuid`, id, ...values)
const insertSql = (table: string, row: Record<string, unknown>): [string, string] => {
  const columns = Object.keys(row).map((column) => `"${column}"`).join(', ')
  return [`INSERT INTO "${table}" (${columns}) SELECT ${columns} FROM jsonb_populate_record(NULL::"${table}", $1::jsonb)`, JSON.stringify(row)]
}
const insert = (scope: FactoryScope, table: string, row: Record<string, unknown>) => run(scope, ...insertSql(table, row))
/** Several inserts in ONE transaction of `scope` (a deferred check runs at its commit). */
const together = (scope: FactoryScope, rows: readonly [string, Record<string, unknown>][]) =>
  as(scope, (client) =>
    client.$transaction(async (tx) => {
      for (const [table, row] of rows) await tx.$executeRawUnsafe(...insertSql(table, row))
    }),
  )
/** INSERT a copy of row `id` of `table` with `changes`, as the office (every column: the office has no hidden one here). */
const copyRow = (table: string, id: string, changes: Record<string, unknown>, scope: FactoryScope = office()) =>
  run(scope, `INSERT INTO "${table}" SELECT * FROM jsonb_populate_record(NULL::"${table}", (SELECT to_jsonb(r) || $1::jsonb FROM "${table}" r WHERE r.id = $2::uuid))`, JSON.stringify(changes), id)
/** The same copy as the owner with every trigger off (set-up only: another customer's rows, a state reached only with time). */
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
const tag = (prefix = 'T-SA5'): string => `${prefix}-${randomUUID().slice(0, 8)}`
/** The refusal's words, or null when it passed. */
const refusalOf = (work: Promise<unknown>): Promise<string | null> => work.then(() => null, (error: Error) => error.message)
/** Neutral words: no customer id, code or name in a refusal (the brand wall). */
async function expectNeutral(words: string | null): Promise<void> {
  expect(words).not.toBeNull()
  const parties = await admin(`SELECT id::text AS id, code, "legalName" AS legal, coalesce("tradeName", '') AS trade FROM "Party" WHERE id IN ($1::uuid, $2::uuid)`, [P1, two.second.partyId])
  for (const party of parties) for (const word of [party.id, party.code, party.legal, party.trade].map(String).filter((entry) => entry.length > 0)) expect(words).not.toContain(word)
}
/** An ACTIVE office person of the tenant; returns its id. */
const person = async (): Promise<string> => {
  const id = randomUUID()
  await insert(office(), 'User', { id, email: `u.${id}@example.com`, displayName: 'Test Person', status: 'ACTIVE' })
  return id
}
/** A thread of `recordType` `recordId` (made once, as the office's platform/threads does). */
async function threadOf(recordType: string, recordId: string, partyId: string | null): Promise<string> {
  const [known] = await admin(`SELECT id::text AS id FROM "Thread" WHERE "recordType" = $1 AND "recordId" = $2::uuid`, [recordType, recordId])
  if (known) return known.id as string
  const id = randomUUID()
  expect(await insert(office(), 'Thread', { id, companyId: companyA, partyId, recordType, recordId, replyToken: randomUUID().replace(/-/g, '') })).toBe(1)
  return id
}
/** P1's own post on `threadId` (INBOUND, PARTNER, PORTAL, PARTY), with `extra`; returns its id. */
async function p1Post(threadId: string, extra: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID()
  expect(await insert(p1(), 'Message', { id, threadId, partyId: P1, direction: 'INBOUND', audience: 'PARTNER', channel: 'PORTAL', authorKind: 'PARTY', authorName: 'Bea Buyer', bodyText: 'Made-up: can the collar be higher?', at: await serverNow(), ...extra })).toBe(1)
  return id
}
/** An office internal note on `threadId`, with `extra`. */
const officeNote = async (threadId: string, extra: Record<string, unknown> = {}) =>
  insert(office(), 'Message', { id: randomUUID(), threadId, direction: 'INTERNAL_NOTE', audience: 'OFFICE', channel: 'APP', authorKind: 'USER', authorId: a.actorId, authorName: 'Test Office', bodyText: 'Made-up: see this part.', at: await serverNow(), ...extra })

/** The fixture: P1's CONFIRMED order to ask on (a copy of SEED-SO-0002 with one SEED-JKT-01 line), its thread, P1's file there. */
const F = { order: '', line: '', thread: '', file: '', otherOrder: '', otherThread: '', soThread: '', quoteThread: '' }
const U = { office: '' }

/**
 * P1's DESIGN ask on F.order and its line rows, in ONE transaction of `scope` (OrderChangeRequest_design_has_lines runs at
 * commit); `lines` null writes none.
 */
async function designAsk(request: Record<string, unknown> = {}, lines: readonly Record<string, unknown>[] | null = [{}], scope: FactoryScope = p1()): Promise<string> {
  const id = randomUUID()
  const at = await serverNow()
  const rows: [string, Record<string, unknown>][] = [
    ['OrderChangeRequest', { id, companyId: companyA, partyId: P1, orderId: F.order, kind: 'DESIGN', reason: 'Made-up: a higher collar on the first line, as in the sketch.', createdAt: at, updatedAt: at, createdById: portal.userIds.p1Buyer, ...request }],
  ]
  for (const line of lines ?? []) {
    rows.push(['OrderChangeRequestLine', { id: randomUUID(), partyId: P1, requestId: id, orderLineId: F.line, size: null, quantityBefore: 3, quantity: 3, createdAt: at, createdById: portal.userIds.p1Buyer, ...line }])
  }
  await together(scope, rows)
  return id
}

beforeAll(async () => {
  db = await migratedDatabase('orderapply')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: NS })
  portal = await seedPortalAuth({ db: factory, namespace: NS })
  quotes = await seedSales({ db: factory, namespace: NS })
  sales = await seedPortalSales({ db: factory, namespace: NS })
  production = await seedProduction({ db: factory, namespace: NS })
  changes = await seedChanges({ db: factory, namespace: NS })
  cutting = await seedCutting({ db: factory, namespace: NS })
  two = await seedTwoBrands({ db: factory, namespace: NS })
  applied = await seedOrderApply({ db: factory, namespace: NS })
  U.office = await person()

  const [line] = await admin(`SELECT id::text AS id FROM "SalesOrderLine" WHERE "orderId" = $1::uuid ORDER BY seq LIMIT 1`, [production.salesOrderId])
  F.order = randomUUID()
  F.line = randomUUID()
  await plant('SalesOrder', production.salesOrderId, { id: F.order, number: tag('T-SO'), customerSeq: null, status: 'CONFIRMED' })
  await plant('SalesOrderLine', line!.id as string, { id: F.line, orderId: F.order })
  F.thread = await threadOf('SalesOrder', F.order, P1)
  F.file = randomUUID()
  await plant('StoredFile', two.second.fileId, { id: F.file, partyId: P1, recordType: 'SalesOrder', recordId: F.order, status: 'AVAILABLE', storageKey: `t/${F.file}`, thumbnailKey: null })
  // Another order of P1 with its own thread (a message there is not this order's).
  F.otherOrder = randomUUID()
  await plant('SalesOrder', production.salesOrderId, { id: F.otherOrder, number: tag('T-SO'), customerSeq: null, status: 'CONFIRMED' })
  F.otherThread = await threadOf('SalesOrder', F.otherOrder, P1)
  // SEED-SO-0002's own thread (its lines, SEED-WO-0001) and a thread of P1's quote (not an order's).
  F.soThread = await threadOf('SalesOrder', production.salesOrderId, P1)
  F.quoteThread = await threadOf('Quote', quotes.quoteId, P1)
}, 1_500_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 120_000)

// ---------------------------------------------------------------------------------------------------------------------------
describe('a DESIGN request (items 1, 2)', () => {
  it('needs their words and at least one line, each once, as a whole, the pieces as they are', async () => {
    const id = await designAsk()
    expect(await admin(`SELECT kind::text AS kind, status::text AS status, "fileIds"::text[] AS files FROM "OrderChangeRequest" WHERE id = $1::uuid`, [id])).toEqual([{ kind: 'DESIGN', status: 'OPEN', files: [] }])
    await expect(designAsk({ reason: null })).rejects.toThrow(DESIGN_WORDS)
    await expect(designAsk({ reasonCode: 'OTHER' })).rejects.toThrow(DESIGN_WORDS)
    expect(await designAsk({ reason: 'x'.repeat(4000) })).toBeTruthy()
    await expect(designAsk({ reason: 'x'.repeat(4001) })).rejects.toThrow(/their words up to 2000 \(a design change up to 4000\)/)
    // No line: refused at commit.
    await expect(designAsk({}, null)).rejects.toThrow(/names at least one line of its order, written with it/)
    await expect(designAsk({}, [{ size: '50' }])).rejects.toThrow(DESIGN_LINES)
    await expect(designAsk({}, [{ quantity: 2 }])).rejects.toThrow(DESIGN_LINES)
    // A null size is no key of the unique: the guard holds "each line once".
    await expect(designAsk({}, [{}, {}])).rejects.toThrow(DESIGN_LINES)
  })

  it('sends 0 to 10 AVAILABLE files of its own order shared with its own customer, only on a DESIGN request; never changed', async () => {
    const id = await designAsk({ fileIds: [F.file] })
    expect(await admin(`SELECT "fileIds"::text[] AS files FROM "OrderChangeRequest" WHERE id = $1::uuid`, [id])).toEqual([{ files: [F.file] }])
    // Brand Beta's file (shared with Beta, of Beta's order): refused, in the words of a file that is not there.
    const beta = await refusalOf(designAsk({ fileIds: [two.second.fileId] }))
    expect(beta).toMatch(OWN_FILES)
    await expectNeutral(beta)
    await expect(designAsk({ fileIds: [randomUUID()] })).rejects.toThrow(OWN_FILES)
    // A file of the order not available yet.
    const pending = randomUUID()
    await plant('StoredFile', F.file, { id: pending, status: 'PENDING_UPLOAD', storageKey: `t/${pending}`, thumbnailKey: null })
    await expect(designAsk({ fileIds: [pending] })).rejects.toThrow(OWN_FILES)
    // Each once, at most 10, never null.
    await expect(designAsk({ fileIds: [F.file, F.file] })).rejects.toThrow(/only a design change sends files: up to 10, each once/)
    await expect(designAsk({ fileIds: Array.from({ length: 11 }, () => randomUUID()) })).rejects.toThrow(/up to 10, each once/)
    await expect(designAsk({ fileIds: null })).rejects.toThrow(/up to 10, each once/)
    // Only a DESIGN request sends files.
    const at = await serverNow()
    await expect(insert(p1(), 'OrderChangeRequest', { id: randomUUID(), companyId: companyA, partyId: P1, orderId: F.order, kind: 'CHANGE', reason: 'Made-up: two more in 52.', fileIds: [F.file], createdAt: at, updatedAt: at, createdById: portal.userIds.p1Buyer })).rejects.toThrow(
      /only a design change sends files/,
    )
    // Written with the request, never changed, for any login.
    await expect(update(office(), 'OrderChangeRequest', id, `"fileIds" = '{}'::uuid[], version = version + 1`)).rejects.toThrow(/the order, kind, ask and creation of change request .* never change/)
    await expect(admin(`UPDATE "OrderChangeRequest" SET "fileIds" = '{}'::uuid[], version = version + 1 WHERE id = $1`, [id])).rejects.toThrow(/never change/)
  })

  it('P1 asks only on its own orders, for itself (the partner wall); Beta reads none of it', async () => {
    await expect(designAsk({ partyId: two.second.partyId })).rejects.toThrow(RLS)
    const id = await designAsk({ fileIds: [F.file] })
    expect(await sql(beta(), `SELECT id FROM "OrderChangeRequest" WHERE id = $1::uuid`, id)).toEqual([])
    expect(await sql(beta(), `SELECT id FROM "OrderChangeRequestLine" WHERE "requestId" = $1::uuid`, id)).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------------------------------------
describe("the ask's own message (item 5, P21)", () => {
  it("names P1's INBOUND message on its own order's thread, one request per message", async () => {
    const message = await p1Post(F.thread)
    const id = await designAsk({ askMessageId: message })
    expect(await admin(`SELECT "askMessageId"::text AS message FROM "OrderChangeRequest" WHERE id = $1::uuid`, [id])).toEqual([{ message }])
    await expect(designAsk({ askMessageId: message })).rejects.toThrow(/OrderChangeRequest_tenantId_askMessageId_key/)
    // Brand Beta's message on Beta's order: the reference holds the party, so P1 never names it (the guard, which fires before the
    // reference's trigger, refuses it first, in the words of a message that is not there).
    const words = await refusalOf(designAsk({ askMessageId: two.second.messageIds[1] }))
    expect(words).toMatch(new RegExp(`${ASK_MESSAGE.source}|OrderChangeRequest_tenantId_partyId_askMessageId_fkey`))
    await expectNeutral(words)
    // An internal note (no party) neither.
    const note = randomUUID()
    expect(await officeNote(F.thread, { id: note })).toBe(1)
    await expect(designAsk({ askMessageId: note })).rejects.toThrow(new RegExp(`${ASK_MESSAGE.source}|OrderChangeRequest_tenantId_partyId_askMessageId_fkey`))
    // P1's message on another of its orders' threads, or on its quote's thread: not this order's conversation.
    await expect(designAsk({ askMessageId: await p1Post(F.otherThread) })).rejects.toThrow(ASK_MESSAGE)
    await expect(designAsk({ askMessageId: await p1Post(F.quoteThread) })).rejects.toThrow(ASK_MESSAGE)
  })

  it('is named with the ask or once while it waits, nothing else with it; never changed; answering and withdrawing keep it', async () => {
    const id = await designAsk()
    const first = await p1Post(F.thread)
    await expect(update(p1(), 'OrderChangeRequest', id, `"askMessageId" = $2::uuid, reason = 'Made-up: other words', version = version + 1`, first)).rejects.toThrow(
      /the order, kind, ask and creation of change request .* never change/,
    )
    await expect(update(p1(), 'OrderChangeRequest', id, `"askMessageId" = $2::uuid, "withdrawnAt" = now(), version = version + 1`, first)).rejects.toThrow(
      /naming the ask's message of change request .* changes only askMessageId, version, updatedAt/,
    )
    expect(await update(p1(), 'OrderChangeRequest', id, `"askMessageId" = $2::uuid, version = version + 1`, first)).toBe(1)
    const second = await p1Post(F.thread)
    await expect(update(p1(), 'OrderChangeRequest', id, `"askMessageId" = $2::uuid, version = version + 1`, second)).rejects.toThrow(/names its ask's message once; it never changes/)
    await expect(update(office(), 'OrderChangeRequest', id, `"askMessageId" = NULL, version = version + 1`)).rejects.toThrow(/names its ask's message once; it never changes/)
    // Withdrawn, it keeps its message; a decided request takes none any more.
    expect(await update(p1(), 'OrderChangeRequest', id, `status = 'WITHDRAWN', "withdrawnAt" = now(), version = version + 1`)).toBe(1)
    expect(await admin(`SELECT "askMessageId"::text AS message FROM "OrderChangeRequest" WHERE id = $1::uuid`, [id])).toEqual([{ message: first }])
    const later = await designAsk()
    expect(await update(p1(), 'OrderChangeRequest', later, `status = 'WITHDRAWN', "withdrawnAt" = now(), version = version + 1`)).toBe(1)
    await expect(update(office(), 'OrderChangeRequest', later, `"askMessageId" = $2::uuid, version = version + 1`, second)).rejects.toThrow(/it never changes again/)
  })
})

// ---------------------------------------------------------------------------------------------------------------------------
describe('a product change request raised from a DESIGN request (item 3, R3)', () => {
  const jkt01 = () => production.styleId
  /** An OPEN CUSTOMER change request (a copy of the seed's P1 one) with `changes`. */
  const raise = (changesOf: Record<string, unknown>) =>
    copyRow('ChangeRequest', changes.requestIds.customer, {
      id: randomUUID(),
      number: tag('T-CR'),
      source: 'CUSTOMER',
      partyId: P1,
      styleId: jkt01(),
      revisionId: null,
      siteId: null,
      workOrderId: null,
      sampleRoundId: null,
      status: 'OPEN',
      decidedAt: null,
      decidedById: null,
      decisionNote: null,
      changeOrderId: null,
      version: 1,
      ...changesOf,
    })
  /** A copy of SEED-JKT-01 with `brandPartyId`, and a line of F.order in it; returns both ids. */
  async function styleWithLine(brandPartyId: string | null): Promise<{ style: string; line: string }> {
    const style = randomUUID()
    const line = randomUUID()
    await plant('Style', jkt01(), { id: style, code: tag('T-JKT'), brandPartyId })
    await plant('SalesOrderLine', F.line, { id: line, styleId: style, seq: 100 + Math.floor(Math.random() * 100_000) })
    return { style, line }
  }

  it("names only a DESIGN request of its own customer, for that customer's own private-label style of one of its lines; set once", async () => {
    // SEED-JKT-01 is P1's own private label (Style.brandPartyId = P1), and F.line is in it.
    expect(await admin(`SELECT "brandPartyId"::text AS brand FROM "Style" WHERE id = $1::uuid`, [jkt01()])).toEqual([{ brand: P1 }])
    const asked = await designAsk()
    const cr = randomUUID()
    expect(await raise({ id: cr, orderChangeRequestId: asked })).toBe(1)
    // Set once: never moved to another request, never cleared, for any login.
    const other = await designAsk()
    await expect(update(office(), 'ChangeRequest', cr, `"orderChangeRequestId" = $2::uuid, version = version + 1`, other)).rejects.toThrow(/names the customer's request that raised it once; it never changes/)
    await expect(admin(`UPDATE "ChangeRequest" SET "orderChangeRequestId" = NULL WHERE id = $1`, [cr])).rejects.toThrow(/never changes/)
    // A style of our own collection, or of another label, never changes from a customer's ask.
    const ours = await styleWithLine(null)
    await expect(raise({ styleId: ours.style, orderChangeRequestId: await designAsk({}, [{ orderLineId: ours.line }]) })).rejects.toThrow(OWN_LABEL)
    const theirs = await styleWithLine(two.second.partyId)
    await expect(raise({ styleId: theirs.style, orderChangeRequestId: await designAsk({}, [{ orderLineId: theirs.line }]) })).rejects.toThrow(OWN_LABEL)
    // P1's own label, but not the style of one of the request's lines.
    const notAsked = await styleWithLine(P1)
    await expect(raise({ styleId: notAsked.style, orderChangeRequestId: asked })).rejects.toThrow(/is about the style of one of the lines its customer's design change names/)
    // Not a DESIGN request (the seed's OPEN change), and not the customer's own request (no source CUSTOMER, no party).
    await expect(raise({ orderChangeRequestId: sales.changes.open })).rejects.toThrow(/names a design change request of its own customer/)
    await expect(raise({ source: 'OFFICE', partyId: null, orderChangeRequestId: asked })).rejects.toThrow(/names a customer's request only when it is the customer's own/)
    // A floor device has no grant on it.
    await expect(
      insert(floor(), 'ChangeRequest', { id: randomUUID(), companyId: companyA, siteId: siteA1, source: 'FLOOR', styleId: jkt01(), title: 'Made-up: a seam', reason: 'Made-up: it opens', orderChangeRequestId: asked }),
    ).rejects.toThrow(DENIED)
  })

  it("Brand Beta's request never links Brand Alpha's style (the brand wall)", async () => {
    // Beta's DESIGN request on its own order and line (planted: Beta's portal rules are not under test here).
    const template = await designAsk()
    const [templateLine] = await admin(`SELECT id::text AS id FROM "OrderChangeRequestLine" WHERE "requestId" = $1::uuid`, [template])
    const betaAsk = randomUUID()
    await plant('OrderChangeRequest', template, { id: betaAsk, partyId: two.second.partyId, orderId: two.second.salesOrderId })
    await plant('OrderChangeRequestLine', templateLine!.id as string, { id: randomUUID(), partyId: two.second.partyId, requestId: betaAsk, orderLineId: two.salesOrderLineId })
    // Alpha's change request naming Beta's request: refused (the reference holds the party; the guard, which fires before the
    // reference's trigger, refuses it first, in the words of a request that is not there).
    const named = await refusalOf(raise({ orderChangeRequestId: betaAsk }))
    expect(named).toMatch(/names a design change request of its own customer|ChangeRequest_tenantId_partyId_orderChangeRequestId_fkey/)
    await expectNeutral(named)
    // Beta's change request on Alpha's style: refused by the guard, in neutral words.
    const words = await refusalOf(raise({ partyId: two.second.partyId, orderChangeRequestId: betaAsk }))
    expect(words).toMatch(OWN_LABEL)
    await expectNeutral(words)
    // Beta's own label, the style of its line: raised.
    expect(await raise({ partyId: two.second.partyId, styleId: two.styleId, orderChangeRequestId: betaAsk })).toBe(1)
  })
})

// ---------------------------------------------------------------------------------------------------------------------------
describe('what a message is about (item 6, B-SA-061 "Discuss")', () => {
  it("names a part of its thread's own order, kind and id both or neither; written once", async () => {
    const [line] = await admin(`SELECT id::text AS id FROM "SalesOrderLine" WHERE "orderId" = $1::uuid ORDER BY seq LIMIT 1`, [production.salesOrderId])
    const id = randomUUID()
    expect(await officeNote(F.soThread, { id, aboutKind: 'SalesOrderLine', aboutId: line!.id })).toBe(1)
    // SEED-WO-0001 makes SEED-SO-0002's lines: an office note may be about it.
    expect(await officeNote(F.soThread, { aboutKind: 'WorkOrder', aboutId: production.workOrderId })).toBe(1)
    // Brand Beta's work order, or another order's line: not a part of this record (neutral words).
    const words = await refusalOf(officeNote(F.soThread, { aboutKind: 'WorkOrder', aboutId: two.workOrderIds.inProduction }))
    expect(words).toMatch(NOT_A_PART)
    await expectNeutral(words)
    await expect(officeNote(F.soThread, { aboutKind: 'SalesOrderLine', aboutId: F.line })).rejects.toThrow(NOT_A_PART)
    await expect(officeNote(F.soThread, { aboutKind: 'SalesOrderLine', aboutId: two.salesOrderLineId })).rejects.toThrow(NOT_A_PART)
    // Only on a sales order's thread.
    await expect(officeNote(F.quoteThread, { aboutKind: 'SalesOrderLine', aboutId: line!.id })).rejects.toThrow(NOT_A_PART)
    // Both or neither, one of the seven kinds.
    await expect(officeNote(F.soThread, { aboutKind: 'SalesOrderLine' })).rejects.toThrow(ABOUT_SHAPE)
    await expect(officeNote(F.soThread, { aboutId: line!.id })).rejects.toThrow(ABOUT_SHAPE)
    await expect(officeNote(F.soThread, { aboutKind: 'Quote', aboutId: quotes.quoteId })).rejects.toThrow(ABOUT_SHAPE)
    // Written once: a message is append-only, for every login.
    await expect(admin(`UPDATE "Message" SET "aboutKind" = NULL, "aboutId" = NULL WHERE id = $1`, [id])).rejects.toThrow(/append-only/)
  })

  it('a message shared with the customer is never about a work order; P1 writes it in its own posts, about its own order only', async () => {
    const id = await p1Post(F.thread, { aboutKind: 'SalesOrderLine', aboutId: F.line })
    expect(await sql(p1(), `SELECT "aboutKind", "aboutId"::text AS "aboutId" FROM "Message" WHERE id = $1::uuid`, id)).toEqual([{ aboutKind: 'SalesOrderLine', aboutId: F.line }])
    await expect(p1Post(F.soThread, { aboutKind: 'WorkOrder', aboutId: production.workOrderId })).rejects.toThrow(/is shared with the customer, so it is never about a work order/)
    // Beta's line: P1 cannot see it, so it is not a part of this record.
    await expect(p1Post(F.thread, { aboutKind: 'SalesOrderLine', aboutId: two.salesOrderLineId })).rejects.toThrow(NOT_A_PART)
  })
})

// ---------------------------------------------------------------------------------------------------------------------------
describe('WorkOrderChange (item 4, R1)', () => {
  /** SEED-WO-0001's cell `name` as a change names it. */
  const cellOf = async (name: keyof ProductionSeed['cellIds'], to: number, from?: number) => {
    const [cell] = await admin(`SELECT "salesOrderLineId"::text AS line, size, quantity FROM "WorkOrderSize" WHERE id = $1::uuid`, [production.cellIds[name]])
    return { salesOrderLineId: cell!.line as string, size: cell!.size as string, from: from ?? (cell!.quantity as number), to, workOrderSizeId: production.cellIds[name] }
  }
  /** A PROPOSED LOWER_TO_ORDER of SEED-WO-0001 for SEED-SO-0002 (RED 52 goes), with `extra` columns. */
  const change = async (extra: Record<string, unknown> = {}) => {
    const id = randomUUID()
    const at = await serverNow()
    const row = {
      id,
      companyId: companyA,
      partyId: P1,
      salesOrderId: production.salesOrderId,
      siteId: siteA1,
      workOrderId: production.workOrderId,
      kind: 'LOWER_TO_ORDER',
      cells: [await cellOf('RED-52', 0)],
      reason: 'Made-up: the customer no longer wants RED 52.',
      proposedById: U.office,
      createdAt: at,
      updatedAt: at,
      ...extra,
    }
    return { id, insert: () => insert(office(), 'WorkOrderChange', row) }
  }
  const proposed = async (extra: Record<string, unknown> = {}): Promise<string> => {
    const made = await change(extra)
    expect(await made.insert()).toBe(1)
    return made.id
  }

  it('is office only: no portal, floor or link grant', async () => {
    await expect(sql(p1(), `SELECT id FROM "WorkOrderChange" LIMIT 1`)).rejects.toThrow(DENIED)
    await expect(sql(floor(), `SELECT id FROM "WorkOrderChange" LIMIT 1`)).rejects.toThrow(DENIED)
    await expect(run(p1(), `INSERT INTO "WorkOrderChange" (id) VALUES ($1::uuid)`, randomUUID())).rejects.toThrow(DENIED)
    // The seed's proposal (SEED-WO-0001's RED 54) is there, waiting.
    expect(await sql(office(), `SELECT status::text AS status, kind::text AS kind FROM "WorkOrderChange" WHERE id = $1::uuid`, applied.changeId)).toEqual([{ status: 'PROPOSED', kind: 'LOWER_TO_ORDER' }])
  })

  it("is born PROPOSED, of the order's customer, on an open work order of that customer, its cells of its own order and work order", async () => {
    expect(await (await change()).insert()).toBe(1)
    await expect((await change({ status: 'APPLIED', decidedAt: await serverNow(), decidedById: U.office })).insert()).rejects.toThrow(/a new work-order change is PROPOSED, undecided/)
    // Brand Beta's work order (at the same site) on Alpha's order: refused, in neutral words.
    const words = await refusalOf((await change({ workOrderId: two.workOrderIds.inProduction })).insert())
    expect(words).toMatch(/names an open work order of its own order's customer/)
    await expectNeutral(words)
    // Beta's order under Alpha's customer, or Beta's request: refused by the references.
    await expect((await change({ salesOrderId: two.second.salesOrderId })).insert()).rejects.toThrow(/WorkOrderChange_tenantId_companyId_partyId_salesOrderId_fkey/)
    // Its work order with that work order's site, both or neither; always when it lowers.
    await expect((await change({ siteId: null, workOrderId: null })).insert()).rejects.toThrow(/names its work order with that work order's site, both or neither, always when it lowers one/)
    await expect((await change({ workOrderId: null })).insert()).rejects.toThrow(/names its work order with that work order's site/)
    // Its cells: lines of its own order, cells of its own work order, lowered (or raised for MAKE_MORE), each once.
    const own = await cellOf('RED-52', 0)
    await expect((await change({ cells: [{ ...own, salesOrderLineId: two.salesOrderLineId }] })).insert()).rejects.toThrow(/each cell is of a line of its own order/)
    const [draftCell] = await admin(`SELECT id::text AS id FROM "WorkOrderSize" WHERE "workOrderId" = $1::uuid LIMIT 1`, [production.draftWorkOrderId])
    await expect((await change({ cells: [{ ...own, workOrderSizeId: draftCell!.id }] })).insert()).rejects.toThrow(/each cell it names is a cell of its own work order/)
    await expect((await change({ cells: [{ ...own, to: own.from }] })).insert()).rejects.toThrow(/it lowers its work order's cells \(to below from, each naming its cell\) or makes more/)
    await expect((await change({ cells: [{ ...own, workOrderSizeId: null }] })).insert()).rejects.toThrow(/it lowers its work order's cells/)
    await expect((await change({ cells: [own, own] })).insert()).rejects.toThrow(/each line and size once/)
    await expect((await change({ cells: [] })).insert()).rejects.toThrow(/its cells are a list of 1 to 200/)
    await expect((await change({ cells: [{ ...own, note: 'Made-up' }] })).insert()).rejects.toThrow(/each cell is \{salesOrderLineId, size, from, to, workOrderSizeId\}/)
    await expect((await change({ cells: [{ ...own, to: 1.5 }] })).insert()).rejects.toThrow(/each cell is \{salesOrderLineId, size, from, to, workOrderSizeId\}/)
    // MAKE_MORE raises: an open DRAFT's cell, or none (a new DRAFT is made).
    await expect((await change({ kind: 'MAKE_MORE' })).insert()).rejects.toThrow(/it lowers its work order's cells/)
    expect(await (await change({ kind: 'MAKE_MORE', siteId: null, workOrderId: null, cells: [{ ...own, from: 0, to: 2, workOrderSizeId: null }] })).insert()).toBe(1)
    await expect((await change({ kind: 'MAKE_MORE', siteId: null, workOrderId: null, cells: [{ ...own, from: 0, to: 2 }] })).insert()).rejects.toThrow(/each cell it names is a cell of its own work order/)
    // Extra pieces with their outcome, both or neither, only when it lowers, each of a cell it lowers, once.
    const extra = [{ workOrderSizeId: own.workOrderSizeId, salesOrderLineId: own.salesOrderLineId, size: own.size, count: 1 }]
    expect(await (await change({ extra, extraOutcome: 'LEFTOVER' })).insert()).toBe(1)
    await expect((await change({ extra })).insert()).rejects.toThrow(/names its extra pieces with what happens to them, both or neither, only when it lowers a work order/)
    await expect((await change({ extraOutcome: 'SCRAP' })).insert()).rejects.toThrow(/names its extra pieces with what happens to them/)
    await expect((await change({ kind: 'MAKE_MORE', siteId: null, workOrderId: null, cells: [{ ...own, from: 0, to: 2, workOrderSizeId: null }], extra, extraOutcome: 'CHARGE' })).insert()).rejects.toThrow(/only when it lowers a work order/)
    await expect((await change({ extra: [{ ...extra[0]!, workOrderSizeId: production.cellIds['RED-50'] }], extraOutcome: 'SCRAP' })).insert()).rejects.toThrow(/each extra is of a cell it lowers/)
    await expect((await change({ extra: [extra[0], extra[0]], extraOutcome: 'SCRAP' })).insert()).rejects.toThrow(/each extra is of a cell it lowers \(that cell's line and size\), once/)
    await expect((await change({ extra: [{ ...extra[0]!, count: 0 }], extraOutcome: 'SCRAP' })).insert()).rejects.toThrow(/1 to 100000 pieces/)
    // Its request one of its own order; proposed by an active office person, with words.
    // (End check: the seeds' OPEN ask is of SEED-SO-0002 itself; the refused cancel is of SEED-SO-0003, another order.)
    const [other] = await admin(`SELECT "orderId"::text AS "order" FROM "OrderChangeRequest" WHERE id = $1::uuid`, [sales.changes.refusedCancel])
    expect(other!.order).not.toBe(production.salesOrderId)
    await expect((await change({ requestId: sales.changes.refusedCancel })).insert()).rejects.toThrow(/carries out a request of its own order/)
    await expect((await change({ proposedById: portal.userIds.p1Buyer })).insert()).rejects.toThrow(/is proposed by an active office person/)
    await expect((await change({ proposedById: randomUUID() })).insert()).rejects.toThrow(/is proposed by an active office person/)
    await expect((await change({ reason: ' ' })).insert()).rejects.toThrow(/says why in 1 to 500 characters/)
  })

  it('moves only PROPOSED → APPLIED | DECLINED | STALE, once, then never changes; never deleted', async () => {
    const id = await proposed()
    // While it waits: only a failed apply's words.
    expect(await update(office(), 'WorkOrderChange', id, `"lastError" = 'Made-up: WO changed since; propose again', version = version + 1`)).toBe(1)
    await expect(update(office(), 'WorkOrderChange', id, `reason = 'Made-up: other words', version = version + 1`)).rejects.toThrow(/while it waits, work-order change .* changes only by a failed apply's words/)
    await expect(update(office(), 'WorkOrderChange', id, `"lastError" = NULL, version = version + 2`)).rejects.toThrow(/goes up by one/)
    // The decision: when and by whom (an active office person) to apply.
    await expect(update(office(), 'WorkOrderChange', id, `status = 'APPLIED', "decidedAt" = now(), version = version + 1`)).rejects.toThrow(/with the wrong decision/)
    await expect(update(office(), 'WorkOrderChange', id, `status = 'APPLIED', "decidedAt" = now(), "decidedById" = $2::uuid, version = version + 1`, portal.userIds.p1Buyer)).rejects.toThrow(/is decided by an active office person/)
    await expect(update(office(), 'WorkOrderChange', id, `status = 'APPLIED', "decidedAt" = now(), "decidedById" = $2::uuid, reason = 'Made-up', version = version + 1`, U.office)).rejects.toThrow(/deciding work-order change .* changes only/)
    await expect(update(office(), 'WorkOrderChange', id, `status = 'APPLIED', "decidedAt" = now(), "decidedById" = $2::uuid, "madeWorkOrderId" = $3::uuid, version = version + 1`, U.office, production.draftWorkOrderId)).rejects.toThrow(
      /names the work order it made only when it applied a MAKE_MORE that named none/,
    )
    expect(await update(office(), 'WorkOrderChange', id, `status = 'APPLIED', "decidedAt" = now(), "decidedById" = $2::uuid, version = version + 1`, U.office)).toBe(1)
    for (const set of [`"lastError" = 'Made-up'`, `status = 'STALE'`, `"decisionNote" = 'Made-up'`]) {
      await expect(update(office(), 'WorkOrderChange', id, `${set}, version = version + 1`), set).rejects.toThrow(/is APPLIED; it never changes again/)
    }
    // Declined in words ("Left as is", up to 300); stale with no person (the system's context).
    const declined = await proposed()
    await expect(update(office(), 'WorkOrderChange', declined, `status = 'DECLINED', "decidedAt" = now(), "decidedById" = $2::uuid, version = version + 1`, U.office)).rejects.toThrow(/words to decline \(left as is\)/)
    await expect(update(office(), 'WorkOrderChange', declined, `status = 'DECLINED', "decidedAt" = now(), "decidedById" = $2::uuid, "decisionNote" = $3, version = version + 1`, U.office, 'x'.repeat(301))).rejects.toThrow(/a decision in up to 300/)
    expect(await update(office(), 'WorkOrderChange', declined, `status = 'DECLINED', "decidedAt" = now(), "decidedById" = $2::uuid, "decisionNote" = 'Made-up: the workshop keeps them as made', version = version + 1`, U.office)).toBe(1)
    const stale = await proposed()
    await expect(update(office(), 'WorkOrderChange', stale, `status = 'STALE', version = version + 1`)).rejects.toThrow(/with the wrong decision/)
    expect(await update(office(), 'WorkOrderChange', stale, `status = 'STALE', "decidedAt" = now(), version = version + 1`)).toBe(1)
    // An applied MAKE_MORE that named no work order names the DRAFT it made: one of its own customer.
    const own = await cellOf('RED-52', 2, 0)
    const more = await proposed({ kind: 'MAKE_MORE', siteId: null, workOrderId: null, cells: [{ ...own, workOrderSizeId: null }] })
    const apply = `status = 'APPLIED', "decidedAt" = now(), "decidedById" = $2::uuid, "madeWorkOrderId" = $3::uuid, version = version + 1`
    await expect(update(office(), 'WorkOrderChange', more, apply, U.office, two.workOrderIds.draft)).rejects.toThrow(/names the work order it made: one of its own customer/)
    await expect(update(office(), 'WorkOrderChange', more, apply, U.office, randomUUID())).rejects.toThrow(/names the work order it made: one of its own customer/)
    expect(await update(office(), 'WorkOrderChange', more, apply, U.office, production.draftWorkOrderId)).toBe(1)
    // Never deleted, never truncated, for any login.
    await expect(run(office(), `DELETE FROM "WorkOrderChange" WHERE id = $1::uuid`, id)).rejects.toThrow(DENIED)
    await expect(admin(`DELETE FROM "WorkOrderChange" WHERE id = $1`, [id])).rejects.toThrow(/is declined or made stale, never deleted/)
    await expect(admin(`TRUNCATE "WorkOrderChange"`)).rejects.toThrow(/TRUNCATE on "WorkOrderChange" is refused/)
  })
})

// ---------------------------------------------------------------------------------------------------------------------------
describe('the work-order cell guard, redefined (item 7, R1 "Lower to the order")', () => {
  /** An IN_PROGRESS copy of SEED-WO-0001 (or in `status`) with no cell of its own; returns its id. */
  async function workOrder(status = 'IN_PROGRESS'): Promise<string> {
    const id = randomUUID()
    await plant('WorkOrder', production.workOrderId, { id, number: tag('T-WO'), batchNumber: tag('T-BT'), status, ...(status === 'ON_HOLD' ? { heldFromStatus: 'IN_PROGRESS', holdReason: 'Made-up: material', heldAt: await serverNow(), heldById: a.actorId } : {}) })
    return id
  }
  /** A cell of `workOrderId` (a copy of SEED-WO-0001's RED 50, or of another `size`) of `quantity`; returns its id. */
  async function cell(workOrderId: string, quantity: number, size?: string): Promise<string> {
    const id = randomUUID()
    await plant('WorkOrderSize', production.cellIds['RED-50'], { id, workOrderId, quantity, ...(size ? { size } : {}) })
    return id
  }
  /** A bundle of `cellId` (a copy of the seed's first) of `quantity` garments, ACTIVE, split off `parentBundleId` or none. */
  async function bundle(workOrderId: string, cellId: string, quantity: number, parentBundleId: string | null = null): Promise<string> {
    const id = randomUUID()
    await plant('Bundle', production.bundleIds[0], { id, workOrderId, workOrderSizeId: cellId, quantity, code: tag('T-BN'), replacedCodes: [], part: null, parentBundleId, status: 'ACTIVE', voidedAt: null, voidReason: null, clientEventId: null, deviceId: null, cutLogIds: [] })
    return id
  }
  const floorOf = async (cellId: string): Promise<number> => Number((await sql(office(), `SELECT "factory_work_order_cell_floor"($1::uuid, $2::uuid) AS n`, a.tenantId, cellId))[0]!.n)
  const setQuantity = (cellId: string, quantity: number, more = '') => update(office(), 'WorkOrderSize', cellId, `quantity = ${quantity}, version = version + 1${more}`)

  it('a RELEASED or IN_PROGRESS cell goes down to what is bundled, never below it and never up; it goes only when nothing is', async () => {
    for (const status of ['IN_PROGRESS', 'RELEASED']) {
      const wo = await workOrder(status)
      const c = await cell(wo, 6)
      const b = await bundle(wo, c, 4)
      // A split leaves its parent's garments as they were cut: the child is not counted again.
      await bundle(wo, c, 1, b)
      expect(await floorOf(c)).toBe(4)
      const words = await refusalOf(setQuantity(c, 3))
      expect(words).toMatch(BELOW(4))
      await expectNeutral(words)
      await expect(admin(`UPDATE "WorkOrderSize" SET quantity = 3 WHERE id = $1`, [c])).rejects.toThrow(BELOW(4))
      expect(await setQuantity(c, 4)).toBe(1)
      await expect(setQuantity(c, 5)).rejects.toThrow(FROZEN)
      // Going down with any other change is no going down.
      await expect(setQuantity(c, 4, `, size = '56'`)).rejects.toThrow(FROZEN)
      await expect(run(office(), `DELETE FROM "WorkOrderSize" WHERE id = $1::uuid`, c)).rejects.toThrow(BELOW(4))
      // A new cell still only on a DRAFT.
      await expect(copyRow('WorkOrderSize', c, { id: randomUUID(), size: '56', quantity: 1 })).rejects.toThrow(FROZEN)
      // The bundle voided (end check: MES-071 voids the garment split off it first, so the genealogy stays whole): the split
      // garment alone never counted, and with both void nothing is held, so the cell goes down below what was bundled.
      const voided = (where: string) => admin(`UPDATE "Bundle" SET status = 'VOID', "voidedAt" = now(), "voidReason" = 'Made-up: recut', version = version + 1 WHERE ${where} = $1 RETURNING id`, [b])
      await expect(voided('id')).rejects.toThrow(/has ACTIVE bundles split from it; void them first/)
      expect(await voided('"parentBundleId"')).toHaveLength(1)
      expect(await floorOf(c)).toBe(4)
      expect(await voided('id')).toHaveLength(1)
      expect(await floorOf(c)).toBe(0)
      expect(await setQuantity(c, 1)).toBe(1)
      // A cell nothing of which is cut, bundled or on a cut order goes (another size: a work order has one cell per size).
      const gone = await cell(wo, 2, '56')
      expect(await run(office(), `DELETE FROM "WorkOrderSize" WHERE id = $1::uuid`, gone)).toBe(1)
    }
  })

  it('counts the cut of hides by the planned part cut least, never a reversed entry; its planned materials follow it down', async () => {
    const wo = await workOrder()
    const c = await cell(wo, 6)
    const materials = await admin(`SELECT id::text AS id FROM "WorkOrderMaterial" WHERE "workOrderSizeId" = $1::uuid`, [production.cellIds['RED-50']])
    const parts = (
      await admin(
        `SELECT DISTINCT coalesce(NULLIF(btrim(b."placement"), ''), i."code") AS part
           FROM "WorkOrderMaterial" m JOIN "Item" i ON i.id = m."itemId" AND i."tracking" = 'HIDE' LEFT JOIN "BomLine" b ON b.id = m."bomLineId"
          WHERE m."workOrderSizeId" = $1::uuid ORDER BY 1`,
        [production.cellIds['RED-50']],
      )
    ).map((row) => row.part as string)
    expect(parts.length).toBeGreaterThan(0)
    const planned: string[] = []
    for (const material of materials) {
      const id = randomUUID()
      await plant('WorkOrderMaterial', material.id as string, { id, workOrderId: wo, workOrderSizeId: c })
      planned.push(id)
    }
    expect(await floorOf(c)).toBe(0)
    // One live cut log entry: 5 pieces of every planned part but the last, 3 of the last, 9 of a part not planned (a recut).
    const entry = randomUUID()
    await plant('CutLog', production.cutLogId, { id: entry, workOrderId: wo, clientEventId: `t-${entry}`, reversalOfId: null })
    const [piece] = await admin(`SELECT id::text AS id FROM "CutLogPiece" WHERE "cutLogId" = $1::uuid LIMIT 1`, [production.cutLogId])
    for (const [index, part] of [...parts, 'T-RECUT'].entries()) {
      const pieces = part === 'T-RECUT' ? 9 : index === parts.length - 1 ? 3 : 5
      await plant('CutLogPiece', piece!.id as string, { id: randomUUID(), cutLogId: entry, workOrderId: wo, workOrderSizeId: c, part, pieces })
    }
    expect(await floorOf(c)).toBe(3)
    await expect(setQuantity(c, 2)).rejects.toThrow(BELOW(3))
    expect(await setQuantity(c, 3)).toBe(1)
    // Its planned materials follow it down (both quantities lower, nothing else); never up, never one unit alone; they go only
    // with a cell nothing of which is cut.
    const [first] = planned
    expect(await update(office(), 'WorkOrderMaterial', first!, `quantity = quantity / 2, "baseQuantity" = "baseQuantity" / 2, version = version + 1`)).toBe(1)
    await expect(update(office(), 'WorkOrderMaterial', first!, `quantity = quantity / 2, version = version + 1`)).rejects.toThrow(MATERIALS_FROZEN)
    await expect(update(office(), 'WorkOrderMaterial', first!, `quantity = quantity * 2, "baseQuantity" = "baseQuantity" * 2, version = version + 1`)).rejects.toThrow(MATERIALS_FROZEN)
    await expect(update(office(), 'WorkOrderMaterial', first!, `quantity = quantity / 2, "baseQuantity" = "baseQuantity" / 2, "createdById" = $2::uuid, version = version + 1`, randomUUID())).rejects.toThrow(MATERIALS_FROZEN)
    await expect(run(office(), `DELETE FROM "WorkOrderMaterial" WHERE id = $1::uuid`, first!)).rejects.toThrow(MATERIALS_FROZEN)
    // The entry reversed: its pieces no longer count, so nothing of the cell is cut and its planned materials may go.
    const reversal = randomUUID()
    await plant('CutLog', entry, { id: reversal, reversalOfId: entry, clientEventId: `t-${reversal}` })
    expect(await floorOf(c)).toBe(0)
    expect(await run(office(), `DELETE FROM "WorkOrderMaterial" WHERE "workOrderSizeId" = $1::uuid`, c)).toBe(planned.length)
  })

  it("counts a cut order's line until its reconciliation says what was cut", async () => {
    const wo = await workOrder()
    const c = await cell(wo, 6)
    const line = randomUUID()
    const [planned] = await admin(`SELECT "cutOrderId"::text AS "cutOrder" FROM "CutOrderLine" WHERE id = $1::uuid`, [cutting.lineIds.planned])
    await plant('CutOrderLine', cutting.lineIds.planned, { id: line, workOrderId: wo, workOrderSizeId: c, seq: 90_000 + Math.floor(Math.random() * 9_000), quantity: 4 })
    expect(await floorOf(c)).toBe(4)
    await expect(setQuantity(c, 3)).rejects.toThrow(BELOW(4))
    expect(await setQuantity(c, 4)).toBe(1)
    await plant('CutReconciliation', cutting.reconciliationId, { id: randomUUID(), cutOrderId: planned!.cutOrder, cutOrderLineId: line, key: `reconciliation:${line}`, orderedQuantity: 4, cutQuantity: 2, recutQuantity: 0, varianceReasonCode: 'SHORT' })
    expect(await floorOf(c)).toBe(2)
    expect(await setQuantity(c, 2)).toBe(1)
  })

  it('a DRAFT cell behaves as before; a held or completed one stays frozen', async () => {
    const [draft] = await admin(`SELECT id::text AS id, quantity FROM "WorkOrderSize" WHERE "workOrderId" = $1::uuid LIMIT 1`, [production.draftWorkOrderId])
    const quantity = draft!.quantity as number
    expect(await setQuantity(draft!.id as string, quantity + 1)).toBe(1)
    expect(await setQuantity(draft!.id as string, quantity)).toBe(1)
    for (const status of ['ON_HOLD', 'COMPLETED']) {
      const c = await cell(await workOrder(status), 3)
      await expect(setQuantity(c, 2)).rejects.toThrow(new RegExp(`is ${status}; its size quantities are frozen \\(MES-005\\)`))
      await expect(run(office(), `DELETE FROM "WorkOrderSize" WHERE id = $1::uuid`, c)).rejects.toThrow(FROZEN)
    }
  })
})
