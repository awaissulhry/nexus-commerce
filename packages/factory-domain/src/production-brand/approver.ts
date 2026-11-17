import { SAMPLE_ROUND_RECORD, type ApprovalKind, type ApprovalLocale } from '../approvals-out/kinds'

/**
 * B-PR-29 (production plan §3 "Brand alone", §C S-LIM-approver "Any person with Production access · or a named approver (one of
 * their portal people) for production approvals — the portal shows other people 'Waiting for <name>'"; 08-backend §2
 * PortalSettings.productionApproverId; review fix R-25 "Name the kinds the approver covers, and who keeps the others"): the
 * customer's named approver, pure.
 *
 *   covered       the customer's production approvals only: PP (a SAMPLE asked on a PRE_PRODUCTION round), the size set (a
 *                 SIZE_SET round), the top of production (a TOP_OF_PRODUCTION round), fabric (FABRIC) and trims (TRIM). Only
 *                 the named person answers them; the top of production also the customer's Quality people
 *   not covered   every other kind keeps today's rule (any of the customer's people with the right to approve): the Designer's
 *                 artwork, design proofs and development samples (proto, fit, salesman, CE test, brand sample, a sample asked
 *                 on a style, a quote or an order), colours and leathers, Quality's concessions, the Buyer's revised orders,
 *                 new dates and counter-offers, signatures
 *   nobody named  today's rule; a named person no longer active counts as nobody named (never a request nobody may answer)
 *   a link        names nobody: with a named approver a covered request is answered in the portal, by that person
 *
 * The words name the approver to the customer's own people only (a colleague of theirs); they never name anyone of ours or of
 * another customer.
 */

/** The round kinds whose SAMPLE approval is a production approval (PP, size set, top of production). */
export const APPROVER_ROUND_KINDS = ['PRE_PRODUCTION', 'SIZE_SET', 'TOP_OF_PRODUCTION'] as const
/** The approval kinds that are production approvals on any record (fabric, trims). */
export const APPROVER_KINDS = ['FABRIC', 'TRIM'] as const satisfies readonly ApprovalKind[]

/** Who answers a covered request: the named person only, or (the top of production) also the customer's Quality people. */
export const APPROVER_RULES = ['APPROVER', 'APPROVER_OR_QUALITY'] as const
export type ApproverRule = (typeof APPROVER_RULES)[number]

/** The customer's Quality role (auth/roles/partner-templates: CUSTOMER quality). */
export const CUSTOMER_QUALITY_ROLE = 'customer-quality'

export interface ApproverRequest {
  readonly kind: ApprovalKind
  readonly recordType: string
  /** The round's kind when the request is about a SampleRound. */
  readonly sampleKind?: string | null | undefined
}

/** The rule a named approver puts on this request, or null: the request is not one of the customer's production approvals. */
export function approverRuleOf(request: ApproverRequest): ApproverRule | null {
  if ((APPROVER_KINDS as readonly string[]).includes(request.kind)) return 'APPROVER'
  if (request.kind !== 'SAMPLE' || request.recordType !== SAMPLE_ROUND_RECORD || !request.sampleKind) return null
  if (!(APPROVER_ROUND_KINDS as readonly string[]).includes(request.sampleKind)) return null
  return request.sampleKind === 'TOP_OF_PRODUCTION' ? 'APPROVER_OR_QUALITY' : 'APPROVER'
}

export interface Answerer {
  readonly via: 'LINK' | 'PORTAL'
  /** The portal person (null for a link). */
  readonly userId: string | null
  /** The person holds the customer's Quality role. */
  readonly quality: boolean
}

/** Whether this person may answer a request the rule covers, the approver being `approverId`. */
export function mayAnswerAsApprover(rule: ApproverRule, approverId: string, who: Answerer): boolean {
  if (who.via !== 'PORTAL' || who.userId === null) return false
  if (who.userId === approverId) return true
  return rule === 'APPROVER_OR_QUALITY' && who.quality
}

/** "Waiting for Anna: …", in the reader's language (the person may read the request, not answer it). */
export function approverHeldWords(rule: ApproverRule, name: string, via: 'LINK' | 'PORTAL', locale: ApprovalLocale): string {
  if (via === 'LINK') return locale === 'it' ? `In attesa di ${name}: ${name} risponde dal vostro portale.` : `Waiting for ${name}: ${name} answers it in your portal.`
  if (rule === 'APPROVER_OR_QUALITY') {
    return locale === 'it'
      ? `In attesa di ${name}: a questo campione di inizio produzione (TOP) rispondono ${name} o il vostro controllo qualità.`
      : `Waiting for ${name}: ${name} or your quality team answers this top-of-production sample.`
  }
  return locale === 'it' ? `In attesa di ${name}: è ${name} a rispondere alle vostre approvazioni di produzione.` : `Waiting for ${name}: ${name} answers your production approvals.`
}
