import { fileURLToPath } from 'node:url'
import { Redis } from 'ioredis'
import { openFactoryDatabase, type FactoryDatabase } from '@nexus/factory-db'
import { appConfig, buildApp } from './core/app'
import { loadFactoryEnv } from './env'
import { assertNoFakeAccountsInProduction } from './platform/gateway/boot'
import { createOfficeAuth } from './platform/auth/sessions/office-auth'

// The env loader runs first: it refuses a wrong environment before anything opens a connection.
const env = loadFactoryEnv()

// The runtime login, audited at open (factory-db): an unsafe login (superuser, BYPASSRLS, an owner …) stops the boot.
let database: FactoryDatabase
try {
  database = await openFactoryDatabase({ connectionString: env.FACTORY_DATABASE_URL })
} catch (error) {
  console.error(`factory-api: the database refused the boot: ${(error as Error).message}`)
  process.exit(1)
}

// Plan A1 §4: production never starts while an integration account is FAKE (platform/gateway/boot.ts).
try {
  await assertNoFakeAccountsInProduction(database, env.FACTORY_ENV)
} catch (error) {
  console.error(`factory-api: refused to start: ${(error as Error).message}`)
  await database.close().catch(() => {})
  process.exit(1)
}

// Redis reconnects by itself; until it answers, /ready says so and rate limits are not counted.
const redis = new Redis(env.FACTORY_REDIS_URL, {
  lazyConnect: true,
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
  connectTimeout: 2_000,
})
let redisDown = false
redis.on('error', () => {
  redisDown = true
})

// Office sign-in: the authenticator (a one-off link's token in x-factory-link, platform/links, else the office session
// cookie) and the auth and link routes' services. Floor and portal sessions come with their steps; until then those
// requests have no session (401).
const officeAuth = createOfficeAuth({
  database,
  environment: env.FACTORY_ENV,
  cookieSecret: env.FACTORY_COOKIE_SECRET,
  webOrigin: env.FACTORY_WEB_ORIGIN,
})

// A route without a manifest entry (or an entry without a route) stops the boot here.
let app: Awaited<ReturnType<typeof buildApp>>
try {
  app = await buildApp(appConfig(env), {
    database,
    redis,
    officeAuth,
    // src/{platform,modules} under tsx; dist/{platform,modules} next to the bundle (build.mjs).
    routesRoot: fileURLToPath(new URL('.', import.meta.url)),
    logger: { level: env.FACTORY_ENV === 'test' ? 'warn' : 'info' },
  })
} catch (error) {
  console.error(`factory-api: the app refused the boot: ${(error as Error).message}`)
  await database.close().catch(() => {})
  redis.disconnect()
  process.exit(1)
}

redis.removeAllListeners('error')
redis.on('error', (error) => {
  if (!redisDown) app.log.warn({ err: error }, 'redis is unreachable')
  redisDown = true
})
redis.on('ready', () => {
  if (redisDown) app.log.info('redis is reachable again')
  redisDown = false
})
redis.connect().catch(() => {})

let closing = false
async function shutdown(signal: string): Promise<void> {
  if (closing) return
  closing = true
  app.log.info({ signal }, 'shutting down')
  await app.close()
  await database.close()
  redis.disconnect()
  process.exit(0)
}
process.once('SIGTERM', () => void shutdown('SIGTERM'))
process.once('SIGINT', () => void shutdown('SIGINT'))

try {
  await app.listen({ host: env.FACTORY_HOST, port: env.FACTORY_PORT })
} catch (error) {
  app.log.error({ err: error }, 'listen failed')
  await database.close().catch(() => {})
  redis.disconnect()
  process.exit(1)
}
