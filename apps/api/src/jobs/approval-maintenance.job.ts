/**
 * NAF.AP.4/AP.5 — the approval queue's maintenance pass.
 *
 * Two jobs in one sweep, because both are about a clock running out:
 *  · expire pending approvals past their `expiresAt` (AP.5)
 *  · run approved actions whose undo window has closed (AP.4)
 *
 * Deliberately NOT gated on NEXUS_ENABLE_FLEET_SWEEP_CRON. Those flags exist
 * to keep *agents* dark; this is the opposite — it is the mechanism that
 * makes an operator's own approve actually happen, and that a stale request
 * stops being actionable. Turning the fleet off must not strand a decision
 * a human already took.
 *
 * Every 30 seconds: the undo window is 20s, so a parked action that the
 * operator's browser never committed (tab closed, network dropped) still
 * runs within about a minute.
 */
import cron from 'node-cron'
import { runApprovalMaintenance } from '../services/agent-fleet/approval-inbox.service.js'
import { logger } from '../utils/logger.js'

let running = false

export async function runApprovalMaintenanceOnce(): Promise<string> {
  if (running) return 'skipped=overlap'
  running = true
  try {
    const r = await runApprovalMaintenance()
    return `expired=${r.expired} committed=${r.committed} failed=${r.failed}`
  } finally {
    running = false
  }
}

let task: ReturnType<typeof cron.schedule> | null = null

export function startApprovalMaintenanceCron(): void {
  if (task) return
  const schedule = process.env.NEXUS_APPROVAL_MAINTENANCE_SCHEDULE ?? '*/30 * * * * *'
  if (!cron.validate(schedule)) {
    logger.error(`[approval-maintenance] invalid schedule "${schedule}" — cron not started`)
    return
  }
  task = cron.schedule(schedule, () => {
    void runApprovalMaintenanceOnce().catch((err) =>
      logger.error('[approval-maintenance] failed', { error: String(err) }),
    )
  })
  logger.info(`[approval-maintenance] approval queue maintenance scheduled (${schedule})`)
}
