import { ValidationError } from '@nexus/factory-domain/core/errors'
import { businessDate } from '@nexus/factory-domain/core/time'
import { euroEquivalentOf, INVOICE_CURRENCY_RULE, languageProblem, typedRateProblems } from '@nexus/factory-domain/invoicing/language-currency/language-currency'
import { INVOICES_MANAGE } from '@nexus/factory-domain/invoicing/permissions'
import { EURO } from '@nexus/factory-domain/money/currency/currencies'
import { normalRate, rateWords } from '@nexus/factory-domain/money/currency/rates'
import { asMoney } from '@nexus/factory-domain/money/marked'
import type { CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { dayRate, noRateWords } from '../../../platform/currency/service'
import { onDraft } from '../drafts'
import { officeInvoice, readInvoice, type InvoiceRow, type Reader } from '../store'
import { refusingInWords } from '../tax-codes/store'
import { draftLanguageFor, languageAndRateOf } from './store'

/**
 * The invoice's language and currency (B-W2b-396; FIN-063 "Invoice language and currency"; PLT-131):
 *
 *   GET /invoicing/invoices/:invoiceId/language-currency   what it is written in (its own, else what a draft takes: the
 *        invoices contact's language, else the customer's), its currency and the company's, the rate it keeps (TYPED by
 *        the office on a draft, KEPT from the issue on) or the day's rate the issue would take (DAY_RATE, B-W2b-389), its
 *        euro equivalent at that rate, what waits when there is no rate (invoices.view);
 *   PUT  …/language   a draft's language, or null to decide it again (invoices.manage);
 *   PUT  …/rate       a draft's own rate and its day (the trio exchangeRate + rateDate + totalEur written together, the
 *        database's rule), or null to let the issue take the day's rate (invoices.manage).
 * Each write is ONE command on the DRAFT (its version guards it; an issued invoice never changes), audited, with W1's
 * invoice.draft_saved. The issue (issue.ts) writes the trio again from the rate at its day: a typed rate stays the
 * override, the euro total follows the final gross.
 */

async function viewOf(db: Reader, invoice: InvoiceRow) {
  const kept = (await languageAndRateOf(db, invoice.id))!
  const decided = await draftLanguageFor(db, invoice.buyerPartyId)
  const company = await db.company.findUnique({ where: { id: invoice.companyId }, select: { currency: true } })
  const today = businessDate(serverClock.now())
  let rate: { exchangeRate: string; rateDate: string; source: 'TYPED' | 'KEPT' | 'DAY_RATE'; words: string } | null = null
  let waits: string | null = null
  if (invoice.currency !== EURO) {
    if (kept.exchangeRate && kept.rateDate) {
      rate = { exchangeRate: kept.exchangeRate, rateDate: kept.rateDate, source: invoice.status === 'DRAFT' ? 'TYPED' : 'KEPT', words: rateWords({ base: EURO, quote: invoice.currency, rate: kept.exchangeRate }) }
    } else if (invoice.status === 'DRAFT') {
      const day = await dayRate(db, EURO, invoice.currency, today)
      if (day) rate = { exchangeRate: day.rate, rateDate: day.rateDate, source: 'DAY_RATE', words: rateWords(day) }
      else waits = `The invoice is in ${invoice.currency}: an Italian invoice also keeps its total in euro at a named rate. ${noRateWords(EURO, invoice.currency, today)}`
    } else {
      waits = `Issued before the rates were kept: invoice ${invoice.number} in ${invoice.currency} names no rate.`
    }
  }
  return {
    invoiceId: invoice.id,
    version: invoice.version,
    status: invoice.status,
    language: { code: kept.source === 'INVOICE' ? kept.language : decided.language, source: kept.source === 'INVOICE' ? ('INVOICE' as const) : decided.source, decided: { code: decided.language, source: decided.source } },
    currency: { code: invoice.currency, companyCurrency: company?.currency ?? EURO, euro: invoice.currency === EURO },
    rate,
    euro: asMoney('price', rate ? euroEquivalentOf(invoice, rate.exchangeRate) : null),
    waits,
    rule: { status: INVOICE_CURRENCY_RULE.status, words: INVOICE_CURRENCY_RULE.words },
  }
}

/** GET …/language-currency (invoices.view). */
export async function languageCurrency(caller: CommandCaller, invoiceId: string) {
  const invoice = await officeInvoice(caller, invoiceId)
  return caller.withClient(async (client) => ({ languageCurrency: await viewOf(client, invoice) }))
}

/** PUT …/language (invoices.manage): a draft's language, or null to decide it again. */
export async function putLanguage(caller: CommandCaller, invoiceId: string, body: { version?: number | undefined; language: string | null }, idempotencyKey?: string) {
  const invoice = await officeInvoice(caller, invoiceId, INVOICES_MANAGE)
  const asked = body.language === null ? null : body.language.toLowerCase()
  const problem = asked === null ? null : languageProblem(asked, 'body/language')
  if (problem) throw new ValidationError(problem.message, [problem])
  return refusingInWords(() =>
    onDraft(caller, invoice, { name: 'invoices.setLanguage', idempotencyKey, input: { invoiceId, ...body }, version: body.version }, async (tools, current) => {
      const before = (await tools.tx.invoice.findUnique({ where: { id: current.id }, select: { language: true } }))!.language
      const language = asked ?? (await draftLanguageFor(tools.tx, current.buyerPartyId)).language
      await tools.tx.invoice.update({ where: { id: current.id }, data: { language, updatedAt: tools.now }, select: { id: true } })
      tools.audit({ recordType: 'Invoice', recordId: current.id, companyId: current.companyId, before: { language: before }, after: { language, decided: asked === null } })
      tools.emit({ type: 'invoice.draft_saved', subject: current.id, companyId: current.companyId, payload: { invoiceId: current.id, docType: current.docType, created: false } })
      return { languageCurrency: await viewOf(tools.tx, (await readInvoice(tools.tx, current.id))!) }
    }),
  )
}

/** PUT …/rate (invoices.manage): a draft's own rate and its day, or null to let the issue take the day's rate. */
export async function putRate(caller: CommandCaller, invoiceId: string, body: { version?: number | undefined; exchangeRate: string | null; rateDate?: string | undefined }, idempotencyKey?: string) {
  const invoice = await officeInvoice(caller, invoiceId, INVOICES_MANAGE)
  const today = businessDate(serverClock.now())
  if (body.exchangeRate !== null) {
    const issues = body.rateDate === undefined ? [{ path: 'body/rateDate', message: "Send the rate's day with the rate." }] : typedRateProblems(invoice.currency, { exchangeRate: body.exchangeRate, rateDate: body.rateDate }, today)
    if (issues.length > 0) throw new ValidationError(issues[0]!.message, issues)
  } else if (body.rateDate !== undefined) {
    throw new ValidationError("A rate's day goes with a rate.", [{ path: 'body/rateDate', message: 'Send it with the rate, or neither.' }])
  }
  return refusingInWords(() =>
    onDraft(caller, invoice, { name: 'invoices.setRate', idempotencyKey, input: { invoiceId, ...body }, version: body.version }, async (tools, current) => {
      const before = await languageAndRateOf(tools.tx, current.id)
      if (body.exchangeRate === null) {
        await tools.tx.invoice.update({ where: { id: current.id }, data: { exchangeRate: null, rateDate: null, totalEur: null, updatedAt: tools.now }, select: { id: true } })
      } else {
        const exchangeRate = normalRate(body.exchangeRate)!
        const totalEur = euroEquivalentOf(current, exchangeRate).grossEur
        await tools.tx.invoice.update({ where: { id: current.id }, data: { exchangeRate, rateDate: new Date(`${body.rateDate!}T00:00:00.000Z`), totalEur, updatedAt: tools.now }, select: { id: true } })
      }
      tools.audit({
        recordType: 'Invoice',
        recordId: current.id,
        companyId: current.companyId,
        before: { exchangeRate: before?.exchangeRate ?? null, rateDate: before?.rateDate ?? null },
        after: { exchangeRate: body.exchangeRate === null ? null : normalRate(body.exchangeRate), rateDate: body.rateDate ?? null, currency: current.currency },
      })
      tools.emit({ type: 'invoice.draft_saved', subject: current.id, companyId: current.companyId, payload: { invoiceId: current.id, docType: current.docType, created: false } })
      return { languageCurrency: await viewOf(tools.tx, (await readInvoice(tools.tx, current.id))!) }
    }),
  )
}
