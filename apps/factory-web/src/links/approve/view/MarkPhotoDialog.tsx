'use client'

import { Banner, Field } from '@nexus/ui/components'
import { PhotoCapture } from '@nexus/ui/components/PhotoCapture/index'
import { Button, Spinner } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../lib/i18n/ds-parts'
import { usePhotoWords } from '../../../lib/ds-words/photo-capture'
import { useT } from '../../../lib/i18n/provider'
import { ANSWER_LIMITS, markSaveHeld, type ApproveActions, type MarkingState } from '../model'

/**
 * Design pop:photo-markup — "Mark the photo": arrows and circles on a photo of the request (or a page of its PDF) with the
 * DS PhotoCapture (gap D21; the keyboard draws too), a note, and "Add to my comment". The marks go WITH the answer as an
 * overlay on the request's own copy; nothing is uploaded and nothing is sent until the answer is signed. One photo is
 * marked per answer: marking another one replaces it. Esc closes and gives the focus back (the DS Modal; a sheet on a phone).
 */
export function MarkPhotoDialog({ marking, actions }: { marking: MarkingState; actions?: ApproveActions }) {
  const t = useT('link-approve')
  const photoWords = usePhotoWords()
  const image = marking.image.status === 'ready' ? marking.image : null
  return (
    <Modal open sheet onClose={() => actions?.onMarkClose?.()} size="xl" title={t('mark.title', { name: marking.name })} footer={<Button onClick={() => actions?.onMarkClose?.()}>{t('mark.cancel')}</Button>}>
      <div className="fw-ap-mark">
        <p className="fw-ap-hint">{t(marking.target === 'pdf' ? 'mark.introPdf' : 'mark.introPicture')}</p>
        {marking.target === 'pdf' && (
          <div className="fw-ap-pages" role="group" aria-label={t('mark.pages')}>
            <Button size="sm" heldReason={marking.page <= 1 ? t('mark.held.firstPage') : null} onClick={() => actions?.onMarkPage?.(marking.page - 1)}>
              {t('mark.previousPage')}
            </Button>
            <span aria-live="polite">{marking.pages ? t('mark.pageOf', { page: marking.page, pages: marking.pages }) : t('mark.page', { page: marking.page })}</span>
            <Button size="sm" heldReason={marking.pages !== null && marking.page >= marking.pages ? t('mark.held.lastPage') : null} onClick={() => actions?.onMarkPage?.(marking.page + 1)}>
              {t('mark.nextPage')}
            </Button>
          </div>
        )}
        <Field label={t('mark.note')} hint={t('mark.noteHint')}>
          <Textarea value={marking.note} rows={2} limit={ANSWER_LIMITS.note} onChange={(event) => actions?.onMarkNote?.(event.target.value)} />
        </Field>
        {marking.image.status === 'loading' && (
          <p className="fw-ap-hint" role="status">
            <Spinner size={14} /> {t(marking.target === 'pdf' ? 'mark.loadingPage' : 'mark.loadingPicture')}
          </p>
        )}
        {marking.image.status === 'failed' && <Banner tone="danger" title={t('mark.problem')} />}
        {image && (
          <PhotoCapture
            key={`${image.src.length}-${marking.page}`}
            label={t('mark.surface', { name: marking.name })}
            defaultPhoto={{ src: image.src, width: image.width, height: image.height }}
            defaultMarks={marking.marks}
            markup
            guide="none"
            facesHint={false}
            useHeldReason={(marks) => {
              const held = markSaveHeld(marks)
              return held ? t(held) : null
            }}
            words={{ ...photoWords, usePhoto: t('mark.add') }}
            onCapture={(photo) => actions?.onMarkSave?.(photo.marks)}
          />
        )}
      </div>
    </Modal>
  )
}
