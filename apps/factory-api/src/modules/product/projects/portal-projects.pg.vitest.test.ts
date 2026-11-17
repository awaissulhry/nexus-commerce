import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate } from '@nexus/factory-domain/core/time'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'
import { useAbuseGuard } from '../../../platform/abuse/guard'
import { usePortalOptions } from '../../../platform/auth/portal/service'
import { freshGuard } from '../../../platform/auth/portal/testing/portal'
import { addUser, Browser, enrolTotp, startHarness, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'
import { inTenant, partnerWorld, signIn, type PartnerWorld, type Person } from '../../../platform/search/partner/testing/world'

/**
 * B-TH-069 (threads plan TH-5, PROJ-G07, PROJ-G09; walls W09, W24, W38; tests T09, T24, T38; the Owner's rule 2026-11-16: "One brand
 * must not be able to see anything related to any other brand. But we, as the production unit, should be able to see it all."): the
 * customer's side of a project — the Project partner view (members only: platform/search/partner/views/project.ts), the portal
 * record route GET /portal/threads/Project/<id> and its posts, the portal search's Projects group, GET /portal/projects, the
 * projects block of GET /portal/samples, and RECORD_INVITE links for a project (ended at close).
 *
 *   brand A (P1)  its portal buyer is a MEMBER of SEED-PRJ-001 (the projects seed adds them): opens it — name, status, the SHARED
 *                 messages only (never an office note, never the goal, the lead or the outcome words) — posts on it, finds it, lists
 *                 it; its viewer, of the same company but never added, gets 404 and no search hit
 *   brand B       (Seed Brand Two, SEED-C2B) gets 404 in neutral words on brand A's project, finds nothing, lists nothing (T09, T38)
 *   a supplier    (P2's order desk) is a member of a supplier's project: the same page in the supplier portal (one outside company
 *                 per project); brand A's project is not there for it, nor its project for brand A
 *   invite links  a RECORD_INVITE link of a project names the project's own outside company (T24 / W24), reads only that project's
 *                 shared messages; a closed project takes no new invitation and closing ended the live ones
 *
 * The base seeds in one namespace (the projects seed included), the search index built by the indexers, real portal sign-ins by
 * e-mail code, an office owner signed in with two-factor. Every name is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/product/projects`.
 */

type Json = Record<string, any>

let h: Harness
let world: PartnerWorld
let owner: Browser
let alpha: Browser
let viewer: Browser
let commentOnly: Browser
let beta: Browser
let supplier: Browser
let brandB = ''
const NS = 'th069pp'
const seeded = { active: '', closed: '' }
const made = { open: '', closed: '', supplier: '', invited: '' }
const numbers = { open: '', closed: '', supplier: '', invited: '' }
let counter = 0
const key = () => `th069-${++counter}-${newId()}`
const GOAL = 'Seed: three touring jackets on one pattern block, proto to salesman samples.'
const NOTE = 'Made-up office note: the lining costs too much, try the second mill.'
const SHARED = 'Made-up to brand A: the proto of the family leaves on Friday.'
const QUIET_OUTCOME = 'Made-up outcome the office keeps: the brand dropped two colours.'

const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const one = async <T = Json>(sql: string, values: unknown[]): Promise<T> => {
  const rows = await admin<T>(sql, values)
  expect(rows.length, sql).toBeGreaterThan(0)
  return rows[0]!
}

/** An office call of the owner (cookie, CSRF and a fresh Idempotency-Key on a write). */
async function office(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown, status = 200): Promise<Json> {
  const answer = await owner.send(method as 'POST', url, method === 'GET' ? undefined : (body ?? {}), { headers: method === 'GET' ? {} : { 'idempotency-key': key() } })
  expect(answer.status, `${method} ${url}: ${JSON.stringify(answer.body)}`).toBe(status)
  return answer.body as Json
}
const thread = (browser: Browser, id: string) => browser.get(`/portal/threads/Project/${id}`)
const post = (browser: Browser, id: string, body: Json) => browser.send('POST', `/portal/threads/Project/${id}/messages`, body, { headers: { 'idempotency-key': key() } })
const search = async (browser: Browser, text: string): Promise<Json> => {
  const answer = await browser.get(`/portal/search?q=${encodeURIComponent(text)}`)
  expect(answer.status, JSON.stringify(answer.body)).toBe(200)
  return answer.body
}
const hits = (answer: Json): Json[] => answer.groups.flatMap((group: Json) => group.results)
const tokenOf = (url: string): string => decodeURIComponent(/#token=(\S+)/.exec(url)![1]!)
async function viaLink(token: string, url: string): Promise<{ status: number; body: Json }> {
  const answer = await h.app.inject({ method: 'GET', url, headers: { 'x-factory-link': token, 'user-agent': 'SeedPhone/1.0' } })
  return { status: answer.statusCode, body: answer.json() as Json }
}
const pathsOf = (body: Json): string[] => (body.error?.issues ?? []).map((issue: Json) => issue.path)
const inDays = (days: number): string => businessDate(new Date(Date.now() + days * 86_400_000))

/** A 404 in neutral words: it never says that the project exists, nor whose it is. */
function neutral404(answer: { status: number; body: Json }, ...names: string[]): void {
  expect(answer.status, JSON.stringify(answer.body)).toBe(404)
  const text = JSON.stringify(answer.body)
  expect(text).toMatch(/not found/i)
  for (const name of names) expect(text).not.toContain(name)
  expect(text).not.toMatch(/another (customer|brand|company)|altro cliente|not (a )?member|were not added/i)
}

beforeAll(async () => {
  h = await startHarness('portal_projects_th069')
  h.clock.set(new Date())
  freshGuard(h)
  world = await partnerWorld(h, NS)
  seeded.active = `00000000${seedUuid(NS, 'projects:PRJ-001').slice(8)}`
  seeded.closed = `ffffffff${seedUuid(NS, 'projects:PRJ-003').slice(8)}`
  // Brand B: the two-brands seed's second customer and brand, its portal buyer (its portal switched on).
  brandB = (await one<{ id: string }>(`SELECT id FROM "Party" WHERE "tenantId" = $1 AND code = 'SEED-C2B'`, [world.tenantId])).id
  const buyerB = await one<{ id: string; email: string; displayName: string }>(`SELECT id, email, "displayName" FROM "User" WHERE "tenantId" = $1 AND "partyId" = $2 AND email LIKE 'buyer.second-brand.%' LIMIT 1`, [world.tenantId, brandB])
  await inTenant(h, world, (client) => client.portalSettings.updateMany({ where: { partyId: brandB }, data: { portalOn: true } }))
  // The office: an owner (every permission, projects.manage and partners.shares.manage among them), two-factor set up.
  const tenant: TestTenant = { id: world.tenantId, slug: world.namespace, companies: [{ id: world.companyA, code: world.companyCode }] }
  const user = await addUser(h, tenant, { email: `olga.owner.${NS}@seed-a.example.com`, role: 'owner' })
  owner = new Browser(h.app)
  expect((await owner.signIn(world.namespace, user.email, user.password)).status).toBe(200)
  await enrolTotp(h, owner)
  alpha = await signIn(h, world, world.people.buyer)
  viewer = await signIn(h, world, world.people.viewer)
  commentOnly = await signIn(h, world, world.people.commentOnly)
  beta = await signIn(h, world, { id: buyerB.id, email: buyerB.email, name: buyerB.displayName } satisfies Person)
  supplier = await signIn(h, world, world.people.orders)
  // The seeded project of brand A: an office note and a message shared with brand A (its portal, no mail).
  await office('POST', `/threads/Project/${seeded.active}/notes`, { body: NOTE }, 201)
  await office('POST', `/threads/Project/${seeded.active}/replies`, { body: SHARED }, 201)
  // A second project of brand A with its buyer as a member, closed with an outcome the office keeps (not told).
  const second = await office('POST', '/projects', { companyId: world.companyA, name: 'Made-up glove liner study', partyId: world.p1, targetDate: inDays(30) }, 201)
  made.closed = second.project.id
  numbers.closed = second.project.number
  await office('POST', `/projects/${made.closed}/people`, { userId: world.people.buyer.id })
  await office('POST', `/projects/${made.closed}/close`, { version: (await office('GET', `/projects/${made.closed}`)).project.version, outcome: 'STOPPED', outcomeNote: QUIET_OUTCOME, tellCustomer: false })
  // A supplier's project (P2) with its order desk as a member.
  const forSupplier = await office('POST', '/projects', { companyId: world.companyA, name: 'Made-up mesh lining trials', partyId: world.p2, targetDate: inDays(40) }, 201)
  made.supplier = forSupplier.project.id
  numbers.supplier = forSupplier.project.number
  await office('POST', `/projects/${made.supplier}/people`, { userId: world.people.orders.id })
}, 900_000)

beforeEach(() => {
  freshGuard(h)
})

afterAll(async () => {
  useAbuseGuard(undefined)
  usePortalOptions({})
  await h?.close()
})

describe('B-TH-069: a member of brand A opens, writes in, finds and lists its project', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('T38: the member opens the project — name, status, the shared messages only; never an office note, the goal, the lead or the outcome', async () => {
    const answer = await thread(alpha, seeded.active)
    expect(answer.status, JSON.stringify(answer.body)).toBe(200)
    expect(answer.body.record).toMatchObject({ type: 'Project', id: seeded.active, theirRef: null, ourRef: 'SEED-PRJ-001', subtitle: 'Seed touring jacket family', status: 'ACTIVE' })
    const bodies = (answer.body.messages as Json[]).map((message) => message.body)
    expect(bodies).toContain(SHARED)
    expect(bodies).not.toContain(NOTE)
    const text = JSON.stringify(answer.body)
    for (const hidden of [NOTE, GOAL, 'leadId', 'outcomeNote', 'goal']) expect(text, hidden).not.toContain(hidden)
  })

  it('posts on its project (portal.comment): an INBOUND message of the project’s own thread, shared with brand A only', async () => {
    const answer = await post(alpha, seeded.active, { body: 'Made-up from brand A: the second jacket needs a longer back.' })
    expect(answer.status, JSON.stringify(answer.body)).toBe(201)
    const [row] = await admin<{ partyId: string | null; direction: string; audience: string }>(
      `SELECT t."partyId", m.direction, m.audience FROM "Message" m JOIN "Thread" t ON t.id = m."threadId" WHERE m.id = $1`,
      [answer.body.message.id],
    )
    expect(row).toEqual({ partyId: world.p1, direction: 'INBOUND', audience: 'PARTNER' })
  })

  it('finds it in the Projects group of the portal search, and lists its projects open first (GET /portal/projects)', async () => {
    const found = hits(await search(alpha, 'SEED-PRJ-001')).find((result) => result.recordType === 'Project')
    expect(found).toMatchObject({ recordId: seeded.active, group: 'projects', ourRef: 'SEED-PRJ-001' })
    const listed = await alpha.get('/portal/projects')
    expect(listed.status, JSON.stringify(listed.body)).toBe(200)
    const ids = (listed.body.projects as Json[]).map((project) => project.id)
    expect(ids).toEqual(expect.arrayContaining([seeded.active, made.closed]))
    expect(ids.indexOf(seeded.active)).toBeLessThan(ids.indexOf(made.closed))
    expect((listed.body.projects as Json[]).find((project) => project.id === made.closed)).toMatchObject({ number: numbers.closed, status: 'CLOSED' })
    // The seeded closed project of brand A (SEED-PRJ-003) has no member: it is not listed to anyone of brand A.
    expect(ids).not.toContain(seeded.closed)
  })

  it('a closed project still opens to its member, the outcome the office kept never in its answer', async () => {
    const answer = await thread(alpha, made.closed)
    expect(answer.status, JSON.stringify(answer.body)).toBe(200)
    expect(answer.body.record).toMatchObject({ ourRef: numbers.closed, status: 'CLOSED' })
    expect(answer.body.thread).toMatchObject({ status: 'CLOSED' })
    expect(JSON.stringify(answer.body)).not.toContain(QUIET_OUTCOME)
  })

  it('the Samples & tech packs page carries its projects; a person who was not added gets none', async () => {
    const page = await alpha.get('/portal/samples')
    expect(page.status, JSON.stringify(page.body)).toBe(200)
    expect((page.body.projects as Json[]).map((project) => project.id)).toEqual(expect.arrayContaining([seeded.active, made.closed]))
    const notAdded = await viewer.get('/portal/samples')
    expect(notAdded.status, JSON.stringify(notAdded.body)).toBe(200)
    expect(notAdded.body.projects).toEqual([])
  })
})

describe('T38 / T09: nobody but the project’s members opens or finds it', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('brand A’s viewer, never added: 404 in neutral words, no search hit, nothing listed', async () => {
    neutral404(await thread(viewer, seeded.active), 'SEED-PRJ-001', 'Seed touring jacket family')
    neutral404(await post(viewer, seeded.active, { body: 'Made-up.' }))
    expect(hits(await search(viewer, 'SEED-PRJ-001')).filter((result) => result.recordType === 'Project')).toEqual([])
    expect((await viewer.get('/portal/projects')).body.projects).toEqual([])
  })

  it('a role without portal.projects.view is refused the projects list', async () => {
    expect((await commentOnly.get('/portal/projects')).status).toBe(403)
    neutral404(await thread(commentOnly, seeded.active))
  })

  it('T09: brand B gets 404 on brand A’s projects and finds none of them', async () => {
    for (const id of [seeded.active, made.closed]) {
      neutral404(await thread(beta, id), 'SEED-PRJ-001', numbers.closed, 'Seed touring jacket family')
      neutral404(await post(beta, id, { body: 'Made-up.' }))
    }
    for (const text of ['SEED-PRJ-001', numbers.closed, 'touring jacket']) {
      const answer = await search(beta, text)
      expect(hits(answer).filter((result) => result.recordType === 'Project'), text).toEqual([])
      expect(JSON.stringify({ ...answer, query: null, words: null }), text).not.toMatch(new RegExp(`${seeded.active}|${made.closed}`))
    }
    const listed = await beta.get('/portal/projects')
    expect(listed.status, JSON.stringify(listed.body)).toBe(200)
    expect(listed.body.projects).toEqual([])
    const conversations = await beta.get('/portal/threads')
    expect(JSON.stringify(conversations.body)).not.toMatch(new RegExp(`${seeded.active}|${made.closed}|SEED-PRJ-001`))
  })

  it('a supplier member reads its own project in the supplier portal; brand A’s is not there for it, nor its project for brand A', async () => {
    const own = await thread(supplier, made.supplier)
    expect(own.status, JSON.stringify(own.body)).toBe(200)
    expect(own.body.record).toMatchObject({ type: 'Project', ourRef: numbers.supplier, subtitle: 'Made-up mesh lining trials' })
    expect(((await supplier.get('/portal/projects')).body.projects as Json[]).map((project) => project.id)).toEqual([made.supplier])
    expect(hits(await search(supplier, numbers.supplier)).find((result) => result.recordId === made.supplier)).toMatchObject({ group: 'projects' })
    neutral404(await thread(supplier, seeded.active), 'SEED-PRJ-001')
    neutral404(await thread(alpha, made.supplier), numbers.supplier, 'Made-up mesh lining trials')
    expect(hits(await search(alpha, numbers.supplier)).filter((result) => result.recordType === 'Project')).toEqual([])
  })
})

describe('T24 / W24: an invitation link to a project names the project’s own outside company and ends at close', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  let token = ''

  it('the office invites a designer of brand A by link: the share and its link carry the project’s party', async () => {
    const created = await office('POST', '/projects', { companyId: world.companyA, name: 'Made-up airbag collar family', partyId: world.p1, targetDate: inDays(50) }, 201)
    made.invited = created.project.id
    numbers.invited = created.project.number
    await office('POST', `/threads/Project/${made.invited}/replies`, { body: 'Made-up to brand A: the collar sketch is attached to the project.' }, 201)
    await office('POST', `/threads/Project/${made.invited}/notes`, { body: NOTE }, 201)
    const invited = await office('POST', '/shares', { recordType: 'Project', recordId: made.invited, email: `dana.designer.${NS}@studio-alpha.example`, permissions: ['COMMENT'], send: false, language: 'en' }, 201)
    expect(invited.url).toEqual(expect.any(String))
    token = tokenOf(invited.url)
    const share = await one<{ partyId: string; linkId: string }>('SELECT "partyId", "linkId" FROM "RecordShare" WHERE id = $1', [invited.share.id])
    expect(share.partyId).toBe(world.p1)
    expect((await one<{ partyId: string; purpose: string }>('SELECT "partyId", purpose::text AS purpose FROM "OneOffLink" WHERE id = $1', [share.linkId]))).toEqual({ partyId: world.p1, purpose: 'RECORD_INVITE' })
  })

  it('the link reads only its own project: its fields and shared messages, never an office note, never another project', async () => {
    const page = await viaLink(token, '/link/share?language=en')
    expect(page.status, JSON.stringify(page.body)).toBe(200)
    expect(page.body.record).toMatchObject({ type: 'Project', reference: expect.stringContaining(numbers.invited) })
    expect((page.body.record.fields as Json[]).map((field) => field.key)).toEqual(['number', 'name', 'status', 'targetDate'])
    const text = JSON.stringify(page.body)
    expect(text).toContain('the collar sketch is attached')
    expect(text).not.toContain(NOTE)
    for (const other of [seeded.active, made.supplier]) {
      const answer = await viaLink(token, `/threads/Project/${other}`)
      if (answer.status === 200) expect(answer.body.messages ?? []).toEqual([])
      else expect([403, 404]).toContain(answer.status)
      expect(JSON.stringify(answer.body)).not.toContain(SHARED)
    }
  })

  it('closing the project ends the live invitation (its link opens nothing); a closed project takes no new one', async () => {
    const before = (await office('GET', `/projects/${made.invited}`)).project
    expect(before.may.manage).toBe(true)
    const closed = await office('POST', `/projects/${made.invited}/close`, { version: before.version, outcome: 'DONE', outcomeNote: 'Made-up: the collar family is approved.', tellCustomer: true })
    expect(closed.project).toMatchObject({ status: 'CLOSED', outcome: 'DONE' })
    const share = await one<{ revokedAt: Date | null }>('SELECT "revokedAt" FROM "RecordShare" WHERE "recordType" = $1 AND "recordId" = $2', ['Project', made.invited])
    expect(share.revokedAt).not.toBeNull()
    expect((await viaLink(token, '/link/share')).status).toBe(404)
    const refused = await owner.send('POST', '/shares', { recordType: 'Project', recordId: made.invited, email: `lia.lab.${NS}@studio-alpha.example`, permissions: [], send: false }, { headers: { 'idempotency-key': key() } })
    expect(refused.status, JSON.stringify(refused.body)).toBe(409)
    expect(pathsOf(refused.body)).toEqual(['held/PROJECT_CLOSED'])
    // Told to the customer: the outcome line reached brand A's thread as a shared message (brand A is no member: the office reads it).
    const messages = await admin<{ bodyText: string; direction: string }>(`SELECT m."bodyText", m.direction FROM "Message" m JOIN "Thread" t ON t.id = m."threadId" WHERE t."recordType" = 'Project' AND t."recordId" = $1 ORDER BY m.at`, [made.invited])
    expect(messages.some((message) => message.direction === 'OUTBOUND' && message.bodyText === 'Made-up: the collar family is approved.')).toBe(true)
  })
})
