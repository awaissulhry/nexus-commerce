/**
 * P6.1 (docs/channel-connections/FINAL-PLAN.md section 6.1) — automatic Amazon app-secret rotation.
 *
 * Every 10 minutes, once, platform-wide (ChannelApp is Nexus's own app, not a profile's): read the
 * credential queue (expiry dates, new secrets) and, 30 days before the secret expires, ask Amazon for
 * a new one. The whole logic and its safety rules are in services/cx/amazon-secret-rotation.service.ts.
 *
 * Starts only when AMAZON_APP_CREDENTIAL_QUEUE_URL is set — registering that queue with Amazon is
 * the Owner's one-time step, and without it a rotation would lose the new secret.
 */
import cron, { schedulePlatform } from '../lib/cron/clustered.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { logger } from '../utils/logger.js'
import { credentialQueueUrl, runAmazonSecretRotation } from '../services/cx/amazon-secret-rotation.service.js'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null

export async function runAmazonSecretRotationTick(): Promise<string> {
  return recordCronRun('amazon-secret-rotation', () => runAmazonSecretRotation())
}

export function startAmazonSecretRotationCron(): void {
  if (!credentialQueueUrl()) {
    logger.info('amazon-secret-rotation: AMAZON_APP_CREDENTIAL_QUEUE_URL not set — automatic rotation is off')
    return
  }
  if (scheduledTask) return
  scheduledTask = schedulePlatform('*/10 * * * *', async () => {
    await runAmazonSecretRotationTick().catch((err) =>
      logger.error('amazon-secret-rotation: tick failed', { error: err instanceof Error ? err.message : String(err) }))
  })
  logger.info('amazon-secret-rotation: started (every 10 minutes)')
}
