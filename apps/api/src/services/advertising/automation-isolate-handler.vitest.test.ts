/**
 * PB-7 — the `isolate_product_terms` handler driven with mocked I/O (the scope loader, the negative write service, the
 * three reads of the write's last layer). Values are made up (public repo).
 *
 *   dry run    lists every planned negative as an item (what an accept applies), or proposes nothing (noChange)
 *   accept     applies ONLY the card's items, each planned again on today's data; one no longer due is said, not written
 *   counts     honest: added = reached Amazon; local, already there, refused and failed each counted apart; a refusal
 *              alone is a failed apply (the card keeps waiting with the reason)
 *   last layer a campaign that left the playbook, or an owner keyword no longer live, is never written to
 *   cadence    a rule that ran today proposes nothing more today; a preview always shows what a run would do
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ writeNegativeKeyword: vi.fn(), loadIsolation: vi.fn() }))

vi.mock('../automation-rule.service.js', () => ({ ACTION_HANDLERS: {} as Record<string, unknown>, getFieldPath: vi.fn() }))
vi.mock('./ads-mutation.service.js', () => ({ updateCampaignWithSync: vi.fn(), updateAdGroupWithSync: vi.fn(), updateAdTargetWithSync: vi.fn() }))
vi.mock('./ads-negative-kw.service.js', () => ({ createNegative: vi.fn(), writeNegativeKeyword: h.writeNegativeKeyword, writeNegativeProductTarget: vi.fn() }))
vi.mock('./ads-playbook/isolation-load.js', () => ({ loadIsolation: h.loadIsolation }))
vi.mock('../../db.js', () => ({
  default: {
    adsPlaybookLink: { findFirst: vi.fn() },
    adProductAd: { findMany: vi.fn() },
    adTarget: { findUnique: vi.fn() },
    automationRuleExecution: { findMany: vi.fn() },
  },
}))

import prisma from '../../db.js'
import { ACTION_HANDLERS } from '../automation-rule.service.js'
import './automation-action-handlers.js'

const db = vi.mocked(prisma, true)
type Out = { type: string; ok: boolean; error?: string; output?: Record<string, any> }
const run = (action: Record<string, unknown>, meta: Record<string, unknown> = {}) =>
  (ACTION_HANDLERS.isolate_product_terms as (a: unknown, c: unknown, m: unknown) => Promise<Out>)(action, {}, { dryRun: false, ruleId: 'rule-pb7', ...meta })

const ACTION = {
  type: 'isolate_product_terms', v: 1, control: 'manual', playbookId: 'pb-1', market: 'IT', cadenceDays: 1,
  slots: {
    'exact-category': { role: 'exact', match: 'EXACT', intent: 'CATEGORY' },
    'phrase-category': { role: 'research', match: 'PHRASE', intent: 'CATEGORY' },
    'broad-category': { role: 'research', match: 'BROAD', intent: 'CATEGORY' },
  },
  exactIntoResearch: true, phraseIntoBroadAndAuto: false, brandPhrase: null, handover: 'proven',
}
const scope = [
  { adGroupId: 'gx', campaignId: 'cx', slot: 'exact-category', role: 'exact', match: 'EXACT', intent: 'CATEGORY' },
  { adGroupId: 'gp', campaignId: 'cp', slot: 'phrase-category', role: 'research', match: 'PHRASE', intent: 'CATEGORY' },
  { adGroupId: 'gb', campaignId: 'cb', slot: 'broad-category', role: 'research', match: 'BROAD', intent: 'CATEGORY' },
]
const owner = (text: string) => ({ adTargetId: `t-${text}`, adGroupId: 'gx', text, match: 'EXACT', live: true })
const inputs = (owners: string[] = ['test x', 'test y']) => ({
  inputs: {
    productId: 'p1', family: { productIds: ['p1'], asins: [] }, scope, excluded: [{ slot: 'shared', campaignId: 'cs', adGroupId: 'gs', why: 'it also advertises TEST-OTHER, which is not this product' }],
    positives: new Map([['gx', owners.map(owner)]]), winners: new Map(), standing: new Set(), protections: new Map(),
  },
})
const answer = (over: Record<string, unknown> = {}) => ({ outcome: 'created', mode: 'live', externalTargetId: 'EXT-N', reachedAmazon: true, adTargetId: 'neg-1', refusal: null, error: null, rawResponse: null, ...over })
const written = () => h.writeNegativeKeyword.mock.calls.map(([a]) => `${a.matchType}:${a.keywordText}:${a.adGroupId}`)

beforeEach(() => {
  vi.clearAllMocks()
  h.loadIsolation.mockResolvedValue(inputs())
  h.writeNegativeKeyword.mockResolvedValue(answer())
  db.adsPlaybookLink.findFirst.mockResolvedValue({ playbookId: 'pb-1', adGroupId: null } as never)
  db.adProductAd.findMany.mockImplementation((async (args: { where: { adGroupId: { in: string[] } } }) =>
    args.where.adGroupId.in.map((adGroupId) => ({ adGroupId, productId: 'p1', asin: null, sku: 'TEST-1', product: { sku: 'TEST-1' } }))) as never)
  db.adTarget.findUnique.mockResolvedValue({ isNegative: false, status: 'ENABLED', externalTargetId: 'EXT-O', adGroup: { campaign: { status: 'ENABLED' } } } as never)
  db.automationRuleExecution.findMany.mockResolvedValue([])
})

describe('isolate_product_terms — the dry run', () => {
  it('lists every planned negative as an item and writes nothing', async () => {
    const r = await run(ACTION, { dryRun: true })
    expect(r).toMatchObject({ type: 'isolate_product_terms', ok: true, output: { dryRun: true, noChange: false, planned: 4, wouldNegate: 4 } })
    expect(r.output!.items.map((i: { match: string; text: string; adGroupId: string }) => `${i.match}:${i.text}:${i.adGroupId}`).sort())
      .toEqual(['EXACT:test x:gb', 'EXACT:test x:gp', 'EXACT:test y:gb', 'EXACT:test y:gp'])
    expect(r.output!.scope).toMatchObject({ adGroups: 3, excluded: [expect.objectContaining({ adGroupId: 'gs' })] })
    expect(r.output).not.toHaveProperty('skipped')
    expect(h.writeNegativeKeyword).not.toHaveBeenCalled()
  })

  it('proposes nothing when nothing is planned', async () => {
    h.loadIsolation.mockResolvedValue(inputs([]))
    expect((await run(ACTION, { dryRun: true })).output).toMatchObject({ noChange: true, items: [] })
  })

  it('a playbook that is gone proposes nothing, and an accept on it is refused with the reason', async () => {
    h.loadIsolation.mockResolvedValue({ refused: 'The playbook this rule was compiled from is gone, so nothing is kept apart.' })
    expect((await run(ACTION, { dryRun: true })).output).toMatchObject({ noChange: true, why: expect.stringMatching(/is gone/) })
    expect(await run(ACTION)).toMatchObject({ ok: false, error: expect.stringMatching(/is gone/) })
  })

  it('an action that does not read is refused, naming the field', async () => {
    expect(await run({ ...ACTION, handover: 'later' }, { dryRun: true })).toMatchObject({ ok: false, error: expect.stringMatching(/handover/) })
  })
})

describe('isolate_product_terms — an accepted card', () => {
  it('applies only its items, as the rule, with no converting guard; each written negative joins the approval\'s undo list', async () => {
    const approval = { changeSetId: 'appr-1', reason: 'test', negatives: [] as string[] }
    const r = await run({ ...ACTION, items: [{ text: 'test x', match: 'EXACT', adGroupId: 'gp' }] }, { approval })
    expect(written()).toEqual(['EXACT:test x:gp'])
    expect(h.writeNegativeKeyword.mock.calls[0][0]).toMatchObject({ scope: 'AD_GROUP', protectConverting: null, userId: 'automation:rule-pb7', evidence: { targetKey: 'isolation:exactIntoResearch' } })
    expect(r).toMatchObject({ ok: true, output: { added: 1, local: 0 } })
    expect(approval.negatives).toEqual(['neg-1'])
  })

  it('an item no longer due is said, and when none is, nothing is written and the card keeps waiting', async () => {
    const one = await run({ ...ACTION, items: [{ text: 'test x', match: 'EXACT', adGroupId: 'gp' }, { text: 'test z', match: 'EXACT', adGroupId: 'gp' }] })
    expect(written()).toEqual(['EXACT:test x:gp'])
    expect(one.output).toMatchObject({ noLongerDue: 1, topNoLongerDue: [expect.objectContaining({ text: 'test z' })] })
    h.writeNegativeKeyword.mockClear()
    const none = await run({ ...ACTION, items: [{ text: 'test z', match: 'EXACT', adGroupId: 'gp' }] })
    expect(h.writeNegativeKeyword).not.toHaveBeenCalled()
    expect(none.output).toMatchObject({ skipped: 'no-longer-due' })
  })

  it('honest counts: reached Amazon, held in Nexus, already there and refused, each apart', async () => {
    h.writeNegativeKeyword
      .mockResolvedValueOnce(answer({ adTargetId: 'neg-a' }))
      .mockResolvedValueOnce(answer({ outcome: 'local', mode: 'local', externalTargetId: null, reachedAmazon: false, adTargetId: 'neg-b' }))
      .mockResolvedValueOnce(answer({ outcome: 'already_existed', adTargetId: 'neg-old' }))
      .mockResolvedValueOnce(answer({ outcome: 'refused', externalTargetId: null, reachedAmazon: false, adTargetId: null, refusal: { deniedAt: 'allowlist', reason: 'Not on the live-write allowlist.' } }))
    const r = await run(ACTION)
    expect(r.ok).toBe(true)
    expect(r.output).toMatchObject({ added: 1, local: 1, alreadyStanding: 1, refused: [expect.objectContaining({ deniedAt: 'allowlist', reason: 'Not on the live-write allowlist.' })] })
  })

  it('a refusal alone is a failed apply, with the refusal\'s sentence', async () => {
    h.writeNegativeKeyword.mockResolvedValue(answer({ outcome: 'refused', reachedAmazon: false, adTargetId: null, refusal: { deniedAt: 'halt', reason: 'Ads writes are halted.' } }))
    expect(await run({ ...ACTION, items: [{ text: 'test x', match: 'EXACT', adGroupId: 'gp' }] })).toMatchObject({ ok: false, error: 'Ads writes are halted.' })
  })
})

describe('isolate_product_terms — the write\'s last layer', () => {
  it('never writes into an ad group that now also advertises another product', async () => {
    db.adProductAd.findMany.mockResolvedValue([
      { adGroupId: 'gp', productId: 'p1', asin: null, sku: 'TEST-1', product: { sku: 'TEST-1' } },
      { adGroupId: 'gp', productId: 'p-other', asin: null, sku: 'TEST-OTHER', product: { sku: 'TEST-OTHER' } },
    ] as never)
    const r = await run({ ...ACTION, items: [{ text: 'test x', match: 'EXACT', adGroupId: 'gp' }] })
    expect(h.writeNegativeKeyword).not.toHaveBeenCalled()
    expect(r.output).toMatchObject({ skipped: 'left-alone', why: expect.stringMatching(/also advertises TEST-OTHER, which is not this product/) })
  })

  it('never writes into a campaign that left the playbook since the plan', async () => {
    db.adsPlaybookLink.findFirst.mockResolvedValue({ playbookId: 'pb-other', adGroupId: null } as never)
    const r = await run({ ...ACTION, items: [{ text: 'test x', match: 'EXACT', adGroupId: 'gp' }] })
    expect(h.writeNegativeKeyword).not.toHaveBeenCalled()
    expect(r.output).toMatchObject({ skipped: 'left-alone', why: expect.stringMatching(/left this product's playbook/) })
  })

  it('never writes when the owner keyword is no longer live', async () => {
    db.adTarget.findUnique.mockResolvedValue({ isNegative: false, status: 'PAUSED', externalTargetId: 'EXT-O', adGroup: { campaign: { status: 'ENABLED' } } } as never)
    const r = await run({ ...ACTION, items: [{ text: 'test x', match: 'EXACT', adGroupId: 'gp' }] })
    expect(h.writeNegativeKeyword).not.toHaveBeenCalled()
    expect(r.output).toMatchObject({ skipped: 'left-alone', why: expect.stringMatching(/"test x" is no longer live/) })
  })
})

describe('isolate_product_terms — cadence', () => {
  it('a rule that ran today proposes nothing more today; a preview still shows the plan', async () => {
    db.automationRuleExecution.findMany.mockResolvedValue([{ actionResults: [{ type: 'isolate_product_terms', ok: true, output: { dryRun: true } }] }] as never)
    expect((await run(ACTION, { dryRun: true })).output).toMatchObject({ noChange: true, cadenceHeld: true })
    expect((await run(ACTION, { dryRun: true, preview: true })).output).toMatchObject({ noChange: false, planned: 4 })
  })

  it('a run today that FAILED swept nothing: it does not hold the next one back', async () => {
    db.automationRuleExecution.findMany.mockResolvedValue([{ actionResults: [{ type: 'isolate_product_terms', ok: false, error: 'a made-up failure' }] }] as never)
    const r = await run(ACTION, { dryRun: true })
    expect(r.output).toMatchObject({ noChange: false, planned: 4 })
    expect(r.output).not.toHaveProperty('cadenceHeld')
  })
})
