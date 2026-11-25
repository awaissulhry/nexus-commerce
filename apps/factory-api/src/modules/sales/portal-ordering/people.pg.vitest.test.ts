import { createHash } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FactoryDatabase } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Permission } from '@nexus/factory-domain/core/permissions'
import { PEOPLE_WORDS } from '@nexus/factory-domain/sales/portal-ordering/people'
import { MTM_CLOSED_WORDS } from '@nexus/factory-domain/sales/portal-ordering/rules'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { callerFor } from '../../../core/command'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'
import { useAbuseGuard } from '../../../platform/abuse/guard'
import { usePortalOptions } from '../../../platform/auth/portal/service'
import { freshGuard, mailedCode, portalBrowser } from '../../../platform/auth/portal/testing/portal'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { addUser, Browser, enrolTotp, startHarness, type Answer, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'
import { rosterRecords } from '../../../platform/privacy/erasure/sources/records'
import type { PersonFacts } from '../../../platform/privacy/erasure/sources/type'
import { acceptRequest, confirmRequest, listOfficeRequests, officeRequestView } from './office'

/**
 * B-CP-075 (customer page plan C5; 12 §2 parts 1 and 4; review A5, F1, F2; walls W-CP-1, W-CP-3; money M-CP-2) on the local stack,
 * through the real app and the real portal sign-in by code, every factory-db seed: customer A = SEED-C1 (P1) with a buyer and a
 * Designer (both may upload); customer B = SEED-C2 (P3) with its buyer.
 *
 *   - a described line (its words, colours, its own style, a total) and a made-to-measure line (an ACTIVE garment type, by person)
 *     join a draft; the answer shows every kind (`customLines`), the parts sent later and who saved it (a name, never an id);
 *   - the roster is written at the draft's version: people added (a pasted roster), changed, removed — rows keep their place; a
 *     stale version is a 409 that names the colleague who saved it meanwhile;
 *   - a made-to-measure line whose people are in a measurement sheet on it sends ("People: in the attached sheet"); a person names a
 *     sheet of this very draft only (another draft's, a logo, another customer's: not found, W-CP-3); a sheet taken out puts its
 *     people back to "sending later";
 *   - made to measure switched off for the customer: no new made-to-measure line, an existing one holds the send in its words;
 *   - a line taken out takes its roster; a discarded draft takes all of its people;
 *   - the office reads the roster, the parts sent later and who saved it; a sheet is named only with sales.measurements.view; an
 *     accept stays held while a described or made-to-measure line is not mapped (B-CP-077: accept-kinds.pg maps it);
 *   - W-CP-1: customer B adds, changes, removes or reads nobody of A's; M-CP-2: the Designer's answers carry no price;
 *   - the party's privacy export lists the roster names (the erasure keeps them: CUSTOMER), never another customer's.
 * od-ts (order start; 13-backend § 7 WS-OD-7; addendum R1, R3): an office person (a Sales worker of the ready-made roles, signed in
 * through the app) adds people to the customer's draft through the office's route — read by the office, never by the floor (no
 * grant), never named in a line note after the Confirm; a draft with nothing at all sends; every relaxed row saves; the Sizing cell
 * moves a row's kind (custom size ⇔ made to measure) and a row's choices are checked and cleared.
 * Every name and figure is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/sales/portal-ordering/people`.
 */

type Json = Record<string, any>
const SEED_DIR = fileURLToPath(new URL('../../../../../../packages/factory-db/seed', import.meta.url))
const NS = 'people-cp075'
const T = seedUuid(NS, 'tenant')
const partyA = seedUuid(NS, 'party:P1')
const partyB = seedUuid(NS, 'party:P3')
const companyA = seedUuid(NS, 'company:A')
const TENANT: TestTenant = { id: T, slug: NS, companies: [{ id: companyA, code: 'SCA' }] }
const PRICE_KEYS = /"(unitPriceShown|priceNow|amount|net|brandUnitPrice|priceDiff|priceMatch)":"/

let h: Harness
const people = {
  aBuyer: 'anna.buyer.cp075@brand-alpha.example',
  aDesigner: 'dora.designer.cp075@brand-alpha.example',
  bBuyer: 'bruna.buyer.cp075@brand-beta.example',
}
const names = { aBuyer: 'Made-up Anna Buyer', aDesigner: 'Made-up Dora Designer', bBuyer: 'Made-up Bruna Buyer' }
type Who = keyof typeof people
const ids = {} as Record<Who, string>
const browsers = {} as Record<Who, Browser>
const ADA = newId()
const officeWith = (permissions: string[]) => callerFor(h.database, { audience: 'office', tenantId: T, actorId: ADA, requestId: newId(), grants: [{ permissions: permissions as Permission[], companies: 'all', sites: 'all', parties: 'all' }] })
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
let serial = 0
const call = (who: Who, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown): Promise<Answer> =>
  browsers[who].send(method as 'POST', url, method === 'GET' || method === 'DELETE' ? undefined : (body ?? {}), method === 'GET' ? {} : { headers: { 'idempotency-key': `cp075-key-${++serial}` } })
async function ok(who: Who, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown, status = 200): Promise<Json> {
  const answer = await call(who, method, url, body)
  expect(answer.status, `${who} ${method} ${url}: ${JSON.stringify(answer.body)}`).toBe(status)
  return answer.body as Json
}
const issuesOf = (answer: Answer): Json[] => answer.body?.error?.issues ?? []
// od-ts: a Sales worker of the ready-made roles (orders.manage, no price grain), signed in through the app: the office's draft routes.
let officeBrowser: Browser
let officeUserId = ''
async function asOffice(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown, status = 200): Promise<Json> {
  const answer = await officeBrowser.send(method, url, method === 'GET' || method === 'DELETE' ? undefined : (body ?? {}), method === 'GET' ? {} : { headers: { 'idempotency-key': `cp075-key-${++serial}` } })
  expect(answer.status, `office ${method} ${url}: ${JSON.stringify(answer.body)}`).toBe(status)
  return answer.body as Json
}
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
const pdf = (text: string): Buffer => Buffer.from(`%PDF-1.4\n% made-up file of the CP-075 test: ${text}\n%%EOF\n`)
const png = (text: string): Buffer => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`made-up picture: ${text}`)])
const base = (id: string) => `/portal/order-requests/${id}`
const customOf = (record: Json, lineId: string): Json => record.request.customLines.find((line: Json) => line.id === lineId)

/** Announce, PUT the bytes to the local store's presigned URL, confirm: the file as the draft reads it. */
async function upload(who: Who, requestId: string, part: string, name: string, contentType: string, bytes: Buffer, lineId?: string): Promise<Json> {
  const announced = await ok(who, 'POST', `${base(requestId)}/files`, { part, originalName: name, contentType, sizeBytes: bytes.length, sha256: sha(bytes), ...(lineId ? { lineId } : {}) }, 201)
  const put = await h.app.inject({ method: 'PUT', url: announced.upload.url, headers: announced.upload.headers, payload: bytes })
  expect(put.statusCode, put.body).toBeLessThan(300)
  return (await ok(who, 'POST', `${base(requestId)}/files/${announced.file.id}/complete`)).file
}

async function partnerPerson(email: string, displayName: string, partyId: string, roleKeys: string[]): Promise<string> {
  const id = newId()
  await h.database.withScope({ audience: 'office', tenantId: T, actorId: newId() }, async (client) => {
    await client.user.create({ data: { id, email, displayName, locale: 'en', status: 'ACTIVE', audience: 'PARTNER', partyId, partnerKind: 'CUSTOMER' }, select: { id: true } })
    for (const key of roleKeys) {
      const role = await client.role.findUniqueOrThrow({ where: { tenantId_key: { tenantId: T, key } }, select: { id: true } })
      await client.roleAssignment.create({ data: { id: newId(), userId: id, roleId: role.id, allCompanies: true, partyIds: [partyId], validFrom: new Date(h.clock.now().getTime() - 60_000) }, select: { id: true } })
    }
  })
  return id
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

/** A new draft of customer A with a made-to-measure line (JACKET): the draft's id, the line, the draft's version. */
async function mtmDraft(who: Who = 'aBuyer'): Promise<{ id: string; lineId: string; version: number }> {
  const made = await ok(who, 'POST', '/portal/order-requests', {}, 201)
  const filled = await ok(who, 'POST', `${base(made.request.id)}/custom-lines`, { version: made.request.version, line: { kind: 'MADE_TO_MEASURE', garmentType: 'JACKET', description: 'Made-up team suit, white and red' } })
  return { id: made.request.id, lineId: filled.request.customLines[0].id, version: filled.request.version }
}

beforeAll(async () => {
  h = await startHarness('people_cp075')
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
    await client.user.create({ data: { id: ADA, email: 'ada.office.cp075@example.com', displayName: 'Made-up Ada', locale: 'en', status: 'ACTIVE' }, select: { id: true } })
  })
  await admin('UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE "tenantId" = $1', [T])
  freshGuard(h)
  ids.aBuyer = await partnerPerson(people.aBuyer, names.aBuyer, partyA, ['customer-buyer', 'partner-comment', 'partner-upload'])
  ids.aDesigner = await partnerPerson(people.aDesigner, names.aDesigner, partyA, ['customer-designer', 'partner-comment', 'partner-upload'])
  ids.bBuyer = await partnerPerson(people.bBuyer, names.bBuyer, partyB, ['customer-buyer', 'partner-comment', 'partner-upload'])
  for (const who of Object.keys(people) as Who[]) browsers[who] = await signedIn(people[who])
  // Customer A's own label (SEED-JKT-02) and one of its colours.
  G.style = (await admin<{ id: string }>(`SELECT id FROM "Style" WHERE "tenantId" = $1 AND code = 'SEED-JKT-02'`, [T]))[0]!.id
  G.colour = (await admin<{ id: string }>(`SELECT id FROM "Colourway" WHERE "tenantId" = $1 AND "styleId" = $2 AND code = 'BLK'`, [T, G.style]))[0]!.id
  // od-ts: the office person of WS-OD-7 (signed in before the clock is set back: the sign-in moves it on).
  const officeUser = await addUser(h, TENANT, { email: 'sam.sales.cp075@example.com', role: 'sales' })
  officeUserId = officeUser.id
  officeBrowser = new Browser(h.app)
  expect((await officeBrowser.signIn(NS, officeUser.email, officeUser.password)).status).toBe(200)
  await enrolTotp(h, officeBrowser)
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

describe('B-CP-075: every kind of draft line and the people on it', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('a described line and a made-to-measure line join a draft; the answer shows every kind, the parts sent later and who saved it', async () => {
    const made = await ok('aDesigner', 'POST', '/portal/order-requests', {}, 201)
    const id = made.request.id as string
    expect(made.request).toMatchObject({ customLines: [], laterParts: [], lastEditedBy: names.aDesigner, madeToMeasure: { open: true, words: null } })
    expect(made.request.madeToMeasure.garmentTypes.map((type: Json) => type.code)).toEqual(expect.arrayContaining(['JACKET', 'TROUSERS']))
    const described = await ok('aDesigner', 'POST', `${base(id)}/custom-lines`, {
      version: made.request.version,
      line: { kind: 'DESCRIBED', description: 'Made-up team jackets with our logo on the back', colourText: 'Navy with a white zip', styleId: G.style, quantity: 40 },
    })
    const tailored = await ok('aDesigner', 'POST', `${base(id)}/custom-lines`, { version: described.request.version, line: { kind: 'MADE_TO_MEASURE', garmentType: 'JACKET' } })
    const [first, second] = tailored.request.customLines
    expect(first).toMatchObject({ seq: 1, kind: 'DESCRIBED', quantity: 40, pieces: 40, byPerson: false, style: { id: G.style, code: 'SEED-JKT-02' }, colourText: 'Navy with a white zip', problems: [] })
    expect(second).toMatchObject({ seq: 2, kind: 'MADE_TO_MEASURE', garmentType: { code: 'JACKET' }, byPerson: true, pieces: 0, people: [], peopleInSheet: false })
    // What holds the send is named per part: no one is named on the made-to-measure line yet (People).
    expect(second.problems).toEqual([expect.objectContaining({ code: 'NO_PEOPLE', part: 'PEOPLE', lineId: second.id })])
    expect(tailored.request.problems.map((entry: Json) => entry.code)).toEqual(['NO_PEOPLE'])
    expect(tailored.request.lines).toEqual([])
    expect(tailored.request.summary).toMatchObject({ lines: 2, pieces: 40 })
    // The parts the customer sends later: the header's PATCH (DRAFT only); the buyer saves it now and is named.
    const later = await ok('aBuyer', 'PATCH', base(id), { version: tailored.request.version, laterParts: ['LOGOS', 'PEOPLE'] })
    expect(later.request).toMatchObject({ laterParts: ['LOGOS', 'PEOPLE'], lastEditedBy: names.aBuyer, lastEditedAt: expect.any(String) })
    expect(JSON.stringify(later.request.lastEditedBy)).not.toMatch(/@|[0-9a-f]{8}-[0-9a-f]{4}/)
    const twice = await call('aBuyer', 'PATCH', base(id), { version: later.request.version, laterParts: ['LOGOS', 'LOGOS'] })
    expect(twice.status).toBe(400)
    // Refused in words before anything is written: no catalogue style, no garment type we make, a total on a made-to-measure line.
    for (const [line, path] of [
      [{ kind: 'DESCRIBED', description: 'Made-up', styleId: newId() }, 'body/line/styleId'],
      [{ kind: 'MADE_TO_MEASURE', garmentType: 'NOPE' }, 'body/line/garmentType'],
      [{ kind: 'MADE_TO_MEASURE', garmentType: 'JACKET', quantity: 3 }, 'body/line'],
      [{ kind: 'DESCRIBED', description: ' ' }, 'body/line'],
    ] as const) {
      const refused = await call('aBuyer', 'POST', `${base(id)}/custom-lines`, { version: later.request.version, line })
      expect(refused.status, JSON.stringify(line)).toBe(400)
      expect(issuesOf(refused).map((issue) => issue.path)).toContain(path)
    }
    // A catalogue line's editor is not the custom line's, and the other way round.
    expect((await call('aBuyer', 'PUT', `${base(id)}/lines/${first.id}`, { version: later.request.version, note: 'Made-up' })).status).toBe(409)
    Object.assign(G, { mixed: id, described: first.id, tailored: second.id, version: later.request.version })
  })

  it('the roster is written at the draft’s version: added, changed, removed (rows keep their place); a stale version names the colleague', async () => {
    const added = await ok('aBuyer', 'POST', `${base(G.mixed)}/lines/${G.tailored}/people`, {
      version: G.version,
      people: [
        { name: 'Made-up Mario Rossi', number: '46', measureBy: 'SIZE', size: '52' },
        { name: 'Made-up Luca Neri', measureBy: 'LATER' },
        { name: 'Made-up Sara Blu', number: '7', measureBy: 'SIZE', size: '48' },
      ],
    })
    const roster = customOf(added, G.tailored).people
    expect(roster.map((person: Json) => [person.seq, person.name, person.measureBy, person.size])).toEqual([
      [1, 'Made-up Mario Rossi', 'SIZE', '52'],
      [2, 'Made-up Luca Neri', 'LATER', null],
      [3, 'Made-up Sara Blu', 'SIZE', '48'],
    ])
    expect(customOf(added, G.tailored)).toMatchObject({ pieces: 3, problems: [] })
    const changed = await ok('aDesigner', 'PUT', `${base(G.mixed)}/lines/${G.tailored}/people/${roster[1].id}`, { version: added.request.version, measureBy: 'SIZE', size: '50' })
    expect(customOf(changed, G.tailored).people[1]).toMatchObject({ id: roster[1].id, seq: 2, measureBy: 'SIZE', size: '50', version: 2 })
    expect(changed.request.lastEditedBy).toBe(names.aDesigner)
    // The buyer still holds the version before the Designer's change: 409, naming who saved it meanwhile (A's own person).
    const stale = await call('aBuyer', 'DELETE', `${base(G.mixed)}/lines/${G.tailored}/people/${roster[0].id}?version=${added.request.version}`)
    expect(stale.status).toBe(409)
    expect(stale.body.error.message).toBe(`${names.aDesigner} changed this draft since you read it (now version ${changed.request.version}): read it again.`)
    expect(issuesOf(stale)).toEqual(expect.arrayContaining([{ path: 'lastEditedBy', message: names.aDesigner }]))
    const removed = await ok('aBuyer', 'DELETE', `${base(G.mixed)}/lines/${G.tailored}/people/${roster[0].id}?version=${changed.request.version}`)
    expect(customOf(removed, G.tailored).people.map((person: Json) => person.seq)).toEqual([2, 3])
    // Shapes and places refused in words: a described line that is not by person, a size missing, too many at once.
    const notByPerson = await call('aBuyer', 'POST', `${base(G.mixed)}/lines/${G.described}/people`, { version: removed.request.version, people: [{ name: 'Made-up', measureBy: 'LATER' }] })
    expect(notByPerson.status).toBe(409)
    expect(issuesOf(notByPerson)).toEqual([{ path: 'refusal/NOT_BY_PERSON', message: PEOPLE_WORDS.NOT_BY_PERSON.en }])
    expect((await call('aBuyer', 'POST', `${base(G.mixed)}/lines/${G.tailored}/people`, { version: removed.request.version, people: [{ name: 'Made-up', measureBy: 'SIZE' }] })).status).toBe(400)
    const many = Array.from({ length: 499 }, (_, index) => ({ name: `Made-up rider ${index + 1}`, measureBy: 'LATER' }))
    const tooMany = await call('aBuyer', 'POST', `${base(G.mixed)}/lines/${G.tailored}/people`, { version: removed.request.version, people: many })
    expect(tooMany.status).toBe(409)
    expect(issuesOf(tooMany)).toEqual([{ path: 'refusal/TOO_MANY', message: PEOPLE_WORDS.TOO_MANY.en }])
    // A person's size outside the style's range is a problem of the People part, never a refusal of the write.
    const ownStyle = await ok('aBuyer', 'PUT', `${base(G.mixed)}/custom-lines/${G.tailored}`, { version: removed.request.version, styleId: G.style })
    expect(customOf(ownStyle, G.tailored).style).toMatchObject({ id: G.style })
    G.version = ownStyle.request.version
    G.roster = customOf(ownStyle, G.tailored).people
  })

  it('a made-to-measure line whose people are in a sheet on it sends ("People: in the attached sheet"); a person names a sheet of this draft only', async () => {
    const draft = await mtmDraft()
    const sheet = await upload('aBuyer', draft.id, 'SHEET', 'made-up-team-measures.pdf', 'application/pdf', pdf('team measures'), draft.lineId)
    const logo = await upload('aBuyer', draft.id, 'LOGO', 'made-up-team-logo.png', 'image/png', png('team logo'))
    const read = await ok('aBuyer', 'GET', base(draft.id))
    expect(customOf(read, draft.lineId)).toMatchObject({ people: [], peopleInSheet: true, problems: [] })
    // W-CP-3: a person names a measurement sheet of this very draft — not a logo, not another draft's, not another customer's.
    const other = await mtmDraft()
    const otherSheet = await upload('aBuyer', other.id, 'SHEET', 'made-up-other-measures.pdf', 'application/pdf', pdf('other measures'), other.lineId)
    for (const fileId of [logo.id, otherSheet.id, newId()]) {
      const refused = await call('aBuyer', 'POST', `${base(draft.id)}/lines/${draft.lineId}/people`, { version: read.request.version, people: [{ name: 'Made-up Rider', measureBy: 'SHEET', measurementFileId: fileId }] })
      expect(refused.status, fileId).toBe(404)
    }
    const named = await ok('aBuyer', 'POST', `${base(draft.id)}/lines/${draft.lineId}/people`, { version: read.request.version, people: [{ name: 'Made-up Rider', measureBy: 'SHEET', measurementFileId: sheet.id }] })
    expect(customOf(named, draft.lineId).people[0]).toMatchObject({ measureBy: 'SHEET', sheet: { id: sheet.id, originalName: 'made-up-team-measures.pdf', locked: false } })
    // The other draft's sheet taken out: nobody there named it; this draft's sheet taken out puts its person back to "sending later".
    const withoutSheet = await ok('aBuyer', 'DELETE', `${base(draft.id)}/files/${sheet.id}?version=${sheet.version}`)
    expect(customOf(withoutSheet, draft.lineId).people[0]).toMatchObject({ measureBy: 'LATER', sheet: null })
    const again = await upload('aBuyer', draft.id, 'SHEET', 'made-up-team-measures-2.pdf', 'application/pdf', pdf('team measures 2'), draft.lineId)
    const current = await ok('aBuyer', 'GET', base(draft.id))
    const gone = await ok('aBuyer', 'DELETE', `${base(draft.id)}/lines/${draft.lineId}/people/${customOf(current, draft.lineId).people[0].id}?version=${current.request.version}`)
    expect(customOf(gone, draft.lineId)).toMatchObject({ people: [], peopleInSheet: true })
    // Sent with the sheet alone (the database's rule too); the event counts one piece (at least one person).
    const sent = await ok('aBuyer', 'POST', `${base(draft.id)}/send`, { version: gone.request.version })
    expect(sent.request).toMatchObject({ status: 'SENT', number: expect.any(String), madeToMeasure: null })
    const [event] = await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'portal_order_request.sent' AND subject = $2`, [T, draft.id])
    expect(event!.payload).toMatchObject({ lines: 1, pieces: 1 })
    expect(again.status).toBe('AVAILABLE')
    G.sent = { id: draft.id, version: sent.request.version, sheet: again.id }
  })

  it('made to measure switched off for the customer: no new made-to-measure line; an existing one holds the send in its words', async () => {
    await admin('UPDATE "PortalSettings" SET "mtmDraftsOn" = false WHERE id = $1', [partyA])
    try {
      const made = await ok('aBuyer', 'POST', '/portal/order-requests', {}, 201)
      expect(made.request.madeToMeasure).toMatchObject({ open: false, words: MTM_CLOSED_WORDS, garmentTypes: [] })
      const refused = await call('aBuyer', 'POST', `${base(made.request.id)}/custom-lines`, { version: made.request.version, line: { kind: 'MADE_TO_MEASURE', garmentType: 'JACKET' } })
      expect(refused.status).toBe(409)
      expect(issuesOf(refused)).toEqual([{ path: 'refusal/MTM_CLOSED', message: MTM_CLOSED_WORDS.en }])
      // A described line is still made (drafts only: the switch is about made to measure).
      expect((await ok('aBuyer', 'POST', `${base(made.request.id)}/custom-lines`, { version: made.request.version, line: { kind: 'DESCRIBED', description: 'Made-up caps', quantity: 20 } })).request.customLines).toHaveLength(1)
      const mixed = await ok('aBuyer', 'GET', base(G.mixed))
      expect(customOf(mixed, G.tailored).problems.map((entry: Json) => entry.code)).toContain('MTM_CLOSED')
      expect((await call('aBuyer', 'POST', `${base(G.mixed)}/send`, { version: mixed.request.version })).status).toBe(409)
      expect((await call('aBuyer', 'POST', `${base(G.mixed)}/lines/${G.tailored}/people`, { version: mixed.request.version, people: [{ name: 'Made-up', measureBy: 'LATER' }] })).status).toBe(409)
    } finally {
      await admin('UPDATE "PortalSettings" SET "mtmDraftsOn" = true WHERE id = $1', [partyA])
    }
  })

  it('the office reads the roster, the parts sent later and who saved it; a sheet is named only with sales.measurements.view; accept stays held', async () => {
    const noSheets = officeWith(['orders.view', 'threads.read', 'files.read'])
    const row = (await listOfficeRequests(noSheets, { status: 'DRAFT', partyId: partyA })).requests.find((entry) => entry.id === G.mixed)!
    expect(row.draft).toMatchObject({ people: 2, later: ['LOGOS', 'PEOPLE'], lastEditedBy: names.aBuyer })
    expect(row.draft).not.toHaveProperty('readiness') // od-fx3: the parts sent later are `later` above (the checklist went)
    expect(row.pieces).toBe(42)
    const view = await officeRequestView(noSheets, G.mixed)
    expect(view.request.customLines.map((line) => [line.seq, line.kind])).toEqual([[1, 'DESCRIBED'], [2, 'MADE_TO_MEASURE']])
    expect(view.request.customLines[1]!.people.map((person) => person.name)).toEqual(['Made-up Luca Neri', 'Made-up Sara Blu'])
    // A sent request with a person measured by a sheet: locked and nameless without sales.measurements.view, named with it.
    const sentDraft = await mtmDraft()
    const sheet = await upload('aBuyer', sentDraft.id, 'SHEET', 'made-up-office-measures.pdf', 'application/pdf', pdf('office measures'), sentDraft.lineId)
    const read = await ok('aBuyer', 'GET', base(sentDraft.id))
    const named = await ok('aBuyer', 'POST', `${base(sentDraft.id)}/lines/${sentDraft.lineId}/people`, { version: read.request.version, people: [{ name: 'Made-up Rider', measureBy: 'SHEET', measurementFileId: sheet.id }] })
    const sent = await ok('aBuyer', 'POST', `${base(sentDraft.id)}/send`, { version: named.request.version })
    const locked = await officeRequestView(noSheets, sentDraft.id)
    expect(locked.request.customLines[0]!.people[0]!.sheet).toEqual({ id: sheet.id, originalName: null, locked: true })
    expect(JSON.stringify(locked)).not.toContain('made-up-office-measures.pdf')
    const open = await officeRequestView(officeWith(['orders.view', 'threads.read', 'files.read', 'sales.measurements.view']), sentDraft.id)
    expect(open.request.customLines[0]!.people[0]!.sheet).toEqual({ id: sheet.id, originalName: 'made-up-office-measures.pdf', locked: false })
    // Accept stays held while a described or made-to-measure line is not mapped (B-CP-077: map it first); a made-to-measure line is
    // never an order while made-to-measure has not started (a quote first). accept-kinds.pg holds the rest.
    const decider = officeWith(['orders.view', 'orders.manage', 'quotes.manage', 'money.price'])
    await expect(acceptRequest(decider, sentDraft.id, { version: sent.request.version, as: 'QUOTE' })).rejects.toThrow(/described or made to measure/)
    await expect(acceptRequest(decider, sentDraft.id, { version: sent.request.version, as: 'ORDER' })).rejects.toThrow(/made to measure: accept the request as a quote/)
  })

  it('WS-OD-7 office-written people are read by the office, never by the floor; names never in a line note', async () => {
    // The customer's draft with a made-to-measure row (by person); the office adds its people through the office's route.
    const draft = await mtmDraft()
    const added = await asOffice('POST', `/sales/order-requests/${draft.id}/lines/${draft.lineId}/people`, {
      version: draft.version,
      people: [
        { name: 'Made-up Bea Esempio', number: '12', measureBy: 'SIZE', size: '50' },
        { name: 'Made-up Carlo Esempio', measureBy: 'SIZE', size: '52' },
      ],
    })
    expect(customOf(added, draft.lineId).people.map((person: Json) => person.name)).toEqual(['Made-up Bea Esempio', 'Made-up Carlo Esempio'])
    // The office reads them on its draft page (the portal's own record); the rows say the office person typed them.
    const read = await asOffice('GET', `/sales/order-requests/${draft.id}/draft`)
    expect(customOf(read, draft.lineId).people.map((person: Json) => [person.seq, person.name, person.measureBy, person.size])).toEqual([
      [1, 'Made-up Bea Esempio', 'SIZE', '50'],
      [2, 'Made-up Carlo Esempio', 'SIZE', '52'],
    ])
    expect(await admin('SELECT name, "createdById" FROM "PortalOrderRequestPerson" WHERE "lineId" = $1 ORDER BY seq', [draft.lineId])).toEqual([
      { name: 'Made-up Bea Esempio', createdById: officeUserId },
      { name: 'Made-up Carlo Esempio', createdById: officeUserId },
    ])
    // The floor has no grant on the people of a draft (the database refuses the read).
    const floor = { audience: 'floor' as const, tenantId: T, actorId: newId(), siteId: seedUuid(NS, 'site:A1') }
    await expect(h.database.withScope(floor, (client) => client.$queryRawUnsafe('SELECT name FROM "PortalOrderRequestPerson" WHERE "requestId" = $1::uuid', draft.id))).rejects.toThrow(/permission denied/)
    // Confirmed as a QUOTE (send + accept in one command): the quote line says how many people, never who.
    const decider = officeWith(['orders.view', 'orders.manage', 'quotes.view', 'quotes.manage', 'money.price', 'files.read', 'threads.read'])
    const confirmed = await confirmRequest(decider, draft.id, { version: read.request.version, as: 'QUOTE', map: [{ lineId: draft.lineId, into: [{ styleId: G.style, colourwayId: G.colour }] }] })
    expect(confirmed.request).toMatchObject({ status: 'ACCEPTED', quote: { id: confirmed.made.quoteId } })
    const quoteLines = await admin<{ note: string | null; pieces: number }>(
      `SELECT l.note, l.quantity::int AS pieces FROM "QuoteLine" l JOIN "QuoteVersion" v ON v.id = l."versionId" WHERE v."quoteId" = $1 ORDER BY l.seq`,
      [confirmed.made.quoteId],
    )
    expect(quoteLines.map((line) => line.pieces)).toEqual([2])
    expect(quoteLines[0]!.note).toContain('People: 2 on the request (their names stay there)')
    const quote = await admin('SELECT "internalNote" FROM "Quote" WHERE id = $1', [confirmed.made.quoteId])
    expect(JSON.stringify([quoteLines, quote, confirmed.made])).not.toMatch(/Esempio/)
    // The roster stays on the request, which the quote links: the office reads it there.
    const after = await officeRequestView(decider, draft.id)
    expect(after.request.customLines[0]!.people.map((person) => person.name)).toEqual(['Made-up Bea Esempio', 'Made-up Carlo Esempio'])
  })

  it('a line taken out takes its roster; a discarded draft takes all of its people (personal data)', async () => {
    const draft = await mtmDraft()
    const read = await ok('aBuyer', 'GET', base(draft.id))
    const added = await ok('aBuyer', 'POST', `${base(draft.id)}/lines/${draft.lineId}/people`, { version: read.request.version, people: [{ name: 'Made-up One', measureBy: 'LATER' }, { name: 'Made-up Two', measureBy: 'SIZE', size: '50' }] })
    const second = await ok('aBuyer', 'POST', `${base(draft.id)}/custom-lines`, { version: added.request.version, line: { kind: 'MADE_TO_MEASURE', garmentType: 'TROUSERS' } })
    const secondLine = second.request.customLines.find((line: Json) => line.id !== draft.lineId).id as string
    const both = await ok('aBuyer', 'POST', `${base(draft.id)}/lines/${secondLine}/people`, { version: second.request.version, people: [{ name: 'Made-up Three', measureBy: 'LATER' }] })
    const count = async () => (await admin<{ n: number }>('SELECT count(*)::int AS n FROM "PortalOrderRequestPerson" WHERE "requestId" = $1', [draft.id]))[0]!.n
    expect(await count()).toBe(3)
    const out = await ok('aBuyer', 'DELETE', `${base(draft.id)}/lines/${draft.lineId}?version=${both.request.version}`)
    expect(await count()).toBe(1)
    expect(await ok('aBuyer', 'DELETE', `${base(draft.id)}?version=${out.request.version}`)).toEqual({ discarded: true })
    expect(await count()).toBe(0)
  })

  it('W-CP-1 / M-CP-2: customer B adds, changes, removes or reads nobody of A’s; the Designer’s answers carry no price', async () => {
    const person = G.roster[0]
    expect((await call('bBuyer', 'GET', base(G.mixed))).status).toBe(404)
    expect((await call('bBuyer', 'POST', `${base(G.mixed)}/lines/${G.tailored}/people`, { version: G.version, people: [{ name: 'Made-up', measureBy: 'LATER' }] })).status).toBe(404)
    expect((await call('bBuyer', 'PUT', `${base(G.mixed)}/lines/${G.tailored}/people/${person.id}`, { version: G.version, name: 'Made-up' })).status).toBe(404)
    expect((await call('bBuyer', 'DELETE', `${base(G.mixed)}/lines/${G.tailored}/people/${person.id}?version=${G.version}`)).status).toBe(404)
    expect((await call('bBuyer', 'PUT', `${base(G.mixed)}/custom-lines/${G.tailored}`, { version: G.version, description: 'Made-up' })).status).toBe(404)
    // B's own draft: A's line is not B's to name.
    const theirs = await ok('bBuyer', 'POST', '/portal/order-requests', {}, 201)
    expect((await call('bBuyer', 'POST', `${base(theirs.request.id)}/lines/${G.tailored}/people`, { version: theirs.request.version, people: [{ name: 'Made-up', measureBy: 'LATER' }] })).status).toBe(404)
    expect(await admin('SELECT id FROM "PortalOrderRequestPerson" WHERE "partyId" = $1', [partyB])).toEqual([])
    // M-CP-2: no price field reaches the Designer (the price grain filter), whatever the kinds on the draft.
    expect(JSON.stringify((await ok('aDesigner', 'GET', base(G.mixed))).request)).not.toMatch(PRICE_KEYS)
  })

  it('the party’s privacy export lists the roster names and the erasure keeps them (CUSTOMER); another customer’s never', async () => {
    const facts = (partyId: string, name: string): PersonFacts => ({ kind: 'CONTACT', recordType: 'Contact', recordId: newId(), name, erased: false, companyId: null, email: null, partyId, partyIsPerson: false, employeeId: null, workerIds: [], userId: null, blocked: null })
    await h.database.withScope({ audience: 'office', tenantId: T, actorId: ADA }, async (client) => {
      const collected = await rosterRecords.collect(client, facts(partyA, 'made-up sara blu'))
      expect(collected.sections).toEqual([expect.objectContaining({ key: 'orderRequestPeople', rows: [expect.objectContaining({ name: 'Made-up Sara Blu', measureBy: 'SIZE', requestStatus: 'DRAFT' })] })])
      const planned = await rosterRecords.plan(client, facts(partyA, 'Made-up Sara Blu'), h.clock.now())
      expect(planned).toEqual([expect.objectContaining({ recordType: 'PortalOrderRequestPerson', method: 'KEPT', why: 'CUSTOMER', keptFields: ['name', 'number', 'note'] })])
      // The brand wall: the same name in customer B finds nothing of A's.
      expect((await rosterRecords.collect(client, facts(partyB, 'Made-up Sara Blu'))).sections).toEqual([])
    })
  })
})

// ---- od-ts (order start; addendum R1 and R3, the Owner's change of 2026-11-25 10:12): nothing is required, one products table -------
describe('od-ts: nothing is required to send; every cell of a product row is optional; the Sizing cell moves the row’s kind', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('R1: Send with nothing at all', async () => {
    const made = await ok('aBuyer', 'POST', '/portal/order-requests', {}, 201)
    const id = made.request.id as string
    expect(made.request).toMatchObject({ status: 'DRAFT', subject: null, note: null, lines: [], customLines: [], may: { send: true } })
    // Still open names only the draft's own items (no row): information, never a hold.
    expect(made.request.stillOpen.items.map((item: Json) => item.kind)).toEqual(['DATE', 'SHIP_TO'])
    const sent = await ok('aBuyer', 'POST', `${base(id)}/send`, { version: made.request.version })
    expect(sent.request).toMatchObject({ status: 'SENT', number: expect.any(String), lines: [], customLines: [] })
    expect(sent.sent).toMatchObject({ number: sent.request.number, confirmBy: null })
    expect(await admin('SELECT id FROM "PortalOrderRequestLine" WHERE "requestId" = $1', [id])).toEqual([])
    expect((await admin<{ status: string; number: string | null }>('SELECT status::text AS status, number FROM "PortalOrderRequest" WHERE id = $1', [id]))[0]).toEqual({ status: 'SENT', number: sent.request.number })
    const [event] = await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'portal_order_request.sent' AND subject = $2`, [T, id])
    expect(event!.payload).toMatchObject({ requestId: id, partyId: partyA, lines: 0 })
  })

  it('R3: a relaxed row of each kind saves — an empty row (described, sizing not decided), a custom-size row (made to measure), a catalogue row (standard)', async () => {
    const made = await ok('aBuyer', 'POST', '/portal/order-requests', {}, 201)
    const id = made.request.id as string
    // No kind, nothing in it: a described row whose Sizing is "Not decided yet".
    const blank = await ok('aBuyer', 'POST', `${base(id)}/custom-lines`, { version: made.request.version, line: {} })
    const blankId = blank.request.customLines[0].id as string
    expect(customOf(blank, blankId)).toMatchObject({ seq: 1, kind: 'DESCRIBED', sizing: null, description: null, colourText: null, style: null, colourway: null, garmentType: null, quantity: null, sizes: [], byPerson: false, choices: null })
    // Custom size and nothing else (no garment type yet): made to measure, always by person.
    const custom = await ok('aBuyer', 'POST', `${base(id)}/custom-lines`, { version: blank.request.version, line: { sizing: 'MADE_TO_MEASURE' } })
    const customId = custom.request.customLines.find((line: Json) => line.id !== blankId).id as string
    expect(customOf(custom, customId)).toMatchObject({ seq: 2, kind: 'MADE_TO_MEASURE', sizing: 'MADE_TO_MEASURE', garmentType: null, quantity: null, byPerson: true, people: [] })
    // A catalogue row from the picker: standard sizes.
    const picked = await ok('aBuyer', 'POST', `${base(id)}/lines`, { version: custom.request.version, lines: [{ styleId: G.style, colourwayId: G.colour, sizes: [{ size: '50', quantity: 2 }] }] })
    expect(picked.request.lines).toEqual([expect.objectContaining({ seq: 3, kind: 'CATALOGUE', sizing: 'STANDARD', choices: null, style: expect.objectContaining({ id: G.style }) })])
    expect(await admin('SELECT seq, kind::text AS kind, sizing::text AS sizing FROM "PortalOrderRequestLine" WHERE "requestId" = $1 ORDER BY seq', [id])).toEqual([
      { seq: 1, kind: 'DESCRIBED', sizing: null },
      { seq: 2, kind: 'MADE_TO_MEASURE', sizing: 'MADE_TO_MEASURE' },
      { seq: 3, kind: 'CATALOGUE', sizing: 'STANDARD' },
    ])
  })

  it('R3: sizing ⇔ kind — custom size makes a row made to measure and back; a catalogue row turns custom size; disagreeing words refused; choices checked, [] clears', async () => {
    const made = await ok('aBuyer', 'POST', '/portal/order-requests', {}, 201)
    const id = made.request.id as string
    const described = await ok('aBuyer', 'POST', `${base(id)}/custom-lines`, { version: made.request.version, line: { description: 'Made-up caps with our logo', quantity: 6 } })
    const lineId = described.request.customLines[0].id as string
    expect(customOf(described, lineId)).toMatchObject({ kind: 'DESCRIBED', sizing: null, quantity: 6, byPerson: false })
    // Custom size: made to measure in one update — by person, its total gone (its people will carry the sizes).
    const custom = await ok('aBuyer', 'PUT', `${base(id)}/custom-lines/${lineId}`, { version: described.request.version, sizing: 'MADE_TO_MEASURE', garmentType: 'JACKET' })
    expect(customOf(custom, lineId)).toMatchObject({ kind: 'MADE_TO_MEASURE', sizing: 'MADE_TO_MEASURE', byPerson: true, quantity: null, garmentType: { code: 'JACKET' }, description: 'Made-up caps with our logo' })
    // Back to standard sizes: a described row again, its garment type gone.
    const standard = await ok('aBuyer', 'PUT', `${base(id)}/custom-lines/${lineId}`, { version: custom.request.version, sizing: 'STANDARD' })
    expect(customOf(standard, lineId)).toMatchObject({ kind: 'DESCRIBED', sizing: 'STANDARD', garmentType: null })
    expect((await admin('SELECT kind::text AS kind, sizing::text AS sizing, "garmentType" FROM "PortalOrderRequestLine" WHERE id = $1', [lineId]))[0]).toEqual({ kind: 'DESCRIBED', sizing: 'STANDARD', garmentType: null })
    // A catalogue row whose Sizing turns to custom size: made to measure (its style and colour kept as the hint), its sizes gone.
    const picked = await ok('aBuyer', 'POST', `${base(id)}/lines`, { version: standard.request.version, lines: [{ styleId: G.style, colourwayId: G.colour, sizes: [{ size: '50', quantity: 2 }, { size: '52', quantity: 1 }] }] })
    const catalogueId = picked.request.lines[0].id as string
    const turned = await ok('aBuyer', 'PUT', `${base(id)}/lines/${catalogueId}`, { version: picked.request.version, sizing: 'MADE_TO_MEASURE' })
    expect(turned.request.lines).toEqual([])
    expect(customOf(turned, catalogueId)).toMatchObject({ kind: 'MADE_TO_MEASURE', sizing: 'MADE_TO_MEASURE', byPerson: true, quantity: null, sizes: [], style: { id: G.style }, colourway: { id: G.colour } })
    expect(await admin('SELECT size FROM "PortalOrderRequestSize" WHERE "lineId" = $1', [catalogueId])).toEqual([])
    // A described kind with a custom size in one body: refused in words (400), nothing written.
    const disagree = await call('aBuyer', 'POST', `${base(id)}/custom-lines`, { version: turned.request.version, line: { kind: 'DESCRIBED', sizing: 'MADE_TO_MEASURE' } })
    expect(disagree.status).toBe(400)
    expect(disagree.body.error.message).toBe('A custom-size row is made to measure.')
    expect(issuesOf(disagree)).toEqual([{ path: 'body/line/kind', message: 'A custom-size row is made to measure.' }])
    expect((await ok('aBuyer', 'GET', base(id))).request.version).toBe(turned.request.version)
    // The row's open choices: written, then [] clears them (none: null); a pick that is not one of the options is refused (400).
    const leather = [{ topic: 'Leather', options: ['Cowhide', 'Kangaroo'], picked: null }]
    const chosen = await ok('aBuyer', 'PUT', `${base(id)}/custom-lines/${lineId}`, { version: turned.request.version, choices: leather })
    expect(customOf(chosen, lineId).choices).toEqual(leather)
    const cleared = await ok('aBuyer', 'PUT', `${base(id)}/custom-lines/${lineId}`, { version: chosen.request.version, choices: [] })
    expect(customOf(cleared, lineId).choices).toBeNull()
    expect((await admin('SELECT choices FROM "PortalOrderRequestLine" WHERE id = $1', [lineId]))[0]).toEqual({ choices: null })
    const wrong = await call('aBuyer', 'PUT', `${base(id)}/custom-lines/${lineId}`, { version: cleared.request.version, choices: [{ topic: 'Leather', options: ['Cowhide', 'Kangaroo'], picked: 'Suede' }] })
    expect(wrong.status).toBe(400)
    expect(issuesOf(wrong)).toEqual([{ path: 'body/choices/0/picked', message: 'The pick is one of the options, or "Not decided yet".' }])
  })
})
