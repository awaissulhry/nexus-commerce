import { describe, expect, it } from 'vitest'
import en from '../../../../messages/en/defects-vocab.json'
import it_ from '../../../../messages/it/defects-vocab.json'
import { CAUSE_PROCESSES, PROCESS_WORDS } from '@nexus/factory-domain/quality/defects/causes'
import { CAUSES, GRADES } from './demo/vocabulary'
import { deleteCauseHeld, fieldOfVocabularyEdit, missingWordsNote, newCauseBody, newCauseProblems, newGradeBody, newGradeProblems, NEW_CAUSE, NEW_GRADE, typedGradeCode, vocabularyChange, vocabularyProblemOf } from './vocabulary'

const SEW = CAUSES.causes[3]!
const GRADE_B = GRADES.grades[1]!

describe('Defects & dispositions, the W2b tabs (B-W2b-118): a cell → the PATCH it sends', () => {
  it('saves the words, another floor language, the position and the state; says why not in our words', () => {
    expect(vocabularyChange(SEW, 'labelEn', ' Sewing slip ')).toEqual({ edit: { labelEn: 'Sewing slip' } })
    expect(vocabularyChange(SEW, 'labelEn', SEW.labelEn)).toBeNull()
    expect(vocabularyChange(SEW, 'labelIt', '')).toEqual({ problem: 'problem.labelIt' })
    expect(vocabularyChange(SEW, 'lang:ro', 'x'.repeat(81))).toEqual({ problem: 'problem.tooLong' })
    expect(vocabularyChange(SEW, 'lang:ro', '')).toEqual({ edit: { labelI18n: { ro: null } } })
    expect(vocabularyChange(SEW, 'active', false)).toEqual({ edit: { active: false } })
    expect(vocabularyChange(SEW, 'sortOrder', 'x')).toEqual({ problem: 'problem.sortOrder' })
    expect(fieldOfVocabularyEdit({ labelI18n: { ro: 'a' } })).toBe('lang:ro')
  })

  it('takes a usable share as a percent typed the Italian or the English way, at most 100', () => {
    expect(vocabularyChange(GRADE_B, 'usableShare', '72,5')).toEqual({ edit: { usableShare: '72.50' } })
    expect(vocabularyChange(GRADE_B, 'usableShare', '72%')).toBeNull()
    expect(vocabularyChange(GRADE_B, 'usableShare', '120')).toEqual({ problem: 'problem.usableShare' })
    expect(vocabularyChange(SEW, 'usableShare', '50')).toBeNull()
  })

  it('checks a new cause and a new grade with factory-domain at their fields', () => {
    expect(newCauseProblems(NEW_CAUSE, [])).toMatchObject({ code: 'problem.code', process: 'problem.process', labelIt: 'problem.labelIt', labelEn: 'problem.labelEn' })
    expect(newCauseProblems({ code: 'DEMO-SEW', process: 'SEWING', labelIt: 'a', labelEn: 'b' }, ['DEMO-SEW'])).toEqual({ code: 'problem.codeTaken' })
    expect(newCauseBody({ code: ' GLUE ', process: 'FINISHING', labelIt: ' Colla ', labelEn: 'Glue' })).toEqual({ code: 'GLUE', process: 'FINISHING', labelIt: 'Colla', labelEn: 'Glue' })
    expect(newGradeProblems({ ...NEW_GRADE, code: 'E', labelIt: 'a', labelEn: 'b', usableShare: '120' }, [])).toEqual({ usableShare: 'problem.usableShare' })
    expect(newGradeBody({ code: 'E', labelIt: 'a', labelEn: 'b', usableShare: '30,5' })).toEqual({ code: 'E', labelIt: 'a', labelEn: 'b', usableShare: '30.50' })
    expect(typedGradeCode('first choice extra')).toBe('FIRST-CHOI')
  })

  it('holds deleting a used cause; reads the words missing per floor language; says a refusal in our words', () => {
    expect(deleteCauseHeld(SEW, true)).toEqual({ key: 'held.used', params: { count: 21 } })
    expect(deleteCauseHeld({ usedCount: 0 }, false)).toEqual({ key: 'held.noManage' })
    expect(missingWordsNote({ languages: [{ language: 'ro', missing: { CAUSES: ['A', 'B'], GRADES: [], DEFECTS: ['X'] } }] }, 'CAUSES')).toEqual([{ language: 'ro', count: 2 }])
    expect(missingWordsNote(null, 'GRADES')).toEqual([])
    expect(vocabularyProblemOf(new Error('x'))).toEqual({ key: 'problem.failed', unknown: true })
  })

  it('names each process in the words factory-domain keeps', () => {
    for (const process of CAUSE_PROCESSES) {
      expect(en.process[process]).toBe(PROCESS_WORDS[process].en)
      expect(it_.process[process]).toBe(PROCESS_WORDS[process].it)
    }
  })
})
