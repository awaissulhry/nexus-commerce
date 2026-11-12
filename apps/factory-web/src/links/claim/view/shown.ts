'use client'

import { useMemo } from 'react'
import { useScopedT } from '../../../lib/i18n/provider'
import type { ClaimPage } from '../api'
import { fieldProblem, photosInForm, problemsOf, type ClaimViewModel, type Problem } from '../model'

/** Where to show a problem: the API's refusal first, then the page's own check once the step's Continue was pressed. */
export function useShown(model: ClaimViewModel, page: ClaimPage) {
  // B-W2b-342: a repair's problems name their own catalogue (`returns-repair:…`); every other key is link-claim's.
  const t = useScopedT('link-claim')
  const problems = useMemo(() => problemsOf(model.form, page, photosInForm(model.form, model.photos)), [model.form, model.photos, page])
  return useMemo(() => {
    const at = (field: string): Problem | undefined => fieldProblem(model.issues, field) ?? (problems.some((problem) => problem.field === field && model.checked.includes(problem.step)) ? fieldProblem(problems, field) : undefined)
    return {
      problems,
      /** The words of the problem at a field, or undefined. */
      error: (field: string): string | undefined => {
        const problem = at(field)
        return problem ? t(problem.key, problem.params) : undefined
      },
    }
  }, [model.issues, model.checked, problems, t])
}
