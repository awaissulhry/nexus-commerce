import type { FactoryClient } from '@nexus/factory-db'
import { DomainError, ForbiddenError, InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { asMoney, markMoney } from '@nexus/factory-domain/money/marked'
import { companyTermsProblems, termsInForce, type TermsInForce } from '@nexus/factory-domain/parties/company-terms/terms'
import { PARTIES_MANAGE, PARTIES_VIEW } from '@nexus/factory-domain/parties/permissions'
import { isCustomer, type PartyRole } from '@nexus/factory-domain/parties/rules'
import { decimalText } from '@nexus/factory-domain/product/units/units'
import { PRICE_LISTS_MANAGE, PRICE_LISTS_VIEW } from '@nexus/factory-domain/sales/pricelists/permissions'
import { command, type CommandCaller, type CommandTx } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { listProblemFor } from '../../sales/pricelists/lists'
import { LIST_COLUMNS, mayOnList } from '../../sales/pricelists/store'
import { termsForParty } from '../../sales/terms/terms'
import { assertWritable, contextOf, lockParty, readParty, type PartyRowData } from '../store'
import { companyTermsRow, TERMS_COLUMNS, type TermsRow } from './in-force'

/**
 * A customer's terms with one of our companies (B-W2b-290; SAL-028, SAL-013; design sales.customers record › Tax & terms ›
 * Commercial terms, "Customer PO number required"; rules factory-domain parties/company-terms): the terms of a tenant-wide
 * customer differ per company of the group; the party's own columns (W1, W2a) stay the default for every company without a
 * row. One live PartyCompanyTerms row per party and company: made, changed in place (its version guards the change), ended
 * (back to the party's own); the ended rows are the history.
 *
 * Who: parties.view to read, parties.manage to write, each over the party AND the company the terms are for (a person of
 * company A keeps A's terms with a shared customer, never B's); a price list given also needs pricelists.manage on it.
 *
 * Read by (one line each in their module): a new quote of the company (modules/sales/quotes quotes.ts: payment terms and
 * deposit), its prices (quotes/list-price.ts chainForQuote: the price list), a typed order (sales/orders manual.ts), and the
 * PO number check at confirm (holds/stops.ts `orderStopsFor`). The credit limit on the row is B-W2b-304's: shown here with
 * the price grain, never written.
 */

type Reader = FactoryClient | CommandTx

// ---- the read --------------------------------------------------------------------------------------------------------

const COMPANY_COLUMNS = { id: true, code: true, legalName: true, tradeName: true } as const

async function namesOf(db: Reader, ids: readonly (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))]
  if (wanted.length === 0) return new Map()
  return new Map((await db.user.findMany({ where: { id: { in: wanted } }, select: { id: true, displayName: true } })).map((row) => [row.id, row.displayName]))
}

function termsViewOf(row: TermsRow, names: ReadonlyMap<string, string>, labels: { terms: Map<string, { code: string; name: string }>; lists: Map<string, { code: string; name: string }> }) {
  return {
    id: row.id,
    companyId: row.companyId,
    paymentTermsId: row.paymentTermsId,
    paymentTermsLabel: row.paymentTermsId ? (labels.terms.get(row.paymentTermsId) ?? null) : null,
    paymentTermsText: row.paymentTerms,
    priceListId: row.priceListId,
    priceListLabel: row.priceListId ? (labels.lists.get(row.priceListId) ?? null) : null,
    depositPct: row.depositPct === null ? null : decimalText(row.depositPct.toString()),
    poNumberRequired: row.poNumberRequired,
    /** B-W2b-304's (credit limits): shown with the price grain, never written here. */
    creditLimitAmount: asMoney('price', row.creditLimitAmount),
    creditLimitCurrency: row.creditLimitCurrency,
    setBy: row.updatedById ? (names.get(row.updatedById) ?? null) : null,
    setAt: toUtcIso(row.updatedAt),
    endedAt: row.endedAt ? toUtcIso(row.endedAt) : null,
    endedBy: row.endedById ? (names.get(row.endedById) ?? null) : null,
    version: row.version,
  }
}
export type CompanyTermsView = ReturnType<typeof termsViewOf>

const inForceView = (terms: TermsInForce) => ({
  paymentTermsId: terms.paymentTermsId,
  paymentTermsText: terms.paymentTerms,
  priceListId: terms.priceListId,
  depositPct: terms.depositPct === null ? null : decimalText(terms.depositPct),
  poNumberRequired: terms.poNumberRequired,
  source: { ...terms.source },
})

const PARTY_TERMS = { id: true, code: true, companyId: true, roles: true, status: true, currency: true, paymentTerms: true, paymentTermsId: true, priceListId: true, defaultDepositPct: true, version: true } as const

/** Every company the caller sees this party with: its live terms there (or none: the party's own), what is in force, the ended rows. */
export async function companyTermsOf(db: Reader, context: OfficeContext, partyId: string) {
  const party = await db.party.findUniqueOrThrow({ where: { id: partyId }, select: PARTY_TERMS })
  const actor = actorOf(context)
  const companies = (await db.company.findMany({ where: { status: 'ACTIVE', ...(party.companyId ? { id: party.companyId } : {}) }, select: COMPANY_COLUMNS, orderBy: [{ code: 'asc' }] })).filter((company) =>
    can(actor, PARTIES_VIEW, { companyId: company.id, partyId }),
  )
  const rows = await db.partyCompanyTerms.findMany({ where: { partyId, companyId: { in: companies.map((company) => company.id) } }, select: TERMS_COLUMNS, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
  const names = await namesOf(db, rows.flatMap((row) => [row.updatedById, row.endedById]))
  const termIds = [...new Set(rows.flatMap((row) => (row.paymentTermsId ? [row.paymentTermsId] : [])))]
  const listIds = [...new Set(rows.flatMap((row) => (row.priceListId ? [row.priceListId] : [])))]
  const labels = {
    terms: new Map((termIds.length > 0 ? await db.paymentTerms.findMany({ where: { id: { in: termIds } }, select: { id: true, code: true, name: true } }) : []).map((row) => [row.id, { code: row.code, name: row.name }])),
    lists: new Map((listIds.length > 0 ? await db.priceList.findMany({ where: { id: { in: listIds } }, select: { id: true, code: true, name: true } }) : []).map((row) => [row.id, { code: row.code, name: row.name }])),
  }
  return {
    partyId: party.id,
    code: party.code,
    tenantWide: party.companyId === null,
    partyVersion: party.version,
    companies: companies.map((company) => {
      const mine = rows.filter((row) => row.companyId === company.id)
      const live = mine.find((row) => row.endedAt === null) ?? null
      return {
        company: { id: company.id, code: company.code, name: company.tradeName ?? company.legalName },
        terms: live ? termsViewOf(live, names, labels) : null,
        inForce: inForceView(termsInForce(party, live)),
        mayChange: can(actor, PARTIES_MANAGE, { companyId: company.id, partyId }),
        history: mine.filter((row) => row.endedAt !== null).map((row) => termsViewOf(row, names, labels)),
      }
    }),
  }
}
export type PartyCompanyTermsView = Awaited<ReturnType<typeof companyTermsOf>>

/** GET /parties/:partyId/company-terms (parties.view). */
export async function getCompanyTerms(caller: CommandCaller, partyId: string): Promise<{ terms: PartyCompanyTermsView }> {
  const context = officeOf(caller)
  await readParty(caller, partyId)
  return caller.withClient(async (client) => ({ terms: await companyTermsOf(client, context, partyId) }))
}

// ---- the writes ------------------------------------------------------------------------------------------------------

function officeOf(caller: CommandCaller): OfficeContext {
  const context = contextOf(caller)
  if (context.audience !== 'office') throw new ForbiddenError()
  return context
}

/** The caller may keep this party's terms with this company: parties.manage over both, and the company is one of the party's. */
async function checkTarget(caller: CommandCaller, partyId: string, companyId: string): Promise<{ context: OfficeContext; party: PartyRowData; company: { id: string; code: string } }> {
  const context = officeOf(caller)
  const party = await readParty(caller, partyId)
  const company = isUuid(companyId) ? await caller.withClient((client) => client.company.findUnique({ where: { id: companyId }, select: { id: true, code: true, status: true } })) : null
  if (!company || !can(actorOf(context), PARTIES_VIEW, { companyId: company.id, partyId })) throw new NotFoundError('Company not found.')
  if (!can(actorOf(context), PARTIES_MANAGE, { companyId: company.id, partyId })) throw new ForbiddenError(`You may not change ${party.code}'s terms with ${company.code}.`)
  if (party.companyId !== null && party.companyId !== company.id) {
    throw new ValidationError(`${party.code} is a customer of one company only: its terms are its own (Commercial terms).`, [{ path: 'params/companyId', message: "Terms per company are for a customer of every company; this one's company is another." }])
  }
  if (!isCustomer(party.roles as PartyRole[])) throw new InvalidStateError(`${party.code} is not a customer: terms per company are a customer's.`)
  assertWritable(party.status)
  return { context, party, company }
}

export interface CompanyTermsBody {
  /** The live row's version; required when the company has terms already (absent: make them). */
  readonly version?: number | undefined
  readonly paymentTermsId?: string | null | undefined
  readonly paymentTerms?: string | null | undefined
  readonly priceListId?: string | null | undefined
  readonly depositPct?: string | null | undefined
  readonly poNumberRequired?: boolean | undefined
}

const FIELDS = ['paymentTermsId', 'paymentTerms', 'priceListId', 'depositPct', 'poNumberRequired'] as const
type Field = (typeof FIELDS)[number]

const blankToNull = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())

const fieldsOf = (row: Pick<TermsRow, Field> | null) => ({
  paymentTermsId: row?.paymentTermsId ?? null,
  paymentTerms: row?.paymentTerms ?? null,
  priceListId: row?.priceListId ?? null,
  depositPct: row?.depositPct === null || row?.depositPct === undefined ? null : decimalText(row.depositPct.toString()),
  poNumberRequired: row?.poNumberRequired ?? false,
})
type Fields = ReturnType<typeof fieldsOf>
/** Audit values: the price list as `listId`. */
const auditOf = (fields: Fields) => ({ paymentTermsId: fields.paymentTermsId, paymentTerms: fields.paymentTerms, listId: fields.priceListId, depositPct: fields.depositPct, poNumberRequired: fields.poNumberRequired })

async function checkList(tx: CommandTx, context: OfficeContext, listId: string, party: { companyId: string; currency: string; code: string }): Promise<Issue | null> {
  const list = isUuid(listId) ? await tx.priceList.findUnique({ where: { id: listId }, select: LIST_COLUMNS }) : null
  const path = 'body/priceListId'
  if (!list || !mayOnList(context, PRICE_LISTS_VIEW, list.companyId)) return { path, message: 'Not a price list you may see.' }
  if (!mayOnList(context, PRICE_LISTS_MANAGE, list.companyId)) return { path, message: `You may not give customers ${list.code}: that needs the right to keep price lists.` }
  const problem = listProblemFor(list, party)
  return problem ? { path, message: problem } : null
}

/**
 * PUT /parties/:partyId/company-terms/:companyId (parties.manage over the party and the company): the company's terms with
 * this customer, made (no `version`) or changed (the live row's `version`), the fields sent; null = the party's own.
 */
export async function setCompanyTerms(caller: CommandCaller, partyId: string, companyId: string, body: CompanyTermsBody, idempotencyKey?: string): Promise<{ terms: PartyCompanyTermsView }> {
  const { context, party, company } = await checkTarget(caller, partyId, companyId)
  const sent = FIELDS.filter((field) => body[field] !== undefined)
  if (sent.length === 0) throw new ValidationError('Nothing to change.', [{ path: 'body', message: 'Send at least one field.' }])
  const problems = companyTermsProblems(body).map((issue) => ({ path: `body/${issue.path}`, message: issue.message }))
  if (problems.length > 0) throw new ValidationError(problems.length === 1 ? problems[0]!.message : 'The terms are not valid.', problems)
  if (body.paymentTermsId) await termsForParty(caller, body.paymentTermsId, company.id, 'body/paymentTermsId')
  const live = await caller.withClient((client) => companyTermsRow(client, partyId, company.id))
  if (live && body.version === undefined) throw new DomainError('conflict', `${party.code} has terms with ${company.code} already: send their version to change them.`, [{ path: 'body/version', message: `The terms are at version ${live.version}.` }])
  if (!live && body.version !== undefined) throw new DomainError('conflict', `${party.code} has no terms with ${company.code} any more: reload them.`, [{ path: 'body/version', message: 'No live terms.' }])

  const spec = live
    ? { name: 'parties.setCompanyTerms' as const, idempotencyKey, input: { partyId, companyId, ...body }, record: { type: 'PartyCompanyTerms' as const, id: live.id, expectedVersion: body.version! } }
    : { name: 'parties.setCompanyTerms' as const, idempotencyKey, input: { partyId, companyId, ...body } }
  await command(caller, spec, async (tools) => {
    const { tx, now } = tools
    const locked = await lockParty(tx, partyId)
    assertWritable(locked.status)
    // Under the party's lock: two first writes of one company never both make a row (the partial unique holds it too).
    const current = await companyTermsRow(tx, partyId, company.id)
    if ((current?.id ?? null) !== (live?.id ?? null)) throw new DomainError('conflict', `${party.code}'s terms with ${company.code} changed meanwhile: reload them and apply the change again.`, [{ path: 'body/version', message: 'Changed meanwhile.' }])
    const before = fieldsOf(current)
    const next: Fields = {
      paymentTermsId: body.paymentTermsId === undefined ? before.paymentTermsId : body.paymentTermsId,
      paymentTerms: body.paymentTerms === undefined ? before.paymentTerms : blankToNull(body.paymentTerms),
      priceListId: body.priceListId === undefined ? before.priceListId : body.priceListId,
      depositPct: body.depositPct === undefined ? before.depositPct : body.depositPct === null ? null : decimalText(body.depositPct),
      poNumberRequired: body.poNumberRequired ?? before.poNumberRequired,
    }
    const changed = FIELDS.filter((field: Field) => String(next[field]) !== String(before[field]))
    if (next.paymentTermsId !== null && changed.includes('paymentTermsId')) {
      await tx.$queryRaw`SELECT id FROM "PaymentTerms" WHERE id = ${next.paymentTermsId}::uuid FOR SHARE`
      const terms = await tx.paymentTerms.findUnique({ where: { id: next.paymentTermsId }, select: { status: true, code: true } })
      if (terms?.status !== 'ACTIVE') throw new ValidationError(`${terms?.code ?? 'These terms'} were just archived.`, [{ path: 'body/paymentTermsId', message: 'Archived payment terms.' }])
    }
    if (next.priceListId !== null && changed.includes('priceListId')) {
      await tx.$queryRaw`SELECT id FROM "PriceList" WHERE id = ${next.priceListId}::uuid FOR SHARE`
      const issue = await checkList(tx, context, next.priceListId, { companyId: company.id, currency: party.currency, code: party.code })
      if (issue) throw new ValidationError(issue.message, [issue])
    }
    const id = current?.id ?? newId()
    if (current) {
      if (changed.length > 0) {
        await tx.partyCompanyTerms.update({
          where: { id },
          data: { paymentTermsId: next.paymentTermsId, paymentTerms: next.paymentTerms, priceListId: next.priceListId, depositPct: next.depositPct, poNumberRequired: next.poNumberRequired, updatedById: context.actorId, updatedAt: now },
          select: { id: true },
        })
      }
    } else {
      await tx.partyCompanyTerms.create({
        data: { id, partyId, companyId: company.id, paymentTermsId: next.paymentTermsId, paymentTerms: next.paymentTerms, priceListId: next.priceListId, depositPct: next.depositPct, poNumberRequired: next.poNumberRequired, updatedById: context.actorId, createdById: context.actorId, createdAt: now, updatedAt: now },
        select: { id: true },
      })
    }
    tools.audit({ action: 'parties.setCompanyTerms', recordType: 'PartyCompanyTerms', recordId: id, companyId: company.id, before: current ? { partyId, ...auditOf(before) } : null, after: { partyId, ...auditOf(next) } })
    tools.emit({ type: 'party.company_terms_changed', subject: partyId, companyId: company.id, payload: { partyId, code: party.code, companyId: company.id, termsId: id, change: 'SET', fields: current ? [...changed] : FIELDS.filter((field) => body[field] !== undefined) } })
    return { id }
  })
  return getCompanyTerms(caller, partyId)
}

/** POST /parties/:partyId/company-terms/:companyId/end (parties.manage): the company goes back to the party's own terms. */
export async function endCompanyTerms(caller: CommandCaller, partyId: string, companyId: string, body: { readonly version: number }, idempotencyKey?: string): Promise<{ terms: PartyCompanyTermsView }> {
  const { context, party, company } = await checkTarget(caller, partyId, companyId)
  const live = await caller.withClient((client) => companyTermsRow(client, partyId, company.id))
  if (!live) throw new NotFoundError(`${party.code} has no terms of its own with ${company.code}: the party's own apply already.`)
  // The credit limit (B-W2b-304) lives on the same row: ending it would drop the limit without a word.
  if (live.creditLimitAmount !== null) {
    throw new DomainError('conflict', `${party.code}'s terms with ${company.code} carry its credit limit: clear the fields to use the party's own terms instead (the limit stays).`, [{ path: 'body', message: 'A credit limit is set on these terms.' }])
  }
  await command(caller, { name: 'parties.endCompanyTerms', idempotencyKey, input: { partyId, companyId, ...body }, record: { type: 'PartyCompanyTerms', id: live.id, expectedVersion: body.version } }, async (tools) => {
    const { tx, now } = tools
    await lockParty(tx, partyId)
    await tx.partyCompanyTerms.update({ where: { id: live.id }, data: { endedAt: now, endedById: context.actorId, updatedAt: now }, select: { id: true } })
    tools.audit({ action: 'parties.endCompanyTerms', recordType: 'PartyCompanyTerms', recordId: live.id, companyId: company.id, before: { partyId, ...auditOf(fieldsOf(live)), creditLimit: markMoney('price', live.creditLimitAmount) }, after: { endedAt: toUtcIso(now) } })
    tools.emit({ type: 'party.company_terms_changed', subject: partyId, companyId: company.id, payload: { partyId, code: party.code, companyId: company.id, termsId: live.id, change: 'ENDED', fields: [] } })
    return { id: live.id }
  })
  return getCompanyTerms(caller, partyId)
}
