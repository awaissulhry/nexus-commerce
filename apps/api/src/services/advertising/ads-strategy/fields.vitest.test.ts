/**
 * ADS AUTONOMY W1-2 — the strategy's field registry and its one unit converter.
 *
 *   units      an integer percent becomes the engines' fraction (30 → 0.3) and back; a stored fraction (0.3) is never
 *              read as a percent, nor a percent (30) as 3,000 %
 *   schema     every registry column is an AdsStrategy column and every setting column is in the registry
 *   honest     only the fields something acts on have readers (W1-5: the target, the bid band and the largest change,
 *              each reader named; W1-6: the monthly market cap, the stop bid and the actions per run; W1-7: harvest,
 *              negate, protect; W1-8: Claude's door reads what Claude may do alone), and notReadYet lists every other
 *              field; a reader names where and how
 *   stricter   the one order two harvest (or negate) groups are compared by, everywhere they meet
 *   money      every money field's value keys are stripped for a person without ad-spend money
 *   names      every tool an action type narrows is a registered tool and knows where its change lands; no brake is
 *              among them; the constants mirror their sources
 */
import { describe, expect, it } from 'vitest'
import { Prisma } from '@prisma/client'
import { FIELDS } from '@nexus/shared/permissions'
import { listTools } from '../../agents/tool-registry.js'
import { SUPPRESSION_FLOOR_CENTS } from '../ads-bid-suppression.service.js'
import { MAX_ACCOUNT_DEFAULT_PCT } from '../ads-target-acos-resolver.js'
import { BRAKE_TOOLS, OP_ACTIONS, PLACES, actionOfTool } from './claude.js'
import {
  CLAUDE_ACTION_TOOLS,
  CLAUDE_DAILY_FIELDS,
  CLAUDE_DOOR,
  FIELD_BY_KEY,
  COLUMN_CHECKS,
  DEFAULT_STOP_BID_CENTS,
  MAX_TARGET_PCT,
  READERS,
  STRATEGY_FIELDS,
  STRATEGY_MONEY,
  fractionToPct,
  harvestStricter,
  negateStricter,
  notReadYet,
  pctToFraction,
} from './fields.js'

describe('the one unit converter (the 30-vs-0.3 trap)', () => {
  it('an integer percent is the fraction the engines take, and back', () => {
    expect(pctToFraction(30)).toBe(0.3)
    expect(pctToFraction(1)).toBe(0.01)
    expect(pctToFraction(500)).toBe(5)
    expect(fractionToPct(0.3)).toBe(30)
    expect(fractionToPct(0.07)).toBe(7)
    expect(fractionToPct(pctToFraction(29)!)).toBe(29)
  })

  it('a fraction stored where a percent belongs is not read (never 0.3 % and never 30 %), nor anything outside 1–500', () => {
    for (const bad of [0.3, 0, -5, 501, 25.5, '25', null, undefined, Number.NaN]) expect(pctToFraction(bad), String(bad)).toBeNull()
  })

  it('the range is the account default\'s, and the stop floor is the suppression floor', () => {
    expect(MAX_TARGET_PCT).toBe(MAX_ACCOUNT_DEFAULT_PCT)
    expect(DEFAULT_STOP_BID_CENTS).toBe(SUPPRESSION_FLOOR_CENTS)
  })
})

describe('the registry', () => {
  const settingColumns = Object.keys(Prisma.AdsStrategyScalarFieldEnum).filter((c) =>
    !['workspaceId', 'id', 'channel', 'market', 'level', 'scopeId', 'label', 'version', 'createdAt', 'updatedAt', 'updatedBy'].includes(c))

  it('holds every setting column of AdsStrategy, each checked when read, and no column the table does not have', () => {
    const registered = new Set(STRATEGY_FIELDS.flatMap((f) => f.columns))
    expect([...registered].sort()).toEqual([...settingColumns].sort())
    expect(Object.keys(COLUMN_CHECKS).sort()).toEqual([...settingColumns].sort())
  })

  it('is honest: the bid fields (W1-5), the monthly cap, the stop bid and the actions per run (W1-6), the search-term thresholds and protection (W1-7), what Claude may do alone (W1-8) and what may run by rule a day (AA-W2-2b) have readers; every other field is stored and shown only', () => {
    const read = ['target', 'targetAcosPct', 'monthlySpendCapCents', 'minBidCents', 'maxBidCents', 'maxChangePct', 'maxActionsPerRun', 'protect', 'harvest', 'negate', 'stop', 'claudeAutonomy', ...CLAUDE_DAILY_FIELDS]
    expect(STRATEGY_FIELDS.filter((f) => f.readBy.length).map((f) => f.key)).toEqual(read)
    expect(notReadYet()).toEqual(STRATEGY_FIELDS.map((f) => f.key).filter((key) => !read.includes(key)))
    expect(notReadYet()).toEqual(['goal', 'goalNote', 'reviewEveryDays'])
    // W1-5 — the bid fields, reader by reader.
    const byKey = (key: string) => STRATEGY_FIELDS.find((f) => f.key === key)!.readBy
    const target = [READERS.optimiser, READERS.bidRules, READERS.autopilot]
    const band = [READERS.gate, READERS.optimiser, READERS.bidRules, READERS.hourly, READERS.restores, READERS.autopilot]
    expect([byKey('target'), byKey('minBidCents'), byKey('maxBidCents')]).toEqual([target, band, band])
    // AA-W2-8 — the ACoS target the engines use also holds a campaign target Claude raises by rule.
    expect(byKey('targetAcosPct')).toEqual([...target, expect.stringMatching(/^Claude's door, for an ad change that may run by the business's rule .*: a campaign's own target ACoS that Claude raises by rule stays at or below it/)])
    expect(byKey('maxChangePct')).toEqual([READERS.stepClamp, READERS.optimiser, READERS.claudePreview, READERS.autopilot])
    expect(byKey('claudeAutonomy')).toEqual([CLAUDE_DOOR])
    // Each reader says where it acts, in words a screen can show.
    for (const f of STRATEGY_FIELDS.filter((x) => x.readBy.length)) for (const r of f.readBy) expect(r.length, f.key).toBeGreaterThan(20)
    expect(byKey('harvest').join(' ')).toMatch(/Keyword Harvest page.*stricter/)
    expect(byKey('protect').join(' ')).toMatch(/no engine, rule or schedule negates a protected product's ASIN; a person's own add, or a Claude request he approved, is warned/)
    // W1-6 — the budget engine stops a market at its cap with the stop bid (ads-budget-enforce.service.ts; W1-6b: a
    // category's or product's cap floors the ad groups holding it, ads-strategy/spend.ts); the retail
    // guard (ads-retail-readiness.service.ts) and suppress-campaign (ads-change.tools.ts) floor at the stop bid; the
    // engine guard (ads-engine-guard.ts) counts a market's actions per run for the engines that name the market.
    const readers = (key: string) => byKey(key).join(' | ')
    expect(readers('monthlySpendCapCents')).toMatch(/^the budget engine .*every campaign of the market drops to its stop bid until the 1st \(a cap of 0 is no cap\) \| the budget engine: when a category's or product's .* every ad group holding a product under it drops to its stop bid until the 1st/)
    expect(readers('stop')).toMatch(/^the budget engine: .* \| the retail guard: .* \| Claude's suppress-campaign: /)
    expect(readers('maxActionsPerRun')).toMatch(/^the hourly bid plans \(rank-defend\): .* \| the budget engine .* \| dayparting /)
    // AA-W2-2b — Claude's daily limits: read by Claude's door for a change that may run by rule (ads-autonomy-kit.ts C5),
    // only where an ad tool is set to run by rule and its code allows it; empty is 0.
    for (const key of CLAUDE_DAILY_FIELDS) {
      expect(byKey(key), key).toHaveLength(1)
      expect(readers(key), key).toMatch(new RegExp(`^${READERS.claudeByRule.replace(/[()]/g, '\\$&')}: .*; empty is 0 — no (change|raise|budget increase) runs by rule$`))
    }
  })

  it('every money field keeps its numbers under keys the money filter strips (ad-spend money)', () => {
    const valueKeys = (f: (typeof STRATEGY_FIELDS)[number]) => (f.derivedFrom ? [f.key] : f.columns)
    const moneyKeys = new Set(Object.keys(STRATEGY_MONEY))
    for (const f of STRATEGY_FIELDS.filter((x) => x.money)) {
      expect(valueKeys(f).some((k) => moneyKeys.has(k)), f.key).toBe(true)
    }
    // A field that is not money carries no money key.
    for (const f of STRATEGY_FIELDS.filter((x) => !x.money)) expect(valueKeys(f).filter((k) => moneyKeys.has(k)), f.key).toEqual([])
    expect(new Set(Object.values(STRATEGY_MONEY))).toEqual(new Set([FIELDS.financialsAdspendView]))
  })

  it('AA-W2-2b — Claude\'s daily limits sit on the market row only, the lower one is safer, any increase is a raise, and the budget is money', () => {
    for (const key of CLAUDE_DAILY_FIELDS) {
      expect(FIELD_BY_KEY.get(key), key).toMatchObject({ columns: [key], levels: ['MARKET'], resolve: 'inherit', safer: 'lower', raise: 'count' })
      expect(COLUMN_CHECKS[key], key).toMatchObject({ kind: 'int', min: 0 })
    }
    expect(STRATEGY_MONEY.claudeMaxBudgetIncreasePerDayCents).toBe(FIELDS.financialsAdspendView)
    expect(FIELD_BY_KEY.get('claudeMaxChangesPerDay')!.money).toBe(false)
    expect(FIELD_BY_KEY.get('claudeMaxRaisesPerDay')!.money).toBe(false)
  })

  it('a group names the columns that make it set; a single field is its own column', () => {
    for (const f of STRATEGY_FIELDS) {
      for (const c of f.required ?? []) expect(f.columns, f.key).toContain(c)
    }
    expect(STRATEGY_FIELDS.find((f) => f.key === 'harvest')!.required).not.toContain('harvestMaxAcosPct')
    expect(STRATEGY_FIELDS.find((f) => f.key === 'stop')!.required).toEqual(['stopMethod'])
  })

  it('two groups are compared in one order: more orders (clicks), then more clicks (spend), then the tighter ceiling', () => {
    const h = (minOrders: number, minClicks: number, maxAcosPct: number | null) => ({ minOrders, minClicks, maxAcosPct })
    expect(harvestStricter(h(3, 0, null), h(2, 9, 10))).toBe(true)
    expect(harvestStricter(h(2, 5, null), h(2, 4, 10))).toBe(true)
    expect(harvestStricter(h(2, 5, 30), h(2, 5, 40))).toBe(true)
    expect(harvestStricter(h(2, 5, 40), h(2, 5, null))).toBe(true)
    expect(harvestStricter(h(2, 5, null), h(2, 5, 40))).toBe(false)
    expect(harvestStricter(h(2, 5, 40), h(2, 5, 40))).toBe(false)
    const n = (minClicks: number, minSpendCents: number, maxOrders: number) => ({ minClicks, minSpendCents, maxOrders })
    expect(negateStricter(n(20, 0, 5), n(10, 9999, 0))).toBe(true)
    expect(negateStricter(n(10, 600, 5), n(10, 500, 0))).toBe(true)
    expect(negateStricter(n(10, 500, 0), n(10, 500, 1))).toBe(true)
    expect(negateStricter(n(10, 500, 1), n(10, 500, 1))).toBe(false)
  })

  it('every tool an action type narrows is a registered tool', () => {
    const tools = new Set(listTools().map((t) => t.name))
    expect(Object.values(CLAUDE_ACTION_TOOLS).flat().filter((name) => !tools.has(name))).toEqual([])
  })

  it('W1-8 — each of those tools knows where its change lands; brakes are registered tools, none of them, never narrowed', () => {
    const narrowed = [...new Set(Object.values(CLAUDE_ACTION_TOOLS).flat())]
    expect(Object.keys(PLACES).sort()).toEqual([...narrowed].sort())
    const tools = new Set(listTools().map((t) => t.name))
    for (const brake of BRAKE_TOOLS) {
      expect(tools.has(brake), brake).toBe(true)
      expect(narrowed, brake).not.toContain(brake)
      expect(actionOfTool(brake), brake).toBeNull()
    }
    // A tool is its first kind; one listed again under an op's kind (PB-9: apply-ads-playbook under phase) has that op.
    const seen = new Set<string>()
    for (const [action, names] of Object.entries(CLAUDE_ACTION_TOOLS)) {
      for (const name of names) {
        if (seen.has(name)) expect(Object.values(OP_ACTIONS[name] ?? {}), `${name} under ${action}`).toContain(action)
        else expect(actionOfTool(name)).toBe(action)
        seen.add(name)
      }
    }
    expect(actionOfTool('set-price')).toBeNull()
  })

  it('PB-5a — a tool of several ops: each op its own kind (null: never narrowed); an op not listed, or no args, the tool\'s kind', () => {
    expect(actionOfTool('apply-ads-playbook', { op: 'build' })).toBe('create')
    expect(actionOfTool('apply-ads-playbook', { op: 'adopt' })).toBeNull()
    // PB-9 — a phase switch is its own kind; the tool stays create when no op says otherwise.
    expect(actionOfTool('apply-ads-playbook', { op: 'phase' })).toBe('phase')
    expect(CLAUDE_ACTION_TOOLS.phase).toContain('apply-ads-playbook')
    expect(actionOfTool('apply-ads-playbook', { op: 'something-else' })).toBe('create')
    expect(actionOfTool('apply-ads-playbook')).toBe('create')
    // Every tool with ops is a narrowed tool, and each op names a real kind (or null).
    for (const [tool, ops] of Object.entries(OP_ACTIONS)) {
      expect(Object.values(CLAUDE_ACTION_TOOLS).flat(), tool).toContain(tool)
      for (const action of Object.values(ops)) if (action) expect(Object.keys(CLAUDE_ACTION_TOOLS)).toContain(action)
    }
  })
})
