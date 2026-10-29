import type { BusinessDate } from '../core/time'

/**
 * The words of Today's rows (B-W1-52; A2 SCR-029 "Needs me now": one sentence, and what waits on it). Every sentence is
 * written from the record's own facts and carries no amount: an amount is added by `presentItem` (./attention) only for
 * a reader who holds its grain. English only in W1 (the web keeps message keys for its own labels).
 */

export interface RowWords {
  readonly sentence: string
  /** What waits on it, in words; null when nothing does. */
  readonly blocks: string | null
}

const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`
/** At most five names, then "and N more". */
export function listed(values: readonly string[], max = 5): string {
  const shown = values.slice(0, max).join(', ')
  return values.length > max ? `${shown} and ${values.length - max} more` : shown
}

export function orderPromiseWords(facts: {
  readonly number: string
  readonly customer: string
  readonly state: 'LATE' | 'AT_RISK'
  /** Days late (LATE) or days left (AT_RISK). */
  readonly days: number
  readonly promiseDate: BusinessDate
  readonly toShip: number
}): RowWords {
  const sentence =
    facts.state === 'LATE'
      ? `Order ${facts.number} for ${facts.customer} is ${plural(facts.days, 'day')} late: it was promised for ${facts.promiseDate}.`
      : `Order ${facts.number} for ${facts.customer} is promised for ${facts.promiseDate} (${facts.days === 0 ? 'today' : `in ${plural(facts.days, 'day')}`}) and is not ready yet.`
  return { sentence, blocks: facts.toShip > 0 ? `${facts.customer} waits for ${plural(facts.toShip, 'piece')}.` : `${facts.customer} waits for the order.` }
}

const RELEASE_CHECK_WORDS: Readonly<Record<string, string>> = Object.freeze({
  REVISION: 'revision',
  LABEL_TEMPLATE: 'garment label',
  CERTIFICATE: 'certificate',
  WORK_CENTRES: 'work centres',
  BOM: 'bill of materials',
  CELLS: 'cells',
  DEPOSIT: 'deposit',
  MATERIAL: 'material',
  BATCH_NUMBER: 'batch number series',
})

/** `checks`: the release check's BLOCKED codes (production/work-orders/release). */
export function workOrderHeldWords(facts: { readonly number: string; readonly style: string; readonly checks: readonly string[]; readonly orders: readonly string[] }): RowWords {
  return {
    sentence: `Work order ${facts.number} (${facts.style}) cannot be released: ${plural(facts.checks.length, 'check')} open (${listed(facts.checks.map((check) => RELEASE_CHECK_WORDS[check] ?? check))}).`,
    blocks: facts.orders.length > 0 ? `Production of ${listed(facts.orders)} waits for it.` : null,
  }
}

export function lotHoldWords(facts: { readonly code: string; readonly item: string; readonly state: 'QUARANTINE' | 'BLOCKED'; readonly crViFail: boolean }): RowWords {
  return facts.state === 'QUARANTINE'
    ? { sentence: `Lot ${facts.code} (${facts.item}) waits in quarantine for its release.`, blocks: 'Its stock cannot be issued to work orders until it is released.' }
    : {
        sentence: `Lot ${facts.code} (${facts.item}) is blocked${facts.crViFail ? ': its chromium VI result failed' : ''}.`,
        blocks: 'Its stock stays held: reject the lot, or release it again with new evidence.',
      }
}

export type SdiAttentionState = 'REJECTED' | 'ERROR' | 'NOT_DELIVERABLE' | 'FILES_PENDING'

export function invoiceSdiWords(facts: { readonly number: string; readonly customer: string; readonly state: SdiAttentionState; readonly deadline: BusinessDate | null }): RowWords {
  switch (facts.state) {
    case 'REJECTED':
      return {
        sentence: `Invoice ${facts.number} for ${facts.customer} was rejected by SDI: correct it and send it again${facts.deadline ? ` by ${facts.deadline}` : ''}.`,
        blocks: 'Until it is sent again it counts as never issued.',
      }
    case 'ERROR':
      return { sentence: `Invoice ${facts.number} for ${facts.customer} did not reach SDI: send it again.`, blocks: 'The customer has no valid invoice yet.' }
    case 'NOT_DELIVERABLE':
      return {
        sentence: `SDI could not deliver invoice ${facts.number} to ${facts.customer}, and no courtesy copy went out.`,
        blocks: 'The customer finds it only in their tax area until they get a copy.',
      }
    case 'FILES_PENDING':
      return { sentence: `Invoice ${facts.number} for ${facts.customer} is issued, but its XML or PDF is not stored yet.`, blocks: 'It cannot go to SDI without its XML.' }
  }
}

const REASON_WORDS: Readonly<Record<string, string>> = Object.freeze({
  MARGIN_FLOOR: 'margin under the floor',
  DISCOUNT_LIMIT: 'discount over the limit',
  AMOUNT_LIMIT: 'amount over the limit',
  SPECIAL_ITEM: 'a special item',
})
export const approvalReasonWords = (reasons: readonly string[]): string => listed(reasons.map((reason) => REASON_WORDS[reason] ?? reason.toLowerCase()))

export function quoteApprovalWords(facts: { readonly number: string; readonly customer: string; readonly reasons: readonly string[] }): RowWords {
  return {
    sentence: `Quote ${facts.number} for ${facts.customer} waits for an approval: ${approvalReasonWords(facts.reasons)}.`,
    blocks: 'It cannot be sent to the customer until it is decided.',
  }
}

export function poProposalWords(facts: { readonly number: string; readonly supplier: string }): RowWords {
  return {
    sentence: `${facts.supplier} proposed changes to purchase order ${facts.number}: accept or refuse them.`,
    blocks: 'Receiving and a new link wait for your answer.',
  }
}

export function poNotConfirmedWords(facts: { readonly number: string; readonly supplier: string; readonly hours: number; readonly requestedDate: BusinessDate | null }): RowWords {
  const since = facts.hours >= 48 ? plural(Math.floor(facts.hours / 24), 'day') : plural(facts.hours, 'hour')
  return {
    sentence: `Purchase order ${facts.number} to ${facts.supplier} is not confirmed ${since} after it was sent.`,
    blocks: facts.requestedDate ? `The goods are needed by ${facts.requestedDate}.` : null,
  }
}

export function scanCorrectionWords(facts: { readonly workOrder: string; readonly operation: string; readonly bundle: string }): RowWords {
  return {
    sentence: `A correction of the scan of bundle ${facts.bundle} at ${facts.operation} (${facts.workOrder}) waits for a decision.`,
    blocks: `${facts.workOrder}'s progress counts the report as it was until the correction is decided.`,
  }
}

export function scanRefusalWords(facts: { readonly device: string; readonly message: string; readonly workOrder: string | null }): RowWords {
  return {
    sentence: `A scan sent from ${facts.device} was refused: ${facts.message}`,
    blocks: facts.workOrder ? `${facts.workOrder}'s progress misses it until it is scanned again or discarded.` : null,
  }
}

export function invoiceToIssueWords(facts: { readonly customer: string; readonly month: string; readonly ddts: readonly string[]; readonly deadlineWords: string }): RowWords {
  return {
    sentence: `${facts.customer}: ${plural(facts.ddts.length, 'DDT')} of ${facts.month} not invoiced yet (${listed(facts.ddts)}).`,
    blocks: `${facts.deadlineWords.replace(/\.+$/, '')}.`,
  }
}

const DUTY_WORDS: Readonly<Record<string, string>> = Object.freeze({
  RISK_ASSESSMENT: 'the risk to decide',
  CORRECTIVE_ACTION: 'the corrective action',
  DISTRIBUTORS: 'the distributors to inform',
  AUTHORITY: 'the authority to notify',
})

export function registerDutyWords(facts: { readonly reference: string; readonly kind: string; readonly style: string; readonly duties: readonly string[] }): RowWords {
  return {
    sentence: `PPE register ${facts.kind} ${facts.reference} (${facts.style}): ${listed(facts.duties.map((duty) => DUTY_WORDS[duty] ?? duty))}.`,
    blocks: 'The entry cannot close until these duties are done (Reg. (EU) 2016/425 art. 8).',
  }
}

const PRIVACY_WORDS: Readonly<Record<string, string>> = Object.freeze({
  register: 'the record of processing activities',
  publicNotice: 'the public privacy notice',
  staffNotice: 'the staff notice',
  workerNotice: 'the worker notice',
  dpia: 'the signed DPIA',
})
/** The duties whose absence keeps floor work that records workers off (the privacy gate, B-W1-36). */
export const FLOOR_PRIVACY_DUTIES: readonly string[] = Object.freeze(['workerNotice', 'dpia'])

export function privacyDutyWords(facts: { readonly company: string; readonly duties: readonly string[] }): RowWords {
  const floor = facts.duties.some((duty) => FLOOR_PRIVACY_DUTIES.includes(duty))
  return {
    sentence: `${facts.company}: ${plural(facts.duties.length, 'privacy duty', 'privacy duties')} open (${listed(facts.duties.map((duty) => PRIVACY_WORDS[duty] ?? duty))}).`,
    blocks: floor ? 'Floor work that records workers stays off until the worker notice and the DPIA are in place.' : 'People are not told what the system keeps about them.',
  }
}

const CHECK_WORDS: Readonly<Record<string, string>> = Object.freeze({
  REVISION: 'no released revision',
  LABEL_TEMPLATE: 'garment label',
  CERTIFICATE: 'certificate coverage',
  DECLARATION_OF_CONFORMITY: 'Declaration of Conformity',
  USER_INFORMATION: 'user information leaflet',
})
const STEP_WORDS: Readonly<Record<string, string>> = Object.freeze({ PRODUCTION: 'production', LABELS: 'garment labels', SHIPPING: 'shipping' })

/** `demand`: what waits on the style, in words ("2 open sales orders"). */
export function styleComplianceWords(facts: { readonly style: string; readonly checks: readonly string[]; readonly steps: readonly string[]; readonly demand: readonly string[] }): RowWords {
  return {
    sentence: `Style ${facts.style} is held by its compliance: ${listed(facts.checks.map((check) => CHECK_WORDS[check] ?? check))}.`,
    blocks: `It holds up the ${listed(facts.steps.map((step) => STEP_WORDS[step] ?? step))} of ${facts.demand.join(' and ')}.`,
  }
}

export type MailAttentionState = 'TRIAGE' | 'HELD' | 'FAILED'

const HELD_WORDS: Readonly<Record<string, string>> = Object.freeze({
  DMARC_FAIL: "its sender's address failed the DMARC check",
  SPAM: 'it looks like spam',
  UNKNOWN_SENDER: 'its sender is not a contact of the record',
  THREAD_CLOSED: 'the thread it answers is closed',
})

/** `sender`: the name, else the address; `subject` null: no subject. */
export function mailToSortWords(facts: { readonly sender: string; readonly subject: string | null; readonly state: MailAttentionState; readonly heldReason: string | null }): RowWords {
  const what = facts.subject ? `"${facts.subject}" from ${facts.sender}` : `Mail from ${facts.sender}`
  switch (facts.state) {
    case 'TRIAGE':
      return { sentence: `${what} reached no record: sort it.`, blocks: 'Its sender waits: nobody sees it on a record until it is sorted.' }
    case 'HELD':
      return {
        sentence: `${what} is held${facts.heldReason && HELD_WORDS[facts.heldReason] ? `: ${HELD_WORDS[facts.heldReason]}` : ''}.`,
        blocks: 'It reaches no thread until a person releases it or throws it away.',
      }
    case 'FAILED':
      return { sentence: `${what} could not be read.`, blocks: 'Throw it away, or ask the sender to send it again.' }
  }
}

// ---- waiting on others --------------------------------------------------------------------------------------------------

export function approvalRequestWords(facts: { readonly number: string; readonly customer: string; readonly reasons: readonly string[] }): string {
  return `Your approval request for quote ${facts.number} (${facts.customer}: ${approvalReasonWords(facts.reasons)}) is not decided yet.`
}

export function poConfirmationWords(facts: { readonly number: string; readonly supplier: string }): string {
  return `Purchase order ${facts.number} you sent to ${facts.supplier} is not confirmed yet.`
}

export function quoteAnswerWords(facts: { readonly number: string; readonly revision: number; readonly customer: string }): string {
  return `Quote ${facts.number} (revision ${facts.revision}) you sent to ${facts.customer} is not answered yet.`
}
