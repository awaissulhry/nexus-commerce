import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { expect } from 'vitest'
// The factory-db seeds are no package export: the flow reads them where they live (as quality/final's test does).
import { seed as seedGoldenScenario } from '../../../../../packages/factory-db/seed/scenarios/golden-flow'
import { seedUuid, type SeedContext } from '../../../../../packages/factory-db/src/seeding'
import { newId } from '@nexus/factory-domain/core/ids'
import type { EventEnvelope } from '@nexus/factory-domain/events/envelope'
import { fakePrintRelay, type FakePrintRelay } from '../../adapters/print-relay/fake'
import { FakeSdi } from '../../adapters/sdi/fake'
import { textOf } from '../../adapters/ses/fake'
import { FakeSendcloud } from '../../adapters/sendcloud/fake'
import { FakeVies } from '../../adapters/vies/fake'
import { callerFor } from '../../core/command'
// B-W2a-21: the work-order cost ledger (background.ts lists it too).
import { costingHandlers } from '../../modules/costing/actual/handlers'
import { startOnIssueHandler } from '../../modules/inventory/issue/start'
import { floorMoveValuationHandler } from '../../modules/inventory/ledger/valuation'
import { invoiceFilesHandler } from '../../modules/invoicing/invoice-files'
import { sdiArchiveHandler } from '../../modules/invoicing/sdi/archive'
import { sdiCourtesyCopyHandler } from '../../modules/invoicing/sdi/copy'
import { sdiPollHandler } from '../../modules/invoicing/sdi/poll'
import { createSdiRuntime, useSdi } from '../../modules/invoicing/sdi/runtime'
import { createViesRuntime, useVies } from '../../modules/parties/vies'
import { tellBuyerHandler } from '../../modules/purchasing/confirm/handler'
import { orderHandlers } from '../../modules/sales/orders/handlers'
import { afterAcceptanceHandler } from '../../modules/sales/quotes/after-acceptance'
import { shipDocumentsHandler } from '../../modules/shipping/documents/handler'
import { createCarrierRuntime, useCarrier } from '../../modules/shipping/labels/carrier'
import { trackingPollHandler } from '../../modules/shipping/labels/poll'
import { useCertificatesClock } from '../../modules/compliance/certificates/certificates'
import { useLabelsClock } from '../../modules/compliance/labels/store'
import { useRegisterClock } from '../../modules/compliance/register/register'
import { useStyleComplianceClock } from '../../modules/product/compliance/read'
import { useShipmentDocumentsClock } from '../../modules/shipping/documents/read'
import { emailInHandlers } from '../../platform/email-in/handlers'
import { emailSendHandler } from '../../platform/email-out/outbound'
import { exportHandlers } from '../../platform/exports/worker'
import { createGateway, type Gateway } from '../../platform/gateway/gateway'
import { useGateway } from '../../platform/gateway/service'
import { importHandlers } from '../../platform/imports/worker'
import { inboundHandler } from '../../platform/inbound/process'
import type { EventHandler } from '../../platform/outbox/dispatch'
import { RELAY_SETTINGS, relayTenant } from '../../platform/outbox/relay'
import { systemContext } from '../../platform/outbox/system'
import { printDispatchHandler } from '../../platform/print/handler'
import { printRelays, usePrintRelays } from '../../platform/print/service'
import { useSecrets } from '../../platform/secrets/service'
import { addUser, Browser, enrolTotp, startHarness, stepUp, type Answer, type Harness, type TestTenant } from '../../platform/auth/sessions/testing/harness'

/**
 * The golden flow's world (B-W1-06a): the auth harness (a throwaway database from the migrations, the real app with its
 * real routes and the real sign-in, a clock the flow moves, FAKE SES and R2) with EVERY base seed of
 * packages/factory-db/seed (in name order, as `npm run seed` writes them) under one namespace, the other outside
 * services as their FAKE adapters on one gateway (VIES, SDI, Sendcloud, the print relay), the people of the flow signed
 * in with their role templates and two-factor, and the worker's event handlers run in-process by the real outbox relay
 * (`drain`): no worker process, no BullMQ, the same handlers as background.ts (checked by `assertWorkerHandlers`).
 */

export const NAMESPACE = 'golden'
const SEED_DIR = fileURLToPath(new URL('../../../../../packages/factory-db/seed/', import.meta.url))
const BACKGROUND = fileURLToPath(new URL('../../background.ts', import.meta.url))

/** The worker's handlers, built from the same factories as background.ts HANDLERS (same order). */
export function workerHandlers(): readonly EventHandler[] {
  return [inboundHandler(), ...importHandlers(), printDispatchHandler(), emailSendHandler(), ...emailInHandlers(), floorMoveValuationHandler(), startOnIssueHandler(), invoiceFilesHandler(), sdiPollHandler(), sdiArchiveHandler(), sdiCourtesyCopyHandler(), trackingPollHandler(), afterAcceptanceHandler(), shipDocumentsHandler(), ...orderHandlers(), tellBuyerHandler(), ...costingHandlers(), ...exportHandlers()]
}
const HANDLER_FACTORIES = ['inboundHandler', 'importHandlers', 'printDispatchHandler', 'emailSendHandler', 'emailInHandlers', 'floorMoveValuationHandler', 'startOnIssueHandler', 'invoiceFilesHandler', 'sdiPollHandler', 'sdiArchiveHandler', 'sdiCourtesyCopyHandler', 'trackingPollHandler', 'afterAcceptanceHandler', 'shipDocumentsHandler', 'orderHandlers', 'tellBuyerHandler', 'costingHandlers', 'exportHandlers']

/** background.ts lists exactly the factories above: a handler the worker gains fails the golden flow until it runs here too. */
export function assertWorkerHandlers(): void {
  const source = readFileSync(BACKGROUND, 'utf8')
  const list = /const HANDLERS: readonly EventHandler\[\] = \[([^\]]*)\]/.exec(source)?.[1] ?? ''
  expect([...list.matchAll(/(\w+)\(\)/g)].map((match) => match[1])).toEqual(HANDLER_FACTORIES)
}

export interface Person {
  readonly key: string
  readonly id: string
  readonly email: string
  readonly role: string
  readonly browser: Browser
  readonly secret: string
}

export interface World {
  readonly h: Harness
  readonly tenant: TestTenant
  readonly gateway: Gateway
  readonly vies: FakeVies
  readonly sdi: FakeSdi
  readonly sendcloud: FakeSendcloud
  readonly printer: FakePrintRelay
  readonly people: Record<string, Person>
  /** Handler tries that failed and were tried again by `drain` (the worker's retry), in order. */
  readonly retried: string[]
  /** The seeds' stable id of a key (seedUuid of the namespace). */
  id(key: string): string
  close(): Promise<void>
}

export async function startWorld(): Promise<World> {
  const h = await startHarness('golden')
  // Commands run on the server clock (core/command.ts); the harness clock (sign-in, two-factor, presigned URLs, the
  // modules' own clocks below) starts at the same instant, so every date of the flow is today's.
  h.clock.set(new Date())
  const context: SeedContext = { db: h.database, namespace: NAMESPACE }
  for (const file of readdirSync(SEED_DIR).filter((name) => name.endsWith('.ts')).sort()) {
    const module = (await import(pathToFileURL(`${SEED_DIR}${file}`).href)) as { seed: (context: SeedContext) => Promise<unknown> }
    await module.seed(context)
  }
  // What the flow needs that the base seed lacks and no route makes (each a gap, listed in the scenario's header).
  await seedGoldenScenario(context)
  const id = (key: string) => seedUuid(NAMESPACE, key)
  const tenant: TestTenant = { id: id('tenant'), slug: NAMESPACE, companies: [{ id: id('company:A'), code: 'SCA' }, { id: id('company:B'), code: 'SCB' }] }

  useSecrets(h.secrets)
  const gateway = createGateway({ environment: 'test', redis: h.redis, prefix: h.redisPrefix, secrets: h.secrets, sleep: async () => {}, log: { info() {}, warn() {}, error() {} } })
  useGateway(gateway)
  const vies = new FakeVies()
  useVies(createViesRuntime({ gateway, fake: vies }))
  // The fake SDI answers (RC, delivered) at its first poll; its XML is checked against the FatturaPA XSD.
  const sdi = new FakeSdi({ clock: h.clock, answerAfterMs: 0 })
  useSdi(createSdiRuntime({ gateway, fake: sdi }))
  const sendcloud = new FakeSendcloud(h.clock)
  useCarrier(createCarrierRuntime({ gateway, environment: 'test', fake: sendcloud }))
  const printer = fakePrintRelay({ environment: 'test' })
  usePrintRelays(printRelays({ FAKE: printer }))
  for (const useClock of [useCertificatesClock, useLabelsClock, useRegisterClock, useStyleComplianceClock, useShipmentDocumentsClock]) useClock(h.clock)

  return {
    h,
    tenant,
    gateway,
    vies,
    sdi,
    sendcloud,
    printer,
    people: {},
    retried: [],
    id,
    async close() {
      for (const useClock of [useCertificatesClock, useLabelsClock, useRegisterClock, useStyleComplianceClock, useShipmentDocumentsClock]) useClock(undefined)
      useVies(undefined)
      useSdi(undefined)
      useCarrier(undefined)
      usePrintRelays(undefined)
      useGateway(undefined)
      useSecrets(undefined)
      await h.close()
    },
  }
}

/** A person of the flow: written with a role template, signed in through the real sign-in, two-factor set up. */
export async function person(world: World, key: string, role: string): Promise<Person> {
  const email = `${key.replace(/[A-Z]/g, (letter) => `.${letter.toLowerCase()}`)}@golden.example.com`
  const user = await addUser(world.h, world.tenant, { email, role })
  const browser = new Browser(world.h.app)
  const answer = await browser.signIn(world.tenant.slug, user.email, user.password)
  if (answer.body?.status !== 'signed_in') throw new Error(`sign-in of ${key}: ${answer.status} ${JSON.stringify(answer.body)}`)
  const secret = await enrolTotp(world.h, browser)
  const made: Person = { key, id: user.id, email, role, browser, secret }
  world.people[key] = made
  return made
}

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
type Json = Record<string, any>
let keys = 0
export const freshKey = (label = 'gf') => `${label}-${newId()}-${++keys}`

/** One call of a browser (office cookies, a tablet's device and floor cookies): unsafe calls carry a fresh Idempotency-Key. */
export async function call(browser: Browser, method: Method, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<Answer> {
  const withKey = method === 'GET' || headers['idempotency-key'] ? headers : { ...headers, 'idempotency-key': freshKey() }
  return browser.send(method as 'POST', url, method === 'GET' ? undefined : (body ?? {}), { headers: withKey })
}

/** A call that must answer `status` (200 by default): the body, or the failure with what the API said. */
export async function ok(browser: Browser | Person, method: Method, url: string, body?: unknown, status = 200, headers: Record<string, string> = {}): Promise<Json> {
  const answer = await call('browser' in browser ? browser.browser : browser, method, url, body, headers)
  expect(answer.status, `${method} ${url}: ${JSON.stringify(answer.body)}`).toBe(status)
  return answer.body
}

/** A fresh step-up (TOTP) for the person's next signing act. */
export const stepped = (world: World, who: Person) => stepUp(world.h, who.browser, who.secret)

/** A browser for a one-off link (the customer, the supplier): the token travels in `x-factory-link`, never a cookie. */
export function linkBrowser(world: World, token: string) {
  const browser = new Browser(world.h.app)
  return {
    token,
    async send(method: Method, url: string, body?: unknown, status = 200): Promise<Json> {
      const answer = await call(browser, method, url, body, { 'x-factory-link': token })
      expect(answer.status, `${method} ${url} (link): ${JSON.stringify(answer.body)}`).toBe(status)
      return answer.body
    },
  }
}

/** The token of the newest link in the FAKE mailbox sent to an address (the web link `<web>/l#token=…`). */
export function linkTokenSentTo(world: World, to: string): string {
  const mail = [...world.h.ses.mails].reverse().find((entry) => entry.to.includes(to) && /#token=/.test(textOf(entry.raw)))
  if (!mail) throw new Error(`no link mail to ${to} (mails: ${world.h.ses.mails.map((entry) => `${entry.templateKey} to ${entry.to.join(',')}`).join('; ')})`)
  const token = /#token=(\S+)/.exec(textOf(mail.raw))?.[1]
  if (!token) throw new Error(`the mail to ${to} holds no token`)
  return decodeURIComponent(token)
}

/** SQL as the database owner, for the end checks (never to make a step happen). */
export async function admin<T = Json>(world: World, sql: string, values: unknown[] = []): Promise<T[]> {
  return (await world.h.db.admin.query(sql, values)).rows as T[]
}

/**
 * The worker's job, in-process: the real relay (platform/outbox/relay.ts relayTenant) takes the tenant's PENDING events
 * in order and hands each to every handler of background.ts that handles its type, as the system caller of the event's
 * tenant (dispatch.ts runHandler), up to the handler's attempts as BullMQ would (each failed try is kept in
 * `world.retried`). Repeats until nothing is pending (handlers emit events of their own). A handler whose last try
 * throws fails the step with its error. Returns the event types handled.
 */
export async function drain(world: World, handlers: readonly EventHandler[] = workerHandlers()): Promise<string[]> {
  const seen: string[] = []
  const failures: string[] = []
  const publish = async (event: EventEnvelope) => {
    seen.push(event.type)
    for (const handler of handlers.filter((entry) => entry.events.includes(event.type))) {
      // As BullMQ runs a handler job: up to its attempts (here without the backoff); only the last failure counts.
      for (let attempt = 1; attempt <= handler.attempts; attempt++) {
        try {
          await handler.handle(event, { caller: callerFor(world.h.database, systemContext(event.tenantId, event.correlationId)), attempt })
          break
        } catch (error) {
          world.retried.push(`${handler.name} on ${event.type} (try ${attempt}): ${(error as Error).name}: ${(error as Error).message}`)
          if (attempt === handler.attempts) failures.push(`${handler.name} on ${event.type}: ${(error as Error).stack ?? error}`)
        }
      }
    }
  }
  // Every row is due: the relay's clock runs a year ahead of the flow's, whatever time a row was written at.
  const settings = { ...RELAY_SETTINGS, publishTimeoutMs: 300_000, clock: { now: () => new Date(Date.now() + 365 * 24 * 3_600_000) } }
  for (let pass = 0; pass < 25; pass++) {
    const counts = await relayTenant(world.h.database, world.tenant.id, publish, settings)
    if (failures.length > 0) throw new Error(`the worker's handlers failed:\n${failures.join('\n')}`)
    if (counts.published === 0 && counts.failed === 0 && !counts.more) return seen
  }
  throw new Error('the outbox did not drain in 25 passes')
}

// ---- files ---------------------------------------------------------------------------------------------------------------

/** A made-up PDF (the local store keeps bytes; nothing reads them as a document). */
export const pdf = (text: string): Buffer => Buffer.from(`%PDF-1.4\n% made-up document of the golden flow: ${text}\n%%EOF\n`)
export const sha256 = (body: Buffer): string => createHash('sha256').update(body).digest('hex')
export const announce = (name: string, body: Buffer) => ({ originalName: name, contentType: 'application/pdf', sizeBytes: body.length, sha256: sha256(body) })

/** The bytes of an announced upload, sent to the presigned URL of the local store (the browser's PUT, no session). */
export async function putBytes(world: World, announced: Record<string, any>, body: Buffer): Promise<void> {
  const sent = await world.h.app.inject({ method: 'PUT', url: announced.upload.url, headers: announced.upload.headers, payload: body })
  expect(sent.statusCode, sent.body).toBe(200)
}

// ---- the floor -------------------------------------------------------------------------------------------------------------

export interface FloorWorker {
  readonly id: string
  readonly name: string
  readonly badgeCode: string
  readonly tempPin: string
}

/** A tablet at a station: the supervisor makes the enrolment code, the tablet trades it for its device cookie. */
export async function tablet(world: World, supervisor: Person, siteId: string, stationId: string, name: string): Promise<Browser> {
  const made = await ok(supervisor, 'POST', '/auth/floor/devices', { siteId, stationId, name })
  const device = new Browser(world.h.app)
  await device.get('/auth/csrf')
  await ok(device, 'POST', '/floor/device/enrol', { code: made.enrolment.code, appVersion: '1.0.0' })
  return device
}

/** A floor worker with a floor role, a badge and a temporary PIN, all through the supervisor's routes (one step-up). */
export async function floorWorker(world: World, supervisor: Person, siteId: string, name: string, roleId: string): Promise<FloorWorker> {
  await stepped(world, supervisor)
  const made = await ok(supervisor, 'POST', '/auth/floor/workers', { siteId, displayName: name, locale: 'it', roleIds: [roleId] })
  const workerId = (made.worker?.id ?? made.id) as string
  const badge = await ok(supervisor, 'POST', `/auth/floor/workers/${workerId}/badges`)
  const reset = await ok(supervisor, 'POST', `/auth/floor/workers/${workerId}/pin-reset`)
  return { id: workerId, name, badgeCode: badge.code as string, tempPin: reset.pin as string }
}

/** The worker signs in on the tablet (badge + temporary PIN), sets a PIN of their own and acknowledges the worker notice. */
export async function signOn(device: Browser, worker: FloorWorker, pin: string): Promise<void> {
  await ok(device, 'POST', '/floor/sign-in', { badgeCode: worker.badgeCode, pin: worker.tempPin })
  await ok(device, 'POST', '/floor/pin', { currentPin: worker.tempPin, newPin: pin })
  const shown = await ok(device, 'GET', '/privacy/floor/notice')
  if (!shown.gate.acknowledged) await ok(device, 'POST', '/privacy/floor/notice/acknowledge', { noticeId: shown.notice.id, locale: shown.notice.locale, sha256: shown.notice.sha256 })
}

export const QUIET = { info() {}, warn() {}, error() {} }
