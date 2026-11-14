'use client'

import { useState } from 'react'
import type { ApiClient } from '../../../../lib/api/client'
import type { Role } from '../../shared/api'
import { problemKey } from '../../shared/model'
import { isStepUpCancelled } from '../../shared/step-up'
import { useFreshCode } from '../../security/step-up/fresh'
import { archiveRole, restoreRole, reviewRole, saveRole } from './api'
import { bodyOf, draftDiff, draftOf, saveProblem, type RoleDraft } from './model'
import type { ArchiveDialogModel } from './view/ArchiveDialog'
import type { SaveReview } from './view/RoleEditor'

/**
 * Change role, archive and restore (SCR-012, B-W2b-413): the draft of ticks and money sight; Save → `POST …/review` in the
 * ReviewChangesModal; Save role → a fresh code FIRST when the review says it asks one (raising rights or changing two-factor),
 * then `PATCH /auth/roles/:id` at the reviewed version; done reads the role again (`reload`). Archive (a reason; a fresh code
 * first when people hold it, as it ends their assignments) and Restore (no code).
 */
export function useSaveRole(api: ApiClient, role: Role | null, reload: () => void) {
  const [draft, setDraft] = useState<RoleDraft | null>(null)
  const [review, setReview] = useState<SaveReview | null>(null)
  const [archive, setArchive] = useState<ArchiveDialogModel | null>(null)
  const [notice, setNotice] = useState<{ key: string; tone: 'success' | 'warning' } | null>(null)
  const fresh = useFreshCode(api)
  const current = draft ?? (role ? draftOf(role) : null)

  const askReview = () => {
    if (!role || !current || draftDiff(role, current).count === 0) return
    setReview({ phase: 'reading' })
    reviewRole(api, role.id, bodyOf(role, current)).then(
      (answer) => setReview({ phase: 'ready', review: answer, problem: null, paths: [] }),
      (error: unknown) => setReview({ phase: 'failed', problem: problemKey(error) }),
    )
  }

  const save = async () => {
    if (!role || !current || review?.phase !== 'ready' || review.review.refusals.length > 0) return
    const reviewed = review.review
    setReview({ phase: 'saving', review: reviewed })
    try {
      if (reviewed.asksFreshCode) await fresh.ensureFresh('saveRole.freshSentence')
      await fresh.guard('saveRole.freshSentence', () => saveRole(api, role.id, { version: reviewed.version, ...bodyOf(role, current) }))
      setReview({ phase: 'done', review: reviewed })
      setDraft(null)
      reload()
    } catch (error) {
      if (isStepUpCancelled(error)) return setReview({ phase: 'ready', review: reviewed, problem: null, paths: [] })
      const problem = saveProblem(error)
      setReview({ phase: 'ready', review: reviewed, problem: problem.key === 'saveRole.problem.refused' ? null : problem.key, paths: problem.paths })
      if (problem.key === 'saveRole.problem.stale') reload()
    }
  }

  const doArchive = async (reason: string) => {
    if (!role || !archive || archive.busy) return
    setArchive({ ...archive, busy: true, problem: null })
    try {
      if (role.holders > 0) await fresh.ensureFresh('archive.freshSentence')
      await fresh.guard('archive.freshSentence', () => archiveRole(api, role.id, { version: role.version, reason }))
      setArchive(null)
      setNotice({ key: 'archive.done', tone: 'success' })
      reload()
    } catch (error) {
      if (isStepUpCancelled(error)) return setArchive((open) => (open ? { ...open, busy: false } : open))
      const problem = saveProblem(error)
      setArchive((open) => (open ? { ...open, busy: false, problem: problem.key === 'saveRole.problem.refused' ? 'archive.refused' : problem.key } : open))
    }
  }

  const doRestore = async () => {
    if (!role) return
    try {
      await restoreRole(api, role.id, { version: role.version })
      setNotice({ key: 'archive.restored', tone: 'success' })
    } catch (error) {
      setNotice({ key: saveProblem(error).key, tone: 'warning' })
    }
    reload()
  }

  return {
    draft: current,
    review,
    archive,
    notice,
    stepUp: fresh.stepUp,
    actions: {
      onDraft: (next: RoleDraft) => setDraft(next),
      onDiscard: () => setDraft(null),
      onReview: askReview,
      onRetryReview: askReview,
      onSave: () => void save(),
      onCloseReview: () => setReview(null),
      onArchive: () => role && setArchive({ name: role.name, holders: role.holders, busy: false, problem: null }),
      onArchiveConfirm: (reason: string) => void doArchive(reason),
      onArchiveClose: () => setArchive(null),
      onRestore: () => void doRestore(),
      onDismissNotice: () => setNotice(null),
      onStepUpSubmit: (code: string) => void fresh.submit(code),
      onStepUpClose: fresh.cancel,
    },
  }
}
