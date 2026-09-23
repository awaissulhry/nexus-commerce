import { beforeEach, expect, it, vi } from 'vitest'

/**
 * PLAN Step 3.3 (A-33, R-31) — the PARITY GATE between the two Amazon payload builders.
 *
 * The studio / cockpit feed (`applyResolvedMappingToAmazonFeed`) and the mapping cascade (`prepareMappingDispatch`) both
 * turn resolved mapping cells into Amazon attribute patches. With nothing asserting they agree, they drifted: `e0791ea9d`
 * (2026-09-14) made the studio clear an attribute by its schema selectors and the cascade kept deleting by name alone.
 * They now share `mappedAmazonRoots` + `amazonRootPatch`; this gate builds ONE fixture through BOTH callers and requires
 * the same patch for every root, so a caller that stops using the shared functions — or diverges around them — goes red.
 */
const { db, resolve, specLoad, primary } = vi.hoisted(() => ({
  db: { channelListing: { findUnique: vi.fn() }, marketplace: { findFirst: vi.fn() } }, resolve: vi.fn(), specLoad: vi.fn(), primary: vi.fn(),
}))
vi.mock('../../db.js', () => ({ default: db }))
vi.mock('../pim/mapping/resolve-batch.service.js', () => ({ resolveBatch: resolve }))
vi.mock('../pim/channel-specs/index.js', () => ({ loadAmazonSpec: specLoad }))
vi.mock('../connection-resolver.service.js', () => ({ primaryConnectionIds: primary }))
import { applyResolvedMappingToAmazonFeed, type AttributePatch } from './mapping-payload.js'
import { prepareMappingDispatch } from '../pim/mapping/prepare-dispatch.js'
import { amazonSpecFromDefinition } from '../pim/channel-specs/amazon.js'

const selected = (type = 'string') => ({ type: 'array', selectors: ['marketplace_id'], items: { type: 'object', properties: { value: { type }, marketplace_id: { const: 'IT' } } } })
const spec = amazonSpecFromDefinition({ marketplace: 'IT', productType: 'COAT', schemaDefinition: { properties: {
  part_number: selected(), model_name: selected(),
  // A compound root: two leaves, one of which the cascade may select alone.
  size: { type: 'array', selectors: ['marketplace_id'], items: { type: 'object', properties: { value: { type: 'string' }, system: { type: 'string' }, marketplace_id: { const: 'IT' } } } },
} } })

type Cell = { value: unknown; provenance?: string }
function resolution(cells: Record<string, Cell>, owned: string[] = []) {
  return {
    catalogue: { schema: { present: true }, fields: spec.fields.map(f => ({ fieldKey: f.key, label: f.label, schemaKnown: true, ...(owned.includes(f.key) ? { sourceOwner: { label: 'Listing' } } : {}) })) },
    // Every catalogue field has a cell, as the resolver gives one: a field with no value is an empty, non-override cell.
    products: [{ category: { channelCategoryId: 'COAT' }, cells: Object.fromEntries(spec.fields.map(f => [f.key, { fieldKey: f.key, errors: [], provenance: 'catalogRule', value: null, ...cells[f.key] }])) }],
  } as any
}
const leaf = (attribute: string, first = true) => spec.fields.filter(f => f.attribute === attribute).find(f => (f.path[0] === 'system') !== first)!.key

/** The studio's patch per root, whether its message came back as attributes (replace only) or as PATCH. */
function studioPatches(cells: Record<string, Cell>, roots: string[], owned: string[] = []): Record<string, AttributePatch> {
  const base = { header: { sellerId: 's' }, messages: [{ messageId: 1, operationType: 'PARTIAL_UPDATE', productType: 'COAT', attributes: {} }] }
  const message = JSON.parse(applyResolvedMappingToAmazonFeed(JSON.stringify(base), resolution(cells, owned), spec)).messages[0]
  const patches: AttributePatch[] = message.patches ?? Object.entries(message.attributes ?? {}).map(([k, value]) => ({ op: 'replace', path: `/attributes/${k}`, value }))
  return Object.fromEntries(roots.map(root => [root, patches.find(p => p.path === `/attributes/${root}`)!]))
}
/** The cascade's patch per root, for a reviewed queue item whose fields are exactly `fields`. */
async function cascadePatches(cells: Record<string, Cell>, fields: Record<string, unknown>, owned: string[] = []): Promise<Record<string, AttributePatch>> {
  resolve.mockResolvedValue(resolution(cells, owned))
  const prepared = await prepareMappingDispatch({ channelListingId: 'listing', productId: 'product', targetChannel: 'AMAZON', payload: { fields } })
  return Object.fromEntries((prepared.payload.mappingAttributePatches as AttributePatch[]).map(p => [p.path.replace('/attributes/', ''), p]))
}

beforeEach(() => {
  vi.resetAllMocks()
  db.channelListing.findUnique.mockResolvedValue({ id: 'listing', productId: 'product', channel: 'AMAZON', marketplace: 'IT', channelConnectionId: 'account', aliasKey: '' })
  db.marketplace.findFirst.mockResolvedValue({ languages: ['it'], language: null })
  primary.mockResolvedValue(new Map([['AMAZON', 'account']]))
  specLoad.mockResolvedValue(spec)
})

it('🔴 a value: both builders send the same replace', async () => {
  const cells = { [leaf('part_number')]: { value: 'XP-100' } }
  const studio = studioPatches(cells, ['part_number'])
  expect(studio.part_number).toEqual({ op: 'replace', path: '/attributes/part_number', value: [{ value: 'XP-100', marketplace_id: 'IT' }] })
  expect(await cascadePatches(cells, { [leaf('part_number')]: 'XP-100' })).toEqual(studio)
})

it('🔴 a clear: both builders delete by the schema selectors — the cascade deleted by name alone until A-33', async () => {
  const cells = { [leaf('part_number')]: { value: null, provenance: 'override' } }
  const studio = studioPatches(cells, ['part_number'])
  expect(studio.part_number).toEqual({ op: 'delete', path: '/attributes/part_number', value: [{ marketplace_id: 'IT' }] })
  expect(await cascadePatches(cells, { [leaf('part_number')]: null })).toEqual(studio)
})

it('🔴 a compound root: selecting one leaf sends the whole root, identically', async () => {
  const cells = { [leaf('size')]: { value: 'L' }, [leaf('size', false)]: { value: 'EU' } }
  const studio = studioPatches(cells, ['size'])
  expect(studio.size.value).toEqual([{ value: 'L', system: 'EU', marketplace_id: 'IT' }])
  expect(await cascadePatches(cells, { [leaf('size')]: 'L' })).toEqual(studio)
})

it('🔴 a root with a listing-owned leaf: both builders refuse it, with one sentence', async () => {
  const cells = { [leaf('size')]: { value: 'L' }, [leaf('size', false)]: { value: 'EU' } }
  const owned = [leaf('size', false)]
  expect(() => studioPatches(cells, ['size'], owned)).toThrow('The mixed ownership of size requires a structured listing edit.')
  await expect(cascadePatches(cells, { [leaf('size')]: 'L' }, owned)).rejects.toThrow('The mixed ownership of size requires a structured listing edit.')
})

it('control: two roots in one item — each root matches, and an unselected root is not sent by the cascade', async () => {
  const cells = { [leaf('part_number')]: { value: 'XP-100' }, [leaf('model_name')]: { value: 'Air' } }
  const studio = studioPatches(cells, ['part_number', 'model_name'])
  const cascade = await cascadePatches(cells, { [leaf('part_number')]: 'XP-100' })
  expect(Object.keys(cascade)).toEqual(['part_number'])
  expect(cascade.part_number).toEqual(studio.part_number)
})
