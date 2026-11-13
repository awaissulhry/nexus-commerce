import { draftOf, newDraft, type RuleDialogState, type RuleDraft } from '../model'

/**
 * A new approval rule opened for a kind (B-W2b-382; follow-up XF7:06, B-W2b-354's and B-W2b-355's notes): a page that keeps one
 * kind of request — Purchasing › Settings (purchase orders), Warehouse › Settings (stock adjustments) — opens Admin › Automation ›
 * Approval rules at `?view=approvals&rule=new&kind=<APPROVAL_TASK_KIND>`, and the new rule's pop-up starts with that kind chosen
 * (still changeable until it is saved). A kind the API does not list (or none) leaves the choice to the person. PURE.
 */

export const NEW_RULE_KIND_PARAM = 'kind'

/** The address of a new approval rule of one kind. */
export const newRuleHref = (prefix: string, kind: string): string => `${prefix}/admin/automation?view=approvals&rule=new&${NEW_RULE_KIND_PARAM}=${encodeURIComponent(kind)}`

/** The kind a new rule starts with: the one asked for when the API lists it, else none (null). */
export function newRuleKindOf(asked: string | null | undefined, kinds: readonly { readonly kind: string }[] | null): string | null {
  if (!asked || !kinds) return null
  return kinds.some((entry) => entry.kind === asked) ? asked : null
}

/** The pop-up's first draft: a design case's own, the rule's, else a new rule of the kind it was opened for (one company: that one). */
export function startDraft(dialog: Pick<RuleDialogState, 'draft' | 'rule' | 'kind'>, companies: readonly { readonly id: string }[]): RuleDraft {
  if (dialog.draft) return dialog.draft
  if (dialog.rule) return draftOf(dialog.rule)
  return newDraft(dialog.kind ?? null, companies.length === 1 ? companies[0]!.id : null)
}
