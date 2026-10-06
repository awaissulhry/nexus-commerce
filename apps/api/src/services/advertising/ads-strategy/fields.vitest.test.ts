/**
 * ADS AUTONOMY W1-2 — the strategy's field registry and its one unit converter.
 *
 *   units      an integer percent becomes the engines' fraction (30 → 0.3) and back; a stored fraction (0.3) is never
 *              read as a percent, nor a percent (30) as 3,000 %
 *   schema     every registry column is an AdsStrategy column and every setting column is in the registry
 *   honest     the bid engines (W1-5) read the target, the lowest and highest bid and the largest bid change, Claude's
 *              door (W1-8) what Claude may do alone, each named; notReadYet lists every other field
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
import { BRAKE_TOOLS, PLACES, actionOfTool } from './claude.js'
import {
  CLAUDE_ACTION_TOOLS,
  CLAUDE_DOOR,
  COLUMN_CHECKS,
  DEFAULT_STOP_BID_CENTS,
  MAX_TARGET_PCT,
  READERS,
  STRATEGY_FIELDS,
  STRATEGY_MONEY,
  fractionToPct,
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

  it("is honest: the bid engines (W1-5) and Claude's door (W1-8) read their fields, named by reader; nothing else is read yet", () => {
    const target = [READERS.optimiser, READERS.bidRules, READERS.autopilot]
    const band = [READERS.gate, READERS.optimiser, READERS.bidRules, READERS.hourly, READERS.restores, READERS.autopilot]
    expect(Object.fromEntries(STRATEGY_FIELDS.filter((f) => f.readBy.length).map((f) => [f.key, f.readBy]))).toEqual({
      target,
      targetAcosPct: target,
      minBidCents: band,
      maxBidCents: band,
      maxChangePct: [READERS.stepClamp, READERS.optimiser, READERS.claudePreview, READERS.autopilot],
      claudeAutonomy: [CLAUDE_DOOR],
    })
    // Spend caps (W1-6), search terms and protection (W1-7) and the rest: stored and shown only.
    expect(notReadYet()).toEqual(['goal', 'goalNote', 'monthlySpendCapCents', 'maxActionsPerRun', 'protect', 'harvest', 'negate', 'stop', 'reviewEveryDays'])
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

  it('a group names the columns that make it set; a single field is its own column', () => {
    for (const f of STRATEGY_FIELDS) {
      for (const c of f.required ?? []) expect(f.columns, f.key).toContain(c)
    }
    expect(STRATEGY_FIELDS.find((f) => f.key === 'harvest')!.required).not.toContain('harvestMaxAcosPct')
    expect(STRATEGY_FIELDS.find((f) => f.key === 'stop')!.required).toEqual(['stopMethod'])
  })

  it('every tool an action type narrows is a registered tool', () => {
    const tools = new Set(listTools().map((t) => t.name))
    expect(Object.values(CLAUDE_ACTION_TOOLS).flat().filter((name) => !tools.has(name))).toEqual([])
  })

  it('W1-8 — each of those tools knows where its change lands; brakes are registered tools, none of them, never narrowed', () => {
    const narrowed = Object.values(CLAUDE_ACTION_TOOLS).flat()
    expect(Object.keys(PLACES).sort()).toEqual([...narrowed].sort())
    const tools = new Set(listTools().map((t) => t.name))
    for (const brake of BRAKE_TOOLS) {
      expect(tools.has(brake), brake).toBe(true)
      expect(narrowed, brake).not.toContain(brake)
      expect(actionOfTool(brake), brake).toBeNull()
    }
    for (const [action, names] of Object.entries(CLAUDE_ACTION_TOOLS)) for (const name of names) expect(actionOfTool(name)).toBe(action)
    expect(actionOfTool('set-price')).toBeNull()
  })
})
