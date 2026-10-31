'use client'

import Link from 'next/link'
import { CheckCircle2, Mail, XCircle } from 'lucide-react'
import { Banner, Card, DateTimeField, Field, Modal } from '@nexus/ui/components'
import { Button, Pill, Spinner, Tag, Textarea } from '@nexus/ui/primitives'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { cardHeld, cardsBySupplier, outcomeWords, sendManyBody } from '../../daily-model'
import type { OrdersListActions, OrdersListModel } from '../../model'
import { useSay } from '../../record/view/DailyDialogs'
import '../../daily.css'

const dateLocale = (locale: string) => (locale === 'it' ? 'it-IT' : 'en-GB')

/**
 * Send n (B-W2a-69; design purchasing.orders grid "Bulk: Send n — the Send dialog with several suppliers", pop:send "one
 * card per supplier"): one card per supplier with its drafts — each with who receives it, its language, the confirm-by
 * time (default 48 h, longer by the supplier's closed days; editable per order), a later revision's changes in the
 * supplier's words, or why it does not go (a blocking check, not a draft any more) — one message for all, then each order
 * its own send (one key for the dialog). The result says per order sent to whom, or why not.
 */
export function SendManyDialog({ model, actions }: { model: OrdersListModel; actions?: OrdersListActions }) {
  const t = useT('purchasing-orders')
  const tb = useT('buying')
  const say = useSay()
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const dialog = model.sendMany!
  const cards = dialog.cards.status === 'ready' ? dialog.cards.value : []
  const supplierName = (partyId: string | null) => (partyId ? (model.rows.items?.find((row) => row.partyId === partyId)?.supplierName ?? t('sendMany.supplier')) : t('sendMany.supplier'))
  const groups = cardsBySupplier(cards, supplierName)
  const going = sendManyBody(cards, dialog.confirmBy)
  const held = dialog.sending ? tb('held.busy') : dialog.cards.status !== 'ready' ? t('sendMany.held.reading') : !model.can.poSend ? tb('held.noSend') : model.live === 'offline' ? t('sendMany.held.offline') : going.length === 0 ? t('sendMany.held.none') : null
  const close = () => actions?.onSendMany?.(null)

  if (dialog.outcomes) {
    const sent = dialog.outcomes.filter((outcome) => outcome.outcome === 'SENT').length
    return (
      <Modal open onClose={close} title={t('sendMany.doneTitle', { count: sent })} size="lg" footer={<Button size="sm" variant="primary" onClick={close}>{tb('common.done')}</Button>}>
        <div className="fw-by-dialog">
          <ul className="fw-po-card-orders">
            {dialog.outcomes.map((outcome) => (
              <li key={outcome.id} className="fw-by-check">
                {outcome.outcome === 'SENT' ? <CheckCircle2 size={16} className="fw-by-ico is-ok" aria-hidden /> : <XCircle size={16} className="fw-by-ico is-blocked" aria-hidden />}
                <span className="fw-by-check-body">
                  <Link className="fw-by-link" href={`${model.prefix}/purchasing/orders/${outcome.id}`}>
                    {outcome.number ?? t('sendMany.order')}
                  </Link>{' '}
                  {say(outcomeWords(outcome))}
                  {outcome.sent?.confirmBy && <span className="fw-by-hint"> · {t('sendMany.answerBy', { time: formatDateTime(outcome.sent.confirmBy, place) })}</span>}
                </span>
              </li>
            ))}
          </ul>
          <p className="fw-by-hint">{t('sendMany.fake')}</p>
        </div>
      </Modal>
    )
  }

  return (
    <Modal
      open
      onClose={close}
      title={t('sendMany.title', { count: dialog.orderIds.length })}
      subtitle={t('sendMany.subtitle')}
      size="xl"
      footer={
        <>
          <span className="grow" />
          <Button size="sm" onClick={close} heldReason={dialog.sending ? tb('held.busy') : null}>
            {tb('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={held} onClick={() => actions?.sendMany?.onSend?.()}>
            {dialog.sending ? <Spinner size={12} /> : <Mail size={14} aria-hidden />} {t('sendMany.confirm', { count: going.length })}
          </Button>
        </>
      }
    >
      <div className="fw-by-dialog">
        {dialog.cards.status === 'loading' ? (
          <p className="fw-by-hint" role="status">
            <Spinner size={14} /> {t('sendMany.reading')}
          </p>
        ) : dialog.cards.status === 'error' ? (
          <Banner
            tone="danger"
            title={t('sendMany.readFailed')}
            action={
              <Button size="sm" onClick={() => actions?.sendMany?.onRetry?.()}>
                {tb('common.retry')}
              </Button>
            }
          >
            {tb(dialog.cards.problem)}
          </Banner>
        ) : (
          <div className="fw-po-cards">
            {groups.map((group) => (
              <Card key={group.partyId ?? group.cards[0]!.id} padded>
                <div className="fw-by-stack">
                  <h3 className="fw-by-h3">{group.name}</h3>
                  <ul className="fw-po-card-orders">
                    {group.cards.map((card) => {
                      const why = say(cardHeld(card))
                      return (
                        <li key={card.id} className="fw-po-card-order">
                          <span className="fw-by-inline">
                            <b>{card.documentNumber ?? card.number ?? t('sendMany.order')}</b>
                            {why ? <Pill tone="warning">{t('sendMany.stays')}</Pill> : <Pill tone="success">{t('sendMany.goes')}</Pill>}
                            {(card.revision ?? 1) > 1 && <Tag tone="neutral">{tb('po.record.revision', { revision: card.revision ?? 1 })}</Tag>}
                          </span>
                          {why ? (
                            <span className="fw-by-hint">{why}</span>
                          ) : (
                            <>
                              <span className="fw-by-hint">{t('sendMany.to', { name: card.recipient?.name ?? '—', email: card.recipient?.email ?? '—', language: t(`language.${card.language ?? 'it'}`) })}</span>
                              <Field label={t('send.confirmBy')} hint={card.confirmBy ? t('send.confirmByHint', { time: formatDateTime(card.confirmBy, place) }) : t('send.confirmByHintNone')}>
                                <DateTimeField
                                  value={dialog.confirmBy[card.id] || card.confirmBy || ''}
                                  onChange={(value) => actions?.sendMany?.onConfirmBy?.(card.id, value)}
                                  min={model.now ?? undefined}
                                  locale={dateLocale(locale)}
                                  ariaLabel={t('sendMany.confirmByOf', { number: card.number ?? '' })}
                                  disabled={dialog.sending}
                                />
                              </Field>
                              {card.changes && card.changes.length > 0 && (
                                <div className="fw-by-stack">
                                  <span className="fw-by-hint">{t('send.changesTold', { revision: card.revision ?? 2 })}</span>
                                  <ul className="fw-by-list">
                                    {card.changes.map((line) => (
                                      <li key={line}>{line}</li>
                                    ))}
                                  </ul>
                                </div>
                              )}
                            </>
                          )}
                        </li>
                      )
                    })}
                  </ul>
                </div>
              </Card>
            ))}
          </div>
        )}
        <Field label={t('sendMany.message')} hint={t('sendMany.messageHint')}>
          <Textarea rows={3} maxLength={2000} value={dialog.message} onChange={(event) => actions?.sendMany?.onMessage?.(event.target.value)} readOnly={dialog.sending} />
        </Field>
        <ul className="fw-by-list">
          <li>{t('sendMany.eachOwn')}</li>
          <li>{t('sendMany.link')}</li>
          <li>{t('sendMany.reminder')}</li>
        </ul>
        {dialog.problem && <Banner tone="danger" title={say(dialog.problem) ?? ''} />}
      </div>
    </Modal>
  )
}
