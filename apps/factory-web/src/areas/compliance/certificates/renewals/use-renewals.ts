'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiClient } from '../../../../lib/api/client'
import { isApiError } from '../../../../lib/api/errors'
import { listAssignees } from '../../../../record-panels/tasks/api'
import { failedRead, problemKey, reading, ready, type Read } from '../../../quality/_shared/model'
import { pickedFile, type PickedFile } from '../api'
import type { CertCan } from '../model'
import { decideNotNeeded, getRenewals, linkSuccessor, listReviews, notifyBody, recordAnswer, recordApplication, startRenewal, uploadAnswer, type Renewals, type Review } from './api'
import { blankRenewalDraft, type AssigneeOption, type RenewalAct, type RenewalDialog, type RenewalDraft, type RenewalsModel } from './model'

/** The API's sentences of a refusal (data, English) for the lines under our words. */
const issueLines = (error: unknown): string[] => (isApiError(error) ? [...error.issues.map((issue) => issue.message ?? '').filter(Boolean), ...(error.issues.length === 0 && error.kind === 'conflict' ? [error.message] : [])] : [])

function writeProblem(error: unknown): string {
  if (!isApiError(error)) return 'write.failed'
  if (error.kind === 'conflict') return error.issues.some((issue) => /refusal\//.test(String((issue as { path?: unknown }).path ?? ''))) ? 'ren.write.refused' : 'write.conflict'
  if (error.kind === 'forbidden') return 'held.manage'
  if (error.kind === 'invalid') return 'write.invalid'
  if (error.kind === 'not_found') return 'write.notFound'
  return 'write.failed'
}

export interface RenewalsActions {
  onRetry?: () => void
  onDialog?: (dialog: RenewalDialog | null) => void
  onDraft?: (patch: Partial<RenewalDraft>) => void
  onFile?: (file: File) => void
  onStart?: () => void
  onApplied?: () => void
  onLink?: () => void
  onNotify?: () => void
  onNotNeeded?: () => void
  onAnswer?: () => void
  onSelect?: (ids: readonly string[]) => void
  onExport?: (reviews: readonly Review[]) => void
}

/**
 * The Renewals tab's container (the certificate record mounts it; the view only reads its model): reads the renewals
 * (`GET …/renewals`) and the certificate's changes to the approved type (`GET /compliance/type-changes?certificateId=`)
 * when the tab is open, the people a renewal task may be given to when Start renewal opens, and runs each write with the
 * version read. A write changes the certificate's version: `onCertificateChanged` reads the record again.
 */
export function useRenewals(input: { api: ApiClient; certificateId: string; can: CertCan; active: boolean; today: string; locale: 'it' | 'en'; act: RenewalAct | null; onCertificateChanged: () => void; onExport: (reviews: readonly Review[]) => void }) {
  const { api, certificateId, can, active, today, locale, onCertificateChanged } = input
  const [renewals, setRenewals] = useState<Read<Renewals>>(reading())
  const [reviews, setReviews] = useState<Read<Review[]>>(reading())
  const [people, setPeople] = useState<Read<AssigneeOption[]> | null>(null)
  const [dialog, setDialog] = useState<RenewalDialog | null>(null)
  const [draft, setDraft] = useState<RenewalDraft>(blankRenewalDraft(today, locale))
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [lines, setLines] = useState<readonly string[]>([])
  const [selected, setSelected] = useState<readonly string[]>([])
  const file = useRef<PickedFile | null>(null)
  const acted = useRef(false)

  const load = useCallback(async () => {
    if (!can.view) return
    getRenewals(api, certificateId)
      .then((value) => setRenewals(ready(value)))
      .catch((error) => setRenewals(failedRead(problemKey(error))))
    listReviews(api, { certificateId })
      .then((value) => setReviews(ready(value.reviews)))
      .catch((error) => setReviews(failedRead(problemKey(error))))
  }, [api, can.view, certificateId])

  useEffect(() => {
    if (active) void load()
  }, [active, load])

  const open = useCallback(
    (next: RenewalDialog | null) => {
      setDialog(next)
      setProblem(null)
      setLines([])
      file.current = null
      setDraft((current) => ({ ...blankRenewalDraft(today, locale), successorId: next?.kind === 'link' ? (renewals.value?.candidates[0]?.id ?? '') : '', assignee: current.assignee }))
      if (next?.kind === 'start' && !people) {
        setPeople(reading())
        listAssignees(api, { type: 'Certificate', id: certificateId })
          .then((list) => setPeople(ready(list.map((person) => ({ id: person.id, name: person.name, me: person.me })))))
          .catch((error) => setPeople(failedRead(problemKey(error))))
      }
    },
    [api, certificateId, locale, people, renewals.value, today],
  )

  // `?act=renew|applied|link` from the register's row verb or the record's ⋯: that dialog once, when the tab is read.
  useEffect(() => {
    if (acted.current || !input.act || !renewals.value) return
    acted.current = true
    open(input.act === 'renew' ? { kind: 'start' } : { kind: input.act })
  }, [input.act, open, renewals.value])

  const run = async (work: () => Promise<void>) => {
    setBusy(true)
    setProblem(null)
    setLines([])
    try {
      await work()
      setDialog(null)
    } catch (error) {
      setProblem(writeProblem(error))
      setLines(issueLines(error))
      if (isApiError(error) && error.kind === 'conflict') void load()
    } finally {
      setBusy(false)
    }
  }

  const certificateWrite = (write: (certificate: { id: string; version: number }) => Promise<Renewals>) =>
    run(async () => {
      const current = renewals.value
      if (!current) return
      setRenewals(ready(await write({ id: current.certificate.id, version: current.certificate.version })))
      onCertificateChanged()
    })

  const reviewWrite = (reviewId: string, write: (review: Review) => Promise<Review>) =>
    run(async () => {
      const review = reviews.value?.find((entry) => entry.id === reviewId)
      if (!review) return
      const next = await write(review)
      setReviews((current) => (current.value ? ready(current.value.map((entry) => (entry.id === next.id ? next : entry))) : current))
    })

  const model: RenewalsModel = { renewals, reviews, people, dialog, draft, busy, problem, lines, selected }
  const actions: RenewalsActions = {
    onRetry: () => void load(),
    onDialog: open,
    onDraft: (patch) => setDraft((current) => ({ ...current, ...patch })),
    onFile: (chosen) => {
      void pickedFile(chosen).then((picked) => {
        file.current = picked
        setDraft((current) => ({ ...current, fileName: picked.name }))
      })
    },
    onStart: () =>
      void certificateWrite((certificate) =>
        startRenewal(api, certificate, { assigneeId: draft.assignee === 'me' ? undefined : draft.assignee === 'nobody' ? null : draft.assignee, language: draft.language }),
      ),
    onApplied: () => void certificateWrite((certificate) => recordApplication(api, certificate, { appliedOn: draft.appliedOn, reference: draft.reference.trim() || null, note: draft.note.trim() || null })),
    onLink: () => void certificateWrite((certificate) => linkSuccessor(api, certificate, draft.successorId)),
    onNotify: () => dialog?.kind === 'notify' && void reviewWrite(dialog.reviewId, (review) => notifyBody(api, review, draft.note.trim() || null)),
    onNotNeeded: () => dialog?.kind === 'notNeeded' && void reviewWrite(dialog.reviewId, (review) => decideNotNeeded(api, review, draft.reason.trim())),
    onAnswer: () =>
      dialog?.kind === 'answer' &&
      void reviewWrite(dialog.reviewId, async (review) => {
        const filed = file.current ? await uploadAnswer(api, review.id, { name: file.current.name, contentType: file.current.contentType, size: file.current.size, bytes: file.current.bytes }) : review
        return recordAnswer(api, filed, { decision: draft.decision, answeredOn: draft.answeredOn, reference: draft.reference.trim() || null, note: draft.note.trim() || null })
      }),
    onSelect: (ids) => setSelected([...ids]),
    onExport: input.onExport,
  }
  return { model, actions, reload: load }
}
