/**
 * The browser golden flow's local stack (B-W1-06): ONE process that is the factory API, its worker and the two
 * scheduler polls the flow needs, on a throwaway database of its own, with every outside service FAKE. One process,
 * because the fakes keep their state in memory: the FAKE SDI answers only the process that sent it a file, the FAKE
 * mailbox holds the links the customer and the supplier open, the FAKE Sendcloud knows only the labels it made.
 *
 *   database   factory_test_<FACTORY_PG_TEST_RUN>_bgf_<hex>, built from the migrations (factory-db's migratedDatabase),
 *              every base seed (seed/*.ts in name order, namespace `golden`, tenant slug `golden`) plus the golden-flow
 *              scenario (seed/scenarios/golden-flow.ts: what no route makes yet); dropped when the stack stops.
 *   API        the real app (core/app.ts buildApp, every route, the real sign-in) on FACTORY_HOST:FACTORY_PORT, as
 *              src/index.ts builds it, with generous rate limits (every browser context reaches it from the web
 *              server's one loopback address).
 *   worker     the outbox relay and the event workers (BullMQ under FACTORY_QUEUE_PREFIX), with exactly the handlers of
 *              src/background.ts (checked at start), as `background.ts worker` runs them.
 *   scheduler  only on demand (control `/tick/…`): the SDI poll and the carrier tracking poll, each one tick with its
 *              clock an hour (SDI) or twelve hours (tracking) ahead, as the API golden flow ticks them.
 *   control    a loopback JSON endpoint on FACTORY_BGF_CONTROL_PORT for the browser test's harness only: the people of
 *              the flow (made in the tenant, two-factor set up through the API), their next authenticator code, the
 *              links in the FAKE mailbox, "wait until the worker is idle", the polls, the fake carrier's events.
 *
 * Refusals: FACTORY_ENV must be local (loopback database and Redis: env.ts), the database is always a throwaway
 * factory_test… one this process made, and nothing reads a `.env` (env.ts reads apps/factory-api/.env only, which a
 * fresh worktree has not; the runner passes every FACTORY_ variable on the command line). Never production.
 *
 * Run by scripts/factory/browser-golden-flow.mjs (`node --import tsx <this file>`); it prints `stack: ready` once
 * every part listens.
 */
import { randomBytes } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { fileURLToPath, pathToFileURL } from 'node:url'

const API_SRC = fileURLToPath(new URL('../../../../factory-api/src/', import.meta.url))
const DB_PACKAGE = fileURLToPath(new URL('../../../../../packages/factory-db/', import.meta.url))
const NAMESPACE = 'golden'

if (process.env.FACTORY_ENV !== 'local') {
  console.error('stack: refused to start: FACTORY_ENV must be local')
  process.exit(1)
}
const CONTROL_PORT = Number(process.env.FACTORY_BGF_CONTROL_PORT ?? '')
if (!Number.isSafeInteger(CONTROL_PORT) || CONTROL_PORT <= 0) {
  console.error('stack: refused to start: FACTORY_BGF_CONTROL_PORT is not a port')
  process.exit(1)
}

// The throwaway database first: the API's env loader needs its URL (the runtime login) before anything reads it.
const { migratedDatabase } = await import('@nexus/factory-db/testing')
const db = await migratedDatabase('bgf')
process.env.FACTORY_DATABASE_URL = db.url('factory_app')

const imp = <T>(path: string): Promise<T> => import(pathToFileURL(`${API_SRC}${path}`).href) as Promise<T>
const { loadFactoryEnv } = await imp<typeof import('../../../../factory-api/src/env')>('env.ts')
const env = loadFactoryEnv()

const { openFactoryDatabase } = await import('@nexus/factory-db')
const { seedUuid } = (await import(pathToFileURL(`${DB_PACKAGE}src/seeding.ts`).href)) as typeof import('../../../../../packages/factory-db/src/seeding')
const { hashPassword } = await import('@nexus/factory-domain/auth/password/password')
const { timeStepAt } = await import('@nexus/factory-domain/auth/totp/totp')
const { newId } = await import('@nexus/factory-domain/core/ids')
const { Redis } = await import('ioredis')
const { appConfig, buildApp } = await imp<typeof import('../../../../factory-api/src/core/app')>('core/app.ts')
const { openQueues, queueConnection } = await imp<typeof import('../../../../factory-api/src/core/queue')>('core/queue.ts')
const { assertNoFakeAccountsInProduction } = await imp<typeof import('../../../../factory-api/src/platform/gateway/boot')>('platform/gateway/boot.ts')
const { createOfficeAuth } = await imp<typeof import('../../../../factory-api/src/platform/auth/sessions/office-auth')>('platform/auth/sessions/office-auth.ts')
const { codesFor } = await imp<typeof import('../../../../factory-api/src/platform/auth/office/second-factor')>('platform/auth/office/second-factor.ts')
const { syncAllTenants } = await imp<typeof import('../../../../factory-api/src/platform/auth/roles/sync')>('platform/auth/roles/sync.ts')
const { queuePublisher, startRelay } = await imp<typeof import('../../../../factory-api/src/platform/outbox/relay')>('platform/outbox/relay.ts')
const { startEventWorkers } = await imp<typeof import('../../../../factory-api/src/platform/outbox/dispatch')>('platform/outbox/dispatch.ts')
const { processGateway } = await imp<typeof import('../../../../factory-api/src/platform/gateway/service')>('platform/gateway/service.ts')
const { processEmail } = await imp<typeof import('../../../../factory-api/src/platform/email-out/service')>('platform/email-out/service.ts')
const { textOf } = await imp<typeof import('../../../../factory-api/src/adapters/ses/fake')>('adapters/ses/fake.ts')
const { FakeSdi } = await imp<typeof import('../../../../factory-api/src/adapters/sdi/fake')>('adapters/sdi/fake.ts')
const { FakeSendcloud } = await imp<typeof import('../../../../factory-api/src/adapters/sendcloud/fake')>('adapters/sendcloud/fake.ts')
const { createSdiRuntime, useSdi } = await imp<typeof import('../../../../factory-api/src/modules/invoicing/sdi/runtime')>('modules/invoicing/sdi/runtime.ts')
const { createCarrierRuntime, useCarrier } = await imp<typeof import('../../../../factory-api/src/modules/shipping/labels/carrier')>('modules/shipping/labels/carrier.ts')
const { runSdiPoll } = await imp<typeof import('../../../../factory-api/src/modules/invoicing/sdi/poll')>('modules/invoicing/sdi/poll.ts')
const { runTrackingPoll } = await imp<typeof import('../../../../factory-api/src/modules/shipping/labels/poll')>('modules/shipping/labels/poll.ts')
const { handlers, HANDLER_FACTORIES } = await import('./handlers')

type Json = Record<string, any>
const log = {
  info: (fields: Json, message: string) => console.log(JSON.stringify({ level: 'info', msg: message, ...fields })),
  warn: (fields: Json, message: string) => console.log(JSON.stringify({ level: 'warn', msg: message, ...fields, err: fields.err ? String(fields.err) : undefined })),
  error: (fields: Json, message: string) => console.log(JSON.stringify({ level: 'error', msg: message, ...fields, err: fields.err ? String(fields.err) : undefined })),
}

// ---- the worker's handlers are background.ts's -----------------------------------------------------------------------------
{
  const source = readFileSync(`${API_SRC}background.ts`, 'utf8')
  const list = /const HANDLERS: readonly EventHandler\[\] = \[([^\]]*)\]/.exec(source)?.[1] ?? ''
  const named = [...list.matchAll(/(\w+)\(\)/g)].map((match) => match[1])
  if (JSON.stringify(named) !== JSON.stringify(HANDLER_FACTORIES)) {
    console.error(`stack: the worker's handlers differ from background.ts: ${named.join(', ')} (stack: ${HANDLER_FACTORIES.join(', ')}); add the new one to _harness/handlers.ts`)
    await db.close()
    process.exit(1)
  }
}

// ---- the seed: every base seed and the golden scenario, as the API golden flow writes them -----------------------------
const database = await openFactoryDatabase({ connectionString: env.FACTORY_DATABASE_URL, pool: { max: 16 } })
{
  const context = { db: database, namespace: NAMESPACE }
  const seedDir = `${DB_PACKAGE}seed/`
  for (const file of readdirSync(seedDir).filter((name) => name.endsWith('.ts')).sort()) {
    const module = (await import(pathToFileURL(`${seedDir}${file}`).href)) as { seed: (context: unknown) => Promise<unknown> }
    await module.seed(context)
  }
  for (const file of readdirSync(`${seedDir}scenarios/`).filter((name) => name.endsWith('.ts')).sort()) {
    const module = (await import(pathToFileURL(`${seedDir}scenarios/${file}`).href)) as { seed: (context: unknown) => Promise<unknown> }
    await module.seed(context)
  }
}
await assertNoFakeAccountsInProduction(database, env.FACTORY_ENV)
const id = (key: string) => seedUuid(NAMESPACE, key)
const tenantId = id('tenant')

// ---- the fakes, one instance each, shared by the API and the worker of this process ------------------------------------
const gateway = processGateway()
const sdi = new FakeSdi({ answerAfterMs: 0 })
useSdi(createSdiRuntime({ gateway, fake: sdi }))
const sendcloud = new FakeSendcloud()
useCarrier(createCarrierRuntime({ gateway, environment: env.FACTORY_ENV, fake: sendcloud }))
const mailbox = processEmail().fake
if (!mailbox) throw new Error('stack: no FAKE mailbox (FACTORY_ENV must be local)')

// ---- the API -------------------------------------------------------------------------------------------------------------
const GENEROUS = { max: 100_000, timeWindowMs: 60_000 }
const redis = new Redis(env.FACTORY_REDIS_URL, { lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 1, connectTimeout: 2_000 })
redis.on('error', () => {})
await redis.connect()
const officeAuth = createOfficeAuth({
  database,
  environment: env.FACTORY_ENV,
  cookieSecret: env.FACTORY_COOKIE_SECRET,
  pinPepper: env.FACTORY_PIN_PEPPER,
  webOrigin: env.FACTORY_WEB_ORIGIN,
  rateLimits: { signIn: GENEROUS, resetRequest: GENEROUS, tokenUse: GENEROUS, codes: GENEROUS, linkUse: GENEROUS, floorSignIn: GENEROUS },
})
const app = await buildApp({ ...appConfig(env), rateLimit: GENEROUS }, { database, redis, officeAuth, routesRoot: API_SRC, logger: { level: 'warn' } })
await app.listen({ host: env.FACTORY_HOST, port: env.FACTORY_PORT })

// ---- the worker ------------------------------------------------------------------------------------------------------------
const queueRedis = queueConnection(env.FACTORY_REDIS_URL)
queueRedis.on('error', () => {})
const kit = openQueues({ connection: queueRedis, prefix: env.FACTORY_QUEUE_PREFIX })
await syncAllTenants({ database, log })
const failures: string[] = []
const retried: string[] = []
const workerLog = {
  ...log,
  warn: (fields: Json, message: string) => {
    if (fields.job) retried.push(`${fields.job}: ${String(fields.err)}`)
    log.warn(fields, message)
  },
  error: (fields: Json, message: string) => {
    if (fields.job) failures.push(`${fields.job}: ${String(fields.err)}`)
    log.error(fields, message)
  },
}
const relay = startRelay({ database, publish: queuePublisher(kit), log: workerLog, pollMs: 250 })
const workers = startEventWorkers({ kit, handlers: handlers(), database, live: queueRedis, log: workerLog, handlerBackoffMs: 300 })

// ---- control ---------------------------------------------------------------------------------------------------------------
interface Person {
  readonly key: string
  readonly id: string
  readonly email: string
  readonly password: string
  readonly role: string
  readonly secret: string
}
const people = new Map<string, Person>()

/** A cookie jar on the app's inject (the people's set-up only: two-factor through the real routes). */
async function injectAs(jar: Map<string, string>, method: 'GET' | 'POST', url: string, body?: unknown) {
  const headers: Record<string, string> = {}
  if (jar.size > 0) headers.cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ')
  const csrf = [...jar].find(([name]) => name.endsWith('factory_csrf'))?.[1]
  if (method !== 'GET' && csrf) headers['x-csrf-token'] = csrf
  const response = await app.inject({ method, url, headers, ...(body === undefined ? {} : { payload: body as object }) })
  for (const cookie of response.cookies as { name: string; value: string; maxAge?: number }[]) {
    if (cookie.maxAge === 0 || cookie.value === '') jar.delete(cookie.name)
    else jar.set(cookie.name, cookie.value)
  }
  let parsed: any = undefined
  try {
    parsed = response.json()
  } catch {
    parsed = response.body
  }
  return { status: response.statusCode, body: parsed }
}

async function makePerson(key: string, role: string, displayName: string): Promise<Person> {
  const known = people.get(key)
  if (known) return known
  const userId = newId()
  const email = `${key.replace(/[A-Z]/g, (letter) => `.${letter.toLowerCase()}`)}@golden.example.com`
  const password = `bgf-${randomBytes(12).toString('base64url')}`
  const passwordHash = await hashPassword(password, { logN: 12, r: 8, p: 1 })
  await database.withScope({ audience: 'office', tenantId, actorId: userId }, async (client) => {
    await client.user.create({ data: { id: userId, email, displayName, locale: 'en', status: 'ACTIVE', passwordHash } })
    const found = await client.role.findUniqueOrThrow({ where: { tenantId_key: { tenantId, key: role } }, select: { id: true } })
    await client.roleAssignment.create({ data: { id: newId(), userId, roleId: found.id, allCompanies: true, validFrom: new Date(Date.now() - 86_400_000) } })
  })
  // Two-factor through the real routes: sign in, set up, confirm with the code of now.
  const jar = new Map<string, string>()
  await injectAs(jar, 'GET', '/auth/csrf')
  const signedIn = await injectAs(jar, 'POST', '/auth/office/sign-in', { tenant: NAMESPACE, email, password })
  if (signedIn.body?.status !== 'signed_in') throw new Error(`sign-in of ${key}: ${signedIn.status} ${JSON.stringify(signedIn.body)}`)
  const setup = await injectAs(jar, 'POST', '/auth/office/totp/setup')
  if (setup.status !== 200) throw new Error(`totp setup of ${key}: ${setup.status} ${JSON.stringify(setup.body)}`)
  const secret = setup.body.secret as string
  const confirm = await injectAs(jar, 'POST', '/auth/office/totp/confirm', { code: codesFor(secret)(timeStepAt(new Date())) })
  if (confirm.status !== 200) throw new Error(`totp confirm of ${key}: ${confirm.status} ${JSON.stringify(confirm.body)}`)
  await injectAs(jar, 'POST', '/auth/office/sign-out')
  const person = { key, id: userId, email, password, role, secret }
  people.set(key, person)
  return person
}

/** The person's next code: the first time step after the last one accepted, within the one step of drift; waits if needed. */
async function nextCode(email: string): Promise<{ code: string; step: number }> {
  const person = [...people.values()].find((entry) => entry.email === email)
  if (!person) throw new Error(`no person ${email}`)
  for (;;) {
    const [row] = (await db.admin.query('SELECT "totpLastStep" AS last FROM "User" WHERE id = $1', [person.id])).rows as { last: number | null }[]
    const now = timeStepAt(new Date())
    const step = Math.max(now - 1, (row?.last ?? now - 2) + 1)
    if (step <= now + 1) return { code: codesFor(person.secret)(step), step }
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
}

/** Waits until nothing waits in the outbox and the worker's queues are idle (twice in a row). */
async function settle(timeoutMs = 90_000): Promise<{ failures: string[]; retried: string[] }> {
  const until = Date.now() + timeoutMs
  let quiet = 0
  while (Date.now() < until) {
    const pending = (await db.admin.query(`SELECT count(*)::int AS n FROM "OutboxEvent" WHERE status = 'PENDING'`)).rows as { n: number }[]
    let busy = pending[0]?.n ?? 0
    for (const name of ['events', 'event-handlers'] as const) {
      const counts = await kit.queue(name).getJobCounts('waiting', 'active', 'delayed', 'prioritized', 'waiting-children')
      busy += Object.values(counts).reduce((sum, value) => sum + value, 0)
    }
    quiet = busy === 0 ? quiet + 1 : 0
    if (quiet >= 2) return { failures: [...failures], retried: [...retried] }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('the worker did not become idle in time')
}

function newestLink(to: string, after: number): Json | null {
  const mails = mailbox!.mails.filter((mail) => mail.to.includes(to))
  for (let index = mails.length - 1; index >= 0; index--) {
    if (index < after) break
    const text = textOf(mails[index]!.raw)
    const link = /(https?:\/\/\S+#token=\S+)/.exec(text)?.[1]
    if (link) return { url: link, token: decodeURIComponent(/#token=(\S+)/.exec(link)![1]!), templateKey: mails[index]!.templateKey, index }
  }
  return null
}

const routes: Record<string, (body: Json, query: URLSearchParams) => Promise<unknown>> = {
  'GET /ready': async () => ({ ok: true, tenant: NAMESPACE, companies: { A: { id: id('company:A'), code: 'SCA' }, B: { id: id('company:B'), code: 'SCB' } } }),
  'GET /id': async (_body, query) => ({ id: id(query.get('key') ?? '') }),
  'POST /people': async (body) => {
    const made = await makePerson(String(body.key), String(body.role), String(body.displayName ?? body.key))
    return { key: made.key, id: made.id, email: made.email, password: made.password, role: made.role }
  },
  'POST /totp': async (body) => nextCode(String(body.email)),
  'GET /mails': async (_body, query) => {
    const to = query.get('to')
    return { count: mailbox!.mails.length, mails: mailbox!.mails.filter((mail) => !to || mail.to.includes(to)).map((mail, index) => ({ index, templateKey: mail.templateKey, to: mail.to })) }
  },
  'GET /link': async (_body, query) => {
    const to = query.get('to') ?? ''
    const after = Number(query.get('after') ?? '0')
    const until = Date.now() + Number(query.get('waitMs') ?? '20000')
    for (;;) {
      const found = newestLink(to, after)
      if (found) return found
      if (Date.now() > until) throw new Error(`no link mailed to ${to} (mails: ${mailbox!.mails.map((mail) => `${mail.templateKey} → ${mail.to.join(',')}`).join('; ')})`)
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
  },
  'POST /settle': async (body) => settle(Number(body.timeoutMs ?? 90_000)),
  'GET /worker': async () => ({ failures, retried }),
  'POST /tick/sdi': async () => {
    await settle()
    const tick = await runSdiPoll({ database, log, clock: { now: () => new Date(Date.now() + 3_600_000) } })
    await settle()
    return { tick, files: sdi.files.length }
  },
  'POST /tick/tracking': async (body) => {
    const after = Date.now()
    for (const tracking of (body.trackingNumbers ?? []) as string[]) {
      sendcloud.advance(tracking, 'IN_TRANSIT', 'unused', new Date(after + 60_000))
      sendcloud.advance(tracking, 'DELIVERED', 'unused', new Date(after + 120_000))
    }
    const tick = await runTrackingPoll({ database, log, clock: { now: () => new Date(Date.now() + 12 * 3_600_000 + 5 * 60_000) } })
    await settle()
    return { tick }
  },
  'GET /prints': async () => ({}),
}

const control = createServer(async (request: IncomingMessage, response: ServerResponse) => {
  const url = new URL(request.url ?? '/', 'http://control')
  const route = routes[`${request.method} ${url.pathname}`]
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  const send = (status: number, value: unknown) => {
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(value))
  }
  if (!route) return send(404, { error: `no control route ${request.method} ${url.pathname}` })
  try {
    const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
    send(200, await route(body, url.searchParams))
  } catch (error) {
    send(500, { error: (error as Error).message })
  }
})
await new Promise<void>((resolve) => control.listen(CONTROL_PORT, '127.0.0.1', resolve))

let closing = false
async function shutdown(signal: string): Promise<void> {
  if (closing) return
  closing = true
  console.log(`stack: stopping (${signal})`)
  control.close()
  await relay.stop().catch(() => {})
  await workers.close().catch(() => {})
  await kit.close().catch(() => {})
  await app.close().catch(() => {})
  queueRedis.disconnect()
  redis.disconnect()
  await database.close().catch(() => {})
  await db.close().catch((error: Error) => console.error(`stack: the database was not dropped: ${error.message}`))
  console.log('stack: stopped')
  process.exit(0)
}
process.once('SIGTERM', () => void shutdown('SIGTERM'))
process.once('SIGINT', () => void shutdown('SIGINT'))

console.log(`stack: ready ${JSON.stringify({ api: `http://${env.FACTORY_HOST}:${env.FACTORY_PORT}`, control: `http://127.0.0.1:${CONTROL_PORT}`, database: db.name, admin: db.url('postgres') })}`)
