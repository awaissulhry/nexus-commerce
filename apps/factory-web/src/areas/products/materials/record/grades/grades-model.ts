import { GRADING_LIMITS, gradeRuleDraftProblems, panelsOf } from '@nexus/factory-domain/inventory/hides/grading'
import { isApiError, issuePath } from '../../../../../lib/api/errors'
import { writeProblem } from '../../../library/model'
import type { CreateRuleBody, GradeRule, GradeRuleRow, GradesView, RulePatch } from './api'

/**
 * The material's "Grades and usable area" section, pure (B-W2b-131; PRD-031; design products.materials › Material ›
 * Properties & grades › material.props.grades: Grade (A / B / C) · Usable share % · Panels allowed; autosave per cell).
 * What a cell typed becomes (the article's own rule created, a rule changed at its version, or nothing), the share and the
 * panels as people type and read them (a decimal comma in Italian), why the section is read only, what a refused write
 * says in this app's words (never the API's English), and the moves of the row menu (back to the grade's default, use an
 * earlier rule again). The view and the container use these; the tests hold them.
 */

/** The section's read: loading, the grades, or why not; idle for a material that is not leather. */
export type GradesPart = { status: 'idle' } | { status: 'loading' } | { status: 'ready'; value: GradesView } | { status: 'error'; problem: string }

export const GRADE_CELLS = ['share', 'panels'] as const
export type GradeCell = (typeof GRADE_CELLS)[number]

/** A cell's save: saving (sent), waiting (offline, kept on this page), refused (with our words); nothing once saved. */
export interface GradeMark {
  state: 'saving' | 'waiting' | 'refused'
  /** The text typed, shown until the server answers. */
  value?: string
  /** A message key of `library` (refused). */
  problem?: string
}

export const markKey = (gradeId: string, cell: GradeCell): string => `${gradeId}:${cell}`

export interface GradesModel {
  part: GradesPart
  marks: Record<string, GradeMark>
  /** The grades selected (their ids). */
  selected: string[]
  /** The browser says it is offline: cell edits wait on this page. */
  offline: boolean
  busy: boolean
  /** The material is archived: everything is read only (said in the banner). */
  archived: boolean
  /** The last refused row action (back to default, use again), in our words. */
  notice: { key: string; tone: 'success' | 'danger' | 'info'; params?: Record<string, string | number> } | null
  /** Design cases: the earlier rules shown open. */
  historyOpen?: boolean
}

export interface GradesActions {
  onRetry?: () => void
  onCell?: (row: GradeRuleRow, cell: GradeCell, text: string) => void
  onSelect?: (ids: string[]) => void
  /** Retire the article's rule of these grades: back to each grade's default. */
  onDefault?: (gradeIds: string[]) => void
  /** Use an earlier (retired) rule of a grade again. */
  onUseAgain?: (row: GradeRuleRow, ruleId: string) => void
  onDismissNotice?: () => void
}

export const NO_GRADES: GradesModel = { part: { status: 'idle' }, marks: {}, selected: [], offline: false, busy: false, archived: false, notice: null }

// ---- words ----------------------------------------------------------------------------------------------------------------

/** A grade's name in the person's language. */
export const gradeLabel = (grade: Pick<GradeRuleRow['grade'], 'labelIt' | 'labelEn'>, locale: string): string => (locale.startsWith('it') ? grade.labelIt : grade.labelEn)

/**
 * A share as people read it ("74.50" → "74.5", "74.00" → "74", "74,5" in Italian): exact, from the decimal string (never a
 * float), trailing zeros dropped.
 */
export function shareText(share: string, locale: string): string {
  const [whole, fraction = ''] = share.trim().split('.')
  const tidy = fraction.replace(/0+$/, '')
  if (!tidy) return whole ?? ''
  return `${whole}${locale.startsWith('it') ? ',' : '.'}${tidy}`
}

/** The panels as one line to read or type ("Front, Back"); empty: every panel. */
export const panelsText = (panels: readonly string[]): string => panels.join(', ')

/** Where the share comes from: this article's own rule, or the grade's default. */
export const sourceKey = (row: Pick<GradeRuleRow, 'source'>): string => (row.source === 'RULE' ? 'material.grades.source.rule' : 'material.grades.source.grade')

/** Grades and the article's own rules (the toolbar's count). */
export function gradesCount(view: Pick<GradesView, 'grades'>): { grades: number; rules: number } {
  return { grades: view.grades.length, rules: view.grades.filter((row) => row.rule !== null).length }
}

// ---- what a person types --------------------------------------------------------------------------------------------------

/**
 * A share typed ("74,5", "74.5", "74 %") as the API takes it ("74.5"), or null when it is not a percent from 0 to 100 with
 * at most two decimals (the API's own rule, factory-domain inventory/hides/grading).
 */
export function parseShare(text: string): string | null {
  const tidy = text.trim().replace(/\s*%$/, '').replace(/\s/g, '').replace(',', '.')
  if (tidy === '') return null
  return gradeRuleDraftProblems({ usableShare: tidy }, false).length === 0 ? tidy : null
}

/** Panels typed as one line ("Front, Back; Sleeve") as the API keeps them: trimmed, each once, in the order typed. */
export const parsePanels = (text: string): string[] => panelsOf(text.split(/[,;\n]/))

/** Why panels typed cannot be kept (a key of `library`), or null. */
export function panelsProblem(panels: readonly string[]): string | null {
  if (panels.length > GRADING_LIMITS.panels) return 'material.grades.problem.panelsMany'
  if (panels.some((panel) => panel.length > GRADING_LIMITS.panel)) return 'material.grades.problem.panelLong'
  return null
}

/** Two shares are the same percent ("74" and "74.00"). */
const sameShare = (a: string, b: string): boolean => {
  const norm = (value: string) => {
    const [whole = '', fraction = ''] = value.trim().split('.')
    return `${whole.replace(/^0+(?=\d)/, '')}.${fraction.padEnd(2, '0')}`
  }
  return norm(a) === norm(b)
}

/** The write a cell's text makes: the article's own rule created, a rule changed at its version, nothing, or why not. */
export type CellPlan =
  | { kind: 'none' }
  | { kind: 'problem'; problem: string }
  | { kind: 'create'; body: CreateRuleBody }
  | { kind: 'edit'; rule: { id: string; version: number }; patch: RulePatch }

/**
 * A cell typed on a grade's row. With the article's own rule: a change of it at its version. Without one (the grade's
 * default applies): the article's rule is created with the share typed and the default's panels, or with the grade's
 * default share and the panels typed. A retired grade takes no new rule (the API refuses it too). Nothing changed: nothing.
 */
export function cellPlan(row: GradeRuleRow, cell: GradeCell, text: string): CellPlan {
  if (cell === 'share') {
    const share = parseShare(text)
    if (share === null) return { kind: 'problem', problem: 'material.grades.problem.share' }
    if (sameShare(share, row.share)) return { kind: 'none' }
    if (row.rule) return { kind: 'edit', rule: { id: row.rule.id, version: row.rule.version }, patch: { usableShare: share } }
    if (!row.grade.active) return { kind: 'problem', problem: 'material.grades.problem.retiredGrade' }
    return { kind: 'create', body: { gradeId: row.grade.id, usableShare: share, panels: [...row.panels] } }
  }
  const panels = parsePanels(text)
  const problem = panelsProblem(panels)
  if (problem) return { kind: 'problem', problem }
  if (panels.join('\n') === row.panels.join('\n')) return { kind: 'none' }
  if (row.rule) return { kind: 'edit', rule: { id: row.rule.id, version: row.rule.version }, patch: { panels } }
  if (!row.grade.active) return { kind: 'problem', problem: 'material.grades.problem.retiredGrade' }
  return { kind: 'create', body: { gradeId: row.grade.id, usableShare: row.grade.defaultShare, panels } }
}

/** The text a cell shows: the one typed while it saves or waits, else the row's. */
export function shownText(row: GradeRuleRow, cell: GradeCell, marks: Readonly<Record<string, GradeMark>>, locale: string): string {
  const mark = marks[markKey(row.grade.id, cell)]
  if (mark && mark.state !== 'refused' && mark.value !== undefined) return mark.value
  return cell === 'share' ? shareText(row.share, locale) : panelsText(row.panels)
}

// ---- who may change it, and the row's moves --------------------------------------------------------------------------------

/** Why the section is read only now (a key of `library`), or null: archived, a material of every company, no edit right. */
export function gradesHeld(view: Pick<GradesView, 'canManage' | 'material'>, archived: boolean, libraryManage: boolean): string | null {
  if (archived) return 'material.grades.readOnly.archived'
  if (view.canManage) return null
  if (libraryManage && view.material.companyId === null) return 'material.grades.readOnly.everyCompany'
  return 'material.grades.readOnly.noManage'
}

/** The rules "Back to the grade's default" retires for these grades (only rows with the article's own rule). */
export function defaultPlans(rows: readonly GradeRuleRow[], gradeIds: readonly string[]): { gradeId: string; rule: { id: string; version: number } }[] {
  return rows.filter((row) => gradeIds.includes(row.grade.id) && row.rule).map((row) => ({ gradeId: row.grade.id, rule: { id: row.rule!.id, version: row.rule!.version } }))
}

/** Why "Back to the grade's default" is held for the selection (a key of `library`), or null. */
export function defaultHeld(rows: readonly GradeRuleRow[], gradeIds: readonly string[], held: string | null, busy: boolean): string | null {
  if (held) return held
  if (busy) return 'held.busy'
  return defaultPlans(rows, gradeIds).length === 0 ? 'material.grades.held.noRule' : null
}

/** Why an earlier rule cannot be used again (a key of `library`), or null: another rule is active, or the grade is retired. */
export function useAgainHeld(row: GradeRuleRow, held: string | null): string | null {
  if (held) return held
  if (!row.grade.active) return 'material.grades.held.gradeRetired'
  if (row.rule) return 'material.grades.held.activeExists'
  return null
}

/** The earlier rules of a grade, newest first. */
export const historyOf = (row: Pick<GradeRuleRow, 'retiredRules'>): GradeRule[] => [...row.retiredRules].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))

// ---- a refused write in our words -----------------------------------------------------------------------------------------

export type WriteKind = 'create' | 'edit' | 'retire' | 'reactivate'

/**
 * A refused write as a key of `library` and whether the section reads again: the rule changed meanwhile, the article got a
 * rule for the grade meanwhile, another rule is active, a retired rule, a share or panels refused, a retired grade; else the
 * library's own write words.
 */
export function refusalOf(error: unknown, kind: WriteKind): { key: string; reload: boolean } {
  if (isApiError(error)) {
    const paths = error.issues.map((issue) => issuePath(issue).replace(/^body[./]/, ''))
    if (error.kind === 'invalid') {
      if (paths.some((path) => path.startsWith('usableShare'))) return { key: 'material.grades.problem.share', reload: false }
      if (paths.some((path) => path.startsWith('panels'))) return { key: 'material.grades.problem.panelsMany', reload: false }
      if (paths.some((path) => path.startsWith('gradeId'))) return { key: 'material.grades.problem.retiredGrade', reload: true }
    }
    if (error.kind === 'conflict') {
      const moved = error.code === 'version_conflict' || paths.some((path) => path.split(/[./]/).includes('version'))
      if (moved) return { key: 'material.grades.problem.moved', reload: true }
      if (kind === 'create') return { key: 'material.grades.problem.ruleExists', reload: true }
      if (kind === 'reactivate') return { key: 'material.grades.problem.otherActive', reload: true }
      return { key: 'material.grades.problem.retiredRule', reload: true }
    }
    if (error.kind === 'not_found') return { key: 'material.grades.problem.gone', reload: true }
  }
  const problem = writeProblem(error)
  return { key: problem.key, reload: problem.reload }
}
