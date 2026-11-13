'use client'

import { Button, Pill, Skeleton } from '@nexus/ui/primitives'
import { formatDateTime } from '../../../../lib/i18n/format'
import type { PromiseHistory } from '../api'
import { dayWords, sizeName, type Words } from '../model'
import type { HistoryPopover, PromiseActions } from '../view-model'

const proposalTone = (state: PromiseHistory['proposals'][number]['state']): 'info' | 'success' | 'neutral' | 'danger' => (state === 'WAITING' ? 'info' : state === 'ACCEPTED' ? 'success' : state === 'DECLINED' ? 'danger' : 'neutral')

/**
 * A line's promise history (design planning.promise sec:lines "History popover on the Changes cell"; read when it opens): the
 * first promise kept forever and the promise now, each change in order — the day, which size, how many days it moved, the
 * reason in the customer's words (the page's language) and the office's note, who promised (an office person, inside this one
 * line), whether the customer was told — and the re-promises proposed with sales' word.
 */
export function HistoryPanel({ history, actions, words }: { history: HistoryPopover; actions?: PromiseActions; words: Words }) {
  const { t, locale } = words
  if (history.history.status === 'loading') {
    return (
      <div className="fw-pdt-pop" aria-busy="true">
        <p className="fw-pdt-hint" role="status">
          {t('history.loading')}
        </p>
        <Skeleton height={16} />
        <Skeleton height={16} />
      </div>
    )
  }
  if (history.history.status === 'error') {
    return (
      <div className="fw-pdt-pop">
        <p className="fw-pdt-hint" role="alert">
          {t('history.error')} {t(history.history.problem)}
        </p>
        <Button size="sm" onClick={() => actions?.onRetryHistory?.()}>
          {t('common.retry')}
        </Button>
      </div>
    )
  }
  const value = history.history.value
  const mtm = value.line.kind === 'MADE_TO_MEASURE'
  const day = (date: string | null) => dayWords(date, locale, true)
  return (
    <div className="fw-pdt-pop">
      <b>{t('line.order', { order: value.order.number, line: value.line.seq })}</b>
      <p className="fw-pdt-pop-sum">
        {t('history.sum', { first: day(value.first), current: day(value.current) })}
        {value.changes > 0 ? ` · ${t('history.counted', { count: value.changes, slips: value.slips })}` : ''}
      </p>
      {value.rows.length === 0 ? (
        <p className="fw-pdt-hint">{value.order.promiseDate ? t('history.typedOnly', { day: day(value.order.promiseDate) }) : t('history.none')}</p>
      ) : (
        <ol className="fw-pdt-pop-list">
          {value.rows.map((row) => (
            <li key={row.id} className="fw-pdt-pop-row">
              <span className="fw-pdt-pop-main">
                <Pill tone={row.kind === 'FIRST' ? 'neutral' : row.shiftDays !== null && row.shiftDays > 0 ? 'warning' : 'info'}>{t(row.kind === 'FIRST' ? 'history.first' : 'history.repromise')}</Pill>
                <span>
                  {sizeName(row.size, t, mtm)}: {day(row.promisedDate)}
                  {row.shiftDays ? ` (${t(row.shiftDays > 0 ? 'history.later' : 'history.earlier', { count: Math.abs(row.shiftDays) })})` : ''}
                </span>
              </span>
              <span className="fw-pdt-sub">
                {[
                  row.reasonWords ? row.reasonWords[locale] : null,
                  row.reason ? t('history.note', { note: row.reason }) : null,
                  row.promisedBy ? t('history.by', { name: row.promisedBy.name, time: formatDateTime(row.promisedAt, { locale }) }) : formatDateTime(row.promisedAt, { locale }),
                  row.fromPlan ? t('history.fromPlan') : null,
                  row.customerToldAt ? t('history.told', { time: formatDateTime(row.customerToldAt, { locale }) }) : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </li>
          ))}
        </ol>
      )}
      {value.proposals.length > 0 && (
        <>
          <b className="fw-pdt-pop-head">{t('history.proposals')}</b>
          <ul className="fw-pdt-pop-list">
            {value.proposals.map((proposal) => (
              <li key={proposal.id} className="fw-pdt-pop-row">
                <span className="fw-pdt-pop-main">
                  <Pill tone={proposalTone(proposal.state)}>{t(`proposal.${proposal.state}`)}</Pill>
                  <span>{proposal.sizes.map((entry) => t('history.move', { size: sizeName(entry.size, t, mtm), from: day(entry.from), to: day(entry.to) })).join(', ')}</span>
                </span>
                <span className="fw-pdt-sub">
                  {[
                    proposal.proposedBy ? t('history.proposedBy', { name: proposal.proposedBy.name, time: formatDateTime(proposal.proposedAt, { locale }) }) : null,
                    proposal.decidedBy && proposal.decidedAt ? t('history.decidedBy', { name: proposal.decidedBy.name, time: formatDateTime(proposal.decidedAt, { locale }) }) : null,
                    proposal.decisionReason ? t('history.note', { note: proposal.decisionReason }) : null,
                    proposal.told ? t('history.toldShort') : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
