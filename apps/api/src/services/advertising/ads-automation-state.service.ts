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

export type Autonomy = 'OFF' | 'SUGGEST' | 'AUTO'
export interface AdsAutomationStateView {
  autonomy: Autonomy
  halted: boolean
  haltedAt: string | null
  haltReason: string | null
  haltedBy: string | null
  maxHourlySpendCentsEur: number | null
  maxActionsPerHour: number | null
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
    const { notifyAutomation } = await import('./ads-automation-notify.service.js')
    await notifyAutomation({ type: 'ads-automation-halt', severity: 'danger', title: 'Ad automation halted', body: reason, href: '/marketing/trading-desk/automation' })
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

export async function setGuardThresholds(opts: { maxHourlySpendCentsEur?: number | null; maxActionsPerHour?: number | null }): Promise<void> {
  await prisma.adsAutomationState.upsert({
    where: { id: SINGLETON },
    create: { id: SINGLETON, ...opts },
    update: { ...opts },
  })
}

export async function markGuardChecked(): Promise<void> {
  await prisma.adsAutomationState.upsert({ where: { id: SINGLETON }, create: { id: SINGLETON, lastCheckedAt: new Date() }, update: { lastCheckedAt: new Date() } }).catch(() => {})
}
