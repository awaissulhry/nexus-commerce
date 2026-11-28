import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { DRAFT_EDIT_REFUSALS } from '@nexus/factory-domain/product/drafts/refusals'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedProduct } from '../../../../../../packages/factory-db/seed/product'
import { seed as seedTwoBrands, type TwoBrandsSeed } from '../../../../../../packages/factory-db/seed/two-brands'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'

/**
 * owb-pd1 1.4 on the local stack with the app's real routes: the designer's right (S4 settle 6; base settle 5) — product.drafts.edit
 * is accepted where product.styles.manage / product.bom.manage is asked, only while the revision written is DRAFT (a style-level
 * write: while the style's newest revision is DRAFT). The product seed's jacket SEED-JKT-01 (revision 1 DRAFT, its BOM lines) and
 * the two-brands seed's SEED-JKT-B2 (revision 1 RELEASED). The designer holds the template's three product rights: product.styles.view,
 * product.bom.view, product.drafts.edit. Every name is made up. Run with `node scripts/factory/run-pg-tests.mjs product/drafts`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let brands: TwoBrandsSeed

const NS = 'owb-pd1-designer'
const seedId = (key: string): string => seedUuid(NS, key)
const tenant = seedId('tenant')
const jacket = seedId('product:style:JKT-01')
const draft = seedId('product:revision:JKT-01:1')
const scale = seedId('product:size-scale:EU-JKT')

const grant = (permissions: readonly Permission[]): Grant => ({ permissions: [...permissions], companies: 'all', sites: 'all', parties: 'all' })
const SESSIONS: Record<string, () => SessionContext> = {
  designer: () => ({ audience: 'office', tenantId: tenant, actorId: newId(), grants: [grant(['product.styles.view', 'product.bom.view', 'product.drafts.edit'])] }),
  // Reads products, keeps none: still a 403 on every write the designer may do.
  viewer: () => ({ audience: 'office', tenantId: tenant, actorId: newId(), grants: [grant(['product.styles.view', 'product.bom.view'])] }),
}

type Json = Record<string, any>
const call = (session: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
const refusalOf = (body: Json): string | null => {
  const issue = (body.error?.issues ?? []).find((entry: Json) => String(entry.path).startsWith('refusal/'))
  return issue ? String(issue.path).slice('refusal/'.length) : null
}
const bomUrl = (styleId: string, revisionId: string): string => `/product/styles/${styleId}/revisions/${revisionId}`

beforeAll(async () => {
  db = await migratedDatabase('owb_pd1_designer')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  await seedCore({ db: database, namespace: NS })
  await seedProduct({ db: database, namespace: NS })
  brands = await seedTwoBrands({ db: database, namespace: NS })
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    {
      database,
      routesRoot: fileURLToPath(new URL('../../..', import.meta.url)),
      authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])]?.() ?? null),
    },
  )
}, 180_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe("the designer's right on a product draft (owb-pd1 1.4)", () => {
  it('edits a BOM line of a DRAFT revision', async () => {
    const { bom } = await ok('designer', 'GET', `${bomUrl(jacket, draft)}/bom`)
    const line = bom.lines[0]
    const changed = (await ok('designer', 'PATCH', `${bomUrl(jacket, draft)}/bom/lines/${line.id}`, { version: bom.revision.version, placement: 'Body (designer)' })).bom
    expect(changed.lines.find((entry: Json) => entry.id === line.id).placement).toBe('Body (designer)')
    expect(changed.revision.version).toBe(bom.revision.version + 1)
  })

  it('changes the facts of a product whose newest revision is a draft', async () => {
    const { style } = await ok('designer', 'GET', `/product/styles/${jacket}`)
    const changed = (await ok('designer', 'PATCH', `/product/styles/${jacket}`, { version: style.version, description: 'A made-up touring jacket, drawn again.' })).style
    expect(changed.description).toBe('A made-up touring jacket, drawn again.')
  })

  it('is refused on a RELEASED revision, in words (409 DRAFT_ONLY)', async () => {
    const revisionId = (await ok('designer', 'GET', `/product/styles/${brands.styleId}/revisions`)).revisions.find((entry: Json) => entry.status === 'RELEASED').id
    const line = await call('designer', 'DELETE', `${bomUrl(brands.styleId, revisionId)}/bom/lines/${newId()}?version=1`)
    expect(line.statusCode, line.body).toBe(409)
    expect(refusalOf(line.json())).toBe('DRAFT_ONLY')
    expect(line.json().error.message).toBe(DRAFT_EDIT_REFUSALS.DRAFT_ONLY.en)
    // A style-level write follows the newest revision: released, so refused too.
    const { style } = await ok('designer', 'GET', `/product/styles/${brands.styleId}`)
    const facts = await call('designer', 'PATCH', `/product/styles/${brands.styleId}`, { version: style.version, description: 'Changed by the designer.' })
    expect(facts.statusCode, facts.body).toBe(409)
    expect(refusalOf(facts.json())).toBe('DRAFT_ONLY')
  })

  it('is refused on archive, release and the route (403): those stay the manage rights', async () => {
    const { style } = await ok('designer', 'GET', `/product/styles/${jacket}`)
    expect((await call('designer', 'POST', `/product/styles/${jacket}/archive`, { version: style.version })).statusCode).toBe(403)
    const { bom } = await ok('designer', 'GET', `${bomUrl(jacket, draft)}/bom`)
    expect((await call('designer', 'POST', `${bomUrl(jacket, draft)}/release`, { version: bom.revision.version })).statusCode).toBe(403)
    expect((await call('designer', 'GET', `${bomUrl(jacket, draft)}/routing`)).statusCode).toBe(403)
  })

  it('makes a new product, but not its SKUs (403 SKUS_NOT_HERE)', async () => {
    const body = { code: 'DSG-HOOD-01', name: 'Designer hoodie', productType: 'OTHER', sizeScaleId: scale, sizes: ['50', '52'], ppeCategory: 'NOT_PPE' }
    const skus = await call('designer', 'POST', '/product/styles', { ...body, generateSkus: true })
    expect(skus.statusCode, skus.body).toBe(403)
    expect(refusalOf(skus.json())).toBe('SKUS_NOT_HERE')
    const made = (await ok('designer', 'POST', '/product/styles', body, 201)).style
    expect(made).toMatchObject({ code: 'DSG-HOOD-01', status: 'DRAFT', skuCount: 0 })
    // … and starts its first revision (a new DRAFT).
    const { revision } = await ok('designer', 'POST', `/product/styles/${made.id}/revisions`, { changeNote: 'First drawing.' }, 201)
    expect(revision).toMatchObject({ revision: 1, status: 'DRAFT' })
  })

  it('leaves every one of these writes a 403 for a person without product.drafts.edit', async () => {
    const { bom } = await ok('viewer', 'GET', `${bomUrl(jacket, draft)}/bom`)
    expect((await call('viewer', 'PATCH', `${bomUrl(jacket, draft)}/bom/lines/${bom.lines[0].id}`, { version: bom.revision.version, placement: 'Body' })).statusCode).toBe(403)
    const { style } = await ok('viewer', 'GET', `/product/styles/${jacket}`)
    expect((await call('viewer', 'PATCH', `/product/styles/${jacket}`, { version: style.version, description: 'x' })).statusCode).toBe(403)
    expect((await call('viewer', 'POST', '/product/styles', { code: 'VWR-01', name: 'Viewer style', productType: 'OTHER', sizeScaleId: scale, sizes: ['50'], ppeCategory: 'NOT_PPE' })).statusCode).toBe(403)
  })
})
