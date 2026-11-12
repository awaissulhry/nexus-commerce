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
import { AGE_BUCKETS } from '../api'
import { dateOfDay, dayOfDate, printAddress, quickRange, QUICK_PERIODS, REPORT_SECTIONS, type CsvWords, type ReportSection } from '../model'
import { AgeingPanel, LeatherPanel } from './Panels'
import type { ReportsActions, ReportsModel } from './types'
import '../../../quality/reports/reports.css'
import '../reports.css'

export type { Read, ReportsActions, ReportsModel } from './types'

/**
 * SCR-257 — Warehouse › Reports (design warehouse.reports; B-W2b-356): the band (as of, live, Arrange, Print in a new tab, ⋯ the
 * e-mail every Monday — held with its reason —, Export panel (CSV), Keyboard shortcuts), the scope (the top bar's site, the
 * period: this month so far by default, for the monthly stock review), then the panels in the person's order and widths: Stock
 * ageing (stacked bars by age bucket per material type, the average age; the table below; the articles of a type, each opening
 * Stock and its moves) and Leather use (bars per article for one measure — received, cut, back as remnant, scrapped, on hand —,
 * each opening its hides; the table by article and supplier lot, adding up). Each panel reads and fails on its own. The Arrange
 * dialog is Quality reports' (the DS PreferencesModal with the widths in its side slot). Delivery performance and turnover come
 * with their waves (design: Later).
 */
export function ReportsView({ model, actions }: { model: ReportsModel; actions?: ReportsActions }) {
  return (
    <WithMessages namespaces={['warehouse-reports', 'quality-reports', 'stock']}>
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
  const t = useT('warehouse-reports')
  const stock = useT('stock')
  const locale = useLocale()
  const [keys, setKeys] = useState(model.keysOpen ?? false)
  const print = printAddress(model.prefix, model.range)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isPageKey(event) || model.arranging) return
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
  }, [actions, model.arranging, print])

  if (!model.can.view) {
    return (
      <div className="fw-wr">
        <EmptyState title={t('noAccess.title')} description={t('noAccess.body')} />
      </div>
    )
  }

  const unitWord = (uom: Parameters<CsvWords['unitWord']>[0]) => stock(`uom.${uom}`)
  const typeWord: CsvWords['typeWord'] = (type) => t(`type.${type}`)
  const cost = model.can.cost
  const bucketHeads = AGE_BUCKETS.flatMap((bucket) => [t(`bucket.${bucket}`), t('csv.shareOf', { bucket: t(`bucket.${bucket}`) }), ...(cost ? [t('csv.valueOf', { bucket: t(`bucket.${bucket}`) })] : [])])
  const csv: Record<ReportSection, CsvWords> = {
    ageing: { header: [t('col.type'), t('col.article'), ...bucketHeads, t('col.whole'), ...(cost ? [t('col.value')] : []), t('col.averageDays'), t('col.oldestDays')], unitWord, typeWord, noLot: t('leather.noLot'), locale, cost },
    leather: {
      header: [
        t('leather.col.article'),
        t('leather.col.lot'),
        t('leather.col.unit'),
        ...(['start', 'received', 'cut', 'remnant', 'scrapped', 'other', 'end'] as const).map((key) => t(`leather.col.${key}`)),
        t('leather.col.hidesReceived'),
        t('leather.col.hidesOnHand'),
        ...(cost ? [t('leather.col.valueReceived'), t('leather.col.valueCut'), t('leather.col.valueScrapped'), t('leather.col.valueEnd')] : []),
      ],
      unitWord,
      typeWord,
      noLot: t('leather.noLot'),
      locale,
      cost,
    },
  }
  const ready: Record<ReportSection, boolean> = { ageing: model.ageing.status === 'ready', leather: model.leather.status === 'ready' }
  const panels: Record<ReportSection, ReactNode> = {
    ageing: <AgeingPanel model={model} actions={actions} />,
    leather: <LeatherPanel model={model} actions={actions} />,
  }
  const day = (value: string) => formatDate(`${value}T12:00:00Z`, { locale })

  return (
    <div className="fw-wr">
      <div className="fw-wr-band" role="group" aria-label={t('band.label')}>
        <span className="fw-wr-status">
          {model.asOf ? <AsOf at={model.asOf} /> : <span className="fw-wr-muted">{t('band.reading')}</span>}
          <Tag tone={model.live === 'live' ? 'success' : model.live === 'offline' ? 'warning' : 'neutral'}>{t(`live.${model.live}`)}</Tag>
        </span>
        <span className="fw-wr-actions">
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
              ...REPORT_SECTIONS.map((panel) => ({ id: `csv-${panel}`, label: t(`band.csv.${panel}`), onSelect: () => actions?.onExport?.(panel, csv[panel]), ...(ready[panel] ? {} : { disabled: true, description: t('band.csvHeld') }) })),
              { id: 'keys', label: t('band.keys'), onSelect: () => setKeys(true) },
            ]}
          />
        </span>
      </div>

      <div className="fw-wr-scope" role="group" aria-label={t('scope.label')}>
        <ScopeSiteChip model={model.scope} />
        <DateRangePicker
          value={{ start: dateOfDay(model.range.from), end: dateOfDay(model.range.to) }}
          onChange={(next) => actions?.onAddress?.({ from: dayOfDate(next.start), to: dayOfDate(next.end) })}
          presets={QUICK_PERIODS.map((quick) => ({
            label: t(`scope.quick.${quick}`),
            get: () => {
              const range = quickRange(quick, model.today)
              return { start: dateOfDay(range.from), end: dateOfDay(range.to) }
            },
          }))}
        />
        <span className="fw-wr-hint">{t('scope.asAt', { day: day(model.range.to) })}</span>
      </div>

      <SectionLayout sections={model.specs} value={model.layout} onChange={() => undefined} className="fw-wr-sections">
        {Object.fromEntries(REPORT_SECTIONS.map((id) => [id, panels[id]]))}
      </SectionLayout>

      {model.arranging && <ArrangeDialog specs={model.specs.map((spec) => ({ ...spec, label: t(`section.${spec.id}`) }))} layout={model.layout} onApply={(next) => actions?.onArranged?.(next)} onClose={() => actions?.onArrange?.(false)} />}
      {keys && (
        <Modal open onClose={() => setKeys(false)} title={t('keys.title')} size="sm">
          <dl className="fw-wr-keymap">
            {(
              [
                ['a', t('keys.arrange')],
                ['p', t('keys.print')],
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
