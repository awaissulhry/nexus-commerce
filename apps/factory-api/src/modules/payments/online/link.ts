import type { FastifyRequest } from 'fastify'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { asMoney } from '@nexus/factory-domain/money/marked'
import type { IntentMethod, IntentTarget, OnlineLocale } from '@nexus/factory-domain/payments/online/rules'
import type { CommandCaller } from '../../../core/command'
import { systemCallerOf } from '../../../platform/files/files'
import { linkSessionOf, linkUnavailable, type LinkSession } from '../../../platform/links/authenticator'
import { companyBankDetails, instructionsFor } from '../../sales/deposits/deposits'
import { startIntent, type PayerOrigin, type StartedPayment } from './start'
import { cardOffer, INTENT_COLUMNS, intentView, paymentAccountFor, readIntent, targetFacts, type Reader, type TargetFacts } from './store'
import { processPayments } from './runtime'

/**
 * The payment page by link (B-W2b-185; FIN-123; design links.pay; SCR-199 is its screen): a PAYMENT link (an invoice or a
 * deposit request the office sent to be paid) or W1's DEPOSIT_INFO link (the deposit's bank details, now with card too).
 *
 *   GET  /payments/link/pay                   what you pay (document, for, amount due, due date, already paid), the bank
 *                                             transfer (always), card and SEPA (offered, or why not in words), the latest
 *                                             payment started from this link; reading uses nothing
 *   POST /payments/link/pay/intents {method}  start paying by card or SEPA (./start.ts): the link's own record only; the
 *                                             answer carries the client secret for the provider's fields
 *   GET  /payments/link/pay/intents/:id       how a payment of this link stands ("Waiting for your bank…", Paid, the reason
 *                                             it failed): the page polls it; the provider's webhook moves it even when the
 *                                             person closed the provider's window
 * The link's session reads its party's record (row-level security); what it cannot read (the company's bank account, the
 * credit notes and allocations behind the open amount, the payment account) is read in the tenant's system scope, for the
 * link's own record only. Starting a payment does not use the link (a declined card is tried again): the intent names the
 * link it came from.
 */

const PAYABLE_PURPOSES = new Set(['PAYMENT', 'DEPOSIT_INFO'])

function linkTarget(link: LinkSession): { readonly target: IntentTarget; readonly targetId: string } {
  if (!PAYABLE_PURPOSES.has(link.purpose)) throw linkUnavailable()
  if (link.record.type === 'Invoice' && link.purpose === 'PAYMENT') return { target: 'INVOICE', targetId: link.record.id }
  if (link.record.type === 'DepositRequest') return { target: 'DEPOSIT_REQUEST', targetId: link.record.id }
  throw linkUnavailable()
}

const localeOf = (language: string | null | undefined): OnlineLocale => (language === 'en' ? 'en' : 'it')

/** The bank transfer of a target (W1's words for a deposit; the invoice's IBAN or the company's account for an invoice). */
export async function bankTransferOf(db: Reader, facts: TargetFacts, locale: OnlineLocale) {
  if (facts.deposit) {
    const document = facts.orderNumber ?? facts.quoteDocument ?? ''
    const instructions = await instructionsFor(db, { companyId: facts.companyId, amount: facts.open > 0 ? facts.open : facts.total, currency: facts.currency, dueDate: facts.deposit.dueDate, kind: facts.deposit.kind as Parameters<typeof instructionsFor>[1]['kind'] }, document, locale)
    return { method: 'BANK_TRANSFER' as const, amount: asMoney('price', instructions.amount), currency: instructions.currency, dueDate: instructions.dueDate, reference: instructions.reference, bank: instructions.bank, text: instructions.text }
  }
  const company = await companyBankDetails(db, facts.companyId)
  const legal = await db.company.findUnique({ where: { id: facts.companyId }, select: { legalName: true } })
  const bank = facts.iban ? { accountHolder: company?.accountHolder ?? legal?.legalName ?? '', iban: facts.iban, bic: facts.iban === company?.iban ? company.bic : null, bankName: facts.iban === company?.iban ? company.bankName : null } : company
  const reference = locale === 'it' ? `Fattura ${facts.number ?? ''}` : `Invoice ${facts.number ?? ''}`
  const amount = `${(facts.open / 100).toFixed(2)} ${facts.currency}`
  const to = bank ? (locale === 'it' ? ` sul conto intestato a ${bank.accountHolder}, IBAN ${bank.iban}` : ` to the account of ${bank.accountHolder}, IBAN ${bank.iban}`) : ''
  const text =
    locale === 'it'
      ? `Bonifico bancario di ${amount}${facts.dueDate ? ` entro il ${facts.dueDate.split('-').reverse().join('/')}` : ''}${to}, causale «${reference}».${bank ? '' : ' Le coordinate bancarie sono sulla fattura.'}`
      : `Bank transfer of ${amount}${facts.dueDate ? ` by ${facts.dueDate}` : ''}${to}, reference "${reference}".${bank ? '' : ' The bank details are on the invoice.'}`
  return { method: 'BANK_TRANSFER' as const, amount: asMoney('price', facts.open), currency: facts.currency, dueDate: facts.dueDate, reference, bank, text }
}

export const whatView = (facts: TargetFacts, locale: OnlineLocale) => ({
  target: facts.target,
  id: facts.id,
  label: facts.label[locale],
  number: facts.number,
  orderNumber: facts.orderNumber,
  quoteDocument: facts.quoteDocument,
  issueDate: facts.issueDate,
  dueDate: facts.dueDate,
  currency: facts.currency,
  total: asMoney('price', facts.total),
  settled: asMoney('price', facts.settled),
  open: asMoney('price', facts.open),
})

/** The link's record, read in its own scope first (another party's is behind the wall), then its facts as the system. */
async function linkFacts(request: FastifyRequest): Promise<{ link: LinkSession; system: CommandCaller; facts: TargetFacts; locale: OnlineLocale }> {
  const link = linkSessionOf(request)
  const { target, targetId } = linkTarget(link)
  const own = await request.withClient((client) => (target === 'INVOICE' ? client.invoice.findUnique({ where: { id: targetId }, select: { id: true } }) : client.depositRequest.findUnique({ where: { id: targetId }, select: { id: true } })))
  if (!own) throw linkUnavailable()
  const system = systemCallerOf(request)(link.tenantId)
  const facts = await system.withClient((db) => targetFacts(db, target, targetId))
  if (!facts || facts.partyId !== link.partyId || facts.companyId !== link.companyId) throw linkUnavailable()
  const party = await system.withClient((db) => db.party.findUnique({ where: { id: link.partyId }, select: { language: true } }))
  return { link, system, facts, locale: localeOf(party?.language) }
}

export async function linkPayPage(request: FastifyRequest) {
  const { link, system, facts, locale } = await linkFacts(request)
  const runtime = processPayments()
  return system.withClient(async (db) => {
    const latest = await db.paymentIntent.findFirst({ where: { linkId: link.id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: INTENT_COLUMNS })
    const company = await db.company.findUnique({ where: { id: facts.companyId }, select: { legalName: true, tradeName: true } })
    const status = facts.open > 0 && facts.refusal === null ? ('TO_PAY' as const) : facts.settled > 0 && (facts.status === 'PAID' || facts.open === 0) ? ('PAID' as const) : ('CLOSED' as const)
    return {
      what: whatView(facts, locale),
      status,
      bank: status === 'TO_PAY' ? await bankTransferOf(db, facts, locale) : null,
      card: status === 'TO_PAY' ? cardOffer(await paymentAccountFor(db, facts.companyId, runtime.environment), locale) : cardOffer({ account: null, refusal: 'NO_ACCOUNT' }, locale),
      intent: latest ? intentView(latest, locale) : null,
      from: { legalName: company?.legalName ?? '', tradeName: company?.tradeName ?? null },
      language: locale,
      expiresAt: toUtcIso(link.expiresAt),
      live: { poll: 'GET /payments/link/pay/intents/:intentId' as const },
    }
  })
}

export async function linkStart(request: FastifyRequest, method: IntentMethod): Promise<StartedPayment> {
  const { link, facts, locale } = await linkFacts(request)
  const origin: PayerOrigin = { tenantId: link.tenantId, partyId: link.partyId, companyId: link.companyId, linkId: link.id, personId: null, locale }
  return startIntent(request, origin, facts.target, facts.id, method)
}

export async function linkIntent(request: FastifyRequest, intentId: string) {
  const { link, system, locale } = await linkFacts(request)
  const row = await system.withClient((db) => readIntent(db, intentId))
  if (!row || row.linkId !== link.id) throw new NotFoundError('Payment not found.')
  return { intent: intentView(row, locale) }
}
