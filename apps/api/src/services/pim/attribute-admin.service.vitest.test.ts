/**
 * MCP full control P8 — the attribute dictionary's writes (groups, attributes, options) moved from attributes.routes.ts
 * into attribute-admin.service.ts, so the pages and Claude's `save-attribute` check and write the same way. Every
 * write route answers byte for byte what it answered before (goldens recorded on the route as it was), with business
 * profiles off and on: each success, and each refusal with its status and sentence.
 *
 * Created rows get random ids and database times; those are named `<id N>` and `<time>` in the goldens, every other
 * byte is compared.
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

import { expectGolden, freezeGoldenClock, goldenApp, inGoldenBusiness } from '../../test-support/route-golden.js'
import attributesRoutes from '../../routes/attributes.routes.js'

const GOLDEN = './__golden__'

/** Random ids (cuid) by order of first appearance, and database times. */
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
    await db.attributeGroup.create({ data: { id: 'golden-group-1', code: 'golden_general', label: 'General', sortOrder: 1 } })
    await db.attributeGroup.create({ data: { id: 'golden-group-empty', code: 'golden_empty', label: 'Empty' } })
    await db.customAttribute.create({ data: { id: 'golden-attr-text', code: 'golden_material', label: 'Material', groupId: 'golden-group-1', type: 'text' } })
    await db.customAttribute.create({ data: { id: 'golden-attr-select', code: 'golden_colour', label: 'Colour', groupId: 'golden-group-1', type: 'select' } })
    await db.customAttribute.create({ data: { id: 'golden-attr-number', code: 'golden_weight', label: 'Weight', groupId: 'golden-group-1', type: 'number' } })
    await db.attributeOption.create({ data: { id: 'golden-option-red', attributeId: 'golden-attr-select', code: 'red', label: 'Red', sortOrder: 1 } })
  })
  app = await goldenApp([{ plugin: attributesRoutes, prefix: '/api' }])
}, 60_000)

afterAll(async () => {
  await app?.close()
  vi.useRealTimers()
})

describe('P8 — attribute dictionary writes answer exactly as before', () => {
  it('groups: create, update, delete and their refusals', async () => {
    await write('group-create-bad-code', 'POST', '/api/attribute-groups', { code: 'Bad Code', label: 'X' })
    await write('group-create-no-label', 'POST', '/api/attribute-groups', { code: 'golden_new', label: '  ' })
    await write('group-create', 'POST', '/api/attribute-groups', { code: 'golden_new', label: ' New group ', description: ' about ', sortOrder: 4 })
    await write('group-create-duplicate', 'POST', '/api/attribute-groups', { code: 'golden_new', label: 'Again' })
    await write('group-update-empty-label', 'PATCH', '/api/attribute-groups/golden-group-empty', { label: ' ' })
    await write('group-update-nothing', 'PATCH', '/api/attribute-groups/golden-group-empty', {})
    await write('group-update', 'PATCH', '/api/attribute-groups/golden-group-empty', { label: ' Renamed ', description: '', sortOrder: 9 })
    await write('group-update-missing', 'PATCH', '/api/attribute-groups/nope', { label: 'X' })
    await write('group-delete-in-use', 'DELETE', '/api/attribute-groups/golden-group-1')
    await write('group-delete', 'DELETE', '/api/attribute-groups/golden-group-empty')
    await write('group-delete-missing', 'DELETE', '/api/attribute-groups/golden-group-empty')
  })

  it('attributes: create and update, and every refusal', async () => {
    const base = { code: 'golden_fit', label: 'Fit', groupId: 'golden-group-1', type: 'select' }
    await write('attr-create-bad-code', 'POST', '/api/attributes', { ...base, code: '9fit' })
    await write('attr-create-no-label', 'POST', '/api/attributes', { ...base, label: '' })
    await write('attr-create-no-group', 'POST', '/api/attributes', { ...base, groupId: undefined })
    await write('attr-create-bad-type', 'POST', '/api/attributes', { ...base, type: 'colour' })
    await write('attr-create-bad-scope', 'POST', '/api/attributes', { ...base, scope: 'everywhere' })
    await write('attr-create-code-localizable', 'POST', '/api/attributes', { ...base, localizable: true })
    await write('attr-create-bad-validation', 'POST', '/api/attributes', { ...base, type: 'text', validation: { maxLength: -3 } })
    await write('attr-create-bad-concept', 'POST', '/api/attributes', { ...base, semanticKey: 'not-a-concept' })
    await write('attr-create-group-missing', 'POST', '/api/attributes', { ...base, groupId: 'nope' })
    await write('attr-create', 'POST', '/api/attributes', { ...base, label: ' Fit ', description: ' how it sits ', scope: 'per_variant', sortOrder: 3 })
    await write('attr-create-duplicate', 'POST', '/api/attributes', base)
    await write('attr-update-empty-label', 'PATCH', '/api/attributes/golden-attr-text', { label: ' ' })
    await write('attr-update-group-missing', 'PATCH', '/api/attributes/golden-attr-text', { groupId: 'nope' })
    await write('attr-update-bad-validation', 'PATCH', '/api/attributes/golden-attr-text', { validation: { maxLength: 'x' } })
    await write('attr-update-bad-concept', 'PATCH', '/api/attributes/golden-attr-text', { semanticKey: 'nope' })
    await write('attr-update-localizable-code', 'PATCH', '/api/attributes/golden-attr-select', { localizable: true })
    await write('attr-update-bad-scope', 'PATCH', '/api/attributes/golden-attr-text', { scope: 'x' })
    await write('attr-update-nothing', 'PATCH', '/api/attributes/golden-attr-text', {})
    await write('attr-update', 'PATCH', '/api/attributes/golden-attr-text', { label: ' Fabric ', description: null, localizable: true, scope: 'global', sortOrder: 2 })
    await write('attr-update-missing', 'PATCH', '/api/attributes/nope', { label: 'X' })
  })

  it('options: create, update, delete and their refusals', async () => {
    await write('option-create-bad-code', 'POST', '/api/attributes/golden-attr-select/options', { code: 'Blue!', label: 'Blue' })
    await write('option-create-no-label', 'POST', '/api/attributes/golden-attr-select/options', { code: 'blue', label: '' })
    await write('option-create-attr-missing', 'POST', '/api/attributes/nope/options', { code: 'blue', label: 'Blue' })
    await write('option-create-wrong-type', 'POST', '/api/attributes/golden-attr-number/options', { code: 'blue', label: 'Blue' })
    await write('option-create', 'POST', '/api/attributes/golden-attr-select/options', { code: 'blue', label: ' Blue ', sortOrder: 2, metadata: { hex: '#00f' } })
    await write('option-create-duplicate', 'POST', '/api/attributes/golden-attr-select/options', { code: 'blue', label: 'Blue' })
    await write('option-update-empty-label', 'PATCH', '/api/attribute-options/golden-option-red', { label: '' })
    await write('option-update-bad-synonyms', 'PATCH', '/api/attribute-options/golden-option-red', { synonyms: ['rosso', ' '] })
    await write('option-update-nothing', 'PATCH', '/api/attribute-options/golden-option-red', {})
    await write('option-update', 'PATCH', '/api/attribute-options/golden-option-red', { label: ' Scarlet ', synonyms: [' rosso ', 'rot'], sortOrder: 5, metadata: null })
    await write('option-update-archive', 'PATCH', '/api/attribute-options/golden-option-red', { archived: true })
    await write('option-update-restore', 'PATCH', '/api/attribute-options/golden-option-red', { archived: false })
    await write('option-update-missing', 'PATCH', '/api/attribute-options/nope', { label: 'X' })
    await write('option-delete', 'DELETE', '/api/attribute-options/golden-option-red')
    await write('option-delete-missing', 'DELETE', '/api/attribute-options/golden-option-red')
  })
})
