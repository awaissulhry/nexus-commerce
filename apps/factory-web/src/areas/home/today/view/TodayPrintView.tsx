'use client'

import { Printer } from 'lucide-react'
import { Banner, EmptyState } from '@nexus/ui/components'
import { Button, Spinner } from '@nexus/ui/primitives'
import { formatDate, formatDateTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { dueWords, groupItems, type Loaded, type TodayItem } from '../model'
import '../today.css'

export interface TodayPrintViewModel {
  readonly person: string
  /** The tile the list was filtered by, as words; null: every row. */
  readonly filter: string | null
  readonly list: Loaded<{ readonly asOf: string; readonly items: readonly TodayItem[]; readonly total: number }>
}

/**
 * "Print my list" (design home.today, overflow; W1): Needs me now as one plain page for paper, opened in a new tab, with
 * the date, the person and the filter written at the top, every row with why it is theirs and what waits on it. The
 * print stylesheet hides the Office frame (today.css). It draws ONE view model and fetches nothing.
 */
export function TodayPrintView({ model }: { model: TodayPrintViewModel }) {
  return (
    <WithMessages namespaces={['home']}>
      <PrintList model={model} />
    </WithMessages>
  )
}

function PrintList({ model }: { model: TodayPrintViewModel }) {
  const t = useT('home')
  const locale = useLocale()
  const list = model.list
  return (
    <article className="fw-today-print">
      <header className="fw-today-print-head">
        <h1 className="fw-today-print-title">{t('today.print.title')}</h1>
        <p className="fw-today-muted">
          {list.status === 'ready' ? t('today.print.meta', { at: formatDateTime(list.data.asOf, { locale }), person: model.person }) : model.person}
          {' · '}
          {model.filter ? t('today.print.filter', { filter: model.filter }) : t('today.print.all')}
        </p>
        <Button className="fw-today-print-button" variant="secondary" onClick={() => window.print()}>
          <Printer size={14} aria-hidden /> {t('today.print.button')}
        </Button>
      </header>
      {list.status === 'loading' ? (
        <p className="fw-today-muted" role="status">
          <Spinner size={14} /> {t('today.queue.loading')}
        </p>
      ) : list.status === 'error' ? (
        <Banner tone="danger" title={t('today.queue.error')}>
          {t(list.problem)}
        </Banner>
      ) : list.data.items.length === 0 ? (
        <EmptyState title={t('today.queue.empty.title')} description={t('today.print.empty')} />
      ) : (
        <>
          {groupItems(list.data.items).map((entry) => (
            <section key={entry.group} className="fw-today-print-group">
              <h2 className="fw-today-group-h">{t(`today.group.${entry.group}`)}</h2>
              <ol className="fw-today-print-list">
                {entry.items.map((item) => {
                  const due = dueWords(item.due)
                  return (
                    <li key={item.key}>
                      <strong>{item.record.label}</strong> — {item.sentence}
                      <div className="fw-today-muted">
                        {t(`today.severity.${item.severity}`)}
                        {due ? ` · ${t(due.key, { count: due.count, date: formatDate(due.date, { locale }) })}` : ` · ${t(item.ageDays === 0 ? 'today.row.ageToday' : 'today.row.age', { count: item.ageDays })}`}
                        {' · '}
                        {item.why}
                      </div>
                      {item.blocks && <div className="fw-today-muted">{item.blocks}</div>}
                    </li>
                  )
                })}
              </ol>
            </section>
          ))}
          {list.data.total > list.data.items.length && <p className="fw-today-muted">{t('today.print.cut', { shown: list.data.items.length, total: list.data.total })}</p>}
        </>
      )}
    </article>
  )
}
