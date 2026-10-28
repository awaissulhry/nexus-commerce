import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import type { Redis } from 'ioredis'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { hashPassword } from '@nexus/factory-domain/auth/password/password'
import { timeStepAt } from '@nexus/factory-domain/auth/totp/totp'
import { newId } from '@nexus/factory-domain/core/ids'
import { localFileStore } from '../../../../adapters/local-files/local'
import { FakeSes, textOf, type FakeMail } from '../../../../adapters/ses/fake'
import { sesMailAdapter } from '../../../../adapters/ses/ses'
import { buildApp } from '../../../../core/app'
import type { Clock } from '../../../../core/time'
import { LOCAL_COOKIE_SECRET, LOCAL_PIN_PEPPER } from '../../../../env'
import { emailAuthMailer } from '../../../email-out/auth-mail'
import { createEmailRuntime, useEmail, type EmailRuntime } from '../../../email-out/service'
import { createFilesRuntime, useFiles, type FilesRuntime } from '../../../files/service'
import { createGateway } from '../../../gateway/gateway'
import { testRedis, type TestRedis } from '../../../outbox/testing'
import { createSecretsService, type SecretsService } from '../../../secrets/envelope'
import { localKeyProvider } from '../../../secrets/local'
import { codesFor } from '../../office/second-factor'
import { applySystemRoleChanges, systemRoleChanges } from '../../roles/system-roles'
import { CSRF_COOKIE, CSRF_HEADER } from '../cookies'
import type { AuthMessage } from '../mail'
import { createOfficeAuth, type AuthRateLimits, type OfficeAuth } from '../office-auth'

/**
 * Test helpers for the office sign-in's PostgreSQL tests (never imported by a route): a throwaway database built from
 * the migrations, the real app with its real routes and the real authenticator, a clock the test moves, email out with
 * the gateway on the local Redis (this harness's own prefix), the local file store in a temporary folder (FAKE R2
 * accounts; `h.files`), and a FAKE SES account per tenant whose in-memory mailbox
 * is the only place an invitation or reset link can be read (`h.mailer`), and a cookie jar that behaves like a browser.
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
export const GENEROUS_LIMITS: AuthRateLimits = { signIn: GENEROUS, resetRequest: GENEROUS, tokenUse: GENEROUS, codes: GENEROUS, linkUse: GENEROUS, floorSignIn: GENEROUS }

/** A sign-in mail as the fake mailbox received it, with the link read from its text. */
export interface MailedLink {
  readonly kind: AuthMessage['kind']
  /** The FAKE SES account's tenant. */
  readonly tenantId: string
  /** The person the link is for (the token's middle part). */
  readonly userId: string
  readonly to: string
  readonly link: string
  readonly mail: FakeMail
}

/** The sign-in mails of the fake mailbox (the mail itself is in `ses.mails`). */
export interface AuthMailbox {
  readonly messages: readonly MailedLink[]
  /** The newest sign-in mail of a kind to an address. */
  last(kind: AuthMessage['kind'], to: string): MailedLink | undefined
}

const KINDS: Readonly<Record<string, AuthMessage['kind']>> = { 'auth.invitation': 'invitation', 'auth.password_reset': 'password_reset' }

function authMailbox(ses: FakeSes): AuthMailbox {
  const messages = (): MailedLink[] =>
    ses.mails.flatMap((mail) => {
      const kind = KINDS[mail.templateKey]
      const link = /https?:\/\/\S+#token=\S+/.exec(textOf(mail.raw))?.[0]
      const userId = link ? decodeURIComponent(link.split('#token=')[1] ?? '').split('.')[1] : undefined
      return kind && link && userId ? [{ kind, tenantId: mail.tenantId, userId, to: mail.to[0]!, link, mail }] : []
    })
  return {
    get messages() {
      return messages()
    },
    last: (kind, to) => messages().filter((message) => message.kind === kind && message.to === to).at(-1),
  }
}

export interface Harness {
  readonly db: MigratedDatabase
  readonly database: FactoryDatabase
  readonly clock: MovableClock
  /** The sign-in mails sent (FAKE SES), with their links. */
  readonly mailer: AuthMailbox
  /** The fake mailbox of every tenant's FAKE SES account. */
  readonly ses: FakeSes
  /** Email out as the app uses it (useEmail), on the gateway below. */
  readonly email: EmailRuntime
  /** Files as the app uses them (useFiles): FAKE R2 accounts store in a temporary folder. */
  readonly files: FilesRuntime
  readonly secrets: SecretsService
  /** The gateway's Redis connection and this harness's prefix. */
  readonly redis: Redis
  readonly redisPrefix: string
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
  const testRedisKit: TestRedis = testRedis()
  const redis = testRedisKit.connect()
  const secrets = createSecretsService({ providers: [localKeyProvider({ masterKey: randomBytes(32), environment: 'test' })] })
  const gateway = createGateway({ environment: 'test', redis, prefix: testRedisKit.prefix, secrets, sleep: async () => {}, log: { info() {}, warn() {}, error() {} } })
  const filesRoot = mkdtempSync(join(tmpdir(), 'factory-harness-files-'))
  const files = createFilesRuntime({ gateway, local: localFileStore({ root: filesRoot, environment: 'test' }), clock })
  useFiles(files)
  const ses = new FakeSes()
  // A LIVE or SANDBOX account never reaches SES from a test: its client refuses before anything is sent.
  const neverSes = sesMailAdapter({
    clientFor: () => {
      throw new Error('The test harness never calls SES; use a FAKE account or a FakeSesTransport.')
    },
  })
  const email = createEmailRuntime({ gateway, fake: ses, webOrigin: WEB_ORIGIN, ses: neverSes, files: files.storage })
  useEmail(email)
  const mailer = emailAuthMailer({ database, clock, runtime: () => email })
  const make = (rateLimits: Partial<AuthRateLimits>) =>
    createOfficeAuth({ database, environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET, pinPepper: LOCAL_PIN_PEPPER, webOrigin: WEB_ORIGIN, clock, mailer, rateLimits })
  const auth = make(GENEROUS_LIMITS)
  const app = await appFor(database, auth, clock)
  const others: FastifyInstance[] = []
  return {
    db,
    database,
    clock,
    mailer: authMailbox(ses),
    ses,
    email,
    files,
    secrets,
    redis,
    redisPrefix: testRedisKit.prefix,
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
      useEmail(undefined)
      useFiles(undefined)
      rmSync(filesRoot, { recursive: true, force: true })
      await testRedisKit.cleanup()
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

/**
 * A made-up tenant with its companies and its system roles (one per factory-domain template), written as tenant set-up
 * would (platform scope, then the tenant's), and its sign-in mail sender: a FAKE SES account and a verified
 * NOTIFICATION identity of its first company on `<slug>.example.com`.
 */
export async function addTenant(h: Harness, slug: string, companyCount = 1): Promise<TestTenant> {
  const id = newId()
  await h.database.withScope({ audience: 'platform' }, (client) => client.tenant.create({ data: { id, slug, name: `Test group ${slug}` } }))
  const companies = Array.from({ length: companyCount }, (_, index) => ({ id: newId(), code: `C${index + 1}` }))
  const actorId = newId()
  await h.database.withScope({ audience: 'office', tenantId: id, actorId }, async (client) => {
    for (const company of companies) await client.company.create({ data: { id: company.id, code: company.code, legalName: `Test company ${company.code}` } })
    await applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId })
    const accountId = newId()
    await client.integrationAccount.create({ data: { id: accountId, provider: 'SES', code: 'ses', label: 'Mail (fake)', mode: 'FAKE', rateLimitPerMinute: 6000, rateLimitBurst: 1000 } })
    const domain = `mail.${slug}.example.com`
    await client.emailIdentity.create({
      data: {
        id: newId(),
        companyId: companies[0]!.id,
        kind: 'NOTIFICATION',
        domain,
        fromAddress: `noreply@${domain}`,
        displayName: `Test company ${companies[0]!.code}`,
        displayNamePolicy: 'COMPANY',
        replyDomain: `reply.${slug}.example.com`,
        accountId,
        verificationStatus: 'SUCCESS',
        dkimStatus: 'SUCCESS',
        isDefault: true,
      },
    })
  })
  return { id, slug, companies }
}

/** Gives a user a system role (by template key) over every company, written straight into the tenant. */
export async function addRole(h: Harness, tenant: TestTenant, userId: string, roleKey: string): Promise<string> {
  const assignmentId = newId()
  await h.database.withScope({ audience: 'office', tenantId: tenant.id, actorId: userId }, async (client) => {
    const role = await client.role.findUniqueOrThrow({ where: { tenantId_key: { tenantId: tenant.id, key: roleKey } }, select: { id: true } })
    await client.roleAssignment.create({ data: { id: assignmentId, userId, roleId: role.id, allCompanies: true, validFrom: new Date(START) } })
  })
  return assignmentId
}

export interface TestUser {
  readonly id: string
  readonly email: string
  readonly password: string
}

export const PASSWORD = 'quiet-harbour-lantern-58'

/** A user written straight into the tenant (an ACTIVE one has a password), with a system role when `role` names one. */
export async function addUser(
  h: Harness,
  tenant: TestTenant,
  options: { email: string; role?: string; requireMfa?: boolean; status?: 'INVITED' | 'ACTIVE' | 'SUSPENDED'; password?: string },
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
        requireMfa: options.requireMfa ?? false,
        passwordHash,
      },
    }),
  )
  if (options.role) await addRole(h, tenant, id, options.role)
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
