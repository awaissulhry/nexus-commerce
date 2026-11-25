import { createHash } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FactoryDatabase } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Permission } from '@nexus/factory-domain/core/permissions'
import { KIND_WORDS } from '@nexus/factory-domain/sales/incoming/rules'
import { ACCEPT_WORDS, decisionProblem } from '@nexus/factory-domain/sales/portal-ordering/office'
import { RECORD_TYPE_WORDS } from '@nexus/factory-domain/threads/summary'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { callerFor } from '../../../core/command'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'
import { useAbuseGuard } from '../../../platform/abuse/guard'
import { usePortalOptions } from '../../../platform/auth/portal/service'
import { freshGuard, mailedCode, portalBrowser } from '../../../platform/auth/portal/testing/portal'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { addUser, Browser, enrolTotp, startHarness, type Answer, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'
import { processFiles } from '../../../platform/files/service'
import { carryArtwork } from './accept-artwork'
import { acceptRequest, confirmRequest, officeRequestView } from './office'

/**
 * B-CP-077 (customer page plan C5, 12 §9 B-CP-062; lead notes 1–2; review E3, F4; walls: brand W-CP-3, money M-CP-1) on the local
 * stack, through the real app and the real portal sign-in by code, every factory-db seed: customer A = SEED-C1 (P1) with its buyer,
 * customer B = SEED-C2 (P3) with its buyer; the office decides through the module's functions (an office caller) and, for the money
 * wall, through the app as a Sales worker of the ready-made roles (no price grain since B-CP-011).
 *
 *   - held until mapped: a request with a described and a made-to-measure line is held in words — as a quote: map them first; as an
 *     order: a made-to-measure line is a quote first (GATE-MTM is off); the office record names the lines to map and why it is no
 *     order; nothing is written;
 *   - what the office sends is refused by place (400): a catalogue line in the map, a line of another request, a line mapped twice,
 *     a described total without sizes, a price on a described line's `lines` entry, a size the colourway does not offer, and the
 *     brand wall: a style of another customer's own label is never made for this customer;
 *   - the ONE line map, by id: accepted as a QUOTE — the catalogue line 1 → 1, the described line 1 → 2 (two colourways), the
 *     made-to-measure line 1 → 1 with its people's own sizes — in the answer (`made.lines`) and in the accept's audit; each mapped
 *     quote line's note names the request and the line and how many people, never a person's name; the roster stays on the request;
 *   - accepted as an ORDER (a catalogue and a described line) by a Sales worker through the app, without a price key: the order's
 *     lines by the map, the pieces the request asked and the order makes differ (said), the answer carries no price (M-CP-1); a
 *     unit price typed on the map is refused 403 by the grain filter;
 *   - ARTWORK carried: a logo on the described line lands on each line made from it (QuoteLine / SalesOrderLine), a logo on the draft
 *     on the quote / order itself — category ARTWORK, naming its source, shared with customer A only; carried again, nothing doubles;
 *   - "Portal order": the record type and Incoming's kind in words (the code stays CATALOGUE_ORDER).
 * od-ts (order start, 13-backend § 5 and § 7; addendum R1–R3): the office's Confirm of a customer's DRAFT (confirmRequest, called as the
 * office person like acceptRequest): send and accept in ONE command (WS-OD-12: the number, sent by the office person, one order, the
 * row's open choices in words on the order line, the customer's note labelled in the internal note only); a fully open row is filled
 * by the Confirm body (held in words until then); a custom-size row makes it a quote (the wanted date in its internal note); no row
 * and a decided request are refused.
 * Every name and figure is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/sales/portal-ordering/accept-kinds`.
 */

type Json = Record<string, any>
const SEED_DIR = fileURLToPath(new URL('../../../../../../packages/factory-db/seed', import.meta.url))
const NS = 'accept-kinds-cp077'
const T = seedUuid(NS, 'tenant')
const companyA = seedUuid(NS, 'company:A')
const partyA = seedUuid(NS, 'party:P1')
const partyB = seedUuid(NS, 'party:P3')
const TENANT: TestTenant = { id: T, slug: NS, companies: [{ id: companyA, code: 'SCA' }] }
const PRICE_KEYS = /"(unitPrice|listUnitPrice|unitPriceShown|listPriceNow|amountShown|netShown|netAmount|brandUnitPrice|draftValueAmount|priceDiff|priceMatch)":/

let h: Harness
const people = { aBuyer: 'anna.buyer.cp077@brand-alpha.example', bBuyer: 'bruna.buyer.cp077@brand-beta.example' }
type Who = keyof typeof people
const browsers = {} as Record<Who, Browser>
let sales: Browser
const ADA = newId()
const office = () =>
  callerFor(h.database, { audience: 'office', tenantId: T, actorId: ADA, requestId: newId(), grants: [{ permissions: ['orders.view', 'orders.manage', 'quotes.view', 'quotes.manage', 'money.price', 'files.read', 'threads.read'] as Permission[], companies: 'all', sites: 'all', parties: 'all' }] })
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
let serial = 0
const call = (who: Who, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown): Promise<Answer> =>
  browsers[who].send(method as 'POST', url, method === 'GET' || method === 'DELETE' ? undefined : (body ?? {}), method === 'GET' ? {} : { headers: { 'idempotency-key': `cp077-key-${++serial}` } })
async function ok(who: Who, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown, status = 200): Promise<Json> {
  const answer = await call(who, method, url, body)
  expect(answer.status, `${who} ${method} ${url}: ${JSON.stringify(answer.body)}`).toBe(status)
  return answer.body as Json
}
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
const png = (text: string): Buffer => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`made-up picture: ${text}`)])
const base = (id: string) => `/portal/order-requests/${id}`
/** A refusal thrown by a module function: its code, words and issue paths. */
async function thrown(work: Promise<unknown>): Promise<{ code: string; message: string; paths: string[] }> {
  try {
    await work
  } catch (error) {
    const failure = error as { code?: string; message: string; issues?: { path: string }[] }
    return { code: failure.code ?? '', message: failure.message, paths: (failure.issues ?? []).map((issue) => issue.path) }
  }
  throw new Error('expected a refusal')
}

/** Announce, PUT the bytes to the local store's presigned URL, confirm: the file as the draft reads it. */
async function upload(who: Who, requestId: string, name: string, bytes: Buffer, lineId?: string): Promise<Json> {
  const announced = await ok(who, 'POST', `${base(requestId)}/files`, { part: 'LOGO', originalName: name, contentType: 'image/png', sizeBytes: bytes.length, sha256: sha(bytes), ...(lineId ? { lineId } : {}) }, 201)
  const put = await h.app.inject({ method: 'PUT', url: announced.upload.url, headers: announced.upload.headers, payload: bytes })
  expect(put.statusCode, put.body).toBeLessThan(300)
  return (await ok(who, 'POST', `${base(requestId)}/files/${announced.file.id}/complete`)).file
}

async function partnerPerson(email: string, displayName: string, partyId: string, roleKeys: string[]): Promise<void> {
  await h.database.withScope({ audience: 'office', tenantId: T, actorId: newId() }, async (client) => {
    const id = newId()
    await client.user.create({ data: { id, email, displayName, locale: 'en', status: 'ACTIVE', audience: 'PARTNER', partyId, partnerKind: 'CUSTOMER' }, select: { id: true } })
    for (const key of roleKeys) {
      const role = await client.role.findUniqueOrThrow({ where: { tenantId_key: { tenantId: T, key } }, select: { id: true } })
      await client.roleAssignment.create({ data: { id: newId(), userId: id, roleId: role.id, allCompanies: true, partyIds: [partyId], validFrom: new Date(h.clock.now().getTime() - 60_000) }, select: { id: true } })
    }
  })
}

async function signedIn(email: string): Promise<Browser> {
  const browser = await portalBrowser(h)
  h.clock.advance(61_000)
  expect((await browser.post('/portal/signin/start', { tenant: NS, company: 'SCA', email })).status).toBe(200)
  await h.auth.settled()
  const answer = await browser.post('/portal/signin/code', { tenant: NS, company: 'SCA', email, code: mailedCode(h, email)!.code })
  expect(answer.status, JSON.stringify(answer.body)).toBe(200)
  const terms = await browser.get('/portal/terms?locale=en')
  expect((await browser.post('/portal/first-visit', { noticeId: terms.body.notice.id, noticeLocale: terms.body.notice.locale, sha256: terms.body.notice.sha256 })).status).toBe(200)
  return browser
}

const G = {} as Record<string, any>
const grid = (rows: [string, number][]) => rows.map(([size, quantity]) => ({ size, quantity }))

/**
 * A sent request of customer A: a catalogue line (SEED-JKT-02 black, 3 pieces), a described line (6 team jackets in words), maybe
 * a made-to-measure line (JACKET, three people with their sizes) and the logos (one on the draft, one on the described line).
 */
async function sentRequest(ref: string, withMtm: boolean): Promise<{ id: string; version: number; number: string; catalogue: string; described: string; mtm: string | null; logos: { draft: string; line: string } }> {
  const made = await ok('aBuyer', 'POST', '/portal/order-requests', { customerRef: ref }, 201)
  const id = made.request.id as string
  const catalogue = await ok('aBuyer', 'POST', `${base(id)}/lines`, { version: made.request.version, lines: [{ styleId: G.style, colourwayId: G.black, sizes: grid([['50', 2], ['52', 1]]) }] })
  const described = await ok('aBuyer', 'POST', `${base(id)}/custom-lines`, { version: catalogue.request.version, line: { kind: 'DESCRIBED', description: 'Made-up team jackets with our logo on the back', colourText: 'Half black, half red', quantity: 6 } })
  const describedId = described.request.customLines[0].id as string
  let version = described.request.version as number
  let mtm: string | null = null
  if (withMtm) {
    const tailored = await ok('aBuyer', 'POST', `${base(id)}/custom-lines`, { version, line: { kind: 'MADE_TO_MEASURE', garmentType: 'JACKET', description: 'Made-up race suits for our riders' } })
    mtm = tailored.request.customLines.find((line: Json) => line.kind === 'MADE_TO_MEASURE').id as string
    const roster = await ok('aBuyer', 'POST', `${base(id)}/lines/${mtm}/people`, {
      version: tailored.request.version,
      people: [
        { name: 'Made-up Rider Uno', number: '46', measureBy: 'SIZE', size: '50' },
        { name: 'Made-up Rider Due', measureBy: 'SIZE', size: '52' },
        { name: 'Made-up Rider Tre', number: '7', measureBy: 'SIZE', size: '52' },
      ],
    })
    version = roster.request.version
  }
  const draftLogo = await upload('aBuyer', id, `made-up-team-logo-${ref}.png`, png(`team logo ${ref}`))
  const lineLogo = await upload('aBuyer', id, `made-up-back-print-${ref}.png`, png(`back print ${ref}`), describedId)
  const read = await ok('aBuyer', 'GET', base(id))
  const sent = await ok('aBuyer', 'POST', `${base(id)}/send`, { version: read.request.version })
  expect(sent.request.status).toBe('SENT')
  return { id, version: sent.request.version, number: sent.request.number, catalogue: catalogue.request.lines[0].id, described: describedId, mtm, logos: { draft: draftLogo.id, line: lineLogo.id } }
}

beforeAll(async () => {
  h = await startHarness('accept_kinds_cp077')
  h.clock.set(new Date())
  usePortalOptions({ answerFloorMs: 0 })
  for (const file of readdirSync(SEED_DIR).filter((name) => name.endsWith('.ts')).sort()) {
    const module = (await import(pathToFileURL(join(SEED_DIR, file)).href)) as { seed: (context: { db: FactoryDatabase; namespace: string }) => Promise<unknown> }
    await module.seed({ db: h.database, namespace: NS })
  }
  const actorId = newId()
  await h.database.withScope({ audience: 'office', tenantId: T, actorId }, async (client) => {
    await applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId })
    for (const party of [partyA, partyB]) await client.portalSettings.upsert({ where: { id: party }, create: { id: party, partyId: party, portalOn: true }, update: { portalOn: true }, select: { id: true } })
    await client.user.create({ data: { id: ADA, email: 'ada.office.cp077@example.com', displayName: 'Made-up Ada', locale: 'en', status: 'ACTIVE' }, select: { id: true } })
  })
  await admin('UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE "tenantId" = $1', [T])
  freshGuard(h)
  await partnerPerson(people.aBuyer, 'Made-up Anna Buyer', partyA, ['customer-buyer', 'partner-comment', 'partner-upload'])
  await partnerPerson(people.bBuyer, 'Made-up Bruna Buyer', partyB, ['customer-buyer', 'partner-comment', 'partner-upload'])
  for (const who of Object.keys(people) as Who[]) browsers[who] = await signedIn(people[who])
  // A Sales worker of the ready-made roles (no price grain: B-CP-011), signed in through the app.
  const user = await addUser(h, TENANT, { email: 'sam.sales.cp077@example.com', role: 'sales' })
  sales = new Browser(h.app)
  expect((await sales.signIn(NS, user.email, user.password)).status).toBe(200)
  await enrolTotp(h, sales)
  // Customer A's own label (SEED-JKT-02) in black and red: its catalogue line, and what the office makes the described lines into.
  G.style = (await admin<{ id: string }>(`SELECT id FROM "Style" WHERE "tenantId" = $1 AND code = 'SEED-JKT-02'`, [T]))[0]!.id
  G.black = (await admin<{ id: string }>(`SELECT id FROM "Colourway" WHERE "tenantId" = $1 AND "styleId" = $2 AND code = 'BLK'`, [T, G.style]))[0]!.id
  G.red = (await admin<{ id: string }>(`SELECT id FROM "Colourway" WHERE "tenantId" = $1 AND "styleId" = $2 AND code = 'RED'`, [T, G.style]))[0]!.id
  // The sign-ins moved the harness clock ahead of the real one; the office's calls run on the real clock: a decision is never
  // before its send (the database checks decidedAt >= sentAt).
  h.clock.set(new Date(Date.now() - 2_000))
}, 900_000)

beforeEach(() => {
  freshGuard(h)
})

afterAll(async () => {
  useAbuseGuard(undefined)
  usePortalOptions({})
  await h?.close()
})

describe('B-CP-077: accept a described or made-to-measure request by its line map', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('held until mapped: as a quote, map the lines first; as an order, a made-to-measure line is a quote first; nothing is written', async () => {
    const request = await sentRequest('PO-CP077-Q', true)
    Object.assign(G, { quoteRequest: request })
    const view = await officeRequestView(office(), request.id)
    // The record names what the accept needs: the lines to map (in the request's order) and why it is not an order.
    expect(view.request.acceptMap).toEqual({ lineIds: [request.described, request.mtm], orderHeld: ACCEPT_WORDS.madeToMeasureOrder([3]) })
    expect(view.request.customLines.map((line) => [line.seq, line.kind, line.pieces])).toEqual([[2, 'DESCRIBED', 6], [3, 'MADE_TO_MEASURE', 3]])
    const asQuote = await thrown(acceptRequest(office(), request.id, { version: request.version, as: 'QUOTE' }))
    expect(asQuote).toEqual({ code: 'invalid_state', message: ACCEPT_WORDS.unmapped([2, 3]), paths: ['request/lines/2', 'request/lines/3'] })
    expect(asQuote.message).toMatch(/described or made to measure/)
    // Mapped or not, a made-to-measure line is never an order while made-to-measure has not started (GATE-MTM).
    const asOrder = await thrown(acceptRequest(office(), request.id, { version: request.version, as: 'ORDER', map: [{ lineId: request.mtm!, into: [{ styleId: G.style, colourwayId: G.black }] }] }))
    expect(asOrder).toEqual({ code: 'invalid_state', message: ACCEPT_WORDS.madeToMeasureOrder([3]), paths: ['request/lines/3'] })
    expect((await admin('SELECT status, version FROM "PortalOrderRequest" WHERE id = $1', [request.id]))[0]).toMatchObject({ status: 'SENT', version: request.version })
  })

  it('what the office sends is refused by place: a catalogue line, another request’s line, twice, no sizes, a size not offered, another customer’s own label', async () => {
    const request = G.quoteRequest
    const other = await sentRequest('PO-CP077-X', false)
    const mtm = { lineId: request.mtm, into: [{ styleId: G.style, colourwayId: G.black }] }
    const refusals: [Json, string, string][] = [
      [{ map: [{ lineId: request.catalogue, into: [{ styleId: G.style, colourwayId: G.black, sizes: grid([['50', 1]]) }] }, mtm] }, 'body/map/0/lineId', ACCEPT_WORDS.fromCatalogue(1)],
      [{ map: [{ lineId: other.described, into: [{ styleId: G.style, colourwayId: G.black, sizes: grid([['50', 1]]) }] }, mtm] }, 'body/map/0/lineId', ACCEPT_WORDS.notALine],
      [{ map: [mtm, mtm] }, 'body/map/1/lineId', ACCEPT_WORDS.mappedTwice(3)],
      // A described line with a total only: the office names its sizes.
      [{ map: [{ lineId: request.described, into: [{ styleId: G.style, colourwayId: G.black }] }, mtm] }, 'body/map/0/into/0/sizes', ACCEPT_WORDS.sizesOfTotal(2, 6)],
      // A line made into two style lines names the sizes of each.
      [{ map: [{ lineId: request.described, into: [{ styleId: G.style, colourwayId: G.black, sizes: grid([['50', 3]]) }, { styleId: G.style, colourwayId: G.red }] }, mtm] }, 'body/map/0/into/1/sizes', ACCEPT_WORDS.sizesOfEach(2)],
      // A typed price on a described line's `lines` entry: its price goes on the style line it is made into.
      [{ lines: [{ lineId: request.described, unitPrice: '100' }], map: [{ lineId: request.described, into: [{ styleId: G.style, colourwayId: G.black, sizes: grid([['50', 6]]) }] }, mtm] }, 'body/lines/0/lineId', ACCEPT_WORDS.priceOnMap(2)],
    ]
    for (const [body, path, words] of refusals) {
      const refused = await thrown(acceptRequest(office(), request.id, { version: request.version, as: 'QUOTE', ...body }))
      expect(refused, path).toMatchObject({ code: 'validation_failed', message: words })
      expect(refused.paths, path).toContain(path)
    }
    // Checked in the command against the style: a size its colourway does not offer.
    const notOffered = await thrown(acceptRequest(office(), request.id, { version: request.version, as: 'QUOTE', map: [{ lineId: request.described, into: [{ styleId: G.style, colourwayId: G.black, sizes: grid([['99', 6]]) }] }, mtm] }))
    expect(notOffered).toMatchObject({ code: 'validation_failed', paths: ['body/map/0/into/0/sizes'] })
    // The brand wall: customer B's described line made into customer A's own label is refused (the office reads why).
    const theirs = await ok('bBuyer', 'POST', '/portal/order-requests', { customerRef: 'PO-CP077-B' }, 201)
    const theirLine = await ok('bBuyer', 'POST', `${base(theirs.request.id)}/custom-lines`, { version: theirs.request.version, line: { kind: 'DESCRIBED', description: 'Made-up caps for our shop', quantity: 3 } })
    const theirSent = await ok('bBuyer', 'POST', `${base(theirs.request.id)}/send`, { version: theirLine.request.version })
    const wall = await thrown(acceptRequest(office(), theirs.request.id, { version: theirSent.request.version, as: 'QUOTE', map: [{ lineId: theirLine.request.customLines[0].id, into: [{ styleId: G.style, colourwayId: G.black, sizes: grid([['50', 3]]) }] }] }))
    expect(wall).toMatchObject({ code: 'validation_failed', paths: ['body/map/0/into/0/styleId'] })
    expect(wall.message).toMatch(/another customer's own label/)
    // Nothing was made: both requests are still SENT.
    expect((await admin<{ status: string }>('SELECT status FROM "PortalOrderRequest" WHERE id = ANY($1::uuid[]) ORDER BY status', [[request.id, theirs.request.id]])).map((row) => row.status)).toEqual(['SENT', 'SENT'])
  })

  it('accepted as a QUOTE by its ONE line map, by id: 1 → 1, 1 → 2, the made-to-measure line with its people’s sizes; the people stay on the request', async () => {
    const request = G.quoteRequest
    const accepted = await acceptRequest(office(), request.id, {
      version: request.version,
      as: 'QUOTE',
      map: [
        { lineId: request.described, into: [{ styleId: G.style, colourwayId: G.black, sizes: grid([['50', 3]]) }, { styleId: G.style, colourwayId: G.red, sizes: grid([['52', 3]]) }] },
        // No sizes named: every person has a size, so the line takes them (50 × 1, 52 × 2).
        { lineId: request.mtm, into: [{ styleId: G.style, colourwayId: G.black }] },
      ],
    })
    expect(accepted.made).toMatchObject({ as: 'QUOTE', salesOrderId: null, dropped: [] })
    const quoteLines = await admin<{ id: string; seq: number; colourway: string; pieces: number; note: string | null }>(
      `SELECT l.id, l.seq, c.code AS colourway, l.quantity::int AS pieces, l.note FROM "QuoteLine" l JOIN "QuoteVersion" v ON v.id = l."versionId" JOIN "Colourway" c ON c.id = l."colourwayId" WHERE v."quoteId" = $1 ORDER BY l.seq`,
      [accepted.made.quoteId],
    )
    expect(quoteLines.map((line) => [line.colourway, line.pieces])).toEqual([['BLK', 3], ['BLK', 3], ['RED', 3], ['BLK', 3]])
    // The map: every request line by id, each with the quote lines made from it (never by place).
    expect(accepted.made.lines).toEqual([
      { requestLineId: request.catalogue, requestSeq: 1, into: [{ lineId: quoteLines[0]!.id, seq: quoteLines[0]!.seq }] },
      { requestLineId: request.described, requestSeq: 2, into: [{ lineId: quoteLines[1]!.id, seq: quoteLines[1]!.seq }, { lineId: quoteLines[2]!.id, seq: quoteLines[2]!.seq }] },
      { requestLineId: request.mtm, requestSeq: 3, into: [{ lineId: quoteLines[3]!.id, seq: quoteLines[3]!.seq }] },
    ])
    const sizes = await admin<{ size: string; quantity: number }>('SELECT size, quantity FROM "QuoteLineSize" WHERE "lineId" = $1 ORDER BY size', [quoteLines[3]!.id])
    expect(sizes).toEqual([{ size: '50', quantity: 1 }, { size: '52', quantity: 2 }])
    // A mapped line names where it came from: the request, the line, the customer's words, how many people — never their names.
    expect(quoteLines[1]!.note).toContain(`Request ${request.number}, line 2 (described): Made-up team jackets with our logo on the back`)
    expect(quoteLines[3]!.note).toContain('People: 3 on the request (their names stay there)')
    expect(JSON.stringify(quoteLines)).not.toMatch(/Rider (Uno|Due|Tre)/)
    // The accept's audit keeps the map (ids and places only).
    const [audit] = await admin<{ after: Json }>(`SELECT after FROM "AuditLog" WHERE "recordType" = 'PortalOrderRequest' AND "recordId" = $1 AND action = 'portalOrdering.accept'`, [request.id])
    expect(audit!.after.lineMap).toEqual(accepted.made.lines.map((entry: Json) => ({ requestLineId: entry.requestLineId, requestSeq: entry.requestSeq, into: entry.into.map((line: Json) => line.lineId) })))
    // The people stay on the request, which the quote links: the office reads them there.
    const after = await officeRequestView(office(), request.id)
    expect(after.request).toMatchObject({ status: 'ACCEPTED', quote: { id: accepted.made.quoteId } })
    expect(after.request.customLines.find((line) => line.id === request.mtm)!.people.map((person) => person.name)).toEqual(['Made-up Rider Uno', 'Made-up Rider Due', 'Made-up Rider Tre'])
    Object.assign(G, { quoted: accepted.made, quoteLines })
  })

  it('ARTWORK carried: the line’s logo onto each quote line made from it, the draft’s onto the quote; shared with customer A only; never twice', async () => {
    const request = G.quoteRequest
    const copies = await admin<{ id: string; recordType: string; recordId: string; category: string; sourceFileId: string; partyId: string | null; visibility: string[] }>(
      `SELECT id, "recordType", "recordId", category::text, "sourceFileId", "partyId", visibility::text[] FROM "StoredFile" WHERE "sourceFileId" = ANY($1::uuid[]) ORDER BY "recordType", "recordId"`,
      [[request.logos.draft, request.logos.line]],
    )
    const described = G.quoted.lines.find((entry: Json) => entry.requestLineId === request.described).into.map((line: Json) => line.lineId).sort()
    expect(copies.filter((copy) => copy.sourceFileId === request.logos.line).map((copy) => [copy.recordType, copy.recordId])).toEqual(described.map((lineId: string) => ['QuoteLine', lineId]))
    expect(copies.filter((copy) => copy.sourceFileId === request.logos.draft).map((copy) => [copy.recordType, copy.recordId])).toEqual([['Quote', G.quoted.quoteId]])
    for (const copy of copies) expect(copy).toMatchObject({ category: 'ARTWORK', partyId: partyA })
    expect(G.quoted.artwork.carried).toHaveLength(3)
    expect(G.quoted.artwork.notCarried).toEqual([])
    // Carried again (a retry): nothing doubles.
    const again = await carryArtwork(() => processFiles(), office(), { id: request.id, companyId: companyA, partyId: partyA, number: request.number }, G.quoted)
    expect(again).toEqual({ carried: [], notCarried: [] })
    expect((await admin('SELECT id FROM "StoredFile" WHERE "sourceFileId" = ANY($1::uuid[])', [[request.logos.draft, request.logos.line]])).length).toBe(3)
  })

  it('accepted as an ORDER by a Sales worker through the app, without a price key: lines by the map, the pieces said, no price in the answer (M-CP-1)', async () => {
    const request = await sentRequest('PO-CP077-O', false)
    const read = await sales.send('GET', `/sales/order-requests/${request.id}`)
    expect(read.status, JSON.stringify(read.body)).toBe(200)
    expect(JSON.stringify(read.body)).not.toMatch(PRICE_KEYS)
    expect(read.body.request.acceptMap).toEqual({ lineIds: [request.described], orderHeld: null })
    const map = [{ lineId: request.described, into: [{ styleId: G.style, colourwayId: G.red, sizes: grid([['50', 2], ['52', 3]]) }] }]
    // A unit price typed on the map is a money field: refused 403 by the grain filter, by its path; nothing is written.
    const priced = await sales.send('POST', `/sales/order-requests/${request.id}/accept`, { version: request.version, as: 'ORDER', map: [{ ...map[0], into: [{ ...map[0]!.into[0], unitPrice: '100' }] }] })
    expect(priced.status, JSON.stringify(priced.body)).toBe(403)
    expect((priced.body.error.issues as Json[]).map((issue) => issue.path)).toEqual(['map/0/into/0/unitPrice'])
    const accepted = await sales.send('POST', `/sales/order-requests/${request.id}/accept`, { version: request.version, as: 'ORDER', map })
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200)
    expect(JSON.stringify(accepted.body)).not.toMatch(PRICE_KEYS)
    const made = accepted.body.made
    expect(made).toMatchObject({ as: 'ORDER', quoteId: null, warnings: expect.arrayContaining([ACCEPT_WORDS.pieces(2, 6, 5, 'ORDER')]) })
    const orderLines = await admin<{ id: string; seq: number; colourway: string; pieces: number; note: string | null }>(
      `SELECT l.id, l.seq, c.code AS colourway, l.quantity::int AS pieces, l.note FROM "SalesOrderLine" l JOIN "Colourway" c ON c.id = l."colourwayId" WHERE l."orderId" = $1 ORDER BY l.seq`,
      [made.salesOrderId],
    )
    expect(orderLines.map((line) => [line.seq, line.colourway, line.pieces])).toEqual([[10, 'BLK', 3], [20, 'RED', 5]])
    expect(made.lines).toEqual([
      { requestLineId: request.catalogue, requestSeq: 1, into: [{ lineId: orderLines[0]!.id, seq: 10 }] },
      { requestLineId: request.described, requestSeq: 2, into: [{ lineId: orderLines[1]!.id, seq: 20 }] },
    ])
    expect(orderLines[1]!.note).toContain(`Request ${request.number}, line 2 (described)`)
    // The logos: the line's onto the order line made from it, the draft's onto the order.
    const copies = await admin<{ recordType: string; recordId: string; sourceFileId: string }>(`SELECT "recordType", "recordId", "sourceFileId" FROM "StoredFile" WHERE "sourceFileId" = ANY($1::uuid[]) ORDER BY "recordType"`, [[request.logos.draft, request.logos.line]])
    expect(copies).toEqual([
      { recordType: 'SalesOrder', recordId: made.salesOrderId, sourceFileId: request.logos.draft },
      { recordType: 'SalesOrderLine', recordId: orderLines[1]!.id, sourceFileId: request.logos.line },
    ])
  })

  it('"Portal order": the record type and Incoming’s kind in words (the code stays CATALOGUE_ORDER)', () => {
    expect(RECORD_TYPE_WORDS.PortalOrderRequest).toEqual({ it: 'Ordine dal portale', en: 'Portal order' })
    expect(KIND_WORDS.CATALOGUE_ORDER).toEqual({ it: 'Ordine dal portale', en: 'Portal order' })
  })
})

// ---- od-ts (order start, 13-backend § 5, § 7 WS-OD-12; addendum R1–R3): Confirm = send (a draft) + accept, in ONE command -------------
/** A row's open choice: "Leather: Cowhide · Kangaroo · Not decided yet". */
const leather = [{ topic: 'Leather', options: ['Cowhide', 'Kangaroo'], picked: null }]
/** A day `days` after the harness's today (the portal checks a wanted date against it), as a business date. */
const daysOn = (days: number): string => new Date(h.clock.now().getTime() + days * 86_400_000).toISOString().slice(0, 10)
/** The request as stored (nothing written by a refusal). */
const stored = async (id: string): Promise<Json> => (await admin('SELECT status::text AS status, number, version FROM "PortalOrderRequest" WHERE id = $1', [id]))[0]!

describe('od-ts: the office confirms a customer’s draft — send and accept in one command', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('WS-OD-12 confirm sends and accepts in one command; ACCEPTED names one order; the choices are in the line’s note as words; the customer’s note is in the internal note only, labelled', async () => {
    const note = 'Made-up: the same red as last season, please.'
    // od-fx4: SEED-C1's terms ask its PO number on every order (the order rule, not the draft's): the customer types it on the draft.
    const made = await ok('aBuyer', 'POST', '/portal/order-requests', { subject: 'Made-up team jackets', note, customerRef: 'PO-OD-WS12' }, 201)
    const id = made.request.id as string
    const row = await ok('aBuyer', 'POST', `${base(id)}/custom-lines`, { version: made.request.version, line: { description: 'Made-up team jackets in leather', quantity: 4, choices: leather } })
    const lineId = row.request.customLines[0].id as string
    // Never sent: a DRAFT with no number; its row has an open choice.
    expect(row.request).toMatchObject({ status: 'DRAFT', number: null, sentAt: null, note })
    expect(row.request.customLines[0]).toMatchObject({ kind: 'DESCRIBED', quantity: 4, choices: leather })
    const confirmed = await confirmRequest(office(), id, { version: row.request.version, as: 'ORDER', map: [{ lineId, into: [{ styleId: G.style, colourwayId: G.black, sizes: grid([['50', 2], ['52', 2]]) }] }] })
    expect(confirmed.made).toMatchObject({ as: 'ORDER', quoteId: null, salesOrderId: expect.any(String) })
    const number = confirmed.request.number!
    // The PORTAL_REQUEST series (seed/numbering: RQ-{N:4}).
    expect(number).toMatch(/^RQ-\d{4,}$/)
    expect(confirmed.request).toMatchObject({ status: 'ACCEPTED', salesOrder: { id: confirmed.made.salesOrderId }, quote: null })
    // Sent and decided by the office person, in the same command; ACCEPTED names ONE order.
    const [request] = await admin(`SELECT status::text AS status, number, "sentById", "decidedById", "salesOrderId", "quoteId", "sentAt" = "decidedAt" AS "oneMoment" FROM "PortalOrderRequest" WHERE id = $1`, [id])
    expect(request).toEqual({ status: 'ACCEPTED', number, sentById: ADA, decidedById: ADA, salesOrderId: confirmed.made.salesOrderId, quoteId: null, oneMoment: true })
    // The customer's note: labelled as theirs in the order's internal note (the office-only note), on no order line.
    const orders = await admin<{ id: string; internalNote: string | null }>(`SELECT id, "internalNote" FROM "SalesOrder" WHERE "internalNote" LIKE $1`, [`%(order request ${number})%`])
    expect(orders).toEqual([{ id: confirmed.made.salesOrderId, internalNote: `Customer's note (order request ${number}): ${note}` }])
    const orderLines = await admin<{ colourway: string; pieces: number; note: string | null }>(
      `SELECT c.code AS colourway, l.quantity::int AS pieces, l.note FROM "SalesOrderLine" l JOIN "Colourway" c ON c.id = l."colourwayId" WHERE l."orderId" = $1 ORDER BY l.seq`,
      [confirmed.made.salesOrderId],
    )
    expect(orderLines.map((line) => [line.colourway, line.pieces])).toEqual([['BLK', 4]])
    // The row's open choice travels to the order line's note as words (the real option is picked later on the order).
    expect(orderLines[0]!.note).toContain(`Request ${number}, line 1 (described): Made-up team jackets in leather`)
    expect(orderLines[0]!.note).toContain('Leather: Cowhide or Kangaroo — not decided yet')
    expect(JSON.stringify(orderLines)).not.toContain(note)
    // The send's own audit row (by the office) and its event, beside the accept's.
    const sentAudit = await admin<{ action: string; actorId: string; after: Json }>(`SELECT action, "actorId", after FROM "AuditLog" WHERE "recordType" = 'PortalOrderRequest' AND "recordId" = $1 AND after->>'status' = 'SENT'`, [id])
    expect(sentAudit).toHaveLength(1)
    expect(sentAudit[0]).toMatchObject({ action: 'portalOrdering.confirm', actorId: ADA, after: { status: 'SENT', number, lines: 1, pieces: 4, byOffice: true } })
    expect(sentAudit[0]!.after).not.toHaveProperty('byPartner')
    const sent = await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE type = 'portal_order_request.sent' AND subject = $1`, [id])
    expect(sent.map((event) => event.payload)).toEqual([expect.objectContaining({ requestId: id, number, partyId: partyA, lines: 1, pieces: 4 })])
    expect(await admin(`SELECT 1 FROM "OutboxEvent" WHERE type = 'portal_order_request.accepted' AND subject = $1`, [id])).toHaveLength(1)
    // The customer keeps reading its own note on its request, now accepted.
    expect((await ok('aBuyer', 'GET', base(id))).request).toMatchObject({ status: 'ACCEPTED', number, note })
    G.confirmed = { id, version: confirmed.request.version }
  })

  it('R3: a Confirm body fills every open cell of a fully open row', async () => {
    // od-fx4: the PO number SEED-C1's terms ask on an order (nothing else on the draft: the row is fully open).
    const made = await ok('aBuyer', 'POST', '/portal/order-requests', { customerRef: 'PO-OD-R3' }, 201)
    const id = made.request.id as string
    // The customer's default delivery address (seed/parties: P1's workshop) is the draft's.
    expect(made.request.shipToAddressId).toBe(seedUuid(NS, 'party-address:P1:workshop'))
    const empty = await ok('aBuyer', 'POST', `${base(id)}/custom-lines`, { version: made.request.version, line: {} })
    const lineId = empty.request.customLines[0].id as string
    expect(empty.request.customLines[0]).toMatchObject({ seq: 1, kind: 'DESCRIBED', sizing: null, description: null, style: null, colourway: null, quantity: null, sizes: [], byPerson: false, choices: null })
    // Still open is information on the read: the row's style, sizing, colour, pieces and the date; never MISSING there.
    expect(empty.request.stillOpen).toMatchObject({ openCount: 5, confirmHeld: true })
    expect(empty.request.stillOpen.items.map((item: Json) => item.state)).not.toContain('MISSING')
    // Confirmed with nothing typed for the row: held in words (409), each missing cell by its place; nothing is written.
    const held = await thrown(confirmRequest(office(), id, { version: empty.request.version, as: 'ORDER' }))
    expect(held).toEqual({
      code: 'conflict',
      message: 'Before it is confirmed, the order still needs: line 1 its style and its colour and its pieces by size.',
      paths: ['refusal/CONFIRM_HELD', 'stillOpen/lines/1/PRODUCT', 'stillOpen/lines/1/COLOUR', 'stillOpen/lines/1/PIECES'],
    })
    expect(await stored(id)).toEqual({ status: 'DRAFT', number: null, version: empty.request.version })
    // The body types the style, the colour and the pieces by size: an order of one line.
    const confirmed = await confirmRequest(office(), id, { version: empty.request.version, as: 'ORDER', map: [{ lineId, into: [{ styleId: G.style, colourwayId: G.red, sizes: grid([['50', 1], ['52', 2]]) }] }] })
    expect(confirmed.request.status).toBe('ACCEPTED')
    expect(confirmed.made).toMatchObject({ as: 'ORDER', quoteId: null, lines: [{ requestLineId: lineId, requestSeq: 1, into: [expect.objectContaining({ seq: 10 })] }] })
    const orderLines = await admin<{ colourway: string; pieces: number }>(`SELECT c.code AS colourway, l.quantity::int AS pieces FROM "SalesOrderLine" l JOIN "Colourway" c ON c.id = l."colourwayId" WHERE l."orderId" = $1 ORDER BY l.seq`, [confirmed.made.salesOrderId])
    expect(orderLines).toEqual([{ colourway: 'RED', pieces: 3 }])
  })

  it('R3: a custom-size row makes it a quote — held as an order in today’s words; as a quote its internal note keeps the customer’s note and the wanted date (S4-B2)', async () => {
    const note = 'Made-up: fitted suits for our two riders.'
    const wanted = daysOn(60)
    const made = await ok('aBuyer', 'POST', '/portal/order-requests', { note, requestedDate: wanted }, 201)
    const id = made.request.id as string
    const tailored = await ok('aBuyer', 'POST', `${base(id)}/custom-lines`, { version: made.request.version, line: { sizing: 'MADE_TO_MEASURE' } })
    const lineId = tailored.request.customLines[0].id as string
    expect(tailored.request.customLines[0]).toMatchObject({ kind: 'MADE_TO_MEASURE', sizing: 'MADE_TO_MEASURE', byPerson: true, garmentType: null })
    const map = [{ lineId, into: [{ styleId: G.style, colourwayId: G.black, sizes: grid([['50', 1], ['52', 1]]) }] }]
    // As an order: a made-to-measure row is a quote first (GATE-MTM), mapped or not; nothing is written.
    const asOrder = await thrown(confirmRequest(office(), id, { version: tailored.request.version, as: 'ORDER', map }))
    expect(asOrder).toEqual({ code: 'invalid_state', message: ACCEPT_WORDS.madeToMeasureOrder([1]), paths: ['request/lines/1'] })
    expect(await stored(id)).toEqual({ status: 'DRAFT', number: null, version: tailored.request.version })
    const confirmed = await confirmRequest(office(), id, { version: tailored.request.version, as: 'QUOTE', map })
    const number = confirmed.request.number!
    expect(confirmed.made).toMatchObject({ as: 'QUOTE', salesOrderId: null, quoteId: expect.any(String) })
    expect(confirmed.request).toMatchObject({ status: 'ACCEPTED', quote: { id: confirmed.made.quoteId }, salesOrder: null })
    const [quote] = await admin<{ internalNote: string | null }>('SELECT "internalNote" FROM "Quote" WHERE id = $1', [confirmed.made.quoteId])
    expect(quote).toEqual({ internalNote: `Customer's note (order request ${number}): ${note} · Wanted by ${wanted}` })
    const quoteLines = await admin<{ colourway: string; pieces: number }>(
      `SELECT c.code AS colourway, l.quantity::int AS pieces FROM "QuoteLine" l JOIN "QuoteVersion" v ON v.id = l."versionId" JOIN "Colourway" c ON c.id = l."colourwayId" WHERE v."quoteId" = $1 ORDER BY l.seq`,
      [confirmed.made.quoteId],
    )
    expect(quoteLines).toEqual([{ colourway: 'BLK', pieces: 2 }])
  })

  it('Confirm with no row is held in words (409); a decided request is refused (409)', async () => {
    const made = await ok('aBuyer', 'POST', '/portal/order-requests', { subject: 'Made-up: to be filled' }, 201)
    const none = await thrown(confirmRequest(office(), made.request.id, { version: made.request.version, as: 'ORDER' }))
    expect(none).toMatchObject({ code: 'conflict', message: 'Add at least one product before it is confirmed.' })
    expect(none.paths).toContain('refusal/CONFIRM_HELD')
    expect(await stored(made.request.id)).toEqual({ status: 'DRAFT', number: null, version: made.request.version })
    // The request WS-OD-12 confirmed: already accepted, in today's words.
    const again = await thrown(confirmRequest(office(), G.confirmed.id, { version: G.confirmed.version, as: 'ORDER' }))
    expect(again).toMatchObject({ code: 'invalid_state', message: decisionProblem('ACCEPTED') })
    expect((await stored(G.confirmed.id)).status).toBe('ACCEPTED')
  })
})
