'use client'

import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useNarrow } from '@nexus/ui/components'
import { newIdempotencyKey } from '../../../lib/api/client'
import { isApiError } from '../../../lib/api/errors'
import { WithMessages } from '../../../record-panels/i18n'
import { putToStore, readFromStore, sha256Hex } from '../../../record-panels/store'
import { usePortalApi, usePortalBand, usePortalFrame, usePortalLive, usePortalUnsaved } from '../../shell/frame'
import { PortalThread } from '../../shell/thread/PortalThread'
import { announcePhoto, cancelReturn, completePhoto, fetchComplaint, fetchReturn, instructionsHref, openCaseFile, openCreditNote, type CaseFile, type CaseType } from './api'
import { complaintBandOf, returnBandOf } from './band'
import { openLater, useOffline } from './hooks'
import { cancelHeld, NS, photoProblem, photosHeld, photosLeft, refusalKey, sendPhotosHeld, tabOf, threadTypeOf, type PickedPhoto } from './model'
import { Closed, readsReturns } from './ReturnsPage'
import { CaseRecordView, type CaseDialog, type CaseRecord, type CaseRecordViewModel } from './view/CaseRecordView'
import type { PhotoTarget } from './view/Dialogs'
import { useReturnWords } from './words'

/**
 * `/p/<party>/returns/<id>?tab=request|status|messages` (a return) and `/p/<party>/returns/complaints/<id>?tab=…` (a
 * complaint) for a customer (B-W2b-197; design portal.customer.returns rec "Return"): reads the case (GET
 * /portal/returns/:id or /portal/complaints/:id), fills the band, runs the pop-ups — Cancel this request? (POST …/cancel
 * with the version read), Add photos (each photo announced, its bytes PUT to the store, confirmed), a photo full size and a
 * document or credit note in a new tab (each ONE logged open) — reads again on the live channel's hints, and draws the
 * case's Messages (its thread, B-W2b-197's partner views).
 */
export function CustomerCasePage({ type, id }: { type: CaseType; id: string }) {
  return (
    <WithMessages namespaces={[NS, 'ds-words', 'lists']}>
      <Suspense fallback={null}>
        <CaseRoute type={type} id={id} />
      </Suspense>
    </WithMessages>
  )
}

function CaseRoute({ type, id }: { type: CaseType; id: string }) {
  const frame = usePortalFrame()
  const { t } = useReturnWords()
  return readsReturns(frame) ? <CaseContainer type={type} id={id} /> : <Closed title={t('list.title')} />
}

type PhotosState = { target: string | null; picked: PickedPhoto[]; busy: boolean; done: number | null }
type DialogState = { kind: 'cancel'; busy: boolean; problem: string | null } | ({ kind: 'photos' } & PhotosState) | { kind: 'photo'; photos: readonly CaseFile[]; index: number; state: 'loading' | 'error' | 'ready'; src: string | null } | null

function CaseContainer({ type, id }: { type: CaseType; id: string }) {
  const frame = usePortalFrame()
  const api = usePortalApi()
  const search = useSearchParams()
  const words = useReturnWords()
  const { t, locale } = words
  const offline = useOffline()
  const narrow = useNarrow()
  const tab = tabOf(search?.get('tab'))
  const can = (permission: string) => frame.me.permissions.includes(permission)
  const mayUpload = can('portal.upload') || (frame.access ? frame.access.capabilities.includes('portal.upload') : false)
  const who = { preview: frame.me.preview, mayRequest: can('portal.returns.request'), offline }

  const [current, setCurrent] = useState<CaseRecord | null>(null)
  const [state, setState] = useState<CaseRecordViewModel['state'] | 'forbidden'>('loading')
  const [loadedAt, setLoadedAt] = useState<string | null>(null)
  const [notice, setNotice] = useState<CaseRecordViewModel['notice']>(null)
  const [dialog, setDialog] = useState<DialogState>(null)
  const files = useRef(new Map<string, File>())
  const cancelKey = useRef<string | null>(null)

  const load = useCallback(async () => {
    try {
      const next: CaseRecord = type === 'RETURN' ? { type, record: await fetchReturn(api, id) } : { type, record: await fetchComplaint(api, id) }
      setCurrent(next)
      setLoadedAt(new Date().toISOString())
      setState('ready')
    } catch (error) {
      if (isApiError(error) && error.kind === 'not_found') setState('missing')
      else if (isApiError(error) && error.kind === 'forbidden') setState('forbidden')
      else setState('error')
    }
  }, [api, type, id])

  useEffect(() => {
    void load()
  }, [load])

  // A hint on the live channel (the bell's news of a decision, a parcel, an answer; a question from us): read again.
  usePortalLive({
    onChange: (change) => {
      if (change.type === 'partner_notification.created' || change.type.startsWith('partner_task.')) void load()
    },
    onReconnect: () => void load(),
  })

  // ── what may be done now (OUR words, by code) ─────────────────────────────────────────────────────────────────────
  const record = current?.record ?? null
  const photosHeldKey = current ? photosHeld(current.type, current.record, { ...who, mayUpload }) : null
  const cancelHeldKey = current?.type === 'RETURN' ? cancelHeld(current.record, { ...who, busy: dialog?.kind === 'cancel' && dialog.busy }) : null
  const fileHeld = frame.me.preview ? t('held.previewFiles') : offline ? t('held.offline') : null
  const creditHeld = !can('portal.customerDocuments.view') ? t('held.noDocuments') : null
  const labelHref = current?.type === 'RETURN' && current.record.progress.instructions ? instructionsHref(current.record.id, locale) : null

  // ── Add photos ─────────────────────────────────────────────────────────────────────────────────────────────────────
  const targets: PhotoTarget[] = !current
    ? []
    : current.type === 'RETURN'
      ? [
          { id: null, label: t('photos.ofRequest'), count: current.record.request.photos.length },
          ...current.record.request.lines.map((line) => ({ id: line.id, label: t('request.line', { seq: line.seq, description: line.description }), count: line.photos.length })),
        ]
      : [{ id: null, label: t('photos.ofComplaint'), count: current.record.request.photos.length }]
  const photosDirty = dialog?.kind === 'photos' && dialog.picked.some((photo) => photo.state === 'waiting' && !photo.problem)
  usePortalUnsaved(`returns-photos:${id}`, { dirty: photosDirty, what: t('unsaved.photos') })

  const openPhotos = (lineId: string | null) => {
    if (photosHeldKey) return
    files.current.clear()
    setDialog({ kind: 'photos', target: lineId, picked: [], busy: false, done: null })
  }

  const pick = (picked: File[]) =>
    setDialog((now) => {
      if (now?.kind !== 'photos') return now
      const target = targets.find((entry) => entry.id === now.target)
      let left = photosLeft(target?.count ?? 0, now.picked)
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
    if (dialog?.kind !== 'photos' || !current || dialog.busy) return
    if (sendPhotosHeld(dialog.picked, photosHeldKey, dialog.busy)) return
    const target = dialog.target
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
        const body = { originalName: file.name, contentType: file.type === 'image/jpg' ? 'image/jpeg' : file.type, sizeBytes: file.size, sha256: await sha256Hex(bytes), lineId: target }
        const answer = await announcePhoto(api, current.type, current.record.id, body, newIdempotencyKey())
        await putToStore(answer.upload, bytes)
        await completePhoto(api, current.type, current.record.id, answer.file.id, newIdempotencyKey())
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

  // ── a photo full size, a document or a credit note in a new tab ─────────────────────────────────────────────────────
  const shown = useRef<string | null>(null)
  const forget = () => {
    if (shown.current) URL.revokeObjectURL(shown.current)
    shown.current = null
  }
  useEffect(() => forget, [])
  const showPhoto = useCallback(
    (photos: readonly CaseFile[], index: number) => {
      const photo = photos[index]
      if (!photo) return
      forget()
      setDialog({ kind: 'photo', photos, index, state: 'loading', src: null })
      openCaseFile(api, photo.id, 'preview')
        .then((opened) => readFromStore({ method: 'GET', url: opened.download.url, headers: opened.download.headers, expiresAt: opened.download.expiresAt }).then((bytes) => ({ bytes, type: opened.file.contentType })))
        .then(({ bytes, type: contentType }) => {
          const src = URL.createObjectURL(new Blob([bytes as BlobPart], { type: contentType }))
          shown.current = src
          setDialog((now) => (now?.kind === 'photo' && now.photos[now.index]?.id === photo.id ? { ...now, state: 'ready', src } : now))
        })
        .catch(() => setDialog((now) => (now?.kind === 'photo' && now.photos[now.index]?.id === photo.id ? { ...now, state: 'error' } : now)))
    },
    [api],
  )

  const inNewTab = async (read: () => Promise<{ bytes: Uint8Array; type: string }>, failKey: string) => {
    const tabNow = openLater()
    try {
      const { bytes, type: contentType } = await read()
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: contentType }))
      tabNow.go(url)
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
    } catch (error) {
      tabNow.fail()
      setNotice({ tone: 'danger', key: isApiError(error) && error.kind === 'forbidden' ? 'problem.documentForbidden' : failKey })
    }
  }

  const openDocument = (file: CaseFile) =>
    void inNewTab(async () => {
      const opened = await openCaseFile(api, file.id, 'preview')
      return { bytes: await readFromStore({ method: 'GET', url: opened.download.url, headers: opened.download.headers, expiresAt: opened.download.expiresAt }), type: opened.file.contentType }
    }, 'problem.documentFailed')

  const openCredit = (noteId: string) => {
    if (current?.type !== 'RETURN') return
    const note = current.record.progress.creditNotes.find((entry) => entry.id === noteId)
    if (!note?.pdfFileId) return
    const fileId = note.pdfFileId
    void inNewTab(async () => {
      const link = await openCreditNote(api, fileId)
      return { bytes: await readFromStore({ method: 'GET', url: link.url, headers: link.headers, expiresAt: link.expiresAt }), type: 'application/pdf' }
    }, 'problem.documentFailed')
  }

  // ── Cancel this request? ───────────────────────────────────────────────────────────────────────────────────────────
  const openCancel = () => {
    if (cancelHeldKey) return
    cancelKey.current = newIdempotencyKey()
    setDialog({ kind: 'cancel', busy: false, problem: null })
  }
  const confirmCancel = () => {
    if (dialog?.kind !== 'cancel' || dialog.busy || current?.type !== 'RETURN') return
    setDialog({ ...dialog, busy: true, problem: null })
    cancelReturn(api, current.record.id, { version: current.record.version }, cancelKey.current ?? newIdempotencyKey())
      .then((next) => {
        setCurrent({ type: 'RETURN', record: next })
        setDialog(null)
        setNotice({ tone: 'success', key: 'notice.cancelled', params: { number: next.number } })
        frame.refreshTasks()
      })
      .catch((error: unknown) => {
        setDialog((now) => (now?.kind === 'cancel' ? { ...now, busy: false, problem: refusalKey(error) } : now))
        void load()
      })
  }

  // ── the band ───────────────────────────────────────────────────────────────────────────────────────────────────────
  const listTitle = t('list.title')
  usePortalBand(
    state === 'ready' && current
      ? current.type === 'RETURN'
        ? returnBandOf({
            words,
            record: current.record,
            tab,
            prefix: frame.prefix,
            narrow,
            facts: { photosHeld: photosHeldKey, cancelHeld: cancelHeldKey, labelHref, creditNotes: current.record.progress.creditNotes.filter((note) => note.pdfFileId).map((note) => ({ id: note.id, label: note.number ?? '—' })) },
            onPhotos: () => openPhotos(null),
            onCancel: openCancel,
            onCreditNote: openCredit,
          })
        : complaintBandOf({ words, record: current.record, tab, prefix: frame.prefix, photosHeld: photosHeldKey, narrow, onPhotos: () => openPhotos(null) })
      : { title: state === 'missing' ? t('record.missing') : listTitle, back: { href: `${frame.prefix}/returns`, label: listTitle } },
  )

  if (state === 'forbidden') return <Closed title={listTitle} />

  const viewDialog: CaseDialog | null = !current || !dialog
    ? null
    : dialog.kind === 'cancel'
      ? { kind: 'cancel', model: { number: current.record.number, busy: dialog.busy, problem: dialog.problem } }
      : dialog.kind === 'photos'
        ? (() => {
            const target = targets.find((entry) => entry.id === dialog.target)
            return {
              kind: 'photos' as const,
              model: { number: current.record.number, targets, target: dialog.target, picked: dialog.picked, left: photosLeft(target?.count ?? 0, dialog.picked), held: sendPhotosHeld(dialog.picked, photosHeldKey, dialog.busy), busy: dialog.busy, done: dialog.done },
            }
          })()
        : { kind: 'photo', model: { photos: dialog.photos.map((photo) => ({ id: photo.id, name: photo.name })), index: dialog.index, state: dialog.state, src: dialog.src } }

  return (
    <CaseRecordView
      model={{
        state,
        case: current,
        tab,
        prefix: frame.prefix,
        offlineSince: offline ? loadedAt : null,
        notice,
        photosHeld: photosHeldKey ? t(photosHeldKey) : null,
        fileHeld,
        labelHref,
        creditHeld,
        readsComplaints: can('portal.complaints.view'),
        dialog: viewDialog,
      }}
      actions={{
        onRetry: () => {
          setState('loading')
          void load()
        },
        onPhotos: openPhotos,
        onPhoto: showPhoto,
        onDocument: openDocument,
        onCreditNote: openCredit,
        onDismissNotice: () => setNotice(null),
        dialog: {
          cancel: { onConfirm: confirmCancel, onClose: () => setDialog((now) => (now?.kind === 'cancel' && now.busy ? now : null)) },
          photos: {
            onTarget: (target) => setDialog((now) => (now?.kind === 'photos' && !now.busy ? { ...now, target, picked: now.picked.filter((photo) => photo.state === 'sent'), done: null } : now)),
            onFiles: pick,
            onRemove: (photoId) => {
              files.current.delete(photoId)
              setDialog((now) => (now?.kind === 'photos' ? { ...now, picked: now.picked.filter((photo) => photo.id !== photoId) } : now))
            },
            onSend: () => void sendPhotos(),
            onClose: () => setDialog((now) => (now?.kind === 'photos' && now.busy ? now : null)),
          },
          photo: {
            onIndex: (index) => (dialog?.kind === 'photo' ? showPhoto(dialog.photos, index) : undefined),
            onClose: () => {
              forget()
              setDialog(null)
            },
            onRetry: () => (dialog?.kind === 'photo' ? showPhoto(dialog.photos, dialog.index) : undefined),
          },
        },
      }}
    >
      {tab === 'messages' && record ? <PortalThread type={threadTypeOf(type)} id={record.id} showRecord={false} /> : null}
    </CaseRecordView>
  )
}
