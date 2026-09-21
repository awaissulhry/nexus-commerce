/**
 * P4.6e — Etsy's six-hour rule.
 *
 * A term of Etsy's API licence, recorded in FINAL-PLAN §13 as required *"once we write or show
 * Etsy data"* — which P4.6 is.
 */
import { describe, expect, it } from 'vitest'
import { ETSY_MAX_CONTENT_AGE_MS, etsyContentIsStale, etsyFreshnessCensus } from './freshness.js'

const NOW = Date.UTC(2026, 8, 21, 12, 0, 0)
const agoMs = (ms: number) => new Date(NOW - ms)
const HOUR = 3_600_000

describe('P4.6e — etsyContentIsStale', () => {
  it('six hours is the bound Etsy publishes', () => {
    expect(ETSY_MAX_CONTENT_AGE_MS).toBe(6 * HOUR)
  })
  it('fresh inside the window, stale on and after it', () => {
    expect(etsyContentIsStale(agoMs(5 * HOUR), NOW)).toBe(false)
    expect(etsyContentIsStale(agoMs(ETSY_MAX_CONTENT_AGE_MS - 1), NOW)).toBe(false)
    expect(etsyContentIsStale(agoMs(ETSY_MAX_CONTENT_AGE_MS), NOW)).toBe(true)
    expect(etsyContentIsStale(agoMs(7 * HOUR), NOW)).toBe(true)
  })
  it('🔴 never synced is STALE — absence is not freshness', () => {
    // P3.6's rule: no_data is never a pass. This is the population every Etsy row is in today.
    expect(etsyContentIsStale(null, NOW)).toBe(true)
    expect(etsyContentIsStale(undefined, NOW)).toBe(true)
  })
  it('🔴 a FUTURE timestamp is stale too — a clock problem must not read as "very recent"', () => {
    expect(etsyContentIsStale(new Date(NOW + HOUR), NOW)).toBe(true)
  })
  it('an unreadable date is stale, not fresh', () => {
    expect(etsyContentIsStale(new Date('nonsense'), NOW)).toBe(true)
  })
})

describe('P4.6e — etsyFreshnessCensus', () => {
  it('counts stale, never-synced and the oldest real date', () => {
    expect(etsyFreshnessCensus([
      { lastSyncedAt: agoMs(1 * HOUR) },
      { lastSyncedAt: agoMs(8 * HOUR) },
      { lastSyncedAt: null },
      { lastSyncedAt: agoMs(30 * HOUR) },
    ], NOW)).toEqual({ total: 4, stale: 3, neverSynced: 1, oldestAt: new Date(NOW - 30 * HOUR).toISOString() })
  })
  it('🟢 all fresh: nothing to report', () => {
    expect(etsyFreshnessCensus([{ lastSyncedAt: agoMs(HOUR) }], NOW))
      .toMatchObject({ total: 1, stale: 0, neverSynced: 0 })
  })
  it('🔴 today\'s measured shape: every row never synced', () => {
    // `etsy-sync` is registry-only and its client cannot authenticate, so this is production.
    expect(etsyFreshnessCensus([{ lastSyncedAt: null }, { lastSyncedAt: null }], NOW))
      .toEqual({ total: 2, stale: 2, neverSynced: 2, oldestAt: null })
  })
  it('an empty shop is not a breach', () => {
    expect(etsyFreshnessCensus([], NOW)).toEqual({ total: 0, stale: 0, neverSynced: 0, oldestAt: null })
  })
})

describe('P4.6e — the alert it feeds', () => {
  it('says "all" when all are stale, and names the never-read count', async () => {
    const { staleChannelDataAlert } = await import('../cx/channel-alerts.service.js')
    const alert = staleChannelDataAlert('Etsy', { total: 9, stale: 9, neverSynced: 9, oldestAt: null }, 6)
    expect(alert).toMatchObject({ kind: 'channel-data-stale', severity: 'warn', entityId: 'Etsy:stale:all:never' })
    expect(alert!.body).toContain('no more than 6 hours old')
    expect(alert!.body).toContain('All 9 Etsy listings are older than that')
    expect(alert!.body).toContain('9 have never been read from Etsy at all')
  })
  it('"some" is a DIFFERENT notice from "all" — a shop that fixes most rows is not folded in', async () => {
    const { staleChannelDataAlert } = await import('../cx/channel-alerts.service.js')
    const some = staleChannelDataAlert('Etsy', { total: 9, stale: 2, neverSynced: 0, oldestAt: '2026-09-20T01:00:00.000Z' }, 6)
    expect(some!.entityId).toBe('Etsy:stale:some')
    expect(some!.body).toContain('2 of 9 Etsy listings')
    expect(some!.body).toContain('last read on 2026-09-20')
  })
  it('🟢 nothing stale raises nothing at all', async () => {
    const { staleChannelDataAlert } = await import('../cx/channel-alerts.service.js')
    expect(staleChannelDataAlert('Etsy', { total: 9, stale: 0, neverSynced: 0, oldestAt: null }, 6)).toBeNull()
  })
  it('an EMPTY shop raises nothing — but the census still has a value to log', async () => {
    // Production, 2026-09-21: the sweep ran and printed nothing, because the first version only
    // logged when rows existed. "No Etsy listings" and "the block threw" looked identical.
    const { staleChannelDataAlert } = await import('../cx/channel-alerts.service.js')
    const empty = etsyFreshnessCensus([], NOW)
    expect(empty).toEqual({ total: 0, stale: 0, neverSynced: 0, oldestAt: null })
    expect(staleChannelDataAlert('Etsy', empty, 6)).toBeNull()
  })
})
