/**
 * Meta step 18 — set-meta-budget-schedule as a pure draft: a scheduled increase is SPENDS MONEY with no undo (Meta
 * documents no change or delete), on daily budgets only, ≤ 50 per object, ≥ 3 hours, ≤ 8 daily budgets in total, an
 * amount in WHOLE currency units; a change or a delete is Meta's SDK only (sent, Meta decides) and names its campaign
 * for the gateway's check; the switch is SDK only too. Made-up ids.
 */
import { describe, expect, it } from 'vitest'
import { budgetScheduleDraft, type BudgetScheduleLive, type ScheduleObject } from './change-budget-schedule.js'
import type { MetaChangeDraft } from './change-draft.js'
import type { SettingsRecord } from './change-settings-common.js'

const C = '120000000000001'
const P = '120000000000031'
const NOW = new Date('2026-10-21T00:00:00Z')
const object = (over: Partial<ScheduleObject> = {}): ScheduleObject => ({
  kind: 'campaign', id: C, name: 'Campaign A', status: 'ACTIVE', campaignStatus: 'ACTIVE', dailyBudget: '10000', lifetimeBudget: null, underCampaignBudget: false,
  budgetScheduling: true, objective: 'OUTCOME_SALES', smartPromotionType: null, ...over,
})
const period = { id: P, budgetValue: 20, budgetValueType: 'ABSOLUTE', recurrenceType: 'ONE_TIME', timeStart: '2026-11-27T00:00:00+0000', timeEnd: '2026-11-28T00:00:00+0000' }
const live = (over: Partial<BudgetScheduleLive> = {}): BudgetScheduleLive => ({ object: object(), periods: [period], capabilities: ['CAN_USE_BUDGET_SCHEDULING_API'], currency: 'EUR', ...over })
const ok = (d: MetaChangeDraft | { refusal: string }): MetaChangeDraft => { if ('refusal' in d) throw new Error(d.refusal); return d }
const refusal = (d: MetaChangeDraft | { refusal: string }) => ('refusal' in d ? d.refusal : null)
const create = { action: 'create' as const, level: 'campaign' as const, objectId: C, startTime: '2026-11-27T08:00:00Z', endTime: '2026-11-27T20:00:00Z' }

describe('create (CMP-057, AS-088)', () => {
  it('an amount in WHOLE units on the campaign\'s edge; SPENDS MONEY; no undo; no Meta check', () => {
    const d = ok(budgetScheduleDraft({ ...create, increaseCents: 2000 }, live(), NOW))
    expect(d.requests[0]).toMatchObject({
      kind: 'campaign', objectId: C, edge: 'budget_schedules', check: 'none', raisesSpend: true, undoable: false, operation: 'budgetSchedule.create',
      params: { budget_value: '20', budget_value_type: 'ABSOLUTE', time_start: String(Date.parse(create.startTime) / 1000), time_end: String(Date.parse(create.endTime) / 1000) },
      expect: { budget_value: '20', budget_value_type: 'ABSOLUTE' },
    })
    expect(d.spendsMoney[0]).toMatch(/\+20\.00 EUR on the daily budget/)
    expect(d.warnings.join(' ')).toMatch(/100 times smaller — never larger/)
    expect((d.before as SettingsRecord).undo).toBeNull()
    expect((d.after as SettingsRecord).kind).toBe('highdemandperiod')
  })
  it('a percentage; at most 8 daily budgets in total; at least 3 hours; in the future; at most 50', () => {
    expect(ok(budgetScheduleDraft({ ...create, increasePercent: 40 }, live(), NOW)).requests[0].params).toMatchObject({ budget_value: '40', budget_value_type: 'MULTIPLIER' })
    expect(refusal(budgetScheduleDraft({ ...create, increaseCents: 80000 }, live(), NOW))).toMatch(/at most 700\.00 EUR/)
    expect(refusal(budgetScheduleDraft({ ...create, increaseCents: 2050 }, live(), NOW))).toMatch(/whole/)
    expect(refusal(budgetScheduleDraft({ ...create, endTime: '2026-11-27T10:00:00Z', increaseCents: 2000 }, live(), NOW))).toMatch(/at least 3 hours/)
    expect(refusal(budgetScheduleDraft({ ...create, startTime: '2026-10-20T08:00:00Z', increaseCents: 2000 }, live(), NOW))).toMatch(/in the future/)
    const full = live({ periods: Array.from({ length: 50 }, (_, i) => ({ ...period, id: String(120000000000100 + i) })) })
    expect(refusal(budgetScheduleDraft({ ...create, increaseCents: 2000 }, full, NOW))).toMatch(/at most 50/)
  })
  it('daily budgets only; an ad set under a campaign budget schedules on its campaign; the capability; not Advantage+ App', () => {
    expect(refusal(budgetScheduleDraft({ ...create, increaseCents: 2000 }, live({ object: object({ dailyBudget: null, lifetimeBudget: '900000' }) }), NOW))).toMatch(/daily budgets only/)
    expect(refusal(budgetScheduleDraft({ ...create, level: 'adset', increaseCents: 2000 }, live({ object: object({ kind: 'adset', underCampaignBudget: true }) }), NOW))).toMatch(/on its campaign/)
    expect(refusal(budgetScheduleDraft({ ...create, increaseCents: 2000 }, live({ capabilities: ['CAN_CREATE_LOOKALIKES'] }), NOW))).toMatch(/CAN_USE_BUDGET_SCHEDULING_API/)
    expect(ok(budgetScheduleDraft({ ...create, increaseCents: 2000 }, live({ capabilities: null }), NOW)).warnings.join(' ')).toMatch(/did not say/)
    expect(refusal(budgetScheduleDraft({ ...create, increaseCents: 2000 }, live({ object: object({ objective: 'OUTCOME_APP_PROMOTION' }) }), NOW))).toMatch(/Advantage\+ App/)
  })
  it('a paused campaign: the line says nothing spends unless it is on in the period', () => {
    expect(ok(budgetScheduleDraft({ ...create, increaseCents: 2000 }, live({ object: object({ status: 'PAUSED' }) }), NOW)).spendsMoney[0]).toMatch(/not on now/)
  })
})

describe('change and delete (CMP-059, CMP-060: SDK only)', () => {
  it('a change names the period and its campaign; a raise SPENDS; undo changes it back while it has not started', () => {
    const d = ok(budgetScheduleDraft({ action: 'change', level: 'campaign', objectId: C, periodId: P, increaseCents: 3000 }, live(), NOW))
    expect(d.requests[0]).toMatchObject({ objectId: P, objectKind: 'highdemandperiod', parent: { kind: 'campaign', id: C }, params: { budget_value: '30', budget_value_type: 'ABSOLUTE' }, raisesSpend: true, operation: 'budgetSchedule.update' })
    expect(d.warnings.join(' ')).toMatch(/its SDK has one/)
    expect((d.before as SettingsRecord).undo).toEqual({ action: 'change', level: 'campaign', objectId: C, periodId: P, startTime: '2026-11-27T00:00:00.000Z', endTime: '2026-11-28T00:00:00.000Z', increaseCents: 2000 })
    expect(ok(budgetScheduleDraft({ action: 'change', level: 'campaign', objectId: C, periodId: P, increaseCents: 1000 }, live(), NOW)).spendsMoney).toEqual([])
  })
  it('a delete: DELETE of the period, safe; undo schedules it again while it has not started', () => {
    const d = ok(budgetScheduleDraft({ action: 'delete', level: 'campaign', objectId: C, periodId: P }, live(), NOW))
    expect(d.requests[0]).toMatchObject({ objectId: P, method: 'DELETE', params: {}, raisesSpend: false, objectKind: 'highdemandperiod', parent: { kind: 'campaign', id: C } })
    expect((d.before as SettingsRecord).undo).toEqual({ action: 'create', level: 'campaign', objectId: C, startTime: '2026-11-27T00:00:00.000Z', endTime: '2026-11-28T00:00:00.000Z', increaseCents: 2000 })
    expect((d.after as SettingsRecord).fields).toEqual({ exists: 'no' })
  })
  it('a period of another object, or one that ended: refused', () => {
    expect(refusal(budgetScheduleDraft({ action: 'delete', level: 'campaign', objectId: C, periodId: '120000000000039' }, live(), NOW))).toMatch(/not one of/)
    expect(refusal(budgetScheduleDraft({ action: 'delete', level: 'campaign', objectId: C, periodId: P }, live({ periods: [{ ...period, timeEnd: '2026-10-01T00:00:00+0000' }] }), NOW))).toMatch(/ended/)
  })
})

describe('switch (CMP-061, AS-090: SDK only)', () => {
  it('on SPENDS (its increases apply again); off is safe; undo switches back', () => {
    const on = ok(budgetScheduleDraft({ action: 'switch', level: 'campaign', objectId: C, enabled: true }, live({ object: object({ budgetScheduling: false }) }), NOW))
    expect(on.requests[0]).toMatchObject({ params: { is_budget_schedule_enabled: 'true' }, raisesSpend: true, operation: 'campaign.settings', check: 'not-yet', expect: { is_budget_schedule_enabled: 'true' } })
    const off = ok(budgetScheduleDraft({ action: 'switch', level: 'adset', objectId: C, enabled: false }, live({ object: object({ kind: 'adset' }) }), NOW))
    expect(off.requests[0]).toMatchObject({ kind: 'adset', check: 'none', raisesSpend: false, operation: 'adset.settings' })
    expect((off.before as SettingsRecord).undo).toEqual({ action: 'switch', level: 'adset', objectId: C, enabled: true })
    expect(refusal(budgetScheduleDraft({ action: 'switch', level: 'campaign', objectId: C, enabled: true }, live(), NOW))).toMatch(/already on/)
  })
})
