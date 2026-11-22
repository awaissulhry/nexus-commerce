import { describe, expect, it } from 'vitest'
import { askDayWords, askLocaleOf, askShapeProblem, askTextProblem, chaseNoteText, checkTaskTitle, FILE_ASK_LIMITS, FILE_ASK_REFUSALS, FILE_ASK_REFUSAL_WORDS, isFloorAddressee, lateDaysOf, refusalWords, uploadTaskTitle } from './asks'

/** B-OF-031 (order files tab; 13-backend §2): the pure rules of an ask for a file. Not run in the build (checks at the end). */
describe('an ask for a file: who, where, words (B-OF-031)', () => {
  it('the floor is asked only on a work order, never for a file with prices or body data; a step ask names its step', () => {
    expect(isFloorAddressee('FLOOR_TEAM')).toBe(true)
    expect(isFloorAddressee('STEP')).toBe(true)
    expect(isFloorAddressee('OFFICE_ROLE')).toBe(false)
    const base = { priced: false, bodyData: false, hasStep: true } as const
    expect(askShapeProblem({ ...base, target: 'SALES_ORDER', addressee: 'FLOOR_TEAM' })).toBe('FLOOR_NEEDS_WORK_ORDER')
    expect(askShapeProblem({ ...base, target: 'SALES_ORDER_LINE', addressee: 'STEP' })).toBe('FLOOR_NEEDS_WORK_ORDER')
    expect(askShapeProblem({ ...base, target: 'WORK_ORDER', addressee: 'FLOOR_ROLE', priced: true })).toBe('FLOOR_NO_PRICES')
    expect(askShapeProblem({ ...base, target: 'WORK_ORDER', addressee: 'FLOOR_TEAM', bodyData: true })).toBe('FLOOR_NO_BODY_DATA')
    expect(askShapeProblem({ ...base, target: 'WORK_ORDER', addressee: 'STEP', hasStep: false })).toBe('STEP_NEEDS_STEP')
    expect(askShapeProblem({ ...base, target: 'WORK_ORDER', addressee: 'STEP' })).toBeNull()
    // The office may be asked for a priced file or body data anywhere.
    expect(askShapeProblem({ ...base, target: 'SALES_ORDER', addressee: 'PERSON', priced: true, bodyData: true })).toBeNull()
  })

  it('words in one line of 1 to 500; reasons of 3 to 500', () => {
    expect(askTextProblem('Pattern PDF, size 50', 1)).toBeNull()
    expect(askTextProblem('   ', 1)).toBe('Say what is needed.')
    expect(askTextProblem('Two\nlines', 1)).toBe('One line, without line breaks.')
    expect(askTextProblem('x'.repeat(FILE_ASK_LIMITS.words + 1), 1)).toBe('At most 500 characters.')
    expect(askTextProblem('ab', FILE_ASK_LIMITS.reasonMin, FILE_ASK_LIMITS.reasonMax)).toBe('At least 3 characters.')
  })

  it('late is derived from the due day against the company day; 0 when not late', () => {
    expect(lateDaysOf('2026-11-20', '2026-11-22')).toBe(2)
    expect(lateDaysOf('2026-11-22', '2026-11-22')).toBe(0)
    expect(lateDaysOf('2026-11-25', '2026-11-22')).toBe(0)
    expect(lateDaysOf('2026-12-31', '2027-01-02')).toBe(2)
  })

  it('the Tasks and the chase note say the words in the person’s language, a priced ask never its words', () => {
    expect(askLocaleOf('en')).toBe('en')
    expect(askLocaleOf('en-GB')).toBe('en')
    expect(askLocaleOf(null)).toBe('it')
    expect(uploadTaskTitle('Pattern PDF, size 50', false, 'en')).toBe('Upload: Pattern PDF, size 50')
    expect(uploadTaskTitle('Pattern PDF, size 50', false, 'it')).toBe('Carica: Pattern PDF, size 50')
    expect(uploadTaskTitle('Proforma at 41.50 a jacket', true, 'en')).toBe('Upload: a file with prices')
    expect(checkTaskTitle('Pattern PDF, size 50', false, 'it')).toBe('Controlla: Pattern PDF, size 50')
    const long = uploadTaskTitle('x'.repeat(500), false, 'en')
    expect(long.length).toBe(FILE_ASK_LIMITS.title)
    expect(long.endsWith('…')).toBe(true)
    expect(askDayWords('2026-11-28', 'en')).toBe('28 Nov')
    expect(askDayWords('2026-11-28', 'it')).toBe('28 nov')
    expect(chaseNoteText('Pattern PDF, size 50', false, '2026-11-28', 'en')).toBe('Ask for an update: Pattern PDF, size 50, due 28 Nov')
    expect(chaseNoteText('Proforma at 41.50 a jacket', true, '2026-11-28', 'en')).toBe('Ask for an update: a file with prices, due 28 Nov')
    expect(chaseNoteText('Proforma at 41.50 a jacket', true, '2026-11-28', 'it')).not.toContain('41.50')
  })

  it('every refusal has words it + en; a name and a count are filled in', () => {
    for (const code of FILE_ASK_REFUSALS) expect(FILE_ASK_REFUSAL_WORDS[code].it.length * FILE_ASK_REFUSAL_WORDS[code].en.length, code).toBeGreaterThan(0)
    expect(refusalWords('PERSON_CANNOT_SEE', { name: 'Alex Demo' }).en).toBe('Alex Demo cannot see this order.')
    expect(refusalWords('TOO_MANY_PEOPLE', { n: 23 }).en).toBe('23 people have this role: pick one person.')
    expect(refusalWords('FILES_HELD', { n: 1 }).en).toBe('1 file is still being checked by the virus scan: accept once the check is done.')
    expect(refusalWords('FILES_HELD', { n: 2 }).en).toBe('2 files are still being checked by the virus scan: accept once the check is done.')
    expect(refusalWords('ORDER_CLOSED').it).toBe("Quest'ordine è chiuso: niente nuove richieste.")
  })
})
