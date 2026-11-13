'use client'

import { useId } from 'react'
import { CalendarClock, Camera } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Kbd, Select, Spinner } from '@nexus/ui/primitives'
import { DateField, FileDropzone, Lightbox, Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { INTL_LOCALE } from '../../../../../lib/i18n/locales'
import { useSubmitKey } from '../../parts'
import { MTM_PHOTO_LIMITS } from '@nexus/factory-domain/sales/mtm-photos/rules'
import { dateHeld, deleteLine, fileProblem, MTM_PHOTO_VIEWS, uploadDateHeld, uploadHeld, type MtmPhotoView } from '../model'
import type { OfficePhotosActions, OfficePhotosModel, PhotoDialog } from '../use-photos'
import { useExtras } from '../words'

/**
 * The photos' pop-ups (B-W2b-371, XF2:01): Add a photo (which view; the photo, JPEG or PNG up to 15 MB, never its own file name
 * kept; its delete date when known, else 90 days after the garment ships), Change the delete date (a day from today on, today =
 * deleted within the hour; why, logged) and a photo opened (its stripped copy, in the DS Lightbox). ⌘↵ saves, Esc closes; every
 * save is held with why before the click. Fetches nothing.
 */
export function PhotoDialogs({ model, actions, riderName }: { model: OfficePhotosModel; actions?: OfficePhotosActions; riderName: string }) {
  const dialog = model.dialog
  if (dialog?.kind === 'upload') return <UploadDialog model={model} dialog={dialog} actions={actions} riderName={riderName} />
  if (dialog?.kind === 'date') return <DateDialog model={model} dialog={dialog} actions={actions} />
  if (dialog?.kind === 'open') return <OpenDialog dialog={dialog} actions={actions} riderName={riderName} />
  return null
}

function UploadDialog({ model, dialog, actions, riderName }: { model: OfficePhotosModel; dialog: Extract<PhotoDialog, { kind: 'upload' }>; actions?: OfficePhotosActions; riderName: string }) {
  const { t, say, locale } = useExtras()
  const ids = { view: useId(), day: useId() }
  const held = say(uploadHeld(model.photos, dialog.target.kind, model.can, model.offline) ?? fileProblem(dialog.file) ?? uploadDateHeld(dialog.deleteOn, model.today)) ?? (dialog.busy ? t('photo.working') : null)
  const onKey = useSubmitKey(true, !!held, () => actions?.onSave?.())
  return (
    <Modal
      open
      onClose={() => actions?.onClose?.()}
      size="md"
      title={t(dialog.target.kind === 'profile' ? 'photo.upload.title' : 'photo.upload.titleFitting')}
      subtitle={t('photo.upload.sub', { rider: riderName })}
      footer={
        <span className="fw-mtm-actions">
          <Button variant="secondary" onClick={() => actions?.onClose?.()}>
            {t('photo.cancel')}
          </Button>
          <Button variant="primary" heldReason={held} onClick={() => actions?.onSave?.()} aria-keyshortcuts="Meta+Enter">
            {dialog.busy ? <Spinner size={12} /> : <Camera size={14} aria-hidden />} {t('photo.upload.save')} <Kbd>⌘↵</Kbd>
          </Button>
        </span>
      }
    >
      <div className="fw-mtm-stack" onKeyDown={onKey}>
        {dialog.notice && <Banner tone={dialog.notice.tone} title={say(dialog.notice)} />}
        <p className="fw-mtm-hint">{t('photo.upload.privacy')}</p>
        <Field label={t('photo.upload.view')} required htmlFor={ids.view}>
          <Select id={ids.view} size="sm" value={dialog.view} onChange={(event) => actions?.onDraft?.({ view: event.target.value as MtmPhotoView })}>
            {MTM_PHOTO_VIEWS.map((view) => (
              <option key={view} value={view}>
                {t(`view.${view}`)}
              </option>
            ))}
          </Select>
        </Field>
        <FileDropzone accept="image/jpeg,image/png" maxBytes={MTM_PHOTO_LIMITS.maxBytes} onFiles={(files) => actions?.onDraft?.({ file: files[0] ?? null })} hint={t('photo.upload.hint')} disabled={dialog.busy} />
        {dialog.file && <p className="fw-mtm-hint">{t('photo.upload.picked', { size: Math.max(1, Math.round(dialog.file.size / 1024)) })}</p>}
        <Field label={t('photo.upload.deleteOn')} htmlFor={ids.day} hint={t('photo.upload.deleteOnHint')}>
          <DateField id={ids.day} value={dialog.deleteOn} min={model.today} onChange={(value) => actions?.onDraft?.({ deleteOn: value })} locale={INTL_LOCALE[locale]} ariaLabel={t('photo.upload.deleteOn')} />
        </Field>
      </div>
    </Modal>
  )
}

function DateDialog({ model, dialog, actions }: { model: OfficePhotosModel; dialog: Extract<PhotoDialog, { kind: 'date' }>; actions?: OfficePhotosActions }) {
  const { t, say, locale } = useExtras()
  const ids = { day: useId(), reason: useId() }
  const may = dialog.target.kind === 'profile' ? !!model.photos?.may.date : !!model.photos?.may.dateFitting
  const held = say(dateHeld(dialog, dialog.photo, model.today, may, model.offline)) ?? (dialog.busy ? t('photo.working') : null)
  const onKey = useSubmitKey(true, !!held, () => actions?.onSave?.())
  const today = dialog.day !== '' && dialog.day <= model.today
  return (
    <Modal
      open
      onClose={() => actions?.onClose?.()}
      size="sm"
      title={t('photo.date.title', { view: t(`view.${dialog.photo.view}`) })}
      footer={
        <span className="fw-mtm-actions">
          <Button variant="secondary" onClick={() => actions?.onClose?.()}>
            {t('photo.cancel')}
          </Button>
          <Button variant={today ? 'danger' : 'primary'} heldReason={held} onClick={() => actions?.onSave?.()} aria-keyshortcuts="Meta+Enter">
            {dialog.busy ? <Spinner size={12} /> : <CalendarClock size={14} aria-hidden />} {t(today ? 'photo.date.saveToday' : 'photo.date.save')} <Kbd>⌘↵</Kbd>
          </Button>
        </span>
      }
    >
      <div className="fw-mtm-stack" onKeyDown={onKey}>
        {dialog.notice && <Banner tone={dialog.notice.tone} title={say(dialog.notice)} />}
        <p className="fw-mtm-hint">{t('photo.date.now', { line: say(deleteLine(dialog.photo, model.today)) ?? '' })}</p>
        <Field label={t('photo.date.day')} required htmlFor={ids.day} hint={t('photo.date.dayHint')}>
          <DateField id={ids.day} value={dialog.day} min={model.today} onChange={(value) => actions?.onDraft?.({ day: value })} locale={INTL_LOCALE[locale]} ariaLabel={t('photo.date.day')} />
        </Field>
        <Button size="sm" variant="quiet" onClick={() => actions?.onDraft?.({ day: model.today })}>
          {t('photo.date.today')}
        </Button>
        <Field label={t('photo.date.why')} required htmlFor={ids.reason}>
          <Textarea id={ids.reason} rows={2} maxLength={MTM_PHOTO_LIMITS.reason} value={dialog.reason} onChange={(event) => actions?.onDraft?.({ reason: event.target.value })} />
        </Field>
      </div>
    </Modal>
  )
}

function OpenDialog({ dialog, actions, riderName }: { dialog: Extract<PhotoDialog, { kind: 'open' }>; actions?: OfficePhotosActions; riderName: string }) {
  const { t } = useExtras()
  const title = t(`view.${dialog.photo.view}`)
  if (!dialog.src)
    return (
      <Modal open onClose={() => actions?.onClose?.()} size="sm" title={title}>
        {dialog.problem ? (
          <Banner tone="danger" title={t('photo.problem.open')} />
        ) : (
          <p className="fw-mtm-hint" role="status">
            <Spinner size={12} /> {t('photo.opening')}
          </p>
        )}
      </Modal>
    )
  return <Lightbox open onClose={() => actions?.onClose?.()} items={[{ url: dialog.src, alt: t('photo.alt', { view: title, rider: riderName }) }]} index={0} onIndex={() => undefined} title={title} caption={t('photo.stripped')} />
}
