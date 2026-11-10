import { describe, expect, it } from 'vitest'
import { approvedText, approveRefusal, cellOf, nextRevision, phraseProblems, proposeRefusal, type TranslationFacts } from './rules'

// Every word here is made up.
const phrase = { sourceLanguage: 'it', sourceText: 'Non lavare (prova)', revision: 2 }
const tr = (over: Partial<TranslationFacts>): TranslationFacts => ({
  id: 't',
  language: 'en',
  revision: 1,
  text: 'No washing (test)',
  status: 'APPROVED',
  sourceRevision: 2,
  translatedById: 'translator',
  createdById: 'translator',
  approvedAt: new Date('2026-11-01T10:00:00Z'),
  approvedById: 'approver',
  version: 1,
  ...over,
})

describe('the phrase library (B-W2b-249; PRD-343)', () => {
  it('gives one state per language: source, approved, proposed, stale, missing', () => {
    expect(cellOf(phrase, 'it', []).state).toBe('SOURCE')
    expect(cellOf(phrase, 'en', [tr({})]).state).toBe('APPROVED')
    expect(cellOf(phrase, 'en', [tr({ sourceRevision: 1 })]).state).toBe('STALE')
    expect(cellOf(phrase, 'en', [tr({ sourceRevision: 1 }), tr({ id: 'd', revision: 2, status: 'DRAFT', approvedAt: null, approvedById: null })]).state).toBe('PROPOSED')
    expect(cellOf(phrase, 'de', [tr({})]).state).toBe('MISSING')
  })

  it('prints the source words, or the approved translation of the current words; never a stale one', () => {
    expect(approvedText(phrase, 'it', [])).toBe('Non lavare (prova)')
    expect(approvedText(phrase, 'en', [tr({})])).toBe('No washing (test)')
    expect(approvedText(phrase, 'en', [tr({ sourceRevision: 1 })])).toBeNull()
    expect(approvedText(phrase, 'fr', [])).toBeNull()
  })

  it('numbers a language\'s translations 1, 2, 3 …', () => {
    expect(nextRevision('en', [])).toBe(1)
    expect(nextRevision('en', [{ language: 'en', revision: 1 }, { language: 'en', revision: 2 }, { language: 'de', revision: 5 }])).toBe(3)
  })

  it('approves a draft of the current words, by a second person only', () => {
    const draft = { status: 'DRAFT' as const, sourceRevision: 2, phraseRevision: 2, authorId: 'translator' }
    expect(approveRefusal({ ...draft, approverId: 'approver' })).toBeNull()
    expect(approveRefusal({ ...draft, approverId: 'translator' })?.code).toBe('OWN_PROPOSAL')
    expect(approveRefusal({ ...draft, sourceRevision: 1, approverId: 'approver' })?.code).toBe('STALE')
    expect(approveRefusal({ ...draft, status: 'APPROVED', approverId: 'approver' })?.code).toBe('NOT_DRAFT')
  })

  it('refuses a proposal or a phrase in words', () => {
    const base = { phraseStatus: 'ACTIVE', sourceLanguage: 'it', language: 'de', text: 'Nicht waschen (Test)' }
    expect(proposeRefusal(base)).toBeNull()
    expect(proposeRefusal({ ...base, language: 'pt-BR' })).toBeNull()
    expect(proposeRefusal({ ...base, language: 'it' })?.code).toBe('SOURCE_LANGUAGE')
    expect(proposeRefusal({ ...base, language: 'German' })?.code).toBe('LANGUAGE')
    expect(proposeRefusal({ ...base, phraseStatus: 'ARCHIVED' })?.code).toBe('ARCHIVED')
    expect(phraseProblems({ key: 'warning class b' }).map((issue) => issue.path)).toEqual(['body/key'])
    expect(phraseProblems({ key: 'warning.class-b', sourceLanguage: 'it', sourceText: 'Prova' })).toEqual([])
  })
})
