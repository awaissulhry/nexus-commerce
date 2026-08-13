/**
 * HV.8c — an account-wide sweep is ONE proposal, not one per marketplace.
 *
 * Measured on prod 2026-08-13 before the change:
 *
 *   harvest_and_negate   18 cards carrying  2 distinct payloads  (9 marketplaces × 2 rules)
 *   bid_down             60 cards carrying 60 distinct payloads  (sixty real proposals)
 *
 * The dedupe key is `(ruleId, entityId, proposedKey)`, which is exactly right for an action that
 * acts ON its context and exactly wrong for one that sweeps regardless of it. Five of the nine
 * marketplaces the sweep was filed under have `writesEnabledAt: NULL` and cannot be written to at
 * all, so an operator approving the NL card would have been approving an account-wide negation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const upsert = vi.fn(async () => ({}))
vi.mock('../../db.js', () => ({ default: { adsRuleSuggestion: { upsert: (...a: unknown[]) => upsert(...a) } } }))
vi.mock('../../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

const { generateSuggestionsFromExecution } = await import('./ads-suggestions.service.js')

const run = (type: string, marketplace: string) =>
  generateSuggestionsFromExecution({
    ruleId: 'r1',
    ruleName: 'Auto harvest & negate',
    trigger: 'SCHEDULE',
    executionId: `e-${marketplace}`,
    context: { marketplace },
    actions: [{ type }],
    actionResults: [{ type, ok: true, output: { dryRun: true, scoped: false, wouldNegate: 14 } }],
  })

const keyOf = (call: unknown) => (call as [{ where: { ruleId_entityId_proposedKey: { entityId: string } } }])[0].where.ruleId_entityId_proposedKey.entityId

beforeEach(() => upsert.mockClear())

describe('HV.8c — sweep actions collapse to one card', () => {
  it('🔴 files harvest_and_negate against the account, not against each marketplace', async () => {
    for (const m of ['NL', 'IE', 'IT', 'DE', 'PL', 'UK', 'FR', 'ES', 'SE']) await run('harvest_and_negate', m)
    expect(upsert).toHaveBeenCalledTimes(9)
    // Nine firings, ONE dedupe key — so the upsert collapses them to a single row.
    const keys = new Set(upsert.mock.calls.map(keyOf))
    expect(keys).toEqual(new Set(['account']))
  })

  it('does the same for sync_negatives_across_campaigns — the widest sweep in the section', async () => {
    for (const m of ['IT', 'DE']) await run('sync_negatives_across_campaigns', m)
    expect(new Set(upsert.mock.calls.map(keyOf))).toEqual(new Set(['account']))
  })

  it('🔴 leaves a per-entity action alone — bid_down stays one card per marketplace', async () => {
    for (const m of ['IT', 'DE', 'FR']) await run('bid_down', m)
    expect(new Set(upsert.mock.calls.map(keyOf))).toEqual(new Set(['IT', 'DE', 'FR']))
  })

  it('labels the account entity truthfully rather than borrowing a marketplace name', async () => {
    await run('harvest_and_negate', 'NL')
    const create = (upsert.mock.calls[0] as [{ create: { entityType: string; entityName: string } }])[0].create
    expect(create.entityType).toBe('ACCOUNT')
    expect(create.entityName).toBe('the whole account')
  })
})
