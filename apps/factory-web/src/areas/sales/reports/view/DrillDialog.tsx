'use client'

import Link from 'next/link'
import { ChevronLeft, ChevronRight, Download } from 'lucide-react'
import { EmptyState, KeyValue, SummaryTable } from '@nexus/ui/components'
import { Button, Tag } from '@nexus/ui/primitives'
import { Modal } from '../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { money } from '../../../_shared/stock/model'
import type { Backlog, Intake, Returns } from '../api'
import { backlogRowsOf, backlogWeekLabel, bucketLabel, countText, customerHref, groupName, intakeRowsOf, listHref, neighbourOf, orderHref, reasonWords, returnHref, returnRowsOf, styleHref, type DrillTarget } from '../model'
import { NAMESPACE } from './Parts'
import type { ReportsActions, ReportsModel } from './types'

/** The rows a dialog draws (the rest are counted and in the file). */
export const DRILL_ROWS = 500

/**
 * What this number counts (design: "Click a bar → Orders filtered to it", "Click → Orders 'By week' view", "Click → Returns
 * filtered", "Each tile opens the list filtered the same way"; a detail modal as Planning and Purchasing reports): the orders
 * behind an intake bar, bucket, group or tile; the open sizes behind a backlog week, group or cell; the return lines behind a
 * reason, a group or a heatmap cell — each row a link to its record. J / K (and the buttons) open the next and previous bucket or
 * week. Export writes the rows as a CSV file; "Open the list" opens Orders or Returns as close as their address can say (a
 * customer's code when the bar is one customer's) and says what the list does not filter.
 */
export function DrillDialog({ model, actions }: { model: ReportsModel; actions?: ReportsActions | undefined }) {
  const t = useT(NAMESPACE)
  const locale = useLocale()
  const target = model.drill
  if (!target) return null
  const answer = target.section === 'intake' ? (model.intake.status === 'ready' ? model.intake.value : null) : target.section === 'backlog' ? (model.backlog.status === 'ready' ? model.backlog.value : null) : model.returns.status === 'ready' ? model.returns.value : null
  if (!answer) return null
  const keys = target.section === 'intake' ? (answer as Intake).buckets.map((bucket) => bucket.key) : target.section === 'backlog' ? (answer as Backlog).weeks.map((week) => week.key) : []
  const next = neighbourOf(target, keys, 1)
  const previous = neighbourOf(target, keys, -1)
  const steps = target.section !== 'returns' && (target.section === 'intake' ? target.bucket !== null : target.week !== null)
  const day = (date: string | null) => (date ? formatDate(`${date}T12:00:00Z`, { locale }) : '—')
  const { title, name, customerCode, rows, header, csv } = describe(target, answer, model, { t, locale, day })
  const onKeyDown = (event: React.KeyboardEvent) => {
    const element = event.target as HTMLElement
    if (element.closest('input, textarea, select')) return
    if ((event.key === 'j' || event.key === 'J') && next) {
      event.preventDefault()
      actions?.onDrill?.(next)
    } else if ((event.key === 'k' || event.key === 'K') && previous) {
      event.preventDefault()
      actions?.onDrill?.(previous)
    }
  }
  const footer = (
    <>
      <Button size="sm" onClick={() => previous && actions?.onDrill?.(previous)} heldReason={previous ? null : steps ? t('drill.first') : t('drill.noSteps')} aria-keyshortcuts="k">
        <ChevronLeft size={14} aria-hidden /> {t('drill.previous')}
      </Button>
      <Button size="sm" onClick={() => next && actions?.onDrill?.(next)} heldReason={next ? null : steps ? t('drill.last') : t('drill.noSteps')} aria-keyshortcuts="j">
        {t('drill.next')} <ChevronRight size={14} aria-hidden />
      </Button>
      <span className="grow" />
      <Button size="sm" onClick={() => actions?.onExport?.('drill', header, csv)} heldReason={rows.length > 0 ? null : t('drill.exportHeld')}>
        <Download size={14} aria-hidden /> {t('drill.export')}
      </Button>
      <Button size="sm" variant="primary" asChild>
        <Link href={listHref(model.prefix, target, customerCode)}>{t(`drill.openList.${target.section}`)}</Link>
      </Button>
    </>
  )
  return (
    <Modal open onClose={() => actions?.onDrill?.(null)} title={title} subtitle={name} size="xxl" footer={footer}>
      <div className="fw-slr-drill" onKeyDown={onKeyDown}>
        <KeyValue columns={2} items={[{ label: t('drill.count'), value: countText(rows.length, locale), hint: t(`drill.countHint.${target.section}`) }, { label: t('drill.list'), value: t(`drill.listName.${target.section}`), hint: t(`drill.listHint.${target.section}`) }]} />
        {rows.length === 0 ? (
          <EmptyState title={t('drill.empty')} description={t('drill.emptyHint')} />
        ) : (
          <SummaryTable label={title} stackOnPhone widths={['18%']} columns={header} rows={rows.slice(0, DRILL_ROWS)} />
        )}
        <p className="fw-slr-muted">{[rows.length > DRILL_ROWS ? t('drill.more', { shown: DRILL_ROWS, count: rows.length }) : null, steps ? t('drill.keys') : null].filter(Boolean).join(' ')}</p>
      </div>
    </Modal>
  )
}

type Row = { id: string; cells: React.ReactNode[] }
interface Words {
  t: (key: string, params?: Record<string, string | number>) => string
  locale: 'it' | 'en'
  day: (date: string | null) => string
}

/** The dialog's title, the bar's name, its customer (for the list's search), its rows and its file. */
function describe(target: DrillTarget, answer: Intake | Backlog | Returns, model: ReportsModel, { t, locale, day }: Words): { title: string; name: string; customerCode: string | null; rows: Row[]; header: string[]; csv: (string | number | null)[][] } {
  const prefix = model.prefix
  if (target.section === 'intake') {
    const intake = answer as Intake
    const price = intake.sight.values
    const bucket = target.bucket ? intake.buckets.find((entry) => entry.key === target.bucket) : null
    const group = target.group ? intake.groups.find((entry) => entry.key === target.group) : null
    const groupWords = { none: t(`intake.none.${intake.split}`), fees: t('intake.fees') }
    const name = [bucket ? bucketLabel(bucket, locale) : t('drill.wholePeriod', { from: day(intake.from), to: day(intake.to) }), group ? groupName(group, groupWords) : null].filter(Boolean).join(' · ')
    const orders = intakeRowsOf(intake, target)
    const part = (order: (typeof orders)[number]) => (intake.split === 'style' && target.group ? order.styles.find((style) => style.key === target.group) : null)
    const header = [t('drill.col.order'), t('drill.col.customer'), t('drill.col.bookedOn'), t('drill.col.season'), t('drill.col.pieces'), ...(price ? [t('drill.col.value')] : [])]
    return {
      title: t('drill.title.intake'),
      name,
      customerCode: intake.split === 'customer' && group ? group.code : null,
      header,
      rows: orders.map((order) => {
        const own = part(order)
        const value = own ? own.value : order.value
        return {
          id: order.id,
          cells: [
            <Link key="o" className="fw-slr-link" href={orderHref(prefix, order.id, order.number)}>
              {order.number}
            </Link>,
            <Link key="c" className="fw-slr-link" href={customerHref(prefix, order.customer.id, order.customer.code)}>
              {`${order.customer.code} · ${order.customer.name}`}
            </Link>,
            <span key="d" className="fw-slr-cell">
              {day(order.bookedOn)}
              {order.splitOff ? <span className="fw-slr-muted">{t('drill.splitOff', { day: day(order.orderDate) })}</span> : null}
            </span>,
            order.season ? order.season.code : t('intake.none.season'),
            countText(own ? own.pieces : order.pieces, locale),
            ...(price ? [typeof value === 'number' ? money(value, order.currency, locale) : '—'] : []),
          ],
        }
      }),
      csv: orders.map((order) => {
        const own = part(order)
        const value = own ? own.value : order.value
        return [order.number, `${order.customer.code} ${order.customer.name}`, order.bookedOn, order.season?.code ?? '', own ? own.pieces : order.pieces, ...(price ? [typeof value === 'number' ? money(value, order.currency, locale) : ''] : [])]
      }),
    }
  }
  if (target.section === 'backlog') {
    const backlog = answer as Backlog
    const price = backlog.sight.values
    const week = target.week ? backlog.weeks.find((entry) => entry.key === target.week) : null
    const group = target.group ? backlog.groups.find((entry) => entry.key === target.group) : null
    const long = { earlier: (to: string) => t('backlog.earlier', { day: day(to) }), later: (from: string) => t('backlog.later', { day: day(from) }), none: t('backlog.none') }
    const name = [week ? backlogWeekLabel(week, locale, long) : null, group ? [group.code, group.name].filter(Boolean).join(' · ') : null, target.horizon ? t(`backlog.horizon.${target.horizon}`) : null].filter(Boolean).join(' · ') || t('drill.allBacklog')
    const lines = backlogRowsOf(backlog, target)
    const header = [t('drill.col.orderLine'), t('drill.col.customer'), t('drill.col.style'), t('drill.col.size'), t('drill.col.open'), t('drill.col.promise'), ...(price ? [t('drill.col.value')] : [])]
    return {
      title: t('drill.title.backlog'),
      name,
      customerCode: backlog.by === 'customer' && group ? group.code : null,
      header,
      rows: lines.map((line) => ({
        id: `${line.lineId}|${line.size ?? ''}`,
        cells: [
          <Link key="o" className="fw-slr-link" href={orderHref(prefix, line.orderId, line.number)}>
            {t('drill.lineOf', { number: line.number, seq: line.seq })}
          </Link>,
          `${line.customer.code} · ${line.customer.name}`,
          <Link key="s" className="fw-slr-link" href={styleHref(prefix, line.style.id, line.style.code)}>
            {`${line.style.code} · ${line.colourway.name}`}
          </Link>,
          line.size ?? t('drill.madeToMeasure'),
          countText(line.open, locale),
          <span key="p" className="fw-slr-cell">
            <span className={line.horizon === 'late' ? 'fw-slr-late' : undefined}>{line.promise ? day(line.promise) : t('backlog.none')}</span>
            {line.horizon === 'late' ? <Tag tone="danger">{t('backlog.lateTag')}</Tag> : line.promiseSource === 'RECORD' ? <span className="fw-slr-muted">{t('drill.promiseRecord')}</span> : null}
          </span>,
          ...(price ? [typeof line.value === 'number' ? money(line.value, line.currency, locale) : '—'] : []),
        ],
      })),
      csv: lines.map((line) => [line.number, line.seq, `${line.customer.code} ${line.customer.name}`, `${line.style.code} ${line.colourway.name}`, line.size ?? '', line.open, line.promise ?? '', ...(price ? [typeof line.value === 'number' ? money(line.value, line.currency, locale) : ''] : [])]),
    }
  }
  const returns = answer as Returns
  const price = returns.sight.values
  const reasonOf = (code: string) => {
    const reason = returns.reasons.find((entry) => entry.key === code)
    return reason ? reasonWords(reason, locale) : code
  }
  const groups = target.by === 'style' ? returns.styles : target.by === 'colour' ? returns.colours : target.by === 'size' ? returns.sizes : target.by === 'customer' ? returns.customers : []
  const group = target.by && target.by !== 'reason' && target.key ? groups.find((entry) => entry.key === target.key) : null
  const groupLabel = target.by === 'reason' && target.key ? reasonOf(target.key) : target.by === 'size' && target.key ? (target.key === 'none' ? t('returns.noSize') : target.key) : group ? groupName(group, { none: t('returns.unknown'), fees: t('intake.fees') }) : null
  const name = [groupLabel, target.size ? t('drill.size', { size: target.size === 'none' ? t('returns.noSize') : target.size }) : null].filter(Boolean).join(' · ') || t('drill.wholePeriod', { from: day(returns.from), to: day(returns.to) })
  const lines = returnRowsOf(returns, target)
  const header = [t('drill.col.returnLine'), t('drill.col.requestedOn'), t('drill.col.reason'), t('drill.col.style'), t('drill.col.size'), t('drill.col.customer'), t('drill.col.pieces'), ...(price ? [t('drill.col.credited')] : [])]
  return {
    title: t('drill.title.returns'),
    name,
    customerCode: target.by === 'customer' && group ? group.code : null,
    header,
    rows: lines.map((line) => ({
      id: line.lineId,
      cells: [
        <Link key="r" className="fw-slr-link" href={returnHref(prefix, line.returnId, line.number)}>
          {t('drill.lineOf', { number: line.number, seq: line.seq })}
        </Link>,
        day(line.requestedOn),
        reasonOf(line.reason),
        line.style ? `${line.style.code}${line.colour ? ` · ${line.colour.name}` : ''}` : t('returns.unknown'),
        line.size ?? t('returns.noSize'),
        `${line.customer.code} · ${line.customer.name}`,
        countText(line.pieces, locale),
        ...(price ? [typeof line.credited === 'number' ? money(line.credited, line.currency, locale) : t('drill.notDecided')] : []),
      ],
    })),
    csv: lines.map((line) => [line.number, line.seq, line.requestedOn, reasonOf(line.reason), line.style?.code ?? '', line.colour?.name ?? '', line.size ?? '', `${line.customer.code} ${line.customer.name}`, line.pieces, ...(price ? [typeof line.credited === 'number' ? money(line.credited, line.currency, locale) : ''] : [])]),
  }
}
