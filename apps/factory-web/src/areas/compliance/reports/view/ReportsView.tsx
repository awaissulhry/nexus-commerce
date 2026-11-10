'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { MoreHorizontal, SlidersHorizontal } from 'lucide-react'
import { EmptyState, Menu } from '@nexus/ui/components'
import { SectionLayout } from '@nexus/ui/patterns'
import { Button, Select, Tag } from '@nexus/ui/primitives'
import { AsOf, DateRangePicker, Modal } from '../../../../lib/i18n/ds-parts'
import { useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { ArrangeDialog } from '../../../quality/reports/view/ArrangeDialog'
import { GAP_TYPES, KPI_KEYS, REGISTER_KINDS } from '../api'
import { dateOfDay, dayOfDate, REPORT_SECTIONS, reviewAddress, reviewYears, type CsvWords, type ReportSection } from '../model'
import { Cr6Panel, ExpiryPanel, GapsPanel, KpiPanel, RegisterPanel } from './Panels'
import type { ReportsActions, ReportsModel } from './types'
import '../reports.css'

export type { Read, ReportsActions, ReportsModel } from './types'

/**
 * SCR-261 — Compliance › Reports (design compliance.reports; ANA-025, B-W2b-272): the band (as of, live, Arrange, ⋯ the annual
 * compliance review (PDF) in a new tab, Export panel (CSV), Keyboard shortcuts), the scope (the screen's company, a brand, the
 * period), then the panels in the person's order and widths: Coverage KPIs (ANA-025 and the main gaps; each tile opens its
 * list), Gaps by type (bars and the table), the expiry calendar of the next 12 months (each chip opens its record), chromium VI
 * results per supplier against the limit, and the register summary. Each panel reads and fails on its own. The Arrange dialog
 * is Quality reports' (the DS PreferencesModal with the widths in its side slot; the same words).
 */
export function ReportsView({ model, actions }: { model: ReportsModel; actions?: ReportsActions }) {
  return (
    <WithMessages namespaces={['compliance-reports', 'quality-reports', 'quality']}>
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
  const t = useT('compliance-reports')
  const [keys, setKeys] = useState(model.keysOpen ?? false)
  const years = reviewYears(model.today)
  const review = reviewAddress(model.prefix, years[0]!, model.address.brandId)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isPageKey(event) || model.arranging) return
      if (event.key === 'a') {
        event.preventDefault()
        actions?.onArrange?.(true)
      } else if (event.key === 'e') {
        event.preventDefault()
        window.open(review, '_blank', 'noopener')
      } else if (event.key === '?') {
        event.preventDefault()
        setKeys(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [actions, model.arranging, review])

  if (!model.can.view) {
    return (
      <div className="fw-cr">
        <EmptyState title={t('noAccess.title')} description={t('noAccess.body')} />
      </div>
    )
  }

  const labels = (keysOf: readonly string[], prefix: string) => Object.fromEntries(keysOf.map((key) => [key, t(`${prefix}.${key}`)]))
  const csv: Record<ReportSection, CsvWords> = {
    kpi: { header: [t('csv.figure'), t('csv.value'), t('csv.part'), t('csv.whole')], none: t('csv.none'), labels: labels(KPI_KEYS, 'kpi') },
    gaps: { header: [t('gaps.type'), t('gaps.count'), t('gaps.styles'), t('gaps.markets'), t('gaps.blocking'), t('gaps.requirements')], none: t('csv.none'), labels: labels(GAP_TYPES, 'gap') },
    expiry: { header: [t('csv.month'), t('csv.validTo'), t('csv.recordType'), t('csv.label'), t('csv.status'), t('csv.detail'), t('csv.party')], none: t('csv.none') },
    cr6: { header: [t('cr6.supplier'), t('cr6.lots'), t('cr6.median'), t('cr6.highestShort'), t('cr6.limit'), t('cr6.fails'), t('cr6.belowShort'), t('cr6.lotReports'), t('cr6.supplierReports')], none: t('cr6.noSupplier') },
    register: {
      header: [t('register.kind'), t('register.opened'), t('register.closed'), t('register.openAtEnd'), t('register.median'), ...(model.register.status === 'ready' ? model.register.value.months : [])],
      none: t('csv.none'),
      labels: labels(REGISTER_KINDS, 'kind'),
    },
  }
  const ready: Record<ReportSection, boolean> = { kpi: model.kpis.status === 'ready', gaps: model.gaps.status === 'ready', expiry: model.expiries.status === 'ready', cr6: model.cr6.status === 'ready', register: model.register.status === 'ready' }
  const panels: Record<ReportSection, ReactNode> = {
    kpi: <KpiPanel model={model} actions={actions} />,
    gaps: <GapsPanel model={model} actions={actions} />,
    expiry: <ExpiryPanel model={model} actions={actions} />,
    cr6: <Cr6Panel model={model} actions={actions} />,
    register: <RegisterPanel model={model} actions={actions} />,
  }
  const brands = model.kpis.status === 'ready' ? model.kpis.value.brands : []
  const brandName = model.address.brandId ? (brands.find((brand) => brand.id === model.address.brandId)?.name ?? (model.kpis.status === 'ready' ? model.kpis.value.brand?.name : null) ?? null) : null

  return (
    <div className="fw-cr">
      <div className="fw-cr-band" role="group" aria-label={t('band.label')}>
        <span className="fw-cr-status">
          {model.asOf ? <AsOf at={model.asOf} /> : <span className="fw-cr-muted">{t('band.reading')}</span>}
          <Tag tone={model.live === 'live' ? 'success' : model.live === 'offline' ? 'warning' : 'neutral'}>{t(`live.${model.live}`)}</Tag>
        </span>
        <span className="fw-cr-actions">
          <Button size="sm" onClick={() => actions?.onArrange?.(true)} aria-keyshortcuts="a">
            <SlidersHorizontal size={14} aria-hidden /> {t('band.arrange')}
          </Button>
          <Menu
            label={<MoreHorizontal size={16} aria-hidden />}
            align="right"
            triggerProps={{ 'aria-label': t('band.more') }}
            items={[
              ...years.map((year) => ({ id: `review-${year}`, label: t('band.review', { year }), href: reviewAddress(model.prefix, year, model.address.brandId), target: '_blank' as const })),
              ...REPORT_SECTIONS.map((panel) => ({ id: `csv-${panel}`, label: t(`band.csv.${panel}`), onSelect: () => actions?.onExport?.(panel, csv[panel]), ...(ready[panel] ? {} : { disabled: true, description: t('band.csvHeld') }) })),
              { id: 'keys', label: t('band.keys'), onSelect: () => setKeys(true) },
            ]}
          />
        </span>
      </div>

      <div className="fw-cr-scope" role="group" aria-label={t('scope.label')}>
        <DateRangePicker value={{ start: dateOfDay(model.range.from), end: dateOfDay(model.range.to) }} onChange={(next) => actions?.onAddress?.({ from: dayOfDate(next.start), to: dayOfDate(next.end) })} />
        {brands.length > 0 || model.address.brandId ? (
          <Select size="sm" aria-label={t('scope.brand')} value={model.address.brandId ?? ''} onChange={(event) => actions?.onAddress?.({ brandId: event.target.value || null })}>
            <option value="">{t('scope.allBrands')}</option>
            {model.address.brandId && !brands.some((brand) => brand.id === model.address.brandId) ? <option value={model.address.brandId}>{brandName ?? t('scope.thisBrand')}</option> : null}
            {brands.map((brand) => (
              <option key={brand.id} value={brand.id}>{`${brand.code} · ${brand.name}`}</option>
            ))}
          </Select>
        ) : null}
        <span className="fw-cr-hint">{model.companyName ? t('scope.company', { company: model.companyName }) : t('scope.everyCompany')}</span>
        {brandName ? <span className="fw-cr-hint">{t('scope.brandOnly', { brand: brandName })}</span> : null}
      </div>

      <SectionLayout sections={model.specs} value={model.layout} onChange={() => undefined} className="fw-cr-sections">
        {Object.fromEntries(REPORT_SECTIONS.map((id) => [id, panels[id]]))}
      </SectionLayout>

      {model.arranging && <ArrangeDialog specs={model.specs.map((spec) => ({ ...spec, label: t(`section.${spec.id}`) }))} layout={model.layout} onApply={(next) => actions?.onArranged?.(next)} onClose={() => actions?.onArrange?.(false)} />}
      {keys && (
        <Modal open onClose={() => setKeys(false)} title={t('keys.title')} size="sm">
          <dl className="fw-cr-keymap">
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
