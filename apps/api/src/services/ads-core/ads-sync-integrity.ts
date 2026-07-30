/**
 * AX2.9 — does the Amazon ads spine still work? Answered automatically.
 *
 * Every fix in the AX2 series left behind a fact that needs to STAY true:
 * dead letters stopped, orphans get marked instead of retried forever, the
 * settings sync keeps stamping read-freshness, AMS keeps ingesting, writes keep
 * landing. Checking those by hand every morning is exactly the maintenance
 * burden the work was supposed to remove — so each one is a signal here, and
 * silence means healthy.
 *
 * Deliberately REPORT-ONLY. The anomaly guard halts automation on a spend
 * runaway because money is burning; a stalled sync is not that, and halting on
 * it would turn a data-freshness blip into an outage. These surface instead.
 *
 * Pure: takes a snapshot, returns findings. Unit-tested.
 */

export type IntegritySeverity = 'OK' | 'WARN' | 'CRITICAL'

export interface IntegritySnapshot {
  /** AD_* queue rows that dead-lettered in the last hour. */
  deadLettersLastHour: number
  /** AD_* rows dead-lettered in the last 24h. */
  deadLetters24h: number
  /** AdTargets currently marked orphaned (Amazon no longer has them). */
  orphanedTargets: number
  /** Orphans newly marked in the last 24h — a rising count is drift, a flat one is history. */
  orphanedLast24h: number
  /** Minutes since the settings sync last verified ANY campaign against Amazon. */
  minutesSinceSettingsSync: number | null
  /** Minutes since the newest AMS hourly row was ingested. */
  minutesSinceAmsIngest: number | null
  /** Campaigns whose last write to Amazon failed. */
  campaignsFailedWrite: number
  /** Campaigns in a market with no writable production connection. */
  campaignsInUnwritableMarket: number
  /**
   * AX-VT.5 — open, unresolved drift rows: entities where Amazon disagrees with our records and
   * nothing is in flight to explain it. This is the signal that was missing entirely; the portfolio
   * defect that started AX-VT ran for weeks with every other number on this snapshot healthy.
   */
  openDriftRows: number
  /**
   * Of those, the ones that will NOT resolve on their own — EXTERNAL_CHANGE and WRITE_FAILED.
   *
   * Severity keys off THIS, not the total. Measured on prod: 29 open rows of which 27 were
   * WRITE_LAG (our own writes still landing, self-healing by definition) tripped CRITICAL against
   * a total-based threshold. A busy hour of legitimate writes must never look like a systemic
   * break, or the CRITICAL that matters gets ignored along with the ones that don't.
   */
  driftNeedsAttention: number
  /** Minutes since the structural reconcile last completed a pass. */
  minutesSinceStructuralReconcile: number | null
}

export interface IntegrityFinding {
  code: string
  severity: 'WARN' | 'CRITICAL'
  message: string
  /** What to do. Empty when the system self-heals and this is informational. */
  action: string
}

export interface IntegrityReport {
  severity: IntegritySeverity
  findings: IntegrityFinding[]
  snapshot: IntegritySnapshot
}

/** Thresholds are generous — this must not cry wolf, or it becomes noise to ignore. */
export const INTEGRITY_THRESHOLDS = {
  /** The settings sync runs every 20 min; 3 missed passes is a real stall. */
  settingsSyncStaleMinutes: 70,
  /**
   * AMS only sends when there is traffic. A small account genuinely has hours
   * with zero impressions overnight, so a 3h threshold fired most nights —
   * and a check that cries wolf nightly is one you learn to ignore, which is
   * the exact maintenance burden this file exists to remove. 8h still catches
   * a real multi-day stall by the next morning without firing on a quiet night.
   */
  amsStaleMinutes: 480,
  /** Post-AX2.0 the steady state is zero. Any new one is signal. */
  deadLettersLastHour: 0,
  /**
   * AX-VT.5 — above this, drift stops being a list somebody works through and becomes a systemic
   * fault. Set at 25 from measurement, not taste: the portfolio defect alone produced 62 wrong
   * campaigns, and the SD archiving 19, so a real systemic break clears this comfortably while a
   * handful of ordinary Seller Central edits does not.
   */
  driftRowsCritical: 25,
  /** The reconcile runs 6-hourly; two missed passes is a stall worth naming. */
  structuralReconcileStaleMinutes: 13 * 60,
}

export function evaluateIntegrity(s: IntegritySnapshot): IntegrityReport {
  const findings: IntegrityFinding[] = []

  // The AX2.0 regression test. Before that fix this ran at ~23/day forever.
  if (s.deadLettersLastHour > INTEGRITY_THRESHOLDS.deadLettersLastHour) {
    findings.push({
      code: 'ADS_DEAD_LETTERS_RISING',
      severity: 'CRITICAL',
      message: `${s.deadLettersLastHour} Amazon ad write(s) dead-lettered in the last hour (${s.deadLetters24h} in 24h).`,
      action: 'Check /api/advertising/… queue errors. If they are entityNotFoundError the orphan guard should have caught them — that guard has regressed.',
    })
  }

  // Orphans are expected to exist (Amazon deletes keywords); they are only a
  // problem if they keep APPEARING, which means something upstream is deleting
  // entities we still think we own.
  if (s.orphanedLast24h > 0) {
    findings.push({
      code: 'ADS_ORPHANS_APPEARING',
      severity: 'WARN',
      message: `${s.orphanedLast24h} ad target(s) were newly orphaned in the last 24h (${s.orphanedTargets} total).`,
      action: 'Normal after deleting keywords on Amazon. Investigate only if it keeps rising with no deletions on your side.',
    })
  }

  if (s.minutesSinceSettingsSync == null) {
    findings.push({
      code: 'ADS_SETTINGS_SYNC_NEVER',
      severity: 'CRITICAL',
      message: 'No campaign has ever been verified against Amazon.',
      action: 'The 20-minute settings sync is not running — check NEXUS_ENABLE_AMAZON_ADS_CRON and the ads-campaign-settings-sync CronRun rows.',
    })
  } else if (s.minutesSinceSettingsSync > INTEGRITY_THRESHOLDS.settingsSyncStaleMinutes) {
    findings.push({
      code: 'ADS_SETTINGS_SYNC_STALE',
      severity: 'CRITICAL',
      message: `The settings sync last verified a campaign ${s.minutesSinceSettingsSync} minutes ago (expected every 20).`,
      action: 'The console is showing stale Amazon state. Check the ads-campaign-settings-sync cron.',
    })
  }

  if (s.minutesSinceAmsIngest != null && s.minutesSinceAmsIngest > INTEGRITY_THRESHOLDS.amsStaleMinutes) {
    findings.push({
      code: 'AMS_INGEST_STALLED',
      severity: 'WARN',
      message: `No Marketing Stream data ingested for ${Math.round(s.minutesSinceAmsIngest / 60)}h.`,
      action: 'Longer than a quiet overnight. Intraday figures are stale — check the AMS subscription and the SQS→Lambda forwarder.',
    })
  }

  // AX-VT.5 — the signal whose absence let the portfolio defect run for weeks.
  //
  // Reported on the total, escalated on the part that will not fix itself. Those are different
  // questions and conflating them is what made the first version fire CRITICAL on 27 healthy
  // in-flight writes.
  if (s.driftNeedsAttention > 0) {
    findings.push({
      code: 'ADS_DRIFT_OPEN',
      severity: s.driftNeedsAttention > INTEGRITY_THRESHOLDS.driftRowsCritical ? 'CRITICAL' : 'WARN',
      message: `${s.driftNeedsAttention} entity field(s) differ from Amazon for a reason that will NOT resolve on its own${s.openDriftRows > s.driftNeedsAttention ? ` (of ${s.openDriftRows} open in total)` : ''}.`,
      action: 'Open GET /advertising/drift or /marketing/ads/trust. EXTERNAL_CHANGE means someone edited it on Amazon; WRITE_FAILED means one of our writes never landed.',
    })
  }

  if (s.minutesSinceStructuralReconcile == null) {
    findings.push({
      code: 'ADS_STRUCTURAL_RECONCILE_NEVER',
      severity: 'WARN',
      message: 'The structural reconcile has never completed a pass.',
      action: 'Nothing is comparing the account against Amazon on a schedule. Check NEXUS_ENABLE_AMAZON_ADS_CRON and the ads-structural-reconcile cron.',
    })
  } else if (s.minutesSinceStructuralReconcile > INTEGRITY_THRESHOLDS.structuralReconcileStaleMinutes) {
    findings.push({
      code: 'ADS_STRUCTURAL_RECONCILE_STALE',
      severity: 'WARN',
      message: `No structural reconcile pass for ${Math.round(s.minutesSinceStructuralReconcile / 60)}h.`,
      action: 'Drift is accumulating unmeasured. Check the ads-structural-reconcile cron is running.',
    })
  }

  if (s.campaignsFailedWrite > 0) {
    findings.push({
      code: 'ADS_WRITES_FAILING',
      severity: 'WARN',
      message: `${s.campaignsFailedWrite} campaign(s) have a FAILED last write to Amazon.`,
      action: 'The auto-reconcile sweep retries transient failures. A count that persists across days is a permanent rejection needing attention.',
    })
  }

  if (s.campaignsInUnwritableMarket > 0) {
    findings.push({
      code: 'ADS_CAMPAIGNS_IN_UNWRITABLE_MARKET',
      severity: 'WARN',
      message: `${s.campaignsInUnwritableMarket} campaign(s) live in a marketplace with no writable production connection — edits to them stay local.`,
      action: 'Either graduate that marketplace’s Amazon Ads connection to production, or stop editing those campaigns.',
    })
  }

  const severity: IntegritySeverity =
    findings.some((f) => f.severity === 'CRITICAL') ? 'CRITICAL'
    : findings.length ? 'WARN'
    : 'OK'

  return { severity, findings, snapshot: s }
}
