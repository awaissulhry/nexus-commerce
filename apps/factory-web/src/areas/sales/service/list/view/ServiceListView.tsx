'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { Copy, MoreHorizontal, Plus, X } from 'lucide-react'
import { Card, EmptyState, Menu, MetricStrip, type MenuItemDef } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, FilterChip, Input, Select } from '@nexus/ui/primitives'
import { CASE_KINDS, COVER_STATES } from '@nexus/factory-domain/sales/service/rules'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../../list-frame/model'
import { Freshness } from '../../../../quality/_shared/parts'
import type { CaseKind, CaseRow, CaseView, CoverState } from '../../api'
import { chipsOf, isFiltered, pageNotices, personPhrase, recordHref, rowVerbHeld, SAVED_ROWS, tileValue, TILES, HOME_ADDRESS, type RowVerb } from '../../model'
import { CoverTag, isPageKey, KindTag, NoticeLine, PriorityTag, ServiceMessages, StatusPill, useWords } from '../../parts'
import type { ServiceListActions, ServiceListModel } from '../view-model'
import { NewCaseDialog } from './NewCaseDialog'

export type { ServiceListActions, ServiceListModel } from '../view-model'

/**
 * SCR-217 — Sales › After-sales › Warranty & service (design sales.service, a workspace list): the band (one sentence, the
 * freshness and live state, ⋯, New case `c`), the notices (one at a time, the most serious first, the rest behind "N more"),
 * the tiles (New · Waiting for the customer · Waiting for a part: each a saved row of the API whose chip lands in the filter
 * row), Rows ▾ / Kind ▾ / Cover ▾ and the search, every filter a chip with ✕ and Clear all, then the shared list frame: Case
 * (a real link), Customer or rider, Garment serial, Style, Cover (legal guarantee / factory guarantee / out of cover, decided
 * or suggested), Status, Opened, Owner, Kind and the row's ⋯ (Open · Open in a new tab · Make RMA · Make repair · Close · Copy
 * number), each verb held before the click with why. Selection: Copy N numbers and the frame's Export N. Cause and SLA are
 * Later (not drawn).
 */
export function ServiceListView({ model, actions }: { model: ServiceListModel; actions?: ServiceListActions }) {
  return (
    <ServiceMessages>
      <List model={model} actions={actions} />
    </ServiceMessages>
  )
}

function List({ model, actions }: { model: ServiceListModel; actions?: ServiceListActions }) {
  const { t, say, day } = useWords()
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  const [search, setSearch] = useState(model.address.q)
  const [noticesOpen, setNoticesOpen] = useState(model.noticesOpen ?? false)
  useEffect(() => setSearch(model.address.q), [model.address.q])
  const rows = model.rows.items
  const rowsKey = rows?.map((row) => row.id).join(',') ?? ''
  useEffect(() => setSelected((current) => current.filter((id) => rowsKey.includes(id))), [rowsKey])
  const offline = model.live === 'offline'
  const act = useRef(actions)
  act.current = actions

  // c: New case (never while typing, in a dialog or a menu).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isPageKey(event) || model.newCase) return
      if (event.key === 'c' && model.can.manage) {
        event.preventDefault()
        act.current?.onNew?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [model.newCase, model.can.manage])

  const columns = useMemo<ColDef<CaseRow>[]>(() => {
    const verbItem = (row: CaseRow, verb: RowVerb, label: string): MenuItemDef => {
      const held = say(rowVerbHeld(row, verb, model.can, offline))
      return { id: verb, label, disabled: !!held, description: held ?? undefined, onSelect: () => act.current?.onRowVerb?.(row, verb) }
    }
    const CaseCell = ({ data }: ICellRendererParams<CaseRow>) =>
      data ? (
        <span className="fw-svc-cell">
          <Link className="fw-svc-link fw-svc-code" href={recordHref(model.prefix, data.id)}>
            {data.number}
          </Link>
          <span className="fw-svc-hint" title={data.summary}>
            {data.summary || '—'}
          </span>
        </span>
      ) : null
    const CustomerCell = ({ data }: ICellRendererParams<CaseRow>) =>
      data ? (
        <span className="fw-svc-cell">
          <span>{data.party ? data.party.legalName : t('row.rider')}</span>
          <span className="fw-svc-hint">{data.party ? data.party.code : t('row.riderHint')}</span>
        </span>
      ) : null
    const SerialCell = ({ data }: ICellRendererParams<CaseRow>) => {
      if (!data) return null
      const serial = data.garmentSerial ?? data.serial
      const batch = data.garmentBatch ?? data.batchNumber
      return (
        <span className="fw-svc-cell">
          <span className="fw-svc-code">{serial ?? (batch ? t('row.batch', { batch }) : '—')}</span>
          <span className="fw-svc-hint">{serial ? (data.garmentSerial ? t('row.ours') : t('row.notOurs')) : batch ? (data.garmentBatch ? t('row.ours') : t('row.notOurs')) : t('row.noGarment')}</span>
        </span>
      )
    }
    const StyleCell = ({ data }: ICellRendererParams<CaseRow>) =>
      data ? (
        <span className="fw-svc-cell">
          <span>{data.style ? data.style.code : '—'}</span>
          <span className="fw-svc-hint">{[data.style?.name, data.size ? t('row.size', { size: data.size }) : null].filter(Boolean).join(' · ') || ' '}</span>
        </span>
      ) : null
    const CoverCell = ({ data }: ICellRendererParams<CaseRow>) => (data ? <CoverTag cover={data.cover} /> : null)
    const StatusCell = ({ data }: ICellRendererParams<CaseRow>) =>
      data ? (
        <span className="fw-svc-row">
          <StatusPill status={data.status} />
          {(data.priority === 'HIGH' || data.priority === 'URGENT') && <PriorityTag priority={data.priority} />}
        </span>
      ) : null
    const KindCell = ({ data }: ICellRendererParams<CaseRow>) => (data ? <KindTag kind={data.kind} /> : null)
    const MoreCell = ({ data }: ICellRendererParams<CaseRow>) => {
      if (!data) return null
      return (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('row.menu', { number: data.number }) }}
          items={[
            { id: 'open', label: t('row.open'), href: recordHref(model.prefix, data.id) },
            { id: 'tab', label: t('row.openNewTab'), href: recordHref(model.prefix, data.id), target: '_blank' },
            verbItem(data, 'return', t('row.makeReturn')),
            verbItem(data, 'repair', t('row.makeRepair')),
            { ...verbItem(data, 'close', t('row.close')), tone: 'danger' as const },
            { id: 'copy', label: t('row.copy'), onSelect: () => act.current?.onCopy?.([data.number]) },
          ]}
        />
      )
    }
    // The colIds are the export source's columns (apps/factory-api platform/exports/sources/service-cases.ts).
    return [
      { colId: 'case', headerName: t('col.case'), minWidth: 170, flex: 1.2, valueGetter: (params) => params.data?.number ?? '', cellRenderer: CaseCell },
      { colId: 'customer', headerName: t('col.customer'), minWidth: 160, flex: 1, valueGetter: (params) => (params.data ? (params.data.party?.legalName ?? t('row.rider')) : ''), cellRenderer: CustomerCell },
      { colId: 'serial', headerName: t('col.serial'), minWidth: 140, flex: 0.8, valueGetter: (params) => params.data?.garmentSerial ?? params.data?.serial ?? params.data?.garmentBatch ?? params.data?.batchNumber ?? '', cellRenderer: SerialCell },
      { colId: 'style', headerName: t('col.style'), minWidth: 130, flex: 0.7, valueGetter: (params) => params.data?.style?.code ?? '', cellRenderer: StyleCell },
      { colId: 'cover', headerName: t('col.cover'), minWidth: 150, flex: 0.9, valueGetter: (params) => (params.data ? t(`cover.${params.data.cover.state}`) : ''), cellRenderer: CoverCell },
      { colId: 'status', headerName: t('col.status'), minWidth: 150, flex: 0.8, valueGetter: (params) => (params.data ? t(`status.${params.data.status}`) : ''), cellRenderer: StatusCell },
      { colId: 'opened', headerName: t('col.opened'), minWidth: 104, flex: 0.5, valueGetter: (params) => (params.data ? day(params.data.openedAt) : '') },
      { colId: 'owner', headerName: t('col.owner'), minWidth: 120, flex: 0.6, valueGetter: (params) => (params.data ? (say(personPhrase(model.people, params.data.ownerId, model.me)) ?? '') : '') },
      { colId: 'kind', headerName: t('col.kind'), minWidth: 104, flex: 0.5, valueGetter: (params) => (params.data ? t(`kind.${params.data.kind}`) : ''), cellRenderer: KindCell },
      { colId: 'more', headerName: t('col.more'), minWidth: 72, maxWidth: 72, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
    // The cells read the model through these values only.
  }, [t, say, day, model.prefix, model.can, model.people, model.me, offline])

  if (!model.can.view)
    return (
      <div className="fw-svc">
        <Card padded>
          <EmptyState title={t('noAccess.title')} description={t('noAccess.body')} />
        </Card>
      </div>
    )

  const filtered = isFiltered(model.address)
  const picked = (rows ?? []).filter((row) => selected.includes(row.id))
  const ownKeys: ListKey[] = [{ keys: ['c'], does: t('keys.new') }]
  const newButton = (
    <Button size="sm" variant="primary" heldReason={model.can.manage ? (offline ? t('held.offline') : null) : say({ key: 'held.right', params: { right: 'right.sales.service.manage' } })} onClick={() => actions?.onNew?.()} aria-keyshortcuts="c">
      <Plus size={14} aria-hidden /> {t('list.new')}
    </Button>
  )
  const state: ReactNode = model.rows.problem ? (
    <EmptyState
      title={t('list.failed')}
      description={t(model.rows.problem)}
      action={
        <Button size="sm" onClick={() => actions?.onRetry?.()}>
          {t('common.retry')}
        </Button>
      }
    />
  ) : rows !== null && rows.length === 0 ? (
    filtered ? (
      <EmptyState
        title={t('list.noMatch')}
        description={t('list.noMatchBody')}
        action={
          <Button size="sm" onClick={() => actions?.onClearFilters?.()}>
            {t('common.clearFilters')}
          </Button>
        }
      />
    ) : (
      <EmptyState title={t('list.empty')} description={t('list.emptyBody')} action={model.can.manage ? newButton : undefined} />
    )
  ) : undefined

  const chips = chipsOf(model.address)
  const notices = pageNotices(rows, model.rows.more, model.prefix, new Set(model.dismissed))
  const tools = (
    <>
      <Select size="sm" aria-label={t('list.rows')} value={model.address.view} onChange={(event) => actions?.onAddress?.({ view: event.target.value as CaseView })}>
        {SAVED_ROWS.map((view) => (
          <option key={view} value={view}>
            {t(`view.${view}`)}
          </option>
        ))}
      </Select>
      <Select size="sm" aria-label={t('list.kindLabel')} value={model.address.kind ?? ''} onChange={(event) => actions?.onAddress?.({ kind: (event.target.value || null) as CaseKind | null })}>
        <option value="">{t('list.allKinds')}</option>
        {CASE_KINDS.map((kind) => (
          <option key={kind} value={kind}>
            {t(`kind.${kind}`)}
          </option>
        ))}
      </Select>
      <Select size="sm" aria-label={t('list.coverLabel')} value={model.address.cover ?? ''} onChange={(event) => actions?.onAddress?.({ cover: (event.target.value || null) as CoverState | null })}>
        <option value="">{t('list.allCovers')}</option>
        {COVER_STATES.map((cover) => (
          <option key={cover} value={cover}>
            {t(`cover.${cover}`)}
          </option>
        ))}
      </Select>
    </>
  )

  return (
    <div className="fw-svc">
      <div className="fw-svc-head">
        <div className="fw-svc-head-text">
          <p className="fw-svc-intro">{t('list.intro')}</p>
          <Freshness asOf={model.asOf} live={model.live} />
        </div>
        <div className="fw-svc-actions">
          <Menu label={<MoreHorizontal size={16} aria-hidden />} align="right" triggerProps={{ 'aria-label': t('list.more') }} items={[{ id: 'terms', label: t('list.termsLater'), disabled: true, description: t('list.termsLaterHint') }]} />
          {newButton}
        </div>
      </div>
      <NoticeLine notice={model.notice} onDismiss={actions?.onDismissNotice} />
      {notices.length > 0 && (
        <div className="fw-svc-notices" aria-label={t('notice.label')}>
          {(noticesOpen ? notices : notices.slice(0, 1)).map((notice) => (
            <NoticeLine key={notice.id} notice={notice} onDismiss={() => actions?.onDismissPageNotice?.(notice.id)} />
          ))}
          {notices.length > 1 && (
            <Button size="sm" variant="quiet" aria-expanded={noticesOpen} onClick={() => setNoticesOpen((now) => !now)}>
              {noticesOpen ? t('notice.fewer') : t('notice.more', { count: notices.length - 1 })}
            </Button>
          )}
        </div>
      )}
      <MetricStrip
        metrics={TILES.map((tile) => ({
          label: t(`tile.${tile}`),
          value: tileValue(model.counts, tile),
          hint: model.countsFailed ? t('tile.failed') : t(`tile.hint.${tile}`),
          onClick: () => actions?.onAddress?.({ view: model.address.view === tile ? HOME_ADDRESS.view : tile }),
          active: model.address.view === tile,
        }))}
      />
      {chips.length > 0 && (
        <div className="fw-svc-chips" aria-label={t('chip.label')}>
          {chips.map((chip) => (
            <FilterChip key={chip.id} pressed onClick={() => actions?.onAddress?.(chip.clear)} aria-label={t('chip.clear', { what: say(chip.label) ?? '' })}>
              {say(chip.label)} <X size={12} aria-hidden />
            </FilterChip>
          ))}
          <Button size="sm" variant="quiet" onClick={() => actions?.onClearFilters?.()}>
            {t('chip.clearAll')}
          </Button>
        </div>
      )}
      <ListFrame<CaseRow>
        label={t('list.tableLabel')}
        rows={state ? [] : rows}
        rowId={(row) => row.id}
        columns={columns}
        count={rows ? (model.rows.more ? t('list.countMore', { count: rows.length }) : t('list.count', { count: rows.length })) : t('list.countReading')}
        search={
          <Input
            size="sm"
            type="search"
            className="fw-svc-search"
            aria-label={t('list.search')}
            placeholder={t('list.search')}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') actions?.onAddress?.({ q: search })
            }}
            onBlur={() => search !== model.address.q && actions?.onAddress?.({ q: search })}
          />
        }
        tools={tools}
        selection={{
          selected,
          onChange: setSelected,
          exportSelected: true,
          actions: (
            <Button size="sm" aria-label={t('list.copyMany', { count: picked.length })} onClick={() => actions?.onCopy?.(picked.map((row) => row.number))}>
              <Copy size={13} aria-hidden /> <SelectionLabel>{t('list.copyMany', { count: picked.length })}</SelectionLabel>
            </Button>
          ),
        }}
        updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
        more={model.rows.more ? { label: t('list.showMore'), onMore: () => actions?.onMore?.(), held: offline ? t('held.offline') : null } : null}
        keys={ownKeys}
        keysOpen={model.keysOpen}
        onOpen={(row) => actions?.onOpen?.(row.id)}
        state={state}
        focusRow={model.focusRow}
        title={t('list.tableLabel')}
        cards={{ hrefOf: (row) => recordHref(model.prefix, row.id) }}
      />
      <p className="fw-svc-hint">{t('list.foot')}</p>
      {model.newCase && <NewCaseDialog model={model.newCase} can={model.can} me={model.me} prefix={model.prefix} today={model.today} actions={actions?.newCase} />}
    </div>
  )
}
