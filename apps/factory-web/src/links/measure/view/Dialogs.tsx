'use client'

import { PhotoCapture } from '@nexus/ui/components/PhotoCapture/index'
import { Button } from '@nexus/ui/primitives'
import type { PhotoView } from '@nexus/factory-domain/sales/measure-link/rules'
import { usePhotoWords } from '../../../lib/ds-words/photo-capture'
import { Modal } from '../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../lib/i18n/provider'
import type { MeasurePage } from '../api'
import { pointsOf, type MeasureActions, type MeasureViewModel } from '../model'
import { BodyFigure } from './BodyFigure'

/**
 * pop:guide — "How to measure: inside leg" (design links.measure; Modal): the point's picture large (video Later, SAL-453)
 * and the steps in words: the template's own how-to, then the page's general steps. Close, or Esc, gives the focus back.
 */
export function GuideDialog({ page, model, actions }: { page: MeasurePage; model: MeasureViewModel; actions?: MeasureActions | undefined }) {
  const t = useT('link-measure')
  const locale = useLocale()
  const point = pointsOf(page, locale).find((entry) => entry.code === model.guideFor)
  if (!point) return null
  return (
    <Modal open size="md" onClose={() => actions?.onGuide?.(null)} title={t('guide.title', { point: point.name })} footer={<Button onClick={() => actions?.onGuide?.(null)}>{t('guide.close')}</Button>}>
      <div className="fw-ms-guide">
        <BodyFigure code={point.code} size="lg" label={t('guide.picture', { point: point.name })} />
        <ol className="fw-ms-list fw-ms-steps">
          {point.howTo ? <li>{point.howTo}</li> : null}
          <li>{t('guide.step.stand')}</li>
          <li>{t('guide.step.tape')}</li>
          <li>{t('guide.step.read')}</li>
        </ol>
      </div>
    </Modal>
  )
}

/**
 * "Take the photo" (design sec:photos; anatomy D21): the DS PhotoCapture with the silhouette guide over the camera (or a
 * picture from the device), no marks, in a sheet. "Use photo" sends it at once (kept with us, never on the device); the part
 * re-encodes it, so a file's place and device are gone before it leaves. Esc closes.
 */
export function PhotoDialog({ view, model, actions }: { view: PhotoView; model: MeasureViewModel; actions?: MeasureActions | undefined }) {
  const t = useT('link-measure')
  const words = usePhotoWords()
  const name = t(`photos.view.${view}`)
  return (
    <Modal open sheet size="lg" onClose={() => actions?.onPhotoOpen?.(null)} title={t('photos.dialogTitle', { view: name })} footer={<Button onClick={() => actions?.onPhotoOpen?.(null)}>{t('photos.cancel')}</Button>}>
      <div className="fw-ms-stack">
        <p className="fw-ms-hint">{t(`photos.dialogIntro.${view}`)}</p>
        <PhotoCapture label={t('photos.surface', { view: name })} markup={false} guide="silhouette" facesHint words={words} {...(model.photoSample ? { defaultPhoto: model.photoSample } : {})} onCapture={(photo) => actions?.onPhoto?.(view, photo)} />
      </div>
    </Modal>
  )
}
