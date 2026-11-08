'use client'

import { Copy, FileCheck2, Link2, Mail, PenLine, Send } from 'lucide-react'
import { KIND_RULES } from '@nexus/factory-domain/approvals-out/kinds'
import { Banner, EmptyState, Field, KeyValue } from '@nexus/ui/components'
import { Button, Spinner, Tag } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime } from '../../../lib/i18n/format'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { WithMessages } from '../../i18n'
import type { OfficeRequest } from '../api'
import { ASK_LIMITS, askHeld, statusTone, withdrawHeld, type ApprovalsPanelActions, type ApprovalsPanelModel } from '../model'
import { AskDialog } from './AskDialog'
import '../approvals.css'

export type { ApprovalsPanelModel, ApprovalsPanelActions } from '../model'

/**
 * The record panels' Approvals tab (B-W2b-188; COL-064; "Ask a partner to approve"): the record's requests to its
 * partner, newest first — what was asked, by when, its state in words, the answer as signed (by link or in the portal,
 * with the marks on a photo), a withdrawal and who did it, the link and whether it was used — and "Ask a partner to
 * approve" (held with its reason: no right, the record's own reason from the API). Withdraw asks first. A link asked
 * without mail is shown ONCE with Copy. No money here. One view model, nothing fetched (use-approvals.ts loads it).
 */
export function ApprovalsPanel({ model, actions, title }: { model: ApprovalsPanelModel; actions?: ApprovalsPanelActions; title: string }) {
  return (
    <WithMessages namespaces={['record-approvals']}>
      <Panel model={model} actions={actions} title={title} />
    </WithMessages>
  )
}

function Panel({ model, actions, title }: { model: ApprovalsPanelModel; actions?: ApprovalsPanelActions; title: string }) {
  const t = useT('record-approvals')
  const held = askHeld(model)
  const heldReason = held ? ('key' in held ? t(held.key) : held.words) : model.busy ? t('held.busy') : null
  return (
    <div className="fw-ra">
      <div className="fw-ra-head">
        <p className="fw-ra-muted">{t('intro')}</p>
        <Button size="sm" variant="secondary" heldReason={heldReason} aria-haspopup="dialog" onClick={() => actions?.onAsk?.(true)}>
          <Send size={14} aria-hidden /> {t('ask.open')}
        </Button>
      </div>
      {model.link && (
        <Banner
          tone="info"
          title={t('link.title', { label: model.link.label })}
          action={
            <span className="fw-ra-actions">
              <Button size="sm" onClick={() => actions?.onCopyLink?.()}>
                <Copy size={14} aria-hidden /> {t('link.copy')}
              </Button>
              <Button size="sm" variant="quiet" onClick={() => actions?.onDismissLink?.()}>
                {t('link.dismiss')}
              </Button>
            </span>
          }
        >
          <span className="fw-ra-url">{model.link.url}</span>
          <span className="fw-ra-muted">{t('link.once')}</span>
        </Banner>
      )}
      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={t(model.notice.key, model.notice.params)}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
              {t('dismiss')}
            </Button>
          }
        />
      )}
      {model.read.status === 'loading' ? (
        <p className="fw-ra-muted" role="status">
          <Spinner size={14} /> {t('loading')}
        </p>
      ) : model.read.status === 'failed' ? (
        <Banner
          tone="danger"
          title={t(model.read.problem)}
          action={
            <Button size="sm" onClick={() => actions?.onRetry?.()}>
              {t('retry')}
            </Button>
          }
        />
      ) : model.read.requests.length === 0 ? (
        <EmptyState icon={<FileCheck2 size={22} aria-hidden />} title={t('empty.title')} description={model.read.held ?? t('empty.body')} />
      ) : (
        <ul className="fw-ra-list" aria-label={t('listLabel', { title })}>
          {model.read.requests.map((request) => (
            <RequestRow key={request.id} request={request} model={model} actions={actions} />
          ))}
        </ul>
      )}
      {model.ask && <AskDialog model={model} actions={actions} />}
      {model.withdraw && <WithdrawDialog model={model} actions={actions} />}
    </div>
  )
}

function RequestRow({ request, model, actions }: { request: OfficeRequest; model: ApprovalsPanelModel; actions?: ApprovalsPanelActions }) {
  const t = useT('record-approvals')
  const locale = useLocale()
  const at = (value: string) => formatDateTime(value, { locale, timeZone: model.timeZone })
  const answer = request.answer
  const link = request.links[0] ?? null
  const held = withdrawHeld(request, model.can.ask)
  const marks = answer?.markup ? answer.markup.shapes.length : 0
  return (
    <li className="fw-ra-item">
      <div className="fw-ra-item-head">
        {/* The kind and state in the reader's language (the office read answers them in English). */}
        <strong>{KIND_RULES[request.kind].name[locale]}</strong>
        <Tag tone={statusTone(request.status)}>{t(`status.${request.status}`)}</Tag>
        {request.status === 'OPEN' && <span className="fw-ra-muted">{t('row.dueBy', { date: formatDate(request.dueAt, { locale, timeZone: model.timeZone }) })}</span>}
        <span className="fw-ra-spacer" />
        {request.status === 'OPEN' && (
          <Button size="sm" variant="quiet" heldReason={held ? t(held) : model.busy ? t('held.busy') : null} aria-haspopup="dialog" onClick={() => actions?.onWithdraw?.(request.id)}>
            {t('withdraw.open')}
          </Button>
        )}
      </div>
      <p className="fw-ra-question">{request.question}</p>
      <KeyValue
        dense
        labelCase="sentence"
        columns={2}
        items={[
          { label: t('row.partner'), value: request.party.name || '—' },
          { label: t('row.asked'), value: request.askedBy ? t('row.askedBy', { name: request.askedBy, at: at(request.createdAt) }) : at(request.createdAt) },
          { label: t('row.due'), value: at(request.dueAt) },
          { label: t('row.files'), value: request.files.length > 0 ? request.files.map((file) => file.originalName).join(', ') : t('row.noFiles') },
          ...(link
            ? [
                {
                  label: t('row.link'),
                  value: (
                    <span className="fw-ra-inline">
                      {link.email ? <Mail size={14} aria-hidden /> : <Link2 size={14} aria-hidden />}
                      {link.email ? t('row.linkMailed', { email: link.email }) : t('row.linkGiven')}
                      {' · '}
                      {link.revoked ? t('row.linkRevoked') : link.used ? t('row.linkUsed') : t('row.linkUntil', { at: at(link.expiresAt) })}
                    </span>
                  ),
                },
              ]
            : []),
        ]}
      />
      {answer && (
        <div className="fw-ra-answer" role="group" aria-label={t('row.answer')}>
          <span>
            {t(answer.via === 'LINK' ? 'row.answeredLink' : 'row.answeredPortal', { name: answer.typedName, at: at(answer.at) })}
            {answer.personName ? ` · ${t('row.portalPerson', { name: answer.personName })}` : ''}
          </span>
          {answer.words && <q className="fw-ra-words">{answer.words}</q>}
          {answer.markup && (
            <span className="fw-ra-inline">
              <PenLine size={14} aria-hidden /> {answer.markup.page ? t('row.markedPage', { count: marks, page: answer.markup.page }) : t('row.marked', { count: marks })}
              {answer.markup.note ? ` — “${answer.markup.note}”` : ''}
            </span>
          )}
        </div>
      )}
      {request.withdrawn && (
        <p className="fw-ra-muted">
          {t('row.withdrawn', { name: request.withdrawn.byName ?? t('row.someone'), at: at(request.withdrawn.at) })}
          {request.withdrawn.reason ? ` — ${request.withdrawn.reason}` : ''}
        </p>
      )}
    </li>
  )
}

function WithdrawDialog({ model, actions }: { model: ApprovalsPanelModel; actions?: ApprovalsPanelActions }) {
  const t = useT('record-approvals')
  const locale = useLocale()
  const withdraw = model.withdraw!
  const request = model.read.status === 'ready' ? model.read.requests.find((item) => item.id === withdraw.requestId) : undefined
  return (
    <Modal
      open
      onClose={() => actions?.onWithdraw?.(null)}
      title={t('withdraw.title', { kind: request ? KIND_RULES[request.kind].name[locale] : '' })}
      size="sm"
      footer={
        <>
          <Button onClick={() => actions?.onWithdraw?.(null)}>{t('withdraw.keep')}</Button>
          <Button variant="danger" heldReason={model.busy ? t('held.busy') : null} onClick={() => actions?.onWithdrawConfirm?.()}>
            {t('withdraw.go')}
          </Button>
        </>
      }
    >
      <div className="fw-ra-dialog">
        <p className="fw-ra-muted">{t('withdraw.body', { partner: request?.party.name ?? '' })}</p>
        <Field label={t('withdraw.reason')} hint={t('withdraw.reasonHint')}>
          <Textarea value={withdraw.reason} rows={3} limit={ASK_LIMITS.reason} onChange={(event) => actions?.onWithdrawReason?.(event.target.value)} />
        </Field>
        {model.notice && model.notice.tone === 'danger' && <Banner tone="danger" title={t(model.notice.key)} />}
      </div>
    </Modal>
  )
}
