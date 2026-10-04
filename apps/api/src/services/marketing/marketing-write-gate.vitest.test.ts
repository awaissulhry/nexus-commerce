/**
 * E1 characterization tests — pin the marketing write gate's default-closed
 * posture before eBay writes (E4) route through it.
 *
 * 1f (review 2.10) — and the brakes an AUTOMATED write meets on the marketing mutation path, which reaches
 * Amazon past the ads write gate: no automated pause, and the ads halt binds (bottom of the file).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { checkMarketingWriteGate } from './marketing-write-gate.js'

// ── 1f: the mutation path, with the database, queue row and channel adapters mocked ──
const halted = vi.fn(async () => false)
vi.mock('../advertising/ads-automation-state.service.js', () => ({ isAutomationHalted: halted }))
const db = {
  marketingCampaign: {
    findUnique: vi.fn(async () => ({ id: 'mc-1', status: 'ACTIVE', budgetCents: 2000, channel: 'AMAZON', primaryMarketplace: 'IT' })),
    update: vi.fn(async () => ({ id: 'mc-1', status: 'ACTIVE', budgetCents: 2000 })),
  },
  marketingCampaignLink: { findFirst: vi.fn(async () => ({ marketplace: 'IT', externalId: 'EXT-MC-1' })) },
  campaignAction: {
    create: vi.fn(async () => ({ id: 'ca-1' })),
    findFirst: vi.fn(async (): Promise<Record<string, unknown> | null> => null),
    update: vi.fn(async () => ({})),
    updateMany: vi.fn(async () => ({ count: 1 })),
  },
  outboundSyncQueue: {
    findUnique: vi.fn(async (): Promise<Record<string, unknown> | null> => null),
    update: vi.fn(async () => ({})),
  },
  $transaction: vi.fn(async (ops: unknown[]) => Promise.all(ops)),
}
vi.mock('../../db.js', () => ({ default: db }))
const createOutboundRow = vi.fn(async () => ({ id: 'q-1' }))
vi.mock('../outbound-rows.js', () => ({ createOutboundRow }))
vi.mock('../marketing-events.service.js', () => ({ publishMarketingEvent: vi.fn() }))
const applyMutation = vi.fn(async () => ({ ok: true, status: 'SUCCESS' }))
vi.mock('./adapters/types.js', () => ({ adapterFor: () => ({ applyMutation }) }))
vi.mock('./adapters/amazon.adapter.js', () => ({}))
vi.mock('./adapters/internal.adapter.js', () => ({}))
vi.mock('./adapters/ebay.adapter.js', () => ({}))
vi.mock('./adapters/stub-adapters.js', () => ({}))

const ENV_KEYS = [
  'NEXUS_MARKETING_WRITES_EBAY',
  'NEXUS_MARKETING_MAX_WRITE_VALUE_CENTS',
  'NEXUS_MARKETING_AMAZON_LIVE',
  'NEXUS_AMAZON_ADS_MODE',
] as const

const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k] }
})
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

describe('checkMarketingWriteGate — eBay', () => {
  it('DEFAULT-CLOSED: no env flag → sandbox (allowed, no external write)', () => {
    const d = checkMarketingWriteGate({ channel: 'EBAY', marketplace: 'EBAY_IT', payloadValueCents: 100 })
    expect(d).toEqual({ allowed: true, mode: 'sandbox' })
  })

  it('opens to live ONLY with NEXUS_MARKETING_WRITES_EBAY=1', () => {
    process.env.NEXUS_MARKETING_WRITES_EBAY = '1'
    const d = checkMarketingWriteGate({ channel: 'EBAY', marketplace: 'EBAY_IT', payloadValueCents: 100 })
    expect(d).toEqual({ allowed: true, mode: 'live' })
  })

  it('any other value than "1" stays sandbox', () => {
    process.env.NEXUS_MARKETING_WRITES_EBAY = 'true'
    const d = checkMarketingWriteGate({ channel: 'EBAY', marketplace: 'EBAY_IT', payloadValueCents: 100 })
    expect(d.mode).toBe('sandbox')
  })

  it('per-write value cap blocks oversized payloads even when live', () => {
    process.env.NEXUS_MARKETING_WRITES_EBAY = '1'
    const d = checkMarketingWriteGate({ channel: 'EBAY', marketplace: 'EBAY_IT', payloadValueCents: 50_001 })
    expect(d.allowed).toBe(false)
    expect(d.mode).toBe('sandbox')
    if (!d.allowed) expect(d.reason).toMatch(/exceeds cap/)
  })

  it('cap default is €500 and NEXUS_MARKETING_MAX_WRITE_VALUE_CENTS overrides it', () => {
    expect(
      checkMarketingWriteGate({ channel: 'EBAY', marketplace: null, payloadValueCents: 50_000 }).allowed,
    ).toBe(true)
    process.env.NEXUS_MARKETING_MAX_WRITE_VALUE_CENTS = '1000'
    expect(
      checkMarketingWriteGate({ channel: 'EBAY', marketplace: null, payloadValueCents: 1001 }).allowed,
    ).toBe(false)
  })
})

describe('checkMarketingWriteGate — other channels stay closed by default', () => {
  it('Amazon without NEXUS_MARKETING_AMAZON_LIVE is sandbox', () => {
    const d = checkMarketingWriteGate({ channel: 'AMAZON', marketplace: 'IT', payloadValueCents: 100 })
    expect(d.mode).toBe('sandbox')
    expect(d.allowed).toBe(true)
  })
  it('Shopify/Google default sandbox', () => {
    expect(checkMarketingWriteGate({ channel: 'SHOPIFY', marketplace: null, payloadValueCents: 1 }).mode).toBe('sandbox')
    expect(checkMarketingWriteGate({ channel: 'GOOGLE', marketplace: null, payloadValueCents: 1 }).mode).toBe('sandbox')
  })
})

const { enqueueCampaignMutation, processMarketingSyncRow, AUTOMATED_PAUSE_REFUSAL, AUTOMATION_HALTED_REFUSAL } =
  await import('./marketing-mutation.service.js')

describe('1f — an automated write on the marketing mutation path', () => {
  const RULE = 'automation:tst-mkt-rule'
  const queued = (syncType: string, payload: Record<string, unknown>) => ({
    id: 'q-1', syncStatus: 'PENDING', holdUntil: new Date(Date.now() - 1000), syncType,
    payload: { campaignId: 'mc-1', channel: 'AMAZON', marketplace: 'IT', externalId: 'EXT-MC-1', valueCents: 0, ...payload },
  })
  const audit = (userId: string | null) => ({
    id: 'ca-1', campaignId: 'mc-1', userId, channel: 'AMAZON', payloadBefore: { status: 'ACTIVE', budgetCents: 2000 }, channelResponseStatus: 'PENDING',
  })

  beforeEach(() => {
    vi.clearAllMocks()
    halted.mockResolvedValue(false)
  })

  it('an automated pause is refused before anything is written', async () => {
    await expect(enqueueCampaignMutation({ campaignId: 'mc-1', syncType: 'MKT_STATE_UPDATE', payload: { status: 'PAUSED' }, userId: RULE }))
      .rejects.toThrow(AUTOMATED_PAUSE_REFUSAL)
    expect(db.marketingCampaign.update).not.toHaveBeenCalled()
    expect(createOutboundRow).not.toHaveBeenCalled()
    expect(db.campaignAction.create).not.toHaveBeenCalled()
  })

  it('the sentence is plain English', () => {
    expect(AUTOMATED_PAUSE_REFUSAL).toBe('Refused: no automation may pause a campaign. An automation lowers bids or budgets instead; a person can still pause by hand.')
  })

  // Control: the refusal is about WHO. A person's pause queues as before, and the halt is not even read.
  it('a person may pause; the halt does not bind a person on this path', async () => {
    halted.mockResolvedValue(true)
    const r = await enqueueCampaignMutation({ campaignId: 'mc-1', syncType: 'MKT_STATE_UPDATE', payload: { status: 'PAUSED' }, userId: 'user:tst' })
    expect(r.queueId).toBe('q-1')
    expect(halted).not.toHaveBeenCalled()
  })

  it('an automated resume or budget change queues while automation runs', async () => {
    await enqueueCampaignMutation({ campaignId: 'mc-1', syncType: 'MKT_STATE_UPDATE', payload: { status: 'ACTIVE' }, userId: RULE })
    await enqueueCampaignMutation({ campaignId: 'mc-1', syncType: 'MKT_BUDGET_UPDATE', payload: { budgetCents: 2500 }, userId: RULE })
    expect(createOutboundRow).toHaveBeenCalledTimes(2)
  })

  it('while ads automation is stopped, an automated budget change is refused before anything is written', async () => {
    halted.mockResolvedValue(true)
    await expect(enqueueCampaignMutation({ campaignId: 'mc-1', syncType: 'MKT_BUDGET_UPDATE', payload: { budgetCents: 2500 }, userId: RULE }))
      .rejects.toThrow(AUTOMATION_HALTED_REFUSAL)
    expect(db.marketingCampaign.update).not.toHaveBeenCalled()
    expect(createOutboundRow).not.toHaveBeenCalled()
  })

  it('a halt pressed inside the grace window ends the queued automated write and puts the local change back', async () => {
    db.outboundSyncQueue.findUnique.mockResolvedValueOnce(queued('MKT_BUDGET_UPDATE', { budgetCents: 2500 }))
    db.campaignAction.findFirst.mockResolvedValueOnce(audit(RULE))
    halted.mockResolvedValue(true)
    const r = await processMarketingSyncRow('q-1')
    expect(r).toEqual({ status: 'refused', queueId: 'q-1' })
    expect(applyMutation).not.toHaveBeenCalled()
    expect(db.outboundSyncQueue.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ syncStatus: 'SKIPPED', errorMessage: AUTOMATION_HALTED_REFUSAL }) }))
    expect(db.marketingCampaign.update).toHaveBeenCalledWith({ where: { id: 'mc-1' }, data: { status: 'ACTIVE', budgetCents: 2000 } })
    expect(db.campaignAction.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ channelResponseStatus: 'FAILED', rollbackReason: AUTOMATION_HALTED_REFUSAL }) }))
  })

  it('an automated pause queued before this change is refused at dispatch', async () => {
    db.outboundSyncQueue.findUnique.mockResolvedValueOnce(queued('MKT_STATE_UPDATE', { status: 'PAUSED' }))
    db.campaignAction.findFirst.mockResolvedValueOnce(audit(RULE))
    expect(await processMarketingSyncRow('q-1')).toEqual({ status: 'refused', queueId: 'q-1' })
    expect(applyMutation).not.toHaveBeenCalled()
    expect(db.outboundSyncQueue.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ errorMessage: AUTOMATED_PAUSE_REFUSAL }) }))
  })

  it("a person's queued write still dispatches while automation is stopped (control)", async () => {
    db.outboundSyncQueue.findUnique.mockResolvedValueOnce(queued('MKT_STATE_UPDATE', { status: 'PAUSED' }))
    db.campaignAction.findFirst.mockResolvedValueOnce(audit('user:tst'))
    halted.mockResolvedValue(true)
    const r = await processMarketingSyncRow('q-1')
    expect(r.status).toBe('sandbox-success') // the gate's default-closed posture: no env flag → sandbox
    expect(db.marketingCampaign.update).not.toHaveBeenCalled()
  })
})
