/**
 * Axis guard (asked by the variation-theme lane, 2026-09-26) — an attribute a family VARIES BY is never hidden.
 *
 *   · pure: which stored axis labels name an attribute (the shared synonym table: "Colore" → color, "Taglia" → size);
 *   · on PostgreSQL (F4, the study's 242 attributes): moving an axis attribute to a channel or archiving it is refused,
 *     other attributes still move; the S5 cleanup preview marks an axis row "blocked"; an axis only on a deleted root
 *     product does not count.
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
import { createScopeFixtures, type ScopeFixture, type ScopeFixtureKey } from '../../test-support/attribute-scope-fixtures.js'
import { archiveAttribute, axesNaming, PlacementError, setAttributePlacement, undoPlacementChange } from './attribute-placement.service.js'
import { placementProposalPreview } from './attribute-placement-correction.js'

describe('axesNaming — pure', () => {
  const color = { code: 'color', label: 'Color', semanticKey: 'color' }
  it.each([
    [color, ['Colore', 'Taglia'], ['Colore']],
    [{ code: 'size', label: 'Size', semanticKey: 'size' }, ['Colore', 'Taglia'], ['Taglia']],
    [{ code: 'department', label: 'Department', semanticKey: null }, ['Department', 'Colore'], ['Department']],
    [{ code: 'fit_type', label: 'Fit type', semanticKey: 'fit' }, ['Colore', 'Taglia'], []],
    [{ code: 'custom_axis', label: 'Stagione', semanticKey: null }, ['stagione'], ['stagione']],            // by its label
  ])('%j with axes %j → %j', (attribute, axes, expected) => expect(axesNaming(attribute, axes)).toEqual(expected))
})

describe('on PostgreSQL — F4', () => {
  let fixtures: Record<ScopeFixtureKey, ScopeFixture>
  const inF4 = <T>(work: () => Promise<T>) => withWorkspace(fixtures.F4.context, work)
  const attr = (code: string) => inF4(() => prisma.customAttribute.findFirstOrThrow({ where: { code } }))
  const refusal = async (work: () => Promise<unknown>) => { try { await work(); return null } catch (e) { if (e instanceof PlacementError) return { status: e.status, message: e.message }; throw e } }

  beforeAll(async () => {
    fixtures = await createScopeFixtures(state.db.client)
    await inF4(async () => {
      await prisma.product.update({ where: { id: fixtures.F4.productId }, data: { variationAxes: ['Colore', 'Department'] } })
      // An axis only on a DELETED root product names nothing.
      await prisma.product.create({ data: { sku: 'SCOPE-F4-DELETED', name: 'Deleted', basePrice: 1, variationAxes: ['Weave type'], deletedAt: new Date() } })
    })
  }, 300_000)
  afterAll(async () => { await state.db?.close() }, 30_000)

  it('refuses to move or archive an axis attribute, and says which axis', async () => {
    const color = await attr('color')
    expect(await refusal(() => inF4(() => setAttributePlacement(color.id, { placement: 'channel', channels: ['EBAY'] }))))
      .toMatchObject({ status: 409, message: expect.stringContaining('variation axis (Colore)') })
    expect(await refusal(() => inF4(() => archiveAttribute(color.id)))).toMatchObject({ status: 409, message: expect.stringContaining('variation axis') })
    expect(await attr('color')).toMatchObject({ placement: 'shared', archivedAt: null })
  })

  it('other attributes still move (a deleted product\'s axis does not count)', async () => {
    const weave = await attr('weave_type')
    const moved = await inF4(() => setAttributePlacement(weave.id, { placement: 'channel', channels: ['AMAZON'] }))
    expect(moved.changed).toBe(true)
    await inF4(() => undoPlacementChange(moved.auditId!))
  })

  it('the S5 cleanup preview marks an axis row blocked', async () => {
    const preview = await inF4(placementProposalPreview)
    const row = preview.groups.flatMap(g => g.rows).find(r => r.code === 'department')
    expect(row).toMatchObject({ status: 'blocked', reason: 'variation axis (Department)' })
  })
})
