/**
 * A1.3 — the shared publish chokepoint. The gate/seller/execute are injected, so
 * the whole chain (gate → seller-resolve → circuit → rate-limit → dry-run →
 * execute → audit) is unit-testable without any real marketplace/gate/network.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const writeAttemptLog = vi.fn()
vi.mock('./channel-publish-audit.service.js', () => ({
  writeAttemptLog: (...a: any[]) => writeAttemptLog(...a),
}))

import { ListingPublishService } from './listing-publish.service.js'

const svc = new ListingPublishService()

const okGate = () => ({
  getMode: vi.fn(() => 'live' as const),
  checkCircuit: vi.fn(() => ({ ok: true })),
  acquireToken: vi.fn(async () => ({ ok: true })),
  recordOutcome: vi.fn(),
})

const base = (gate: any, execute: any, resolveSeller: any = async () => ({ id: 'S1' })) => ({
  channel: 'AMAZON' as const,
  marketplaceId: 'APJ6JRA9NG5V4',
  sku: 'X1',
  productId: 'p1',
  digest: 'd',
  gate,
  resolveSeller,
  execute,
})

beforeEach(() => writeAttemptLog.mockClear())

describe('ListingPublishService.publish — the chain', () => {
  it('gated → fail, no seller resolve, no execute', async () => {
    const gate = okGate(); gate.getMode.mockReturnValue('gated' as any)
    const execute = vi.fn(async () => ({ ok: true }))
    const resolveSeller = vi.fn(async () => ({ id: 'S1' }))
    const r = await svc.publish(base(gate, execute, resolveSeller))
    expect(r.success).toBe(false)
    expect(r.outcome).toBe('gated')
    expect(resolveSeller).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
  })

  it('resolveSeller error → fail, no execute', async () => {
    const execute = vi.fn(async () => ({ ok: true }))
    const r = await svc.publish(base(okGate(), execute, async () => ({ error: 'no seller' })))
    expect(r.success).toBe(false)
    expect(r.error).toBe('no seller')
    expect(execute).not.toHaveBeenCalled()
  })

  it('circuit open → fail, no execute', async () => {
    const gate = okGate(); gate.checkCircuit.mockReturnValue({ ok: false, error: 'open' } as any)
    const execute = vi.fn(async () => ({ ok: true }))
    const r = await svc.publish(base(gate, execute))
    expect(r.outcome).toBe('circuit-open')
    expect(execute).not.toHaveBeenCalled()
  })

  it('rate-limited → fail, no execute', async () => {
    const gate = okGate(); gate.acquireToken.mockResolvedValue({ ok: false, error: 'slow down' } as any)
    const execute = vi.fn(async () => ({ ok: true }))
    const r = await svc.publish(base(gate, execute))
    expect(r.outcome).toBe('rate-limited')
    expect(execute).not.toHaveBeenCalled()
  })

  it('dry-run → success, NO execute, records success + audits', async () => {
    const gate = okGate(); gate.getMode.mockReturnValue('dry-run' as any)
    const execute = vi.fn(async () => ({ ok: true }))
    const r = await svc.publish(base(gate, execute))
    expect(r.success).toBe(true)
    expect(execute).not.toHaveBeenCalled()
    expect(gate.recordOutcome).toHaveBeenCalledWith('S1', 'APJ6JRA9NG5V4', true)
    expect(writeAttemptLog).toHaveBeenCalled()
  })

  it('live + execute ok → success, records success', async () => {
    const gate = okGate()
    const execute = vi.fn(async () => ({ ok: true }))
    const r = await svc.publish(base(gate, execute))
    expect(r.success).toBe(true)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(gate.recordOutcome).toHaveBeenCalledWith('S1', 'APJ6JRA9NG5V4', true)
  })

  it('live + execute fail → fail, records failure', async () => {
    const gate = okGate()
    const execute = vi.fn(async () => ({ ok: false, error: 'rejected' }))
    const r = await svc.publish(base(gate, execute))
    expect(r.success).toBe(false)
    expect(r.error).toBe('rejected')
    expect(gate.recordOutcome).toHaveBeenCalledWith('S1', 'APJ6JRA9NG5V4', false)
  })

  it('live + execute throws → timeout fail, records failure', async () => {
    const gate = okGate()
    const execute = vi.fn(async () => { throw new Error('boom') })
    const r = await svc.publish(base(gate, execute))
    expect(r.success).toBe(false)
    expect(r.outcome).toBe('timeout')
    expect(gate.recordOutcome).toHaveBeenCalledWith('S1', 'APJ6JRA9NG5V4', false)
  })
})
