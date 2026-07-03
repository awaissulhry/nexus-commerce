/**
 * E1 characterization tests — pin the marketing write gate's default-closed
 * posture before eBay writes (E4) route through it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { checkMarketingWriteGate } from './marketing-write-gate.js'

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
