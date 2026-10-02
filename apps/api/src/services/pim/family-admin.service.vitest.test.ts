/**
 * MCP full control P8 — the product families' writes (families and their attribute links) moved from families.routes.ts
 * into family-admin.service.ts, so the pages and Claude's `save-product-family` check and write the same way. Every
 * write route answers byte for byte what it answered before (goldens recorded on the route as it was), with business
 * profiles off and on: each success, and each refusal with its status and sentence.
 *
 * Created rows get random ids and database times; those are named `<id N>` and `<time>` in the goldens.
 */
import { afterAll, beforeAll, describe, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client, prisma: state.db.client }
})
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, channelSyncQueue: null, bulkJobQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, addJobSafely: vi.fn() }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(async () => undefined), refreshMany: vi.fn(), refreshInTransaction: vi.fn() } }))

import { expectGolden, freezeGoldenClock, goldenApp, inGoldenBusiness } from '../../test-support/route-golden.js'
import familiesRoutes from '../../routes/families.routes.js'

const GOLDEN = './__golden__'

function normalize(body: string): string {
  const ids = new Map<string, string>()
  return body
    .replace(/\bc[a-z0-9]{24}\b/g, (id) => {
      if (!ids.has(id)) ids.set(id, `<id ${ids.size + 1}>`)
      return ids.get(id)!
    })
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, '<time>')
}

let app: FastifyInstance
const write = (name: string, method: 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  expectGolden(app, name, url, GOLDEN, { method, ...(payload === undefined ? {} : { payload }), normalize })

beforeAll(async () => {
  freezeGoldenClock()
  const db = state.db.client
  await inGoldenBusiness(async () => {
    await db.attributeGroup.create({ data: { id: 'golden-fam-group', code: 'golden_fam_group', label: 'General' } })
    for (const [id, code] of [['golden-fam-attr-1', 'golden_size'], ['golden-fam-attr-2', 'golden_fit'], ['golden-fam-attr-3', 'golden_lining']]) {
      await db.customAttribute.create({ data: { id, code, label: code, groupId: 'golden-fam-group', type: 'text' } })
    }
    await db.productFamily.create({ data: { id: 'golden-fam-root', code: 'golden_apparel', label: 'Apparel' } })
    await db.productFamily.create({ data: { id: 'golden-fam-child', code: 'golden_jackets', label: 'Jackets', parentFamilyId: 'golden-fam-root' } })
    await db.productFamily.create({ data: { id: 'golden-fam-grandchild', code: 'golden_racing', label: 'Racing', parentFamilyId: 'golden-fam-child' } })
    await db.productFamily.create({ data: { id: 'golden-fam-other', code: 'golden_other', label: 'Other' } })
    await db.familyAttribute.create({ data: { id: 'golden-fa-root', familyId: 'golden-fam-root', attributeId: 'golden-fam-attr-1', required: true } })
    await db.familyAttribute.create({ data: { id: 'golden-fa-child', familyId: 'golden-fam-child', attributeId: 'golden-fam-attr-2', channels: ['AMAZON'] } })
  })
  app = await goldenApp([{ plugin: familiesRoutes, prefix: '/api' }])
}, 60_000)

afterAll(async () => {
  await app?.close()
  vi.useRealTimers()
})

describe('P8 — family writes answer exactly as before', () => {
  it('families: create, update, delete and their refusals', async () => {
    await write('family-create-bad-code', 'POST', '/api/families', { code: 'Bad', label: 'X' })
    await write('family-create-no-label', 'POST', '/api/families', { code: 'golden_new', label: ' ' })
    await write('family-create-parent-missing', 'POST', '/api/families', { code: 'golden_new', label: 'New', parentFamilyId: 'nope' })
    await write('family-create', 'POST', '/api/families', { code: 'golden_new', label: ' New ', description: ' d ', parentFamilyId: 'golden-fam-root' })
    await write('family-create-duplicate', 'POST', '/api/families', { code: 'golden_new', label: 'Again' })
    await write('family-update-missing', 'PATCH', '/api/families/nope', { label: 'X' })
    await write('family-update-empty-label', 'PATCH', '/api/families/golden-fam-other', { label: '' })
    await write('family-update-self-parent', 'PATCH', '/api/families/golden-fam-other', { parentFamilyId: 'golden-fam-other' })
    await write('family-update-parent-missing', 'PATCH', '/api/families/golden-fam-other', { parentFamilyId: 'nope' })
    await write('family-update-cycle', 'PATCH', '/api/families/golden-fam-root', { parentFamilyId: 'golden-fam-grandchild' })
    await write('family-update-nothing', 'PATCH', '/api/families/golden-fam-other', {})
    await write('family-update', 'PATCH', '/api/families/golden-fam-other', { label: ' Others ', description: '', parentFamilyId: 'golden-fam-root' })
    await write('family-update-to-root', 'PATCH', '/api/families/golden-fam-other', { parentFamilyId: null })
    await write('family-delete', 'DELETE', '/api/families/golden-fam-other')
    await write('family-delete-missing', 'DELETE', '/api/families/golden-fam-other')
  })

  it('family attributes: attach, update, detach and their refusals', async () => {
    await write('fa-attach-no-attribute', 'POST', '/api/families/golden-fam-child/attributes', {})
    await write('fa-attach-attribute-missing', 'POST', '/api/families/golden-fam-child/attributes', { attributeId: 'nope' })
    await write('fa-attach-family-missing', 'POST', '/api/families/nope/attributes', { attributeId: 'golden-fam-attr-3' })
    await write('fa-attach-self', 'POST', '/api/families/golden-fam-child/attributes', { attributeId: 'golden-fam-attr-2' })
    await write('fa-attach-inherited', 'POST', '/api/families/golden-fam-grandchild/attributes', { attributeId: 'golden-fam-attr-1' })
    await write('fa-attach', 'POST', '/api/families/golden-fam-grandchild/attributes', { attributeId: 'golden-fam-attr-3', required: true, channels: ['EBAY'], sortOrder: 2 })
    await write('fa-update-bad-channels', 'PATCH', '/api/family-attributes/golden-fa-child', { channels: 'EBAY' })
    await write('fa-update-nothing', 'PATCH', '/api/family-attributes/golden-fa-child', {})
    await write('fa-update', 'PATCH', '/api/family-attributes/golden-fa-child', { required: true, channels: [], sortOrder: 7 })
    await write('fa-update-missing', 'PATCH', '/api/family-attributes/nope', { required: true })
    await write('fa-detach', 'DELETE', '/api/family-attributes/golden-fa-child')
    await write('fa-detach-missing', 'DELETE', '/api/family-attributes/golden-fa-child')
  })
})
