import type { RuleDraft as BuilderDraft, RuleField, RuleOperator } from '@nexus/ui/patterns/RuleBuilder/index'
import type { PanelRead } from '../../../../record-panels/model'
import type { ApprovalMeaning } from '../../../../shell/panels/approvals/api'
import type { ApprovalRule, ConditionBody, KindsAnswer, RuleBody, RuleKind, RuleTest, RulesAnswer, Words } from './api'

/**
 * Admin › Automation › Approval rules (B-W2b-307; design admin.automation sec:approval-rules and pop:rule; PLT-086, PLT-042,
 * PLT-105): every rule as its sentence ("Purchase order: order value over 5000 → Finance, signed 'Approved'") with its
 * area, approver, signature meaning, fired in 30 days and its switch; the locked "Nobody approves their own request" first.
 * A row opens the rule pop-up: RuleBuilder over the kind's facts, the approver (a role that decides approvals, or the person
 * the rule names), the meaning and its fresh code, the order, the time to decide, and Test against the kind's latest
 * records ("Would have asked for 4 of the last 50 … · Fiona would approve"). A new rule is written OFF; the switch is the
 * list's. A money threshold the reader's grains do not show is held, never shown. Pure, so the tests hold it.
 */

export const NAMESPACE = 'approvals-depth'
export const MEANINGS: readonly ApprovalMeaning[] = ['REVIEWED', 'APPROVED', 'RELEASED', 'VERIFIED']

export const said = (words: Words | null | undefined, locale: string): string => (words ? (locale === 'it' ? words.it : words.en) : '')

/** A role a rule may name: an office role whose permissions decide approvals (the API refuses any other). */
export interface ApproverRole {
  readonly id: string
  readonly name: string
}

export interface RuleDraft {
  /** null for a new rule until a kind is picked. */
  readonly kind: string | null
  /** The company the rule is for (null: every company — a grant over every company). Fixed once written. */
  readonly companyId: string | null
  readonly name: string
  readonly condition: BuilderDraft
  /** A role, or the person the rule names (kept as it is: this page picks roles). */
  readonly approver: { readonly kind: 'ROLE' | 'PERSON'; readonly id: string; readonly name?: string } | null
  readonly meaning: ApprovalMeaning | null
  readonly stepUp: boolean
  /** Typed text: a whole number 1–9999. */
  readonly sequence: string
  /** Typed text: empty or whole hours 1–2160. */
  readonly dueHours: string
}

export type RuleDialogState = {
  readonly mode: 'new' | 'edit'
  readonly rule: ApprovalRule | null
  readonly draft?: RuleDraft
  /** B-W2b-382: a new rule's kind chosen by the page that opened it (`&kind=`), when the API lists it. */
  readonly kind?: string | null
  readonly test: PanelRead<RuleTest> | null
  /** A refusal of the last save (a key of approvals-depth), or null. */
  readonly problem: string | null
}

export interface ApprovalRulesModel {
  readonly rules: PanelRead<RulesAnswer>
  readonly kinds: PanelRead<KindsAnswer>
  readonly roles: PanelRead<readonly ApproverRole[]>
  /** The companies the person works in: a rule is for one of them, or for every company. */
  readonly companies: readonly { readonly id: string; readonly name: string }[]
  /** approvals.rules.manage: New rule, the switches, the pop-up's changes. */
  readonly manage: boolean
  readonly offline: boolean
  readonly busy: boolean
  readonly saving: readonly string[]
  readonly dialog: RuleDialogState | null
  readonly prefix: string
}

// ---- the rule's condition: RuleBuilder ⇄ the API ---------------------------------------------------------------------------

/** The kind's facts as RuleBuilder fields in the person's language; a money fact without its grain is listed, held. */
export function fieldsOf(kind: RuleKind | null | undefined, locale: string, heldWords: string): RuleField[] {
  return (kind?.fields ?? []).map((field) => ({
    id: field.id,
    label: said(field.label, locale),
    kind: field.kind,
    unit: field.unit,
    ...(field.min !== null ? { min: field.min } : {}),
    ...(field.max !== null ? { max: field.max } : {}),
    options: field.options.map((option) => ({ value: option.value, label: said(option.label, locale) })),
    heldReason: field.heldReason ? heldWords : null,
  }))
}

let serial = 0
const rowId = () => `r${++serial}`

export function builderOf(condition: ApprovalRule['condition']): BuilderDraft {
  return {
    combinator: condition.combinator,
    rows: condition.rows.map((row) => ({ id: row.id ?? rowId(), field: row.field, operator: row.operator as RuleOperator, value: row.held ? null : row.value })),
  }
}

export function conditionOf(draft: BuilderDraft): ConditionBody {
  return {
    combinator: draft.combinator,
    rows: draft.rows.filter((row) => row.field !== null && row.operator !== null).map((row) => ({ id: row.id, field: row.field!, operator: row.operator!, value: row.value === null ? null : typeof row.value === 'string' ? row.value : [...row.value] })),
  }
}

export const EMPTY_CONDITION: BuilderDraft = { combinator: 'and', rows: [] }

export function draftOf(rule: ApprovalRule): RuleDraft {
  return {
    kind: rule.kind,
    companyId: rule.companyId,
    name: rule.name,
    condition: builderOf(rule.condition),
    approver: { kind: rule.approver.kind, id: rule.approver.id, name: rule.approver.name },
    meaning: rule.signatureMeaning,
    stepUp: rule.requireStepUp,
    sequence: String(rule.sequence),
    dueHours: rule.dueHours === null ? '' : String(rule.dueHours),
  }
}

export function newDraft(kind: string | null, companyId: string | null): RuleDraft {
  return { kind, companyId, name: '', condition: EMPTY_CONDITION, approver: null, meaning: null, stepUp: false, sequence: '100', dueHours: '' }
}

const whole = (text: string, min: number, max: number): number | null => {
  if (!/^\d{1,5}$/.test(text.trim())) return null
  const value = Number(text.trim())
  return value >= min && value <= max ? value : null
}

/**
 * Why Save is held (a key of approvals-depth), or null. In order: no right, offline, the rule's own hold (a threshold in a
 * money grain one lacks), busy, no kind, no name, no approver, a row unfinished (RuleBuilder's words), the order, the time.
 */
export function saveHeld(draft: RuleDraft, state: { readonly manage: boolean; readonly offline: boolean; readonly busy: boolean; readonly rule: ApprovalRule | null; readonly builderHeld: string | null }): string | null {
  if (!state.manage) return 'rules.held.noManage'
  if (state.offline) return 'rules.held.offline'
  if (state.rule && !state.rule.canChange) return 'rules.held.cannotChange'
  if (state.busy) return 'inbox.held.busy'
  if (!draft.kind) return 'rules.held.kind'
  if (draft.name.trim() === '') return 'rules.held.name'
  if (!draft.approver) return 'rules.held.approver'
  if (state.builderHeld) return 'rules.held.condition'
  if (whole(draft.sequence, 1, 9999) === null) return 'rules.held.sequence'
  if (draft.dueHours.trim() !== '' && whole(draft.dueHours, 1, 2160) === null) return 'rules.held.dueHours'
  return null
}

/** The body Save sends (only after `saveHeld` said null). */
export function bodyOf(draft: RuleDraft): RuleBody {
  return {
    name: draft.name.trim(),
    condition: conditionOf(draft.condition),
    approver: draft.approver!.kind === 'ROLE' ? { roleId: draft.approver!.id } : { userId: draft.approver!.id },
    signatureMeaning: draft.meaning,
    requireStepUp: draft.meaning !== null && draft.stepUp,
    sequence: whole(draft.sequence, 1, 9999) ?? 100,
    dueHours: draft.dueHours.trim() === '' ? null : whole(draft.dueHours, 1, 2160),
  }
}

/** Only what changed (an edit sends a PUT of the changed fields; a rule with a held threshold never sends its condition). */
export function changesOf(rule: ApprovalRule, draft: RuleDraft): Partial<RuleBody> {
  const next = bodyOf(draft)
  const before = bodyOf(draftOf(rule))
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(next) as (keyof RuleBody)[]) {
    if (key === 'condition' && rule.condition.rows.some((row) => row.held)) continue
    if (JSON.stringify(next[key]) !== JSON.stringify(before[key])) out[key] = next[key]
  }
  return out as Partial<RuleBody>
}

/** Why a rule's switch is held (a key), or null. */
export function switchHeld(rule: ApprovalRule, state: { readonly manage: boolean; readonly offline: boolean; readonly saving: readonly string[] }): string | null {
  if (!state.manage) return 'rules.held.noManage'
  if (!rule.canChange) return 'rules.held.cannotChange'
  if (state.offline) return 'rules.held.offline'
  if (state.saving.includes(rule.id)) return 'inbox.held.busy'
  if (!rule.registered) return 'rules.held.notRegistered'
  return null
}

/** Why New rule is held (a key), or null. */
export function newHeld(model: Pick<ApprovalRulesModel, 'manage' | 'offline' | 'rules' | 'kinds'>): string | null {
  if (!model.manage) return 'rules.held.noManage'
  if (model.offline) return 'rules.held.offline'
  if (model.rules.status !== 'ready' || model.kinds.status !== 'ready') return 'rules.held.reading'
  if (!model.rules.data.canAdd) return 'rules.held.noManage'
  if (model.kinds.data.kinds.length === 0) return 'rules.held.noKinds'
  return null
}

/** The rules by area: the kind's order of the kinds' list, then the API's (sequence, oldest). */
export function sortedRules(rules: readonly ApprovalRule[], kinds: readonly { readonly kind: string }[]): ApprovalRule[] {
  const order = new Map(kinds.map((kind, index) => [kind.kind, index]))
  return [...rules].sort((a, b) => (order.get(a.kind) ?? 99) - (order.get(b.kind) ?? 99) || a.sequence - b.sequence)
}

/** The approver in words: the role or the person the rule names. */
export const approverWords = (rule: Pick<ApprovalRule, 'approver'>): string => rule.approver.name
