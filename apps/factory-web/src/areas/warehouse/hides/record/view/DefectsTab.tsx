'use client'

import { ImageOff, Map as MapIcon, X } from 'lucide-react'
import { Banner, Card, EmptyState, Field } from '@nexus/ui/components'
import { Button, Pill, Spinner } from '@nexus/ui/primitives'
import { EditModeBar, FileDropzone, Textarea } from '../../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import type { Phrase } from '../../../../_shared/stock/model'
import { PartState, useWords, type Words } from '../../../lots/shared/parts'
import { PHOTO_ACCEPT, PHOTO_MAX_BYTES, photoPlaceKey, type RecordPhotosActions, type RecordPhotosModel } from '../../photos/model'
import type { GradingView } from '../grading/api'
import { applyHeldKey, changeCount, readOnlyKey, type GradingActions, type GradingDraft, type GradingModel } from '../grading/grading-model'
import './hide-tabs.css'

const say = (t: Words, said: Phrase) => t(said.key, said.params)

/**
 * The hide's "Defects & photos" tab (design warehouse.hides rec:Hide tab `defects`; B-W2b-131): the defects in words
 * ("holes, scars, veins and brand marks, and where") with the EditModeBar (a reason once the hide was cut); the photos
 * (MES-060) — taken at the cutting table (the cut log names them), at the incoming inspection (a mark names it) or added
 * in the office —, each opening the Lightbox (hd-photo), "Add a photo" for the office (files.upload); the defect map is a
 * later wave (SCM-251) and says so. Photos need files.read: without it the card says why. Draws the model; the containers
 * (use-grading.ts, use-hide-photos.ts) read and write.
 */
export function DefectsTab({
  model,
  photos,
  actions,
  photoActions,
  timeZone,
}: {
  model: GradingModel
  photos: RecordPhotosModel | null
  actions?: GradingActions
  photoActions?: RecordPhotosActions
  timeZone: string
}) {
  const t = useWords()
  return (
    <div className="fw-wl-stack">
      <PartState value={model.view} label={t('hd.tab.defects')} onRetry={actions?.onRetry}>
        {(view) => <DefectsCard view={view} model={model} actions={actions} />}
      </PartState>
      <div className="fw-wl-split">
        <PhotosCard model={model} photos={photos} actions={photoActions} timeZone={timeZone} />
        <Card header={t('hd.defectsTab.map.title')}>
          <EmptyState icon={<MapIcon size={24} aria-hidden />} title={t('hd.defectsTab.map.later')} description={t('hd.defectsTab.map.body')} />
        </Card>
      </div>
    </div>
  )
}

function DefectsCard({ view, model, actions }: { view: GradingView; model: GradingModel; actions?: GradingActions }) {
  const t = useWords()
  const draft = model.defectsDraft
  const readOnly = readOnlyKey(view)
  const editable = readOnly === null && model.can.manage && view.canEdit && draft !== null
  const count = draft ? changeCount(view, draft, 'defects') : 0
  const held = draft ? applyHeldKey(view, draft, 'defects', model.can, model.saving === 'defects') : null
  const set = (next: Partial<GradingDraft>) => draft && actions?.onDraft?.('defects', { ...draft, ...next })
  return (
    <div className="fw-wl-stack">
      {/* A used or scrapped hide: the record's band says it already (one Banner, not two). */}
      {readOnly && view.hide.state !== 'CONSUMED' && view.hide.state !== 'SCRAPPED' && (
        <Banner tone="info" title={t(readOnly, { code: view.hide.code })}>
          {t('hd.grading.readOnlyBody')}
        </Banner>
      )}
      {model.changedMeanwhile && <Banner tone="warning" title={t('hd.grading.changedMeanwhile')} />}
      {model.problem?.tab === 'defects' && <Banner tone="danger" title={say(t, model.problem.phrase)} onDismiss={() => actions?.onDismissNotice?.()} />}
      {model.saved === 'defects' && <Banner tone="success" title={t('hd.grading.saved')} onDismiss={() => actions?.onDismissNotice?.()} />}
      <Card header={t('hd.defectsTab.title')} description={editable ? t('hd.defectsTab.hint') : readOnly ? t(readOnly, { code: view.hide.code }) : t('hd.grading.viewOnly')}>
        {editable && draft ? (
          <div className="fw-hr-form">
            <div className="is-wide">
              <Field label={t('hd.defectsTab.field')}>
                <Textarea rows={5} maxLength={2000} value={draft.defects} placeholder={t('hd.defectsTab.placeholder')} onChange={(event) => set({ defects: event.target.value })} />
              </Field>
            </div>
            {view.reasonRequired && count > 0 && (
              <div className="is-wide">
                <Field label={t('hd.grading.reason')} required hint={t('hd.grading.reasonHint')}>
                  <Textarea rows={2} maxLength={500} value={draft.reason} onChange={(event) => set({ reason: event.target.value })} />
                </Field>
              </div>
            )}
          </div>
        ) : (
          <p className="fw-wl-text">{view.hide.defects ?? t('hd.defects.none')}</p>
        )}
      </Card>
      {editable && draft && count > 0 && (
        <EditModeBar count={count} onDiscard={() => actions?.onDiscard?.('defects')} onApply={() => actions?.onApply?.('defects')} applyHeldReason={held ? t(held) : null} busy={model.saving === 'defects'} saveShortcut />
      )}
    </div>
  )
}

function PhotosCard({ model, photos, actions, timeZone }: { model: GradingModel; photos: RecordPhotosModel | null; actions?: RecordPhotosActions; timeZone: string }) {
  const t = useWords()
  const locale = useLocale()
  const place = { locale, timeZone }
  const state = photos?.state ?? null
  const hideId = model.view.value?.hide.id ?? null
  const list = hideId && state ? (state.byHide[hideId] ?? []) : []
  const readable = model.can.filesRead && state?.canRead !== false
  const addHeld = !model.can.filesUpload ? t('hd.photos.held.noUpload') : null
  const add = model.can.filesUpload ? (
    <FileDropzone onFiles={(files) => actions?.onUpload?.(files)} accept={PHOTO_ACCEPT} maxBytes={PHOTO_MAX_BYTES} multiple hint={t('hd.photos.addHint')} />
  ) : (
    <Button size="sm" heldReason={addHeld}>
      {t('hd.photos.add')}
    </Button>
  )
  return (
    <Card header={t('hd.photos.title', { count: list.length })} description={t('hd.photos.hint')}>
      <div className="fw-wl-stack">
        {!readable ? (
          <EmptyState icon={<ImageOff size={24} aria-hidden />} title={t('hd.photos.noRead')} description={t('hd.photos.noReadBody')} />
        ) : !state || (state.canRead === null && !state.problem) || (state.loading && list.length === 0) ? (
          <p className="fw-wl-hint" role="status">
            <Spinner size={14} /> {t('hd.photos.loading')}
          </p>
        ) : state.problem ? (
          <EmptyState
            title={t('hd.photos.failed')}
            description={t(`stock:${state.problem}`)}
            action={
              <Button size="sm" onClick={() => actions?.onRetry?.()}>
                {t('rec.retry')}
              </Button>
            }
          />
        ) : list.length === 0 ? (
          <EmptyState title={t('hd.photos.none')} description={t('hd.photos.noneBody')} action={add} />
        ) : (
          <>
            <ul className="fw-hr-photos" aria-label={t('hd.photos.listLabel')}>
              {list.map((photo, index) => (
                <li key={photo.fileId} className="fw-hr-photo">
                  {photo.src && !photo.broken ? (
                    <button type="button" className="fw-hr-photo-open" aria-label={t('hd.photos.open', { n: index + 1, place: t(photoPlaceKey(photo)) })} onClick={() => actions?.onOpen?.(index)}>
                      {/* A presigned address of the files API (60 seconds); the Lightbox reads it again when it opens. */}
                      <img src={photo.src} alt={t('hd.photos.alt', { n: index + 1, count: list.length, code: model.view.value?.hide.code ?? '', place: t(photoPlaceKey(photo)) })} loading="lazy" />
                    </button>
                  ) : (
                    <span className="fw-hr-photo-missing">{photo.broken ? t('hd.photos.unread', { name: photo.originalName }) : <Spinner size={14} />}</span>
                  )}
                  <span className="fw-st-cell">
                    <span className="fw-st-inline">
                      <Pill tone={photo.place ? 'info' : 'neutral'}>{t(photoPlaceKey(photo))}</Pill>
                      {photo.workOrder && <span className="fw-wl-code">{photo.workOrder.number}</span>}
                    </span>
                    <span className="fw-st-sub">{formatDateTime(photo.createdAt, place)}</span>
                  </span>
                </li>
              ))}
            </ul>
            {add}
          </>
        )}
        {photos && photos.uploads.length > 0 && (
          <ul className="fw-hr-uploads" aria-label={t('hd.photos.uploadsLabel')}>
            {photos.uploads.map((upload) => (
              <li key={upload.key} className="fw-hr-upload">
                <span className="fw-st-inline">
                  {upload.phase === 'sending' ? <Spinner size={12} /> : <Pill tone="danger">{t('hd.photos.notAdded')}</Pill>}
                  <span className="fw-wl-text">{upload.phase === 'sending' ? t('hd.photos.sending', { name: upload.name }) : upload.name}</span>
                  {upload.problem && <span className="fw-st-sub">{t(upload.problem)}</span>}
                </span>
                {upload.phase === 'failed' && (
                  <Button size="sm" variant="quiet" aria-label={t('hd.photos.dismiss', { name: upload.name })} onClick={() => actions?.onDismissUpload?.(upload.key)}>
                    <X size={13} aria-hidden />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="fw-wl-hint">{t('hd.photos.receiptNote')}</p>
      </div>
    </Card>
  )
}
