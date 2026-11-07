import type { PartnerTaskKind } from '../portal/tasks/kinds'

/**
 * Approval requests to partners (B-W2b-184; COL-064 "approval requests to partners", SAL-222 "customer re-confirmation of a
 * revised order", SAL-294 "design proof sign-off", QHS-085 "the customer's concession"; design links.approve; schema
 * links-depth.prisma ApprovalRequest, B-W2b-154). One engine for every yes we ask of a customer, a supplier or an outside
 * signer: the office asks from a record, the partner answers by its APPROVAL link or in its portal, once.
 *
 *   kind           record it asks about           approve with changes   the partner's task   due (default / most)
 *   CONCESSION     NcrConcession (QHS-085)        yes                    APPROVE              5 / 60 days
 *   SAMPLE         Style, Quote, SalesOrder,      yes                    APPROVE              7 / 60
 *   COLOUR         PurchaseOrder, SubcontractOrder
 *   LEATHER        (records with a thread and a party)
 *   ARTWORK
 *   PROOF          SalesOrderLine (made to measure)  yes                 APPROVE              5 / 60
 *   REVISED_ORDER  SalesOrderAmendment            no                     RECONFIRM_ORDER      5 / 60
 *   SIGNATURE      RiskAssessmentVersion          no                     APPROVE              14 / 60
 *
 * "Approve with changes" (design links.approve decision "Approve with comments (where the kind allows)") is an approval with
 * the partner's words (APPROVED_WITH_CHANGES); a refusal always says why. A revised order is accepted as it stands or refused
 * (a change is a new amendment), a signature is given or refused. Only REVISED_ORDER shows money: the party's own order, the
 * price grain (the partner task's grain, the APPROVAL link's grain); never a cost or a margin.
 */

export const APPROVAL_KINDS = ['CONCESSION', 'SAMPLE', 'COLOUR', 'LEATHER', 'ARTWORK', 'PROOF', 'REVISED_ORDER', 'SIGNATURE'] as const
export type ApprovalKind = (typeof APPROVAL_KINDS)[number]

export const APPROVAL_STATUSES = ['OPEN', 'APPROVED', 'APPROVED_WITH_CHANGES', 'REFUSED', 'WITHDRAWN', 'EXPIRED'] as const
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number]

/** What a partner answers. */
export const APPROVAL_DECISIONS = ['APPROVED', 'APPROVED_WITH_CHANGES', 'REFUSED'] as const
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number]
export const isAnswered = (status: ApprovalStatus): boolean => (APPROVAL_DECISIONS as readonly string[]).includes(status)

/** How a request was answered: by its link, or by a person in the portal. */
export const ANSWER_CHANNELS = ['LINK', 'PORTAL'] as const
export type AnswerChannel = (typeof ANSWER_CHANNELS)[number]

export type ApprovalLocale = 'it' | 'en'
export interface Words {
  readonly it: string
  readonly en: string
}

/** The records a sample, a colour, a leather or an artwork is asked on: records with a thread whose party is the partner. */
export const THREAD_RECORD_TYPES = ['Style', 'Quote', 'SalesOrder', 'PurchaseOrder', 'SubcontractOrder'] as const

export interface KindRule {
  readonly kind: ApprovalKind
  readonly recordTypes: readonly string[]
  /** "Approve with changes" is offered. */
  readonly withChanges: boolean
  /** The partner task it opens (portal/tasks/kinds). */
  readonly task: PartnerTaskKind
  /** It shows the party's own prices (the price grain). */
  readonly price: boolean
  /** Days to answer: the default and the most the office may give. */
  readonly dueDays: { readonly default: number; readonly max: number }
  /** At least one file goes with it (the sample's photos, the proof, the artwork). */
  readonly needsFiles: boolean
  readonly name: Words
}

const rule = (spec: KindRule): KindRule => Object.freeze({ ...spec, recordTypes: Object.freeze([...spec.recordTypes]), dueDays: Object.freeze({ ...spec.dueDays }), name: Object.freeze({ ...spec.name }) })

export const KIND_RULES: Readonly<Record<ApprovalKind, KindRule>> = Object.freeze({
  CONCESSION: rule({ kind: 'CONCESSION', recordTypes: ['NcrConcession'], withChanges: true, task: 'APPROVE', price: false, dueDays: { default: 5, max: 60 }, needsFiles: false, name: { it: 'Concessione', en: 'Concession' } }),
  SAMPLE: rule({ kind: 'SAMPLE', recordTypes: THREAD_RECORD_TYPES, withChanges: true, task: 'APPROVE', price: false, dueDays: { default: 7, max: 60 }, needsFiles: true, name: { it: 'Campione', en: 'Sample' } }),
  COLOUR: rule({ kind: 'COLOUR', recordTypes: THREAD_RECORD_TYPES, withChanges: true, task: 'APPROVE', price: false, dueDays: { default: 7, max: 60 }, needsFiles: true, name: { it: 'Colore', en: 'Colour' } }),
  LEATHER: rule({ kind: 'LEATHER', recordTypes: THREAD_RECORD_TYPES, withChanges: true, task: 'APPROVE', price: false, dueDays: { default: 7, max: 60 }, needsFiles: true, name: { it: 'Pellame', en: 'Leather' } }),
  ARTWORK: rule({ kind: 'ARTWORK', recordTypes: THREAD_RECORD_TYPES, withChanges: true, task: 'APPROVE', price: false, dueDays: { default: 7, max: 60 }, needsFiles: true, name: { it: 'Grafica', en: 'Artwork' } }),
  PROOF: rule({ kind: 'PROOF', recordTypes: ['SalesOrderLine'], withChanges: true, task: 'APPROVE', price: false, dueDays: { default: 5, max: 60 }, needsFiles: true, name: { it: 'Bozza del design', en: 'Design proof' } }),
  REVISED_ORDER: rule({ kind: 'REVISED_ORDER', recordTypes: ['SalesOrderAmendment'], withChanges: false, task: 'RECONFIRM_ORDER', price: true, dueDays: { default: 5, max: 60 }, needsFiles: false, name: { it: 'Ordine modificato', en: 'Revised order' } }),
  SIGNATURE: rule({ kind: 'SIGNATURE', recordTypes: ['RiskAssessmentVersion'], withChanges: false, task: 'APPROVE', price: false, dueDays: { default: 14, max: 60 }, needsFiles: false, name: { it: 'Firma', en: 'Signature' } }),
})

/** The kinds a record type is asked with. */
export const kindsFor = (recordType: string): ApprovalKind[] => APPROVAL_KINDS.filter((kind) => KIND_RULES[kind].recordTypes.includes(recordType))

/** Every record type an approval may name (the PartnerTask's record is the request itself). */
export const APPROVAL_RECORD_TYPES: readonly string[] = Object.freeze([...new Set(APPROVAL_KINDS.flatMap((kind) => KIND_RULES[kind].recordTypes))])
