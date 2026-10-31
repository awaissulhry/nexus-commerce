'use client'

import { useMemo, type ReactNode } from 'react'
import { AlertTriangle, CheckCircle2, ExternalLink, Mail, XCircle } from 'lucide-react'
import { Banner, Field, KeyValue, Modal } from '@nexus/ui/components'
import { PdfViewer } from '@nexus/ui/components/PdfViewer/index'
import { Button, Input, Kbd, Spinner, Tag, Textarea } from '@nexus/ui/primitives'
import { formatDate, formatDateTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { pdfViewerLabels } from '../../../../lib/pdf/labels'
import { WithMessages } from '../../../../record-panels/i18n'
import { orderedChecks, parseCc, sendHeld, type DocumentSendActions, type DocumentSendModel, type SendCheckItem } from '../model'
import '../document-send.css'

export type { DocumentSendModel, DocumentSendActions } from '../model'

const CHECK_ICON: Record<SendCheckItem['state'], ReactNode> = {
  blocks: <XCircle size={16} aria-hidden className="fw-send-ico is-blocks" />,
  warning: <AlertTriangle size={16} aria-hidden className="fw-send-ico is-warning" />,
  passes: <CheckCircle2 size={16} aria-hidden className="fw-send-ico is-passes" />,
}

/**
 * SCR-037 — send a document (the shared part; design shell.preview + the quote's `quotes.send`): left, who it goes to,
 * the copies, subject and message, what the recipient can do, the checks (blocking first, each with its Fix link) and
 * the words about what freezes; right, the PDF exactly as it leaves (also "Open in new tab"). Send is held with the first
 * blocking check's reason, never silently disabled; ⌘↵ sends; Esc closes and keeps the draft. After the send the dialog
 * shows the result: to whom, when, how long the link lives — or that the mail failed, with "Send a new link".
 */
export function DocumentSendView({ open, model, actions, extra }: { open: boolean; model: DocumentSendModel; actions?: DocumentSendActions; extra?: ReactNode }) {
  return (
    <WithMessages namespaces={['send']}>
      <DocumentSend open={open} model={model} actions={actions} extra={extra} />
    </WithMessages>
  )
}

/** The design index's cases: one model per language, so each language shows the host's own words too. */
export type DocumentSendPreviewModel = Readonly<Record<'it' | 'en', DocumentSendModel>>

/** The design index's frame of the dialog: open, with the model of the frame's language (SCR-037 fixtures). */
export function DocumentSendPreview({ model }: { model: DocumentSendPreviewModel }) {
  const locale = useLocale()
  return <DocumentSendView open model={model[locale]} />
}

/** `extra`: the host's own fields of this send, below the message (B-W2a-69: a purchase order's confirm-by and change note). */
function DocumentSend({ open, model, actions, extra }: { open: boolean; model: DocumentSendModel; actions?: DocumentSendActions; extra?: ReactNode }) {
  const t = useT('send')
  const shell = useT('shell')
  const locale = useLocale()
  const cc = useMemo(() => parseCc(model.fields.cc), [model.fields.cc])
  const held = sendHeld(model, cc.invalid, {
    loading: t('held.loading'),
    busy: t('held.busy'),
    noRight: t('held.noRight'),
    noEmail: t('held.noEmail'),
    cc: (list) => t('held.cc', { list }),
    sent: t('held.sent'),
  })
  const send = () => {
    if (!held) actions?.onSend?.()
  }
  const place = { locale, timeZone: model.timeZone }

  return (
    <Modal
      open={open}
      onClose={() => actions?.onClose?.()}
      title={model.title}
      subtitle={model.documentLabel}
      size="xxl"
      footer={
        model.result ? (
          <Button variant="primary" onClick={() => actions?.onClose?.()}>
            {t('close')}
          </Button>
        ) : (
          <>
            <Button onClick={() => actions?.onClose?.()}>{t('cancel')}</Button>
            <Button variant="primary" heldReason={held} onClick={send} aria-keyshortcuts="Meta+Enter Control+Enter">
              <Mail size={14} aria-hidden /> {model.sending ? t('sending') : t('send')}
              <span className="fw-send-keys" aria-hidden>
                <Kbd>⌘</Kbd>
                <Kbd>↵</Kbd>
              </span>
            </Button>
          </>
        )
      }
    >
      <div
        className="fw-send"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            send()
          }
        }}
      >
        <div className="fw-send-form">
          {model.result ? (
            <Result model={model} actions={actions} />
          ) : (
            <>
              <section className="fw-send-section" aria-label={t('to.label')}>
                <KeyValue
                  dense
                  labelCase="sentence"
                  items={[
                    {
                      label: t('to.label'),
                      value: model.recipient ? (
                        <span className="fw-send-to">
                          <strong>{model.recipient.name}</strong>
                          <span>{model.recipient.email ?? t('to.noEmail')}</span>
                        </span>
                      ) : (
                        t('to.none')
                      ),
                    },
                    { label: t('language'), value: t(`languageName.${model.language}`) },
                    { label: t('how.label'), value: model.how.kind === 'acceptLink' ? (model.how.until ? t('how.acceptLinkUntil', { date: formatDate(model.how.until, place) }) : t('how.acceptLink')) : t('how.pdfOnly') },
                  ]}
                />
                <Field label={t('cc.label')} hint={t('cc.hint')} error={cc.invalid.length > 0 ? t('cc.invalid', { list: cc.invalid.join(', ') }) : undefined}>
                  <Input value={model.fields.cc} onChange={(event) => actions?.onField?.('cc', event.target.value)} placeholder={t('cc.placeholder')} inputMode="email" autoComplete="off" readOnly={!model.canSend || model.sending} />
                </Field>
                <Field label={t('subject')}>
                  <Input value={model.fields.subject} onChange={(event) => actions?.onField?.('subject', event.target.value)} maxLength={200} readOnly={!model.canSend || model.sending} />
                </Field>
                <Field label={t('message.label')} hint={t('message.hint')}>
                  <Textarea value={model.fields.message} onChange={(event) => actions?.onField?.('message', event.target.value)} rows={6} maxLength={4000} readOnly={!model.canSend || model.sending} />
                </Field>
                {extra}
              </section>

              {model.recipientCan.length > 0 && (
                <section className="fw-send-section" aria-labelledby="fw-send-can">
                  <h3 id="fw-send-can" className="fw-send-h">
                    {t('recipientCan')}
                  </h3>
                  <ul className="fw-send-list">
                    {model.recipientCan.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </section>
              )}

              <section className="fw-send-section" aria-labelledby="fw-send-checks">
                <h3 id="fw-send-checks" className="fw-send-h">
                  {t('checks.title')}
                </h3>
                {model.checks.status === 'loading' ? (
                  <p className="fw-send-hint" role="status">
                    <Spinner size={14} /> {t('checks.loading')}
                  </p>
                ) : model.checks.status === 'error' ? (
                  <Banner tone="danger" title={model.checks.problem} action={<Button size="sm" onClick={() => actions?.onRetryChecks?.()}>{t('retry')}</Button>} />
                ) : (
                  <ul className="fw-send-checks">
                    {orderedChecks(model.checks.items).map((item) => (
                      <li key={item.id} className={`fw-send-check is-${item.state}`}>
                        {CHECK_ICON[item.state]}
                        <span className="fw-send-check-text">
                          <span className="fw-sr">{t(`checks.state.${item.state}`)}: </span>
                          {item.label}
                        </span>
                        {item.fix && item.state !== 'passes' && (
                          <a className="fw-send-fix" href={item.fix.href}>
                            {item.fix.label}
                          </a>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <p className="fw-send-freeze">{model.freezeNote}</p>
              {model.problem && <Banner tone="danger" title={model.problem} />}
            </>
          )}
        </div>

        <div className="fw-send-preview">
          <div className="fw-send-preview-head">
            <h3 className="fw-send-h">{t('preview.title')}</h3>
            {model.preview.openHref && (
              <Button size="sm" variant="quiet" asChild>
                <a href={model.preview.openHref} target="_blank" rel="noopener">
                  <ExternalLink size={14} aria-hidden /> {t('preview.newTab')}
                </a>
              </Button>
            )}
          </div>
          {model.preview.problem ? (
            <Banner tone="warning" title={model.preview.problem} />
          ) : model.preview.src ? (
            <PdfViewer src={model.preview.src} title={model.documentLabel} fileName={model.preview.fileName} labels={pdfViewerLabels(shell)} height="min(62vh, 680px)" />
          ) : (
            <p className="fw-send-hint" role="status">
              <Spinner size={14} /> {t('preview.loading')}
            </p>
          )}
          {model.result && <p className="fw-send-hint">{t('preview.sentNote', { time: formatDateTime(model.result.at, place) })}</p>}
        </div>
      </div>
    </Modal>
  )
}

function Result({ model, actions }: { model: DocumentSendModel; actions?: DocumentSendActions }) {
  const t = useT('send')
  const locale = useLocale()
  const result = model.result!
  const place = { locale, timeZone: model.timeZone }
  const failed = result.delivery === 'failed'
  return (
    <div className="fw-send-result" role="status">
      <Banner tone={failed ? 'danger' : 'success'} title={failed ? t('result.failedTitle') : t('result.sentTitle')}>
        {failed ? t('result.failedBody', { to: result.to }) : t('result.sentBody', { to: result.to, time: formatDateTime(result.at, place) })}
      </Banner>
      <KeyValue
        dense
        labelCase="sentence"
        items={[
          { label: t('to.label'), value: result.to },
          { label: t('result.at'), value: formatDateTime(result.at, place) },
          ...(result.linkUntil ? [{ label: t('result.linkUntil'), value: formatDate(result.linkUntil, place) }] : []),
          { label: t('result.delivery'), value: <Tag tone={failed ? 'danger' : result.delivery === 'retry' ? 'warning' : 'success'}>{t(`result.state.${result.delivery ?? 'settled'}`)}</Tag> },
        ]}
      />
      <p className="fw-send-hint">{t('result.linkNote')}</p>
      {failed && actions?.onNewLink && (
        <Button size="sm" onClick={() => actions.onNewLink?.()}>
          {t('result.newLink')}
        </Button>
      )}
    </div>
  )
}
