import { ruleProblems } from '@nexus/factory-domain/invoicing/cancellation/cancellation'
import type { Phrase } from '../../_shared/model'
import type { DepositRule, RuleBody } from './api'

/**
 * The refund rule on cancellation, pure (B-W2b-417; design finance.settings sec:deposits "refund on cancellation (W2b)";
 * FIN-080): who may, the rows, the rule's words (what is kept and paid back, the document), the dialog's draft checked as
 * factory-domain checks it (a percent kept only with KEEP_PERCENT, twice back only for a caparra we cancel, nothing paid
 * back → no document), and the refusals (`finance-invoices-depth`).
 */

const phrase = (key: string, params?: Record<string, string | number>): Phrase => (params ? { key, params } : { key })

export interface RuleAbilities {
  view: boolean
  manage: boolean
}

export const ruleAbilitiesOf = (permissions: readonly string[]): RuleAbilities => {
  const held = new Set(permissions)
  return { view: held.has('invoices.view'), manage: held.has('invoices.depositRules.manage') }
}

export const RULE_ROWS = ['active', 'archived', 'all'] as const
export type RuleRows = (typeof RULE_ROWS)[number]
export const ruleStatusOf = (rows: RuleRows): 'ACTIVE' | 'ARCHIVED' | 'ALL' => (rows === 'active' ? 'ACTIVE' : rows === 'archived' ? 'ARCHIVED' : 'ALL')

/** Which orders a rule covers: made to measure, the others, any. */
export const ORDER_KINDS = ['any', 'made', 'stock'] as const
export type OrderKind = (typeof ORDER_KINDS)[number]
export const orderKindOf = (madeToMeasure: boolean | null): OrderKind => (madeToMeasure === null ? 'any' : madeToMeasure ? 'made' : 'stock')
export const madeToMeasureOf = (kind: OrderKind): boolean | null => (kind === 'any' ? null : kind === 'made')

export interface RuleDraft {
  depositKind: RuleBody['depositKind']
  cancelledBy: RuleBody['cancelledBy']
  orderKind: OrderKind
  refundRule: RuleBody['refundRule']
  keepPct: string
  documentKind: RuleBody['documentKind']
  note: string
}

export const emptyRule = (): RuleDraft => ({ depositKind: 'ACCONTO', cancelledBy: 'CUSTOMER', orderKind: 'any', refundRule: 'REFUND_ALL', keepPct: '0', documentKind: 'CREDIT_NOTE', note: '' })

export const ruleDraftOf = (rule: DepositRule): RuleDraft => ({ depositKind: rule.depositKind, cancelledBy: rule.cancelledBy, orderKind: orderKindOf(rule.madeToMeasure), refundRule: rule.refundRule, keepPct: rule.keepPct.replace(/\.?0+$/, '') || '0', documentKind: rule.documentKind, note: rule.note ?? '' })

/** The body as the API takes it (a percent with a dot; KEEP_PERCENT keeps it, the others send 0). */
export function ruleBodyOf(draft: RuleDraft): RuleBody {
  return {
    depositKind: draft.depositKind,
    cancelledBy: draft.cancelledBy,
    madeToMeasure: madeToMeasureOf(draft.orderKind),
    refundRule: draft.refundRule,
    keepPct: draft.refundRule === 'KEEP_PERCENT' ? draft.keepPct.trim().replace(',', '.') : '0',
    documentKind: draft.documentKind,
    note: draft.note.trim() === '' ? null : draft.note.trim(),
  }
}

/** The draft's problems as message keys by field (factory-domain ruleProblems, read by path). */
export function ruleDraftProblems(draft: RuleDraft): Partial<Record<'keepPct' | 'refundRule' | 'documentKind' | 'note', string>> {
  const out: Partial<Record<'keepPct' | 'refundRule' | 'documentKind' | 'note', string>> = {}
  for (const issue of ruleProblems(ruleBodyOf(draft))) {
    const field = issue.path.split('/').pop() as 'keepPct' | 'refundRule' | 'documentKind' | 'note'
    out[field] ??= `rule.problem.${field}`
  }
  return out
}

/** The rule in words: who cancels which deposit on which orders → what is kept or paid back, and the document. */
export function ruleWords(rule: Pick<DepositRule, 'refundRule' | 'keepPct' | 'documentKind'>): Phrase {
  const pct = Number(rule.keepPct)
  if (rule.refundRule === 'KEEP_PERCENT') return phrase(`rule.words.KEEP_PERCENT.${rule.documentKind}`, { pct: String(pct) })
  return phrase(`rule.words.${rule.refundRule}.${rule.documentKind}`)
}

/** Why adding, changing or archiving waits: the right, archived, busy. */
export const manageHeld = (can: RuleAbilities, busy = false): Phrase | null => (!can.manage ? phrase('held.noRules') : busy ? phrase('held.busy') : null)
export const archiveHeld = (rule: Pick<DepositRule, 'status'>, can: RuleAbilities, busy = false): Phrase | null => manageHeld(can, busy) ?? (rule.status === 'ARCHIVED' ? phrase('rule.held.archived') : null)
