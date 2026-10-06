/**
 * ADS AUTONOMY W1-2 — the strategy's field registry and its one unit converter.
 *
 *   units      an integer percent becomes the engines' fraction (30 → 0.3) and back; a stored fraction (0.3) is never
 *              read as a percent, nor a percent (30) as 3,000 %
 *   schema     every registry column is an AdsStrategy column and every setting column is in the registry
 *   honest     only the fields an engine acts on have readers (W1-7: harvest, negate, protect), and notReadYet lists
 *              every other field; a reader names where and how
 *   stricter   the one order two harvest (or negate) groups are compared by, everywhere they meet
 *   money      every money field's value keys are stripped for a person without ad-spend money
 *   names      every tool an action type narrows is a registered tool; the constants mirror their sources
 */
import { describe, expect, it } from 'vitest'
import { Prisma } from '@prisma/client'
import { FIELDS } from '@nexus/shared/permissions'
import { listTools } from '../../agents/tool-registry.js'
import { SUPPRESSION_FLOOR_CENTS } from '../ads-bid-suppression.service.js'
import { MAX_ACCOUNT_DEFAULT_PCT } from '../ads-target-acos-resolver.js'
import {
  CLAUDE_ACTION_TOOLS,
  COLUMN_CHECKS,
  DEFAULT_STOP_BID_CENTS,
  MAX_TARGET_PCT,
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

  it('is honest: only the search-term thresholds and protection have readers (W1-7); every other field is stored and shown only', () => {
    const read = ['harvest', 'negate', 'protect']
    expect(STRATEGY_FIELDS.filter((f) => f.readBy.length).map((f) => f.key)).toEqual(['protect', 'harvest', 'negate'])
    expect(notReadYet()).toEqual(STRATEGY_FIELDS.map((f) => f.key).filter((key) => !read.includes(key)))
    // Each reader says where it acts, in words a screen can show.
    for (const f of STRATEGY_FIELDS.filter((x) => x.readBy.length)) for (const r of f.readBy) expect(r.length, f.key).toBeGreaterThan(20)
    expect(STRATEGY_FIELDS.find((f) => f.key === 'harvest')!.readBy.join(' ')).toMatch(/Keyword Harvest page.*stricter/)
    expect(STRATEGY_FIELDS.find((f) => f.key === 'protect')!.readBy.join(' ')).toMatch(/no ASIN negative of a protected product, from anyone/)
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
})
