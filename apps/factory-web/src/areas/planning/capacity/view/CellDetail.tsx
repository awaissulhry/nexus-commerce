'use client'

import { useEffect, useRef } from 'react'
import Link from 'next/link'
import { ChartGantt, ChevronDown, ChevronUp } from 'lucide-react'
import { SummaryTable } from '@nexus/ui/components'
import { LoadBar } from '@nexus/ui/patterns/planning-board/index'
import { Button, Kbd, Tag } from '@nexus/ui/primitives'
import { DetailModal } from '../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../lib/i18n/format'
import { INTL_LOCALE } from '../../../../lib/i18n/locales'
import { useBoardWords } from '../../../_shared/planning-board/words'
import type { Capacity, CapacityLane } from '../api'
import { boardHref, cellAt, cellOrder, cellTitle, dayWords, howWords, minutesText, type Words } from '../model'
import type { CapacityActions, CapacityModel } from '../view-model'

/**
 * A cell's orders (design planning.capacity pop:bucket, "Line 2 · week 46"; a DetailModal opened from the bar or Enter,
 * `?cell=`): the load in one bar, how the capacity is made, and every work order's operation booked in those days with
 * its garments still to do, its minutes and its share of the load — placed by the board or at its due date. Open on
 * board (a window of its own); K / J the previous and next cell (lane by lane, bucket by bucket); Esc closes.
 */
export function CellDetail({ model, actions, data, lanes, words }: { model: CapacityModel; actions?: CapacityActions; data: Capacity; lanes: readonly CapacityLane[]; words: Words }) {
  const { t, locale } = words
  const kit = useBoardWords()
  const key = model.controls.cell!
  const at = cellAt(data, key)
  const order = cellOrder(lanes.length > 0 ? lanes : data.lanes)
  const index = order.indexOf(key)
  const prev = index > 0 ? order[index - 1]! : null
  const next = index >= 0 && index < order.length - 1 ? order[index + 1]! : null
  const bucket = at ? (data.buckets.find((entry) => entry.key === at.cell.key) ?? { key: at.cell.key, kind: data.bucket, from: at.cell.from, to: at.cell.to }) : null
  const loaded = model.cell?.key === key ? model.cell.orders : { status: 'loading' as const }

  const latest = useRef({ actions, prev, next })
  latest.current = { actions, prev, next }
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target && (target.closest('input, textarea, select, [contenteditable="true"], [role="menu"]') || target.isContentEditable)) return
      const now = latest.current
      const pressed = event.key.toLowerCase()
      if (pressed === 'j' && now.next) {
        event.preventDefault()
        now.actions?.onCell?.(now.next)
      } else if (pressed === 'k' && now.prev) {
        event.preventDefault()
        now.actions?.onCell?.(now.prev)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const title = at && bucket ? cellTitle(at.lane, bucket, words) : t('cell.gone')
  return (
    <DetailModal
      open
      onClose={() => actions?.onCell?.(null)}
      title={title}
      subtitle={at && bucket ? t('cell.days', { from: dayWords(bucket.from, locale, true), to: dayWords(bucket.to, locale, true) }) : undefined}
      meta={at ? <Tag tone="neutral">{t(`kind.${at.lane.kind}`)}</Tag> : undefined}
      loading={at !== null && loaded.status === 'loading'}
      error={!at ? t('error.gone') : loaded.status === 'error' ? t(loaded.problem) : undefined}
      onRetry={() => actions?.onRetryCell?.()}
      actions={
        <>
          <span className="fw-pc-inline">
            <Button size="sm" variant="quiet" aria-label={t('cell.prev')} heldReason={prev ? null : t('cell.first')} onClick={() => prev && actions?.onCell?.(prev)} aria-keyshortcuts="k">
              <ChevronUp size={16} aria-hidden /> <Kbd>K</Kbd>
            </Button>
            <Button size="sm" variant="quiet" aria-label={t('cell.next')} heldReason={next ? null : t('cell.last')} onClick={() => next && actions?.onCell?.(next)} aria-keyshortcuts="j">
              <ChevronDown size={16} aria-hidden /> <Kbd>J</Kbd>
            </Button>
          </span>
          {at && (
            <Button size="sm" variant="primary" asChild>
              <a href={boardHref(model.prefix, model.siteId, [at.lane], at.cell.from)} target="_blank" rel="noreferrer">
                <ChartGantt size={13} aria-hidden /> {t('cell.board')}
              </a>
            </Button>
          )}
        </>
      }
    >
      {at && (
        <div className="fw-pc-detail">
          <LoadBar size="md" label={title} labelVisible={false} booked={Number(at.cell.bookedMinutes)} available={Number(at.cell.availableMinutes)} words={kit.load} locale={INTL_LOCALE[locale]} />
          <section aria-labelledby="fw-pc-how">
            <h3 id="fw-pc-how" className="fw-pc-text">
              <b>{t('how.titleShort')}</b>
            </h3>
            <ul className="fw-pc-list">
              {howWords(at.lane, at.cell, words).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </section>
          {loaded.status === 'ready' &&
            (loaded.value.orders.length === 0 ? (
              <p className="fw-pc-hint">{t('cell.noOrders')}</p>
            ) : (
              <SummaryTable
                label={t('cell.orders')}
                density="compact"
                stackOnPhone
                columns={[t('cell.col.workOrder'), t('cell.col.operation'), t('cell.col.pieces'), t('cell.col.minutes'), t('cell.col.share'), t('cell.col.placed')]}
                align={['left', 'left', 'right', 'right', 'right', 'left']}
                rows={loaded.value.orders.map((entry) => ({
                  id: `${entry.workOrder.id}-${entry.operation.id}`,
                  cells: [
                    <span key="wo" className="fw-pc-cell">
                      <Link className="fw-pc-link" href={`${model.prefix}/production/work-orders/${encodeURIComponent(entry.workOrder.id)}`}>{entry.workOrder.number}</Link>
                      <span className="fw-pc-cell-sub">
                        {entry.workOrder.style.code} {entry.workOrder.style.name}
                      </span>
                    </span>,
                    `${entry.operation.seq} · ${entry.operation.code} ${entry.operation.name}`,
                    String(entry.pieces),
                    t('cell.minutes', { minutes: minutesText(entry.minutes, locale) }),
                    `${minutesText(entry.sharePct, locale)}%`,
                    entry.placedBy === 'SLOT' && entry.slot ? t('cell.placedSlot', { time: formatDateTime(entry.slot.startAt, { locale, timeZone: data.site.timeZone }) }) : entry.workOrder.dueDate ? t('cell.placedDue', { date: dayWords(entry.workOrder.dueDate, locale) }) : t('cell.placedDueNone'),
                  ],
                }))}
              />
            ))}
          <p className="fw-pc-hint">{t('cell.noPerson')}</p>
        </div>
      )}
    </DetailModal>
  )
}
