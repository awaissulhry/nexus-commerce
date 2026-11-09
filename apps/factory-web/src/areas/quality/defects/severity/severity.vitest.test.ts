import { describe, expect, it } from 'vitest'
import { SEVERITY, SEVERITY_OWN } from '../demo/vocabulary'
import { designScreen } from './fixtures'
import { bodyOf, changedCells, draftOf, draftProblems, editable, editHeld, saveProblemOf, standardOf, withCell } from './model'

/** B-W2b-213: the severity words editor's rules (Quality › Defects & dispositions › Severity). */
describe('the severity words (FQ4:04)', () => {
  it('the draft holds what the tenant wrote, every language shown; critical has no meaning to type', () => {
    const draft = draftOf(SEVERITY_OWN)
    expect(draft.MAJOR.words).toEqual({ it: 'Grave (demo)', en: 'Serious (demo)', ro: 'Grav (demo)' })
    expect(draft.MAJOR.meaning).toEqual({ it: '', en: 'Likely to make the garment fail in use (demo words).', ro: '' })
    expect(draft.CRITICAL.words).toEqual({ it: '', en: 'Safety (demo)', ro: '' })
    expect(draft.CRITICAL.meaning).toEqual({})
    const critical = SEVERITY.classes.find((row) => row.class === 'CRITICAL')!
    expect(editable(critical, 'words')).toBe(true)
    expect(editable(critical, 'meaning')).toBe(false)
    expect(changedCells(SEVERITY_OWN, draft)).toBe(0)
  })

  it('the body is the whole set: empty boxes are the standard words, null when nothing is the tenant\'s', () => {
    const draft = withCell(draftOf(SEVERITY_OWN), 'MINOR', 'words', 'ro', '  Minor (demo) ')
    expect(changedCells(SEVERITY_OWN, draft)).toBe(1)
    expect(bodyOf(SEVERITY_OWN, draft)).toEqual({
      version: 2,
      texts: {
        CRITICAL: { words: { en: 'Safety (demo)' } },
        MAJOR: { words: { it: 'Grave (demo)', en: 'Serious (demo)', ro: 'Grav (demo)' }, meaning: { en: 'Likely to make the garment fail in use (demo words).' } },
        MINOR: { words: { ro: 'Minor (demo)' } },
      },
    })
    expect(bodyOf(SEVERITY, draftOf(SEVERITY))).toEqual({ version: 1, texts: null })
  })

  it('too long is said at its box; the placeholder is the standard word; refusals in words; Edit held without the right', () => {
    const draft = withCell(withCell(draftOf(SEVERITY), 'MAJOR', 'words', 'en', 'x'.repeat(61)), 'MINOR', 'meaning', 'it', 'y'.repeat(501))
    expect(draftProblems(draft).map((problem) => [problem.klass, problem.part, problem.language, problem.params.max])).toEqual([
      ['MAJOR', 'words', 'en', 60],
      ['MINOR', 'meaning', 'it', 500],
    ])
    const major = SEVERITY.classes.find((row) => row.class === 'MAJOR')!
    expect(standardOf(major, 'words', 'it')).toBe('Maggiore')
    expect(standardOf(major, 'words', 'ro')).toBe('Major')
    expect(saveProblemOf({ kind: 'conflict' })).toEqual({ key: 'problem.stale' })
    expect(saveProblemOf({ kind: 'forbidden' })).toEqual({ key: 'problem.forbidden' })
    expect(saveProblemOf(null)).toEqual({ key: 'problem.failed' })
    expect(editHeld({ ...SEVERITY, canManage: false })).toBe('held.noManage')
    expect(editHeld(SEVERITY)).toBeNull()
    expect(editHeld(null)).toBe('held.reading')
  })

  it('the review screen has every state', () => {
    expect(designScreen.screen).toBe('SCR-273')
    expect(designScreen.cases.map((item) => item.id)).toEqual(['standard', 'own', 'editing', 'edited', 'problems', 'saving', 'refused', 'no-permission', 'loading', 'error'])
  })
})
