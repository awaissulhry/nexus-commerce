import { describe, expect, it } from 'vitest'
import { CAUSE_PROCESSES, causeDraftProblems, isCauseProcess, missingCauses, PROCESS_WORDS, STARTER_CAUSES } from './causes'
import { GRADE_CODE, gradeDraftProblems, HIDE_DEFECT_CATEGORY, isHideDefect, missingGrades, STARTER_GRADES, usableShareText } from './grades'
import { DEFECT_CLASSES, useAsIsProblem } from './rules'
import { acceptanceProblem, acceptedDecisionProblem, classesAllowed, classLocked, classWordsIn, recordedClassProblem, SAFETY_LAW, SAFETY_RULE, SEVERITY_CLASSES } from './severity'
import { STARTER_LIBRARY } from './standard'
import { coverageOf, languageOf, missingLanguages, otherFloorLanguages, wordsIn } from './vocabulary'

const paths = (issues: readonly { path: string }[]) => issues.map((issue) => issue.path)

describe('the severity classes and the safety rule (QHS-002)', () => {
  it('are critical, major and minor in the database order, critical locked at an acceptance number of 0 with its law', () => {
    expect(SEVERITY_CLASSES.map((entry) => entry.class)).toEqual([...DEFECT_CLASSES])
    expect(SEVERITY_CLASSES.map((entry) => entry.rank)).toEqual([0, 1, 2])
    const critical = SEVERITY_CLASSES[0]!
    expect(critical).toMatchObject({ acceptanceNumber: 0, locked: true, law: SAFETY_LAW })
    expect(SEVERITY_CLASSES.slice(1).every((entry) => !entry.locked && entry.acceptanceNumber === null && entry.law === null)).toBe(true)
    expect(SEVERITY_CLASSES.every((entry) => entry.words.it && entry.words.en && entry.meaning.it && entry.meaning.en)).toBe(true)
    expect(SAFETY_RULE.en).toBe('Critical = safety or compliance failure; never accepted (AQL 0).')
    expect(SAFETY_LAW).toMatch(/2016\/425/)
    expect(classWordsIn('MAJOR', 'it')).toBe('Maggiore')
    expect(classWordsIn('MAJOR', 'ro')).toBe('Major')
  })

  it('a critical defect of the library is recorded critical, never milder; the others may be judged either way', () => {
    expect(classesAllowed('CRITICAL')).toEqual(['CRITICAL'])
    expect(classesAllowed('MINOR')).toEqual(['CRITICAL', 'MAJOR', 'MINOR'])
    expect(classesAllowed(null)).toEqual(['CRITICAL', 'MAJOR', 'MINOR'])
    expect(classLocked('CRITICAL')).toBe(true)
    expect(classLocked('MAJOR')).toBe(false)
    expect(recordedClassProblem('CRITICAL', 'MINOR', 'LABEL-WRONG')).toBe('LABEL-WRONG is critical in the defect library (a safety or compliance failure): it is recorded critical, never minor.')
    expect(recordedClassProblem('CRITICAL', 'CRITICAL')).toBeNull()
    expect(recordedClassProblem('MAJOR', 'MINOR')).toBeNull()
    expect(recordedClassProblem('MINOR', 'CRITICAL')).toBeNull()
  })

  it('a critical acceptance number is always 0; a major or minor one any whole number from 0', () => {
    expect(acceptanceProblem('CRITICAL', 0)).toBeNull()
    expect(acceptanceProblem('CRITICAL', 1)).toMatch(/never accepted: its acceptance number is always 0/)
    expect(acceptanceProblem('MAJOR', 3)).toBeNull()
    expect(acceptanceProblem('MINOR', -1)).toBe('An acceptance number is a whole number from 0.')
    expect(acceptanceProblem('MINOR', 1.5)).toBe('An acceptance number is a whole number from 0.')
  })

  it('no decision lets a critical defect go on; a major one is never used as is; taking goods away is always open', () => {
    expect(acceptedDecisionProblem('USE_AS_IS', 'CRITICAL')).toMatch(/not used as it is/)
    expect(acceptedDecisionProblem('REGRADE', 'CRITICAL')).toMatch(/not regraded to second quality/)
    expect(acceptedDecisionProblem('CONCESSION', 'CRITICAL')).toMatch(/not sold under a concession/)
    for (const outcome of ['REWORK', 'REPAIR', 'RETURN_TO_SUPPLIER', 'QUARANTINE', 'SCRAP'] as const) expect(acceptedDecisionProblem(outcome, 'CRITICAL')).toBeNull()
    expect(acceptedDecisionProblem('USE_AS_IS', 'MAJOR')).toBe(useAsIsProblem('USE_AS_IS', 'MAJOR'))
    expect(acceptedDecisionProblem('REGRADE', 'MAJOR')).toBeNull()
    expect(acceptedDecisionProblem('CONCESSION', 'MAJOR')).toBeNull()
    expect(acceptedDecisionProblem('USE_AS_IS', 'MINOR')).toBeNull()
  })

  it('the starter library keeps its safety defects critical (armour, labels)', () => {
    const critical = STARTER_LIBRARY.flatMap((category) => category.defects.filter((defect) => defect.severity === 'CRITICAL').map((defect) => `${category.code}/${defect.code}`))
    expect(critical).toEqual(['PROTECTION/ARMOUR-POCKET-MISSING', 'LABEL/LABEL-WRONG'])
  })
})

describe('the cause codes (QHS-004)', () => {
  it('a new code names its process and its words; a change never names the code or the process', () => {
    expect(causeDraftProblems({ code: 'SEW-ERROR', process: 'SEWING', labelIt: 'Errore di cucitura', labelEn: 'Sewing error', labelI18n: { ro: 'Eroare de coasere' } }, true)).toEqual([])
    expect(paths(causeDraftProblems({ code: 'sew error', process: 'KNITTING', labelIt: ' ', labelEn: 'x' }, true))).toEqual(['code', 'process', 'labelIt'])
    expect(paths(causeDraftProblems({ code: 'X1' }, true))).toEqual(['process', 'labelIt', 'labelEn'])
    expect(paths(causeDraftProblems({ code: 'OTHER', process: 'DESIGN', labelI18n: { it: 'no', ro: '' } }, false))).toEqual(['code', 'process', 'labelI18n/it', 'labelI18n/ro'])
    expect(paths(causeDraftProblems({ sortOrder: -1 }, false))).toEqual(['sortOrder'])
    expect(causeDraftProblems({ labelEn: 'Handling damage' }, false)).toEqual([])
  })

  it('the processes are the database\'s eight, each with words; the starter set has one code per process, in order', () => {
    expect(CAUSE_PROCESSES).toEqual(['MATERIAL', 'SUPPLIER', 'CUTTING', 'SEWING', 'FINISHING', 'HANDLING', 'DESIGN', 'MEASUREMENT'])
    expect(CAUSE_PROCESSES.every((process) => PROCESS_WORDS[process].it && PROCESS_WORDS[process].en)).toBe(true)
    expect(STARTER_CAUSES.map((cause) => cause.process)).toEqual([...CAUSE_PROCESSES])
    expect(STARTER_CAUSES.every((cause) => causeDraftProblems(cause, true).length === 0)).toBe(true)
    expect(isCauseProcess('SEWING')).toBe(true)
    expect(isCauseProcess('sewing')).toBe(false)
    expect(missingCauses(new Set(['MAT-FAULT', 'SEW-ERROR', 'OWN-CODE'])).map((cause) => cause.code)).toEqual(['SUP-SPEC', 'CUT-ERROR', 'FIN-ERROR', 'HANDLING', 'DESIGN', 'MEASURE'])
    expect(missingCauses(new Set(STARTER_CAUSES.map((cause) => cause.code)))).toEqual([])
  })
})

describe('the leather grades and hide defects (QHS-006)', () => {
  it('a grade is a short code without spaces with its words and a usable share from 0 to 100', () => {
    expect(GRADE_CODE.test('A')).toBe(true)
    expect(GRADE_CODE.test('1-ST')).toBe(true)
    expect(GRADE_CODE.test('a')).toBe(false)
    expect(GRADE_CODE.test('A B')).toBe(false)
    expect(GRADE_CODE.test('ABCDEFGHIJK')).toBe(false)
    expect(gradeDraftProblems({ code: 'E', labelIt: 'Scarto', labelEn: 'Reject', usableShare: '20' }, true)).toEqual([])
    expect(paths(gradeDraftProblems({ code: 'e e', labelIt: 'x', labelEn: 'y' }, true))).toEqual(['code', 'usableShare'])
    for (const share of ['100.01', '101', '-1', '72.555', 'abc', '']) expect(paths(gradeDraftProblems({ usableShare: share }, false))).toEqual(['usableShare'])
    for (const share of ['0', '100', '72.5', '72.50']) expect(gradeDraftProblems({ usableShare: share }, false)).toEqual([])
    expect(paths(gradeDraftProblems({ code: 'B' }, false))).toEqual(['code'])
    expect(usableShareText('72.5')).toBe('72.50')
    expect(usableShareText(' 85 ')).toBe('85.00')
  })

  it('the starter grades are A-D, best first; the missing ones in order', () => {
    expect(STARTER_GRADES.map((grade) => `${grade.code} ${grade.usableShare}`)).toEqual(['A 85.00', 'B 72.00', 'C 60.00', 'D 45.00'])
    expect(STARTER_GRADES.every((grade) => gradeDraftProblems(grade, true).length === 0)).toBe(true)
    expect(missingGrades(new Set(['A', 'C'])).map((grade) => grade.code)).toEqual(['B', 'D'])
  })

  it('the hide defects are the hide category\'s defects that apply at incoming or cutting', () => {
    expect(HIDE_DEFECT_CATEGORY).toBe('LEATHER')
    const leather = STARTER_LIBRARY.find((category) => category.code === HIDE_DEFECT_CATEGORY)!
    expect(leather.defects.filter((defect) => isHideDefect(defect, leather.code)).map((defect) => defect.code)).toEqual(['SHADE-DIFF', 'HIDE-SCAR', 'GRAIN-CRACK', 'LOOSE-GRAIN'])
    expect(isHideDefect({ stages: [] }, 'LEATHER')).toBe(true)
    expect(isHideDefect({ stages: ['INCOMING'] }, 'SEAM')).toBe(false)
  })
})

describe('the vocabulary in the person\'s language (QHS-007)', () => {
  const scar = { labelIt: 'Cicatrice', labelEn: 'Scar', labelI18n: { ro: 'Cicatrice pe piele' } }

  it('shows a code in the language asked, else its English words and says so', () => {
    expect(wordsIn(scar, 'it')).toEqual({ label: 'Cicatrice', language: 'it', missing: false })
    expect(wordsIn(scar, 'en')).toEqual({ label: 'Scar', language: 'en', missing: false })
    expect(wordsIn(scar, 'ro')).toEqual({ label: 'Cicatrice pe piele', language: 'ro', missing: false })
    expect(wordsIn(scar, 'ur')).toEqual({ label: 'Scar', language: 'en', missing: true })
    expect(wordsIn({ ...scar, labelI18n: { ro: '  ' } }, 'ro')).toMatchObject({ label: 'Scar', missing: true })
  })

  it('answers in the language asked, else the person\'s, else Italian', () => {
    expect(languageOf('ro', 'it')).toBe('ro')
    expect(languageOf('RO', 'en')).toBe('en')
    expect(languageOf(undefined, 'ur')).toBe('ur')
    expect(languageOf(null, null)).toBe('it')
  })

  it('counts, per other floor language of the sites, the active codes with no words in it', () => {
    const sites = [{ floorLocales: ['it', 'ro'] }, { floorLocales: ['it', 'en', 'ro', 'ur'] }, { floorLocales: ['it', 'xx-bad'] }]
    expect(otherFloorLanguages(sites)).toEqual(['ro', 'ur'])
    expect(missingLanguages(scar, ['it', 'ro', 'ur'])).toEqual(['ur'])
    const coverage = coverageOf(
      {
        DEFECTS: [{ code: 'HIDE-SCAR', active: true, labelI18n: { ro: 'Cicatrice' } }, { code: 'OLD', active: false, labelI18n: {} }],
        CAUSES: [{ code: 'SEW-ERROR', active: true, labelI18n: { ro: 'Eroare', ur: 'غلطی' } }],
        GRADES: [{ code: 'A', active: true, labelI18n: {} }],
      },
      sites,
    )
    expect(coverage).toEqual([
      { language: 'ro', sites: 2, missing: { DEFECTS: [], CAUSES: [], GRADES: ['A'] }, complete: false },
      { language: 'ur', sites: 1, missing: { DEFECTS: ['HIDE-SCAR'], CAUSES: [], GRADES: ['A'] }, complete: false },
    ])
    expect(coverageOf({ DEFECTS: [], CAUSES: [], GRADES: [] }, [{ floorLocales: ['it', 'en'] }])).toEqual([])
  })
})
