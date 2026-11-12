import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { poNumberProblem, termsInForce } from '@nexus/factory-domain/parties/company-terms/terms'
import type { CommandTx } from '../../../core/command'
import type { QuoteParty } from '../../sales/quotes/store'

/**
 * The terms a party works with at one of our companies (B-W2b-290; SAL-028, SAL-013), for the modules that copy "the
 * customer's defaults": its live PartyCompanyTerms row there over its own columns (factory-domain parties/company-terms
 * `termsInForce`). Office and system scopes only (the partner and the floor read no terms row). One small file, so a
 * quote's pricing does not load the terms' routes.
 */

export const TERMS_COLUMNS = {
  id: true,
  partyId: true,
  companyId: true,
  paymentTerms: true,
  paymentTermsId: true,
  priceListId: true,
  depositPct: true,
  poNumberRequired: true,
  creditLimitAmount: true,
  creditLimitCurrency: true,
  updatedById: true,
  endedAt: true,
  endedById: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.PartyCompanyTermsSelect
export type TermsRow = Prisma.PartyCompanyTermsGetPayload<{ select: typeof TERMS_COLUMNS }>

type Reader = FactoryClient | CommandTx

/** The live terms of a party with a company, or null (the party's own apply). */
export async function companyTermsRow(db: Reader, partyId: string, companyId: string): Promise<TermsRow | null> {
  return db.partyCompanyTerms.findFirst({ where: { partyId, companyId, endedAt: null }, select: TERMS_COLUMNS, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
}

/**
 * The quote's (or typed order's) view of the customer with the company's terms over its own (payment terms, price list,
 * deposit), so the code that copies "the customer's defaults" copies the company's. Null in, null out.
 */
export async function withCompanyTerms<Party extends QuoteParty>(db: Reader, party: Party | null, companyId: string): Promise<Party | null> {
  if (party === null) return null
  const row = await companyTermsRow(db, party.row.id, companyId)
  if (row === null) return party
  const terms = termsInForce(party.row, row)
  return {
    ...party,
    row: {
      ...party.row,
      paymentTermsId: terms.paymentTermsId,
      paymentTerms: terms.paymentTerms,
      priceListId: terms.priceListId,
      defaultDepositPct: terms.source.deposit === 'COMPANY' ? row.depositPct : party.row.defaultDepositPct,
    },
  }
}

/** The price list a party is priced from with a company: its terms' list there, else its own. */
export async function priceListFor(db: Reader, party: { readonly id: string; readonly priceListId: string | null }, companyId: string): Promise<string | null> {
  const row = await companyTermsRow(db, party.id, companyId)
  return row?.priceListId ?? party.priceListId
}

/** The words of a missing PO number on an order of the party with the company (SAL-013), or null. */
export async function poNumberProblemFor(db: Reader, party: { readonly id: string; readonly code: string }, companyId: string, customerRef: string | null | undefined): Promise<string | null> {
  const row = await companyTermsRow(db, party.id, companyId)
  if (!row?.poNumberRequired) return null
  const company = await db.company.findUnique({ where: { id: companyId }, select: { code: true, legalName: true, tradeName: true } })
  return poNumberProblem(true, customerRef, { code: party.code, company: company?.tradeName ?? company?.legalName ?? 'this company' })
}
