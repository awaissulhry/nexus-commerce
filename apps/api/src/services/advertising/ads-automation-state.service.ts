/**
 * TD.0 — Trading Desk automation safety spine.
 *
 * Single source of truth for the ad-automation engine's RUNTIME posture:
 *   • autonomy dial — OFF (nothing runs) · SUGGEST (force dry-run) · AUTO
 *     (respect each rule's own enabled/dryRun).
 *   • circuit-breaker halt — set by the anomaly guard or an operator; the rule
 *     evaluator + write-gate refuse automation writes while halted.
 *
 * The env kill-switch (NEXUS_ADS_AUTOMATION_KILL=1) remains a deploy-level
 * backstop; this row is the runtime control that needs no redeploy.
 *
 * ACR.0.3 — this dial fails SAFE, in both of its two distinct failure modes:
 *
 *   • Row missing → the upsert creates it from the schema default, which is
 *     SUGGEST. An environment nobody has configured proposes; it does not act.
 *   • Read failed → we cannot confirm we are allowed to write, so the two
 *     ENFORCEMENT calls answer as if we were not. A skipped tick costs 15
 *     minutes; a tick that writes because a pooler blip made the safety state
 *     unreadable costs real money against a decision nobody made.
 *
 * Both previously resolved to AUTO, so the control that exists to stop
 * automation defaulted to permitting it.
 */
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { ENGINE_ACTORS, engineCaps, engineLabel, type BreakerBucket, type EngineCaps } from './ads-engine-actors.js'

export type Autonomy = 'OFF' | 'SUGGEST' | 'AUTO'
export interface AdsAutomationStateView {
  autonomy: Autonomy
  halted: boolean
  haltedAt: string | null
  haltReason: string | null
  haltedBy: string | null
  maxHourlySpendCentsEur: number | null
  maxActionsPerHour: number | null
  /** SG.5 — account default ACoS target, INTEGER percent (30 = 30%). Two readers: the bid optimiser, for every
   *  campaign without a target of its own and no rule or plan target (ads-target-acos-resolver.ts), and bid_apply's
   *  targetAcos/curBidTargetAcos ops, as fallback when the rule has no target. */
  defaultTargetAcosPct: number | null
  lastCheckedAt: string | null
  // Derived: env kill-switch OR halted OR autonomy=OFF.
  effectivelyStopped: boolean
  /**
   * True when the state row could not be read. The posture reported alongside
   * it is the fail-safe assumption, NOT observed truth — surface it as "cannot
   * read the safety state" rather than as a setting the operator chose.
   */
  degraded: boolean
}

/**
 * PER BUSINESS. The workspace client (`packages/database/workspace-client.ts`, `singleton()`) stores and reads this
 * id as `<workspaceId>:singleton` for every business except the legacy one, which keeps `singleton`. So each business
 * has its own row, and a halt in one never stops another (`automation-state-two-business-postgres.vitest.test.ts`).
 */
const SINGLETON = 'singleton'

/**
 * The posture assumed when the state row cannot be read. Matches the schema
 * default, so "unconfigured" and "unreadable" behave identically: propose, never act.
 */
const FAIL_SAFE_AUTONOMY: Autonomy = 'SUGGEST'

function envKill(): boolean { return process.env.NEXUS_ADS_AUTOMATION_KILL === '1' }

async function getRow() {
  return prisma.adsAutomationState.upsert({
    where: { id: SINGLETON },
    create: { id: SINGLETON },
    update: {},
  })
}

export async function getAutomationState(): Promise<AdsAutomationStateView> {
  const r = await getRow().catch((err) => {
    logger.error('[ads-automation] state read failed — reporting the fail-safe posture', { error: String(err) })
    return null
  })
  const autonomy = (r?.autonomy as Autonomy) ?? FAIL_SAFE_AUTONOMY
  const halted = r?.halted ?? false
  return {
    autonomy,
    halted,
    haltedAt: r?.haltedAt?.toISOString() ?? null,
    haltReason: r?.haltReason ?? null,
    haltedBy: r?.haltedBy ?? null,
    maxHourlySpendCentsEur: r?.maxHourlySpendCentsEur ?? null,
    maxActionsPerHour: r?.maxActionsPerHour ?? null,
    defaultTargetAcosPct: r?.defaultTargetAcosPct ?? null,
    lastCheckedAt: r?.lastCheckedAt?.toISOString() ?? null,
    effectivelyStopped: envKill() || halted || autonomy === 'OFF',
    degraded: r == null,
  }
}

/**
 * True when NO automation writes should fire (env kill, operator/auto halt, or OFF).
 *
 * Fails CLOSED: an unreadable state row halts this tick rather than writing blind.
 */
export async function isAutomationHalted(): Promise<boolean> {
  if (envKill()) return true
  const r = await getRow().catch((err) => {
    logger.error('[ads-automation] halt check could not read state — treating as halted', { error: String(err) })
    return null
  })
  if (r == null) return true
  return r.halted || r.autonomy === 'OFF'
}

/**
 * True when automation may evaluate but must only PROPOSE (force dry-run).
 *
 * Fails CLOSED: an unreadable state row proposes rather than acts.
 */
export async function shouldForceDryRun(): Promise<boolean> {
  const r = await getRow().catch((err) => {
    logger.error('[ads-automation] dry-run check could not read state — forcing dry-run', { error: String(err) })
    return null
  })
  if (r == null) return true
  return r.autonomy === 'SUGGEST'
}

export async function haltAutomation(reason: string, by: string): Promise<void> {
  await prisma.adsAutomationState.upsert({
    where: { id: SINGLETON },
    create: { id: SINGLETON, halted: true, haltedAt: new Date(), haltReason: reason, haltedBy: by },
    update: { halted: true, haltedAt: new Date(), haltReason: reason, haltedBy: by },
  })
  logger.warn('[ads-automation] HALTED', { reason, by })
  // Notify operators (best-effort; loose import to avoid cycles).
  try {
    // 7d — no href: the notice links to the Control Room by default (the old link had no page).
    const { notifyAutomation } = await import('./ads-automation-notify.service.js')
    await notifyAutomation({ type: 'ads-automation-halt', severity: 'danger', title: 'Ad automation halted', body: reason })
  } catch { /* notify is best-effort */ }
}

export async function resumeAutomation(by: string): Promise<void> {
  await prisma.adsAutomationState.upsert({
    where: { id: SINGLETON },
    create: { id: SINGLETON, halted: false },
    update: { halted: false, haltedAt: null, haltReason: null, haltedBy: by },
  })
  logger.info('[ads-automation] resumed', { by })
}

export async function setAutonomy(level: Autonomy, by: string): Promise<void> {
  await prisma.adsAutomationState.upsert({
    where: { id: SINGLETON },
    create: { id: SINGLETON, autonomy: level },
    update: { autonomy: level },
  })
  logger.info('[ads-automation] autonomy set', { level, by })
}

/** SG.5 — set (or clear, with null) the account default ACoS target. INTEGER percent. */
export async function setDefaultTargetAcosPct(pct: number | null, by: string): Promise<void> {
  await prisma.adsAutomationState.upsert({
    where: { id: SINGLETON },
    create: { id: SINGLETON, defaultTargetAcosPct: pct },
    update: { defaultTargetAcosPct: pct },
  })
  logger.info('[ads-automation] default target ACoS set', { pct, by })
}

export async function setGuardThresholds(opts: { maxHourlySpendCentsEur?: number | null; maxActionsPerHour?: number | null }): Promise<void> {
  await prisma.adsAutomationState.upsert({
    where: { id: SINGLETON },
    create: { id: SINGLETON, ...opts },
    update: { ...opts },
  })
}

// ── Group 1 (1g) — the brakes as a person moves them (the Control Room routes) ────────────────────────────
//
// The routes called the setters above directly: no audit row, and the thresholds route spread its whole body into the
// upsert, so a 0 or negative limit was stored (0 € switches the spend signal off) and any other column could ride
// along. These validate, change, and leave one audit row each: who, from → to, why. The row goes in the ads action
// log, where Claude's moves of the same brakes already go (ads-automation-adapters.ts, automation-stop.service.ts,
// ads-engine-tune.service.ts), so both are read in one place. A press that changes nothing writes no row.

export type BrakeOutcome = { ok: true } | { ok: false; error: string }

async function auditBrake(by: string, actionType: string, entityType: string, entityId: string, before: object, after: object, note: string): Promise<void> {
  await prisma.advertisingActionLog.create({
    data: {
      userId: by, actionType, entityType, entityId, payloadBefore: before, payloadAfter: after,
      amazonResponseStatus: 'SUCCESS', evidence: { metric: 'operator_autonomy', note },
    },
  }).catch((err: unknown) => logger.warn('[ads-automation] audit row not written', { actionType, error: String(err) }))
}

const AUTONOMY_LEVELS: readonly Autonomy[] = ['OFF', 'SUGGEST', 'AUTO']

/** The dial. It does not lift a halt: Resume does that. */
export async function changeAutonomy(level: unknown, by: string): Promise<BrakeOutcome> {
  if (typeof level !== 'string' || !(AUTONOMY_LEVELS as readonly string[]).includes(level)) {
    return { ok: false, error: 'The dial level must be OFF, SUGGEST or AUTO.' }
  }
  const before = await getRow()
  if (before.autonomy === level) return { ok: true }
  await setAutonomy(level as Autonomy, by)
  await auditBrake(by, 'set_automation_level', 'ADS_DIAL', 'ads-dial', { autonomy: before.autonomy }, { autonomy: level }, `ads dial ${before.autonomy} → ${level}`)
  return { ok: true }
}

export async function haltWithAudit(reason: unknown, by: string): Promise<void> {
  const why = typeof reason === 'string' && reason.trim() ? reason.trim() : 'Operator halt'
  const before = await getRow()
  await haltAutomation(why, by)
  await auditBrake(by, 'halt_automation', 'AUTOMATION', 'amazon-ads', { halted: before.halted, haltReason: before.haltReason }, { halted: true, haltReason: why }, 'ads automation halted')
}

/** Clears a halt only. A dial at OFF stays OFF: the dial is what turns it back on. */
export async function resumeWithAudit(by: string): Promise<void> {
  const before = await getRow()
  await resumeAutomation(by)
  if (before.halted) {
    await auditBrake(by, 'resume_automation', 'AUTOMATION', 'amazon-ads', { halted: true, haltReason: before.haltReason }, { halted: false, haltReason: null }, 'ads automation resumed')
  }
}

export interface GuardThresholds { maxActionsPerHour?: number | null; maxHourlySpendCentsEur?: number | null }

const THRESHOLD_NAMES: Record<keyof GuardThresholds, string> = {
  maxActionsPerHour: 'Rule actions per hour (maxActionsPerHour)',
  maxHourlySpendCentsEur: 'Spend per hour in cents (maxHourlySpendCentsEur)',
}
const INT_MAX = 2_147_483_647 // the columns are Int

/**
 * Each limit: a whole number of at least 1, or null for the default (250 rule actions, €500 an hour — the breaker reads
 * null as its default, never as "no limit"). A field left out is left as it is.
 */
export function parseGuardThresholds(body: unknown): { ok: true; value: GuardThresholds } | { ok: false; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Send maxActionsPerHour and/or maxHourlySpendCentsEur.' }
  }
  const fields = Object.keys(THRESHOLD_NAMES) as Array<keyof GuardThresholds>
  const unknown = Object.keys(body).filter((k) => !(fields as string[]).includes(k))
  if (unknown.length) return { ok: false, error: `Only maxActionsPerHour and maxHourlySpendCentsEur can be set here, not ${unknown.join(', ')}.` }
  const value: GuardThresholds = {}
  for (const field of fields) {
    const n = (body as Record<string, unknown>)[field]
    if (n === undefined) continue
    if (n !== null && (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > INT_MAX)) {
      return { ok: false, error: `${THRESHOLD_NAMES[field]} must be a whole number of at least 1, or empty to use the default.` }
    }
    value[field] = n as number | null
  }
  if (!Object.keys(value).length) return { ok: false, error: 'Send maxActionsPerHour and/or maxHourlySpendCentsEur.' }
  return { ok: true, value }
}

export async function changeGuardThresholds(body: unknown, by: string): Promise<BrakeOutcome> {
  const parsed = parseGuardThresholds(body)
  if ('error' in parsed) return parsed
  const row = await getRow()
  const before = { maxActionsPerHour: row.maxActionsPerHour, maxHourlySpendCentsEur: row.maxHourlySpendCentsEur }
  const after = { ...before, ...parsed.value }
  if (after.maxActionsPerHour === before.maxActionsPerHour && after.maxHourlySpendCentsEur === before.maxHourlySpendCentsEur) return { ok: true }
  await setGuardThresholds(parsed.value)
  await auditBrake(by, 'tune_engine_setting', 'ADS_AUTOMATION_STATE', 'breaker', before, after, 'anomaly breaker limits')
  return { ok: true }
}

/**
 * Each engine's write limits, for the screens (from ads-engine-actors.ts: code defaults + NEXUS_ADS_ENGINE_CAPS).
 * `breakerPerHour` binds now (the anomaly breaker); `perTick` / `perDay` bind only where an engine checks them.
 */
export function engineLimits(): Array<{ key: BreakerBucket; label: string } & EngineCaps> {
  return ([...ENGINE_ACTORS.map((d) => d.key), 'unknown'] as BreakerBucket[]).map((key) => ({ key, label: engineLabel(key), ...engineCaps(key) }))
}

export async function markGuardChecked(): Promise<void> {
  await prisma.adsAutomationState.upsert({ where: { id: SINGLETON }, create: { id: SINGLETON, lastCheckedAt: new Date() }, update: { lastCheckedAt: new Date() } }).catch(() => {})
}

/** R12 — the halt as stop-automation reads it, without creating the row (a read never writes). */
export async function readHaltState(): Promise<{ halted: boolean; haltReason: string | null; basis: string | null }> {
  const row = await prisma.adsAutomationState.findUnique({ where: { id: SINGLETON } })
  return { halted: row?.halted ?? false, haltReason: row?.haltReason ?? null, basis: row?.updatedAt.toISOString() ?? null }
}
