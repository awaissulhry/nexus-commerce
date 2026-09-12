import { randomUUID } from 'node:crypto'
import { logger } from '../../utils/logger.js'

type LeaseStore = { status: string; eval(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown> }
const CLAIM = `
  if tonumber(redis.call('get', KEYS[1]) or '-1') >= tonumber(ARGV[1]) or redis.call('exists', KEYS[2]) == 1 then return 0 end
  redis.call('set', KEYS[1], ARGV[1], 'PX', 3024000000)
  redis.call('set', KEYS[2], ARGV[2], 'PX', 90000)
  return 1`
const RENEW = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], 90000) else return 0 end`
const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`

/** One bounded pair of keys per schedule/profile; do not start work without a lease. */
export async function runWorkspaceTick(store: LeaseStore, jobId: string, scheduledAt: number, work: () => Promise<void>, periodMs = 60_000): Promise<boolean> {
  // The shared hash tag also keeps both keys in one Redis Cluster slot.
  const tickKey = `{nexus:cron:workspace:${jobId}}:last`
  const leaseKey = `{nexus:cron:workspace:${jobId}}:lease`
  const token = randomUUID()
  try {
    if (store.status !== 'ready') throw new Error('Redis is unavailable')
    const claimed = await store.eval(CLAIM, 2, tickKey, leaseKey, Math.floor(scheduledAt / periodMs), token)
    if (claimed !== 1) return false
  } catch (error) {
    logger.error('business automation tick skipped: lease unavailable', { jobId, error: String(error) })
    return false
  }
  let renewing = false
  const timer = setInterval(async () => {
    if (renewing) return
    renewing = true
    try {
      if (store.status !== 'ready' || await store.eval(RENEW, 1, leaseKey, token) !== 1) throw new Error('Lease lost')
    } catch (error) {
      logger.error('business automation lease lost while work was in progress', { jobId, error: String(error) })
    } finally { renewing = false }
  }, 20_000)
  timer.unref()
  try { await work(); return true }
  finally {
    clearInterval(timer)
    try { if (store.status === 'ready') await store.eval(RELEASE, 1, leaseKey, token) }
    catch (error) { logger.warn('business automation lease release failed', { jobId, error: String(error) }) }
  }
}
