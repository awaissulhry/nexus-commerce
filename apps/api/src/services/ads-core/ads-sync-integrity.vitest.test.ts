/** AX2.9 — the self-check that replaces looking at this every morning. */
import { describe, it, expect } from 'vitest'
import { evaluateIntegrity, INTEGRITY_THRESHOLDS, type IntegritySnapshot } from './ads-sync-integrity.js'

const healthy = (over: Partial<IntegritySnapshot> = {}): IntegritySnapshot => ({
  deadLettersLastHour: 0,
  deadLetters24h: 0,
  orphanedTargets: 23,      // history — expected to persist
  orphanedLast24h: 0,
  minutesSinceSettingsSync: 4,
  minutesSinceAmsIngest: 45,
  campaignsFailedWrite: 0,
  campaignsInUnwritableMarket: 0,
  ...over,
})

describe('evaluateIntegrity — healthy is silent', () => {
  it('the post-AX2 steady state produces NO findings', () => {
    const r = evaluateIntegrity(healthy())
    expect(r.severity).toBe('OK')
    expect(r.findings).toEqual([])
  })

  it('existing orphans do not nag — only NEW ones are signal', () => {
    // 23 orphaned targets is the AX2.0 backfill and must stay quiet forever.
    const r = evaluateIntegrity(healthy({ orphanedTargets: 23, orphanedLast24h: 0 }))
    expect(r.severity).toBe('OK')
  })
})

describe('evaluateIntegrity — the AX2.0 regression alarm', () => {
  it('ANY new dead letter is CRITICAL — the steady state is zero', () => {
    const r = evaluateIntegrity(healthy({ deadLettersLastHour: 1, deadLetters24h: 23 }))
    expect(r.severity).toBe('CRITICAL')
    const f = r.findings.find((x) => x.code === 'ADS_DEAD_LETTERS_RISING')!
    expect(f.message).toContain('1 Amazon ad write')
    expect(f.action).toMatch(/orphan guard/)
  })
  it('threshold is genuinely zero, not a tolerance', () => {
    expect(INTEGRITY_THRESHOLDS.deadLettersLastHour).toBe(0)
  })
})

describe('evaluateIntegrity — sync stalls', () => {
  it('CRITICAL when the settings sync stops stamping', () => {
    const r = evaluateIntegrity(healthy({ minutesSinceSettingsSync: 120 }))
    expect(r.severity).toBe('CRITICAL')
    expect(r.findings.some((f) => f.code === 'ADS_SETTINGS_SYNC_STALE')).toBe(true)
  })
  it('tolerates two missed passes before complaining', () => {
    expect(evaluateIntegrity(healthy({ minutesSinceSettingsSync: 45 })).severity).toBe('OK')
    expect(INTEGRITY_THRESHOLDS.settingsSyncStaleMinutes).toBeGreaterThan(40)
  })
  it('CRITICAL when nothing has ever been verified', () => {
    const r = evaluateIntegrity(healthy({ minutesSinceSettingsSync: null }))
    expect(r.findings.some((f) => f.code === 'ADS_SETTINGS_SYNC_NEVER')).toBe(true)
  })
  it('AMS silence is a WARN, not an outage', () => {
    const r = evaluateIntegrity(healthy({ minutesSinceAmsIngest: 600 }))
    expect(r.severity).toBe('WARN')
    expect(r.findings.some((f) => f.code === 'AMS_INGEST_STALLED')).toBe(true)
  })
  it('a QUIET OVERNIGHT is not a stall — this must not cry wolf nightly', () => {
    // Observed on prod: 276 minutes with no AMS row simply because a small
    // account had no impressions overnight. Alerting on that trains people to
    // ignore the alert, which is worse than not having it.
    expect(evaluateIntegrity(healthy({ minutesSinceAmsIngest: 276 })).severity).toBe('OK')
    expect(evaluateIntegrity(healthy({ minutesSinceAmsIngest: 420 })).severity).toBe('OK')
  })
  it('no AMS data at all is not reported as a stall', () => {
    // An account with the stream switched off must not be nagged forever.
    expect(evaluateIntegrity(healthy({ minutesSinceAmsIngest: null })).severity).toBe('OK')
  })
})

describe('evaluateIntegrity — delivery and markets', () => {
  it('failed writes are a WARN with the self-healing caveat stated', () => {
    const r = evaluateIntegrity(healthy({ campaignsFailedWrite: 3 }))
    expect(r.severity).toBe('WARN')
    expect(r.findings.find((f) => f.code === 'ADS_WRITES_FAILING')!.action).toMatch(/auto-reconcile/)
  })
  it('campaigns stranded in an unwritable market are surfaced', () => {
    const r = evaluateIntegrity(healthy({ campaignsInUnwritableMarket: 4 }))
    expect(r.findings.some((f) => f.code === 'ADS_CAMPAIGNS_IN_UNWRITABLE_MARKET')).toBe(true)
  })
})

describe('evaluateIntegrity — severity rollup', () => {
  it('CRITICAL wins over WARN', () => {
    const r = evaluateIntegrity(healthy({ deadLettersLastHour: 1, campaignsFailedWrite: 2 }))
    expect(r.severity).toBe('CRITICAL')
    expect(r.findings.length).toBe(2)
  })
  it('every finding carries an action — a signal with no next step is noise', () => {
    const r = evaluateIntegrity(healthy({
      deadLettersLastHour: 1, orphanedLast24h: 5, minutesSinceSettingsSync: 999,
      minutesSinceAmsIngest: 9999, campaignsFailedWrite: 1, campaignsInUnwritableMarket: 1,
    }))
    expect(r.findings.length).toBe(6)
    for (const f of r.findings) {
      expect(f.action.length).toBeGreaterThan(20)
      expect(f.message.length).toBeGreaterThan(10)
    }
  })
})
