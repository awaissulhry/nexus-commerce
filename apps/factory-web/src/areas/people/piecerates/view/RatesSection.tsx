'use client'

import { useEffect, useMemo, useState } from 'react'
import { CheckCheck, MoreHorizontal, X } from 'lucide-react'
import { Banner, EmptyState, Menu } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Pill, SegmentedControl } from '@nexus/ui/primitives'
import { useLocale } from '../../../../lib/i18n/provider'
import { ListFrame } from '../../../../list-frame/ListFrame'
import type { RateRow } from '../api'
import { byStyle, confirmHeld, dayText, minutesText, rateText, rowsOfTile, STATE_TONE, versionsOfRows } from '../model'
import type { PieceActions, PieceModel } from '../view-model'
import { Figure, said, Section, usePieceWords, type PieceWords } from './parts'

type Row = RateRow & { readonly first: boolean }

/** The status as the design says it: Provisional until …, Confirmed, Superseded. */
export function StatePill({ row, t, locale }: { row: Pick<RateRow['version'], 'state' | 'trialEndsOn' | 'effectiveTo'>; t: PieceWords; locale: string }) {
  return (
    <Pill tone={STATE_TONE[row.state]} dot>
      {row.state === 'PROVISIONAL' ? t('state.provisionalUntil', { day: dayText(row.trialEndsOn, locale) ?? '' }) : t(`state.${row.state}`)}
    </Pill>
  )
}

/**
 * Rate table (design sec:rates, MES-254) on the shared list frame, rows by style: a new rate is a new version with a reason,
 * never an edit (c.c. art. 2101), so nothing here edits a cell. Enter opens the version's record. Bulk: Confirm n provisional
 * rates → the review. Pay figures need the pay grain: without it, operations and SMVs only, and the page says so.
 */
export function RatesSection({ model, actions }: { model: PieceModel; actions?: PieceActions | undefined }) {
  const t = usePieceWords()
  const locale = useLocale()
  const { can } = model
  const [search, setSearch] = useState(model.address.q)
  useEffect(() => setSearch(model.address.q), [model.address.q])
  useEffect(() => {
    if (search === model.address.q) return
    const timer = setTimeout(() => actions?.onAddress({ q: search }), 300)
    return () => clearTimeout(timer)
  })
  const page = model.rates?.status === 'ready' ? model.rates.value : null
  const payShown = page?.payShown ?? can.pay
  const rows = useMemo<Row[]>(() => (page ? byStyle(rowsOfTile(page.rows, model.address.tile, model.today)) : []), [page, model.address.tile, model.today])
  const hidden = t('rates.hidden')
  const columns = useMemo<ColDef<Row>[]>(() => {
    const open = (row: Row) => actions?.onOpenVersion(row.version.id)
    return [
      {
        colId: 'style',
        headerName: t('rates.style'),
        width: 210,
        pinned: 'left',
        valueGetter: (params) => (params.data ? (params.data.first ? (params.data.style ? `${params.data.style.code} · ${params.data.style.name}` : t('rates.general')) : '') : ''),
      },
      {
        colId: 'operation',
        headerName: t('rates.operation'),
        minWidth: 220,
        flex: 1,
        valueGetter: (params) => (params.data ? `${params.data.rate.operation.code} · ${params.data.rate.operation.name}` : ''),
        cellRenderer: (params: ICellRendererParams<Row>) =>
          params.data ? (
            <a
              className="fw-pp-link"
              href={`?open=${encodeURIComponent(params.data.version.id)}`}
              onClick={(event) => {
                if (event.metaKey || event.ctrlKey) return
                event.preventDefault()
                open(params.data!)
              }}
            >
              {params.data.rate.operation.code} · {params.data.rate.operation.name}
            </a>
          ) : null,
      },
      { colId: 'band', headerName: t('rates.band'), width: 90, valueGetter: (params) => (params.data ? (params.data.rate.sizeBand === 'ALL' ? t('rates.allSizes') : params.data.rate.sizeBand) : '') },
      { colId: 'smv', headerName: t('rates.smv'), width: 130, type: 'numericColumn', valueGetter: (params) => minutesText(params.data?.rate.standardMinutes, locale) ?? '—' },
      ...(payShown
        ? ([
            { colId: 'perMinute', headerName: t('rates.perMinute'), width: 140, type: 'numericColumn', cellRenderer: (params: ICellRendererParams<Row>) => (params.data ? <Figure value={rateText(params.data.rate.ratePerMinute, params.data.table.currency, locale)} hidden={hidden} /> : null) },
            { colId: 'perPiece', headerName: t('rates.perPiece'), width: 150, type: 'numericColumn', cellRenderer: (params: ICellRendererParams<Row>) => (params.data ? <Figure value={rateText(params.data.rate.ratePerPiece, params.data.table.currency, locale)} hidden={hidden} /> : null) },
          ] as ColDef<Row>[])
        : []),
      { colId: 'basis', headerName: t('rates.basis'), width: 130, valueGetter: (params) => (params.data ? t(`basis.${params.data.rate.basis}`) : '') },
      {
        colId: 'status',
        headerName: t('rates.status'),
        width: 210,
        valueGetter: (params) => params.data?.version.state ?? '',
        cellRenderer: (params: ICellRendererParams<Row>) => (params.data ? <StatePill row={params.data.version} t={t} locale={locale} /> : null),
      },
      { colId: 'effective', headerName: t('rates.effective'), width: 210, valueGetter: (params) => (params.data ? `${dayText(params.data.version.effectiveFrom, locale)} – ${dayText(params.data.version.effectiveTo, locale) ?? t('rates.open')}` : '') },
      { colId: 'version', headerName: t('rates.version'), width: 90, type: 'numericColumn', valueGetter: (params) => (params.data ? `v${params.data.version.versionNo}` : '') },
      { colId: 'published', headerName: t('rates.published'), width: 130, valueGetter: (params) => (params.data ? (dayText(params.data.version.publishedOn, locale) ?? t('rates.notPublished')) : '') },
      { colId: 'read', headerName: t('rates.read'), width: 120, valueGetter: (params) => (params.data ? t('rates.readBy', { read: params.data.version.readBy.read, of: params.data.version.readBy.of }) : '') },
      { colId: 'why', headerName: t('rates.why'), width: 180, valueGetter: (params) => (params.data ? t(`why.${params.data.version.changeReason}`) : '') },
      {
        colId: 'actions',
        headerName: '',
        width: 72,
        pinned: 'right',
        sortable: false,
        cellRenderer: (params: ICellRendererParams<Row>) =>
          params.data ? (
            <Menu
              label={<MoreHorizontal size={16} aria-hidden />}
              align="right"
              triggerProps={{ 'aria-label': t('rates.more') }}
              items={[
                { id: 'open', label: t('rates.openVersion'), onSelect: () => open(params.data!) },
                ...(can.manage
                  ? [
                      { id: 'new', label: t('rates.newFrom'), onSelect: () => actions?.onNewVersion({ tableId: params.data!.table.id }) },
                      { id: 'publish', label: t('rates.publishThis'), onSelect: () => actions?.onPublish(params.data!.version.id) },
                    ]
                  : []),
                { id: 'sheet', label: t('rates.print'), href: `${model.prefix}/people/piecerates/rate-sheet?version=${encodeURIComponent(params.data.version.id)}`, target: '_blank' },
              ]}
            />
          ) : null,
      },
    ]
  }, [t, locale, payShown, hidden, can.manage, actions, model.prefix])

  const chosen = page ? versionsOfRows(page.rows, model.selectedRates) : { ids: [], rates: 0 }
  const state =
    model.rates?.status === 'failed' ? (
      <EmptyState
        title={t('common.failed')}
        description={said(t, model.rates.problem)}
        action={
          <Button size="sm" onClick={() => actions?.onRetry()}>
            {t('common.retry')}
          </Button>
        }
      />
    ) : page && page.rows.length === 0 ? (
      model.address.q ? (
        <EmptyState title={t('rates.noMatch')} description={t('rates.noMatchBody')} />
      ) : (
        <EmptyState
          title={t('rates.empty')}
          description={t('rates.emptyBody')}
          action={
            can.manage ? (
              <span className="fw-pp-actions">
                <Button size="sm" variant="primary" onClick={() => actions?.onNewVersion()}>
                  {t('band.newVersion')}
                </Button>
                <Button size="sm" onClick={() => actions?.onNewVersion('library')}>
                  {t('rates.copySmv')}
                </Button>
              </span>
            ) : undefined
          }
        />
      )
    ) : page && rows.length === 0 ? (
      <EmptyState title={t('rates.noMatch')} description={t('rates.tileEmpty')} />
    ) : undefined

  return (
    <Section
      id="rates"
      title={t('rates.title')}
      hint={t('rates.hint')}
      actions={
        can.manage ? (
          <Button size="sm" variant="secondary" onClick={() => actions?.onNewVersion()}>
            {t('band.newVersion')}
          </Button>
        ) : undefined
      }
    >
      {page && !page.payShown && <Banner tone="info" title={t('rates.payHidden')} />}
      {page && !page.complete && <Banner tone="warning" title={t('rates.cut')} />}
      <ListFrame<Row>
        listKey="people.piecerates"
        label={t('rates.title')}
        rows={model.rates?.status === 'loading' ? null : rows}
        rowId={(row) => row.rate.id}
        columns={columns}
        count={t('rates.count', { count: rows.length })}
        search={<Input size="sm" type="search" value={search} placeholder={t('rates.search')} aria-label={t('rates.search')} onChange={(event) => setSearch(event.target.value)} />}
        tools={
          <span className="fw-pr8-row">
            <SegmentedControl size="sm" aria-label={t('rates.view')} value={model.address.allVersions ? 'all' : 'current'} onChange={(value) => actions?.onAddress({ allVersions: value === 'all' })} options={[{ value: 'current', label: t('rates.current') }, { value: 'all', label: t('rates.all') }]} />
            {model.address.tile && (
              <Button size="sm" variant="tonal" onClick={() => actions?.onTile(null)}>
                {t(model.address.tile === 'TRIAL' ? 'tiles.trial' : 'tiles.unread')} <X size={12} aria-hidden />
              </Button>
            )}
          </span>
        }
        onHelp={() => actions?.onHelp(true)}
        onOpen={(row) => actions?.onOpenVersion(row.version.id)}
        withheld={payShown ? [] : [{ label: t('rates.perMinute'), reason: t('rates.hidden') }, { label: t('rates.perPiece'), reason: t('rates.hidden') }]}
        isRowSelectable={(row) => {
          const held = confirmHeld(row, model.today)
          return can.manage ? (held ? said(t, held) : null) : t('rates.held.right')
        }}
        selection={{
          selected: model.selectedRates,
          onChange: (ids) => actions?.onSelectRates(ids),
          actions: (
            <Button size="sm" variant="primary" onClick={() => actions?.onConfirmRates()}>
              <CheckCheck size={14} aria-hidden /> <SelectionLabel>{t('rates.confirmN', { count: chosen.rates })}</SelectionLabel>
            </Button>
          ),
        }}
        state={state}
      />
    </Section>
  )
}
