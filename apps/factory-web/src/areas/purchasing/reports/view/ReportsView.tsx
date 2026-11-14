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
import { ScopeSiteChip } from '../../../../shell/scope/view/ScopeSiteChip'
import { ArrangeDialog } from '../../../quality/reports/view/ArrangeDialog'
import { dateOfDay, dayOfDate, groupLabel, pivotMonths, printAddress, quickRange, QUICK_PERIODS, REPORT_SECTIONS, monthText, type ReportSection, type SpendCsvWords } from '../model'
import { ChaseDialog } from './ChaseDialog'
import { DrillDialog } from './DrillDialog'
import { LatePanel } from './LatePanel'
import { SpendPanel } from './SpendPanel'
import type { ReportsActions, ReportsModel } from './types'
import '../../../quality/reports/reports.css'
import '../reports.css'

export type { ChaseResult, ChaseState, DrillState, Read, ReportsActions, ReportsModel } from './types'

/**
 * SCR-255 — Purchasing › Reports (design purchasing.reports; B-W2b-350): the band (as of, live, Arrange, Print in a new tab, ⋯ the
 * e-mail every Monday — held with its reason —, Export spend / late lines (CSV), Keyboard shortcuts), the scope (the top bar's
 * company and site, the period: this month so far by default, for the monthly buying review), then the panels in the person's
 * order and widths: Spend (bars by supplier, category, material, company or month for one measure — production spend, sample
 * orders apart, orders —, each bar opening the POs behind it; the pivot table below by month) and Late lines and what they block
 * (the list frame ranked by the customer orders they put at risk, Chase per order or for the selected lines, the chain of the
 * chosen line: supplier → PO line → work orders → customer orders). Each panel reads and fails on its own. The Arrange dialog is
 * Quality reports' (the DS PreferencesModal with the widths in its side slot).
 */
export function ReportsView({ model, actions }: { model: ReportsModel; actions?: ReportsActions }) {
  return (
    <WithMessages namespaces={['purchasing-reports', 'quality-reports', 'warehouse-reports', 'stock', 'home-dashboards']}>
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
  const t = useT('purchasing-reports')
  // B-W2b-434 (follow-up DB1:01): Save as dashboard is said by the dashboards' catalogue.
  const td = useT('home-dashboards')
  const wr = useT('warehouse-reports')
  const locale = useLocale()
  const [keys, setKeys] = useState(model.keysOpen ?? false)
  const print = printAddress(model.prefix, model.range, model.address.by)
  const dialogOpen = model.arranging || model.drill !== null || model.chase !== null

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
      <div className="fw-pr">
        <EmptyState title={t('noAccess.title')} description={t('noAccess.body')} />
      </div>
    )
  }

  const cost = model.can.cost && (model.spend.status !== 'ready' || model.spend.value.sight.values)
  const spend = model.spend.status === 'ready' ? model.spend.value : null
  const months = spend ? pivotMonths(spend) : []
  const spendWords: SpendCsvWords = {
    header: [t(`by.${model.address.by}`), ...(cost ? months.map((month) => monthText(month, locale)) : []), ...(cost ? [t('col.production'), t('col.samples')] : []), t('col.orders'), t('col.lines'), t('col.sampleOrders'), ...(cost ? [t('col.share')] : [])],
    group: (group) => groupLabel(group, model.address.by, { category: (kind) => wr(`type.${kind}`), locale }),
    month: (month) => monthText(month, locale),
    locale,
    cost,
  }
  const lateRows = model.late.status === 'ready' ? [...model.late.value.rows, ...model.lateMore] : []
  const ready: Record<ReportSection, boolean> = { spend: model.spend.status === 'ready', late: model.late.status === 'ready' }
  const exports: Record<ReportSection, () => void> = {
    spend: () => actions?.onExportSpend?.(spendWords, t('spend.all')),
    late: () => actions?.onExportLate?.(lateRows, [t('late.col.order'), t('late.col.line'), t('late.col.supplier'), t('late.col.material'), t('late.col.needed'), t('late.col.expected'), t('late.col.daysLate'), t('late.col.why'), t('late.col.workOrders'), t('late.col.salesOrders')], (reason) => t(`reason.${reason}`)),
  }
  const panels: Record<ReportSection, ReactNode> = {
    spend: <SpendPanel model={model} actions={actions} />,
    late: <LatePanel model={model} actions={actions} />,
  }
  const day = (value: string) => formatDate(`${value}T12:00:00Z`, { locale })

  return (
    <div className="fw-pr">
      <div className="fw-pr-band" role="group" aria-label={t('band.label')}>
        <span className="fw-pr-status">
          {model.asOf ? <AsOf at={model.asOf} /> : <span className="fw-pr-muted">{t('band.reading')}</span>}
          <Tag tone={model.live === 'live' ? 'success' : model.live === 'offline' ? 'warning' : 'neutral'}>{t(`live.${model.live}`)}</Tag>
        </span>
        <span className="fw-pr-actions">
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
              { id: 'monday', label: t('band.monday'), disabled: true, description: t('band.mondayHeld') },
              ...REPORT_SECTIONS.map((panel) => ({ id: `csv-${panel}`, label: t(`band.csv.${panel}`), onSelect: exports[panel], ...(ready[panel] ? {} : { disabled: true, description: t('band.csvHeld') }) })),
              { id: 'dashboard', label: td('pin.menu'), onSelect: () => actions?.onSaveAsDashboard?.() },
              { id: 'keys', label: t('band.keys'), onSelect: () => setKeys(true) },
            ]}
          />
        </span>
      </div>

      <div className="fw-pr-scope" role="group" aria-label={t('scope.label')}>
        <span className="fw-pr-company">{model.scope.company?.name ?? ''}</span>
        <ScopeSiteChip model={model.scope} />
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
        <span className="fw-pr-hint">{t('scope.placed', { from: day(model.range.from), to: day(model.range.to) })}</span>
      </div>

      <SectionLayout sections={model.specs} value={model.layout} onChange={() => undefined} className="fw-pr-sections">
        {Object.fromEntries(REPORT_SECTIONS.map((id) => [id, panels[id]]))}
      </SectionLayout>

      {model.arranging && <ArrangeDialog specs={model.specs.map((spec) => ({ ...spec, label: t(`section.${spec.id}`) }))} layout={model.layout} onApply={(next) => actions?.onArranged?.(next)} onClose={() => actions?.onArrange?.(false)} />}
      {model.drill && <DrillDialog model={model} actions={actions} />}
      {model.chase && <ChaseDialog model={model} actions={actions} />}
      {keys && (
        <Modal open onClose={() => setKeys(false)} title={t('keys.title')} size="sm">
          <dl className="fw-pr-keymap">
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
