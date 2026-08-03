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
  // AX-VT.5 — a healthy account now also means "nothing is drifting" and "something is checking".
  openDriftRows: 0,
  driftNeedsAttention: 0,
  minutesSinceStructuralReconcile: 30,
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

describe('AX-VT.5 — drift and reconcile freshness', () => {
  it('escalates on drift that will NOT self-heal, not on the total', () => {
    expect(evaluateIntegrity(healthy({ openDriftRows: 3, driftNeedsAttention: 3 })).severity).toBe('WARN')
    // 62 wrong campaigns (the portfolio defect) must not read the same as three Seller Central edits.
    expect(evaluateIntegrity(healthy({ openDriftRows: 62, driftNeedsAttention: 62 })).severity).toBe('CRITICAL')
  })

  it('self-healing drift alone is SILENT — measured on prod', () => {
    // 29 open of which 27 were WRITE_LAG (our own writes still landing) fired CRITICAL against the
    // first, total-based threshold. A busy hour of legitimate writes must never look systemic, or
    // the CRITICAL that matters gets ignored along with the ones that don't.
    const r = evaluateIntegrity(healthy({ openDriftRows: 27, driftNeedsAttention: 0 }))
    expect(r.severity).toBe('OK')
    expect(r.findings.map((f) => f.code)).not.toContain('ADS_DRIFT_OPEN')
  })

  it('names the total alongside the actionable count when they differ', () => {
    const f = evaluateIntegrity(healthy({ openDriftRows: 29, driftNeedsAttention: 2 }))
      .findings.find((x) => x.code === 'ADS_DRIFT_OPEN')
    expect(f?.severity).toBe('WARN')
    expect(f?.message).toContain('2 entity field(s)')
    expect(f?.message).toContain('of 29 open in total')
  })

  it('a reconcile that has never run is itself a finding', () => {
    // Silence because nothing is checking is the failure mode this whole series exists to remove.
    const r = evaluateIntegrity(healthy({ minutesSinceStructuralReconcile: null }))
    expect(r.findings.map((f) => f.code)).toContain('ADS_STRUCTURAL_RECONCILE_NEVER')
  })

  it('tolerates one missed 6-hourly pass, complains at two', () => {
    expect(evaluateIntegrity(healthy({ minutesSinceStructuralReconcile: 7 * 60 })).severity).toBe('OK')
    expect(evaluateIntegrity(healthy({ minutesSinceStructuralReconcile: 14 * 60 })).findings.map((f) => f.code))
      .toContain('ADS_STRUCTURAL_RECONCILE_STALE')
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

/**
 * WF.2 — a whole entity class failing while the aggregate looks healthy.
 *
 * This is the signal that was missing during DL.1: 413 KEYWORD writes landed while every PRODUCT
 * and AUTO write failed, and no threshold on this snapshot moved. The failure was not "some writes
 * fail" — it was "one class fails totally", which only a per-class rate can see.
 */
describe('WF.2 ADS_WRITE_KIND_FAILING', () => {
  const base = (over: Partial<IntegritySnapshot> = {}): IntegritySnapshot => ({
    deadLettersLastHour: 0, deadLetters24h: 0, orphanedTargets: 0, orphanedLast24h: 0,
    minutesSinceSettingsSync: 5, minutesSinceAmsIngest: 5, campaignsFailedWrite: 0,
    campaignsInUnwritableMarket: 0, openDriftRows: 0, driftNeedsAttention: 0,
    minutesSinceStructuralReconcile: 5, writeOutcomesByKind: [], ...over,
  })
  const codes = (s: IntegritySnapshot) => evaluateIntegrity(s).findings.map((f) => f.code)

  it('fires on the observed shape: keywords landing, product/auto failing totally', () => {
    const r = evaluateIntegrity(base({ writeOutcomesByKind: [
      { kind: 'KEYWORD', applied: 413, failed: 0 },
      { kind: 'PRODUCT', applied: 0, failed: 15 },
      { kind: 'AUTO', applied: 0, failed: 12 },
    ] }))
    expect(r.findings.filter((f) => f.code === 'ADS_WRITE_KIND_FAILING')).toHaveLength(2)
    expect(r.severity).toBe('CRITICAL')
    expect(r.findings.find((f) => f.code === 'ADS_WRITE_KIND_FAILING')?.action).toMatch(/routing/i)
  })
  it('silent when everything lands — the healthy steady state after DL.1', () => {
    expect(codes(base({ writeOutcomesByKind: [
      { kind: 'KEYWORD', applied: 413, failed: 0 },
      { kind: 'PRODUCT', applied: 15, failed: 0 },
      { kind: 'AUTO', applied: 12, failed: 0 },
    ] }))).not.toContain('ADS_WRITE_KIND_FAILING')
  })
  it('ignores a kind with too little traffic to mean anything', () => {
    expect(codes(base({ writeOutcomesByKind: [{ kind: 'AUTO', applied: 0, failed: 3 }] }))).not.toContain('ADS_WRITE_KIND_FAILING')
  })
  it('ignores an ordinary bad patch — this must not become background noise', () => {
    expect(codes(base({ writeOutcomesByKind: [{ kind: 'KEYWORD', applied: 40, failed: 10 }] }))).not.toContain('ADS_WRITE_KIND_FAILING')
  })
  it('fires at total failure with enough attempts, not before', () => {
    expect(codes(base({ writeOutcomesByKind: [{ kind: 'PRODUCT', applied: 0, failed: 10 }] }))).toContain('ADS_WRITE_KIND_FAILING')
    expect(codes(base({ writeOutcomesByKind: [{ kind: 'PRODUCT', applied: 0, failed: 9 }] }))).not.toContain('ADS_WRITE_KIND_FAILING')
  })
  it('an absent array (older caller) changes nothing', () => {
    expect(codes(base({ writeOutcomesByKind: undefined as never }))).not.toContain('ADS_WRITE_KIND_FAILING')
  })
})
