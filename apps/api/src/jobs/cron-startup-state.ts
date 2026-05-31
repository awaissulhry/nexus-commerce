/**
 * Apex diagnostic — records how far the ads-cron startup block got, so a hang
 * on an `await import` (e.g. a Redis-touching module when Redis is unreachable)
 * is observable via the cron-status probe instead of invisible in Railway logs.
 * The last `step` before the probe goes quiet is the line that hung.
 */
export const cronStartupState: { step: string; updatedAt: string } = {
  step: 'not-reached',
  updatedAt: '',
}

export function markCronStep(step: string): void {
  cronStartupState.step = step
  cronStartupState.updatedAt = new Date().toISOString()
}
