import type { Issue } from '../../core/errors'
import { cleanNote, cleanText } from '../../parties/rules'

/**
 * Supplier bank details with change control (B-W2b-315; SCM-007; the table is B-W2b-287's SupplierBankAccount; design
 * purchasing.suppliers › Bank details, portal.supplier.profile › Bank details + New bank details). Pure; apps/factory-api
 * modules/purchasing/bank (office) and portal-profile/bank.ts (the supplier's portal) write it through command(), and the
 * …_suppliers_depth_w2b_guards triggers hold the same rules for every login, the owner included.
 *
 * A changed IBAN is the classic supplier-payment fraud. So an account is never edited: a change is a new account,
 *
 *   PROPOSED   by an office person (from the supplier's letter) or by the supplier's Admin in its portal, after a step-up;
 *              payments still go to the ACTIVE account;
 *   call-back  someone of the office who neither proposed nor wrote it calls the supplier on a number we had on file BEFORE
 *              the proposal (a contact's or an address's phone, created and last changed before it) — never a number that
 *              came with the request, never by mail;
 *   checked    a second person (never the one who proposed or wrote it, the Owner included: Owner answer Q3) checks it
 *              after the call-back — by an approval when a switched-on SUPPLIER_BANK_CHANGE rule asks for one, else
 *              directly — and it becomes ACTIVE in the same command, the account it replaces RETIRED first (one ACTIVE per
 *              party and currency); or REFUSED with why.
 *
 * Payments use only the ACTIVE account (`payableAccount`). Nothing about an account goes by mail; lists and the portal
 * show the masked IBAN (`IT** **** **** 3456`), the full IBAN only to finance behind a step-up (and to the supplier for its
 * own accounts: B-W2b-287's Decided 1).
 */

export const BANK_ACCOUNT_STATUSES = ['PROPOSED', 'VERIFIED', 'ACTIVE', 'REFUSED', 'RETIRED'] as const
export type BankAccountStatus = (typeof BANK_ACCOUNT_STATUSES)[number]

/**
 * What a person reads in the pill (the design's "Usable · Waiting second approval · Waiting call-back check"):
 *   WAITING_CALL_BACK     proposed, nobody called the supplier back yet
 *   WAITING_SECOND_CHECK  called back, waiting for the second person (directly, or the approval a rule asked for)
 *   VERIFIED              checked, not the account payments use yet (an older activation path; this step activates at once)
 *   USABLE                the ACTIVE account: payments use it
 *   REFUSED · RETIRED     final
 */
export const BANK_PILLS = ['WAITING_CALL_BACK', 'WAITING_SECOND_CHECK', 'VERIFIED', 'USABLE', 'REFUSED', 'RETIRED'] as const
export type BankPill = (typeof BANK_PILLS)[number]

export const BANK_SOURCES = ['OFFICE', 'PORTAL'] as const
export type BankSource = (typeof BANK_SOURCES)[number]

export const BANK_LIMITS = Object.freeze({ holder: 140, bankName: 140, refuseReason: 2000, retireReason: 500, phone: 40, phoneDigits: 6, note: 2000 })

/** The IBAN's length per country (ISO 13616 registry: the SEPA countries and the usual others). */
export const IBAN_LENGTHS: Readonly<Record<string, number>> = Object.freeze({
  AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22, BR: 29, BY: 28, CH: 21, CR: 22, CY: 28, CZ: 24,
  DE: 22, DK: 18, DO: 28, EE: 20, EG: 29, ES: 24, FI: 18, FO: 18, FR: 27, GB: 22, GE: 22, GI: 23, GL: 18, GR: 27, GT: 28,
  HR: 21, HU: 28, IE: 22, IL: 23, IQ: 23, IS: 26, IT: 27, JO: 30, KW: 30, KZ: 20, LB: 28, LC: 32, LI: 21, LT: 20, LU: 20,
  LV: 21, MC: 27, MD: 24, ME: 22, MK: 19, MR: 27, MT: 31, MU: 30, NL: 18, NO: 15, PK: 24, PL: 28, PS: 29, PT: 25, QA: 29,
  RO: 24, RS: 22, SA: 24, SC: 31, SE: 24, SI: 19, SK: 24, SM: 27, ST: 25, SV: 28, TL: 23, TN: 24, TR: 26, UA: 29, VA: 22,
  VG: 24, XK: 20,
})

/** "it11 x000 0000 0000 0000 0315 001" → "IT11X0000000000000000315001": upper case, no spaces or separators. */
export const normaliseIban = (value: string): string => value.replace(/[\s\-.]/g, '').toUpperCase()

/** ISO 7064 mod 97-10 over the IBAN moved by four characters (letters as 10..35): 1 for a right IBAN. */
export function ibanRemainder(iban: string): number {
  const moved = `${iban.slice(4)}${iban.slice(0, 4)}`
  let remainder = 0
  for (const char of moved) {
    const value = /[0-9]/.test(char) ? char : String(char.charCodeAt(0) - 55)
    for (const digit of value) remainder = (remainder * 10 + Number(digit)) % 97
  }
  return remainder
}

/** What is wrong with an IBAN (already normalised), in words; null when it is right. */
export function ibanProblem(iban: string): string | null {
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(iban)) return 'An IBAN is two letters of the country, two check digits and 11 to 30 letters or digits.'
  const length = IBAN_LENGTHS[iban.slice(0, 2)]
  if (length !== undefined && iban.length !== length) return `An IBAN of ${iban.slice(0, 2)} has ${length} characters; this one has ${iban.length}.`
  if (ibanRemainder(iban) !== 1) return 'The IBAN’s check digits do not match: a character is mistyped.'
  return null
}

/** The masked IBAN a list and the portal show: the country, the check digits hidden, the last four ("IT** **** **** 3456"). */
export const maskedIban = (country: string, last4: string): string => `${country}** **** **** ${last4}`

/** The full IBAN in groups of four, as a person reads it ("IT11 X000 0000 …"). */
export const groupedIban = (iban: string): string => iban.replace(/(.{4})/g, '$1 ').trim()

export const BIC = /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/
export const CURRENCY = /^[A-Z]{3}$/

export interface ProposalInput {
  readonly iban: string
  readonly holder: string
  readonly bankName?: string | null | undefined
  readonly bic?: string | null | undefined
  readonly currency?: string | null | undefined
}

export interface Proposal {
  readonly iban: string
  readonly holder: string
  readonly bankName: string | null
  readonly bic: string | null
  readonly currency: string
}

/** A proposal as it is written (normalised), or its problems at `body/<field>`. */
export function planProposal(input: ProposalInput): { readonly ok: true; readonly proposal: Proposal } | { readonly ok: false; readonly issues: Issue[] } {
  const issues: Issue[] = []
  const iban = normaliseIban(input.iban ?? '')
  const ibanWrong = ibanProblem(iban)
  if (ibanWrong) issues.push({ path: 'body/iban', message: ibanWrong })
  const holder = cleanText(input.holder)
  if (holder === null || holder.length > BANK_LIMITS.holder) issues.push({ path: 'body/holder', message: `The account holder as the bank knows it, in one line of 1 to ${BANK_LIMITS.holder} characters.` })
  const bankName = cleanText(input.bankName ?? null)
  if (bankName !== null && bankName.length > BANK_LIMITS.bankName) issues.push({ path: 'body/bankName', message: `The bank's name in at most ${BANK_LIMITS.bankName} characters.` })
  const bic = input.bic ? input.bic.replace(/\s/g, '').toUpperCase() : null
  if (bic !== null && !BIC.test(bic)) issues.push({ path: 'body/bic', message: 'A BIC is 8 or 11 letters and digits (bank, country, place, branch).' })
  const currency = (input.currency ?? 'EUR').trim().toUpperCase()
  if (!CURRENCY.test(currency)) issues.push({ path: 'body/currency', message: 'The currency as its ISO 4217 code (EUR).' })
  if (issues.length > 0) return { ok: false, issues }
  return { ok: true, proposal: { iban, holder: holder!, bankName, bic, currency } }
}

/** An account as these rules read it (the columns that decide its state). */
export interface AccountFacts {
  readonly id: string
  readonly status: BankAccountStatus
  readonly iban: string
  readonly currency: string
  readonly proposedById: string
  readonly createdById: string | null
  readonly proposedAt: Date
  readonly callBackAt: Date | null
}

export function pillOf(account: Pick<AccountFacts, 'status' | 'callBackAt'>): BankPill {
  switch (account.status) {
    case 'PROPOSED':
      return account.callBackAt === null ? 'WAITING_CALL_BACK' : 'WAITING_SECOND_CHECK'
    case 'VERIFIED':
      return 'VERIFIED'
    case 'ACTIVE':
      return 'USABLE'
    default:
      return account.status
  }
}

export const PILL_WORDS: Readonly<Record<BankPill, string>> = Object.freeze({
  WAITING_CALL_BACK: 'Waiting for the call-back check',
  WAITING_SECOND_CHECK: 'Waiting for the second approval',
  VERIFIED: 'Checked, not in use yet',
  USABLE: 'Usable: payments go to it',
  REFUSED: 'Refused',
  RETIRED: 'Retired',
})

/** The account payments to a supplier use in a currency: its one ACTIVE account, or null (payments to it are held). */
export function payableAccount<Row extends Pick<AccountFacts, 'status' | 'currency'>>(accounts: readonly Row[], currency: string): Row | null {
  return accounts.find((account) => account.status === 'ACTIVE' && account.currency === currency) ?? null
}

/** Still open: proposed or checked, not yet decided for good. */
export const isOpen = (status: BankAccountStatus): boolean => status === 'PROPOSED' || status === 'VERIFIED'

/** What stands against a new proposal: the same IBAN in use or waiting, or another change of that currency still open. */
export function proposalConflict(proposal: Proposal, accounts: readonly Pick<AccountFacts, 'status' | 'iban' | 'currency'>[]): string | null {
  if (accounts.some((account) => account.status === 'ACTIVE' && account.iban === proposal.iban)) return 'This is the account payments already use: nothing to change.'
  if (accounts.some((account) => isOpen(account.status) && account.iban === proposal.iban)) return 'This account was proposed already: it waits for its call-back and check.'
  if (accounts.some((account) => isOpen(account.status) && account.currency === proposal.currency)) return `Another change of the ${proposal.currency} account waits for its call-back and check: decide that one first.`
  return null
}

/** The digits of a phone number ("+39 055 123 4567" → "390551234567"), as the database compares them. */
export const phoneDigits = (phone: string | null | undefined): string => (phone ?? '').replace(/[^0-9]/g, '')

export interface OnFile {
  readonly kind: 'CONTACT' | 'ADDRESS'
  readonly id: string
  readonly label: string
  readonly phone: string | null
  readonly createdAt: Date
  readonly updatedAt: Date
  readonly active: boolean
}

export type CandidateHold = 'NO_PHONE' | 'CHANGED_AFTER' | 'ADDED_AFTER' | 'NOT_ACTIVE'

/**
 * Where the call-back may dial: a contact or an address of the party with a phone (at least six digits), created AND last
 * changed before the proposal (the database's rule: a number that came with the change, or was changed since, is never
 * "on file"). The others are listed with why not, so the person sees what was left out.
 */
export function callBackCandidates(onFile: readonly OnFile[], proposedAt: Date): { readonly usable: OnFile[]; readonly held: (OnFile & { readonly hold: CandidateHold })[] } {
  const usable: OnFile[] = []
  const held: (OnFile & { readonly hold: CandidateHold })[] = []
  for (const row of onFile) {
    const hold: CandidateHold | null =
      phoneDigits(row.phone).length < BANK_LIMITS.phoneDigits
        ? 'NO_PHONE'
        : row.createdAt.getTime() >= proposedAt.getTime()
          ? 'ADDED_AFTER'
          : row.updatedAt.getTime() >= proposedAt.getTime()
            ? 'CHANGED_AFTER'
            : !row.active
              ? 'NOT_ACTIVE'
              : null
    if (hold === null) usable.push(row)
    else held.push({ ...row, hold })
  }
  return { usable, held }
}

export const CANDIDATE_HOLD_WORDS: Readonly<Record<CandidateHold, string>> = Object.freeze({
  NO_PHONE: 'No phone number on file.',
  ADDED_AFTER: 'Added after the change was proposed: it may have come with the change.',
  CHANGED_AFTER: 'Changed after the change was proposed: it may have come with the change.',
  NOT_ACTIVE: 'No longer active.',
})

/** The people who may not call back or check an account: who proposed it and who wrote it. */
export const askersOfAccount = (account: Pick<AccountFacts, 'proposedById' | 'createdById'>): string[] => [...new Set([account.proposedById, ...(account.createdById ? [account.createdById] : [])])]

export const BANK_REFUSALS = Object.freeze({
  notOpen: 'This account is no longer waiting: reload the bank details.',
  calledBack: 'The supplier was called back on this change already.',
  notCalledBack: 'Call the supplier back on a number we had before the change first: only then may a second person check it.',
  ownCallBack: 'You proposed or wrote this change: someone else calls the supplier back (on a number we had before the change).',
  ownCheck: 'You proposed or wrote this change: a second person checks it, the Owner included.',
  notOnFile: 'Dial a number we had on file before the change: a contact or an address of the supplier, unchanged since the proposal.',
  phoneNotOnFile: 'The number dialled is not the one on file for that contact or address: dial the number we had.',
  waitingYes: 'This change waits for its yes in Approvals: the approver checks it there.',
  notActive: 'Only the account payments use can be retired.',
})

/** The call-back's problems (who, where, what was dialled), before the database says the same. */
export function callBackProblems(input: { readonly account: AccountFacts; readonly byId: string; readonly candidate: OnFile | null; readonly phone: string }): Issue[] {
  const { account } = input
  if (account.status !== 'PROPOSED') return [{ path: 'accountId', message: BANK_REFUSALS.notOpen }]
  if (account.callBackAt !== null) return [{ path: 'accountId', message: BANK_REFUSALS.calledBack }]
  if (askersOfAccount(account).includes(input.byId)) return [{ path: 'refusal/OWN_CHANGE', message: BANK_REFUSALS.ownCallBack }]
  if (input.candidate === null) return [{ path: 'body/onFile', message: BANK_REFUSALS.notOnFile }]
  const { usable } = callBackCandidates([input.candidate], account.proposedAt)
  if (usable.length === 0) return [{ path: 'body/onFile', message: BANK_REFUSALS.notOnFile }]
  const phone = cleanText(input.phone)
  if (phone === null || phone.length > BANK_LIMITS.phone || phoneDigits(phone) !== phoneDigits(input.candidate.phone)) return [{ path: 'body/phone', message: BANK_REFUSALS.phoneNotOnFile }]
  return []
}

/** The second check's problems: called back, still open, never by who proposed or wrote it. */
export function checkProblems(account: AccountFacts, byId: string): Issue[] {
  if (!isOpen(account.status)) return [{ path: 'accountId', message: BANK_REFUSALS.notOpen }]
  if (account.callBackAt === null) return [{ path: 'refusal/NOT_CALLED_BACK', message: BANK_REFUSALS.notCalledBack }]
  if (askersOfAccount(account).includes(byId)) return [{ path: 'refusal/OWN_CHANGE', message: BANK_REFUSALS.ownCheck }]
  return []
}

/** Why it is refused: 1 to 2000 characters, kept as written (lines included). */
export function refuseReasonOf(value: string | null | undefined): { readonly reason: string } | { readonly issue: Issue } {
  const reason = cleanNote(value ?? null)
  if (reason === null || reason.length > BANK_LIMITS.refuseReason) return { issue: { path: 'body/reason', message: `Why it is refused, in 1 to ${BANK_LIMITS.refuseReason} characters.` } }
  return { reason }
}

/** Why an ACTIVE account is retired: one line of at most 500 characters ("account closed"). */
export function retireReasonOf(value: string | null | undefined): { readonly reason: string } | { readonly issue: Issue } {
  const reason = cleanText(value ?? null)
  if (reason === null || reason.length > BANK_LIMITS.retireReason) return { issue: { path: 'body/reason', message: `Why it is retired, in one line of 1 to ${BANK_LIMITS.retireReason} characters.` } }
  return { reason }
}

/** The retired account's words when a newer one replaces it ("Replaced by the account ending 3456."). */
export const replacedWords = (last4: string): string => `Replaced by the account ending ${last4}.`

/** The portal's words for the supplier while its change waits (design portal.supplier.profile › Bank details). */
export const PORTAL_WAITING_WORDS = 'Waiting: we call you on your registered number before any payment uses the new account. Payments go to the old account until then.'
