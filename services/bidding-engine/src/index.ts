/**
 * Bootstrap: start the BullMQ worker + the Fastify control server, with clean
 * graceful shutdown so in-flight jobs finish and Redis connections close.
 */
import { config } from './config.js'
import { startWorker } from './worker.js'
import { buildHttp } from './http.js'
import { bidQueue, connection } from './queue.js'

async function main() {
  config.assertWritable() // fail fast if live mode is missing creds

  const worker = startWorker()
  const app = buildHttp()
  await app.listen({ port: config.httpPort, host: '0.0.0.0' })
  app.log.info(
    { dryRun: config.worker.dryRun, concurrency: config.worker.concurrency, region: config.amazon.region },
    'bidding-engine up',
  )

  const shutdown = async (signal: string) => {
    app.log.info(`${signal} received — draining`)
    try {
      await worker.close()
      await app.close()
      await bidQueue.close()
      await connection.quit()
    } finally {
      process.exit(0)
    }
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

main().catch((err) => {
  console.error('bidding-engine failed to start', err)
  process.exit(1)
})
