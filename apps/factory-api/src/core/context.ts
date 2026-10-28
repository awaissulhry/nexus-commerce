import type { FastifyRequest } from 'fastify'
import type { FactoryClient, FactoryDatabase, FactoryScope } from '@nexus/factory-db'
import { UnauthenticatedError } from '@nexus/factory-domain/core/errors'
import type { Actor, Audience, Grant } from '@nexus/factory-domain/core/permissions'
import { ApiError } from './errors'

/**
 * The request context (plan A1 §3.2 step 1, §3.10): who calls, for which tenant, and with which grants. The session
 * step (sign-in per audience) builds it from the cookie or device token; this module only defines it, maps it to the
 * factory-db scope, and keeps a request without one away from every tenant client (fail closed).
 *
 *   audience   database scope (factory-db)                     role
 *   office     office   { tenantId, actorId }                   factory_runtime
 *   floor      floor    { tenantId, actorId, siteId }           factory_floor_runtime
 *   partner    partner  { tenantId, actorId, partyId }          factory_partner_runtime
 *   link       partner  { tenantId, actorId: linkId, partyId }  factory_partner_runtime (+ the token's one record)
 *   platform   platform {}                                      factory_platform
 *   system     office   { tenantId, actorId: SYSTEM_ACTOR_ID }  factory_runtime (worker and scheduler; never HTTP)
 */

/** The actor id of the worker and scheduler (a valid UUIDv7 shape; no User row has it). */
export const SYSTEM_ACTOR_ID = '00000000-0000-7000-8000-000000000000'

interface Base {
  /** The grants of the session's role assignments (A1 §3.11). */
  readonly grants: readonly Grant[]
  /** The id of the request (or job) this context belongs to; audit rows carry it. */
  readonly requestId: string
}

export interface OfficeContext extends Base {
  readonly audience: 'office'
  readonly tenantId: string
  /** The signed-in user. */
  readonly actorId: string
  /** The company the screen works in (`/w/<company>`), when the route needs one. */
  readonly companyId?: string
  /** The site the screen works in, when the route needs one. */
  readonly siteId?: string
}

export interface FloorContext extends Base {
  readonly audience: 'floor'
  readonly tenantId: string
  /** The operator signed in on the device. */
  readonly actorId: string
  /** The site the enrolled device belongs to. */
  readonly siteId: string
  readonly deviceId: string
}

export interface PartnerContext extends Base {
  readonly audience: 'partner'
  readonly tenantId: string
  /** The portal user. */
  readonly actorId: string
  readonly partyId: string
}

export interface LinkContext extends Base {
  readonly audience: 'link'
  readonly tenantId: string
  /** The link token's row (never the token itself). */
  readonly linkId: string
  readonly partyId: string
  /** The one record the link opens. */
  readonly record: { readonly type: string; readonly id: string }
}

export interface PlatformContext extends Base {
  readonly audience: 'platform'
  readonly actorId: string
}

export interface SystemContext extends Base {
  readonly audience: 'system'
  readonly tenantId: string
  readonly actorId: typeof SYSTEM_ACTOR_ID
}

export type RequestContext = OfficeContext | FloorContext | PartnerContext | LinkContext | PlatformContext | SystemContext

type WithoutRequestId<T> = T extends unknown ? Omit<T, 'requestId'> : never
/** What an authenticator returns: the context without the request id, which the pipeline adds. */
export type SessionContext = WithoutRequestId<RequestContext>

/**
 * Reads the session of a request: a context, or null for "no session". Throwing an UnauthenticatedError also means
 * no session. The sign-in step provides the real one; until then the app has `noSessions`.
 */
export type Authenticator = (request: FastifyRequest) => SessionContext | null | Promise<SessionContext | null>

/** No request has a session: every route that is not public answers 401. The default until sign-in exists. */
export const noSessions: Authenticator = () => null

const TEST_ONLY = Symbol('factory.testAuthenticator')

/**
 * The test-only way to set the context: wraps a function so the app accepts it only when FACTORY_ENV=test
 * (`buildApp` refuses it otherwise, at boot). Real sessions come from the sign-in step.
 */
export function testAuthenticator(read: Authenticator): Authenticator {
  const wrapped: Authenticator = (request) => read(request)
  Object.defineProperty(wrapped, TEST_ONLY, { value: true })
  return wrapped
}

export function isTestAuthenticator(authenticate: Authenticator): boolean {
  return (authenticate as unknown as Record<symbol, unknown>)[TEST_ONLY] === true
}

const AUDIENCE_FIELDS: Readonly<Record<Audience, readonly string[]>> = {
  office: ['tenantId', 'actorId'],
  floor: ['tenantId', 'actorId', 'siteId', 'deviceId'],
  partner: ['tenantId', 'actorId', 'partyId'],
  link: ['tenantId', 'linkId', 'partyId'],
  platform: ['actorId'],
  system: ['tenantId', 'actorId'],
}

/** Checks the shape an authenticator returned: a known audience with every field it needs. A bad one is a bug: 500. */
export function completeContext(session: SessionContext, requestId: string): RequestContext {
  const fields = AUDIENCE_FIELDS[session?.audience as Audience]
  const values = session as unknown as Record<string, unknown>
  const missing = fields ? fields.filter((field) => typeof values[field] !== 'string' || values[field] === '') : ['audience']
  if (!Array.isArray(session?.grants)) missing.push('grants')
  if (session?.audience === 'link' && (typeof session.record?.type !== 'string' || typeof session.record?.id !== 'string')) {
    missing.push('record')
  }
  if (missing.length > 0) {
    throw new ApiError('internal_error', `The session context is incomplete (${missing.join(', ')}).`)
  }
  return Object.freeze({ ...session, requestId }) as RequestContext
}

/** The factory-db scope of a context: which role the transactions enter, with which settings. */
export function scopeForContext(context: RequestContext): FactoryScope {
  switch (context.audience) {
    case 'office':
      return { audience: 'office', tenantId: context.tenantId, actorId: context.actorId }
    case 'system':
      return { audience: 'office', tenantId: context.tenantId, actorId: SYSTEM_ACTOR_ID }
    case 'floor':
      return { audience: 'floor', tenantId: context.tenantId, actorId: context.actorId, siteId: context.siteId }
    case 'partner':
      return { audience: 'partner', tenantId: context.tenantId, actorId: context.actorId, partyId: context.partyId }
    case 'link':
      return { audience: 'partner', tenantId: context.tenantId, actorId: context.linkId, partyId: context.partyId }
    case 'platform':
      return { audience: 'platform' }
    default:
      throw new ApiError('internal_error', 'Unknown audience in the request context.')
  }
}

/**
 * The actor for can() and scopeWhere(). The floor's site and a partner's party pin the actor; an office site is a
 * screen choice, not a session binding, so it does not.
 */
export function actorOf(context: RequestContext): Actor {
  const tenant = context.audience === 'platform' ? {} : { tenantId: context.tenantId }
  const site = context.audience === 'floor' ? { siteId: context.siteId } : {}
  const party = context.audience === 'partner' || context.audience === 'link' ? { partyId: context.partyId } : {}
  return { audience: context.audience, grants: context.grants, ...tenant, ...site, ...party }
}

/**
 * Runs `work` with the database client of the context's scope. No context → UnauthenticatedError before the database
 * is touched: a request without a session can never reach a tenant client.
 */
export async function withContextClient<T>(
  database: FactoryDatabase | undefined,
  context: RequestContext | null | undefined,
  work: (client: FactoryClient) => Promise<T>,
): Promise<T> {
  if (!context) throw new UnauthenticatedError()
  if (!database) throw new ApiError('internal_error', 'The database is not configured.')
  return database.withScope(scopeForContext(context), work)
}

declare module 'fastify' {
  interface FastifyRequest {
    /** The session context, or null (no session, or a public route). Use `requireContext(request)`. */
    factoryContext: RequestContext | null
    /** The database client of this request's context (see withContextClient). */
    withClient<T>(work: (client: FactoryClient) => Promise<T>): Promise<T>
  }
}

/** The request's context, or an UnauthenticatedError (401). */
export function requireContext(request: FastifyRequest): RequestContext {
  if (!request.factoryContext) throw new UnauthenticatedError()
  return request.factoryContext
}
