/**
 * ACR.4.5 — the switch that decides whether four AUTO rules can see.
 *
 * `previewBidOptimization` is the shared upstream of the APPLY path (`ads-auto-bid`,
 * `autopilot/apply`), so this is not a display preference: `daily` lets those rules start writing
 * bids on a live account. Measured blast radius at the time of writing — 52 proposals, net −314¢,
 * €1,555 of 30-day spend touched. Everything here exists to pin ONE property: you cannot arrive
 * at `daily` by accident.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { resolveSource } from './ads-bid-optimizer.service.js'

const KEY = 'NEXUS_BID_OPTIMIZER_SOURCE'
afterEach(() => { delete process.env[KEY] })

describe('default-off', () => {
  it('unset env resolves to legacy — deploying this changes nothing', () => {
    delete process.env[KEY]
    expect(resolveSource()).toBe('legacy')
  })

  /**
   * Anything that is not exactly 'daily' must fall back to legacy. A truthy-but-wrong value is
   * the realistic way an env var goes wrong (`true`, `1`, `DAILY`), and every one of them must
   * fail CLOSED — arming an engine on a typo is the failure this test exists to prevent.
   */
  it.each(['', 'legacy', 'true', '1', 'DAILY', 'Daily', 'yes', 'on', ' daily'])(
    'env=%j resolves to legacy',
    (v) => { process.env[KEY] = v; expect(resolveSource()).toBe('legacy') },
  )

  it('only the exact string arms it', () => {
    process.env[KEY] = 'daily'
    expect(resolveSource()).toBe('daily')
  })
})

describe('an explicit argument wins over the environment', () => {
  /** So a caller can inspect the daily view without arming the AUTO path. */
  it('daily can be requested while the env says legacy', () => {
    delete process.env[KEY]
    expect(resolveSource('daily')).toBe('daily')
  })
  /** And a caller can pin legacy even on an armed deployment. */
  it('legacy can be forced while the env says daily', () => {
    process.env[KEY] = 'daily'
    expect(resolveSource('legacy')).toBe('legacy')
  })
})
