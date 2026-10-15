/**
 * Google Ads programme 2, G8b (2026-10-15) — the account's billing, as far as the Google Ads API allows it: a billing
 * setup for an EXISTING payments account (and cancelling one that has not started), and account budgets (propose a new
 * one, change one, end one, cancel a proposal still waiting for Google's review). ONE call of BillingSetupService (no
 * validate_only) or AccountBudgetProposalService (validate_only: Google checks it first).
 *
 * Checked 2026-10-15 in Google's v25 protos / reference (curl) and guides (docs/billing/overview, billing-setups,
 * account-budgets):
 *   - "The payments setting in your Google Ads account must be configured for monthly invoicing in order to manage
 *     billing setups, account budgets, and invoices with the Google Ads API." An account paid by card (automatic
 *     payments) changes its billing in Google Ads only, and NO API adds or changes a payment card.
 *   - BillingSetupOperation: create | remove ("Update operations are not supported"); a setup "cannot be removed unless
 *     it is in a pending state or its scheduled start time is in the future". create: payments_account
 *     (customers/{c}/paymentsAccounts/{1234-5678-9012-3456}) for an existing payments account; start_time_type NOW ("the
 *     only acceptable start time if the customer doesn't have any approved setups") or a future start_date_time.
 *     BillingSetupStatus PENDING | APPROVED_HELD | APPROVED | CANCELLED.
 *   - AccountBudgetProposal: proposal_type CREATE | UPDATE | END | REMOVE; billing_setup (CREATE), account_budget (the
 *     others); proposed_name; proposed_start_time_type NOW | proposed_start_date_time; proposed_end_time_type FOREVER |
 *     proposed_end_date_time ("cannot be in the past"; dates in the account's time zone, "yyyy-mm-dd hh:mm:ss");
 *     proposed_spending_limit_micros | proposed_spending_limit_type INFINITE; UPDATE needs update_mask ("Specifying a
 *     mask for any other proposal type is considered an error"). "Only one active account budget is allowed per
 *     customer." Google reviews a proposal (usually in under an hour); a PENDING proposal can be removed
 *     (AccountBudgetProposalOperation.remove: "A request may be cancelled iff it is pending"). An active budget cannot be
 *     removed, only ended (END). AccountBudgetProposalError includes CANNOT_EXTEND_END_TIME,
 *     SPENDING_LIMIT_LOWER_THAN_ACCRUED_COST_NOT_ALLOWED, PENDING_UPDATE_PROPOSAL_EXISTS, CANNOT_END_INACTIVE_BUDGET.
 *   - Both services are not allowed at the Explorer access level (docs/api-policy/access-levels).
 *
 * Money (Owner's rule): a new account budget, a higher spending limit, no limit, a later end and a billing setup are
 * SPENDS MONEY; a lower limit or an end stops ads (warnings). Amounts are cents of the account's currency.
 */
import { changeLines, money, type GoogleChangeDraft } from './change-draft.js'
import { ACCOUNT_CALL } from './account-client.js'
import { microsOfCents } from './live.js'
import type { LiveAccountBudget, LiveBillingState } from './live-account-admin.js'

export const BILLING_ACTIONS = [
  'create-billing-setup', 'cancel-billing-setup', 'propose-account-budget', 'change-account-budget', 'end-account-budget', 'cancel-proposal', 'add-payment-card',
] as const
export type BillingAction = typeof BILLING_ACTIONS[number]

export interface BillingRequest {
  action: BillingAction
  paymentsAccountId?: string
  billingSetupId?: string
  accountBudgetId?: string
  proposalId?: string
  name?: string
  spendingLimitCents?: number
  unlimited?: boolean
  /** YYYY-MM-DD in the account's time zone; absent = now. */
  startDate?: string
  /** YYYY-MM-DD in the account's time zone; absent on a new budget = until it is ended. */
  endDate?: string
  /** A change: take the budget's end date away (it runs until it is ended). */
  noEnd?: boolean
  confirmEnd?: boolean
}

export interface BillingRecord {
  action: BillingAction
  billingSetupId?: string | null
  paymentsAccountId?: string | null
  accountBudgetId?: string | null
  proposalId?: string | null
  /** A budget's values the change wrote (before: what they were). */
  budget?: { name: string | null; spendingLimitCents: number | null; unlimited: boolean; endDate: string | null } | null
  state: string
}

export const NO_CARD = 'No API can add or change a payment card: the Google Ads API (and the Payments API behind it) has no method for it. Add or change a card '
  + 'in Google Ads › Billing › Payment methods. Nexus can make a billing setup for an EXISTING payments account and manage account budgets, and only '
  + 'for an account on monthly invoicing.'
export const NOT_CHECKED_BILLING = 'Google cannot check a billing setup first (BillingSetupService has no validate_only): the preview is built from the live '
  + 'account, and the change is sent only after a person approves it.'
export const INVOICING_ONLY = 'Billing setups and account budgets work through the API only for an account on monthly invoicing (developers.google.com/google-ads/api/docs/billing/overview); '
  + 'at the Explorer access level Google does not allow these services at all (docs/api-policy/access-levels). Google answers either plainly.'
export const REVIEWED = 'Google reviews an account budget proposal before it applies (usually within an hour); until then it is PENDING and can be cancelled.'

const DATE = /^\d{4}-\d{2}-\d{2}$/
const day = (dateTime: string | null | undefined): string | null => (dateTime ? dateTime.slice(0, 10) : null)
const limitWords = (cents: number | null, unlimited: boolean, currency: string) => (unlimited ? 'no limit' : money(cents, currency))

function draftOf(summary: string, lines: Array<[string, unknown, unknown]>, path: string, body: Record<string, unknown>, stands: unknown, before: BillingRecord, after: BillingRecord, warnings: string[], spendsMoney: string[] = []): GoogleChangeDraft {
  const { changes } = changeLines(lines)
  return { summary, changes, totals: { billing: 1 }, warnings: [...warnings, INVOICING_ONLY], spendsMoney, skipped: [], operations: [{ [ACCOUNT_CALL]: { path, body } }], stands, before, after }
}

const budgetOf = (b: LiveAccountBudget) => ({ name: b.name, spendingLimitCents: b.spendingLimitCents, unlimited: b.spendingLimitType === 'INFINITE', endDate: b.endType === 'FOREVER' ? null : day(b.end) })

/** The active budget (approved, started, not ended) — Google allows one per account. */
function activeBudget(live: LiveBillingState, today: string): LiveAccountBudget | null {
  return live.budgets.find((b) => b.status === 'APPROVED' && (day(b.start) ?? '') <= today && (b.endType === 'FOREVER' || (day(b.end) ?? '9999') >= today)) ?? null
}

/**
 * `today`: YYYY-MM-DD in the account's time zone (Google reads every date of a proposal in it). `currency`: the account's.
 */
export function billingDraft(customer: string, currency: string, today: string, request: BillingRequest, live: LiveBillingState): GoogleChangeDraft | { refusal: string } {
  if (request.action === 'add-payment-card') return { refusal: NO_CARD }
  for (const [what, d] of [['start date', request.startDate], ['end date', request.endDate]] as const) {
    if (d !== undefined && (!DATE.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`)))) return { refusal: `The ${what} is not a date (YYYY-MM-DD).` }
  }
  if (request.startDate !== undefined && request.startDate <= today) return { refusal: `The start date must be after today (${today} in the account's time zone; Google's rule): leave it out to start now.` }
  if (request.spendingLimitCents !== undefined && request.unlimited) return { refusal: 'Give a spending limit or unlimited: true, not both.' }
  const approvedSetups = live.setups.filter((s) => s.status === 'APPROVED' || s.status === 'APPROVED_HELD')

  switch (request.action) {
    case 'create-billing-setup': {
      const pa = (request.paymentsAccountId ?? '').trim()
      if (!/^\d{4}-\d{4}-\d{4}-\d{4}$/.test(pa)) return { refusal: 'Give the payments account id (16 digits as 1234-5678-9012-3456, from Google Ads › Billing › Settings). Nexus cannot make a new payments account or add a card.' }
      if (approvedSetups.length && request.startDate === undefined) return { refusal: 'This account already has an approved billing setup: a new one starts on a future date (startDate), when the current one ends.' }
      if (live.setups.some((s) => s.paymentsAccountId === pa && s.status !== 'CANCELLED' && (!s.end || day(s.end)! >= today))) return { refusal: `Payments account ${pa} already pays for this account (Google refuses a change to the same payments account).` }
      const start = request.startDate ? { startDateTime: `${request.startDate} 00:00:00` } : { startTimeType: 'NOW' }
      return draftOf(
        `Make a billing setup: payments account ${pa} pays for the Google Ads account from ${request.startDate ?? 'now'}.`,
        [['Billing setup', approvedSetups.map((s) => s.paymentsAccountName ?? s.paymentsAccountId).join(', ') || '(none)', `payments account ${pa} from ${request.startDate ?? 'now'}`]],
        'billingSetups:mutate', { operation: { create: { paymentsAccount: `${customer}/paymentsAccounts/${pa}`, ...start } } },
        { setups: live.setups.map((s) => `${s.billingSetupId}:${s.status}:${s.paymentsAccountId}`).sort() },
        { action: 'create-billing-setup', paymentsAccountId: pa, billingSetupId: null, state: 'none' },
        { action: 'create-billing-setup', paymentsAccountId: pa, billingSetupId: null, state: 'PENDING' },
        ['Google approves a billing setup before it takes effect (PENDING until then).'],
        [`Payments account ${pa} becomes who pays for this account: with an approved account budget and enabled campaigns, ads serve and are billed to it.`],
      )
    }
    case 'cancel-billing-setup': {
      const id = (request.billingSetupId ?? '').trim()
      const setup = live.setups.find((s) => s.billingSetupId === id)
      if (!setup) return { refusal: `Billing setup ${id || '(none given)'} is not in this account (google-ads-live view billing lists them).` }
      const future = setup.status === 'APPROVED' && (day(setup.start) ?? '') > today
      if (setup.status !== 'PENDING' && !future) return { refusal: `Billing setup ${id} is ${setup.status ?? 'unknown'}${setup.start ? ` since ${day(setup.start)}` : ''}: Google cancels only a pending setup or one that starts in the future.` }
      return draftOf(
        `Cancel billing setup ${id} (payments account ${setup.paymentsAccountId ?? '?'}, ${setup.status}).`,
        [[`Billing setup ${id}`, setup.status, '(cancelled)']],
        'billingSetups:mutate', { operation: { remove: `${customer}/billingSetups/${id}` } },
        { billingSetupId: id, status: setup.status, start: setup.start },
        { action: 'cancel-billing-setup', billingSetupId: id, paymentsAccountId: setup.paymentsAccountId, state: setup.status ?? 'unknown' },
        { action: 'cancel-billing-setup', billingSetupId: id, paymentsAccountId: setup.paymentsAccountId, state: 'CANCELLED' },
        ['A cancelled billing setup cannot come back: a new one is made (create-billing-setup).'],
      )
    }
    case 'propose-account-budget': {
      const name = (request.name ?? '').trim()
      if (!name || name.length > 255) return { refusal: 'Give the new account budget a name (1 to 255 characters).' }
      if (request.spendingLimitCents === undefined && !request.unlimited) return { refusal: 'Give its spending limit (spendingLimitCents) or unlimited: true.' }
      const setupId = (request.billingSetupId ?? (approvedSetups.length === 1 ? approvedSetups[0].billingSetupId : '')).trim()
      const setup = live.setups.find((s) => s.billingSetupId === setupId)
      if (!setup) {
        return { refusal: live.setups.length
          ? `Name the billing setup the budget is billed to (billingSetupId: ${live.setups.map((s) => `${s.billingSetupId} ${s.status}`).join(', ')}).`
          : 'This account shows no billing setup: account budgets through the API need an account on monthly invoicing. An account that pays by card sets its spending in Google Ads › Billing.' }
      }
      if (setup.status === 'CANCELLED') return { refusal: `Billing setup ${setupId} is cancelled.` }
      if (request.endDate !== undefined && request.endDate < (request.startDate ?? today)) return { refusal: 'The end date is before the start.' }
      const start = request.startDate ?? today
      const active = activeBudget(live, today)
      if (active && (active.endType === 'FOREVER' || (day(active.end) ?? '') >= start)) {
        return { refusal: `The account budget "${active.name ?? active.accountBudgetId}" runs ${active.endType === 'FOREVER' ? 'with no end' : `until ${day(active.end)}`}: Google allows one active account budget, so a new one starts after it ends (startDate), or change that one (change-account-budget).` }
      }
      const unlimited = request.unlimited === true
      const limit = unlimited ? { proposedSpendingLimitType: 'INFINITE' } : { proposedSpendingLimitMicros: microsOfCents(request.spendingLimitCents!) }
      const end = request.endDate ? { proposedEndDateTime: `${request.endDate} 23:59:59` } : { proposedEndTimeType: 'FOREVER' }
      const startBody = request.startDate ? { proposedStartDateTime: `${request.startDate} 00:00:00` } : { proposedStartTimeType: 'NOW' }
      const words = limitWords(request.spendingLimitCents ?? null, unlimited, currency)
      return draftOf(
        `Propose a new account budget "${name}": ${words}, from ${request.startDate ?? 'now'} ${request.endDate ? `to ${request.endDate}` : 'until it is ended'}, billed to setup ${setupId}.`,
        [['Account budget', '(none)', `"${name}": ${words}, ${request.startDate ?? 'now'} → ${request.endDate ?? 'no end'}`]],
        'accountBudgetProposals:mutate',
        { operation: { create: { proposalType: 'CREATE', billingSetup: `${customer}/billingSetups/${setupId}`, proposedName: name, ...startBody, ...end, ...limit } } },
        { billingSetupId: setupId, setupStatus: setup.status, budgets: live.budgets.map((b) => `${b.accountBudgetId}:${b.status}:${b.end ?? b.endType}`).sort() },
        { action: 'propose-account-budget', billingSetupId: setupId, proposalId: null, budget: null, state: 'none' },
        { action: 'propose-account-budget', billingSetupId: setupId, proposalId: null, budget: { name, spendingLimitCents: request.spendingLimitCents ?? null, unlimited, endDate: request.endDate ?? null }, state: 'PENDING' },
        [REVIEWED],
        [`A new account budget lets the account spend ${unlimited ? 'with no limit' : `up to ${words}`} from ${request.startDate ?? 'now'} ${request.endDate ? `to ${request.endDate}` : 'until it is ended'}.`],
      )
    }
    case 'change-account-budget':
    case 'end-account-budget': {
      const id = (request.accountBudgetId ?? '').trim()
      const budget = live.budgets.find((b) => b.accountBudgetId === id)
      if (!budget) return { refusal: `Account budget ${id || '(none given)'} is not in this account (google-ads-live view billing lists them).` }
      if (budget.status !== 'APPROVED') return { refusal: `Account budget ${id} is ${budget.status ?? 'not approved'}: only an approved budget is changed or ended (a pending proposal is cancelled with cancel-proposal).` }
      if (budget.pending) return { refusal: `Account budget ${id} already has a proposal waiting for Google's review (${budget.pending.proposalId ?? '?'}, ${budget.pending.type ?? '?'}): wait for it, or cancel it (cancel-proposal).` }
      const was = budgetOf(budget)
      const ended = budget.endType !== 'FOREVER' && (day(budget.end) ?? '9999') < today
      if (ended) return { refusal: `Account budget ${id} ended on ${day(budget.end)}: an ended budget is not changed (propose a new one).` }
      const stands = { accountBudgetId: id, status: budget.status, ...was, start: budget.start, servedCents: budget.amountServedCents }
      if (request.action === 'end-account-budget') {
        if (request.confirmEnd !== true) return { refusal: `Ending account budget "${budget.name ?? id}" needs confirmEnd: true: from then on the account has no budget and ALL its ads stop.` }
        return draftOf(
          `End the account budget "${budget.name ?? id}" now.`,
          [[`Account budget "${budget.name ?? id}"`, `${limitWords(was.spendingLimitCents, was.unlimited, currency)}, to ${was.endDate ?? 'no end'}`, 'ended now']],
          'accountBudgetProposals:mutate', { operation: { create: { proposalType: 'END', accountBudget: `${customer}/accountBudgets/${id}` } } },
          stands,
          { action: 'end-account-budget', accountBudgetId: id, budget: was, state: 'APPROVED' },
          { action: 'end-account-budget', accountBudgetId: id, budget: was, state: 'ENDED' },
          ['From then on the account has no account budget: ALL its ads stop serving. An ended budget cannot be restarted; a new one is proposed.', REVIEWED],
        )
      }
      const mask: string[] = []
      const body: Record<string, unknown> = { proposalType: 'UPDATE', accountBudget: `${customer}/accountBudgets/${id}` }
      const lines: Array<[string, unknown, unknown]> = []
      const spends: string[] = []
      const warnings: string[] = [REVIEWED]
      const now = { ...was }
      const name = request.name?.trim()
      if (name !== undefined && name !== (was.name ?? '')) {
        if (!name || name.length > 255) return { refusal: 'The budget name is 1 to 255 characters.' }
        body.proposedName = name; mask.push('proposed_name'); lines.push(['Name', was.name, name]); now.name = name
      }
      if (request.unlimited && !was.unlimited) {
        body.proposedSpendingLimitType = 'INFINITE'; mask.push('proposed_spending_limit_type'); lines.push(['Spending limit', money(was.spendingLimitCents, currency), 'no limit'])
        spends.push(`Takes the account's spending limit away (was ${money(was.spendingLimitCents, currency)}): it can spend with no limit until the budget ends.`)
        now.unlimited = true; now.spendingLimitCents = null
      } else if (request.spendingLimitCents !== undefined && (was.unlimited || request.spendingLimitCents !== was.spendingLimitCents)) {
        if (budget.amountServedCents !== null && request.spendingLimitCents < budget.amountServedCents) {
          return { refusal: `The account already spent ${money(budget.amountServedCents, currency)} on this budget: Google does not allow a limit below what was spent.` }
        }
        body.proposedSpendingLimitMicros = microsOfCents(request.spendingLimitCents); mask.push('proposed_spending_limit_micros')
        lines.push(['Spending limit', was.unlimited ? 'no limit' : money(was.spendingLimitCents, currency), money(request.spendingLimitCents, currency)])
        if (!was.unlimited && request.spendingLimitCents > (was.spendingLimitCents ?? 0)) spends.push(`Raises the account's spending limit from ${money(was.spendingLimitCents, currency)} to ${money(request.spendingLimitCents, currency)}.`)
        else warnings.push(`When the account has spent ${money(request.spendingLimitCents, currency)} on this budget, ALL its ads stop until the limit is raised${budget.amountServedCents !== null ? ` (spent so far: ${money(budget.amountServedCents, currency)})` : ''}.`)
        now.unlimited = false; now.spendingLimitCents = request.spendingLimitCents
      }
      if (request.noEnd && request.endDate !== undefined) return { refusal: 'Give an end date or noEnd: true, not both.' }
      if (request.noEnd && was.endDate) {
        body.proposedEndTimeType = 'FOREVER'; mask.push('proposed_end_time_type'); lines.push(['End', was.endDate, 'no end'])
        spends.push(`Takes the account budget's end (${was.endDate}) away: it runs until it is ended (Google may refuse a later end: CANNOT_EXTEND_END_TIME).`)
        now.endDate = null
      }
      if (request.endDate !== undefined && request.endDate !== was.endDate) {
        if (request.endDate < today) return { refusal: 'The end date cannot be in the past (Google\'s rule): end the budget now with end-account-budget.' }
        body.proposedEndDateTime = `${request.endDate} 23:59:59`; mask.push('proposed_end_date_time'); lines.push(['End', was.endDate ?? 'no end', request.endDate])
        if (was.endDate && request.endDate > was.endDate) spends.push(`Extends the account budget from ${was.endDate} to ${request.endDate} (Google may refuse a later end: CANNOT_EXTEND_END_TIME).`)
        else warnings.push(`All ads of the account stop on ${request.endDate}, when the budget ends, unless a new budget follows.`)
        now.endDate = request.endDate
      }
      if (!mask.length) return { refusal: `Nothing to change: account budget "${budget.name ?? id}" already has these values.` }
      return draftOf(
        `Change the account budget "${budget.name ?? id}": ${lines.map(([w, , to]) => `${w.toLowerCase()} → ${String(to)}`).join('; ')}.`,
        lines, 'accountBudgetProposals:mutate', { operation: { create: body, updateMask: mask.join(',') } }, stands,
        { action: 'change-account-budget', accountBudgetId: id, budget: was, state: 'APPROVED' },
        // What the budget is once Google applied the proposal (undo puts it back only then).
        { action: 'change-account-budget', accountBudgetId: id, budget: now, state: 'APPROVED' },
        warnings, spends,
      )
    }
    case 'cancel-proposal': {
      const id = (request.proposalId ?? '').trim()
      const proposal = live.proposals.find((p) => p.proposalId === id)
      if (!proposal) {
        // google-ads-live view billing shows a budget's pending proposal without its id: the refusal names the waiting ones.
        const waiting = live.proposals.map((p) => `${p.proposalId} (${p.type ?? '?'}${p.name ? `, "${p.name}"` : ''})`)
        return { refusal: `Proposal ${id || '(none given)'} is not waiting in this account (only a PENDING proposal is cancelled; Google may have decided it already). `
          + (waiting.length ? `Waiting now: ${waiting.join(', ')}.` : 'No proposal is waiting now.') }
      }
      return draftOf(
        `Cancel the account budget proposal ${id} (${proposal.type ?? '?'}${proposal.name ? `, "${proposal.name}"` : ''}) before Google applies it.`,
        [[`Proposal ${id}`, 'waiting for Google\'s review', '(cancelled)']],
        'accountBudgetProposals:mutate', { operation: { remove: `${customer}/accountBudgetProposals/${id}` } },
        { proposalId: id, status: proposal.status, type: proposal.type },
        { action: 'cancel-proposal', proposalId: id, accountBudgetId: proposal.accountBudgetId, state: 'PENDING' },
        { action: 'cancel-proposal', proposalId: id, accountBudgetId: proposal.accountBudgetId, state: 'CANCELLED' },
        ['The account budget stays as it was. Google usually applies a proposal within minutes: if it already did, Google refuses the cancel.'],
      )
    }
  }
  return { refusal: `Unknown billing action ${String(request.action)}.` }
}

/** Whether Google can check this billing change first (an account budget proposal has validate_only). */
export const billingCheckable = (action: BillingAction | undefined): boolean =>
  action === 'propose-account-budget' || action === 'change-account-budget' || action === 'end-account-budget' || action === 'cancel-proposal'

/** What is there now, in the shape of the change's `after` (undo's "current"). */
export function billingNow(after: BillingRecord, live: LiveBillingState): BillingRecord {
  switch (after.action) {
    case 'create-billing-setup': {
      const setup = live.setups.find((s) => s.billingSetupId === after.billingSetupId)
      return { ...after, state: setup?.status === 'PENDING' ? 'PENDING' : setup?.status ?? 'none' }
    }
    case 'propose-account-budget': {
      const proposal = live.proposals.find((p) => p.proposalId === after.proposalId)
      return { ...after, state: proposal ? 'PENDING' : 'decided' }
    }
    case 'change-account-budget': {
      const budget = live.budgets.find((b) => b.accountBudgetId === after.accountBudgetId)
      if (!budget) return { ...after, state: 'none' }
      return { ...after, budget: budgetOf(budget), state: budget.pending ? 'PENDING' : budget.status ?? 'unknown' }
    }
    default:
      return after
  }
}

/** The request that puts the billing back, or why it cannot. */
export function billingUndo(before: BillingRecord, after: BillingRecord): { args: Record<string, unknown> } | { refusal: string } {
  switch (after.action) {
    case 'create-billing-setup':
      return after.billingSetupId ? { args: { action: 'cancel-billing-setup', billingSetupId: after.billingSetupId } } : { refusal: 'This change does not record the billing setup Google made: cancel it in Google Ads › Billing.' }
    case 'propose-account-budget':
      return after.proposalId
        ? { args: { action: 'cancel-proposal', proposalId: after.proposalId } }
        : { refusal: 'This change does not record the proposal Google made: cancel it in Google Ads › Billing (once Google approved it, end the budget with end-account-budget).' }
    case 'change-account-budget': {
      const b = before.budget
      if (!b || !after.accountBudgetId) return { refusal: 'This change does not record the budget values it replaced.' }
      return { args: {
        action: 'change-account-budget', accountBudgetId: after.accountBudgetId,
        ...(b.name ? { name: b.name } : {}),
        ...(b.unlimited ? { unlimited: true } : b.spendingLimitCents !== null ? { spendingLimitCents: b.spendingLimitCents } : {}),
        ...(b.endDate ? { endDate: b.endDate } : after.budget?.endDate ? { noEnd: true } : {}),
      } }
    }
    case 'end-account-budget':
      return { refusal: 'An ended account budget cannot be restarted (Google\'s rule): propose a new one (propose-account-budget).' }
    case 'cancel-billing-setup':
      return { refusal: 'A cancelled billing setup cannot come back (Google\'s rule): make a new one (create-billing-setup).' }
    case 'cancel-proposal':
      return { refusal: 'A cancelled proposal cannot come back: propose it again.' }
    default:
      return { refusal: 'This billing change cannot be put back.' }
  }
}
