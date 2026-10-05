/**
 * The stock push heal's switch (stock-push-heal.job.ts), in a module with no imports, so the automation inventory
 * (services/automation/automation-adapters.ts) reads the very same decision the job does.
 *
 *   on     it queues a fresh quantity push for each listing whose last one failed for good (within its budget);
 *   count  count-only: it finds the same listings, lists them in its run (log and CronRun summary) and sends nothing;
 *   off    the cron is not scheduled, and a manual run does nothing.
 */
export type StockPushHealMode = 'on' | 'count' | 'off'

/**
 * THE default while NEXUS_STOCK_PUSH_HEAL is not set. Change this ONE line to ship the heal count-only ('count') or
 * off ('off'); the env var still overrides it per server.
 */
export const STOCK_PUSH_HEAL_DEFAULT_MODE: StockPushHealMode = 'on'

export const STOCK_PUSH_HEAL_FLAG = 'NEXUS_STOCK_PUSH_HEAL'

/**
 * NEXUS_STOCK_PUSH_HEAL: `0` / `off` / `false` / `no` = off; `count` / `count-only` / `dry-run` = count-only;
 * `1` / `on` / `true` / `yes` = on; unset or empty = STOCK_PUSH_HEAL_DEFAULT_MODE. Any other value is off: a switch
 * nobody can read sends nothing to a channel. Pure.
 */
export function stockPushHealMode(raw: string | undefined = process.env[STOCK_PUSH_HEAL_FLAG]): StockPushHealMode {
  const value = (raw ?? '').trim().toLowerCase()
  if (value === '') return STOCK_PUSH_HEAL_DEFAULT_MODE
  if (['1', 'on', 'true', 'yes'].includes(value)) return 'on'
  if (['count', 'count-only', 'dry-run'].includes(value)) return 'count'
  return 'off'
}
