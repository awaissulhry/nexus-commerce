import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedAuth } from '../../../../../../packages/factory-db/seed/auth'
import { seed as seedRoles } from '../../../../../../packages/factory-db/seed/roles'
import { seed as seedSalesIntake } from '../../../../../../packages/factory-db/seed/sales-intake'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { callerFor } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'
import indexer from '../../../platform/search/indexers/inquiry'
import { entryOf } from '../../../platform/search/store'
import { inquiries as exportSource } from './export-source'

/**
 * Inquiries and requests for quotation (B-W2b-295; SAL-032, SAL-033, SAL-305) through the app's real routes on a throwaway
 * PostgreSQL 17 database from the migrations (the runtime login: row-level security and B-W2b-279's …_sales_intake_w2b_guards are
 * real), on the seeds up to the sales intake (the brand P1 = SEED-C1 with its buyer, the customer P3 = SEED-C2, the supplier
 * P2, the jacket SEED-JKT-01 in BLK and RED sizes 50/52/54, the INQUIRY series of company A, SEED-INQ-0001 … 0006, the mail
 * an unknown sender wrote) and, made up here, two mails waiting in Mail to sort (one from P1's buyer with a tech pack attached,
 * one from a stranger) and three office people with the sales role and one without. Every word and number is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/sales/inquiries`.
 */

vi.setConfig({ testTimeout: 90_000 })

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

const NS = 'w2b295-inquiries'
const idOf = (key: string): string => seedUuid(NS, key)
const T = idOf('tenant')
const companyA = idOf('company:A')
const P1 = idOf('party:P1')
const P2 = idOf('party:P2')
const P3 = idOf('party:P3')
const P1_BUYER = idOf('party-contact:P1:buyer')
const YEAR = businessDate(new Date()).slice(0, 4)

const PEOPLE = { ada: newId(), bruno: newId(), carla: newId(), piero: newId() } as const
const sales = templateOf('sales')!
const SALES = [...sales.permissions, ...sales.grains.map((grain) => `money.${grain}`)] as Permission[]
const grant = (permissions: Permission[], parties: Grant['parties'] = 'all'): Grant => ({ permissions, companies: 'all', sites: 'all', parties })
const office = (actorId: string, permissions: Permission[], parties: Grant['parties'] = 'all'): SessionContext => ({ audience: 'office', tenantId: T, actorId, grants: [grant(permissions, parties)] })
const SESSIONS: Record<string, SessionContext> = {
  ada: office(PEOPLE.ada, SALES),
  bruno: office(PEOPLE.bruno, SALES),
  // Sales without the price grain: reads inquiries, never their target price, and may not send one.
  noPrice: office(newId(), SALES.filter((name) => name !== 'money.price')),
  // A role limited to another customer: P1's inquiries are not there for it, a prospect's are.
  otherCustomer: office(newId(), SALES, [newId()]),
  // The planner's template: no inquiries.
  planner: office(PEOPLE.piero, templateOf('planner')!.permissions as Permission[]),
}

let h: Harness
let app: FastifyInstance
const run = randomBytes(4).toString('hex')
let serial = 0
const admin = async <Row = Json>(sql: string, values: unknown[] = []): Promise<Row[]> => (await h.db.admin.query(sql, values)).rows as Row[]
const one = async (sql: string, values: unknown[] = []): Promise<Json> => (await admin(sql, values))[0]!
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': `i-${run}-${++serial}` }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function no(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}
const refusal = (error: Json): string => String(error.issues?.[0]?.path ?? '')
const events = async (type: string, subject: string) => admin(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 AND subject = $3 ORDER BY "occurredAt", id`, [T, type, subject])

let jacket = ''
let black = ''
let mailKnown = '' // a mail from P1's buyer, waiting, with the tech pack attached
let mailStranger = '' // a mail from someone Nexus does not know
let techPackFile = ''
let phone = '' // P1's phone inquiry
let prospect = '' // a prospect's inquiry typed at a fair

/** A made-up mail waiting in Mail to sort (TRIAGE), copied from the seed's, from `from`, with one kept attachment when `file` is given. */
async function waitingMail(key: string, from: string, fromName: string, partyId: string | null, contactId: string | null, file: string | null): Promise<string> {
  const id = newId()
  const attachments = file ? JSON.stringify([{ kept: true, name: 'Made-up tech pack TP3.pdf', contentType: 'application/pdf', sizeBytes: 4096, sha256: 'a'.repeat(64), storeAccountId: newId(), storageKey: `made-up/${key}`, fileId: file }]) : '[]'
  await admin(
    `INSERT INTO "InboundEmail" SELECT (jsonb_populate_record(NULL::"InboundEmail", to_jsonb(m) || jsonb_build_object(
       'id', $2::uuid, 'receiptId', gen_random_uuid(), 'sesMessageId', $3::text, 's3Key', $3::text, 'emailMessageId', $4::text,
       'fromAddress', $5::text, 'envelopeFrom', $5::text, 'fromName', $6::text, 'subject', 'Richiesta preventivo giacche brand',
       'bodyText', E'Buongiorno,\\nci servono 60 giacche come da tech pack allegato.', 'bodyHtml', '<p>Buongiorno, ci servono 60 giacche.</p>',
       'senderPartyId', $7::uuid, 'senderContactId', $8::uuid, 'attachments', $9::jsonb, 'version', 1, 'receivedAt', now() - interval '3 days'))).*
     FROM "InboundEmail" m WHERE m."tenantId" = $1 AND m.status = 'TRIAGE' ORDER BY m."receivedAt" LIMIT 1`,
    [T, id, `made-up-${key}-${run}`, `<${key}.${run}@mail.example.com>`, from, fromName, partyId, contactId, attachments],
  )
  return id
}

beforeAll(async () => {
  h = await startHarness('sales_inquiries')
  await seedCore({ db: h.database, namespace: NS })
  await seedAuth({ db: h.database, namespace: NS })
  await seedRoles({ db: h.database, namespace: NS })
  await seedSalesIntake({ db: h.database, namespace: NS })
  const salesRole = (await one(`SELECT id FROM "Role" WHERE "tenantId" = $1 AND key = 'sales'`, [T])).id
  const plannerRole = (await one(`SELECT id FROM "Role" WHERE "tenantId" = $1 AND key = 'planner'`, [T])).id
  for (const [person, userId] of Object.entries(PEOPLE)) {
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, 'ACTIVE')`, [userId, T, `w2b295-${person}-${run}@example.test`, `Made-up ${person}`])
    await admin(`INSERT INTO "RoleAssignment" (id, "tenantId", "userId", "roleId", "allCompanies", "companyIds", "validFrom") VALUES ($1, $2, $3, $4, true, '{}'::uuid[], now() - interval '30 days')`, [newId(), T, userId, person === 'piero' ? plannerRole : salesRole])
  }
  jacket = (await one('SELECT id FROM "Style" WHERE "tenantId" = $1 AND code = $2', [T, 'SEED-JKT-01'])).id
  black = (await one('SELECT id FROM "Colourway" WHERE "styleId" = $1 AND code = $2', [jacket, 'BLK'])).id
  // P1's buyer writes with the brand's tech pack attached (a file of the mail, as email in keeps it).
  techPackFile = newId()
  mailKnown = await waitingMail('known', 'buyer.p1@example.com', 'Seed Buyer One', P1, P1_BUYER, techPackFile)
  await admin(
    `INSERT INTO "StoredFile" SELECT (jsonb_populate_record(NULL::"StoredFile", to_jsonb(f) || jsonb_build_object('id', $2::uuid, 'recordId', $3::uuid, 'storageKey', $4::text, 'originalName', 'Made-up tech pack TP3.pdf'))).*
     FROM "StoredFile" f WHERE f."tenantId" = $1 AND f."recordType" = 'InboundEmail' ORDER BY f."createdAt" LIMIT 1`,
    [T, techPackFile, mailKnown, `t/${T}/made-up/${run}/tp3`],
  )
  mailStranger = await waitingMail('stranger', 'nuovo.club@example.net', 'Moto Club Esempio', null, null, null)
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 900_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('an inquiry typed by the office (SAL-032)', () => {
  it('numbers it INQ-, keeps what is asked by size, the target price only with the price grain, and puts it in the queue', async () => {
    const wanted = businessDate(new Date(Date.now() + 40 * 86_400_000))
    const { inquiry } = await ok(
      'ada',
      'POST',
      '/sales/inquiries',
      {
        companyId: companyA,
        source: 'PHONE',
        partyId: P1,
        contactId: P1_BUYER,
        request: 'Made-up: 15 black jackets for the team, and gloves to match.',
        wantedDate: wanted,
        targetUnitPrice: '180.50',
        lines: [
          { styleId: jacket, colourwayId: black, sizes: { '50': 5, '52': 10 } },
          { description: 'Made-up: gloves in the team colours', quantity: 15 },
        ],
      },
      201,
    )
    phone = inquiry.id
    expect(inquiry).toMatchObject({ number: expect.stringMatching(new RegExp(`^INQ-${YEAR}-\\d{4}$`)), source: 'PHONE', status: 'NEW', party: { id: P1, code: 'SEED-C1' }, prospect: false, pieces: 30, sizes: '50:5 52:10', targetUnitPrice: '180.5', currency: 'EUR', wantedDate: wanted, contact: { id: P1_BUYER }, createdBy: { id: PEOPLE.ada } })
    expect(inquiry.lines.map((line: Json) => [line.seq, line.style?.code ?? null, line.quantity])).toEqual([
      [10, 'SEED-JKT-01', 15],
      [20, null, 15],
    ])
    expect(inquiry.waiting).toMatchObject({ for: 'US', overdue: false })
    expect(inquiry.actions).toMatchObject({ edit: { allowed: true }, quote: { allowed: true }, resume: { allowed: false, refusal: { code: 'NOT_WAITING' } } })
    // The price grain: without it the target price is not there, and sending one is refused.
    expect('targetUnitPrice' in (await ok('noPrice', 'GET', `/sales/inquiries/${phone}`)).inquiry).toBe(false)
    await no('noPrice', 'POST', '/sales/inquiries', { companyId: companyA, source: 'PHONE', partyId: P1, request: 'x', targetUnitPrice: '1' }, 403)
    // The queue: NEW, the maker follows it, the event, the audit row.
    const list = await ok('ada', 'GET', '/sales/inquiries?tile=NEW')
    expect(list.rows.map((row: Json) => row.id)).toContain(phone)
    expect(list.counts.NEW).toBeGreaterThanOrEqual(1)
    expect(Object.keys(list.counts).sort()).toEqual(['ALL', 'DECLINED', 'LOST', 'MINE', 'NEW', 'OPEN', 'QUOTED', 'QUOTED_THIS_WEEK', 'WAITING_CUSTOMER', 'WAITING_US'])
    expect((await events('inquiry.received', phone))[0]!.payload).toMatchObject({ number: inquiry.number, source: 'PHONE', status: 'NEW', partyId: P1 })
    expect((await one(`SELECT count(*)::int AS n FROM "RecordFollower" WHERE "recordType" = 'Inquiry' AND "recordId" = $1 AND "userId" = $2`, [phone, PEOPLE.ada])).n).toBe(1)
    expect((await one(`SELECT action FROM "AuditLog" WHERE "recordType" = 'Inquiry' AND "recordId" = $1 ORDER BY at, id LIMIT 1`, [phone])).action).toBe('sales.inquiries.create')
  })

  it("takes a prospect not yet a party, and refuses who asks nobody, a supplier, a mail typed by hand and an assignee who keeps no inquiries", async () => {
    const { inquiry } = await ok('bruno', 'POST', '/sales/inquiries', { companyId: companyA, source: 'FAIR', prospect: { name: 'Made-up Visitor', company: 'Moto Club Fiera', email: ' Visitor@Example.NET ' }, request: 'Made-up: a quote for 40 race suits.' }, 201)
    prospect = inquiry.id
    expect(inquiry).toMatchObject({ status: 'NEW', prospect: true, fromWords: 'Moto Club Fiera', prospectDetails: { email: 'visitor@example.net', lawfulBasis: 'CONTRACT', erased: false }, actions: { quote: { allowed: false, refusal: { code: 'NEEDS_CUSTOMER' } } } })
    expect(refusal(await no('ada', 'POST', '/sales/inquiries', { companyId: companyA, source: 'OFFICE', request: 'x' }, 400))).toBe('body/partyId')
    expect(refusal(await no('ada', 'POST', '/sales/inquiries', { companyId: companyA, source: 'OFFICE', partyId: P2, request: 'x' }, 400))).toBe('body/partyId')
    expect(refusal(await no('ada', 'POST', '/sales/inquiries', { companyId: companyA, source: 'OFFICE', prospect: { name: 'x', email: 'not-an-address' }, request: 'x' }, 400))).toBe('body/prospect/email')
    await no('ada', 'POST', '/sales/inquiries', { companyId: companyA, source: 'MAIL', partyId: P1, request: 'x' }, 400)
    expect(refusal(await no('ada', 'POST', '/sales/inquiries', { companyId: companyA, source: 'OFFICE', partyId: P1, request: 'x', assigneeId: PEOPLE.piero }, 400))).toBe('body/assigneeId')
    expect(refusal(await no('ada', 'POST', '/sales/inquiries', { companyId: companyA, source: 'OFFICE', partyId: P1, request: 'x', lines: [{ styleId: jacket, sizes: { '50': 2 }, quantity: 3 }] }, 400))).toBe('body/lines/0/quantity')
    // The planner has no inquiries at all; a role of another customer does not see P1's, but sees a prospect's.
    await no('planner', 'GET', '/sales/inquiries', undefined, 403)
    await no('otherCustomer', 'GET', `/sales/inquiries/${phone}`, undefined, 404)
    expect((await ok('otherCustomer', 'GET', `/sales/inquiries/${prospect}`)).inquiry.number).toBe(inquiry.number)
  })
})

describe('who answers it', () => {
  it('assigns it, says it is mine to its assignee, refuses the same person again, takes it off, and assigns a selection all or none', async () => {
    const people = (await ok('ada', 'GET', `/sales/inquiries/assignees?companyId=${companyA}&partyId=${P1}`)).people as Json[]
    expect(people.map((person) => person.id)).toEqual(expect.arrayContaining([PEOPLE.ada, PEOPLE.bruno, PEOPLE.carla]))
    expect(people.map((person) => person.id)).not.toContain(PEOPLE.piero)
    expect(Object.keys(people[0]!).sort()).toEqual(['id', 'me', 'name'])
    const seen = (await ok('ada', 'GET', `/sales/inquiries/${phone}`)).inquiry
    const assigned = (await ok('ada', 'POST', `/sales/inquiries/${phone}/assign`, { version: seen.version, assigneeId: PEOPLE.bruno })).inquiry
    expect(assigned).toMatchObject({ status: 'ASSIGNED', assigneeId: PEOPLE.bruno, mine: false, assignee: { id: PEOPLE.bruno, name: 'Made-up bruno' } })
    expect((await ok('bruno', 'GET', '/sales/inquiries?tile=MINE')).rows.find((row: Json) => row.id === phone)).toMatchObject({ mine: true })
    expect(refusal(await no('ada', 'POST', `/sales/inquiries/${phone}/assign`, { version: assigned.version, assigneeId: PEOPLE.bruno }, 409))).toBe('refusal/SAME_ASSIGNEE')
    expect(refusal(await no('ada', 'POST', `/sales/inquiries/${phone}/assign`, { version: assigned.version, assigneeId: PEOPLE.piero }, 400))).toBe('body/assigneeId')
    const off = (await ok('ada', 'POST', `/sales/inquiries/${phone}/assign`, { version: assigned.version, assigneeId: null })).inquiry
    expect(off).toMatchObject({ status: 'NEW', assigneeId: null })
    await no('ada', 'POST', `/sales/inquiries/${phone}/assign`, { version: assigned.version, assigneeId: PEOPLE.carla }, 409)
    // A selection: a stale version refuses both, nothing changed; then both go to Carla.
    const other = (await ok('ada', 'GET', `/sales/inquiries/${prospect}`)).inquiry
    const stale = await no('ada', 'POST', '/sales/inquiries/assign', { items: [{ inquiryId: phone, version: off.version }, { inquiryId: prospect, version: other.version + 5 }], assigneeId: PEOPLE.carla }, 409)
    expect(stale.issues.map((issue: Json) => issue.path)).toEqual(['body/items/1'])
    expect((await ok('ada', 'GET', `/sales/inquiries/${phone}`)).inquiry.status).toBe('NEW')
    const both = (await ok('ada', 'POST', '/sales/inquiries/assign', { items: [{ inquiryId: phone, version: off.version }, { inquiryId: prospect, version: other.version }], assigneeId: PEOPLE.carla })).inquiries as Json[]
    expect(both.map((row) => row.status)).toEqual(['ASSIGNED', 'ASSIGNED'])
    expect((await events('inquiry.changed', phone)).map((event) => event.payload.change)).toEqual(['ASSIGNED', 'UNASSIGNED', 'ASSIGNED'])
  })

  it('waits for the customer and takes it up again when they answer', async () => {
    const seen = (await ok('ada', 'GET', `/sales/inquiries/${phone}`)).inquiry
    const waiting = (await ok('ada', 'POST', `/sales/inquiries/${phone}/ask-info`, { version: seen.version })).inquiry
    expect(waiting).toMatchObject({ status: 'NEED_INFO', waiting: { for: 'CUSTOMER', overdue: false } })
    expect((await ok('ada', 'GET', '/sales/inquiries?tile=WAITING_CUSTOMER')).rows.map((row: Json) => row.id)).toContain(phone)
    expect(refusal(await no('ada', 'POST', `/sales/inquiries/${phone}/ask-info`, { version: waiting.version }, 409))).toBe('refusal/ALREADY_WAITING')
    const back = (await ok('ada', 'POST', `/sales/inquiries/${phone}/resume`, { version: waiting.version })).inquiry
    expect(back).toMatchObject({ status: 'ASSIGNED', assigneeId: PEOPLE.carla })
  })
})

describe('the quote it becomes (SAL-032)', () => {
  it('makes the W1 quote in one command with the lines that name a style, colourway and sizes, the wanted date, and the inquiry QUOTED', async () => {
    const seen = (await ok('ada', 'GET', `/sales/inquiries/${phone}`)).inquiry
    const made = await ok('ada', 'POST', `/sales/inquiries/${phone}/quote`, { version: seen.version, customerRef: 'MADE-UP-RFQ-7' }, 201)
    expect(made.quote.number).toMatch(new RegExp(`^.+-${YEAR}-\\d+`))
    expect(made.leftOut).toEqual([{ seq: 20, size: null, reason: 'No style picked: add it on the quote.' }])
    expect(made.inquiry).toMatchObject({ status: 'QUOTED', quote: { id: made.quote.id, number: made.quote.number }, quoteDetail: { id: made.quote.id, status: 'DRAFT', revision: 1, currency: 'EUR' }, closedBy: { id: PEOPLE.ada }, waiting: { for: null } })
    const quote = (await ok('ada', 'GET', `/sales/quotes/${made.quote.id}`)).quote
    expect(quote).toMatchObject({ partyId: P1, customerRef: 'MADE-UP-RFQ-7' })
    const lines = await admin(`SELECT l.seq, l.quantity, l."styleId" FROM "QuoteLine" l JOIN "QuoteVersion" v ON v.id = l."versionId" WHERE v."quoteId" = $1 ORDER BY l.seq`, [made.quote.id])
    expect(lines).toEqual([{ seq: 10, quantity: 15, styleId: jacket }])
    expect((await one(`SELECT "promiseDate"::text AS day FROM "QuoteVersion" WHERE "quoteId" = $1`, [made.quote.id])).day).toBe(seen.wantedDate)
    expect((await one(`SELECT action FROM "AuditLog" WHERE "recordType" = 'Quote' AND "recordId" = $1 ORDER BY at, id LIMIT 1`, [made.quote.id])).action).toBe('quotes.fromInquiry')
    expect((await events('inquiry.closed', phone))[0]!.payload).toMatchObject({ status: 'QUOTED', quoteId: made.quote.id, previousStatus: 'ASSIGNED' })
    expect(await events('quote.created', made.quote.id)).toHaveLength(1)
    // The quote shows where it came from; the inquiry is closed: no second quote, no change but its note.
    const source = (await ok('ada', 'GET', `/sales/inquiries/source?quoteId=${made.quote.id}`)).inquiry
    expect(source).toMatchObject({ id: phone, status: 'QUOTED', targetUnitPrice: '180.5', techPack: { files: [] } })
    expect(refusal(await no('ada', 'POST', `/sales/inquiries/${phone}/quote`, { version: made.inquiry.version }, 409))).toBe('refusal/CLOSED')
    expect(refusal(await no('ada', 'PATCH', `/sales/inquiries/${phone}`, { version: made.inquiry.version, request: 'changed' }, 409))).toBe('refusal/CLOSED')
    const noted = (await ok('ada', 'PATCH', `/sales/inquiries/${phone}`, { version: made.inquiry.version, note: 'Made-up: they call back on Monday.' })).inquiry
    expect(noted).toMatchObject({ status: 'QUOTED', note: 'Made-up: they call back on Monday.' })
    expect((await ok('ada', 'GET', '/sales/inquiries?tile=QUOTED_THIS_WEEK')).rows.map((row: Json) => row.id)).toContain(phone)
  })

  it("refuses a prospect's quote until it is matched to a customer", async () => {
    const seen = (await ok('ada', 'GET', `/sales/inquiries/${prospect}`)).inquiry
    expect(refusal(await no('ada', 'POST', `/sales/inquiries/${prospect}/quote`, { version: seen.version }, 409))).toBe('refusal/NEEDS_CUSTOMER')
  })
})

describe('an inquiry from a mail (SAL-033) and the brand tech pack (SAL-305)', () => {
  it("makes one from the buyer's mail: P1 found by the contact, the mail joins the inquiry's thread, its attachment is the tech pack", async () => {
    const draft = await ok('ada', 'GET', `/sales/inquiries/from-mail/${mailKnown}`)
    expect(draft).toMatchObject({ inquiry: null, party: { id: P1 }, contactId: P1_BUYER, matchedBy: 'CONTACT', prospect: null, refusal: null })
    expect(draft.request).toBe('Richiesta preventivo giacche brand\n\nBuongiorno,\nci servono 60 giacche come da tech pack allegato.')
    expect(draft.attachments.map((file: Json) => file.id)).toEqual([techPackFile])
    const mail = await one(`SELECT version FROM "InboundEmail" WHERE id = $1`, [mailKnown])
    const { inquiry } = await ok('ada', 'POST', `/sales/inquiries/from-mail/${mailKnown}`, { version: mail.version, techPackFileIds: [techPackFile], techPackVersion: 'TP 3 · 2026-11', lines: [{ styleId: jacket, colourwayId: black, sizes: { '52': 60 } }] }, 201)
    expect(inquiry).toMatchObject({ source: 'MAIL', party: { id: P1 }, contact: { id: P1_BUYER }, mail: { id: mailKnown, subject: 'Richiesta preventivo giacche brand' }, techPack: { version: 'TP 3 · 2026-11', files: [{ named: { id: techPackFile }, current: { id: techPackFile }, newer: false }] } })
    expect(inquiry.mailFiles.map((file: Json) => file.id)).toEqual([techPackFile])
    const sorted = await one(`SELECT status, "matchedBy", "threadId" FROM "InboundEmail" WHERE id = $1`, [mailKnown])
    expect(sorted).toMatchObject({ status: 'MATCHED', matchedBy: 'MANUAL' })
    const thread = await ok('ada', 'GET', `/threads/Inquiry/${inquiry.id}`)
    expect(JSON.stringify(thread)).toContain('ci servono 60 giacche')
    // One inquiry per mail.
    const again = await one(`SELECT version FROM "InboundEmail" WHERE id = $1`, [mailKnown])
    expect(refusal(await no('ada', 'POST', `/sales/inquiries/from-mail/${mailKnown}`, { version: again.version }, 409))).toBe('refusal/MAIL_TAKEN')
    expect((await ok('ada', 'GET', `/sales/inquiries/from-mail/${mailKnown}`)).inquiry).toMatchObject({ id: inquiry.id })

    // A newer version of the tech pack file: the inquiry, and the quote made from it, point at the version in force.
    const v2 = newId()
    await admin('BEGIN')
    try {
      await admin(
        `INSERT INTO "StoredFile" SELECT (jsonb_populate_record(NULL::"StoredFile", to_jsonb(f) || jsonb_build_object('id', $1::uuid, 'seriesId', $2::uuid, 'versionNo', 2, 'storageKey', $3::text, 'originalName', 'Made-up tech pack TP4.pdf', 'createdAt', now(), 'availableAt', now()))).* FROM "StoredFile" f WHERE f.id = $2`,
        [v2, techPackFile, `t/${T}/made-up/${run}/tp4`],
      )
      await admin(`UPDATE "StoredFile" SET "supersededAt" = now() WHERE id = $1`, [techPackFile])
      await admin('COMMIT')
    } catch (error) {
      await admin('ROLLBACK')
      throw error
    }
    const fresh = (await ok('ada', 'GET', `/sales/inquiries/${inquiry.id}`)).inquiry
    expect(fresh.techPack.files[0]).toMatchObject({ named: { id: techPackFile, versionNo: 1 }, current: { id: v2, versionNo: 2 }, newer: true })
    const quoted = await ok('ada', 'POST', `/sales/inquiries/${inquiry.id}/quote`, { version: fresh.version }, 201)
    expect(quoted.leftOut).toEqual([])
    const order = await ok('ada', 'GET', `/sales/inquiries/source?quoteId=${quoted.quote.id}`)
    expect(order.inquiry.techPack.files[0]).toMatchObject({ current: { id: v2 }, newer: true })
    // The orders' side reads the same through the order's quote version (none here yet: not found for a made-up id).
    await no('ada', 'GET', `/sales/inquiries/source?salesOrderId=${newId()}`, undefined, 404)
    await no('ada', 'GET', '/sales/inquiries/source', undefined, 400)
  })

  it("makes a prospect of a stranger's mail, keeps the mail waiting, and joins it to the thread once matched to a customer", async () => {
    const draft = await ok('ada', 'GET', `/sales/inquiries/from-mail/${mailStranger}`)
    expect(draft).toMatchObject({ party: null, matchedBy: null, prospect: { name: 'Moto Club Esempio', email: 'nuovo.club@example.net' } })
    const mail = await one(`SELECT version FROM "InboundEmail" WHERE id = $1`, [mailStranger])
    await no('ada', 'POST', `/sales/inquiries/from-mail/${mailStranger}`, { version: mail.version + 1 }, 409)
    const { inquiry } = await ok('bruno', 'POST', `/sales/inquiries/from-mail/${mailStranger}`, { version: mail.version, assigneeId: PEOPLE.bruno }, 201)
    expect(inquiry).toMatchObject({ source: 'MAIL', status: 'ASSIGNED', prospect: true, fromWords: 'Moto Club Esempio', prospectDetails: { email: 'nuovo.club@example.net', lawfulBasis: 'CONTRACT' } })
    expect((await one(`SELECT status FROM "InboundEmail" WHERE id = $1`, [mailStranger])).status).toBe('TRIAGE')
    // A file of a mail it did not come from is no tech pack of it.
    expect(refusal(await no('bruno', 'PATCH', `/sales/inquiries/${inquiry.id}`, { version: inquiry.version, techPackFileIds: [techPackFile] }, 400))).toBe('body/techPackFileIds')
    const matched = (await ok('bruno', 'PATCH', `/sales/inquiries/${inquiry.id}`, { version: inquiry.version, partyId: P3, prospect: null })).inquiry
    expect(matched).toMatchObject({ party: { id: P3 }, prospect: false, prospectDetails: null })
    expect((await one(`SELECT status, "matchedBy" FROM "InboundEmail" WHERE id = $1`, [mailStranger])).status).toBe('MATCHED')
    expect((await events('inquiry.changed', inquiry.id)).map((event) => event.payload.change)).toEqual(['MATCHED'])
    // The customer is named for good.
    expect(refusal(await no('bruno', 'PATCH', `/sales/inquiries/${inquiry.id}`, { version: matched.version, partyId: P1 }, 400))).toBe('body/partyId')
  })
})

describe('declined or lost', () => {
  it('declines with the reason (Other in words), one or a selection, and marks a lost one with why', async () => {
    const make = async (request: string) => (await ok('ada', 'POST', '/sales/inquiries', { companyId: companyA, source: 'OFFICE', partyId: P3, request }, 201)).inquiry
    const first = await make('Made-up: 500 suits by next week.')
    expect(refusal(await no('ada', 'POST', `/sales/inquiries/${first.id}/decline`, { version: first.version, reason: 'OTHER' }, 409))).toBe('refusal/OTHER_NEEDS_WORDS')
    const declined = (await ok('ada', 'POST', `/sales/inquiries/${first.id}/decline`, { version: first.version, reason: 'LEAD_TIME' })).inquiry
    expect(declined).toMatchObject({ status: 'DECLINED', declineReason: 'LEAD_TIME', closedBy: { id: PEOPLE.ada } })
    const [a, b] = [await make('Made-up: a'), await make('Made-up: b')]
    const many = (await ok('ada', 'POST', '/sales/inquiries/decline', { items: [{ inquiryId: a.id, version: a.version }, { inquiryId: b.id, version: b.version }], reason: 'OTHER', note: 'Made-up: not a garment we make.' })).inquiries as Json[]
    expect(many.map((row) => row.status)).toEqual(['DECLINED', 'DECLINED'])
    expect((await ok('ada', 'GET', '/sales/inquiries?tile=DECLINED')).rows.map((row: Json) => row.id)).toEqual(expect.arrayContaining([first.id, a.id, b.id]))
    const lost = await make('Made-up: c')
    await no('ada', 'POST', `/sales/inquiries/${lost.id}/lost`, { version: lost.version }, 400)
    expect((await ok('ada', 'POST', `/sales/inquiries/${lost.id}/lost`, { version: lost.version, note: 'Made-up: they bought elsewhere.' })).inquiry).toMatchObject({ status: 'LOST', closeNote: 'Made-up: they bought elsewhere.' })
    expect((await events('inquiry.closed', lost.id))[0]!.payload).toMatchObject({ status: 'LOST', declineReason: null })
  })
})

describe('search and export', () => {
  it('indexes an inquiry by number and customer or prospect company, never what is asked; the export reads the list', async () => {
    const docs = await h.database.withScope({ audience: 'office', tenantId: T, actorId: PEOPLE.ada }, (client) => indexer.read(client as never, { ids: [phone, prospect] }, 10))
    const byId = new Map(docs.map((doc) => [doc.recordId, doc]))
    expect(byId.get(phone)).toMatchObject({ partyId: P1, title: expect.any(String), subtitle: 'Phone inquiry', status: 'QUOTED' })
    expect(byId.get(prospect)).toMatchObject({ partyId: null, title: 'Moto Club Fiera', subtitle: 'Fair inquiry' })
    for (const doc of docs) expect(entryOf(indexer, doc).searchText).not.toMatch(/visitor|race suits|jackets/i)
    const caller = callerFor(h.database, { ...SESSIONS.ada!, requestId: newId() } as never)
    const page = await exportSource.read(caller, exportSource.query(new URLSearchParams('tile=ALL&q=Moto Club Fiera')), null, 50)
    const row = (page.rows as Json[]).find((entry) => entry.id === prospect)!
    const words = (code: string) => exportSource.words!.en[code] ?? code
    expect(exportSource.columns.from!.value(row, words)).toBe('Moto Club Fiera')
    expect(exportSource.columns.status!.value(row, words)).toBe('In progress')
    expect(exportSource.columns.assignedTo!.value(row, words)).toBe('A colleague')
    expect(exportSource.columns.targetPrice!.grain).toBe('price')
  })
})
