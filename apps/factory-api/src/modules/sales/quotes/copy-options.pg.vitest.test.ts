import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedCompliance } from '../../../../../../packages/factory-db/seed/compliance'
import { seed as seedCosting } from '../../../../../../packages/factory-db/seed/costing'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedOptions, type OptionsSeed } from '../../../../../../packages/factory-db/seed/options'
import { seed as seedReasons } from '../../../../../../packages/factory-db/seed/reasons'
import { seed as seedSalesPricing, type SalesPricingSeed } from '../../../../../../packages/factory-db/seed/sales-pricing'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { localFileStore } from '../../../adapters/local-files/local'
import { createFilesRuntime, useFiles } from '../../../platform/files/service'
import { createGateway } from '../../../platform/gateway/gateway'
import { testRedis, type TestRedis } from '../../../platform/outbox/testing'
import { createSecretsService } from '../../../platform/secrets/envelope'
import { localKeyProvider } from '../../../platform/secrets/local'
import { cellsPrinted, orderLinesPrinted, quoteLinesPrinted } from '../configurator/printed'

/**
 * B-W2b-374 on the local stack with the app's real routes (a throwaway PostgreSQL 17 database from the migrations, the
 * runtime login: row-level security, the grants and the …_sales_pricing_w2b_guards and …_followups_sales_w2b5_guards triggers
 * on the option rows are real): what a group takes (XF3:05), the options of copies — Duplicate, Copy as new quote, the paste's
 * Options column (XF3:01) —, a typed order line's and an amendment's new line's options (XF3:02) and the options as paper
 * prints them (XF3:03). The seeds' SEED-JKT-05 offers the liner (+60.00), perforation (front +5 %, full +40.00; full EXCLUDES
 * the liner), the name (+15.00, a text) and the armour; SEED-Q-0003 (DRAFT) has JKT-05 configured (NET 470), SEED-SO-0004
 * (CONFIRMED) JKT-05 with the liner. Run with `node scripts/factory/run-pg-tests.mjs modules/sales/quotes/copy-options`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let seeded: SalesPricingSeed
let options: OptionsSeed
let redis: TestRedis
let localRoot = ''

const NS = 'options-followups-seed'
const seedId = (key: string): string => seedUuid(NS, key)
const tenant = seedId('tenant')
const companyA = seedId('company:A')
const P1 = seedId('party:P1')
const jkt01 = seedId('product:style:JKT-01')
const BLK = seedId('product:colourway:JKT-01:BLK')
const RED = seedId('product:colourway:JKT-01:RED')

const grainsOf = (grains: readonly string[]): Permission[] => grains.map((grain) => `money.${grain}` as Permission)
const PEOPLE: Record<string, { readonly template: string; readonly drop?: readonly string[] }> = {
  seller: { template: 'sales' },
  owner: { template: 'owner' },
  keeper: { template: 'production_manager' },
}
const IDS: Record<string, string> = Object.fromEntries(Object.keys(PEOPLE).map((key) => [key, newId()]))
const SESSIONS: Record<string, SessionContext> = Object.fromEntries(
  Object.entries(PEOPLE).map(([key, person]) => {
    const role = templateOf(person.template)!
    const grant: Grant = { permissions: [...role.permissions.filter((permission) => !(person.drop ?? []).includes(permission)), ...grainsOf(role.grains)], companies: 'all', sites: 'all', parties: 'all' }
    return [key, { audience: 'office', tenantId: tenant, actorId: IDS[key]!, grants: [grant] }]
  }),
)

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const call = (session: string, method: Method, url: string, payload?: unknown) => app.inject({ method, url, headers: { 'x-test-session': session }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function refused(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}
const q = (quoteId: string, lineId: string) => `/sales/quotes/${quoteId}/lines/${lineId}`
const codesOf = async (table: 'QuoteLineOption' | 'SalesOrderLineOption', lineId: string) =>
  (await admin<{ code: string }>(`SELECT v.code FROM "${table}" o JOIN "OptionValue" v ON v.id = o."valueId" WHERE o."lineId" = $1 ORDER BY v.code`, [lineId])).map((row) => row.code)
const rowsOf = async (table: 'QuoteLineOption' | 'SalesOrderLineOption', lineId: string) =>
  admin<{ code: string; freeText: string | null; surchargeAmount: string | null; colourId: string | null; itemId: string | null }>(
    `SELECT v.code, o."freeText", o."surchargeAmount"::text, o."colourId", o."itemId" FROM "${table}" o JOIN "OptionValue" v ON v.id = o."valueId" WHERE o."lineId" = $1 ORDER BY v.code`,
    [lineId],
  )
const num = (value: string | null) => (value === null ? null : Number(value))

beforeAll(async () => {
  db = await migratedDatabase('options_followups')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 12 } })
  await seedCore({ db: database, namespace: NS })
  await seedCompliance({ db: database, namespace: NS })
  await seedCosting({ db: database, namespace: NS })
  await seedNumbering({ db: database, namespace: NS })
  seeded = await seedSalesPricing({ db: database, namespace: NS })
  options = await seedOptions({ db: database, namespace: NS })
  await seedReasons({ db: database, namespace: NS })
  for (const key of Object.keys(PEOPLE)) await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, 'ACTIVE')`, [IDS[key], tenant, `${key}.followups@example.com`, `Follow-ups ${key}`])
  // SEED-JKT-01 offers the liner and the perforation too (test data: two offer rows; full perforation EXCLUDES the liner), for
  // copies, typed lines and pastes at its list price (BLK 420, RED 430): SEED-JKT-05 has no variant in these seeds.
  await admin(`INSERT INTO "StyleOptionGroup" (id, "tenantId", "styleId", "groupId", seq) VALUES ($1, $2, $3, $4, 10), ($5, $2, $3, $6, 20)`, [newId(), tenant, jkt01, options.groupIds.liner, newId(), options.groupIds.perforation])
  redis = testRedis()
  localRoot = mkdtempSync(join(tmpdir(), 'factory-followups-test-'))
  const secrets = createSecretsService({ providers: [localKeyProvider({ masterKey: randomBytes(32), environment: 'test' })] })
  const gateway = createGateway({ environment: 'test', redis: redis.connect(), prefix: redis.prefix, secrets, sleep: async () => {}, log: { info() {}, warn() {}, error() {} } })
  useFiles(createFilesRuntime({ gateway, local: localFileStore({ root: localRoot, environment: 'test' }) }))
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null), logger: false },
  )
}, 180_000)

afterAll(async () => {
  useFiles(undefined)
  await redis?.cleanup()
  if (localRoot) rmSync(localRoot, { recursive: true, force: true })
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe('what a chosen value of a group takes (XF3:05)', () => {
  it('a colour or a material by the group: the picker offered, a pick of the other kind and a takes change refused in words', async () => {
    const { quoteId, gridLineId } = seeded.draftQuote
    const perf = options.groupIds.perforation
    let takes = await ok('seller', 'GET', `/product/option-groups/${perf}/takes`)
    expect(takes).toMatchObject({ code: 'SEED-OG-PERF', takes: null, picking: { colours: 0, materials: 0 } })
    // The sales role reads it; changing it is for who keeps the library.
    expect(takes.may).toMatchObject({ change: false })
    await refused('seller', 'PUT', `/product/option-groups/${perf}/takes`, { version: takes.version, takes: 'COLOUR' }, 403)
    // A quote's front perforation picks a leather (either is allowed while the group takes nothing).
    const [leather] = await admin<{ id: string; colour: string }>(`SELECT i.id, c.id AS colour FROM "Item" i JOIN "ItemColour" c ON c."itemId" = i.id WHERE i.code = 'SEED-LEA-100' AND c.code = 'RED' AND i."tenantId" = $1`, [tenant])
    const [red] = await admin<{ id: string }>(`SELECT id FROM "Colour" WHERE code = 'SEED-RED' AND "tenantId" = $1`, [tenant])
    let quote = (await ok('seller', 'GET', `/sales/quotes/${quoteId}`)).quote
    quote = (await ok('seller', 'PUT', `${q(quoteId, gridLineId)}/options`, { version: quote.version, picks: [{ valueId: options.valueIds.perfFront, itemId: leather!.id, itemColourId: leather!.colour }, { valueId: options.valueIds.name, text: 'ROSSI' }, { valueId: options.valueIds.linerYes }] })).quote
    takes = await ok('keeper', 'GET', `/product/option-groups/${perf}/takes`)
    expect(takes).toMatchObject({ picking: { colours: 0, materials: 1 }, may: { change: true, held: null } })
    // COLOUR while a chosen option picks a material: 409 in words, nothing changed.
    const clash = await refused('keeper', 'PUT', `/product/option-groups/${perf}/takes`, { version: takes.version, takes: 'COLOUR' }, 409)
    expect(clash.message).toMatch(/pick a material: change them first/)
    // MATERIAL fits: saved, audited, the configurator offers the material picker only.
    takes = await ok('keeper', 'PUT', `/product/option-groups/${perf}/takes`, { version: takes.version, takes: 'MATERIAL' })
    expect(takes.takes).toBe('MATERIAL')
    const [audit] = await admin<Json>(`SELECT before, after FROM "AuditLog" WHERE action = 'product.options.setTakes' AND "recordId" = $1 ORDER BY at DESC LIMIT 1`, [perf])
    expect(audit).toMatchObject({ before: { takes: null }, after: { takes: 'MATERIAL' } })
    const view = await ok('seller', 'GET', `${q(quoteId, gridLineId)}/configurator`)
    expect(view.groups.find((group: Json) => group.code === 'SEED-OG-PERF').takes).toBe('MATERIAL')
    expect(view.groups.find((group: Json) => group.code === 'SEED-OG-NAME').takes).toBeNull()
    // A library colour on a MATERIAL group's value is refused in words (409), before the database would.
    const wrong = await refused('seller', 'PUT', `${q(quoteId, gridLineId)}/options`, { version: quote.version, picks: [{ valueId: options.valueIds.perfFront, colourId: red!.id }] }, 409)
    expect(wrong.message).toMatch(/takes a material and its colour: not a colour of the library/)
    expect(wrong.issues[0].path).toBe('body/picks/0/colourId')
    // A stale version of the group is refused; back to either.
    await refused('keeper', 'PUT', `/product/option-groups/${perf}/takes`, { version: takes.version - 1, takes: null }, 409)
    takes = await ok('keeper', 'PUT', `/product/option-groups/${perf}/takes`, { version: takes.version, takes: null })
    expect(takes.takes).toBeNull()
    // The quote line keeps its options for the copies below.
    expect(await codesOf('QuoteLineOption', gridLineId)).toEqual(['FRONT', 'NAME', 'STD', 'YES'])
  })
})

describe('the options travel with every copy (XF3:01)', () => {
  it('Duplicate: the copy takes the options, each with the surcharge it was sold with (its price kept as sold holds them)', async () => {
    let quote = (await ok('seller', 'POST', '/sales/quotes', { companyId: companyA, partyId: P1 }, 201)).quote
    quote = (await ok('seller', 'POST', `/sales/quotes/${quote.id}/lines`, { version: quote.version, styleId: jkt01, colourwayId: BLK, sizes: [{ size: '50', quantity: 2 }] }, 201)).quote
    const sourceLine = quote.lines[0].id
    // Liner +60 and front perforation +5 % of the list's 420 (21): priced through the waterfall to 501.
    quote = (await ok('seller', 'PUT', `${q(quote.id, sourceLine)}/options`, { version: quote.version, picks: [{ valueId: options.valueIds.linerYes }, { valueId: options.valueIds.perfFront }] })).quote
    expect(quote.lines[0].unitPrice).toBe('501')
    const source = await rowsOf('QuoteLineOption', sourceLine)
    // Today the front perforation costs more: the copy keeps the 21 it was sold with (its price, 501, holds them).
    await admin(`UPDATE "OptionEffect" SET "pricePct" = 10 WHERE "valueId" = $1 AND kind = 'PRICE'`, [options.valueIds.perfFront])
    try {
      const made = await ok('seller', 'POST', `/sales/quotes/${quote.id}/duplicate`, {}, 201)
      const line = made.quote.lines[0]
      expect(line.unitPrice).toBe('501')
      const copied = await rowsOf('QuoteLineOption', line.id)
      expect(copied.map((row) => [row.code, num(row.surchargeAmount)])).toEqual(source.map((row) => [row.code, num(row.surchargeAmount)]))
      expect(copied.map((row) => [row.code, num(row.surchargeAmount)])).toEqual([['FRONT', 21], ['YES', 60]])
      expect(made.dropped).toEqual([])
      const [audit] = await admin<Json>(`SELECT after FROM "AuditLog" WHERE action = 'quotes.duplicate' AND "recordId" = $1`, [made.quote.id])
      expect(audit!.after.options).toBe(2)
    } finally {
      await admin(`UPDATE "OptionEffect" SET "pricePct" = 5 WHERE "valueId" = $1 AND kind = 'PRICE'`, [options.valueIds.perfFront])
    }
  })

  it('Duplicate: a line at its list price starts its waterfall from the list with the options; options the rules refuse now are said', async () => {
    let quote = (await ok('seller', 'POST', '/sales/quotes', { companyId: companyA, partyId: P1 }, 201)).quote
    quote = (await ok('seller', 'POST', `/sales/quotes/${quote.id}/lines`, { version: quote.version, styleId: jkt01, colourwayId: BLK, sizes: [{ size: '50', quantity: 2 }] }, 201)).quote
    const lineId = quote.lines[0].id
    quote = (await ok('seller', 'PUT', `${q(quote.id, lineId)}/options`, { version: quote.version, picks: [{ valueId: options.valueIds.linerYes }] })).quote
    expect(quote.lines[0].unitPrice).toBe('480')
    // W1's typed price drops the waterfall: the line is at its list again (420), the liner frozen beside it.
    quote = (await ok('seller', 'PATCH', `${q(quote.id, lineId)}`, { version: quote.version, unitPrice: '420' })).quote
    const made = await ok('seller', 'POST', `/sales/quotes/${quote.id}/duplicate`, {}, 201)
    expect(made.quote.lines[0].unitPrice).toBe('480')
    expect(await codesOf('QuoteLineOption', made.quote.lines[0].id)).toEqual(['YES'])
    const steps = (await ok('seller', 'GET', `/sales/quotes/${made.quote.id}/pricing`)).lines[0].steps.map((step: Json) => step.kind)
    expect(steps).toContain('OPTION')
    // The liner is no longer offered on JKT-01: the copy keeps the line and says its options were left out.
    await admin(`UPDATE "StyleOptionGroup" SET status = 'ARCHIVED' WHERE "styleId" = $1 AND "groupId" = $2`, [jkt01, options.groupIds.liner])
    try {
      const again = await ok('seller', 'POST', `/sales/quotes/${quote.id}/duplicate`, {}, 201)
      expect(await codesOf('QuoteLineOption', again.quote.lines[0].id)).toEqual([])
      expect(again.dropped.find((entry: Json) => /options were not copied/.test(entry.reason))).toMatchObject({ seq: 10, size: null })
    } finally {
      await admin(`UPDATE "StyleOptionGroup" SET status = 'ACTIVE' WHERE "styleId" = $1 AND "groupId" = $2`, [jkt01, options.groupIds.liner])
    }
  })

  it("Copy as new quote: the order line's options, as accepted", async () => {
    const order = (await ok('seller', 'POST', '/sales/orders/manual', { companyId: companyA, partyId: P1, lines: [{ styleId: jkt01, colourwayId: BLK, sizes: [{ size: '50', quantity: 1 }], options: [{ valueId: options.valueIds.linerYes }] }] }, 201)).order
    const source = await rowsOf('SalesOrderLineOption', order.lines[0].id)
    expect(source.map((row) => row.code)).toEqual(['YES'])
    const made = await ok('seller', 'POST', `/sales/orders/${order.id}/copy-as-quote`, {}, 201)
    const line = made.quote.lines[0]
    expect(line.unitPrice).toBe('480')
    expect((await rowsOf('QuoteLineOption', line.id)).map((row) => [row.code, num(row.surchargeAmount)])).toEqual([['YES', 60]])
  })

  it("paste: a new line takes the Options column's values (checked by the rules); a line already there keeps its own; what cannot be read is said", async () => {
    let quote = (await ok('seller', 'POST', '/sales/quotes', { companyId: companyA, partyId: P1 }, 201)).quote
    const text = 'Style\tColourway\tOptions\t50\t52\nSEED-JKT-01\tBLK\tSEED-OG-LINER:YES, HUMP:XL\t2\t2'
    const preview = await ok('seller', 'POST', `/sales/quotes/${quote.id}/lines/paste`, { version: quote.version, text, preview: true })
    expect(preview.rows[0]).toMatchObject({ action: 'ADD', options: 1 })
    expect(preview.rows[0].leftOut.map((entry: Json) => entry.message)).toEqual(['Row 2: option HUMP:XL is not one the style offers.'])
    const pasted = await ok('seller', 'POST', `/sales/quotes/${quote.id}/lines/paste`, { version: quote.version, text })
    quote = pasted.quote
    expect(await codesOf('QuoteLineOption', quote.lines[0].id)).toEqual(['YES'])
    expect(quote.lines[0].unitPrice).toBe('480')
    // The same line again: its pieces change, its options stay as they are (said).
    const again = await ok('seller', 'POST', `/sales/quotes/${quote.id}/lines/paste`, { version: quote.version, text: 'Style\tColourway\tOpzioni\t54\nSEED-JKT-01\tBLK\tYES\t1' })
    expect(again.rows[0]).toMatchObject({ action: 'CHANGE', options: 0 })
    expect(again.rows[0].leftOut[0].message).toMatch(/options are not written on a line already on the quote/)
    expect(await codesOf('QuoteLineOption', quote.lines[0].id)).toEqual(['YES'])
    // A refused combination (full perforation and the liner): the line lands without options, said.
    quote = again.quote
    const clash = await ok('seller', 'POST', `/sales/quotes/${quote.id}/lines/paste`, { version: quote.version, text: 'Style\tColourway\tOptions\t50\nSEED-JKT-01\tRED\tFULL, SEED-OG-LINER:YES\t1', preview: true })
    expect(clash.rows[0]).toMatchObject({ action: 'ADD', options: 0 })
    expect(clash.rows[0].leftOut[0].message).toMatch(/^Row 2: the options were left out \(/)
  })
})

describe("a typed order line and an amendment's new line take options (XF3:02)", () => {
  const body = (extra: Json = {}) => ({ companyId: companyA, partyId: P1, lines: [{ styleId: jkt01, colourwayId: BLK, sizes: [{ size: '50', quantity: 2 }, { size: '52', quantity: 1 }], options: [{ valueId: options.valueIds.linerYes }] }], ...extra })

  it('New order: the preview prices the options in, Confirm writes them on the line; a refused combination is said by path', async () => {
    const preview = await ok('seller', 'POST', '/sales/orders/manual/preview', body())
    expect(preview.ok, JSON.stringify(preview.problems)).toBe(true)
    expect(preview.order.lines[0]).toMatchObject({ unitPrice: '480', optionsAdd: '60' })
    const made = await ok('seller', 'POST', '/sales/orders/manual', body(), 201)
    const line = made.order.lines[0]
    expect(line.unitPrice).toBe('480')
    expect((await rowsOf('SalesOrderLineOption', line.id)).map((row) => [row.code, num(row.surchargeAmount)])).toEqual([['YES', 60]])
    const [event] = await admin<Json>(`SELECT payload FROM "OutboxEvent" WHERE type = 'sales_order.options_changed' AND subject = $1`, [made.order.id])
    expect(event!.payload).toMatchObject({ change: 'CHOSEN', lineIds: [line.id] })
    // The order line's configurator reads them as chosen.
    const view = await ok('seller', 'GET', `/sales/orders/${made.order.id}/lines/${line.id}/configurator`)
    expect(view.chosen.map((row: Json) => row.valueId)).toEqual([options.valueIds.linerYes])
    // JKT-05 with full perforation AND the liner: refused in the rule's words, by the line's path.
    const clashing = [{ styleId: jkt01, colourwayId: BLK, sizes: [{ size: '52', quantity: 1 }], options: [{ valueId: options.valueIds.perfFull }, { valueId: options.valueIds.linerYes }] }]
    const clash = await ok('seller', 'POST', '/sales/orders/manual/preview', { ...body(), lines: clashing })
    expect(clash.ok).toBe(false)
    expect(clash.problems.some((issue: Json) => issue.path.startsWith('body/lines/0/options'))).toBe(true)
    const words = await refused('seller', 'POST', '/sales/orders/manual', { ...body(), lines: clashing }, 400)
    expect(words.issues.find((issue: Json) => issue.path.startsWith('body/lines/0/options')).message).toMatch(/Full perforation/)
  })

  it("an amendment's new line takes options; an existing line keeps its own (they change in its Options)", async () => {
    const order = (await ok('seller', 'POST', '/sales/orders/manual', { ...body(), lines: [{ styleId: jkt01, colourwayId: BLK, sizes: [{ size: '50', quantity: 1 }] }] }, 201)).order
    const existing = order.lines[0]
    const lines = [{ id: existing.id }, { styleId: jkt01, colourwayId: RED, sizes: [{ size: '52', quantity: 2 }], options: [{ valueId: options.valueIds.linerYes }] }]
    const preview = await ok('seller', 'POST', `/sales/orders/${order.id}/amendments/preview`, { version: order.version, reason: 'Second colour', lines })
    expect(preview.ok, JSON.stringify(preview.problems)).toBe(true)
    const applied = await ok('seller', 'POST', `/sales/orders/${order.id}/amendments`, { version: order.version, reason: 'Second colour', lines }, 201)
    const added = applied.order.lines.find((line: Json) => line.colourwayId === RED)
    // RED's list price (430) and the liner (+60).
    expect(added.unitPrice).toBe('490')
    expect(await codesOf('SalesOrderLineOption', added.id)).toEqual(['YES'])
    const [audit] = await admin<Json>(`SELECT after FROM "AuditLog" WHERE action = 'orders.amend' AND "recordId" = $1 ORDER BY at DESC LIMIT 1`, [order.id])
    expect(audit!.after.options[0]).toMatchObject({ lineId: added.id })
    const answer = await ok('seller', 'POST', `/sales/orders/${order.id}/amendments/preview`, { version: applied.order.version, reason: 'x', lines: [{ id: existing.id, options: [{ valueId: options.valueIds.linerYes }] }, { id: added.id }] })
    expect(answer.ok).toBe(false)
    expect(answer.problems[0]).toMatchObject({ path: 'body/lines/0/options' })
  })
})

describe('the options as paper prints them (XF3:03)', () => {
  it('quote lines, order lines and work-order cells: group, value, the text, a colour or a material, in the language', async () => {
    const { gridLineId } = seeded.draftQuote
    const scope = { audience: 'office' as const, tenantId: tenant, actorId: IDS.owner! }
    await database.withScope(scope, async (client) => {
      const it = (await quoteLinesPrinted(client, [gridLineId], 'it')).get(gridLineId)!
      const en = (await quoteLinesPrinted(client, [gridLineId], 'en')).get(gridLineId)!
      expect(en.map((option) => option.group)).toEqual(expect.arrayContaining(['Thermal liner', 'Perforation']))
      expect(en.find((option) => option.text === 'ROSSI')).toBeDefined()
      expect(en.find((option) => option.material)?.material).toMatch(/SEED-LEA-100 · /)
      expect(it.length).toBe(en.length)
      const { lineId } = seeded.order
      const order = (await orderLinesPrinted(client, [lineId], 'en')).get(lineId)!
      expect(order.length).toBeGreaterThan(0)
      const cells = await cellsPrinted(client, [{ id: 'a', salesOrderLineId: lineId, optionValueIds: [] }, { id: 'b', salesOrderLineId: null, optionValueIds: [options.valueIds.perfFull] }], 'en')
      expect(cells.get('a')).toEqual(order)
      expect(cells.get('b')).toEqual([{ group: 'Perforation', value: expect.any(String) }])
    })
  })
})
