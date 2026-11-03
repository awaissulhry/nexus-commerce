'use client'

import { Banner, EmptyState, SummaryTable } from '@nexus/ui/components'
import { PrintSection, PrintView } from '@nexus/ui/patterns/print-view/index'
import { Spinner } from '@nexus/ui/primitives'
import { useDsWords } from '../../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { CalendarAnswer } from '../../api'
import { failedKey, itemWords, monthGroups } from '../../model'
import { SAFETY_NAMESPACES, say, useDay, useWords } from '../../view/parts'
import '../../calendar.css'

/** SCR-267-cal-print — the calendar for the periodic safety meeting: one view model, nothing fetched. */
export interface CalendarPrintModel {
  person: string
  at: string
  company: string
  site: string | null
  /** With "All sites" each row says its site. */
  allSites: boolean
  window: { from: string; to: string }
  canView: boolean
  calendar: { value: CalendarAnswer | null; problem: string | null }
}

const monthText = (month: string, locale: string): string => {
  const text = new Intl.DateTimeFormat(locale === 'it' ? 'it-IT' : 'en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${month}-15T12:00:00Z`))
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/**
 * Design new tab "Calendar (print)": the window (this month and the next 11, or `?from=&to=`) grouped by month — due,
 * what, site, owner, state; a health visit is a count, never a name; what is still open from before the window comes
 * first; a source that could not be read is said on the paper too.
 */
export function CalendarPrintView({ model }: { model: CalendarPrintModel }) {
  return (
    <WithMessages namespaces={SAFETY_NAMESPACES}>
      <Print model={model} />
    </WithMessages>
  )
}

function Print({ model }: { model: CalendarPrintModel }) {
  const t = useWords()
  const locale = useLocale()
  const ds = useDsWords()
  const day = useDay()
  const answer = model.calendar.value
  const waiting = model.canView && !answer && !model.calendar.problem
  const groups = answer ? monthGroups(answer.items) : []
  return (
    <PrintView
      title={t('calPrint.title')}
      meta={[model.company, model.site ?? t('orgPrint.allSites')]}
      printedAt={formatDateTime(model.at, { locale })}
      printedBy={model.person}
      filters={[{ label: t('calPrint.window'), value: `${day(model.window.from)} – ${day(model.window.to)}` }]}
      printHeld={waiting ? t('common.stillLoading') : null}
      labels={ds.printView}
    >
      {!model.canView ? (
        <EmptyState title={t('access.title')} description={t('access.body')} />
      ) : model.calendar.problem ? (
        <Banner tone="warning" title={t('calendar.failed')}>
          {t(model.calendar.problem)}
        </Banner>
      ) : !answer ? (
        <p className="fw-hs-muted" role="status">
          <Spinner size={14} /> {t('common.reading')}
        </p>
      ) : (
        <>
          <p className="fw-hs-print-note">{t('calPrint.note')}</p>
          {answer.failed.length > 0 && (
            <Banner tone="warning" title={t('calendar.failedTitle')}>
              {answer.failed.map((kind) => t(failedKey(kind))).join(' · ')}
            </Banner>
          )}
          {groups.length === 0 && <p>{t('calendar.empty')}</p>}
          {groups.map((group) => (
            <PrintSection key={group.month} title={monthText(group.month, locale)} className="fw-hs-print-group">
              <SummaryTable
                label={t('calPrint.tableLabel', { month: monthText(group.month, locale) })}
                columns={[t('col.dueOn'), t('col.what'), ...(model.allSites ? [t('col.site')] : []), t('col.owner'), t('col.state')]}
                widths={model.allSites ? ['12%', '44%', '14%', '14%', undefined] : ['12%', '52%', '18%', undefined]}
                rows={group.items.map((item) => ({
                  id: item.key,
                  cells: [day(item.dueOn), say(t, itemWords(item, locale)), ...(model.allSites ? [item.site?.name ?? t('site.whole')] : []), item.owner ?? t('owner.none'), t(`state.${item.state}`)],
                }))}
              />
            </PrintSection>
          ))}
        </>
      )}
    </PrintView>
  )
}
