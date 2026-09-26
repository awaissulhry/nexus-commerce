/**
 * P3b S5 (docs/attributes/PLAN.md §10.9) — the reviewed cleanup of the shared attribute set, on the F4 fixture (the
 * study's 242 attributes in a Jackets family) and PostgreSQL with row-level security:
 *   · the proposal data keeps the study's counts;
 *   · a preview with an old fingerprint is refused, and nothing changes;
 *   · one approved group changes only its own rows; the disputed rows need their own decision; a blocked row is skipped;
 *   · "approve the rest" leaves only the core (and the undecided disputed rows) on Shared;
 *   · undo restores the whole batch exactly;
 *   · another business sees only its own attributes in its preview.
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
import { PLACEMENT_PROPOSAL, PLACEMENT_PROPOSAL_DISPUTED } from '@nexus/shared/attribute-placement-proposal'
import { createScopeFixtures, type ScopeFixture, type ScopeFixtureKey } from '../../test-support/attribute-scope-fixtures.js'
import { applyPlacementProposal, placementProposalPreview, undoPlacementProposal } from './attribute-placement-correction.js'
import { archiveAttribute, PlacementError, restoreAttribute } from './attribute-placement.service.js'
import { getStudioSheet } from './studio-sheet.service.js'

describe('the proposal data', () => {
  it('keeps the study\'s counts: 54 core, 69 Amazon, 4 eBay, 1 Shopify, 114 duplicate or not relevant', () => {
    const count = (g: string) => PLACEMENT_PROPOSAL.filter(r => r.group === g).length
    expect([count('core'), count('amazon'), count('ebay'), count('shopify'), count('duplicate') + count('not-relevant')]).toEqual([54, 69, 4, 1, 114])
    expect(new Set(PLACEMENT_PROPOSAL.map(r => r.code)).size).toBe(242)
    expect(PLACEMENT_PROPOSAL_DISPUTED.every(code => PLACEMENT_PROPOSAL.some(r => r.code === code))).toBe(true)
  })
})

describe('on PostgreSQL — F4', () => {
  let fixtures: Record<ScopeFixtureKey, ScopeFixture>
  const inF4 = <T>(work: () => Promise<T>) => withWorkspace(fixtures.F4.context, work)
  const dictionary = () => inF4(async () => (await prisma.customAttribute.findMany({ select: { code: true, placement: true, placementChannels: true, archivedAt: true }, orderBy: { code: 'asc' } }))
    .map(a => `${a.code}:${a.placement}:${a.placementChannels.join(',')}:${a.archivedAt ? 'archived' : 'active'}`))
  const refusal = async (work: () => Promise<unknown>) => { try { await work(); return null } catch (e) { if (e instanceof PlacementError) return { status: e.status, message: e.message }; throw e } }

  beforeAll(async () => {
    fixtures = await createScopeFixtures(state.db.client)
    // A family requires one Amazon-group attribute on eBay: that row must be blocked, never moved.
    await inF4(async () => {
      const a = await prisma.customAttribute.findFirstOrThrow({ where: { code: 'department' } })
      await prisma.familyAttribute.updateMany({ where: { attributeId: a.id }, data: { required: true, channels: ['EBAY'] } })
    })
  }, 300_000)
  afterAll(async () => { await state.db?.close() }, 30_000)

  it('previews every group, the disputed rows apart, and the blocked row with its reason', async () => {
    const preview = await inF4(placementProposalPreview)
    expect(preview.disputed.map(r => r.code).sort()).toEqual([...PLACEMENT_PROPOSAL_DISPUTED].sort())
    const amazon = preview.groups.find(g => g.group === 'amazon')!
    expect(amazon.rows.find(r => r.code === 'department')).toMatchObject({ status: 'blocked', reason: expect.stringContaining('EBAY in Jackets') })
    expect(amazon.rows.some(r => r.disputed)).toBe(false)
    expect(preview.groups.find(g => g.group === 'core')!.rows.every(r => r.status === 'no-change')).toBe(true)   // everything starts on Shared
    expect(preview.fingerprint).toMatch(/^[0-9a-f]{64}$/)
  })

  it('refuses an apply with an old fingerprint, and changes nothing', async () => {
    const preview = await inF4(placementProposalPreview)
    const before = await dictionary()
    const flavor = await inF4(() => prisma.customAttribute.findFirstOrThrow({ where: { code: 'flavor' } }))
    await inF4(() => archiveAttribute(flavor.id))                        // the dictionary changes after the preview
    expect(await refusal(() => inF4(() => applyPlacementProposal({ fingerprint: preview.fingerprint, groups: ['amazon'] })))).toMatchObject({ status: 409 })
    await inF4(() => restoreAttribute(flavor.id))
    expect(await dictionary()).toEqual(before)
  })

  it('one approved group changes only its own rows; undo restores the batch exactly', async () => {
    const before = await dictionary()
    const preview = await inF4(placementProposalPreview)
    const result = await inF4(() => applyPlacementProposal({ fingerprint: preview.fingerprint, groups: ['amazon'] }))
    const amazonRows = preview.groups.find(g => g.group === 'amazon')!.rows
    expect(result.applied).toBe(amazonRows.filter(r => r.status === 'change').length)
    const after = new Map((await dictionary()).map(line => [line.split(':')[0], line]))
    for (const row of amazonRows) {
      expect(after.get(row.code)).toBe(row.status === 'change' ? `${row.code}:channel:AMAZON:active` : `${row.code}:shared::active`)
    }
    // Nothing outside the group moved, the disputed rows included.
    const changed = before.filter(line => after.get(line.split(':')[0]) !== line).map(line => line.split(':')[0])
    expect(changed.every(code => amazonRows.some(r => r.code === code))).toBe(true)
    expect(changed).not.toContain('lining_description')
    await inF4(() => undoPlacementProposal(result.batchId))
    expect(await dictionary()).toEqual(before)
  }, 180_000)

  it('"approve the rest" leaves only the core and the undecided disputed rows on Shared; undo restores it', async () => {
    const before = await dictionary()
    const preview = await inF4(placementProposalPreview)
    const result = await inF4(() => applyPlacementProposal({ fingerprint: preview.fingerprint, groups: 'all' }))
    expect(result.applied).toBeGreaterThan(100)
    const shared = (await inF4(() => getStudioSheet({ productId: fixtures.F4.productId, scope: 'master', market: 'IT', locale: 'it' } as never))).columns.map(c => c.key)
    const onShared = PLACEMENT_PROPOSAL.filter(r => shared.includes(r.code))
    const allowed = (code: string, group: string) => group === 'core' || PLACEMENT_PROPOSAL_DISPUTED.includes(code) || code === 'department'   // department: blocked (required)
    expect(onShared.filter(r => !allowed(r.code, r.group)).map(r => r.code)).toEqual([])
    expect(onShared.filter(r => r.group === 'core').length).toBeGreaterThan(40)
    await inF4(() => undoPlacementProposal(result.batchId))
    expect(await dictionary()).toEqual(before)
  }, 240_000)

  it('another business previews only its own attributes', async () => {
    const f4Ids = new Set((await inF4(() => prisma.customAttribute.findMany({ select: { id: true } }))).map(a => a.id))
    const f1 = await withWorkspace(fixtures.F1.context, placementProposalPreview)
    const rows = [...f1.disputed, ...f1.groups.flatMap(g => g.rows)]
    expect(rows.length).toBeGreaterThan(0)                                // the starter set overlaps the study (color, size …)
    expect(rows.some(r => f4Ids.has(r.attributeId))).toBe(false)
  })
})
