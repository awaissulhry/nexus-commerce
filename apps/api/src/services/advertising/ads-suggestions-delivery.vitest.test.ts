/**
 * SG.3 — delivery truth for applied suggestions.
 *
 * An apply returns at ENQUEUE; the gate runs later in the drain worker. This join reads the
 * write's actual fate from the queue row (or a create's own receipt), and resolves the
 * AdvertisingActionLog handle the rollback service needs — matched nearest-to-decision inside
 * a window, never on a truncated timestamp, never via the change feed's display ids.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const queueFindMany = vi.fn(async (_a?: unknown) => [] as unknown[])
const logFindMany = vi.fn(async (_a?: unknown) => [] as unknown[])

vi.mock('../../db.js', () => ({
  default: {
    outboundSyncQueue: { get findMany() { return queueFindMany } },
    advertisingActionLog: { get findMany() { return logFindMany } },
  },
}))
vi.mock('../../utils/logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }))

const { attachDeliveryData } = await import('./ads-suggestions.service.js')

const T0 = new Date('2026-08-21T12:00:00Z')
const row = (appliedResult: unknown, entityId = 'e1') => ({ entityType: 'AD_TARGET', entityId, decidedAt: T0, appliedResult })

beforeEach(() => { queueFindMany.mockReset().mockResolvedValue([]); logFindMany.mockReset().mockResolvedValue([]) })

describe('the delivery fate', () => {
  it('queue SUCCESS → delivered', async () => {
    queueFindMany.mockResolvedValue([{ id: 'q1', syncStatus: 'SUCCESS', errorCode: null, errorMessage: null, isDead: false, syncedAt: T0 }])
    const [r] = await attachDeliveryData([row({ ok: true, output: { outboundQueueId: 'q1' } })])
    expect(r.delivery.state).toBe('delivered')
  })

  it('queue SKIPPED + WRITE_GATE_DENIED → refused, in the gate’s own words', async () => {
    queueFindMany.mockResolvedValue([{ id: 'q1', syncStatus: 'SKIPPED', errorCode: 'WRITE_GATE_DENIED', errorMessage: 'denied at campaign_allowlist', isDead: false, syncedAt: null }])
    const [r] = await attachDeliveryData([row({ ok: true, output: { outboundQueueId: 'q1' } })])
    expect(r.delivery).toEqual({ state: 'refused', detail: 'denied at campaign_allowlist' })
  })

  it('dead-lettered → failed; still queued → pending', async () => {
    queueFindMany.mockResolvedValue([
      { id: 'q1', syncStatus: 'FAILED', errorCode: null, errorMessage: 'HTTP 500 ×3', isDead: true, syncedAt: null },
      { id: 'q2', syncStatus: 'PENDING', errorCode: null, errorMessage: null, isDead: false, syncedAt: null },
    ])
    const [a, b] = await attachDeliveryData([
      row({ ok: true, output: { outboundQueueId: 'q1' } }),
      row({ ok: true, output: { outboundQueueId: 'q2' } }, 'e2'),
    ])
    expect(a.delivery.state).toBe('failed')
    expect(b.delivery.state).toBe('pending')
  })

  it('a create’s own receipt: externalTargetId → delivered; wire failedWrites → failed', async () => {
    const [a, b] = await attachDeliveryData([
      row({ ok: true, output: { externalTargetId: 'amz1', reachedAmazon: true } }),
      row({ ok: false, error: '2 creations did not reach Amazon — see outcomes', output: { confirmed: 1, failedWrites: 2, outcomes: [] } }, 'e2'),
    ])
    expect(a.delivery.state).toBe('delivered')
    expect(b.delivery.state).toBe('failed')
  })

  it('a legacy row with no fate in its shape → unknown, never a confident success', async () => {
    const [r] = await attachDeliveryData([row({ ok: true, output: { campaignId: 'c1' } })])
    expect(r.delivery.state).toBe('unknown')
  })
})

describe('the undo handle', () => {
  it('matches the nearest action-log row inside the window and carries rolledBack', async () => {
    logFindMany.mockResolvedValue([
      { id: 'far', entityId: 'e1', createdAt: new Date(T0.getTime() + 55_000), rolledBackAt: null },
      { id: 'near', entityId: 'e1', createdAt: new Date(T0.getTime() + 2_000), rolledBackAt: null },
      { id: 'other', entityId: 'e9', createdAt: new Date(T0.getTime() + 1_000), rolledBackAt: null },
    ])
    const [r] = await attachDeliveryData([row({ ok: true, output: {} })])
    expect(r.undo).toEqual({ actionLogId: 'near', rolledBack: false })
  })

  it('no row in the window → undo null ("no undo is offered here", not "cannot be undone")', async () => {
    logFindMany.mockResolvedValue([])
    const [r] = await attachDeliveryData([row({ ok: true, output: {} })])
    expect(r.undo).toBeNull()
  })
})
