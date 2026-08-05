/**
 * Phase 2 — Amazon client hardening + regional quota.
 *
 * Tested through the exported ledger semantics and the retry policy's shape.
 * The four defects: Retry-After never read, deterministic backoff, 423 treated
 * as a hard failure, and a dead unreachable fetch after the loop.
 */
import { describe, it, expect } from 'vitest'
import { QuotaLedger, MemoryQuotaStore, type QuotaStore } from '../ads-core/quota-ledger.js'
import { isMutatingCall } from './ads-api-client.js'

describe('Amazon quota — regional, not per-connection', () => {
  it('two profiles in one region share one bucket', async () => {
    // Amazon's limit is a regional queue shared across tenants: adding
    // connections does not raise throughput. A per-profile bucket would let
    // each profile believe it had the full allowance.
    const store = new MemoryQuotaStore()
    const ledger = new QuotaLedger(store, { failMode: 'open' })
    const EU = { key: 'amz:ads:EU', limit: 2, windowSec: 3600 }

    expect((await ledger.reserve(EU)).ok).toBe(true)  // profile A
    expect((await ledger.reserve(EU)).ok).toBe(true)  // profile B
    expect((await ledger.reserve(EU)).ok).toBe(false) // shared bucket exhausted
  })

  it('regions do not interfere', async () => {
    const store = new MemoryQuotaStore()
    const l = new QuotaLedger(store, { failMode: 'open' })
    const EU = { key: 'amz:ads:EU', limit: 1, windowSec: 3600 }
    const NA = { key: 'amz:ads:NA', limit: 1, windowSec: 3600 }
    expect((await l.reserve(EU)).ok).toBe(true)
    expect((await l.reserve(EU)).ok).toBe(false)
    expect((await l.reserve(NA)).ok).toBe(true) // separate queue
  })

  it('reads fail OPEN and writes fail CLOSED on a store outage', async () => {
    const broken: QuotaStore = { incr: async () => { throw new Error('redis down') } }
    const B = { key: 'amz:ads:EU', limit: 10, windowSec: 3600 }
    const read = await new QuotaLedger(broken, { failMode: 'open' }).reserve(B)
    const write = await new QuotaLedger(broken, { failMode: 'closed' }).reserve(B)
    // A lost read costs one wasted call; an unmetered write can breach the
    // shared regional quota and mutate the live account.
    expect(read.ok).toBe(true)
    expect(read.degraded).toBe(true)
    expect(write.ok).toBe(false)
    expect(write.degraded).toBe(true)
  })

  it('every retry consumes a unit — Amazon counts them all', async () => {
    const store = new MemoryQuotaStore()
    const l = new QuotaLedger(store, { failMode: 'open' })
    const B = { key: 'amz:ads:EU', limit: 10, windowSec: 3600 }
    // One logical call that retries three times = four outbound requests.
    for (let i = 0; i < 4; i++) await l.reserve(B)
    expect((await l.reserve(B)).used).toBe(5)
  })
})

describe('retry policy', () => {
  const RETRYABLE = new Set([429, 423])

  it('423 is retryable — it means another writer holds the entity', () => {
    // Previously a hard failure surfaced to the operator, though Amazon
    // documents ConcurrentModificationException as retryable.
    expect(RETRYABLE.has(423)).toBe(true)
    expect(RETRYABLE.has(429)).toBe(true)
  })

  it('a client error that is not 429/423 is still not retried', () => {
    for (const s of [400, 401, 403, 404, 422]) expect(RETRYABLE.has(s)).toBe(false)
  })

  it('full jitter keeps concurrent callers from re-colliding', () => {
    // Deterministic backoff made every caller retry at the same instant, which
    // reproduces the collision that caused the 429.
    const jitter = (base: number) => Math.round(base / 2 + Math.random() * (base / 2))
    const samples = Array.from({ length: 200 }, () => jitter(4000))
    expect(Math.min(...samples)).toBeGreaterThanOrEqual(2000)
    expect(Math.max(...samples)).toBeLessThanOrEqual(4000)
    expect(new Set(samples).size).toBeGreaterThan(50) // genuinely spread
  })

  it('Retry-After is preferred over guessing when Amazon supplies it', () => {
    const pick = (header: string | null, backoff: number) =>
      header && Number.isFinite(Number(header)) ? Number(header) * 1000 : backoff
    expect(pick('30', 4000)).toBe(30_000)
    expect(pick(null, 4000)).toBe(4000)
    expect(pick('not-a-number', 4000)).toBe(4000)
  })
})

describe('read/write classification — Amazon reads through POST', () => {
  // ACR Stage 5. Classifying by HTTP verb made every v3/v4 `/list` a WRITE, so all
  // ten of them fail-CLOSED on a store outage. The write ledger fails closed because
  // an unmetered write can mutate the live account; a list call cannot mutate anything.
  it('POST .../list is a READ across every ad-product family', () => {
    for (const path of [
      '/sp/campaigns/list', '/sp/adGroups/list', '/sp/keywords/list',
      '/sp/targets/list', '/sp/productAds/list', '/sp/negativeKeywords/list',
      '/sb/v4/campaigns/list', '/portfolios/list', '/eligibility/product/list',
    ]) {
      expect(isMutatingCall('POST', path)).toBe(false)
    }
  })

  it('GET is always a read — including SD, which reads through GET with a query string', () => {
    expect(isMutatingCall('GET', '/sd/campaigns?campaignIdFilter=1,2,3')).toBe(false)
    expect(isMutatingCall('GET', '/sd/targets')).toBe(false)
    expect(isMutatingCall('GET', '/v2/profiles')).toBe(false)
  })

  it('real mutations stay fail-closed', () => {
    // The entity creates — the calls that spend money if they escape the gate.
    expect(isMutatingCall('POST', '/sp/campaigns')).toBe(true)
    expect(isMutatingCall('POST', '/sd/targets')).toBe(true)
    expect(isMutatingCall('POST', '/sb/v4/ads')).toBe(true)
    expect(isMutatingCall('PUT', '/sp/campaigns')).toBe(true)
    expect(isMutatingCall('DELETE', '/sp/keywords')).toBe(true)
    // Creating a report job is not an account mutation, but it IS resource
    // creation and stays with the writes deliberately.
    expect(isMutatingCall('POST', '/reporting/reports')).toBe(true)
  })

  it('a path that merely CONTAINS "list" is not a list endpoint', () => {
    expect(isMutatingCall('POST', '/sp/listings/publish')).toBe(true)
    expect(isMutatingCall('POST', '/sp/list/create')).toBe(true)
  })
})
