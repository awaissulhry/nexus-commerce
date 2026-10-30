import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { heldGrains, type Grain } from '@nexus/factory-domain/auth/grains/grains'
import { ForbiddenError, NotFoundError, UnauthenticatedError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, type Permission } from '@nexus/factory-domain/core/permissions'
import { toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { isCustomer, type PartyKind, type PartyRole, type PartyStatus } from '@nexus/factory-domain/parties/rules'
import { customerTaxProfile, identityAt, type PartyTaxMode, type TaxIdentityFields } from '@nexus/factory-domain/parties/tax'
import { viesStanding } from '@nexus/factory-domain/parties/vies'
import { QUOTES_VIEW } from '@nexus/factory-domain/sales/quotes/permissions'
import { priceText, type MoneyLine, type SizeRow } from '@nexus/factory-domain/sales/quotes/quotes'
import { TaxRuleError } from '@nexus/factory-domain/tax/rules'
import { STANDARD_VAT_RATE, isItalianVatRate } from '@nexus/factory-domain/tax/vat-rates'
import { decideVatTreatment, LEGAL_WORDING, nonTaxable, taxable, type CustomerTaxProfile, type VatTreatment } from '@nexus/factory-domain/tax/vat-treatment'
import type { CommandCaller, CommandTx } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { dateText, TAX_COLUMNS, taxFieldsOf, VIES_COLUMNS, viesFactsOf } from '../../parties/store'

/**
 * The quotes' reads (factory-db sales.prisma Quote, QuoteVersion, QuoteLine, QuoteLineSize, QuoteApproval): the columns
 * every read names, who may see and act on a quote (office only; can() on its company AND its party, so a role limited
 * to some customers reaches only theirs), the party as a quote reads it (status, the tax identity in force, the VIES
 * proof, the VAT treatment the rules decide), and the lines as the money is computed from them. A reader takes a
 * command's transaction or a scoped client: row-level security decides what it finds.
 */

export type Reader = FactoryClient | CommandTx

export function officeContextOf(caller: CommandCaller): OfficeContext {
  const context = caller.factoryContext
  if (!context) throw new UnauthenticatedError()
  if (context.audience !== 'office') throw new ForbiddenError()
  return context
}

export interface QuoteScope {
  readonly companyId: string
  readonly partyId: string
}

export const mayOn = (context: OfficeContext, permission: Permission, scope: QuoteScope): boolean => can(actorOf(context), permission, { companyId: scope.companyId, partyId: scope.partyId })

/** The caller may see the record (quotes.view, else 404) and do `permission` on it (else 403). */
export function assertMay(context: OfficeContext, permission: Permission, scope: QuoteScope | null, what = 'Quote'): asserts scope is QuoteScope {
  if (!scope || !mayOn(context, QUOTES_VIEW, scope)) throw new NotFoundError(`${what} not found.`)
  if (!mayOn(context, permission, scope)) throw new ForbiddenError()
}

/** The grains the caller holds (the margin amount needs cost AND margin: net − margin is the cost). */
export const grainsOf = (context: OfficeContext): ReadonlySet<Grain> => heldGrains(actorOf(context))

export const QUOTE_COLUMNS = {
  id: true,
  companyId: true,
  number: true,
  partyId: true,
  contactId: true,
  customerRef: true,
  status: true,
  currentRevision: true,
  internalNote: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  createdById: true,
} as const satisfies Prisma.QuoteSelect
export type QuoteRow = Prisma.QuoteGetPayload<{ select: typeof QUOTE_COLUMNS }>

export const VERSION_COLUMNS = {
  id: true,
  quoteId: true,
  partyId: true,
  revision: true,
  status: true,
  currency: true,
  language: true,
  taxMode: true,
  taxIdentityId: true,
  billToAddressId: true,
  shipToAddressId: true,
  validUntil: true,
  firmOffer: true,
  promiseDate: true,
  paymentTerms: true,
  // B-W2a-19: the library's terms and the price list version the version keeps.
  paymentTermsId: true,
  priceListVersionId: true,
  termsText: true,
  termsVersion: true,
  depositPct: true,
  depositKind: true,
  depositAmount: true,
  noWithdrawal: true,
  netAmount: true,
  vatAmount: true,
  grossAmount: true,
  costAmount: true,
  marginAmount: true,
  marginPct: true,
  marginFloorPct: true,
  marginFloorBreached: true,
  changeNote: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  createdById: true,
} as const satisfies Prisma.QuoteVersionSelect
export type VersionRow = Prisma.QuoteVersionGetPayload<{ select: typeof VERSION_COLUMNS }>

export const LINE_COLUMNS = {
  id: true,
  versionId: true,
  seq: true,
  kind: true,
  styleId: true,
  styleRevisionId: true,
  colourwayId: true,
  description: true,
  note: true,
  quantity: true,
  listUnitPrice: true,
  unitPrice: true,
  netAmount: true,
  vatRatePct: true,
  vatNature: true,
  vatAmount: true,
  unitCost: true,
  costAmount: true,
  marginAmount: true,
  marginPct: true,
  costSnapshot: true,
  version: true,
} as const satisfies Prisma.QuoteLineSelect
export type LineRow = Prisma.QuoteLineGetPayload<{ select: typeof LINE_COLUMNS }>

export const APPROVAL_COLUMNS = {
  id: true,
  versionId: true,
  reasons: true,
  details: true,
  requestNote: true,
  status: true,
  decidedAt: true,
  decidedById: true,
  decisionNote: true,
  createdAt: true,
  createdById: true,
} as const satisfies Prisma.QuoteApprovalSelect
export type ApprovalRow = Prisma.QuoteApprovalGetPayload<{ select: typeof APPROVAL_COLUMNS }>

/** A Decimal column as plain text ("450", "12.5"), or null. */
export const decimal = (value: Prisma.Decimal | null): string | null => (value === null ? null : priceText(value.toString()))
export const day = (value: Date | null): string | null => (value === null ? null : dateText(value))
export const dayValue = (value: string): Date => new Date(`${value}T00:00:00.000Z`)

export async function readQuote(db: Reader, quoteId: string): Promise<QuoteRow | null> {
  if (!isUuid(quoteId)) return null
  return db.quote.findUnique({ where: { id: quoteId }, select: QUOTE_COLUMNS })
}

/** The quote's current (newest) version. */
export async function readCurrentVersion(db: Reader, quote: Pick<QuoteRow, 'id' | 'currentRevision'>): Promise<VersionRow> {
  const row = await db.quoteVersion.findFirst({ where: { quoteId: quote.id, revision: quote.currentRevision }, select: VERSION_COLUMNS })
  if (!row) throw new NotFoundError('Quote version not found.')
  return row
}

/** A line with its size grid (QuoteLineSize rows, in the style's range order once the style is known). */
export interface LineRecord extends LineRow {
  readonly sizes: SizeRow[]
}

export async function readLineRecords(db: Reader, versionId: string): Promise<LineRecord[]> {
  const lines = await db.quoteLine.findMany({ where: { versionId }, select: LINE_COLUMNS, orderBy: { seq: 'asc' } })
  if (lines.length === 0) return []
  const sizes = await db.quoteLineSize.findMany({ where: { lineId: { in: lines.map((line) => line.id) } }, select: { lineId: true, size: true, quantity: true, unitPrice: true }, orderBy: [{ lineId: 'asc' }, { size: 'asc' }] })
  return lines.map((line) => ({
    ...line,
    sizes: sizes.filter((row) => row.lineId === line.id).map((row) => ({ size: row.size, quantity: row.quantity, unitPrice: decimal(row.unitPrice) })),
  }))
}

/** A line as the version's money is computed from it. */
export const moneyLineOf = (line: LineRecord): MoneyLine => ({ seq: line.seq, unitPrice: decimal(line.unitPrice)!, listUnitPrice: decimal(line.listUnitPrice), sizes: line.sizes, costAmount: line.costAmount })

/** The quote the office may see (else 404) and act on with `permission` (else 403). */
export async function officeQuote(caller: CommandCaller, quoteId: string, permission: Permission = QUOTES_VIEW): Promise<QuoteRow> {
  const context = officeContextOf(caller)
  const quote = await caller.withClient((client) => readQuote(client, quoteId))
  assertMay(context, permission, quote ? { companyId: quote.companyId, partyId: quote.partyId } : null)
  return quote!
}

// ---- the party as a quote reads it -----------------------------------------------------------------------------------

const PARTY_COLUMNS = {
  id: true,
  companyId: true,
  code: true,
  legalName: true,
  kind: true,
  roles: true,
  status: true,
  language: true,
  paymentTerms: true,
  // B-W2a-19 (SAL-012): the commercial terms a new quote copies.
  paymentTermsId: true,
  priceListId: true,
  defaultDepositPct: true,
} as const satisfies Prisma.PartySelect

export interface QuoteParty {
  readonly row: {
    readonly id: string
    readonly companyId: string | null
    readonly code: string
    readonly legalName: string
    readonly kind: PartyKind
    readonly roles: PartyRole[]
    readonly status: PartyStatus
    readonly language: string
    readonly paymentTerms: string | null
    readonly paymentTermsId: string | null
    readonly priceListId: string | null
    readonly defaultDepositPct: Prisma.Decimal | null
  }
  readonly isCustomer: boolean
  /** The tax identity in force on the day, and its row. */
  readonly identityId: string | null
  readonly identity: TaxIdentityFields | null
  /** A current VIES check proves the EU VAT number (art. 41 DL 331/1993; parties/vies zeroRatingProof). */
  readonly viesValid: boolean
  readonly viesMessage: string | null
  /** The VAT rules' view of the customer (null without a tax identity). */
  readonly profile: CustomerTaxProfile | null
}

/** The party on `date` (its identity in force) at `instant` (the VIES window). Null: not visible. */
export async function quotePartyOf(db: Reader, partyId: string, date: BusinessDate, instant: Date): Promise<QuoteParty | null> {
  if (!isUuid(partyId)) return null
  const row = await db.party.findUnique({ where: { id: partyId }, select: PARTY_COLUMNS })
  if (!row) return null
  const identities = await db.partyTaxIdentity.findMany({ where: { partyId }, select: TAX_COLUMNS })
  const current = identityAt(identities.map((identity) => ({ row: identity, validFrom: dateText(identity.validFrom) })), date)?.row ?? null
  const identity = current ? taxFieldsOf(current) : null
  const checks = current ? await db.viesCheck.findMany({ where: { taxIdentityId: current.id }, select: VIES_COLUMNS }) : []
  const vies = viesStanding(identity, checks.map(viesFactsOf), instant)
  const viesValid = vies.state === 'VALID' && vies.proof !== null
  return {
    row,
    isCustomer: isCustomer(row.roles),
    identityId: current?.id ?? null,
    identity,
    viesValid,
    viesMessage: vies.state === 'NOT_APPLICABLE' ? null : vies.message,
    profile: identity ? customerTaxProfile(row, identity, viesValid) : null,
  }
}

/** The VAT of a garment sold to this customer (FIN-098), or why it cannot be decided. */
export function treatmentFor(profile: CustomerTaxProfile): VatTreatment | { readonly problem: string } {
  try {
    return decideVatTreatment({ customer: profile, supply: 'GOODS', rate: STANDARD_VAT_RATE, goodsLeaveEu: true }).treatment
  } catch (error) {
    if (error instanceof TaxRuleError) return { problem: error.message }
    throw error
  }
}

const NATURE_WORDING: Readonly<Record<string, string>> = { 'N3.2': LEGAL_WORDING.INTRA_EU_SUPPLY, 'N3.1': LEGAL_WORDING.EXPORT }

/** A line's stored VAT (QuoteLine.vatRatePct, vatNature) as its treatment. */
export function treatmentOfStored(line: Pick<LineRow, 'vatRatePct' | 'vatNature'>): VatTreatment {
  if (line.vatNature !== null) return nonTaxable(line.vatNature as never, NATURE_WORDING[line.vatNature] ?? line.vatNature)
  const rate = Number.parseInt(line.vatRatePct.toFixed(0), 10)
  return taxable(isItalianVatRate(rate) ? rate : STANDARD_VAT_RATE)
}

/** How a treatment is stored on a line. */
export const storedVat = (treatment: VatTreatment): { vatRatePct: string; vatNature: string | null } =>
  treatment.kind === 'TAXABLE' ? { vatRatePct: treatment.rate.toFixed(2), vatNature: null } : { vatRatePct: '0.00', vatNature: treatment.natura }

export type { PartyTaxMode }

export const dateTimeText = (value: Date | null): string | null => (value === null ? null : toUtcIso(value))
