import { describe, it, expect } from 'vitest'
import {
  computeLatencyStats,
  outboundDeltaMs,
  buildOutboundLatencyResponse,
  summarizeDiagnostics,
  evaluateLatencyBreach,
} from './sync-metrics.js'

describe('computeLatencyStats', () => {
  it('returns nulls and zero count for empty input', () => {
    expect(computeLatencyStats([])).toEqual({
      sampleCount: 0,
      p50Ms: null, p95Ms: null, p99Ms: null, minMs: null, maxMs: null,
      histogram: [
        { bucket: '0-1s', count: 0 }, { bucket: '1-5s', count: 0 },
        { bucket: '5-15s', count: 0 }, { bucket: '15-60s', count: 0 },
        { bucket: '1-5min', count: 0 }, { bucket: '5-15min', count: 0 },
        { bucket: '15-60min', count: 0 }, { bucket: '>1h', count: 0 },
      ],
    })
  })

  it('computes nearest-rank percentiles and min/max', () => {
    const s = computeLatencyStats([500, 1500, 8000, 40000])
    expect(s.sampleCount).toBe(4)
    expect(s.minMs).toBe(500)
    expect(s.maxMs).toBe(40000)
    expect(s.p50Ms).toBe(1500) // ceil(0.5*4)=2 -> index 1
    expect(s.p95Ms).toBe(40000)
  })

  it('buckets each delta into the right histogram band', () => {
    const s = computeLatencyStats([500, 3000, 40000])
    const get = (b: string) => s.histogram.find((h) => h.bucket === b)!.count
    expect(get('0-1s')).toBe(1)
    expect(get('1-5s')).toBe(1)
    expect(get('15-60s')).toBe(1)
  })
})

describe('outboundDeltaMs', () => {
  it('returns null when not yet synced', () => {
    expect(outboundDeltaMs({ createdAt: new Date(), syncedAt: null })).toBeNull()
  })
  it('returns syncedAt - createdAt in ms', () => {
    const created = new Date('2026-06-30T10:00:00.000Z')
    const synced = new Date('2026-06-30T10:00:03.500Z')
    expect(outboundDeltaMs({ createdAt: created, syncedAt: synced })).toBe(3500)
  })
  it('clamps negative (clock skew) to 0', () => {
    const created = new Date('2026-06-30T10:00:05.000Z')
    const synced = new Date('2026-06-30T10:00:00.000Z')
    expect(outboundDeltaMs({ createdAt: created, syncedAt: synced })).toBe(0)
  })
})

describe('buildOutboundLatencyResponse', () => {
  it('groups by channel, counts pending separately, and stats only synced rows', () => {
    const c = new Date('2026-06-30T10:00:00.000Z')
    const s2 = new Date('2026-06-30T10:00:02.000Z')
    const res = buildOutboundLatencyResponse(
      [
        { targetChannel: 'AMAZON', createdAt: c, syncedAt: s2, syncStatus: 'SUCCESS' },
        { targetChannel: 'AMAZON', createdAt: c, syncedAt: null, syncStatus: 'PENDING' },
        { targetChannel: 'EBAY', createdAt: c, syncedAt: s2, syncStatus: 'SUCCESS' },
      ],
      '24h',
      '2026-06-30T10:01:00.000Z',
    )
    expect(res.window).toBe('24h')
    expect(res.checkedAt).toBe('2026-06-30T10:01:00.000Z')
    const amazon = res.channels.find((x) => x.channel === 'AMAZON')!
    expect(amazon.sampleCount).toBe(1)
    expect(amazon.pendingCount).toBe(1)
    expect(amazon.p50Ms).toBe(2000)
    const ebay = res.channels.find((x) => x.channel === 'EBAY')!
    expect(ebay.pendingCount).toBe(0)
  })

  it('does NOT count FAILED/CANCELLED/SKIPPED rows in pendingCount', () => {
    const c = new Date('2026-06-30T10:00:00.000Z')
    const res = buildOutboundLatencyResponse(
      [
        { targetChannel: 'AMAZON', createdAt: c, syncedAt: null, syncStatus: 'FAILED' },
        { targetChannel: 'AMAZON', createdAt: c, syncedAt: null, syncStatus: 'CANCELLED' },
        { targetChannel: 'AMAZON', createdAt: c, syncedAt: null, syncStatus: 'SKIPPED' },
        { targetChannel: 'AMAZON', createdAt: c, syncedAt: null, syncStatus: 'PENDING' },
        { targetChannel: 'AMAZON', createdAt: c, syncedAt: null, syncStatus: 'IN_PROGRESS' },
      ],
      '24h',
      '2026-06-30T10:01:00.000Z',
    )
    const amazon = res.channels.find((x) => x.channel === 'AMAZON')!
    expect(amazon.pendingCount).toBe(2) // only PENDING + IN_PROGRESS
  })

  it('includes truncated: false by default and true when passed true', () => {
    const c = new Date('2026-06-30T10:00:00.000Z')
    const s = new Date('2026-06-30T10:00:01.000Z')
    const row = { targetChannel: 'AMAZON', createdAt: c, syncedAt: s, syncStatus: 'SUCCESS' }

    const resDefault = buildOutboundLatencyResponse([row], '24h', '2026-06-30T10:01:00.000Z')
    expect(resDefault.truncated).toBe(false)

    const resTruncated = buildOutboundLatencyResponse([row], '24h', '2026-06-30T10:01:00.000Z', true)
    expect(resTruncated.truncated).toBe(true)
  })
})

describe('evaluateLatencyBreach', () => {
  const mk = (channel: string, p95Ms: number | null) => ({
    channel, pendingCount: 0, sampleCount: 1, p50Ms: p95Ms, p95Ms, p99Ms: p95Ms,
    minMs: p95Ms, maxMs: p95Ms, histogram: [],
  })
  it('flags only channels over the threshold', () => {
    const out = evaluateLatencyBreach([mk('AMAZON', 90_000), mk('EBAY', 3_000)], 60_000)
    expect(out).toEqual([{ channel: 'AMAZON', p95Ms: 90_000 }])
  })
  it('ignores channels with null p95 (no samples)', () => {
    expect(evaluateLatencyBreach([mk('AMAZON', null)], 60_000)).toEqual([])
  })
})

describe('summarizeDiagnostics', () => {
  const base = {
    queueWorkersEnabled: true, redisConfigured: true,
    ebayNotificationsActive: true, shopifyPublishLive: false, amazonPublishLive: true,
    outboundPending: 0, outboundOldestPendingAgeMs: null, dlqDepth: 0, crons: [],
  }
  it('reports immediate path + realtime-ready with no warnings when healthy', () => {
    const r = summarizeDiagnostics(base, '2026-06-30T10:00:00.000Z')
    expect(r.dispatchPath).toBe('immediate-bullmq')
    expect(r.realtimeReady).toBe(true)
    expect(r.warnings).toEqual([])
  })
  it('warns and downgrades when queue workers are off', () => {
    const r = summarizeDiagnostics({ ...base, queueWorkersEnabled: false }, 'now')
    expect(r.dispatchPath).toBe('cron-60s-only')
    expect(r.realtimeReady).toBe(false)
    expect(r.warnings.some((w) => w.includes('queue workers'))).toBe(true)
  })
  it('warns when eBay notifications inactive, DLQ non-empty, and backlog is old', () => {
    const r = summarizeDiagnostics(
      { ...base, ebayNotificationsActive: false, dlqDepth: 3, outboundOldestPendingAgeMs: 10 * 60_000 },
      'now',
    )
    expect(r.warnings.some((w) => w.toLowerCase().includes('ebay'))).toBe(true)
    expect(r.warnings.some((w) => w.includes('dead-letter') || w.includes('DLQ'))).toBe(true)
    expect(r.warnings.some((w) => w.toLowerCase().includes('backlog'))).toBe(true)
  })
})
