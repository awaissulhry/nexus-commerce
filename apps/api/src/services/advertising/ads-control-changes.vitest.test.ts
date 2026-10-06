/**
 * CR (Control Room review) — "Changes to the controls": the two logs' rows in plain words, and whose they are.
 * Pure: no database.
 */
import { describe, expect, it } from 'vitest'
import { actionLogChange, auditLogChange, personOf } from './ads-control-changes.service.js'
import { liveWritesAuditUser } from './campaign-settings.service.js'

const at = new Date('2026-10-06T10:00:00.000Z')
const row = (over: Partial<Parameters<typeof actionLogChange>[0]>) => ({
  id: 'r1', createdAt: at, userId: 'user:u1', actionType: 'set_automation_level', entityType: 'ADS_DIAL', entityId: 'ads-dial',
  payloadBefore: {}, payloadAfter: {}, evidence: { metric: 'operator_autonomy' }, ...over,
})

describe('the ads action log rows (operator_autonomy)', () => {
  it('the account level in the one scale', () => {
    expect(actionLogChange(row({ payloadBefore: { autonomy: 'SUGGEST' }, payloadAfter: { autonomy: 'AUTO' } })))
      .toMatchObject({ id: 'a:r1', kind: 'account-level', what: 'Account level', from: 'Ask me', to: 'Auto', userId: 'u1' })
  })
  it('Stop now and Start again', () => {
    expect(actionLogChange(row({ actionType: 'halt_automation', entityType: 'AUTOMATION' }))).toMatchObject({ kind: 'stop', what: 'Stop now', from: 'Running', to: 'Stopped' })
    expect(actionLogChange(row({ actionType: 'resume_automation', entityType: 'AUTOMATION' }))).toMatchObject({ kind: 'start', from: 'Stopped', to: 'Running' })
  })
  it('the breaker limits, a null limit being the default', () => {
    expect(actionLogChange(row({
      actionType: 'tune_engine_setting', entityType: 'ADS_AUTOMATION_STATE', entityId: 'breaker',
      payloadBefore: { maxActionsPerHour: null, maxHourlySpendCentsEur: 50_000 }, payloadAfter: { maxActionsPerHour: 100, maxHourlySpendCentsEur: 50_000 },
    }))).toMatchObject({ kind: 'brakes', what: 'Account brakes', from: 'actions: default · €500/h', to: '100 actions/h · €500/h' })
  })
  it('a rule’s level, named from its note; an automation’s level', () => {
    expect(actionLogChange(row({ actionType: 'set_rule_autonomy', entityType: 'RULE', entityId: 'rule1', payloadAfter: { level: 'PROPOSE' }, evidence: { metric: 'operator_autonomy', note: 'Harvest winners → PROPOSE' } })))
      .toMatchObject({ kind: 'rule-level', what: 'Rule: Harvest winners', from: null, to: 'Ask me' })
    expect(actionLogChange(row({ entityType: 'BUDGET_POOL', entityId: 'p1', payloadBefore: { level: 'OBSERVE' }, payloadAfter: { level: 'AUTO' }, evidence: { metric: 'operator_autonomy', note: 'Helmets pool → AUTO' } })))
      .toMatchObject({ kind: 'automation-level', what: 'Automation: Helmets pool', from: 'Watch', to: 'Auto' })
  })
})

describe('the audit log rows', () => {
  const engineName = (key: string) => (key === 'auto-bid' ? 'Bid optimiser' : key)
  it('an engine’s level for this business, by the engine’s name', () => {
    expect(auditLogChange({ id: 'l1', createdAt: at, userId: 'u2', action: 'set_engine_switch', entityId: 'auto-bid', before: { mode: 'OFF' }, after: { mode: 'AUTO', reason: null }, metadata: null }, engineName))
      .toMatchObject({ id: 'l:l1', kind: 'engine-level', what: 'Engine: Bid optimiser', from: 'Off', to: 'Auto', userId: 'u2' })
  })
  it('a campaign’s "Automation may change it", by the campaign’s name', () => {
    expect(auditLogChange({ id: 'l2', createdAt: at, userId: 'u2', action: 'set_live_writes', entityId: 'c1', before: { liveBidWritesEnabled: false }, after: { liveBidWritesEnabled: true }, metadata: { campaignName: 'DE_Auto_Close' } }, engineName))
      .toMatchObject({ kind: 'campaign-allowed', what: 'Automation may change it: DE_Auto_Close', from: 'No', to: 'Yes' })
  })
})

describe('whose change it is', () => {
  it('a person from a user:<id> actor; never anonymous, a cron or a non-person actor', () => {
    expect(personOf('user:u1')).toBe('u1')
    expect(personOf('user:anonymous')).toBeNull()
    expect(personOf('user:cron-budget-pool')).toBeNull()
    expect(personOf('automation:rule:r1')).toBeNull()
    expect(personOf(null)).toBeNull()
    expect(liveWritesAuditUser('user:u9')).toBe('u9')
    expect(liveWritesAuditUser('user:anonymous')).toBeNull()
    expect(liveWritesAuditUser(undefined)).toBeNull()
  })
})
