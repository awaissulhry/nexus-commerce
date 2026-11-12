'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { MoreHorizontal, Printer, SlidersHorizontal } from 'lucide-react'
import { Banner, EmptyState, Menu } from '@nexus/ui/components'
import { SectionLayout } from '@nexus/ui/patterns'
import { Button, Tag } from '@nexus/ui/primitives'
import { AsOf, DateRangePicker, Modal } from '../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { ScopeSiteChip } from '../../../../shell/scope/view/ScopeSiteChip'
import { ArrangeDialog } from '../../../quality/reports/view/ArrangeDialog'
import { adherenceCsvRows, coverCsvRows, dateOfDay, dayOfDate, laneLabel, printAddress, quickRange, QUICK_PERIODS, REPORT_SECTIONS, utilisationCsvRows, type ReportSection } from '../model'
import { AdherencePanel } from './AdherencePanel'
import { CoverPanel } from './CoverPanel'
import { DrillDialog } from './DrillDialog'
import { NAMESPACE } from './Parts'
import { UtilisationPanel } from './UtilisationPanel'
import type { ReportsActions, ReportsModel } from './types'
import '../../../quality/reports/reports.css'
import '../reports.css'

export type { DrillState, Read, ReportsActions, ReportsModel } from './types'

/**
 * SCR-254 — Planning › Reports (design planning.reports; B-W2b-349): the band (as of, live, Arrange, Print in a new tab, ⋯ the
 * e-mail every month — held with its reason —, Export ▾ each panel's rows (CSV), Keyboard shortcuts), the scope (the top bar's
 * company and site — planning is per site: with "All sites" the first site is shown and said —, the period: this month so far by
 * default, the monthly planning review), then the panels in the person's order and widths: Schedule adherence (% on time per week
 * against the plan the floor had, lines × weeks below), the Utilisation trend (what happened and the plan's load ahead, per lane,
 * the plant and workshop) and Material cover (days of cover and the projected stock-out day per material, Draft PO on What to
 * buy & make). Each panel reads and fails on its own; a bar, a point or a cell opens the work orders behind it.
 */
export function ReportsView({ model, actions }: { model: ReportsModel; actions?: ReportsActions }) {
  return (
    <WithMessages namespaces={[NAMESPACE, 'quality-reports', 'warehouse-reports', 'stock']}>
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
      <div className="fw-plr">
        <EmptyState title={t('noAccess.title')} description={t('noAccess.body')} />
      </div>
    )
  }
  if (!model.can.plans || !model.site) {
    return (
      <div className="fw-plr">
        <EmptyState title={t('noSite.title')} description={model.can.plans ? t('noSite.body') : t('noSite.notPlanned')} />
      </div>
    )
  }

  const ready: Record<ReportSection, boolean> = { adherence: model.adherence.status === 'ready', utilisation: model.utilisation.status === 'ready', cover: model.cover.status === 'ready' }
  const exports: Record<ReportSection, () => void> = {
    adherence: () => {
      if (model.adherence.status !== 'ready') return
      actions?.onExport?.(
        'adherence',
        [t('adherence.csv.line'), t('adherence.csv.week'), t('adherence.csv.finished'), t('adherence.csv.planned'), t('adherence.csv.onTime'), t('adherence.csv.late'), t('adherence.csv.notPlanned'), t('adherence.csv.onTimePct'), t('adherence.csv.meanFinish'), t('adherence.csv.meanStart')],
        adherenceCsvRows(model.adherence.value, { line: (line) => (line ? `${line.code} ${line.name}` : t('adherence.noLine')), all: t('adherence.all') }),
      )
    },
    utilisation: () => {
      if (model.utilisation.status !== 'ready') return
      actions?.onExport?.(
        'utilisation',
        [t('utilisation.csv.lane'), t('utilisation.csv.week'), t('utilisation.csv.earned'), t('utilisation.csv.available'), t('utilisation.csv.used'), t('utilisation.csv.booked'), t('utilisation.csv.capacity'), t('utilisation.csv.load'), t('utilisation.csv.unit')],
        utilisationCsvRows(model.utilisation.value, { lane: (lane) => laneLabel(lane, { plant: t('utilisation.plant'), kind: (kind) => t(`utilisation.kind.${kind}`) }) }),
      )
    },
    cover: () => {
      if (model.cover.status !== 'ready') return
      actions?.onExport?.(
        'cover',
        [t('cover.csv.code'), t('cover.csv.name'), t('cover.csv.colour'), t('cover.csv.unit'), t('cover.csv.onHand'), t('cover.csv.safety'), t('cover.csv.demand'), t('cover.csv.receipts'), t('cover.csv.days'), t('cover.csv.stockOut'), t('cover.csv.belowSafety'), t('cover.csv.state'), t('cover.csv.orders'), t('cover.csv.onOrder'), t('cover.csv.nextDue')],
        coverCsvRows(model.cover.value.rows, { state: (state) => t(`cover.state.${state}`) }),
      )
    },
  }
  const panels: Record<ReportSection, ReactNode> = {
    adherence: <AdherencePanel model={model} actions={actions} />,
    utilisation: <UtilisationPanel model={model} actions={actions} />,
    cover: <CoverPanel model={model} actions={actions} />,
  }
  const day = (value: string) => formatDate(`${value}T12:00:00Z`, { locale })

  return (
    <div className="fw-plr">
      <div className="fw-plr-band" role="group" aria-label={t('band.label')}>
        <span className="fw-plr-status">
          {model.asOf ? <AsOf at={model.asOf} /> : <span className="fw-plr-muted">{t('band.reading')}</span>}
          <Tag tone={model.live === 'live' ? 'success' : model.live === 'offline' ? 'warning' : 'neutral'}>{t(`live.${model.live}`)}</Tag>
        </span>
        <span className="fw-plr-actions">
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
              { id: 'monthly', label: t('band.monthly'), disabled: true, description: t('band.monthlyHeld') },
              ...REPORT_SECTIONS.map((panel) => ({ id: `csv-${panel}`, label: t(`band.csv.${panel}`), onSelect: exports[panel], ...(ready[panel] ? {} : { disabled: true, description: t('band.csvHeld') }) })),
              { id: 'keys', label: t('band.keys'), onSelect: () => setKeys(true) },
            ]}
          />
        </span>
      </div>

      <div className="fw-plr-scope" role="group" aria-label={t('scope.label')}>
        <span className="fw-plr-company">{model.scope.company?.name ?? ''}</span>
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
        <span className="fw-plr-hint">{t('scope.period', { from: day(model.range.from), to: day(model.range.to) })}</span>
      </div>
      {model.scope.allSites ? (
        <Banner tone="info" title={t('scope.oneSite', { site: model.site.name })}>
          {t('scope.oneSiteBody')}
        </Banner>
      ) : null}

      <SectionLayout sections={model.specs} value={model.layout} onChange={() => undefined} className="fw-plr-sections">
        {Object.fromEntries(REPORT_SECTIONS.map((id) => [id, panels[id]]))}
      </SectionLayout>

      {model.arranging && <ArrangeDialog specs={model.specs.map((spec) => ({ ...spec, label: t(`section.${spec.id}`) }))} layout={model.layout} onApply={(next) => actions?.onArranged?.(next)} onClose={() => actions?.onArrange?.(false)} />}
      {model.drill && <DrillDialog model={model} actions={actions} />}
      {keys && (
        <Modal open onClose={() => setKeys(false)} title={t('keys.title')} size="sm">
          <dl className="fw-plr-keymap">
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
