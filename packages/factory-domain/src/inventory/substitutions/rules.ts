import { Dec, ZERO, type Decimal, type DecimalInput } from '../../tax/decimal'
import { quantityText } from '../ledger/moves'
import { alternateUse, type AlternateHeld, type AlternateUse } from '../../product/bom-lines/rules'
import { baseFactor, type ItemUnits, type Uom } from '../../product/units/units'

/**
 * Substitutes with a yes (B-W2b-298; MES-139; follow-up PK1:01 of B-W2b-228; design warehouse.picking pop:pk-sub "Use a
 * substitute", production.workorders Materials "Substitute…"), pure: when another material may stand in for a BOM line's own
 * on a work order, and what the substitution record (MaterialSubstitution, B-W2b-277) keeps.
 *
 *   what            another lot of the line's own material (any colour; its lot named), or one of the line's alternates
 *                   (BomLineAlternate, B-W2b-228) with its colour
 *   the rule        B-W2b-228's `alternateUse`, called with the work order's facts: the line's own material short for the work
 *                   order (no free stock covers what it still needs), the certificate check done (a VALID certificate in the
 *                   register covers the substitute today), and no person's yes yet. Its answer is kept as it was given.
 *                   ONLY_WHEN_SHORT while the own material is not short: refused. NEEDS_CERTIFICATE_CHECK with no certificate:
 *                   refused (MES-139: a PPE component outside its certificate is not used). NEEDS_APPROVAL: a person's yes.
 *                   Another lot of the own material is not an alternate of the BOM: a person's yes too
 *   the yes         an approval request of kind MATERIAL_SUBSTITUTION (the approval engine, B-W2b-282): its rules say who
 *                   decides. A use that needs a person while no switched-on rule asks anyone is refused in words (nobody could
 *                   decide it). A use that needs nobody (an ALWAYS alternate, a WHEN_SHORT one while short) is approved at once
 *                   unless a rule asks for a yes. Nobody decides their own request
 *   the issue       an approved substitute is issued with its own moves (ISSUE of the substitute to the work order), at most
 *                   what the substitution names unless the office over-issues with the reason; then it is ISSUED, final
 *   the line        what the substitute stands for of the line's own material (`replacesOwn`), so the pick list says what is
 *                   still to pick of the line
 *
 * Sentences are English (as W1's); the screens say their own words by the codes. No money.
 */

export const SUBSTITUTION_STATUSES = ['WAITING', 'APPROVED', 'ISSUED', 'REFUSED', 'WITHDRAWN'] as const
export type SubstitutionStatus = (typeof SUBSTITUTION_STATUSES)[number]

/** The statuses that still stand for some of the line (asked, approved or issued). */
export const STANDING_STATUSES = ['WAITING', 'APPROVED', 'ISSUED'] as const satisfies readonly SubstitutionStatus[]

/** What happened to a substitution (its event's `change`). */
export const SUBSTITUTION_CHANGES = ['ASKED', 'APPROVED', 'REFUSED', 'WITHDRAWN', 'ISSUED'] as const
export type SubstitutionChange = (typeof SUBSTITUTION_CHANGES)[number]

export const SUBSTITUTE_KINDS = ['OWN_MATERIAL', 'ALTERNATE'] as const
export type SubstituteKind = (typeof SUBSTITUTE_KINDS)[number]

/** The database's limits (…_warehouse_depth_w2b_guards). */
export const SUBSTITUTION_LIMITS = Object.freeze({ reason: 1000, note: 2000, withdrawReason: 500, reasonCode: 40, list: 200 })

export const SUBSTITUTION_REFUSAL_CODES = [
  'NOT_OPEN',
  'NOT_ON_THE_LINE',
  'ONLY_WHEN_SHORT',
  'OUTSIDE_CERTIFICATE',
  'NO_APPROVER',
  'LOT_NOT_USABLE',
  'TOO_MUCH',
  'NOT_APPROVED',
  'NOT_WAITING',
  'WRONG_STOCK',
] as const
export type SubstitutionRefusalCode = (typeof SUBSTITUTION_REFUSAL_CODES)[number]

export interface SubstitutionRefusal {
  readonly code: SubstitutionRefusalCode
  readonly message: string
}

/** The alternate rule's answer as the record keeps it (the database asks an object with `may`). */
export interface RuleAnswer {
  readonly may: boolean
  readonly held: readonly (AlternateHeld | 'NEEDS_APPROVAL')[]
  readonly message: string
}

/** The facts of one ask, read for the work order. */
export interface AskFacts {
  readonly kind: SubstituteKind
  /** The BOM line: its number and its own material's code. */
  readonly line: { readonly seq: number; readonly materialCode: string }
  /** The line's alternate that is used (ALTERNATE only). */
  readonly alternate: { readonly priority: number; readonly code: string; readonly allowedWhen: AlternateUse; readonly certificateCheck: boolean } | null
  /** A certificate check is needed: the alternate asks one, or the line's material or the substitute is a PPE component. */
  readonly certificateRequired: boolean
  /** The VALID certificate in the register that covers the substitute today, or null. */
  readonly certificate: { readonly number: string; readonly validTo: string } | null
  /** The line's own material is short for the work order (no free stock covers what it still needs). */
  readonly ownShort: boolean
}

export interface AskAnswer {
  /** What the record keeps (the rule's answer as given, before any yes). */
  readonly ruleAnswer: RuleAnswer
  /** A person must say yes before it is used. */
  readonly needsPerson: boolean
  /** Why it may not be asked at all, or null. */
  readonly refusal: SubstitutionRefusal | null
}

/** The rule's answer for an ask, with what it means for the request (rules in the header). */
export function askAnswer(facts: AskFacts): AskAnswer {
  if (facts.kind === 'OWN_MATERIAL' || facts.alternate === null) {
    return {
      ruleAnswer: {
        may: false,
        held: ['NEEDS_APPROVAL'],
        message: `Another lot of line ${facts.line.seq}'s own material (${facts.line.materialCode}) is not an alternate of the BOM: a person approves its use.`,
      },
      needsPerson: true,
      refusal: null,
    }
  }
  const { alternate } = facts
  const answer = alternateUse({
    priority: alternate.priority,
    code: alternate.code,
    allowedWhen: alternate.allowedWhen,
    certificateCheck: facts.certificateRequired,
    ownShort: facts.ownShort,
    approved: false,
    certificateChecked: facts.certificate !== null,
  })
  const ruleAnswer: RuleAnswer = { may: answer.may, held: answer.held, message: answer.message }
  if (answer.held.includes('ONLY_WHEN_SHORT')) {
    return {
      ruleAnswer,
      needsPerson: false,
      refusal: {
        code: 'ONLY_WHEN_SHORT',
        message: `Alternate ${alternate.priority} (${alternate.code}) is used only when line ${facts.line.seq}'s own material (${facts.line.materialCode}) is short, and the stock covers what the work order still needs: pick ${facts.line.materialCode}.`,
      },
    }
  }
  if (answer.held.includes('NEEDS_CERTIFICATE_CHECK')) {
    return {
      ruleAnswer,
      needsPerson: false,
      refusal: {
        code: 'OUTSIDE_CERTIFICATE',
        message: `${alternate.code} needs its certificate check, and no valid certificate in the register covers it today: a PPE component outside its certificate is not used (the notified body may have to agree first).`,
      },
    }
  }
  return { ruleAnswer, needsPerson: answer.held.includes('NEEDS_APPROVAL'), refusal: null }
}

/** The words of an ask that needs a person while no switched-on approval rule asks anyone. */
export const noApproverWords = (what: string): string =>
  `${what} needs a person's yes, and no approval rule for substitutes is switched on: ask whoever keeps Admin › Automation › Approval rules to set one (kind Material substitution).`

/** The facts of the line and the substitute that say how much of the line's own material a substitute stands for. */
export interface ReplaceFacts {
  readonly kind: SubstituteKind
  /** The line's quantity per output unit, in its own unit, and the own material's units. */
  readonly lineQty: DecimalInput
  readonly lineUom: Uom
  readonly ownUnits: ItemUnits
  /** The alternate's quantity per output unit in the line's unit (null: the line's), and the substitute's units. */
  readonly alternateQty: DecimalInput | null
  readonly substituteUnits: ItemUnits
}

/**
 * How much of the line's own material (its base unit) `baseQuantity` of the substitute (its base unit) stands for: another
 * lot of the own material one for one; an alternate by the two quantities per output unit (the line's and the alternate's,
 * each in its material's base unit). Null when a unit does not convert (B-W2b-228 refuses such an alternate).
 */
export function replacesOwn(facts: ReplaceFacts, baseQuantity: DecimalInput): Decimal | null {
  const quantity = new Dec(baseQuantity)
  if (facts.kind === 'OWN_MATERIAL') return quantity
  const ownFactor = baseFactor(facts.lineUom, facts.ownUnits)
  const substituteFactor = baseFactor(facts.lineUom, facts.substituteUnits)
  if (ownFactor === null || substituteFactor === null) return null
  const own = new Dec(facts.lineQty).times(ownFactor)
  const substitute = new Dec(facts.alternateQty ?? facts.lineQty).times(substituteFactor)
  if (substitute.lte(ZERO)) return null
  return quantity.times(own).div(substitute)
}

/**
 * What a substitute may still be asked for, of the line's own material: what the work order still needs of the line less what
 * standing substitutes stand for; a WHEN_SHORT alternate only the short part.
 */
export function stillOpen(facts: { readonly toIssue: DecimalInput; readonly short: DecimalInput; readonly standing: DecimalInput; readonly onlyShort: boolean }): Decimal {
  const need = new Dec(facts.onlyShort ? facts.short : facts.toIssue)
  return Dec.max(ZERO, need.minus(new Dec(facts.standing)))
}

/** An ask above what is still open (of the line's own material, base unit), in words; null when it fits. */
export function tooMuchRefusal(facts: { readonly asked: DecimalInput; readonly open: DecimalInput; readonly ownCode: string; readonly baseUom: string; readonly onlyShort: boolean }): SubstitutionRefusal | null {
  if (new Dec(facts.asked).lte(new Dec(facts.open))) return null
  const open = quantityText(facts.open)
  return {
    code: 'TOO_MUCH',
    message: new Dec(facts.open).lte(ZERO)
      ? `Nothing of ${facts.ownCode} is left to replace on this line${facts.onlyShort ? ' (only the short part may be)' : ''}.`
      : `This stands for more ${facts.ownCode} than is left to replace on the line: at most ${open} ${facts.baseUom}${facts.onlyShort ? ' (the short part)' : ''}.`,
  }
}

/** Why an issue of the substitute is refused now (its status), or null. */
export function issueRefusal(status: SubstitutionStatus): SubstitutionRefusal | null {
  switch (status) {
    case 'APPROVED':
      return null
    case 'WAITING':
      return { code: 'NOT_APPROVED', message: 'This substitute still waits for its yes: it is issued once approved.' }
    case 'ISSUED':
      return { code: 'NOT_APPROVED', message: 'This substitute is issued already.' }
    case 'REFUSED':
      return { code: 'NOT_APPROVED', message: 'This substitute was refused: it is not issued.' }
    default:
      return { code: 'NOT_APPROVED', message: 'This substitute was withdrawn: it is not issued.' }
  }
}

/** Why a substitution may not be withdrawn now, or null (WAITING or APPROVED, not yet issued). */
export function withdrawRefusal(status: SubstitutionStatus): SubstitutionRefusal | null {
  if (status === 'WAITING' || status === 'APPROVED') return null
  return { code: 'NOT_WAITING', message: status === 'ISSUED' ? 'This substitute is issued: return what is left to stock instead.' : `This substitute is ${status.toLowerCase()} already.` }
}

/** The words of a substitution's state, for a list ("Waiting for a yes", "Approved: pick it"). */
export const STATUS_WORDS: Readonly<Record<SubstitutionStatus, string>> = Object.freeze({
  WAITING: 'Waiting for a yes',
  APPROVED: 'Approved: pick it',
  ISSUED: 'Issued',
  REFUSED: 'Refused',
  WITHDRAWN: 'Withdrawn',
})

/** The sum of what standing substitutions stand for (null entries: a unit that does not convert, left out). */
export const standingTotal = (rows: readonly { readonly status: SubstitutionStatus; readonly replaces: DecimalInput | null }[]): Decimal =>
  rows.reduce((sum, row) => ((STANDING_STATUSES as readonly string[]).includes(row.status) && row.replaces !== null ? sum.plus(new Dec(row.replaces)) : sum), ZERO)
