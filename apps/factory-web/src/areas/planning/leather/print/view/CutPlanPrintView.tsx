'use client'

import { Printer } from 'lucide-react'
import { Banner, SummaryTable } from '@nexus/ui/components'
import { Button, Spinner } from '@nexus/ui/primitives'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { LeatherNeed } from '../../api'
import { cutPlanRows, NAMESPACE, visibleNeed, type LeatherControls } from '../../model'
import { useLeatherWords } from '../../view/LeatherView'
import '../../leather.css'

/** SCR-252-print — the cut plan on paper: one view model, nothing fetched. */
export interface CutPlanPrintModel {
  readonly need: LeatherNeed | null
  readonly problem: string | null
  readonly controls: LeatherControls
  readonly printedAt: string
}

/**
 * The cut plan for the cutting room (design planning.leather tab:cut-plan): the site, the plan run it is from, the filters it
 * was printed with and when, then per order line the style and colour, the sizes, the leather, the area left to find, about
 * how many hides, the lot to cut from (or the split by garment) and the answer. No money, no person.
 */
export function CutPlanPrintView({ model }: { model: CutPlanPrintModel }) {
  return (
    <WithMessages namespaces={[NAMESPACE, 'buying']}>
      <Paper model={model} />
    </WithMessages>
  )
}

function Paper({ model }: { model: CutPlanPrintModel }) {
  const words = useLeatherWords()
  const { t, locale } = words
  const need = model.need
  const timeZone = need?.site.timeZone ?? 'Europe/Rome'
  const rows = need ? visibleNeed(need.rows, model.controls) : []
  const filters = [
    model.controls.tile ? t(`tile.${model.controls.tile}`) : null,
    model.controls.feas !== 'all' ? t(`feasibility.${model.controls.feas}`) : null,
    model.controls.q.trim() ? t('print.search', { q: model.controls.q.trim() }) : null,
  ].filter((entry): entry is string => entry !== null)
  return (
    <article className="fw-lp-print">
      <Button className="fw-lp-print-button" variant="secondary" heldReason={need ? undefined : t('print.held')} onClick={() => window.print()}>
        <Printer size={14} aria-hidden /> {t('print.button')}
      </Button>
      {model.problem ? (
        <Banner tone="danger" title={t('need.error')}>
          {t(model.problem)}
        </Banner>
      ) : !need ? (
        <p className="fw-lp-hint" role="status">
          <Spinner size={14} /> {t('common.loading')}
        </p>
      ) : (
        <section aria-label={t('print.title')}>
          <p className="fw-lp-hint">{t('print.kicker', { site: `${need.site.code} · ${need.site.name}` })}</p>
          <h1 className="fw-lp-h2">{t('print.title')}</h1>
          <p className="fw-lp-hint">
            {need.run ? t('page.asOf', { time: formatDateTime(need.run.finishedAt, { locale, timeZone }) }) : t('page.noRun')} · {t('print.printedAt', { time: formatDateTime(model.printedAt, { locale, timeZone }) })}
          </p>
          <p className="fw-lp-hint">{filters.length > 0 ? t('print.filters', { filters: filters.join(' · ') }) : t('print.noFilters')}</p>
          {rows.length === 0 ? (
            <p className="fw-lp-text">{t('need.empty')}</p>
          ) : (
            <SummaryTable
              label={t('print.title')}
              columns={['order', 'style', 'sizes', 'leather', 'toFind', 'hides', 'lot', 'feasibility'].map((column) => t(`print.col.${column}`))}
              rows={cutPlanRows(rows, words)}
            />
          )}
          <p className="fw-lp-hint">{t('print.foot', { count: rows.length })}</p>
        </section>
      )}
    </article>
  )
}
