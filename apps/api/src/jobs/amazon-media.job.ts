import { processPendingAmazonMediaRuns } from '../services/images/amazon-media-publish.service.js'
import { logger } from '../utils/logger.js'
import prisma from '../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'
import { runProfileTimer } from '../lib/cron/workspace-timer.js'

let timer: ReturnType<typeof setInterval> | undefined
let running = false
export function startAmazonMediaWorker() {
  if (timer) return
  const tick = async () => {
    if (running) return
    running = true
    try {
      await runProfileTimer('amazon-media', processPendingAmazonMediaRuns, 30_000)
    }
    catch (error) { logger.error('Amazon media worker failed', { error: error instanceof Error ? error.message : String(error) }) }
    finally { running = false }
  }
  timer = setInterval(() => void tick(), 30_000)
  timer.unref()
  void tick()
}
