import { fileURLToPath } from 'node:url'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { hashPassword } from '@nexus/factory-domain/auth/password/password'
import { timeStepAt } from '@nexus/factory-domain/auth/totp/totp'
import { newId } from '@nexus/factory-domain/core/ids'
import { buildApp } from '../../../../core/app'
import type { Clock } from '../../../../core/time'
import { LOCAL_COOKIE_SECRET } from '../../../../env'
import { codesFor } from '../../office/second-factor'
import { CSRF_COOKIE, CSRF_HEADER } from '../cookies'
import { memoryAuthMailer, type MemoryAuthMailer } from '../mail'
import { createOfficeAuth, type AuthRateLimits, type OfficeAuth } from '../office-auth'

/**
 * Test helpers for the office sign-in's PostgreSQL tests (never imported by a route): a throwaway database built from
 * the migrations, the real app with its real routes and the real authenticator, a clock the test moves, the memory
 * mailer (the only place an invitation or reset link can be read), and a cookie jar that behaves like a browser.
 */

export const WEB_ORIGIN = 'http://localhost:3200'
export const START = '2026-10-28T09:00:00.000Z'

export interface MovableClock extends Clock {
  set(instant: string | Date): void
  advance(ms: number): void
}

export function movableClock(start: string | Date = START): MovableClock {
  let current = new Date(start).getTime()
  return {
    now: () => new Date(current),
    set: (instant) => void (current = new Date(instant).getTime()),
    advance: (ms) => void (current += ms),
  }
}

const GENEROUS = { max: 10_000, timeWindowMs: 60_000 }
export const GENEROUS_LIMITS: AuthRateLimits = { signIn: GENEROUS, resetRequest: GENEROUS, tokenUse: GENEROUS, codes: GENEROUS }

export interface Harness {
  readonly db: MigratedDatabase
  readonly database: FactoryDatabase
  readonly clock: MovableClock
  readonly mailer: MemoryAuthMailer
  readonly auth: OfficeAuth
  readonly app: FastifyInstance
  /** Another app on the same database and clock (other rate limits). */
  app2(rateLimits: Partial<AuthRateLimits>): Promise<FastifyInstance>
  close(): Promise<void>
}

async function appFor(database: FactoryDatabase, auth: OfficeAuth, clock: Clock): Promise<FastifyInstance> {
  return buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET, webOrigin: WEB_ORIGIN, rateLimit: GENEROUS },
    { database, officeAuth: auth, clock, routesRoot: fileURLToPath(new URL('../../../..', import.meta.url)) },
  )
}

export async function startHarness(label: string): Promise<Harness> {
  const db = await migratedDatabase(label)
  const database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 6 } })
  const clock = movableClock()
  const mailer = memoryAuthMailer()
  const make = (rateLimits: Partial<AuthRateLimits>) =>
    createOfficeAuth({ database, environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET, webOrigin: WEB_ORIGIN, clock, mailer, rateLimits })
  const auth = make(GENEROUS_LIMITS)
  const app = await appFor(database, auth, clock)
  const others: FastifyInstance[] = []
  return {
    db,
    database,
    clock,
    mailer,
    auth,
    app,
    async app2(rateLimits) {
      const other = await appFor(database, make({ ...GENEROUS_LIMITS, ...rateLimits }), clock)
      others.push(other)
      return other
    },
    async close() {
      for (const other of others) await other.close()
      await app.close()
      await database.close()
      await db.close()
    },
  }
}

export interface TestTenant {
  readonly id: string
  readonly slug: string
  readonly companies: readonly { readonly id: string; readonly code: string }[]
}

/** A made-up tenant with its companies, written as tenant set-up would (platform scope, then the tenant's). */
export async function addTenant(h: Harness, slug: string, companyCount = 1): Promise<TestTenant> {
  const id = newId()
  await h.database.withScope({ audience: 'platform' }, (client) => client.tenant.create({ data: { id, slug, name: `Test group ${slug}` } }))
  const companies = Array.from({ length: companyCount }, (_, index) => ({ id: newId(), code: `C${index + 1}` }))
  await h.database.withScope({ audience: 'office', tenantId: id, actorId: newId() }, async (client) => {
    for (const company of companies) await client.company.create({ data: { id: company.id, code: company.code, legalName: `Test company ${company.code}` } })
  })
  return { id, slug, companies }
}

export interface TestUser {
  readonly id: string
  readonly email: string
  readonly password: string
}

export const PASSWORD = 'quiet-harbour-lantern-58'

/** A user written straight into the tenant (an ACTIVE one has a password). */
export async function addUser(
  h: Harness,
  tenant: TestTenant,
  options: { email: string; isOwner?: boolean; requireMfa?: boolean; status?: 'INVITED' | 'ACTIVE' | 'SUSPENDED'; password?: string },
): Promise<TestUser> {
  const id = newId()
  const password = options.password ?? PASSWORD
  const status = options.status ?? 'ACTIVE'
  const passwordHash = status === 'INVITED' ? null : await hashPassword(password, { logN: 12, r: 8, p: 1 })
  await h.database.withScope({ audience: 'office', tenantId: tenant.id, actorId: id }, (client) =>
    client.user.create({
      data: {
        id,
        email: options.email,
        displayName: options.email.split('@')[0]!.replace(/\./g, ' '),
        status,
        isOwner: options.isOwner ?? false,
        requireMfa: options.requireMfa ?? false,
        passwordHash,
      },
    }),
  )
  return { id, email: options.email, password }
}

/** The TOTP code of a secret at the clock's time, `steps` steps later. */
export const codeAt = (clock: Clock, secret: string, steps = 0): string => codesFor(secret)(timeStepAt(clock.now()) + steps)

export interface Answer {
  readonly status: number
  readonly body: any
  readonly response: LightMyRequestResponse
}

/** A browser: keeps the cookies the API sets and sends them back, and the CSRF header on unsafe requests. */
export class Browser {
  readonly cookies = new Map<string, string>()
  constructor(readonly app: FastifyInstance) {}

  get csrfToken(): string | undefined {
    return this.cookies.get(CSRF_COOKIE)
  }

  async send(method: 'GET' | 'POST', url: string, body?: unknown, options: { csrf?: boolean; headers?: Record<string, string> } = {}): Promise<Answer> {
    const headers: Record<string, string> = { ...options.headers }
    if (this.cookies.size > 0) headers.cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ')
    if (method !== 'GET' && options.csrf !== false && this.csrfToken) headers[CSRF_HEADER] = this.csrfToken
    const response = await this.app.inject({ method, url, headers, ...(body === undefined ? {} : { payload: body as object }) })
    for (const cookie of response.cookies as { name: string; value: string; maxAge?: number; expires?: Date }[]) {
      const gone = cookie.maxAge === 0 || (cookie.expires !== undefined && cookie.expires.getTime() <= Date.now()) || cookie.value === ''
      if (gone) this.cookies.delete(cookie.name)
      else this.cookies.set(cookie.name, cookie.value)
    }
    let parsed: unknown = undefined
    try {
      parsed = response.json()
    } catch {
      parsed = response.body
    }
    return { status: response.statusCode, body: parsed, response }
  }

  get = (url: string, options?: { headers?: Record<string, string> }) => this.send('GET', url, undefined, options)
  post = (url: string, body?: unknown, options?: { csrf?: boolean; headers?: Record<string, string> }) => this.send('POST', url, body ?? {}, options)

  /** Gets a CSRF token, then signs in. */
  async signIn(tenant: string, email: string, password: string, code?: string): Promise<Answer> {
    if (!this.csrfToken) await this.get('/auth/csrf')
    return this.post('/auth/office/sign-in', { tenant, email, password, ...(code === undefined ? {} : { code }) })
  }
}

/** Sets up two-factor on a signed-in browser; returns the secret. Moves the clock one step on, so the next code is new. */
export async function enrolTotp(h: Harness, browser: Browser): Promise<string> {
  const setup = await browser.post('/auth/office/totp/setup')
  if (setup.status !== 200) throw new Error(`totp setup: ${setup.status} ${JSON.stringify(setup.body)}`)
  const secret = setup.body.secret as string
  const confirm = await browser.post('/auth/office/totp/confirm', { code: codeAt(h.clock, secret) })
  if (confirm.status !== 200) throw new Error(`totp confirm: ${confirm.status} ${JSON.stringify(confirm.body)}`)
  h.clock.advance(30_000)
  return secret
}

/** A fresh step-up on a signed-in browser with two-factor (moves the clock one step on afterwards). */
export async function stepUp(h: Harness, browser: Browser, secret: string): Promise<void> {
  const answer = await browser.post('/auth/office/step-up', { code: codeAt(h.clock, secret) })
  if (answer.status !== 200) throw new Error(`step-up: ${answer.status} ${JSON.stringify(answer.body)}`)
  h.clock.advance(30_000)
}
