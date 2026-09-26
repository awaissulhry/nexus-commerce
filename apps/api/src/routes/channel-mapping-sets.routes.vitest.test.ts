/**
 * CHMAP — the Mapping page's API on a real PostgreSQL (PGlite): list, read, decide, activate, freeze, and the
 * permission every route needs (`pim.manage`).
 */
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { permissionForRoute } from '../lib/auth/permissions-manifest.js'
import { withWorkspace } from '../lib/workspace-context.js'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})

// Profiles ON (production): every request and store call runs inside a business, as the global workspace preHandler does.
const PROFILES_ON = process.env.NEXUS_WORKSPACES_ENABLED === '1'
const scope = { workspaceId: 'CHMAP-A', actorUserId: null, membershipId: null, roleKeys: [] }
const inBusiness = <T>(work: () => Promise<T>) => (PROFILES_ON ? withWorkspace(scope, work) : work())

describe('CHMAP — /api/pim/channel-mapping-sets', () => {
  let app: FastifyInstance
  let setId = ''
  beforeAll(async () => {
    const { default: routes } = await import('./channel-mapping-sets.routes.js')
    app = Fastify()
    app.addHook('preHandler', (_request, _reply, done) => { if (PROFILES_ON) withWorkspace(scope, done); else done() })
    await app.register(routes, { prefix: '/api' })
    await app.ready()
    const { ensureSetForForm } = await import('../services/channel-mapping/store.js')
    const row = (channelKey: string, extra: object = {}) => ({ channelKey, columnKey: channelKey, label: null, aliases: [], productTypes: [], requirement: 'optional' as const, templateRequirement: null,
      targetKind: 'channelField' as const, targetKey: channelKey, transform: [], direction: 'both' as const, state: 'mapped' as const, reason: null, decidedBy: 'rule' as const, sortOrder: 0, ...extra })
    if (PROFILES_ON) await state.db.db.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP)`, [scope.workspaceId])
    const { set } = await inBusiness(() => ensureSetForForm({ channel: 'EBAY', marketplace: 'IT', formKind: 'EBAY_WORKBOOK', formKey: '177104', templateIdentifier: null, templateVersion: null, language: null,
      layout: { sheet: 'ebay_it', labelRow: null, keyRow: 1, dataRow: 2 }, keyFingerprint: 'fp' }, () => [row('SKU', { targetKind: 'identity', targetKey: null, requirement: 'required' }), row('aspect:Marca', { requirement: 'required', state: 'unmapped', targetKind: 'none', targetKey: null }), row('specific:team name', { targetKind: 'itemSpecific', targetKey: 'itemSpecifics.team name' })]))
    setId = set.id
  }, 120_000)
  afterAll(async () => { await app?.close(); await state.db?.close() }, 30_000)

  it('every route needs pim.manage', () => {
    for (const [method, url] of [['GET', '/api/pim/channel-mapping-sets'], ['GET', '/api/pim/channel-mapping-sets/:id'], ['PATCH', '/api/pim/channel-mapping-sets/:id/fields'],
      ['POST', '/api/pim/channel-mapping-sets/:id/activate'], ['POST', '/api/pim/channel-mapping-sets/:id/versions'], ['GET', '/api/pim/channel-mapping-sets/:id/push-impact']] as const) {
      expect(permissionForRoute(method, url)).toBe(permissionForRoute('POST', '/api/pim/channel-mapping/:channel/:code/impact'))
      expect(permissionForRoute(method, url)).toBeTruthy()
    }
  })

  it('lists and reads a version with its counters', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/pim/channel-mapping-sets?channel=ebay' })
    expect(list.statusCode).toBe(200)
    expect(list.json().sets[0]).toMatchObject({ id: setId, status: 'DRAFT', counts: { fields: 3, requiredUnmapped: 1 } })
    const one = await app.inject({ method: 'GET', url: `/api/pim/channel-mapping-sets/${setId}` })
    expect(one.json().set.fields.map((f: { channelKey: string }) => f.channelKey)).toEqual(['SKU', 'aspect:Marca', 'specific:team name'])
    expect((await app.inject({ method: 'GET', url: '/api/pim/channel-mapping-sets/nope' })).statusCode).toBe(404)
  })

  it('refuses activation with a required column open, then decides, activates and freezes', async () => {
    const blocked = await app.inject({ method: 'POST', url: `/api/pim/channel-mapping-sets/${setId}/activate` })
    expect(blocked.statusCode).toBe(409)
    expect(blocked.json().error).toContain('aspect:Marca')
    const noReason = await app.inject({ method: 'PATCH', url: `/api/pim/channel-mapping-sets/${setId}/fields`, payload: { channelKey: 'specific:team name', state: 'ignored' } })
    expect(noReason.statusCode).toBe(400)
    const ignored = await app.inject({ method: 'PATCH', url: `/api/pim/channel-mapping-sets/${setId}/fields`, payload: { channelKey: 'specific:team name', state: 'ignored', reason: 'Amazon workaround field' } })
    // The column keeps its target: the push must know which field the Owner stopped.
    expect(ignored.json().set.fields.find((f: { channelKey: string }) => f.channelKey === 'specific:team name')).toMatchObject({ state: 'ignored', decidedBy: 'owner', reason: 'Amazon workaround field', targetKind: 'itemSpecific', targetKey: 'itemSpecifics.team name' })
    await app.inject({ method: 'PATCH', url: `/api/pim/channel-mapping-sets/${setId}/fields`, payload: { channelKey: 'aspect:Marca', state: 'mapped', targetKind: 'channelField', targetKey: 'aspect_Marca' } })
    // CHMAP M4 — the difference list before activation: the push stops sending the specific the Owner ignored.
    const impact = await app.inject({ method: 'GET', url: `/api/pim/channel-mapping-sets/${setId}/push-impact` })
    expect(impact.json().impact).toMatchObject({ stops: ['item specific “team name”'], starts: [], kept: [], listings: 0, replaces: null })
    expect((await app.inject({ method: 'GET', url: '/api/pim/channel-mapping-sets/nope/push-impact' })).statusCode).toBe(404)
    const active = await app.inject({ method: 'POST', url: `/api/pim/channel-mapping-sets/${setId}/activate` })
    expect(active.json().set).toMatchObject({ status: 'ACTIVE', counts: { requiredUnmapped: 0 } })
    // Retiring the ACTIVE version would make the push send the specific again: the Retire confirmation says so.
    const retire = await app.inject({ method: 'GET', url: `/api/pim/channel-mapping-sets/${setId}/push-impact?on=retire` })
    expect(retire.json().impact).toMatchObject({ stops: [], starts: ['item specific “team name”'], replaces: null })
    const frozen = await app.inject({ method: 'PATCH', url: `/api/pim/channel-mapping-sets/${setId}/fields`, payload: { channelKey: 'specific:team name', state: 'mapped', targetKind: 'itemSpecific', targetKey: 'itemSpecifics.team name' } })
    expect(frozen.statusCode).toBe(409)
    const copy = await app.inject({ method: 'POST', url: `/api/pim/channel-mapping-sets/${setId}/versions` })
    expect(copy.json().set).toMatchObject({ version: 2, status: 'DRAFT' })
    const diff = await app.inject({ method: 'GET', url: `/api/pim/channel-mapping-sets/${copy.json().set.id}/diff/${setId}` })
    expect(diff.json().diff).toEqual({ added: [], removed: [], requirementChanged: [], decisionChanged: [] })
    // The copy undoes the Owner's ignore: against the ACTIVE v1, the push starts sending the specific again.
    await app.inject({ method: 'PATCH', url: `/api/pim/channel-mapping-sets/${copy.json().set.id}/fields`, payload: { channelKey: 'specific:team name', state: 'mapped', targetKind: 'itemSpecific', targetKey: 'itemSpecifics.team name' } })
    const back = await app.inject({ method: 'GET', url: `/api/pim/channel-mapping-sets/${copy.json().set.id}/push-impact` })
    expect(back.json().impact).toMatchObject({ stops: [], starts: ['item specific “team name”'], replaces: 1 })
  })

  it('NCF — a Shopify product-CSV version: its targets are the store’s fields, and it exports only when ACTIVE', async () => {
    const { ensureSetForForm } = await import('../services/channel-mapping/store.js')
    const { buildShopifyDraftFields, shopifyChannelKeyOf } = await import('../services/channel-mapping/shopify-draft.js')
    const { shopifyFormOf } = await import('../services/channel-mapping/form.js')
    const headers = ['Handle', 'Title', 'Option1 Name', 'Option1 Value', 'Variant SKU', 'Variant Price', 'Status']
    const { set } = await inBusiness(() => ensureSetForForm(shopifyFormOf({ accountId: 'store-1', channelKeys: headers.map(shopifyChannelKeyOf) }), () => buildShopifyDraftFields(headers)))
    const targets = (await app.inject({ method: 'GET', url: `/api/pim/channel-mapping-sets/${set.id}/targets` })).json()
    expect(targets.targets.map((t: { key: string }) => t.key)).toEqual(expect.arrayContaining(['title', 'descriptionHtml', 'vendor', 'seo_title', 'barcode']))
    expect(targets.missingSchemas).toEqual(['this store’s field list (metafields)'])
    const draft = await app.inject({ method: 'POST', url: `/api/pim/channel-mapping-sets/${set.id}/export`, payload: { skus: ['X'] } })
    expect(draft.statusCode).toBe(409)
    expect(draft.json().error).toBe('Activate version 1 before exporting with it.')
    expect((await app.inject({ method: 'POST', url: `/api/pim/channel-mapping-sets/${set.id}/activate` })).json().set.status).toBe('ACTIVE')
    const none = await app.inject({ method: 'POST', url: `/api/pim/channel-mapping-sets/${set.id}/export`, payload: { skus: [] } })
    expect(none.statusCode).toBe(400)
    expect(none.json().error).toBe('Choose the products to export')
  })
})
