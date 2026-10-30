import { fileURLToPath } from 'node:url'
import { openFactoryDatabase, type FactoryDatabase } from '@nexus/factory-db'
import { checkTestDatabaseUrl, readWorktree, worktreeDatabaseNames } from '@nexus/factory-db/test-database'
import { startCrons, type CronJob } from './core/cron'
import { redact } from './core/logger'
import { openQueues, queueConnection, type Log } from './core/queue'
import { loadFactoryEnv } from './env'
import { certificateExpiryCron } from './modules/compliance/certificates/expiry'
// B-W2a-21: the work-order cost ledger after each stock move, scan and rework of a work order.
import { costingHandlers } from './modules/costing/actual/handlers'
import { startOnIssueHandler } from './modules/inventory/issue/start'
import { floorMoveValuationHandler } from './modules/inventory/ledger/valuation'
import { invoiceFilesHandler } from './modules/invoicing/invoice-files'
import { tellBuyerHandler } from './modules/purchasing/confirm/handler'
import { afterAcceptanceHandler } from './modules/sales/quotes/after-acceptance'
import { orderHandlers } from './modules/sales/orders/handlers'
import { nightlyPlanCron } from './modules/planning/nightly'
import { sdiArchiveHandler } from './modules/invoicing/sdi/archive'
import { sdiCourtesyCopyHandler } from './modules/invoicing/sdi/copy'
import { sdiPollCron, sdiPollHandler } from './modules/invoicing/sdi/poll'
import { shipDocumentsHandler } from './modules/shipping/documents/handler'
import { trackingPollCron, trackingPollHandler } from './modules/shipping/labels/poll'
import { emailInHandlers } from './platform/email-in/handlers'
import { emailSendHandler } from './platform/email-out/outbound'
import { digestCron } from './platform/email-out/digest/digest'
import { notificationsHandler } from './platform/notifications/fan-out'
import { exportExpiryCron } from './platform/exports/expire'
import { exportHandlers } from './platform/exports/worker'
import { assertNoFakeAccountsInProduction } from './platform/gateway/boot'
import { importHandlers } from './platform/imports/worker'
import { inboundHandler } from './platform/inbound/process'
import { startEventWorkers, type EventHandler } from './platform/outbox/dispatch'
import { outboxLagCron } from './platform/outbox/lag'
import { queuePublisher, startRelay } from './platform/outbox/relay'
import { printDispatchHandler } from './platform/print/handler'
import { rolesSyncCron, syncAllTenants } from './platform/auth/roles/sync'
// B-W2a-18: a new tenant's empty reason lists get the standard reasons.
import { standardReasonsCron, standardReasonsForNewTenants } from './platform/reasons/standard'
// B-W2a-32: the search index, one indexer per record type in platform/search/indexers/ (found by folder).
import { indexNewTenants, searchHandlers } from './platform/search/indexing'
import { loadIndexers } from './platform/search/registry'

/**
 * The factory's background processes (plan A1 §3.1), one codebase with the API, two Railway services:
 *
 *   node dist/background.js worker      the outbox relay (relay.ts), the events dispatcher and the handler runner
 *                                       (dispatch.ts), after syncing every active tenant's system roles with their
 *                                       templates (platform/auth/roles/sync.ts); npm run dev:worker -w @nexus/factory-api
 *   node dist/background.js scheduler   the clustered crons (core/cron.ts): each tick runs on one replica only;
 *                                       npm run dev:scheduler -w @nexus/factory-api
 *
 * Commerce hard rule 2, for the factory: a local worker or scheduler starts every consumer and every cron, so before
 * anything connects it refuses
 *   - a wrong environment (env.ts: local and test only on loopback, staging and production only on Railway);
 *   - with FACTORY_ENV local or test, a database that is not this worktree's own (factory_<branch>, factory_<step>) or a
 *     throwaway factory_test…: never a shared one;
 *   - with FACTORY_ENV local or test, a missing FACTORY_QUEUE_PREFIX (env.ts): the local Redis is shared by every
 *     worktree.
 * Then the database login is audited (openFactoryDatabase) and, with FACTORY_ENV=production, no integration account may be
 * in FAKE mode, as at the API's boot.
 */

const MODES = ['worker', 'scheduler'] as const
type Mode = (typeof MODES)[number]

/** The handlers of published events, one list for the worker. Modules add theirs here (dispatch.ts defineHandler). */
const HANDLERS: readonly EventHandler[] = [inboundHandler(), ...importHandlers(), printDispatchHandler(), emailSendHandler(), ...emailInHandlers(), floorMoveValuationHandler(), startOnIssueHandler(), invoiceFilesHandler(), sdiPollHandler(), sdiArchiveHandler(), sdiCourtesyCopyHandler(), trackingPollHandler(), afterAcceptanceHandler(), shipDocumentsHandler(), ...orderHandlers(), tellBuyerHandler(), ...costingHandlers(), ...exportHandlers()]
// B-W2a-20: the notification centre's fan-out (mentions, followed records, assignments, approvals).
const W2A_20_HANDLERS: readonly EventHandler[] = [notificationsHandler()]
// B-W2a-32: the search index follows the record events its indexers name (platform/search/indexing.ts).
const SEARCH_INDEXERS = await loadIndexers(fileURLToPath(new URL('.', import.meta.url)))
const W2A_32_HANDLERS: readonly EventHandler[] = searchHandlers(SEARCH_INDEXERS)

const mode = process.argv[2] as Mode
if (!MODES.includes(mode)) {
  console.error(`usage: background.js <${MODES.join('|')}> (got ${JSON.stringify(process.argv[2] ?? '')})`)
  process.exit(2)
}

/** JSON lines on standard output, every field redacted like the API's log (core/logger.ts). */
function lineLog(name: Mode): Log {
  const write =
    (level: 'info' | 'warn' | 'error') =>
    (fields: Record<string, unknown>, message: string): void => {
      const line = { level, time: new Date().toISOString(), process: name, msg: message, ...(redact(fields) as Record<string, unknown>) }
      process.stdout.write(`${JSON.stringify(line)}\n`)
    }
  return { info: write('info'), warn: write('warn'), error: write('error') }
}
const log = lineLog(mode)

function refuse(reason: string): never {
  console.error(`factory-${mode}: refused to start: ${reason}`)
  process.exit(1)
}

let env: ReturnType<typeof loadFactoryEnv>
try {
  env = loadFactoryEnv()
} catch (error) {
  refuse((error as Error).message)
}
const prefix = env.FACTORY_QUEUE_PREFIX
if (env.FACTORY_ENV === 'local' || env.FACTORY_ENV === 'test') {
  const own = checkTestDatabaseUrl(env.FACTORY_DATABASE_URL, worktreeDatabaseNames(readWorktree(fileURLToPath(new URL('.', import.meta.url)))))
  if (!own.ok) refuse(`${own.reason}; a local ${mode} runs only against this worktree's own database`)
}

let database: FactoryDatabase
try {
  database = await openFactoryDatabase({ connectionString: env.FACTORY_DATABASE_URL, pool: { max: 8 } })
} catch (error) {
  refuse(`the database refused the boot: ${(error as Error).message}`)
}
// Plan A1 §4: production never starts while an integration account is FAKE (platform/gateway/boot.ts).
try {
  await assertNoFakeAccountsInProduction(database, env.FACTORY_ENV)
} catch (error) {
  refuse((error as Error).message)
}
const redis = queueConnection(env.FACTORY_REDIS_URL)
redis.on('error', (error) => log.warn({ err: error }, 'redis is unreachable'))
const kit = openQueues({ connection: redis, prefix })

const stops: Array<() => Promise<void>> = []
if (mode === 'worker') {
  // A deploy that changed a role template starts a new worker: the system roles follow it (audited per tenant).
  await syncAllTenants({ database, log }).catch((error) => log.error({ err: error }, 'the system roles could not be synced at start'))
  await standardReasonsForNewTenants({ database, log }).catch((error) => log.error({ err: error }, 'the standard reasons could not be given at start'))
  await indexNewTenants({ database, indexers: SEARCH_INDEXERS, log }).catch((error) => log.error({ err: error }, 'the search index could not be built at start'))
  const relay = startRelay({ database, publish: queuePublisher(kit), log })
  const workers = startEventWorkers({ kit, handlers: [...HANDLERS, ...W2A_20_HANDLERS, ...W2A_32_HANDLERS], database, live: redis, log })
  stops.push(() => relay.stop(), () => workers.close())
} else {
  const crons: CronJob[] = [outboxLagCron({ database, kit, log }), rolesSyncCron({ database, log }), certificateExpiryCron({ database, log }), sdiPollCron({ database, log }), trackingPollCron({ database, log }), nightlyPlanCron({ database, log }), exportExpiryCron({ database, log })]
  crons.push(standardReasonsCron({ database, log }))
  // B-W2a-20: the daily digests people turned on.
  crons.push(digestCron({ database, log }))
  const scheduler = startCrons(crons, { redis, prefix, log })
  stops.push(() => scheduler.stop())
}
log.info({ prefix, environment: env.FACTORY_ENV }, `factory-${mode} started`)

let closing = false
async function shutdown(signal: string): Promise<void> {
  if (closing) return
  closing = true
  log.info({ signal }, `factory-${mode} shutting down`)
  for (const stop of stops) await stop().catch((error) => log.error({ err: error }, 'a part did not stop cleanly'))
  await kit.close()
  redis.disconnect()
  await database.close()
  process.exit(0)
}
process.once('SIGTERM', () => void shutdown('SIGTERM'))
process.once('SIGINT', () => void shutdown('SIGINT'))
