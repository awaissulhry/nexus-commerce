'use client'

import { ArrowRight, CheckCircle2, Clock, Link2, XCircle } from 'lucide-react'
import { Banner, Card, KeyValue, SummaryTable } from '@nexus/ui/components'
import { Button, Pill, Tag } from '@nexus/ui/primitives'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { dayAt, quantity } from '../../../../_shared/buying/model'
import type { PurchaseOrder, SupplierAnswer } from '../../api'
import type { OrderRecordActions, OrderRecordModel } from '../../model'
import { PartState } from './OrderRecordView'

/**
 * Supplier's answer (SCR-059 "Confirmations & changes"; B-W1-31): what came back on the confirm link — confirmed as
 * asked (who typed their name, their reference and note), declined (when), or changes proposed per line (asked →
 * proposed: a later or earlier date, less or more, two deliveries, cannot deliver, with their reason) and the buyer's
 * decision (P2: the buyer always accepts or refuses; accepting makes the proposal the confirmation, refusing sends the
 * order back to "waiting" for a new link). Below: each confirm link with its state, and the link's evidence.
 */
export function AnswerTab({ order, model, actions }: { order: PurchaseOrder; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('buying')
  if (!model.answer.value) return <PartState problem={model.answer.problem} onRetry={() => actions?.onRetryPart?.('answer')} label={t('po.tab.answer')} />
  return <Answer answer={model.answer.value} order={order} model={model} actions={actions} />
}

function Answer({ answer, order, model, actions }: { answer: SupplierAnswer; order: PurchaseOrder; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('buying')
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const q = (value: string | null | undefined) => quantity(value, locale)
  const proposal = answer.proposal
  const waiting = answer.answer === 'WAITING'
  const live = answer.links.find((link) => link.state === 'LIVE') ?? null

  const head = (() => {
    switch (answer.answer) {
      case 'NOT_SENT':
        return { tone: 'neutral' as const, icon: <Clock size={18} className="fw-by-ico" aria-hidden />, words: t('po.answer.notSent') }
      case 'WAITING':
        return { tone: 'info' as const, icon: <Clock size={18} className="fw-by-ico" aria-hidden />, words: live ? t('po.answer.waitingUntil', { supplier: order.supplier.name, sent: order.sentAt ? formatDateTime(order.sentAt, place) : '—', date: formatDate(live.expiresAt, place) }) : t('po.answer.waitingNoLink', { supplier: order.supplier.name }) }
      case 'CONFIRMED':
        return {
          tone: 'success' as const,
          icon: <CheckCircle2 size={18} className="fw-by-ico is-ok" aria-hidden />,
          words:
            answer.confirmation?.via === 'LINK'
              ? answer.confirmation.byName
                ? t('po.answer.confirmedByName', { name: answer.confirmation.byName, date: formatDateTime(answer.confirmation.at, place) })
                : t('po.answer.confirmedLink', { date: formatDateTime(answer.confirmation.at, place) })
              : t('po.answer.confirmedOffice', { date: answer.confirmation ? formatDateTime(answer.confirmation.at, place) : '—' }),
        }
      case 'DECLINED':
        return { tone: 'danger' as const, icon: <XCircle size={18} className="fw-by-ico is-blocked" aria-hidden />, words: t('po.answer.declined', { date: answer.decline ? formatDateTime(answer.decline.at, place) : '—' }) }
      case 'CHANGES_PROPOSED':
        return { tone: 'warning' as const, icon: <ArrowRight size={18} className="fw-by-ico is-warning" aria-hidden />, words: t('po.answer.proposed', { name: proposal?.byName ?? order.supplier.name, date: proposal ? formatDateTime(proposal.at, place) : '—' }) }
      default:
        return { tone: 'neutral' as const, icon: <CheckCircle2 size={18} className="fw-by-ico" aria-hidden />, words: t('po.answer.closed', { status: t(`poStatus.${answer.status}`) }) }
    }
  })()

  const changeWords = (changes: readonly string[]) => (changes.length === 0 ? t('po.answer.asAsked') : changes.map((change) => t(`po.answer.change.${change}`)).join(' · '))

  return (
    <div className="fw-by-stack">
      <Card padded>
        <div className="fw-by-stack">
          <div className="fw-by-card-head">
            <h3 className="fw-by-h3">
              {head.icon} {head.words}
            </h3>
            {answer.answer === 'NOT_SENT' && (
              <Button size="sm" variant="primary" heldReason={model.can.poSend ? null : t('held.noSend')} onClick={() => actions?.onDialog?.({ kind: 'send' })}>
                {t('po.step.send')}
              </Button>
            )}
            {answer.answer === 'CHANGES_PROPOSED' && (
              <span className="fw-by-actions">
                <Button size="sm" heldReason={model.can.poSend ? null : t('held.noSend')} onClick={() => actions?.onDialog?.({ kind: 'refuse', note: '' })}>
                  {t('po.answer.refuse')}
                </Button>
                <Button size="sm" variant="primary" heldReason={model.can.poSend ? null : t('held.noSend')} onClick={() => actions?.onDialog?.({ kind: 'accept', message: '' })}>
                  {t('po.answer.accept')}
                </Button>
              </span>
            )}
            {(waiting || answer.answer === 'DECLINED') && model.can.poSend && (
              <Button size="sm" onClick={() => actions?.onDialog?.({ kind: 'newLink', message: '' })}>
                <Link2 size={13} aria-hidden /> {t('po.step.newLink')}
              </Button>
            )}
          </div>
          {(answer.confirmation || proposal) && (
            <KeyValue
              dense
              columns={3}
              labelCase="sentence"
              items={[
                ...(answer.confirmation?.supplierRef || proposal?.supplierRef ? [{ label: t('po.answer.theirRef'), value: answer.confirmation?.supplierRef ?? proposal?.supplierRef ?? '' }] : []),
                ...(answer.confirmation?.byName || proposal?.byName ? [{ label: t('po.answer.typedName'), value: answer.confirmation?.byName ?? proposal?.byName ?? '' }] : []),
                { label: t('po.answer.how'), value: t(answer.confirmation?.via === 'OFFICE' ? 'po.answer.viaOffice' : 'po.answer.viaLink') },
              ]}
            />
          )}
          {(answer.confirmation?.note || proposal?.note) && (
            <blockquote className="fw-by-text">
              <span className="fw-by-hint">{t('po.answer.theirNote')}</span> {answer.confirmation?.note ?? proposal?.note}
            </blockquote>
          )}
          {proposal?.decision && (
            <Banner tone={proposal.decision === 'ACCEPTED' ? 'success' : 'info'} title={t(`po.answer.decision.${proposal.decision}`, { date: proposal.decidedAt ? formatDateTime(proposal.decidedAt, place) : '—' })}>
              {proposal.decision === 'REFUSED' ? t('po.answer.refusedNext') : null}
            </Banner>
          )}
          {answer.answer === 'DECLINED' && <p className="fw-by-hint">{t('po.answer.declinedNext')}</p>}
        </div>
      </Card>

      <Card padded>
        <div className="fw-by-stack">
          <h3 className="fw-by-h3">{t('po.answer.perLine')}</h3>
          <SummaryTable
            label={t('po.answer.perLine')}
            density="compact"
            stackOnPhone
            columns={[t('po.col.seq'), t('po.col.material'), t('po.answer.asked'), t('po.answer.proposedCol'), t('po.answer.confirmedCol'), t('po.answer.what')]}
            align={['right', 'left', 'left', 'left', 'left', 'left']}
            rows={answer.lines.map((line) => ({
              id: line.id,
              cells: [
                String(line.seq),
                `${line.item.code} ${line.item.name}${line.colour ? ` · ${line.colour}` : ''}`,
                `${q(line.asked.quantity)} ${t(`uom.${line.asked.uom}`)} · ${formatDate(dayAt(line.asked.needDate), place)}`,
                line.proposed
                  ? line.proposed.kind === 'SPLIT'
                    ? line.proposed.deliveries.map((delivery) => `${q(delivery.quantity)} ${t(`uom.${line.asked.uom}`)} · ${delivery.date ? formatDate(dayAt(delivery.date), place) : '—'}`).join(' + ')
                    : line.proposed.kind === 'CANNOT_DELIVER'
                      ? t('po.answer.change.CANNOT_DELIVER')
                      : `${q(line.proposed.quantity)} ${t(`uom.${line.asked.uom}`)} · ${line.proposed.date ? formatDate(dayAt(line.proposed.date), place) : '—'}`
                  : '—',
                line.confirmed ? `${q(line.confirmed.quantity)} ${t(`uom.${line.asked.uom}`)} · ${line.confirmed.date ? formatDate(dayAt(line.confirmed.date), place) : '—'}` : '—',
                <span key="what" className="fw-by-cell">
                  <span>{line.proposed ? changeWords(line.proposed.changes) : line.confirmed ? t('po.answer.asAsked') : '—'}</span>
                  {line.proposed?.reason && <span className="fw-by-cell-sub">{t('po.answer.reason', { reason: line.proposed.reason })}</span>}
                </span>,
              ],
            }))}
          />
        </div>
      </Card>

      <div className="fw-by-cards">
        <Card padded>
          <div className="fw-by-stack">
            <h3 className="fw-by-h3">{t('po.answer.links')}</h3>
            {answer.links.length === 0 ? (
              <p className="fw-by-hint">{t('po.answer.noLinks')}</p>
            ) : (
              <SummaryTable
                label={t('po.answer.links')}
                density="compact"
                stackOnPhone
                columns={[t('po.answer.linkTo'), t('po.answer.linkState'), t('po.answer.linkUntil'), t('po.answer.linkUsed')]}
                align={['left', 'left', 'left', 'left']}
                rows={answer.links.map((link) => ({
                  id: link.id,
                  cells: [
                    link.email ?? '—',
                    <Pill key="state" tone={link.state === 'LIVE' ? 'success' : link.state === 'USED_UP' ? 'info' : 'neutral'}>
                      {t(`po.link.${link.state}`)}
                    </Pill>,
                    formatDate(link.expiresAt, place),
                    link.lastUsedAt ? formatDateTime(link.lastUsedAt, place) : t('po.answer.notUsed'),
                  ],
                }))}
              />
            )}
          </div>
        </Card>
        <Card padded>
          <div className="fw-by-stack">
            <h3 className="fw-by-h3">{t('po.answer.evidence')}</h3>
            {answer.evidence.length === 0 ? (
              <p className="fw-by-hint">{t('po.answer.noEvidence')}</p>
            ) : (
              <ul className="fw-by-list">
                {answer.evidence.map((entry, index) => (
                  <li key={`${entry.linkId}-${index}`}>
                    <Tag tone="neutral">{t(`po.evidence.${evidenceKey(entry.action)}`)}</Tag> {formatDateTime(entry.at, place)}
                    {entry.typedName ? ` · ${t('po.answer.typedAs', { name: entry.typedName })}` : ''}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
      </div>
    </div>
  )
}

/** The link evidence's action (factory-db LinkEvidenceAction) as this app's words, else "other". */
function evidenceKey(action: string): string {
  const known = ['OPENED', 'CONFIRMED', 'DECLINED', 'ACCEPTED']
  return known.includes(action.toUpperCase()) ? action.toUpperCase() : 'OTHER'
}
