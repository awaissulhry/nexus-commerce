import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from 'fastify'
import type { FactoryClient, FactoryDatabase } from '@nexus/factory-db'
import { pinKeyring, type PinKeyring } from '@nexus/factory-domain/auth/floor/pin'
import type { Grant } from '@nexus/factory-domain/core/permissions'
import { callerFor, COMMAND_SETTINGS, runCommand, type CommandOutcome, type CommandSpec, type CommandTools } from '../../../core/command'
import type { Authenticator, OfficeContext } from '../../../core/context'
import { ApiError } from '../../../core/errors'
import { serverClock, type Clock } from '../../../core/time'
import type { FactoryEnv } from '../../../env'
import { floorAuthenticator, sessionAuthenticator } from '../floor/authenticator'
import { linkAuthenticator, withLinkSessions } from '../../links/authenticator'
import { officeAuthenticator } from './authenticator'
import { emailAuthMailer } from '../../email-out/auth-mail'
import type { AuthMailer, AuthMessage } from './mail'
import { authSecrets, type AuthSecrets } from './secrets'

/**
 * Office sign-in as one object (plan A1 §3.10): the real `Authenticator` for office cookies (and one-off link tokens,
 * platform/links; and, for a request that carries a floor session cookie, the floor's: platform/auth/floor), and what
 * the auth and link routes (platform/auth/{office,sessions,invitations,users,roles,floor}, platform/links) share.
 * `src/index.ts` makes it and hands it to `buildApp`
 * (`officeAuth`), which uses its authenticator and decorates the app with it; a route reads it with `officeAuthOf`.
 *
 * Before a session exists (sign-in, an invitation or reset link) the tenant comes from the request: the sign-in names
 * the tenant's slug (read in the platform scope, the only use of factory_platform here), a link or cookie carries the
 * tenant's id. Everything else runs in that tenant's office scope (factory_runtime), and every write goes through
 * command(), on this object's clock, with its audit rows.
 */

export interface AuthRateLimit {
  readonly max: number
  readonly timeWindowMs: number
}

/** Per client address, on top of the app's global limit (A1 §3.10: rate limits on every public route). */
export interface AuthRateLimits {
  /** Sign-in: guessing across accounts from one address. */
  readonly signIn: AuthRateLimit
  /** Asking for a reset link (each one may mean an email). */
  readonly resetRequest: AuthRateLimit
  /** Using a link: accept an invitation, set a new password, preview. */
  readonly tokenUse: AuthRateLimit
  /** Step-up and two-factor codes of a signed-in session. */
  readonly codes: AuthRateLimit
  /** Opening and answering a one-off link (platform/links): a token tried from one address. */
  readonly linkUse: AuthRateLimit
  /** Floor sign-in, switch and PIN change: per enrolled device (a plant's tablets may share one address). */
  readonly floorSignIn: AuthRateLimit
}

export const AUTH_RATE_LIMITS: AuthRateLimits = Object.freeze({
  signIn: { max: 10, timeWindowMs: 60_000 },
  resetRequest: { max: 5, timeWindowMs: 15 * 60_000 },
  tokenUse: { max: 20, timeWindowMs: 15 * 60_000 },
  codes: { max: 10, timeWindowMs: 5 * 60_000 },
  linkUse: { max: 30, timeWindowMs: 60_000 },
  floorSignIn: { max: 30, timeWindowMs: 60_000 },
})

/** The actor of reads made before the person is known (a sign-in looking up the email). It never writes. */
export const PRE_SESSION_ACTOR_ID = '00000000-0000-7000-8000-000000000001'

export interface OfficeAuthOptions {
  readonly database: FactoryDatabase
  readonly environment: FactoryEnv['FACTORY_ENV']
  /** FACTORY_COOKIE_SECRET: the keys of auth/sessions/secrets.ts derive from it. */
  readonly cookieSecret: string
  /** FACTORY_PIN_PEPPER (and FACTORY_PIN_PEPPER_PREVIOUS during a rotation): the floor PIN hashes' pepper. */
  readonly pinPepper: string
  readonly pinPepperPrevious?: string | undefined
  /** FACTORY_WEB_ORIGIN: invitation and reset links point at the web. */
  readonly webOrigin: string
  readonly clock?: Clock
  /** Default email out's (`emailAuthMailer`: SES through the gateway, on this object's database and clock). */
  readonly mailer?: AuthMailer
  readonly rateLimits?: Partial<AuthRateLimits>
}

export interface OfficeAuth {
  readonly database: FactoryDatabase
  readonly clock: Clock
  readonly secrets: AuthSecrets
  /** The floor PIN peppers (factory-domain auth/floor/pin): the current one hashes, previous ones still verify. */
  readonly pins: PinKeyring
  readonly rateLimits: AuthRateLimits
  /**
   * Reads the session of a request (core/context.ts Authenticator): a one-off link's token in the `x-factory-link`
   * header (platform/links/authenticator.ts), else the floor session cookie's (floor/authenticator.ts: no office
   * fallback), else the office session cookie.
   */
  readonly authenticate: Authenticator
  /** Reads inside a tenant before a session exists, as `actorId` (a link's user, or PRE_SESSION_ACTOR_ID). */
  inTenant<T>(tenantId: string, actorId: string, work: (client: FactoryClient) => Promise<T>): Promise<T>
  /** Reads the platform tables (the tenant of a slug). */
  inPlatform<T>(work: (client: FactoryClient) => Promise<T>): Promise<T>
  /** command() on this object's clock, for an office context. */
  command<Result, State extends string = string, Facts = undefined>(
    context: OfficeContext,
    spec: CommandSpec<State, Facts>,
    work: (tools: CommandTools) => Promise<Result>,
  ): Promise<CommandOutcome<Result>>
  /** The office context of a person before their session exists (a sign-in, an accepted link): no grants. */
  contextFor(request: FastifyRequest, tenantId: string, userId: string, grants?: readonly Grant[]): OfficeContext
  /** A web link with a token in its fragment (never sent to a server, never in an access log). */
  link(path: string, token: string): string
  /** Hands a message to the mailer after its command committed; a failure is logged, never answered. */
  deliver(message: AuthMessage, log: FastifyBaseLogger): Promise<void>
  /** Work that must not delay the answer (so its time says nothing); a failure is logged. */
  afterAnswer(work: () => Promise<void>, log: FastifyBaseLogger): void
  /** Resolves when all `afterAnswer` work has ended (tests). */
  settled(): Promise<void>
}

export function createOfficeAuth(options: OfficeAuthOptions): OfficeAuth {
  const clock = options.clock ?? serverClock
  const mailer = options.mailer ?? emailAuthMailer({ database: options.database, clock })
  const secrets = authSecrets(options.cookieSecret)
  const settings = { ...COMMAND_SETTINGS, clock }
  const pending = new Set<Promise<void>>()
  const origin = options.webOrigin.replace(/\/+$/, '')

  return {
    database: options.database,
    clock,
    secrets,
    pins: pinKeyring(options.pinPepper, options.pinPepperPrevious ? [options.pinPepperPrevious] : []),
    rateLimits: { ...AUTH_RATE_LIMITS, ...options.rateLimits },
    authenticate: withLinkSessions(
      linkAuthenticator({ database: options.database, clock }),
      sessionAuthenticator(officeAuthenticator({ database: options.database, clock }), floorAuthenticator({ database: options.database, clock })),
    ),
    inTenant: (tenantId, actorId, work) => options.database.withScope({ audience: 'office', tenantId, actorId }, work),
    inPlatform: (work) => options.database.withScope({ audience: 'platform' }, work),
    command: (context, spec, work) => runCommand(callerFor(options.database, context), spec, work, settings),
    contextFor: (request, tenantId, userId, grants = []) => ({ audience: 'office', tenantId, actorId: userId, grants, requestId: String(request.id) }),
    link: (path, token) => `${origin}${path}#token=${encodeURIComponent(token)}`,
    async deliver(message, log) {
      try {
        await mailer.deliver(message)
      } catch (error) {
        log.error({ err: error, kind: message.kind }, 'an office sign-in message could not be handed to the mailer')
      }
    },
    afterAnswer(work, log) {
      const task: Promise<void> = work()
        .catch((error: unknown) => log.error({ err: error }, 'office sign-in background work failed'))
        .finally(() => pending.delete(task))
      pending.add(task)
    },
    async settled() {
      while (pending.size > 0) await Promise.allSettled([...pending])
    },
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Office sign-in (platform/auth/sessions/office-auth.ts), or null when the app was built without it. */
    officeAuth: OfficeAuth | null
  }
}

/** The app's office sign-in; a 503 when the app was built without it (a test of another part). */
export function officeAuthOf(instance: FastifyInstance): OfficeAuth {
  const auth = instance.officeAuth
  if (!auth) throw new ApiError('not_ready', 'Office sign-in is not configured in this process.')
  return auth
}
