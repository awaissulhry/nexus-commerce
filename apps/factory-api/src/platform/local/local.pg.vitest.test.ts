import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FakeSes } from '../../adapters/ses/fake'
import { addTenant, addUser, Browser, startHarness, WEB_ORIGIN, type Harness, type TestTenant } from '../auth/sessions/testing/harness'
import { emailAuthMailer } from '../email-out/auth-mail'
import { createEmailRuntime } from '../email-out/service'
import { createGateway } from '../gateway/gateway'
import { localMailbox } from './mailbox'
import { NO_LOCAL_STACK, useLocalStack } from './stack'

/**
 * The Owner's local test server's mailbox (B-W2b-F58) on the local stack: a throwaway PostgreSQL 17 database from the
 * migrations (the runtime login), the real office sign-in, and two FAKE mail providers on one mailbox folder — the API's
 * (the app built with the local stack) and another process's (a second email runtime, as the worker's). Every person and
 * address is made up. Run with `node scripts/factory/run-pg-tests.mjs platform/local`.
 *
 *   shared     a mail the other process sends lands in the folder; the API's GET /local/mailbox lists it, newest first,
 *              with its subject, text and links, for a signed-in office person of that tenant only
 *   off local  an app built without the local stack registers neither the route nor its manifest entry: 404 for everyone
 */

let h: Harness
let tenant: TestTenant
let other: TestTenant
let folder: string
let browser: Browser
let otherBrowser: Browser
let offLocal: FastifyInstance

beforeAll(async () => {
  folder = mkdtempSync(join(tmpdir(), 'factory-local-mailbox-'))
  // The API's own process: the local stack (its mailbox) is read when the app registers its routes.
  useLocalStack({ mailbox: localMailbox({ folder }), hideTestModeBanner: false })
  h = await startHarness('local_stack')
  tenant = await addTenant(h, 'local-a')
  other = await addTenant(h, 'local-b')
  const reader = await addUser(h, tenant, { email: 'rita.reader@local-a.example.com', role: 'read_only' })
  browser = new Browser(h.app)
  expect((await browser.signIn('local-a', reader.email, reader.password)).status).toBe(200)
  const otherReader = await addUser(h, other, { email: 'otto.reader@local-b.example.com', role: 'read_only' })
  otherBrowser = new Browser(h.app)
  expect((await otherBrowser.signIn('local-b', otherReader.email, otherReader.password)).status).toBe(200)
  // Another process without the local stack (test, staging, production): built while the stack is off.
  useLocalStack(NO_LOCAL_STACK)
  offLocal = await h.app2({})
  useLocalStack({ mailbox: localMailbox({ folder }), hideTestModeBanner: false })
}, 300_000)

afterAll(async () => {
  useLocalStack(undefined)
  await h?.close()
  rmSync(folder, { recursive: true, force: true })
}, 60_000)

describe('the local mailbox is shared by every process (B-W2b-F58)', () => {
  it('a mail another process’s FAKE provider sends is listed by the API, with its text and links, for its tenant only', async () => {
    // The worker's process: its own gateway, email runtime and FAKE provider, writing to the same folder.
    const gateway = createGateway({ environment: 'test', redis: h.redis, prefix: h.redisPrefix, secrets: h.secrets, sleep: async () => {}, log: { info() {}, warn() {}, error() {} } })
    const workerSes = new FakeSes({ mailbox: localMailbox({ folder }) })
    const worker = createEmailRuntime({ gateway, fake: workerSes, webOrigin: WEB_ORIGIN, files: h.files.storage })
    const invited = await addUser(h, tenant, { email: 'nina.nuova@local-a.example.com', status: 'INVITED' })
    const link = `${WEB_ORIGIN}/accept-invitation#token=made-up-invitation-token-f58`
    const mailer = emailAuthMailer({ database: h.database, clock: h.clock, runtime: () => worker })
    await mailer.deliver({ kind: 'invitation', tenantId: tenant.id, userId: invited.id, to: invited.email, link, expiresAt: new Date(h.clock.now().getTime() + 7 * 86_400_000), invitedById: null })
    const reset = `${WEB_ORIGIN}/reset-password#token=made-up-reset-token-f58`
    await mailer.deliver({ kind: 'password_reset', tenantId: tenant.id, userId: invited.id, to: invited.email, link: reset, expiresAt: new Date(h.clock.now().getTime() + 3_600_000) })
    // The worker's FAKE provider kept them in memory as before; the API's never saw them.
    expect(workerSes.mails).toHaveLength(2)
    expect(h.ses.mails.filter((mail) => mail.to.includes(invited.email))).toEqual([])

    const listed = await browser.get('/local/mailbox')
    expect(listed.status, JSON.stringify(listed.body)).toBe(200)
    const [newest, older] = listed.body.messages
    expect(newest).toMatchObject({ to: [invited.email], templateKey: 'auth.password_reset', links: [reset] })
    expect(older).toMatchObject({ to: [invited.email], templateKey: 'auth.invitation', links: [link] })
    expect(older.subject.length).toBeGreaterThan(0)
    expect(older.text).toContain(link)
    expect(Object.keys(newest).sort()).toEqual(['bcc', 'cc', 'from', 'id', 'links', 'sentAt', 'subject', 'templateKey', 'text', 'to'])
    expect((await browser.get('/local/mailbox?limit=1')).body.messages).toHaveLength(1)
    // Another tenant's office person sees none of them.
    expect((await otherBrowser.get('/local/mailbox')).body).toEqual({ messages: [] })
    // No session: 401, as every office route.
    expect((await new Browser(h.app).get('/local/mailbox')).status).toBe(401)
  })
})

describe('off the local test server the route does not exist (B-W2b-F58)', () => {
  it('an app built without the local stack answers 404 and has no manifest entry for it', async () => {
    expect(h.app.factoryRouteManifest.routes().map(([key]) => key)).toContain('GET /local/mailbox')
    expect(offLocal.factoryRouteManifest.routes().map(([key]) => key)).not.toContain('GET /local/mailbox')
    const signedIn = new Browser(offLocal)
    signedIn.cookies.clear()
    for (const [name, value] of browser.cookies) signedIn.cookies.set(name, value)
    expect((await signedIn.get('/auth/office/me')).status).toBe(200)
    expect((await signedIn.get('/local/mailbox')).status).toBe(404)
    expect((await new Browser(offLocal).get('/local/mailbox')).status).toBe(404)
  })
})
