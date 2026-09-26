/**
 * CHMAP — the Mapping page's API on a real PostgreSQL (PGlite): list, read, decide, activate, freeze, and the
 * permission every route needs (`pim.manage`).
 */
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { permissionForRoute } from '../lib/auth/permissions-manifest.js'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})

describe('CHMAP — /api/pim/channel-mapping-sets', () => {
  let app: FastifyInstance
  let setId = ''
  beforeAll(async () => {
    const { default: routes } = await import('./channel-mapping-sets.routes.js')
    app = Fastify()
    await app.register(routes, { prefix: '/api' })
    await app.ready()
    const { ensureSetForForm } = await import('../services/channel-mapping/store.js')
    const row = (channelKey: string, extra: object = {}) => ({ channelKey, columnKey: channelKey, label: null, aliases: [], productTypes: [], requirement: 'optional' as const, templateRequirement: null,
      targetKind: 'channelField' as const, targetKey: channelKey, transform: [], direction: 'both' as const, state: 'mapped' as const, reason: null, decidedBy: 'rule' as const, sortOrder: 0, ...extra })
    const { set } = await ensureSetForForm({ channel: 'EBAY', marketplace: 'IT', formKind: 'EBAY_WORKBOOK', formKey: '177104', templateIdentifier: null, templateVersion: null, language: null,
      layout: { sheet: 'ebay_it', labelRow: null, keyRow: 1, dataRow: 2 }, keyFingerprint: 'fp' }, () => [row('SKU', { targetKind: 'identity', targetKey: null, requirement: 'required' }), row('aspect:Marca', { requirement: 'required', state: 'unmapped', targetKind: 'none', targetKey: null }), row('specific:team name', { targetKind: 'itemSpecific', targetKey: 'itemSpecifics.team name' })])
    setId = set.id
  }, 120_000)
  afterAll(async () => { await app?.close(); await state.db?.close() }, 30_000)

  it('every route needs pim.manage', () => {
    for (const [method, url] of [['GET', '/api/pim/channel-mapping-sets'], ['GET', '/api/pim/channel-mapping-sets/:id'], ['PATCH', '/api/pim/channel-mapping-sets/:id/fields'],
      ['POST', '/api/pim/channel-mapping-sets/:id/activate'], ['POST', '/api/pim/channel-mapping-sets/:id/versions']] as const) {
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
    expect(ignored.json().set.fields.find((f: { channelKey: string }) => f.channelKey === 'specific:team name')).toMatchObject({ state: 'ignored', decidedBy: 'owner', reason: 'Amazon workaround field' })
    await app.inject({ method: 'PATCH', url: `/api/pim/channel-mapping-sets/${setId}/fields`, payload: { channelKey: 'aspect:Marca', state: 'mapped', targetKind: 'channelField', targetKey: 'aspect_Marca' } })
    const active = await app.inject({ method: 'POST', url: `/api/pim/channel-mapping-sets/${setId}/activate` })
    expect(active.json().set).toMatchObject({ status: 'ACTIVE', counts: { requiredUnmapped: 0 } })
    const frozen = await app.inject({ method: 'PATCH', url: `/api/pim/channel-mapping-sets/${setId}/fields`, payload: { channelKey: 'specific:team name', state: 'mapped', targetKind: 'itemSpecific', targetKey: 'itemSpecifics.team name' } })
    expect(frozen.statusCode).toBe(409)
    const copy = await app.inject({ method: 'POST', url: `/api/pim/channel-mapping-sets/${setId}/versions` })
    expect(copy.json().set).toMatchObject({ version: 2, status: 'DRAFT' })
    const diff = await app.inject({ method: 'GET', url: `/api/pim/channel-mapping-sets/${copy.json().set.id}/diff/${setId}` })
    expect(diff.json().diff).toEqual({ added: [], removed: [], requirementChanged: [], decisionChanged: [] })
  })
})
