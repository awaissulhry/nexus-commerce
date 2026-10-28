import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest, RouteOptions } from 'fastify'
import type { FastifyPluginAsyncZod, ZodTypeProvider } from 'fastify-type-provider-zod'
import { ForbiddenError, UnauthenticatedError } from '@nexus/factory-domain/core/errors'
import { decide, holds, isAudience, isPermission, type Audience, type Permission } from '@nexus/factory-domain/core/permissions'
import { ApiError } from './errors'
import { actorOf, completeContext, type Authenticator, type RequestContext } from './context'

/**
 * The route manifest (plan A1 §3.2 step 2, §6.2; PLAN §4.6; features PLT-029, PLT-037). Every route declares who may
 * call it (audiences), what it needs (one permission) and what its data is scoped by. A route without an entry, an
 * entry without a route, or a malformed entry stops the boot. `scripts/factory/check-route-manifest.mjs` checks the
 * same statically.
 *
 * A module declares its routes in `src/modules/<module>/routes.ts` and its entries in `manifest.ts` beside it:
 *
 *   // manifest.ts
 *   export const manifest = defineManifest({
 *     'GET /quotes/:quoteId': { audiences: ['office'], permission: 'quotes.view', scope: 'record' },
 *   })
 *   // routes.ts
 *   export default defineRoutes('quotes', manifest, async (app) => { app.get('/quotes/:quoteId', { schema }, handler) })
 *
 * Paths are written in full (no prefixes), so the key is exactly what Fastify registers.
 *
 * Before the body is read, each request passes, in order: the session (the authenticator; none → 401), the audience
 * (not listed → 403), the permission (not held in any grant → 403) and the scope:
 *   none     no tenant: public routes and platform routes
 *   tenant   tenant-wide: the permission held in any grant
 *   company  the context's company (office); a grant must reach it
 *   site     the context's site (the floor device's, or the office screen's); a grant must reach it
 *   party    the session's party (partner, link)
 *   record   the handler checks each record with can() and filters lists with scopeWhere()
 */

/** No session needed (health, sign-in, webhooks verified by signature). */
export const PUBLIC = 'public' as const
/** Any session of the listed audiences; no permission (for example "my profile"). */
export const SIGNED_IN = 'signed-in' as const

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const
export type HttpMethod = (typeof HTTP_METHODS)[number]

export const ROUTE_SCOPES = ['none', 'tenant', 'company', 'site', 'party', 'record'] as const
export type RouteScope = (typeof ROUTE_SCOPES)[number]

/** The audiences a route can serve; `system` is the worker and scheduler, never an HTTP caller. */
export type RouteAudience = Exclude<Audience, 'system'>

export interface RouteManifestEntry {
  readonly audiences: typeof PUBLIC | readonly RouteAudience[]
  readonly permission: typeof PUBLIC | typeof SIGNED_IN | Permission
  readonly scope: RouteScope
}

export type RouteKey = `${HttpMethod} /${string}`
export type RouteManifest = Readonly<Record<RouteKey, RouteManifestEntry>>

export class RouteManifestError extends Error {
  override name = 'RouteManifestError'
}

const KEY = /^(GET|POST|PUT|PATCH|DELETE) (\/\S*)$/
const SCOPE_AUDIENCES: Readonly<Record<RouteScope, readonly RouteAudience[]>> = {
  none: ['platform'],
  tenant: ['office', 'floor', 'partner', 'link'],
  company: ['office'],
  site: ['office', 'floor'],
  party: ['partner', 'link'],
  record: ['office', 'floor', 'partner', 'link'],
}

/** What is wrong with one entry (empty when nothing is). */
export function entryProblems(key: string, entry: RouteManifestEntry | undefined): string[] {
  if (!KEY.test(key)) return [`"${key}" is not "<GET|POST|PUT|PATCH|DELETE> /path"`]
  if (entry === null || typeof entry !== 'object') return [`${key}: the entry is missing`]
  const problems: string[] = []
  const { audiences, permission, scope } = entry
  if (!(ROUTE_SCOPES as readonly string[]).includes(scope)) problems.push(`${key}: unknown scope "${String(scope)}"`)
  if (audiences === PUBLIC || permission === PUBLIC) {
    if (audiences !== PUBLIC || permission !== PUBLIC || scope !== 'none') {
      problems.push(`${key}: a public route has audiences "public", permission "public" and scope "none"`)
    }
    return problems
  }
  if (!Array.isArray(audiences) || audiences.length === 0) {
    problems.push(`${key}: audiences must list at least one of office, floor, partner, link, platform`)
    return problems
  }
  for (const audience of audiences) {
    if (!isAudience(audience) || audience === 'system') problems.push(`${key}: "${String(audience)}" is not a route audience`)
    else if (SCOPE_AUDIENCES[scope] && !SCOPE_AUDIENCES[scope].includes(audience)) {
      problems.push(`${key}: scope "${scope}" does not apply to the ${audience} audience`)
    }
  }
  if (new Set(audiences).size !== audiences.length) problems.push(`${key}: an audience is listed twice`)
  if (permission !== SIGNED_IN && !isPermission(permission)) {
    problems.push(`${key}: permission "${String(permission)}" is not <module>.<action> (or "signed-in")`)
  }
  return problems
}

/** Declares a module's entries; a malformed entry throws at once (at import, so at boot). */
export function defineManifest<const Manifest extends RouteManifest>(manifest: Manifest): Manifest {
  const problems = Object.entries(manifest).flatMap(([key, entry]) => entryProblems(key, entry as RouteManifestEntry))
  if (problems.length > 0) throw new RouteManifestError(`Route manifest is not valid: ${problems.join('; ')}`)
  return Object.freeze(manifest)
}

/** The core routes (`core/app.ts`). */
export const CORE_MANIFEST = defineManifest({
  'GET /health': { audiences: PUBLIC, permission: PUBLIC, scope: 'none' },
  'GET /ready': { audiences: PUBLIC, permission: PUBLIC, scope: 'none' },
})

/** Every entry the app's modules declared, and which of them a route claimed. */
export class ManifestRegistry {
  readonly #entries = new Map<string, { readonly entry: RouteManifestEntry; readonly source: string }>()
  readonly #claimed = new Set<string>()

  add(source: string, manifest: RouteManifest): void {
    const problems = Object.entries(manifest).flatMap(([key, entry]) => entryProblems(key, entry as RouteManifestEntry))
    if (problems.length > 0) throw new RouteManifestError(`Route manifest of ${source} is not valid: ${problems.join('; ')}`)
    for (const [key, entry] of Object.entries(manifest)) {
      const existing = this.#entries.get(key)
      if (existing) throw new RouteManifestError(`${key} is declared twice (${existing.source} and ${source})`)
      this.#entries.set(key, { entry: entry as RouteManifestEntry, source })
    }
  }

  /** The entry of a route being registered; throws when there is none (the boot stops). */
  claim(method: string, url: string): RouteManifestEntry {
    const key = `${method} ${url}`
    const found = this.#entries.get(key)
    if (!found) {
      throw new RouteManifestError(`Route ${key} has no manifest entry (audiences, permission, scope); the API does not start without one`)
    }
    if (this.#claimed.has(key)) throw new RouteManifestError(`Route ${key} is registered twice`)
    this.#claimed.add(key)
    return found.entry
  }

  /** Entries no route claimed. */
  unclaimed(): string[] {
    return [...this.#entries.keys()].filter((key) => !this.#claimed.has(key)).sort()
  }

  /** Every claimed route and its entry (for tests and the coverage listing). */
  routes(): Array<[string, RouteManifestEntry]> {
    return [...this.#entries].filter(([key]) => this.#claimed.has(key)).map(([key, { entry }]) => [key, entry])
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    factoryRouteManifest: ManifestRegistry
  }
  interface FastifyContextConfig {
    manifest?: RouteManifestEntry
  }
}

const ROUTES_PLUGIN = Symbol('factory.routesPlugin')
const ROUTES_MANIFEST = Symbol('factory.routesManifest')

/**
 * A module's routes with their manifest. The entries join the app's registry before the routes register, so each
 * route finds its entry; a route the manifest does not list stops the boot.
 */
export function defineRoutes(name: string, manifest: RouteManifest, routes: FastifyPluginAsyncZod): FastifyPluginAsync {
  const plugin: FastifyPluginAsync = async (instance, options) => {
    if (!instance.hasDecorator('factoryRouteManifest')) {
      throw new RouteManifestError(`${name}: routes registered outside buildApp (the route manifest is not installed)`)
    }
    instance.factoryRouteManifest.add(name, manifest)
    await routes(instance.withTypeProvider<ZodTypeProvider>(), options)
  }
  Object.defineProperty(plugin, 'name', { value: `routes:${name}` })
  Object.defineProperty(plugin, ROUTES_PLUGIN, { value: name })
  Object.defineProperty(plugin, ROUTES_MANIFEST, { value: manifest })
  return plugin
}

/** The manifest a defineRoutes plugin declares (the boot checks its permissions against the registry). */
export function manifestOfRoutes(plugin: FastifyPluginAsync): RouteManifest {
  return (plugin as unknown as Record<symbol, RouteManifest>)[ROUTES_MANIFEST] ?? {}
}

/**
 * The permissions of a manifest that the registry does not declare (plan A1 §3.11, feature PLT-029: every permission
 * is declared once, in factory-domain auth/permissions). The app refuses to boot a routes file that names one.
 */
export function undeclaredPermissions(manifest: RouteManifest, isDeclared: (permission: string) => boolean): string[] {
  const named = Object.values(manifest)
    .map((entry) => entry.permission)
    .filter((permission) => permission !== PUBLIC && permission !== SIGNED_IN)
  return [...new Set(named.filter((permission) => !isDeclared(permission)))].sort()
}

/** True for a plugin made by defineRoutes. */
export function isRoutesPlugin(value: unknown): value is FastifyPluginAsync {
  return typeof value === 'function' && typeof (value as unknown as Record<symbol, unknown>)[ROUTES_PLUGIN] === 'string'
}

function methodsOf(route: RouteOptions): string[] {
  return (Array.isArray(route.method) ? route.method : [route.method]).map((method) => String(method).toUpperCase())
}

/** The company, site or party a route with that scope works inside, taken from the context; null for other scopes. */
function scopedRecord(scope: RouteScope, context: RequestContext): Record<string, string | undefined> | null {
  switch (scope) {
    case 'company':
      return { companyId: context.audience === 'office' ? context.companyId : undefined }
    case 'site':
      return { siteId: context.audience === 'office' || context.audience === 'floor' ? context.siteId : undefined }
    case 'party':
      return { partyId: context.audience === 'partner' || context.audience === 'link' ? context.partyId : undefined }
    default:
      return null
  }
}

/** The access check of one request against its route's entry. Throws the error to answer with. */
export async function checkAccess(request: FastifyRequest, authenticate: Authenticator): Promise<void> {
  const entry = request.routeOptions.config.manifest
  if (!entry) {
    if (request.is404) return
    throw new ApiError('internal_error', 'The route has no manifest entry.')
  }
  if (entry.audiences === PUBLIC) return

  const session = await authenticate(request)
  if (!session) throw new UnauthenticatedError()
  const context = completeContext(session, String(request.id))
  if (!(entry.audiences as readonly string[]).includes(context.audience)) throw new ForbiddenError()
  request.factoryContext = context

  const record = scopedRecord(entry.scope, context)
  if (record && !Object.values(record)[0]) {
    throw new ForbiddenError(`This route works inside one ${entry.scope}; the request names none.`)
  }
  if (entry.permission === SIGNED_IN) return
  const actor = actorOf(context)
  const permission = entry.permission as Permission
  if (!holds(actor, permission)) throw new ForbiddenError()
  if (record && !decide(actor, permission, record).allowed) throw new ForbiddenError()
}

/**
 * Installs the manifest on the root instance: the registry, the boot checks (every route has an entry, every entry
 * has a route) and the access check, which runs before the body is read (after the rate limit).
 */
export function installRouteManifest(app: FastifyInstance, authenticate: Authenticator): ManifestRegistry {
  const registry = new ManifestRegistry()
  app.decorate('factoryRouteManifest', registry)
  app.decorateRequest('factoryContext', null)
  app.addHook('onRoute', (route) => {
    const entries = methodsOf(route).map((method) => registry.claim(method, route.url ?? ''))
    const [entry] = entries
    if (entries.some((other) => other !== entry)) {
      throw new RouteManifestError(`Route ${route.url} registers several methods with different entries; register one per method`)
    }
    route.config = { ...route.config, manifest: entry }
  })
  app.addHook('onReady', async () => {
    const orphans = registry.unclaimed()
    if (orphans.length > 0) {
      throw new RouteManifestError(`Manifest entries without a route: ${orphans.join(', ')}`)
    }
  })
  app.addHook('preParsing', async (request: FastifyRequest, _reply: FastifyReply, payload) => {
    await checkAccess(request, authenticate)
    return payload
  })
  return registry
}
