'use client'

import { useCallback, useRef, useState } from 'react'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'
import { addAssessment, fingerprintOf, freezeVersion, readAssessment, uploadFile, type Assessment, type DvrVersion } from './api'
import { emptyVersionDraft, freezeBodyOf, freezeHeld, newAssessmentHeld, problemOf, readProblemOf, type VersionDraft } from './model'
import type { PageNotice, VersionActions, VersionDialogState } from './view-model'

export interface VersionDeskInput {
  readonly api: ApiClient
  readonly companyId: string | null
  readonly today: string
  readonly canManage: boolean
  readonly onFrozen: (version: DvrVersion) => void
  readonly onAssessment: (assessment: Assessment) => void
  readonly onNotice: (notice: PageNotice) => void
}

/**
 * New DVR version (design pop:version), the page's and the record's: the chosen assessment's record is read for its signers
 * (`next`), what the caller may do and a version already waiting; "Add the current DVR" for a site without an assessment adds
 * it first (POST /safety/risk/assessments); the PDF's SHA-256 is computed on this device as soon as it is chosen; "Freeze and
 * send for signature" uploads the PDF as a file of the assessment (generic files routes), then freezes it (POST …/versions):
 * the key of both writes is ONE per attempt, so a retry after a lost answer is the same freeze.
 */
export function useVersionDesk({ api, companyId, today, canManage, onFrozen, onAssessment, onNotice }: VersionDeskInput) {
  const [state, setState] = useState<VersionDialogState | null>(null)
  const file = useRef<File | null>(null)
  const attempt = useRef<{ key: string; fileId: string | null } | null>(null)
  const latest = useRef({ onFrozen, onAssessment, onNotice })
  latest.current = { onFrozen, onAssessment, onNotice }

  const readRecord = useCallback(
    (assessmentId: string | null) => {
      if (!assessmentId) return setState((current) => (current ? { ...current, record: null } : current))
      setState((current) => (current ? { ...current, record: { status: 'loading' } } : current))
      readAssessment(api, assessmentId).then(
        (record) => setState((current) => (current && current.draft.assessmentId === assessmentId ? { ...current, record: { status: 'ready', value: record } } : current)),
        (error: unknown) => setState((current) => (current && current.draft.assessmentId === assessmentId ? { ...current, record: { status: 'error', problem: readProblemOf(error) } } : current)),
      )
    },
    [api],
  )

  const open = useCallback(
    (assessmentId: string | null) => {
      setState((current) => {
        if (current) return current
        file.current = null
        attempt.current = null
        return { draft: emptyVersionDraft(assessmentId, today), record: null, busy: false, step: 'fill', addingAssessment: false, problem: null, frozen: null }
      })
      readRecord(assessmentId)
    },
    [readRecord, today],
  )

  const close = useCallback(() => {
    file.current = null
    attempt.current = null
    setState(null)
  }, [])

  const setDraft = useCallback(
    (draft: VersionDraft) => {
      const changed = state?.draft.assessmentId !== draft.assessmentId
      setState((current) => (current ? { ...current, draft, problem: null } : current))
      if (changed) readRecord(draft.assessmentId)
    },
    [readRecord, state?.draft.assessmentId],
  )

  const setFile = useCallback((chosen: File | null) => {
    file.current = chosen
    attempt.current = null
    setState((current) => (current ? { ...current, problem: null, draft: { ...current.draft, file: chosen ? { name: chosen.name, type: chosen.type || 'application/pdf', size: chosen.size } : null, sha256: null } } : current))
    if (!chosen) return
    fingerprintOf(chosen).then(
      (sha256) => setState((current) => (current && file.current === chosen ? { ...current, draft: { ...current.draft, sha256 } } : current)),
      () => setState((current) => (current ? { ...current, problem: { key: 'problem.fingerprint', field: null } } : current)),
    )
  }, [])

  const addTheAssessment = useCallback(async () => {
    if (!state || state.addingAssessment || !companyId || !canManage) return
    const { draft } = state
    if (newAssessmentHeld(draft, today, false) || !draft.newSiteId) return
    setState({ ...state, addingAssessment: true, problem: null })
    try {
      const assessment = await addAssessment(api, { companyId, siteId: draft.newSiteId, name: draft.newName.trim(), nextReviewOn: draft.newReviewOn || null, note: null }, newIdempotencyKey())
      latest.current.onAssessment(assessment)
      setState((current) => (current ? { ...current, addingAssessment: false, draft: { ...current.draft, assessmentId: assessment.id, newSiteId: null } } : current))
      readRecord(assessment.id)
    } catch (error) {
      setState((current) => (current ? { ...current, addingAssessment: false, problem: problemOf(error) } : current))
    }
  }, [api, canManage, companyId, readRecord, state, today])

  const freeze = useCallback(async () => {
    if (!state || state.busy || !file.current) return
    const record = state.record?.status === 'ready' ? state.record.value : null
    if (!record || freezeHeld(state.draft, record, today, false)) return
    const assessment = record.assessment
    const pdf = file.current
    attempt.current = attempt.current ?? { key: newIdempotencyKey(), fileId: null }
    const turn = attempt.current
    setState({ ...state, busy: true, step: 'uploading', problem: null })
    try {
      if (!turn.fileId) {
        const stored = await uploadFile(api, { type: 'RiskAssessment', id: assessment.id, companyId: assessment.companyId }, pdf)
        if (stored.status !== 'AVAILABLE') throw Object.assign(new Error('not available'), { kept: 'refusal.FILE_NOT_READY' })
        turn.fileId = stored.id
      }
      setState((current) => (current ? { ...current, step: 'freezing' } : current))
      const version = await freezeVersion(api, assessment.id, freezeBodyOf(state.draft, turn.fileId), turn.key)
      attempt.current = null
      file.current = null
      setState((current) => (current ? { ...current, busy: false, step: 'fill', frozen: version } : current))
      latest.current.onFrozen(version)
      latest.current.onNotice({ tone: 'success', key: 'notice.frozen', params: { version: `v${version.versionNo}`, assessment: assessment.name } })
    } catch (error) {
      const kept = (error as { kept?: string }).kept
      setState((current) => (current ? { ...current, busy: false, step: 'fill', problem: kept ? { key: kept, field: null } : problemOf(error) } : current))
    }
  }, [api, state, today])

  const actions: VersionActions = {
    onVersionDraft: setDraft,
    onVersionFile: setFile,
    onVersionAddAssessment: () => void addTheAssessment(),
    onVersionFreeze: () => void freeze(),
    onVersionRetry: () => readRecord(state?.draft.assessmentId ?? null),
  }

  return { state, open, close, actions }
}
