'use client'

import { PhotoCapture } from '@nexus/ui/components/PhotoCapture/index'
import { Button } from '@nexus/ui/primitives'
import { usePhotoWords } from '../../../lib/ds-words/photo-capture'
import { Modal } from '../../../lib/i18n/ds-parts'
import { useT } from '../../../lib/i18n/provider'
import type { ClaimPage } from '../api'
import { CASE_GROUP, itemOf, type ClaimActions, type ClaimViewModel } from '../model'
import { itemTitle } from './items'

/**
 * "Add a photo" (design sec:photos; anatomy D21): the DS PhotoCapture with markup — the camera or a picture from the
 * device, then arrows and circles to show the problem (the keyboard draws too) — in a sheet. "Use photo" keeps the photo
 * with its marks drawn in, in this page only, until the send; the part re-encodes it, so a file's place and device are
 * gone before it ever leaves. Keep faces out of the picture (the part says so above the camera). Esc closes.
 */
export function PhotoDialog({ page, model, actions }: { page: ClaimPage; model: ClaimViewModel; actions?: ClaimActions }) {
  const t = useT('link-claim')
  const words = usePhotoWords()
  const group = model.photoFor ?? CASE_GROUP
  const title = group === CASE_GROUP ? t('photos.case') : itemTitle(itemOf(page, group), t)
  return (
    <Modal
      open
      sheet
      size="lg"
      onClose={() => actions?.onPhotoClose?.()}
      title={t('photos.dialogTitle', { title })}
      footer={<Button onClick={() => actions?.onPhotoClose?.()}>{t('photos.cancel')}</Button>}
    >
      <div className="fw-cl-stack">
        <p className="fw-cl-hint">{t('photos.dialogIntro')}</p>
        <PhotoCapture
          label={t('photos.surface', { title })}
          markup
          guide="frame"
          facesHint
          words={words}
          {...(model.photoSample ? { defaultPhoto: model.photoSample } : {})}
          onCapture={(photo) => actions?.onPhoto?.(photo)}
        />
      </div>
    </Modal>
  )
}
