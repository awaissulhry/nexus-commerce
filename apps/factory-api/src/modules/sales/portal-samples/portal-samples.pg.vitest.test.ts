import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedFiles } from '../../../../../../packages/factory-db/seed/files'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedSamples, type SamplesSeed } from '../../../../../../packages/factory-db/seed/samples'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { usePortalOptions } from '../../../platform/auth/portal/service'
import { freshGuard, mailedCode, portalBrowser, portalWorld } from '../../../platform/auth/portal/testing/portal'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { addUser, Browser, enrolTotp, startHarness, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'
import { callerFor } from '../../../core/command'
import { storeGeneratedFile } from '../../../platform/files/files'
import { systemContext } from '../../../platform/outbox/system'
import { TECH_PACK_OPEN_ACTION } from './download'

/**
 * The brand's samples and tech packs in the portal (B-W2b-262; PRD-245; design portal.customer.samples, SCR-225) through the
 * app's real routes, the real portal sign-in by code and real office sign-ins (the system roles synced to their templates),
 * on a throwaway PostgreSQL 17 database from the migrations (row-level security and the partner role's grants are real).
 * Seeds: the file store (FAKE), the samples (SEED-SR-0001 a FIT round of SEED-JKT-01 for the brand P1, SEED-SR-0003 a PRE_PRODUCTION round of
 * SEED-JKT-02 for P1 under review with an OPEN request, two internal rounds; SEED-JKT-01 and -02 are P1's private labels).
 * The office makes the tech pack copies through B-W2b-230's route (a BRAND copy for P1, an internal and a workshop copy);
 * P1's buyer reads, opens and decides in the portal (the portal answer path of B-W2b-184 + B-W2b-252's settle, end to
 * end); P1's viewer reads but may not decide; P1's finance person has no samples page; another brand (Brand Alpha) sees none of P1's.
 * Every name and number is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/sales/portal-samples`.
 */

vi.setConfig({ testTimeout: 90_000 })

type Json = Record<string, any>
const NS = 'w2b262-portal-samples'
const idOf = (key: string): string => seedUuid(NS, key)
const tenant = idOf('tenant')
const companyA = idOf('company:A')
const P1 = idOf('party:P1')
const people = {
  buyer: 'bruna.buyer@customer-p1.example',
  viewer: 'vito.viewer@customer-p1.example',
  finance: 'fulvia.finance@customer-p1.example',
  other: 'otto.buyer@brand-alpha.example',
  manager: 'pia.pm@seed-a.example.com',
  sales: 'sandro.sales@seed-a.example.com',
}

let h: Harness
let samples: SamplesSeed
let manager: Browser
let sales: Browser
/** The request the office asks for the pre-production round (the seeded one withdrawn first). */
let asked = ''
let buyer: Browser
let viewer: Browser
let finance: Browser
let other: Browser
let buyerId = ''
/** A second brand: portalWorld's made-up customer (Brand Alpha). */
let otherBrand = ''
let jacket1 = ''
let rev1 = ''
const copies = { brand: '', internal: '', workshop: '' }
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex')

const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const one = async <T = Json>(sql: string, values: unknown[] = []): Promise<T> => (await admin<T>(sql, values))[0]!
let counter = 0
const key = (label = 'k'): string => `w2b262-${label}-${++counter}-${newId()}`

async function as(browser: Browser, method: 'GET' | 'POST', url: string, body?: unknown, status = 200): Promise<Json> {
  const answer = await browser.send(method as never, url, method === 'GET' ? undefined : (body ?? {}), { headers: method === 'GET' ? {} : { 'idempotency-key': key() } })
  expect(answer.status, `${method} ${url}: ${JSON.stringify(answer.body)}`).toBe(status)
  return answer.body as Json
}

async function partnerPerson(email: string, partyId: string, roleKeys: string[]): Promise<string> {
  const id = newId()
  await h.database.withScope({ audience: 'office', tenantId: tenant, actorId: newId() }, async (client) => {
    await client.user.create({ data: { id, email, displayName: email.split('@')[0]!.replace('.', ' '), locale: 'en', status: 'ACTIVE', audience: 'PARTNER', partyId, partnerKind: 'CUSTOMER' }, select: { id: true } })
    for (const roleKey of roleKeys) {
      const role = await client.role.findUniqueOrThrow({ where: { tenantId_key: { tenantId: tenant, key: roleKey } }, select: { id: true } })
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

async function officeBrowser(seedTenant: TestTenant, email: string, role: string): Promise<Browser> {
  const user = await addUser(h, seedTenant, { email, role })
  const browser = new Browser(h.app)
  expect((await browser.signIn(NS, user.email, user.password)).status).toBe(200)
  await enrolTotp(h, browser)
  return browser
}

/** Every key of an answer, deep. */
const keysOf = (value: unknown): string[] => (Array.isArray(value) ? value.flatMap(keysOf) : value && typeof value === 'object' ? Object.entries(value).flatMap(([name, item]) => [name, ...keysOf(item)]) : [])
const FORBIDDEN = /cost|charge|price|amount|margin|instruction|decidedBy|createdBy|note|cells/i

beforeAll(async () => {
  h = await startHarness('portal_samples')
  h.clock.set(new Date())
  usePortalOptions({ answerFloorMs: 0 })
  await seedCore({ db: h.database, namespace: NS })
  await seedFiles({ db: h.database, namespace: NS })
  await seedNumbering({ db: h.database, namespace: NS })
  samples = await seedSamples({ db: h.database, namespace: NS })
  const actorId = newId()
  await h.database.withScope({ audience: 'office', tenantId: tenant, actorId }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId }))
  await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE "tenantId" = $1`, [tenant])
  const ses = newId()
  await admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'SES', 'ses-ps', 'Mail', 'FAKE', 6000, 1000)`, [ses, tenant])
  for (const kind of ['CONVERSATION', 'NOTIFICATION']) {
    await admin(
      `INSERT INTO "EmailIdentity" (id, "tenantId", "companyId", kind, domain, "fromAddress", "displayName", "displayNamePolicy", "replyDomain", "accountId", "verificationStatus", "dkimStatus", "isDefault")
       SELECT $1, $2, $3, $4::"EmailIdentityKind", 'mail.seed-a.example.com', $5, 'Seed A', 'COMPANY', 'reply.seed-a.example.com', $6, 'SUCCESS', 'SUCCESS', true
       WHERE NOT EXISTS (SELECT 1 FROM "EmailIdentity" WHERE "tenantId" = $2 AND "companyId" = $3 AND kind = $4::"EmailIdentityKind" AND "isDefault")`,
      [newId(), tenant, companyA, kind, kind === 'CONVERSATION' ? 'vendite@mail.seed-a.example.com' : 'avvisi@mail.seed-a.example.com', ses],
    )
  }
  const seedTenant: TestTenant = { id: tenant, slug: NS, companies: [{ id: companyA, code: 'SCA' }] }
  otherBrand = (await portalWorld(h, seedTenant)).partyId
  await h.database.withScope({ audience: 'office', tenantId: tenant, actorId }, async (client) => {
    const settings = await client.portalSettings.findFirst({ where: { partyId: P1 }, select: { id: true } })
    if (settings) await client.portalSettings.update({ where: { id: settings.id }, data: { portalOn: true }, select: { id: true } })
    else await client.portalSettings.create({ data: { id: P1, partyId: P1, portalOn: true }, select: { id: true } })
  })
  buyerId = await partnerPerson(people.buyer, P1, ['customer-buyer', 'partner-approve'])
  await partnerPerson(people.viewer, P1, ['customer-viewer'])
  await partnerPerson(people.finance, P1, ['customer-finance'])
  await partnerPerson(people.other, otherBrand, ['customer-buyer', 'partner-approve'])
  manager = await officeBrowser(seedTenant, people.manager, 'production_manager')
  sales = await officeBrowser(seedTenant, people.sales, 'sales')
  jacket1 = (await one('SELECT id FROM "Style" WHERE "tenantId" = $1 AND code = $2', [tenant, 'SEED-JKT-01'])).id
  rev1 = (await one('SELECT id FROM "StyleRevision" WHERE "styleId" = $1 AND revision = 1', [jacket1])).id
  // The office's copies of SEED-JKT-01 revision 1 (B-W2b-230's route): the brand's, an internal one and a workshop one.
  const make = async (body: Json) => (await as(manager, 'POST', `/product/styles/${jacket1}/revisions/${rev1}/tech-pack/pdf`, { language: 'en', companyId: companyA, ...body }, 201)).pdf.version.id as string
  copies.brand = await make({ audience: 'BRAND', partyId: P1, sections: ['COVER', 'BOM', 'SIZE_SPEC'] })
  copies.internal = await make({ audience: 'INTERNAL', sections: ['COVER', 'BOM'] })
  copies.workshop = await make({ audience: 'SUBCONTRACTOR', sections: ['COVER', 'BOM'] })
  // The office asks the brand to decide the pre-production round (B-W2b-252's adapter): the seeded request withdrawn, a
  // photo of the sample, a new request with its partner task.
  const seeded = await as(sales, 'GET', `/approvals-out/${samples.approvalRequestId}`)
  await as(sales, 'POST', `/approvals-out/${samples.approvalRequestId}/withdraw`, { version: seeded.request.version, reason: 'Made-up: new photos.' })
  const photo = (await storeGeneratedFile(h.files, callerFor(h.database, systemContext(tenant, newId())), { companyId: companyA, recordType: 'SampleRound', recordId: samples.roundIds.pp, kind: 'PHOTO', originalName: 'Made-up pre-production front.png', contentType: 'image/png', body: PNG })).id
  asked = (await as(sales, 'POST', '/approvals-out', { kind: 'SAMPLE', recordType: 'SampleRound', recordId: samples.roundIds.pp, question: 'Approve the pre-production sample.', fileIds: [photo], send: false }, 201)).request.id
  freshGuard(h)
  buyer = await signedIn(people.buyer)
  viewer = await signedIn(people.viewer)
  finance = await signedIn(people.finance)
  other = await signedIn(people.other)
}, 900_000)

afterAll(async () => {
  await h?.close()
}, 60_000)

describe('the brand reads its samples page (SCR-225)', () => {
  it('lists what waits for its decision, its own styles in development with their BRAND tech pack, and its rounds — no money, no office person', async () => {
    const page = await as(buyer, 'GET', '/portal/samples')
    expect(page.mayApprove).toBe(true)
    // Waiting: the seeded pre-production round's request (and the seeded request on the style itself), overdue first.
    const pp = (page.waiting as Json[]).find((row) => row.recordType === 'SampleRound')
    expect(pp).toMatchObject({ requestId: asked, kind: 'SAMPLE', round: { id: samples.roundIds.pp, kind: 'PRE_PRODUCTION', roundNo: 1 }, style: { code: 'SEED-JKT-02' } })
    expect(pp!.label.en).toMatch(/^Sample · SEED-SR-\d+ · Pre-production · round 1$/)
    // Rounds: only the party's (the internal proto and CE rounds are the office's), each in the brand's words.
    const rounds = Object.fromEntries((page.rounds as Json[]).map((row) => [row.id, row]))
    expect(Object.keys(rounds).sort()).toEqual([samples.roundIds.fit, samples.roundIds.pp].sort())
    expect(rounds[samples.roundIds.pp]).toMatchObject({ status: 'WAITING', waitingRequestId: asked, shipment: { sentAt: expect.any(String), receivedAt: expect.any(String) } })
    expect(rounds[samples.roundIds.fit]).toMatchObject({ status: 'BEING_MADE', kind: 'FIT', waitingRequestId: null })
    // Styles: P1's private labels in development or with a round open; SEED-JKT-02 is in production but its round is open.
    const styles = Object.fromEntries((page.styles as Json[]).map((row) => [row.code, row]))
    expect(styles['SEED-JKT-01']).toMatchObject({ stage: 'FIT', openRounds: 1, latestRound: { kind: 'FIT', status: 'BEING_MADE' } })
    expect(styles['SEED-JKT-02']).toMatchObject({ stage: 'PRE_PRODUCTION', waiting: 1 })
    // The tech pack: the BRAND copy only, never the internal or the workshop one.
    expect((styles['SEED-JKT-01']!.techPacks as Json[]).map((pack) => pack.id)).toEqual([copies.brand])
    expect(styles['SEED-JKT-01']!.techPack).toMatchObject({ id: copies.brand, revision: 1, version: 1, language: 'en', state: 'DRAFT', printed: expect.stringMatching(/^TP [0-9A-Z]{5}-[0-9A-Z]{5}$/) })
    expect(keysOf(page).filter((name) => FORBIDDEN.test(name))).toEqual([])
  })

  it('opens the BRAND tech pack (logged), never an internal or workshop copy', async () => {
    const opened = await as(buyer, 'POST', `/portal/samples/tech-packs/${copies.brand}/download`, { mode: 'preview' })
    expect(opened).toMatchObject({ techPack: { id: copies.brand, styleCode: 'SEED-JKT-01', revision: 1, version: 1, language: 'en' }, download: { mode: 'inline', method: 'GET', url: expect.any(String) } })
    const audit = await one(`SELECT audience::text, "partyId", after FROM "AuditLog" WHERE action = $1 AND "actorId" = $2 ORDER BY at DESC LIMIT 1`, [TECH_PACK_OPEN_ACTION, buyerId])
    expect(audit).toMatchObject({ audience: 'PARTNER', partyId: P1, after: { kind: 'TECH_PACK', generatedDocumentId: copies.brand, styleCode: 'SEED-JKT-01', mode: 'preview' } })
    for (const id of [copies.internal, copies.workshop, newId()]) expect((await as(buyer, 'POST', `/portal/samples/tech-packs/${id}/download`, { mode: 'download' }, 404)).error.message).toBe('Tech pack not found.')
  })
})

describe('the brand decides in the portal (B-W2b-184 portal answer + B-W2b-252 settle, end to end)', () => {
  it('a viewer reads the request but may not answer', async () => {
    const page = await as(viewer, 'GET', '/portal/samples')
    expect(page.mayApprove).toBe(false)
    expect((page.waiting as Json[]).map((row) => row.requestId)).toContain(asked)
    const approval = await as(viewer, 'GET', `/portal/approvals/${asked}`)
    expect(approval.may.answer).toBe(false)
  })

  it('the buyer approves with comments: the round is DECIDED via PORTAL by that person, its task done, the page follows', async () => {
    const approval = await as(buyer, 'GET', `/portal/approvals/${asked}`)
    expect(approval.may).toMatchObject({ answer: true, withChanges: true })
    const answered = await as(buyer, 'POST', `/portal/approvals/${asked}/answer`, { decision: 'APPROVED_WITH_CHANGES', answer: 'Made-up: a darker thread on the collar.', typedName: 'Bruna Buyer', version: approval.request.version })
    expect(answered.request.status).toBe('APPROVED_WITH_CHANGES')
    const round = await one('SELECT stage::text, decision::text, "decisionComments", "decidedVia"::text AS via, "decidedById" FROM "SampleRound" WHERE id = $1', [samples.roundIds.pp])
    expect(round).toEqual({ stage: 'DECIDED', decision: 'APPROVED_WITH_COMMENTS', decisionComments: 'Made-up: a darker thread on the collar.', via: 'PORTAL', decidedById: buyerId })
    const decided = await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE subject = $1 AND type = 'sample_round.decided'`, [samples.roundIds.pp])
    expect(decided.map((event) => event.payload)).toEqual([expect.objectContaining({ via: 'PORTAL', decision: 'APPROVED_WITH_COMMENTS', approvalRequestId: asked, partyId: P1 })])
    const task = await one(`SELECT status::text, "doneById" FROM "PartnerTask" WHERE "sourceKey" = $1`, [`ApprovalRequest:${asked}`])
    expect(task).toEqual({ status: 'DONE', doneById: buyerId })
    const page = await as(buyer, 'GET', '/portal/samples')
    expect((page.waiting as Json[]).map((row) => row.requestId)).not.toContain(asked)
    expect((page.rounds as Json[]).find((row) => row.id === samples.roundIds.pp)).toMatchObject({ status: 'APPROVED_WITH_COMMENTS', decision: 'APPROVED_WITH_COMMENTS', waitingRequestId: null })
    // Answered once: a second answer is refused in words.
    expect((await as(buyer, 'POST', `/portal/approvals/${asked}/answer`, { decision: 'APPROVED', typedName: 'Bruna Buyer', version: approval.request.version + 1 }, 409)).error.message).toBeTruthy()
  })
})

describe('another brand and other roles', () => {
  it('another brand sees none of P1’s rounds, styles, requests or tech packs', async () => {
    const page = await as(other, 'GET', '/portal/samples')
    expect(page).toMatchObject({ waiting: [], styles: [], rounds: [], counts: { waiting: 0, styles: 0, rounds: 0, open: 0 } })
    await as(other, 'POST', `/portal/samples/tech-packs/${copies.brand}/download`, { mode: 'preview' }, 404)
    await as(other, 'GET', `/portal/approvals/${asked}`, undefined, 404)
  })

  it('the customer’s finance person has no samples page (403)', async () => {
    await as(finance, 'GET', '/portal/samples', undefined, 403)
    await as(finance, 'POST', `/portal/samples/tech-packs/${copies.brand}/download`, { mode: 'preview' }, 403)
  })
})
