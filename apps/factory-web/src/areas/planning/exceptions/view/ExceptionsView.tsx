'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { CheckCheck, Download, MoreHorizontal, Play, Search, ShieldOff } from 'lucide-react'
import { Banner, Card, EmptyState, Menu, MetricStrip } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Pill, Select, Skeleton, Spinner, Tag } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../list-frame/model'
import { formatDateTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { usePageKeys } from '../../../_shared/buying/hooks'
import { KINDS, type ExceptionKind, type PlanningException } from '../api'
import { ackHeld, acknowledgeable, impactOf, kindTone, NAMESPACE, ownerWords, resolveHeld, selectHeld, sentenceOf, snoozeHeld, statusTone, statusWords, TILES, VIEWS, visibleRows, whatOf, type ExceptionsView as ViewName, type Words } from '../model'
import type { ExceptionsActions, ExceptionsModel } from '../view-model'
import { ExceptionDetail } from './ExceptionDetail'
import { ExceptionDialogs } from './ExceptionDialogs'
import '../exceptions.css'

export type { ExceptionsActions, ExceptionsModel } from '../view-model'

const focusedRowId = (): string | null => (typeof document === 'undefined' ? null : ((document.activeElement as HTMLElement | null)?.closest('.ag-row')?.getAttribute('row-id') ?? null))

/**
 * SCR-125 — Planning › Exceptions (design planning.exceptions, an inbox: 00 §2.1 list frame): the band (which run the
 * queue is from, Run plan now), the tiles Waiting for you (New, Mine, Snoozed until today: saved views), and the queue on
 * the shared list frame — the type in words, what it is about with the sentence, the impact (orders, days late), the
 * owner, the age and the state. Enter opens the detail (`?open=`); A acknowledges (the focused or the ticked rows), S
 * snoozes, R resolves with a note, on the rows and in the detail. Ticked rows: Acknowledge N, Export N.
 */
export function ExceptionsView({ model, actions }: { model: ExceptionsModel; actions?: ExceptionsActions }) {
  return (
    <WithMessages namespaces={[NAMESPACE, 'buying', 'lists']}>
      <ExceptionsScreen model={model} actions={actions} />
    </WithMessages>
  )
}

function useWords(timeZone?: string): Words {
  const t = useT(NAMESPACE)
  const units = useT('buying')
  const locale = useLocale()
  return useMemo(() => ({ t, unit: (uom: string) => (uom ? units(`uom.${uom}`) : ''), locale, timeZone }), [t, units, locale, timeZone])
}

function ExceptionsScreen({ model, actions }: { model: ExceptionsModel; actions?: ExceptionsActions }) {
  const words = useWords(model.timeZone)
  const { t, locale } = words
  const place = { locale, timeZone: model.timeZone }
  const [query, setQuery] = useState(model.controls.q)
  useEffect(() => setQuery(model.controls.q), [model.controls.q])
  const typed = useRef(false)
  const latest = useRef(actions)
  latest.current = actions
  useEffect(() => {
    if (!typed.current) return
    const timer = setTimeout(() => latest.current?.onSearch?.(query), 250)
    return () => clearTimeout(timer)
  }, [query])
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  useEffect(() => setSelected(model.selected ?? []), [model.selected])

  const list = model.list.status === 'ready' ? model.list.value : null
  const rows = useMemo(() => (list ? visibleRows(model.rows, model.controls.view, model.controls.q, model.endOfToday) : null), [list, model.rows, model.controls.view, model.controls.q, model.endOfToday])
  const rowsKey = rows?.map((row) => row.id).join(',') ?? ''
  useEffect(() => setSelected((current) => current.filter((id) => rowsKey.includes(id))), [rowsKey])
  const picked = (rows ?? []).filter((row) => selected.includes(row.id))
  const toAck = acknowledgeable(picked)
  const quiet = model.dialog !== null || model.detail !== null

  // A acknowledges the ticked rows (else the focused one), S snoozes and R resolves the focused one.
  usePageKeys((event) => {
    if (quiet || event.metaKey || event.ctrlKey || event.altKey) return
    const key = event.key.toLowerCase()
    if (key !== 'a' && key !== 's' && key !== 'r') return
    const focused = (rows ?? []).find((row) => row.id === focusedRowId()) ?? null
    if (key === 'a') {
      const reach = toAck.length > 0 ? toAck.map((row) => row.id) : focused && !ackHeld(focused, model.can) ? [focused.id] : []
      if (reach.length === 0) return
      event.preventDefault()
      actions?.onAcknowledge?.(reach)
    } else if (key === 's' && focused && !snoozeHeld(focused, model.can)) {
      event.preventDefault()
      actions?.onSnooze?.(focused.id)
    } else if (key === 'r' && focused && !resolveHeld(focused, model.can)) {
      event.preventDefault()
      actions?.onResolve?.(focused.id)
    }
  })

  if (!model.can.view) {
    return (
      <div className="fw-px">
        <Card padded>
          <EmptyState icon={<ShieldOff size={24} aria-hidden />} title={t('noAccess.title')} description={t('noAccess.body')} />
        </Card>
      </div>
    )
  }

  const sites = model.sites.status === 'ready' ? model.sites.value : []
  const site = sites.find((entry) => entry.id === model.siteId) ?? null
  const ownKeys: ListKey[] = [
    { keys: ['a'], does: t('keys.acknowledge') },
    { keys: ['s'], does: t('keys.snooze') },
    { keys: ['r'], does: t('keys.resolve') },
  ]
  const runHeld = !model.can.run ? t('held.noRun') : model.running ? t('held.running') : !model.siteId ? t('held.noSite') : null
  const busy = (id: string) => model.busy.includes(id)

  const KindCell = ({ data }: ICellRendererParams<PlanningException>) =>
    data ? (
      <span className="fw-px-cell">
        <span>
          <Tag tone={kindTone(data.kind)}>{t(`kind.${data.kind}`)}</Tag>
        </span>
        {data.occurrence > 1 && <span className="fw-px-cell-sub">{t('row.again', { count: data.occurrence })}</span>}
      </span>
    ) : null
  const WhatCell = ({ data }: ICellRendererParams<PlanningException>) =>
    data ? (
      <span className="fw-px-cell" title={sentenceOf(data, words)}>
        <span className="fw-px-ellipsis">{whatOf(data, words)}</span>
        <span className="fw-px-cell-sub fw-px-ellipsis">{sentenceOf(data, words)}</span>
      </span>
    ) : null
  const ImpactCell = ({ data }: ICellRendererParams<PlanningException>) =>
    data ? (
      <span className="fw-px-cell" title={impactOf(data, words)}>
        <span className="fw-px-ellipsis">{data.ordersAffected > 0 ? t('impact.orders', { count: data.ordersAffected }) : '—'}</span>
        {data.daysLate !== null && data.daysLate > 0 && <span className="fw-px-cell-sub fw-px-ellipsis">{t('impact.late', { count: data.daysLate })}</span>}
      </span>
    ) : null
  const OwnerCell = ({ data }: ICellRendererParams<PlanningException>) => (data ? <span className={data.owner ? 'fw-px-ellipsis' : 'fw-px-ellipsis fw-px-cell-sub'}>{ownerWords(data, words)}</span> : null)
  const AgeCell = ({ data }: ICellRendererParams<PlanningException>) =>
    data ? (
      <span className="fw-px-cell">
        <span>{data.ageDays === 0 ? t('row.today') : t('row.age', { count: data.ageDays })}</span>
        <span className="fw-px-cell-sub">{t('row.seen', { time: formatDateTime(data.lastSeenAt, place) })}</span>
      </span>
    ) : null
  const StatusCell = ({ data }: ICellRendererParams<PlanningException>) =>
    data ? (
      <span className="fw-px-inline">
        {busy(data.id) ? <Spinner size={12} /> : null}
        <Pill tone={statusTone(data)}>{statusWords(data, words)}</Pill>
      </span>
    ) : null
  const MoreCell = ({ data }: ICellRendererParams<PlanningException>) =>
    data ? (
      <Menu
        label={<MoreHorizontal size={16} aria-hidden />}
        align="right"
        triggerProps={{ 'aria-label': t('row.menu', { what: whatOf(data, words) }) }}
        items={[
          { id: 'open', label: t('row.open'), onSelect: () => actions?.onOpen?.(data.id) },
          { id: 'ack', label: t('row.acknowledge'), onSelect: () => actions?.onAcknowledge?.([data.id]), disabled: ackHeld(data, model.can) !== null },
          { id: 'snooze', label: t('row.snooze'), onSelect: () => actions?.onSnooze?.(data.id), disabled: snoozeHeld(data, model.can) !== null },
          { id: 'resolve', label: t('row.resolve'), onSelect: () => actions?.onResolve?.(data.id), disabled: resolveHeld(data, model.can) !== null },
        ]}
      />
    ) : null
  const columns: ColDef<PlanningException>[] = [
    { colId: 'type', headerName: t('col.type'), minWidth: 200, flex: 1, cellRenderer: KindCell },
    { colId: 'what', headerName: t('col.what'), minWidth: 300, flex: 2.6, cellRenderer: WhatCell },
    { colId: 'impact', headerName: t('col.impact'), minWidth: 150, flex: 0.9, cellRenderer: ImpactCell },
    { colId: 'owner', headerName: t('col.owner'), minWidth: 130, flex: 0.8, cellRenderer: OwnerCell },
    { colId: 'age', headerName: t('col.age'), minWidth: 150, flex: 0.9, cellRenderer: AgeCell },
    { colId: 'status', headerName: t('col.status'), minWidth: 190, flex: 1.1, cellRenderer: StatusCell },
    { colId: 'more', headerName: t('col.more'), minWidth: 64, maxWidth: 64, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
  ]

  const tileView = TILES.find((tile) => tile.view === model.controls.view)?.view ?? null
  let state: ReactNode = undefined
  if (model.list.status === 'error') {
    state = <EmptyState title={t('error.title')} description={t(model.list.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('common.retry')}</Button>} />
  } else if (rows && rows.length === 0) {
    const filtered = model.controls.q.trim() !== '' || model.controls.kind !== null || model.controls.view !== 'queue'
    state = filtered ? (
      <EmptyState
        title={t('empty.noMatch.title')}
        description={t('empty.noMatch.body')}
        action={
          <Button
            size="sm"
            onClick={() => {
              setQuery('')
              actions?.onSearch?.('')
              actions?.onKind?.(null)
              actions?.onView?.('queue')
            }}
          >
            {t('common.clearFilters')}
          </Button>
        }
      />
    ) : (
      <EmptyState title={t('empty.clear.title')} description={list?.latestRun ? t('empty.clear.body') : t('empty.noRun')} />
    )
  }

  return (
    <div className="fw-px">
      <div className="fw-px-head">
        <span className="fw-px-status" role="status">
          {model.list.status === 'loading' ? (
            <Skeleton width={160} height={18} />
          ) : list?.latestRun?.finishedAt ? (
            t('page.asOf', { time: formatDateTime(list.latestRun.finishedAt, place) })
          ) : (
            t('page.noRun')
          )}
          {' · '}
          {t(`live.${model.live}`)}
        </span>
        <span className="fw-px-inline">
          {sites.length > 1 && (
            <Select size="sm" aria-label={t('page.site')} value={model.siteId ?? ''} onChange={(event) => actions?.onSite?.(event.target.value)}>
              {sites.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.code} · {entry.name}
                </option>
              ))}
            </Select>
          )}
          {sites.length === 1 && site && <span className="fw-px-hint">{t('page.siteOne', { site: `${site.code} · ${site.name}` })}</span>}
          <Button size="sm" heldReason={runHeld} onClick={() => actions?.onRun?.()}>
            {model.running ? <Spinner size={12} /> : <Play size={13} aria-hidden />} {model.running ? t('page.running') : t('page.run')}
          </Button>
          <Menu
            label={<MoreHorizontal size={16} aria-hidden />}
            align="right"
            triggerProps={{ 'aria-label': t('page.more') }}
            items={[
              { id: 'export', label: t('page.export'), onSelect: () => actions?.onExport?.((rows ?? []).map((row) => row.id)), disabled: !rows || rows.length === 0 },
              { id: 'keys', label: t('page.keys'), onSelect: () => actions?.onKeys?.() },
            ]}
          />
        </span>
      </div>

      {model.sites.status === 'ready' && sites.length === 0 && <Banner tone="info" title={t('page.noSites')} />}
      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={t(model.notice.key, model.notice.params)}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
              {t('common.dismiss')}
            </Button>
          }
        />
      )}

      <section aria-label={t('tile.title')}>
        <MetricStrip
          metrics={TILES.map((tile) => ({
            label: t(`tile.${tile.id}`),
            value: list ? String(tile.count(list.tiles)) : '—',
            hint: t(`tile.hint.${tile.id}`),
            onClick: () => actions?.onView?.(model.controls.view === tile.view ? 'queue' : tile.view),
            active: tileView === tile.view,
          }))}
        />
      </section>

      <ListFrame<PlanningException>
        label={t('list.label')}
        rows={state ? [] : rows}
        rowId={(row) => row.id}
        columns={columns}
        count={rows ? t('list.count', { count: rows.length }) : '—'}
        search={
          <Input
            size="sm"
            type="search"
            leadingIcon={<Search size={13} aria-hidden />}
            aria-label={t('list.search')}
            placeholder={t('list.search')}
            value={query}
            onChange={(event) => {
              typed.current = true
              setQuery(event.target.value)
            }}
          />
        }
        tools={
          <span className="fw-px-inline">
            <Select size="sm" aria-label={t('view.label')} value={model.controls.view} onChange={(event) => actions?.onView?.(event.target.value as ViewName)}>
              {VIEWS.map((view) => (
                <option key={view} value={view}>
                  {t(`view.${view}`)}
                </option>
              ))}
            </Select>
            <Select size="sm" aria-label={t('kind.label')} value={model.controls.kind ?? ''} onChange={(event) => actions?.onKind?.((event.target.value || null) as ExceptionKind | null)}>
              <option value="">{t('kind.all')}</option>
              {KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {t(`kind.${kind}`)}
                </option>
              ))}
            </Select>
          </span>
        }
        selection={{
          selected,
          onChange: setSelected,
          actions: (
            <>
              <Button
                size="sm"
                variant="primary"
                aria-label={t('bulk.acknowledge', { count: toAck.length })}
                heldReason={!model.can.manage ? t('held.noManage') : toAck.length === 0 ? t('held.noneNew') : model.busy.length > 0 ? t('held.busy') : null}
                onClick={() => actions?.onAcknowledge?.(toAck.map((row) => row.id))}
                aria-keyshortcuts="a"
              >
                <CheckCheck size={13} aria-hidden /> <SelectionLabel>{t('bulk.acknowledge', { count: toAck.length })}</SelectionLabel>
              </Button>
              <Button size="sm" aria-label={t('bulk.export', { count: picked.length })} onClick={() => actions?.onExport?.(picked.map((row) => row.id))}>
                <Download size={13} aria-hidden /> <SelectionLabel>{t('bulk.export', { count: picked.length })}</SelectionLabel>
              </Button>
            </>
          ),
        }}
        isRowSelectable={(row) => {
          const reason = selectHeld(row)
          return reason ? t(reason) : null
        }}
        updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
        more={model.more ? { label: t('list.more'), onMore: () => actions?.onMore?.(), held: model.loadingMore ? t('held.loading') : null } : null}
        keys={ownKeys}
        onHelp={() => actions?.onKeys?.()}
        onOpen={(row) => actions?.onOpen?.(row.id)}
        state={state}
        focusRow={model.focusRow}
        keysOpen={model.keysOpen}
      />
      {model.controls.view !== 'queue' && <p className="fw-px-hint">{t('list.viewing', { view: t(`view.${model.controls.view}`) })}</p>}

      {model.detail && <ExceptionDetail model={model} actions={actions} order={(rows ?? []).map((row) => row.id)} words={words} />}
      <ExceptionDialogs model={model} actions={actions} ownKeys={ownKeys} words={words} />
    </div>
  )
}
