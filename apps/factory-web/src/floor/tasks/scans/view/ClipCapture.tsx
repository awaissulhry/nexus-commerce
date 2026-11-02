'use client'

import { useEffect, useRef, useState } from 'react'
import { Camera, CircleStop, Check, RotateCcw, ScanFace, Video, X } from 'lucide-react'
import { FloorButton } from '@nexus/ui/floor'
import { FloorElapsed } from '@nexus/ui/floor/FloorElapsed/index'
import { useDsWords } from '../../../../lib/i18n/ds-parts'
import type { Translate } from '../../../../lib/i18n/messages'
import { TaskLine } from '../../shared/view/TaskParts'

/**
 * A 15-second clip for "Photo or comment" (COL-017). The DS PhotoCapture has no clip mode (named in the notes), so this composes
 * one from the browser's camera and MediaRecorder with the same reminder and outline guide: start the camera, record, it stops by
 * itself at the limit, look at it, use it or take it again. The length is the tablet's word (the API does not open a video). The
 * camera never starts by itself and stops as soon as the clip is taken or the step closes.
 */

/** What this browser records, in order of preference; null: it cannot. Pure, so the tests hold it. */
export function clipTypeOf(supported: (type: string) => boolean): string | null {
  return ['video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find(supported) ?? null
}

type Stage = 'idle' | 'ready' | 'recording' | 'done' | 'failed'

export function ClipCapture({ seconds, reminder, t, onClip, onCancel }: { seconds: number; reminder: string; t: Translate; onClip: (clip: Blob, seconds: number) => void; onCancel: () => void }) {
  const labels = useDsWords().floorElapsed
  const [stage, setStage] = useState<Stage>('idle')
  const [until, setUntil] = useState<number | null>(null)
  const [url, setUrl] = useState<string | null>(null)
  const video = useRef<HTMLVideoElement>(null)
  const stream = useRef<MediaStream | null>(null)
  const recorder = useRef<MediaRecorder | null>(null)
  const timer = useRef<number | null>(null)
  const taken = useRef<{ blob: Blob; seconds: number } | null>(null)

  const stopCamera = () => {
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
      stopCamera()
    },
    [],
  )
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url])

  const start = async () => {
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      if (video.current) {
        video.current.srcObject = stream.current
        await video.current.play()
      }
      setStage('ready')
    } catch {
      stopCamera()
      setStage('failed')
    }
  }

  const record = () => {
    const type = typeof MediaRecorder === 'undefined' ? null : clipTypeOf((candidate) => MediaRecorder.isTypeSupported(candidate))
    if (!type || !stream.current) return setStage('failed')
    const chunks: Blob[] = []
    const began = Date.now()
    const take = new MediaRecorder(stream.current, { mimeType: type, videoBitsPerSecond: 2_000_000 })
    take.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data)
    }
    take.onstop = () => {
      clearTimer()
      stopCamera()
      const blob = new Blob(chunks, { type })
      taken.current = { blob, seconds: Math.min(seconds, Math.max(1, Math.round((Date.now() - began) / 1000))) }
      if (video.current) video.current.srcObject = null
      setUrl(URL.createObjectURL(blob))
      setStage('done')
    }
    recorder.current = take
    take.start()
    setUntil(began + seconds * 1000)
    setStage('recording')
    timer.current = window.setTimeout(() => {
      if (take.state === 'recording') take.stop()
    }, seconds * 1000)
  }

  const again = () => {
    taken.current = null
    setUrl(null)
    setUntil(null)
    setStage('idle')
    void start()
  }

  return (
    <div className="fw-floor-stack">
      <TaskLine tone="info" icon={<ScanFace />}>
        {reminder}
      </TaskLine>
      <div className="fw-scans-clip" data-stage={stage}>
        {/* The outline guide: keep the work inside it, people out of it. */}
        {url ? <video className="fw-scans-clip-video" src={url} controls playsInline aria-label={t('note.clip.review')} /> : <video ref={video} className="fw-scans-clip-video" muted playsInline aria-label={t('note.clip.preview')} />}
        {stage === 'ready' || stage === 'recording' ? <span className="fw-scans-clip-guide" aria-hidden="true" /> : null}
      </div>
      {stage === 'recording' && until ? <FloorElapsed label={t('note.clip.left')} until={until} labels={labels} size="md" /> : null}
      {stage === 'failed' ? (
        <TaskLine tone="warning" icon={<Video />} alert>
          {t('note.clip.failed')}
        </TaskLine>
      ) : null}
      <div className="fw-floor-dialog-actions">
        {stage === 'idle' || stage === 'failed' ? (
          <FloorButton size="lg" variant="primary" icon={<Camera />} onClick={() => void start()}>
            {t('note.clip.camera')}
          </FloorButton>
        ) : null}
        {stage === 'ready' ? (
          <FloorButton size="lg" variant="primary" icon={<Video />} onClick={record}>
            {t('note.clip.record', { count: seconds })}
          </FloorButton>
        ) : null}
        {stage === 'recording' ? (
          <FloorButton size="lg" variant="warning" icon={<CircleStop />} onClick={() => recorder.current?.stop()}>
            {t('note.clip.stop')}
          </FloorButton>
        ) : null}
        {stage === 'done' ? (
          <>
            <FloorButton size="lg" variant="secondary" icon={<RotateCcw />} onClick={again}>
              {t('note.clip.again')}
            </FloorButton>
            <FloorButton size="lg" variant="primary" icon={<Check />} onClick={() => taken.current && onClip(taken.current.blob, taken.current.seconds)}>
              {t('note.clip.use')}
            </FloorButton>
          </>
        ) : null}
        <FloorButton size="lg" variant="secondary" icon={<X />} onClick={onCancel}>
          {t('note.cancel')}
        </FloorButton>
      </div>
    </div>
  )
}
