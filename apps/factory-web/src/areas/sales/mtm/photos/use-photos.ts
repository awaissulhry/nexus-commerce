'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { businessDate } from '@nexus/factory-domain/core/time'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'
import { useLiveChanges } from '../../../../record-panels/live'
import { storeUrl } from '../../../../record-panels/store'
import { readProblem, type MtmCan, type Notice } from '../model'
import { datePhoto, openPhoto, readPhotos, uploadPhoto, type PhotosView, type PhotoTarget, type PhotoView } from './api'
import { dateHeld, dateProblem, fileProblem, uploadDateHeld, uploadHeld, uploadProblem, type MtmPhotoView } from './model'

/**
 * The rider profile's office and fitting photos (B-W2b-371, XF2:01): read when the Photos or the Fittings tab is on screen and again
 * on a measurement_photo.* event of the rider's customer (and after an opening, which makes the photo's stripped copy); one dialog at a time — Add a photo (the view, the file, its delete date
 * when known), Change the delete date (with why; "Delete today" = within the hour), a photo opened in the Lightbox (its stripped
 * copy). Each write is ONE call with its own Idempotency-Key, kept across a retry of the same attempt.
 */

export type PhotoDialog =
  | { readonly kind: 'upload'; readonly target: PhotoTarget; readonly view: MtmPhotoView; readonly file: File | null; readonly deleteOn: string; readonly busy: boolean; readonly notice: Notice | null }
  | { readonly kind: 'date'; readonly target: PhotoTarget; readonly photo: PhotoView; readonly day: string; readonly reason: string; readonly busy: boolean; readonly notice: Notice | null }
  | { readonly kind: 'open'; readonly photo: PhotoView; readonly src: string | null; readonly problem: string | null }

export interface OfficePhotosModel {
  readonly photos: PhotosView | null
  readonly problem: string | null
  readonly dialog: PhotoDialog | null
  readonly notice: Notice | null
  readonly today: string
  readonly can: MtmCan
  readonly offline: boolean
}

export interface OfficePhotosActions {
  onRetry?: () => void
  onUpload?: (target: PhotoTarget) => void
  onDate?: (target: PhotoTarget, photo: PhotoView) => void
  onOpen?: (photo: PhotoView) => void
  onDraft?: (patch: Partial<{ view: MtmPhotoView; file: File | null; deleteOn: string; day: string; reason: string }>) => void
  onSave?: () => void
  onClose?: () => void
  onDismiss?: () => void
}

export function useOfficePhotos(input: { readonly api: ApiClient; readonly profileId: string | null; readonly partyId: string | null; readonly shown: boolean; readonly can: MtmCan; readonly offline: boolean; readonly today: string }) {
  const { api, profileId, partyId, shown, can, offline, today } = input
  const [photos, setPhotos] = useState<PhotosView | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [dialog, setDialog] = useState<PhotoDialog | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const dialogRef = useRef<PhotoDialog | null>(null)
  dialogRef.current = dialog
  const key = useRef<string | null>(null)

  const load = useCallback(async () => {
    if (!profileId || !can.view) return
    try {
      const fresh = await readPhotos(api, profileId)
      setPhotos(fresh)
      setProblem(null)
      // A date being typed keeps its words and takes the photo as it is now (its version moves when its stripped copy is made).
      const now = (id: string) => [...fresh.revisions.flatMap((revision) => revision.photos), ...fresh.fittings.flatMap((fitting) => fitting.photos)].find((photo) => photo.id === id)
      setDialog((open) => (open?.kind === 'date' ? { ...open, photo: now(open.photo.id) ?? open.photo } : open))
    } catch (error) {
      setProblem(readProblem(error))
    }
  }, [api, profileId, can.view])

  useEffect(() => {
    if (shown) void load()
  }, [shown, load])

  useLiveChanges({
    onChange: (change) => {
      if (!shown || !change.type.startsWith('measurement_photo.')) return
      if ((change.fields as { partyId?: unknown }).partyId === partyId) void load()
    },
  })

  const patch = useCallback((next: Partial<PhotoDialog>) => setDialog((open) => (open ? ({ ...open, ...next } as PhotoDialog) : open)), [])

  const save = useCallback(async () => {
    const open = dialogRef.current
    if (!open || open.kind === 'open' || open.busy) return
    if (open.kind === 'upload') {
      if (uploadHeld(photos, open.target.kind, can, offline) || fileProblem(open.file) || uploadDateHeld(open.deleteOn, today)) return
      patch({ busy: true, notice: null })
      try {
        key.current ??= newIdempotencyKey()
        await uploadPhoto(api, open.target, open.file!, { view: open.view, deleteOn: open.deleteOn || null }, key.current)
        key.current = null
        setDialog(null)
        setNotice({ key: 'photo.upload.done', tone: 'success' })
        void load()
      } catch (error) {
        patch({ busy: false, notice: { ...uploadProblem(error), tone: 'danger' } })
      }
      return
    }
    const may = open.target.kind === 'profile' ? !!photos?.may.date : !!photos?.may.dateFitting
    if (dateHeld(open, open.photo, today, may, offline)) return
    patch({ busy: true, notice: null })
    try {
      key.current ??= newIdempotencyKey()
      await datePhoto(api, open.target, open.photo, { version: open.photo.version, deleteOn: open.day, reason: open.reason.trim() }, key.current)
      key.current = null
      setDialog(null)
      setNotice({ key: open.day <= today ? 'photo.date.doneToday' : 'photo.date.done', params: { date: open.day }, tone: 'success' })
      void load()
    } catch (error) {
      const said = dateProblem(error)
      patch({ busy: false, notice: { ...said, tone: 'danger' } })
      if (said.key === 'photo.date.problem.stale' || said.key === 'photo.date.problem.deleted') {
        key.current = null
        void load()
      }
    }
  }, [api, can, offline, photos, today, load, patch])

  const model: OfficePhotosModel = { photos, problem, dialog, notice, today, can, offline }
  const actions: OfficePhotosActions = {
    onRetry: () => void load(),
    onUpload: (target) => {
      key.current = null
      setDialog({ kind: 'upload', target, view: 'FRONT', file: null, deleteOn: '', busy: false, notice: null })
    },
    onDate: (target, photo) => {
      key.current = null
      setDialog({ kind: 'date', target, photo, day: photo.deleteAfter ? businessDate(new Date(photo.deleteAfter)) : today, reason: '', busy: false, notice: null })
    },
    onOpen: (photo) => {
      setDialog({ kind: 'open', photo, src: null, problem: null })
      openPhoto(api, photo.id)
        .then((answer) => {
          setDialog((open) => (open?.kind === 'open' && open.photo.id === photo.id ? { ...open, src: storeUrl(answer.download.url) } : open))
          // The first opening makes the stripped copy (the photo's version moves): read the photos again.
          void load()
        })
        .catch((error: unknown) => setDialog((open) => (open?.kind === 'open' ? { ...open, problem: readProblem(error) } : open)))
    },
    onDraft: (next) => patch(next as Partial<PhotoDialog>),
    onSave: () => void save(),
    onClose: () => setDialog(null),
    onDismiss: () => setNotice(null),
  }
  return { model, actions }
}
