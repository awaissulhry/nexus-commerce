/**
 * Starts this process's runtime-status heartbeat (see lib/runtime-status/process-snapshot.ts).
 *
 * Every PUBLISH_INTERVAL_MS it applies circuit resets requested since the last tick, then publishes the
 * snapshot. Started by all three processes: src/index.ts (API) and src/background.ts (worker, scheduler).
 */
import { logger } from '../../utils/logger.js'
import { registeredCronModules } from '../../lib/cron/clustered.js'
import {
  PUBLISH_INTERVAL_MS, buildSection, currentProcessRole, flagSection, publishLocalSnapshot, registerStatusSection, withdrawLocalSnapshot,
} from '../../lib/runtime-status/process-snapshot.js'
import { applyRequestedCircuitResets, registerCircuitSection } from './circuit-breakers.service.js'

/** The sections every process publishes. Role-specific ones are registered by their owners. */
export function registerCoreStatusSections(): void {
  registerCircuitSection()
  registerStatusSection('scheduledJobs', registeredCronModules)
  registerStatusSection('flags', () => flagSection())
  // Platform health watchdog — a restart under the same deployment is a crash, not a deploy.
  registerStatusSection('build', () => buildSection())
}

export function startRuntimeStatusPublisher(options: { intervalMs?: number } = {}): () => Promise<void> {
  registerCoreStatusSections()
  let stopped = false
  let running = false
  let failing = false
  const tick = async () => {
    if (running || stopped) return
    running = true
    try {
      await applyRequestedCircuitResets()
      const published = await publishLocalSnapshot()
      if (published && failing) logger.info('runtime status: publishing again', { role: currentProcessRole() })
      failing = !published
    } catch (error) {
      // Once per outage, not every tick: readers already report the missing heartbeat.
      if (!failing) logger.warn('runtime status: publish failed; the API will report this process as not reporting', {
        role: currentProcessRole(),
        error: error instanceof Error ? error.message : String(error),
      })
      failing = true
    } finally {
      running = false
    }
  }
  void tick()
  const timer = setInterval(() => void tick(), options.intervalMs ?? PUBLISH_INTERVAL_MS)
  timer.unref()
  return async () => {
    stopped = true
    clearInterval(timer)
    await withdrawLocalSnapshot()
  }
}
