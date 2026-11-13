'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { MoreHorizontal, Printer, SlidersHorizontal } from 'lucide-react'
import { EmptyState, Menu } from '@nexus/ui/components'
import { SectionLayout } from '@nexus/ui/patterns'
import { Button, Tag } from '@nexus/ui/primitives'
import { AsOf, DateRangePicker, Modal } from '../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { ArrangeDialog } from '../../../quality/reports/view/ArrangeDialog'
import { BACKLOG_HORIZONS } from '../api'
import { backlogCsvRows, bucketLabel, dateOfDay, dayOfDate, groupName, intakeCsvRows, printAddress, quickRange, QUICK_PERIODS, reasonWords, REPORT_SECTIONS, returnsCsvRows, type ReportSection } from '../model'
import { BacklogPanel } from './BacklogPanel'
import { DrillDialog } from './DrillDialog'
import { HeadlinePanel } from './HeadlinePanel'
import { IntakePanel } from './IntakePanel'
import { NAMESPACE } from './Parts'
import { ReturnsPanel } from './ReturnsPanel'
import type { ReportsActions, ReportsModel } from './types'
import '../../../quality/reports/reports.css'
import '../reports.css'

export type { Read, ReportsActions, ReportsModel } from './types'

/**
 * SCR-250 — Sales › Reports (design sales.reports; B-W2b-348): the band (as of, live, Arrange, Print in a new tab, ⋯ Export each
 * panel's data (CSV), Save as dashboard (Home) — held with its reason —, Keyboard shortcuts), the scope (the top bar's company,
 * the period: this month so far by default, the monthly sales review), then the panels in the person's order and widths: the
 * Headline (the period in five numbers), Order intake (by week or month, split by customer, style or season), the Backlog by
 * promise week (now, late weeks toned, by customer or style) and Return reasons (by reason, style, size, colour, customer; the
 * most returned styles by size). Each panel reads and fails on its own; a tile, a bar, a cell opens what it counts.
 */
export function ReportsView({ model, actions }: { model: ReportsModel; actions?: ReportsActions }) {
  return (
    <WithMessages namespaces={[NAMESPACE, 'quality-reports', 'warehouse-reports']}>
      <Reports model={model} actions={actions} />
    </WithMessages>
  )
}

/** A key the page answers while the focus is on the page (not typing, not in a menu or a dialog). */
function isPageKey(event: KeyboardEvent): boolean {
  if (event.metaKey || event.ctrlKey || event.altKey) return false
  const target = event.target as HTMLElement | null
  if (!target) return true
  if (target.isContentEditable) return false
  return !target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"], [role="listbox"], [role="grid"], [role="treegrid"]')
}

function Reports({ model, actions }: { model: ReportsModel; actions?: ReportsActions | undefined }) {
  const t = useT(NAMESPACE)
  const wr = useT('warehouse-reports')
  const locale = useLocale()
  const [keys, setKeys] = useState(model.keysOpen ?? false)
  const print = printAddress(model.prefix, model.address, model.range)
  const dialogOpen = model.arranging || model.drill !== null

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isPageKey(event) || dialogOpen) return
      if (event.key === 'a') {
        event.preventDefault()
        actions?.onArrange?.(true)
      } else if (event.key === 'p') {
        event.preventDefault()
        window.open(print, '_blank', 'noopener')
      } else if (event.key === '?') {
        event.preventDefault()
        setKeys(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [actions, dialogOpen, print])

  if (!model.can.view) {
    return (
      <div className="fw-slr">
        <EmptyState title={t('noAccess.title')} description={t('noAccess.body')} />
      </div>
    )
  }

  const ready: Record<Exclude<ReportSection, 'strip'>, boolean> = { intake: model.intake.status === 'ready', backlog: model.backlog.status === 'ready', returns: model.returns.status === 'ready' }
  const price = model.can.price
  const exports: Record<Exclude<ReportSection, 'strip'>, () => void> = {
    intake: () => {
      if (model.intake.status !== 'ready') return
      const answer = model.intake.value
      const words = { none: t(`intake.none.${answer.split}`), fees: t('intake.fees') }
      actions?.onExport?.(
        'intake',
        [t(`intake.byOption.${answer.by}`), t(`intake.splitOption.${answer.split}`), t('intake.col.orders'), t('intake.col.pieces'), ...(answer.sight.values ? [t('intake.col.value')] : [])],
        intakeCsvRows(answer, { bucket: (bucket) => bucketLabel(bucket, locale), group: (group) => groupName(group, words), price: answer.sight.values, locale }),
      )
    },
    backlog: () => {
      if (model.backlog.status !== 'ready') return
      const answer = model.backlog.value
      actions?.onExport?.(
        'backlog',
        [t(`backlog.col.${answer.by}`), ...BACKLOG_HORIZONS.map((horizon) => t(`backlog.horizon.${horizon}`)), t('backlog.col.total'), t('intake.col.orders'), ...(answer.sight.values ? [t('backlog.col.value')] : [])],
        backlogCsvRows(answer, { group: (group) => `${group.code} ${group.name}`, price: answer.sight.values, locale }),
      )
    },
    returns: () => {
      if (model.returns.status !== 'ready') return
      const answer = model.returns.value
      const reason = (code: string) => {
        const found = answer.reasons.find((entry) => entry.key === code)
        return found ? reasonWords(found, locale) : code
      }
      actions?.onExport?.(
        'returns',
        [t('drill.col.return'), t('drill.col.line'), t('drill.col.requestedOn'), t('drill.col.reason'), t('drill.col.style'), t('drill.col.colour'), t('drill.col.size'), t('drill.col.customer'), t('drill.col.pieces'), ...(answer.sight.values ? [t('drill.col.credited')] : [])],
        returnsCsvRows(answer, { reason, price: answer.sight.values, locale }),
      )
    },
  }
  const panels: Record<ReportSection, ReactNode> = {
    strip: <HeadlinePanel model={model} actions={actions} />,
    intake: <IntakePanel model={model} actions={actions} />,
    backlog: <BacklogPanel model={model} actions={actions} />,
    returns: <ReturnsPanel model={model} actions={actions} />,
  }
  const day = (value: string) => formatDate(`${value}T12:00:00Z`, { locale })

  return (
    <div className="fw-slr">
      <div className="fw-slr-band" role="group" aria-label={t('band.label')}>
        <span className="fw-slr-status">
          {model.asOf ? <AsOf at={model.asOf} /> : <span className="fw-slr-muted">{t('band.reading')}</span>}
          <Tag tone={model.live === 'live' ? 'success' : model.live === 'offline' ? 'warning' : 'neutral'}>{t(`live.${model.live}`)}</Tag>
        </span>
        <span className="fw-slr-actions">
          <Button size="sm" onClick={() => actions?.onArrange?.(true)} aria-keyshortcuts="a">
            <SlidersHorizontal size={14} aria-hidden /> {t('band.arrange')}
          </Button>
          <Button size="sm" onClick={() => window.open(print, '_blank', 'noopener')} aria-keyshortcuts="p">
            <Printer size={14} aria-hidden /> {t('band.print')}
          </Button>
          <Menu
            label={<MoreHorizontal size={16} aria-hidden />}
            align="right"
            triggerProps={{ 'aria-label': t('band.more') }}
            items={[
              ...(['intake', 'backlog', 'returns'] as const).map((panel) => ({ id: `csv-${panel}`, label: t(`band.csv.${panel}`), onSelect: exports[panel], ...(ready[panel] ? {} : { disabled: true, description: t('band.csvHeld') }) })),
              { id: 'dashboard', label: t('band.dashboard'), disabled: true, description: t('band.dashboardHeld') },
              { id: 'keys', label: t('band.keys'), onSelect: () => setKeys(true) },
            ]}
          />
        </span>
      </div>

      <div className="fw-slr-scope" role="group" aria-label={t('scope.label')}>
        <span className="fw-slr-company">{model.scope.company?.name ?? t('scope.allCompanies')}</span>
        <DateRangePicker
          value={{ start: dateOfDay(model.range.from), end: dateOfDay(model.range.to) }}
          onChange={(next) => actions?.onAddress?.({ from: dayOfDate(next.start), to: dayOfDate(next.end) })}
          presets={QUICK_PERIODS.map((quick) => ({
            label: wr(`scope.quick.${quick}`),
            get: () => {
              const range = quickRange(quick, model.today)
              return { start: dateOfDay(range.from), end: dateOfDay(range.to) }
            },
          }))}
        />
        <span className="fw-slr-hint">{t('scope.period', { from: day(model.range.from), to: day(model.range.to) })}</span>
        <span className="fw-slr-hint">{price ? t('scope.wholeCompany') : t('scope.noPrice')}</span>
      </div>

      <SectionLayout sections={model.specs} value={model.layout} onChange={() => undefined} className="fw-slr-sections">
        {Object.fromEntries(REPORT_SECTIONS.map((id) => [id, panels[id]]))}
      </SectionLayout>

      {model.arranging && <ArrangeDialog specs={model.specs.map((spec) => ({ ...spec, label: t(`section.${spec.id}`) }))} layout={model.layout} onApply={(next) => actions?.onArranged?.(next)} onClose={() => actions?.onArrange?.(false)} />}
      {model.drill && <DrillDialog model={model} actions={actions} />}
      {keys && (
        <Modal open onClose={() => setKeys(false)} title={t('keys.title')} size="sm">
          <dl className="fw-slr-keymap">
            {(
              [
                ['a', t('keys.arrange')],
                ['p', t('keys.print')],
                ['Enter', t('keys.bar')],
                ['J / K', t('keys.nextBar')],
                ['?', t('keys.help')],
              ] as const
            ).map(([key, does]) => (
              <div key={key}>
                <dt>
                  <kbd>{key}</kbd>
                </dt>
                <dd>{does}</dd>
              </div>
            ))}
          </dl>
        </Modal>
      )}
    </div>
  )
}
