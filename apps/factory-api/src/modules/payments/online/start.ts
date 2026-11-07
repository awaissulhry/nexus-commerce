import type { FastifyRequest } from 'fastify'
import { DomainError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { markMoney } from '@nexus/factory-domain/money/marked'
import { IN_PROGRESS_MS, LIVE_INTENT_STATUSES, RESUME_MS, START_REFUSALS, type IntentMethod, type IntentTarget, type OnlineLocale, type StartRefusal } from '@nexus/factory-domain/payments/online/rules'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { systemCallerOf } from '../../../platform/files/files'
import { lockMoney } from '../locks'
import { processPayments, type PaymentsRuntime } from './runtime'
import { INTENT_COLUMNS, intentView, paymentAccountFor, readIntent, targetFacts, targetOf, type IntentRow, type IntentView, type TargetFacts } from './store'

/**
 * Starting a card or SEPA payment (B-W2b-185; FIN-123; design links.pay "Pay by card", portal.customer.documents › Pay):
 * the same work for a link (PAYMENT or DEPOSIT_INFO) and a portal person. A link or portal session never calls a provider
 * nor writes PaymentIntent (the partner role only reads it): the work runs as the tenant's system, after the session's own
 * checks (its party, its company, its permission).
 *
 *   1. read: what the target still asks (open > 0, euro, a payable document), the company's payment account (or why
 *      none: 409 `payment/NO_PROVIDER`), the target's live intents (CREATED, WAITING)
 *   2. a live intent of the same payer, method and amount (under a day old) is taken up again: the provider's intent is
 *      retrieved for its client secret (a double click, a reload: never two payments). Another payer's live intent under
 *      30 minutes old, or one the provider holds as processing (a SEPA debit on its way) or succeeded, is a payment under
 *      way: 409 `payment/IN_PROGRESS`. Any other live intent is cancelled at the provider (so it can never take money)
 *   3. ONE command: the target's money lock, the checks again, the cancelled ones CANCELLED, the new intent CREATED
 *   4. the provider makes its intent (gateway; our id as the idempotency key)
 *   5. ONE command: WAITING with the provider's id (`payment_intent.started`), or FAILED when the provider refused
 *      (`provider_refused` / `provider_unavailable`: 409 `payment/PROVIDER` in words)
 * The answer carries the client secret for the provider's fields on the page; it is never stored, logged or audited.
 */

export interface PayerOrigin {
  readonly tenantId: string
  /** The session's party: the target must be its own. */
  readonly partyId: string
  /** The session's company (the portal's, the link's): the target must be of it. */
  readonly companyId: string
  readonly linkId: string | null
  readonly personId: string | null
  readonly locale: OnlineLocale
}

export interface StartedPayment {
  readonly intent: IntentView
  /** What the page loads the provider's fields with; null when the intent failed at once. */
  readonly provider: { readonly name: string; readonly mode: string; readonly clientSecret: string; readonly publishableKey: string | null } | null
  readonly resumed: boolean
}

const refuse = (code: StartRefusal): DomainError => new DomainError('conflict', START_REFUSALS[code], [{ path: `payment/${code}`, message: START_REFUSALS[code] }])

/** The target the session may pay (its party's, of its company), or 404 (another party's is as unknown as a wrong id). */
export async function payableTarget(system: CommandCaller, origin: PayerOrigin, target: IntentTarget, targetId: string): Promise<TargetFacts> {
  const facts = await system.withClient((db) => targetFacts(db, target, targetId))
  if (!facts || facts.partyId !== origin.partyId || facts.companyId !== origin.companyId) throw new NotFoundError(target === 'INVOICE' ? 'Invoice not found.' : 'Deposit request not found.')
  return facts
}

const sameOrigin = (row: IntentRow, origin: PayerOrigin): boolean => (origin.linkId !== null ? row.linkId === origin.linkId : row.linkId === null && row.createdById === origin.personId)

export async function startIntent(request: FastifyRequest, origin: PayerOrigin, target: IntentTarget, targetId: string, method: IntentMethod, runtime: PaymentsRuntime = processPayments()): Promise<StartedPayment> {
  const system = systemCallerOf(request)(origin.tenantId)
  const facts = await payableTarget(system, origin, target, targetId)
  if (facts.refusal) throw refuse(facts.refusal)
  const found = await system.withClient((db) => paymentAccountFor(db, facts.companyId, runtime.environment))
  if (!found.account) throw refuse('NO_PROVIDER')
  const account = found.account
  const providerOf = (clientSecret: string) => ({ name: account.provider, mode: account.mode, clientSecret, publishableKey: account.publishableKey })
  const now = Date.now()

  // 2. The target's live intents.
  const live = await system.withClient((db) =>
    db.paymentIntent.findMany({ where: { ...(target === 'INVOICE' ? { invoiceId: targetId } : { depositRequestId: targetId }), status: { in: [...LIVE_INTENT_STATUSES] } }, select: INTENT_COLUMNS, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] }),
  )
  const mine = live.find((row) => sameOrigin(row, origin) && row.method === method && row.amount === facts.open && row.providerRef !== null && row.providerAccountId === account.id && now - row.createdAt.getTime() < RESUME_MS)
  if (mine) {
    const again = await runtime.retrieveIntent(system, mine.providerAccountId, mine.providerRef!).catch(() => null)
    if (again && again.state !== 'canceled' && again.state !== 'succeeded') return { intent: intentView(mine, origin.locale), provider: providerOf(again.clientSecret), resumed: true }
    if (again?.state === 'succeeded') throw refuse('IN_PROGRESS')
  }
  const toCancel: IntentRow[] = []
  for (const row of live) {
    if (!sameOrigin(row, origin) && now - row.createdAt.getTime() < IN_PROGRESS_MS) throw refuse('IN_PROGRESS')
    if (row.providerRef) {
      const state = await runtime.retrieveIntent(system, row.providerAccountId, row.providerRef).then((answer) => answer.state, () => null)
      if (state === 'processing' || state === 'succeeded') throw refuse('IN_PROGRESS')
      if (state !== 'canceled') await runtime.cancelIntent(system, row.providerAccountId, row.providerRef).catch(() => null)
    }
    toCancel.push(row)
  }

  // 3. The new intent, CREATED, and the replaced ones CANCELLED.
  const intentId = newId()
  await command(system, { name: 'payments.startOnline', input: { target, targetId, method, linkId: origin.linkId, personId: origin.personId } }, async (tools) => {
    await lockMoney(tools.tx, tools.context, target === 'INVOICE' ? 'invoice' : 'deposit', targetId)
    const again = await targetFacts(tools.tx, target, targetId)
    if (!again || again.refusal) throw refuse(again?.refusal ?? 'NOT_OPEN')
    const stillLive = await tools.tx.paymentIntent.findMany({ where: { ...(target === 'INVOICE' ? { invoiceId: targetId } : { depositRequestId: targetId }), status: { in: [...LIVE_INTENT_STATUSES] } }, select: { id: true } })
    const cancelling = new Set(toCancel.map((row) => row.id))
    if (stillLive.some((row) => !cancelling.has(row.id))) throw refuse('IN_PROGRESS')
    for (const row of toCancel) await finishInCommand(tools, row, 'CANCELLED', null)
    await tools.tx.paymentIntent.create({
      data: {
        id: intentId,
        companyId: again.companyId,
        partyId: again.partyId,
        ...(target === 'INVOICE' ? { invoiceId: targetId } : { depositRequestId: targetId }),
        method,
        amount: again.open,
        currency: again.currency,
        providerAccountId: account.id,
        linkId: origin.linkId,
        createdAt: tools.now,
        updatedAt: tools.now,
        createdById: origin.personId,
      },
      select: { id: true },
    })
    tools.audit({ action: 'payments.startOnline', recordType: 'PaymentIntent', recordId: intentId, companyId: again.companyId, after: { target, targetId, method, amount: markMoney('price', again.open), currency: again.currency, providerAccountId: account.id, linkId: origin.linkId, personId: origin.personId, replaced: toCancel.map((row) => row.id) } })
    return { intentId }
  })

  // 4. The provider's intent, outside any transaction.
  let made: Awaited<ReturnType<PaymentsRuntime['createIntent']>> | null = null
  let failure: 'provider_refused' | 'provider_unavailable' | null = null
  try {
    made = await runtime.createIntent(system, account.id, { intentId, tenantId: origin.tenantId, method, amount: facts.open, currency: facts.currency, description: facts.label.en })
  } catch (error) {
    const status = (error as { httpStatus?: unknown }).httpStatus
    failure = typeof status === 'number' && status >= 400 && status < 500 ? 'provider_refused' : 'provider_unavailable'
  }

  // 5. WAITING with the provider's id, or FAILED.
  await command(system, { name: 'payments.onlineStarted', input: { intentId, outcome: made ? 'WAITING' : 'FAILED' } }, async (tools) => {
    const row = (await readIntent(tools.tx, intentId))!
    if (made) {
      await tools.tx.paymentIntent.update({ where: { id: intentId }, data: { status: 'WAITING', providerRef: made.providerRef, version: { increment: 1 }, updatedAt: tools.now }, select: { id: true } })
      tools.audit({ action: 'payments.onlineStarted', recordType: 'PaymentIntent', recordId: intentId, companyId: row.companyId, before: { status: row.status }, after: { status: 'WAITING', providerRef: made.providerRef } })
    } else {
      await tools.tx.paymentIntent.update({ where: { id: intentId }, data: { status: 'FAILED', failureCode: failure, finishedAt: tools.now, version: { increment: 1 }, updatedAt: tools.now }, select: { id: true } })
      tools.audit({ action: 'payments.onlineStarted', recordType: 'PaymentIntent', recordId: intentId, companyId: row.companyId, before: { status: row.status }, after: { status: 'FAILED', failureCode: failure } })
    }
    tools.emit({ type: 'payment_intent.started', subject: intentId, companyId: row.companyId, payload: { intentId, partyId: row.partyId, ...targetOf(row), method: row.method as IntentMethod, status: made ? 'WAITING' : 'FAILED', byLink: row.linkId !== null } })
    return { intentId }
  })
  if (!made) throw refuse('PROVIDER')
  const intent = (await system.withClient((db) => readIntent(db, intentId)))!
  return { intent: intentView(intent, origin.locale), provider: providerOf(made.clientSecret), resumed: false }
}

/**
 * Inside a command: a live intent ends FAILED or CANCELLED (never SUCCEEDED here: that records a payment, webhook.ts),
 * with `payment_intent.finished`. Returns false when it was final already (nothing changes).
 */
export async function finishInCommand(tools: CommandTools, row: IntentRow, status: 'FAILED' | 'CANCELLED', failureCode: string | null): Promise<boolean> {
  const { count } = await tools.tx.paymentIntent.updateMany({
    where: { id: row.id, status: { in: [...LIVE_INTENT_STATUSES] } },
    data: { status, failureCode: status === 'FAILED' ? failureCode : null, finishedAt: tools.now, version: { increment: 1 }, updatedAt: tools.now },
  })
  if (count !== 1) return false
  tools.audit({ action: 'payments.onlineFinished', recordType: 'PaymentIntent', recordId: row.id, companyId: row.companyId, before: { status: row.status }, after: { status, failureCode: status === 'FAILED' ? failureCode : null } })
  tools.emit({ type: 'payment_intent.finished', subject: row.id, companyId: row.companyId, payload: { intentId: row.id, partyId: row.partyId, ...targetOf(row), method: row.method as IntentMethod, status, paymentId: null } })
  return true
}
