import { causeDraftProblems, CAUSE_PROCESSES, type CauseProcess } from '@nexus/factory-domain/quality/defects/causes'
import { gradeDraftProblems, usableShareText } from '@nexus/factory-domain/quality/defects/grades'
import { isApiError, issuePath } from '../../../lib/api/errors'
import type { Cause, Grade, NewCauseBody, NewGradeBody, VocabularyEdit } from './api'
import { typedCode, type Change } from './model'

/**
 * B-W2b-118: the rules of the three W2b tabs of Defects & dispositions (design quality.defects df-severity, df-causes,
 * df-grades), without React and without the API: a cell's change → the PATCH it sends (or why not, in our words), the new
 * cause and the new grade (factory-domain's own checks at their fields), refusals in our words. Message keys are the
 * `defects-vocab` catalogue's. The severity texts are fixed (B-W2b-90's schema need): no change rule.
 */

export type VocabularyField = 'labelIt' | 'labelEn' | 'sortOrder' | 'active' | 'usableShare' | `lang:${string}`

const LABEL_MAX = 80

/** A cell's change of a cause or a grade → its PATCH, its problem (a `defects-vocab` key), or null when nothing changed. */
export function vocabularyChange(row: Cause | Grade, field: VocabularyField, value: unknown): Change<VocabularyEdit> {
  if (field === 'labelIt' || field === 'labelEn') {
    const text = typeof value === 'string' ? value.trim() : ''
    if (text === row[field]) return null
    if (!text) return { problem: field === 'labelIt' ? 'problem.labelIt' : 'problem.labelEn' }
    if (text.length > LABEL_MAX) return { problem: 'problem.tooLong' }
    return { edit: { [field]: text } }
  }
  if (field.startsWith('lang:')) {
    const language = field.slice(5)
    const text = typeof value === 'string' ? value.trim() : ''
    if (text === (row.labelI18n[language] ?? '')) return null
    if (text.length > LABEL_MAX) return { problem: 'problem.tooLong' }
    return { edit: { labelI18n: { [language]: text || null } } }
  }
  if (field === 'active') {
    const on = value === true
    return on === row.active ? null : { edit: { active: on } }
  }
  if (field === 'sortOrder') {
    const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : ''
    if (!/^\d{1,7}$/.test(text)) return { problem: 'problem.sortOrder' }
    return Number(text) === row.sortOrder ? null : { edit: { sortOrder: Number(text) } }
  }
  if (field === 'usableShare') {
    if (!('usableShare' in row)) return null
    const text = (typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value)).trim().replace(',', '.').replace(/%$/, '').trim()
    if (gradeDraftProblems({ usableShare: text }, false).length > 0) return { problem: 'problem.usableShare' }
    const normal = usableShareText(text)
    return normal === row.usableShare ? null : { edit: { usableShare: normal } }
  }
  return null
}

/** The field a change saves (where its mark goes). */
export function fieldOfVocabularyEdit(edit: VocabularyEdit): VocabularyField {
  if (edit.labelIt !== undefined) return 'labelIt'
  if (edit.labelEn !== undefined) return 'labelEn'
  if (edit.labelI18n !== undefined) return `lang:${Object.keys(edit.labelI18n)[0] ?? ''}`
  if (edit.usableShare !== undefined) return 'usableShare'
  if (edit.sortOrder !== undefined) return 'sortOrder'
  return 'active'
}

// ---- a new cause, a new grade ------------------------------------------------------------------------------------------------

export interface NewCauseDraft {
  readonly code: string
  readonly process: CauseProcess | null
  readonly labelIt: string
  readonly labelEn: string
}
export const NEW_CAUSE: NewCauseDraft = Object.freeze({ code: '', process: null, labelIt: '', labelEn: '' })

export function newCauseProblems(draft: NewCauseDraft, taken: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const problem of causeDraftProblems({ code: draft.code.trim(), process: draft.process ?? undefined, labelIt: draft.labelIt.trim() || undefined, labelEn: draft.labelEn.trim() || undefined }, true)) {
    const field = problem.path.split('/')[0]!
    if (!out[field]) out[field] = `problem.${field}`
  }
  if (!out.code && taken.includes(draft.code.trim())) out.code = 'problem.codeTaken'
  return out
}

export const newCauseBody = (draft: NewCauseDraft): NewCauseBody => ({ code: draft.code.trim(), process: draft.process!, labelIt: draft.labelIt.trim(), labelEn: draft.labelEn.trim() })

export interface NewGradeDraft {
  readonly code: string
  readonly labelIt: string
  readonly labelEn: string
  readonly usableShare: string
}
export const NEW_GRADE: NewGradeDraft = Object.freeze({ code: '', labelIt: '', labelEn: '', usableShare: '' })

const shareOf = (text: string): string => text.trim().replace(',', '.').replace(/%$/, '').trim()

export function newGradeProblems(draft: NewGradeDraft, taken: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const problem of gradeDraftProblems({ code: draft.code.trim(), labelIt: draft.labelIt.trim() || undefined, labelEn: draft.labelEn.trim() || undefined, usableShare: shareOf(draft.usableShare) || undefined }, true)) {
    const field = problem.path.split('/')[0]!
    if (!out[field]) out[field] = `problem.${field}`
  }
  if (!out.code && taken.includes(draft.code.trim())) out.code = 'problem.codeTaken'
  return out
}

export const newGradeBody = (draft: NewGradeDraft): NewGradeBody => ({ code: draft.code.trim(), labelIt: draft.labelIt.trim(), labelEn: draft.labelEn.trim(), usableShare: usableShareText(shareOf(draft.usableShare)) })

/** A typed grade code as the list keeps it: upper case, no spaces, at most 10. */
export const typedGradeCode = (text: string): string => typedCode(text).slice(0, 10)

export const PROCESSES = CAUSE_PROCESSES

// ---- held reasons and refusals ------------------------------------------------------------------------------------------------

/** Delete a cause: only an unused one; a grade is never deleted (retired). */
export function deleteCauseHeld(cause: Pick<Cause, 'usedCount'>, canManage: boolean): { key: string; params?: Record<string, number> } | null {
  if (!canManage) return { key: 'held.noManage' }
  if (cause.usedCount > 0) return { key: 'held.used', params: { count: cause.usedCount } }
  return null
}

/** An API refusal in this tab's words: a `defects-vocab` key; `unknown` when the outcome is not known. */
export function vocabularyProblemOf(error: unknown): { key: string; unknown: boolean } {
  if (!isApiError(error)) return { key: 'problem.failed', unknown: true }
  const paths = error.issues.map((issue) => issuePath(issue))
  switch (error.kind) {
    case 'conflict':
      if (paths.includes('version')) return { key: 'problem.stale', unknown: false }
      if (/ is taken/.test(error.message)) return { key: 'problem.codeTaken', unknown: false }
      if (/is used on/.test(error.message)) return { key: 'problem.inUse', unknown: false }
      if (/at most/.test(error.message)) return { key: 'problem.full', unknown: false }
      return { key: 'problem.conflict', unknown: false }
    case 'invalid': {
      const field = paths.map((path) => path.replace(/^body\//, '').split('/')[0]!).find((name) => ['code', 'process', 'labelIt', 'labelEn', 'labelI18n', 'usableShare', 'sortOrder'].includes(name))
      return { key: field ? (field === 'labelI18n' ? 'problem.language' : `problem.${field}`) : 'problem.invalid', unknown: false }
    }
    case 'forbidden':
    case 'step_up':
      return { key: 'problem.forbidden', unknown: false }
    case 'not_found':
      return { key: 'problem.gone', unknown: false }
    case 'unavailable':
      return { key: 'problem.offline', unknown: true }
    default:
      return { key: 'problem.failed', unknown: true }
  }
}

/** The words still missing in another floor language, per list (the coverage read), for the note above a tab. */
export function missingWordsNote(coverage: { languages: readonly { language: string; missing: { CAUSES: readonly string[]; GRADES: readonly string[]; DEFECTS: readonly string[] } }[] } | null, list: 'CAUSES' | 'GRADES'): { language: string; count: number }[] {
  return (coverage?.languages ?? []).map((entry) => ({ language: entry.language, count: entry.missing[list].length })).filter((entry) => entry.count > 0)
}
