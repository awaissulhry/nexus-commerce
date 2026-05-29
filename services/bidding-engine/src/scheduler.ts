/**
 * Periodic optimize loop. Without this the engine is inert — nothing ever
 * pulls contexts. Every BIDDING_INTERVAL_MIN minutes it asks the primary app
 * for re-biddable targets, runs the inventory-elasticity formula, and enqueues
 * the material changes (the worker then performs the gated writes). A re-entrancy
 * guard prevents overlapping cycles; BIDDING_INTERVAL_MIN<=0 disables it (e.g.
 * when an external scheduler drives POST /optimize instead).
 */
import { optimizeFromPrimary } from './producer.js'

interface Logger { info: (obj: unknown, msg?: string) => void; error: (obj: unknown, msg?: string) => void }

export function startScheduler(log: Logger): () => void {
  const minutes = Number(process.env.BIDDING_INTERVAL_MIN ?? 60)
  if (!Number.isFinite(minutes) || minutes <= 0) {
    log.info({}, 'bidding scheduler disabled (BIDDING_INTERVAL_MIN <= 0)')
    return () => {}
  }

  let running = false
  const tick = async () => {
    if (running) return // skip if the previous cycle is still draining
    running = true
    try {
      const result = await optimizeFromPrimary({})
      log.info(result, 'bidding optimize cycle')
    } catch (err) {
      log.error({ err: String(err) }, 'bidding optimize cycle failed')
    } finally {
      running = false
    }
  }

  const handle = setInterval(() => void tick(), minutes * 60_000)
  // First run shortly after boot so the HTTP server comes up unblocked.
  const kick = setTimeout(() => void tick(), 10_000)
  log.info({ minutes }, 'bidding scheduler started')

  return () => { clearInterval(handle); clearTimeout(kick) }
}
