import { at, COMPANY_ID, uid } from '../../../library/demo'
import { LEATHER } from '../../demo'
import type { GradeRule, GradeRuleRow, GradesView } from './api'
import { markKey, NO_GRADES, type GradeMark, type GradesModel } from './grades-model'

/**
 * Design-only made-up grades of the demo leather (SCR-048 › Properties & grades › Grades and usable area): grade A with the
 * article's own rule (88 %), B on the grade's default (74 %), C with a rule that names its panels and two earlier rules
 * (history), and a retired grade D the article still has a rule for. Invented shares and panel names; no real tannery.
 */

const rule = (n: number, usableShare: string, panels: string[], day: number, version = 1): GradeRule => ({ id: uid('4731', n), usableShare, panels, version, updatedAt: at(day, 10, 15) })
const grade = (n: number, code: string, labelIt: string, labelEn: string, defaultShare: string, active = true) => ({ id: uid('4732', n), code, labelIt, labelEn, active, defaultShare })

export const GRADE_ROWS: GradeRuleRow[] = [
  { grade: grade(1, 'A', 'Prima scelta', 'First choice', '85.00'), rule: rule(1, '88.00', [], 12, 2), share: '88.00', source: 'RULE', panels: [], retiredRules: [], hidesInStock: 6 },
  { grade: grade(2, 'B', 'Seconda scelta', 'Second choice', '74.00'), rule: null, share: '74.00', source: 'GRADE', panels: [], retiredRules: [], hidesInStock: 11 },
  {
    grade: grade(3, 'C', 'Terza scelta', 'Third choice', '55.00'),
    rule: rule(2, '58.50', ['Sottocollo', 'Taschino interno'], 20, 3),
    share: '58.50',
    source: 'RULE',
    panels: ['Sottocollo', 'Taschino interno'],
    retiredRules: [rule(3, '60.00', ['Sottocollo'], 3), rule(4, '52.00', [], 1)],
    hidesInStock: 3,
  },
  { grade: grade(4, 'D', 'Scarto', 'Reject', '40.00', false), rule: rule(5, '45.00', ['Rinforzo'], 8), share: '45.00', source: 'RULE', panels: ['Rinforzo'], retiredRules: [], hidesInStock: 1 },
]

export const GRADES_VIEW: GradesView = {
  material: { id: LEATHER.id, code: LEATHER.code, name: LEATHER.name, companyId: COMPANY_ID, tracksHides: true },
  grades: GRADE_ROWS,
  canManage: true,
}

/** The section as it shows the view, with marks or a notice for a case. */
export function gradesModel(over: Partial<GradesModel> = {}, view: GradesView = GRADES_VIEW): GradesModel {
  return { ...NO_GRADES, part: { status: 'ready', value: view }, ...over }
}

const B = GRADE_ROWS[1]!.grade.id
const C = GRADE_ROWS[2]!.grade.id

/** Cells on their way: B's share typed (creates the article's rule), C's panels changed. */
export const SAVING_MARKS: Record<string, GradeMark> = { [markKey(B, 'share')]: { state: 'saving', value: '72,5' }, [markKey(C, 'panels')]: { state: 'saving', value: 'Sottocollo, Taschino interno, Patta' } }
/** Offline: two cells wait on the page. */
export const WAITING_MARKS: Record<string, GradeMark> = { [markKey(B, 'share')]: { state: 'waiting', value: '72,5' }, [markKey(C, 'share')]: { state: 'waiting', value: '57' } }
/** Refused: a share above 100 typed (our words), a panels cell the rule moved under (read again). */
export const REFUSED_MARKS: Record<string, GradeMark> = { [markKey(B, 'share')]: { state: 'refused', value: '120', problem: 'material.grades.problem.share' }, [markKey(C, 'panels')]: { state: 'refused', problem: 'material.grades.problem.moved' } }
