/**
 * NEG.0 — the two safety fixes, pinned.
 *
 * These tests exist to fail if a branch is deleted, which is the specific failure mode this fix
 * repairs: `protectConverting` was written, rendered, defaulted ON, and read by nothing for as long
 * as it has existed. A pure-function test alone would not have caught that — the pure function did
 * not exist either. So the second half of this file drives the real handler and asserts that the
 * refusal reaches the caller AND that `createNegative` is never called.
 *
 * The three things that must stay true:
 *   1. a term that converted in the window is refused, and the refusal names the numbers;
 *   2. `createNegative` is not called on a refusal (a "protection" that writes anyway is not one);
 *   3. `createNegative` IS called with a `marketplace` on the allowed path — fix (b), which without
 *      a test is one `as never` away from silently reverting.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  normaliseNegTerm,
  protectConvertingConfig,
  decideNegation,
  type ConvertedTerm,
} from './ads-protect-converting.js'

const conv = (orders: number, salesCents = 0, markets: string[] = ['IT']): ConvertedTerm =>
  ({ orders, salesCents, markets })
const ON = { enabled: true, days: 30 }

describe('normaliseNegTerm — one normalisation, used on both sides of the compare', () => {
  it('folds the case Amazon does not send back', () => {
    // Our negatives carry mixed case; Amazon's search terms arrive lower-case. Comparing raw
    // strings would let exactly the brand terms through: "AIRMESH pant", "giacca MOSS".
    expect(normaliseNegTerm('AIRMESH pant')).toBe('airmesh pant')
    expect(normaliseNegTerm('giacca MOSS')).toBe('giacca moss')
  })
  it('collapses the whitespace a paste introduces', () => {
    expect(normaliseNegTerm('  giacca   moto  ')).toBe('giacca moto')
    expect(normaliseNegTerm('giacca\tmoto')).toBe('giacca moto')
  })
})

describe('protectConvertingConfig — absent means ON', () => {
  it('🔴 a rule that never saw the switch is still protected', () => {
    // Every seeded rule in the account carries no key at all. Defaulting those to OFF would
    // protect only rules built after the switch shipped — the same half-protection this fixes.
    expect(protectConvertingConfig({})).toEqual({ enabled: true, days: 30 })
    expect(protectConvertingConfig(null)).toEqual({ enabled: true, days: 30 })
    expect(protectConvertingConfig(undefined)).toEqual({ enabled: true, days: 30 })
  })
  it('only an explicit false turns it off', () => {
    expect(protectConvertingConfig({ protectConverting: false }).enabled).toBe(false)
    expect(protectConvertingConfig({ protectConverting: true }).enabled).toBe(true)
    // The adapter writes a boolean, but a hand-edited rule JSON is a string. Anything that is not
    // exactly `false` keeps the protection on, because the failure direction matters here.
    expect(protectConvertingConfig({ protectConverting: 'false' }).enabled).toBe(true)
    expect(protectConvertingConfig({ protectConverting: 0 }).enabled).toBe(true)
  })
  it('carries the window, and refuses one that would disable the check', () => {
    expect(protectConvertingConfig({ protectDays: 60 }).days).toBe(60)
    expect(protectConvertingConfig({ protectDays: 0 }).days).toBe(30)
    expect(protectConvertingConfig({ protectDays: -7 }).days).toBe(30)
    expect(protectConvertingConfig({ protectDays: 'abc' }).days).toBe(30)
    expect(protectConvertingConfig({ protectDays: 100000 }).days).toBe(365)
  })
})

describe('decideNegation — the branch', () => {
  it('refuses a term with an order in the window', () => {
    const d = decideNegation({ term: 'giacca moto', config: ON, converted: new Map([['giacca moto', conv(3, 28521)]]) })
    expect(d.allowed).toBe(false)
    expect(d.evidence).toEqual({ term: 'giacca moto', orders: 3, salesCents: 28521, markets: ['IT'], windowDays: 30 })
  })

  it('the refusal is legible — it names the orders, the money, the market and the window', () => {
    // "recorded and legible, not a silent skip": the reason string is what lands in the execution
    // row's actionResults, and it is the only thing an operator will ever read about this.
    const d = decideNegation({ term: 'giacca moto', config: ON, converted: new Map([['giacca moto', conv(3, 28521, ['DE', 'IT'])]]) })
    expect(d.reason).toContain('3 orders')
    expect(d.reason).toContain('€285.21')
    expect(d.reason).toContain('DE, IT')
    expect(d.reason).toContain('30 days')
  })

  it('allows a term with no order in the window', () => {
    const d = decideNegation({ term: 'saponette moto', config: ON, converted: new Map([['giacca moto', conv(3)]]) })
    expect(d.allowed).toBe(true)
    expect(d.evidence).toBeNull()
  })

  it('matches across case and whitespace — the whole point of the normalisation', () => {
    const converted = new Map([['giacca moto', conv(1, 8115)]])
    expect(decideNegation({ term: 'Giacca  Moto', config: ON, converted }).allowed).toBe(false)
    expect(decideNegation({ term: ' GIACCA MOTO ', config: ON, converted }).allowed).toBe(false)
  })

  it('an explicit off lets a converting term through, and says so', () => {
    const d = decideNegation({ term: 'giacca moto', config: { enabled: false, days: 30 }, converted: new Map([['giacca moto', conv(9)]]) })
    expect(d.allowed).toBe(true)
    expect(d.reason).toMatch(/is off on this rule/)
  })

  it('a zero-order entry is not a conversion', () => {
    // Defensive: `convertedTermsIn` filters `orders7d > 0`, but the map is an argument and a future
    // caller could build one that does not.
    expect(decideNegation({ term: 'x', config: ON, converted: new Map([['x', conv(0)]]) }).allowed).toBe(true)
  })

  it('an empty term is refused rather than negated', () => {
    expect(decideNegation({ term: '   ', config: ON, converted: new Map() }).allowed).toBe(false)
  })
})

// ── The handler, driven for real ──────────────────────────────────────────────────────────────
//
// Mocking the engine module rather than importing it keeps this test off the rule engine entirely;
// `automation-action-handlers.ts` registers into whatever ACTION_HANDLERS object it is handed.

const h = vi.hoisted(() => ({ createNegative: vi.fn() }))

vi.mock('../automation-rule.service.js', () => ({
  ACTION_HANDLERS: {} as Record<string, unknown>,
  getFieldPath: vi.fn(),
}))
vi.mock('./ads-mutation.service.js', () => ({
  updateCampaignWithSync: vi.fn(),
  updateAdGroupWithSync: vi.fn(),
  updateAdTargetWithSync: vi.fn(),
}))
vi.mock('./ads-negative-kw.service.js', () => ({ createNegative: h.createNegative }))
vi.mock('../../db.js', () => ({
  default: {
    amazonAdsSearchTerm: { groupBy: vi.fn() },
    amazonAdsConnection: { findFirst: vi.fn() },
    campaign: { findMany: vi.fn(), findFirst: vi.fn() },
    automationRule: { findUnique: vi.fn() },
    automationRuleExecution: { findMany: vi.fn() },
    adGroup: { findFirst: vi.fn(), findMany: vi.fn() },
  },
}))

import prisma from '../../db.js'
import { ACTION_HANDLERS } from '../automation-rule.service.js'
import './automation-action-handlers.js'

const db = vi.mocked(prisma, true)
const meta = { dryRun: false, ruleId: 'rule-1' }
const call = (action: Record<string, unknown>, context: Record<string, unknown>) =>
  (ACTION_HANDLERS.add_negative_exact as (a: unknown, c: unknown, m: unknown) => Promise<{ ok: boolean; error?: string; output?: unknown }>)(action, context, meta)

beforeEach(() => {
  vi.clearAllMocks()
  db.amazonAdsSearchTerm.groupBy.mockResolvedValue([] as never)
  db.amazonAdsConnection.findFirst.mockResolvedValue({ profileId: 'p1' } as never)
  h.createNegative.mockResolvedValue({ ok: true, alreadyExisted: false, denied: null, externalNegativeKeywordId: 'k1' })
})

describe('add_negative_exact — the handler reads the toggle', () => {
  it('🔴 refuses a converting term, and does NOT call createNegative', async () => {
    db.amazonAdsSearchTerm.groupBy.mockResolvedValue([
      { query: 'giacca moto', marketplace: 'IT', _sum: { orders7d: 2, sales7dCents: 16722 } },
    ] as never)

    const r = await call({ type: 'add_negative_exact', keyword: 'Giacca Moto' }, { marketplace: 'IT', campaign: { externalCampaignId: 'C1' } })

    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/protect converting/i)
    expect(h.createNegative).not.toHaveBeenCalled()
  })

  it('negates a term with no orders — and passes the marketplace the gate needs (fix b)', async () => {
    const r = await call({ type: 'add_negative_exact', keyword: 'saponette moto' }, { marketplace: 'IT', campaign: { externalCampaignId: 'C1' } })

    expect(r.ok).toBe(true)
    expect(h.createNegative).toHaveBeenCalledTimes(1)
    // Without this, the gate's FIRST check (`!ctx.marketplace → deniedAt:'connection'`) fires
    // before the whitelist is ever consulted, and every campaign-scope negative in the account
    // becomes a local-only row Amazon has never heard of. That is what the 22 rows are.
    expect(h.createNegative.mock.calls[0][0]).toMatchObject({ marketplace: 'IT', keywordText: 'saponette moto' })
  })

  it('an explicit protectConverting:false still negates a converting term', async () => {
    db.amazonAdsSearchTerm.groupBy.mockResolvedValue([
      { query: 'giacca moto', marketplace: 'IT', _sum: { orders7d: 2, sales7dCents: 16722 } },
    ] as never)

    const r = await call(
      { type: 'add_negative_exact', keyword: 'giacca moto', protectConverting: false },
      { marketplace: 'IT', campaign: { externalCampaignId: 'C1' } },
    )

    expect(r.ok).toBe(true)
    expect(h.createNegative).toHaveBeenCalledTimes(1)
  })

  it('refuses rather than writing blind when the context carries no marketplace', async () => {
    // Previously this reached `createNegative` with `marketplace: undefined` behind an `as never`,
    // was denied at the gate's connection check, and reported ok:true to the execution row.
    const r = await call({ type: 'add_negative_exact', keyword: 'saponette moto' }, { campaign: { externalCampaignId: 'C1' } })

    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/marketplace/i)
    expect(h.createNegative).not.toHaveBeenCalled()
  })

  it('reports a gate denial as a failure instead of success', async () => {
    h.createNegative.mockResolvedValue({ ok: false, alreadyExisted: false, denied: { reason: 'protected term', deniedAt: 'protection' }, externalNegativeKeywordId: null })

    const r = await call({ type: 'add_negative_exact', keyword: 'xavia' }, { marketplace: 'IT', campaign: { externalCampaignId: 'C1' } })

    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/protected term/)
  })

  it('a dry run still reports what it would have refused', async () => {
    db.amazonAdsSearchTerm.groupBy.mockResolvedValue([
      { query: 'giacca moto', marketplace: 'IT', _sum: { orders7d: 2, sales7dCents: 16722 } },
    ] as never)

    const r = await (ACTION_HANDLERS.add_negative_exact as (a: unknown, c: unknown, m: unknown) => Promise<{ ok: boolean; error?: string; output?: unknown }>)(
      { type: 'add_negative_exact', keyword: 'giacca moto' },
      { marketplace: 'IT', campaign: { externalCampaignId: 'C1' } },
      { dryRun: true, ruleId: 'rule-1' },
    )

    // Every one of the seven rules is on PROPOSE, so this is the ONLY path any of them takes today.
    // A preview that says "would negate" about a term the armed rule would refuse is the same lie
    // in a different place.
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/protect converting/i)
    expect(h.createNegative).not.toHaveBeenCalled()
  })
})
