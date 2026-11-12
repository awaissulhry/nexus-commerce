'use client'

import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { isApiError } from '../../../../lib/api/errors'
import { useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { putToStore, readFromStore, sha256Hex } from '../../../../record-panels/store'
import { usePortalApi, usePortalBand, usePortalFrame, usePortalLive, usePortalUnsaved } from '../../../shell/frame'
import { useOffline } from '../hooks'
import { NS as RETURNS_NS, photoProblem, photosLeft, refusalKey, sendPhotosHeld, type PickedPhoto } from '../model'
import { Closed, readsReturns } from '../ReturnsPage'
import { useReturnWords } from '../words'
import { announceRepairPhoto, answerEstimate, completeRepairPhoto, fetchRepair, openRepairPhoto, type RepairRecord } from './api'
import { repairBandOf } from './band'
import { answerHeldKey, declineProblem, NS, photosHeldKey, repairRefusalKey, repairTabOf } from './model'
import { RepairRecordView, type RepairDialog, type RepairRecordViewModel } from './RepairRecordView'

/**
 * `/p/<party>/returns/repairs/<id>?tab=status|request` — a customer's repair (B-W2b-342; SCR-358): reads it (GET
 * /portal/repairs/:id), fills the band, runs the pop-ups — Accept (POST …/estimate/answer ACCEPTED with the estimate's
 * version), Decline (the same with the customer's words), Add photos (each announced, its bytes PUT to the store,
 * confirmed), a photo full size (ONE logged open) — and reads again on the live channel's hints.
 */
export function CustomerRepairPage({ id }: { id: string }) {
  return (
    <WithMessages namespaces={[NS, RETURNS_NS, 'ds-words', 'lists']}>
      <Suspense fallback={null}>
        <RepairRoute id={id} />
      </Suspense>
    </WithMessages>
  )
}

function RepairRoute({ id }: { id: string }) {
  const frame = usePortalFrame()
  const { t } = useReturnWords()
  return readsReturns(frame) ? <RepairContainer id={id} /> : <Closed title={t('list.title')} />
}

type PhotosState = { picked: PickedPhoto[]; busy: boolean; done: number | null }
type DialogState = Exclude<RepairDialog, { kind: 'photos' } | { kind: 'photo' }> | ({ kind: 'photos' } & PhotosState) | { kind: 'photo'; index: number; state: 'loading' | 'error' | 'ready'; src: string | null } | null

function RepairContainer({ id }: { id: string }) {
  const frame = usePortalFrame()
  const api = usePortalApi()
  const search = useSearchParams()
  const r = useT(NS)
  const { t } = useReturnWords()
  const offline = useOffline()
  const tab = repairTabOf(search?.get('tab'))
  const [read, setRead] = useState<RepairRecord | null>(null)
  const [state, setState] = useState<RepairRecordViewModel['state'] | 'forbidden'>('loading')
  const [loadedAt, setLoadedAt] = useState<string | null>(null)
  const [notice, setNotice] = useState<RepairRecordViewModel['notice']>(null)
  const [dialog, setDialog] = useState<DialogState>(null)
  const files = useRef(new Map<string, File>())
  const answerKey = useRef<{ body: string; key: string } | null>(null)

  const load = useCallback(async () => {
    try {
      setRead(await fetchRepair(api, id))
      setLoadedAt(new Date().toISOString())
      setState('ready')
    } catch (error) {
      if (isApiError(error) && error.kind === 'not_found') setState('missing')
      else if (isApiError(error) && error.kind === 'forbidden') setState('forbidden')
      else setState('error')
    }
  }, [api, id])

  useEffect(() => {
    void load()
  }, [load])

  usePortalLive({
    onChange: (change) => {
      if (change.type === 'partner_notification.created' || change.type.startsWith('partner_task.')) void load()
    },
    onReconnect: () => void load(),
  })

  const repair = read?.repair ?? null
  const busy = (dialog?.kind === 'accept' || dialog?.kind === 'decline') && dialog.busy
  const photosHeld = repair ? photosHeldKey(repair.actions.addPhotos, offline) : null
  const answerHeld = repair ? answerHeldKey(repair.actions.answer, offline, busy) : null
  const fileHeld = frame.me.preview ? r('portal.held.photos.PREVIEW') : offline ? r('portal.held.offline') : null

  const photosDirty = dialog?.kind === 'photos' && dialog.picked.some((photo) => photo.state === 'waiting' && !photo.problem)
  const declineDirty = dialog?.kind === 'decline' && dialog.reason.trim() !== ''
  usePortalUnsaved(`repair:${id}`, { dirty: photosDirty || declineDirty, what: r('portal.unsaved') })

  // ── Add photos ───────────────────────────────────────────────────────────────────────────────────────────────────
  const openPhotos = () => {
    if (photosHeld) return
    files.current.clear()
    setDialog({ kind: 'photos', picked: [], busy: false, done: null })
  }
  const pick = (picked: File[]) =>
    setDialog((now) => {
      if (now?.kind !== 'photos') return now
      let left = photosLeft(repair?.photos.length ?? 0, now.picked)
      const added = picked.map((file) => {
        const photoId = newIdempotencyKey()
        files.current.set(photoId, file)
        const problem = photoProblem(file) ?? (left <= 0 ? 'photos.problem.full' : null)
        if (!problem) left -= 1
        return { id: photoId, name: file.name, type: file.type, size: file.size, state: 'waiting' as const, problem }
      })
      return { ...now, picked: [...now.picked, ...added], done: null }
    })
  const sendPhotos = async () => {
    if (dialog?.kind !== 'photos' || !repair || dialog.busy) return
    if (sendPhotosHeld(dialog.picked, null, dialog.busy)) return
    const queue = dialog.picked.filter((photo) => photo.state === 'waiting' && !photo.problem)
    setDialog({ ...dialog, busy: true })
    const mark = (photoId: string, patch: Partial<PickedPhoto>) => setDialog((now) => (now?.kind === 'photos' ? { ...now, picked: now.picked.map((photo) => (photo.id === photoId ? { ...photo, ...patch } : photo)) } : now))
    let sent = 0
    for (const photo of queue) {
      const file = files.current.get(photo.id)
      if (!file) continue
      mark(photo.id, { state: 'sending' })
      try {
        const bytes = await file.arrayBuffer()
        const answer = await announceRepairPhoto(api, repair.id, { originalName: file.name, contentType: file.type === 'image/jpg' ? 'image/jpeg' : file.type, sizeBytes: file.size, sha256: await sha256Hex(bytes) }, newIdempotencyKey())
        await putToStore(answer.upload, bytes)
        await completeRepairPhoto(api, repair.id, answer.file.id, newIdempotencyKey())
        mark(photo.id, { state: 'sent', problem: null })
        files.current.delete(photo.id)
        sent += 1
      } catch (error) {
        mark(photo.id, { state: 'failed', problem: refusalKey(error) === 'problem.internal' ? 'photos.problem.failed' : refusalKey(error) })
      }
    }
    setDialog((now) => (now?.kind === 'photos' ? { ...now, busy: false, done: sent } : now))
    void load()
  }

  // ── a photo full size ──────────────────────────────────────────────────────────────────────────────────────────────
  const shown = useRef<string | null>(null)
  const forget = () => {
    if (shown.current) URL.revokeObjectURL(shown.current)
    shown.current = null
  }
  useEffect(() => forget, [])
  const showPhoto = useCallback(
    (index: number) => {
      const photo = read?.repair.photos[index]
      if (!photo) return
      forget()
      setDialog({ kind: 'photo', index, state: 'loading', src: null })
      openRepairPhoto(api, photo.id)
        .then((opened) => readFromStore({ method: 'GET', url: opened.download.url, headers: opened.download.headers, expiresAt: opened.download.expiresAt }).then((bytes) => ({ bytes, type: opened.file.contentType })))
        .then(({ bytes, type }) => {
          const src = URL.createObjectURL(new Blob([bytes as BlobPart], { type }))
          shown.current = src
          setDialog((now) => (now?.kind === 'photo' && now.index === index ? { ...now, state: 'ready', src } : now))
        })
        .catch(() => setDialog((now) => (now?.kind === 'photo' && now.index === index ? { ...now, state: 'error' } : now)))
    },
    [api, read],
  )

  // ── the answer ───────────────────────────────────────────────────────────────────────────────────────────────────
  const answer = (kind: 'ACCEPTED' | 'DECLINED', reason: string | null) => {
    if (!repair?.estimate || answerHeld) return
    const body = { estimateId: repair.estimate.id, version: repair.estimate.version, answer: kind, declineReason: reason }
    const json = JSON.stringify(body)
    if (!answerKey.current || answerKey.current.body !== json) answerKey.current = { body: json, key: newIdempotencyKey() }
    setDialog((now) => (now && (now.kind === 'accept' || now.kind === 'decline') ? { ...now, busy: true, problem: null } : now))
    answerEstimate(api, repair.id, body, answerKey.current.key)
      .then((next) => {
        answerKey.current = null
        setRead(next)
        setDialog(null)
        setNotice({ tone: kind === 'ACCEPTED' ? 'success' : 'info', key: kind === 'ACCEPTED' ? 'portal.notice.accepted' : 'portal.notice.declined', params: { number: next.repair.number } })
        frame.refreshTasks()
      })
      .catch((error: unknown) => {
        const key = repairRefusalKey(error)
        if (!isApiError(error) || error.kind !== 'unavailable') answerKey.current = null
        setDialog((now) => (now && (now.kind === 'accept' || now.kind === 'decline') ? { ...now, busy: false, problem: key } : now))
        void load()
      })
  }

  // ── the band ───────────────────────────────────────────────────────────────────────────────────────────────────────
  const listTitle = t('list.title')
  usePortalBand(state === 'ready' && repair ? repairBandOf({ t: r, listTitle, repair, tab, prefix: frame.prefix, photosHeld, onPhotos: openPhotos }) : { title: state === 'missing' ? r('portal.record.missing') : listTitle, back: { href: `${frame.prefix}/returns`, label: listTitle } })

  if (state === 'forbidden') return <Closed title={listTitle} />

  const viewDialog: RepairDialog | null = !repair || !dialog
    ? null
    : dialog.kind === 'photos'
      ? { kind: 'photos', model: { number: repair.number, targets: [{ id: null, label: r('portal.request.photos'), count: repair.photos.length }], target: null, picked: dialog.picked, left: photosLeft(repair.photos.length, dialog.picked), held: sendPhotosHeld(dialog.picked, null, dialog.busy), busy: dialog.busy, done: dialog.done } }
      : dialog.kind === 'photo'
        ? { kind: 'photo', model: { photos: repair.photos.map((photo) => ({ id: photo.id, name: photo.name })), index: dialog.index, state: dialog.state, src: dialog.src } }
        : dialog

  return (
    <RepairRecordView
      model={{ state, repair, tab, prefix: frame.prefix, offlineSince: offline ? loadedAt : null, seesPrices: read?.seesPrices ?? false, notice, photosHeld, answerHeld, fileHeld, dialog: viewDialog }}
      actions={{
        onRetry: () => {
          setState('loading')
          void load()
        },
        onPhotos: openPhotos,
        onPhoto: showPhoto,
        onAccept: () => !answerHeld && setDialog({ kind: 'accept', busy: false, problem: null }),
        onDecline: () => !answerHeld && setDialog({ kind: 'decline', busy: false, problem: null, reason: '', tried: false }),
        onDismissNotice: () => setNotice(null),
        dialog: {
          accept: { onConfirm: () => answer('ACCEPTED', null), onClose: () => setDialog((now) => (now?.kind === 'accept' && now.busy ? now : null)) },
          decline: {
            onReason: (reason) => setDialog((now) => (now?.kind === 'decline' ? { ...now, reason, problem: null } : now)),
            onConfirm: () => {
              if (dialog?.kind !== 'decline') return
              if (declineProblem(dialog.reason)) {
                setDialog({ ...dialog, tried: true })
                return
              }
              answer('DECLINED', dialog.reason.trim())
            },
            onClose: () => setDialog((now) => (now?.kind === 'decline' && now.busy ? now : null)),
          },
          photos: {
            onFiles: pick,
            onRemove: (photoId) => {
              files.current.delete(photoId)
              setDialog((now) => (now?.kind === 'photos' ? { ...now, picked: now.picked.filter((photo) => photo.id !== photoId) } : now))
            },
            onSend: () => void sendPhotos(),
            onClose: () => setDialog((now) => (now?.kind === 'photos' && now.busy ? now : null)),
          },
          photo: {
            onIndex: (index) => showPhoto(index),
            onClose: () => {
              forget()
              setDialog(null)
            },
            onRetry: () => (dialog?.kind === 'photo' ? showPhoto(dialog.index) : undefined),
          },
        },
      }}
    />
  )
}
