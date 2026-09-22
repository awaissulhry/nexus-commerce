/**
 * Step 2.6a (A-27, R-23) — a child's size and colour live in ONE store: `categoryAttributes.variations`.
 *
 * Two halves, one claim: the sheet shows what the publishers send, and a sheet edit lands where they read.
 * - READ: the master cell is the resolver; every publisher reads `storedVariationValues`
 *   (`variations`, then `variantAttributes`). Measured on production 2026-09-23: the flat
 *   `categoryAttributes.size` key holds 0 values, and one child (`xriser-bla-l`, local) carries
 *   `size: null` over a stored `Size: 'L'` — the sheet showed it empty while eBay was sent `L`.
 * - WRITE: the sheet mirrored an axis edit into `variations` only for a DECLARED axis. `xracing` declares
 *   none, so a size edit there landed in the flat key only — shown, never published.
 *
 * The end-to-end arms run on real PostgreSQL through `applyProductBulkEdits`, the sheet's own writer.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  // R-VT-12 has verified this URL. The helper creates its own database, never uses the catalogue.
  process.env.NEXUS_TEST_CONCURRENT_PG_URL = process.env.DATABASE_URL
  const { concurrentDatabase } = await import('../../test-support/concurrent-database.js')
  state.db = await concurrentDatabase()
  return { default: state.db.client }
})
vi.mock('../outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn() }))
vi.mock('../product-event.service.js', () => ({ productEventService: { emitMany: vi.fn(), emitManyTx: vi.fn() } }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn() } }))
vi.mock('./readiness-index.service.js', () => ({ produceReadiness: vi.fn() }))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { resolveAttributes } from './attribute-resolver.js'
import { storedVariationValues } from './stored-variation-projection.js'
import { variationAttributePatch } from './shared-variation-values.js'
import { applyProductBulkEdits } from '../products/bulk-edit.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID,
  actorUserId: null, membershipId: null, roleKeys: [] }, work)

type Bags = { categoryAttributes?: Record<string, unknown>; variantAttributes?: Record<string, unknown> }
const parent = { id: 'parent', parentId: null, localizedContent: {}, variantAttributes: {}, categoryAttributes: { size: 'Parent size' } }
const child = ({ categoryAttributes = {}, variantAttributes = {} }: Bags) =>
  ({ ...parent, id: 'child', parentId: parent.id, categoryAttributes, variantAttributes })
/** What the sheet shows, next to what every publisher sends. */
const shownAndSent = (bags: Bags, axis = 'Size') => {
  const product = child(bags)
  const resolved = resolveAttributes({ product: product as any, parent: parent as any })
  return { shown: resolved.size?.value, color: resolved.color, sent: storedVariationValues(product, [axis])[axis] }
}

describe('READ — the sheet shows the store the publishers send', () => {
  it('an empty flat key no longer hides the stored size (xriser-bla-l, measured)', () => {
    const r = shownAndSent({ categoryAttributes: { size: null, variations: { Size: 'L', Color: 'Nero' } } })
    expect(r).toMatchObject({ shown: 'L', sent: 'L' })
  })
  it('a flat value that disagrees loses to the store', () => {
    expect(shownAndSent({ categoryAttributes: { size: 'M', variations: { Size: 'L' } } })).toMatchObject({ shown: 'L', sent: 'L' })
  })
  it('the legacy bag still answers when variations has no value (as storedVariationValues does)', () => {
    expect(shownAndSent({ categoryAttributes: { size: 'M' }, variantAttributes: { Taglia: 'XS' } }, 'Taglia')).toMatchObject({ shown: 'XS', sent: 'XS' })
  })
  it('the store beats the legacy bag when they disagree (AIR-MESH-JACKET-MEN-XXL-BLACK, production)', () => {
    expect(shownAndSent({ categoryAttributes: { variations: { Size: 'XXL' } }, variantAttributes: { Taglia: 'XS' } }, 'Size'))
      .toMatchObject({ shown: 'XXL', sent: 'XXL' })
  })
  it('control — a plain attribute: no axis value anywhere, the flat key is read', () => {
    expect(shownAndSent({ categoryAttributes: { size: 'M' } }).shown).toBe('M')
  })
  it('control — nothing on the child: the parent value still inherits', () => {
    expect(shownAndSent({}).shown).toBe('Parent size')
  })
  it('a conflict in the store is shown as a conflict, never hidden by the flat key', () => {
    const r = shownAndSent({ categoryAttributes: { color: 'Rosso', variations: { Color: 'Nero', Colore: 'Black' } } })
    expect(r.color?.value).toBeNull()
    expect(r.color?.warnings?.join(' ')).toContain('Conflicting variant attributes')
  })
})

describe('WRITE — a sheet edit lands in the store', () => {
  const held = { categoryAttributes: { variations: { Size: 'L' } }, variantAttributes: {} }
  it('an axis the child already holds is written even when the family declares none (xracing)', () => {
    expect(variationAttributePatch(held, [], { size: 'XL' }, [])).toEqual({ changed: true, set: { Size: 'XL' }, unset: [] })
    expect(variationAttributePatch(held, [], {}, ['size'])).toEqual({ changed: true, set: {}, unset: ['Size'] })
  })
  it('control — a plain attribute (no declared axis, nothing held) stays out of the store', () => {
    expect(variationAttributePatch({ categoryAttributes: { variations: {} }, variantAttributes: {} }, [], { size: 'XL' }, []).changed).toBe(false)
  })
  it('control — a size edit never touches a colour the child holds', () => {
    expect(variationAttributePatch({ categoryAttributes: { variations: { Color: 'Nero' } }, variantAttributes: {} }, [], { size: 'XL' }, []).changed).toBe(false)
  })
})

describe('END TO END — the sheet writer, on real PostgreSQL', () => {
  const context = { formulaCascade: false, logger: { warn: vi.fn(), error: vi.fn() } }
  beforeAll(() => scoped(async () => {
    for (const channel of ['AMAZON', 'EBAY']) await prisma.marketplace.create({ data: { channel, code: 'IT', name: 'Italy', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'] } })
    const group = await prisma.attributeGroup.create({ data: { code: 'sizing', label: 'Sizing' } })
    const size = await prisma.customAttribute.create({ data: { code: 'size', label: 'Size', type: 'text', groupId: group.id, scope: 'per_variant' } })
    const family = await prisma.productFamily.create({ data: { code: 'jackets', label: 'Jackets' } })
    await prisma.familyAttribute.create({ data: { familyId: family.id, attributeId: size.id, channels: [] } })
    for (const [id, axes] of [['undeclared', []], ['declared', ['Taglia']], ['plain', []]] as const) {
      await prisma.product.create({ data: { id: `${id}-parent`, sku: `${id}-parent`, name: id, basePrice: 10, isParent: true, familyId: family.id, variationAxes: [...axes] } })
    }
    await prisma.product.create({ data: { id: 'undeclared-child', sku: 'undeclared-child', name: 'c', basePrice: 10, parentId: 'undeclared-parent', familyId: family.id,
      categoryAttributes: { size: null, variations: { Size: 'L', Color: 'Nero' } } } })
    await prisma.product.create({ data: { id: 'declared-child', sku: 'declared-child', name: 'c', basePrice: 10, parentId: 'declared-parent', familyId: family.id } })
    await prisma.product.create({ data: { id: 'plain-child', sku: 'plain-child', name: 'c', basePrice: 10, parentId: 'plain-parent', familyId: family.id } })
  }))
  const edit = (id: string, value: string) => scoped(async () => {
    const before = await prisma.product.findUniqueOrThrow({ where: { id } })
    // The master sheet's own request shape (`masterWrite.ts`): the market it read with, no channel.
    const result = await applyProductBulkEdits({ changes: [{ id, field: 'attr_size', value, target: 'master' }],
      marketplaceContexts: [{ marketplace: 'IT', locale: 'it' }] as never, expectedVersion: before.version }, context)
      .catch((error: { body?: unknown }) => { throw new Error(`the sheet writer refused: ${JSON.stringify(error.body ?? error)} ${
        context.logger.warn.mock.calls.map(c => String((c[0] as { err?: Error })?.err?.stack ?? c[1])).join(' | ')}`) })
    return { result, after: await prisma.product.findUniqueOrThrow({ where: { id }, include: { parent: true } }) }
  })

  it('xracing-shaped: a size edit reaches what eBay publishes, and the sheet shows the same value', async () => {
    const { result, after } = await edit('undeclared-child', 'XL')
    expect(result).toMatchObject({ updated: 1 })
    expect(storedVariationValues(after, ['Size']).Size).toBe('XL')
    expect(resolveAttributes({ product: after as any, parent: after.parent as any }).size?.value).toBe('XL')
    expect((after.categoryAttributes as any).variations.Color).toBe('Nero')
  })
  it('declared axis: unchanged behaviour, the value lands under the declared key', async () => {
    const { after } = await edit('declared-child', 'M')
    expect(storedVariationValues(after, ['Taglia']).Taglia).toBe('M')
  })
  it('control — a plain attribute is written to the flat key and nothing else', async () => {
    const { after } = await edit('plain-child', 'S')
    expect((after.categoryAttributes as any).size).toBe('S')
    expect((after.categoryAttributes as any).variations).toBeUndefined()
    expect(after.variantAttributes).toBeNull()
  })
})
