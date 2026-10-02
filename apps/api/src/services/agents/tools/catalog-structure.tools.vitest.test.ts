/**
 * MCP full control P5 — catalog-structure and channel-mappings, run through the one door (call-tool.ts) against a
 * real PostgreSQL with the production schema and the business-isolation policies (PGlite). No mocked query.
 *
 * Proven here: each kind reads what the business holds and leaves out what is archived, inactive or deleted; search
 * narrows; every page is walked with nothing twice and nothing missed; a changed cursor is refused; a bad kind is a
 * wrongly made call; a person without products.view is refused; and (profiles on) another business's structure never
 * shows. Run with business profiles off and with NEXUS_WORKSPACES_ENABLED=1.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))
// The registry loads every tool, and a change tool imports the queues: no Redis here.
vi.mock('../../../lib/queue.js', () => ({ outboundSyncQueue: null, bulkJobQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn() }))

import { callTool, ToolAccessError, type UserPrincipal } from '../call-tool.js'

const A = LEGACY_WORKSPACE_ID
const B = 'ws_p5_structure_bravo'
const ON = process.env.NEXUS_WORKSPACES_ENABLED === '1'
const PERSON = 'u-p5-structure'

const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inside = <T>(workspaceId: string, work: () => Promise<T>) => withWorkspace(business(workspaceId), work)

function principal(permissions: string[], workspaceId = A): UserPrincipal {
  return {
    kind: 'user',
    userId: PERSON,
    label: 'P5 test',
    permissions: { isOwner: false, permissions: new Set(permissions) },
    // Profiles off: no business on the principal, as the door runs then; the legacy business answers.
    ...(ON ? { workspace: business(workspaceId) } : {}),
    via: 'claude',
  }
}
const everything = (workspaceId = A) => principal([...Object.values(FEATURES), ...Object.values(FIELDS)], workspaceId)

type Row = Record<string, any>
interface Answer { ok: boolean; error?: string; data?: { kind: string; items: Row[]; nextCursor: string | null; total: number; hint?: string } }

async function call(tool: string, args: Record<string, unknown>, who: UserPrincipal = everything()): Promise<Answer> {
  return (await callTool(who, tool, args)).visible as Answer
}

async function refusal(tool: string, args: Record<string, unknown>, who: UserPrincipal = everything()) {
  try {
    await callTool(who, tool, args)
    return null
  } catch (error) {
    if (error instanceof ToolAccessError) return error.code
    throw error
  }
}

/** Every page of a list, following nextCursor. */
async function walk(tool: string, args: Record<string, unknown>, limit: number) {
  const items: Row[] = []
  let cursor: string | null = null
  let pages = 0
  do {
    const answer: Answer = await call(tool, { ...args, limit, ...(cursor ? { cursor } : {}) })
    expect(answer.ok, answer.error).toBe(true)
    expect(answer.data!.items.length).toBeLessThanOrEqual(limit)
    items.push(...answer.data!.items)
    cursor = answer.data!.nextCursor
    pages++
  } while (cursor && pages < 50)
  return { items, pages }
}

async function seed(workspaceId: string, mark: string) {
  await inside(workspaceId, async () => {
    const db = database.client
    const group = await db.attributeGroup.create({ data: { code: `${mark.toLowerCase()}_group`, label: `${mark} Fit` } })
    const colour = await db.customAttribute.create({ data: { code: `${mark.toLowerCase()}_colour`, label: `${mark} Colour`, groupId: group.id, type: 'select' } })
    await db.attributeOption.create({ data: { attributeId: colour.id, code: 'red', label: 'Red' } })
    await db.attributeOption.create({ data: { attributeId: colour.id, code: 'old', label: 'Old colour', archivedAt: new Date() } })
    for (let n = 1; n <= 6; n++) {
      await db.customAttribute.create({ data: { code: `${mark.toLowerCase()}_attr_${n}`, label: `${mark} Attribute ${n}`, groupId: group.id, type: 'text' } })
    }
    await db.customAttribute.create({ data: { code: `${mark.toLowerCase()}_archived`, label: `${mark} Archived`, groupId: group.id, type: 'text', archivedAt: new Date() } })
    const workflow = await db.productWorkflow.create({ data: { code: `${mark.toLowerCase()}_flow`, label: `${mark} Flow` } })
    const draft = await db.workflowStage.create({ data: { workflowId: workflow.id, code: 'draft', label: 'Draft', isInitial: true, sortOrder: 1 } })
    await db.workflowStage.create({ data: { workflowId: workflow.id, code: 'live', label: 'Live', isTerminal: true, isPublishable: true, sortOrder: 2 } })
    const family = await db.productFamily.create({ data: { code: `${mark.toLowerCase()}_jackets`, label: `${mark} Jackets`, workflowId: workflow.id } })
    await db.familyAttribute.create({ data: { familyId: family.id, attributeId: colour.id, required: true, channels: [] } })
    const root = await db.category.create({ data: { slug: `${mark.toLowerCase()}-clothing`, name: { en: `${mark} Clothing` } } })
    await db.category.create({ data: { slug: 'jackets', parentId: root.id, depth: 1, name: { en: 'Jackets', it: 'Giacche' } } })
    await db.category.create({ data: { slug: 'retired', name: { en: `${mark} Retired` }, isActive: false } })
    const live = await db.product.create({ data: { sku: `${mark}-TEST-SKU-1`, name: `${mark} jacket`, basePrice: '10.00', productType: `${mark}_JACKET`, familyId: family.id, workflowStageId: draft.id } })
    const gone = await db.product.create({ data: { sku: `${mark}-TEST-SKU-2`, name: `${mark} gone`, basePrice: '10.00', productType: `${mark}_GONE`, familyId: family.id, deletedAt: new Date() } })
    const tag = await db.tag.create({ data: { name: `${mark} Winter` } })
    await db.productTag.create({ data: { productId: live.id, tagId: tag.id } })
    await db.productTag.create({ data: { productId: gone.id, tagId: tag.id } })
    await db.wizardTemplate.create({ data: { name: `${mark} eBay preset`, channels: [{ platform: 'EBAY', marketplace: 'IT' }], defaults: { price: 99 } } })
    await db.marketplace.create({
      data: {
        channel: 'EBAY', code: 'IT', name: 'eBay Italy', region: 'EU', currency: 'EUR', language: 'it', languages: ['it'], marketplaceId: 'EBAY_IT',
        schemaMapping: {
          version: 3,
          fields: {
            title: { source: 'name', transforms: [{ type: 'truncate', max: 80 }], required: true, notes: `${mark} title rule` },
            'ItemSpecifics.Brand': { source: 'brand', fallback: 'manufacturer' },
          },
          byProductType: { [`${mark}_JACKET`]: { 'ItemSpecifics.Colour': { source: 'attributes.colour', transforms: [{ type: 'valueMap', attribute: 'colour' }] } } },
          expressions: { [`${mark}_margin`]: 'round($price * 1.2, 2)' },
        },
      },
    })
    await db.fieldValueMap.create({ data: { channel: 'EBAY', marketplace: 'IT', attribute: 'colour', fromValue: 'Rosso', toValue: `${mark} Red` } })
    await db.fieldValueMap.create({ data: { channel: 'EBAY', marketplace: '*', attribute: 'colour', fromValue: 'Blu', toValue: 'Blue' } })
    await db.bulkOperation.create({
      data: { userId: PERSON, productCount: 3, changeCount: 1, status: 'MAPPING_REVIEW', total: 3, processed: 3, changes: { channel: 'EBAY', market: 'IT', counts: { changed: 2, invalid: 0 } } },
    })
    await db.bulkOperation.create({
      data: { userId: 'someone-else', productCount: 1, changeCount: 1, status: 'MAPPING_REVIEW', changes: { channel: 'EBAY', market: 'IT', counts: { changed: 9 } } },
    })
  })
}

beforeAll(async () => {
  database = await formulaDatabase()
  await seed(A, 'ALPHA')
  if (ON) {
    // Row-level security admits rows only for a business that exists and is active.
    const owner = await database.client.userProfile.create({ data: { email: 'p5-structure-owner@example.test', status: 'active' } })
    await database.client.workspace.create({ data: { id: B, name: 'Bravo structure business', createdByUserId: owner.id, creationKey: 'p5-structure-bravo' } })
    await seed(B, 'BRAVO')
  }
}, 120_000)

afterAll(async () => {
  await database?.close()
}, 30_000)

describe('catalog-structure', () => {
  it('attributes: the live dictionary with its group, options and families; archived attributes and options left out', async () => {
    const { items } = await walk('catalog-structure', { kind: 'attributes' }, 3)
    expect(items.map((item) => item.code)).toEqual([
      'alpha_attr_1', 'alpha_attr_2', 'alpha_attr_3', 'alpha_attr_4', 'alpha_attr_5', 'alpha_attr_6', 'alpha_colour',
    ])
    expect(items.find((item) => item.code === 'alpha_colour')).toMatchObject({ label: 'ALPHA Colour', group: 'ALPHA Fit', type: 'select', options: 1, firstOptions: ['Red'], inFamilies: 1 })
  })

  it('search narrows, and every other kind reads what the business holds', async () => {
    expect((await call('catalog-structure', { kind: 'attributes', search: 'colour' })).data!.items.map((item) => item.code)).toEqual(['alpha_colour'])
    expect((await call('catalog-structure', { kind: 'groups' })).data!.items).toEqual([expect.objectContaining({ code: 'alpha_group', attributes: 7 })])
    expect((await call('catalog-structure', { kind: 'families' })).data!.items).toEqual([
      expect.objectContaining({ code: 'alpha_jackets', workflow: 'ALPHA Flow', attributes: 1, requiredAttributes: 1, products: 1 }),
    ])
    const categories = (await call('catalog-structure', { kind: 'categories' })).data!.items
    expect(categories.map((item) => item.path)).toEqual(['ALPHA Clothing', 'ALPHA Clothing › Jackets'])
    expect((await call('catalog-structure', { kind: 'product-types' })).data!.items).toEqual([{ productType: 'ALPHA_JACKET', products: 1 }])
    const [flow] = (await call('catalog-structure', { kind: 'workflows' })).data!.items
    expect(flow.stages).toEqual([
      expect.objectContaining({ code: 'draft', first: true, products: 1 }),
      expect.objectContaining({ code: 'live', last: true, publishable: true, products: 0 }),
    ])
    expect((await call('catalog-structure', { kind: 'tags' })).data!.items).toEqual([expect.objectContaining({ name: 'ALPHA Winter', products: 1 })])
    const [preset] = (await call('catalog-structure', { kind: 'templates' })).data!.items
    expect(preset).toMatchObject({ name: 'ALPHA eBay preset', destinations: ['EBAY IT'] })
    expect(preset).not.toHaveProperty('defaults')
    expect((await call('catalog-structure', { kind: 'markets' })).data!.items).toEqual([expect.objectContaining({ channel: 'EBAY', code: 'IT', currency: 'EUR', languages: ['it'] })])
  })

  it('a changed cursor, a bad kind and a missing permission are refused', async () => {
    const first = await call('catalog-structure', { kind: 'attributes', limit: 2 })
    expect(first.data!.nextCursor).toBeTruthy()
    const other = await call('catalog-structure', { kind: 'groups', limit: 2, cursor: first.data!.nextCursor })
    expect(other).toMatchObject({ ok: false, error: expect.stringContaining('cursor') })
    expect(await refusal('catalog-structure', { kind: 'nope' })).toBe('invalid_arguments')
    expect(await refusal('catalog-structure', {})).toBe('invalid_arguments')
    expect(await refusal('catalog-structure', { kind: 'tags' }, principal([FEATURES.aiRun, FEATURES.listingsView]))).toBe('forbidden')
    expect((await call('catalog-structure', { kind: 'tags' }, principal([FEATURES.aiRun, FEATURES.productsView]))).ok).toBe(true)
  })

  it.runIf(ON)('another business’s structure never shows', async () => {
    for (const kind of ['attributes', 'groups', 'families', 'categories', 'product-types', 'workflows', 'tags', 'templates', 'markets']) {
      expect(JSON.stringify(await call('catalog-structure', { kind }))).not.toContain('BRAVO')
      // Control: inside B the same call reads B (except markets, whose names carry no mark).
      if (kind !== 'markets') expect(JSON.stringify(await call('catalog-structure', { kind }, everything(B)))).toContain('BRAVO')
    }
  })
})

describe('channel-mappings', () => {
  it('rules: every field rule per market and product type, the transforms in words, and the named business rules', async () => {
    const { items } = await walk('channel-mappings', { kind: 'rules', channel: 'ebay' }, 2)
    expect(items).toEqual([
      { channel: 'EBAY', market: 'IT', productType: null, field: 'ItemSpecifics.Brand', source: 'brand', fallback: 'manufacturer', required: false },
      { channel: 'EBAY', market: 'IT', productType: null, field: 'title', source: 'name', transforms: ['cut to 80 characters'], required: true, notes: 'ALPHA title rule' },
      { channel: 'EBAY', market: 'IT', productType: 'ALPHA_JACKET', field: 'ItemSpecifics.Colour', source: 'attributes.colour', transforms: ['value map of colour'], required: false },
      { channel: 'EBAY', market: 'IT', businessRule: 'ALPHA_margin', formula: 'round($price * 1.2, 2)' },
    ])
    expect((await call('channel-mappings', {})).data!.kind).toBe('rules')
    expect((await call('channel-mappings', { channel: 'AMAZON' })).data!.items).toEqual([])
  })

  it('value-maps include the maps for every market; coverage answers per market; impacts are the caller’s own', async () => {
    const maps = (await call('channel-mappings', { kind: 'value-maps', channel: 'EBAY', market: 'it' })).data!.items
    expect(maps.map((map) => [map.market, map.from, map.to])).toEqual([['all markets', 'Blu', 'Blue'], ['IT', 'Rosso', 'ALPHA Red']])
    const [coverage] = (await call('channel-mappings', { kind: 'coverage', channel: 'EBAY', market: 'IT' })).data!.items
    expect(coverage).toMatchObject({ channel: 'EBAY', market: 'IT', fields: expect.any(Number), coveragePct: expect.any(Number) })
    const impacts = (await call('channel-mappings', { kind: 'impacts' })).data!.items
    expect(impacts).toEqual([expect.objectContaining({ state: 'review', channel: 'EBAY', market: 'IT', counts: { changed: 2, invalid: 0 } })])
  })

  it('a bad channel or kind is a wrongly made call; a missing permission is refused', async () => {
    expect(await refusal('channel-mappings', { channel: 'MYSPACE' })).toBe('invalid_arguments')
    expect(await refusal('channel-mappings', { kind: 'everything' })).toBe('invalid_arguments')
    expect(await refusal('channel-mappings', {}, principal([FEATURES.aiRun]))).toBe('forbidden')
  })

  it.runIf(ON)('another business’s mappings never show', async () => {
    for (const kind of ['rules', 'value-maps', 'coverage', 'impacts']) {
      expect(JSON.stringify(await call('channel-mappings', { kind, channel: 'EBAY', market: 'IT' }))).not.toContain('BRAVO')
    }
    expect(JSON.stringify(await call('channel-mappings', { kind: 'rules' }, everything(B)))).toContain('BRAVO')
  })
})
