import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { DEMO_PDF, inHealthShell, NOW, type HealthRoleDemo } from '../_demo/fixtures'
import type { JudgementCopyModel } from '../view-model'
import { JudgementCopyView } from './view/JudgementCopyView'

/** SCR-212-copy — a judgement's copy in its own tab (design tab:copy "Judgement copy (PDF)"), a made-up one-page PDF. */

interface CopyCase {
  role: HealthRoleDemo
  model: JudgementCopyModel
}

const model = (over: Partial<JudgementCopyModel> = {}, role: HealthRoleDemo = 'hr'): CopyCase => ({ role, model: { canView: true, kind: 'pdf', bytes: DEMO_PDF, problem: null, at: NOW, ...over } })

function CopyDesign({ model: value }: { model: CopyCase }) {
  return inHealthShell('/plant/health/copy', createElement(JudgementCopyView, { model: value.model }), value.role)
}

export const designScreen = defineDesignScreen<CopyCase>({
  screen: 'SCR-212-copy',
  title: 'Health surveillance: a judgement\'s copy (PDF)',
  view: CopyDesign,
  cases: [
    { id: 'pdf', label: 'The doctor\'s copy (PDF): this opening was recorded', model: model() },
    { id: 'loading', label: 'Reading the copy', model: model({ kind: null, bytes: null, at: null }) },
    { id: 'error', label: 'The copy could not be read', model: model({ kind: null, bytes: null, at: null, problem: 'problem.read' }) },
    { id: 'not-found', label: 'No such copy (or not in reach)', model: model({ kind: null, bytes: null, at: null, problem: 'problem.notFound' }) },
    { id: 'unknown', label: 'A file that is neither a PDF nor a picture', model: model({ kind: null }) },
    { id: 'no-permission', label: 'Safety officer: no access', model: model({ canView: false, bytes: null, kind: null, at: null }, 'safety') },
  ],
})
