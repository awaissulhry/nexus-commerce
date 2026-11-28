import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import { ORDER_LIFE } from '@nexus/factory-domain/sales/order-life'
import { LINE_MODEL_KINDS } from '@nexus/factory-domain/sales/portal-ordering/line-moves'
import { SHEET_WAITS } from '@nexus/factory-domain/sales/portal-orders/sheet-rows'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedShipping } from '../../../../../../packages/factory-db/seed/shipping'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'
import { useAbuseGuard } from '../../../platform/abuse/guard'
import { usePortalOptions } from '../../../platform/auth/portal/service'
import { freshGuard, mailedCode, portalBrowser, portalWorld, type PortalWorld } from '../../../platform/auth/portal/testing/portal'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { startHarness, type Answer, type Browser, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'
import { forgetProgress } from './progress'

/**
 * The portal orders sheet as ONE order (owb- order workflow, S1 po1.1; design § 5b, § 5zi C, § 5zj A; the S1 Shape "SHEET") on the
 * local stack, through the real app and the real portal sign-in by code: the factory-db seeds up to shipping (the brand SEED-C1 = P1
 * with its orders), P1's portal and another customer's on; P1's buyer, viewer and designer, the other customer's buyer. Every name is
 * made up. Run with `node scripts/factory/run-pg-tests.mjs portal-orders/portal-sheet-one-order`.
 *
 *   - with drafts=true: the party's drafts as rows (kind DRAFT, status null) and its sent orders (REQUEST) with their page; every row's
 *     life, C rows (model, material, sizes, pieces, own values), own column ids, waits and acts; the answer's own columns
 *   - without it (an older web): no DRAFT row
 *   - BRAND: party B's drafts never in A's sheet (nor A's in B's); a request picture of B is absent from A's answer
 *   - MONEY: a viewer's rows carry no price key and no draft; the Designer reads no sheet (403: no portal.salesOrders.view)
 *   - no office series (SO-, RQ-) in any row
 */

let h: Harness
let tenant: TestTenant
let world: PortalWorld
const NS = 'owb-portal-sheet-one-order'
const T = seedUuid(NS, 'tenant')
const companyA = seedUuid(NS, 'company:A')
const P1 = seedUuid(NS, 'party:P1')

type Json = Record<string, any>
const people = { buyer: 'bina.buyer@sheet-one-order.example.com', viewer: 'vera.viewer@sheet-one-order.example.com', designer: 'dante.designer@sheet-one-order.example.com', other: 'omar.buyer@sheet-one-order-two.example.com' }
const browsers = {} as Record<keyof typeof people, Browser>

async function partnerPerson(email: string, partyId: string, roleKeys: string[]): Promise<void> {
  await h.database.withScope({ audience: 'office', tenantId: T, actorId: newId() }, async (client) => {
    const id = newId()
    await client.user.create({ data: { id, email, displayName: email.split('@')[0]!, locale: 'en', status: 'ACTIVE', audience: 'PARTNER', partyId, partnerKind: 'CUSTOMER' }, select: { id: true } })
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

const call = (browser: Browser, method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown): Promise<Answer> => browser.send(method as 'POST', url, method === 'GET' ? undefined : (body ?? {}))
async function ok(browser: Browser, method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown, status = 200): Promise<Json> {
  const answer = await call(browser, method, url, body)
  expect(answer.status, `${method} ${url}: ${JSON.stringify(answer.body)}`).toBe(status)
  return answer.body as Json
}

/** A draft of the browser's party with one described line (2 pieces, its material a choice); its record. */
async function draft(browser: Browser, subject: string): Promise<Json> {
  const made = await ok(browser, 'POST', '/portal/order-requests', { source: 'PICKER', subject }, 201)
  return ok(browser, 'POST', `/portal/order-requests/${made.request.id}/custom-lines`, { version: made.request.version, line: { description: 'Made-up suit', quantity: 2, choices: [{ topic: 'Material', options: ['Cowhide', 'Kangaroo'], picked: 'Kangaroo' }] } })
}

let A = { draftId: '', lineId: '', sentId: '', columnId: '' }
let B = { draftId: '' }

beforeAll(async () => {
  h = await startHarness('owb_sheet_one_order')
  h.clock.set(new Date())
  usePortalOptions({ answerFloorMs: 0 })
  await seedCore({ db: h.database, namespace: NS })
  await seedShipping({ db: h.database, namespace: NS })
  tenant = { id: T, slug: NS, companies: [{ id: companyA, code: 'SCA' }] }
  const actorId = newId()
  await h.database.withScope({ audience: 'office', tenantId: T, actorId }, async (client) => {
    await applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId })
    const accountId = newId()
    await client.integrationAccount.create({ data: { id: accountId, provider: 'SES', code: 'ses-portal', label: 'Mail (fake)', mode: 'FAKE', rateLimitPerMinute: 6000, rateLimitBurst: 1000 } })
    const domain = `mail.${NS}.example.com`
    await client.emailIdentity.create({
      data: { id: newId(), companyId: companyA, kind: 'NOTIFICATION', domain, fromAddress: `noreply@${domain}`, displayName: 'Seed A', displayNamePolicy: 'COMPANY', replyDomain: `reply.${NS}.example.com`, accountId, verificationStatus: 'SUCCESS', dkimStatus: 'SUCCESS', isDefault: true },
    })
    const settings = await client.portalSettings.findUnique({ where: { id: P1 }, select: { id: true, version: true } })
    if (settings) await client.portalSettings.update({ where: { id: P1 }, data: { portalOn: true, version: settings.version + 1 }, select: { id: true } })
    else await client.portalSettings.create({ data: { id: P1, partyId: P1, portalOn: true }, select: { id: true } })
  })
  world = await portalWorld(h, tenant)
  freshGuard(h)
  await partnerPerson(people.buyer, P1, ['customer-buyer'])
  await partnerPerson(people.viewer, P1, ['customer-viewer'])
  await partnerPerson(people.designer, P1, ['customer-designer'])
  await partnerPerson(people.other, world.partyId, ['customer-buyer'])
  for (const key of Object.keys(people) as (keyof typeof people)[]) browsers[key] = await signedIn(people[key])
  // A's draft with an own column and its value; A's sent order; B's draft.
  const record = await draft(browsers.buyer, 'Made-up A draft')
  A.draftId = record.request.id
  A.lineId = record.request.customLines[0].id
  const columnRow = await ok(browsers.buyer, 'POST', '/portal/own-columns', { name: 'Rider number (made up)', kind: 'TEXT' }, 201)
  A.columnId = columnRow.id
  await ok(browsers.buyer, 'PUT', `/portal/order-requests/${A.draftId}/own-columns`, { version: record.request.version, columnIds: [A.columnId] })
  await ok(browsers.buyer, 'PUT', '/portal/own-values', { line: { kind: 'REQUEST_LINE', id: A.lineId }, columnId: A.columnId, value: 'Made-up 46' })
  const toSend = await draft(browsers.buyer, 'Made-up A sent order')
  A.sentId = toSend.request.id
  await ok(browsers.buyer, 'POST', `/portal/order-requests/${A.sentId}/send`, { version: toSend.request.version })
  B.draftId = (await draft(browsers.other, 'Made-up B draft')).request.id
}, 300_000)

beforeEach(() => {
  freshGuard(h)
})

afterAll(async () => {
  useAbuseGuard(undefined)
  usePortalOptions({})
  forgetProgress()
  await h?.close()
})

describe('the sheet as ONE order (owb- po1.1)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('drafts and sent orders are rows with their page, life, C rows, own values, waits and acts', async () => {
    const sheet = await ok(browsers.buyer, 'GET', '/portal/sales-orders/sheet?chip=ALL&drafts=true')
    const draftRow = sheet.items.find((row: Json) => row.id === A.draftId)
    expect(draftRow).toMatchObject({ kind: 'DRAFT', status: null, number: null, subject: 'Made-up A draft', page: { kind: 'request', id: A.draftId }, life: 'DRAFT', ownColumnIds: [A.columnId] })
    expect(draftRow.lines).toEqual([{ id: A.lineId, seq: 1, model: { kind: 'TEXT', words: 'Made-up suit', garmentType: null }, material: 'Kangaroo', sizes: null, pieces: 2, ownValues: { [A.columnId]: expect.objectContaining({ columnId: A.columnId, value: 'Made-up 46' }) } }])
    expect(draftRow.may).toMatchObject({ edit: true, send: true, delete: true, takeBack: false, picture: true })
    const sentRow = sheet.items.find((row: Json) => row.id === A.sentId)
    expect(sentRow).toMatchObject({ kind: 'REQUEST', status: 'REQUESTED', page: { kind: 'request', id: A.sentId }, life: 'SENT' })
    expect(sentRow.may).toMatchObject({ edit: false, send: false, delete: false, takeBack: true, picture: true })
    const orders = sheet.items.filter((row: Json) => row.kind === 'ORDER')
    expect(orders.length).toBeGreaterThan(0)
    for (const row of orders as Json[]) {
      expect(row.page).toEqual({ kind: 'order', id: row.id })
      expect(ORDER_LIFE).toContain(row.life)
      for (const line of row.lines as Json[]) expect(LINE_MODEL_KINDS).toContain(line.model.kind)
      for (const wait of row.waits as Json[]) expect(SHEET_WAITS).toContain(wait.kind)
      // owb- po2.6 (pin moved): SEND_LABEL comes with S3's warehouse leg — only for an order with a shipment at the factory's warehouse.
    }
    expect(sheet.ownColumns).toEqual([expect.objectContaining({ id: A.columnId, name: 'Rider number (made up)', kind: 'TEXT' })])
    // Without drafts=true (an older web): no DRAFT row, every other row as before.
    const older = await ok(browsers.buyer, 'GET', '/portal/sales-orders/sheet?chip=ALL')
    expect(older.items.map((row: Json) => row.kind)).not.toContain('DRAFT')
    expect(older.items.map((row: Json) => row.id)).toContain(A.sentId)
  })

  it('no office series in any row: number null, no SO-/RQ- words', async () => {
    const sheet = await ok(browsers.buyer, 'GET', '/portal/sales-orders/sheet?chip=ALL&drafts=true')
    for (const row of sheet.items as Json[]) expect(row.number).toBeNull()
    const text = JSON.stringify(sheet.items)
    expect(text).not.toMatch(/SEED-SO-\d|RQ-\d{4}/)
  })

  it('BRAND: party B’s drafts never in A’s sheet, nor A’s in B’s; B’s Draft picture is absent from A’s answer', async () => {
    const mine = JSON.stringify(await ok(browsers.buyer, 'GET', '/portal/sales-orders/sheet?chip=ALL&drafts=true'))
    expect(mine).not.toContain(B.draftId)
    expect(mine).not.toContain('Made-up B draft')
    const theirs = await ok(browsers.other, 'GET', '/portal/sales-orders/sheet?chip=ALL&drafts=true')
    expect(theirs.items.map((row: Json) => row.id)).toContain(B.draftId)
    const text = JSON.stringify(theirs)
    for (const word of [A.draftId, A.sentId, A.columnId, 'Made-up A draft', 'Rider number', 'Made-up 46']) expect(text, word).not.toContain(word)
    const pictures = await ok(browsers.buyer, 'POST', '/portal/sales-orders/pictures', { requestIds: [A.draftId, B.draftId] })
    expect(pictures.pictures.map((entry: Json) => entry.id)).not.toContain(B.draftId)
    expect((await call(browsers.buyer, 'POST', '/portal/sales-orders/pictures', {})).status).toBe(400)
  })

  it('MONEY: a viewer’s rows carry no price key and no draft; the Designer reads no sheet', async () => {
    const viewer = await ok(browsers.viewer, 'GET', '/portal/sales-orders/sheet?chip=ALL&drafts=true')
    expect(viewer.items.map((row: Json) => row.kind)).not.toContain('DRAFT')
    for (const row of viewer.items as Json[]) expect(row).not.toHaveProperty('netAmount')
    expect(JSON.stringify(viewer.items)).not.toMatch(/unitPrice|netAmount|brandUnitPrice/)
    expect((await call(browsers.designer, 'GET', '/portal/sales-orders/sheet?chip=ALL&drafts=true')).status).toBe(403)
  })
})
