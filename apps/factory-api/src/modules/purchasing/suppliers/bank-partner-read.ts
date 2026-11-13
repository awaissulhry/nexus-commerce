import type { Prisma } from '@nexus/factory-db'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { maskedIban, type BankAccountStatus } from '@nexus/factory-domain/purchasing/bank/rules'

/**
 * What a partner reads of a supplier's bank account (B-W2b-377; follow-up XF5:07; SCM-007; B-W2b-287's Decided 1, B-W2b-363's
 * write-only `iban` for the partner): the country and the LAST FOUR characters of the IBAN (`ibanCountry`, `ibanLast4`, written
 * by the database), shown masked ("IT** **** **** 3456"), never the whole number. THE one place a partner answer reads an
 * account: the columns below can never name `iban` (the type refuses it), and the database refuses the partner's SELECT of it
 * (42501) whatever a later route tries. The office reads the same masked view; the whole IBAN only through Reveal (finance,
 * step-up, audited: modules/purchasing/bank).
 */

/** The account's columns a partner's answer reads: never `iban` (the type says so; the partner's grant does too). */
export const PARTNER_ACCOUNT_COLUMNS = {
  id: true,
  ibanCountry: true,
  ibanLast4: true,
  bankName: true,
  holder: true,
  currency: true,
  status: true,
  proposedAt: true,
  callBackAt: true,
  activatedAt: true,
  refusedAt: true,
  refuseReason: true,
  retiredAt: true,
  version: true,
} as const satisfies Prisma.SupplierBankAccountSelect & { readonly iban?: never }
export type PartnerAccountRow = Prisma.SupplierBankAccountGetPayload<{ select: typeof PARTNER_ACCOUNT_COLUMNS }>

/** The state a supplier reads: usable (payments use it), waiting (its call-back and second check), refused, retired. */
export const partnerStateOf = (status: BankAccountStatus): 'USABLE' | 'WAITING' | 'REFUSED' | 'RETIRED' => (status === 'ACTIVE' ? 'USABLE' : status === 'PROPOSED' || status === 'VERIFIED' ? 'WAITING' : status)

/** One account as the supplier's portal shows it: the IBAN masked to its country and last four characters. */
export const partnerAccountView = (row: PartnerAccountRow) => ({
  id: row.id,
  masked: maskedIban(row.ibanCountry, row.ibanLast4),
  bankName: row.bankName,
  holder: row.holder,
  currency: row.currency,
  state: partnerStateOf(row.status as BankAccountStatus),
  proposedAt: toUtcIso(row.proposedAt),
  activatedAt: row.activatedAt ? toUtcIso(row.activatedAt) : null,
  refusedAt: row.refusedAt ? toUtcIso(row.refusedAt) : null,
  reason: row.status === 'REFUSED' ? row.refuseReason : null,
  retiredAt: row.retiredAt ? toUtcIso(row.retiredAt) : null,
})
