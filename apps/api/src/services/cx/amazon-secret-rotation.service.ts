/**
 * P6.1 (docs/channel-connections/FINAL-PLAN.md section 6.1) — automatic Amazon app-secret rotation.
 *
 * Amazon requires a new LWA client secret for our SP-API app every 180 days; if it is missed, every
 * Amazon call stops. Amazon lets an app rotate its own secret:
 *
 *   1. Once, the Owner registers an SQS queue for our app in the Developer Console (rows
 *      "Application Client Secret Expiry" and "Application Client New Secret"), with a queue policy
 *      that lets Amazon's principal 437568002678 SendMessage + GetQueueAttributes, and gives Nexus
 *      the queue URL as AMAZON_APP_CREDENTIAL_QUEUE_URL. Without it, nothing here runs.
 *   2. APPLICATION_OAUTH_CLIENT_SECRET_EXPIRY messages carry the expiry date: Nexus records it
 *      (the P0.5 date, no typing needed).
 *   3. 30 days before that date, Nexus calls rotateApplicationClientSecret
 *      (POST /applications/2023-11-30/clientSecret, grantless scope
 *      sellingpartnerapi::client_credential:rotation; answer 204).
 *   4. Amazon puts the new secret ONLY on the queue (APPLICATION_OAUTH_CLIENT_NEW_SECRET). Nexus tests
 *      it with a real token exchange, stores it sealed in ChannelApp (every Amazon token exchange
 *      reads it from there), sets the next expiry date, and only then deletes the message.
 *   5. The old secret keeps working for 7 days, so there is no gap. Any failure raises an alert
 *      and leaves at least 30 days to act by hand.
 *
 * Safety rules: a rotation is never requested without a queue that Nexus can read and Amazon may
 * write to (otherwise the new secret would be lost); never twice within 24 hours or within 7 days
 * of the last rotation; a secret never reaches a log line, the ledger or an alert; a message whose
 * secret could not be tested or stored is left on the queue for the next pass.
 *
 * Sources (read 2026-09-19): developer-docs.amazon "Rotate your application's client secret",
 * "Set up credential rotation notifications", the application_2023-11-30 model, and Amazon's
 * lwa-rotation sample (scope, payload field names).
 */
import {
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs'
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { mapAwsRegionToSpApiSlug } from '../../clients/amazon-sp-api.client.js'
import { alertService, AlertType } from '../monitoring/alert.service.js'
import { getChannelApp, storeClientSecret } from './apps.service.js'
import { setAppSecretExpiry, daysUntil } from './app-secret-expiry.js'
import { CRON_ACTOR, recordConnectionEvent, SYSTEM_ACTOR } from './events.service.js'

export const ROTATION_SCOPE = 'sellingpartnerapi::client_credential:rotation'
export const ROTATE_DAYS_BEFORE_EXPIRY = 30
export const AMAZON_NOTIFICATIONS_PRINCIPAL = '437568002678'
const NEW_SECRET = 'APPLICATION_OAUTH_CLIENT_NEW_SECRET'
const SECRET_EXPIRY = 'APPLICATION_OAUTH_CLIENT_SECRET_EXPIRY'
const DAY_MS = 86_400_000
const LWA_TOKEN_URL = 'https://api.amazon.com/auth/o2/token'

export function credentialQueueUrl(): string | null {
  const url = process.env.AMAZON_APP_CREDENTIAL_QUEUE_URL?.trim()
  return url ? url : null
}

const tail = (value: string) => `…${value.slice(-4)}`

function sqsClientFor(queueUrl: string): SQSClient {
  // https://sqs.<region>.amazonaws.com/<account>/<name>
  const region = /^https:\/\/sqs\.([a-z0-9-]+)\.amazonaws\.com\//.exec(queueUrl)?.[1] ?? process.env.AWS_REGION ?? 'eu-west-1'
  return new SQSClient({ region })
}

/** The message type, when the body is one of the two credential notifications (bare or SNS-wrapped). */
export function credentialNotificationType(body: string): typeof NEW_SECRET | typeof SECRET_EXPIRY | null {
  try {
    const outer = JSON.parse(body) as Record<string, unknown>
    const inner = typeof outer.Message === 'string' ? (JSON.parse(outer.Message) as Record<string, unknown>) : outer
    const type = inner.notificationType ?? inner.NotificationType
    return type === NEW_SECRET || type === SECRET_EXPIRY ? type : null
  } catch {
    return null
  }
}

function parse(body: string): Record<string, any> {
  const outer = JSON.parse(body) as Record<string, any>
  return typeof outer.Message === 'string' ? JSON.parse(outer.Message) : outer
}

/** A real LWA token exchange with this secret. True only when Amazon issues a token. */
async function secretWorks(clientId: string, clientSecret: string): Promise<boolean> {
  try {
    const response = await fetch(LWA_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret, scope: ROTATION_SCOPE }).toString(),
      signal: AbortSignal.timeout(20_000),
    })
    if (!response.ok) return false
    const data = (await response.json().catch(() => ({}))) as { access_token?: string }
    return typeof data.access_token === 'string' && data.access_token.length > 0
  } catch {
    return false
  }
}

async function alert(title: string, message: string): Promise<void> {
  await alertService.createAlert(AlertType.CONNECTION_HEALTH, title, message, 1).catch(() => null)
}

export type CredentialMessageOutcome = 'saved' | 'expiry_recorded' | 'ignored' | 'test_failed' | 'store_failed'

/**
 * Act on one credential notification. The caller deletes the message unless the outcome is
 * `test_failed` or `store_failed` (then it stays on the queue for the next pass).
 */
export async function handleAmazonCredentialMessage(body: string): Promise<CredentialMessageOutcome> {
  let note: Record<string, any>
  try {
    note = parse(body)
  } catch {
    return 'ignored'
  }
  const type = note.notificationType ?? note.NotificationType
  const app = await getChannelApp('AMAZON_SP')

  if (type === SECRET_EXPIRY) {
    const expiry = note.payload?.applicationOAuthClientSecretExpiry ?? {}
    if (expiry.clientId !== app.clientId) {
      logger.warn('[amazon-secret-rotation] expiry notice for another app — ignored', { clientId: tail(String(expiry.clientId ?? '')) })
      return 'ignored'
    }
    const at = new Date(String(expiry.clientSecretExpiryTime ?? ''))
    if (Number.isNaN(at.getTime())) return 'ignored'
    await setAppSecretExpiry({ channelKey: 'AMAZON_SP', environment: 'production', expiresAt: at, actor: { kind: 'channel' } })
    logger.info('[amazon-secret-rotation] expiry date recorded from Amazon', { expiresAt: at.toISOString(), reason: expiry.clientSecretExpiryReason ?? null })
    return 'expiry_recorded'
  }

  if (type === NEW_SECRET) {
    const fresh = note.payload?.applicationOAuthClientNewSecret ?? {}
    if (fresh.clientId !== app.clientId || typeof fresh.newClientSecret !== 'string' || !fresh.newClientSecret) {
      logger.warn('[amazon-secret-rotation] new-secret notice for another app, or without a secret — ignored', { clientId: tail(String(fresh.clientId ?? '')) })
      return 'ignored'
    }
    if (!(await secretWorks(app.clientId, fresh.newClientSecret))) {
      await recordConnectionEvent({ channelKey: 'AMAZON_SP', type: 'secret_rotation_failed', actor: SYSTEM_ACTOR, detail: { step: 'test', clientId: tail(app.clientId) } })
      await alert('Amazon app secret: the new secret did not work', 'Amazon sent a new app secret, but a test token exchange with it failed. Nexus still uses the old secret (it works for 7 days after rotation). The message stays on the queue and is retried; if it keeps failing, rotate by hand in the Solution Provider Portal.')
      return 'test_failed'
    }
    const expiresAt = fresh.newClientSecretExpiryTime ? new Date(String(fresh.newClientSecretExpiryTime)) : new Date(Date.now() + 180 * DAY_MS)
    try {
      await storeClientSecret('AMAZON_SP', 'production', fresh.newClientSecret, Number.isNaN(expiresAt.getTime()) ? null : expiresAt)
    } catch (err) {
      await recordConnectionEvent({ channelKey: 'AMAZON_SP', type: 'secret_rotation_failed', actor: SYSTEM_ACTOR, detail: { step: 'store', error: err instanceof Error ? err.message : String(err) } })
      await alert('Amazon app secret: the new secret could not be saved', 'The new secret works, but Nexus could not store it. The message stays on the queue and is retried.')
      return 'store_failed'
    }
    await recordConnectionEvent({
      channelKey: 'AMAZON_SP',
      type: 'secret_rotated',
      actor: SYSTEM_ACTOR,
      detail: { clientId: tail(app.clientId), newSecretExpiresAt: Number.isNaN(expiresAt.getTime()) ? null : expiresAt.toISOString(), oldSecretExpiresAt: fresh.oldClientSecretExpiryTime ?? null },
    })
    logger.info('[amazon-secret-rotation] new secret tested and stored', { clientId: tail(app.clientId) })
    return 'saved'
  }
  return 'ignored'
}

/** Read the credential queue once (long poll) and act on every message. */
export async function drainAmazonCredentialQueue(waitSeconds = 2): Promise<Record<CredentialMessageOutcome, number>> {
  const counts: Record<CredentialMessageOutcome, number> = { saved: 0, expiry_recorded: 0, ignored: 0, test_failed: 0, store_failed: 0 }
  const queueUrl = credentialQueueUrl()
  if (!queueUrl) return counts
  const client = sqsClientFor(queueUrl)
  const received = await client.send(new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: waitSeconds }))
  for (const message of received.Messages ?? []) {
    if (!message.Body || !message.ReceiptHandle) continue
    const outcome = await handleAmazonCredentialMessage(message.Body)
    counts[outcome]++
    if (outcome !== 'test_failed' && outcome !== 'store_failed') {
      await client.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }))
    }
  }
  return counts
}

/**
 * Can Amazon deliver a new secret to the queue, and can Nexus read it? A rotation without both would
 * lose the only copy of the new secret. Returns the reason it cannot, or null.
 */
export async function credentialQueueProblem(): Promise<string | null> {
  const queueUrl = credentialQueueUrl()
  if (!queueUrl) return 'No credential queue is configured (AMAZON_APP_CREDENTIAL_QUEUE_URL).'
  try {
    const attributes = await sqsClientFor(queueUrl).send(new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['Policy'] }))
    const policy = attributes.Attributes?.Policy ?? ''
    if (!policy.includes(AMAZON_NOTIFICATIONS_PRINCIPAL) || !/sqs:SendMessage/i.test(policy)) {
      return `The credential queue policy does not let Amazon (${AMAZON_NOTIFICATIONS_PRINCIPAL}) send messages to it.`
    }
    return null
  } catch (err) {
    return `Nexus cannot read the credential queue: ${err instanceof Error ? err.message : String(err)}`
  }
}

/** Ask Amazon for a new secret. Refuses unless the queue can receive it. Never throws. */
export async function requestAmazonSecretRotation(reason: string): Promise<{ requested: boolean; status?: number; error?: string }> {
  const problem = await credentialQueueProblem()
  if (problem) return { requested: false, error: problem }
  const app = await getChannelApp('AMAZON_SP')
  try {
    const tokenResponse = await fetch(LWA_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: app.clientId, client_secret: app.clientSecret, scope: ROTATION_SCOPE }).toString(),
      signal: AbortSignal.timeout(20_000),
    })
    const token = tokenResponse.ok ? ((await tokenResponse.json()) as { access_token?: string }).access_token : undefined
    if (!token) throw new Error(`the rotation token was refused (HTTP ${tokenResponse.status})`)
    const slug = mapAwsRegionToSpApiSlug(process.env.AMAZON_REGION || 'eu')
    const response = await fetch(`https://sellingpartnerapi-${slug}.amazon.com/applications/2023-11-30/clientSecret`, {
      method: 'POST',
      headers: { 'x-amz-access-token': token },
      signal: AbortSignal.timeout(20_000),
    })
    if (response.status !== 204) {
      const text = (await response.text().catch(() => '')).slice(0, 300)
      throw new Error(`Amazon answered HTTP ${response.status}${text ? `: ${text}` : ''}`)
    }
    await recordConnectionEvent({ channelKey: 'AMAZON_SP', type: 'secret_rotation_requested', actor: CRON_ACTOR, detail: { reason } })
    logger.info('[amazon-secret-rotation] rotation requested', { reason })
    return { requested: true, status: 204 }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    await recordConnectionEvent({ channelKey: 'AMAZON_SP', type: 'secret_rotation_failed', actor: CRON_ACTOR, detail: { step: 'request', error } })
    await alert('Amazon app secret: automatic rotation could not start', `Nexus asked Amazon for a new app secret and it failed: ${error}. Rotate by hand in the Solution Provider Portal before the expiry date, then record the new date.`)
    return { requested: false, error }
  }
}

async function recentlyRequested(now: number): Promise<boolean> {
  const row = await prisma.connectionEvent.findFirst({
    where: { channelKey: 'AMAZON_SP', type: 'secret_rotation_requested', createdAt: { gt: new Date(now - DAY_MS) } },
    select: { id: true },
  })
  return !!row
}

/**
 * One pass: take what is on the queue (expiry dates, new secrets); if the secret expires within 30
 * days and no rotation is in flight, request one and wait up to `settleSeconds` for the new secret.
 */
export async function runAmazonSecretRotation(now: number = Date.now(), settleSeconds = 60): Promise<string> {
  if (!credentialQueueUrl()) return 'skipped: no credential queue configured'
  const first = await drainAmazonCredentialQueue()
  const row = await prisma.channelApp.findUnique({
    where: { channelKey_environment: { channelKey: 'AMAZON_SP', environment: 'production' } },
    select: { secretExpiresAt: true, rotatedAt: true },
  })
  const drained = `saved=${first.saved} expiry=${first.expiry_recorded} failed=${first.test_failed + first.store_failed}`
  if (!row?.secretExpiresAt) return `${drained}; no expiry date recorded yet`
  const daysLeft = daysUntil(row.secretExpiresAt, now)
  if (daysLeft > ROTATE_DAYS_BEFORE_EXPIRY) return `${drained}; ${daysLeft} days left, nothing to do`
  if (row.rotatedAt && now - row.rotatedAt.getTime() < 7 * DAY_MS) return `${drained}; rotated within 7 days, waiting`
  if (await recentlyRequested(now)) return `${drained}; rotation already requested in the last 24 h`
  const request = await requestAmazonSecretRotation(`${daysLeft} days before expiry`)
  if (!request.requested) return `${drained}; rotation not requested: ${request.error}`
  let saved = 0
  const deadline = Date.now() + settleSeconds * 1000
  while (saved === 0 && Date.now() < deadline) saved += (await drainAmazonCredentialQueue(Math.min(20, settleSeconds))).saved
  return `${drained}; rotation requested; new secret ${saved > 0 ? 'stored' : 'not yet received (next pass)'}`
}
