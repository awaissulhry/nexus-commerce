import { LANGUAGE_CODE } from '@nexus/factory-domain/compliance/markets/rules'
import { normaliseLanguages, PPE_TEXT_KINDS, PPE_TEXT_LIMITS, type PpeTextKind } from '@nexus/factory-domain/compliance/ppe-texts/rules'
import { isApiError, issuePath } from '../../../../lib/api/errors'
import { isStepUpCancelled } from '../../../quality/_shared/hooks'
import type { Approval, RecordBody, Template, TemplatesAnswer, TemplateState } from './api'

/**
 * Compliance › Rules & markets › Templates (SCR-262 tab `templates`; B-W2b-288, FU2:01; GATE-PPE-TEXTS), pure: the templates
 * shown, a template's approvals, the record dialog's draft and why its primary is held, the withdrawal's hold, and an API
 * refusal in our words (never the API's English). The rules themselves are factory-domain's compliance/ppe-texts (the same
 * limits the API checks).
 */

export const PPE_NAMESPACE = 'compliance-followups-w2b4'
export { PPE_TEXT_KINDS, PPE_TEXT_LIMITS }

/** A template's address in `?open=` (its kind and `<key>.<version>`): "DOC:annex-ix.1". */
export const templateKeyOf = (template: Pick<Template, 'templateKind' | 'templateId'>): string => `${template.templateKind}:${template.templateId}`

/** The templates the filters keep (the kind, the words typed: the key, the label's code and name), in the API's order. */
export function templatesShown(answer: TemplatesAnswer | null, filter: { readonly q: string; readonly kind: string | null }): Template[] | null {
  if (!answer) return null
  const q = filter.q.trim().toLowerCase()
  return answer.templates.filter((template) => (!filter.kind || template.templateKind === filter.kind) && (q === '' || `${template.templateKey} ${template.label?.name ?? ''}`.toLowerCase().includes(q)))
}

/** A template's approvals: those in force first, then the newest. */
export function approvalsOf(answer: TemplatesAnswer | null, template: Pick<Template, 'templateKind' | 'templateId'>): Approval[] {
  return (answer?.approvals ?? []).filter((approval) => approval.templateKind === template.templateKind && approval.templateId === template.templateId).sort((a, b) => Number(b.live) - Number(a.live) || b.recordedAt.localeCompare(a.recordedAt))
}

/** The template `?open=` names: its key, or (a record link) one of its approvals' ids. */
export function templateOf(answer: TemplatesAnswer | null, key: string | null): Template | null {
  if (!key || !answer) return null
  const byKey = answer.templates.find((template) => templateKeyOf(template) === key)
  if (byKey) return byKey
  const approval = answer.approvals.find((entry) => entry.id === key)
  return approval ? (answer.templates.find((template) => template.templateKind === approval.templateKind && template.templateId === approval.templateId) ?? null) : null
}

/** The tone of a template's state (always with its word and icon). */
export const STATE_TONE: Readonly<Record<TemplateState, 'success' | 'warning' | 'neutral'>> = { APPROVED: 'success', WITHDRAWN: 'warning', NONE: 'neutral' }

// ---- recording a yes ----------------------------------------------------------------------------------------------------------

/** Whose texts the yes approves: the screen's company, or every company (a role over every company). */
export type RecordScope = 'company' | 'all'

export interface RecordDraft {
  /** The template (`templateKeyOf`). */
  readonly template: string | null
  readonly scope: RecordScope
  /** The languages as typed ("it, en"). */
  readonly languages: string
  readonly checkedBy: string
  readonly file: File | null
  readonly fileName: string | null
}

export const emptyRecordDraft = (template: string | null, mayCompany: boolean): RecordDraft => ({ template, scope: mayCompany ? 'company' : 'all', languages: '', checkedBy: '', file: null, fileName: null })

/** "IT, en;de" → ['it', 'en', 'de'] (lower case, each once). */
export const languagesTyped = (text: string): string[] => normaliseLanguages(text.split(/[\s,;]+/))

/** The languages a template prints (a label's own; the generators': none to offer, the consultant's say). */
export const languagesOffered = (template: Template | null): string[] => template?.label?.languages ?? []

export interface RecordContext {
  readonly mayCompany: boolean
  readonly mayEvery: boolean
  readonly offline: boolean
  readonly busy: boolean
  readonly companyId: string | null
}

/** Why "Record the yes" is held (a message key), or null. */
export function recordHeld(draft: RecordDraft, context: RecordContext): string | null {
  if (!context.mayCompany && !context.mayEvery) return 'ppe.held.manage'
  if (context.offline) return 'ppe.held.offline'
  if (context.busy) return 'ppe.held.busy'
  if (!draft.template) return 'ppe.held.template'
  if (draft.scope === 'all' ? !context.mayEvery : !context.mayCompany || context.companyId === null) return draft.scope === 'all' ? 'ppe.held.everyCompany' : 'ppe.held.company'
  const languages = languagesTyped(draft.languages)
  if (languages.length === 0) return 'ppe.held.languages'
  if (languages.length > PPE_TEXT_LIMITS.languages || languages.some((language) => !LANGUAGE_CODE.test(language))) return 'ppe.held.languageCodes'
  const consultant = draft.checkedBy.trim()
  if (consultant === '' || consultant.length > PPE_TEXT_LIMITS.checkedBy || /[\r\n]/.test(consultant)) return 'ppe.held.checkedBy'
  if (!draft.file) return 'ppe.held.file'
  return null
}

/** What the API is asked to record (null while held). */
export function recordBodyOf(draft: RecordDraft, template: Template | null, companyId: string | null): RecordBody | null {
  if (!template) return null
  return {
    companyId: draft.scope === 'all' ? null : companyId,
    templateKind: template.templateKind,
    templateKey: template.templateKey,
    templateVersion: template.templateVersion,
    languages: languagesTyped(draft.languages),
    checkedBy: draft.checkedBy.trim(),
  }
}

// ---- withdrawing ----------------------------------------------------------------------------------------------------------

/** Why "Withdraw" is held (a message key), or null. */
export function withdrawHeld(approval: Pick<Approval, 'live' | 'mayWithdraw'>, reason: string, context: { readonly offline: boolean; readonly busy: boolean }): string | null {
  if (!approval.live) return 'ppe.held.withdrawn'
  if (!approval.mayWithdraw) return 'ppe.held.manage'
  if (context.offline) return 'ppe.held.offline'
  if (context.busy) return 'ppe.held.busy'
  const words = reason.trim()
  if (words.length < PPE_TEXT_LIMITS.reasonMin || words.length > PPE_TEXT_LIMITS.reason) return 'ppe.held.reason'
  return null
}

// ---- refusals in our words ------------------------------------------------------------------------------------------------

export interface PpeProblem {
  readonly key: string
}

const FIELDS = ['templateKey', 'templateVersion', 'templateKind', 'languages', 'checkedBy', 'fileId', 'reason', 'companyId'] as const
const REFUSALS = ['RECORDED', 'WITHDRAWN', 'DATABASE'] as const

/** A write's problem as the screen says it: a known refusal, the field, or the kind of answer. */
export function ppeProblemOf(error: unknown): PpeProblem {
  if (isStepUpCancelled(error)) return { key: 'ppe.problem.cancelled' }
  if (!isApiError(error)) return { key: 'ppe.problem.unavailable' }
  for (const issue of error.issues) {
    const path = issuePath(issue).replace(/\./g, '/')
    const refusal = path.startsWith('refusal/') ? path.slice(8) : null
    if (refusal && (REFUSALS as readonly string[]).includes(refusal)) return { key: `ppe.refusal.${refusal}` }
    const field = path.startsWith('body/') ? path.slice(5).split('/')[0]! : null
    if (field && (FIELDS as readonly string[]).includes(field)) return { key: `ppe.problem.field.${field}` }
  }
  if (error.kind === 'conflict') return { key: error.issues.some((issue) => issuePath(issue).endsWith('version')) ? 'ppe.problem.stale' : 'ppe.problem.conflict' }
  if (error.kind === 'forbidden' || error.kind === 'step_up') return { key: 'ppe.problem.forbidden' }
  if (error.kind === 'signed_out') return { key: 'ppe.problem.signedOut' }
  if (error.kind === 'not_found') return { key: 'ppe.problem.notFound' }
  if (error.kind === 'invalid') return { key: 'ppe.problem.invalid' }
  if (error.kind === 'unavailable' || error.kind === 'rate_limited') return { key: 'ppe.problem.unavailable' }
  return { key: 'ppe.problem.failed' }
}

/** A read that failed, in the page's words (compliance-settings: the section's SectionFailed says them). */
export const readProblemOf = (error: unknown): string => {
  const key = ppeProblemOf(error).key
  return key === 'ppe.problem.forbidden' ? 'problem.forbidden' : key === 'ppe.problem.signedOut' ? 'problem.signedOut' : 'problem.read'
}

/** The kind of a template as the kind filter reads it from the address (`?kind=`). */
export const kindFilterOf = (kind: string | null): PpeTextKind | null => ((PPE_TEXT_KINDS as readonly string[]).includes(kind ?? '') ? (kind as PpeTextKind) : null)
