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
// D2 — the applied card a sweep's next proposal finds (none by default), and the move that keeps it aside.
const findFirst = vi.fn(async (_args?: unknown) => null as { id: string } | null)
const update = vi.fn(async (_args?: unknown) => ({}))
vi.mock('../../db.js', () => ({ default: { adsRuleSuggestion: { upsert: (...a: unknown[]) => upsert(...a), findFirst: (a: unknown) => findFirst(a), update: (a: unknown) => update(a) } } }))
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

beforeEach(() => { upsert.mockClear(); findFirst.mockReset(); findFirst.mockResolvedValue(null); update.mockClear() })

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

/**
 * D2 — a sweep's card is its rule's one card. Once applied, a later proposal of the rule was folded INTO the applied row
 * (the upsert's update branch) and reached no person again; the lifecycle sweep re-opens only expired and dismissed
 * rows. Now the applied row is kept aside (its key with its id after it) and the proposal opens a new pending card.
 */
describe('D2 — a sweep card that was applied: the next proposal opens a new pending card', () => {
  it('🔴 the applied card keeps what was applied (moved aside under its own key); the proposal is a new card', async () => {
    findFirst.mockResolvedValue({ id: 'sug-applied-1' })
    await run('harvest_and_negate', 'IT')
    expect(findFirst).toHaveBeenCalledWith({ where: { ruleId: 'r1', entityId: 'account', proposedKey: 'harvest_and_negate', status: 'applied' }, select: { id: true } })
    expect(update).toHaveBeenCalledWith({ where: { id: 'sug-applied-1' }, data: { proposedKey: 'harvest_and_negate:applied=sug-applied-1' } })
    // The type still leads the moved key (every reader that falls back to it reads the head).
    expect('harvest_and_negate:applied=sug-applied-1'.split(':')[0]).toBe('harvest_and_negate')
    expect(update.mock.invocationCallOrder[0]).toBeLessThan(upsert.mock.invocationCallOrder[0])
    expect((upsert.mock.calls[0] as unknown as [{ create: { status: string } }])[0].create.status).toBe('pending')
  })

  it('the same for every sweep: sync_negatives_across_campaigns and the playbook\'s isolate_product_terms', async () => {
    findFirst.mockResolvedValue({ id: 'sug-applied-2' })
    await run('sync_negatives_across_campaigns', 'IT')
    await run('isolate_product_terms', 'IT')
    expect(update.mock.calls.map((c) => (c[0] as { data: { proposedKey: string } }).data.proposedKey)).toEqual(['sync_negatives_across_campaigns:applied=sug-applied-2', 'isolate_product_terms:applied=sug-applied-2'])
  })

  it('no applied card (pending, dismissed, expired or none): nothing is moved — the upsert folds as before, and a dismissal keeps its rules', async () => {
    await run('harvest_and_negate', 'IT')
    expect(findFirst).toHaveBeenCalledTimes(1)
    expect(update).not.toHaveBeenCalled()
    expect(upsert).toHaveBeenCalledTimes(1)
  })

  it('a card of one change on one entity is not a sweep: it is never looked up or moved (it still folds)', async () => {
    findFirst.mockResolvedValue({ id: 'never-read' })
    await run('bid_down', 'IT')
    expect(findFirst).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
    expect(upsert).toHaveBeenCalledTimes(1)
  })
})
