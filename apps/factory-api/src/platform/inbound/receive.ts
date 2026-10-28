import { createHash } from 'node:crypto'
import type { FastifyRequest } from 'fastify'
import type { IntegrationProvider } from '@nexus/factory-db'
import { NotFoundError, UnauthenticatedError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { command } from '../../core/command'
import { systemContext } from '../outbox/system'
import { readSecret, SECRET_PURPOSES } from '../secrets/store'
import type { InboundRuntime } from './providers'
import { fakeVerifier } from './verifiers'

/**
 * Receiving one webhook (plan A1 §4; feature PLT-194): `POST /inbound/<provider>/<tenantId>/<accountId>`.
 *
 *   1. The account: a webhook has no session, so the route acts as the system context of the tenant its URL names
 *      (office role, RLS forced: an unknown tenant or account, or one of another provider, is simply not found → 404,
 *      logged, nothing stored). A FAKE account is not found in production either.
 *   2. The signature, on the raw body: the provider's verifier (a FAKE account: the fake verifier), with the account's
 *      webhook secret opened in memory.
 *   3. The receipt, FIRST, through command() (audited): a failed signature → a REJECTED receipt (no dedupe key, no body)
 *      and 401; a verified delivery → a RECEIVED receipt with its body and the outbox event
 *      integration.inbound_received in the same transaction → 200 `received`. A dedupe key already stored (a provider's
 *      retry, or two deliveries at once: the unique key decides) → 200 `duplicate`, nothing new.
 *   4. Nothing is processed here: the worker's job (process.ts) does it later, once.
 */

export const PROVIDER_SLUGS = Object.freeze({
  ses: 'SES',
  r2: 'R2',
  sdi: 'SDI',
  sendcloud: 'SENDCLOUD',
  vies: 'VIES',
} as const satisfies Record<string, IntegrationProvider>)
export type ProviderSlug = keyof typeof PROVIDER_SLUGS

export interface Delivery {
  readonly provider: IntegrationProvider
  readonly tenantId: string
  readonly accountId: string
  readonly rawBody: Buffer
  readonly contentType: string | null
  readonly headers: Readonly<Record<string, string | undefined>>
}

export interface InboundAnswer {
  readonly status: 'received' | 'duplicate'
  readonly receiptId: string
}

/** The receipt's key was stored meanwhile by a delivery that committed first. */
class DuplicateDelivery extends Error {
  override name = 'DuplicateDelivery'
}

const MAX_KEY = 255
const utf8 = new TextDecoder('utf-8', { fatal: true })

export async function receiveInbound(request: FastifyRequest, delivery: Delivery, runtime: InboundRuntime): Promise<InboundAnswer> {
  // The webhook acts as its tenant's system: the scope that reads the account and writes the receipt (step 1).
  request.factoryContext = systemContext(delivery.tenantId, String(request.id))
  const where = { provider: delivery.provider, accountId: delivery.accountId }

  const account = await request.withClient((client) =>
    client.integrationAccount.findFirst({
      where: { id: delivery.accountId, provider: delivery.provider },
      select: { id: true, companyId: true, mode: true, webhookSecretId: true },
    }),
  )
  if (!account) {
    request.log.warn(where, 'inbound webhook for an unknown account: not stored')
    throw new NotFoundError()
  }
  if (account.mode === 'FAKE' && runtime.environment === 'production') {
    request.log.warn(where, 'inbound webhook for a FAKE account in production: not stored')
    throw new NotFoundError()
  }
  const verifier = account.mode === 'FAKE' ? fakeVerifier : runtime.providers[delivery.provider]?.verifier
  if (!verifier) {
    request.log.warn(where, 'inbound webhook for a provider without a verifier: not stored')
    throw new NotFoundError()
  }

  const now = runtime.clock.now()
  const bodySha256 = createHash('sha256').update(delivery.rawBody).digest('hex')
  const secret = account.webhookSecretId
    ? await request.withClient((client) => readSecret(client, runtime.secrets, { id: account.webhookSecretId!, tenantId: delivery.tenantId, purpose: SECRET_PURPOSES.webhook }))
    : null
  let verdict = await verifier.verify({ rawBody: delivery.rawBody, headers: delivery.headers, secret, now })
  let body: string | null = null
  if (verdict.ok) {
    try {
      body = utf8.decode(delivery.rawBody)
    } catch {
      verdict = { ok: false, reason: 'body_not_utf8' }
    }
    if (verdict.ok && (verdict.dedupeKey.length === 0 || verdict.dedupeKey.length > MAX_KEY)) verdict = { ok: false, reason: 'bad_event_id' }
  }
  const receipt = {
    companyId: account.companyId,
    accountId: account.id,
    provider: delivery.provider,
    bodySha256,
    bodyBytes: delivery.rawBody.length,
    contentType: delivery.contentType?.slice(0, 200) ?? null,
    receivedAt: now,
    requestId: String(request.id),
  }

  if (!verdict.ok) {
    const reason = verdict.reason.slice(0, 100)
    await command(request, { name: 'integration.rejectInbound', input: { ...where, bodySha256, reason } }, async (tools) => {
      const id = newId()
      await tools.tx.inboundWebhook.createMany({ data: [{ id, ...receipt, verified: false, rejectReason: reason, status: 'REJECTED' }] })
      tools.audit({ recordType: 'InboundWebhook', recordId: id, companyId: account.companyId, after: { ...where, status: 'REJECTED', reason } })
      return { receiptId: id }
    })
    request.log.warn({ ...where, reason }, 'inbound webhook refused: its signature does not verify (stored as REJECTED)')
    throw new UnauthenticatedError('The webhook signature is not valid.')
  }

  const accepted = verdict
  const { dedupeKey } = accepted
  const stored = () =>
    request.withClient((client) => client.inboundWebhook.findFirst({ where: { provider: delivery.provider, dedupeKey }, select: { id: true } }))
  const earlier = await stored()
  if (earlier) return { status: 'duplicate', receiptId: earlier.id }

  try {
    const { result } = await command(request, { name: 'integration.receiveInbound', input: { ...where, dedupeKey, bodySha256 } }, async (tools) => {
      const id = newId()
      const { count } = await tools.tx.inboundWebhook.createMany({
        data: [
          {
            id,
            ...receipt,
            verified: true,
            dedupeKey,
            externalId: accepted.externalId?.slice(0, MAX_KEY) ?? null,
            eventType: accepted.eventType?.slice(0, 200) ?? null,
            body,
            status: 'RECEIVED',
          },
        ],
        skipDuplicates: true,
      })
      if (count !== 1) throw new DuplicateDelivery()
      tools.audit({ recordType: 'InboundWebhook', recordId: id, companyId: account.companyId, after: { ...where, dedupeKey, status: 'RECEIVED' } })
      tools.emit({
        type: 'integration.inbound_received',
        subject: id,
        companyId: account.companyId,
        payload: { receiptId: id, accountId: account.id, provider: delivery.provider },
      })
      return { receiptId: id }
    })
    return { status: 'received', receiptId: result.receiptId }
  } catch (error) {
    if (!(error instanceof DuplicateDelivery)) throw error
    const first = await stored()
    if (!first) throw error
    return { status: 'duplicate', receiptId: first.id }
  }
}
