'use client'

import { History, Lock, Send, Users } from 'lucide-react'
import { Disclosure } from '@nexus/ui/components'
import { Tag, ToolbarButton } from '@nexus/ui/primitives'
import { PROMISE_REASON_WORDS } from '@nexus/factory-domain/sales/portal-orders/promise'
import { formatDate, formatDateTime } from '../../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { useRecordFrame } from '../../../../../_shared/record-frame/RecordFrame'
import type { Order } from '../../../api'
import { dayInstant } from '../../../model'
import { readOf, say } from '../../overview/model'
import { promiseRowOf } from '../../overview/dates'
import { MOVES_OPEN, promiseHistoryOf, toldOfMove, type MoveReason, type MoveRow } from '../../production/history'
import type { OrderRecordActions, OrderRecordModel } from '../../record-model'
import { ShowInThreadDoor } from '../Discuss'
import { Quiet } from './Kit'

/**
 * F-PT-204 (order PRODUCTION tab, 10-design §5 Block D; S4; bugs B21–B24) — "Promise history" inside Dates & plan (#promise-moves):
 * the headline in the read's own count ("7 Dec · moved 1× · +6 d since first promised" — ONE rule with Overview), the newest move
 * open and the older ones folded; each move from → to (each line's own day for a lines' move, never "— → 19 Dec"), how many days
 * later or sooner, which lines, why in office words (the office's note apart, office only, and what the customer reads; no reason
 * given: said so), who and when; its doors: Tell the customer… (the thread's Reply box), Show in the thread, Who was told…. The
 * order's first promise is "Date set" — never counted as a move. No undo (a move back is a new move).
 */
export function PromiseHistory({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const locale = useLocale()
  const frame = useRecordFrame()
  const read = readOf(model.production)
  const day = (value: string) => formatDate(dayInstant(value), { locale })
  const history = promiseHistoryOf(order.promiseHistory)
  const promise = promiseRowOf(order, read?.headline ?? null)
  const told = model.told?.value?.changes ?? []
  const nameOf = (id: string) => order.people.find((person) => person.id === id)?.name ?? t('dates.someone')
  const lineName = (id: string) => {
    const line = order.lines.find((entry) => entry.id === id)
    return line ? t('discuss.line', { seq: line.seq, name: `${line.style?.code ?? '—'} ${line.colourway?.name ?? line.colourway?.code ?? ''}`.trim() }) : '—'
  }
  const customerLocale = order.language === 'it' ? 'it' : 'en'
  const reasonOf = (reason: MoveReason) => {
    if (reason.kind === 'none') return <span className="fw-pt-sub">{t('productionTab.history.reasonNone')}</span>
    if (reason.kind === 'automatic') return <span className="fw-pt-sub">{t('productionTab.history.reasonAutomatic')}</span>
    const office = reason.code === 'YOUR_CHANGE' ? t('promise.officeReason.YOUR_CHANGE') : say(PROMISE_REASON_WORDS[reason.code], locale)
    return (
      <>
        <b>{office}</b>
        {reason.note ? (
          <span className="fw-pt-sub fw-pt-inline">
            <Lock size={12} aria-hidden /> {t('productionTab.history.officeNote', { note: reason.note })}
          </span>
        ) : null}
        <span className="fw-pt-sub">{t('productionTab.history.customerReads', { words: say(PROMISE_REASON_WORDS[reason.code], customerLocale) })}</span>
      </>
    )
  }
  const moveOf = (move: MoveRow, index: number) => {
    const fromWords = move.from.length === 1 ? (move.from[0]!.from ? day(move.from[0]!.from) : '—') : move.from.map((line) => `${line.lineId ? lineName(line.lineId) : '—'} ${line.from ? day(line.from) : '—'}`).join(' · ')
    const change = toldOfMove(move.at, told)
    return (
      <li key={move.key} className="fw-pt-move" id={`about-PromiseMove-${index}` /* 10-design §2: a move's own anchor (not a thread chip kind) */} tabIndex={-1}>
        <span className="fw-pt-inline">
          <b>{t('dates.fromTo', { from: fromWords, to: day(move.to) })}</b>
          {move.delta !== null && move.delta !== 0 ? <Tag tone={move.delta > 0 ? 'warning' : 'info'}>{move.delta > 0 ? t('productionTab.history.later', { count: move.delta }) : t('productionTab.history.sooner', { count: -move.delta })}</Tag> : null}
        </span>
        <span className="fw-pt-sub">{move.lineIds.length === 0 ? t('dates.wholeOrder') : t('productionTab.history.lines', { lines: move.lineIds.map(lineName).join(', ') })}</span>
        {reasonOf(move.reason)}
        <span className="fw-pt-sub">{t('productionTab.history.by', { name: nameOf(move.actorId), at: formatDateTime(move.at, { locale }) })}</span>
        <span className="fw-pt-move-doors">
          {/* The only customer-facing door here: the thread's Reply box (the customer was already told by the portal's notice). */}
          {model.people?.mayNote && frame?.compose ? <ToolbarButton icon={<Send size={14} aria-hidden />} label={t('productionTab.history.tell')} onClick={() => frame.compose?.({ messageId: change?.messageId ?? null, mode: 'reply' })} /> : null}
          <ShowInThreadDoor order={order} at={move.at} />
          {change && actions?.onWhoWasTold ? <ToolbarButton icon={<Users size={14} aria-hidden />} label={t('told.open')} onClick={() => actions.onWhoWasTold?.(change.messageId)} /> : null}
        </span>
      </li>
    )
  }
  const open = history.moves.slice(0, MOVES_OPEN)
  const older = history.moves.slice(MOVES_OPEN)
  return (
    <div className="fw-pt-blk fw-pt-hist" id="promise-moves">
      <h3 className="fw-pt-h3">
        <History size={14} aria-hidden /> {t('productionTab.history.title')}
      </h3>
      {!promise ? (
        <Quiet>{t('productionTab.history.noPromise')}</Quiet>
      ) : history.moves.length === 0 ? (
        <Quiet>{history.set ? t('productionTab.history.never', { date: day(promise.date), since: formatDate(history.set.at, { locale }) }) : t('productionTab.history.neverNoSince', { date: day(promise.date) })}</Quiet>
      ) : (
        <>
          <p className="fw-pt-hint">
            <b>{promise.moved ? t(promise.moved.key, { ...promise.moved.params, date: day(promise.date) }) : day(promise.date)}</b>
          </p>
          <ol className="fw-pt-moves">{open.map((move, index) => moveOf(move, index))}</ol>
          {older.length > 0 ? (
            <Disclosure summary={t('productionTab.history.earlier', { count: older.length })}>
              <ol className="fw-pt-moves">{older.map((move, index) => moveOf(move, index + MOVES_OPEN))}</ol>
            </Disclosure>
          ) : null}
        </>
      )}
      {history.set && history.moves.length > 0 ? (
        <ol className="fw-pt-moves">
          <li className="fw-pt-move is-set">
            <b>{t('productionTab.history.set', { date: day(history.set.to) })}</b>
            <span className="fw-pt-sub">{[nameOf(history.set.actorId), formatDateTime(history.set.at, { locale }), t('productionTab.history.setNote')].join(' · ')}</span>
          </li>
        </ol>
      ) : null}
    </div>
  )
}
