import ExcelJS from 'exceljs'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedFiles } from '../../../../../../packages/factory-db/seed/files'
import { seed as seedShipping } from '../../../../../../packages/factory-db/seed/shipping'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { seedSecondBrand, type SecondBrand } from '../../../../../../packages/factory-db/src/testing/second-brand'
import { callerFor } from '../../../core/command'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'
import { useAbuseGuard } from '../../../platform/abuse/guard'
import { usePortalOptions } from '../../../platform/auth/portal/service'
import { freshGuard, mailedCode, portalBrowser, portalWorld } from '../../../platform/auth/portal/testing/portal'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { startHarness, type Browser, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'
import { addOption, createField, createPicklist, writeValues } from '../../../platform/fields/fields'
import { forgetProgress } from './progress'

/**
 * The customer's own sheet in its portal (B-TH-061; threads plan TH-4, SHEET-G10, Owner decision 13; wall W10, W17, W39 / T39) on
 * the local stack, through the real app and the real portal sign-in by code: the factory-db seeds up to shipping (the brand SEED-C1's
 * orders SEED-SO-0001/0002/0003) and the second brand's fixture (Seed Brand Two, SEED-C2B, its order SEED-SO-B001), both portals on;
 * a buyer and a viewer (no price) of the first, a buyer of the second. Custom fields of orders made through platform/fields: one for
 * every customer shown in the portal, one kept in the office, a list, a price, and Seed Brand Two's own. Every name is made up.
 *
 *   - GET /portal/sales-orders/sheet: the customer's own rows only, with the columns the office ticked for the portal — every
 *     customer's and its own, never another customer's field, a list's values only as its rows use them, a price only with the
 *     price grain — and its OWN order numbers (plan §0.5: no office number);
 *   - GET /portal/sales-orders/sheet/download: EVERY row, written by the server in the partner scope (never the export job), as
 *     CSV and as Excel: the same rows and columns, nothing of the other customer (T39), no office number.
 * Run with `node scripts/factory/run-pg-tests.mjs portal-orders/portal-sheet`.
 */

let h: Harness
let tenant: TestTenant
let second: SecondBrand
const NS = 'th4-portal-sheet'
const T = seedUuid(NS, 'tenant')
const companyA = seedUuid(NS, 'company:A')
const P1 = seedUuid(NS, 'party:P1')

type Json = Record<string, any>
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
const one = async <R = Json>(sql: string, values: unknown[] = []): Promise<R> => (await admin<R>(sql, values))[0]!
const orderId = (number: string) => one<{ id: string }>('SELECT id FROM "SalesOrder" WHERE "tenantId" = $1 AND number = $2', [T, number]).then((row) => row.id)

const people = { buyer: 'bianca.buyer@th4-sheet.example.com', viewer: 'vito.viewer@th4-sheet.example.com', beta: 'bruna.buyer@th4-sheet-two.example.net' }
const browsers = {} as Record<keyof typeof people, Browser>
let keySerial = 0
const key = () => `th4-sheet-${++keySerial}-${Date.now()}`
const office = () => callerFor(h.database, { audience: 'office', tenantId: T, actorId: newId(), requestId: newId(), grants: [{ permissions: ['fields.view', 'fields.manage', 'orders.view', 'orders.manage', 'parties.view', 'money.price'] as Permission[], companies: 'all', sites: 'all', parties: 'all' }] })

async function partnerPerson(email: string, partyId: string, roleKeys: string[]): Promise<void> {
  await h.database.withScope({ audience: 'office', tenantId: T, actorId: newId() }, async (client) => {
    const id = newId()
    await client.user.create({ data: { id, email, displayName: email.split('@')[0]!, locale: 'en', status: 'ACTIVE', audience: 'PARTNER', partyId, partnerKind: 'CUSTOMER' }, select: { id: true } })
    for (const roleKey of roleKeys) {
      const role = await client.role.findUniqueOrThrow({ where: { tenantId_key: { tenantId: T, key: roleKey } }, select: { id: true } })
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

async function ok(browser: Browser, url: string): Promise<Json> {
  const answer = await browser.get(url)
  expect(answer.status, `${url}: ${JSON.stringify(answer.body)}`).toBe(200)
  return answer.body as Json
}

/** Every text cell of the workbook's first sheet, row by row. */
async function workbookRows(bytes: Buffer): Promise<string[][]> {
  const book = new ExcelJS.Workbook()
  await book.xlsx.load(bytes as unknown as ArrayBuffer)
  const sheet = book.worksheets[0]!
  const rows: string[][] = []
  sheet.eachRow((row) => rows.push((row.values as unknown[]).slice(1).map((value) => (value === null || value === undefined ? '' : value instanceof Date ? value.toISOString().slice(0, 10) : String(value)))))
  return rows
}

/** What of the other customer must never be in the first customer's sheet or file, and the office's numbers. */
const BRAND_TWO = ['SEED-C2B', 'Seed Brand Two', 'SEED-SO-B001', 'SEED-B-PO-1', 'Made-up BL-2', 'beta_lining', 'Brand Two lining', 'BRAND_TWO_SPECIAL']
const OFFICE_NUMBERS = ['SEED-SO-0001', 'SEED-SO-0002', 'SEED-SO-0003']

beforeAll(async () => {
  h = await startHarness('th4_portal_sheet')
  h.clock.set(new Date())
  usePortalOptions({ answerFloorMs: 0 })
  await seedCore({ db: h.database, namespace: NS })
  await seedShipping({ db: h.database, namespace: NS })
  await seedFiles({ db: h.database, namespace: NS })
  second = await seedSecondBrand({ db: h.database, namespace: NS })
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
    for (const partyId of [P1, second.partyId]) {
      const settings = await client.portalSettings.findUnique({ where: { id: partyId }, select: { id: true, version: true } })
      if (settings) await client.portalSettings.update({ where: { id: partyId }, data: { portalOn: true, version: settings.version + 1 }, select: { id: true } })
      else await client.portalSettings.create({ data: { id: partyId, partyId, portalOn: true }, select: { id: true } })
    }
  })
  await portalWorld(h, tenant)
  freshGuard(h)
  await partnerPerson(people.buyer, P1, ['customer-buyer'])
  await partnerPerson(people.viewer, P1, ['customer-viewer'])
  await partnerPerson(people.beta, second.partyId, ['customer-buyer'])
  for (const person of Object.keys(people) as (keyof typeof people)[]) browsers[person] = await signedIn(people[person])

  // The custom fields of orders and their values (the office, through platform/fields).
  const list = await createPicklist(office(), { code: 'sheet_finish', labelIt: 'Finitura', labelEn: 'Finish' }, key())
  await addOption(office(), list.id, { code: 'STANDARD', labelIt: 'Standard', labelEn: 'Standard' }, key())
  await addOption(office(), list.id, { code: 'BRAND_TWO_SPECIAL', labelIt: 'Speciale (inventata)', labelEn: 'Special (made up)' }, key())
  const field = (body: Json) => createField(office(), { recordType: 'ORDER', labelIt: 'Campo inventato', ...body } as never, key())
  await field({ code: 'ship_week', type: 'TEXT', labelEn: 'Ship week (made up)', shownInPortal: true })
  await field({ code: 'office_code', type: 'TEXT', labelEn: 'Office code (made up)', shownInPortal: false })
  await field({ code: 'finish', type: 'SELECT', labelEn: 'Finish (made up)', picklistId: list.id, shownInPortal: true })
  await field({ code: 'target_price', type: 'MONEY', grain: 'price', labelEn: 'Target price (made up)', shownInPortal: true })
  await field({ code: 'beta_lining', type: 'TEXT', partyId: second.partyId, labelEn: 'Brand Two lining (made up)', shownInPortal: true })
  const values = (id: string, entries: [string, unknown][]) => writeValues(office(), 'ORDER', id, { values: entries.map(([code, value]) => ({ code, value, version: null })) } as never, key())
  await values(await orderId('SEED-SO-0001'), [['ship_week', 'Made-up W49'], ['office_code', 'Made-up INT-1'], ['finish', 'STANDARD'], ['target_price', { amount: 12_000, currency: 'EUR' }]])
  await values(second.salesOrderId, [['ship_week', 'Made-up W50'], ['finish', 'BRAND_TWO_SPECIAL'], ['beta_lining', 'Made-up BL-2']])
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

describe('T39 the customer’s own sheet in its portal (B-TH-061)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('its own rows with the columns ticked for the portal, its own numbers; never the other customer’s rows, fields or list values', async () => {
    const sheet = await ok(browsers.buyer, '/portal/sales-orders/sheet?chip=ALL')
    const own = await Promise.all(OFFICE_NUMBERS.map(orderId))
    expect(sheet.items.map((row: Json) => row.id).sort()).toEqual([...own].sort())
    expect(sheet.columns.map((column: Json) => column.code)).toEqual(['ship_week', 'finish', 'target_price'])
    expect(sheet.columns.find((column: Json) => column.code === 'finish').options).toEqual([{ code: 'STANDARD', labelIt: 'Standard', labelEn: 'Standard' }])
    const so1 = sheet.items.find((row: Json) => row.id === own[0])
    expect(so1.values['cf:ship_week']).toMatchObject({ value: 'Made-up W49' })
    expect(so1.values['cf:finish']).toMatchObject({ value: 'STANDARD', wordsEn: 'Standard' })
    expect(so1.values['cf:price:target_price'].value).toEqual({ amount: 12_000, currency: 'EUR' })
    // Its own numbers: no office number on an order, "Your order N" instead.
    for (const row of sheet.items as Json[]) {
      expect(row.number).toBeNull()
      expect(row.yourNumber.words.en).toMatch(/^Your order \d+$/)
    }
    const text = JSON.stringify(sheet)
    for (const word of [...BRAND_TWO, ...OFFICE_NUMBERS, 'office_code', 'Made-up INT-1']) expect(text, word).not.toContain(word)
  })

  it('a viewer without the price grain: no price column; the other customer reads its own rows and field, nothing of the first', async () => {
    const viewer = await ok(browsers.viewer, '/portal/sales-orders/sheet?chip=ALL')
    expect(viewer.columns.map((column: Json) => column.code)).toEqual(['ship_week', 'finish'])
    expect(JSON.stringify(viewer)).not.toContain('target_price')
    const beta = await ok(browsers.beta, '/portal/sales-orders/sheet?chip=ALL')
    expect(beta.items.map((row: Json) => row.id)).toEqual([second.salesOrderId])
    expect(beta.columns.map((column: Json) => column.code)).toEqual(['ship_week', 'finish', 'target_price', 'beta_lining'])
    expect(beta.columns.find((column: Json) => column.code === 'finish').options.map((option: Json) => option.code)).toEqual(['BRAND_TWO_SPECIAL'])
    expect(beta.items[0].values['cf:beta_lining']).toMatchObject({ value: 'Made-up BL-2' })
    const text = JSON.stringify(beta)
    for (const word of ['Made-up W49', 'Made-up INT-1', 'SEED-PO-77', ...OFFICE_NUMBERS, 'SEED-SO-B001']) expect(text, word).not.toContain(word)
  })

  it('Download all: every row as CSV and as Excel, written by the server, the customer’s own rows and columns only', async () => {
    const csv = await browsers.buyer.get('/portal/sales-orders/sheet/download?chip=ALL&format=CSV&locale=en')
    expect(csv.status).toBe(200)
    expect(String(csv.response.headers['content-type'])).toContain('text/csv')
    expect(String(csv.response.headers['content-disposition'])).toMatch(/^attachment; filename="Your orders \d{4}-\d{2}-\d{2}\.csv"/)
    const content = csv.response.body
    expect(content).toContain('Ship week (made up)')
    expect(content).toContain('Made-up W49')
    expect(content).toContain('SEED-PO-77')
    for (const word of [...BRAND_TWO, ...OFFICE_NUMBERS, 'Office code', 'Made-up INT-1']) expect(content, word).not.toContain(word)
    // The header and one line per order, never the export job (no job row is made).
    expect(content.trim().split(/\r?\n/).filter((line: string) => /SEED-PO-/.test(line))).toHaveLength(OFFICE_NUMBERS.length)
    expect((await one<{ n: number }>(`SELECT count(*)::int AS n FROM "ExportJob" WHERE "tenantId" = $1`, [T])).n).toBe(0)

    const xlsx = await browsers.buyer.get('/portal/sales-orders/sheet/download?chip=ALL&format=XLSX&locale=it')
    expect(xlsx.status).toBe(200)
    expect(String(xlsx.response.headers['content-type'])).toContain('spreadsheetml')
    const rows = await workbookRows(xlsx.response.rawPayload)
    const cells = rows.flat().join('\n')
    expect(rows.some((row) => row.includes('Il vostro ordine n.'))).toBe(true)
    expect(rows.filter((row) => row.some((cell) => /SEED-PO-/.test(cell)))).toHaveLength(OFFICE_NUMBERS.length)
    for (const word of [...BRAND_TWO, ...OFFICE_NUMBERS, 'Made-up INT-1']) expect(cells, word).not.toContain(word)

    // The other customer's file holds its own order only.
    const beta = await browsers.beta.get('/portal/sales-orders/sheet/download?chip=ALL&format=CSV&locale=en')
    expect(beta.status).toBe(200)
    expect(beta.response.body).toContain('SEED-B-PO-1')
    for (const word of ['Made-up W49', 'SEED-PO-77', 'SEED-PO-78', 'SEED-PO-91', 'SEED-SO-B001', ...OFFICE_NUMBERS]) expect(beta.response.body, word).not.toContain(word)
  })

  it('a viewer’s file has no value column and says why', async () => {
    const csv = await browsers.viewer.get('/portal/sales-orders/sheet/download?chip=ALL&format=CSV&locale=en')
    expect(csv.status).toBe(200)
    expect(csv.response.body).toContain('Prices are not part of your access')
    expect(csv.response.body).not.toContain('Net value')
    expect(csv.response.body).not.toContain('Target price')
  })
})
