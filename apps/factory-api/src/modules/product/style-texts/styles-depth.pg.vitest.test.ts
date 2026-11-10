import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { gtinOf } from '@nexus/factory-domain/product/gtin/rules'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedStylesDepth, type StylesDepthSeed } from '../../../../../../packages/factory-db/seed/styles-depth'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { catalogueTextsOf } from './texts'

/**
 * Styles in depth (B-W2b-227; PRD-019 texts per language, PRD-010 private label, PRD-006 GTINs, PRD-021 where-used) through
 * the app's real routes on a throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security and
 * B-W2b-206's StyleText_check, Variant_gtin_guard and GtinRange_guard are real), seeded with the core and styles-depth seeds:
 * SEED-JKT-01 (the brand P1's, every company's, DEVELOPMENT, texts it/en/de), SEED-JKT-02 (P1's, IN_PRODUCTION under the tenant rule CHANGE_ORDER;
 * three SKUs with GTINs of the seeded block 2009999 (next reference 103), BLK 50 and RED 52 shipped in SH-0001), the work order
 * and orders of the production and shipping seeds. Made up here: styles, a range 2009997, texts. GS1 prefixes 200-299 are
 * in-store numbers, never a company's. FACTORY_ENV is test: assigning from a range is open (GATE-SPEND shuts it in staging and
 * production; factory-domain product/gtin tests it).
 * Run with `node scripts/factory/run-pg-tests.mjs modules/product/style-texts`.
 */

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH'

const NS = 'styles-depth-api'
const seedId = (key: string): string => seedUuid(NS, key)
const tenant = seedId('tenant')
const companyA = seedId('company:A')
const companyB = seedId('company:B')
const P1 = seedId('party:P1')
const user = newId()

const READS: Permission[] = ['quotes.view', 'orders.view', 'workorders.view', 'inventory.stock.view', 'pricelists.view', 'compliance.certificates.view']
const MANAGE: Permission[] = ['product.styles.view', 'product.styles.manage', 'product.styles.lifecycle', 'product.gtins.manage', ...READS]
const grant = (permissions: readonly Permission[], companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties: 'all' })
const office = (grants: Grant[]): SessionContext => ({ audience: 'office', tenantId: tenant, actorId: user, grants })
const SESSIONS: Record<string, SessionContext> = {
  manager: office([grant(MANAGE)]),
  styles: office([grant(['product.styles.view', 'product.styles.manage'])]),
  viewer: office([grant(['product.styles.view'])]),
  companyB: office([grant(MANAGE, [companyB])]),
}

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let seeded: StylesDepthSeed

const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': newId() }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
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
const events = async (type: string) => (await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id`, [tenant, type])).map((row) => row.payload)
const styleOf = async (styleId: string): Promise<Json> => (await ok('viewer', 'GET', `/product/styles/${styleId}`)).style
const newStyle = async (code: string): Promise<string> => {
  const scale = (await admin<{ id: string }>(`SELECT "sizeScaleId" AS id FROM "Style" WHERE id = $1`, [seeded.styleIds.jkt01]))[0]!.id
  const made = await ok('manager', 'POST', '/product/styles', { code, name: `Made up ${code}`, productType: 'JACKET', sizeScaleId: scale, companyId: companyA }, 201)
  return made.style.id
}

beforeAll(async () => {
  db = await migratedDatabase('product_styles_depth')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  await seedCore({ db: database, namespace: NS })
  seeded = await seedStylesDepth({ db: database, namespace: NS })
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 900_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe('names and descriptions per language (PRD-019)', () => {
  it('writes a language, falls back when one is missing, and refuses in words', async () => {
    const jkt01 = seeded.styleIds.jkt01
    const first = (await ok('viewer', 'GET', `/product/styles/${jkt01}/texts?language=fr`)).texts
    expect(first.companyLanguage).toBe('it')
    expect(first.styleNames).toHaveProperty('it')
    const seededLanguages = first.texts.map((text: Json) => text.language)
    expect(seededLanguages).toEqual(expect.arrayContaining(['it', 'en', 'de']))
    // French has no text: the company's language (Italian) answers.
    expect(first.resolved).toMatchObject({ language: 'fr', source: 'COMPANY_TEXT', from: 'it' })

    // A new language, typed loosely: stored in its BCP 47 form.
    const put = (await ok('styles', 'PUT', `/product/styles/${jkt01}/texts/FR-ch`, { name: 'Veste de course', shortDescription: 'Cuir, protections CE', longDescription: 'Ligne un\nLigne deux' })).texts
    const fr = put.texts.find((text: Json) => text.language === 'fr-CH')
    expect(fr).toMatchObject({ name: 'Veste de course', version: 1, createdById: user })
    expect(put.resolved).toMatchObject({ language: 'fr-CH', source: 'TEXT', name: 'Veste de course', longDescription: 'Ligne un\nLigne deux' })
    // Plain French falls back to Italian; Swiss French to its own row. A reader of "fr-CH" gets it, of "fr-BE" the company's.
    expect((await ok('viewer', 'GET', `/product/styles/${jkt01}/texts?language=fr-BE`)).texts.resolved).toMatchObject({ source: 'COMPANY_TEXT' })
    // Written again without its version: 409; with it: changed.
    expect((await refused('styles', 'PUT', `/product/styles/${jkt01}/texts/fr-CH`, { name: 'Autre' }, 409)).message).toMatch(/has a fr-CH text already/)
    expect((await ok('styles', 'PUT', `/product/styles/${jkt01}/texts/fr-CH`, { version: 1, name: 'Veste de course moto' })).texts.texts.find((text: Json) => text.language === 'fr-CH')).toMatchObject({ version: 2, name: 'Veste de course moto', shortDescription: null })
    expect((await refused('styles', 'PUT', `/product/styles/${jkt01}/texts/fr-CH`, { version: 1, name: 'Stale' }, 409)).code).toBe('conflict')
    // Not a language; a name on two lines; a viewer.
    expect((await refused('styles', 'PUT', `/product/styles/${jkt01}/texts/english`, { name: 'x' }, 400)).issues[0].path).toBe('params/language')
    expect((await refused('styles', 'PUT', `/product/styles/${jkt01}/texts/es`, { name: 'Una\nDos' }, 400)).issues).toEqual([{ path: 'body/name', message: 'One line, without line breaks.' }])
    await refused('viewer', 'PUT', `/product/styles/${jkt01}/texts/es`, { name: 'Chaqueta' }, 403)
    // Removed: readers fall back again.
    const removed = (await ok('styles', 'POST', `/product/styles/${jkt01}/texts/fr-CH/remove`, { version: 2 })).texts
    expect(removed.texts.map((text: Json) => text.language)).not.toContain('fr-CH')
    expect(removed.resolved).toMatchObject({ source: 'COMPANY_TEXT', from: 'it' })
    expect((await events('style.texts_changed')).map((payload) => [payload.language, payload.change])).toEqual([
      ['fr-CH', 'SET'],
      ['fr-CH', 'SET'],
      ['fr-CH', 'REMOVED'],
    ])
  })

  it('asks the style edit rule: a discontinued style (blocked) keeps its texts', async () => {
    const styleId = await newStyle('TXT-BLOCKED')
    await admin(`UPDATE "Style" SET lifecycle = 'DISCONTINUED', "lifecycleChangedById" = $2 WHERE id = $1`, [styleId, user])
    const view = (await ok('viewer', 'GET', `/product/styles/${styleId}/texts`)).texts
    expect(view.editRefusal).toMatchObject({ code: 'EDIT_BLOCKED' })
    const error = await refused('styles', 'PUT', `/product/styles/${styleId}/texts/en`, { name: 'Blocked jacket' }, 409)
    expect(error.issues[0].path).toBe('refusal/EDIT_BLOCKED')
  })

  it('gives the portal catalogue every name and the reader\'s language (labels and the tech pack read the same)', async () => {
    const texts = await database.withScope({ audience: 'office', tenantId: tenant, actorId: user }, (client) => catalogueTextsOf(client, [seeded.styleIds.jkt01], 'de'))
    const jkt01 = texts.get(seeded.styleIds.jkt01)!
    expect(jkt01.own).toMatchObject({ source: 'TEXT', from: 'de' })
    expect(Object.keys(jkt01.nameI18n).sort()).toEqual(['en', 'it'])
    expect(jkt01.names.length).toBeGreaterThanOrEqual(3)
  })
})

describe('private-label styles (PRD-010)', () => {
  it('marks the style, says who sees it and who sends its declaration, and refuses in words', async () => {
    const styleId = await newStyle('PL-ONE')
    let view = (await ok('viewer', 'GET', `/product/styles/${styleId}/private-label`)).privateLabel
    expect(view).toMatchObject({ brand: null, soldUnderOurName: false, shownTo: 'EVERY_CUSTOMER', declarationSender: 'COMPANY' })
    // Sold under our name without a brand: refused in words before the database.
    const words = await refused('styles', 'PUT', `/product/styles/${styleId}/private-label`, { version: view.style.version, brandPartyId: null, soldUnderOurName: true }, 400)
    expect(words.issues[0].message).toMatch(/name the brand it is made for/)
    view = (await ok('styles', 'PUT', `/product/styles/${styleId}/private-label`, { version: view.style.version, brandPartyId: P1, soldUnderOurName: false })).privateLabel
    expect(view).toMatchObject({ brand: { id: P1 }, shownTo: 'BRAND_ONLY', declarationSender: 'BRAND' })
    view = (await ok('styles', 'PUT', `/product/styles/${styleId}/private-label`, { version: view.style.version, brandPartyId: P1, soldUnderOurName: true })).privateLabel
    expect(view).toMatchObject({ soldUnderOurName: true, declarationSender: 'COMPANY' })
    // W1's PATCH clearing the brand of a style sold under our name: words, not a 500 (B-W2b-221's style guard).
    expect((await refused('styles', 'PATCH', `/product/styles/${styleId}`, { version: view.style.version, brandPartyId: null }, 409)).message).toMatch(/sold under our name/)
    // Both together: our own collection again.
    view = (await ok('styles', 'PUT', `/product/styles/${styleId}/private-label`, { version: view.style.version, brandPartyId: null, soldUnderOurName: false })).privateLabel
    expect(view).toMatchObject({ brand: null, shownTo: 'EVERY_CUSTOMER' })
    expect((await events('style.updated')).filter((payload) => payload.styleId === styleId).map((payload) => payload.fields)).toEqual([['brandPartyId'], ['soldUnderOurName'], ['brandPartyId', 'soldUnderOurName']])
    // A brand that is not a brand; a viewer.
    expect((await refused('styles', 'PUT', `/product/styles/${styleId}/private-label`, { version: view.style.version, brandPartyId: seedId('party:P3'), soldUnderOurName: false }, 400)).issues[0].message).toMatch(/not a brand/)
    await refused('viewer', 'PUT', `/product/styles/${styleId}/private-label`, { version: view.style.version, brandPartyId: P1, soldUnderOurName: false }, 403)
  })

  it('is the style spec: an in-production style under a change-order rule refuses it in words', async () => {
    const jkt02 = await styleOf(seeded.styleIds.jkt02)
    const error = await refused('styles', 'PUT', `/product/styles/${jkt02.id}/private-label`, { version: jkt02.version, brandPartyId: P1, soldUnderOurName: true }, 409)
    expect(error.issues[0].path).toBe('refusal/NEEDS_CHANGE_ORDER')
    const view = (await ok('viewer', 'GET', `/product/styles/${jkt02.id}/private-label`)).privateLabel
    expect(view).toMatchObject({ brand: { id: P1 }, soldUnderOurName: false, shownTo: 'BRAND_ONLY' })
  })
})

describe('GTINs (PRD-006)', () => {
  it('keeps GS1 ranges as a setting: words for a bad one, limits fixed once used, archive and restore', async () => {
    const list = await ok('viewer', 'GET', '/product/gtin-ranges')
    expect(list.allocation).toEqual({ open: true, refusal: null, message: null })
    expect(list.ranges.find((range: Json) => range.id === seeded.gtinRangeId)).toMatchObject({ gs1Prefix: '2009999', nextReference: 103, used: true, nextGtin: gtinOf('2009999', 103) })
    const bad = await refused('manager', 'POST', '/product/gtin-ranges', { companyId: companyA, name: 'Bad', gs1Prefix: '123', firstReference: 0, lastReference: 9 }, 400)
    expect(bad.issues[0]).toMatchObject({ path: 'body/gs1Prefix' })
    await refused('styles', 'POST', '/product/gtin-ranges', { companyId: companyA, name: 'No right', gs1Prefix: '2009997', firstReference: 0, lastReference: 9 }, 403)
    await refused('companyB', 'POST', '/product/gtin-ranges', { companyId: companyA, name: 'Other company', gs1Prefix: '2009997', firstReference: 0, lastReference: 9 }, 403)
    const made = (await ok('manager', 'POST', '/product/gtin-ranges', { companyId: companyA, name: 'Made-up block', gs1Prefix: '2009997', firstReference: 10, lastReference: 12 }, 201)).range
    expect(made).toMatchObject({ nextReference: 10, left: 3, used: false })
    // Unused: its limits change, its first reference only up (the next one never goes back).
    expect((await refused('manager', 'PATCH', `/product/gtin-ranges/${made.id}`, { version: made.version, firstReference: 0 }, 409)).message).toMatch(/moves only up/)
    const widened = (await ok('manager', 'PATCH', `/product/gtin-ranges/${made.id}`, { version: made.version, firstReference: 11, lastReference: 20 })).range
    expect(widened).toMatchObject({ firstReference: 11, nextReference: 11, left: 10 })
    // The seeded block gave numbers: its limits stay (words, not the database's refusal).
    const seededRange = list.ranges.find((range: Json) => range.id === seeded.gtinRangeId)
    expect((await refused('manager', 'PATCH', `/product/gtin-ranges/${seeded.gtinRangeId}`, { version: seededRange.version, lastReference: 2000 }, 409)).message).toMatch(/has given 3 GTIN/)
    const archived = (await ok('manager', 'POST', `/product/gtin-ranges/${made.id}/archive`, { version: widened.version })).range
    expect(archived.status).toBe('ARCHIVED')
    expect((await ok('manager', 'POST', `/product/gtin-ranges/${made.id}/restore`, { version: archived.version })).range.status).toBe('ACTIVE')
    expect((await events('gtin_range.changed')).map((payload) => payload.change)).toEqual(['CREATED', 'UPDATED', 'ARCHIVED', 'RESTORED'])
  })

  it("imports a brand's own barcodes: every row checked first, written all together, a shipped SKU's GTIN kept", async () => {
    const jkt02 = await styleOf(seeded.styleIds.jkt02)
    const shipped = seeded.gtins[0]!
    const free = jkt02.skus.filter((sku: Json) => sku.gtin === null && sku.status === 'ACTIVE')
    expect(free.length).toBeGreaterThanOrEqual(3)
    const typed = gtinOf('2009999', 103) // the seeded block's next number, typed by hand: the range will skip it.
    const rows = [
      { sku: free[0].sku, gtin: typed.replace(/(\d{3})(\d{4})/, '$1 $2 ') },
      { sku: shipped.sku, gtin: null },
      { sku: 'NO-SUCH-SKU', gtin: '2009999001041' },
    ]
    const dry = (await ok('styles', 'POST', '/product/gtins/import', { rows, dryRun: true })).import
    expect(dry.rows.map((row: Json) => row.outcome)).toEqual(['SET', 'REFUSED', 'REFUSED'])
    expect(dry.rows[1].message).toMatch(/keeps its GTIN .*: garments with it have shipped/)
    expect(dry.counts).toEqual({ set: 1, cleared: 0, unchanged: 0, refused: 2 })
    // Applied while a row is refused: nothing is written.
    const error = await refused('styles', 'POST', '/product/gtins/import', { rows, dryRun: false }, 400)
    expect(error.issues.map((issue: Json) => issue.path)).toEqual(['body/rows/1', 'body/rows/2'])
    expect((await styleOf(jkt02.id)).skus.find((sku: Json) => sku.id === free[0].id).gtin).toBeNull()
    const applied = (await ok('styles', 'POST', '/product/gtins/import', { rows: [rows[0]], dryRun: false })).import
    expect(applied).toMatchObject({ applied: true, counts: { set: 1 } })
    expect((await styleOf(jkt02.id)).skus.find((sku: Json) => sku.id === free[0].id).gtin).toBe(typed)
    // The same GTIN on another SKU: refused.
    expect((await ok('styles', 'POST', '/product/gtins/import', { rows: [{ sku: free[1].sku, gtin: typed }], dryRun: true })).import.rows[0].message).toMatch(/is on SKU .* already/)
    await refused('viewer', 'POST', '/product/gtins/import', { rows, dryRun: true }, 403)
  })

  it("W1's PATCH of a shipped SKU's GTIN answers in words, not a 500", async () => {
    const jkt02 = await styleOf(seeded.styleIds.jkt02)
    const shipped = jkt02.skus.find((sku: Json) => sku.id === seeded.gtins[0]!.variantId)
    const error = await refused('styles', 'PATCH', `/product/styles/${jkt02.id}/skus/${shipped.id}`, { version: shipped.version, gtin: '2009999001041' }, 409)
    expect(error.message).toMatch(new RegExp(`SKU ${shipped.sku} keeps its GTIN ${shipped.gtin}: garments with it have shipped`))
  })

  it('assigns from a range after a preview, skips a GTIN already on a SKU, never gives one twice', async () => {
    const jkt02 = await styleOf(seeded.styleIds.jkt02)
    const preview = (await ok('manager', 'POST', `/product/styles/${jkt02.id}/gtins/assign`, { rangeId: seeded.gtinRangeId, dryRun: true })).assignment
    const waiting = jkt02.skus.filter((sku: Json) => sku.gtin === null && sku.status === 'ACTIVE')
    expect(preview.count).toBe(waiting.length)
    expect(preview.skipped).toEqual([{ reference: 103, gtin: gtinOf('2009999', 103) }])
    expect(preview.assignments[0]).toMatchObject({ reference: 104, gtin: gtinOf('2009999', 104) })
    expect(preview.allocation.open).toBe(true)
    // Without the preview's figures, or as someone who may only type barcodes: refused.
    expect((await refused('manager', 'POST', `/product/styles/${jkt02.id}/gtins/assign`, { rangeId: seeded.gtinRangeId, dryRun: false }, 400)).message).toBe('Preview first.')
    await refused('styles', 'POST', `/product/styles/${jkt02.id}/gtins/assign`, { rangeId: seeded.gtinRangeId, dryRun: true }, 403)
    // The preview no longer matches (a count other than shown): preview again.
    expect((await refused('manager', 'POST', `/product/styles/${jkt02.id}/gtins/assign`, { rangeId: seeded.gtinRangeId, dryRun: false, rangeVersion: preview.rangeVersion, count: preview.count + 1 }, 409)).message).toMatch(/preview again/)
    const done = (await ok('manager', 'POST', `/product/styles/${jkt02.id}/gtins/assign`, { rangeId: seeded.gtinRangeId, dryRun: false, rangeVersion: preview.rangeVersion, count: preview.count })).assignment
    expect(done).toMatchObject({ dryRun: false, count: preview.count, range: { nextReference: 104 + preview.count } })
    const after = await styleOf(jkt02.id)
    for (const entry of preview.assignments) expect(after.skus.find((sku: Json) => sku.id === entry.skuId).gtin).toBe(entry.gtin)
    // The old preview again: the range moved on (its version), refused.
    await refused('manager', 'POST', `/product/styles/${jkt02.id}/gtins/assign`, { rangeId: seeded.gtinRangeId, dryRun: false, rangeVersion: preview.rangeVersion, count: preview.count }, 409)
    // Nothing left to number on this style.
    expect((await ok('manager', 'POST', `/product/styles/${jkt02.id}/gtins/assign`, { rangeId: seeded.gtinRangeId, dryRun: true })).assignment.count).toBe(0)
    // Another company's style takes no number of company A's range.
    const scale = (await admin<{ id: string }>(`SELECT "sizeScaleId" AS id FROM "Style" WHERE id = $1`, [seeded.styleIds.jkt01]))[0]!.id
    const other = (await ok('manager', 'POST', '/product/styles', { code: 'GT-OTHER', name: 'Company B style', productType: 'JACKET', sizeScaleId: scale, companyId: companyB }, 201)).style
    expect((await refused('manager', 'POST', `/product/styles/${other.id}/gtins/assign`, { rangeId: seeded.gtinRangeId, dryRun: true }, 400)).issues[0].message).toMatch(/its own company's ranges/)
    const range = (await admin<{ next: number }>(`SELECT "nextReference" AS next FROM "GtinRange" WHERE id = $1`, [seeded.gtinRangeId]))[0]!
    expect(range.next).toBe(104 + preview.count)
    expect((await events('style.skus_changed')).filter((payload) => payload.styleId === jkt02.id).map((payload) => payload.updated)).toEqual([1, preview.count])
  })
})

describe('where a style is used (PRD-021)', () => {
  it('lists each kind the person may read, open first, without money; a kind it may not read says nothing', async () => {
    const whereUsed = (await ok('manager', 'GET', `/product/styles/${seeded.styleIds.jkt02}/where-used`)).whereUsed
    expect(whereUsed.style).toMatchObject({ code: 'SEED-JKT-02', brand: { id: P1 } })
    const group = (kind: string) => whereUsed.groups.find((entry: Json) => entry.kind === kind)
    expect(whereUsed.groups.map((entry: Json) => entry.kind)).toEqual(['QUOTES', 'SALES_ORDERS', 'WORK_ORDERS', 'STOCK', 'PRICE_LISTS', 'SAMPLE_ROUNDS', 'CERTIFICATES'])
    expect(whereUsed.groups.every((entry: Json) => entry.allowed)).toBe(true)
    expect(group('SALES_ORDERS').count).toBeGreaterThan(0)
    expect(group('WORK_ORDERS').count).toBeGreaterThan(0)
    expect(group('SALES_ORDERS').rows.some((row: Json) => row.party?.id === P1)).toBe(true)
    expect(JSON.stringify(whereUsed)).not.toMatch(/"(unitPrice|price|cost\w*|amount\w*|charge\w*|margin\w*)":/i)
    // The style library only: the style, and its sample rounds; every other kind not allowed, no count.
    const viewer = (await ok('viewer', 'GET', `/product/styles/${seeded.styleIds.jkt02}/where-used`)).whereUsed
    expect(viewer.groups.filter((entry: Json) => entry.allowed).map((entry: Json) => entry.kind)).toEqual(['SAMPLE_ROUNDS'])
    expect(viewer.groups.find((entry: Json) => entry.kind === 'SALES_ORDERS')).toEqual({ kind: 'SALES_ORDERS', allowed: false, count: 0, open: 0, rows: [], more: false, onHand: null })
    // Another company's people do not find company A's style (the seeded styles are every company's).
    const own = await newStyle('WU-A')
    expect((await ok('manager', 'GET', `/product/styles/${own}/where-used`)).whereUsed.groups.every((entry: Json) => entry.count === 0)).toBe(true)
    await refused('companyB', 'GET', `/product/styles/${own}/where-used`, undefined, 404)
  })
})
