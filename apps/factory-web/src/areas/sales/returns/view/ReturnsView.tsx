'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { Copy, Download, MoreHorizontal, Plus, Search, Undo2, Wrench, X } from 'lucide-react'
import { Banner, Disclosure, EmptyState, Menu, MetricStrip, type MenuItemDef } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, FilterChip, Input, Kbd, Skeleton } from '@nexus/ui/primitives'
import { useLocale } from '../../../../lib/i18n/provider'
import { ListFrame } from '../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../list-frame/model'
import { Freshness, NoAccess, PageHead } from '../../../quality/_shared/parts'
import { isFiltered, isOpenRow, ownerName, ROW_VIEWS, rowHref, rowStatusWords, TILES, type AfterSalesRow, type AfterSalesTile } from '../model'
import type { ReturnsListActions, ReturnsListModel } from '../view-model'
import { CloseReturnModal } from './CloseReturnModal'
import { NewRepairModal } from './NewRepairModal'
import { NewReturnModal } from './NewReturnModal'
import { DayText, isPageKey, KeysModal, KindTag, Money, ReturnsMessages, RowStatusPill, say, useDayWords, useWords } from './parts'

export type { ReturnsListActions, ReturnsListModel } from '../view-model'

/**
 * SCR-111 Returns & repairs (Sales › After-sales; design sales.returns: SAL-333, SAL-335, SAL-341, SAL-352, LOG-116): the
 * customer returns (RMAs, B-W2a-43) and the repairs and alterations (B-W2a-57) in ONE grid. The head (one sentence,
 * Updated · Live, New repair, New return), ONE notice at a time (the rest behind "n more notices"), the tiles (each a
 * named saved filter: pressing one puts its chip in the toolbar), then the shared list frame: count, search, Rows ▾,
 * chips, ⋯ — swapped for Copy numbers and Export N while rows are selected — and the footer with the keys icon. Credit
 * values only with the price grain. Fetches nothing: ReturnsPage.tsx reads and writes.
 */
export function ReturnsView({ model, actions }: { model: ReturnsListModel; actions?: ReturnsListActions }) {
  return (
    <ReturnsMessages>
      <ReturnsList model={model} actions={actions} />
    </ReturnsMessages>
  )
}

function tileCount(model: ReturnsListModel, tile: AfterSalesTile): number | null {
  const { returns, repairs } = model.counts
  switch (tile) {
    case 'waiting':
      return returns ? returns.waiting + (repairs?.awaiting ?? 0) : null
    case 'toInspect':
      return returns ? returns.toInspect : null
    case 'inRepair':
      return repairs ? repairs.inRepair : null
    case 'replacement':
      return returns ? returns.replacement : null
  }
}

function ReturnsList({ model, actions }: { model: ReturnsListModel; actions?: ReturnsListActions }) {
  const t = useWords()
  const locale = useLocale()
  const can = model.can
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  const [help, setHelp] = useState(!!model.helpOpen)
  const items = useMemo(() => model.rows.items ?? [], [model.rows.items])
  const rowsKey = items.map((row) => row.key).join(',')
  useEffect(() => setSelected((current) => current.filter((key) => rowsKey.includes(key))), [rowsKey])
  const address = model.address

  const dayWords = useDayWords()
  const latest = useRef({ actions, can, people: model.people, me: model.me, today: model.today, dayWords })
  latest.current = { actions, can, people: model.people, me: model.me, today: model.today, dayWords }
  const columns = useMemo<ColDef<AfterSalesRow>[]>(() => {
    const NumberCell = ({ data }: ICellRendererParams<AfterSalesRow>) =>
      data ? (
        <span className="fw-q-cell">
          <Link className="fw-q-name fw-q-code" href={rowHref(model.prefix, data)} tabIndex={-1}>
            {data.number}
          </Link>
          <span className="fw-q-hint">
            <KindTag kind={data.kind} />
          </span>
        </span>
      ) : null
    const CustomerCell = ({ data }: ICellRendererParams<AfterSalesRow>) =>
      data ? (
        <span className="fw-q-cell">
          <span className="fw-rr-ellipsis" title={data.party?.legalName}>
            {data.party?.legalName ?? '—'}
          </span>
          <span className="fw-q-hint">{data.customerRef ? t('row.theirRef', { ref: data.customerRef }) : (data.party?.code ?? '')}</span>
        </span>
      ) : null
    const OrderCell = ({ data }: ICellRendererParams<AfterSalesRow>) => {
      if (!data) return null
      if (data.kind === 'RETURN')
        return (
          <span className="fw-q-cell">
            <span className="fw-q-code">{data.order ?? '—'}</span>
            <span className="fw-q-hint fw-q-code">{data.invoices.join(', ')}</span>
          </span>
        )
      return (
        <span className="fw-q-cell">
          <span className="fw-q-code">{data.source?.number ?? '—'}</span>
          <span className="fw-q-hint">{t(`source.${data.source?.kind ?? 'HAND'}`)}</span>
        </span>
      )
    }
    const UnitsCell = ({ data }: ICellRendererParams<AfterSalesRow>) =>
      data ? (
        <span className="fw-q-cell">
          <span className="fw-q-num">{data.units}</span>
          {data.kind === 'RETURN' && <span className="fw-q-hint">{t('row.received', { count: data.receivedUnits })}</span>}
        </span>
      ) : null
    const ReasonCell = ({ data }: ICellRendererParams<AfterSalesRow>) => {
      if (!data) return null
      if (data.kind !== 'RETURN') return <span className="fw-rr-ellipsis fw-q-hint" title={data.problem ?? ''}>{data.problem ?? '—'}</span>
      return data.reason ? (
        <span className="fw-q-cell">
          <span className="fw-rr-ellipsis">{locale === 'it' ? data.reason.labelIt : data.reason.labelEn}</span>
          {data.reason.more > 0 && <span className="fw-q-hint">{t('row.moreReasons', { count: data.reason.more })}</span>}
        </span>
      ) : (
        <span className="fw-q-hint">—</span>
      )
    }
    const StatusCell = ({ data }: ICellRendererParams<AfterSalesRow>) =>
      data ? (
        <span className="fw-q-cell">
          <RowStatusPill row={data} />
          <span className="fw-q-hint fw-rr-ellipsis">{say(t, rowStatusWords(data, latest.current.today), latest.current.dayWords)}</span>
        </span>
      ) : null
    const DispositionCell = ({ data }: ICellRendererParams<AfterSalesRow>) =>
      data ? <span className="fw-rr-ellipsis">{data.dispositions.length > 0 ? data.dispositions.map((value) => t(`disposition.${value}`)).join(', ') : '—'}</span> : null
    const ReceivedCell = ({ data }: ICellRendererParams<AfterSalesRow>) => (data ? <DayText value={data.receivedAt} /> : null)
    const DeadlineCell = ({ data }: ICellRendererParams<AfterSalesRow>) =>
      data ? (
        data.deadline ? (
          <span className="fw-q-cell">
            <DayText value={data.deadline} />
            {data.late && <span className="fw-q-hint">{t('row.late')}</span>}
          </span>
        ) : (
          <span className="fw-q-hint">—</span>
        )
      ) : null
    const CreditCell = ({ data }: ICellRendererParams<AfterSalesRow>) => (data ? data.kind === 'RETURN' ? <Money minor={data.credit} currency={data.currency} /> : <span className="fw-q-hint">—</span> : null)
    const OwnerCell = ({ data }: ICellRendererParams<AfterSalesRow>) => {
      if (!data) return null
      const name = ownerName(latest.current.people, data.ownerId, latest.current.me)
      return <span className="fw-rr-ellipsis">{name ? ('key' in name ? t(name.key) : name.name) : '—'}</span>
    }
    const MoreCell = ({ data }: ICellRendererParams<AfterSalesRow>) => {
      if (!data) return null
      const now = latest.current
      const href = rowHref(model.prefix, data)
      const open = isOpenRow(data)
      const receiveRight = data.kind === 'RETURN' ? now.can.receive : now.can.repairsReceive
      const awaiting = data.status.kind === 'RETURN' ? data.status.status === 'AUTHORISED' : data.status.stage === 'AWAITING_GOODS'
      const receiveHeld = !receiveRight ? t(data.kind === 'RETURN' ? 'held.right.receive' : 'held.right.repairsReceive') : !awaiting ? t('held.notWaiting') : null
      const closeHeld = data.kind !== 'RETURN' ? t('held.repairsNoClose') : !now.can.manage ? t('held.right.manage') : !open ? t('held.notOpen') : null
      const repairHeld = data.kind !== 'RETURN' ? t('held.isRepair') : !now.can.repairsManage ? t('held.right.repairsManage') : null
      const items: MenuItemDef[] = [
        { id: 'open', label: t('row.open'), href },
        { id: 'tab', label: t('row.openNewTab'), href, target: '_blank' },
        { id: 'receive', label: t('row.markReceived'), href: receiveHeld ? undefined : `${href}?do=receive`, disabled: !!receiveHeld, description: receiveHeld ?? undefined },
        { id: 'repair', label: t('row.makeRepair'), href: repairHeld ? undefined : `${href}?tab=inspection`, disabled: !!repairHeld, description: repairHeld ?? t('row.makeRepairHint') },
        { id: 'close', label: t('row.close'), onSelect: () => now.actions?.onClose?.(data), disabled: !!closeHeld, description: closeHeld ?? undefined },
        { id: 'copy', label: t('row.copy'), onSelect: () => now.actions?.onCopy?.(data.number) },
      ]
      return <Menu align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': t('row.menu', { number: data.number }) }} items={items} />
    }
    const column = (colId: string, header: string, cellRenderer: ColDef<AfterSalesRow>['cellRenderer'], size: { flex?: number; minWidth?: number; width?: number; maxWidth?: number }): ColDef<AfterSalesRow> => ({ colId, headerName: header, cellRenderer, sortable: false, ...size })
    return [
      column('number', t('col.number'), NumberCell, { flex: 1, minWidth: 150 }),
      column('customer', t('col.customer'), CustomerCell, { flex: 1.3, minWidth: 170 }),
      column('order', t('col.order'), OrderCell, { flex: 1, minWidth: 140 }),
      column('units', t('col.units'), UnitsCell, { flex: 0.5, minWidth: 90 }),
      column('reason', t('col.reason'), ReasonCell, { flex: 1.2, minWidth: 160 }),
      column('status', t('col.status'), StatusCell, { flex: 1.4, minWidth: 190 }),
      column('disposition', t('col.disposition'), DispositionCell, { flex: 1, minWidth: 130 }),
      column('received', t('col.received'), ReceivedCell, { flex: 0.7, minWidth: 110 }),
      column('deadline', t('col.deadline'), DeadlineCell, { flex: 0.7, minWidth: 110 }),
      { ...column('credit', t('col.credit'), CreditCell, { flex: 0.8, minWidth: 110 }), headerTooltip: can.price ? t('col.creditHint') : t('col.creditNoGrain') },
      column('owner', t('col.owner'), OwnerCell, { flex: 0.8, minWidth: 110 }),
      { ...column('actions', t('col.actions'), MoreCell, { width: 72, minWidth: 72, maxWidth: 72 }), pinned: 'right', suppressHeaderMenuButton: true, suppressMovable: true },
    ]
    // The cells close over the words and the prefix: a change of language rebuilds them.
  }, [t, locale, model.prefix, can.price])

  // c: New return; n: New repair — never while typing, in a menu or a dialog.
  const dialogOpen = !!(model.newReturn || model.newRepair || model.close || help)
  const keys = useRef({ actions, can, offline: model.offline })
  keys.current = { actions, can, offline: model.offline }
  useEffect(() => {
    if (dialogOpen) return
    const onKey = (event: KeyboardEvent) => {
      if (!isPageKey(event)) return
      const now = keys.current
      if (event.key === 'c' && now.can.manage && !now.offline) {
        event.preventDefault()
        now.actions?.onNewReturn?.()
      } else if (event.key === 'n' && now.can.repairsManage && !now.offline) {
        event.preventDefault()
        now.actions?.onNewRepair?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dialogOpen])

  if (!can.view) return <NoAccess title={t('noAccess.title')} body={t('noAccess.body')} />

  const newReturnHeld = !can.manage ? t('held.right.manage') : model.offline ? t('held.offline') : null
  const newRepairHeld = !can.repairsManage ? t('held.right.repairsManage') : model.offline ? t('held.offline') : null
  const filtered = isFiltered(address)
  const pickedRows = items.filter((row) => selected.includes(row.key))

  const tile = (id: AfterSalesTile) => {
    const active = address.view === id
    const count = tileCount(model, id)
    const unknown = count === null
    return {
      label: t(`tile.${id}`),
      value: !unknown ? String(count) : model.counts.failed || (id === 'inRepair' && !can.repairsView) ? '—' : <Skeleton width={36} height={22} />,
      hint: model.counts.failed ? t('tile.unknown') : id === 'inRepair' && !can.repairsView ? t('tile.noRepairs') : t(`tileHint.${id}`),
      active,
      onClick: () => actions?.onAddress?.({ view: active ? 'open' : id }),
    }
  }

  const viewItems: MenuItemDef[] = [
    { id: 'heading', heading: true, label: t('list.rowsHeading') } as MenuItemDef,
    ...ROW_VIEWS.map((view) => ({ id: view, label: t(`view.${view}`), checked: address.view === view, onSelect: () => actions?.onAddress?.({ view }), disabled: view === 'openRepairs' && !can.repairsView }) as MenuItemDef),
  ]
  const chip = (key: string, label: string, onRemove: () => void) => (
    <FilterChip key={key} pressed onClick={onRemove} aria-label={t('list.removeFilter', { name: label })}>
      {label} <X size={12} aria-hidden />
    </FilterChip>
  )
  const tools = (
    <>
      <Menu label={t('list.rows', { view: t(`view.${address.view}`) })} items={viewItems} />
      {filtered && (
        <span className="fw-q-chips" aria-label={t('list.activeFilters')}>
          {address.view !== 'open' && chip('view', t(`view.${address.view}`), () => actions?.onAddress?.({ view: 'open' }))}
          {address.q.trim() !== '' && chip('q', `“${address.q.trim()}”`, () => actions?.onAddress?.({ q: '' }))}
          <Button size="sm" variant="quiet" onClick={() => actions?.onClearFilters?.()}>
            {t('list.clearAll')}
          </Button>
        </span>
      )}
    </>
  )
  const moreItems: MenuItemDef[] = [
    { id: 'export', label: t('list.exportView'), onSelect: () => actions?.onExport?.(items), disabled: items.length === 0, description: items.length === 0 ? t('list.exportNothing') : t('list.exportViewHint', { count: items.length }) },
    { id: 'policy', label: t('list.policy'), href: can.settingsView ? `${model.prefix}/sales/settings#returns` : undefined, disabled: !can.settingsView, description: can.settingsView ? t('list.policyHint') : t('held.right.settingsView') },
    { id: 'sep', separator: true } as MenuItemDef,
    { id: 'keys', label: t('keys.title'), onSelect: () => setHelp(true) },
  ]
  const bulkActions = (
    <>
      <Button size="sm" aria-label={t('list.bulkCopy', { count: pickedRows.length })} onClick={() => actions?.onCopy?.(pickedRows.map((row) => row.number).join(', '))}>
        <Copy size={13} aria-hidden /> <SelectionLabel>{t('list.bulkCopy', { count: pickedRows.length })}</SelectionLabel>
      </Button>
      <Button size="sm" aria-label={t('list.bulkExport', { count: pickedRows.length })} onClick={() => actions?.onExport?.(pickedRows)}>
        <Download size={13} aria-hidden /> <SelectionLabel>{t('list.bulkExport', { count: pickedRows.length })}</SelectionLabel>
      </Button>
    </>
  )

  const state = model.rows.problem ? (
    <EmptyState
      title={t('list.failed')}
      description={t(model.rows.problem)}
      action={
        <Button size="sm" onClick={() => actions?.onRetry?.()}>
          {t('quality:common.retry')}
        </Button>
      }
    />
  ) : model.rows.items !== null && items.length === 0 ? (
    filtered ? (
      <EmptyState
        title={t('list.noMatch')}
        action={
          <Button size="sm" onClick={() => actions?.onClearFilters?.()}>
            {t('list.clearAll')}
          </Button>
        }
      />
    ) : (
      <EmptyState
        icon={<Undo2 size={24} aria-hidden />}
        title={t('list.empty')}
        description={t('list.emptyBody')}
        action={
          <Button variant="primary" heldReason={newReturnHeld} onClick={() => actions?.onNewReturn?.()}>
            {t('newReturn.action')}
          </Button>
        }
      />
    )
  ) : undefined

  const ownKeys: ListKey[] = [
    { keys: ['c'], does: t('keys.newReturn') },
    { keys: ['n'], does: t('keys.newRepair') },
  ]
  const [first, ...rest] = model.notices

  return (
    <div className="fw-q">
      <PageHead
        intro={t('intro')}
        status={<Freshness asOf={model.asOf} live={model.live} />}
        actions={
          <>
            <Button size="sm" heldReason={newRepairHeld} onClick={() => actions?.onNewRepair?.()} aria-keyshortcuts="n">
              <Wrench size={14} aria-hidden /> {t('newRepair.action')} <Kbd>N</Kbd>
            </Button>
            <Button size="sm" variant="primary" heldReason={newReturnHeld} onClick={() => actions?.onNewReturn?.()} aria-keyshortcuts="c">
              <Plus size={14} aria-hidden /> {t('newReturn.action')} <Kbd>C</Kbd>
            </Button>
          </>
        }
      />
      {model.offline && (
        <Banner tone="warning" title={t('offline.title')}>
          {t('offline.body')}
        </Banner>
      )}
      {model.receipt && (
        <Banner
          tone={model.receipt.tone}
          title={say(t, model.receipt.words)}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissReceipt?.()}>
              {t('quality:common.dismiss')}
            </Button>
          }
        />
      )}
      {first && (
        <section aria-label={t('notices.label')} className="fw-q-stack">
          <Banner
            tone={first.tone}
            title={say(t, first.words)}
            action={
              <span className="fw-q-actions">
                {first.href && first.linkWords && (
                  <Link className="fw-q-link" href={first.href}>
                    {say(t, first.linkWords)}
                  </Link>
                )}
                <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.(first.id)}>
                  {t('quality:common.dismiss')}
                </Button>
              </span>
            }
          />
          {rest.length > 0 && (
            <Disclosure summary={t('notices.more', { count: rest.length })}>
              <div className="fw-q-stack">
                {rest.map((notice) => (
                  <Banner
                    key={notice.id}
                    tone={notice.tone}
                    title={say(t, notice.words)}
                    action={
                      notice.href && notice.linkWords ? (
                        <Link className="fw-q-link" href={notice.href}>
                          {say(t, notice.linkWords)}
                        </Link>
                      ) : undefined
                    }
                  />
                ))}
              </div>
            </Disclosure>
          )}
        </section>
      )}
      <MetricStrip metrics={TILES.map(tile)} />

      <ListFrame<AfterSalesRow>
        label={t('list.table')}
        rows={model.rows.problem ? [] : model.rows.items}
        rowId={(row) => row.key}
        columns={columns}
        count={model.rows.items ? t(model.rows.truncated ? 'list.countMore' : 'list.count', { count: items.length }) : '—'}
        search={
          <Input
            size="sm"
            type="search"
            leadingIcon={<Search size={14} aria-hidden />}
            aria-label={t('list.search')}
            placeholder={t('list.search')}
            value={address.q}
            onChange={(event) => actions?.onAddress?.({ q: event.target.value })}
          />
        }
        tools={tools}
        right={<Menu align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': t('list.more') }} items={moreItems} />}
        selection={{ selected, onChange: setSelected, actions: bulkActions }}
        updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
        keys={ownKeys}
        onHelp={() => setHelp(true)}
        onOpen={(row) => actions?.onOpen?.(row)}
        state={state}
        focusRow={model.focusRow}
        title={t('list.exportTitle')}
      />

      {model.newReturn && <NewReturnModal model={model.newReturn} actions={actions} />}
      {model.newRepair && <NewRepairModal model={model.newRepair} prefix={model.prefix} actions={actions} />}
      {model.close && <CloseReturnModal model={model.close} actions={actions} />}
      {help && <KeysModal own={ownKeys} onClose={() => setHelp(false)} />}
    </div>
  )
}
