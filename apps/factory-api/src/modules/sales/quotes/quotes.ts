import type { Prisma } from '@nexus/factory-db'
import { DomainError, InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { fitsDecimal } from '@nexus/factory-domain/core/money'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { QUOTES_MANAGE, QUOTES_VIEW } from '@nexus/factory-domain/sales/quotes/permissions'
import { addDays, OPEN_BEFORE_SEND, STATUS_WORDS, validityProblem, versionTaxModeOf, type DepositKind, type QuoteStatus } from '@nexus/factory-domain/sales/quotes/quotes'
import { parseDecimal } from '@nexus/factory-domain/tax/decimal'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { allocateNumber } from '../../../platform/numbering/allocate'
import { decideTreatment, refreshVersion } from './pricing'
import { quoteRulesFor } from './rules'
import { revokeAcceptLinks } from './accept-links'
import { chainForQuote } from './list-price'
import { usableTerms } from '../terms/store'
import { termsForParty } from '../terms/terms'
import { depositOf, quoteDefaultsOf, termsNameIn } from '@nexus/factory-domain/sales/terms/terms'
import { assertMay, day, dayValue, decimal, grainsOf, officeContextOf, officeQuote, quotePartyOf, readCurrentVersion, readQuote, type QuoteParty, type QuoteRow, type VersionRow } from './store'
import { forCaller, quoteDetail, type QuoteDetail } from './views'

/**
 * Quotes (B-W1-21; SAL-143, SAL-157; A2 SCR-030, SCR-034): the list, the record, a new quote, its header and its draft
 * version's terms, and its cancellation. A quote is made for a customer of a company (never BLOCKED or ARCHIVED, and with
 * a tax identity in force: the VAT of every line depends on it), numbered from the company's QUOTE series in the same
 * command, with a first DRAFT version that takes the customer's defaults (its ORDERS contact, default invoice and
 * delivery addresses, payment terms) and the company's quote rules (validity, deposit, the margin floor). Every write is
 * ONE command on the Quote: its version is the edit-conflict guard, and its bump locks the row, so two writes to one
 * quote never interleave.
 */

const blankToNull = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())
const actorIdOf = (tools: Pick<CommandTools, 'context'>): string | null => (tools.context.audience === 'office' ? tools.context.actorId : null)

/** The record after a write, in the command (the answer of every write route). */
export async function detailInCommand(tools: CommandTools, quoteId: string): Promise<{ quote: QuoteDetail }> {
  const quote = (await readQuote(tools.tx, quoteId))!
  const context = tools.context
  if (context.audience !== 'office') throw new InvalidStateError('Quotes are written by the office.')
  return { quote: await quoteDetail(tools.tx, quote, tools.now) }
}

/**
 * A command on a quote the caller may act on with `permission`: the quote's version guards it and locks the row; the
 * work gets the quote and its current version as they are now.
 */
export async function onQuote<Result extends { quote: QuoteDetail }>(
  caller: CommandCaller,
  quote: QuoteRow,
  spec: { readonly name: `quotes.${string}`; readonly idempotencyKey: string | undefined; readonly input: unknown; readonly version: number },
  work: (tools: CommandTools, current: QuoteRow, version: VersionRow) => Promise<Result>,
): Promise<Result> {
  const context = officeContextOf(caller)
  const { result } = await command(caller, { name: spec.name, idempotencyKey: spec.idempotencyKey, input: spec.input, record: { type: 'Quote', id: quote.id, expectedVersion: spec.version } }, async (tools) => {
    const current = (await readQuote(tools.tx, quote.id))!
    return work(tools, current, await readCurrentVersion(tools.tx, current))
  })
  return forCaller(result, grainsOf(context))
}

/** Lines and terms change only while the current version is a DRAFT (the …_sales_guards triggers say so too). */
export function assertDraft(version: VersionRow): void {
  if (version.status === 'DRAFT') return
  const reopen = version.status === 'PENDING_APPROVAL' || version.status === 'APPROVED' ? ' Reopen it first: a waiting approval request is withdrawn, and an approval is asked again if a rule still breaks.' : ''
  throw new InvalidStateError(`The quote is ${STATUS_WORDS[version.status]}: its lines and terms change only while it is a draft.${reopen}`)
}

/** A quote goes only to an active customer (or a prospect): a blocked or archived one gets none (B-W1-07). */
export function assertQuotable(party: QuoteParty, path = 'body/partyId'): void {
  if (!party.isCustomer) throw new ValidationError('This party is not a customer.', [{ path, message: 'Give the party the customer (or brand) role first.' }])
  if (party.row.status === 'BLOCKED' || party.row.status === 'ARCHIVED') {
    throw new DomainError('conflict', `${party.row.legalName} is ${party.row.status.toLowerCase()}: no quote goes to it until it is active again.`, [{ path, message: `The customer is ${party.row.status}.` }])
  }
}

export interface HeaderInput {
  readonly contactId?: string | null | undefined
  readonly customerRef?: string | null | undefined
  readonly internalNote?: string | null | undefined
  readonly validUntil?: string | null | undefined
  readonly firmOffer?: boolean | undefined
  readonly promiseDate?: string | null | undefined
  readonly paymentTerms?: string | null | undefined
  /** B-W2a-19: terms from the library; their printed name (in the version's language) follows unless paymentTerms is sent. */
  readonly paymentTermsId?: string | null | undefined
  readonly termsText?: string | null | undefined
  readonly termsVersion?: string | null | undefined
  readonly depositPct?: string | null | undefined
  readonly depositKind?: DepositKind | null | undefined
  readonly billToAddressId?: string | null | undefined
  readonly shipToAddressId?: string | null | undefined
  readonly language?: 'it' | 'en' | undefined
  readonly changeNote?: string | null | undefined
}

/** The contact and addresses named must be the party's ACTIVE ones (an address of the right kind). */
async function checkPartyRefs(tools: CommandTools, partyId: string, body: HeaderInput, today: string): Promise<void> {
  const issues: Issue[] = []
  if (body.contactId) {
    const contact = await tools.tx.partyContact.findUnique({ where: { id: body.contactId }, select: { partyId: true, status: true } })
    if (!contact || contact.partyId !== partyId || contact.status !== 'ACTIVE') issues.push({ path: 'body/contactId', message: "Not an active contact of this customer." })
  }
  for (const [field, kind] of [['billToAddressId', 'BILL_TO'], ['shipToAddressId', 'SHIP_TO']] as const) {
    const addressId = body[field]
    if (!addressId) continue
    const address = await tools.tx.partyAddress.findUnique({ where: { id: addressId }, select: { partyId: true, status: true, kinds: true } })
    if (!address || address.partyId !== partyId || address.status !== 'ACTIVE') issues.push({ path: `body/${field}`, message: 'Not an active address of this customer.' })
    else if (!address.kinds.includes(kind) && !(kind === 'BILL_TO' && address.kinds.includes('REGISTERED'))) issues.push({ path: `body/${field}`, message: `The address is not a ${kind === 'BILL_TO' ? 'billing' : 'delivery'} address.` })
  }
  if (body.validUntil) {
    const problem = validityProblem(body.validUntil, today)
    if (problem) issues.push({ path: 'body/validUntil', message: problem })
  }
  if (body.promiseDate && body.promiseDate < today) issues.push({ path: 'body/promiseDate', message: 'The promise date is today or later.' })
  if (body.depositPct !== undefined && body.depositPct !== null) {
    const pct = parseDecimal(body.depositPct)
    if (pct === null || !fitsDecimal(body.depositPct, 7, 4) || pct.lte(0) || pct.gt(100)) issues.push({ path: 'body/depositPct', message: 'A deposit above 0 and at most 100 percent of the gross total, or none.' })
  }
  if (issues.length > 0) throw new ValidationError(issues.length === 1 ? issues[0]!.message : 'The quote cannot be saved.', issues)
}

// ---- create -----------------------------------------------------------------------------------------------------------

export interface CreateQuoteInput extends HeaderInput {
  readonly companyId: string
  readonly partyId: string
}

/** quotes.manage over the company and the customer: a new quote with its number and a first DRAFT version. */
export async function createQuote(caller: CommandCaller, body: CreateQuoteInput, idempotencyKey?: string): Promise<{ quote: QuoteDetail }> {
  const context = officeContextOf(caller)
  assertMay(context, QUOTES_MANAGE, { companyId: body.companyId, partyId: body.partyId }, 'Customer')
  const picked = body.paymentTermsId ? await termsForParty(caller, body.paymentTermsId, body.companyId, 'body/paymentTermsId') : null
  const { result } = await command(caller, { name: 'quotes.create', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    const today = businessDate(now)
    const company = await tx.company.findUnique({ where: { id: body.companyId }, select: { id: true, currency: true } })
    if (!company) throw new NotFoundError('Company not found.')
    const party = await quotePartyOf(tx, body.partyId, today, now)
    if (!party || (party.row.companyId !== null && party.row.companyId !== company.id)) throw new NotFoundError('Customer not found.')
    assertQuotable(party)
    decideTreatment(party)
    await checkPartyRefs(tools, party.row.id, body, today)
    const rules = await quoteRulesFor(tx, company.id)

    // The customer's defaults: its ORDERS contact with an email, its default invoice and delivery addresses.
    const contactId =
      body.contactId === undefined
        ? ((await tx.partyContact.findFirst({ where: { partyId: party.row.id, status: 'ACTIVE', roles: { has: 'ORDERS' }, email: { not: null } }, select: { id: true }, orderBy: { createdAt: 'asc' } }))?.id ?? null)
        : body.contactId
    const contact = contactId ? await tx.partyContact.findUnique({ where: { id: contactId }, select: { language: true } }) : null
    const address = async (flag: 'isDefaultBillTo' | 'isDefaultShipTo') => (await tx.partyAddress.findFirst({ where: { partyId: party.row.id, status: 'ACTIVE', [flag]: true }, select: { id: true } }))?.id ?? null
    const billToAddressId = body.billToAddressId === undefined ? await address('isDefaultBillTo') : body.billToAddressId
    const shipToAddressId = body.shipToAddressId === undefined ? await address('isDefaultShipTo') : body.shipToAddressId
    const language = body.language ?? ((contact?.language ?? party.row.language) === 'it' ? 'it' : 'en')
    // B-W2a-19 (SAL-012): the customer's commercial terms: its library terms (when its company may use them) with their
    // printed name in the document's language, its deposit (else its terms' order share, else the settings').
    const terms = picked ? await usableTerms(tx, picked.id, company.id) : body.paymentTermsId === null ? null : await usableTerms(tx, party.row.paymentTermsId, company.id)
    const defaults = quoteDefaultsOf({
      partyDepositPct: party.row.defaultDepositPct === null ? null : party.row.defaultDepositPct.toString(),
      terms,
      partyTermsText: party.row.paymentTerms,
      settingsDepositPct: rules.defaultDepositPct,
      language,
    })
    const depositPct = body.depositPct === undefined ? defaults.depositPct : blankToNull(body.depositPct)

    const id = newId()
    const issued = await allocateNumber(tools, { companyId: company.id, kind: 'QUOTE' }, { type: 'Quote', id })
    const actorId = actorIdOf(tools)
    await tx.quote.create({
      data: { id, companyId: company.id, number: issued.formatted, partyId: party.row.id, contactId, customerRef: blankToNull(body.customerRef), internalNote: blankToNull(body.internalNote), createdById: actorId },
      select: { id: true },
    })
    const versionId = newId()
    await tx.quoteVersion.create({
      data: {
        id: versionId,
        quoteId: id,
        partyId: party.row.id,
        revision: 1,
        currency: company.currency,
        language,
        taxMode: versionTaxModeOf(party.identity!.taxMode, party.viesValid),
        taxIdentityId: party.identityId,
        billToAddressId,
        shipToAddressId,
        validUntil: dayValue(body.validUntil ?? addDays(today, rules.defaultValidityDays)),
        firmOffer: body.firmOffer ?? false,
        promiseDate: body.promiseDate ? dayValue(body.promiseDate) : null,
        paymentTerms: body.paymentTerms === undefined ? defaults.paymentTerms : blankToNull(body.paymentTerms),
        paymentTermsId: defaults.paymentTermsId,
        termsText: blankToNull(body.termsText),
        termsVersion: blankToNull(body.termsVersion),
        depositPct,
        depositKind: depositPct === null ? null : (body.depositKind ?? 'ACCONTO'),
        marginFloorPct: rules.marginFloorPct,
        changeNote: blankToNull(body.changeNote),
        createdById: actorId,
      },
      select: { id: true },
    })
    const quote = (await readQuote(tx, id))!
    // SAL-165: the list version its prices come from, kept while the quote is open.
    const chain = await chainForQuote(tx, quote, { currency: company.currency, priceListVersionId: null }, party, now)
    if (chain.keptVersionId !== null) await tx.quoteVersion.update({ where: { id: versionId }, data: { priceListVersionId: chain.keptVersionId }, select: { id: true } })
    await refreshVersion(tools, quote, await readCurrentVersion(tx, quote), new Set())
    tools.audit({
      action: 'quotes.create',
      recordType: 'Quote',
      recordId: id,
      companyId: company.id,
      after: { number: issued.formatted, partyId: party.row.id, status: 'DRAFT', revision: 1, contactId, billToAddressId, shipToAddressId, depositPct, rulesSource: rules.source, paymentTermsId: defaults.paymentTermsId, listVersionId: chain.keptVersionId },
    })
    tools.emit({ type: 'quote.created', subject: id, companyId: company.id, payload: { quoteId: id, versionId, number: issued.formatted, partyId: party.row.id } })
    return detailInCommand(tools, id)
  })
  return forCaller(result, grainsOf(context))
}

// ---- the header and the draft's terms --------------------------------------------------------------------------------

const QUOTE_FIELDS = ['contactId', 'customerRef', 'internalNote'] as const
const VERSION_FIELDS = ['validUntil', 'firmOffer', 'promiseDate', 'paymentTerms', 'paymentTermsId', 'termsText', 'termsVersion', 'depositPct', 'depositKind', 'billToAddressId', 'shipToAddressId', 'language', 'changeNote'] as const

const termsOf = (version: VersionRow) => ({
  validUntil: day(version.validUntil),
  firmOffer: version.firmOffer,
  promiseDate: day(version.promiseDate),
  paymentTerms: version.paymentTerms,
  paymentTermsId: version.paymentTermsId,
  termsText: version.termsText,
  termsVersion: version.termsVersion,
  depositPct: decimal(version.depositPct),
  depositKind: version.depositKind,
  billToAddressId: version.billToAddressId,
  shipToAddressId: version.shipToAddressId,
  language: version.language,
  changeNote: version.changeNote,
})

/**
 * quotes.manage: the header (contact, customer reference, internal note) and the DRAFT version's terms (validity, firm
 * offer, promise date, payment terms, terms and conditions, deposit, addresses, language, change note). The internal
 * note alone changes in any state; anything else only while DRAFT. The totals follow (the deposit, the VAT decided again).
 */
export async function updateQuote(caller: CommandCaller, quoteId: string, body: HeaderInput & { version: number }, idempotencyKey?: string): Promise<{ quote: QuoteDetail }> {
  const quote = await officeQuote(caller, quoteId, QUOTES_MANAGE)
  const picked = body.paymentTermsId ? await termsForParty(caller, body.paymentTermsId, quote.companyId, 'body/paymentTermsId') : null
  return onQuote(caller, quote, { name: 'quotes.update', idempotencyKey, input: { quoteId, ...body }, version: body.version }, async (tools, current, version) => {
    const fields = [...QUOTE_FIELDS, ...VERSION_FIELDS].filter((field) => body[field] !== undefined)
    if (fields.length === 0) throw new ValidationError('Nothing to change.', [{ path: 'body', message: 'Send at least one field.' }])
    if (fields.some((field) => field !== 'internalNote')) assertDraft(version)
    const today = businessDate(tools.now)
    await checkPartyRefs(tools, current.partyId, body, today)
    const quoteData: Prisma.QuoteUncheckedUpdateInput = {
      ...(body.contactId !== undefined ? { contactId: body.contactId } : {}),
      ...(body.customerRef !== undefined ? { customerRef: blankToNull(body.customerRef) } : {}),
      ...(body.internalNote !== undefined ? { internalNote: blankToNull(body.internalNote) } : {}),
    }
    if (Object.keys(quoteData).length > 0) await tools.tx.quote.update({ where: { id: current.id }, data: quoteData, select: { id: true } })
    // B-W2a-19: library terms chosen (their printed name in the version's language, and their order share as the deposit
    // unless one is sent); a change of language reprints the library terms' name.
    const language = body.language ?? version.language
    const chosen = picked ? await usableTerms(tools.tx, picked.id, current.companyId) : null
    const keptTerms = body.paymentTermsId === undefined && version.paymentTermsId !== null ? await usableTerms(tools.tx, version.paymentTermsId, current.companyId) : null
    const termsText =
      body.paymentTerms !== undefined ? undefined
      : chosen ? termsNameIn(chosen, language)
      : body.paymentTermsId === null ? undefined
      : keptTerms && body.language !== undefined && version.paymentTerms === termsNameIn(keptTerms, version.language) ? termsNameIn(keptTerms, language)
      : undefined
    const termsDeposit = chosen && body.depositPct === undefined ? (depositOf(chosen.instalments)?.sharePct ?? undefined) : undefined
    const depositPct = body.depositPct === undefined ? (termsDeposit ?? decimal(version.depositPct)) : blankToNull(body.depositPct)
    const versionData: Prisma.QuoteVersionUncheckedUpdateInput = {
      ...(body.validUntil !== undefined ? { validUntil: body.validUntil === null ? null : dayValue(body.validUntil) } : {}),
      ...(body.firmOffer !== undefined ? { firmOffer: body.firmOffer } : {}),
      ...(body.promiseDate !== undefined ? { promiseDate: body.promiseDate === null ? null : dayValue(body.promiseDate) } : {}),
      ...(body.paymentTerms !== undefined ? { paymentTerms: blankToNull(body.paymentTerms) } : {}),
      ...(termsText !== undefined ? { paymentTerms: termsText } : {}),
      ...(body.paymentTermsId !== undefined ? { paymentTermsId: chosen?.id ?? null } : {}),
      ...(body.termsText !== undefined ? { termsText: blankToNull(body.termsText) } : {}),
      ...(body.termsVersion !== undefined ? { termsVersion: blankToNull(body.termsVersion) } : {}),
      ...(body.depositPct !== undefined || body.depositKind !== undefined || termsDeposit !== undefined ? { depositPct, depositKind: depositPct === null ? null : (body.depositKind ?? version.depositKind ?? 'ACCONTO') } : {}),
      ...(body.billToAddressId !== undefined ? { billToAddressId: body.billToAddressId } : {}),
      ...(body.shipToAddressId !== undefined ? { shipToAddressId: body.shipToAddressId } : {}),
      ...(body.language !== undefined ? { language: body.language } : {}),
      ...(body.changeNote !== undefined ? { changeNote: blankToNull(body.changeNote) } : {}),
    }
    if (Object.keys(versionData).length > 0) {
      await tools.tx.quoteVersion.update({ where: { id: version.id }, data: { ...versionData, version: { increment: 1 } }, select: { id: true } })
      await refreshVersion(tools, current, await readCurrentVersion(tools.tx, current), new Set())
    }
    const after = await readCurrentVersion(tools.tx, current)
    tools.audit({
      recordType: 'Quote',
      recordId: current.id,
      companyId: current.companyId,
      before: { contactId: current.contactId, customerRef: current.customerRef, internalNote: current.internalNote, ...termsOf(version) },
      after: { contactId: body.contactId === undefined ? current.contactId : body.contactId, customerRef: body.customerRef === undefined ? current.customerRef : blankToNull(body.customerRef), internalNote: body.internalNote === undefined ? current.internalNote : blankToNull(body.internalNote), ...termsOf(after) },
    })
    tools.emit({ type: 'quote.updated', subject: current.id, companyId: current.companyId, payload: { quoteId: current.id, versionId: version.id, fields } })
    return detailInCommand(tools, current.id)
  })
}

// ---- cancel -----------------------------------------------------------------------------------------------------------

/**
 * quotes.manage: the office withdraws a quote. Before it is sent (DRAFT, waiting for approval or approved → CANCELLED; a
 * waiting approval request is withdrawn with it). Once sent (B-W1-24), with a reason: the sent version is CANCELLED and
 * every accept link of the quote stops working (revoked; their evidence stays); a draft revision and the sent version
 * it would replace go together. A firm offer is not withdrawn before its last day (c.c. art. 1329).
 */
export async function cancelQuote(caller: CommandCaller, quoteId: string, body: { version: number; reason?: string | null | undefined }, idempotencyKey?: string): Promise<{ quote: QuoteDetail }> {
  const quote = await officeQuote(caller, quoteId, QUOTES_MANAGE)
  return onQuote(caller, quote, { name: 'quotes.cancel', idempotencyKey, input: { quoteId, ...body }, version: body.version }, async (tools, current, version) => {
    if (!OPEN_BEFORE_SEND.includes(version.status) && version.status !== 'SENT') throw new InvalidStateError(`The quote is ${STATUS_WORDS[version.status]}; it cannot be cancelled.`)
    const sent = await tools.tx.quoteVersion.findMany({ where: { quoteId: current.id, status: 'SENT' }, select: { id: true, revision: true, firmOffer: true, validUntil: true } })
    const reason = blankToNull(body.reason)
    if (sent.length > 0) {
      if (reason === null) throw new ValidationError('Say why the sent quote is withdrawn: the customer is told it was withdrawn.', [{ path: 'body/reason', message: 'A reason is needed once the quote was sent.' }])
      const today = businessDate(tools.now)
      const firm = sent.find((row) => row.firmOffer && row.validUntil !== null && day(row.validUntil)! >= today)
      if (firm) throw new InvalidStateError(`Version ${firm.revision} is a firm offer until ${day(firm.validUntil)} (c.c. art. 1329): it cannot be withdrawn before then.`)
    }
    const withdrawn = OPEN_BEFORE_SEND.includes(version.status) ? await withdrawPending(tools, version.id) : null
    const ids = [...new Set([version.id, ...sent.map((row) => row.id)])]
    await tools.tx.quoteVersion.updateMany({ where: { id: { in: ids } }, data: { status: 'CANCELLED', closedAt: tools.now, version: { increment: 1 } } })
    await tools.tx.quote.update({ where: { id: current.id }, data: { status: 'CANCELLED' }, select: { id: true } })
    const revokedLinkIds = sent.length > 0 ? await revokeAcceptLinks(tools, current, actorIdOf(tools)) : []
    tools.audit({
      recordType: 'Quote',
      recordId: current.id,
      companyId: current.companyId,
      before: { status: version.status },
      after: { status: 'CANCELLED', withdrawnApprovalId: withdrawn, cancelledVersionIds: ids, revokedLinkIds },
      ...(reason ? { reason } : {}),
    })
    tools.emit({ type: 'quote.cancelled', subject: current.id, companyId: current.companyId, payload: { quoteId: current.id, versionId: version.id } })
    return detailInCommand(tools, current.id)
  })
}

/** Withdraws the version's PENDING approval request, if any (inside the command). Returns its id. */
export async function withdrawPending(tools: CommandTools, versionId: string): Promise<string | null> {
  const pending = await tools.tx.quoteApproval.findFirst({ where: { versionId, status: 'PENDING' }, select: { id: true } })
  if (!pending) return null
  await tools.tx.quoteApproval.update({ where: { id: pending.id }, data: { status: 'WITHDRAWN', decidedAt: tools.now, decidedById: actorIdOf(tools), version: { increment: 1 } }, select: { id: true } })
  return pending.id
}

// ---- reads ------------------------------------------------------------------------------------------------------------

export async function getQuote(caller: CommandCaller, quoteId: string): Promise<{ quote: QuoteDetail }> {
  const context = officeContextOf(caller)
  const quote = await officeQuote(caller, quoteId)
  return forCaller({ quote: await caller.withClient((client) => quoteDetail(client, quote, serverClock.now())) }, grainsOf(context))
}

export interface ListQuotesQuery {
  readonly status?: QuoteStatus | undefined
  readonly companyId?: string | undefined
  readonly partyId?: string | undefined
  readonly mine?: 'true' | 'false' | undefined
  readonly q?: string | undefined
  readonly cursor?: string | undefined
  readonly limit: number
}

/** The quotes the caller may see (its companies and customers), newest first, with their current version's figures. */
export async function listQuotes(caller: CommandCaller, query: ListQuotesQuery) {
  const context = officeContextOf(caller)
  const where: Prisma.QuoteWhereInput = {
    AND: [
      scopeWhere(actorOf(context), QUOTES_VIEW, { company: 'companyId', party: 'partyId' }) as Prisma.QuoteWhereInput,
      query.status ? { status: query.status } : {},
      query.companyId ? { companyId: query.companyId } : {},
      query.partyId ? { partyId: query.partyId } : {},
      query.mine === 'true' ? { createdById: context.actorId } : {},
      query.q ? { OR: [{ number: { contains: query.q, mode: 'insensitive' } }, { customerRef: { contains: query.q, mode: 'insensitive' } }] } : {},
      query.cursor ? { id: { lt: query.cursor } } : {},
    ],
  }
  return caller.withClient(async (client) => {
    const rows = await client.quote.findMany({ where, orderBy: { id: 'desc' }, take: query.limit + 1, select: { id: true, number: true, companyId: true, partyId: true, contactId: true, customerRef: true, status: true, currentRevision: true, createdById: true, updatedAt: true, version: true } })
    const page = rows.slice(0, query.limit)
    const ids = page.map((row) => row.id)
    const versions = (await client.quoteVersion.findMany({ where: { quoteId: { in: ids } }, select: { id: true, quoteId: true, revision: true, currency: true, netAmount: true, grossAmount: true, marginPct: true, marginFloorBreached: true, validUntil: true, promiseDate: true } })).filter(
      (version) => page.find((row) => row.id === version.quoteId)?.currentRevision === version.revision,
    )
    const versionOf = new Map(versions.map((version) => [version.quoteId, version]))
    const versionIds = versions.map((version) => version.id)
    const lines = await client.quoteLine.findMany({ where: { versionId: { in: versionIds } }, select: { versionId: true, quantity: true } })
    const approvals = await client.quoteApproval.findMany({ where: { versionId: { in: versionIds } }, select: { versionId: true, status: true }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
    const parties = new Map((await client.party.findMany({ where: { id: { in: [...new Set(page.map((row) => row.partyId))] } }, select: { id: true, legalName: true } })).map((party) => [party.id, party.legalName]))
    return {
      quotes: page.map((row) => {
        const version = versionOf.get(row.id)
        const own = version ? lines.filter((line) => line.versionId === version.id) : []
        return {
          id: row.id,
          number: row.number,
          companyId: row.companyId,
          partyId: row.partyId,
          partyName: parties.get(row.partyId) ?? '',
          contactId: row.contactId,
          customerRef: row.customerRef,
          status: row.status,
          revision: row.currentRevision,
          lineCount: own.length,
          units: own.reduce((total, line) => total + line.quantity, 0),
          currency: version?.currency ?? 'EUR',
          netAmount: asMoney('price', version?.netAmount ?? 0),
          grossAmount: asMoney('price', version?.grossAmount ?? 0),
          marginPct: asMoney('margin', version ? decimal(version.marginPct) : null),
          marginFloorBreached: asMoney('margin', version?.marginFloorBreached ?? false),
          approval: (version ? (approvals.find((approval) => approval.versionId === version.id)?.status ?? null) : null) as 'PENDING' | 'APPROVED' | 'REJECTED' | 'WITHDRAWN' | null,
          validUntil: version ? day(version.validUntil) : null,
          promiseDate: version ? day(version.promiseDate) : null,
          createdById: row.createdById,
          updatedAt: toUtcIso(row.updatedAt),
          version: row.version,
        }
      }),
      nextCursor: rows.length > query.limit ? page[page.length - 1]!.id : null,
    }
  })
}
