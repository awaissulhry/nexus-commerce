'use client'

import { BellRing, CalendarClock, FileText, History, Scissors } from 'lucide-react'
import { Banner, Card, EmptyState, KeyValue, SummaryTable } from '@nexus/ui/components'
import { Button, Pill, Tag } from '@nexus/ui/primitives'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { dayAt, money, quantity, unitPrice } from '../../../../_shared/buying/model'
import type { OrderRevision, PurchaseOrder, RevisionChanges } from '../../api'
import { answerTone, closeShortHeld, confirmByHeld, confirmByPhrase, fieldKey, quantityValue, remindersSummary, remindHeld, revisionsNewestFirst } from '../../daily-model'
import type { OrderRecordActions, OrderRecordModel } from '../../model'
import { useSay } from './DailyDialogs'
import '../../daily.css'
import { PartState } from './OrderRecordView'

/**
 * The PO studio's daily sections (B-W2a-69, design purchasing.orders record "Confirmations & changes" › Revisions and Sends ›
 * Reminders sent; Lines' revision banner; Receipts' Close short): every revision with its diff (field from → to per line,
 * in this app's words), the supplier's answer to it and its PDF; the confirm-by time with Move; the reminders sent (by hand,
 * or by the daily run once the Owner's switch is on — off today) with Remind; the lines still expected that can be closed short.
 */

/** One change "Quantity: 105 ft² → 140 ft²" in words (dates, units, yes/no and colours as this app writes them). */
function useChangeText(order: PurchaseOrder, timeZone: string | undefined) {
  const t = useT('purchasing-orders')
  const tb = useT('buying')
  const locale = useLocale()
  const place = { locale, timeZone }
  const colourName = (id: string | null) => {
    if (!id) return t('value.none')
    const line = order.lines.find((entry) => entry.itemColourId === id)
    return line?.colour ? `${line.colour.code} ${line.colour.name}` : t('value.otherColour')
  }
  const valueText = (field: string, value: string | null): string => {
    if (value === null) return t('value.none')
    if (field === 'quantity') {
      const parts = quantityValue(value)
      return parts ? `${quantity(parts.amount, locale)} ${tb(`uom.${parts.uom}`)}` : value
    }
    if (field === 'needDate' || field === 'requestedDate') return /^\d{4}-\d{2}-\d{2}$/.test(value) ? formatDate(dayAt(value), place) : value
    if (field === 'oneDyeBatch') return value === 'yes' ? t('value.yes') : t('value.no')
    if (field === 'itemColourId') return colourName(value)
    if (field === 'areaTolerancePct') return `${value} %`
    if (field === 'thicknessMinMm' || field === 'thicknessMaxMm') return `${value} mm`
    return value
  }
  return (field: string, before: string | null, after: string | null) => t('change.fromTo', { field: t(fieldKey(field)), before: valueText(field, before), after: valueText(field, after) })
}

/** A revision's changes in words, one entry per header field and per line. */
function ChangesList({ order, changes, model }: { order: PurchaseOrder; changes: RevisionChanges; model: OrderRecordModel }) {
  const t = useT('purchasing-orders')
  const text = useChangeText(order, model.timeZone)
  if (changes.count === 0) return <p className="fw-by-hint">{t('revisions.noChange')}</p>
  const itemOf = (lineId: string) => order.lines.find((line) => line.id === lineId)?.item
  return (
    <ul className="fw-by-list">
      {changes.header.map((change) => (
        <li key={`h-${change.field}`}>{text(change.field, change.before, change.after)}</li>
      ))}
      {changes.lines.map((line) => {
        const item = itemOf(line.lineId)
        const name = t('revisions.line', { seq: line.seq, item: item ? `${item.code} ${item.name}` : t('revisions.removedLine') })
        if (line.kind !== 'CHANGED') return <li key={line.lineId}>{t(`revisions.kind.${line.kind}`, { line: name })}</li>
        return (
          <li key={line.lineId}>
            {name}: {line.changes.map((change) => text(change.field, change.before, change.after)).join(' · ')}
          </li>
        )
      })}
    </ul>
  )
}

/** Lines tab of a draft of revision 2+: "Revision 2 draft — the supplier sees it after you send it", with the changes so far. */
export function RevisionDraftBanner({ order, model }: { order: PurchaseOrder; model: OrderRecordModel }) {
  const t = useT('purchasing-orders')
  if (order.status !== 'DRAFT' || order.revision <= 1) return null
  const draft = model.revisions.value?.draft ?? null
  return (
    <Banner tone="info" title={t('revisionDraft.title', { revision: order.revision })}>
      {draft ? draft.changes.count > 0 ? <ChangesList order={order} changes={draft.changes} model={model} /> : t('revisionDraft.nothingYet') : model.revisions.problem ? t('revisionDraft.unknown') : null}
    </Banner>
  )
}

function RevisionPrices({ order, revision }: { order: PurchaseOrder; revision: OrderRevision }) {
  const t = useT('purchasing-orders')
  const locale = useLocale()
  const prices = revision.prices
  if (!prices) return null
  const net = prices.changed.netAmount
  const lines = prices.changed.lines.filter((line) => line.unitPrice)
  if (!net && lines.length === 0) return <p className="fw-by-hint">{t('revisions.pricesSame', { amount: money(prices.after.netAmount ?? null, prices.after.currency, locale) })}</p>
  return (
    <ul className="fw-by-list">
      {net && <li>{t('revisions.netFromTo', { before: money(net.before, prices.after.currency, locale), after: money(net.after, prices.after.currency, locale) })}</li>}
      {lines.map((line) => (
        <li key={line.lineId}>
          {t('revisions.priceFromTo', { seq: line.seq, before: line.unitPrice?.before ? unitPrice(line.unitPrice.before, order.currency, locale) : t('value.none'), after: line.unitPrice?.after ? unitPrice(line.unitPrice.after, order.currency, locale) : t('value.none') })}
        </li>
      ))}
    </ul>
  )
}

/** Confirmations & changes › Revisions: every version with a visible diff; the supplier re-confirms each. */
export function RevisionsCard({ order, model, actions }: { order: PurchaseOrder; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('purchasing-orders')
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const part = model.revisions
  if (!part.value) return <PartState problem={part.problem} onRetry={() => actions?.onRetryPart?.('revisions')} label={t('revisions.title')} />
  const list = revisionsNewestFirst(part.value.revisions)
  return (
    <Card padded>
      <div className="fw-by-stack">
        <div className="fw-by-card-head">
          <h3 className="fw-by-h3">
            <History size={16} className="fw-by-ico" aria-hidden /> {t('revisions.title')}
          </h3>
          {part.value.draft && <Tag tone="info">{t('revisions.draftOpen', { revision: part.value.draft.revision })}</Tag>}
        </div>
        {list.length === 0 ? (
          <p className="fw-by-hint">{order.status === 'DRAFT' && order.revision <= 1 ? t('revisions.notSent') : t('revisions.onlyOne')}</p>
        ) : (
          <ol className="fw-by-stack fw-po-revisions">
            {list.map((revision) => (
              <li key={revision.id} className="fw-po-revision">
                <div className="fw-by-card-head">
                  <span className="fw-by-inline">
                    <b>{t('revisions.version', { revision: revision.revision })}</b>
                    <span className="fw-by-hint">{t('revisions.sent', { time: formatDateTime(revision.sentAt, place), by: revision.sentByName ?? t('revisions.someone') })}</span>
                  </span>
                  <span className="fw-by-inline">
                    <Pill tone={answerTone(revision.answer)}>{t(`revisions.answer.${revision.answer}`)}</Pill>
                    {revision.documentFileId && (
                      <Button size="sm" variant="quiet" onClick={() => actions?.daily?.onOpenRevision?.(revision.documentFileId!)} aria-label={t('revisions.openPdf', { revision: revision.revision })}>
                        <FileText size={13} aria-hidden /> {t('revisions.pdf')}
                      </Button>
                    )}
                  </span>
                </div>
                {revision.confirmation && <p className="fw-by-hint">{t('revisions.confirmedBy', { time: formatDateTime(revision.confirmation.at, place), name: revision.confirmation.byName ?? t('revisions.viaLink') })}</p>}
                {revision.revision === 1 ? <p className="fw-by-hint">{t('revisions.first', { count: revision.lines })}</p> : <ChangesList order={order} changes={revision.changes} model={model} />}
                {revision.changeNote && (
                  <blockquote className="fw-by-text">
                    <span className="fw-by-hint">{t('revisions.note')}</span> {revision.changeNote}
                  </blockquote>
                )}
                {model.can.cost && revision.revision > 1 && <RevisionPrices order={order} revision={revision} />}
              </li>
            ))}
          </ol>
        )}
      </div>
    </Card>
  )
}

/** Sends › Reminders sent, with the confirm-by time (Move) and Remind. */
export function RemindersCard({ order, model, actions }: { order: PurchaseOrder; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('purchasing-orders')
  const say = useSay()
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const part = model.reminders
  const now = model.now ? new Date(model.now) : new Date()
  if (!part.value) return <PartState problem={part.problem} onRetry={() => actions?.onRetryPart?.('reminders')} label={t('reminders.title')} />
  const reminders = part.value
  const deadline = confirmByPhrase(order, now)
  const summary = remindersSummary(reminders)
  const remind = say(remindHeld(order, model.can))
  const move = say(confirmByHeld(order, model.can))
  return (
    <Card padded>
      <div className="fw-by-stack">
        <div className="fw-by-card-head">
          <h3 className="fw-by-h3">
            <BellRing size={16} className="fw-by-ico" aria-hidden /> {t('reminders.title')}
          </h3>
          <span className="fw-by-actions">
            <Button size="sm" heldReason={model.busy ? t('reminders.busy') : move} onClick={() => actions?.onDialog?.({ kind: 'confirmBy', confirmBy: order.confirmBy ?? '' })}>
              <CalendarClock size={13} aria-hidden /> {t('confirmBy.move')}
            </Button>
            <Button size="sm" variant="primary" heldReason={model.busy ? t('reminders.busy') : remind} onClick={() => actions?.onDialog?.({ kind: 'remind', message: '' })}>
              <BellRing size={13} aria-hidden /> {t('remind.open')}
            </Button>
          </span>
        </div>
        <KeyValue
          dense
          columns={2}
          labelCase="sentence"
          items={[
            { label: t('reminders.confirmBy'), value: reminders.confirmBy ? formatDateTime(reminders.confirmBy, place) : t('reminders.noDeadline'), hint: deadline ? t(deadline.key) : undefined },
            {
              label: t('reminders.automatic'),
              value: reminders.automatic ? t('reminders.automaticOn') : t('reminders.automaticOff'),
              hint: reminders.automatic && reminders.nextAutomaticAt ? t('reminders.nextAt', { time: formatDateTime(reminders.nextAutomaticAt, place) }) : t('reminders.switchHint'),
            },
          ]}
        />
        <p className="fw-by-hint">{t(summary.key, { count: reminders.sentForRevision, time: reminders.nextAutomaticAt ? formatDateTime(reminders.nextAutomaticAt, place) : '—' })}</p>
        {reminders.reminders.length === 0 ? (
          <p className="fw-by-hint">{t('reminders.none')}</p>
        ) : (
          <SummaryTable
            label={t('reminders.title')}
            density="compact"
            stackOnPhone
            columns={[t('reminders.col.when'), t('reminders.col.revision'), t('reminders.col.how'), t('reminders.col.to'), t('reminders.col.mail')]}
            align={['left', 'right', 'left', 'left', 'left']}
            rows={reminders.reminders.map((entry) => ({
              id: entry.id,
              cells: [
                formatDateTime(entry.sentAt, place),
                String(entry.revision),
                entry.automatic ? t('reminders.byRun') : t('reminders.byHand', { name: entry.sentByName ?? t('revisions.someone') }),
                entry.to ?? '—',
                <Tag key="mail" tone={entry.mailStatus === 'FAILED' ? 'danger' : entry.mailStatus === 'SENT' || entry.mailStatus === 'DELIVERED' ? 'success' : 'neutral'}>
                  {t(`reminders.mail.${['QUEUED', 'SENT', 'DELIVERED', 'FAILED'].includes(entry.mailStatus ?? '') ? entry.mailStatus : 'OTHER'}`)}
                </Tag>,
              ],
            }))}
          />
        )}
      </div>
    </Card>
  )
}

/** Receipts › Close short a line: the rest will not come; planning releases it (the lines part received, the rest open). */
export function CloseShortCard({ order, model, actions }: { order: PurchaseOrder; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('purchasing-orders')
  const tb = useT('buying')
  const say = useSay()
  const locale = useLocale()
  const open = order.lines.filter((line) => !line.ended)
  const closed = order.lines.filter((line) => line.ended?.kind === 'CLOSED_SHORT')
  // Only once part of the order came (a line is closed short after some of it was received), or to show the lines closed.
  if (order.status !== 'PARTLY_RECEIVED' && closed.length === 0) return null
  const candidates = open.filter((line) => closeShortHeld(order, line, model.can) === null)
  return (
    <Card padded>
      <div className="fw-by-stack">
        <div className="fw-by-card-head">
          <h3 className="fw-by-h3">
            <Scissors size={16} className="fw-by-ico" aria-hidden /> {t('closeShort.title')}
          </h3>
          <Button size="sm" heldReason={candidates.length === 0 ? (say(open[0] ? closeShortHeld(order, open[0], model.can) : null) ?? t('closeShort.none')) : model.busy ? t('reminders.busy') : null} onClick={() => actions?.daily?.onEndLines?.('CLOSE_SHORT', candidates.map((line) => line.id))}>
            {t('closeShort.open', { count: candidates.length })}
          </Button>
        </div>
        <p className="fw-by-hint">{t('closeShort.means')}</p>
        {open.length === 0 && closed.length === 0 ? (
          <EmptyState title={t('closeShort.nothing')} />
        ) : (
          <SummaryTable
            label={t('closeShort.title')}
            density="compact"
            stackOnPhone
            columns={[tb('po.col.seq'), tb('po.col.material'), t('reach.col.ordered'), t('reach.col.received'), t('closeShort.col.state'), '']}
            align={['right', 'left', 'right', 'right', 'left', 'right']}
            rows={[...open, ...closed].map((line) => {
              const held = closeShortHeld(order, line, model.can)
              return {
                id: line.id,
                cells: [
                  String(line.seq),
                  `${line.item.code} · ${line.item.name}${line.colour ? ` · ${line.colour.name}` : ''}`,
                  `${quantity(line.baseQuantity, locale)} ${tb(`uom.${line.baseUom}`)}`,
                  `${quantity(line.receivedBaseQuantity, locale)} ${tb(`uom.${line.baseUom}`)}`,
                  line.ended ? <Tag key="ended" tone="neutral">{t(`ended.${line.ended.kind}`)}</Tag> : (say(held) ?? t('closeShort.can')),
                  held === null ? (
                    <Button key="act" size="sm" variant="quiet" onClick={() => actions?.daily?.onEndLines?.('CLOSE_SHORT', [line.id])} aria-label={t('closeShort.line', { seq: line.seq })}>
                      {t('closeShort.lineShort')}
                    </Button>
                  ) : (
                    ''
                  ),
                ],
              }
            })}
          />
        )}
      </div>
    </Card>
  )
}
