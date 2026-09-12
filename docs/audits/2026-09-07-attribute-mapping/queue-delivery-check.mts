/** Uses the disposable Redis on 6387. Runs synthetic work only, never channel workers. */
import { Queue, QueueEvents, Worker } from 'bullmq'
import { writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
process.env.REDIS_URL = 'redis://127.0.0.1:6387'
process.env.ENABLE_QUEUE_WORKERS = '1'
const { addJobSafely, closeQueue, initializeQueue, getRedisRuntimeStatus } = await import('../../../apps/api/src/lib/queue.ts')
const connection = { host: '127.0.0.1', port: 6387, maxRetriesPerRequest: null }
const name = `mapping-quality-${Date.now()}`
const queue = new Queue(name, { connection })
const events = new QueueEvents(name, { connection })
let calls = 0
const worker = new Worker(name, async job => {
  calls++
  if (job.attemptsMade === 0) throw new Error('Deliberate transient failure')
  return { resolved: job.data.value * 2 }
}, { connection, autorun: false })
const report: any = { checkedAt: new Date().toISOString(), listingWrites: 0, isolatedRedis: true }
try {
  await initializeQueue()
  await events.waitUntilReady()
  const options = { jobId: 'reviewed-job', attempts: 3, backoff: { type: 'fixed', delay: 30 } }
  assert.equal((await addJobSafely(queue, 'check', { value: 21 }, options)).enqueued, true)
  assert.equal((await addJobSafely(queue, 'check', { value: 99 }, options)).enqueued, true)
  assert.equal(await queue.count(), 1, 'duplicate job IDs must not enqueue a second job')
  const job = await queue.getJob('reviewed-job')
  assert.ok(job)
  void worker.run()
  const result = await job.waitUntilFinished(events, 15_000)
  assert.deepEqual(result, { resolved: 42 })
  assert.equal(calls, 2)
  Object.assign(report, { ok: true, runtime: getRedisRuntimeStatus(), deduplicated: true, retryRecovered: true, executions: calls, result })
} catch (error) {
  Object.assign(report, { ok: false, error: String(error) }); process.exitCode = 1
} finally {
  await worker.close()
  await events.close()
  await queue.obliterate({ force: true })
  await queue.close()
  await closeQueue()
  await writeFile('/tmp/nexus-mapping-queue-delivery.json', JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
}
