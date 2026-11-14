'use client'

import { useEffect, useMemo, type ReactNode } from 'react'
import { Gauge, Info, MonitorPlay, MoreHorizontal, ShieldOff, SlidersHorizontal } from 'lucide-react'
import { boardOf, defaultLayout } from '@nexus/factory-domain/insights/dashboards/boards'
import { Card, DetailPopover, EmptyState, Menu } from '@nexus/ui/components'
import { SectionLayout } from '@nexus/ui/patterns'
import { Button, SegmentedControl, Skeleton } from '@nexus/ui/primitives'
import { AsOf, Listbox, Modal } from '../../../../lib/i18n/ds-parts'
import { useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { DASHBOARD_PERIODS, type DashboardPeriod, type LayoutPanel } from '../api'
import { DASHBOARD_KEYS_MAP, isBoardPanel, pinnedOf, presentHref, recordsHrefOf, sectionSpecs, sectionValue, visiblePanels } from '../model'
import { ArrangeDialog } from './ArrangeDialog'
import { ByCompanyPanel, NeedsPanel, NumbersPanel, PinnedReportPanel, TrendsPanel, WipPanel } from './Panels'
import type { DashboardsActions, DashboardsModel } from './types'
import '../dashboards.css'

export type { DashboardsActions, DashboardsModel, Read } from './types'

/**
 * SCR-031 (the role dashboards) and SCR-103 (the Owner's group view) — Home › Insights › Dashboards (design home.dashboards;
 * ANA-002, ANA-003, ANA-004); SCR-490 — Present, the same view in its own window (design tab:present). The band: which
 * dashboard (my role's first, in the address), the period (week, month, quarter: each number over it and the 11 before it),
 * the scope (every company I reach, one company, a site of it), as of, Arrange (saved on the server for me), Present (a new
 * window) and ⋯. Then the panels in my order and widths: the five numbers (each with its line, as of and source, the records
 * behind it and how it is made), Needs action (at most five kinds of exception, then See all N), Are we shipping on time? (the
 * weeks with the target, a line per company), Is work piling up? (the garments waiting at each stage with their age, a flow
 * strip), By company and site (the Owner's group view) and the reports pinned here. Each panel reads and fails on its own. No
 * figure is about one person. One view model, nothing fetched.
 */
export function DashboardsView({ model, actions }: { model: DashboardsModel; actions?: DashboardsActions }) {
  return (
    <WithMessages namespaces={['home-dashboards', 'home-kpis', 'home', 'home-reports']}>
      <Dashboards model={model} actions={actions} />
    </WithMessages>
  )
}

/** A key the page answers while the focus is on the page (not typing, not in a menu, a dialog or a list box). */
function isPageKey(event: KeyboardEvent): boolean {
  if (event.metaKey || event.ctrlKey || event.altKey) return false
  const target = event.target as HTMLElement | null
  if (!target) return true
  if (target.isContentEditable) return false
  return !target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"], [role="listbox"], [role="grid"]')
}

function Dashboards({ model, actions }: { model: DashboardsModel; actions?: DashboardsActions | undefined }) {
  const t = useT('home-dashboards')
  const tr = useT('home-reports')
  const present = model.mode === 'present'
  const board = model.board
  const panels: LayoutPanel[] = useMemo(() => {
    if (!board) return []
    const layout = model.layout.status === 'ready' ? model.layout.value.panels : defaultLayout(boardOf(board.key)!)
    return visiblePanels(layout, board.panels)
  }, [board, model.layout])
  const label = (id: string): string => {
    if (isBoardPanel(id)) return t(`panel.${id}`)
    const pinned = pinnedOf(id)
    return pinned?.kind === 'panel' ? t(`pinned.${pinned.area}.${pinned.panel}`) : pinned?.kind === 'report' ? tr(`report.${pinned.key}.title`) : id
  }
  const specs = sectionSpecs(panels, label)
  const value = sectionValue(panels)
  const presentAddress = presentHref(model.prefix, { ...model.address, board: board?.key ?? model.address.board })
  const dialogOpen = Boolean(model.arranging || model.keysOpen)

  useEffect(() => {
    if (present) return
    const onKey = (event: KeyboardEvent) => {
      if (!isPageKey(event) || dialogOpen) return
      if (event.key === 'A' && event.shiftKey) {
        event.preventDefault()
        actions?.onArrange?.(true)
      } else if (event.key === 'p' || event.key === 'P') {
        event.preventDefault()
        window.open(presentAddress, '_blank', 'noopener')
      } else if (event.key === '?') {
        event.preventDefault()
        actions?.onKeys?.(true)
      } else if (/^[1-5]$/.test(event.key) && model.numbers.status === 'ready') {
        const number = model.numbers.value.numbers[Number(event.key) - 1]
        const href = number ? recordsHrefOf(number, model.built) : null
        if (href) {
          event.preventDefault()
          actions?.onOpen?.(`${model.prefix}${href}`)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [actions, dialogOpen, model.built, model.numbers, model.prefix, present, presentAddress])

  if (!model.can.view) {
    return (
      <div className="fw-dash">
        <Card padded>
          <EmptyState icon={<ShieldOff size={24} aria-hidden />} title={t('noAccess.title')} description={t('noAccess.body')} />
        </Card>
      </div>
    )
  }

  if (model.boards.status !== 'ready') {
    return (
      <div className="fw-dash">
        {model.boards.status === 'loading' ? (
          <div className="fw-dash-skeleton" role="status" aria-label={t('panel.loading')}>
            <Skeleton height={32} />
            <Skeleton height={120} />
            <span className="fw-dash-muted">{t('panel.stillLoading')}</span>
          </div>
        ) : (
          <Card padded>
            <EmptyState
              icon={<Gauge size={22} aria-hidden />}
              title={t('boards.failed')}
              description={t(model.boards.problem)}
              action={
                <Button size="sm" onClick={() => actions?.onRetry?.('boards')}>
                  {t('panel.retry')}
                </Button>
              }
            />
          </Card>
        )}
      </div>
    )
  }

  const boards = model.boards.value
  const company = boards.companies.find((entry) => entry.id === model.address.company) ?? null
  const sites = company ? company.sites : boards.companies.flatMap((entry) => entry.sites)
  const site = sites.find((entry) => entry.id === model.address.site) ?? null
  const asOf = model.numbers.status === 'ready' ? model.numbers.value.asOf : boards.asOf
  const scopeWords = [company?.name ?? t('scope.allCompanies'), site?.name ?? t('scope.allSites')].join(' · ')

  const node = (id: string): ReactNode => {
    switch (id) {
      case 'numbers':
        return <NumbersPanel model={model} actions={actions} />
      case 'needs-action':
        return <NeedsPanel model={model} actions={actions} />
      case 'trends':
        return <TrendsPanel model={model} actions={actions} />
      case 'wip':
        return <WipPanel model={model} actions={actions} />
      case 'by-company':
        return <ByCompanyPanel model={model} actions={actions} />
      default: {
        const pinned = pinnedOf(id)
        return pinned ? <PinnedReportPanel model={model} pinned={pinned} /> : null
      }
    }
  }

  return (
    <div className={`fw-dash${present ? ' fw-dash--present' : ''}`}>
      {present ? (
        <div className="fw-dash-band" role="status" aria-label={t('band.label')}>
          <h1 className="fw-dash-present-title">{board ? t(`board.${board.key}`) : t('title')}</h1>
          <span className="fw-dash-muted">
            {scopeWords} · {t(`periodWord.${model.address.period}`)} · <AsOf at={asOf} now={model.now} />
          </span>
          <span className="fw-dash-muted">{t('present.refresh')}</span>
        </div>
      ) : (
        <div className="fw-dash-band" role="group" aria-label={t('band.label')}>
          <span className="fw-dash-scope">
            <Listbox
              size="sm"
              width={240}
              ariaLabel={t('band.board')}
              value={board?.key ?? ''}
              onChange={(next) => actions?.onBoard?.(next as NonNullable<typeof board>['key'])}
              options={boards.boards.map((entry) => ({ value: entry.key, label: t(`board.${entry.key}`), ...(entry.mine ? { trailing: t('band.mine') } : {}) }))}
            />
            <SegmentedControl
              size="sm"
              ariaLabel={t('band.period')}
              value={model.address.period}
              onChange={(next) => actions?.onAddress?.({ ...model.address, period: next as DashboardPeriod })}
              options={DASHBOARD_PERIODS.map((period) => ({ value: period, label: t(`period.${period}`) }))}
            />
            <Listbox
              size="sm"
              width={220}
              ariaLabel={t('band.company')}
              value={model.address.company ?? ''}
              onChange={(next) => actions?.onAddress?.({ ...model.address, company: next || null, site: null })}
              options={[{ value: '', label: t('scope.allCompanies') }, ...boards.companies.map((entry) => ({ value: entry.id, label: entry.name }))]}
            />
            {sites.length > 0 ? (
              <Listbox
                size="sm"
                width={200}
                ariaLabel={t('band.site')}
                value={model.address.site ?? ''}
                onChange={(next) => actions?.onAddress?.({ ...model.address, site: next || null })}
                options={[{ value: '', label: t('scope.allSites') }, ...sites.map((entry) => ({ value: entry.id, label: entry.name }))]}
              />
            ) : null}
          </span>
          <span className="fw-dash-actions">
            <span className="fw-dash-muted">
              {t('band.read')} <AsOf at={asOf} now={model.now} />
            </span>
            <Button size="sm" onClick={() => actions?.onArrange?.(true)} aria-keyshortcuts="Shift+A" heldReason={!board ? t('band.noBoard') : undefined}>
              <SlidersHorizontal size={14} aria-hidden /> {t('band.arrange')}
            </Button>
            <Button size="sm" onClick={() => window.open(presentAddress, '_blank', 'noopener')} aria-keyshortcuts="P">
              <MonitorPlay size={14} aria-hidden /> {t('band.present')}
            </Button>
            <Menu
              label={<MoreHorizontal size={16} aria-hidden />}
              align="right"
              triggerProps={{ 'aria-label': t('band.more') }}
              items={[
                { id: 'reset', label: t('arrange.reset'), onSelect: () => actions?.onReset?.(), ...(model.layout.status === 'ready' && model.layout.value.saved ? {} : { disabled: true, description: t('arrange.resetHeld') }) },
                { id: 'keys', label: t('band.keys'), onSelect: () => actions?.onKeys?.(true) },
              ]}
            />
          </span>
        </div>
      )}

      {!board ? (
        <Card padded>
          <EmptyState icon={<Gauge size={22} aria-hidden />} title={t('boards.none')} description={t('boards.noneBody')} />
        </Card>
      ) : (
        <SectionLayout sections={specs} value={value} onChange={() => undefined} className="fw-dash-sections">
          {Object.fromEntries(panels.map((panel) => [panel.id, node(panel.id)]))}
        </SectionLayout>
      )}

      {!present ? (
        <div className="fw-dash-foot">
          <span className="fw-dash-muted">{t('foot.fresh')}</span>
          <DetailPopover trigger={<Info size={14} aria-hidden />} triggerLabel={t('keys.title')} label={t('keys.title')} triggerClassName="fw-dash-explain">
            <dl className="fw-dash-keymap">
              {DASHBOARD_KEYS_MAP.map(([key, does]) => (
                <div key={key}>
                  <dt>
                    <kbd>{key}</kbd>
                  </dt>
                  <dd>{t(does)}</dd>
                </div>
              ))}
            </dl>
          </DetailPopover>
        </div>
      ) : null}

      {model.arranging && board ? (
        <ArrangeDialog
          specs={specs}
          layout={value}
          saved={model.layout.status === 'ready' && model.layout.value.saved}
          busy={model.arrange?.busy ?? false}
          problem={model.arrange?.problem ?? null}
          onApply={(next) => actions?.onArranged?.(next)}
          onReset={() => actions?.onReset?.()}
          onClose={() => actions?.onArrange?.(false)}
        />
      ) : null}
      {model.keysOpen ? (
        <Modal open onClose={() => actions?.onKeys?.(false)} title={t('keys.title')} size="sm">
          <dl className="fw-dash-keymap">
            {DASHBOARD_KEYS_MAP.map(([key, does]) => (
              <div key={key}>
                <dt>
                  <kbd>{key}</kbd>
                </dt>
                <dd>{t(does)}</dd>
              </div>
            ))}
          </dl>
        </Modal>
      ) : null}
    </div>
  )
}
