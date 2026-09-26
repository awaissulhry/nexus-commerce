/**
 * P3b S6 (docs/attributes/PLAN.md §10.9) — "used by" and dormant.
 *
 *   · pure: what declares an attribute (concept binding, mapping rule, the channel's schema, placement), which of those
 *     channels are connected, and dormant = no connected user and no family requirement;
 *   · F1 (eBay only, no family → the starter core on Shared): the columns name only eBay; the starter attributes eBay
 *     does not use are hidden by default but still there (they can be shown again);
 *   · connecting a channel shows at once (the column caches carry the channel side of the version);
 *   · F4: a mapping rule of an eBay market makes eBay a user.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, addJobSafely: vi.fn() }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn() }, FACE_IMAGE_ORDER_BY: [], FACE_IMAGE_SELECT: {}, pickFaceImage: () => null }))
import prisma from '../../db.js'
import { withWorkspace } from '../../lib/workspace-context.js'
import { customAttributeConcepts } from '@nexus/shared/attribute-concepts'
import { createScopeFixtures, type ScopeFixture, type ScopeFixtureKey } from '../../test-support/attribute-scope-fixtures.js'
import { attributeUsages, mappedAttributeKey, usageFrom } from './attribute-usage.service.js'
import { getStudioSheet } from './studio-sheet.service.js'

describe('usageFrom — pure', () => {
  const base = { conceptChannels: new Map([['color', ['AMAZON', 'EBAY', 'SHOPIFY']]]), ruleChannels: new Map([['fit_type', new Set(['EBAY'])]]), amazonKeys: new Set(['department']) }
  const attr = (code: string, extra: Partial<{ semanticKey: string | null; placement: string; placementChannels: string[]; requirements: string[][] }> = {}) =>
    ({ code, semanticKey: null, placement: 'shared', placementChannels: [], requirements: [], ...extra })
  const usage = usageFrom({ ...base, connected: new Set(['EBAY']), attributes: [
    attr('color', { semanticKey: 'color' }), attr('fit_type'), attr('department'), attr('garmentClass'),
    attr('garmentClassRequired', { requirements: [[]] }), attr('weave', { placement: 'channel', placementChannels: ['AMAZON'] }),
  ] })
  it('a concept binding: every bound channel declares it; only the connected ones use it', () => {
    expect(usage.get('color')).toMatchObject({ declaredBy: ['AMAZON', 'EBAY', 'SHOPIFY'], usedBy: ['EBAY'], dormant: false })
  })
  it('a mapping rule and the channel schema declare it', () => {
    expect(usage.get('fit_type')).toMatchObject({ usedBy: ['EBAY'], dormant: false })
    expect(usage.get('department')).toMatchObject({ declaredBy: ['AMAZON'], usedBy: [], dormant: true })
  })
  it('nothing declares it → dormant; a family requirement keeps it out of dormant', () => {
    expect(usage.get('garmentClass')).toMatchObject({ declaredBy: [], dormant: true })
    expect(usage.get('garmentClassRequired')).toMatchObject({ requiredBy: ['*'], dormant: false })
  })
  it('placement declares it on its channels', () => {
    expect(usage.get('weave')).toMatchObject({ declaredBy: ['AMAZON'], usedBy: [], dormant: true })
  })
  it.each([
    ['categoryAttributes.color', 'color'], ['localizedContent.{locale}.material', 'material'], ['localizedContent.de.title', 'title'],
    ['size.0', 'size'], ['', null], [42, null],
  ])('mappedAttributeKey(%j) = %j', (path, key) => expect(mappedAttributeKey(path)).toBe(key))
})

describe('on PostgreSQL — the scope fixtures', () => {
  let fixtures: Record<ScopeFixtureKey, ScopeFixture>
  const sharedOf = (key: ScopeFixtureKey) => withWorkspace(fixtures[key].context, async () =>
    (await getStudioSheet({ productId: fixtures[key].productId, scope: 'master', market: 'IT', locale: 'it' } as never)).columns)
  beforeAll(async () => { fixtures = await createScopeFixtures(state.db.client) }, 300_000)
  afterAll(async () => { await state.db?.close() }, 30_000)

  it('F1 (eBay only): Shared names only eBay; the starter attributes eBay does not use are hidden by default, still there', async () => {
    const starter = customAttributeConcepts()
    const columns = (await sharedOf('F1')).filter(c => starter.some(s => s.key === c.key))
    expect(columns).toHaveLength(starter.length)
    expect([...new Set(columns.flatMap(c => c.usedBy ?? []))]).toEqual(['EBAY'])
    const notEbay = starter.filter(s => !s.bindings.EBAY?.length).map(s => s.key)
    expect(notEbay.length).toBeGreaterThan(0)
    for (const c of columns) {
      if (notEbay.includes(c.key)) expect({ key: c.key, usedBy: c.usedBy, defaultVisible: c.defaultVisible }).toEqual({ key: c.key, usedBy: [], defaultVisible: false })
      else expect({ key: c.key, usedBy: c.usedBy }).toEqual({ key: c.key, usedBy: ['EBAY'] })
    }
  }, 180_000)

  it('connecting a channel shows at once: F1 gains Amazon users on the next read', async () => {
    const before = await sharedOf('F1')
    expect(before.find(c => c.key === 'size_system')?.usedBy).toEqual([])
    await withWorkspace(fixtures.F1.context, () => prisma.channelConnection.create({ data: { channelType: 'AMAZON', managedBy: 'oauth', isActive: true, accountLabel: 'F1 AMAZON', externalAccountId: 'scope-F1-AMAZON-new' } as never }))
    const after = await sharedOf('F1')
    expect(after.find(c => c.key === 'size_system')).toMatchObject({ usedBy: ['AMAZON'] })
    expect(after.find(c => c.key === 'color')?.usedBy).toEqual(['AMAZON', 'EBAY'])
  }, 180_000)

  it('F4: a mapping rule of an eBay market makes eBay a user of the attribute it reads', async () => {
    const usageOf = () => withWorkspace(fixtures.F4.context, attributeUsages)
    expect((await usageOf()).get('pattern_type')?.usedBy ?? []).not.toContain('EBAY')
    await withWorkspace(fixtures.F4.context, () => prisma.marketplace.updateMany({ where: { channel: 'EBAY', code: 'IT' }, data: { schemaMapping: { fields: { aspect_Motivo: { source: 'categoryAttributes.pattern_type' } } } } }))
    expect((await usageOf()).get('pattern_type')?.usedBy).toContain('EBAY')
  })
})
