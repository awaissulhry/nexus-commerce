import { describe, it, expect } from 'vitest'
import { parseActor } from './ads-changes.service.js'

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
