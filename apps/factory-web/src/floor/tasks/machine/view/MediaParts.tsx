'use client'

import { useEffect, useRef, useState } from 'react'
import { AudioLines, Check, CircleAlert, CircleStop, FileImage, Hourglass, Mic, RotateCcw, ScanFace, X } from 'lucide-react'
import { PhotoCapture, type CapturedPhoto } from '@nexus/ui/components/PhotoCapture/index'
import { FloorButton } from '@nexus/ui/floor'
import { FloorElapsed } from '@nexus/ui/floor/FloorElapsed/index'
import { PHOTO_KIT_NAMESPACE, usePhotoWords } from '../../../../lib/ds-words/photo-capture'
import { formatTime } from '../../../../lib/i18n/format'
import { Modal, useDsWords } from '../../../../lib/i18n/ds-parts'
import type { Translate } from '../../../../lib/i18n/messages'
import { WithMessages } from '../../../../record-panels/i18n'
import { TaskLine } from '../../shared/view/TaskParts'
import type { StoredMedia } from '../api'
import { mediaKey, voiceTypeOf, VOICE_SECONDS, type MediaKind, type MediaUpload, type TakenMedia } from '../depth'

/**
 * The photos and voice notes of the machine problem (B-W2b-102; design floor.machine "Optional photo or voice note",
 * QHS-189; "before and after photos" of the close): the DS PhotoCapture (D21: outline guide, "keep faces out of the
 * picture", arrows and circles drawn into the picture) and a voice recorder composed here (the DS has none: named in the
 * notes), the rows of what was taken or stored, and the dialog that shows a photo or plays a voice note on the tablet.
 * Faces never: nothing looks for them; the hint stands over every camera and the recorder asks for no names.
 */

export interface Place {
  readonly locale: 'it' | 'en'
  readonly timeZone?: string
}

/** A photo or voice note opened on the tablet: its blob address once read; failed when it could not be read. */
export interface Peek {
  readonly fileId: string
  readonly kind: MediaKind
  readonly name: string
  readonly url: string | null
  readonly failed?: boolean
}

// ---- taking one ------------------------------------------------------------------------------------------------------------

/** The DS camera with its words (photo-kit), the faces hint and the marks drawn in. */
function PhotoStep({ title, onPhoto, onCancel }: { title: string; onPhoto: (photo: CapturedPhoto) => void; onCancel: () => void }) {
  const words = usePhotoWords()
  return (
    <div className="fw-floor-stack">
      <h2 className="fw-floor-section-title">{title}</h2>
      <PhotoCapture label={title} words={words} facesHint onCapture={onPhoto} onCancel={onCancel} />
    </div>
  )
}

/** The camera or the recorder in place of the screen's body, for one photo or one voice note. */
export function CaptureStep({ kind, title, t, onPhoto, onVoice, onCancel }: { kind: MediaKind; title: string; t: Translate; onPhoto: (blob: Blob) => void; onVoice: (blob: Blob) => void; onCancel: () => void }) {
  if (kind === 'PHOTO') {
    return (
      <WithMessages namespaces={[PHOTO_KIT_NAMESPACE]}>
        {/* The photo with its marks drawn in when there are marks: what the technician needs to see. */}
        <PhotoStep title={title} onPhoto={(photo) => onPhoto(photo.marked ?? photo.photo)} onCancel={onCancel} />
      </WithMessages>
    )
  }
  return (
    <div className="fw-floor-stack">
      <h2 className="fw-floor-section-title">{title}</h2>
      <VoiceCapture t={t} onVoice={onVoice} onCancel={onCancel} />
    </div>
  )
}

type VoiceStage = 'idle' | 'recording' | 'done' | 'failed'

/**
 * A voice note of at most VOICE_SECONDS (composed: the DS PhotoCapture has no audio mode). The microphone never starts by
 * itself: Start recording asks the browser, it stops by itself at the limit, the person listens, then uses it or records
 * again. The microphone is released as soon as the note is taken or the step closes.
 */
export function VoiceCapture({ t, onVoice, onCancel }: { t: Translate; onVoice: (blob: Blob) => void; onCancel: () => void }) {
  const labels = useDsWords().floorElapsed
  const [stage, setStage] = useState<VoiceStage>('idle')
  const [until, setUntil] = useState<number | null>(null)
  const [url, setUrl] = useState<string | null>(null)
  const stream = useRef<MediaStream | null>(null)
  const recorder = useRef<MediaRecorder | null>(null)
  const timer = useRef<number | null>(null)
  const taken = useRef<Blob | null>(null)

  const stopMicrophone = () => {
    stream.current?.getTracks().forEach((track) => track.stop())
    stream.current = null
  }
  const clearTimer = () => {
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = null
  }
  useEffect(
    () => () => {
      clearTimer()
      if (recorder.current?.state === 'recording') recorder.current.stop()
      stopMicrophone()
    },
    [],
  )
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url])

  const record = async () => {
    const type = typeof MediaRecorder === 'undefined' ? null : voiceTypeOf((candidate) => MediaRecorder.isTypeSupported(candidate))
    if (!type || !navigator.mediaDevices?.getUserMedia) return setStage('failed')
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
    } catch {
      stopMicrophone()
      return setStage('failed')
    }
    const chunks: Blob[] = []
    const take = new MediaRecorder(stream.current, { mimeType: type })
    take.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data)
    }
    take.onstop = () => {
      clearTimer()
      stopMicrophone()
      const blob = new Blob(chunks, { type })
      taken.current = blob
      setUrl(URL.createObjectURL(blob))
      setStage('done')
    }
    recorder.current = take
    take.start()
    setUntil(Date.now() + VOICE_SECONDS * 1000)
    setStage('recording')
    timer.current = window.setTimeout(() => {
      if (take.state === 'recording') take.stop()
    }, VOICE_SECONDS * 1000)
  }

  const again = () => {
    taken.current = null
    setUrl(null)
    setUntil(null)
    setStage('idle')
  }

  return (
    <div className="fw-floor-stack">
      <TaskLine tone="info" icon={<ScanFace />}>
        {t('voice.hint', { count: VOICE_SECONDS })}
      </TaskLine>
      {stage === 'recording' ? (
        <p className="fw-mc-voice-now" role="status">
          <span className="fw-floor-inline-icon" aria-hidden="true">
            <Mic />
          </span>
          {t('voice.recording')}
        </p>
      ) : null}
      {stage === 'recording' && until ? <FloorElapsed label={t('voice.left')} until={until} labels={labels} size="md" /> : null}
      {url ? <audio className="fw-mc-audio" src={url} controls aria-label={t('voice.review')} /> : null}
      {stage === 'failed' ? (
        <TaskLine tone="warning" icon={<CircleAlert />} alert>
          {t('voice.failed')}
        </TaskLine>
      ) : null}
      <div className="fw-floor-dialog-actions">
        {stage === 'idle' || stage === 'failed' ? (
          <FloorButton size="lg" variant="primary" icon={<Mic />} onClick={() => void record()}>
            {t('voice.start')}
          </FloorButton>
        ) : null}
        {stage === 'recording' ? (
          <FloorButton size="lg" variant="warning" icon={<CircleStop />} onClick={() => recorder.current?.stop()}>
            {t('voice.stop')}
          </FloorButton>
        ) : null}
        {stage === 'done' ? (
          <>
            <FloorButton size="lg" variant="secondary" icon={<RotateCcw />} onClick={again}>
              {t('voice.again')}
            </FloorButton>
            <FloorButton size="lg" variant="primary" icon={<Check />} onClick={() => taken.current && onVoice(taken.current)}>
              {t('voice.use')}
            </FloorButton>
          </>
        ) : null}
        <FloorButton size="lg" variant="secondary" icon={<X />} onClick={onCancel}>
          {t('voice.cancel')}
        </FloorButton>
      </div>
    </div>
  )
}

// ---- what was taken, what is stored ------------------------------------------------------------------------------------

const kindIcon = (kind: MediaKind) => (kind === 'AUDIO' ? <AudioLines /> : <FileImage />)

/** Taken with the report, not sent yet: each with Remove. */
export function TakenList({ media, t, onRemove }: { media: readonly TakenMedia[]; t: Translate; onRemove: (id: string) => void }) {
  if (media.length === 0) return null
  return (
    <ul className="fw-mc-media" aria-label={t('media.taken')}>
      {media.map((entry) => (
        <li key={entry.id} className="fw-mc-media-row">
          <span className="fw-floor-inline-icon" aria-hidden="true">
            {kindIcon(entry.kind)}
          </span>
          <span className="fw-mc-media-name">{t(entry.kind === 'AUDIO' ? 'media.voice' : 'media.photo')}</span>
          <span className="fw-mc-media-state">{entry.name}</span>
          <FloorButton size="md" variant="secondary" icon={<X />} aria-label={t('media.remove', { name: entry.name })} onClick={() => onRemove(entry.id)} />
        </li>
      ))}
    </ul>
  )
}

/** Sent after the report: where each one stands, a failed one with Try again. */
export function UploadList({ uploads, t, onRetry }: { uploads: readonly MediaUpload[]; t: Translate; onRetry: (id: string) => void }) {
  if (uploads.length === 0) return null
  return (
    <ul className="fw-mc-media" aria-label={t('media.sent')}>
      {uploads.map((entry) => (
        <li key={entry.id} className="fw-mc-media-row" data-state={entry.state}>
          <span className="fw-floor-inline-icon" aria-hidden="true">
            {entry.state === 'added' ? <Check /> : entry.state === 'failed' ? <CircleAlert /> : entry.state === 'sending' ? <Hourglass /> : kindIcon(entry.kind)}
          </span>
          <span className="fw-mc-media-name">{t(entry.kind === 'AUDIO' ? 'media.voice' : 'media.photo')}</span>
          <span className="fw-mc-media-state" role={entry.state === 'failed' ? 'alert' : undefined}>
            {t(`upload.${entry.state}`)}
          </span>
          {entry.state === 'failed' ? (
            <FloorButton size="md" variant="secondary" icon={<RotateCcw />} onClick={() => onRetry(entry.id)}>
              {t('action.retry')}
            </FloorButton>
          ) : null}
        </li>
      ))}
    </ul>
  )
}

/** Stored on the request or job: each opens on the tablet (held offline with the reason). */
export function StoredList({ files, t, place, online, onOpen }: { files: readonly StoredMedia[]; t: Translate; place: Place; online: boolean; onOpen: (file: StoredMedia) => void }) {
  if (files.length === 0) return <p className="fw-floor-muted">{t('media.none')}</p>
  return (
    <ul className="fw-mc-media" aria-label={t('media.stored')}>
      {files.map((file) => (
        <li key={file.id} className="fw-mc-media-row">
          <span className="fw-floor-inline-icon" aria-hidden="true">
            {kindIcon(file.kind)}
          </span>
          <span className="fw-mc-media-name">{t(mediaKey(file))}</span>
          <span className="fw-mc-media-state">{file.availableAt ? formatTime(file.availableAt, place) : ''}</span>
          <FloorButton size="md" variant="secondary" icon={file.kind === 'AUDIO' ? <AudioLines /> : <FileImage />} heldReason={online ? null : t('held.offline')} aria-label={t(file.kind === 'AUDIO' ? 'media.listenTo' : 'media.lookAt', { what: t(mediaKey(file)) })} onClick={() => onOpen(file)}>
            {t(file.kind === 'AUDIO' ? 'media.listen' : 'media.look')}
          </FloorButton>
        </li>
      ))}
    </ul>
  )
}

/** The photo or the voice note opened on the tablet. */
export function PeekDialog({ peek, t, onClose }: { peek: Peek | null; t: Translate; onClose: () => void }) {
  const title = peek ? t(peek.kind === 'AUDIO' ? 'media.voice' : 'media.photo') : ''
  return (
    <Modal open={peek !== null} onClose={onClose} title={title} size="md" className="fw-floor-dialog">
      {peek ? (
        <div className="fw-floor-dialog-body">
          {peek.url ? (
            peek.kind === 'PHOTO' ? (
              // A blob of this page: the photo as stored (marks drawn in), faces never (the office deletes one that shows a face).
              <img className="fw-mc-peek-photo" src={peek.url} alt={peek.name} />
            ) : (
              <audio className="fw-mc-audio" src={peek.url} controls aria-label={peek.name} />
            )
          ) : peek.failed ? (
            <TaskLine tone="warning" icon={<CircleAlert />} alert>
              {t('media.openFailed')}
            </TaskLine>
          ) : (
            <p className="fw-floor-muted" role="status" aria-busy="true">
              {t('media.opening')}
            </p>
          )}
          <div className="fw-floor-dialog-actions">
            <FloorButton size="lg" variant="secondary" icon={<X />} onClick={onClose}>
              {t('media.close')}
            </FloorButton>
          </div>
        </div>
      ) : null}
    </Modal>
  )
}
