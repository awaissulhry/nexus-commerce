/**
 * P6.1 (docs/channel-connections/FINAL-PLAN.md section 6.1) — automatic Amazon app-secret rotation.
 *
 * A fake Amazon (the LWA token endpoint + rotateApplicationClientSecret) and a fake credential queue
 * stand in for the real ones. The fake Amazon only issues a token for a secret it knows, and a
 * rotation puts a NEW_SECRET message on the queue — so "tested", "stored" and "used afterwards" are
 * real outcomes of the code, not assumptions. Every log line, ledger row and alert is captured and
 * searched for the secrets.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const OLD = 'old-secret-0123456789abcdef'
const NEW = 'new-secret-fedcba9876543210'
const CLIENT = 'amzn1.application-oa2-client.test'

const h = vi.hoisted(() => ({
  queue: [] as Array<{ Body: string; ReceiptHandle: string }>,
  deleted: [] as string[],
  policy: '' as string,
  queueReadable: true,
  secret: '' as string,
  validSecrets: new Set<string>(),
  rotateStatus: 204,
  rotateCalls: [] as Array<{ url: string; token: string | null }>,
  tokenRequests: [] as Array<{ secret: string; scope: string }>,
  app: { secretExpiresAt: null as Date | null, rotatedAt: null as Date | null },
  events: [] as Array<Record<string, unknown>>,
  alerts: [] as string[],
  logs: [] as string[],
  expirySet: [] as Array<{ expiresAt: Date | null }>,
  stored: [] as Array<{ secret: string; expiresAt: Date | null }>,
}))

vi.mock('@aws-sdk/client-sqs', () => {
  class ReceiveMessageCommand { constructor(readonly input: unknown) {} }
  class DeleteMessageCommand { constructor(readonly input: { ReceiptHandle: string }) {} }
  class GetQueueAttributesCommand { constructor(readonly input: unknown) {} }
  class SQSClient {
    async send(command: unknown) {
      if (command instanceof ReceiveMessageCommand) return { Messages: h.queue.splice(0) }
      if (command instanceof DeleteMessageCommand) { h.deleted.push(command.input.ReceiptHandle); return {} }
      if (command instanceof GetQueueAttributesCommand) {
        if (!h.queueReadable) throw new Error('AccessDenied')
        return { Attributes: { Policy: h.policy } }
      }
      return {}
    }
  }
  return { SQSClient, ReceiveMessageCommand, DeleteMessageCommand, GetQueueAttributesCommand }
})
vi.mock('../../db.js', () => ({
  default: {
    channelApp: { findUnique: vi.fn(async () => ({ ...h.app })) },
    connectionEvent: {
      findFirst: vi.fn(async ({ where }: any) => h.events.find((e) => e.type === where.type && (e.createdAt as Date) > where.createdAt.gt) ?? null),
    },
  },
}))
vi.mock('./events.service.js', () => ({
  CRON_ACTOR: { kind: 'cron' }, SYSTEM_ACTOR: { kind: 'system' },
  recordConnectionEvent: vi.fn(async (input: Record<string, unknown>) => { h.events.push({ ...input, createdAt: new Date() }) }),
}))
vi.mock('./apps.service.js', () => ({
  getChannelApp: vi.fn(async () => ({ channelKey: 'AMAZON_SP', environment: 'production', clientId: CLIENT, clientSecret: h.secret, redirectUris: [], extra: {}, signingKey: null })),
  storeClientSecret: vi.fn(async (_k: string, _e: string, secret: string, expiresAt: Date | null) => {
    h.stored.push({ secret, expiresAt }); h.secret = secret; h.app.rotatedAt = new Date(); h.app.secretExpiresAt = expiresAt
  }),
}))
vi.mock('./app-secret-expiry.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./app-secret-expiry.js')>()),
  setAppSecretExpiry: vi.fn(async (input: { expiresAt: Date | null }) => { h.expirySet.push({ expiresAt: input.expiresAt }); h.app.secretExpiresAt = input.expiresAt; return null }),
}))
vi.mock('../monitoring/alert.service.js', () => ({
  AlertType: { CONNECTION_HEALTH: 'CONNECTION_HEALTH' },
  alertService: { createAlert: vi.fn(async (_t: string, title: string, message: string) => { h.alerts.push(`${title} ${message}`); return {} }) },
}))
vi.mock('../../clients/amazon-sp-api.client.js', () => ({ mapAwsRegionToSpApiSlug: () => 'eu' }))
vi.mock('../../utils/logger.js', () => {
  const capture = (...args: unknown[]) => { h.logs.push(JSON.stringify(args)) }
  return { logger: { info: capture, warn: capture, error: capture, debug: capture } }
})

import {
  credentialNotificationType, drainAmazonCredentialQueue, handleAmazonCredentialMessage,
  requestAmazonSecretRotation, runAmazonSecretRotation, ROTATION_SCOPE,
} from './amazon-secret-rotation.service.js'

const DAY = 86_400_000
const GOOD_POLICY = JSON.stringify({ Statement: [{ Effect: 'Allow', Principal: { AWS: 'arn:aws:iam::437568002678:root' }, Action: ['sqs:SendMessage', 'sqs:GetQueueAttributes'] }] })
const newSecretBody = (clientId = CLIENT, secret = NEW) => JSON.stringify({
  notificationVersion: '1.0', notificationType: 'APPLICATION_OAUTH_CLIENT_NEW_SECRET', payloadVersion: '2023-11-30', eventTime: '2026-09-19T10:00:00Z',
  payload: { applicationOAuthClientNewSecret: { clientId, newClientSecret: secret, newClientSecretExpiryTime: '2027-03-18T10:00:00Z', oldClientSecretExpiryTime: '2026-09-26T10:00:00Z' } },
  notificationMetadata: { applicationId: 'amzn1.sp.solution.test', subscriptionId: 's', publishTime: '2026-09-19T10:00:01Z', notificationId: 'n' },
})
const expiryBody = (clientId = CLIENT) => JSON.stringify({
  notificationVersion: '1.0', notificationType: 'APPLICATION_OAUTH_CLIENT_SECRET_EXPIRY', payloadVersion: '2023-11-30', eventTime: '2026-09-19T10:00:00Z',
  payload: { applicationOAuthClientSecretExpiry: { clientId, clientSecretExpiryTime: '2026-10-09T22:06:39.224Z', clientSecretExpiryReason: 'PERIODIC_ROTATION' } },
})
let receipt = 0
const enqueue = (Body: string) => { h.queue.push({ Body, ReceiptHandle: `rh-${++receipt}` }); return `rh-${receipt}` }

beforeEach(() => {
  vi.stubEnv('AMAZON_APP_CREDENTIAL_QUEUE_URL', 'https://sqs.eu-west-1.amazonaws.com/123456789012/nexus-app-credentials')
  vi.stubEnv('AMAZON_REGION', 'eu')
  Object.assign(h, { queue: [], deleted: [], policy: GOOD_POLICY, queueReadable: true, secret: OLD, validSecrets: new Set([OLD]), rotateStatus: 204,
    rotateCalls: [], tokenRequests: [], events: [], alerts: [], logs: [], expirySet: [], stored: [] })
  h.app = { secretExpiresAt: null, rotatedAt: null }
  // The fake Amazon.
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    if (url === 'https://api.amazon.com/auth/o2/token') {
      const form = new URLSearchParams(String(init.body))
      h.tokenRequests.push({ secret: form.get('client_secret') ?? '', scope: form.get('scope') ?? '' })
      if (!h.validSecrets.has(form.get('client_secret') ?? '')) return new Response('{"error":"invalid_client"}', { status: 401 })
      return new Response(JSON.stringify({ access_token: `tok-for-${form.get('client_secret')}`, expires_in: 3600 }), { status: 200 })
    }
    if (url.endsWith('/applications/2023-11-30/clientSecret')) {
      h.rotateCalls.push({ url, token: (init.headers as Record<string, string>)['x-amz-access-token'] ?? null })
      if (h.rotateStatus === 204) { h.validSecrets.add(NEW); enqueue(newSecretBody()) }
      return new Response(null, { status: h.rotateStatus })
    }
    return new Response('not found', { status: 404 })
  }))
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

describe('P6.1 — reading credential notifications', () => {
  it('recognises both types, bare or SNS-wrapped, and nothing else', () => {
    expect(credentialNotificationType(newSecretBody())).toBe('APPLICATION_OAUTH_CLIENT_NEW_SECRET')
    expect(credentialNotificationType(JSON.stringify({ Type: 'Notification', Message: expiryBody() }))).toBe('APPLICATION_OAUTH_CLIENT_SECRET_EXPIRY')
    expect(credentialNotificationType(JSON.stringify({ NotificationType: 'ORDER_CHANGE' }))).toBeNull()
    expect(credentialNotificationType('not json')).toBeNull()
  })
  it('an expiry notice for our app records the date (no typing needed)', async () => {
    expect(await handleAmazonCredentialMessage(expiryBody())).toBe('expiry_recorded')
    expect(h.expirySet).toEqual([{ expiresAt: new Date('2026-10-09T22:06:39.224Z') }])
  })
  it('a new secret for our app is tested with a real token exchange, stored with its expiry, and recorded', async () => {
    h.validSecrets.add(NEW)
    expect(await handleAmazonCredentialMessage(newSecretBody())).toBe('saved')
    expect(h.tokenRequests).toEqual([{ secret: NEW, scope: ROTATION_SCOPE }])
    expect(h.stored).toEqual([{ secret: NEW, expiresAt: new Date('2027-03-18T10:00:00Z') }])
    expect(h.events).toEqual([expect.objectContaining({ type: 'secret_rotated', detail: expect.objectContaining({ oldSecretExpiresAt: '2026-09-26T10:00:00Z' }) })])
  })
  it('a new secret that does not work is NOT stored; alert; the message stays for the next pass', async () => {
    const handle = enqueue(newSecretBody()) // Amazon has not activated NEW (not in validSecrets)
    const counts = await drainAmazonCredentialQueue()
    expect(counts.test_failed).toBe(1)
    expect(h.stored).toEqual([])
    expect(h.deleted).not.toContain(handle)
    expect(h.alerts.join()).toMatch(/new secret did not work/)
  })
  it('a notice for another app is ignored and removed; the stored secret is untouched', async () => {
    h.validSecrets.add(NEW)
    const a = enqueue(newSecretBody('amzn1.application-oa2-client.OTHER'))
    const b = enqueue(expiryBody('amzn1.application-oa2-client.OTHER'))
    expect(await drainAmazonCredentialQueue()).toMatchObject({ ignored: 2, saved: 0 })
    expect(h.stored).toEqual([]); expect(h.expirySet).toEqual([])
    expect(h.deleted).toEqual([a, b])
  })
})

describe('P6.1 — asking Amazon for a new secret', () => {
  it('refuses without a queue, with a queue Amazon may not write to, or one Nexus cannot read — 0 calls to Amazon', async () => {
    h.policy = JSON.stringify({ Statement: [{ Principal: { AWS: '111111111111' }, Action: 'sqs:SendMessage' }] })
    expect(await requestAmazonSecretRotation('test')).toMatchObject({ requested: false, error: expect.stringMatching(/does not let Amazon/) })
    h.policy = GOOD_POLICY; h.queueReadable = false
    expect(await requestAmazonSecretRotation('test')).toMatchObject({ requested: false, error: expect.stringMatching(/cannot read the credential queue/) })
    vi.stubEnv('AMAZON_APP_CREDENTIAL_QUEUE_URL', '')
    expect(await requestAmazonSecretRotation('test')).toMatchObject({ requested: false, error: expect.stringMatching(/No credential queue/) })
    expect(h.tokenRequests).toEqual([]); expect(h.rotateCalls).toEqual([])
  })
  it('positive control: a good queue → a rotation-scope token from the CURRENT secret, then POST clientSecret → 204', async () => {
    expect(await requestAmazonSecretRotation('test')).toEqual({ requested: true, status: 204 })
    expect(h.tokenRequests).toEqual([{ secret: OLD, scope: ROTATION_SCOPE }])
    expect(h.rotateCalls).toEqual([{ url: 'https://sellingpartnerapi-eu.amazon.com/applications/2023-11-30/clientSecret', token: `tok-for-${OLD}` }])
    expect(h.events).toEqual([expect.objectContaining({ type: 'secret_rotation_requested' })])
  })
  it('Amazon refusing the rotation: recorded, alerted, nothing stored', async () => {
    h.rotateStatus = 403
    expect(await requestAmazonSecretRotation('test')).toMatchObject({ requested: false, error: expect.stringMatching(/HTTP 403/) })
    expect(h.events).toEqual([expect.objectContaining({ type: 'secret_rotation_failed' })])
    expect(h.alerts.join()).toMatch(/could not start/)
  })
})

describe('P6.1 — the pass that runs every 10 minutes', () => {
  const NOW = Date.UTC(2026, 8, 19, 12)
  it('without a queue it does nothing at all', async () => {
    vi.stubEnv('AMAZON_APP_CREDENTIAL_QUEUE_URL', '')
    expect(await runAmazonSecretRotation(NOW, 0)).toMatch(/^skipped/)
    expect(h.rotateCalls).toEqual([])
  })
  it.each([
    ['no date recorded', null, /no expiry date recorded/],
    ['45 days left', 45, /45 days left, nothing to do/],
  ])('%s → no rotation', async (_label, days, summary) => {
    h.app.secretExpiresAt = days === null ? null : new Date(NOW + (days as number) * DAY + 3_600_000)
    expect(await runAmazonSecretRotation(NOW, 0)).toMatch(summary)
    expect(h.rotateCalls).toEqual([])
  })
  it('END TO END: 20 days left → rotation requested → new secret arrives, is tested, stored, and used by the next token exchange', async () => {
    h.app.secretExpiresAt = new Date(NOW + 20 * DAY + 3_600_000)
    const summary = await runAmazonSecretRotation(NOW, 5)
    expect(summary).toMatch(/rotation requested; new secret stored/)
    expect(h.rotateCalls).toHaveLength(1)
    expect(h.stored).toEqual([{ secret: NEW, expiresAt: new Date('2027-03-18T10:00:00Z') }])
    expect(h.deleted).toHaveLength(1)
    // The next exchange uses the stored secret, not the old one.
    const { getChannelApp } = await import('./apps.service.js')
    expect((await getChannelApp('AMAZON_SP')).clientSecret).toBe(NEW)
    // And nothing anywhere carries either secret.
    const everything = JSON.stringify({ logs: h.logs, events: h.events, alerts: h.alerts })
    expect(everything).not.toContain(NEW)
    expect(everything).not.toContain(OLD)
  })
  it('never twice: a request in the last 24 hours, or a rotation in the last 7 days, holds the next one', async () => {
    h.app.secretExpiresAt = new Date(NOW + 20 * DAY)
    h.events.push({ type: 'secret_rotation_requested', createdAt: new Date(NOW - 3_600_000) })
    expect(await runAmazonSecretRotation(NOW, 0)).toMatch(/already requested in the last 24 h/)
    h.events.length = 0
    h.app.rotatedAt = new Date(NOW - 2 * DAY)
    expect(await runAmazonSecretRotation(NOW, 0)).toMatch(/rotated within 7 days/)
    expect(h.rotateCalls).toEqual([])
  })
  it('an expiry notice on the queue feeds the same pass: the date lands, then the 30-day rule decides', async () => {
    enqueue(expiryBody()) // 2026-10-09 → 20 days after NOW
    const summary = await runAmazonSecretRotation(NOW, 5)
    expect(h.expirySet).toHaveLength(1)
    expect(summary).toMatch(/expiry=1 failed=0; rotation requested; new secret stored/)
  })
})
