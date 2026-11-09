'use client'

import { useState } from 'react'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'
import { isApiError } from '../../../../lib/api/errors'
import { saveSeverity, type Severity } from './api'
import { bodyOf, draftOf, draftProblems, saveProblemOf, type SeverityEdit, type SeverityWordsActions } from './model'

/**
 * B-W2b-213: the severity words editor's state for the Defects & dispositions page (the container): Edit opens the draft
 * of what the tenant wrote, Save sends the whole set with the settings row's version (one Idempotency-Key per save), the
 * answer is the page's new read. A refusal stays on the bar in words; a stale version asks to read again.
 */
export function useSeverityWords(api: ApiClient, severity: Severity | null, onSaved: (value: Severity) => void): { edit: SeverityEdit | null; actions: SeverityWordsActions } {
  const [edit, setEdit] = useState<SeverityEdit | null>(null)
  const actions: SeverityWordsActions = {
    onEdit: () => severity && severity.canManage && setEdit({ draft: draftOf(severity), busy: false, problem: null }),
    onDraft: (draft) => setEdit((current) => (current ? { ...current, draft, problem: null } : current)),
    onDiscard: () => setEdit(null),
    onSave: () => {
      if (!severity || !edit || edit.busy) return
      // Held while a text is too long (the bar says why; each box says its own problem).
      if (draftProblems(edit.draft).length > 0) return
      setEdit({ ...edit, busy: true, problem: null })
      saveSeverity(api, bodyOf(severity, edit.draft), newIdempotencyKey())
        .then((value) => {
          onSaved(value)
          setEdit(null)
        })
        .catch((error: unknown) => setEdit((current) => (current ? { ...current, busy: false, problem: saveProblemOf(isApiError(error) ? error : null) } : current)))
    },
  }
  return { edit, actions }
}
