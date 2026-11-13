import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedPortalSales, type PortalSalesSeed } from '../seed/portal-sales'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { classifiedModels, personalDataOf } from './ownership'
import { RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'
import { loadOwnership, loadSchema } from './tools'

/**
 * The customer portal (W2b schema wave 21/22, B-W2b-157, …_portal_sales_w2b_guards) on a database built from the migrations
 * and seeded, through the real login and the scoped client:
 *   - grants: a portal session reads and writes its own party's drafts, reads its requests, change requests and payment
 *     intents, never another party's, never who in the office decided or answered, never the provider account; the floor
 *     reads none of it; a MEASUREMENTS link session adds the revision it sent; the office moves only the photos' deletion;
 *   - order requests: a DRAFT kept by the customer, sent with its number and its pieces, decided by the office (one order or
 *     quote, words to refuse) or withdrawn; its lines only while DRAFT; only a draft is deleted;
 *   - change requests: asked OPEN of an order still open to amendments, a cancel with its reason code; the office answers,
 *     the customer withdraws; an accepted change names its amendment once; the cells it asks are written once;
 *   - payment intents: CREATED on a payment provider account, paying one open deposit request or issued invoice, moved
 *     forward only, no card number in any column, a succeeded one names its payment once;
 *   - measurements by link: the link, the notice shown, three body photos; never edited but the photos' deletion date;
 *   - the sales settings' cut-off rules; TRUNCATE refused.
 * The refusals are check_violation (SQLSTATE 23514); their messages are read through raw SQL.
 */

const NS = 'w2b-157-a'
const DENIED = /permission denied/

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let seeded: PortalSalesSeed

const key = (name: string): string => seedUuid(NS, name)
const P1 = key('party:P1')
const P2 = key('party:P2')
const office = (): FactoryScope => ({ audience: 'office', tenantId: a.tenantId, actorId: a.actorId })
const floor = (): FactoryScope => ({ audience: 'floor', tenantId: a.tenantId, actorId: key('worker:A1:operator'), siteId: key('site:A1') })
const partner = (partyId: string = P1, actorId: string = seeded.buyerId): FactoryScope => ({ audience: 'partner', tenantId: a.tenantId, actorId, partyId })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const run = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$executeRawUnsafe(text, ...values))
const sql = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$queryRawUnsafe<Record<string, unknown>[]>(text, ...values))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, unknown>[]
/** The columns the partner role may not read or write, of the tables a partner copies here (ownership/*.json). */
const PARTNER_HIDDEN: Readonly<Record<string, readonly string[]>> = {
  PortalOrderRequest: ['decidedById'],
  OrderChangeRequest: ['answeredById'],
  // W2b-5 (wave 44/44, B-W2b-297): nor who reviewed it or which office person measured it.
  MeasurementProfile: ['internalNote', 'createdById', 'measuredByUserId', 'reviewedById'],
}
/**
 * INSERT a copy of row `id` of `table` with `changes`, in `scope`: the row is read as the owner, and a partner writes only
 * the columns it has a grant on (a hidden column takes its default), as the generated isolation tests do.
 */
async function copyRow(table: string, id: string, changes: Record<string, unknown>, scope: FactoryScope = office()): Promise<number> {
  const [source] = await admin(`SELECT to_jsonb(r) AS row FROM "${table}" r WHERE r.id = $1::uuid`, [id])
  const hidden = scope.audience === 'partner' ? (PARTNER_HIDDEN[table] ?? []) : []
  const names = await admin(`SELECT column_name AS name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`, [table])
  const columns = names.map((row) => row.name as string).filter((name) => !hidden.includes(name)).map((name) => `"${name}"`).join(', ')
  return run(scope, `INSERT INTO "${table}" (${columns}) SELECT ${columns} FROM jsonb_populate_record(NULL::"${table}", $1::jsonb)`, JSON.stringify({ ...(source!.row as object), ...changes }))
}
const update = (scope: FactoryScope, table: string, id: string, set: string, ...values: unknown[]) => run(scope, `UPDATE "${table}" SET ${set} WHERE id = $1::uuid`, id, ...values)
/** Runs `text` as the owner with the triggers off: to put a row in a state the guards only reach with time. */
async function bypass(text: string, values: unknown[]): Promise<void> {
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

/** A new DRAFT of P1 made by the customer from the seed's draft (no lines), with `changes`. */
async function newDraft(changes: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID()
  await copyRow('PortalOrderRequest', seeded.requests.draft, { id, ...changes }, partner())
  return id
}
/** A line on request `requestId` with `sizes` (code → pieces), made by the customer. */
async function newLine(requestId: string, sizes: Record<string, number>, seq = 1): Promise<string> {
  const id = randomUUID()
  await copyRow('PortalOrderRequestLine', seeded.draftLines[0], { id, requestId, seq }, partner())
  for (const [size, quantity] of Object.entries(sizes)) {
    await copyRow('PortalOrderRequestSize', (await admin(`SELECT id FROM "PortalOrderRequestSize" WHERE "lineId" = $1::uuid LIMIT 1`, [seeded.draftLines[0]]))[0]!.id as string, { id: randomUUID(), lineId: id, size, quantity }, partner())
  }
  return id
}
const send = (requestId: string, number = `RQ-T-${randomUUID().slice(0, 8)}`, scope: FactoryScope = office()) =>
  update(scope, 'PortalOrderRequest', requestId, `status = 'SENT', number = $2, "sentAt" = now(), "sentById" = $3::uuid, version = version + 1`, number, seeded.buyerId)
/**
 * The database server's clock, `ms` later, for a test row's createdAt. The guards compare createdAt with a later
 * statement's now() (answeredAt, withdrawnAt, finishedAt), and the server's clock is not this process's: the local
 * stack's PostgreSQL runs in a container whose clock drifts some milliseconds from the host's either way, so a createdAt
 * taken from new Date() can lie after the next statement's now().
 */
const serverNow = async (ms = 0): Promise<string> =>
  ((await admin(`SELECT clock_timestamp() + $1::int * interval '1 millisecond' AS at`, [ms]))[0]!.at as Date).toISOString()
/** A new OPEN change request of P1 on `orderId`, made by the customer from the seed's OPEN one. */
async function newChange(changes: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID()
  const at = await serverNow()
  await copyRow('OrderChangeRequest', seeded.changes.open, { id, createdAt: at, updatedAt: at, ...changes }, partner())
  return id
}
/** A new CREATED payment intent made by the office from the seed's CREATED one, with `changes`. */
async function newIntent(changes: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID()
  const at = await serverNow()
  await copyRow('PaymentIntent', seeded.intents.created, { id, createdAt: at, updatedAt: at, ...changes })
  return id
}

beforeAll(async () => {
  db = await migratedDatabase('portalsalesw2b')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: NS })
  seeded = await seedPortalSales({ db: factory, namespace: NS })
}, 1_500_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

describe('grants and the seed', () => {
  it('classifies the six models: office and partner only, no floor, no personal data map; a link inserts a profile, the office updates one', () => {
    const ownership = loadOwnership()
    const models = classifiedModels(loadSchema(), ownership).filter(({ model }) => model.file === 'portal-sales.prisma')
    expect(models.map(({ model }) => model.name).sort()).toEqual(['OrderChangeRequest', 'OrderChangeRequestLine', 'PaymentIntent', 'PortalOrderRequest', 'PortalOrderRequestLine', 'PortalOrderRequestSize'])
    for (const { model, ownership: entry } of models) expect(Object.keys(entry.access).sort(), model.name).toEqual(['factory_partner_runtime', 'factory_runtime'])
    const names = new Set(models.map(({ model }) => model.name))
    expect(personalDataOf(loadSchema(), ownership).filter((entry) => names.has(entry.model))).toEqual([])
    const byName = (name: string) => models.find(({ model }) => model.name === name)!.ownership.access
    expect(byName('PaymentIntent').factory_partner_runtime).toMatchObject({ privileges: ['select'], hiddenColumns: ['providerAccountId', 'createdById'] })
    expect(byName('PortalOrderRequest').factory_runtime!.privileges).toEqual(['select', 'update'])
    const profile = classifiedModels(loadSchema(), ownership).find(({ model }) => model.name === 'MeasurementProfile')!.ownership.access
    expect(profile.factory_runtime!.privileges).toEqual(['select', 'insert', 'update'])
    expect(profile.factory_partner_runtime).toMatchObject({ privileges: ['select', 'insert'], hiddenColumns: ['internalNote', 'createdById', 'measuredByUserId', 'reviewedById'] })
  })

  it('the seed: a draft, three sent requests decided or waiting, three change requests, two payment intents, a profile sent by link', async () => {
    expect(await sql(office(), `SELECT r.status::text AS status, r.number FROM "PortalOrderRequest" r ORDER BY r.status`)).toEqual([
      { status: 'DRAFT', number: null },
      { status: 'SENT', number: 'SEED-RQ-0001' },
      { status: 'ACCEPTED', number: 'SEED-RQ-0002' },
      { status: 'REFUSED', number: 'SEED-RQ-0003' },
    ])
    // The first row of each table (the generated isolation tests copy it) is the one either role may insert again.
    expect((await sql(office(), `SELECT id FROM "PortalOrderRequest" ORDER BY id LIMIT 1`))[0]!.id).toBe(seeded.requests.draft)
    expect(await sql(office(), `SELECT c.kind::text AS kind, c.status::text AS status, c."amendmentId" FROM "OrderChangeRequest" c ORDER BY c.status`)).toEqual([
      { kind: 'CHANGE', status: 'OPEN', amendmentId: null },
      { kind: 'CHANGE', status: 'ACCEPTED', amendmentId: seeded.amendmentId },
      { kind: 'CANCEL', status: 'REFUSED', amendmentId: null },
    ])
    expect(await sql(office(), `SELECT p.status::text AS status, p."failureCode" FROM "PaymentIntent" p ORDER BY p.status`)).toEqual([
      { status: 'CREATED', failureCode: null },
      { status: 'FAILED', failureCode: 'card_declined' },
    ])
    expect(await sql(office(), `SELECT revision, "submittedViaLinkId", "noticeVersionId", "photosDeleteAfter" FROM "MeasurementProfile" WHERE id = $1::uuid`, seeded.profileId)).toEqual([
      { revision: 2, submittedViaLinkId: seeded.measurementLinkId, noticeVersionId: seeded.publicNoticeId, photosDeleteAfter: null },
    ])
    expect(await sql(office(), `SELECT "cancelCutoffStatus"::text AS s, "cancelCutoffDays" AS d, "changeCutoffStatus"::text AS c FROM "SalesSettings" WHERE id = $1::uuid`, a.tenantId)).toEqual([{ s: 'IN_PRODUCTION', d: 14, c: 'READY' }])
  })

  it('a partner reads its own party only, never who decided or answered nor the provider account; the floor reads none of it', async () => {
    expect((await sql(partner(), 'SELECT id FROM "PortalOrderRequest"')).length).toBe(4)
    expect((await sql(partner(), 'SELECT id FROM "OrderChangeRequest"')).length).toBe(3)
    expect((await sql(partner(), 'SELECT id FROM "PaymentIntent"')).length).toBe(2)
    for (const table of ['PortalOrderRequest', 'PortalOrderRequestLine', 'PortalOrderRequestSize', 'OrderChangeRequest', 'OrderChangeRequestLine', 'PaymentIntent']) {
      expect(await sql(partner(P2), `SELECT id FROM "${table}"`), table).toEqual([])
      await expect(sql(floor(), `SELECT 1 FROM "${table}" LIMIT 1`), table).rejects.toThrow(DENIED)
    }
    await expect(sql(partner(), 'SELECT "decidedById" FROM "PortalOrderRequest"')).rejects.toThrow(DENIED)
    await expect(sql(partner(), 'SELECT "answeredById" FROM "OrderChangeRequest"')).rejects.toThrow(DENIED)
    await expect(sql(partner(), 'SELECT "providerAccountId" FROM "PaymentIntent"')).rejects.toThrow(DENIED)
    await expect(run(partner(), `UPDATE "PaymentIntent" SET version = version WHERE false`)).rejects.toThrow(DENIED)
    await expect(run(office(), `INSERT INTO "PortalOrderRequestLine" (id) VALUES (NULL)`)).rejects.toThrow(DENIED)
  })
})

describe('order requests', () => {
  it('the customer edits its draft; the office never does; a draft is discarded whole', async () => {
    const draft = await newDraft()
    expect(await update(partner(), 'PortalOrderRequest', draft, `"customerRef" = 'PO-T-1', note = 'Two more styles', version = version + 1`)).toBe(1)
    await expect(update(office(), 'PortalOrderRequest', draft, `note = 'office words'`)).rejects.toThrow(/is the customer's; the office only sends it/)
    await expect(update(partner(), 'PortalOrderRequest', draft, `"decidedAt" = now()`)).rejects.toThrow(/changes only source, customerRef/)
    await expect(update(partner(), 'PortalOrderRequest', draft, `currency = 'euro'`)).rejects.toThrow(/an ISO currency/)
    const line = await newLine(draft, { '50': 1 })
    expect(await update(partner(), 'PortalOrderRequestLine', line, `"unitPriceShown" = 399, version = version + 1`)).toBe(1)
    await expect(update(partner(), 'PortalOrderRequestLine', line, `"unitPriceShown" = -1`)).rejects.toThrow(/a price shown of at least 0/)
    await expect(run(partner(), `UPDATE "PortalOrderRequestSize" SET quantity = 0 WHERE "lineId" = $1::uuid`, line)).rejects.toThrow(/1 to 100000 pieces/)
    await expect(run(partner(), `UPDATE "PortalOrderRequestSize" SET size = '52' WHERE "lineId" = $1::uuid`, line)).rejects.toThrow(/keeps its line and its size/)
    await expect(run(partner(), `DELETE FROM "PortalOrderRequest" WHERE id = $1::uuid`, draft)).rejects.toThrow(/foreign key/)
    expect(await run(partner(), `DELETE FROM "PortalOrderRequestSize" WHERE "lineId" = $1::uuid`, line)).toBe(1)
    expect(await run(partner(), `DELETE FROM "PortalOrderRequestLine" WHERE id = $1::uuid`, line)).toBe(1)
    expect(await run(partner(), `DELETE FROM "PortalOrderRequest" WHERE id = $1::uuid`, draft)).toBe(1)
    await expect(copyRow('PortalOrderRequest', seeded.requests.draft, { id: randomUUID(), status: 'SENT', number: 'RQ-X', sentAt: new Date().toISOString(), sentById: seeded.buyerId }, partner())).rejects.toThrow(
      /a new order request is a DRAFT/,
    )
  })

  it('sending: a number, when and who; at least one line, each with its pieces; a date not before the day it is sent', async () => {
    const empty = await newDraft()
    await expect(send(empty)).rejects.toThrow(/at least one line, each with its pieces \(0 lines/)
    const bare = await newDraft()
    const line = randomUUID()
    await copyRow('PortalOrderRequestLine', seeded.draftLines[0], { id: line, requestId: bare }, partner())
    await expect(send(bare)).rejects.toThrow(/\(1 lines, 1 without pieces\)/)
    const early = await newDraft({ requestedDate: '2020-01-02' })
    await newLine(early, { '52': 2 })
    await expect(send(early)).rejects.toThrow(/before the day it is sent/)
    await expect(update(office(), 'PortalOrderRequest', early, `status = 'SENT', number = 'RQ-NOSENDER', "sentAt" = now(), "requestedDate" = NULL`)).rejects.toThrow(/changes only status, number, sentAt, sentById/)
    await expect(update(office(), 'PortalOrderRequest', early, `status = 'SENT', number = 'RQ-NOSENDER', "sentAt" = now()`)).rejects.toThrow(/its number, when and who sent it/)
    // The customer may fix its date in the same write that sends it.
    await expect(send(early, 'RQ-T-EARLY', partner())).rejects.toThrow(/before the day it is sent/)
    expect(await update(partner(), 'PortalOrderRequest', early, `status = 'SENT', number = 'RQ-T-FIXED', "sentAt" = now(), "sentById" = $2::uuid, "requestedDate" = NULL, version = version + 1`, seeded.buyerId)).toBe(1)
    expect(await sql(office(), `SELECT status::text, number FROM "PortalOrderRequest" WHERE id = $1::uuid`, early)).toEqual([{ status: 'SENT', number: 'RQ-T-FIXED' }])
  })

  it('a sent request is frozen but for its decision or withdrawal; its lines and sizes change only while DRAFT', async () => {
    const id = seeded.requests.sent
    await expect(update(partner(), 'PortalOrderRequest', id, `note = 'later words'`)).rejects.toThrow(/moves DRAFT → SENT → ACCEPTED, REFUSED or WITHDRAWN, not SENT → SENT/)
    await expect(update(office(), 'PortalOrderRequest', id, `status = 'DRAFT', number = NULL, "sentAt" = NULL, "sentById" = NULL`)).rejects.toThrow(/not SENT → DRAFT/)
    const sentLine = (await admin(`SELECT id FROM "PortalOrderRequestLine" WHERE "requestId" = $1::uuid`, [id]))[0]!.id as string
    await expect(update(partner(), 'PortalOrderRequestLine', sentLine, `note = 'more'`)).rejects.toThrow(/change only while it is a DRAFT \(it is SENT\)/)
    await expect(copyRow('PortalOrderRequestLine', sentLine, { id: randomUUID(), seq: 9 }, partner())).rejects.toThrow(/change only while it is a DRAFT/)
    await expect(run(partner(), `DELETE FROM "PortalOrderRequestSize" WHERE "lineId" = $1::uuid`, sentLine)).rejects.toThrow(/change only while its request is a DRAFT/)
    await expect(run(partner(), `DELETE FROM "PortalOrderRequest" WHERE id = $1::uuid`, id)).rejects.toThrow(/only a draft is discarded/)
  })

  it('the office decides: one order or quote of its own company, words to refuse; never the customer; then frozen', async () => {
    const draft = await newDraft()
    await newLine(draft, { '50': 1, '54': 2 })
    await send(draft)
    const decide = (set: string, ...values: unknown[]) => update(office(), 'PortalOrderRequest', draft, `${set}, "decidedAt" = now(), "decidedById" = $2::uuid, version = version + 1`, a.actorId, ...values)
    // The partner role cannot even write who decided (decidedById: no column grant).
    await expect(update(partner(), 'PortalOrderRequest', draft, `"decidedById" = $2::uuid`, seeded.orders.so1)).rejects.toThrow(DENIED)
    await expect(update(partner(), 'PortalOrderRequest', draft, `status = 'ACCEPTED', "salesOrderId" = $2::uuid, "decidedAt" = now()`, seeded.orders.so1)).rejects.toThrow(/the office decides order request/)
    await expect(decide(`status = 'ACCEPTED'`)).rejects.toThrow(/the order or quote it became \(one\)/)
    const quote = (await admin(`SELECT id FROM "Quote" WHERE "tenantId" = $1::uuid AND "partyId" = $2::uuid LIMIT 1`, [a.tenantId, P1]))[0]!.id as string
    await expect(decide(`status = 'ACCEPTED', "salesOrderId" = $3::uuid, "quoteId" = $4::uuid`, seeded.orders.so1, quote)).rejects.toThrow(/the order or quote it became \(one\)/)
    await expect(decide(`status = 'REFUSED'`)).rejects.toThrow(/words exactly when REFUSED/)
    await expect(decide(`status = 'REFUSED', "refuseReason" = 'x', "salesOrderId" = $3::uuid`, seeded.orders.so1)).rejects.toThrow(/exactly when ACCEPTED/)
    expect(await decide(`status = 'ACCEPTED', "salesOrderId" = $3::uuid`, seeded.orders.so1)).toBe(1)
    await expect(update(office(), 'PortalOrderRequest', draft, `"refuseReason" = 'later'`)).rejects.toThrow(/is ACCEPTED; it never changes again/)
    await expect(update(office(), 'PortalOrderRequest', draft, `"salesOrderId" = $2::uuid`, seeded.orders.so2)).rejects.toThrow(/never changes again/)
  })

  it('the customer withdraws a sent request (nothing else moves); a withdrawn one never changes', async () => {
    const draft = await newDraft()
    await newLine(draft, { '52': 3 })
    await send(draft)
    await expect(update(partner(), 'PortalOrderRequest', draft, `status = 'WITHDRAWN', "withdrawnAt" = now(), note = 'bye'`)).rejects.toThrow(/changes only status, withdrawnAt/)
    await expect(update(partner(), 'PortalOrderRequest', draft, `status = 'WITHDRAWN'`)).rejects.toThrow(/withdrawn \(when\) exactly when WITHDRAWN/)
    expect(await update(partner(), 'PortalOrderRequest', draft, `status = 'WITHDRAWN', "withdrawnAt" = now(), version = version + 1`)).toBe(1)
    await expect(update(partner(), 'PortalOrderRequest', draft, `status = 'SENT'`)).rejects.toThrow(/is WITHDRAWN; it never changes again/)
  })

  it('delivered to one of the customer\'s SHIP_TO addresses, not archived', async () => {
    await expect(newDraft({ shipToAddressId: key('party-address:P1:office') })).rejects.toThrow(/one of the customer's SHIP_TO addresses/)
    const draft = await newDraft({ shipToAddressId: key('party-address:P1:workshop') })
    await expect(update(partner(), 'PortalOrderRequest', draft, `"shipToAddressId" = $2::uuid`, key('party-address:P1:office'))).rejects.toThrow(/SHIP_TO/)
    // Another party's address is not even a reference of P1's (its key names the party).
    await expect(update(partner(), 'PortalOrderRequest', draft, `"shipToAddressId" = $2::uuid`, key('party-address:P2:office'))).rejects.toThrow(/foreign key/)
  })
})

describe('change and cancel requests', () => {
  it('asked OPEN of an order open to amendments; a cancel gives its reason code, a change none; a date not already past', async () => {
    await expect(newChange({ kind: 'CANCEL' })).rejects.toThrow(/a cancel gives a code of the CANCEL reason list/)
    await expect(newChange({ reasonCode: 'LEAD_TIME' })).rejects.toThrow(/a change has no reason code/)
    // ---- B-W2b-F43: a day still to come on every day the test runs (30 days after the server's day), not 2027-01-10: from that day
    // the "already past" refusal came first.
    const comingDay = (await admin(`SELECT (current_date + 30)::text AS day`))[0]!.day as string
    await expect(newChange({ kind: 'CANCEL', reasonCode: 'LEAD_TIME', requestedDate: comingDay })).rejects.toThrow(/asks no date or address/)
    // ---- end B-W2b-F43
    await expect(newChange({ kind: 'CANCEL', reasonCode: 'lead time' })).rejects.toThrow(/a code of the CANCEL reason list/)
    await expect(newChange({ status: 'ACCEPTED' })).rejects.toThrow(/a new change request is OPEN/)
    await expect(newChange({ requestedDate: '2020-01-02' })).rejects.toThrow(/a day already past when it was asked/)
    await expect(newChange({ shipToAddressId: key('party-address:P1:office') })).rejects.toThrow(/SHIP_TO addresses/)
    await bypass(`UPDATE "SalesOrder" SET status = 'SHIPPED' WHERE id = $1::uuid`, [seeded.orders.so3])
    try {
      await expect(newChange({ orderId: seeded.orders.so3, kind: 'CANCEL', reasonCode: 'LEAD_TIME' })).rejects.toThrow(/is SHIPPED; a change or a cancel is asked only while/)
    } finally {
      await bypass(`UPDATE "SalesOrder" SET status = 'CONFIRMED' WHERE id = $1::uuid`, [seeded.orders.so3])
    }
    expect(await newChange({ orderId: seeded.orders.so3, kind: 'CANCEL', reasonCode: 'LEAD_TIME' })).toMatch(/-/)
    // Another party's order is not a reference of P1's request.
    await expect(newChange({ partyId: P2 })).rejects.toThrow(/row-level security/)
  })

  it('the customer withdraws, the office answers (words to refuse); nothing else moves; then frozen', async () => {
    const change = await newChange()
    await expect(update(partner(), 'OrderChangeRequest', change, `status = 'ACCEPTED', "answeredAt" = now()`)).rejects.toThrow(/the office answers change request/)
    await expect(update(partner(), 'OrderChangeRequest', change, `reason = 'other words'`)).rejects.toThrow(/the order, kind, ask and creation of change request .* never change/)
    await expect(update(office(), 'OrderChangeRequest', change, `answer = 'thinking'`)).rejects.toThrow(/changes only by its answer or its withdrawal/)
    await expect(update(office(), 'OrderChangeRequest', change, `status = 'REFUSED', "answeredAt" = now(), "answeredById" = $2::uuid`, a.actorId)).rejects.toThrow(/words to refuse/)
    await expect(update(office(), 'OrderChangeRequest', change, `status = 'REFUSED', "answeredAt" = now()`)).rejects.toThrow(/the answer \(when, who\)/)
    expect(await update(office(), 'OrderChangeRequest', change, `status = 'REFUSED', answer = 'Already cut', "answeredAt" = now(), "answeredById" = $2::uuid, version = version + 1`, a.actorId)).toBe(1)
    await expect(update(office(), 'OrderChangeRequest', change, `answer = 'Already cut on 3 Nov'`)).rejects.toThrow(/is REFUSED; it never changes again/)
    const other = await newChange()
    await expect(update(partner(), 'OrderChangeRequest', other, `status = 'WITHDRAWN', "withdrawnAt" = now(), "answeredAt" = now()`)).rejects.toThrow(/changes only status, withdrawnAt/)
    expect(await update(partner(), 'OrderChangeRequest', other, `status = 'WITHDRAWN', "withdrawnAt" = now(), version = version + 1`)).toBe(1)
    await expect(run(office(), `DELETE FROM "OrderChangeRequest" WHERE id = $1::uuid`, other)).rejects.toThrow(DENIED)
    await expect(admin(`DELETE FROM "OrderChangeRequest" WHERE id = $1::uuid`, [other])).rejects.toThrow(/never deleted/)
  })

  it('an accepted change names its amendment once: of its own order, made after it was asked, one request per amendment', async () => {
    const change = await newChange({ orderId: seeded.orders.so1, requestedDate: '2027-01-20', reason: 'Seed test: later, please.' })
    expect(await update(office(), 'OrderChangeRequest', change, `status = 'ACCEPTED', "answeredAt" = now(), "answeredById" = $2::uuid, version = version + 1`, a.actorId)).toBe(1)
    // SEED-SO-0001's amendment 1 was made before this request was asked (and answers the seed's own request).
    await expect(update(office(), 'OrderChangeRequest', change, `"amendmentId" = $2::uuid`, seeded.amendmentId)).rejects.toThrow(/an amendment made after it was asked|duplicate key/)
    const amendment = randomUUID()
    await copyRow('SalesOrderAmendment', seeded.amendmentId, { id: amendment, revision: 77, requestId: 'test-157-amendment', createdAt: await serverNow(1000) })
    await expect(update(partner(), 'OrderChangeRequest', change, `"amendmentId" = $2::uuid`, amendment)).rejects.toThrow(/never changes again/)
    expect(await update(office(), 'OrderChangeRequest', change, `"amendmentId" = $2::uuid, version = version + 1`, amendment)).toBe(1)
    await expect(update(office(), 'OrderChangeRequest', change, `"amendmentId" = NULL`)).rejects.toThrow(/never changes again/)
    // One request per amendment.
    const again = await newChange({ orderId: seeded.orders.so1, requestedDate: '2027-01-21', reason: 'Seed test: again.' })
    await update(office(), 'OrderChangeRequest', again, `status = 'ACCEPTED', "answeredAt" = now(), "answeredById" = $2::uuid`, a.actorId)
    await expect(update(office(), 'OrderChangeRequest', again, `"amendmentId" = $2::uuid`, amendment)).rejects.toThrow(/OrderChangeRequest_tenantId_amendmentId_key/)
    // An amendment of another order is not a reference of this request (its key names the order).
    const other = randomUUID()
    await copyRow('SalesOrderAmendment', seeded.amendmentId, { id: other, revision: 78, requestId: 'test-157-amendment-2', createdAt: await serverNow(1000) })
    const so2Change = await newChange()
    await update(office(), 'OrderChangeRequest', so2Change, `status = 'ACCEPTED', "answeredAt" = now(), "answeredById" = $2::uuid`, a.actorId)
    await expect(update(office(), 'OrderChangeRequest', so2Change, `"amendmentId" = $2::uuid`, other)).rejects.toThrow(/foreign key/)
  })

  it('the cells it asks: a line of its own order, while OPEN; a cancel asks 0, a change a different number; never changed or removed', async () => {
    const firstCell = (await admin(`SELECT id, "orderLineId" FROM "OrderChangeRequestLine" WHERE "requestId" = $1::uuid ORDER BY id LIMIT 1`, [seeded.changes.open]))[0]!
    const cell = (requestId: string, changes: Record<string, unknown> = {}) => copyRow('OrderChangeRequestLine', firstCell.id as string, { id: randomUUID(), requestId, size: `T${randomUUID().slice(0, 4)}`, ...changes }, partner())
    const change = await newChange()
    expect(await cell(change)).toBe(1)
    await expect(cell(change, { quantity: 4, quantityBefore: 4 })).rejects.toThrow(/a change a different number/)
    await expect(cell(change, { quantity: -1 })).rejects.toThrow(/0 to 100000 pieces/)
    const so1Line = (await admin(`SELECT id FROM "SalesOrderLine" WHERE "orderId" = $1::uuid LIMIT 1`, [seeded.orders.so1]))[0]!.id as string
    await expect(cell(change, { orderLineId: so1Line })).rejects.toThrow(/asks for a line of its own order/)
    const cancel = await newChange({ orderId: seeded.orders.so2, kind: 'CANCEL', reasonCode: 'PRICE' })
    await expect(cell(cancel, { quantity: 1 })).rejects.toThrow(/a cancel asks 0/)
    expect(await cell(cancel, { quantity: 0 })).toBe(1)
    await expect(cell(seeded.changes.refusedCancel, { quantity: 0 })).rejects.toThrow(/is REFUSED; what it asks is written while it is OPEN/)
    await expect(run(partner(), `UPDATE "OrderChangeRequestLine" SET quantity = 9 WHERE id = $1::uuid`, firstCell.id)).rejects.toThrow(DENIED)
    await expect(admin(`UPDATE "OrderChangeRequestLine" SET quantity = 9 WHERE id = $1::uuid`, [firstCell.id])).rejects.toThrow(/never changed or removed/)
    await expect(admin(`DELETE FROM "OrderChangeRequestLine" WHERE id = $1::uuid`, [firstCell.id])).rejects.toThrow(/never changed or removed/)
  })
})

describe('payment intents', () => {
  it('made CREATED by the office on an ACTIVE payment account, paying one open deposit request or issued TD01 / TD24 invoice', async () => {
    await expect(newIntent({ status: 'WAITING', providerRef: 'pi_x' })).rejects.toThrow(/a new payment intent is CREATED/)
    await expect(newIntent({ providerAccountId: key('integration:account:ses') })).rejects.toThrow(/an ACTIVE payment provider account/)
    await expect(newIntent({ depositRequestId: seeded.depositRequestId })).rejects.toThrow(/exactly one deposit request or invoice/)
    await expect(newIntent({ invoiceId: null, depositRequestId: seeded.depositRequestId })).rejects.toThrow(/an OPEN deposit request/)
    const td02 = (await admin(`SELECT id FROM "Invoice" WHERE "docType" = 'TD02' AND "tenantId" = $1::uuid LIMIT 1`, [a.tenantId]))[0]!.id as string
    await expect(newIntent({ invoiceId: td02 })).rejects.toThrow(/an issued TD01 or TD24 invoice/)
    const draftInvoice = (await admin(`SELECT id FROM "Invoice" WHERE status = 'DRAFT' AND "docType" = 'TD24' AND "tenantId" = $1::uuid LIMIT 1`, [a.tenantId]))[0]?.id as string | undefined
    if (draftInvoice) await expect(newIntent({ invoiceId: draftInvoice })).rejects.toThrow(/./)
    await expect(newIntent({ amount: 61001 })).rejects.toThrow(/at most its gross total/)
    await expect(newIntent({ currency: 'USD' })).rejects.toThrow(/in its currency/)
    await expect(newIntent({ amount: 0 })).rejects.toThrow(/an amount above 0/)
    await expect(newIntent({ linkId: key('link:P1') })).rejects.toThrow(/a PAYMENT or DEPOSIT_INFO link/)
    await expect(copyRow('PaymentIntent', seeded.intents.created, { id: randomUUID() }, partner())).rejects.toThrow(DENIED)
    await bypass(`UPDATE "IntegrationAccount" SET status = 'PAUSED' WHERE id = $1::uuid`, [seeded.paymentAccountId])
    try {
      await expect(newIntent()).rejects.toThrow(/an ACTIVE payment provider account/)
    } finally {
      await bypass(`UPDATE "IntegrationAccount" SET status = 'ACTIVE' WHERE id = $1::uuid`, [seeded.paymentAccountId])
    }
    expect(await newIntent({ method: 'SEPA_DEBIT' })).toMatch(/-/)
  })

  it('no card data: the provider\'s id and reason code are its own words, never a card number', async () => {
    const intent = await newIntent()
    for (const value of ['4242424242424242', 'pi 1', 'tok_4000056655665556', `pi_${'x'.repeat(260)}`]) {
      await expect(update(office(), 'PaymentIntent', intent, `"providerRef" = $2`, value), value).rejects.toThrow(/never a card number/)
    }
    await expect(update(office(), 'PaymentIntent', intent, `status = 'FAILED', "finishedAt" = now(), "failureCode" = '5555555555554444'`)).rejects.toThrow(/never a card number/)
    expect(await update(office(), 'PaymentIntent', intent, `"providerRef" = 'pi_3MtwBwLkdIwHu7ix28a3tqPa'`)).toBe(1)
    await expect(update(office(), 'PaymentIntent', intent, `"providerRef" = 'pi_other'`)).rejects.toThrow(/is set once/)
  })

  it('moves forward only; final states frozen; a succeeded intent names its payment once, of its amount and currency', async () => {
    const intent = await newIntent()
    await expect(update(office(), 'PaymentIntent', intent, `status = 'WAITING'`)).rejects.toThrow(/the provider's id once WAITING or SUCCEEDED/)
    expect(await update(office(), 'PaymentIntent', intent, `status = 'WAITING', "providerRef" = 'pi_fake_t1', version = version + 1`)).toBe(1)
    await expect(update(office(), 'PaymentIntent', intent, `status = 'CREATED'`)).rejects.toThrow(/never goes back to CREATED/)
    await expect(update(office(), 'PaymentIntent', intent, `amount = 100`)).rejects.toThrow(/how much, on which account and from where never change/)
    await expect(update(office(), 'PaymentIntent', intent, `status = 'SUCCEEDED'`)).rejects.toThrow(/finished \(when\) exactly when/)
    await expect(update(office(), 'PaymentIntent', intent, `"failureCode" = 'card_declined'`)).rejects.toThrow(/a reason code only when FAILED/)
    expect(await update(office(), 'PaymentIntent', intent, `status = 'SUCCEEDED', "finishedAt" = now(), version = version + 1`)).toBe(1)
    const amount = (await admin(`SELECT amount FROM "PaymentIntent" WHERE id = $1::uuid`, [intent]))[0]!.amount as number
    const payment = (await admin(`SELECT id FROM "Payment" WHERE "tenantId" = $1::uuid AND "partyId" = $2::uuid LIMIT 1`, [a.tenantId, P1]))[0]!.id as string
    const card = randomUUID()
    await copyRow('Payment', payment, { id: card, amount, externalRef: `pi_fake_t1-${card.slice(0, 8)}`, receivedOn: new Date().toISOString().slice(0, 10), voidedAt: null, voidReason: null, status: 'RECEIVED', version: 1 })
    await expect(update(office(), 'PaymentIntent', intent, `"paymentId" = $2::uuid`, payment)).rejects.toThrow(/of its amount and currency/)
    await expect(update(office(), 'PaymentIntent', intent, `"paymentId" = $2::uuid, "failureCode" = NULL, "finishedAt" = now()`, card)).rejects.toThrow(/never changes again/)
    expect(await update(office(), 'PaymentIntent', intent, `"paymentId" = $2::uuid, version = version + 1`, card)).toBe(1)
    await expect(update(office(), 'PaymentIntent', intent, `"paymentId" = NULL`)).rejects.toThrow(/never changes again/)
    await expect(update(office(), 'PaymentIntent', seeded.intents.failed, `status = 'SUCCEEDED', "failureCode" = NULL`)).rejects.toThrow(/is FAILED; it never changes again/)
    await expect(admin(`DELETE FROM "PaymentIntent" WHERE id = $1::uuid`, [intent])).rejects.toThrow(/never deleted/)
  })
})

describe('measurements by link', () => {
  const linkScope = () => partner(P1, seeded.measurementLinkId)
  /** A copy of the seed's link-sent profile, as revision `revision`, with `changes`. */
  const sendAgain = (revision: number, changes: Record<string, unknown> = {}, scope: FactoryScope = linkScope()) =>
    copyRow('MeasurementProfile', seeded.profileId, { id: randomUUID(), revision, supersedesId: seeded.profileId, ...changes }, scope)

  it('a link session adds only the revision sent through its MEASUREMENTS link, while the link opens, without a deletion date', async () => {
    expect(await sendAgain(3)).toBe(1)
    await expect(sendAgain(4, { submittedViaLinkId: null, submittedAt: null })).rejects.toThrow(/a link session adds only the revision the rider sent/)
    await expect(sendAgain(4, { photosDeleteAfter: '2027-03-01T00:00:00Z' })).rejects.toThrow(/without a photo deletion date/)
    await expect(sendAgain(4, { submittedViaLinkId: key('link:P1') })).rejects.toThrow(/through a MEASUREMENTS link of its party, while the link opened/)
    await expect(sendAgain(4, { submittedAt: '2026-11-01T10:00:00Z' })).rejects.toThrow(/while the link opened|no later than the send/)
    // A link of another party is not a reference of P1's profile (its key names the party).
    await expect(sendAgain(4, { noticeVersionId: null })).rejects.toThrow(/names the link, when it was sent and the notice shown/)
    // An expired link (a send inside its time, written after it) no longer sends from a link session.
    const expired = randomUUID()
    await copyRow('OneOffLink', seeded.measurementLinkId, { id: expired, tokenHash: randomUUID().replace(/-/g, '').repeat(2), uses: 0, lastUsedAt: null, createdAt: '2026-10-01T08:00:00Z', expiresAt: '2026-10-20T08:00:00Z' })
    await expect(sendAgain(4, { submittedViaLinkId: expired, submittedAt: '2026-10-15T10:00:00Z', privacyNoticeAt: '2026-10-15T09:40:00Z' }, partner(P1, expired))).rejects.toThrow(/no longer opens/)
    expect(await sendAgain(4)).toBe(1)
  })

  it('the notice shown is a published notice for people outside the company, of the link\'s company, in force when shown', async () => {
    const workerNotice = (await admin(`SELECT id FROM "PrivacyNotice" WHERE kind = 'WORKER_FLOOR' AND status = 'PUBLISHED' AND "tenantId" = $1::uuid LIMIT 1`, [a.tenantId]))[0]!.id as string
    await expect(sendAgain(5, { noticeVersionId: workerNotice }, office())).rejects.toThrow(/a notice for people outside the company/)
    await expect(sendAgain(5, { privacyNoticeAt: '2026-11-13T09:00:00Z' }, office())).rejects.toThrow(/in force when it was shown/)
    await expect(sendAgain(5, { privacyNoticeAt: '2026-11-18T10:30:00Z' }, office())).rejects.toThrow(/no later than the send/)
  })

  it('photos: three different files, AVAILABLE PHOTO files of category BODY_PHOTO, not another party\'s', async () => {
    await expect(sendAgain(6, { photoSideFileId: seeded.photoIds[0] })).rejects.toThrow(/three different files/)
    const plain = randomUUID()
    await copyRow('StoredFile', seeded.photoIds[2], { id: plain, category: 'SAMPLE_PHOTO', storageKey: `t/${a.tenantId}/test/${plain}`, sha256: 'a'.repeat(64) })
    await expect(sendAgain(6, { photoBackFileId: plain })).rejects.toThrow(/category BODY_PHOTO/)
    await expect(sendAgain(6, { photoBackFileId: plain }, office())).rejects.toThrow(/category BODY_PHOTO/)
  })

  it('never edited in place: only when the photos are deleted moves, set or moved, never cleared; only with a photo', async () => {
    const id = seeded.profileId
    await expect(update(office(), 'MeasurementProfile', id, `"fitNotes" = 'changed'`)).rejects.toThrow(/never edited in place/)
    await expect(update(office(), 'MeasurementProfile', id, `"photoBackFileId" = NULL`)).rejects.toThrow(/never edited in place/)
    expect(await update(office(), 'MeasurementProfile', id, `"photosDeleteAfter" = '2027-03-18T00:00:00Z'`)).toBe(1)
    expect(await update(office(), 'MeasurementProfile', id, `"photosDeleteAfter" = '2027-02-18T00:00:00Z'`)).toBe(1)
    await expect(update(office(), 'MeasurementProfile', id, `"photosDeleteAfter" = NULL`)).rejects.toThrow(/moved, never cleared/)
    await expect(update(office(), 'MeasurementProfile', id, `"photosDeleteAfter" = '2026-01-01T00:00:00Z'`)).rejects.toThrow(/after it was written/)
    await expect(update(office(), 'MeasurementProfile', key('measurement:P1:rider:JACKET:1'), `"photosDeleteAfter" = '2027-03-18T00:00:00Z'`)).rejects.toThrow(/only with a photo/)
    await expect(update(linkScope(), 'MeasurementProfile', id, `"photosDeleteAfter" = '2027-04-18T00:00:00Z'`)).rejects.toThrow(DENIED)
  })
})

describe('the sales settings\' cut-off rules', () => {
  it('a status cut-off is CONFIRMED, IN_PRODUCTION or READY; the cancel\'s days 1 to 365; null: no rule', async () => {
    const id = a.tenantId
    for (const set of [`"cancelCutoffStatus" = 'PARTLY_SHIPPED'`, `"changeCutoffStatus" = 'SHIPPED'`, `"cancelCutoffDays" = 0`, `"cancelCutoffDays" = 366`]) {
      await expect(update(office(), 'SalesSettings', id, set), set).rejects.toThrow(/a cut-off status is CONFIRMED, IN_PRODUCTION or READY/)
    }
    expect(await update(office(), 'SalesSettings', id, `"cancelCutoffStatus" = 'CONFIRMED', "cancelCutoffDays" = NULL, "changeCutoffStatus" = NULL, version = version + 1`)).toBe(1)
  })
})

it('TRUNCATE is refused on every new table, for every login', async () => {
  for (const table of ['PortalOrderRequest', 'PortalOrderRequestLine', 'PortalOrderRequestSize', 'OrderChangeRequest', 'OrderChangeRequestLine', 'PaymentIntent']) {
    await expect(admin(`TRUNCATE "${table}" CASCADE`), table).rejects.toThrow(/TRUNCATE on/)
  }
})
