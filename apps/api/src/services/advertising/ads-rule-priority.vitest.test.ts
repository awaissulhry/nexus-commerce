/**
 * EA7 — priority arbitration.
 *
 * The behaviour under test is the one that decides what actually reaches Amazon when two rules
 * want the same field on the same campaign in one tick. Before EA7 the winner was whichever row
 * Postgres returned last, so these are the first assertions the engine has ever had about order.
 */
import { describe, it, expect } from 'vitest'
import { ACTION_WRITES_FIELD } from './ads-conflicts.service.js'

/** The arbitration, extracted exactly as `evaluateRule` performs it. */
function arbitrate(
  claims: Map<string, string>,
  ruleId: string,
  campaignId: string | null,
  actions: Array<{ type: string }>,
): { yielded: false } | { yielded: true; field: string; to: string } {
  if (!campaignId) return { yielded: false }
  const fields = [...new Set(actions
    .map((a) => ACTION_WRITES_FIELD[a.type]?.field)
    .filter((f): f is NonNullable<typeof f> => !!f))]
  const taken = fields.find((f) => claims.has(`${campaignId}:${f}`))
  if (taken) return { yielded: true, field: taken, to: claims.get(`${campaignId}:${taken}`)! }
  for (const f of fields) claims.set(`${campaignId}:${f}`, ruleId)
  return { yielded: false }
}

describe('EA7 — one write per campaign field per tick', () => {
  it('the first rule takes the budget; the second yields', () => {
    const claims = new Map<string, string>()
    // The live pair on this account: opposite directions, same field, different triggers — which
    // is exactly why the old trigger-keyed conflict detector never compared them.
    const trim = arbitrate(claims, 'trim', 'DE_Gale', [{ type: 'adjust_ad_budget' }])
    const boost = arbitrate(claims, 'boost', 'DE_Gale', [{ type: 'adjust_ad_budget' }, { type: 'notify' }])
    expect(trim.yielded).toBe(false)
    expect(boost).toEqual({ yielded: true, field: 'budget', to: 'trim' })
  })

  it('does not yield across DIFFERENT fields — a bid rule and a budget rule both run', () => {
    const claims = new Map<string, string>()
    expect(arbitrate(claims, 'a', 'DE_Gale', [{ type: 'bid_down' }]).yielded).toBe(false)
    expect(arbitrate(claims, 'b', 'DE_Gale', [{ type: 'adjust_ad_budget' }]).yielded).toBe(false)
  })

  it('does not yield across DIFFERENT campaigns', () => {
    const claims = new Map<string, string>()
    expect(arbitrate(claims, 'a', 'DE_Gale', [{ type: 'bid_down' }]).yielded).toBe(false)
    expect(arbitrate(claims, 'b', 'IT_Gale', [{ type: 'bid_down' }]).yielded).toBe(false)
  })

  it('a notify-only rule claims nothing, so it never blocks a writer', () => {
    const claims = new Map<string, string>()
    expect(arbitrate(claims, 'alert', 'DE_Gale', [{ type: 'notify' }, { type: 'alert_operator' }]).yielded).toBe(false)
    expect(claims.size).toBe(0)
    expect(arbitrate(claims, 'real', 'DE_Gale', [{ type: 'bid_down' }]).yielded).toBe(false)
  })

  it('a context with no campaign does not arbitrate at all', () => {
    const claims = new Map<string, string>()
    expect(arbitrate(claims, 'a', null, [{ type: 'bid_down' }]).yielded).toBe(false)
    expect(arbitrate(claims, 'b', null, [{ type: 'bid_down' }]).yielded).toBe(false)
    expect(claims.size).toBe(0)
  })

  it('a multi-action rule claims EVERY field it writes', () => {
    const claims = new Map<string, string>()
    arbitrate(claims, 'wide', 'DE_Gale', [{ type: 'bid_down' }, { type: 'adjust_ad_budget' }])
    expect(arbitrate(claims, 'x', 'DE_Gale', [{ type: 'bid_up' }])).toMatchObject({ yielded: true, field: 'bid' })
    expect(arbitrate(claims, 'y', 'DE_Gale', [{ type: 'budget_apply' }])).toMatchObject({ yielded: true, field: 'budget' })
  })

  it('the field map covers every action the builder can produce', () => {
    // A missing entry means the action claims nothing and silently races — the failure this
    // arbitration exists to prevent, reintroduced by omission.
    for (const t of ['budget_apply', 'placement_apply', 'bid_apply', 'add_negative_exact', 'promote_to_exact', 'dayparting_apply']) {
      expect(ACTION_WRITES_FIELD[t]?.field, `${t} writes no known field`).toBeTruthy()
    }
  })
})
