import { createElement } from 'react'
import { defineDesignScreen } from '../../../../../lib/design/design-screen'
import { inShellAs, TRAINING_ROLES } from '../../fixtures'
import { demoPdf, DEMO_COURSE_REFS } from '../_demo'
import { DueListView, type DueListModel } from './view/DueListView'

/**
 * SCR-160-due — Training due list (PDF for the RSPP) (design people.skills tab:due-pdf, from the band's ⋯), made-up data:
 * due and overdue by default, one course, the other row sets, English, being made, a failed read, no right.
 */

interface DueCase {
  permissions: readonly string[]
  model: DueListModel
}

const model = (over: Partial<DueListModel> = {}, permissions: readonly string[] = TRAINING_ROLES.safety): DueCase => ({
  permissions,
  model: { allowed: true, language: 'it', view: 'due', courseId: null, courses: DEMO_COURSE_REFS, scope: 'DEMO · Stabilimento Nord', pdf: demoPdf('Scadenzario formazione DEMO'), problem: null, ...over },
})

function DueDesign({ model: value }: { model: DueCase }) {
  return inShellAs('/people/skills/due', createElement(DueListView, { model: value.model }), value.permissions)
}

export const designScreen = defineDesignScreen<DueCase>({
  screen: 'SCR-160-due',
  title: 'Skills & training: training due list (PDF)',
  view: DueDesign,
  cases: [
    { id: 'due', label: 'Due and overdue, every course (the safety officer)', model: model(), note: 'Made now, stored nowhere; which rows, one course, Italiano | English; Print.' },
    { id: 'overdue-one', label: 'Overdue only, one course', model: model({ view: 'overdue', courseId: DEMO_COURSE_REFS[1]!.id }) },
    { id: 'language', label: 'Language not checked', model: model({ view: 'language' }) },
    { id: 'english', label: 'In English (HR)', model: model({ language: 'en', pdf: demoPdf('Training due list DEMO') }, TRAINING_ROLES.hrSafety) },
    { id: 'loading', label: 'Being made', model: model({ pdf: null }) },
    { id: 'error', label: 'The list could not be made', model: model({ pdf: null, problem: 'problem.unavailable' }) },
    { id: 'company-legal', label: 'Refused: the company lacks its legal data for the letterhead', model: model({ pdf: null, problem: 'problem.companyLegal' }) },
    { id: 'no-permission', label: 'Sales: no safety.view', model: model({ allowed: false, pdf: null }, []) },
  ],
})
