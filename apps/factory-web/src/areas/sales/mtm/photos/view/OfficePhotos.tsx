'use client'

import Link from 'next/link'
import { CalendarClock, Camera, Image as ImageIcon } from 'lucide-react'
import { Banner, EmptyState } from '@nexus/ui/components'
import { Button, Tag } from '@nexus/ui/primitives'
import { ReadState, Section } from '../../../../quality/_shared/parts'
import { templatesHref } from '../../model'
import type { PhotoTarget, PhotoView } from '../api'
import { deleteLine, fittingPhotos, uploadHeld } from '../model'
import type { OfficePhotosActions, OfficePhotosModel } from '../use-photos'
import { useExtras } from '../words'

/**
 * The office's own photos on the rider profile (B-W2b-371, XF2:01; design rider.photos "Front, side, back · Taken when, by whom ·
 * Consent reference · Upload · Open in Lightbox · Delete (reason, logged)"): per revision the photos taken in the office (each its
 * view, who added it and when, its delete date in words, Open, Change the delete date), with the privacy notice the rider was given
 * (the consent); then the photos of each fitting. "Add a photo" on the newest revision, held with why (made-to-measure off for the
 * template, no right, offline). Office only, never shared. Fetches nothing.
 */
export function OfficePhotosSection({ model, actions, newestId, prefix }: { model: OfficePhotosModel; actions?: OfficePhotosActions; newestId: string; prefix: string }) {
  const { t, say, day } = useExtras()
  const photos = model.photos
  const held = uploadHeld(photos, 'profile', model.can, model.offline)
  const add = (
    <Button size="sm" variant="secondary" heldReason={say(held)} onClick={() => actions?.onUpload?.({ kind: 'profile', id: newestId })}>
      <Camera size={14} aria-hidden /> {t('photo.add')}
    </Button>
  )
  if (model.problem || !photos)
    return (
      <Section id="photos-office" title={t('photo.office')} actions={add}>
        <ReadState problem={model.problem} loading={!photos && !model.problem} onRetry={() => actions?.onRetry?.()} failedTitle={t('photo.failed')} />
      </Section>
    )
  return (
    <>
      <PhotoNotice model={model} actions={actions} />
      <Section id="photos-office" title={t('photo.office')} sub={t('photo.officeSub')} actions={add}>
        {!photos.started && (
          <p className="fw-mtm-hint">
            {t('photo.offBody', { garment: photos.garmentType })}{' '}
            <Link className="fw-mtm-link" href={templatesHref(prefix)}>
              {t('photo.offWhere')}
            </Link>
          </p>
        )}
        {photos.revisions.length === 0 ? (
          <EmptyState icon={<ImageIcon size={20} aria-hidden />} title={t('photo.none')} description={t('photo.noneBody')} />
        ) : (
          <div className="fw-mtm-stack">
            {photos.revisions.map((revision) => (
              <div key={revision.id} className="fw-mtm-stack">
                <p className="fw-mtm-row fw-mtm-hint">
                  <strong>{t('photo.revision', { revision: revision.revision })}</strong>
                  <span>{t('photo.consent', { notice: revision.notice.ref, date: day(revision.notice.at) })}</span>
                </p>
                <PhotoGrid photos={revision.photos} target={{ kind: 'profile', id: revision.id }} may={photos.may.date} model={model} actions={actions} />
              </div>
            ))}
          </div>
        )}
      </Section>
      {photos.fittings.length > 0 && (
        <Section id="photos-fittings" title={t('photo.fittings')} sub={t('photo.fittingsSub')}>
          <div className="fw-mtm-stack">
            {photos.fittings.map((fitting) => (
              <div key={fitting.resultId} className="fw-mtm-stack">
                <p className="fw-mtm-row fw-mtm-hint">
                  <strong>{t('photo.fittingOf', { date: day(fitting.fittedAt), revision: fitting.revision })}</strong>
                  <span>{t(`verdict.${fitting.verdict}`)}</span>
                </p>
                <PhotoGrid photos={fitting.photos} target={{ kind: 'fitting', id: fitting.resultId }} may={photos.may.dateFitting} model={model} actions={actions} />
              </div>
            ))}
          </div>
        </Section>
      )}
    </>
  )
}

/** The last photo receipt or refusal (a photo added, a date moved), with Dismiss. */
export function PhotoNotice({ model, actions }: { model: OfficePhotosModel; actions?: OfficePhotosActions }) {
  const { t, say } = useExtras()
  if (!model.notice) return null
  return (
    <Banner
      tone={model.notice.tone}
      title={say(model.notice)}
      action={
        <Button size="sm" variant="quiet" onClick={() => actions?.onDismiss?.()}>
          {t('photo.dismiss')}
        </Button>
      }
    />
  )
}

/** A fitting result's photos on its card (Fittings tab): their number, each one, Add a photo. */
export function FittingPhotos({ model, actions, resultId }: { model: OfficePhotosModel; actions?: OfficePhotosActions; resultId: string }) {
  const { t, say } = useExtras()
  const list = fittingPhotos(model.photos, resultId)
  const held = uploadHeld(model.photos, 'fitting', model.can, model.offline)
  return (
    <div className="fw-mtm-stack">
      <div className="fw-mtm-head">
        <span className="fw-mtm-hint">{list.length === 0 ? t('photo.fittingNone') : t('photo.fittingCount', { count: list.length })}</span>
        <Button size="sm" variant="secondary" heldReason={say(held)} onClick={() => actions?.onUpload?.({ kind: 'fitting', id: resultId })}>
          <Camera size={14} aria-hidden /> {t('photo.addFitting')}
        </Button>
      </div>
      {list.length > 0 && <PhotoGrid photos={list} target={{ kind: 'fitting', id: resultId }} may={!!model.photos?.may.dateFitting} model={model} actions={actions} />}
    </div>
  )
}

function PhotoGrid({ photos, target, may, model, actions }: { photos: readonly PhotoView[]; target: PhotoTarget; may: boolean; model: OfficePhotosModel; actions?: OfficePhotosActions }) {
  const { t, say, when } = useExtras()
  const dateHeldNow = !may ? t('photo.held.rightDate') : model.offline ? t('photo.held.offline') : null
  return (
    <div className="fw-mtm-photos">
      {photos.map((photo) => (
        <div key={photo.id} className="fw-mtm-photo">
          <span className="fw-mtm-row">
            <strong>{t(`view.${photo.view}`)}</strong>
            {photo.status !== 'AVAILABLE' && <Tag tone="warning">{t(photo.status === 'PENDING_UPLOAD' ? 'photo.pending' : 'photo.held.checked')}</Tag>}
          </span>
          <span className="fw-mtm-hint">{photo.by ? t('photo.addedBy', { name: photo.by.name, when: when(photo.createdAt) }) : t('photo.added', { when: when(photo.createdAt) })}</span>
          <span className="fw-mtm-hint">{say(deleteLine(photo, model.today))}</span>
          <span className="fw-mtm-actions">
            <Button size="sm" variant="secondary" heldReason={photo.status !== 'AVAILABLE' ? t('photo.notAvailable') : null} onClick={() => actions?.onOpen?.(photo)} aria-label={t('photo.openAria', { view: t(`view.${photo.view}`) })}>
              <ImageIcon size={14} aria-hidden /> {t('photo.open')}
            </Button>
            <Button size="sm" variant="quiet" heldReason={dateHeldNow} onClick={() => actions?.onDate?.(target, photo)} aria-label={t('photo.dateAria', { view: t(`view.${photo.view}`) })}>
              <CalendarClock size={14} aria-hidden /> {t('photo.dateButton')}
            </Button>
          </span>
        </div>
      ))}
    </div>
  )
}
