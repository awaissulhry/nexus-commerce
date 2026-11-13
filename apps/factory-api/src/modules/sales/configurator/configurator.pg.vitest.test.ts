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
import { callerFor, type CommandCaller } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { systemContext } from '../../../platform/outbox/system'
import { localFileStore } from '../../../adapters/local-files/local'
import { createFilesRuntime, useFiles } from '../../../platform/files/service'
import { createGateway } from '../../../platform/gateway/gateway'
import { testRedis, type TestRedis } from '../../../platform/outbox/testing'
import { createSecretsService } from '../../../platform/secrets/envelope'
import { localKeyProvider } from '../../../platform/secrets/local'
import { carryOptionsAfterYes } from './copy'

/**
 * B-W2b-340 on the local stack, with the app's real routes (a throwaway PostgreSQL 17 database from the migrations, the
 * runtime login: row-level security, the grants and the …_sales_pricing_w2b_guards triggers on the option rows and the
 * waterfall are real). The seeds' SEED-JKT-05 offers the liner (+60.00), perforation (front +5 %, full +40.00; full EXCLUDES
 * the liner: a BLOCK), the name on the chest (+15.00, a typed text) and the armour (one, standard by default; "without" is
 * outside the certificate, -25.00); the liner REQUIRES the standard armour (a WARN). SEED-Q-0003 (DRAFT) has JKT-05 BLK
 * configured: SUGGESTED 400 → liner 60 → front 20 → name 15 → 5 % → MANUAL -0.25 → NET 470. SEED-SO-0004 (CONFIRMED) has
 * JKT-05 with the standard armour and the liner. A seller (the sales role: price and margin, no cost grain) and the owner.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/sales/configurator/`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let seeded: SalesPricingSeed
let options: OptionsSeed
let redis: TestRedis
let localRoot = ''

const NS = 'configurator-seed'
const seedId = (key: string): string => seedUuid(NS, key)
const tenant = seedId('tenant')
const companyA = seedId('company:A')
const P1 = seedId('party:P1')
const jkt01 = seedId('product:style:JKT-01')
const BLK = seedId('product:colourway:JKT-01:BLK')

const grainsOf = (grains: readonly string[]): Permission[] => grains.map((grain) => `money.${grain}` as Permission)
const PEOPLE: Record<string, { readonly template: string; readonly dropGrains?: readonly string[]; readonly drop?: readonly string[] }> = {
  seller: { template: 'sales' },
  owner: { template: 'owner' },
  blind: { template: 'sales', dropGrains: ['price', 'margin'] },
  reader: { template: 'sales', drop: ['quotes.manage', 'orders.manage'] },
}
const IDS: Record<string, string> = Object.fromEntries(Object.keys(PEOPLE).map((key) => [key, newId()]))
const SESSIONS: Record<string, SessionContext> = Object.fromEntries(
  Object.entries(PEOPLE).map(([key, person]) => {
    const role = templateOf(person.template)!
    const grains = role.grains.filter((grain) => !(person.dropGrains ?? []).includes(grain))
    const grant: Grant = { permissions: [...role.permissions.filter((permission) => !(person.drop ?? []).includes(permission)), ...grainsOf(grains)], companies: 'all', sites: 'all', parties: 'all' }
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
const system = (): CommandCaller => callerFor(database, systemContext(tenant, newId()))
const q = (quoteId: string, lineId: string) => `/sales/quotes/${quoteId}/lines/${lineId}`
const o = (orderId: string, lineId: string) => `/sales/orders/${orderId}/lines/${lineId}`
/** A forced state (test data past its guards: the accept flow and the credit check are other steps' tests). */
const forced = async (sql: string, values: unknown[]) => {
  await db.admin.query(`SET session_replication_role = replica`)
  try {
    await db.admin.query(sql, values)
  } finally {
    await db.admin.query(`SET session_replication_role = origin`)
  }
}
const valueCodes = async (table: 'QuoteLineOption' | 'SalesOrderLineOption', lineId: string) =>
  (await admin<{ code: string }>(`SELECT v.code FROM "${table}" o JOIN "OptionValue" v ON v.id = o."valueId" WHERE o."lineId" = $1 ORDER BY v.code`, [lineId])).map((row) => row.code)

beforeAll(async () => {
  db = await migratedDatabase('configurator')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 12 } })
  await seedCore({ db: database, namespace: NS })
  await seedCompliance({ db: database, namespace: NS })
  await seedCosting({ db: database, namespace: NS })
  await seedNumbering({ db: database, namespace: NS })
  seeded = await seedSalesPricing({ db: database, namespace: NS })
  options = await seedOptions({ db: database, namespace: NS })
  await seedReasons({ db: database, namespace: NS })
  for (const key of Object.keys(PEOPLE)) await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, 'ACTIVE')`, [IDS[key], tenant, `${key}.configurator@example.com`, `Configurator ${key}`])
  // The file store: the local folder (FAKE R2 of the seed), through the gateway on the local Redis under a prefix of its own.
  redis = testRedis()
  localRoot = mkdtempSync(join(tmpdir(), 'factory-configurator-test-'))
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

describe("a quote line's configurator (SAL-133, SAL-136, SAL-139)", () => {
  it("reads the style's groups with their surcharges and rules, the chosen values, the check, the price and the choices", async () => {
    const { quoteId, gridLineId } = seeded.draftQuote
    const view = await ok('seller', 'GET', `${q(quoteId, gridLineId)}/configurator`)
    expect(view.document).toMatchObject({ kind: 'QUOTE', number: 'SEED-Q-0003', status: 'DRAFT', currency: 'EUR', priceBasis: 'NET' })
    expect(view.style.code).toBe('SEED-JKT-05')
    expect(view.groups.map((group: Json) => group.code)).toEqual(['SEED-OG-LINER', 'SEED-OG-PERF', 'SEED-OG-NAME', 'SEED-OG-ARMOUR'])
    const perf = view.groups.find((group: Json) => group.code === 'SEED-OG-PERF')
    expect(perf.values.map((value: Json) => [value.code, value.surcharge])).toEqual([
      ['FRONT', { delta: null, currency: null, percent: '5' }],
      ['FULL', { delta: '40', currency: 'EUR', percent: null }],
    ])
    expect(perf.rules[0]).toMatchObject({ kind: 'EXCLUDES', severity: 'BLOCK', valueId: options.valueIds.perfFull, otherValueId: options.valueIds.linerYes })
    expect(perf.rules[0].words.en).toMatch(/Full perforation/)
    const armour = view.groups.find((group: Json) => group.code === 'SEED-OG-ARMOUR')
    expect(armour).toMatchObject({ minPicks: 1, maxPicks: 1, defaultValueId: options.valueIds.armourStd })
    expect(armour.values.find((value: Json) => value.code === 'NONE')).toMatchObject({ outsideCertificate: true, surcharge: { delta: '-25', currency: 'EUR' } })
    expect(view.chosen).toHaveLength(4)
    expect(view.chosen.find((row: Json) => row.valueId === options.valueIds.name)).toMatchObject({ text: 'ROSSI', surchargeAmount: '15' })
    expect(view.chosen.find((row: Json) => row.valueId === options.valueIds.perfFront)).toMatchObject({ surchargeAmount: '20', surchargePct: '5' })
    // The liner asks the standard armour, which is chosen: no warning.
    expect(view.check).toMatchObject({ ok: true, blocks: [], warnings: [], outsideCertificate: false })
    expect(view.pricing).toMatchObject({ holdsOptions: true, held: null, manualKept: true })
    expect(view.line).toMatchObject({ unitPrice: '470', optionsTotal: '95' })
    // The sales role holds no cost grain: no unit cost; the margin is the margin grain.
    expect(view.line.unitCost).toBeUndefined()
    expect(view.choices.colours.map((colour: Json) => colour.code)).toEqual(['SEED-BLK', 'SEED-GRY', 'SEED-RED'])
    expect(view.choices.leathers.find((leather: Json) => leather.code === 'SEED-LEA-100').colours.map((colour: Json) => colour.code)).toEqual(['BLK', 'RED'])
    expect(view.may).toMatchObject({ configure: true, held: null, artwork: true })
    // Without the price grain: no surcharge, price or waterfall figure at all.
    const blind = await ok('blind', 'GET', `${q(quoteId, gridLineId)}/configurator`)
    expect(blind.line.unitPrice).toBeUndefined()
    expect(blind.chosen[0].surchargeAmount).toBeUndefined()
    expect(perf.values[0].surcharge).toBeDefined()
    expect(blind.groups[1].values[0].surcharge).toBeUndefined()
    // Without quotes.manage: read, held with the reason.
    const reader = await ok('reader', 'GET', `${q(quoteId, gridLineId)}/configurator`)
    expect(reader.may.configure).toBe(false)
    expect(reader.may.held.en).toMatch(/manage quotes/)
  })

  it('checks a choice without writing: the price it would make through the waterfall, the manual change kept as its amount', async () => {
    const { quoteId, gridLineId } = seeded.draftQuote
    // The liner left out: 400 + front 20 + name 15 = 435, 5 % off = 413.25, the manual -0.25 kept = 413.
    const check = await ok('seller', 'POST', `${q(quoteId, gridLineId)}/configurator/check`, { picks: [{ valueId: options.valueIds.perfFront }, { valueId: options.valueIds.name, text: 'ROSSI' }] })
    expect(check).toMatchObject({ ok: true, problem: null })
    expect(check.chosen.map((row: Json) => [row.valueId, row.byDefault, row.surchargeAmount])).toEqual([
      [options.valueIds.perfFront, false, '20'],
      [options.valueIds.name, false, '15'],
      [options.valueIds.armourStd, true, null],
    ])
    expect(check.pricing).toMatchObject({ repriced: true, held: null, manualKept: true, unitPrice: '413', before: '470', optionsTotal: '35' })
    expect(check.pricing.steps.map((step: Json) => step.kind)).toEqual(['SUGGESTED', 'OPTION', 'OPTION', 'DISCOUNT', 'MANUAL', 'SIZE_SURCHARGE', 'NET'])
    // Nothing was written.
    expect(await valueCodes('QuoteLineOption', gridLineId)).toEqual(['FRONT', 'NAME', 'STD', 'YES'])
    // A refused combination in the rule's words (not written, said).
    const clash = await ok('seller', 'POST', `${q(quoteId, gridLineId)}/configurator/check`, { picks: [{ valueId: options.valueIds.perfFull }, { valueId: options.valueIds.linerYes }] })
    expect(clash.ok).toBe(false)
    expect(clash.blocks[0]).toMatchObject({ code: 'EXCLUDES', severity: 'BLOCK' })
    expect(clash.blocks[0].message.it).not.toBe('')
    expect(clash.pricing.repriced).toBe(false)
  })

  it('writes the choice (CF1:01): refused in the rule\'s words, then frozen with its surcharges and priced again', async () => {
    const { quoteId, gridLineId } = seeded.draftQuote
    let quote = (await ok('seller', 'GET', `/sales/quotes/${quoteId}`)).quote
    const clash = await refused('seller', 'PUT', `${q(quoteId, gridLineId)}/options`, { version: quote.version, picks: [{ valueId: options.valueIds.perfFull }, { valueId: options.valueIds.linerYes }] }, 409)
    expect(clash.message).toMatch(/Full perforation/)
    const noText = await refused('seller', 'PUT', `${q(quoteId, gridLineId)}/options`, { version: quote.version, picks: [{ valueId: options.valueIds.name }] }, 409)
    expect(noText.issues.some((issue: Json) => issue.path.startsWith('body/picks/0'))).toBe(true)
    const both = await refused('seller', 'PUT', `${q(quoteId, gridLineId)}/options`, { version: quote.version, picks: [{ valueId: options.valueIds.perfFront, colourId: newId(), itemId: newId() }] }, 400)
    expect(both.message).toMatch(/library colour or a material/)
    const [red] = await admin<{ id: string }>(`SELECT id FROM "Colour" WHERE code = 'SEED-RED' AND "tenantId" = $1`, [tenant])
    const [leather] = await admin<{ id: string; colour: string }>(`SELECT i.id, c.id AS colour FROM "Item" i JOIN "ItemColour" c ON c."itemId" = i.id WHERE i.code = 'SEED-LEA-100' AND c.code = 'RED' AND i."tenantId" = $1`, [tenant])
    const saved = await ok('seller', 'PUT', `${q(quoteId, gridLineId)}/options`, {
      version: quote.version,
      picks: [{ valueId: options.valueIds.perfFront, colourId: red!.id }, { valueId: options.valueIds.name, text: 'BIANCHI', itemId: leather!.id, itemColourId: leather!.colour }],
    })
    quote = saved.quote
    expect(quote.lines.find((line: Json) => line.id === gridLineId).unitPrice).toBe('413')
    expect(saved.line.pricing).toMatchObject({ holdsOptions: true, held: null, manualKept: true })
    expect(saved.line.chosen.find((row: Json) => row.valueId === options.valueIds.perfFront)).toMatchObject({ colourId: red!.id, surchargeAmount: '20', surchargePct: '5' })
    expect(saved.line.chosen.find((row: Json) => row.valueId === options.valueIds.name)).toMatchObject({ text: 'BIANCHI', itemId: leather!.id, itemColourId: leather!.colour })
    expect(await valueCodes('QuoteLineOption', gridLineId)).toEqual(['FRONT', 'NAME', 'STD'])
    // B-W2b-330's pricing reads the same waterfall: the OPTION steps name the rows written.
    const pricing = await ok('seller', 'GET', `/sales/quotes/${quoteId}/pricing`)
    const line = pricing.lines.find((row: Json) => row.lineId === gridLineId)
    expect(line.steps.filter((step: Json) => step.kind === 'OPTION').map((step: Json) => step.delta)).toEqual(['20', '15'])
    const audit = await admin<Json>(`SELECT after FROM "AuditLog" WHERE action = 'quotes.configureLine' AND "recordId" = $1 ORDER BY at DESC, id DESC LIMIT 1`, [quoteId])
    expect(audit[0]!.after).toMatchObject({ lineId: gridLineId, newWaterfall: true, held: null })
    // The armour without protectors: outside the certificate, said by the check and by the send's line rule (a warning).
    quote = (await ok('seller', 'PUT', `${q(quoteId, gridLineId)}/options`, { version: quote.version, picks: [{ valueId: options.valueIds.perfFront }, { valueId: options.valueIds.name, text: 'BIANCHI' }, { valueId: options.valueIds.armourNone }] })).quote
    const warnings = await ok('seller', 'GET', `/sales/quotes/${quoteId}/warnings`)
    expect(warnings.warnings.find((warning: Json) => warning.code === 'OPTIONS_OUTSIDE_CERTIFICATE')).toMatchObject({ severity: 'WARNING', lineIds: [gridLineId] })
    // A stale version is refused.
    await refused('seller', 'PUT', `${q(quoteId, gridLineId)}/options`, { version: quote.version - 1, picks: [] }, 409)
    // Without quotes.manage: forbidden.
    await refused('reader', 'PUT', `${q(quoteId, gridLineId)}/options`, { version: quote.version, picks: [] }, 403)
  })

  it('a line at its list price starts its waterfall from the list; a hand-typed one keeps its price and the rule says so', async () => {
    // SEED-JKT-01 offers the liner (test data: one offer row).
    await admin(`INSERT INTO "StyleOptionGroup" (id, "tenantId", "styleId", "groupId", seq) VALUES ($1, $2, $3, $4, 10)`, [newId(), tenant, jkt01, options.groupIds.liner])
    let quote = (await ok('seller', 'POST', '/sales/quotes', { companyId: companyA, partyId: P1 }, 201)).quote
    quote = (await ok('seller', 'POST', `/sales/quotes/${quote.id}/lines`, { version: quote.version, styleId: jkt01, colourwayId: BLK, sizes: [{ size: '50', quantity: 2 }, { size: '52', quantity: 2 }] }, 201)).quote
    const atList = quote.lines[0]
    expect(atList).toMatchObject({ unitPrice: '420', listUnitPrice: '420' })
    const saved = await ok('seller', 'PUT', `${q(quote.id, atList.id)}/options`, { version: quote.version, picks: [{ valueId: options.valueIds.linerYes }] })
    quote = saved.quote
    expect(quote.lines[0].unitPrice).toBe('480')
    const steps = (await ok('seller', 'GET', `/sales/quotes/${quote.id}/pricing`)).lines[0].steps
    expect(steps.map((step: Json) => [step.kind, step.delta ?? step.unitPrice])).toEqual([['LIST', '420'], ['OPTION', '60'], ['NET', '480']])
    // A price typed by hand (W1's line edit drops the waterfall): the options stay frozen, the price is not moved.
    quote = (await ok('seller', 'PATCH', `/sales/quotes/${quote.id}/lines/${atList.id}`, { version: quote.version, unitPrice: '455', listUnitPrice: null })).quote
    expect(quote.lines[0].unitPrice).toBe('455')
    const held = await ok('seller', 'GET', `${q(quote.id, atList.id)}/configurator`)
    expect(held.pricing).toMatchObject({ holdsOptions: false, held: 'NO_START' })
    const checks = await ok('seller', 'GET', `/sales/quotes/${quote.id}/warnings`)
    expect(checks.warnings.find((warning: Json) => warning.code === 'OPTIONS_NOT_PRICED')).toMatchObject({ severity: 'WARNING' })
    quote = (await ok('seller', 'PUT', `${q(quote.id, atList.id)}/options`, { version: quote.version, picks: [] })).quote
    expect(quote.lines[0].unitPrice).toBe('455')
    expect((await ok('seller', 'GET', `${q(quote.id, atList.id)}/configurator`)).chosen).toEqual([])
  })

  it('a new version of the quote carries the options; its waterfall still holds them', async () => {
    let quote = (await ok('seller', 'POST', '/sales/quotes', { companyId: companyA, partyId: P1 }, 201)).quote
    quote = (await ok('seller', 'POST', `/sales/quotes/${quote.id}/lines`, { version: quote.version, styleId: jkt01, colourwayId: BLK, sizes: [{ size: '52', quantity: 3 }] }, 201)).quote
    quote = (await ok('seller', 'PUT', `${q(quote.id, quote.lines[0].id)}/options`, { version: quote.version, picks: [{ valueId: options.valueIds.linerYes }] })).quote
    const [version] = await admin<{ id: string }>(`SELECT id FROM "QuoteVersion" WHERE "quoteId" = $1`, [quote.id])
    await forced(`UPDATE "QuoteVersion" SET status = 'SENT', "sentAt" = now() WHERE id = $1`, [version!.id])
    await forced(`UPDATE "Quote" SET status = 'SENT' WHERE id = $1`, [quote.id])
    quote = (await ok('seller', 'GET', `/sales/quotes/${quote.id}`)).quote
    const revised = (await ok('seller', 'POST', `/sales/quotes/${quote.id}/revise`, { version: quote.version })).quote
    expect(revised.currentRevision).toBe(2)
    const line = revised.lines[0]
    expect(await valueCodes('QuoteLineOption', line.id)).toEqual(['YES'])
    const view = await ok('seller', 'GET', `${q(revised.id, line.id)}/configurator`)
    expect(view.pricing).toMatchObject({ holdsOptions: true, held: null })
    expect(view.line.unitPrice).toBe('480')
  })

  it('artwork: a PDF or a picture announced on the line (category ARTWORK), never an SVG', async () => {
    const { quoteId, gridLineId } = seeded.draftQuote
    const announced = await ok('seller', 'POST', `${q(quoteId, gridLineId)}/artwork`, { originalName: 'logo.pdf', contentType: 'application/pdf', sizeBytes: 1200, sha256: 'a'.repeat(64) }, 201)
    expect(announced.file).toMatchObject({ recordType: 'QuoteLine', recordId: gridLineId, kind: 'DOCUMENT', status: 'PENDING_UPLOAD' })
    expect(announced.upload.url).toBeTruthy()
    expect((await admin<{ category: string }>(`SELECT category::text FROM "StoredFile" WHERE id = $1`, [announced.file.id]))[0]!.category).toBe('ARTWORK')
    const view = await ok('seller', 'GET', `${q(quoteId, gridLineId)}/configurator`)
    expect(view.artwork).toEqual([expect.objectContaining({ fileId: announced.file.id, name: 'logo.pdf', from: 'LINE' })])
    const svg = await refused('seller', 'POST', `${q(quoteId, gridLineId)}/artwork`, { originalName: 'logo.svg', contentType: 'image/svg+xml', sizeBytes: 100, sha256: 'b'.repeat(64) }, 400)
    expect(svg.message).toMatch(/PDF or a picture/)
  })

  it('the bench reads a style (Test a combination)', async () => {
    const bench = await ok('seller', 'GET', `/sales/configurator/styles/${options.jacketStyleId}`)
    expect(bench.style.code).toBe('SEED-JKT-05')
    expect(bench.colourway).toBeNull()
    expect(bench.groups).toHaveLength(4)
  })
})

describe('the picks travel: to the order and the work order (CF1:03)', () => {
  let orderId = ''
  let orderLineId = ''

  it('make-order copies the accepted options; the order line reads them', async () => {
    const { versionId, gridLineId } = seeded.draftQuote
    await forced(`UPDATE "QuoteVersion" SET status = 'ACCEPTED' WHERE id = $1`, [versionId])
    await forced(`UPDATE "Quote" SET status = 'ACCEPTED' WHERE id = $1`, [seeded.draftQuote.quoteId])
    const made = await ok('seller', 'POST', '/sales/orders', { quoteVersionId: versionId }, 201)
    orderId = made.order.id
    const [line] = await admin<{ id: string }>(`SELECT id FROM "SalesOrderLine" WHERE "orderId" = $1 AND "quoteLineId" = $2`, [orderId, gridLineId])
    orderLineId = line!.id
    if (made.order.status !== 'CONFIRMED') {
      // A yes it waits for (credit, a rule): its options come with the yes.
      expect(await valueCodes('SalesOrderLineOption', orderLineId)).toEqual([])
      await forced(`UPDATE "SalesOrder" SET status = 'CONFIRMED' WHERE id = $1`, [orderId])
      expect(await carryOptionsAfterYes(system(), orderId)).toEqual({ lines: 1 })
    }
    expect(await valueCodes('SalesOrderLineOption', orderLineId)).toEqual(['FRONT', 'NAME', 'NONE'])
    const view = await ok('seller', 'GET', `${o(orderId, orderLineId)}/configurator`)
    expect(view.document).toMatchObject({ kind: 'ORDER', status: 'CONFIRMED' })
    expect(view.chosen.find((row: Json) => row.valueId === options.valueIds.name)).toMatchObject({ text: 'BIANCHI', surchargeAmount: '15' })
    // The quote line's artwork travels without a copy.
    expect(view.artwork.map((file: Json) => file.from)).toEqual(['QUOTE_LINE'])
    expect(view.may.configure).toBe(true)
  })

  it('an order keeps its accepted price: a change of what the options add is held until the price is kept', async () => {
    let view = await ok('seller', 'GET', `${o(orderId, orderLineId)}/configurator`)
    const picks = [{ valueId: options.valueIds.perfFront }, { valueId: options.valueIds.name, text: 'VERDI' }, { valueId: options.valueIds.armourNone }]
    // A new text: nothing more to pay.
    view = (await ok('seller', 'PUT', `${o(orderId, orderLineId)}/options`, { version: view.document.version, picks })).line
    expect(view.chosen.find((row: Json) => row.valueId === options.valueIds.name)).toMatchObject({ text: 'VERDI' })
    // The standard armour back: 25.00 more a piece than accepted.
    const more = [{ valueId: options.valueIds.perfFront }, { valueId: options.valueIds.name, text: 'VERDI' }]
    const check = await ok('seller', 'POST', `${o(orderId, orderLineId)}/configurator/check`, { picks: more })
    expect(check.pricing).toMatchObject({ repriced: false, change: '25' })
    const held = await refused('seller', 'PUT', `${o(orderId, orderLineId)}/options`, { version: view.document.version, picks: more }, 409)
    expect(held.message).toMatch(/keep the accepted price, or amend the order/)
    view = (await ok('seller', 'PUT', `${o(orderId, orderLineId)}/options`, { version: view.document.version, picks: more, keepPrice: true })).line
    expect(view.line.unitPrice).toBe((await admin<{ p: string }>(`SELECT trim(trailing '.' from trim(trailing '0' from "unitPrice"::text)) AS p FROM "SalesOrderLine" WHERE id = $1`, [orderLineId]))[0]!.p)
    const event = await admin<Json>(`SELECT payload FROM "OutboxEvent" WHERE type = 'sales_order.options_changed' AND subject = $1`, [orderId])
    expect(event.length).toBeGreaterThan(0)
  })

  it('a work order made from the line names its option values; the options are then frozen', async () => {
    const made = await ok('owner', 'POST', '/production/work-orders', { lines: [{ salesOrderLineId: orderLineId }] }, 201)
    const cells = await admin<{ values: string[] }>(`SELECT "optionValueIds"::text[] AS values FROM "WorkOrderSize" WHERE "workOrderId" = $1`, [made.workOrder.id])
    expect(cells.length).toBeGreaterThan(0)
    for (const cell of cells) expect([...cell.values].sort()).toEqual([options.valueIds.armourStd, options.valueIds.name, options.valueIds.perfFront].sort())
    const view = await ok('seller', 'GET', `${o(orderId, orderLineId)}/configurator`)
    expect(view.may).toMatchObject({ configure: false })
    expect(view.may.held.en).toMatch(/Work orders already make this line/)
    const frozen = await refused('seller', 'PUT', `${o(orderId, orderLineId)}/options`, { version: view.document.version, picks: [] }, 409)
    expect(frozen.message).toMatch(/Work orders already make this line/)
  })

  it("SEED-SO-0004's line reads its seeded options", async () => {
    const view = await ok('seller', 'GET', `${o(seeded.order.orderId, seeded.order.lineId)}/configurator`)
    expect(view.chosen.map((row: Json) => row.valueId).sort()).toEqual([options.valueIds.armourStd, options.valueIds.linerYes].sort())
    expect(view.check.ok).toBe(true)
  })
})
