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

const upsert = vi.fn(async () => ({}))
vi.mock('../../db.js', () => ({ default: { adsRuleSuggestion: { get upsert() { return upsert } } } }))
vi.mock('../../utils/logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }))

const { generateSuggestionsFromExecution } = await import('./ads-suggestions.service.js')

const CONTEXT = { marketplace: 'IT', campaign: { id: 'camp-1', name: 'GALE BROAD DE' } }
const run = (actions: Array<Record<string, unknown>>, results: Array<{ type: string; ok?: boolean; output?: unknown }>) =>
  generateSuggestionsFromExecution({
    ruleId: 'r1', ruleName: 'test rule', trigger: 'SCHEDULE', executionId: 'e1',
    context: CONTEXT, actions, actionResults: results,
  })

beforeEach(() => upsert.mockClear())

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
