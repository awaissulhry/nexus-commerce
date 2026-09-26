/**
 * P3b S4 (docs/attributes/PLAN.md §10.9) — Shared follows placement, at once.
 *
 *   · an archive, a restore and a label edit show on the very next read: the column caches carry the dictionary's
 *     version (before S4 a column set was kept 5 minutes whatever changed);
 *   · a channel-placed attribute with a stored value neither returns as "Additional saved attributes" nor stays
 *     writable on Shared through it (the save's Master contract uses the same filter), and the value is kept;
 *   · the export keeps every saved key (it still calls `savedAttributeFields`);
 *   · a saved Amazon PLUMBING key (`condition_type`, `skip_offer`…) is off Shared even on a business with no Amazon
 *     schema of its own (F4 = eBay + Etsy, like Motovento), while a real old key stays.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, addJobSafely: vi.fn() }))
vi.mock('../outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../product-event.service.js', () => ({ productEventService: { emit: vi.fn(), emitMany: vi.fn(), emitManyTx: vi.fn() } }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn(), refreshInTransaction: vi.fn() }, FACE_IMAGE_ORDER_BY: [], FACE_IMAGE_SELECT: {}, pickFaceImage: () => null }))
vi.mock('./readiness-index.service.js', async () => (await import('../../test-support/readiness-module-mock.js')).readinessModuleMock(vi.fn()))
import prisma from '../../db.js'
import { withWorkspace } from '../../lib/workspace-context.js'
import { OLD_KEY, createScopeFixtures, type ScopeFixture, type ScopeFixtureKey } from '../../test-support/attribute-scope-fixtures.js'
import { archiveAttribute, restoreAttribute, setAttributePlacement, undoPlacementChange } from './attribute-placement.service.js'
import { getStudioSheet } from './studio-sheet.service.js'
import { savedAttributeFields } from './family-sheet-schema.js'
import { applyProductBulkEdits } from '../products/bulk-edit.service.js'

let fixtures: Record<ScopeFixtureKey, ScopeFixture>
const inF4 = <T>(work: () => Promise<T>) => withWorkspace(fixtures.F4.context, work)
const shared = () => inF4(async () => (await getStudioSheet({ productId: fixtures.F4.productId, scope: 'master', market: 'IT', locale: 'it' } as never)).columns)
const attr = (code: string) => inF4(() => prisma.customAttribute.findFirstOrThrow({ where: { code } }))

beforeAll(async () => { fixtures = await createScopeFixtures(state.db.client) }, 300_000)
afterAll(async () => { await state.db?.close() }, 30_000)

describe('P3b S4 — Shared follows placement, at once', () => {
  it('an archive, a restore and a label edit show on the very next read', async () => {
    expect((await shared()).some(c => c.key === 'flavor')).toBe(true)          // warms every column cache
    const flavor = await attr('flavor')
    await inF4(() => archiveAttribute(flavor.id))
    expect((await shared()).some(c => c.key === 'flavor')).toBe(false)
    await inF4(() => restoreAttribute(flavor.id))
    expect((await shared()).some(c => c.key === 'flavor')).toBe(true)
    await inF4(() => prisma.customAttribute.update({ where: { id: flavor.id }, data: { label: 'Flavour (renamed)' } }))
    expect((await shared()).find(c => c.key === 'flavor')?.label).toBe('Flavour (renamed)')
  }, 180_000)

  it('a channel-placed attribute with a value: off Shared, not writable there, value kept; the export still has it', async () => {
    await inF4(() => prisma.product.update({ where: { id: fixtures.F4.productId }, data: { categoryAttributes: { weave_type: 'Twill' } } }))
    const save = () => inF4(async () => {
      try { return await applyProductBulkEdits({ changes: [{ id: fixtures.F4.productId, field: 'attr_weave_type', value: 'Satin', target: 'master' }] } as never, { formulaCascade: false, logger: { warn: vi.fn(), error: vi.fn() } }) as any }
      catch (error: any) { return { refused: error?.statusCode, errors: error?.details?.errors } }
    })
    // Control, on Shared: a family attribute saves with no market (P8).
    expect(await save()).toMatchObject({ updated: 1 })

    const weave = await attr('weave_type')
    const moved = await inF4(() => setAttributePlacement(weave.id, { placement: 'channel', channels: ['AMAZON'] }))
    expect((await shared()).some(c => c.key === 'weave_type')).toBe(false)     // not a family column, not a saved one
    expect(await save()).toMatchObject({ refused: 400, errors: [expect.objectContaining({ field: 'attr_weave_type', error: expect.stringContaining('not in the business dictionary for this product') })] })
    const bag = await inF4(() => prisma.product.findUniqueOrThrow({ where: { id: fixtures.F4.productId }, select: { categoryAttributes: true } }))
    expect((bag.categoryAttributes as Record<string, unknown>).weave_type).toBe('Satin')   // the value stays where it was
    // The export keeps every saved key: it calls the unfiltered helper.
    expect(savedAttributeFields([bag.categoryAttributes]).map(f => f.id)).toContain('attr_weave_type')
    await inF4(() => undoPlacementChange(moved.auditId!))
    expect((await shared()).some(c => c.key === 'weave_type')).toBe(true)
  }, 180_000)

  it('hides saved Amazon plumbing keys on a business with no Amazon schema, keeps a real old key, and the export keeps all', async () => {
    const bag = { condition_type: 'new_new', skip_offer: 'false', merchant_shipping_group: 'legacy-template-id', [OLD_KEY]: 'IPX4' }
    await inF4(() => prisma.product.update({ where: { id: fixtures.F4.productId }, data: { categoryAttributes: bag } }))
    const keys = (await shared()).map(c => c.key)
    // POSITIVE CONTROL: the real old key is read from the same bag, so the bag reached the Shared view.
    expect(keys).toContain(OLD_KEY)
    expect(keys.filter(key => ['condition_type', 'skip_offer', 'merchant_shipping_group'].includes(key))).toEqual([])
    expect(savedAttributeFields([bag]).map(f => f.id)).toEqual(expect.arrayContaining(['attr_condition_type', 'attr_skip_offer', 'attr_merchant_shipping_group']))
  }, 180_000)
})
