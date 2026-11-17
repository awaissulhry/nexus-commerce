import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { businessDate } from '@nexus/factory-domain/core/time'
import type { ErrorReport } from '@nexus/factory-domain/observability/report'
import { addDays } from '@nexus/factory-domain/planning/buy'
import { createErrorTracker, useErrorTracker } from '../../observability/tracker'
import { usePortalOptions } from '../../platform/auth/portal/service'
import { freshGuard, mailedCode, portalBrowser } from '../../platform/auth/portal/testing/portal'
import type { Browser } from '../../platform/auth/sessions/testing/harness'
import { fakeScanner } from '../../platform/files/scan/fake'
import { useScanner } from '../../platform/files/scan/service'
import type { EventHandler } from '../../platform/outbox/dispatch'
import { standardReasonsForNewTenants } from '../../platform/reasons/standard'
import type { SearchIndexer } from '../../platform/search/indexer'
import { indexNewTenants } from '../../platform/search/indexing'
import { everyHandler, searchIndexers, settler } from '../daily/testing/day'
import { addressesOf, asBrand, BRAND_ALPHA, BRAND_BETA, findMarkers, mailText, markersOf, setUpBrand, type BrandInWorld, type Marker, type Seen } from '../portal/testing/two-brands'
import { admin, announce, call, ok, pdf, person, putBytes, QUIET, startWorld, stepped, type Method, type Person, type World } from '../testing/world'
import { DATABASE_FUTURE_MS, oneClock } from '../testing/world'

/**
 * B-TH-074 golden flow TH-5 (T00, T38) — A PROJECT FOR ONE BRAND (threads plan TH-5, B-TH-066 … B-TH-073; §0 the brand wall; Owner
 * rule 2026-11-16: "One brand must not be able to see anything related to any other brand. But we, as the production unit, should be
 * able to see it all. And manage it all as well."). On the golden world (every base seed, the real app and sign-in, every outside
 * provider FAKE) with the worker's handlers run in-process, through the HTTP routes:
 *
 *   S    the sales office makes P1 into Brand Alpha (customer A) and P3 into Brand Beta (customer B), each with its portal buyer; the
 *        buyer opens P2's supplier portal with an order desk
 *   P01  the office makes a project for brand A (numbered PRJ-…), its colleague added (and told "added you"), brand A's private
 *        style linked at once; the project is found in the office search
 *   P02  brand A's sample round linked; brand B's request refused in words that name no customer (W38: linking brand B's record
 *        to brand A's project); "In project" on the round
 *   P03  brand A's portal buyer added as a member; brand B's portal person refused (only the project's outside company)
 *   P04  a file on the project shared with brand A, and an artwork approval asked of brand A on the project (Project is a thread
 *        record type of approvals now): brand A's portal lists the request
 *   P05  an office note and a message to brand A; brand A's member reads the message (never the note) and answers in the portal;
 *        the office reads the answer; the project's linked news for the office and for the member
 *   P06  closed with its outcome, told to the customer: the line reaches brand A's member, the conversation is closed, the project
 *        reads CLOSED
 *   T38  brand B's portal person and the supplier's order desk get 404 or nothing on every door to the project (thread, posts,
 *        projects list, linked news, search, approvals, conversations)
 *   T00  the name scan: nothing brand B (or the supplier) got — answers and mail — holds a name, code, number, file name or id of
 *        brand A or of its project
 *   Z    no route answered 500 during the flow
 *
 * SQL only reads ids and asserts: no step is made by SQL. Every name, address and figure is made up. Run with
 * `node scripts/factory/golden-flow.mjs threads`.
 */

let w: World
let handlers: readonly EventHandler[]
let indexers: readonly SearchIndexer[]
let settle: () => Promise<string[]>
type Json = Record<string, any>
const P = {} as Record<'owner' | 'sales' | 'manager' | 'buyer', Person>
let alpha: BrandInWorld
let beta: BrandInWorld
let desk: { browser: Browser; userId: string }
const seen: Seen[] = []
const unexpected: ErrorReport[] = []
const G = {} as Record<string, any>
const BUYER = { roleKey: 'customer-buyer', capabilities: ['comment'] } as const
const DESK_EMAIL = 'desk.th5@tannery-p2.example'
const PROJECT_NAME = 'Alpha FW27 airbag line (made up)'
const GOAL = 'Made-up goal the office keeps: three airbag jackets on one block, proto to salesman samples.'
const NOTE = 'Made-up office note: the airbag supplier quotes 12 weeks, keep it from the brand.'
const TO_ALPHA = 'Made-up to Brand Alpha: the first proto of the airbag line leaves on Friday.'
const FROM_ALPHA = 'Made-up from Brand Alpha: please keep the yellow piping on all three jackets.'
const OUTCOME = 'Made-up outcome: the airbag line is approved, three styles to production in March.'
const QUESTION = 'Made-up: please approve the airbag label artwork.'
const FILE_NAME = 'Alpha airbag line sketch AX-300.pdf'
const id = (key: string) => w.id(key)
const companyA = () => id('company:A')
const P1 = () => id('party:P1')
const P2 = () => id('party:P2')
const P3 = () => id('party:P3')
const today = () => businessDate(new Date())
const A = (method: Method, url: string, body?: unknown, status: number | null = 200) => asBrand(alpha, seen, method, url, body, status)
const B = (method: Method, url: string, body?: unknown, status: number | null = 200) => asBrand(beta, seen, method, url, body, status)
/** The supplier's order desk: every answer kept for the scan, as the brands'. */
async function S(method: Method, url: string, body?: unknown, status: number | null = 200): Promise<any> {
  const answer = await call(desk.browser, method, url, body)
  seen.push({ who: 'supplier portal', method, url, status: answer.status, body: answer.body })
  if (status !== null) expect(answer.status, `supplier ${method} ${url}: ${JSON.stringify(answer.body)}`).toBe(status)
  return answer.body
}
const refusalOf = (answer: Json): string[] => (answer.error?.issues ?? []).map((issue: Json) => issue.path)

function clockWithinDatabase(): void {
  const ahead = w.h.clock.now().getTime() - Date.now()
  expect(ahead, `the harness clock runs ${Math.round(ahead / 1000)} s ahead of the database's`).toBeLessThan(DATABASE_FUTURE_MS)
}

/** P2's supplier portal, opened by the buyer, with its order desk invited (supplier-orders), signed in by code, first visit done. */
async function setUpDesk(): Promise<{ browser: Browser; userId: string }> {
  const tab = await ok(P.buyer, 'GET', `/partners/${P2()}`)
  await stepped(w, P.buyer)
  await ok(P.buyer, 'POST', `/partners/${P2()}/settings`, { portalOn: true, version: tab.settings?.version ?? 0 })
  await stepped(w, P.buyer)
  await ok(P.buyer, 'POST', `/partners/${P2()}/people`, { email: DESK_EMAIL, displayName: 'Marta Desk', locale: 'en', kind: 'SUPPLIER', roleKey: 'supplier-orders', capabilities: ['comment'], companyId: companyA() })
  const browser = await portalBrowser(w.h, '203.0.113.150')
  expect((await call(browser, 'POST', '/portal/signin/start', { tenant: w.tenant.slug, company: 'SCA', email: DESK_EMAIL })).status).toBe(200)
  await w.h.auth.settled()
  const signedIn = await call(browser, 'POST', '/portal/signin/code', { tenant: w.tenant.slug, company: 'SCA', email: DESK_EMAIL, code: mailedCode(w.h, DESK_EMAIL)!.code })
  expect(signedIn.status, JSON.stringify(signedIn.body)).toBe(200)
  const terms = (await call(browser, 'GET', '/portal/terms?locale=en')).body
  expect((await call(browser, 'POST', '/portal/first-visit', { noticeId: terms.notice.id, noticeLocale: terms.notice.locale, sha256: terms.notice.sha256 })).status).toBe(200)
  const me = (await call(browser, 'GET', '/portal/me')).body
  expect(me).toMatchObject({ termsDue: false, party: { id: P2() } })
  return { browser, userId: me.user.id }
}

beforeAll(async () => {
  useErrorTracker(createErrorTracker({ sink: { kind: 'fake', send: (report) => void unexpected.push(report) }, source: 'api' }))
  w = await startWorld()
  w.h.clock.set(new Date())
  oneClock(w)
  freshGuard(w.h)
  usePortalOptions({ answerFloorMs: 0 })
  useScanner(fakeScanner())
  indexers = await searchIndexers()
  handlers = everyHandler(indexers)
  settle = settler(w, handlers)
  P.owner = await person(w, 'owner', 'owner')
  P.sales = await person(w, 'sales', 'sales')
  P.manager = await person(w, 'manager', 'production_manager')
  P.buyer = await person(w, 'buyer', 'buyer')
}, 1_200_000)

afterAll(async () => {
  useScanner(undefined)
  usePortalOptions({})
  useErrorTracker(undefined)
  await w?.close()
}, 60_000)

describe('B-TH-074 golden flow TH-5 (T00, T38): a project for brand A, its people and records, behind the brand wall', { timeout: 300_000 }, () => {
  it('S00 the world: the seeds drain; the search index is built', async () => {
    await standardReasonsForNewTenants({ database: w.h.database, log: QUIET })
    await indexNewTenants({ database: w.h.database, indexers, log: QUIET })
    await settle()
  })

  it('S01 Brand Alpha (P1) and Brand Beta (P3) with their portal buyers; P2’s supplier portal with an order desk', async () => {
    alpha = await setUpBrand(w, P.sales, BRAND_ALPHA, P1(), companyA(), BUYER)
    beta = await setUpBrand(w, P.sales, BRAND_BETA, P3(), companyA(), BUYER)
    desk = await setUpDesk()
    G.style = (await admin<{ id: string }>(w, `SELECT id FROM "Style" WHERE "tenantId" = $1 AND code = 'SEED-JKT-01' AND "brandPartyId" = $2`, [w.tenant.id, P1()]))[0]!.id
    G.round = (await admin<{ id: string }>(w, `SELECT id FROM "SampleRound" WHERE "tenantId" = $1 AND number = 'SEED-SR-0001' AND "partyId" = $2`, [w.tenant.id, P1()]))[0]!.id
    G.betaRequest = (await admin<{ id: string }>(w, `SELECT id FROM "Inquiry" WHERE "tenantId" = $1 AND "partyId" = $2 ORDER BY number LIMIT 1`, [w.tenant.id, P3()]))[0]?.id
    await settle()
    clockWithinDatabase()
  }, 900_000)

  it('P01 the office makes a project for brand A: numbered, its colleague added and told, brand A’s style linked at once', async () => {
    const made = await ok(
      P.owner,
      'POST',
      '/projects',
      { companyId: companyA(), name: PROJECT_NAME, partyId: P1(), targetDate: addDays(today(), 60), goal: GOAL, colleagueIds: [P.sales.id], links: [{ recordType: 'Style', recordId: G.style, note: 'Made-up: the base jacket of the line.' }] },
      201,
    )
    expect(made.project).toMatchObject({ name: PROJECT_NAME, status: 'ACTIVE', party: { id: P1() }, lead: { id: P.owner.id }, officeOnly: false, may: { manage: true } })
    expect(made.project.number).toMatch(/^PRJ-\d{2}-\d{3}$/)
    G.project = made.project
    expect((await admin<Json>(w, 'SELECT "partyId", "companyId", status::text AS status FROM "Project" WHERE id = $1', [G.project.id]))[0]).toEqual({ partyId: P1(), companyId: companyA(), status: 'ACTIVE' })
    await settle()
    // END CHECK (fix wave 3c): the colleague follows the project, so the style link's note reaches them too (FOLLOWING, newest):
    // the ASSIGNMENT is looked up by its own key, not as the project's first item.
    const told = ((await ok(P.sales, 'GET', '/notifications')).items as Json[]).find((item) => item.record.id === G.project.id && item.messageKey === 'notifications.projects.addedYou')
    expect(told).toMatchObject({ category: 'ASSIGNMENT', messageKey: 'notifications.projects.addedYou', actor: { id: P.owner.id } })
    const page = await ok(P.owner, 'GET', `/projects/${G.project.id}`)
    expect(page.people.office.people.find((entry: Json) => entry.userId === P.sales.id)).toMatchObject({ reason: 'ADDED', addedBy: { id: P.owner.id } })
    expect(page.links.records.map((entry: Json) => [entry.recordType, entry.recordId])).toEqual([['Style', G.style]])
    const found = await ok(P.sales, 'GET', `/search?q=${encodeURIComponent(G.project.number)}`)
    expect(JSON.stringify(found)).toContain(G.project.id)
  })

  it('P02 brand A’s sample round linked; brand B’s request refused in words that name no customer (W38); "In project" on the round', async () => {
    const linked = await ok(P.owner, 'POST', `/projects/${G.project.id}/links`, { recordType: 'SampleRound', recordId: G.round })
    expect(linked.links.records.map((entry: Json) => entry.recordType)).toEqual(['Style', 'SampleRound'])
    if (G.betaRequest) {
      const refused = await ok(P.owner, 'POST', `/projects/${G.project.id}/links`, { recordType: 'Inquiry', recordId: G.betaRequest }, 409)
      expect(refusalOf(refused)).toEqual(['body/recordId'])
      expect(JSON.stringify(refused)).not.toMatch(/Brand Beta|BRAND-BETA/)
      expect(await admin(w, 'SELECT id FROM "ProjectLink" WHERE "projectId" = $1 AND "recordId" = $2', [G.project.id, G.betaRequest])).toEqual([])
    }
    const chip = await ok(P.owner, 'GET', `/projects/of/SampleRound/${G.round}`)
    expect(chip.projects.map((entry: Json) => entry.id)).toContain(G.project.id)
    await settle()
  })

  it('P03 brand A’s portal buyer is added as a member; brand B’s portal person is refused', async () => {
    const added = await ok(P.owner, 'POST', `/projects/${G.project.id}/people`, { userId: alpha.userId })
    expect(added.people.outside.people.map((entry: Json) => entry.userId)).toEqual([alpha.userId])
    const refused = await ok(P.owner, 'POST', `/projects/${G.project.id}/people`, { userId: beta.userId }, 409)
    expect(refusalOf(refused)).toEqual(['body/userId'])
    expect(JSON.stringify(refused)).not.toMatch(/Brand Beta|BRAND-BETA/)
    await settle()
  })

  it('P04 a file shared with brand A on the project, and an artwork approval asked of brand A on the project', async () => {
    const body = pdf(FILE_NAME)
    const announced = await ok(P.owner, 'POST', '/files', { recordType: 'Project', recordId: G.project.id, companyId: companyA(), kind: 'DOCUMENT', ...announce(FILE_NAME, body), visibility: ['OFFICE', 'PARTNER'] }, 201)
    await putBytes(w, announced, body)
    expect((await ok(P.owner, 'POST', `/files/${announced.file.id}/complete`)).file.status).toBe('AVAILABLE')
    G.file = announced.file.id
    const asked = await ok(P.owner, 'POST', '/approvals-out', { kind: 'ARTWORK', recordType: 'Project', recordId: G.project.id, email: BRAND_ALPHA.contact.email, question: QUESTION, fileIds: [G.file], send: false, language: 'en' }, 201)
    expect(asked.request).toMatchObject({ kind: 'ARTWORK', status: 'OPEN' })
    G.approval = asked.request
    await settle()
    const open = (await A('GET', '/portal/approvals?state=OPEN')).items as Json[]
    expect(open.map((item) => item.id)).toContain(G.approval.id)
  })

  it('P05 an office note and a message to brand A: the member reads the message, never the note, and answers; the office reads the answer', async () => {
    await ok(P.owner, 'POST', `/threads/Project/${G.project.id}/notes`, { body: NOTE }, 201)
    await ok(P.owner, 'POST', `/threads/Project/${G.project.id}/replies`, { body: TO_ALPHA }, 201)
    await settle()
    const read = await A('GET', `/portal/threads/Project/${G.project.id}`)
    // TH-5 follow-up (B-TH-303's rule): the member reads it by its name and target date, never by the office's PRJ number.
    expect(read.record).toMatchObject({ type: 'Project', id: G.project.id, ourRef: null, subtitle: PROJECT_NAME, status: 'ACTIVE', date: `${G.project.targetDate as string}T00:00:00.000Z` })
    expect(JSON.stringify(read)).not.toContain(G.project.number as string)
    const bodies = (read.messages as Json[]).map((message) => message.body)
    expect(bodies).toContain(TO_ALPHA)
    expect(JSON.stringify(read)).not.toContain(NOTE)
    expect(JSON.stringify(read)).not.toContain(GOAL)
    const answered = await A('POST', `/portal/threads/Project/${G.project.id}/messages`, { body: FROM_ALPHA }, 201)
    G.answer = answered.message.id
    await settle()
    const office = await ok(P.owner, 'GET', `/threads/Project/${G.project.id}`)
    expect(JSON.stringify(office)).toContain(FROM_ALPHA)
    // Its portal projects and its linked news (only the records brand A opens itself).
    expect(((await A('GET', '/portal/projects')).projects as Json[]).map((entry) => entry.id)).toContain(G.project.id)
    const news = await A('GET', `/portal/projects/${G.project.id}/news`)
    for (const entry of news.entries as Json[]) expect([G.style, G.round]).toContain(entry.recordId)
    const timeline = await ok(P.owner, 'GET', `/threads/Project/${G.project.id}/timeline?kinds=linked`)
    for (const entry of timeline.entries as Json[]) expect(entry).toMatchObject({ kind: 'linked' })
  })

  it('P06 closed with its outcome, told to the customer: the member reads the line, the conversation is closed', async () => {
    const page = await ok(P.owner, 'GET', `/projects/${G.project.id}`)
    const closed = await ok(P.owner, 'POST', `/projects/${G.project.id}/close`, { version: page.project.version, outcome: 'DONE', outcomeNote: OUTCOME, tellCustomer: true })
    expect(closed.project).toMatchObject({ status: 'CLOSED', outcome: 'DONE', outcomeNote: OUTCOME, threadStatus: 'CLOSED' })
    await settle()
    const read = await A('GET', `/portal/threads/Project/${G.project.id}`)
    expect(read.record).toMatchObject({ status: 'CLOSED' })
    expect(read.thread).toMatchObject({ status: 'CLOSED' })
    expect((read.messages as Json[]).map((message) => message.body)).toContain(OUTCOME)
    await A('POST', `/portal/threads/Project/${G.project.id}/messages`, { body: 'Made-up: one more thing.' }, 409)
    // A closed project changes nothing but its reopening.
    const refused = await ok(P.owner, 'POST', `/projects/${G.project.id}/links`, { recordType: 'Style', recordId: G.style }, 409)
    expect(refusalOf(refused)).toEqual(['refusal/CLOSED'])
  })

  it('T38 brand B and the supplier get 404 or nothing on every door to brand A’s project', async () => {
    for (const ask of [B, S]) {
      await ask('GET', `/portal/threads/Project/${G.project.id}`, undefined, 404)
      await ask('POST', `/portal/threads/Project/${G.project.id}/messages`, { body: 'Made-up.' }, 404)
      await ask('GET', `/portal/projects/${G.project.id}/news`, undefined, 404)
      expect((await ask('GET', '/portal/projects')).projects).toEqual([])
      for (const q of [G.project.number, PROJECT_NAME, 'airbag']) {
        const found = await ask('GET', `/portal/search?q=${encodeURIComponent(q)}`)
        expect(JSON.stringify({ ...found, query: null, words: null })).not.toContain(G.project.id)
      }
      expect(JSON.stringify(await ask('GET', '/portal/threads'))).not.toContain(G.project.id)
      await ask('GET', `/files?recordType=Project&recordId=${G.project.id}`, undefined, null)
    }
    expect(JSON.stringify(await B('GET', '/portal/approvals?state=OPEN'))).not.toContain(G.approval.id)
    await B('GET', '/portal/notifications')
    await S('GET', '/portal/notifications')
  })

  it('T00 the name scan: nothing brand B or the supplier got (answers and mail) holds a name, number, file or id of brand A or its project', async () => {
    const markers: Marker[] = [
      ...(await markersOf(w, BRAND_ALPHA, P1())),
      { label: 'project number', text: G.project.number as string },
      { label: 'project id', text: G.project.id as string },
      { label: 'project name', text: PROJECT_NAME },
      { label: 'project goal', text: GOAL },
      { label: 'office note', text: NOTE },
      { label: 'message to Alpha', text: TO_ALPHA },
      { label: 'message from Alpha', text: FROM_ALPHA },
      { label: 'outcome', text: OUTCOME },
      { label: 'approval question', text: QUESTION },
      { label: 'approval id', text: G.approval.id as string },
      { label: 'project file', text: FILE_NAME },
      { label: 'round id', text: G.round as string },
    ]
    // A search answer repeats what was typed (B and the supplier typed A's project number and name on purpose): its echo is left out.
    const bodyOf = (entry: Seen) => (entry.url.startsWith('/portal/search') && entry.body && typeof entry.body === 'object' ? { ...(entry.body as Json), query: null, words: null } : entry.body)
    const outsiders = seen.filter((entry) => entry.who.startsWith('beta') || entry.who.startsWith('supplier'))
    const leaks = outsiders.flatMap((entry) => findMarkers(bodyOf(entry), markers).map((found) => `${entry.who} ${entry.method} ${entry.url} (${entry.status}): ${found}`))
    expect(leaks).toEqual([])
    const addresses = new Set([...(await addressesOf(w, beta)), DESK_EMAIL])
    const mails = w.h.ses.mails.filter((mail) => [...mail.to, ...mail.cc, ...mail.bcc].some((address) => addresses.has(address.toLowerCase())))
    expect(mails.flatMap((mail) => findMarkers(mailText(mail.raw), markers).map((found) => `${mail.templateKey}: ${found}`))).toEqual([])
    expect(outsiders.length).toBeGreaterThan(15)
  })

  it('Z no route answered 500 during the flow', async () => {
    await settle()
    expect(unexpected.map((report) => `${report.context.method} ${report.context.route}: ${report.name}: ${report.message} ${report.stack.slice(0, 3).join(' | ')}`)).toEqual([])
  })
})
