'use client'

import { useRef, useState } from 'react'
import { newIdempotencyKey } from '../api/client'
import { FRESH_DIALOG, type ReportDialogActions, type ReportDialogModel } from './dialog'
import { intakeBodyOf, intakeDirty, intakeFieldProblems, patchIntake, sendRefusalOf, waitOf, type Door, type IntakeBody, type IntakeDraft, type SendRefusal } from './intake'
import { useSafetyPhotos } from './use-photos'

/**
 * The report dialog's state for a door from outside (the public DoC page, the portal): the shared form with its problems
 * after Next, check and send with ONE Idempotency-Key per body (a repeat answers the same report; a changed form gets a new
 * key), a refusal in words (a 429 wait holds Send until it is over), Discard / Stay on a close with typed work, the camera
 * sheet, and the photos after the send (`photosOf` says where they go, or null when this door takes none).
 */
export function useReportDialog(input: {
  door: Exclude<Door, 'office'>
  today: string
  fixedBatch: string | null
  offline?: boolean
  send: (body: IntakeBody, idempotencyKey: string, onChecking: () => void) => Promise<{ number: string; photos: { until: string; max: number } | null }>
  upload: (photo: { blob: Blob; name: string }, keys: { announce: string; complete: string }) => Promise<unknown>
  /** A refusal came back (the host may close its door on `refused.off…`). */
  onRefused?: (refusal: SendRefusal) => void
}) {
  const [dialog, setDialog] = useState<ReportDialogModel | null>(null)
  const [photoWindow, setWindow] = useState<{ until: string; max: number } | null>(null)
  const latest = useRef({ dialog, input })
  latest.current = { dialog, input }
  const writeKey = useRef<{ body: string; key: string } | null>(null)

  const photos = useSafetyPhotos({ number: dialog?.sent?.number ?? null, until: photoWindow?.until ?? null, max: photoWindow?.max, offline: input.offline, upload: (photo, keys) => latest.current.input.upload(photo, keys) })
  const patch = (change: Partial<ReportDialogModel>) => setDialog((current) => (current ? { ...current, ...change } : current))

  const send = () => {
    const { dialog: current, input: now } = latest.current
    if (!current || current.busy || current.refusal?.wait || now.offline) return
    if (Object.keys(intakeFieldProblems(current.draft, now.door, now.today, now.fixedBatch)).length > 0) return patch({ step: 'form', tried: true })
    const body = intakeBodyOf(current.draft, now.door, now.fixedBatch)
    const text = JSON.stringify(body)
    if (writeKey.current?.body !== text) writeKey.current = { body: text, key: newIdempotencyKey() }
    patch({ busy: true, checking: false, refusal: null, refusedFields: {} })
    now
      .send(body, writeKey.current.key, () => patch({ checking: true }))
      .then((answer) => {
        writeKey.current = null
        setWindow(answer.photos)
        photos.reset()
        patch({ busy: false, checking: false, sent: { number: answer.number } })
      })
      .catch((error: unknown) => {
        const refusal = sendRefusalOf(error, current.draft, now.door)
        now.onRefused?.(refusal)
        const wait = refusal.waitSeconds ? waitOf(refusal.waitSeconds) : null
        const fields = Object.keys(refusal.fields).length > 0
        patch({ busy: false, checking: false, refusal: { key: refusal.key, wait }, refusedFields: refusal.fields, ...(fields ? { step: 'form' as const, tried: true } : {}) })
        if (wait) setTimeout(() => setDialog((next) => (next?.refusal?.wait ? { ...next, refusal: null } : next)), (refusal.waitSeconds ?? 60) * 1000)
      })
  }

  const actions: ReportDialogActions = {
    onDraft: (change: Partial<IntakeDraft>) => setDialog((current) => (current && !current.busy ? { ...current, discard: false, draft: patchIntake(current.draft, change), refusedFields: {}, refusal: current.refusal?.wait ? current.refusal : null } : current)),
    onNext: () =>
      setDialog((current) => {
        if (!current || current.busy) return current
        const { door, today, fixedBatch } = latest.current.input
        return Object.keys(intakeFieldProblems(current.draft, door, today, fixedBatch)).length > 0 ? { ...current, tried: true } : { ...current, step: 'review', tried: false }
      }),
    onBack: () => patch({ step: 'form' }),
    onSend: send,
    onClose: () =>
      setDialog((current) => {
        if (!current || current.busy) return current
        if (!current.sent && intakeDirty(current.draft)) return { ...current, discard: true }
        return null
      }),
    onDiscard: () => setDialog(null),
    onStay: () => patch({ discard: false }),
    onScan: (open: boolean) => patch({ scanning: open }),
    onScanned: (code: string) => setDialog((current) => (current ? { ...current, scanning: false, draft: patchIntake(current.draft, { serial: code }) } : current)),
    photos: photos.actions,
  }

  return {
    /** The dialog as drawn (its photos only after the send, and only where the door takes them). */
    model: dialog ? { ...dialog, photos: dialog.sent && photoWindow ? photos.model : null } : null,
    actions,
    open: () => {
      writeKey.current = null
      setWindow(null)
      photos.reset()
      setDialog(FRESH_DIALOG)
    },
    /** Typed work not sent yet (the portal's unsaved guard). */
    dirty: dialog !== null && !dialog.sent && intakeDirty(dialog.draft),
  }
}
