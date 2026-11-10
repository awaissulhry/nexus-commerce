'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { browserApi } from '../../../../../lib/api/browser'
import { newIdempotencyKey } from '../../../../../lib/api/client'
import { useOfficeSession } from '../../../../../lib/session/context'
import type { OfficeSession } from '../../../../../lib/session/session'
import { failedRead, problemKey, ready, reading, type Notice, type Read } from '../../../../quality/_shared/model'
import { writeProblemKey } from '../../declarations/model'
import { editProfile, evaluateMaterials, getProfile, readEvaluation, type MaterialEvaluation, type ProfileRecord } from '../api'
import { profileChanges, profilesCan, type ProfileDraft } from '../model'
import { ProfileCardView } from './view/ProfileCardView'

/** The office session, or null outside the office (the design index renders the material's tab without one). */
function useOptionalSession(): OfficeSession | null {
  try {
    return useOfficeSession()
  } catch {
    return null
  }
}

/**
 * The material's compliance profile as the material record's Compliance tab mounts it (B-W2b-267; one import and one line in
 * products/materials/record/view/ComplianceTab.tsx): reads GET /compliance/material-profiles/:itemId and the evaluator's
 * verdicts (GET /compliance/substances/materials/:id/evaluation), saves the confirmations, origin and note in ONE PATCH at the
 * version read (the evaluator runs in it), and asks the evaluator again. Without compliance.certificates.view, or outside the
 * office (the design index), it draws nothing.
 */
export function MaterialProfileCard({ itemId, prefix }: { itemId: string; prefix: string }) {
  const session = useOptionalSession()
  const company = session?.company?.code ?? null
  const api = useMemo(() => (session ? browserApi({ company }) : null), [session, company])
  const can = useMemo(() => profilesCan(session?.permissions ?? []), [session])
  const [profile, setProfile] = useState<Read<ProfileRecord>>(reading())
  const [evaluation, setEvaluation] = useState<Read<MaterialEvaluation>>(reading())
  const [draft, setDraft] = useState<ProfileDraft | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [online, setOnline] = useState(true)

  useEffect(() => {
    const update = () => setOnline(typeof navigator === 'undefined' || navigator.onLine !== false)
    update()
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])

  const load = useCallback(() => {
    if (!api || !can.view) return
    getProfile(api, itemId).then(
      (answer) => setProfile(ready(answer.profile)),
      (error: unknown) => setProfile(failedRead(problemKey(error))),
    )
    readEvaluation(api, itemId).then(
      (answer) => setEvaluation(ready(answer)),
      (error: unknown) => setEvaluation(failedRead(problemKey(error))),
    )
  }, [api, can.view, itemId])
  useEffect(load, [load])
  // Opened from Material profiles (`#material-profile`): the card is drawn after its read, so the browser's own jump came too early.
  const shown = profile.value !== null
  useEffect(() => {
    if (shown && typeof window !== 'undefined' && window.location.hash === '#material-profile') document.getElementById('material-profile')?.scrollIntoView({ block: 'start' })
  }, [shown])

  if (!session || !api || !can.view) return null

  const save = async () => {
    const current = profile.value
    if (!current || !draft || busy) return
    const changes = profileChanges(current, draft)
    if (Object.keys(changes).length === 0) return
    setBusy(true)
    try {
      const answer = await editProfile(api, itemId, current.version, changes, newIdempotencyKey())
      setProfile(ready(answer.profile))
      setDraft(null)
      setNotice({ key: `done.profileSaved.${answer.profile.state ?? 'NONE'}`, tone: 'success' })
      readEvaluation(api, itemId).then((value) => setEvaluation(ready(value)), () => undefined)
    } catch (error) {
      setNotice({ key: writeProblemKey('profile', error), tone: 'danger' })
      load()
    } finally {
      setBusy(false)
    }
  }
  const evaluate = async () => {
    if (busy) return
    setBusy(true)
    try {
      const answer = await evaluateMaterials(api, [itemId], newIdempotencyKey())
      const one = answer.profiles[0]
      setNotice({ key: `${one?.changed ? 'done.evaluatedChanged' : 'done.evaluatedSame'}.${one?.state ?? 'NONE'}`, tone: 'success' })
      load()
    } catch (error) {
      setNotice({ key: writeProblemKey('evaluate', error), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <ProfileCardView
      model={{ prefix, itemId, can, online, profile, evaluation, draft, busy, notice }}
      actions={{ onRetry: load, onEdit: setDraft, onSave: () => void save(), onEvaluate: () => void evaluate(), onDismissNotice: () => setNotice(null) }}
    />
  )
}
