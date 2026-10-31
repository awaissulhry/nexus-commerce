import type { Issue } from '../core/errors'
import { Dec } from '../tax/decimal'
import { MATCH_SETTINGS, type MatchBasis, type MatchSettings } from './match'
import type { Refusal } from './rules'

/**
 * The payables settings of a company (B-W2b-21, Z8:03; factory-db payables.prisma PayablesSettings, B-W2b-02; B-W2a-62's
 * schema need; the accountant's tolerances and billing basis, GATE-ACCOUNTANT), pure.
 *
 * One row per company, and one tenant-wide row (its id the tenant's): a value set on the company's row wins, a null follows
 * the tenant-wide row, and nothing anywhere keeps the W2a rule (an exact match on what was received, any approver):
 *   quantityTolerancePct        percent the quantity invoiced may pass what was received (0 to 100)
 *   priceTolerancePct           percent the unit price invoiced may pass the order's (0 to 100)
 *   differenceToleranceAmount   a difference up to this amount (minor units) is within whatever the percentages say
 *                               (rounding on a long invoice)
 *   billingBasis                RECEIVED (pay what arrived) or ORDERED (pay what was ordered: a supplier billing ahead)
 *   sdiApproval                 who approves an invoice SDI delivered (the system registered it, so "not the registrant"
 *                               says nothing): ANY_APPROVER, NOT_THE_BUYER (not who sent an order it bills), LISTED (only
 *                               the users listed in sdiApproverIds)
 *   accepterMayNotApprove       whoever accepted a difference does not approve the invoice. The lead's four eyes of
 *                               B-W2a-F7 already hold it for every invoice: the setting can say it, never lift it
 * The figures are the accountant's; the setting holds them once given (`decided` says whether every match figure is set).
 */

export const PAYABLES_SDI_APPROVALS = ['ANY_APPROVER', 'NOT_THE_BUYER', 'LISTED'] as const
export type PayablesSdiApproval = (typeof PAYABLES_SDI_APPROVALS)[number]
export const PAYABLES_SETTING_FIELDS = ['quantityTolerancePct', 'priceTolerancePct', 'differenceToleranceAmount', 'billingBasis', 'sdiApproval', 'accepterMayNotApprove'] as const
export type PayablesSettingField = (typeof PAYABLES_SETTING_FIELDS)[number]
export type SettingSource = 'COMPANY' | 'TENANT' | 'DEFAULT'

/** A stored row, as read (decimals as text). */
export interface PayablesSettingsRow {
  readonly quantityTolerancePct: string | null
  readonly priceTolerancePct: string | null
  readonly differenceToleranceAmount: number | null
  readonly billingBasis: MatchBasis | null
  readonly sdiApproval: PayablesSdiApproval | null
  readonly sdiApproverIds: readonly string[]
  readonly accepterMayNotApprove: boolean | null
}

export interface EffectivePayablesSettings {
  readonly quantityTolerancePct: string
  readonly priceTolerancePct: string
  readonly differenceToleranceAmount: number
  readonly billingBasis: MatchBasis
  readonly sdiApproval: PayablesSdiApproval
  readonly sdiApproverIds: readonly string[]
  readonly accepterMayNotApprove: true
  /** Every match figure (both tolerances, the amount, the basis) is set on the company's or the tenant's row. */
  readonly decided: boolean
  /** Where each value comes from. */
  readonly source: Readonly<Record<PayablesSettingField, SettingSource>>
}

const pick = <T>(company: T | null | undefined, tenant: T | null | undefined, fallback: T): { value: T; source: SettingSource } =>
  company !== null && company !== undefined ? { value: company, source: 'COMPANY' } : tenant !== null && tenant !== undefined ? { value: tenant, source: 'TENANT' } : { value: fallback, source: 'DEFAULT' }

/** The settings that apply to a company: its row's values, else the tenant's, else the W2a rule. */
export function effectivePayablesSettings(company: PayablesSettingsRow | null, tenant: PayablesSettingsRow | null): EffectivePayablesSettings {
  const quantity = pick(company?.quantityTolerancePct, tenant?.quantityTolerancePct, MATCH_SETTINGS.quantityTolerancePct)
  const price = pick(company?.priceTolerancePct, tenant?.priceTolerancePct, MATCH_SETTINGS.priceTolerancePct)
  const amount = pick(company?.differenceToleranceAmount, tenant?.differenceToleranceAmount, 0)
  const basis = pick<MatchBasis>(company?.billingBasis, tenant?.billingBasis, MATCH_SETTINGS.basis)
  const approval = pick<PayablesSdiApproval>(company?.sdiApproval, tenant?.sdiApproval, 'ANY_APPROVER')
  const accepter = pick(company?.accepterMayNotApprove, tenant?.accepterMayNotApprove, true)
  // The listed approvers travel with the row whose LISTED rule applies.
  const approvers = approval.value !== 'LISTED' ? [] : approval.source === 'COMPANY' ? [...(company?.sdiApproverIds ?? [])] : [...(tenant?.sdiApproverIds ?? [])]
  return {
    quantityTolerancePct: new Dec(quantity.value).toFixed(4),
    priceTolerancePct: new Dec(price.value).toFixed(4),
    differenceToleranceAmount: amount.value,
    billingBasis: basis.value,
    sdiApproval: approval.value,
    sdiApproverIds: approvers,
    accepterMayNotApprove: true,
    decided: [quantity, price, amount, basis].every((entry) => entry.source !== 'DEFAULT'),
    source: { quantityTolerancePct: quantity.source, priceTolerancePct: price.source, differenceToleranceAmount: amount.source, billingBasis: basis.source, sdiApproval: approval.source, accepterMayNotApprove: accepter.source },
  }
}

const basisWords = (basis: MatchBasis) => (basis === 'ORDERED' ? { en: 'what was ordered', it: "quanto ordinato" } : { en: 'what was received', it: 'quanto ricevuto' })

/** The three-way match's settings from the payables settings (the words say what applies and whether it is decided). */
export function matchSettingsOf(settings: EffectivePayablesSettings): MatchSettings & { readonly differenceToleranceAmount: number } {
  // Nothing set anywhere: the W2a rule, in its own words.
  if (!settings.decided && settings.source.quantityTolerancePct === 'DEFAULT' && settings.source.priceTolerancePct === 'DEFAULT' && settings.source.billingBasis === 'DEFAULT' && settings.source.differenceToleranceAmount === 'DEFAULT') {
    return { ...MATCH_SETTINGS, differenceToleranceAmount: 0 }
  }
  const basis = basisWords(settings.billingBasis)
  const q = new Dec(settings.quantityTolerancePct).toString()
  const p = new Dec(settings.priceTolerancePct).toString()
  const amount = settings.differenceToleranceAmount > 0 ? settings.differenceToleranceAmount : 0
  const pending = settings.decided ? { en: '', it: '' } : { en: ' Some figures are not set yet (they follow the W2a rule: exact, on what was received).', it: ' Alcuni valori non sono ancora impostati (seguono la regola W2a: esatta, su quanto ricevuto).' }
  return {
    basis: settings.billingBasis,
    quantityTolerancePct: settings.quantityTolerancePct,
    priceTolerancePct: settings.priceTolerancePct,
    decided: settings.decided,
    differenceToleranceAmount: amount,
    words: {
      en: `Payables settings: an invoice is paid on ${basis.en}, at the price ordered, within ${q} % on the quantity and ${p} % on the price${amount > 0 ? `, and any difference up to ${amount} minor units` : ''} (an order line that names an area tolerance keeps it for the quantity).${pending.en}`,
      it: `Impostazioni fornitori: si paga ${basis.it}, al prezzo d'ordine, con tolleranza del ${q} % sulla quantità e del ${p} % sul prezzo${amount > 0 ? `, e ogni differenza fino a ${amount} centesimi` : ''} (una riga d'ordine con una tolleranza sulla superficie la mantiene per la quantità).${pending.it}`,
    },
  }
}

export interface PayablesSettingsInput {
  readonly quantityTolerancePct?: string | null | undefined
  readonly priceTolerancePct?: string | null | undefined
  readonly differenceToleranceAmount?: number | null | undefined
  readonly billingBasis?: MatchBasis | null | undefined
  readonly sdiApproval?: PayablesSdiApproval | null | undefined
  readonly sdiApproverIds?: readonly string[] | undefined
  readonly accepterMayNotApprove?: boolean | null | undefined
}

const PCT = /^\d{1,3}(\.\d{1,4})?$/

/** What is wrong with a change of the settings (400 issues at body/…; empty: fine). `after` is the row as it would be. */
export function payablesSettingsProblems(after: PayablesSettingsRow): Issue[] {
  const issues: Issue[] = []
  for (const field of ['quantityTolerancePct', 'priceTolerancePct'] as const) {
    const value = after[field]
    if (value === null) continue
    if (!PCT.test(value) || new Dec(value).greaterThan(100)) issues.push({ path: `body/${field}`, message: 'A percentage from 0 to 100, at most four decimals.' })
  }
  if (after.differenceToleranceAmount !== null && (!Number.isSafeInteger(after.differenceToleranceAmount) || after.differenceToleranceAmount < 0)) {
    issues.push({ path: 'body/differenceToleranceAmount', message: 'An amount of 0 or more, in minor units (cents).' })
  }
  if (after.sdiApproval === 'LISTED' && after.sdiApproverIds.length === 0) issues.push({ path: 'body/sdiApproverIds', message: 'Name who approves what SDI delivered: one office user or more.' })
  if (after.sdiApproval !== 'LISTED' && after.sdiApproverIds.length > 0) issues.push({ path: 'body/sdiApproverIds', message: 'People are listed only when the rule is LISTED.' })
  if (new Set(after.sdiApproverIds).size !== after.sdiApproverIds.length) issues.push({ path: 'body/sdiApproverIds', message: 'Each person once.' })
  if (after.accepterMayNotApprove === false) issues.push({ path: 'body/accepterMayNotApprove', message: 'Whoever accepted a difference never approves the invoice (the four eyes of B-W2a-F7): it cannot be lifted.' })
  return issues
}

/**
 * The SDI approval rule for one person on one invoice SDI delivered (null: it may). `buyers` are the people who sent the
 * orders its lines bill (the purchase order's sender or maker, the subcontract order's issuer or maker).
 */
export function sdiApprovalProblem(settings: Pick<EffectivePayablesSettings, 'sdiApproval' | 'sdiApproverIds'>, invoice: { readonly source: string }, approverId: string, buyers: readonly string[]): Refusal | null {
  if (invoice.source !== 'SDI') return null
  if (settings.sdiApproval === 'LISTED' && !settings.sdiApproverIds.includes(approverId)) return { code: 'NOT_A_LISTED_APPROVER', message: 'Invoices from SDI are approved only by the people the payables settings list: you are not one of them.' }
  if (settings.sdiApproval === 'NOT_THE_BUYER' && buyers.includes(approverId)) return { code: 'OWN_ORDER', message: 'You sent an order this invoice bills, so someone else approves it (payables settings).' }
  return null
}
