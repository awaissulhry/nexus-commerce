'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { MoreHorizontal, SlidersHorizontal } from 'lucide-react'
import { EmptyState, Menu } from '@nexus/ui/components'
import { SectionLayout } from '@nexus/ui/patterns'
import { Button, Tag, Toggle } from '@nexus/ui/primitives'
import { AsOf, DateRangePicker, Modal } from '../../../../lib/i18n/ds-parts'
import { useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { ScopeSiteChip } from '../../../../shell/scope/view/ScopeSiteChip'
import { KPI_KEYS, type KpiKey } from '../api'
import { dateOfDay, dayOfDate, printAddress, REPORT_SECTIONS, type CsvWords, type ReportSection } from '../model'
import { ArrangeDialog } from './ArrangeDialog'
import { ComparePanel, IncomingPanel, KpiPanel, TrendPanel } from './Panels'
import type { ReportsActions, ReportsModel } from './types'
import '../reports.css'

export type { Read, ReportsActions, ReportsModel } from './types'

/**
 * SCR-147 — Quality › Reports (design quality.reports; QHS-147, B-W2b-138): the band (as of, live, Arrange, ⋯ Export report
 * (PDF) in a new tab, Export panel (CSV), Keyboard shortcuts), the scope (the top bar's site, the period, compare to the
 * previous one), then the panels in the person's order and widths: Quality KPIs (each tile opens its source list), Trend (FPY
 * and DHU per week, by line, each week's figures in a pop-over), the comparison by line, operation, supplier and style, and
 * incoming quality per supplier. Each panel reads and fails on its own. Groups only, never a person; a group too small to hide
 * one person shows no figure, in words (Statuto dei Lavoratori art. 4; ANA-075). The Pareto and the heat map are W3.
 */
export function ReportsView({ model, actions }: { model: ReportsModel; actions?: ReportsActions }) {
  return (
    <WithMessages namespaces={['quality-reports', 'quality']}>
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
  return !target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"], [role="listbox"]')
}

function Reports({ model, actions }: { model: ReportsModel; actions?: ReportsActions | undefined }) {
  const t = useT('quality-reports')
  const [keys, setKeys] = useState(model.keysOpen ?? false)
  const print = printAddress(model.prefix, model.address)
  const noSite = !model.scope.siteId

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isPageKey(event) || model.arranging) return
      if (event.key === 'a') {
        event.preventDefault()
        actions?.onArrange?.(true)
      } else if (event.key === 'e') {
        event.preventDefault()
        window.open(print, '_blank', 'noopener')
      } else if (event.key === '?') {
        event.preventDefault()
        setKeys(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [actions, model.arranging, print])

  if (!model.can.view) {
    return (
      <div className="fw-qr">
        <EmptyState title={t('noAccess.title')} description={t('noAccess.body')} />
      </div>
    )
  }

  const kpiLabels = Object.fromEntries(KPI_KEYS.map((kpi) => [kpi, t(`kpi.${kpi}`)])) as Record<KpiKey, string>
  const csv: Record<ReportSection, CsvWords> = {
    kpi: { header: [t('csv.kpi'), t('csv.now'), t('csv.previous')], none: t('csv.none'), tooFew: t('tooFewShort'), labels: kpiLabels },
    trend: { header: [t('csv.week'), t('csv.from'), t('csv.to'), t('kpi.fpy'), t('kpi.dhu'), t('trend.pieces'), t('kpi.aqlPass'), t('trend.capaClosed')], none: t('csv.none'), tooFew: t('tooFewShort') },
    table: { header: [t(`dimension.${model.address.by}`), t('table.inspected'), t('table.defects'), t('table.dhu'), t('table.aql'), t('table.ncrs')], none: t(`table.none.${model.address.by}`), tooFew: t('tooFewShort') },
    supplier: { header: [t('incoming.supplier'), t('incoming.lots'), t('incoming.rejected'), t('incoming.crVi'), t('incoming.days'), t('incoming.inspections'), t('incoming.failedInspections')], none: t('incoming.noSupplier'), tooFew: t('tooFewShort') },
  }
  const ready: Record<ReportSection, boolean> = { kpi: model.kpis.status === 'ready', trend: model.trend.status === 'ready', table: model.compare.status === 'ready', supplier: model.incoming.status === 'ready' }
  const panels: Record<ReportSection, ReactNode> = {
    kpi: <KpiPanel model={model} actions={actions} />,
    trend: <TrendPanel model={model} actions={actions} />,
    table: <ComparePanel model={model} actions={actions} />,
    supplier: <IncomingPanel model={model} actions={actions} />,
  }

  return (
    <div className="fw-qr">
      <div className="fw-qr-band" role="group" aria-label={t('band.label')}>
        <span className="fw-qr-status">
          {model.asOf ? <AsOf at={model.asOf} /> : <span className="fw-qr-muted">{noSite ? t('band.noSite') : t('band.reading')}</span>}
          <Tag tone={model.live === 'live' ? 'success' : model.live === 'offline' ? 'warning' : 'neutral'}>{t(`live.${model.live}`)}</Tag>
        </span>
        <span className="fw-qr-actions">
          <Button size="sm" onClick={() => actions?.onArrange?.(true)} aria-keyshortcuts="a">
            <SlidersHorizontal size={14} aria-hidden /> {t('band.arrange')}
          </Button>
          <Menu
            label={<MoreHorizontal size={16} aria-hidden />}
            align="right"
            triggerProps={{ 'aria-label': t('band.more') }}
            items={[
              { id: 'pdf', label: t('band.pdf'), href: print, target: '_blank' },
              ...REPORT_SECTIONS.map((panel) => ({ id: `csv-${panel}`, label: t(`band.csv.${panel}`), onSelect: () => actions?.onExport?.(panel, csv[panel]), ...(ready[panel] ? {} : { disabled: true, description: t('band.csvHeld') }) })),
              { id: 'keys', label: t('band.keys'), onSelect: () => setKeys(true) },
            ]}
          />
        </span>
      </div>

      <div className="fw-qr-scope" role="group" aria-label={t('scope.label')}>
        <DateRangePicker value={{ start: dateOfDay(model.range.from), end: dateOfDay(model.range.to) }} onChange={(next) => actions?.onAddress?.({ from: dayOfDate(next.start), to: dayOfDate(next.end) })} />
        <label className="fw-qr-row">
          <Toggle size="sm" checked={model.address.compare} aria-label={t('scope.compare')} onChange={(compare) => actions?.onAddress?.({ compare })} />
          <span className="fw-qr-hint">{t('scope.compare')}</span>
        </label>
        <ScopeSiteChip model={model.scope} />
        <span className="fw-qr-hint">{t('privacy')}</span>
      </div>

      {noSite ? (
        <EmptyState title={t('noSite.title')} description={t('noSite.body')} />
      ) : (
        <SectionLayout sections={model.specs} value={model.layout} onChange={() => undefined} className="fw-qr-sections">
          {Object.fromEntries(REPORT_SECTIONS.map((id) => [id, panels[id]]))}
        </SectionLayout>
      )}

      {model.arranging && <ArrangeDialog specs={model.specs.map((spec) => ({ ...spec, label: t(`section.${spec.id}`) }))} layout={model.layout} onApply={(next) => actions?.onArranged?.(next)} onClose={() => actions?.onArrange?.(false)} />}
      {keys && (
        <Modal open onClose={() => setKeys(false)} title={t('keys.title')} size="sm">
          <dl className="fw-qr-keymap">
            {(
              [
                ['a', t('keys.arrange')],
                ['e', t('keys.export')],
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
