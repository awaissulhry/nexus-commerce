/**
 * PB-7 — the parked cross-match route's service is a thin caller of the playbook's isolation (mocked I/O; made-up
 * values). It used to walk every ad group holding one of the product's ads in every market, and count a refusal as
 * applied.
 *
 *   refused    without a market, for a product that is not in a playbook there, for a playbook with no campaign yet
 *   one market the playbook row is looked up in the named market only, and its compiled rule is what runs
 *   honest     `applied` is what reached Amazon; held, refused and failed are said apart
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ compileIsolationFor: vi.fn(), isolateProduct: vi.fn(), findLiveProduct: vi.fn() }))
vi.mock('./ads-create.service.js', () => ({ createCampaignLocal: vi.fn(), createAdGroupLocal: vi.fn(), createProductAdLocal: vi.fn(), createKeywordLocal: vi.fn() }))
vi.mock('./ads-playbook/isolation-run.js', () => ({ compileIsolationFor: h.compileIsolationFor, isolateProduct: h.isolateProduct }))
vi.mock('./ads-strategy/load.js', async (importOriginal) => ({ ...(await importOriginal<object>()), findLiveProduct: h.findLiveProduct }))
vi.mock('../../db.js', () => ({ default: { adsPlaybook: { findMany: vi.fn() }, adsPlaybookLink: { findMany: vi.fn() } } }))

import prisma from '../../db.js'
import { crossMatchNegations } from './ads-keyword-funnel.service.js'

const db = vi.mocked(prisma, true)
const row = (id: string, scopeId: string, enrolled: boolean | null, state: string | null) => ({ id, scopeId, market: 'DE', channel: 'AMAZON', enrolled, state })
const ACTION = { type: 'isolate_product_terms', playbookId: 'row-own' }
const add = (text: string, adGroupId: string) => ({ kind: 'exactIntoResearch', text, match: 'EXACT', adGroupId, campaignId: `c-${adGroupId}`, slot: 'phrase-category', owner: { adTargetId: 't1', adGroupId: 'gx', slot: 'exact-category', text }, why: `Kept apart: "${text}"` })
const runOf = (written: Record<string, unknown> | null) => ({
  scope: { adGroups: 2, groups: [{ adGroupId: 'gp', campaignId: 'c-gp', slot: 'phrase-category', role: 'research', match: 'PHRASE', intent: 'CATEGORY', name: 'TEST | IT | Phrase' }], excluded: [] },
  plan: { adds: [add('test x', 'gp')], leftAlone: [], alreadyStanding: 0 },
  chosen: [add('test x', 'gp')],
  noLongerDue: [],
  written,
})

beforeEach(() => {
  vi.clearAllMocks()
  h.findLiveProduct.mockResolvedValue({ id: 'p-child', sku: 'TEST-SKU-1', parentId: 'p-parent' })
  db.adsPlaybook.findMany.mockResolvedValue([row('row-own', 'p-child', null, 'RUNNING'), row('row-parent', 'p-parent', true, 'RUNNING')] as never)
  db.adsPlaybookLink.findMany.mockResolvedValue([{ playbookId: 'row-parent' }] as never)
  h.compileIsolationFor.mockResolvedValue({ row: { id: 'row-parent', market: 'DE', version: 1 }, compiled: { action: ACTION, problems: [], warnings: [], enabled: true, name: 'x' } })
  h.isolateProduct.mockResolvedValue(runOf(null))
})

describe('crossMatchNegations — inside one product\'s playbook in one market', () => {
  it('is refused without a market, and for a product that is not in a playbook there', async () => {
    expect(await crossMatchNegations('p-child', false, 'user:u1', '')).toEqual({ refused: expect.stringMatching(/^Name a market/) })
    db.adsPlaybook.findMany.mockResolvedValue([row('row-own', 'p-child', false, 'RUNNING'), row('row-parent', 'p-parent', true, 'RUNNING')] as never)
    expect(await crossMatchNegations('p-child', false, 'user:u1', 'DE')).toEqual({ refused: expect.stringMatching(/TEST-SKU-1 is not in an ads playbook in DE/) })
    expect(h.isolateProduct).not.toHaveBeenCalled()
  })

  it('is refused when the row that holds the campaigns is not enrolled itself, or is stopped', async () => {
    db.adsPlaybook.findMany.mockResolvedValue([row('row-own', 'p-child', true, 'RUNNING'), row('row-parent', 'p-parent', false, 'RUNNING')] as never)
    expect(await crossMatchNegations('p-child', true, 'user:u1', 'DE')).toEqual({ refused: expect.stringMatching(/TEST-SKU-1 in DE: .*not enrolled/) })
    db.adsPlaybook.findMany.mockResolvedValue([row('row-own', 'p-child', null, null), row('row-parent', 'p-parent', true, 'STOPPED')] as never)
    expect(await crossMatchNegations('p-child', true, 'user:u1', 'DE')).toEqual({ refused: expect.stringMatching(/playbook is stopped/) })
    expect(h.isolateProduct).not.toHaveBeenCalled()
  })

  it('is refused for a playbook that holds no campaign yet', async () => {
    db.adsPlaybookLink.findMany.mockResolvedValue([])
    expect(await crossMatchNegations('p-child', true, 'user:u1', 'DE')).toEqual({ refused: expect.stringMatching(/holds no campaign yet/) })
  })

  it('looks in the named market only, and runs the playbook row that holds the campaigns', async () => {
    const out = await crossMatchNegations('p-child', false, 'user:u1', 'de')
    expect(db.adsPlaybook.findMany.mock.calls[0][0]).toMatchObject({ where: { market: 'DE', level: 'PRODUCT', scopeId: { in: ['p-child', 'p-parent'] } } })
    expect(h.compileIsolationFor).toHaveBeenCalledWith('row-parent')
    expect(h.isolateProduct).toHaveBeenCalledWith({ action: ACTION, actor: 'user:u1', dryRun: true })
    expect(out).toMatchObject({ applied: 0, proposals: [{ keywordText: 'test x', matchType: 'NEGATIVE_EXACT', adGroupId: 'gp', adGroupName: 'TEST | IT | Phrase', role: 'PHRASE' }] })
  })

  it('applied = what reached Amazon; held, refused and failed are said apart', async () => {
    h.isolateProduct.mockResolvedValue(runOf({ added: 1, local: 2, alreadyStanding: 0, refused: [{ text: 'test y', adGroupId: 'gp', deniedAt: 'halt', reason: 'Ads writes are halted.' }], failed: [{ text: 'test z', adGroupId: 'gp', error: 'Amazon gave no id' }], leftAlone: [], negativeIds: [] }))
    const out = await crossMatchNegations('p-child', true, 'user:u1', 'DE')
    expect(out).toMatchObject({ applied: 1, local: 2, errors: ['test y: Ads writes are halted.', 'test z: Amazon gave no id'] })
    expect(h.isolateProduct).toHaveBeenCalledWith({ action: ACTION, actor: 'user:u1', dryRun: false })
  })

  it('a negative left to a product\'s brain is said with its reason and counted, never dropped from the answer', async () => {
    const skip = { lever: 'negatives', holder: 'productBrain', campaignId: 'c-gb', campaignName: 'TEST | IT | Broad', productId: 'p-parent', market: 'DE', reason: 'a product\'s brain runs the negatives of campaign "TEST | IT | Broad" (c-gb) — product p-parent in DE' }
    h.isolateProduct.mockResolvedValue({ ...runOf(null), leftToBrain: [skip], leftToBrainItems: [{ text: 'test w', adGroupId: 'gb', why: `left alone: ${skip.reason} (one owner per lever)` }] })
    const out = await crossMatchNegations('p-child', false, 'user:u1', 'DE')
    if ('refused' in out) throw new Error(out.refused)
    expect(out.leftAlone).toEqual([{ text: 'test w', adGroupId: 'gb', why: expect.stringMatching(/^left alone: a product's brain runs the negatives of campaign .* \(one owner per lever\)$/) }])
    expect(out.brainSkips).toMatchObject({ counts: { productBrain: { negatives: 1 } } })
    // Nothing left to a brain: no brainSkips, as before.
    h.isolateProduct.mockResolvedValue(runOf(null))
    expect(await crossMatchNegations('p-child', false, 'user:u1', 'DE')).not.toHaveProperty('brainSkips')
  })
})
