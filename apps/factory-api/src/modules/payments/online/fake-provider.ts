import type { FastifyRequest } from 'fastify'
import { ConflictError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { failureWords, isFinalIntent, type IntentStatus } from '@nexus/factory-domain/payments/online/rules'
import { readFakeClientSecret, type FakeScenario } from '../../../adapters/payment-fake/fake'
import { systemCallerOf } from '../../../platform/files/files'
import { ProviderError } from '../../../platform/gateway/gateway'
import { inboundRuntime } from '../../../platform/inbound/providers'
import { readSecret, SECRET_PURPOSES } from '../../../platform/secrets/store'
import { processPayments, type PaymentsRuntime } from './runtime'

/**
 * The FAKE provider's own fields (B-W2b-185; local and test only; W2b-3 question 2: no account, no key, no cost): what
 * Stripe's fields do in the customer's browser, for a FAKE payment account. `POST /payment-fake/confirm` takes the client
 * secret the page was given and a scenario (never card data: "succeed", "decline", "authenticate" …, adapters/payment-fake),
 * answers the provider's state, and posts the provider's webhook(s) to the inbound route exactly as the provider would
 * (signed with the account's webhook secret), so the payment moves only by the webhook, as it will live.
 *
 * Public (the provider's endpoint, not ours): the client secret is the key. In staging and production it answers 404 (the
 * runtime has no fake there; the gateway refuses FAKE accounts and the API does not start with one).
 */

const SLUG = { PAYMENT_FAKE: 'payment-fake', STRIPE: 'stripe' } as const

export async function fakeConfirm(request: FastifyRequest, body: { readonly clientSecret: string; readonly scenario: FakeScenario }, runtime: PaymentsRuntime = processPayments()) {
  const fake = runtime.fake
  const named = readFakeClientSecret(body.clientSecret)
  if (!fake || !named || runtime.environment === 'production') throw new NotFoundError()
  const system = systemCallerOf(request)(named.tenantId)
  const facts = await system.withClient(async (db) => {
    const account = await db.integrationAccount.findFirst({ where: { id: named.accountId, mode: 'FAKE', provider: { in: ['PAYMENT_FAKE', 'STRIPE'] } }, select: { id: true, provider: true, webhookSecretId: true } })
    const intent = account ? await db.paymentIntent.findFirst({ where: { providerAccountId: account.id, providerRef: named.providerRef }, select: { id: true, method: true, amount: true, currency: true, status: true } }) : null
    const secret = account?.webhookSecretId ? await readSecret(db, inboundRuntime().secrets, { id: account.webhookSecretId, tenantId: named.tenantId, purpose: SECRET_PURPOSES.webhook }) : null
    return { account, intent, secret }
  })
  if (!facts.account || !facts.intent) throw new NotFoundError()
  if (isFinalIntent(facts.intent.status as IntentStatus)) throw new ConflictError('This payment has ended already (fake provider).')
  if (!facts.secret) throw new ConflictError('The FAKE payment account has no webhook secret: set one on the connection (Admin › Connections), or the provider cannot tell us how the payment ended.')
  let confirmation
  try {
    confirmation = fake.confirm({ intentId: facts.intent.id, tenantId: named.tenantId, providerRef: named.providerRef, method: facts.intent.method, amount: facts.intent.amount, currency: facts.intent.currency }, body.scenario, facts.secret)
  } catch (error) {
    if (error instanceof ProviderError) throw new ConflictError(error.message)
    throw error
  }
  const slug = SLUG[facts.account.provider as keyof typeof SLUG]
  const webhooks = []
  for (const webhook of confirmation.webhooks) {
    const answer = await request.server.inject({ method: 'POST', url: `/inbound/${slug}/${named.tenantId}/${facts.account.id}`, headers: webhook.headers, payload: webhook.body })
    webhooks.push({ type: webhook.type, status: answer.statusCode })
  }
  return { state: confirmation.state, error: confirmation.errorCode ? { code: confirmation.errorCode, words: failureWords(confirmation.errorCode, 'en') } : null, webhooks }
}
