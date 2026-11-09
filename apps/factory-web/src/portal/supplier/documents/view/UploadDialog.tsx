'use client'

import { FileText, X } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Input, RadioCard } from '@nexus/ui/primitives'
import { DateField, FileDropzone, Modal, Textarea } from '../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { CATEGORIES, kindKey, LIMITS, NS, sizeWords, UPLOAD_ACCEPT, UPLOAD_MAX_BYTES, type PickedFile, type UploadDraft, type UploadField, type UploadTarget } from '../model'

/**
 * pop:upload — "Upload a document" (B-W2b-193; design portal.supplier.documents pop:upload, from the band's primary or a
 * "We ask for" row): kind · issuer · number · issued · expires · the file · for which articles or lots (+ a note), then
 * "Send for review". It says what it answers (the request, the record, the document it replaces) and that we check it
 * before it counts. Esc closes and gives the focus back to the opener; Tab stays inside (the DS Modal). The send is three
 * steps (announce, the bytes to the store, the confirm): the pop-up is held while it runs.
 */

export interface UploadDialogModel {
  target: UploadTarget
  draft: UploadDraft
  file: PickedFile | null
  problems: Partial<Record<UploadField, string>>
  showProblems: boolean
  sending: boolean
  /** A refusal of the send (a key), or null. */
  failed: string | null
  /** Why Send waits (a held key: a preview, no connection, the right to upload), or null. */
  held: string | null
  /** The site's day (`YYYY-MM-DD`): issued not after it, expiring not before it. */
  today: string
}

export interface UploadDialogActions {
  onField?: (field: keyof UploadDraft, value: string) => void
  onFile?: (file: File | null) => void
  onSend?: () => void
  onClose?: () => void
}

export function UploadDialog({ model, heldWords, actions }: { model: UploadDialogModel; heldWords: string | null; actions?: UploadDialogActions | undefined }) {
  const t = useT(NS)
  const locale = useLocale()
  const problem = (field: UploadField) => (model.showProblems && model.problems[field] ? t(model.problems[field]!, { max: LIMITS.codes }) : undefined)
  const close = () => actions?.onClose?.()
  const target = model.target
  return (
    <Modal
      open
      onClose={close}
      sheet
      size="lg"
      title={target.replacesFileId ? t('upload.titleReplace') : t('upload.title')}
      subtitle={t('upload.for', { what: t(target.for.key, target.for.params) })}
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={model.sending}>
            {t('upload.cancel')}
          </Button>
          <Button variant="primary" heldReason={model.sending ? t('upload.sending') : heldWords} onClick={() => actions?.onSend?.()}>
            {t('upload.send')}
          </Button>
        </>
      }
    >
      <form
        className="fw-psdoc-dialog"
        onSubmit={(event) => {
          event.preventDefault()
          actions?.onSend?.()
        }}
      >
        <Banner tone="info">{target.replaces ? t('upload.checkReplace', { name: target.replaces }) : t('upload.check')}</Banner>
        <fieldset className="fw-psdoc-kinds">
          <legend className="fw-psdoc-strong">{t('upload.kind')}</legend>
          {CATEGORIES.map((category) => (
            <RadioCard key={category} name="fw-psdoc-kind" value={category} checked={model.draft.category === category} selected={model.draft.category === category} onChange={() => actions?.onField?.('category', category)} title={t(kindKey(category))} description={t(`upload.kindHint.${category}`)} />
          ))}
          {problem('category') ? <p className="fw-psdoc-problem">{problem('category')}</p> : null}
        </fieldset>
        <div className="fw-psdoc-file">
          <span className="fw-psdoc-strong">{t('upload.file')}</span>
          {model.file ? (
            <div className="fw-psdoc-picked">
              <FileText size={18} aria-hidden />
              <span className="fw-psdoc-picked-name">{model.file.name}</span>
              <span className="fw-psdoc-muted">{sizeWords(model.file.size, locale)}</span>
              <Button size="sm" variant="quiet" disabled={model.sending} aria-label={t('upload.removeFile', { name: model.file.name })} onClick={() => actions?.onFile?.(null)}>
                <X size={14} aria-hidden /> {t('upload.remove')}
              </Button>
            </div>
          ) : (
            <FileDropzone accept={UPLOAD_ACCEPT} maxBytes={UPLOAD_MAX_BYTES} hint={t('upload.fileHint')} disabled={model.sending} onFiles={(files) => actions?.onFile?.(files[0] ?? null)} />
          )}
          {problem('file') ? <p className="fw-psdoc-problem">{problem('file')}</p> : null}
        </div>
        <div className="fw-psdoc-pair">
          <Field label={t('upload.issuer')} hint={t('upload.issuerHint')} error={problem('issuer')}>
            <Input value={model.draft.issuer} maxLength={LIMITS.issuer} autoComplete="off" onChange={(event) => actions?.onField?.('issuer', event.target.value)} />
          </Field>
          <Field label={t('upload.number')} error={problem('number')}>
            <Input value={model.draft.number} maxLength={LIMITS.number} autoComplete="off" onChange={(event) => actions?.onField?.('number', event.target.value)} />
          </Field>
        </div>
        <div className="fw-psdoc-pair">
          <Field label={t('upload.issued')} error={problem('issuedOn')}>
            <DateField value={model.draft.issuedOn} max={model.today} clearable onChange={(value) => actions?.onField?.('issuedOn', value)} />
          </Field>
          <Field label={t('upload.expires')} hint={t('upload.expiresHint')} error={problem('expiresOn')}>
            <DateField value={model.draft.expiresOn} min={model.today} clearable onChange={(value) => actions?.onField?.('expiresOn', value)} />
          </Field>
        </div>
        <div className="fw-psdoc-pair">
          <Field label={t('upload.articles')} hint={t('upload.codesHint')} error={problem('articles')}>
            <Input value={model.draft.articles} autoComplete="off" onChange={(event) => actions?.onField?.('articles', event.target.value)} />
          </Field>
          <Field label={t('upload.lots')} hint={t('upload.codesHint')} error={problem('lots')}>
            <Input value={model.draft.lots} autoComplete="off" onChange={(event) => actions?.onField?.('lots', event.target.value)} />
          </Field>
        </div>
        <Field label={t('upload.note')} hint={t('upload.noteHint')} error={problem('note')}>
          <Textarea value={model.draft.note} rows={2} maxLength={LIMITS.note} onChange={(event) => actions?.onField?.('note', event.target.value)} />
        </Field>
        {model.failed ? <Banner tone="danger">{t(model.failed)}</Banner> : null}
      </form>
    </Modal>
  )
}
