'use client'

import { useRef } from 'react'
import Link from 'next/link'
import { Camera, CircleCheck, Lock, Mic, RotateCcw, ShieldCheck } from 'lucide-react'
import { Banner, Card, KeyValue } from '@nexus/ui/components'
import { LawRef } from '@nexus/ui/components/LawRef/index'
import { PhotoCapture } from '@nexus/ui/components/PhotoCapture/index'
import { Button, Spinner } from '@nexus/ui/primitives'
import { usePhotoWords } from '../../../../../lib/ds-words/photo-capture'
import { useDsWords } from '../../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import { labelOf, personWords } from '../../../_shared/model'
import { say, useWords } from '../../../_shared/parts'
import type { DeepJobRecord } from '../../../requests/depth/api'
import { firstPieceAsked, leadHeld, lightboxPhotos, uploadHeld } from '../../../requests/depth/model'
import { MediaList } from '../../../requests/view/MediaList'
import type { JobRecordActions, JobRecordModel } from '../../view-model'
import '../../../requests/depth/depth.css'

interface PartProps {
  model: JobRecordModel
  value: DeepJobRecord
  actions?: JobRecordActions
}

/**
 * The job's Unsafe lock (B-W2b-140; design plant.jobs Problem › "Unsafe lock", QHS-183): "Locked since 09:12 by Station
 * C2 · reason 'guard missing'", Sign safe here (a technician: what was checked, then a fresh code; the status returns to
 * Running or Under maintenance), the law named; the request that locks it one click away. Hidden when not locked.
 */
export function LockPanel({ model, value, actions }: PartProps) {
  const t = useWords()
  const ds = useDsWords()
  const locale = useLocale()
  const lock = value.lock
  if (!lock) return null
  const place = { locale, timeZone: model.timeZone }
  const request = lock.request
  // The reason in the page's language: the lock's symptom, else its words (the API's machine status words are English).
  const reason = (request.symptom ? labelOf(request.symptom, locale) : request.description?.trim()) || t('symptom.none')
  const held = !model.can.signSafe || !lock.canSignSafe ? t('held.noSignSafe') : model.busy ? t('held.busy') : null
  return (
    <Banner
      tone="danger"
      icon={<Lock size={18} aria-hidden />}
      title={t('lockPanel.title', { machine: value.job.machine.assetNumber, since: formatDateTime(lock.since, place), who: personWords(t, request.reportedBy) })}
      action={
        <span className="fw-pl-row">
          <Button size="sm" variant="quiet" asChild>
            <Link href={`${model.prefix}/plant/requests?open=${encodeURIComponent(request.id)}`}>{t('record.lockedOpen')}</Link>
          </Button>
          <Button size="sm" variant="primary" heldReason={held} onClick={() => actions?.onSignSafe?.()}>
            <ShieldCheck size={14} aria-hidden /> {t('detail.signSafe')}
          </Button>
        </span>
      }
    >
      <span className="fw-pl-row">
        <span>{t('lockPanel.reason', { reason })}</span>
        <LawRef law="D.Lgs. 81/2008 art. 71" plain={t('lockAsUnsafe.lawPlain')} labels={ds.lawRef} />
      </span>
      <span className="fw-pl-hint">{t('lockPanel.body')}</span>
    </Banner>
  )
}

/**
 * Line lead confirms (B-W2b-140; design plant.jobs Hand-back › "Line lead confirms", QHS-180, QHS-191): confirmed by whom
 * and when, else Confirm it works (a person who triages the requests; on the floor the line lead); every request behind
 * the job with what its reporter sees; a stitch-settings repair says the first-piece check that comes with W3.
 */
export function LeadConfirmPanel({ model, value, actions }: PartProps) {
  const t = useWords()
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const job = value.job
  const held = leadHeld(value, model.can, model.busy)
  return (
    <Card padded>
      <section className="fw-pl-stack tight" aria-labelledby="pl-lead">
        <h3 className="fw-pl-h3" id="pl-lead">
          {t('lead.title')}
        </h3>
        {job.leadConfirmed ? (
          <KeyValue
            dense
            labelCase="sentence"
            columns={2}
            items={[
              { label: t('lead.by'), value: personWords(t, job.leadConfirmed.by) },
              { label: t('lead.at'), value: formatDateTime(job.leadConfirmed.at, place) },
            ]}
          />
        ) : (
          <>
            <p className="fw-pl-text">{t('lead.body')}</p>
            <span>
              <Button size="sm" variant="primary" heldReason={held ? t(held) : null} onClick={() => actions?.onConfirmLead?.()}>
                {model.busy ? <Spinner size={12} /> : <CircleCheck size={14} aria-hidden />} {t('lead.confirm')}
              </Button>
            </span>
          </>
        )}
        {value.requests.length > 0 && (
          <>
            <p className="fw-pl-h3">{t('lead.reporters')}</p>
            <ul className="fw-pl-plain">
              {value.requests.map((request) => (
                <li key={request.id} className="fw-pl-dupe">
                  <span className="fw-pl-cell">
                    <span>{personWords(t, request.reportedBy)}</span>
                    <span className="fw-pl-sub">{t(`progress.step.${request.progress.step}`)}</span>
                  </span>
                  <Button size="sm" variant="quiet" asChild>
                    <Link href={`${model.prefix}/plant/requests?open=${encodeURIComponent(request.id)}`}>{t('record.openRequest')}</Link>
                  </Button>
                </li>
              ))}
            </ul>
          </>
        )}
        {firstPieceAsked(job) && <p className="fw-pl-hint">{t('lead.firstPiece')}</p>}
      </section>
    </Card>
  )
}

/**
 * Photos (B-W2b-140; design plant.jobs tab "Photos", QHS-189): the job's photos before and after the work and its voice
 * notes, then its requests' (from the station). Add a photo before / after with the DS camera (arrows and circles drawn
 * in, faces kept out), add a voice note from a phone (its file picker records one) — each held with its reason; one at a
 * time, a failed one with Try again. Opened in the DS Lightbox.
 */
export function PhotosTab({ model, value, actions, can }: PartProps & { can: { manageJobs: boolean; work: boolean } }) {
  const t = useWords()
  const locale = useLocale()
  const photoWords = usePhotoWords()
  const picker = useRef<HTMLInputElement | null>(null)
  const place = { locale, timeZone: model.timeZone }
  const job = value.job
  const capture = model.capture
  const held = uploadHeld(job, can, capture?.state === 'sending')
  const own = model.media.filter((entry) => entry.requestId === null)
  const fromRequests = model.media.filter((entry) => entry.requestId !== null)
  const photos = lightboxPhotos(model.media)
  const open = (id: string) => actions?.onPhoto?.(photos.findIndex((entry) => entry.id === id))
  return (
    <div className="fw-pl-stack">
      {capture?.state === 'failed' && (
        <Banner
          tone="danger"
          title={say(t, capture.words) ?? ''}
          action={
            <Button size="sm" onClick={() => actions?.onRetryUpload?.()}>
              <RotateCcw size={13} aria-hidden /> {t('common.retry')}
            </Button>
          }
        />
      )}
      <Card padded>
        <section className="fw-pl-stack tight" aria-labelledby="pl-photos">
          <h3 className="fw-pl-h3" id="pl-photos">
            {t('media.jobTitle')}
          </h3>
          {capture?.state === 'camera' ? (
            <PhotoCapture
              label={t(capture.category === 'BEFORE_WORK' ? 'media.takeBefore' : 'media.takeAfter')}
              words={photoWords}
              facesHint
              onCapture={(photo) => actions?.onPhotoTaken?.(photo)}
              onCancel={() => actions?.onCamera?.(null)}
              heldReason={held ? t(held) : null}
            />
          ) : (
            <span className="fw-pl-row">
              <Button size="sm" heldReason={held ? t(held) : null} onClick={() => actions?.onCamera?.('BEFORE_WORK')}>
                <Camera size={14} aria-hidden /> {t('media.addBefore')}
              </Button>
              <Button size="sm" heldReason={held ? t(held) : null} onClick={() => actions?.onCamera?.('AFTER_WORK')}>
                <Camera size={14} aria-hidden /> {t('media.addAfter')}
              </Button>
              <Button size="sm" heldReason={held ? t(held) : null} onClick={() => picker.current?.click()}>
                <Mic size={14} aria-hidden /> {t('media.addVoice')}
              </Button>
              <input
                ref={picker}
                className="fw-pd-hidden-input"
                type="file"
                accept="audio/*"
                capture
                tabIndex={-1}
                aria-hidden
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  event.target.value = ''
                  if (file) actions?.onVoicePicked?.(file)
                }}
              />
              {capture?.state === 'sending' && (
                <span className="fw-pl-hint" role="status">
                  <Spinner size={12} /> {t(capture.kind === 'AUDIO' ? 'media.sendingVoice' : 'media.sendingPhoto')}
                </span>
              )}
            </span>
          )}
          <p className="fw-pl-hint">{t('media.phoneHint')}</p>
          <MediaList media={own} canRead={model.can.readFiles} t={t} place={place} onPhoto={open} empty={t('media.noneJob')} />
        </section>
      </Card>
      <Card padded>
        <section className="fw-pl-stack tight" aria-labelledby="pl-photos-requests">
          <h3 className="fw-pl-h3" id="pl-photos-requests">
            {t('media.fromRequests', { count: value.requests.length })}
          </h3>
          <MediaList media={fromRequests} canRead={model.can.readFiles} t={t} place={place} onPhoto={open} empty={t('media.noneRequests')} />
        </section>
      </Card>
    </div>
  )
}
