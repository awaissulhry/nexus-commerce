import { describe, it, expect } from 'vitest'
import { opDeliveryState, parseActor, unexplainedUndoReason } from './ads-changes.service.js'

/**
 * HX.4 — every row in the change feed is classified by parseActor, and getting it wrong is not
 * cosmetic: the endpoint this replaces reported every automated write as an operator action,
 * because it read which COLUMN was populated instead of the actor string.
 */
describe('HX.4 parseActor — source + origin from the actor string', () => {
  it('classifies a rank schedule and keeps its id for name resolution', () => {
    const r = parseActor('automation:rank-defend-clx9f2abc')
    expect(r.source).toBe('automation')
    expect(r.origin.kind).toBe('schedule')
    expect(r.origin.id).toBe('clx9f2abc')
  })

  it('classifies a family plan', () => {
    const r = parseActor('automation:rank-plan-plan123')
    expect(r.origin).toMatchObject({ kind: 'plan', id: 'plan123' })
  })

  it('classifies a rule', () => {
    expect(parseActor('automation:rule-r42').origin).toMatchObject({ kind: 'rule', id: 'r42' })
  })

  it('SG.0 — classifies the UNPREFIXED rule actor RULE_ACTOR actually writes (automation:<cuid>)', () => {
    // automation-action-handlers.ts writes `automation:<ruleId>` with no 'rule-' prefix, so every
    // rule write (including operator-approved suggestion applies) parsed as an anonymous job.
    const r = parseActor('automation:cmehif9xk0001s6mvabcd1234')
    expect(r.source).toBe('automation')
    expect(r.origin).toMatchObject({ kind: 'rule', id: 'cmehif9xk0001s6mvabcd1234' })
    // resolveOrigins demotes a bare-cuid 'rule' back to 'job' when no such rule exists.
  })

  it('SG.0 — a short or non-cuid tail is still a standing job', () => {
    expect(parseActor('automation:auto-harvest').origin.kind).toBe('job')
    expect(parseActor('automation:budget-manager-cron').origin.kind).toBe('job')
  })

  it('treats a standing job as automation with no per-instance id', () => {
    const r = parseActor('automation:ads-write-reconcile')
    expect(r.source).toBe('automation')
    expect(r.origin).toMatchObject({ kind: 'job', id: null })
    expect(r.origin.name).toBe('ads write reconcile')
  })

  it('does NOT mistake an automation actor for an operator — the defect this replaces', () => {
    // listEvents reported this as 'Operator' because the actor lives in the userId column.
    expect(parseActor('automation:rank-defend-x').source).not.toBe('operator')
  })

  it('classifies a human, with and without the user: prefix', () => {
    expect(parseActor('user:awais')).toMatchObject({ source: 'operator', origin: { kind: 'manual', id: 'awais' } })
    expect(parseActor('awais').source).toBe('operator')
  })

  /**
   * R2 (MCP full control, part 06 gap 11) — rows written before the actor fix keep their old strings, and the feed
   * must attribute them exactly as it attributes the same writer's new rows: a doubled `automation:` prefix
   * (auto-bid, `bid_to_target_acos`, autopilot plans) and the budget-pool cron's `user:cron-budget-pool`, which
   * read as a PERSON named "cron-budget-pool".
   */
  it('R2 — reads a doubled automation: prefix (old rows) as the writer it names', () => {
    expect(parseActor('automation:automation:auto-bid')).toEqual(parseActor('automation:auto-bid'))
    expect(parseActor('automation:automation:cmehif9xk0001s6mvabcd1234').origin).toMatchObject({ kind: 'rule', id: 'cmehif9xk0001s6mvabcd1234' })
    expect(parseActor('automation:automation:rank-defend-clx9f2abc').origin).toMatchObject({ kind: 'schedule', id: 'clx9f2abc' })
  })

  it('R2 — reads the budget-pool cron\'s old user:cron-budget-pool as that engine, never as a person', () => {
    const old = parseActor('user:cron-budget-pool')
    expect(old.source).toBe('automation')
    expect(old).toEqual(parseActor('automation:budget-pool-rebalance'))
    expect(old.origin).toMatchObject({ kind: 'job', id: null, name: 'budget pool rebalance' })
  })

  it('treats an absent or system actor as system, never as a person', () => {
    for (const a of [null, undefined, '', 'system']) {
      expect(parseActor(a as string | null).source).toBe('system')
    }
  })

  it('classifies an externally-originated change', () => {
    expect(parseActor('external:seller-central').source).toBe('external')
  })

  it('matches the longest prefix first, so rank-plan is never read as a rule', () => {
    expect(parseActor('automation:rank-plan-abc').origin.kind).toBe('plan')
    expect(parseActor('automation:rank-defend-abc').origin.kind).toBe('schedule')
  })

  it('never returns an empty id string — null is what resolveOrigins skips on', () => {
    expect(parseActor('automation:rank-defend-').origin.id).toBeNull()
  })
})

/**
 * Ads fix 7d (review I.5) — a change that cannot be undone says why. A target bid past its window and an ad group's
 * default bid used to show no Undo and no reason at all.
 */
describe('7d unexplainedUndoReason — every not-undoable history row says why', () => {
  const row = (type: string, field: string, oldValue: string | null = '0.35') => ({ entity: { type }, field, oldValue })

  it('a target bid past its window names the 24-hour window', () => {
    expect(unexplainedUndoReason(row('AD_TARGET', 'bid'), true)).toBe('Older than the 24-hour undo window for this kind of change.')
  })

  it('a target bid with no prior value says there is nothing to restore', () => {
    expect(unexplainedUndoReason(row('AD_TARGET', 'bid', null), true)).toBe('No prior value was recorded, so there is nothing to restore.')
  })

  it('a placement or budget row with no matching record says so, in the pairing pass\'s own words', () => {
    expect(unexplainedUndoReason(row('CAMPAIGN', 'dailyBudget'), true)).toBe('This change could not be matched to a reversible record with certainty, so undo is not offered.')
  })

  it('any other kind (an ad group\'s default bid) says undo is not offered for it', () => {
    expect(unexplainedUndoReason(row('AD_GROUP', 'defaultBid'), false)).toBe('Undo is not offered for this kind of change.')
  })
})


describe('W4-12 — opDeliveryState: never APPLIED unless Amazon took it', () => {
  it('maps each action log status to a delivery state', () => {
    expect(opDeliveryState('SUCCESS')).toBe('APPLIED')
    expect(opDeliveryState('FAILED')).toBe('FAILED')
    expect(opDeliveryState('PENDING')).toBe('PENDING')
    expect(opDeliveryState('SKIPPED')).toBe('CANCELLED')
    expect(opDeliveryState('CANCELLED')).toBe('CANCELLED')
    expect(opDeliveryState('SUPERSEDED')).toBe('SUPERSEDED')
    expect(opDeliveryState(null)).toBe('PENDING')
  })
})
