import { DEFECT_CLASSES } from '@nexus/factory-domain/quality/defects/rules'
import type { Severity, SeverityTexts } from './api'

/**
 * B-W2b-213: the severity words editor of Quality › Defects & dispositions › Severity (design quality.defects df-severity
 * "Text per class … EditModeBar for the texts"; QHS-002), pure. Per class and language the tenant's words (what the class is
 * called) and its meaning (what it means on screen); an empty cell is the standard text. Critical keeps its locked meaning
 * (Reg. (EU) 2016/425): only how it is called is the tenant's. The API decides again (PUT /quality/severity).
 */

export type DefectClass = (typeof DEFECT_CLASSES)[number]
export type TextPart = 'words' | 'meaning'

export const SEVERITY_WORDS_LIMITS = Object.freeze({ words: 60, meaning: 500 })

/** Per class, per part, per language: the text typed ('' = the standard text). */
export type SeverityDraft = Readonly<Record<DefectClass, Readonly<Record<TextPart, Readonly<Record<string, string>>>>>>

/** The editor while editing; null: read mode. */
export interface SeverityEdit {
  readonly draft: SeverityDraft
  readonly busy: boolean
  /** A save the API refused, as a message key of `defects-severity` (with its params). */
  readonly problem: { readonly key: string; readonly params?: Readonly<Record<string, string | number>> } | null
}

export interface SeverityWordsActions {
  onEdit?: () => void
  onDraft?: (draft: SeverityDraft) => void
  onDiscard?: () => void
  onSave?: () => void
}

/** A cell may hold the tenant's text: every class's words; the meaning of every class but the locked critical. */
export const editable = (row: Pick<Severity['classes'][number], 'class' | 'locked'>, part: TextPart): boolean => part === 'words' || !row.locked

/** The draft of what the tenant wrote (every language the editor shows, empty where the standard text stands). */
export function draftOf(severity: Severity): SeverityDraft {
  const draft = {} as Record<DefectClass, Record<TextPart, Record<string, string>>>
  for (const row of severity.classes) {
    const parts = { words: {} as Record<string, string>, meaning: {} as Record<string, string> }
    for (const language of severity.languages) {
      parts.words[language] = row.own.words[language] ?? ''
      if (editable(row, 'meaning')) parts.meaning[language] = row.own.meaning[language] ?? ''
    }
    draft[row.class] = parts
  }
  return draft
}

/** The draft with one cell typed. */
export const withCell = (draft: SeverityDraft, klass: DefectClass, part: TextPart, language: string, text: string): SeverityDraft => ({
  ...draft,
  [klass]: { ...draft[klass], [part]: { ...draft[klass][part], [language]: text } },
})

/** The cells that differ from what is saved. */
export function changedCells(severity: Severity, draft: SeverityDraft): number {
  const saved = draftOf(severity)
  let count = 0
  for (const klass of DEFECT_CLASSES) {
    for (const part of ['words', 'meaning'] as const) {
      const keys = new Set([...Object.keys(saved[klass]?.[part] ?? {}), ...Object.keys(draft[klass]?.[part] ?? {})])
      for (const language of keys) if ((saved[klass]?.[part]?.[language] ?? '').trim() !== (draft[klass]?.[part]?.[language] ?? '').trim()) count++
    }
  }
  return count
}

export interface CellProblem {
  readonly klass: DefectClass
  readonly part: TextPart
  readonly language: string
  readonly key: string
  readonly params: Readonly<Record<string, number>>
}

/** Every cell too long (an empty cell is the standard text: never a problem). */
export function draftProblems(draft: SeverityDraft): CellProblem[] {
  const problems: CellProblem[] = []
  for (const klass of DEFECT_CLASSES) {
    for (const part of ['words', 'meaning'] as const) {
      for (const [language, text] of Object.entries(draft[klass]?.[part] ?? {})) {
        const max = SEVERITY_WORDS_LIMITS[part]
        if (text.trim().length > max) problems.push({ klass, part, language, key: 'problem.tooLong', params: { max } })
      }
    }
  }
  return problems
}

export const problemAt = (problems: readonly CellProblem[], klass: DefectClass, part: TextPart, language: string): CellProblem | undefined =>
  problems.find((problem) => problem.klass === klass && problem.part === part && problem.language === language)

/** The PUT body: the whole set (empty cells left out), or null when nothing is the tenant's. */
export function bodyOf(severity: Severity, draft: SeverityDraft): { version: number; texts: SeverityTexts | null } {
  const texts: SeverityTexts = {}
  for (const row of severity.classes) {
    for (const part of ['words', 'meaning'] as const) {
      if (!editable(row, part)) continue
      const kept = Object.fromEntries(Object.entries(draft[row.class]?.[part] ?? {}).flatMap(([language, text]) => (text.trim() ? [[language, text.trim()] as const] : [])))
      if (Object.keys(kept).length > 0) texts[row.class] = { ...(texts[row.class] ?? {}), [part]: kept }
    }
  }
  return { version: severity.version, texts: Object.keys(texts).length > 0 ? texts : null }
}

/** The standard text a cell falls back to (the placeholder): Italian or English; another language: English. */
export function standardOf(row: Severity['classes'][number], part: TextPart, language: string): string {
  const standard = row.standard?.[part] ?? row[part]
  return language === 'it' ? standard.it : standard.en
}

/** A refused save in words (a `defects-severity` key). */
export function saveProblemOf(error: { readonly kind?: string; readonly status?: number } | null | undefined): { key: string } {
  if (!error) return { key: 'problem.failed' }
  if (error.kind === 'conflict') return { key: 'problem.stale' }
  if (error.kind === 'forbidden' || error.kind === 'step_up') return { key: 'problem.forbidden' }
  if (error.kind === 'invalid') return { key: 'problem.invalid' }
  if (error.kind === 'unavailable') return { key: 'problem.offline' }
  return { key: 'problem.failed' }
}

/** Why Edit is held (a key), or null. */
export const editHeld = (severity: Severity | null): string | null => (!severity ? 'held.reading' : !severity.canManage ? 'held.noManage' : null)
