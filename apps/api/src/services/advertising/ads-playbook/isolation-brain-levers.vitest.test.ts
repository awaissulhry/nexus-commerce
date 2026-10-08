/**
 * ONE BRAIN AB-6 — a playbook's isolation negatives leave a campaign whose negatives a product's brain owns (or the Owner
 * holds), in a dry run too (so no card offers them), and the run says so (`leftToBrain`, `brainSkips`). The rest is
 * planned and written exactly as before; nothing enrolled: exactly as before. Follow-up: the rule's own run (runIsolation,
 * as the rule engine calls it, now that AB-10 lets a product's brain own its negatives at PROPOSE or AUTO) writes nothing
 * on a campaign the brain runs and counts it with its holder and reason; a card whose every negative sits there is a skip
 * that says so; each left negative carries its text and why for a caller that lists them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlannedNegative } from './isolation.js'

const h = vi.hoisted(() => ({ load: vi.fn(), plan: vi.fn(), write: vi.fn(), campaignLeverOwners: vi.fn(), anyBrainEnrolled: vi.fn() }))
vi.mock('../../../db.js', () => ({
  default: {
    adsPlaybookLink: { findFirst: vi.fn(async (args: { where: { refId: string } }) => ({ playbookId: 'pb-1', adGroupId: `g-${args.where.refId}` })) },
    adTarget: { findUnique: vi.fn(async () => ({ isNegative: false, status: 'ENABLED', externalTargetId: 'EXT-own', adGroup: { campaign: { status: 'ENABLED' } } })) },
  },
}))
vi.mock('./isolation-load.js', () => ({ loadIsolation: h.load }))
vi.mock('./isolation.js', async (importOriginal) => ({ ...(await importOriginal<object>()), planIsolation: h.plan }))
vi.mock('../ads-negative-kw.service.js', () => ({ writeNegativeKeyword: h.write }))
vi.mock('../ads-winner-lock.js', () => ({ familyOnly: vi.fn(async () => ({ excluded: [] })) }))
vi.mock('../brain/lever-owners.js', () => ({
  campaignLeverOwners: (...a: unknown[]) => h.campaignLeverOwners(...a),
  anyBrainEnrolled: (...a: unknown[]) => h.anyBrainEnrolled(...a),
}))

const { isolateProduct, runIsolation } = await import('./isolation-run.js')

const add = (campaignId: string, text: string): PlannedNegative => ({
  kind: 'exactIntoResearch' as PlannedNegative['kind'], text, match: 'EXACT', adGroupId: `g-${campaignId}`, campaignId, slot: 'research',
  owner: { adTargetId: 't-own', adGroupId: 'g-exact', slot: 'exact', text }, why: 'sent home to its exact keyword',
})
const ACTION = { playbookId: 'pb-1' } as never
const OWNED = { kind: 'owned', productId: 'gale', market: 'IT', why: 'AUTO by the Owner\'s product override' }

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'live')
  h.load.mockResolvedValue({ inputs: { scope: [{ adGroupId: 'g-c-research' }], excluded: [], family: {}, positives: new Map(), winners: new Map(), standing: [], protections: [], waiting: new Set() } })
  h.plan.mockReturnValue({ adds: [add('c-research', 'gale jacket'), add('c-auto', 'gale jacket')], leftAlone: [], alreadyStanding: 0 })
  h.write.mockResolvedValue({ outcome: 'created', reachedAmazon: true, adTargetId: 'n1' })
  h.anyBrainEnrolled.mockResolvedValue(true)
  h.campaignLeverOwners.mockResolvedValue(new Map())
})
afterEach(() => vi.unstubAllEnvs())

describe('AB-6 — isolation leaves a campaign whose negatives a product\'s brain holds', () => {
  it('a dry run plans without it, and names it', async () => {
    h.campaignLeverOwners.mockResolvedValue(new Map([['c-auto', { campaignId: 'c-auto', name: 'GALE auto', market: 'IT', levers: { negatives: OWNED } }]]))
    const run = await isolateProduct({ action: ACTION, actor: 'automation:rule-iso', dryRun: true })
    if ('refused' in run) throw new Error(run.refused)
    expect(run.chosen.map((a) => a.campaignId)).toEqual(['c-research'])
    expect(run.leftToBrain).toEqual([expect.objectContaining({ lever: 'negatives', campaignId: 'c-auto' })])
  })

  it('a live run writes only the other', async () => {
    h.campaignLeverOwners.mockResolvedValue(new Map([['c-auto', { campaignId: 'c-auto', name: 'GALE auto', market: 'IT', levers: { negatives: OWNED } }]]))
    const run = await isolateProduct({ action: ACTION, actor: 'automation:rule-iso', dryRun: false })
    if ('refused' in run) throw new Error(run.refused)
    expect(h.write).toHaveBeenCalledTimes(1)
    expect(h.write.mock.calls[0][0]).toMatchObject({ adGroupId: 'g-c-research' })
    expect(run.written).toMatchObject({ added: 1 })
  })

  it('nothing enrolled: both, as before', async () => {
    h.anyBrainEnrolled.mockResolvedValue(false)
    const run = await isolateProduct({ action: ACTION, actor: 'automation:rule-iso', dryRun: false })
    if ('refused' in run) throw new Error(run.refused)
    expect(h.write).toHaveBeenCalledTimes(2)
    expect(run.leftToBrain).toEqual([])
    expect(run).not.toHaveProperty('holdsUnread')
  })
})

describe('AB-6 follow-up — the isolation rule\'s own run leaves the negatives a product\'s brain runs, counted with the reason', () => {
  const RULE_ACTION = { type: 'isolate_product_terms', v: 1, control: 'manual', playbookId: 'pb-1', market: 'IT', cadenceDays: 1, slots: {}, exactIntoResearch: true, phraseIntoBroadAndAuto: true, brandPhrase: null, handover: 'landed' }
  const ownedAuto = () => h.campaignLeverOwners.mockResolvedValue(new Map([['c-auto', { campaignId: 'c-auto', name: 'GALE auto', market: 'IT', levers: { negatives: OWNED } }]]))

  it('a run writes only the campaign the brain does not run; the other is counted under the product\'s brain, with why', async () => {
    ownedAuto()
    const r = await runIsolation({ action: RULE_ACTION, ruleId: 'rule-iso', dryRun: false, preview: true })
    expect(r.ok).toBe(true)
    expect(h.write).toHaveBeenCalledTimes(1)
    expect(h.write.mock.calls[0][0]).toMatchObject({ adGroupId: 'g-c-research', userId: 'automation:rule-iso' })
    expect((r.output as Record<string, unknown>).brainSkips).toEqual({
      counts: { productBrain: { negatives: 1 } },
      sample: [{ lever: 'negatives', holder: 'productBrain', campaignId: 'c-auto', why: 'a product\'s brain runs the negatives of campaign "GALE auto" (c-auto) — product gale in IT' }],
    })
  })

  it('its card (a dry run) offers none of them; an accepted card whose every negative sits there is a skip that says so', async () => {
    ownedAuto()
    const card = await runIsolation({ action: RULE_ACTION, ruleId: 'rule-iso', dryRun: true, preview: true })
    expect((card.output as { items: Array<{ adGroupId: string }> }).items.map((i) => i.adGroupId)).toEqual(['g-c-research'])
    const accepted = await runIsolation({ action: { ...RULE_ACTION, items: [{ text: 'gale jacket', match: 'EXACT', adGroupId: 'g-c-auto' }] }, ruleId: 'rule-iso', dryRun: false })
    expect(h.write).not.toHaveBeenCalled()
    expect(accepted).toMatchObject({ ok: true, output: { skipped: 'brain-lever', why: expect.stringMatching(/^every negative of the card is left alone: a product's brain runs the negatives of campaign "GALE auto"/) } })
  })

  it('each left negative carries its text, ad group and why (a caller lists it, never drops it)', async () => {
    ownedAuto()
    const run = await isolateProduct({ action: ACTION, actor: 'user:owner', dryRun: true })
    if ('refused' in run) throw new Error(run.refused)
    expect(run.leftToBrainItems).toEqual([{ text: 'gale jacket', adGroupId: 'g-c-auto', why: 'left alone: a product\'s brain runs the negatives of campaign "GALE auto" (c-auto) — product gale in IT (one owner per lever)' }])
  })
})
