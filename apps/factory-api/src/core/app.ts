import { pathToFileURL } from 'node:url'
import Fastify, { type FastifyInstance, type FastifyPluginAsync } from 'fastify'
import cookie from '@fastify/cookie'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import type { Redis } from 'ioredis'
import type { FactoryDatabase } from '@nexus/factory-db'
import { FACTORY_PERMISSIONS } from '@nexus/factory-domain/auth/permissions/catalogue'
import { healthContract, readyContract } from '@nexus/factory-domain/core/contracts'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { FactoryEnv } from '../env'
import type { OfficeAuth } from '../platform/auth/sessions/office-auth'
import { routesFiles } from './autoload'
import { isTestAuthenticator, noSessions, withContextClient, type Authenticator } from './context'
import { installErrorHandling } from './errors'
import { requestIdFor } from './ids'
import { loggerOptions, type LoggerSettings } from './logger'
import { installGrainFilter } from '../platform/auth/roles/grain-filter'
import { CORE_MANIFEST, defineRoutes, installRouteManifest, isRoutesPlugin, manifestOfRoutes, RouteManifestError, undeclaredPermissions } from './manifest'
import { BODY_LIMIT_BYTES, registerSecurity } from './security'
import { serverClock, type Clock } from './time'

/**
 * The factory API application (plan A1 §3.1, §3.2). `buildApp` returns a ready instance: the error mapping, the
 * redacting logger, request ids, the security baseline, the zod contracts, the route manifest with its access check,
 * the money-grain filter of answers and requests (platform/auth/roles/grain-filter.ts), the core routes `/health`
 * (the process is up) and `/ready` (the database and Redis answer), and the routes of `platform/*` and `modules/*`
 * (core/autoload.ts).
 * It rejects, so the process does not start, when a route has no manifest entry, an entry has no route, or a routes
 * file names a permission the registry does not declare (test routes passed in `routes` are not checked).
 *
 * Writes go through `command()` (core/command.ts); a route reaches the database only through `request.withClient`,
 * which needs a session context (core/context.ts).
 */

export interface AppConfig {
  readonly environment: FactoryEnv['FACTORY_ENV']
  /** The only origin allowed to call cross-origin (the factory web). */
  readonly webOrigin?: string | undefined
  /** Proxy hops in front of the API whose X-Forwarded-For is trusted (the client address for rate limits). */
  readonly trustProxyHops: number
  /** Signs cookies (@fastify/cookie). */
  readonly cookieSecret: string
  readonly rateLimit?: { readonly max: number; readonly timeWindowMs: number }
  /** FACTORY_QUEUE_PREFIX: the rate-limit counters sit under it (rateLimitNamespace). Default `factory`. */
  readonly queuePrefix?: string
}

/** The app settings from the loaded env. */
export function appConfig(env: FactoryEnv): AppConfig {
  return {
    environment: env.FACTORY_ENV,
    webOrigin: env.FACTORY_WEB_ORIGIN,
    trustProxyHops: env.FACTORY_TRUST_PROXY_HOPS,
    cookieSecret: env.FACTORY_COOKIE_SECRET,
    queuePrefix: env.FACTORY_QUEUE_PREFIX,
  }
}

/**
 * The Redis key prefix of the rate-limit counters: the queue prefix, then the environment. Every worktree's API on the
 * one local Redis has its own FACTORY_QUEUE_PREFIX, so parallel APIs on this machine never share a client's count (they
 * all met `factory:local:rate-limit:127.0.0.1` before). On Railway the prefix is `factory` (env.ts), so the key there
 * stays `factory:<environment>:rate-limit:`.
 */
export function rateLimitNamespace(config: Pick<AppConfig, 'environment' | 'queuePrefix'>): string {
  return `${config.queuePrefix ?? 'factory'}:${config.environment}:rate-limit:`
}

export interface AppDependencies {
  /** The scoped database (`openFactoryDatabase`). Without it, `/ready` reports the database as not configured. */
  readonly database?: FactoryDatabase | undefined
  /** Redis (ioredis). Without it, `/ready` reports Redis as not configured and rate limits count in memory. */
  readonly redis?: Redis | undefined
  /**
   * Office sign-in (platform/auth/sessions/office-auth.ts): its authenticator reads the office session cookie, and the
   * auth routes use it. Without it those routes answer 503.
   */
  readonly officeAuth?: OfficeAuth
  /** Reads the session of a request. Default: the office sign-in's authenticator, else no sessions (401). */
  readonly authenticate?: Authenticator
  /** The folder that holds `platform/` and `modules/`: `src/` under tsx and vitest, `dist/` in a build. */
  readonly routesRoot?: string
  /** More route plugins, each made with defineRoutes (tests). */
  readonly routes?: readonly FastifyPluginAsync[]
  /** Log settings; false (the default) logs nothing. */
  readonly logger?: LoggerSettings | false
  readonly clock?: Clock
  /** Longest wait for one readiness check. Default 2 s. */
  readonly readyTimeoutMs?: number
}

const DEFAULT_RATE_LIMIT = { max: 300, timeWindowMs: 60_000 }

type CheckState = 'ok' | 'failed' | 'not_configured'

async function probe(
  app: FastifyInstance,
  name: string,
  check: (() => Promise<unknown>) | undefined,
  timeoutMs: number,
): Promise<CheckState> {
  if (!check) return 'not_configured'
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      check(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer within ${timeoutMs} ms`)), timeoutMs)
      }),
    ])
    return 'ok'
  } catch (error) {
    app.log.warn({ err: error, check: name }, 'readiness check failed')
    return 'failed'
  } finally {
    clearTimeout(timer)
  }
}

/** Imports and registers every routes file under the root (core/autoload.ts finds them). */
async function registerRoutesFiles(app: FastifyInstance, root: string): Promise<void> {
  for (const file of routesFiles(root)) {
    // The import runs in our own code, so vitest, tsx and the bundle load it the same way (one module instance each).
    const loaded = (await import(pathToFileURL(file).href)) as { default?: unknown }
    if (!isRoutesPlugin(loaded.default)) {
      throw new RouteManifestError(`${file} must default-export defineRoutes(name, manifest, plugin)`)
    }
    const undeclared = undeclaredPermissions(manifestOfRoutes(loaded.default), FACTORY_PERMISSIONS.isDeclared)
    if (undeclared.length > 0) {
      throw new RouteManifestError(
        `${file} names permissions that are not declared (factory-domain auth/permissions/catalogue): ${undeclared.join(', ')}`,
      )
    }
    await app.register(loaded.default)
  }
}

export async function buildApp(config: AppConfig, dependencies: AppDependencies = {}): Promise<FastifyInstance> {
  const authenticate = dependencies.authenticate ?? dependencies.officeAuth?.authenticate ?? noSessions
  if (isTestAuthenticator(authenticate) && config.environment !== 'test') {
    throw new Error(`A test authenticator is refused with FACTORY_ENV=${config.environment}; it works only in tests.`)
  }
  const { database, redis } = dependencies
  const clock = dependencies.clock ?? serverClock
  const readyTimeoutMs = dependencies.readyTimeoutMs ?? 2_000

  const app = Fastify({
    logger: dependencies.logger ? loggerOptions(dependencies.logger) : false,
    genReqId: requestIdFor,
    requestIdHeader: false,
    requestIdLogLabel: 'requestId',
    bodyLimit: BODY_LIMIT_BYTES,
    trustProxy: config.trustProxyHops > 0 ? config.trustProxyHops : false,
    // A HEAD route would be a second route per GET; the manifest lists each method once.
    exposeHeadRoutes: false,
    return503OnClosing: true,
  })
  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)

  installErrorHandling(app)
  await registerSecurity(app, {
    webOrigin: config.webOrigin,
    rateLimit: {
      ...(config.rateLimit ?? DEFAULT_RATE_LIMIT),
      redis,
      namespace: rateLimitNamespace(config),
    },
  })
  await app.register(cookie, { secret: config.cookieSecret })
  installRouteManifest(app, authenticate)
  installGrainFilter(app)
  app.decorate('officeAuth', dependencies.officeAuth ?? null)
  app.decorateRequest('withClient', function withClient(work) {
    return withContextClient(database, this.factoryContext, work)
  })

  await app.register(
    defineRoutes('core', CORE_MANIFEST, async (core) => {
      core.get('/health', { schema: healthContract }, async () => ({ status: 'ok' as const, time: toUtcIso(clock.now()) }))

      core.get('/ready', { schema: readyContract }, async (_request, reply) => {
        const [databaseState, redisState] = await Promise.all([
          probe(
            core,
            'database',
            database && (() => database.withScope({ audience: 'platform' }, (client) => client.$queryRaw`SELECT 1`)),
            readyTimeoutMs,
          ),
          probe(core, 'redis', redis && (() => redis.ping()), readyTimeoutMs),
        ])
        const ready = databaseState === 'ok' && redisState === 'ok'
        return reply.code(ready ? 200 : 503).send({
          status: ready ? 'ready' : 'not_ready',
          checks: { database: databaseState, redis: redisState },
        })
      })
    }),
  )

  if (dependencies.routesRoot) await registerRoutesFiles(app, dependencies.routesRoot)
  for (const routes of dependencies.routes ?? []) await app.register(routes)

  await app.ready()
  return app
}
