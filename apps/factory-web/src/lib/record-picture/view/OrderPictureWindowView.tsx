'use client'

import { useId } from 'react'
import { FileText, Image as ImageIcon, Shirt } from 'lucide-react'
import { Banner, type BannerProps } from '@nexus/ui/components'
import { Button, RadioCard } from '@nexus/ui/primitives'
import { FileDropzone, Modal } from '../../i18n/ds-parts'
import type { ReadPictures } from '../cache'
import type { PictureSource } from '../model'
import { PICTURE_ACCEPT, type OrderPictureView, type Phrase, type PictureOption } from '../order-picture'
import { usePictureWords } from '../words'
import { RecordPicture } from './RecordPicture'
import '../record-picture.css'
import '../order-picture.css'

/** The window's view model: the order in words, its picture as every list draws it, the choices (order-picture.ts). */
export interface OrderPictureWindowModel {
  readonly open: boolean
  /** The order's number in words ("Your order 12", "SO-2026-0142"). */
  readonly number: string
  readonly subject: string | null
  /** The record's picture as its lists draw it (the batch read answers the saved picture first, else the design). */
  readonly record: { readonly source: PictureSource; readonly recordId: string; readonly read?: ReadPictures | null; readonly demo?: string }
  readonly view: OrderPictureView
  /** The host gave an upload port: the field "A picture from your computer or phone" shows. */
  readonly canUpload: boolean
}

export interface OrderPictureWindowActions {
  readonly onClose: () => void
  readonly onPick: (value: string) => void
  readonly onFiles: (files: File[]) => void
  readonly onSave: () => void
}

const say = (t: (key: string, params?: Phrase['params']) => string, phrase: Phrase): string => t(phrase.key, phrase.params)

/**
 * owb-b4 w4.3 (design § 5zi E, § 5zj A; prototype oplus.js coverModal) — the window "The picture of the order": a centred DS Modal (a
 * sheet from the bottom on a phone) that says what the picture is now and who decides it, offers "A picture from your computer or
 * phone" first (when the host can upload) and then the choices as radios — "Use the design" (back to the design of the first line)
 * and every file of the order that may be the picture, each with its small picture and its kind. Choose, then Save (held, saying
 * why, while nothing changed, a save or an upload is out, or the version went stale). Cancel leaves it. It draws its model only.
 */
export function OrderPictureWindowView({ model, actions }: { model: OrderPictureWindowModel; actions: OrderPictureWindowActions }) {
  const t = usePictureWords()
  return (
    <Modal
      open={model.open}
      onClose={actions.onClose}
      title={t('window.title')}
      subtitle={model.subject ? t('window.subtitle', { number: model.number, subject: model.subject }) : model.number}
      size="md"
      sheet
      busy={model.view.busy !== 'idle'}
      closeHeld={model.view.closeHeld ? say(t, model.view.closeHeld) : null}
      footer={<OrderPictureWindowFoot view={model.view} actions={actions} />}
    >
      <OrderPictureWindowBody model={model} actions={actions} />
    </Modal>
  )
}

/** The window's body (exported for the design index and the tests: a Modal draws nothing on the server). */
export function OrderPictureWindowBody({ model, actions }: { model: OrderPictureWindowModel; actions: Pick<OrderPictureWindowActions, 'onPick' | 'onFiles'> }) {
  const t = usePictureWords()
  const name = useId()
  const { view } = model
  const refusal: BannerProps['tone'] = view.refusal?.key === 'window.refused.stale' ? 'warning' : 'danger'
  return (
    <div className="fw-opic">
      <section className="fw-opic-now" aria-label={t('window.nowLabel')}>
        <RecordPicture source={model.record.source} recordId={model.record.recordId} number={model.number} size="lineLarge" read={model.record.read} demo={model.record.demo} />
        <div className="fw-opic-now-words">
          <strong>{say(t, view.now)}</strong>
          <p>{t('window.who')}</p>
        </div>
      </section>

      {view.refusal ? <Banner tone={refusal}>{say(t, view.refusal)}</Banner> : null}

      {model.canUpload ? (
        <section className="fw-opic-up" aria-label={t('window.upload')} aria-busy={view.busy === 'uploading' || undefined}>
          <h3 className="fw-opic-head">{t('window.upload')}</h3>
          <FileDropzone accept={PICTURE_ACCEPT} onFiles={actions.onFiles} disabled={view.busy !== 'idle'} hint={t('window.uploadHint')} />
          {view.busy === 'uploading' ? <p role="status" className="fw-opic-status">{t('window.uploading')}</p> : null}
        </section>
      ) : null}

      <fieldset className="fw-opic-choices">
        <legend className="fw-opic-head">{t('window.choose')}</legend>
        {view.options.map((option) => (
          <RadioCard
            key={option.value}
            name={name}
            value={option.value}
            checked={option.checked}
            selected={option.checked}
            onChange={() => actions.onPick(option.value)}
            title={
              <span className="fw-opic-option">
                <OptionMark option={option} />
                <span className="fw-opic-option-name">{option.words ? say(t, option.words) : option.choice?.name}</span>
                {option.isNow ? <span className="fw-opic-now-tag">{t('window.isNow')}</span> : null}
              </span>
            }
            description={say(t, option.hint)}
          />
        ))}
        {view.noFiles ? <p className="fw-opic-status">{t('window.noFiles')}</p> : null}
      </fieldset>
    </div>
  )
}

/** The window's foot: Cancel and Save (held with its reason). */
export function OrderPictureWindowFoot({ view, actions }: { view: OrderPictureView; actions: Pick<OrderPictureWindowActions, 'onClose' | 'onSave'> }) {
  const t = usePictureWords()
  return (
    <>
      <Button variant="secondary" onClick={actions.onClose} heldReason={view.closeHeld ? say(t, view.closeHeld) : null}>
        {t('window.cancel')}
      </Button>
      <Button variant="primary" onClick={actions.onSave} heldReason={view.saveHeld ? say(t, view.saveHeld) : null}>
        {view.busy === 'saving' ? t('window.saving') : t('window.save')}
      </Button>
    </>
  )
}

/** A choice's small picture: its preview, else the mark of its kind; the design: the shirt mark. */
function OptionMark({ option }: { option: PictureOption }) {
  const choice = option.choice
  if (choice?.small) {
    return (
      <span className="fw-rpic fw-rpic-line-large" aria-hidden>
        <img src={choice.small.url} alt="" loading="lazy" />
      </span>
    )
  }
  const Mark = !choice ? Shirt : choice.kind === 'pdf' ? FileText : ImageIcon
  return (
    <span className="fw-rpic fw-rpic-line-large fw-rpic-none" aria-hidden>
      <Mark size={24} aria-hidden />
    </span>
  )
}
