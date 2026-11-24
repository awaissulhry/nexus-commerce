import type { Party, TaxIdentity } from '../../../../parties/_shared/api'
import type { HoldRow, WaitingModel } from './holds'
import type { TermsInForce } from './in-force'
import { daysUntil, IDENTITY_ROWS, said, text, VIES_ENDS_WITHIN_DAYS, type Said, type TermsSectionId } from './model'

/**
 * F-CT-104 (customer page › TERMS & REQUIREMENTS tab, lane ct-; 10-design §4; 18-lead-settles Z3, Z6, Z23, Z27, Z28) — the tab's answer
 * line, pure: ONE sentence for the company the reader works in — on what terms we work with this customer (from the ONE in-force
 * helper), whether every order must carry its PO number, how many requirements, whether we can invoice it — and the chips of what waits
 * on us, each a door to EXACTLY its rows ON this tab (the hold rows, the quotes waiting for the hold or for a PO number, the identity's
 * e-invoice fact, the VIES row). Only what is true and read is said: a read not in is left out, a failed read is never "none"; when
 * the terms per company could not be read the sentence says the customer's own terms, and says so. No tab count (Z28).
 */

export const TERMS_CHIPS = ['hold', 'waitHold', 'waitPo', 'waitOrder', 'noIdentity', 'noSdi', 'viesEnds', 'viesInvalid', 'viesUnchecked'] as const
export type TermsChipId = (typeof TERMS_CHIPS)[number]

export interface TermsChip {
  readonly id: TermsChipId
  readonly tone: 'warning' | 'danger'
  readonly label: Said
  /** The section it opens (scrolled into view). */
  readonly section: TermsSectionId
  /** The rows it marks there (their addresses). */
  readonly rows: readonly string[]
  /** A door off the tab instead (Quotes › Order waits, while the server does not say why each quote waits — Z6). */
  readonly door: string | null
}

/** The identity facts the answer reads (the party read: the identity in force, its warnings, its VIES standing). */
export interface IdentityFacts {
  readonly identity: TaxIdentity | null
  /** FISCAL_DRAWER: an Italian business without an SDI code or a PEC (its invoices go to the fiscal drawer, Z3). */
  readonly fiscalDrawer: boolean
  readonly vies: Party['vies']
}

export function identityFactsOf(party: Pick<Party, 'taxIdentities' | 'warnings' | 'vies'>): IdentityFacts {
  return { identity: party.taxIdentities.find((row) => row.current) ?? null, fiscalDrawer: party.warnings.some((warning) => warning.code === 'FISCAL_DRAWER'), vies: party.vies }
}

export interface TermsFacts {
  /** A customer of two or more of our companies (the sentence starts "With {company}: "). */
  readonly multi: boolean
  /** The company the reader works in (its name); null: none. */
  readonly company: string | null
  /** The terms in force with that company; null: the customer's own terms are not read yet. */
  readonly inForce: TermsInForce | null
  /** The terms per company could not be read (the sentence says the customer's own, and says so; no PO chip). */
  readonly companiesFailed: boolean
  /** Nothing set beyond what every customer starts with (Commercial terms says it in one line). */
  readonly blank: boolean
  readonly holds: readonly HoldRow[]
  readonly waiting: WaitingModel
  /** How many requirements are in force; null: not read (left out). */
  readonly requirements: number | null
  readonly identity: IdentityFacts
  /** ISO now (VIES's days left). */
  readonly now: string
}

export interface TermsAnswer {
  /** "With {company}: " before the sentence (two or more of our companies), else null. */
  readonly lead: Said | null
  /** The sentence's parts, said joined with " · " and a full stop. */
  readonly words: readonly Said[]
  /** The terms per company could not be read: these are the customer's own (said under the sentence). */
  readonly fallback: Said | null
  readonly chips: readonly TermsChip[]
  readonly tone: 'info' | 'warning' | 'danger'
}

const ITALIAN = new Set(['IT_B2B', 'IT_B2C'])
const realSdi = (code: string | null): boolean => code !== null && code.trim() !== '' && code !== '0000000'

/** The invoicing part of the sentence: by SDI code / by PEC / no SDI code or PEC · VIES · no tax identity. */
function invoicingWords(facts: IdentityFacts): Said | null {
  const identity = facts.identity
  if (!identity) return said('ct.answer.noIdentity')
  if (ITALIAN.has(identity.taxMode)) return realSdi(identity.sdiRecipientCode) ? said('ct.answer.sdi') : identity.pec ? said('ct.answer.pec') : said('ct.answer.noSdi')
  if (identity.taxMode === 'EU_B2B') {
    const vies = facts.vies
    if (vies.state === 'VALID' && vies.validUntil) return said('ct.answer.viesValid', { days: { date: vies.validUntil } })
    if (vies.state === 'INVALID') return said('ct.answer.viesInvalid')
    if (vies.state !== 'NOT_APPLICABLE') return said('ct.answer.viesUnchecked')
  }
  return null
}

/** The chips of the identity (no tax identity, no SDI code or PEC, VIES) — each opens #party-identity at its row. */
function identityChips(facts: IdentityFacts, now: string): TermsChip[] {
  const chip = (id: TermsChipId, tone: TermsChip['tone'], label: Said, rows: readonly string[]): TermsChip => ({ id, tone, label, section: 'party-identity', rows, door: null })
  if (!facts.identity) return [chip('noIdentity', 'danger', said('ct.chip.noIdentity'), [])]
  const out: TermsChip[] = []
  // Z3: a warning (its invoices go to the fiscal drawer, a copy by mail), never "cannot be invoiced" — the server's own warning.
  if (facts.fiscalDrawer) out.push(chip('noSdi', 'warning', said('ct.chip.noSdi'), [IDENTITY_ROWS.einvoice]))
  if (facts.identity.taxMode === 'EU_B2B') {
    const vies = facts.vies
    const days = daysUntil(vies.validUntil, now)
    if (vies.state === 'VALID' && days !== null && days <= VIES_ENDS_WITHIN_DAYS) out.push(chip('viesEnds', 'warning', said('ct.chip.viesEnds', { params: { count: Math.max(days, 0) } }), [IDENTITY_ROWS.vies]))
    else if (vies.state === 'INVALID') out.push(chip('viesInvalid', 'danger', said('ct.chip.viesInvalid'), [IDENTITY_ROWS.vies]))
    // Z23: no answer is never "not valid"; a proof that ended or was never made is "not checked".
    else if (vies.state === 'UNCHECKED' || vies.state === 'EXPIRED' || vies.state === 'HELD') out.push(chip('viesUnchecked', 'warning', said('ct.chip.viesUnchecked'), [IDENTITY_ROWS.vies]))
  }
  return out
}

/** The answer line (pure): the sentence for the reader's company and the chips of what waits on us. */
export function termsAnswer(facts: TermsFacts): TermsAnswer {
  const words: Said[] = []
  const inForce = facts.inForce
  if (inForce) {
    if (facts.blank) words.push(said('ct.answer.nothingSet'))
    else {
      words.push(inForce.paymentTerms ? text(inForce.paymentTerms.name) : said('ct.answer.noTerms'))
      // The deposit: its own percent; omitted when the terms' name already says it (their order share); else the sales settings.
      if (inForce.deposit.from === 'COMPANY' || inForce.deposit.from === 'PARTY') words.push(said('ct.answer.deposit', { pcts: { pct: inForce.deposit.pct! } }))
      else if (inForce.deposit.from === 'SETTINGS') words.push(said('ct.answer.depositSettings'))
    }
    if (inForce.poNumberRequired) words.push(said('ct.answer.po'))
  }
  if (facts.requirements !== null) words.push(facts.requirements > 0 ? said('ct.answer.requirements', { params: { count: facts.requirements } }) : said('ct.answer.noRequirements'))
  const invoicing = invoicingWords(facts.identity)
  if (invoicing) words.push(invoicing)

  const chips: TermsChip[] = []
  if (facts.holds.length === 1) chips.push({ id: 'hold', tone: 'danger', label: said('ct.chip.hold', { lower: { reason: said(`sales-customers-depth:reason.${facts.holds[0]!.reason}`) } }), section: 'party-hold', rows: [facts.holds[0]!.anchor], door: null })
  else if (facts.holds.length > 1) chips.push({ id: 'hold', tone: 'danger', label: said('ct.chip.holds', { params: { count: facts.holds.length } }), section: 'party-hold', rows: facts.holds.map((row) => row.anchor), door: null })
  const waiting = facts.waiting
  if (waiting.byReason && waiting.counts) {
    // Z27: the hold and PO chips open their rows ON this tab (the Quotes group mixes every reason).
    if (waiting.counts.hold > 0) chips.push({ id: 'waitHold', tone: 'warning', label: said('ct.chip.waitHold', { params: { count: waiting.counts.hold } }), section: 'party-hold', rows: waiting.hold.map((row) => row.anchor), door: null })
    if (waiting.counts.po > 0 && !facts.companiesFailed) chips.push({ id: 'waitPo', tone: 'warning', label: said('ct.chip.waitPo', { params: { count: waiting.counts.po } }), section: 'party-commercial', rows: waiting.po.map((row) => row.anchor), door: null })
  } else if (waiting.total > 0) {
    // Z6: before S4 nobody can say why each quote waits — the count, and the door to Quotes › Order waits.
    chips.push({ id: 'waitOrder', tone: 'warning', label: said('sales-customers-depth:hold.waiting', { params: { count: waiting.total } }), section: 'party-hold', rows: [], door: waiting.door })
  }
  chips.push(...identityChips(facts.identity, facts.now))
  return {
    lead: facts.multi && facts.company ? said('ct.answer.with', { params: { company: facts.company } }) : null,
    words,
    fallback: inForce && facts.companiesFailed ? said('ct.answer.fallback') : null,
    chips,
    tone: chips.some((chip) => chip.tone === 'danger') ? 'danger' : chips.length > 0 ? 'warning' : 'info',
  }
}
