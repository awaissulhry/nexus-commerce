import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedAuth } from '../seed/auth'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedPeople } from '../seed/people'
import { seed as seedPortalAuth, type PortalAuthSeed } from '../seed/portal-auth'
import { seed as seedProduction, type ProductionSeed } from '../seed/production'
import { seed as seedShipping } from '../seed/shipping'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'
import { seedOrderWorkflow, type OrderWorkflowFixture } from './testing/order-workflow'
import { seedSecondBrand, type SecondBrand } from './testing/second-brand'

/**
 * owb-b1 (order workflow build, schema wave "order workflow 1/1"; LF plan.md § 4, plan/PL-schema.md § 3-5A, PL-review § 2.8 and
 * § 4; the Owner's yes of 2026-11-28 on plan.md § 5 A-K): the rules of …_order_workflow_guards on a database built from the
 * migrations and seeded, through the real login and the scoped client. P1 (Brand Alpha, the seeds' customer): its portal buyer
 * (seed/portal-auth.ts), SEED-SO-0002 with its BLK and RED lines, SEED-WO-0001 at plant A1 with its steps 10-40, its cut H1:1 and
 * bundles 1-2 (seed/production.ts), A1's team L1-A (seed/people.ts), SEED-SH-0001 (SHIPPED) and SEED-SH-0002 (DRAFT)
 * (seed/shipping.ts), and the wave's own rows (testing/order-workflow.ts: a WAREHOUSE site of company A, P1's columns, "I paid",
 * L1-A in charge of SEED-SO-0002, its first print, bundle 1's hand move and skipped step, a late warning, SEED-SH-0002's warehouse
 * leg, the office member in P1's pool). Seed Brand Two (testing/second-brand.ts: its order and its file) is the other customer; a
 * second tenant's core gives a file of another tenant.
 *   - G1  the order request (REDEFINED factory_portal_order_request_guard): both doors edit a draft, its picture too; Send gives the
 *         number; "Take it back" (SENT → DRAFT, both doors) keeps it and clears when and who; a Send again keeps the SAME number,
 *         never another; refused once the office named a style draft; a draft taken back is withdrawn, never discarded, and one
 *         never sent is discarded, never withdrawn; while SENT the customer changes only the picture, the office the style drafts
 *         and the picture; accepted, frozen (the picture too); the line guard unchanged (a draft again is edited again).
 *   - G2  the picture: all three or none; an image or a PDF everybody on the order may see (never a fiscal archive, audio, body
 *         data, a priced or a design file, nor a deleted one); never another customer's file or record's, never another tenant's;
 *         a portal session names only a file shared with it; on SalesOrder the office sets it, the partner role cannot.
 *   - G3  a department's number given once (never changed, reused or deleted); ready on the floor: its name kept, never closed;
 *         the ten grid tones, an icon id; one default operation per department, which names it; a closed department named by none.
 *   - G4  one open team in charge per order; a team once per order among the open rows; a share of 1 or more; the baskets of the
 *         order's work orders, each with one open team; ended once with when and who, then frozen; never deleted.
 *   - G5  OrderPrint, BasketMove, BasketRouteEdit append-only; a print again gives its reason, a small change its words; a move
 *         back its reason; an UNDO undoes one earlier hand move of the same basket, once, never an undo; steps of the work order.
 *   - G6  a late warning born OPEN, answered once by the office (KEPT or CHANGED, with when and who); 1, 2, 3 or 5 days.
 *   - G7  "I paid" born OPEN in the portal, answered once by the office (RECORDED or DISMISSED); nothing else changes; kept.
 *   - G8  own columns: a name once among the customer's open columns (whatever its case), 1 to 40; the choices of a CHOICE column;
 *         closed once, kind kept; a use and a value name a column of the same customer (the brand wall); exactly one record or
 *         line; a value fills only its kind's field (a CHOICE one of its choices).
 *   - G9  the warehouse leg: a WAREHOUSE site of the company; arrived only once SHIPPED, once; sent on after it, once, with the
 *         customer's label (a CUSTOMER_LABEL file of the shipment) or as sent on without it; the shipment DELIVERED only after.
 *   - G10 baskets made at print (REDEFINED factory_bundle_guard): only where the site turned it on, before the cut; their cut log
 *         entries only grow (a second attach adds ids; removing or swapping one refused; each new one of the work order, no
 *         reversal); any other bundle's entries never change; madeAtPrint never changes; a normal bundle as before.
 *   - G11 the People-by-customer pool: an active office person, one open row per customer and person, ended once, never deleted.
 *   - G12 a quiet line (Message.eventKey / eventArgs) is a SYSTEM message: a portal post or a person's message never carries one;
 *         the arguments only beside the key, as one object.
 * The refusals are check_violation (SQLSTATE 23514; a key a unique_violation or a foreign_key_violation, a grant "permission
 * denied", a wall "row-level security"); their messages are read through raw SQL. Rows only time reaches (a file of a record, a
 * second cut of a hide, a reversal) are planted by the owner with triggers off; append-only is shown on the owner's own write.
 * Every name is made up. Not run in the build (Owner rule: checks at the end).
 */

const NS = 'owb-b1-order-workflow'
const DENIED = /permission denied/
const RLS = /row-level security/
const UNIQUE = /Unique constraint|duplicate key|unique/i
const FOREIGN = /_fkey|foreign key/i
// G1
const SENT_PICTURE_ONLY = /was sent; the customer changes only its picture \(the office names the style drafts it made for it\)/
const SENT_OFFICE_ONLY = /\(SENT → SENT\) changes only styleIds, pictureFileId, pictureSetAt, pictureSetById, version, updatedAt/
const TAKE_BACK_ONLY = /\(SENT → DRAFT\) changes only status, sentAt, sentById, version, updatedAt/
const FACTORY_STARTED = /the factory already started work on request .*; ask the factory/
const KEEPS_NUMBER = /keeps its number for ever; a Send after it was taken back sends it under the same number/
const SENT_STATE = /its number, when and who sent it from SENT on, together/
const NEVER_DISCARDED = /was sent once and keeps its number; it is withdrawn, never discarded/
const NEVER_WITHDRAWN = /was never sent; a draft is discarded, not withdrawn/
const MOVES = /moves DRAFT → SENT → ACCEPTED, REFUSED or WITHDRAWN \(SENT → DRAFT when taken back; a draft taken back → WITHDRAWN\)/
const FROZEN = (status: string): RegExp => new RegExp(`is ${status}; it never changes again`)
const LINES_DRAFT = /the lines of order request .* change only while it is a DRAFT/
// G2
const ALL_THREE = /names its file, when and who set it: all three or none/
const PICTURE_KIND = /is an image or a PDF everybody on the order may see/
const PICTURE_WALL = /is a file of its own company and customer, or of the whole factory; never another customer's/
const PICTURE_OPEN = /is a file this person can open/
// G3
const DEPT_FROZEN = /the number, company and creation of department .* never change/
const DEPT_KEPT = /is closed, never deleted \(its number is never given again\)/
const DEPT_FLOOR = /is ready on the floor: it stays so and keeps its name/
const DEPT_FLOOR_CLOSE = /is ready on the floor: it never closes/
const DEPT_LOOK = /has one of the ten grid tones .*, an icon id/
const DEFAULT_NAMES = /is the default operation of a department only when it names that department/
const CLOSED_DEPT = /which is closed or of another company/
// G4
const TEAM_BASKETS = /are baskets of its order's work orders at the team's site/
const ONE_TEAM = /a basket is with one team at a time/
const TEAM_SHARE = /has a share of its order's baskets of 1 or more/
const TEAM_ENDED = /was ended; it never changes again/
const TEAM_END = /is ended with when and who, both or neither/
const TEAM_KEPT = /a team of an order is ended, never deleted/
// G5
const APPEND_ONLY = (op: string, table: string): RegExp => new RegExp(`append-only: ${op} on "${table}" is refused`)
const PRINT_REASON = /gives a reason exactly when it prints AGAIN/
const PRINT_WORDS = /for a small change says what changed in words/
const MOVE_STEPS = /moves a basket of its work order between steps of that work order|_fkey|foreign key/
const MOVE_BACK = /back to an earlier step gives its reason/
const MOVE_UNDO_NAMES = /names the move it undoes exactly when it is an UNDO/
const MOVE_UNDO = /undoes an earlier hand move of the same basket \(not an undo\)/
const EDIT_STEP = /changes a step of its work order for a basket of it|_fkey|foreign key/
// G6, G7
const LATE_NEW = /a new late warning is OPEN, unanswered, at version 1/
const LATE_DAYS = /says late by 1, 2, 3 or 5 days/
const LATE_ONCE = /is answered once, OPEN → KEPT or CHANGED, with when and who; nothing else of it changes/
const LATE_ANSWERED = /late warning .* was answered \(KEPT\); it never changes again/
const LATE_KEPT = /late warning .* is answered, never deleted/
const NOTICE_NEW = /a new payment notice is OPEN, unanswered, at version 1/
const NOTICE_AMOUNT = /names an amount above 0 in an ISO currency/
const NOTICE_ONCE = /is answered once, OPEN → RECORDED or DISMISSED, with when and who; nothing else of it changes/
const NOTICE_ANSWERED = /payment notice .* was answered \(RECORDED\); it never changes again/
const NOTICE_KEPT = /payment notice .* is answered, never deleted/
const NOTICE_PROOF = /the proof of payment notice .* is a file this person can open/
// G8
const COLUMN_NAME = /has a name of 1 to 40 trimmed characters and its place/
const COLUMN_CHOICES = /has its choices exactly when it is a CHOICE column/
const COLUMN_FROZEN = /the customer, kind and creation of own column .* never change/
const COLUMN_CLOSED = /own column .* was closed; it never changes again/
const COLUMN_KEPT = /is closed, never deleted \(its values stay\)/
const USE_ONE = /is on exactly one record \(a sales order or an order request\)/
const VALUE_ONE = /is on exactly one line/
const VALUE_KIND = /fills only the field its column's kind needs/
const VALUE_KEEPS = /keeps its column and its line/
// G9
const LEG_WAREHOUSE = /goes through a WAREHOUSE site of the shipment's company/
const LEG_ARRIVE = /arrive at our warehouse only once it left \(SHIPPED; it is /
const LEG_ORDER = /records its arrival and its sending on each with when and who, sent on only after it arrived/
const LEG_ONCE = /records its arrival \(and the warehouse\) once and its sending on \(and the label\) once/
const LEG_LABEL_WAY = /is sent on with it or as sent on without it, never both/
const LEG_LABEL = /is a CUSTOMER_LABEL file of that shipment/
const LEG_DELIVERED = /goes through our warehouse; it is DELIVERED only after the warehouse sent it on/
const LEG_KEPT = /the warehouse leg of shipment .* is kept, never deleted/
// G10
const PRINT_SWITCH = /baskets are made at print only where the site turned it on/
const PRINT_NO_CUT = /is made at print, before its cut: it names no cut log entry yet/
const ONLY_ADDS = /made at print only adds cut log entries, while ACTIVE; every entry it names stays/
const CUT_ENTRIES = /names cut log entries of its work order, each once, none a reversal/
const ONLY_REPRINT = /changes only by a reprint of its ticket or by being voided/
// G11
const POOL_OFFICE = /a customer's pool names an active office person/
const POOL_ENDED = /of a customer's pool was ended; it never changes again/
const POOL_END = /of a customer's pool is ended with when and who, both or neither/
const POOL_KEPT = /a person of a customer's pool is ended, never deleted/
// G12
const QUIET_SYSTEM = /carries a quiet line's key; a quiet line is a SYSTEM message, never a person's/
const QUIET_SHAPE = /names its key \(a word key: letters, digits, _ and -, parts joined by \., up to 120\), and its arguments only beside it, as one object/

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let other: CoreSeed
let portal: PortalAuthSeed
let production: ProductionSeed
let second: SecondBrand
let ow: OrderWorkflowFixture

const key = (name: string): string => seedUuid(NS, name)
const P1 = key('party:P1')
const companyA = key('company:A')
const siteA = key('site:A1')
/** P1's own label: the product seed's jacket SEED-JKT-01 (tenant-wide, its brand P1), a style draft P1's requests may name. */
const OWN_LABEL = key('product:style:JKT-01')
const office = (): FactoryScope => ({ audience: 'office', tenantId: a.tenantId, actorId: a.actorId })
const p1 = (): FactoryScope => ({ audience: 'partner', tenantId: a.tenantId, actorId: portal.userIds.p1Buyer, partyId: P1 })
const floor = (): FactoryScope => ({ audience: 'floor', tenantId: a.tenantId, actorId: production.operatorId, siteId: siteA })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const run = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$executeRawUnsafe(text, ...values))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, unknown>[]
const insert = (scope: FactoryScope, table: string, row: Record<string, unknown>) => {
  const columns = Object.keys(row).map((column) => `"${column}"`).join(', ')
  return run(scope, `INSERT INTO "${table}" (${columns}) SELECT ${columns} FROM jsonb_populate_record(NULL::"${table}", $1::jsonb)`, JSON.stringify(row))
}
const update = (scope: FactoryScope, table: string, id: string, set: string, ...values: unknown[]) => run(scope, `UPDATE "${table}" SET ${set} WHERE id = $1::uuid`, id, ...values)
const remove = (scope: FactoryScope, table: string, id: string) => run(scope, `DELETE FROM "${table}" WHERE id = $1::uuid`, id)
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
/** A copy of row `id` of `table` with `changes`, written in `scope` through the guards (every column named). */
const copyRow = (scope: FactoryScope, table: string, id: string, changes: Record<string, unknown>) =>
  run(scope, `INSERT INTO "${table}" SELECT * FROM jsonb_populate_record(NULL::"${table}", (SELECT to_jsonb(r) || $1::jsonb FROM "${table}" r WHERE r.id = $2::uuid))`, JSON.stringify(changes), id)
const tag = (prefix: string): string => `${prefix}-${randomUUID().slice(0, 8)}`
const refusalOf = (work: Promise<unknown>): Promise<string | null> => work.then(() => null, (error: Error) => error.message)
/** Neutral words: no customer id, code or name in a refusal (the brand wall). */
async function expectNeutral(words: string | null): Promise<void> {
  expect(words).not.toBeNull()
  const parties = await admin(`SELECT id::text AS id, code, "legalName" AS legal, coalesce("tradeName", '') AS trade FROM "Party" WHERE id IN ($1::uuid, $2::uuid)`, [P1, second.partyId])
  for (const party of parties) for (const word of [party.id, party.code, party.legal, party.trade].map(String).filter((entry) => entry.length > 0)) expect(words).not.toContain(word)
}

/** A file planted as a copy of Seed Brand Two's seeded file (AVAILABLE, unscanned): office only, of company A, a PNG photo of `changes`' record. */
async function plantFile(changes: Record<string, unknown>): Promise<string> {
  const id = randomUUID()
  await plant('StoredFile', second.fileId, {
    id,
    companyId: companyA,
    storageKey: `t/${a.tenantId}/c/${companyA}/2026/${randomUUID()}`,
    kind: 'PHOTO',
    contentType: 'image/png',
    status: 'AVAILABLE',
    visibility: ['OFFICE'],
    partyId: null,
    floorSiteId: null,
    category: null,
    priced: false,
    seriesId: null,
    versionNo: 1,
    supersededAt: null,
    sourceFileId: null,
    thumbnailKey: null,
    exifStrippedAt: null,
    ...changes,
  })
  return id
}
/** A picture P1 can open: a PNG of `recordType`/`recordId` shared with P1's portal. */
const p1Picture = (recordType: string, recordId: string, changes: Record<string, unknown> = {}) =>
  plantFile({ recordType, recordId, visibility: ['OFFICE', 'PARTNER'], partyId: P1, ...changes })
/** The three picture columns, set to `fileId` by `who`, as a SET clause ($2 the file, $3 who). */
const PICTURE = `"pictureFileId" = $2::uuid, "pictureSetAt" = now(), "pictureSetById" = $3::uuid, version = version + 1`

/** A new DRAFT of P1, started in its portal (or in the office for it); its id. */
async function newDraft(scope: FactoryScope = p1()): Promise<string> {
  const id = randomUUID()
  const createdById = scope.audience === 'partner' ? portal.userIds.p1Buyer : a.actorId
  expect(await insert(scope, 'PortalOrderRequest', { id, companyId: companyA, partyId: P1, currency: 'EUR', createdById })).toBe(1)
  return id
}
/** Sends `requestId` under `number`, from `scope` (the portal's Send, or the office sending for it). */
const send = (requestId: string, number: string | null, scope: FactoryScope = p1()) =>
  update(scope, 'PortalOrderRequest', requestId, `status = 'SENT', number = $2, "sentAt" = now(), "sentById" = $3::uuid, version = version + 1`, number, scope.audience === 'partner' ? portal.userIds.p1Buyer : a.actorId)
/** "Take it back": SENT → DRAFT, when and who cleared, the number kept. */
const takeBack = (requestId: string, scope: FactoryScope = p1()) => update(scope, 'PortalOrderRequest', requestId, `status = 'DRAFT', "sentAt" = NULL, "sentById" = NULL, version = version + 1`)
const requestOf = async (requestId: string) =>
  (await admin(`SELECT status::text AS status, number, "sentAt" IS NOT NULL AS sent, "sentById" IS NOT NULL AS "sentBy", version FROM "PortalOrderRequest" WHERE id = $1::uuid`, [requestId]))[0]
/** A line on `requestId` (a DESCRIBED line, no pieces), made in `scope`. */
const draftLine = (requestId: string, seq: number, scope: FactoryScope = p1()) =>
  insert(scope, 'PortalOrderRequestLine', { id: randomUUID(), partyId: P1, requestId, seq, kind: 'DESCRIBED', description: 'Made-up team gloves', createdById: portal.userIds.p1Buyer })

beforeAll(async () => {
  db = await migratedDatabase('orderworkflow')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: NS })
  other = await seedCore({ db: factory, namespace: `${NS}-other` })
  await seedAuth({ db: factory, namespace: NS })
  portal = await seedPortalAuth({ db: factory, namespace: NS })
  production = await seedProduction({ db: factory, namespace: NS })
  await seedShipping({ db: factory, namespace: NS })
  await seedPeople({ db: factory, namespace: NS })
  second = await seedSecondBrand({ db: factory, namespace: NS })
  ow = await seedOrderWorkflow({ db: factory, namespace: NS })
}, 1_500_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

// ---------------------------------------------------------------------------------------------------------------------------
describe('G1 — the order request: Take it back, the number, the picture (REDEFINED factory_portal_order_request_guard)', () => {
  it('both doors edit a draft, its picture with its file, when and who (owb G1 (a))', async () => {
    const draft = await newDraft()
    const picture = await p1Picture('PortalOrderRequest', draft)
    expect(await update(p1(), 'PortalOrderRequest', draft, `subject = 'Made-up race kit', ${PICTURE}`, picture, portal.userIds.p1Buyer)).toBe(1)
    const pdf = await p1Picture('PortalOrderRequest', draft, { kind: 'DOCUMENT', contentType: 'application/pdf' })
    expect(await update(office(), 'PortalOrderRequest', draft, PICTURE, pdf, a.actorId)).toBe(1)
    expect(await admin(`SELECT "pictureFileId"::text AS file, "pictureSetById"::text AS who FROM "PortalOrderRequest" WHERE id = $1::uuid`, [draft])).toEqual([{ file: pdf, who: a.actorId }])
    // Back to the first line's design: all three cleared together.
    expect(await update(p1(), 'PortalOrderRequest', draft, `"pictureFileId" = NULL, "pictureSetAt" = NULL, "pictureSetById" = NULL, version = version + 1`)).toBe(1)
  })

  it('Send gives the number; Take it back keeps it and clears when and who; a Send again keeps the SAME number, never another (owb G1 (c), (d))', async () => {
    const number = tag('T-RQ')
    const draft = await newDraft()
    expect(await send(draft, number)).toBe(1)
    expect(await requestOf(draft)).toMatchObject({ status: 'SENT', number, sent: true, sentBy: true })
    // The customer takes it back: a DRAFT again with its number, unsent.
    expect(await takeBack(draft)).toBe(1)
    expect(await requestOf(draft)).toMatchObject({ status: 'DRAFT', number, sent: false, sentBy: false, version: 3 })
    // A DRAFT again: its header and its lines are edited as before (the line guard reads only the status).
    expect(await update(p1(), 'PortalOrderRequest', draft, `note = 'One more line, sorry.', version = version + 1`)).toBe(1)
    expect(await draftLine(draft, 1)).toBe(1)
    // Sent again: under the SAME number only.
    expect(await refusalOf(send(draft, tag('T-RQ')))).toMatch(KEEPS_NUMBER)
    expect(await refusalOf(send(draft, null))).toMatch(KEEPS_NUMBER)
    expect(await send(draft, number)).toBe(1)
    expect(await requestOf(draft)).toMatchObject({ status: 'SENT', number })
    // The office takes it back too (before the factory decided), and sends it again for the portal under the same number.
    expect(await takeBack(draft, office())).toBe(1)
    expect(await requestOf(draft)).toMatchObject({ status: 'DRAFT', number, sent: false })
    expect(await send(draft, number, office())).toBe(1)
    // Its line is frozen again once sent.
    const line = (await admin(`SELECT id::text AS id FROM "PortalOrderRequestLine" WHERE "requestId" = $1::uuid`, [draft]))[0]!.id as string
    expect(await refusalOf(update(p1(), 'PortalOrderRequestLine', line, `note = 'more', version = version + 1`))).toMatch(LINES_DRAFT)
  })

  it('Take it back changes only the status, when and who (cleared), the version: never the number, never kept sent times (owb G1 (c), (d))', async () => {
    const draft = await newDraft()
    expect(await send(draft, tag('T-RQ'))).toBe(1)
    expect(await refusalOf(update(p1(), 'PortalOrderRequest', draft, `status = 'DRAFT', number = NULL, "sentAt" = NULL, "sentById" = NULL, version = version + 1`))).toMatch(TAKE_BACK_ONLY)
    expect(await refusalOf(update(office(), 'PortalOrderRequest', draft, `status = 'DRAFT', "sentAt" = NULL, "sentById" = NULL, note = 'Taken back', version = version + 1`))).toMatch(TAKE_BACK_ONLY)
    expect(await refusalOf(update(p1(), 'PortalOrderRequest', draft, `status = 'DRAFT', version = version + 1`))).toMatch(SENT_STATE)
    expect(await refusalOf(update(p1(), 'PortalOrderRequest', draft, `status = 'DRAFT', "sentAt" = NULL, version = version + 1`))).toMatch(SENT_STATE)
    expect(await requestOf(draft)).toMatchObject({ status: 'SENT', sent: true })
    // A new request is still unnumbered (the INSERT rule, unchanged).
    expect(await refusalOf(insert(p1(), 'PortalOrderRequest', { id: randomUUID(), companyId: companyA, partyId: P1, currency: 'EUR', number: tag('T-RQ'), createdById: portal.userIds.p1Buyer }))).toMatch(
      /a new order request is a DRAFT, unnumbered and unsent, at version 1/,
    )
  })

  it('Take it back is refused once the factory acted on it: the office named a style draft for it (owb G1 (c2), PL-review § 2.8)', async () => {
    const draft = await newDraft()
    expect(await send(draft, tag('T-RQ'))).toBe(1)
    expect(await update(office(), 'PortalOrderRequest', draft, `"styleIds" = "styleIds" || $2::uuid, version = version + 1`, OWN_LABEL)).toBe(1)
    const words = await refusalOf(takeBack(draft))
    expect(words).toMatch(FACTORY_STARTED)
    await expectNeutral(words)
    expect(await refusalOf(takeBack(draft, office()))).toMatch(FACTORY_STARTED)
    // Named while it was a DRAFT, then sent: refused too.
    const named = await newDraft(office())
    expect(await update(office(), 'PortalOrderRequest', named, `"styleIds" = ARRAY[$2::uuid], version = version + 1`, OWN_LABEL)).toBe(1)
    expect(await send(named, tag('T-RQ'), office())).toBe(1)
    expect(await refusalOf(takeBack(named))).toMatch(FACTORY_STARTED)
    expect(await requestOf(named)).toMatchObject({ status: 'SENT' })
  })

  it('a draft taken back keeps its number: withdrawn, never discarded; a draft never sent is discarded, never withdrawn (owb G1 (e))', async () => {
    const draft = await newDraft()
    expect(await send(draft, tag('T-RQ'))).toBe(1)
    expect(await takeBack(draft)).toBe(1)
    expect(await refusalOf(remove(p1(), 'PortalOrderRequest', draft))).toMatch(NEVER_DISCARDED)
    expect(await refusalOf(remove(office(), 'PortalOrderRequest', draft))).toMatch(NEVER_DISCARDED)
    expect(await refusalOf(update(p1(), 'PortalOrderRequest', draft, `status = 'WITHDRAWN', "withdrawnAt" = now(), note = 'bye', version = version + 1`))).toMatch(/changes only status, withdrawnAt, version, updatedAt/)
    expect(await update(p1(), 'PortalOrderRequest', draft, `status = 'WITHDRAWN', "withdrawnAt" = now(), version = version + 1`)).toBe(1)
    expect(await requestOf(draft)).toMatchObject({ status: 'WITHDRAWN', sent: false })
    expect(await refusalOf(update(p1(), 'PortalOrderRequest', draft, `status = 'SENT', version = version + 1`))).toMatch(FROZEN('WITHDRAWN'))
    // Never sent: withdrawn refused, discarded whole.
    const fresh = await newDraft()
    expect(await refusalOf(update(p1(), 'PortalOrderRequest', fresh, `status = 'WITHDRAWN', "withdrawnAt" = now(), version = version + 1`))).toMatch(NEVER_WITHDRAWN)
    expect(await remove(p1(), 'PortalOrderRequest', fresh)).toBe(1)
    // A sent one is still withdrawn as before (it keeps when and who sent it).
    const sent = await newDraft()
    expect(await send(sent, tag('T-RQ'))).toBe(1)
    expect(await update(p1(), 'PortalOrderRequest', sent, `status = 'WITHDRAWN', "withdrawnAt" = now(), version = version + 1`)).toBe(1)
    expect(await requestOf(sent)).toMatchObject({ status: 'WITHDRAWN', sent: true, sentBy: true })
  })

  it('while SENT the customer changes only its picture; the office the style drafts and the picture (owb G1 (b))', async () => {
    const draft = await newDraft()
    expect(await send(draft, tag('T-RQ'))).toBe(1)
    const mine = await p1Picture('PortalOrderRequest', draft)
    expect(await update(p1(), 'PortalOrderRequest', draft, PICTURE, mine, portal.userIds.p1Buyer)).toBe(1)
    for (const set of [`note = 'Later words.'`, `subject = 'Another subject'`, `"customerRef" = 'PO-T-LATE'`, `note = 'With it.', "pictureFileId" = NULL, "pictureSetAt" = NULL, "pictureSetById" = NULL`]) {
      expect(await refusalOf(update(p1(), 'PortalOrderRequest', draft, `${set}, version = version + 1`)), set).toMatch(SENT_PICTURE_ONLY)
    }
    // The partner role neither reads nor writes the style drafts (no grant).
    expect(await refusalOf(update(p1(), 'PortalOrderRequest', draft, `"styleIds" = ARRAY[$2::uuid], version = version + 1`, OWN_LABEL))).toMatch(DENIED)
    const ours = await p1Picture('PortalOrderRequest', draft)
    expect(await update(office(), 'PortalOrderRequest', draft, `"styleIds" = "styleIds" || $4::uuid, ${PICTURE}`, ours, a.actorId, OWN_LABEL)).toBe(1)
    expect(await refusalOf(update(office(), 'PortalOrderRequest', draft, `note = 'Office words after the Send.', version = version + 1`))).toMatch(SENT_OFFICE_ONLY)
    expect(await admin(`SELECT status::text AS status, "pictureFileId"::text AS file, note FROM "PortalOrderRequest" WHERE id = $1::uuid`, [draft])).toEqual([{ status: 'SENT', file: ours, note: null }])
  })

  it('the office accepts a sent request (never a draft taken back); accepted, nothing changes — its picture neither (owb G1, frozen as before)', async () => {
    const draft = await newDraft()
    expect(await send(draft, tag('T-RQ'))).toBe(1)
    expect(await takeBack(draft)).toBe(1)
    const decide = (requestId: string) =>
      update(office(), 'PortalOrderRequest', requestId, `status = 'ACCEPTED', "salesOrderId" = $2::uuid, "decidedAt" = now(), "decidedById" = $3::uuid, version = version + 1`, ow.orderId, a.actorId)
    expect(await refusalOf(decide(draft))).toMatch(MOVES)
    const number = (await requestOf(draft))!.number as string
    expect(await send(draft, number)).toBe(1)
    expect(await decide(draft)).toBe(1)
    const picture = await p1Picture('PortalOrderRequest', draft)
    expect(await refusalOf(update(office(), 'PortalOrderRequest', draft, PICTURE, picture, a.actorId))).toMatch(FROZEN('ACCEPTED'))
    expect(await refusalOf(update(p1(), 'PortalOrderRequest', draft, PICTURE, picture, portal.userIds.p1Buyer))).toMatch(FROZEN('ACCEPTED'))
    expect(await refusalOf(takeBack(draft))).toMatch(FROZEN('ACCEPTED'))
  })
})

// ---------------------------------------------------------------------------------------------------------------------------
describe('G2 — the order picture (factory_order_picture_check)', () => {
  it('names its file, when and who: all three or none', async () => {
    const draft = await newDraft()
    const picture = await p1Picture('PortalOrderRequest', draft)
    expect(await refusalOf(update(p1(), 'PortalOrderRequest', draft, `"pictureFileId" = $2::uuid, version = version + 1`, picture))).toMatch(ALL_THREE)
    expect(await refusalOf(update(p1(), 'PortalOrderRequest', draft, `"pictureFileId" = $2::uuid, "pictureSetAt" = now(), version = version + 1`, picture))).toMatch(ALL_THREE)
    expect(await refusalOf(update(office(), 'SalesOrder', ow.orderId, `"pictureSetAt" = now(), version = version + 1`))).toMatch(ALL_THREE)
  })

  it('an image or a PDF everybody on the order may see: never a fiscal archive, audio, body data, a priced or a design file, nor a deleted one', async () => {
    const draft = await newDraft(office())
    const bad: Record<string, unknown>[] = [
      { kind: 'FISCAL_ARCHIVE', contentType: 'application/pdf' },
      { kind: 'AUDIO', contentType: 'audio/mpeg' },
      { category: 'MEASUREMENTS' },
      { category: 'BODY_PHOTO' },
      { category: 'MTM_PHOTO' },
      { category: 'FITTING_PHOTO' },
      { priced: true },
      { kind: 'ATTACHMENT', contentType: 'image/vnd.adobe.photoshop' },
      { kind: 'ATTACHMENT', contentType: 'text/csv' },
      { status: 'DELETED', deletedAt: new Date().toISOString() },
    ]
    for (const changes of bad) {
      const file = await p1Picture('PortalOrderRequest', draft, changes)
      expect(await refusalOf(update(office(), 'PortalOrderRequest', draft, PICTURE, file, a.actorId)), JSON.stringify(changes)).toMatch(PICTURE_KIND)
    }
    expect(await update(office(), 'PortalOrderRequest', draft, PICTURE, await p1Picture('PortalOrderRequest', draft, { kind: 'DOCUMENT', contentType: 'application/pdf' }), a.actorId)).toBe(1)
    expect(await update(office(), 'PortalOrderRequest', draft, PICTURE, await p1Picture('PortalOrderRequest', draft, { contentType: 'Image/JPEG; q=1' }), a.actorId)).toBe(1)
  })

  it("never another customer's file nor a file of another customer's record (the brand wall), never another tenant's", async () => {
    const draft = await newDraft(office())
    // Seed Brand Two's own file, shared with its portal.
    const words = await refusalOf(update(office(), 'PortalOrderRequest', draft, PICTURE, second.fileId, a.actorId))
    expect(words).toMatch(PICTURE_WALL)
    await expectNeutral(words)
    // An office-only file of Seed Brand Two's order (no party on the file, its record's is Brand Two).
    const ofBeta = await plantFile({ recordType: 'SalesOrder', recordId: second.salesOrderId })
    expect(await refusalOf(update(office(), 'PortalOrderRequest', draft, PICTURE, ofBeta, a.actorId))).toMatch(PICTURE_WALL)
    // A file of company B.
    const companyB = await plantFile({ recordType: 'PortalOrderRequest', recordId: draft, companyId: key('company:B'), storageKey: `t/${a.tenantId}/c/${key('company:B')}/2026/${randomUUID()}` })
    expect(await refusalOf(update(office(), 'PortalOrderRequest', draft, PICTURE, companyB, a.actorId))).toMatch(PICTURE_WALL)
    // A file of another tenant is no file of this one (the tenant-safe reference).
    const otherTenant = randomUUID()
    await plant('StoredFile', second.fileId, {
      id: otherTenant,
      tenantId: other.tenantId,
      companyId: other.companies[0]!.id,
      storageKey: `t/${other.tenantId}/c/${other.companies[0]!.id}/2026/${randomUUID()}`,
      recordType: 'Company',
      recordId: other.companies[0]!.id,
      visibility: ['OFFICE'],
      partyId: null,
      seriesId: null,
      sourceFileId: null,
    })
    // (The picture's own check speaks first: no such file in this tenant for this session; else the reference refuses it.)
    expect(await refusalOf(update(office(), 'PortalOrderRequest', draft, PICTURE, otherTenant, a.actorId))).toMatch(/is a file this person can open|_fkey|foreign key/)
    // A tenant-wide file of our own (a style of our collection): fine.
    expect(await update(office(), 'PortalOrderRequest', draft, PICTURE, await plantFile({ companyId: null, recordType: 'Style', recordId: production.styleId, storageKey: `t/${a.tenantId}/tenant/2026/${randomUUID()}` }), a.actorId)).toBe(1)
  })

  it('a portal session names only a file shared with its own party', async () => {
    const draft = await newDraft()
    const officeOnly = await plantFile({ recordType: 'PortalOrderRequest', recordId: draft })
    expect(await refusalOf(update(p1(), 'PortalOrderRequest', draft, PICTURE, officeOnly, portal.userIds.p1Buyer))).toMatch(PICTURE_OPEN)
    expect(await refusalOf(update(p1(), 'PortalOrderRequest', draft, PICTURE, second.fileId, portal.userIds.p1Buyer))).toMatch(PICTURE_OPEN)
  })

  it("the order's picture on SalesOrder: the office sets it (Confirm's carry, a customer's choice through the API); the partner role cannot", async () => {
    const picture = await p1Picture('SalesOrder', ow.orderId)
    expect(await update(office(), 'SalesOrder', ow.orderId, PICTURE, picture, a.actorId)).toBe(1)
    expect(await refusalOf(update(p1(), 'SalesOrder', ow.orderId, PICTURE, picture, portal.userIds.p1Buyer))).toMatch(DENIED)
    expect(await refusalOf(update(office(), 'SalesOrder', ow.orderId, PICTURE, await p1Picture('SalesOrder', ow.orderId, { priced: true }), a.actorId))).toMatch(PICTURE_KIND)
    // The partner role does not read who set it (hidden, like createdById).
    await expect(as(p1(), (client) => client.$queryRawUnsafe(`SELECT "pictureSetById" FROM "SalesOrder" LIMIT 1`))).rejects.toThrow(DENIED)
  })
})

// ---------------------------------------------------------------------------------------------------------------------------
describe('G3 — departments (factory_department_guard, factory_operation_department_check)', () => {
  let numberSeq = 900
  /** A new department of the whole factory, number 900 or more; its id. */
  async function newDepartment(extra: Record<string, unknown> = {}): Promise<{ id: string; number: number }> {
    const made = { id: randomUUID(), number: ++numberSeq }
    expect(await insert(office(), 'Department', { id: made.id, number: made.number, name: `Made-up hall ${made.number}`, shortName: `Hall ${made.number}`, tone: 'cyan', icon: 'shirt', workCentreKind: 'SEWING', createdById: a.actorId, ...extra })).toBe(1)
    return made
  }
  /** A library operation copied from the product seed's SEW, with `changes`; its id. */
  async function newOperation(changes: Record<string, unknown>): Promise<string> {
    const id = randomUUID()
    expect(await copyRow(office(), 'Operation', key('product:operation:SEW'), { id, code: tag('OWB-OP'), version: 1, ...changes })).toBe(1)
    return id
  }

  it('a number is given once: never changed, never reused, never deleted (closed instead)', async () => {
    const dept = await newDepartment()
    expect(await refusalOf(insert(office(), 'Department', { id: randomUUID(), number: dept.number, name: 'Again', shortName: 'Again', tone: 'blue', icon: 'ruler', workCentreKind: 'CUTTING' }))).toMatch(UNIQUE)
    expect(await refusalOf(update(office(), 'Department', dept.id, `number = 999, version = version + 1`))).toMatch(DEPT_FROZEN)
    expect(await refusalOf(insert(office(), 'Department', { id: randomUUID(), number: 0, name: 'Zero', shortName: 'Zero', tone: 'blue', icon: 'ruler', workCentreKind: 'CUTTING' }))).toMatch(/has a number of 1 or more/)
    expect(await refusalOf(insert(office(), 'Department', { id: randomUUID(), number: 950, status: 'CLOSED', name: 'Closed', shortName: 'Closed', tone: 'blue', icon: 'ruler', workCentreKind: 'CUTTING' }))).toMatch(/a new department is ACTIVE, at version 1/)
    // The office has no DELETE grant; the owner's own DELETE meets the guard.
    expect(await refusalOf(remove(office(), 'Department', dept.id))).toMatch(DENIED)
    await expect(admin(`DELETE FROM "Department" WHERE id = $1::uuid`, [dept.id])).rejects.toThrow(DEPT_KEPT)
    expect(await update(office(), 'Department', dept.id, `status = 'CLOSED', version = version + 1`)).toBe(1)
    expect(await update(office(), 'Department', dept.id, `name = 'Made-up old hall', version = version + 1`)).toBe(1)
  })

  it('a department ready on the floor keeps its name and never closes', async () => {
    const dept = await newDepartment({ floorReady: true })
    expect(await refusalOf(update(office(), 'Department', dept.id, `name = 'Renamed', version = version + 1`))).toMatch(DEPT_FLOOR)
    expect(await refusalOf(update(office(), 'Department', dept.id, `"floorReady" = false, version = version + 1`))).toMatch(DEPT_FLOOR)
    expect(await refusalOf(update(office(), 'Department', dept.id, `status = 'CLOSED', version = version + 1`))).toMatch(DEPT_FLOOR_CLOSE)
    // Its tone, icon, short name and place may still change.
    expect(await update(office(), 'Department', dept.id, `tone = 'violet', icon = 'pen-tool', "shortName" = 'Hall', seq = 3, version = version + 1`)).toBe(1)
  })

  it('one of the ten grid tones; an icon id', async () => {
    const dept = await newDepartment()
    for (const set of [`tone = 'green'`, `tone = 'Blue'`, `icon = 'Scissors'`, `icon = 'shield check'`, `icon = ''`, `name = ' Hall'`, `"shortName" = ''`]) {
      expect(await refusalOf(update(office(), 'Department', dept.id, `${set}, version = version + 1`)), set).toMatch(DEPT_LOOK)
    }
    for (const tone of ['slate', 'purple', 'emerald', 'pink', 'orange', 'blue', 'yellow', 'red', 'violet', 'cyan']) {
      expect(await update(office(), 'Department', dept.id, `tone = $2, icon = 'shield-check', version = version + 1`, tone), tone).toBe(1)
    }
  })

  it('one default operation per department, which names it; a closed department is named by no new operation or step', async () => {
    const dept = await newDepartment()
    await newOperation({ departmentId: dept.id, departmentDefault: true })
    expect(await refusalOf(newOperation({ departmentId: dept.id, departmentDefault: true }))).toMatch(UNIQUE)
    expect(await refusalOf(newOperation({ departmentId: null, departmentDefault: true }))).toMatch(DEFAULT_NAMES)
    await newOperation({ departmentId: dept.id, departmentDefault: false })
    const closed = await newDepartment()
    expect(await update(office(), 'Department', closed.id, `status = 'CLOSED', version = version + 1`)).toBe(1)
    expect(await refusalOf(newOperation({ departmentId: closed.id, departmentDefault: false }))).toMatch(CLOSED_DEPT)
    // The floor reads departments, never writes them.
    expect((await as(floor(), (client) => client.$queryRawUnsafe<unknown[]>(`SELECT id FROM "Department" WHERE id = $1::uuid`, dept.id))).length).toBe(1)
    expect(await refusalOf(update(floor(), 'Department', dept.id, `seq = 9`))).toMatch(DENIED)
  })
})

// ---------------------------------------------------------------------------------------------------------------------------
describe('G4 — the teams of an order (factory_order_team_guard)', () => {
  /** A new team of plant A1 (company A); its id. */
  async function newTeam(): Promise<string> {
    const id = randomUUID()
    expect(await insert(office(), 'Team', { id, companyId: companyA, siteId: siteA, code: tag('T-TEAM'), name: 'Made-up team', createdById: a.actorId })).toBe(1)
    return id
  }
  const teamRow = (teamId: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: randomUUID(),
    companyId: companyA,
    partyId: P1,
    siteId: siteA,
    salesOrderId: ow.orderId,
    teamId,
    createdById: a.actorId,
    ...extra,
  })

  it('one open team in charge per order; a team once per order among the open rows; a share of 1 or more', async () => {
    const team = await newTeam()
    // The fixture's L1-A is in charge of SEED-SO-0002.
    expect(await refusalOf(insert(office(), 'OrderTeam', teamRow(team, { inCharge: true })))).toMatch(UNIQUE)
    expect(await refusalOf(insert(office(), 'OrderTeam', teamRow(ow.teamId)))).toMatch(UNIQUE)
    expect(await refusalOf(insert(office(), 'OrderTeam', teamRow(team, { basketShare: 0 })))).toMatch(TEAM_SHARE)
    expect(await insert(office(), 'OrderTeam', teamRow(team, { basketShare: 2 }))).toBe(1)
    expect(await refusalOf(insert(office(), 'OrderTeam', teamRow(team, { endedAt: new Date().toISOString(), endedById: a.actorId })))).toMatch(/a new order team is open \(not ended\), at version 1/)
  })

  it("the baskets of the order's work orders at the team's site, each with one open team", async () => {
    const team = await newTeam()
    const row = teamRow(team)
    expect(await insert(office(), 'OrderTeam', row)).toBe(1)
    expect(await update(office(), 'OrderTeam', ow.ids.team, `"bundleIds" = ARRAY[$2::uuid], version = version + 1`, ow.bundleIds[0])).toBe(1)
    expect(await refusalOf(update(office(), 'OrderTeam', row.id as string, `"bundleIds" = ARRAY[$2::uuid], version = version + 1`, ow.bundleIds[0]))).toMatch(ONE_TEAM)
    expect(await refusalOf(update(office(), 'OrderTeam', row.id as string, `"bundleIds" = ARRAY[$2::uuid], version = version + 1`, randomUUID()))).toMatch(TEAM_BASKETS)
    expect(await refusalOf(update(office(), 'OrderTeam', row.id as string, `"bundleIds" = ARRAY[$2::uuid, $2::uuid], version = version + 1`, ow.bundleIds[1]))).toMatch(TEAM_SHARE)
    expect(await update(office(), 'OrderTeam', row.id as string, `"bundleIds" = ARRAY[$2::uuid], version = version + 1`, ow.bundleIds[1])).toBe(1)
    // The order, the team, the site and how it was given never change.
    expect(await refusalOf(update(office(), 'OrderTeam', row.id as string, `"givenBy" = 'RULE', version = version + 1`))).toMatch(/never change/)
  })

  it('ended once with when and who; then never changes; never deleted', async () => {
    const row = teamRow(await newTeam())
    expect(await insert(office(), 'OrderTeam', row)).toBe(1)
    expect(await refusalOf(update(office(), 'OrderTeam', row.id as string, `"endedAt" = now(), version = version + 1`))).toMatch(TEAM_END)
    expect(await update(office(), 'OrderTeam', row.id as string, `"endedAt" = now(), "endedById" = $2::uuid, version = version + 1`, a.actorId)).toBe(1)
    expect(await refusalOf(update(office(), 'OrderTeam', row.id as string, `"basketShare" = 3, version = version + 1`))).toMatch(TEAM_ENDED)
    expect(await refusalOf(remove(office(), 'OrderTeam', row.id as string))).toMatch(DENIED)
    await expect(admin(`DELETE FROM "OrderTeam" WHERE id = $1::uuid`, [row.id])).rejects.toThrow(TEAM_KEPT)
    // The floor reads its site's order teams, never writes them.
    expect(await refusalOf(update(floor(), 'OrderTeam', ow.ids.team, `"basketShare" = 1`))).toMatch(DENIED)
  })
})

// ---------------------------------------------------------------------------------------------------------------------------
describe('G5 — prints, basket moves and route changes: append-only, and what each insert says', () => {
  const printRow = (extra: Record<string, unknown>): Record<string, unknown> => ({
    id: randomUUID(),
    companyId: companyA,
    partyId: P1,
    salesOrderId: ow.orderId,
    kind: 'AGAIN',
    pages: [{ salesOrderLineId: ow.orderLineIds[0], page: 1 }],
    cards: [],
    createdById: a.actorId,
    ...extra,
  })
  const moveRow = (extra: Record<string, unknown>): Record<string, unknown> => ({
    id: randomUUID(),
    siteId: siteA,
    workOrderId: ow.workOrderId,
    bundleId: ow.bundleIds[1],
    fromOperationId: ow.stepIds.sew,
    toOperationId: ow.stepIds.cut,
    kind: 'BACK',
    reason: 'REDO',
    groupId: randomUUID(),
    workerId: production.operatorId,
    ...extra,
  })

  it('a print again gives its reason, a small change says what; a first print gives none; then never changed', async () => {
    expect(await refusalOf(insert(office(), 'OrderPrint', printRow({ reason: null })))).toMatch(PRINT_REASON)
    expect(await refusalOf(insert(office(), 'OrderPrint', printRow({ kind: 'FIRST', reason: 'LOST' })))).toMatch(PRINT_REASON)
    expect(await refusalOf(insert(office(), 'OrderPrint', printRow({ reason: 'SMALL_CHANGE' })))).toMatch(PRINT_WORDS)
    expect(await refusalOf(insert(office(), 'OrderPrint', printRow({ reason: 'SMALL_CHANGE', note: '   ' })))).toMatch(PRINT_WORDS)
    expect(await refusalOf(insert(office(), 'OrderPrint', printRow({ reason: 'LOST', pages: { page: 1 } })))).toMatch(/names its pages and its basket cards as lists/)
    const row = printRow({ reason: 'SMALL_CHANGE', note: 'Made-up: the logo moves 2 cm up.' })
    expect(await insert(office(), 'OrderPrint', row)).toBe(1)
    expect(await insert(office(), 'OrderPrint', printRow({ reason: 'DAMAGED' }))).toBe(1)
    expect(await refusalOf(update(office(), 'OrderPrint', row.id as string, `note = 'x'`))).toMatch(DENIED)
    await expect(admin(`UPDATE "OrderPrint" SET note = 'x' WHERE id = $1::uuid`, [row.id])).rejects.toThrow(APPEND_ONLY('UPDATE', 'OrderPrint'))
    await expect(admin(`DELETE FROM "OrderPrint" WHERE id = $1::uuid`, [row.id])).rejects.toThrow(APPEND_ONLY('DELETE', 'OrderPrint'))
  })

  it('a move back gives its reason; an UNDO undoes one earlier hand move of the same basket, once, never an undo; steps of the work order', async () => {
    expect(await refusalOf(insert(floor(), 'BasketMove', moveRow({ reason: null })))).toMatch(MOVE_BACK)
    expect(await refusalOf(insert(floor(), 'BasketMove', moveRow({ toOperationId: randomUUID() })))).toMatch(MOVE_STEPS)
    expect(await refusalOf(insert(floor(), 'BasketMove', moveRow({ note: '  ' })))).toMatch(/has words of 1 to 500 characters/)
    const back = moveRow({})
    expect(await insert(floor(), 'BasketMove', back)).toBe(1)
    // Ready to ship: no step to go to.
    expect(await insert(floor(), 'BasketMove', moveRow({ kind: 'FORWARD', reason: null, fromOperationId: ow.stepIds.pack, toOperationId: null }))).toBe(1)
    expect(await refusalOf(insert(floor(), 'BasketMove', moveRow({ kind: 'UNDO', reason: null })))).toMatch(MOVE_UNDO_NAMES)
    expect(await refusalOf(insert(floor(), 'BasketMove', moveRow({ kind: 'FORWARD', reason: null, undoesId: back.id })))).toMatch(MOVE_UNDO_NAMES)
    const undo = moveRow({ kind: 'UNDO', reason: null, undoesId: back.id, fromOperationId: ow.stepIds.cut, toOperationId: ow.stepIds.sew })
    expect(await insert(floor(), 'BasketMove', undo)).toBe(1)
    expect(await refusalOf(insert(floor(), 'BasketMove', { ...undo, id: randomUUID() }))).toMatch(UNIQUE)
    expect(await refusalOf(insert(floor(), 'BasketMove', moveRow({ kind: 'UNDO', reason: null, undoesId: undo.id })))).toMatch(MOVE_UNDO)
    // Another basket's move is not this basket's to undo (the reference names the basket too).
    expect(await refusalOf(insert(office(), 'BasketMove', moveRow({ bundleId: ow.bundleIds[0], kind: 'UNDO', reason: null, undoesId: back.id, workerId: null, userId: a.actorId })))).toMatch(/_fkey|foreign key|undoes an earlier hand move/)
    expect(await refusalOf(update(floor(), 'BasketMove', back.id as string, `note = 'x'`))).toMatch(DENIED)
    await expect(admin(`UPDATE "BasketMove" SET note = 'x' WHERE id = $1::uuid`, [back.id])).rejects.toThrow(APPEND_ONLY('UPDATE', 'BasketMove'))
    await expect(admin(`DELETE FROM "BasketMove" WHERE id = $1::uuid`, [back.id])).rejects.toThrow(APPEND_ONLY('DELETE', 'BasketMove'))
  })

  it('a route change names a step of the basket’s work order; never changed', async () => {
    const row = { id: randomUUID(), siteId: siteA, workOrderId: ow.workOrderId, bundleId: ow.bundleIds[1], operationId: ow.stepIds.qc, kind: 'SKIP', reason: 'CUSTOMER', groupId: randomUUID(), workerId: production.operatorId }
    expect(await refusalOf(insert(floor(), 'BasketRouteEdit', { ...row, operationId: randomUUID() }))).toMatch(EDIT_STEP)
    expect(await insert(floor(), 'BasketRouteEdit', row)).toBe(1)
    await expect(admin(`UPDATE "BasketRouteEdit" SET note = 'x' WHERE id = $1::uuid`, [row.id])).rejects.toThrow(APPEND_ONLY('UPDATE', 'BasketRouteEdit'))
    await expect(admin(`TRUNCATE "BasketRouteEdit"`)).rejects.toThrow(APPEND_ONLY('TRUNCATE', 'BasketRouteEdit'))
  })
})

// ---------------------------------------------------------------------------------------------------------------------------
describe('G6 + G7 — answered once: the late warning, "I paid"', () => {
  it('a late warning is born OPEN on the floor and answered once by the office (KEPT or CHANGED, with when and who)', async () => {
    const row = { id: randomUUID(), siteId: siteA, workOrderId: ow.workOrderId, days: 3, reason: 'MACHINE', workerId: production.operatorId }
    expect(await refusalOf(insert(floor(), 'FloorLateWarning', { ...row, id: randomUUID(), days: 4 }))).toMatch(LATE_DAYS)
    expect(await refusalOf(insert(floor(), 'FloorLateWarning', { ...row, id: randomUUID(), state: 'KEPT' }))).toMatch(LATE_NEW)
    expect(await refusalOf(insert(floor(), 'FloorLateWarning', { ...row, id: randomUUID(), bundleId: randomUUID() }))).toMatch(/names a basket of its own work order|_fkey|foreign key/)
    expect(await insert(floor(), 'FloorLateWarning', row)).toBe(1)
    expect(await refusalOf(update(floor(), 'FloorLateWarning', row.id, `state = 'KEPT'`))).toMatch(DENIED)
    expect(await refusalOf(update(office(), 'FloorLateWarning', row.id, `state = 'KEPT', "answeredAt" = now(), version = version + 1`))).toMatch(LATE_ONCE)
    expect(await refusalOf(update(office(), 'FloorLateWarning', row.id, `state = 'KEPT', "answeredAt" = now(), "answeredById" = $2::uuid, days = 5, version = version + 1`, a.actorId))).toMatch(LATE_ONCE)
    expect(await update(office(), 'FloorLateWarning', row.id, `state = 'KEPT', "answeredAt" = now(), "answeredById" = $2::uuid, version = version + 1`, a.actorId)).toBe(1)
    expect(await refusalOf(update(office(), 'FloorLateWarning', row.id, `state = 'CHANGED', version = version + 1`))).toMatch(LATE_ANSWERED)
    await expect(admin(`DELETE FROM "FloorLateWarning" WHERE id = $1::uuid`, [row.id])).rejects.toThrow(LATE_KEPT)
  })

  it('"I paid" is born OPEN in the portal and answered once by the office; nothing else of it changes; kept', async () => {
    const row = { id: randomUUID(), companyId: companyA, partyId: P1, salesOrderId: ow.orderId, amount: 12_000, currency: 'EUR', paidOn: '2026-11-26', method: 'Bank transfer', createdById: portal.userIds.p1Buyer }
    expect(await refusalOf(insert(p1(), 'PaymentNotice', { ...row, id: randomUUID(), state: 'RECORDED' }))).toMatch(NOTICE_NEW)
    expect(await refusalOf(insert(p1(), 'PaymentNotice', { ...row, id: randomUUID(), amount: 0 }))).toMatch(NOTICE_AMOUNT)
    expect(await refusalOf(insert(p1(), 'PaymentNotice', { ...row, id: randomUUID(), currency: 'eur' }))).toMatch(NOTICE_AMOUNT)
    expect(await refusalOf(insert(p1(), 'PaymentNotice', { ...row, id: randomUUID(), fileId: await plantFile({ recordType: 'SalesOrder', recordId: ow.orderId }) }))).toMatch(NOTICE_PROOF)
    // Another customer's order is not P1's to tell about (the wall, then the reference).
    expect(await refusalOf(insert(p1(), 'PaymentNotice', { ...row, id: randomUUID(), salesOrderId: second.salesOrderId }))).toMatch(/row-level security|_fkey|foreign key/)
    expect(await insert(p1(), 'PaymentNotice', { ...row, fileId: await p1Picture('SalesOrder', ow.orderId, { kind: 'DOCUMENT', contentType: 'application/pdf' }) })).toBe(1)
    // The office does not type a customer's notice (no insert grant); the customer does not answer it (no update grant).
    expect(await refusalOf(insert(office(), 'PaymentNotice', { ...row, id: randomUUID() }))).toMatch(DENIED)
    expect(await refusalOf(update(p1(), 'PaymentNotice', row.id, `state = 'DISMISSED'`))).toMatch(DENIED)
    expect(await refusalOf(update(office(), 'PaymentNotice', row.id, `amount = 13000, version = version + 1`))).toMatch(NOTICE_ONCE)
    expect(await refusalOf(update(office(), 'PaymentNotice', row.id, `state = 'RECORDED', version = version + 1`))).toMatch(NOTICE_ONCE)
    expect(await update(office(), 'PaymentNotice', row.id, `state = 'RECORDED', "answeredAt" = now(), "answeredById" = $2::uuid, version = version + 1`, a.actorId)).toBe(1)
    expect(await refusalOf(update(office(), 'PaymentNotice', row.id, `state = 'DISMISSED', version = version + 1`))).toMatch(NOTICE_ANSWERED)
    expect(await refusalOf(remove(office(), 'PaymentNotice', row.id))).toMatch(DENIED)
    await expect(admin(`DELETE FROM "PaymentNotice" WHERE id = $1::uuid`, [row.id])).rejects.toThrow(NOTICE_KEPT)
    // The customer reads its notice, never who answered it.
    await expect(as(p1(), (client) => client.$queryRawUnsafe(`SELECT "answeredById" FROM "PaymentNotice" LIMIT 1`))).rejects.toThrow(DENIED)
  })
})

// ---------------------------------------------------------------------------------------------------------------------------
describe('G8 — the customer’s own columns', () => {
  const columnRow = (extra: Record<string, unknown>): Record<string, unknown> => ({ id: randomUUID(), partyId: P1, name: tag('Made-up'), kind: 'TEXT', seq: 5, createdById: portal.userIds.p1Buyer, ...extra })

  it('a name once among the customer’s open columns, whatever its case, 1 to 40; a closed one frees its name', async () => {
    // The fixture's open "Rider number".
    expect(await refusalOf(insert(p1(), 'PartyLineColumn', columnRow({ name: 'RIDER NUMBER' })))).toMatch(UNIQUE)
    for (const name of [' Leading space', '', 'x'.repeat(41)]) expect(await refusalOf(insert(p1(), 'PartyLineColumn', columnRow({ name }))), JSON.stringify(name)).toMatch(COLUMN_NAME)
    const remake = columnRow({ name: 'Remake' })
    expect(await insert(p1(), 'PartyLineColumn', remake)).toBe(1)
    expect(await refusalOf(insert(office(), 'PartyLineColumn', columnRow({ name: 'remake', createdById: a.actorId })))).toMatch(UNIQUE)
    expect(await update(p1(), 'PartyLineColumn', remake.id as string, `"closedAt" = now(), version = version + 1`)).toBe(1)
    expect(await insert(p1(), 'PartyLineColumn', columnRow({ name: 'Remake' }))).toBe(1)
    expect(await refusalOf(update(p1(), 'PartyLineColumn', remake.id as string, `name = 'Remade', version = version + 1`))).toMatch(COLUMN_CLOSED)
    // Another customer may have its own "Remake".
    expect(await insert(office(), 'PartyLineColumn', columnRow({ partyId: second.partyId, name: 'Remake', createdById: a.actorId }))).toBe(1)
  })

  it('the choices of a CHOICE column (at least one, each once), none for any other kind; the kind never changes; never deleted', async () => {
    expect(await refusalOf(insert(p1(), 'PartyLineColumn', columnRow({ kind: 'CHOICE', choices: [] })))).toMatch(COLUMN_CHOICES)
    expect(await refusalOf(insert(p1(), 'PartyLineColumn', columnRow({ kind: 'CHOICE', choices: ['Yes', 'Yes'] })))).toMatch(COLUMN_CHOICES)
    expect(await refusalOf(insert(p1(), 'PartyLineColumn', columnRow({ kind: 'CHOICE', choices: [' Yes'] })))).toMatch(COLUMN_CHOICES)
    expect(await refusalOf(insert(p1(), 'PartyLineColumn', columnRow({ kind: 'TEXT', choices: ['Yes'] })))).toMatch(COLUMN_CHOICES)
    const sizing = columnRow({ kind: 'CHOICE', choices: ['Tight'] })
    expect(await insert(p1(), 'PartyLineColumn', sizing)).toBe(1)
    expect(await update(p1(), 'PartyLineColumn', sizing.id as string, `choices = ARRAY['Tight', 'Loose'], name = 'Sizing', version = version + 1`)).toBe(1)
    expect(await refusalOf(update(p1(), 'PartyLineColumn', sizing.id as string, `kind = 'TEXT', choices = ARRAY[]::text[], version = version + 1`))).toMatch(COLUMN_FROZEN)
    expect(await refusalOf(update(p1(), 'PartyLineColumn', sizing.id as string, `"partyId" = $2::uuid`, second.partyId))).toMatch(RLS)
    expect(await refusalOf(remove(p1(), 'PartyLineColumn', sizing.id as string))).toMatch(DENIED)
    await expect(admin(`DELETE FROM "PartyLineColumn" WHERE id = $1::uuid`, [sizing.id])).rejects.toThrow(COLUMN_KEPT)
  })

  it('a use and a value name a column of the same customer (the brand wall); exactly one record, exactly one line', async () => {
    const beta = columnRow({ partyId: second.partyId, name: 'Made-up number', createdById: a.actorId })
    expect(await insert(office(), 'PartyLineColumn', beta)).toBe(1)
    // P1's line with Seed Brand Two's column: no such column of P1 (the key names the customer).
    expect(await refusalOf(insert(office(), 'OrderLineOwnValue', { id: randomUUID(), partyId: P1, columnId: beta.id, salesOrderLineId: ow.orderLineIds[0], valueText: '9' }))).toMatch(FOREIGN)
    expect(await refusalOf(insert(office(), 'OrderLineOwnValue', { id: randomUUID(), partyId: second.partyId, columnId: beta.id, salesOrderLineId: ow.orderLineIds[0], valueText: '9' }))).toMatch(FOREIGN)
    expect(await refusalOf(insert(p1(), 'OrderLineColumnUse', { id: randomUUID(), companyId: companyA, partyId: P1, salesOrderId: ow.orderId, columnId: beta.id, seq: 2 }))).toMatch(FOREIGN)
    expect(await refusalOf(insert(p1(), 'OrderLineColumnUse', { id: randomUUID(), companyId: companyA, partyId: second.partyId, salesOrderId: second.salesOrderId, columnId: beta.id, seq: 2 }))).toMatch(RLS)
    // Exactly one record and one line.
    const draft = await newDraft()
    expect(await refusalOf(insert(p1(), 'OrderLineColumnUse', { id: randomUUID(), companyId: companyA, partyId: P1, salesOrderId: ow.orderId, portalOrderRequestId: draft, columnId: ow.ids.columns.rider, seq: 2 }))).toMatch(USE_ONE)
    expect(await refusalOf(insert(p1(), 'OrderLineColumnUse', { id: randomUUID(), companyId: companyA, partyId: P1, columnId: ow.ids.columns.rider, seq: 2 }))).toMatch(USE_ONE)
    expect(await insert(p1(), 'OrderLineColumnUse', { id: randomUUID(), companyId: companyA, partyId: P1, portalOrderRequestId: draft, columnId: ow.ids.columns.rider, seq: 1 })).toBe(1)
    expect(await refusalOf(insert(p1(), 'OrderLineOwnValue', { id: randomUUID(), partyId: P1, columnId: ow.ids.columns.rider, valueText: '9' }))).toMatch(VALUE_ONE)
    expect(await refusalOf(update(office(), 'OrderLineOwnValue', ow.ids.value, `"salesOrderLineId" = $2::uuid, version = version + 1`, ow.orderLineIds[1]))).toMatch(VALUE_KEEPS)
  })

  it('a value fills only the field its column’s kind needs (a CHOICE one of its choices); cleared, it fills none', async () => {
    const valueRow = (columnId: string, extra: Record<string, unknown>): Record<string, unknown> => ({ id: randomUUID(), partyId: P1, columnId, salesOrderLineId: ow.orderLineIds[1], ...extra })
    expect(await refusalOf(insert(p1(), 'OrderLineOwnValue', valueRow(ow.ids.columns.rider, { valueBool: true })))).toMatch(VALUE_KIND)
    expect(await refusalOf(insert(p1(), 'OrderLineOwnValue', valueRow(ow.ids.columns.rider, { valueNumber: '7' })))).toMatch(VALUE_KIND)
    expect(await refusalOf(insert(p1(), 'OrderLineOwnValue', valueRow(ow.ids.columns.logo, { valueText: 'Maybe' })))).toMatch(VALUE_KIND)
    expect(await refusalOf(insert(p1(), 'OrderLineOwnValue', valueRow(ow.ids.columns.rider, { valueText: '   ' })))).toMatch(/has words of 1 to 1000 characters/)
    const logo = valueRow(ow.ids.columns.logo, { valueText: 'Yes' })
    expect(await insert(p1(), 'OrderLineOwnValue', logo)).toBe(1)
    expect(await update(office(), 'OrderLineOwnValue', logo.id as string, `"valueText" = 'No', version = version + 1`)).toBe(1)
    expect(await update(p1(), 'OrderLineOwnValue', logo.id as string, `"valueText" = NULL, version = version + 1`)).toBe(1)
    expect(await refusalOf(update(p1(), 'OrderLineOwnValue', logo.id as string, `"valueDate" = '2026-12-01', version = version + 1`))).toMatch(VALUE_KIND)
    const yesNo = columnRow({ kind: 'YES_NO', name: 'Logo sent?' })
    expect(await insert(p1(), 'PartyLineColumn', yesNo)).toBe(1)
    expect(await insert(p1(), 'OrderLineOwnValue', valueRow(yesNo.id as string, { valueBool: false }))).toBe(1)
    // The floor reads none of it.
    await expect(as(floor(), (client) => client.$queryRawUnsafe(`SELECT 1 FROM "OrderLineOwnValue" LIMIT 1`))).rejects.toThrow(DENIED)
  })
})

// ---------------------------------------------------------------------------------------------------------------------------
describe('G9 — the warehouse leg (factory_shipment_warehouse_leg_guard, Shipment_warehouse_leg_delivered)', () => {
  it('a WAREHOUSE site; arrived only once SHIPPED, once; sent on after it, once, with the label or as without it; DELIVERED only after', async () => {
    // The fixture's leg is on SEED-SH-0002, still a DRAFT: its goods cannot have arrived.
    expect(await refusalOf(update(office(), 'ShipmentWarehouseLeg', ow.ids.leg, `"arrivedAt" = now(), "arrivedById" = $2::uuid, version = version + 1`, a.actorId))).toMatch(LEG_ARRIVE)
    const leg = { id: randomUUID(), companyId: companyA, siteId: siteA, partyId: P1, shipmentId: ow.shipmentIds.shipped, createdById: a.actorId }
    expect(await refusalOf(insert(office(), 'ShipmentWarehouseLeg', { ...leg, warehouseSiteId: siteA }))).toMatch(LEG_WAREHOUSE)
    expect(await refusalOf(insert(office(), 'ShipmentWarehouseLeg', { ...leg, warehouseSiteId: ow.warehouseSiteId, arrivedAt: new Date().toISOString(), arrivedById: a.actorId }))).toMatch(/a new warehouse leg has not arrived and was not sent on/)
    expect(await insert(office(), 'ShipmentWarehouseLeg', { ...leg, warehouseSiteId: ow.warehouseSiteId })).toBe(1)
    const deliver = () => update(office(), 'Shipment', ow.shipmentIds.shipped, `status = 'DELIVERED', "deliveredAt" = now(), version = version + 1`)
    expect(await refusalOf(deliver())).toMatch(LEG_DELIVERED)
    expect(await refusalOf(update(office(), 'ShipmentWarehouseLeg', leg.id, `"forwardedAt" = now(), "forwardedById" = $2::uuid, "forwardedWithoutLabel" = true, version = version + 1`, a.actorId))).toMatch(LEG_ORDER)
    expect(await refusalOf(update(office(), 'ShipmentWarehouseLeg', leg.id, `"arrivedAt" = now(), version = version + 1`))).toMatch(LEG_ORDER)
    expect(await update(office(), 'ShipmentWarehouseLeg', leg.id, `"arrivedAt" = now(), "arrivedById" = $2::uuid, version = version + 1`, a.actorId)).toBe(1)
    expect(await refusalOf(update(office(), 'ShipmentWarehouseLeg', leg.id, `"arrivedAt" = now() + interval '1 hour', version = version + 1`))).toMatch(LEG_ONCE)
    expect(await refusalOf(deliver())).toMatch(LEG_DELIVERED)
    // Sent on: with the customer's label, or as sent on without it — never with neither, never both.
    expect(await refusalOf(update(office(), 'ShipmentWarehouseLeg', leg.id, `"forwardedAt" = now(), "forwardedById" = $2::uuid, version = version + 1`, a.actorId))).toMatch(LEG_LABEL_WAY)
    const notALabel = await plantFile({ recordType: 'Shipment', recordId: ow.shipmentIds.shipped, kind: 'DOCUMENT', contentType: 'application/pdf', category: 'POD' })
    expect(await refusalOf(update(office(), 'ShipmentWarehouseLeg', leg.id, `"customerLabelFileId" = $2::uuid, "customerLabelAt" = now(), "customerLabelById" = $3::uuid, version = version + 1`, notALabel, portal.userIds.p1Buyer))).toMatch(LEG_LABEL)
    const otherShipmentLabel = await plantFile({ recordType: 'Shipment', recordId: ow.shipmentIds.draft, kind: 'DOCUMENT', contentType: 'application/pdf', category: 'CUSTOMER_LABEL' })
    expect(await refusalOf(update(office(), 'ShipmentWarehouseLeg', leg.id, `"customerLabelFileId" = $2::uuid, "customerLabelAt" = now(), "customerLabelById" = $3::uuid, version = version + 1`, otherShipmentLabel, portal.userIds.p1Buyer))).toMatch(LEG_LABEL)
    const label = await plantFile({ recordType: 'Shipment', recordId: ow.shipmentIds.shipped, kind: 'DOCUMENT', contentType: 'application/pdf', category: 'CUSTOMER_LABEL', visibility: ['OFFICE', 'PARTNER'], partyId: P1 })
    expect(await refusalOf(update(office(), 'ShipmentWarehouseLeg', leg.id, `"customerLabelFileId" = $2::uuid, version = version + 1`, label))).toMatch(LEG_LABEL_WAY)
    expect(await update(office(), 'ShipmentWarehouseLeg', leg.id, `"customerLabelFileId" = $2::uuid, "customerLabelAt" = now(), "customerLabelById" = $3::uuid, version = version + 1`, label, portal.userIds.p1Buyer)).toBe(1)
    expect(await refusalOf(update(office(), 'ShipmentWarehouseLeg', leg.id, `"forwardedAt" = now(), "forwardedById" = $2::uuid, "forwardedWithoutLabel" = true, version = version + 1`, a.actorId))).toMatch(LEG_LABEL_WAY)
    expect(await update(office(), 'ShipmentWarehouseLeg', leg.id, `"forwardedAt" = now(), "forwardedById" = $2::uuid, version = version + 1`, a.actorId)).toBe(1)
    expect(await refusalOf(update(office(), 'ShipmentWarehouseLeg', leg.id, `"customerLabelFileId" = NULL, "customerLabelAt" = NULL, "customerLabelById" = NULL, "forwardedWithoutLabel" = true, version = version + 1`))).toMatch(LEG_ONCE)
    expect(await deliver()).toBe(1)
    // The customer reads its leg, never who in the warehouse handled it; nobody deletes it.
    await expect(as(p1(), (client) => client.$queryRawUnsafe(`SELECT "arrivedById" FROM "ShipmentWarehouseLeg" LIMIT 1`))).rejects.toThrow(DENIED)
    expect(await refusalOf(update(p1(), 'ShipmentWarehouseLeg', leg.id, `version = version`))).toMatch(DENIED)
    await expect(admin(`DELETE FROM "ShipmentWarehouseLeg" WHERE id = $1::uuid`, [leg.id])).rejects.toThrow(LEG_KEPT)
  })
})

// ---------------------------------------------------------------------------------------------------------------------------
describe('G10 — baskets made at print (REDEFINED factory_bundle_guard)', () => {
  const setSwitch = (on: boolean) => update(office(), 'ProductionSettings', siteA, `"basketsAtPrint" = $2, version = version + 1`, on)
  const basketRow = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: randomUUID(),
    siteId: siteA,
    workOrderId: ow.workOrderId,
    workOrderSizeId: production.cellIds['BLK-50'],
    code: tag('T-PB'),
    quantity: 1,
    madeAtPrint: true,
    createdById: a.actorId,
    ...extra,
  })
  /** A second (or third) cut of WO-0001 at A1, planted as a copy of the seed's H1:1 (rows only time reaches). */
  async function plantCut(changes: Record<string, unknown> = {}): Promise<string> {
    const id = randomUUID()
    await plant('CutLog', production.cutLogId, { id, clientEventId: tag('owb-cut'), ...changes })
    return id
  }

  it('only where the site turned "baskets at print" on, and before its cut (no cut log entry yet) — owb G10 (a)', async () => {
    expect(await setSwitch(false)).toBe(1)
    const words = await refusalOf(insert(office(), 'Bundle', basketRow()))
    expect(words).toMatch(PRINT_SWITCH)
    expect(await setSwitch(true)).toBe(1)
    expect(await insert(office(), 'Bundle', basketRow())).toBe(1)
    expect(await refusalOf(insert(office(), 'Bundle', basketRow({ cutLogIds: [production.cutLogId] })))).toMatch(PRINT_NO_CUT)
    // A normal (cut) bundle is made as before, whatever the switch.
    expect(await insert(office(), 'Bundle', basketRow({ madeAtPrint: false, cutLogIds: [production.cutLogId] }))).toBe(1)
    expect(await setSwitch(false)).toBe(1)
    expect(await insert(office(), 'Bundle', basketRow({ madeAtPrint: false, cutLogIds: [production.cutLogId] }))).toBe(1)
  })

  it('its cut log entries only grow: attached, a second attach ADDS ids; removing or swapping one refused; each new one of the work order, no reversal — owb G10 (b)', async () => {
    expect(await setSwitch(true)).toBe(1)
    const basket = basketRow()
    expect(await insert(office(), 'Bundle', basket)).toBe(1)
    const id = basket.id as string
    const cut2 = await plantCut()
    const cut3 = await plantCut()
    expect(await update(floor(), 'Bundle', id, `"cutLogIds" = ARRAY[$2::uuid], version = version + 1`, production.cutLogId)).toBe(1)
    expect(await update(floor(), 'Bundle', id, `"cutLogIds" = "cutLogIds" || $2::uuid, version = version + 1`, cut2)).toBe(1)
    expect(await admin(`SELECT "cutLogIds"::text[] AS cuts FROM "Bundle" WHERE id = $1::uuid`, [id])).toEqual([{ cuts: [production.cutLogId, cut2] }])
    // Removing an entry, or swapping one for another: refused.
    expect(await refusalOf(update(floor(), 'Bundle', id, `"cutLogIds" = ARRAY[$2::uuid], version = version + 1`, cut2))).toMatch(ONLY_ADDS)
    expect(await refusalOf(update(floor(), 'Bundle', id, `"cutLogIds" = ARRAY[$2::uuid, $3::uuid], version = version + 1`, production.cutLogId, cut3))).toMatch(ONLY_ADDS)
    // Each new entry passes the insert's own check: named once, of its work order, not a reversal.
    expect(await refusalOf(update(floor(), 'Bundle', id, `"cutLogIds" = "cutLogIds" || $2::uuid || $2::uuid, version = version + 1`, cut3))).toMatch(CUT_ENTRIES)
    expect(await refusalOf(update(floor(), 'Bundle', id, `"cutLogIds" = "cutLogIds" || $2::uuid, version = version + 1`, randomUUID()))).toMatch(CUT_ENTRIES)
    const reversal = await plantCut({ reversalOfId: cut3 })
    expect(await refusalOf(update(floor(), 'Bundle', id, `"cutLogIds" = "cutLogIds" || $2::uuid, version = version + 1`, reversal))).toMatch(CUT_ENTRIES)
    expect(await update(floor(), 'Bundle', id, `"cutLogIds" = "cutLogIds" || $2::uuid, version = version + 1`, cut3)).toBe(1)
    // Voided, it takes no more.
    expect(await update(office(), 'Bundle', id, `status = 'VOID', "voidedAt" = now(), "voidReason" = 'Made-up: printed twice.', version = version + 1`)).toBe(1)
    expect(await refusalOf(update(floor(), 'Bundle', id, `"cutLogIds" = "cutLogIds" || $2::uuid, version = version + 1`, await plantCut()))).toMatch(ONLY_ADDS)
  })

  it("any other bundle's cut log entries never change; madeAtPrint never changes — owb G10 (b), (c)", async () => {
    const extra = await plantCut()
    // The seed's bundle 1 was made at its cut: its entries stay as they are.
    expect(await refusalOf(update(floor(), 'Bundle', ow.bundleIds[0], `"cutLogIds" = "cutLogIds" || $2::uuid, version = version + 1`, extra))).toMatch(ONLY_REPRINT)
    expect(await refusalOf(update(floor(), 'Bundle', ow.bundleIds[0], `"madeAtPrint" = true, version = version + 1`))).toMatch(ONLY_REPRINT)
    expect(await setSwitch(true)).toBe(1)
    const basket = basketRow()
    expect(await insert(office(), 'Bundle', basket)).toBe(1)
    expect(await refusalOf(update(office(), 'Bundle', basket.id as string, `"madeAtPrint" = false, version = version + 1`))).toMatch(ONLY_REPRINT)
    expect(await refusalOf(update(office(), 'Bundle', basket.id as string, `quantity = 2, "cutLogIds" = ARRAY[$2::uuid], version = version + 1`, extra))).toMatch(ONLY_REPRINT)
  })
})

// ---------------------------------------------------------------------------------------------------------------------------
describe('G11 — the People-by-customer pool (factory_party_office_person_guard)', () => {
  const poolRow = (userId: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ id: randomUUID(), companyId: companyA, partyId: P1, userId, createdById: a.actorId, ...extra })

  it('an active office person; one open row per customer and person; ended once with when and who, then frozen; never deleted', async () => {
    // The fixture's open row: the office member in P1's pool.
    expect(await refusalOf(insert(office(), 'PartyOfficePerson', poolRow(ow.memberId)))).toMatch(UNIQUE)
    expect(await refusalOf(insert(office(), 'PartyOfficePerson', poolRow(portal.userIds.p1Buyer)))).toMatch(POOL_OFFICE)
    expect(await refusalOf(insert(office(), 'PartyOfficePerson', poolRow(key('user:invited'))))).toMatch(POOL_OFFICE)
    const row = poolRow(a.actorId)
    expect(await insert(office(), 'PartyOfficePerson', row)).toBe(1)
    expect(await refusalOf(update(office(), 'PartyOfficePerson', row.id as string, `"endedAt" = now(), version = version + 1`))).toMatch(POOL_END)
    expect(await refusalOf(update(office(), 'PartyOfficePerson', row.id as string, `"userId" = $2::uuid, version = version + 1`, ow.memberId))).toMatch(/only ends/)
    expect(await update(office(), 'PartyOfficePerson', row.id as string, `"endedAt" = now(), "endedById" = $2::uuid, version = version + 1`, a.actorId)).toBe(1)
    expect(await refusalOf(update(office(), 'PartyOfficePerson', row.id as string, `"endedAt" = NULL, "endedById" = NULL, version = version + 1`))).toMatch(POOL_ENDED)
    // Ended, the same person may join the pool again.
    expect(await insert(office(), 'PartyOfficePerson', poolRow(a.actorId))).toBe(1)
    expect(await refusalOf(insert(p1(), 'PartyOfficePerson', poolRow(a.actorId)))).toMatch(DENIED)
    expect(await refusalOf(remove(office(), 'PartyOfficePerson', row.id as string))).toMatch(DENIED)
    await expect(admin(`DELETE FROM "PartyOfficePerson" WHERE id = $1::uuid`, [row.id])).rejects.toThrow(POOL_KEPT)
    // The customer reads its pool, never who added or ended a row.
    await expect(as(p1(), (client) => client.$queryRawUnsafe(`SELECT "endedById" FROM "PartyOfficePerson" LIMIT 1`))).rejects.toThrow(DENIED)
  })
})

// ---------------------------------------------------------------------------------------------------------------------------
describe('G12 — a quiet line is a SYSTEM message (factory_message_event_check)', () => {
  /** Seed Brand Two's portal: its buyer, on its own order's shared thread (testing/second-brand.ts). */
  const beta = (): FactoryScope => ({ audience: 'partner', tenantId: a.tenantId, actorId: second.userId, partyId: second.partyId })
  const line = (extra: Record<string, unknown>): Record<string, unknown> => ({
    id: randomUUID(),
    threadId: second.threadId,
    partyId: second.partyId,
    direction: 'OUTBOUND',
    audience: 'PARTNER',
    channel: 'APP',
    authorKind: 'SYSTEM',
    bodyText: 'The factory confirmed your order.',
    at: new Date().toISOString(),
    ...extra,
  })

  it("the system writes it; a person's message never carries a key, a portal post neither", async () => {
    expect(await insert(office(), 'Message', line({ eventKey: 'order.confirmed', eventArgs: { number: 'SEED-SO-B001' } }))).toBe(1)
    expect(await insert(office(), 'Message', line({ eventKey: 'order.line_added' }))).toBe(1)
    expect(await refusalOf(insert(office(), 'Message', line({ authorKind: 'USER', authorId: a.actorId, authorName: 'Seed Office User', eventKey: 'order.confirmed' })))).toMatch(QUIET_SYSTEM)
    // A portal post with a quiet line's key: refused (the partner role holds an INSERT grant on the column).
    const post = { id: randomUUID(), threadId: second.threadId, partyId: second.partyId, direction: 'INBOUND', audience: 'PARTNER', channel: 'PORTAL', authorKind: 'PARTY', authorName: 'Seed Second Brand Buyer', bodyText: 'Made-up: thank you.', at: new Date().toISOString() }
    const words = await refusalOf(insert(beta(), 'Message', { ...post, eventKey: 'order.confirmed' }))
    expect(words).toMatch(QUIET_SYSTEM)
    expect(await refusalOf(insert(beta(), 'Message', { ...post, id: randomUUID(), eventArgs: { number: 'SEED-SO-B001' } }))).toMatch(QUIET_SYSTEM)
    expect(await insert(beta(), 'Message', { ...post, id: randomUUID() })).toBe(1)
  })

  it('the arguments only beside its key, as one object; the key a word key', async () => {
    expect(await refusalOf(insert(office(), 'Message', line({ eventArgs: { number: 'SEED-SO-B001' } })))).toMatch(QUIET_SHAPE)
    expect(await refusalOf(insert(office(), 'Message', line({ eventKey: 'order.confirmed', eventArgs: ['SEED-SO-B001'] })))).toMatch(QUIET_SHAPE)
    for (const eventKey of ['Order confirmed', '.order', 'order..confirmed', 'x'.repeat(121)]) {
      expect(await refusalOf(insert(office(), 'Message', line({ eventKey }))), eventKey).toMatch(QUIET_SHAPE)
    }
    // Append-only, as every message: what a quiet line says is fixed.
    const kept = line({ eventKey: 'order.promise_moved', eventArgs: { from: '2026-12-10', to: '2026-12-17' } })
    expect(await insert(office(), 'Message', kept)).toBe(1)
    await expect(admin(`UPDATE "Message" SET "eventKey" = 'order.confirmed' WHERE id = $1::uuid`, [kept.id])).rejects.toThrow(/append-only|refused/)
  })
})
