import { differs, type LineFacts } from '../counts/rules'
import type { RuleSource } from '../posting/rules'

/**
 * Separation of duties (B-W2b-299; SCM-293; design warehouse.settings ws-sod "Receiver cannot approve the invoice match;
 * counter cannot approve their own variance"): two switches of the warehouse rules (InventorySettings, the company's row,
 * else the tenant-wide row, else ON — exactly as the database reads `factory_wh_counter_not_approver`).
 *
 *   COUNTER_NOT_APPROVER   who counted, recounted or scanned a unit of a line that differs never approves the count's
 *                          differences, and a recount (by scan) is another person's. The database holds it too.
 *   RECEIVER_NOT_MATCHER   who received the goods an invoice bills (posted or made the receipt, or received the work back
 *                          from the workshop) never approves that invoice nor accepts a difference of its match (payables;
 *                          the API's rule: no database rule).
 *
 * Switching one off widens what one person can do: it asks the reason (kept as separationOffReason while a switch is off) and
 * a fresh code (the step-up). Switching one on asks nothing. Pure.
 */

export const SEPARATION_RULES = ['COUNTER_NOT_APPROVER', 'RECEIVER_NOT_MATCHER'] as const
export type SeparationRule = (typeof SEPARATION_RULES)[number]

export const SEPARATION_FIELDS: Readonly<Record<SeparationRule, 'counterNotApprover' | 'receiverNotMatcher'>> = Object.freeze({
  COUNTER_NOT_APPROVER: 'counterNotApprover',
  RECEIVER_NOT_MATCHER: 'receiverNotMatcher',
})

export interface SeparationRow {
  readonly counterNotApprover: boolean | null
  readonly receiverNotMatcher: boolean | null
  readonly separationOffReason: string | null
}

export interface SwitchInForce {
  readonly on: boolean
  readonly source: RuleSource
}

export type SeparationInForce = Readonly<Record<SeparationRule, SwitchInForce>>

/** The switches in force for a company (its row, then the tenant-wide row, then on), or tenant-wide (`company` undefined). */
export function separationInForce(company: SeparationRow | null | undefined, tenant: SeparationRow | null | undefined): SeparationInForce {
  const pick = (field: 'counterNotApprover' | 'receiverNotMatcher'): SwitchInForce => {
    if (company && company[field] !== null) return { on: company[field], source: 'COMPANY' }
    if (tenant && tenant[field] !== null) return { on: tenant[field], source: 'TENANT' }
    return { on: true, source: 'DEFAULT' }
  }
  return { COUNTER_NOT_APPROVER: pick('counterNotApprover'), RECEIVER_NOT_MATCHER: pick('receiverNotMatcher') }
}

/** A switch on before and off after (in force): it widens what one person can do. */
export const separationLoosened = (before: SeparationInForce, after: SeparationInForce): SeparationRule[] => SEPARATION_RULES.filter((rule) => before[rule].on && !after[rule].on)

/** The words of a reason a rule is switched off: 1 to 500 characters. */
export function offReasonProblem(reason: string | null | undefined): string | null {
  const text = reason?.trim() ?? ''
  if (text.length === 0) return 'Switching a separation rule off needs the reason (it lets one person do both steps).'
  if (text.length > 500) return 'The reason is at most 500 characters.'
  return null
}

export const SEPARATION_WORDS: Readonly<Record<SeparationRule, { readonly on: { en: string; it: string }; readonly off: { en: string; it: string } }>> = Object.freeze({
  COUNTER_NOT_APPROVER: {
    on: {
      en: 'Who counted, recounted or scanned a line that differs never approves the count; a recount is another person’s.',
      it: 'Chi ha contato, ricontato o scansionato una riga con differenza non approva mai il conteggio; il riconteggio è di un’altra persona.',
    },
    off: {
      en: 'Off: one person may count, recount and approve the same differences.',
      it: 'Disattivata: una sola persona può contare, ricontare e approvare le stesse differenze.',
    },
  },
  RECEIVER_NOT_MATCHER: {
    on: {
      en: 'Who received the goods never approves their supplier invoice nor accepts a difference of its match.',
      it: 'Chi ha ricevuto la merce non approva mai la fattura del fornitore né accetta una differenza del suo abbinamento.',
    },
    off: {
      en: 'Off: the person who received the goods may approve their invoice.',
      it: 'Disattivata: chi ha ricevuto la merce può approvarne la fattura.',
    },
  },
})

export interface VarianceLine extends LineFacts {
  readonly seq: number
  readonly countedById: string | null
  readonly recountedById: string | null
  /** The office users who scanned a unit of the line (a worker as the office user they are). */
  readonly scannedByUserIds: readonly string[]
}

const listed = (seqs: readonly number[]): string => (seqs.length <= 12 ? seqs.join(', ') : `${seqs.slice(0, 12).join(', ')} and ${seqs.length - 12} more`)

/**
 * The counter never approves their own variance (SCM-229, SCM-293), while the switch is on and the approval is needed: the
 * approver counted, recounted or scanned no line that differs. Switched off: anyone who may approve does.
 */
export function ownVarianceProblems(input: { readonly switchOn: boolean; readonly approvalRequired: boolean; readonly approverId: string; readonly lines: readonly VarianceLine[] }): { readonly code: 'OWN_VARIANCE'; readonly message: string }[] {
  if (!input.switchOn || !input.approvalRequired) return []
  const own = input.lines
    .filter((line) => differs(line) && (line.countedById === input.approverId || line.recountedById === input.approverId || line.scannedByUserIds.includes(input.approverId)))
    .map((line) => line.seq)
  return own.length > 0
    ? [{ code: 'OWN_VARIANCE', message: `You counted, recounted or scanned ${own.length} line(s) that differ (${listed(own)}); a person who did not count them approves the differences.` }]
    : []
}

/**
 * The receiver never approves their invoice (RECEIVER_NOT_MATCHER, while on): the refusal in words when the person is one of
 * the receivers of what the invoice bills.
 */
export function receiverProblem(input: { readonly switchOn: boolean; readonly personId: string; readonly receiverIds: readonly string[]; readonly number: string; readonly acting: 'APPROVE' | 'ACCEPT' }): { readonly code: 'RECEIVED_THE_GOODS'; readonly message: string } | null {
  if (!input.switchOn || !input.receiverIds.includes(input.personId)) return null
  return {
    code: 'RECEIVED_THE_GOODS',
    message:
      input.acting === 'APPROVE'
        ? `You received the goods invoice ${input.number} bills: another person approves it (separation of duties).`
        : `You received the goods invoice ${input.number} bills: another person accepts the differences of its match (separation of duties).`,
  }
}
