/**
 * ONE BRAIN AB-6 — the rule-driven budget writers that touch several campaigns leave a daily budget a product's brain owns
 * (or the Owner holds), in a dry run too, and count it:
 *   pace_budget            a held out-of-budget winner is neither raised nor offered
 *   liquidate_aged_stock   a held campaign of the aged product is not boosted
 * Nothing enrolled (production today): exactly as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  campaignLeverOwners: vi.fn(),
  anyBrainEnrolled: vi.fn(),
  updateCampaignWithSync: vi.fn(),
  handlers: {} as Record<string, (a: unknown, c: unknown, m: unknown) => Promise<{ ok: boolean; output?: Record<string, any> }>>,
}))
vi.mock('../automation-rule.service.js', () => ({ ACTION_HANDLERS: h.handlers, getFieldPath: vi.fn() }))
vi.mock('./ads-mutation.service.js', () => ({ updateCampaignWithSync: h.updateCampaignWithSync }))
vi.mock('./brain/lever-owners.js', () => ({
  campaignLeverOwners: (...a: unknown[]) => h.campaignLeverOwners(...a),
  anyBrainEnrolled: (...a: unknown[]) => h.anyBrainEnrolled(...a),
}))
vi.mock('../../db.js', () => ({
  default: {
    campaign: { findMany: vi.fn() },
    product: { findUnique: vi.fn() },
    productProfitDaily: { aggregate: vi.fn() },
  },
}))

import prisma from '../../db.js'
import './ads-budget-pacing.service.js'
import { liquidateAgedStock } from './promotion-ad-coordinator.service.js'

const db = vi.mocked(prisma, true)
const OWNED = { kind: 'owned', productId: 'gale', market: 'IT', why: 'AUTO by the Owner\'s product override' }
const held = (id: string) => new Map([[id, { campaignId: id, name: `GALE ${id}`, market: 'IT', levers: { budgets: OWNED } }]])

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'live')
  h.anyBrainEnrolled.mockResolvedValue(true)
  h.campaignLeverOwners.mockResolvedValue(new Map())
  h.updateCampaignWithSync.mockResolvedValue({ ok: true, outboundQueueId: 'q1', actionLogId: 'l1' })
})
afterEach(() => vi.unstubAllEnvs())

describe('pace_budget', () => {
  const winner = (id: string) => ({ id, name: id, marketplace: 'IT', dailyBudget: '10.00', spend: '50.00', sales: '400.00', roas: '8.0', deliveryReasons: ['CAMPAIGN_OUT_OF_BUDGET'] })
  beforeEach(() => { db.campaign.findMany.mockResolvedValue([winner('c-gale'), winner('c-misano')] as never) })
  const pace = (dryRun: boolean) => h.handlers.pace_budget({ type: 'pace_budget' }, {}, { dryRun, ruleId: 'rule-pace' })

  it('a held winner is not raised, the other is; counted', async () => {
    h.campaignLeverOwners.mockResolvedValue(held('c-gale'))
    const r = await pace(false)
    expect(h.updateCampaignWithSync).toHaveBeenCalledTimes(1)
    expect(h.updateCampaignWithSync.mock.calls[0][0]).toMatchObject({ campaignId: 'c-misano', actor: 'automation:rule-pace' })
    expect(r.output).toMatchObject({ raised: 1, brainSkips: { counts: { productBrain: { budgets: 1 } }, sample: [{ campaignId: 'c-gale', holder: 'productBrain' }] } })
  })

  it('a dry run offers only the free one; all held → nothing to propose', async () => {
    h.campaignLeverOwners.mockResolvedValue(held('c-gale'))
    expect((await pace(true)).output).toMatchObject({ dryRun: true, wouldRaise: 1 })
    h.campaignLeverOwners.mockResolvedValue(new Map([...held('c-gale'), ...held('c-misano')]))
    expect((await pace(true)).output).toMatchObject({ dryRun: true, wouldRaise: 0, noChange: true, brainSkips: { counts: { productBrain: { budgets: 2 } } } })
  })

  it('nothing enrolled: both raised as before, no brainSkips', async () => {
    h.anyBrainEnrolled.mockResolvedValue(false)
    const r = await pace(false)
    expect(h.updateCampaignWithSync).toHaveBeenCalledTimes(2)
    expect(r.output).toEqual({ raised: 2 })
  })
})

describe('liquidate_aged_stock — the boost', () => {
  beforeEach(() => {
    db.product.findUnique.mockResolvedValue({ id: 'p-aged', sku: 'AGED-1', productType: 'JACKET' } as never)
    db.productProfitDaily.aggregate.mockResolvedValue({ _sum: { revenueCents: 0, trueProfitCents: 0 }, _count: 0 } as never)
    db.campaign.findMany.mockResolvedValue([{ id: 'c-gale', name: 'GALE', dailyBudget: '10.00' }, { id: 'c-misano', name: 'MISANO', dailyBudget: '20.00' }] as never)
  })
  const liquidate = (dryRun: boolean) => liquidateAgedStock({ productId: 'p-aged', marketplace: 'IT', discountPct: 15, durationDays: 14, boostPercent: 25, actor: 'automation:rule-liq', dryRun, executionId: null })

  it('a held campaign is not boosted (nor offered in a dry run); counted on the boost step', async () => {
    h.campaignLeverOwners.mockResolvedValue(held('c-gale'))
    const dry = await liquidate(true)
    const boostDry = dry.subActions.find((s) => s.step === 'boost_aged_product_ads')!
    expect(boostDry.output).toMatchObject({ count: 1, wouldBoost: [{ id: 'c-misano' }], brainSkips: { counts: { productBrain: { budgets: 1 } } } })
    expect(h.updateCampaignWithSync).not.toHaveBeenCalled()
  })

  it('nothing enrolled: both offered as before', async () => {
    h.anyBrainEnrolled.mockResolvedValue(false)
    const dry = await liquidate(true)
    const boostDry = dry.subActions.find((s) => s.step === 'boost_aged_product_ads')!
    expect(boostDry.output).toMatchObject({ count: 2 })
    expect(boostDry.output).not.toHaveProperty('brainSkips')
  })
})
