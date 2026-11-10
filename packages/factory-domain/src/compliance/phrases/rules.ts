import type { Issue } from '../../core/errors'

/**
 * The phrase library (B-W2b-249; PRD-343; PPE Reg. (EU) 2016/425 art. 8(7): the label and the user information in a
 * language the market's users understand; design compliance.settings › rm-phrases, compliance.labels › Languages), pure.
 * The tables are B-W2b-216's Phrase and PhraseTranslation: a phrase has a key ("warning.class-a", fixed), a kind, its
 * source language and words, and a revision that moves up by one with new source words. A translation per language is
 * proposed as a DRAFT, approved by a second person (the database refuses the author) on the phrase's current revision,
 * and superseded by the next approved one; one APPROVED and one DRAFT per language at most. A translation of an older
 * revision of the source words is stale: the label must not print it until it is translated again.
 *
 * One cell per phrase and language (`cellOf`): SOURCE (the phrase's own language), APPROVED (current), PROPOSED (a draft
 * waits for approval), STALE (only an approval of older source words), MISSING. `approvedText` is what a label, a DoC or
 * a leaflet prints: the source words in the source language, else the approved translation of the current revision.
 */

export const PHRASE_KINDS = ['WARNING', 'CARE', 'MARKING', 'DOC', 'USER_INFO', 'CLAIM'] as const
export type PhraseKind = (typeof PHRASE_KINDS)[number]
export const TRANSLATION_STATUSES = ['DRAFT', 'APPROVED', 'SUPERSEDED'] as const
export type TranslationStatus = (typeof TRANSLATION_STATUSES)[number]
export const CELL_STATES = ['SOURCE', 'APPROVED', 'PROPOSED', 'STALE', 'MISSING'] as const
export type CellState = (typeof CELL_STATES)[number]

export const KEY = /^[^\s\p{Cc}]{1,100}$/u
export const SOURCE_LANGUAGE = /^[a-z]{2,3}$/
export const LANGUAGE_TAG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/
export const LANGUAGE_TAG_MAX = 35
export const WORDS_MAX = 4000
export const NOTE_MAX = 2000

export interface PhraseFacts {
  readonly sourceLanguage: string
  readonly sourceText: string
  readonly revision: number
}

export interface TranslationFacts {
  readonly id: string
  readonly language: string
  readonly revision: number
  readonly text: string
  readonly status: TranslationStatus
  readonly sourceRevision: number
  readonly translatedById: string | null
  readonly createdById: string | null
  readonly approvedAt: Date | null
  readonly approvedById: string | null
  readonly version: number
}

export interface Cell {
  readonly language: string
  readonly state: CellState
  readonly approved: TranslationFacts | null
  readonly draft: TranslationFacts | null
}

/** The state of one phrase in one language. */
export function cellOf(phrase: PhraseFacts, language: string, translations: readonly TranslationFacts[]): Cell {
  const own = translations.filter((row) => row.language === language)
  const approved = own.find((row) => row.status === 'APPROVED') ?? null
  const draft = own.find((row) => row.status === 'DRAFT') ?? null
  if (language === phrase.sourceLanguage) return { language, state: 'SOURCE', approved: null, draft: null }
  if (approved && approved.sourceRevision === phrase.revision) return { language, state: 'APPROVED', approved, draft }
  if (draft) return { language, state: 'PROPOSED', approved, draft }
  if (approved) return { language, state: 'STALE', approved, draft }
  return { language, state: 'MISSING', approved: null, draft: null }
}

/** What prints in a language: the source words, or the approved translation of the current words; null when none. */
export function approvedText(phrase: PhraseFacts, language: string, translations: readonly TranslationFacts[]): string | null {
  if (language === phrase.sourceLanguage) return phrase.sourceText
  const cell = cellOf(phrase, language, translations)
  return cell.state === 'APPROVED' ? (cell.approved?.text ?? null) : null
}

/** The next revision number of a language's translations. */
export const nextRevision = (language: string, translations: readonly Pick<TranslationFacts, 'language' | 'revision'>[]): number =>
  translations.filter((row) => row.language === language).reduce((highest, row) => Math.max(highest, row.revision), 0) + 1

export interface PhraseDraft {
  readonly key?: string | undefined
  readonly sourceLanguage?: string | undefined
  readonly sourceText?: string | undefined
  readonly note?: string | null | undefined
}

/** What is wrong with a phrase's fields, in words (paths under `body/`). Only the fields given are checked. */
export function phraseProblems(draft: PhraseDraft): Issue[] {
  const problems: Issue[] = []
  if (draft.key !== undefined && !KEY.test(draft.key)) problems.push({ path: 'body/key', message: 'A key of 1 to 100 characters without spaces ("warning.class-b").' })
  if (draft.sourceLanguage !== undefined && !SOURCE_LANGUAGE.test(draft.sourceLanguage)) problems.push({ path: 'body/sourceLanguage', message: 'The source language as an ISO 639 code ("it").' })
  if (draft.sourceText !== undefined && (draft.sourceText.trim() === '' || draft.sourceText.length > WORDS_MAX)) problems.push({ path: 'body/sourceText', message: `The source words: 1 to ${WORDS_MAX} characters.` })
  if (draft.note !== undefined && draft.note !== null && (draft.note.trim() === '' || draft.note.length > NOTE_MAX)) problems.push({ path: 'body/note', message: `A note of 1 to ${NOTE_MAX} characters, or none.` })
  return problems
}

/** Why a proposal is refused, in words (null: fine). */
export function proposeRefusal(input: { readonly phraseStatus: string; readonly sourceLanguage: string; readonly language: string; readonly text: string }): { code: string; message: string } | null {
  if (input.phraseStatus !== 'ACTIVE') return { code: 'ARCHIVED', message: 'This phrase is archived: restore it before translating it.' }
  if (input.language.length > LANGUAGE_TAG_MAX || !LANGUAGE_TAG.test(input.language)) return { code: 'LANGUAGE', message: 'The language as a BCP 47 tag ("de", "pt-BR").' }
  if (input.language === input.sourceLanguage) return { code: 'SOURCE_LANGUAGE', message: `The phrase is written in ${input.sourceLanguage}: change its source words instead.` }
  if (input.text.trim() === '' || input.text.length > WORDS_MAX) return { code: 'WORDS', message: `The translation: 1 to ${WORDS_MAX} characters.` }
  return null
}

/** Why an approval is refused, in words (null: fine): a draft of the current words, approved by someone else. */
export function approveRefusal(input: { readonly status: TranslationStatus; readonly sourceRevision: number; readonly phraseRevision: number; readonly authorId: string | null; readonly approverId: string }): { code: string; message: string } | null {
  if (input.status !== 'DRAFT') return { code: 'NOT_DRAFT', message: `This translation is ${input.status}: only a proposed one is approved.` }
  if (input.sourceRevision !== input.phraseRevision) {
    return { code: 'STALE', message: `This translation is of revision ${input.sourceRevision} of the source words; the phrase is at revision ${input.phraseRevision}: propose it again for the current words.` }
  }
  if (input.authorId !== null && input.authorId === input.approverId) return { code: 'OWN_PROPOSAL', message: 'You proposed this translation: a second person approves it.' }
  return null
}
