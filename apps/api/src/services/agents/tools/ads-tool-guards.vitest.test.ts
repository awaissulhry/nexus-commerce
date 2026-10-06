/**
 * MCP full control A3 (docs/mcp-full-control/sections/01-ads.md §3 "Rules every change tool follows") — the guards
 * Claude's ad change tools run in their preview and again before they write.
 *
 *   live reach      every gate answer maps to live / sandbox / refused:<reason>; the gate is handed the campaign,
 *                   every field and the value as the ads worker hands it; a changed answer at execute is a refusal.
 *   suppression     a write never raises a suppressed target (suppressedFromBidCents set) nor an unflagged one at
 *                   ≤ 3¢; the two are counted apart; lowering or holding is not refused. Only a suppression a person
 *                   set (`user:…`) may be lifted — an engine's is refused.
 *   currency        amounts are the campaign's own minor units, labelled with its currency, never converted.
 *   actor / reason  `user:<approverId>` and `Claude request <approvalId>: <why>`.
 *   bound rules     enabled rules bound to the campaign and enabled schedules on it; disabled ones and other
 *                   campaigns' are left out.
 * PGlite with the production schema for the reads; the gate is the real one unless an arm stands in for it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../../lib/workspace-context.js'
import type { GateContext, GateDecision } from '../../advertising/ads-write-gate.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../../db.js', () => ({ default: new Proxy({}, { get: (_t, p) => Reflect.get(database.client, p) }) }))
const gate = vi.hoisted(() => ({ answer: null as GateDecision | null, seen: [] as GateContext[] }))
vi.mock('../../advertising/ads-write-gate.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../advertising/ads-write-gate.js')>()
  return {
    ...real,
    checkAdsWriteGate: async (ctx: GateContext) => {
      gate.seen.push(ctx)
      return gate.answer ?? real.checkAdsWriteGate(ctx)
    },
  }
})

import {
  amountLabel, boundAutomationsFor, campaignCurrency, checkLiveReach, claudeActor, claudeReason, liftSuppressionRefusal,
  liveReachOf, reachChanged, reachLabel, splitBySuppression, suppressionOf,
} from './ads-tool-guards.js'

const inside = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)

beforeAll(async () => {
  database = await formulaDatabase()
}, 60_000)
afterAll(async () => { await database?.close() })

describe('live reach', () => {
  it('maps every gate answer: live, sandbox, and each denial as refused with its reason', () => {
    expect(liveReachOf({ allowed: true, mode: 'live', profileId: 'P1' })).toEqual({ reach: 'live', profileId: 'P1' })
    expect(liveReachOf({ allowed: true, mode: 'sandbox' })).toEqual({ reach: 'sandbox' })
    for (const deniedAt of ['env', 'connection', 'connection_writes', 'value_cap', 'campaign_allowlist', 'daily_cap', 'entity_bounds',
      'keyword_protected', 'automation_halted', 'authority_pin', 'spend_ceiling', 'budget_day_move'] as const) {
      const reach = liveReachOf({ allowed: false, deniedAt, reason: `why ${deniedAt}` })
      expect(reach).toEqual({ reach: 'refused', deniedAt, reason: `why ${deniedAt}` })
      expect(reachLabel(reach)).toBe(`refused: why ${deniedAt}`)
    }
    expect(reachLabel({ reach: 'live', profileId: 'P1' })).toBe('live')
    expect(reachLabel({ reach: 'sandbox' })).toBe('sandbox')
  })

  it('hands the gate the campaign, every field and the value, as the ads worker does', async () => {
    gate.seen = []
    gate.answer = { allowed: false, deniedAt: 'campaign_allowlist', reason: 'campaign C1 is not on the live-write allowlist' }
    try {
      const bid = await checkLiveReach({ campaignId: 'C1', marketplace: 'IT', changes: [{ field: 'bid', valueCents: 45 }] })
      expect(bid).toEqual({ reach: 'refused', deniedAt: 'campaign_allowlist', reason: 'campaign C1 is not on the live-write allowlist' })
      const budget = await checkLiveReach({ campaignId: 'C1', marketplace: 'DE', changes: [{ field: 'dailyBudget', valueCents: 2500 }] })
      expect(budget.reach).toBe('refused')
      const both = await checkLiveReach({ campaignId: 'C1', marketplace: 'IT', changes: [{ field: 'dailyBudget', valueCents: 2500 }, { field: 'bid', valueCents: 40 }], isSuppression: true })
      expect(both.reach).toBe('refused')
    } finally {
      gate.answer = null
    }
    // 4A (Owner decided 2026-10-06) — asked as the person who approves it: his manual mark, and his approval as his
    // "Send anyway" past his own limits (the card shows them first).
    const asPerson = { manual: true, confirmOwnLimits: true }
    expect(gate.seen).toEqual([
      { marketplace: 'IT', campaignId: 'C1', field: 'bid', fields: ['bid'], intendedValueCents: 45, payloadValueCents: 45, isSuppression: false, ...asPerson },
      { marketplace: 'DE', campaignId: 'C1', field: 'dailyBudget', fields: ['dailyBudget'], intendedValueCents: 2500, payloadValueCents: 2500, isSuppression: false, ...asPerson },
      // The bid is the bounded field the gate judges; the pins see every field; the value cap sees the largest.
      { marketplace: 'IT', campaignId: 'C1', field: 'bid', fields: ['dailyBudget', 'bid'], intendedValueCents: 40, payloadValueCents: 2500, isSuppression: true, ...asPerson },
    ])
  })

  it('the real gate, with the ads mode not live: sandbox', async () => {
    vi.stubEnv('NEXUS_AMAZON_ADS_MODE', '')
    try {
      expect(await inside(() => checkLiveReach({ campaignId: 'C1', marketplace: 'IT', changes: [{ field: 'bid', valueCents: 45 }] }))).toEqual({ reach: 'sandbox' })
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('execute refuses when the answer changed since the preview', () => {
    expect(reachChanged({ reach: 'live', profileId: 'P1' }, { reach: 'live', profileId: 'P1' })).toBeNull()
    expect(reachChanged({ reach: 'sandbox' }, { reach: 'sandbox' })).toBeNull()
    expect(reachChanged({ reach: 'sandbox' }, { reach: 'live', profileId: 'P1' })).toBe('approved as sandbox, but it would now be live — not run')
    expect(reachChanged({ reach: 'live', profileId: 'P1' }, { reach: 'refused', deniedAt: 'authority_pin', reason: 'bids are pinned' }))
      .toBe('approved as live, but it would now be refused: bids are pinned — not run')
    expect(reachChanged({ reach: 'live', profileId: 'P1' }, { reach: 'live', profileId: 'P2' })).toBe('approved for Amazon Ads profile P1, but it would now reach profile P2 — not run')
  })
})

describe('suppression guard', () => {
  const t = (id: string, bidCents: number, suppressedFromBidCents: number | null = null) => ({ id, bidCents, suppressedFromBidCents })

  it('never raises a flagged target, nor an unflagged one at 3¢ or less; counts the two apart', () => {
    expect(suppressionOf(t('a', 2, 80), 50)).toBe('suppressed')
    expect(suppressionOf(t('b', 3), 50)).toBe('low-unflagged')
    expect(suppressionOf(t('c', 2), 4)).toBe('low-unflagged')
    expect(suppressionOf(t('d', 4), 50)).toBe('ok')
    // Lowering or holding is not a raise.
    expect(suppressionOf(t('e', 2, 80), 2)).toBe('ok')
    expect(suppressionOf(t('f', 3), 2)).toBe('ok')

    const writes = [
      { target: t('a', 2, 80), newBidCents: 50 }, { target: t('b', 3), newBidCents: 50 }, { target: t('c', 1), newBidCents: 10 },
      { target: t('d', 40), newBidCents: 50 }, { target: t('e', 2, 80), newBidCents: 2 },
    ]
    const split = splitBySuppression(writes)
    expect(split.allowed.map((w) => w.target.id)).toEqual(['d', 'e'])
    expect(split.suppressed.map((w) => w.target.id)).toEqual(['a'])
    expect(split.lowUnflagged.map((w) => w.target.id)).toEqual(['b', 'c'])
    expect(split.counts).toEqual({ allowed: 2, suppressed: 1, lowUnflagged: 2 })
  })

  it('only a suppression a person set may be lifted; an engine’s is refused', () => {
    const at = new Date('2026-09-30T10:00:00Z')
    expect(liftSuppressionRefusal({ bidsSuppressedAt: at, bidsSuppressedBy: 'user:u-1' })).toBeNull()
    expect(liftSuppressionRefusal({ bidsSuppressedAt: at, bidsSuppressedBy: 'automation:ad-dayparting' }))
      .toBe('its bids were suppressed by automation:ad-dayparting; only a suppression a person set may be lifted here')
    expect(liftSuppressionRefusal({ bidsSuppressedAt: at, bidsSuppressedBy: null }))
      .toBe('its bids were suppressed by an unrecorded actor; only a suppression a person set may be lifted here')
    expect(liftSuppressionRefusal({ bidsSuppressedAt: null, bidsSuppressedBy: null })).toBe('its bids are not suppressed')
  })
})

describe('currency, actor and reason', () => {
  it('labels minor units in the campaign’s own currency, never converted', () => {
    expect(campaignCurrency({ dailyBudgetCurrency: 'GBP' })).toBe('GBP')
    expect(campaignCurrency({ dailyBudgetCurrency: null })).toBe('EUR')
    expect(amountLabel(1234, 'SEK')).toBe('SEK 12.34')
    expect(amountLabel(5, 'EUR')).toBe('EUR 0.05')
  })

  it('acts as the approver, and says which request and why', () => {
    expect(claudeActor('u-approver')).toBe('user:u-approver')
    expect(() => claudeActor('  ')).toThrow('an approver is required')
    expect(claudeReason('ap-1', '  ACoS 80% over 14 days ')).toBe('Claude request ap-1: ACoS 80% over 14 days')
    expect(() => claudeReason('', 'why')).toThrow('an approval id is required')
    expect(() => claudeReason('ap-1', ' ')).toThrow('a reason is required')
  })
})

describe('bound rules', () => {
  it('names the enabled rules bound to the campaign and its enabled schedules, nothing else', async () => {
    await inside(async () => {
      const db = database.client
      const campaign = (id: string) => db.campaign.create({ data: { id, name: id, type: 'SP', marketplace: 'IT', dailyBudget: '10.00', startDate: new Date('2026-01-01T00:00:00Z') } as never })
      await campaign('g-c1')
      await campaign('g-c2')
      const rule = (id: string, name: string, enabled: boolean) => db.automationRule.create({ data: { id, name, domain: 'advertising', trigger: 'SCHEDULE', enabled, actions: [] } as never })
      await rule('g-r1', 'Budget pacer IT', true)
      await rule('g-r2', 'Old bid rule', false)
      await rule('g-r3', 'Other campaign rule', true)
      await db.campaignRuleAssignment.create({ data: { campaignId: 'g-c1', ruleId: 'g-r1', kind: 'budget' } })
      await db.campaignRuleAssignment.create({ data: { campaignId: 'g-c1', ruleId: 'g-r2', kind: 'bid' } })
      await db.campaignRuleAssignment.create({ data: { campaignId: 'g-c2', ruleId: 'g-r3', kind: 'budget' } })
      await db.adSchedule.create({ data: { id: 'g-s1', campaignId: 'g-c1', name: 'Rank hold', enabled: true } as never })
      // One schedule per campaign; a disabled one is left out.
      await db.adSchedule.create({ data: { id: 'g-s2', campaignId: 'g-c2', name: 'Switched-off window', enabled: false } as never })
      expect(await boundAutomationsFor('g-c1')).toEqual([
        { kind: 'rule', id: 'g-r1', name: 'Budget pacer IT', binding: 'budget' },
        { kind: 'schedule', id: 'g-s1', name: 'Rank hold' },
      ])
      expect(await boundAutomationsFor('g-c2')).toEqual([{ kind: 'rule', id: 'g-r3', name: 'Other campaign rule', binding: 'budget' }])
      expect(await boundAutomationsFor('g-none')).toEqual([])
    })
  })
})

/**
 * 4A (Owner decided 2026-10-06) — who an approved request writes as. Approved by a person: his manual mark and his
 * "Send anyway" (the card showed the limits first). Approved by his standing rule, or a write the rule itself makes:
 * the machine's write, judged as one.
 */
describe('4A — an approved request is his own click; a rule\'s is not', () => {
  const ctx = (approvedByPerson?: boolean) => ({ userId: 'u-approver', via: 'app', approvalId: 'ap-1', ...(approvedByPerson ? { approvedByPerson } : {}) }) as never

  it('approvedRun carries his mark only when a person approved it', async () => {
    const { approvedRun } = await import('./ads-change-kit.js')
    expect(approvedRun(ctx(true), 'why')).toMatchObject({ actor: 'user:u-approver', manual: true, confirmOwnLimits: true })
    expect(approvedRun(ctx(), 'why')).toMatchObject({ actor: 'user:u-approver', manual: false, confirmOwnLimits: false })
  })

  it('the re-check inside a rule-approved run, and a rule\'s own write, are asked without his mark', async () => {
    const { runAsRuleApproved } = await import('../tool-types.js')
    gate.answer = { allowed: true, mode: 'sandbox' }
    gate.seen = []
    try {
      const intent = { campaignId: 'C1', marketplace: 'IT', changes: [{ field: 'bid', valueCents: 45 }] }
      await checkLiveReach(intent)
      await runAsRuleApproved(() => checkLiveReach(intent))
      await checkLiveReach({ ...intent, byRule: true })
    } finally {
      gate.answer = null
    }
    expect(gate.seen.map((c) => [c.manual === true, c.confirmOwnLimits === true])).toEqual([[true, true], [false, false], [false, false]])
  })

  it('the limits the card warned about are part of what he approved: the same limits run, different ones are not run', async () => {
    const { recheck } = await import('./ads-change-kit.js')
    const past = [{ limit: 'entity_bounds', reason: 'bid 150¢ exceeds the 100¢ ceiling' }]
    const approved = { reach: { reach: 'live', profileId: 'P1', pastOwnLimits: past }, value: 150 }
    const at = { ...(ctx(true) as object), approvedPreview: approved } as never
    expect(recheck(at, { ok: true, preview: approved }, ['value'])).toBeNull()
    const more = { ...approved, reach: { ...approved.reach, pastOwnLimits: [...past, { limit: 'value_cap', reason: 'payload value over the cap' }] } }
    expect(recheck(at, { ok: true, preview: more }, ['value'])).toMatch(/^Not run: the limits it goes past changed after you approved it\. .*payload value over the cap.* Ask for it again/)
  })
})
