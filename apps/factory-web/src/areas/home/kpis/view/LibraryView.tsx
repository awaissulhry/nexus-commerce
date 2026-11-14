'use client'

import { useMemo } from 'react'
import Link from 'next/link'
import { Download, FileSpreadsheet, Gauge, PackagePlus, ShieldOff } from 'lucide-react'
import { Banner, Card, EmptyState, Menu } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, FilterChip, Input, Skeleton, Spinner, Tag } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { ActionConfirm, AsOf } from '../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import type { KpiItem, KpiLibrary } from '../api'
import {
  areaChips,
  areaOf,
  kpiHref,
  libraryRows,
  notInstalled,
  ownerOf,
  ownerText,
  periodText,
  problemOf,
  problemText,
  statusOf,
  statusWords,
  valueText,
  wordsOf,
  type KpiArea,
  type KpisAbilities,
  type LibraryAddress,
} from '../model'
import '../kpis.css'

/**
 * SCR-249 — Home › Insights › KPI library (design home.kpis `catalogue`, ANA-012): one place for every KPI so a number
 * means the same everywhere. Every KPI of the metric layer with its name and plain definition (the version in force, in the
 * reader's language), area, unit, owner, its value now in my scope (its own period, current; a value I may not see says
 * why: margin KPIs are listed for everyone, their values only with the margin rights), its version and how many dashboards,
 * reports and alerts read it. Area chips and a search; a row opens the KPI (a real link: ⌘-click opens a new tab); rows
 * selected → Export N definitions; ⋯ › Export definitions writes them all. The owner installs the standard KPIs the company
 * has no version of yet. Targets are W3 (no column). One view model, nothing fetched.
 */

export interface LibraryModel {
  readonly can: KpisAbilities
  readonly prefix: string
  readonly address: LibraryAddress
  readonly library: { readonly value: KpiLibrary | null; readonly problem: string | null }
  readonly selected: readonly string[]
  /** The read's clock, for "as of" (design cases). */
  readonly now?: number
  /** The owner's install: asked (the confirmation open), running, its result or its refusal. */
  readonly install?: { readonly asking: boolean; readonly busy: boolean; readonly installed: readonly string[] | null; readonly problem: string | null }
}

export interface LibraryActions {
  onAddress?: (address: LibraryAddress) => void
  onRetry?: () => void
  onOpen?: (key: string) => void
  onSelect?: (keys: string[]) => void
  /** The CSV of these KPIs (every one shown when null). */
  onExport?: (keys: readonly string[] | null) => void
  onInstall?: (step: 'ask' | 'confirm' | 'cancel' | 'dismiss') => void
}

export function LibraryView({ model, actions }: { model: LibraryModel; actions?: LibraryActions }) {
  return (
    <WithMessages namespaces={['home-kpis', 'lists']}>
      <LibraryScreen model={model} actions={actions} />
    </WithMessages>
  )
}

function LibraryScreen({ model, actions }: { model: LibraryModel; actions?: LibraryActions }) {
  const t = useT('home-kpis')
  const locale = useLocale()
  const library = model.library.value
  const rows = useMemo(() => (library ? libraryRows(library.kpis, model.address, locale) : null), [library, model.address, locale])
  const chips = useMemo(() => (library ? areaChips(library.kpis) : []), [library])
  const missing = useMemo(() => (library ? notInstalled(library.kpis) : []), [library])
  const set = (change: Partial<LibraryAddress>) => actions?.onAddress?.({ ...model.address, ...change })

  const columns = useMemo<ColDef<KpiItem>[]>(() => {
    const NameCell = ({ data }: ICellRendererParams<KpiItem>) => {
      if (!data) return null
      const words = wordsOf(data, locale)
      return (
        <span className="fw-kpi-cell">
          <Link className="fw-kpi-link" href={kpiHref(model.prefix, data.key)}>
            {words.name}
          </Link>
          <span className="fw-kpi-sub">{words.definition}</span>
        </span>
      )
    }
    const AreaCell = ({ data }: ICellRendererParams<KpiItem>) => (data ? <Tag tone="neutral">{t(`area.${areaOf(data.key)}`)}</Tag> : null)
    const ValueCell = ({ data }: ICellRendererParams<KpiItem>) => {
      if (!data) return null
      const unit = data.shown?.unit ?? data.calculation?.unit ?? 'COUNT'
      const problem = problemOf(data.value, data.calculation?.grain ?? data.shown?.grain ?? null)
      const text = problem ? null : valueText(unit, data.value.value, data.value.currency, t, locale)
      return (
        <span className="fw-kpi-value">
          {text ? <strong>{text}</strong> : <span className="fw-kpi-muted">{problemText(problem ?? { key: 'problem.NO_VALUE' }, t)}</span>}
          {data.value.period && <span className="fw-kpi-muted">{periodText(data.value.period, t, locale)}{data.value.stale ? ` · ${t('value.stale')}` : ''}</span>}
        </span>
      )
    }
    const VersionCell = ({ data }: ICellRendererParams<KpiItem>) => {
      if (!data) return null
      const status = statusOf(data)
      const words = statusWords(status, t)
      return (
        <span className="fw-kpi-tags">
          <Tag tone={words.tone}>{words.text}</Tag>
          {status.kind === 'IN_FORCE' && status.drafts > 0 && <Tag tone="info">{t('status.drafts', { count: status.drafts })}</Tag>}
          {data.measuresDiffer && <Tag tone="warning">{t('status.differs')}</Tag>}
        </span>
      )
    }
    const valueOf = (item: KpiItem) => {
      const problem = problemOf(item.value, item.calculation?.grain ?? item.shown?.grain ?? null)
      return problem ? problemText(problem, t) : (valueText(item.shown?.unit ?? item.calculation?.unit ?? 'COUNT', item.value.value, item.value.currency, t, locale) ?? '')
    }
    return [
      { colId: 'kpi', headerName: t('library.col.kpi'), minWidth: 300, flex: 2.6, cellRenderer: NameCell, autoHeight: true, valueGetter: ({ data }) => (data ? wordsOf(data, locale).name : '') },
      { colId: 'area', headerName: t('library.col.area'), minWidth: 120, flex: 0.6, cellRenderer: AreaCell, valueGetter: ({ data }) => (data ? t(`area.${areaOf(data.key)}`) : '') },
      { colId: 'unit', headerName: t('library.col.unit'), minWidth: 110, flex: 0.6, valueGetter: ({ data }) => (data ? t(`unit.${data.shown?.unit ?? data.calculation?.unit ?? 'COUNT'}`) : '') },
      { colId: 'owner', headerName: t('library.col.owner'), minWidth: 190, flex: 0.9, valueGetter: ({ data }) => (data ? ownerText(ownerOf(data), t) : '') },
      { colId: 'now', headerName: t('library.col.now'), minWidth: 180, flex: 1, cellRenderer: ValueCell, autoHeight: true, valueGetter: ({ data }) => (data ? valueOf(data) : '') },
      { colId: 'version', headerName: t('library.col.version'), minWidth: 190, flex: 1, cellRenderer: VersionCell, autoHeight: true, valueGetter: ({ data }) => (data ? statusWords(statusOf(data), t).text : '') },
      { colId: 'uses', headerName: t('library.col.uses'), minWidth: 100, flex: 0.5, type: 'numericColumn', valueGetter: ({ data }) => (data ? data.uses : 0) },
    ]
  }, [t, locale, model.prefix])

  if (!model.can.view) {
    return (
      <div className="fw-kpi">
        <Card padded>
          <EmptyState icon={<ShieldOff size={24} aria-hidden />} title={t('noAccess.title')} description={t('noAccess.body')} />
        </Card>
      </div>
    )
  }

  const state = model.library.problem && !library ? (
    <EmptyState
      icon={<Gauge size={22} aria-hidden />}
      title={t('library.failed')}
      description={t(model.library.problem)}
      action={
        <Button size="sm" onClick={() => actions?.onRetry?.()}>
          {t('common.retry')}
        </Button>
      }
    />
  ) : rows && rows.length === 0 ? (
    <EmptyState
      icon={<Gauge size={22} aria-hidden />}
      title={t('library.noMatch')}
      description={t('library.noMatchBody')}
      action={
        <Button size="sm" onClick={() => actions?.onAddress?.({ q: '', area: null })}>
          {t('library.clear')}
        </Button>
      }
    />
  ) : null

  const exportHeld = !rows || rows.length === 0 ? t('held.nothingToExport') : null
  const install = model.install
  const selectedCount = model.selected.length

  return (
    <div className="fw-kpi">
      <div className="fw-kpi-band fw-kpi-row--between" role="status" aria-label={t('band.label')}>
        <span className="fw-kpi-band">
          {library ? (
            <span className="fw-kpi-muted">
              {t('library.updated')} <AsOf at={library.asOf} now={model.now} /> · {t('library.count', { count: library.kpis.length })}
            </span>
          ) : model.library.problem ? null : (
            <span className="fw-kpi-muted">
              <Skeleton width={200} height={14} />
            </span>
          )}
        </span>
        <span className="fw-kpi-actions">
          {model.can.manage && missing.length > 0 && (
            <Button size="sm" variant="primary" heldReason={install?.busy ? t('held.installing') : undefined} onClick={() => actions?.onInstall?.('ask')}>
              {install?.busy ? <Spinner size={14} /> : <PackagePlus size={14} aria-hidden />} {t('install.button', { count: missing.length })}
            </Button>
          )}
          <Menu
            label={
              <>
                <Download size={14} aria-hidden /> {t('library.more')}
              </>
            }
            align="right"
            items={[{ id: 'csv', label: t('library.exportAll'), icon: <FileSpreadsheet size={14} aria-hidden />, disabled: exportHeld !== null, description: exportHeld, onSelect: () => actions?.onExport?.(null) }]}
          />
        </span>
      </div>

      {install?.installed && (
        <Banner tone="success" title={t('install.done', { count: install.installed.length })} onDismiss={() => actions?.onInstall?.('dismiss')}>
          {install.installed.length === 0 ? t('install.nothing') : t('install.doneBody')}
        </Banner>
      )}
      {install?.problem && (
        <Banner tone="danger" title={t('install.refused')} onDismiss={() => actions?.onInstall?.('dismiss')}>
          {t(install.problem)}
        </Banner>
      )}
      {!model.can.manage && missing.length > 0 && <p className="fw-kpi-muted">{t('install.readerNote', { count: missing.length })}</p>}

      <section className="fw-kpi-section" aria-labelledby="fw-kpi-catalogue">
        <div className="fw-kpi-head">
          <h2 id="fw-kpi-catalogue" className="fw-kpi-h">
            <Gauge size={16} aria-hidden /> {t('library.title')}
          </h2>
          <p className="fw-kpi-muted">{t('library.intro')}</p>
        </div>
        {!library && !model.library.problem && (
          <p className="fw-kpi-muted" role="status">
            {t('common.loading')}
          </p>
        )}
        <ListFrame<KpiItem>
          label={t('library.title')}
          rows={library ? (rows ?? []) : model.library.problem ? [] : null}
          rowId={(row) => row.key}
          columns={columns}
          count={rows ? t('library.shown', { count: rows.length }) : '—'}
          search={
            <Input size="sm" type="search" aria-label={t('library.search')} placeholder={t('library.search')} value={model.address.q} onChange={(event) => set({ q: event.target.value })} />
          }
          tools={
            <span className="fw-kpi-chips" role="group" aria-label={t('library.areas')}>
              <FilterChip pressed={model.address.area === null} onClick={() => set({ area: null })}>
                {t('library.allAreas')}
              </FilterChip>
              {chips.map((chip) => (
                <FilterChip key={chip.area} pressed={model.address.area === chip.area} count={chip.count} onClick={() => set({ area: model.address.area === chip.area ? null : (chip.area as KpiArea) })}>
                  {t(`area.${chip.area}`)}
                </FilterChip>
              ))}
            </span>
          }
          selection={{
            selected: model.selected,
            onChange: (ids) => actions?.onSelect?.(ids),
            actions: (
              <Button size="sm" onClick={() => actions?.onExport?.(model.selected)}>
                <FileSpreadsheet size={14} aria-hidden /> <SelectionLabel>{t('library.exportSelected', { count: selectedCount })}</SelectionLabel>
              </Button>
            ),
          }}
          cards={{ hrefOf: (row) => kpiHref(model.prefix, row.key) }}
          onOpen={(row) => actions?.onOpen?.(row.key)}
          state={state}
          title={t('library.title')}
        />
        {model.library.problem && library !== null && (
          <Banner tone="warning" title={t('library.stale')}>
            {t(model.library.problem)}
          </Banner>
        )}
        <p className="fw-kpi-muted fw-kpi-foot">{t('library.foot')}</p>
      </section>

      {install?.asking && library && (
        <ActionConfirm
          impact={{
            level: 'confirm',
            title: t('install.question', { count: missing.length }),
            confirmLabel: t('install.confirm', { count: missing.length }),
            consequences: missing.map((item) => wordsOf(item, locale).name),
            sideEffects: [t('install.inForce'), t('install.uses')],
          }}
          onConfirm={() => actions?.onInstall?.('confirm')}
          onCancel={() => actions?.onInstall?.('cancel')}
        />
      )}
    </div>
  )
}
