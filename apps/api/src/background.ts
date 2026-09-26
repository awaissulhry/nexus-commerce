import './db.js'
import { createServer } from 'node:http'
import prisma from './db.js'
import { redis, initializeQueue, closeQueue } from './lib/queue.js'
import { stopScheduledTasks } from './lib/cron/clustered.js'
import { closeBroker } from './lib/events/index.js'
import { initOtel } from './utils/otel-setup.js'
import { logger } from './utils/logger.js'

const role = process.argv[2]
if (role !== 'worker' && role !== 'scheduler') throw new Error('Background process role must be worker or scheduler')
if (process.env.NEXUS_DISABLE_BACKGROUND_JOBS === '1') throw new Error('Background service cannot start with NEXUS_DISABLE_BACKGROUND_JOBS=1')
if (!process.env.REDIS_URL && !process.env.REDIS_HOST) throw new Error('Background services require Redis for coordination')
// The worker consumes the queued lane and the scheduler produces into it (addJobSafely
// skips every enqueue while this is off, leaving work to the 60-second drains).
if (process.env.ENABLE_QUEUE_WORKERS !== '1') throw new Error('Background services require ENABLE_QUEUE_WORKERS=1')
// Legacy schedules must also fail closed once they run as independent services.
process.env.NEXUS_REQUIRE_CRON_LEASE = '1'
process.env.NEXUS_PROCESS_ROLE = role
process.env.EVENT_SOURCE = role
void initOtel()
let ready = false
let stop: (() => Promise<void>) | undefined
const server = createServer((request, response) => {
  if (request.url !== '/health/ready') { response.writeHead(404).end(); return }
  response.writeHead(ready && redis.connection.status === 'ready' ? 200 : 503, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ role, ready: ready && redis.connection.status === 'ready' }))
})
const deadline = setTimeout(() => { logger.error('Background startup timed out', { role }); process.exit(1) }, 60_000)
deadline.unref()
async function start() {
try {
  await prisma.$queryRaw`SELECT 1`
  if (role === 'worker') {
    const { startWorker } = await import('./runtime/worker.js')
    stop = await startWorker()
  } else {
    await initializeQueue()
    const { startScheduler } = await import('./runtime/scheduler.js')
    await startScheduler()
    stop = async () => { await stopScheduledTasks(); await closeBroker(); await closeQueue() }
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(Number(process.env.PORT ?? 8081), '0.0.0.0', resolve)
  })
  ready = true
  clearTimeout(deadline)
  logger.info('Background service ready', { role })
} catch (error) {
  logger.error('Background service startup failed', { role, error: String(error) })
  process.exit(1)
}
}
void start()

let stopping = false
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, async () => {
  if (stopping) return
  stopping = true
  ready = false
  const timeout = setTimeout(() => process.exit(1), 30_000)
  timeout.unref()
  try {
    await new Promise<void>(resolve => server.close(() => resolve()))
    await stop?.()
    await prisma.$disconnect()
    process.exit(0)
  } catch (error) { logger.error('Background shutdown failed', { role, error: String(error) }); process.exit(1) }
})
