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
}

const SINGLETON = 'singleton'

function envKill(): boolean { return process.env.NEXUS_ADS_AUTOMATION_KILL === '1' }

async function getRow() {
  return prisma.adsAutomationState.upsert({
    where: { id: SINGLETON },
    create: { id: SINGLETON },
    update: {},
  })
}

export async function getAutomationState(): Promise<AdsAutomationStateView> {
  const r = await getRow().catch(() => null)
  const autonomy = (r?.autonomy as Autonomy) ?? 'AUTO'
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
  }
}

/** True when NO automation writes should fire (env kill, operator/auto halt, or OFF). */
export async function isAutomationHalted(): Promise<boolean> {
  if (envKill()) return true
  const r = await getRow().catch(() => null)
  return (r?.halted ?? false) || (r?.autonomy ?? 'AUTO') === 'OFF'
}

/** True when automation may evaluate but must only PROPOSE (force dry-run). */
export async function shouldForceDryRun(): Promise<boolean> {
  const r = await getRow().catch(() => null)
  return (r?.autonomy ?? 'AUTO') === 'SUGGEST'
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
