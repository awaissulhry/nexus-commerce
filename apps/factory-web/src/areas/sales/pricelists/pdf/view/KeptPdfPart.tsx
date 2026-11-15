'use client'

import { ExternalLink, FileText, Send } from 'lucide-react'
import { Banner, Card, Field, KeyValue } from '@nexus/ui/components'
import { Button, Input, SegmentedControl, Select, Spinner, Tag } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import { useFollowupsT } from '../../../_shared/cost-changed/words'
import type { PdfLanguage } from '../api'
import { keepHeld, sendHeld, sendOpenHeld, type KeptPdfModel, type SendDraft } from '../model'
import type { KeptPdfActions } from '../use-kept-pdf'
import '../pdf.css'

const LANGUAGES: readonly PdfLanguage[] = ['it', 'en']

/**
 * The price list PDF kept for mail (B-W2b-380, XF6:01), on the print page above the paper (never printed): the newest kept PDF
 * of the version shown (its number, language, who kept it and when, whether it still shows the version as it is), Open it,
 * Keep this version as a PDF in Italian or English, Send… (the newest showing the version as it is goes, the same file the
 * list keeps). Held buttons say why. It fetches nothing.
 */
export function KeptPdfPart({ model, actions }: { model: KeptPdfModel; actions?: KeptPdfActions }) {
  const t = useFollowupsT()
  const locale = useLocale()
  const head = (
    <div className="fw-plp-head">
      <h2 className="fw-plp-title">
        <FileText size={15} aria-hidden /> {t('pdf.title')}
      </h2>
      <p className="fw-plp-hint">{t('pdf.sub')}</p>
    </div>
  )
  if (!model.can.price) {
    return (
      <Card padded className="fw-plp-card" data-print-hide="">
        {head}
        <p className="fw-plp-hint">{t('pdf.held.noPrice')}</p>
      </Card>
    )
  }
  const read = model.read
  const value = read.status === 'ready' ? read.value : null
  const newest = value?.pdfs[0] ?? null
  const keep = keepHeld(model)
  const openSend = sendOpenHeld(model)
  return (
    <Card padded className="fw-plp-card" data-print-hide="">
      {head}
      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={t(model.notice.words.key, model.notice.words.params)}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismiss?.()}>
              {t('pdf.dismiss')}
            </Button>
          }
        />
      )}
      {read.status === 'loading' ? (
        <p className="fw-plp-hint" role="status">
          <Spinner size={14} /> {t('pdf.loading')}
        </p>
      ) : read.status === 'error' ? (
        <Banner
          tone="danger"
          title={t('pdf.failed')}
          action={
            <Button size="sm" onClick={() => actions?.onRetry?.()}>
              {t('pdf.retry')}
            </Button>
          }
        >
          {t(read.problem.key, read.problem.params)}
        </Banner>
      ) : read.status === 'none' ? (
        <p className="fw-plp-hint">{t('pdf.held.noVersion')}</p>
      ) : newest ? (
        <KeyValue
          columns={2}
          dense
          labelCase="sentence"
          items={[
            { label: t('pdf.newest'), value: newest.number ?? t('pdf.version', { version: newest.version }), hint: value?.upToDate === false ? undefined : t('pdf.upToDateHint') },
            { label: t('pdf.state'), value: value?.upToDate === false ? <Tag tone="warning">{t('pdf.outdated')}</Tag> : <Tag tone="success">{t('pdf.upToDate')}</Tag>, hint: value?.upToDate === false ? t('pdf.outdatedHint') : undefined },
            { label: t('pdf.language'), value: t(`pdf.lang.${newest.language === 'en' ? 'en' : 'it'}`) },
            { label: t('pdf.keptBy'), value: newest.createdBy ?? t('pdf.system'), hint: formatDateTime(newest.createdAt, { locale }) },
            { label: t('pdf.count'), value: String(value?.pdfs.length ?? 0) },
          ]}
        />
      ) : (
        <p className="fw-plp-hint">{t('pdf.none')}</p>
      )}
      <div className="fw-plp-actions">
        <SegmentedControl size="sm" ariaLabel={t('pdf.language')} value={model.language} onChange={(next) => actions?.onLanguage?.(next as PdfLanguage)} options={LANGUAGES.map((language) => ({ value: language, label: t(`pdf.lang.${language}`) }))} />
        <Button size="sm" variant={newest ? 'secondary' : 'primary'} heldReason={keep ? t(keep.key, keep.params) : null} onClick={() => actions?.onKeep?.()}>
          {model.busy ? <Spinner size={12} /> : <FileText size={13} aria-hidden />} {t(value?.upToDate === false || !newest ? 'pdf.keep' : 'pdf.keepAgain')}
        </Button>
        {newest && (
          <Button size="sm" variant="quiet" onClick={() => actions?.onOpen?.(newest.fileId)}>
            <ExternalLink size={13} aria-hidden /> {t('pdf.open')}
          </Button>
        )}
        <Button size="sm" variant={newest ? 'primary' : 'secondary'} heldReason={openSend ? t(openSend.key, openSend.params) : null} onClick={() => actions?.onSendOpen?.()}>
          <Send size={13} aria-hidden /> {t('pdf.send')}
        </Button>
      </div>
      {model.send && <SendPdfDialog draft={model.send} model={model} actions={actions} />}
    </Card>
  )
}

/** Send… : to, copies, subject, message; the newest PDF showing the version as it is goes attached (kept first when none does). */
function SendPdfDialog({ draft, model, actions }: { draft: SendDraft; model: KeptPdfModel; actions?: KeptPdfActions | undefined }) {
  const t = useFollowupsT()
  const locale = useLocale()
  const held = sendHeld(draft)
  const outdated = model.read.status === 'ready' && model.read.value.upToDate !== true
  const onClose = () => actions?.onSendClose?.()
  return (
    <Modal
      open
      onClose={onClose}
      title={t('pdf.sendTitle')}
      subtitle={t(outdated ? 'pdf.sendKeepsFirst' : 'pdf.sendNewest', { language: t(`pdf.lang.${model.language}`) })}
      size="md"
      footer={
        <>
          <Button onClick={onClose}>{t(draft.sent ? 'pdf.close' : 'pdf.cancel')}</Button>
          <Button variant="primary" heldReason={held ? t(held.key, held.params) : null} onClick={() => actions?.onSend?.()}>
            {draft.sending ? <Spinner size={12} /> : <Send size={13} aria-hidden />} {t('pdf.sendGo')}
          </Button>
        </>
      }
    >
      <div className="fw-plp-dialog">
        {draft.problem && <Banner tone="danger" title={t(draft.problem.key, draft.problem.params)} />}
        {draft.sent && <Banner tone="success" title={t('pdf.sentTo', { to: draft.sent.to, at: formatDateTime(draft.sent.at, { locale }) })} />}
        <Field label={t('pdf.customer')} hint={t('pdf.customerHint')}>
          <Select value={draft.partyId} onChange={(event) => actions?.onSendField?.('partyId', event.target.value)}>
            {model.customers.map((customer) => (
              <option key={customer.id} value={customer.id}>
                {customer.code} · {customer.legalName}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('pdf.to')} hint={t('pdf.toHint')}>
          <Input value={draft.to} onChange={(event) => actions?.onSendField?.('to', event.target.value)} inputMode="email" autoComplete="off" maxLength={2600} />
        </Field>
        <Field label={t('pdf.cc')} hint={t('pdf.ccHint')}>
          <Input value={draft.cc} onChange={(event) => actions?.onSendField?.('cc', event.target.value)} inputMode="email" autoComplete="off" maxLength={2600} />
        </Field>
        <Field label={t('pdf.subject')} hint={t('pdf.subjectHint')}>
          <Input value={draft.subject} onChange={(event) => actions?.onSendField?.('subject', event.target.value)} maxLength={200} />
        </Field>
        <Field label={t('pdf.message')} hint={t('pdf.messageHint')}>
          <Textarea value={draft.message} onChange={(event) => actions?.onSendField?.('message', event.target.value)} rows={4} maxLength={10_000} />
        </Field>
      </div>
    </Modal>
  )
}
