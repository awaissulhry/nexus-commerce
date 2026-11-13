'use client'

import { useEffect, useRef, useState } from 'react'
import { Camera, ImagePlus } from 'lucide-react'
import type { CameraScanner } from '@nexus/ui/floor'
import { Banner } from '@nexus/ui/components'
import { PhotoCapture, type CapturedPhoto } from '@nexus/ui/components/PhotoCapture/index'
import { Button, Pill, Spinner } from '@nexus/ui/primitives'
import { usePhotoWords } from '../../ds-words/photo-capture'
import { Modal } from '../../i18n/ds-parts'
import { formatTime } from '../../i18n/format'
import { useLocale, useT } from '../../i18n/provider'
import { NS } from '../intake'
import '../safety-intake.css'

/**
 * Photos after the send (design links.claim sec:photos, portal pop:safety-report "photos"; anatomy D21; SAL-415): the
 * reporter adds up to `max` photos to the report just sent, until `until` (the API's window), each by the phone's camera or a
 * picture of the device in the DS PhotoCapture (re-encoded: no place, no device), with arrows and circles to show the
 * problem. Faces out of the picture (the part says so). Each photo says whether it reached us; one that failed offers Try
 * again. Held with why: the window is over, all photos are in, no connection.
 */

export interface SafetyPhoto {
  readonly key: string
  readonly name: string
  readonly state: 'sending' | 'sent' | 'failed'
}

export interface SafetyPhotosModel {
  readonly photos: readonly SafetyPhoto[]
  readonly max: number
  /** The last moment a photo is taken (an instant); null: no window (the office). */
  readonly until: string | null
  /** Why "Add a photo" waits (a key), or null. */
  readonly held: string | null
  /** The camera sheet is open. */
  readonly capturing: boolean
  /** Photos the report holds already (the office record lists them itself): counted against `max`. */
  readonly already?: number
  /** Design cases: a made-up photo the sheet starts with. */
  readonly sample?: { readonly src: string; readonly width: number; readonly height: number }
}

export interface SafetyPhotosActions {
  onAdd?: () => void
  onCapture?: (photo: CapturedPhoto) => void | Promise<void>
  onCloseCapture?: () => void
  onRetry?: (key: string) => void
}

export function SafetyPhotos({ model, actions }: { model: SafetyPhotosModel; actions?: SafetyPhotosActions }) {
  const t = useT(NS)
  const locale = useLocale()
  const words = usePhotoWords()
  const sent = (model.already ?? 0) + model.photos.filter((photo) => photo.state === 'sent').length
  return (
    <section className="fw-sri-photos" aria-labelledby="fw-sri-photos-title">
      <div className="fw-sri-photos-head">
        <h3 className="fw-sri-legend" id="fw-sri-photos-title">
          <Camera size={16} aria-hidden /> {t('photos.title')}
        </h3>
        <span className="fw-sri-hint">{model.until ? t('photos.until', { time: formatTime(model.until, { locale }), count: sent, max: model.max }) : t('photos.count', { count: sent, max: model.max })}</span>
      </div>
      <p className="fw-sri-hint">{t('photos.intro')}</p>
      {model.photos.length > 0 && (
        <ul className="fw-sri-photo-list">
          {model.photos.map((photo) => (
            <li key={photo.key} className="fw-sri-photo">
              <span className="fw-sri-mono">{photo.name}</span>
              {photo.state === 'sending' ? (
                <span className="fw-sri-hint" role="status">
                  <Spinner size={12} /> {t('photos.sending')}
                </span>
              ) : photo.state === 'sent' ? (
                <Pill tone="success">{t('photos.sent')}</Pill>
              ) : (
                <span className="fw-sri-photo-failed">
                  <Pill tone="danger">{t('photos.failed')}</Pill>
                  <Button size="sm" variant="secondary" onClick={() => actions?.onRetry?.(photo.key)}>
                    {t('photos.retry')}
                  </Button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      <Button variant="secondary" onClick={() => actions?.onAdd?.()} heldReason={model.held ? t(model.held, { max: model.max }) : null}>
        <ImagePlus size={16} aria-hidden /> {t('photos.add')}
      </Button>
      {model.capturing && (
        <Modal open sheet size="lg" onClose={() => actions?.onCloseCapture?.()} title={t('photos.dialogTitle')} footer={<Button onClick={() => actions?.onCloseCapture?.()}>{t('common.cancel')}</Button>}>
          <div className="fw-sri">
            <p className="fw-sri-hint">{t('photos.dialogIntro')}</p>
            <PhotoCapture label={t('photos.surface')} markup guide="frame" facesHint words={words} {...(model.sample ? { defaultPhoto: model.sample } : {})} onCapture={(photo) => actions?.onCapture?.(photo)} />
          </div>
        </Modal>
      )}
    </section>
  )
}

/**
 * "Scan the label": the rear camera in a sheet reads the label's code, fills the serial and closes (the claim link's
 * ScanDialog and the service case's ScanSheet, here for the three doors). No camera, or none allowed: it says so; typing
 * the serial still works.
 */
export function ScanSheet({ scanner, onScanned, onClose }: { scanner: CameraScanner | null; onScanned: (code: string) => void; onClose: () => void }) {
  const t = useT(NS)
  const video = useRef<HTMLVideoElement>(null)
  const latest = useRef(onScanned)
  latest.current = onScanned
  const [state, setState] = useState<'starting' | 'on' | 'failed' | 'none'>(scanner ? 'starting' : 'none')

  useEffect(() => {
    const element = video.current
    if (!scanner || !element) return
    let stop: (() => void) | null = null
    let done = false
    scanner
      .start(element, (code) => {
        if (done || code.trim() === '') return
        done = true
        stop?.()
        latest.current(code.trim())
      })
      .then((stopper) => {
        if (done) stopper()
        else {
          stop = stopper
          setState('on')
        }
      })
      .catch(() => {
        if (!done) setState('failed')
      })
    return () => {
      done = true
      stop?.()
    }
  }, [scanner])

  return (
    <Modal open sheet size="md" onClose={onClose} title={t('scan.title')} footer={<Button onClick={onClose}>{t('common.cancel')}</Button>}>
      <div className="fw-sri">
        <p className="fw-sri-hint">{t('scan.intro')}</p>
        {scanner && (
          <div className="fw-sri-video" data-state={state}>
            <video ref={video} muted playsInline aria-label={t('scan.video')} />
          </div>
        )}
        {state === 'starting' && (
          <p className="fw-sri-hint" role="status">
            <Spinner size={12} /> {t('scan.starting')}
          </p>
        )}
        {(state === 'failed' || state === 'none') && <Banner tone="warning" title={t('scan.noCamera')} />}
      </div>
    </Modal>
  )
}
