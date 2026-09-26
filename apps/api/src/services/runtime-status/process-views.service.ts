/**
 * Status answers about the worker and the scheduler, built from their runtime snapshots
 * (lib/runtime-status/process-snapshot.ts) instead of the API's own memory.
 */
import {
  describeProcesses, readFlag, readLiveProcesses, snapshotsOf, unknownFor,
  type LiveProcesses, type UnknownValue,
} from '../../lib/runtime-status/process-snapshot.js'
import { amsPollerFacts } from '../ams-sqs.service.js'
import { flagValueEnabled } from '../../utils/env-flag.js'

interface SyncWorkerSection {
  isProcessing: boolean
  totalSyncsProcessed: number
  totalErrors: number
  lastProcessingTime: string | null
}

/**
 * The Autopilot sync worker (workers/sync.worker.ts) runs in the worker process. Counters are summed over
 * live worker instances and count from each instance's start (`uptime` is the oldest start).
 */
export async function readSyncWorkerStatus(live?: LiveProcesses) {
  const processes = live ?? (await readLiveProcesses())
  const workers = snapshotsOf(processes, 'worker').filter(snapshot => snapshot.sections.syncWorker && typeof snapshot.sections.syncWorker === 'object')
  if (!workers.length) {
    return {
      isRunning: null,
      isProcessing: null,
      totalSyncsProcessed: null,
      totalErrors: null,
      lastProcessingTime: null,
      uptime: null,
      source: 'worker' as const,
      instances: [],
      unknown: [unknownFor(processes, 'worker', 'status')] as UnknownValue[],
    }
  }
  const instances = workers.map(snapshot => {
    const s = snapshot.sections.syncWorker as SyncWorkerSection
    return {
      instanceId: snapshot.instanceId,
      startedAt: snapshot.startedAt,
      publishedAt: snapshot.publishedAt,
      isProcessing: s.isProcessing === true,
      totalSyncsProcessed: Number(s.totalSyncsProcessed) || 0,
      totalErrors: Number(s.totalErrors) || 0,
      lastProcessingTime: s.lastProcessingTime ?? null,
    }
  })
  const latest = instances.map(i => i.lastProcessingTime).filter((t): t is string => !!t).sort().at(-1) ?? null
  return {
    // A live worker heartbeat carries this section only once the Autopilot cron is registered there.
    isRunning: true,
    isProcessing: instances.some(i => i.isProcessing),
    totalSyncsProcessed: instances.reduce((n, i) => n + i.totalSyncsProcessed, 0),
    totalErrors: instances.reduce((n, i) => n + i.totalErrors, 0),
    lastProcessingTime: latest,
    uptime: instances.map(i => i.startedAt).sort()[0],
    source: 'worker' as const,
    instances,
    unknown: [] as UnknownValue[],
  }
}

/**
 * The ads-cron diagnostic. The ads crons are gated and registered in the scheduler and the AMS poller runs in
 * the worker, so each value is read from that process; `processUptimeSec` and `hasRedisUrl` describe this
 * API process, as `sources` says.
 */
export async function readAdsCronStatus(live?: LiveProcesses) {
  const processes = live ?? (await readLiveProcesses())
  const unknown: UnknownValue[] = []
  const schedulerFlag = (name: string, field: string) => {
    const flag = readFlag(processes, 'scheduler', name, field)
    if (!flag.known) unknown.push(flag.unknown)
    return flag
  }
  const adsCron = schedulerFlag('NEXUS_ENABLE_AMAZON_ADS_CRON', 'adsCronEnabled')
  const adsMode = schedulerFlag('NEXUS_AMAZON_ADS_MODE', 'adsMode')
  const queueWorkers = schedulerFlag('ENABLE_QUEUE_WORKERS', 'queueWorkersRaw')

  const scheduler = snapshotsOf(processes, 'scheduler')
    .filter(snapshot => snapshot.sections.cronStartup && typeof snapshot.sections.cronStartup === 'object')
    .sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1))[0]
  const startup = scheduler?.sections.cronStartup as { step?: string; updatedAt?: string } | undefined
  if (!startup) unknown.push(unknownFor(processes, 'scheduler', 'cronStartupStep'))

  const worker = snapshotsOf(processes, 'worker')
    .filter(snapshot => snapshot.sections.ams && typeof snapshot.sections.ams === 'object')
    .sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1))[0]
  const ams = worker?.sections.ams as ReturnType<typeof amsPollerFacts> | undefined
  if (!ams) unknown.push(unknownFor(processes, 'worker', 'ams'))
  const unknownAms = Object.fromEntries(Object.keys(amsPollerFacts()).map(key => [key, null])) as Record<keyof ReturnType<typeof amsPollerFacts>, null>

  return {
    adsCronEnabled: adsCron.known ? flagValueEnabled(adsCron.raw) : null,
    adsCronRaw: adsCron.known ? adsCron.raw : null,
    cronStartupStep: startup?.step ?? null,
    cronStartupAt: startup?.updatedAt || null,
    adsMode: adsMode.known ? adsMode.raw : null,
    queueWorkersRaw: queueWorkers.known ? queueWorkers.raw : null,
    hasRedisUrl: !!process.env.REDIS_URL,
    ams: ams ?? unknownAms,
    processUptimeSec: Math.round(process.uptime()),
    nowUtc: new Date().toISOString(),
    sources: {
      adsCronEnabled: 'scheduler', adsCronRaw: 'scheduler', cronStartupStep: 'scheduler', cronStartupAt: 'scheduler',
      adsMode: 'scheduler', queueWorkersRaw: 'scheduler', ams: 'worker', hasRedisUrl: 'api', processUptimeSec: 'api',
    },
    processes: describeProcesses(processes),
    unknown,
  }
}
