/**
 * ADX A2.1 — what belongs in the suggestions queue.
 *
 * A suggestion is a CHANGE an operator can approve or dismiss. Measured on prod
 * 2026-08-04, the first time this pipeline had ever produced anything: 227 pending
 * rows, of which 117 were notifications, 48 explicitly reported changing nothing, and
 * 11 were real. A 5% signal rate, and a regression I introduced in ADX.2 by making
 * every matched dry-run propose without asking what kind of action it was.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const upsert = vi.fn(async (_args: unknown) => ({}))
const updateMany = vi.fn(async (_args: unknown) => ({ count: 0 }))
vi.mock('../../db.js', () => ({ default: { adsRuleSuggestion: { get upsert() { return upsert }, get updateMany() { return updateMany } } } }))
vi.mock('../../utils/logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }))

const { generateSuggestionsFromExecution } = await import('./ads-suggestions.service.js')

const CONTEXT = { marketplace: 'IT', campaign: { id: 'camp-1', name: 'GALE BROAD DE' } }
const run = (actions: Array<Record<string, unknown>>, results: Array<{ type: string; ok?: boolean; output?: unknown }>) =>
  generateSuggestionsFromExecution({
    ruleId: 'r1', ruleName: 'test rule', trigger: 'SCHEDULE', executionId: 'e1',
    context: CONTEXT, actions, actionResults: results,
  })

beforeEach(() => { upsert.mockClear(); updateMany.mockClear() })

describe('what reaches the queue', () => {
  it('a real change does', async () => {
    const n = await run(
      [{ type: 'adjust_ad_budget', percent: -15 }],
      [{ type: 'adjust_ad_budget', ok: true, output: { wouldChange: '€20.00 → €17.00' } }],
    )
    expect(n).toBe(1)
    expect(upsert).toHaveBeenCalledTimes(1)
  })

  it('a notification does NOT — there is nothing to approve', async () => {
    const n = await run(
      [{ type: 'notify', target: 'operator', message: 'bid reduced' }],
      [{ type: 'notify', ok: true, output: {} }],
    )
    expect(n).toBe(0)
    expect(upsert).not.toHaveBeenCalled()
  })

  it('alert_operator and log_only do not either', async () => {
    await run(
      [{ type: 'alert_operator', severity: 'warning' }, { type: 'log_only' }],
      [{ type: 'alert_operator', ok: true, output: {} }, { type: 'log_only', ok: true, output: {} }],
    )
    expect(upsert).not.toHaveBeenCalled()
  })

  it('a result that explicitly changes nothing does not', async () => {
    await run(
      [{ type: 'bid_to_target_acos' }],
      [{ type: 'bid_to_target_acos', ok: true, output: { wouldChange: 0 } }],
    )
    expect(upsert).not.toHaveBeenCalled()
  })

  it("string '0' is treated the same as numeric 0", async () => {
    await run(
      [{ type: 'bid_to_target_acos' }],
      [{ type: 'bid_to_target_acos', ok: true, output: { wouldChange: '0' } }],
    )
    expect(upsert).not.toHaveBeenCalled()
  })

  it('the pre-existing filters still hold — failures, noChange, skipped', async () => {
    await run(
      [{ type: 'a' }, { type: 'b' }, { type: 'c' }, { type: 'd' }],
      [
        { type: 'a', ok: false },
        { type: 'b', ok: true, output: { noChange: true } },
        { type: 'c', ok: true, output: { skipped: 'not allowlisted' } },
        { type: 'd', ok: true, output: { noActiveWindow: true } },
      ],
    )
    expect(upsert).not.toHaveBeenCalled()
  })

  it('mixed batch: only the real change survives', async () => {
    // The exact shape of the prod queue — one useful proposal buried in notifications.
    const n = await run(
      [{ type: 'promote_to_exact', bidEur: 0.6 }, { type: 'notify' }, { type: 'alert_operator' }],
      [
        { type: 'promote_to_exact', ok: true, output: { query: 'motorradjacke herren sommer' } },
        { type: 'notify', ok: true, output: {} },
        { type: 'alert_operator', ok: true, output: {} },
      ],
    )
    expect(n).toBe(1)
    expect(upsert).toHaveBeenCalledTimes(1)
  })

  it('a zero that is not wouldChange is left alone — 0% share is a real observation', async () => {
    const n = await run(
      [{ type: 'set_placement_multiplier', percentage: 0 }],
      [{ type: 'set_placement_multiplier', ok: true, output: { observed: 0 } }],
    )
    expect(n).toBe(1)
  })
})

/**
 * 5d (review 7.10) — a search-term card is keyed by its ad group too, and a wire rule whose every outcome is a skip
 * proposes nothing. Before, one term in two ad groups of a campaign shared one card (approving applied whichever ad
 * group ran last), and an all-skipped dry run became a card that "applied" nothing.
 */
describe('5d — search-term cards', () => {
  const term = (externalAdGroupId: string) => ({ marketplace: 'IT', searchTerm: { query: 'giacca moto', externalCampaignId: 'EC1', externalAdGroupId } })
  const runOn = (context: unknown, actions: Array<Record<string, unknown>>, results: Array<{ type: string; ok?: boolean; output?: unknown }>) =>
    generateSuggestionsFromExecution({ ruleId: 'r1', ruleName: 'test rule', trigger: 'SEARCH_TERM_WASTING', executionId: 'e1', context, actions, actionResults: results })
  const keyOf = (call: unknown[]) => (call[0] as { where: { ruleId_entityId_proposedKey: { entityId: string; proposedKey: string } } }).where.ruleId_entityId_proposedKey
  const NEG = [{ type: 'add_negative_exact' }]
  const would = [{ type: 'add_negative_exact', ok: true, output: { keyword: 'giacca moto', outcomes: [{ adGroupId: 'dst1', matchType: 'NEGATIVE_EXACT', level: 'AD_GROUP', wouldCreate: true }] } }]

  it('two ad groups proposing the same term make two cards, on the same entity', async () => {
    await runOn(term('EAG1'), NEG, would)
    await runOn(term('EAG2'), NEG, would)
    expect(upsert).toHaveBeenCalledTimes(2)
    const [a, b] = upsert.mock.calls.map(keyOf)
    expect(a.entityId).toBe('EC1:giacca moto')
    expect(b.entityId).toBe('EC1:giacca moto')
    expect(a.proposedKey).toBe('add_negative_exact:ag=EAG1')
    expect(b.proposedKey).toBe('add_negative_exact:ag=EAG2')
  })

  it('a card written before the ad group joined the key is taken over, not duplicated; a sweep keeps its account card', async () => {
    await runOn(term('EAG1'), NEG, would)
    expect(updateMany).toHaveBeenCalledWith({
      where: { ruleId: 'r1', entityId: 'EC1:giacca moto', proposedKey: 'add_negative_exact' },
      data: { proposedKey: 'add_negative_exact:ag=EAG1' },
    })
    await runOn(term('EAG1'), [{ type: 'harvest_and_negate' }], [{ type: 'harvest_and_negate', ok: true, output: { wouldNegate: 2 } }])
    expect(keyOf(upsert.mock.calls[1])).toMatchObject({ entityId: 'account', proposedKey: 'harvest_and_negate' })
    expect(updateMany).toHaveBeenCalledTimes(1)
  })

  it('every outcome a skip → no card', async () => {
    const n = await runOn(term('EAG1'), NEG, [{ type: 'add_negative_exact', ok: true, output: { keyword: 'giacca moto', outcomes: [
      { adGroupId: 'dst1', matchType: 'NEGATIVE_EXACT', level: 'AD_GROUP', skipped: 'dedupe — the term is already negated at this level with this match type' },
      { adGroupId: 'dst1', matchType: 'PRODUCT', level: 'CAMPAIGN', refused: 'is an ASIN, a product' },
    ] } }])
    expect(n).toBe(0)
    expect(upsert).not.toHaveBeenCalled()
  })
})
