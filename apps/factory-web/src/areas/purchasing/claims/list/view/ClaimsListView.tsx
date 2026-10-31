'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { Download, FilePlus2, MoreHorizontal, Search, ShieldOff, Undo2, X } from 'lucide-react'
import { Banner, Card, EmptyState, Menu, MetricStrip, Modal } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, FilterChip, Input, Pill, Select } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { listKeys, type ListKey } from '../../../../../list-frame/model'
import { formatDate, formatTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { money, quantity } from '../../../../_shared/buying/model'
import type { ClaimKind, ClaimRow } from '../../api'
import { CLAIM_VIEWS, defaultView, KIND_TONE, newClaimHeld, reasonWords, returnHeld, say, STATUS_TONE, TILES, type ClaimsListActions, type ClaimsListModel, type ClaimView } from '../../model'
import { ReturnDialog } from './ReturnDialog'
import '../../../../_shared/buying/buying.css'
import '../../claims.css'

export type { ClaimsListActions, ClaimsListModel } from '../../model'

/**
 * SCR-131 — Returns & claims (Purchasing › Sourcing & claims; design purchasing.claims, workspace-list): the band (as of,
 * live, Return to supplier `r` — New claim is W2b in the design and not drawn), the tiles "Claims" (open, waiting for the
 * supplier, credit expected, closed this month — each a saved filter; a count not known draws '—'), the filter chips of
 * the address (a receipt's or a lot's claims, the kind) with ✕ and Clear all, and on the shared list frame the goods
 * sent back and the claims for credit: number (a real link), kind, supplier, lot, material, reason, quantity or area,
 * remedy, value (the cost grain only: the column is not drawn without it), status, age; Rows ▾ the saved views;
 * select-all, shift range, x, Export N (CSV) while rows are selected; live changes behind "N updates · Show".
 */
export function ClaimsListView({ model, actions }: { model: ClaimsListModel; actions?: ClaimsListActions }) {
  return (
    <WithMessages namespaces={['purchasing-claims', 'lists']}>
      <Page model={model} actions={actions} />
    </WithMessages>
  )
}

function Page({ model, actions }: { model: ClaimsListModel; actions?: ClaimsListActions }) {
  const t = useT('purchasing-claims')
  const lists = useT('lists')
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const [help, setHelp] = useState(!!model.helpOpen)
  const [query, setQuery] = useState(model.filters.q)
  useEffect(() => setQuery(model.filters.q), [model.filters.q])
  const typed = useRef(false)
  const latest = useRef(actions)
  latest.current = actions
  useEffect(() => {
    if (!typed.current) return
    const timer = setTimeout(() => latest.current?.onSearch?.(query), 300)
    return () => clearTimeout(timer)
  }, [query])
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  const items = model.rows.items
  const rowsKey = items?.map((row) => row.id).join(',') ?? ''
  useEffect(() => setSelected((current) => current.filter((id) => rowsKey.includes(id))), [rowsKey])
  useEffect(() => setSelected(model.selected ?? []), [model.selected])
  const picked = (items ?? []).filter((row) => selected.includes(row.id))

  const returnBlocked = !model.can.manage ? 'purchasing.claims.manage' : !model.can.ret ? 'purchasing.claims.return' : !model.can.ddtIssue ? 'shipping.ddt.issue' : null
  const returnHeldWords = returnBlocked ? t('held.permissionPlain', { permission: returnBlocked }) : null
  // B-W2b-14: New claim (design page.h#1, primary, W2b) — a draft for credit or replacement from a lot in stock.
  const newBlocked = !model.can.manage ? 'purchasing.claims.manage' : !model.can.stock ? 'inventory.stock.view' : null
  const newHeldWords = newBlocked ? t('held.permissionPlain', { permission: newBlocked }) : null

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.metaKey || event.ctrlKey || event.altKey || help || model.ret) return
      if (target && (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"]') || target.isContentEditable)) return
      if (event.key === 'r' && !returnHeldWords) {
        event.preventDefault()
        actions?.onReturn?.(true)
      }
      if (event.key === 'c' && !newHeldWords) {
        event.preventDefault()
        actions?.onNewClaim?.(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const columns = useMemo<ColDef<ClaimRow>[]>(() => {
    const href = (row: ClaimRow) => `${model.prefix}/purchasing/claims/${row.id}`
    const NumberCell = ({ data }: ICellRendererParams<ClaimRow>) =>
      data ? (
        <span className="fw-by-cell">
          <Link className="fw-by-link" href={href(data)}>
            {data.number}
          </Link>
          <span className="fw-by-cell-sub">{formatDate(data.createdAt, place)}</span>
        </span>
      ) : null
    const KindCell = ({ data }: ICellRendererParams<ClaimRow>) => (data ? <Pill tone={KIND_TONE[data.kind]}>{t(`kind.${data.kind}`)}</Pill> : null)
    const SupplierCell = ({ data }: ICellRendererParams<ClaimRow>) =>
      data ? (
        <span className="fw-by-cell" title={data.supplier.name}>
          <span className="fw-by-ellipsis">{data.supplier.name}</span>
          <span className="fw-by-cell-sub">{data.site.code}</span>
        </span>
      ) : null
    const LotCell = ({ data }: ICellRendererParams<ClaimRow>) =>
      data ? (
        data.lots.length === 0 ? (
          <span className="fw-by-cell-sub">—</span>
        ) : (
          <span className="fw-by-ellipsis" title={data.lots.map((lot) => lot.code).join(', ')}>
            {data.lots.map((lot, index) => (
              <span key={lot.id}>
                {index > 0 ? ', ' : ''}
                <Link className="fw-by-link" href={`${model.prefix}/warehouse/lots/${lot.id}`}>
                  {lot.code}
                </Link>
              </span>
            ))}
          </span>
        )
      ) : null
    const MaterialCell = ({ data }: ICellRendererParams<ClaimRow>) =>
      data ? (
        <span className="fw-by-cell" title={data.materials.map((item) => `${item.code} ${item.name}`).join(' · ')}>
          <span className="fw-by-ellipsis">{data.materials.map((item) => item.name).join(' · ') || '—'}</span>
          <span className="fw-by-cell-sub">{data.materials.map((item) => item.code).join(' · ')}</span>
        </span>
      ) : null
    const ReasonCell = ({ data }: ICellRendererParams<ClaimRow>) => {
      if (!data) return null
      const reason = reasonWords(data.reason, locale)
      return (
        <span className="fw-by-cell" title={[reason.label, reason.note].filter(Boolean).join(': ')}>
          <span className="fw-by-ellipsis">{reason.label ?? '—'}</span>
          {reason.note && <span className="fw-by-cell-sub fw-by-ellipsis">{reason.note}</span>}
        </span>
      )
    }
    const QuantityCell = ({ data }: ICellRendererParams<ClaimRow>) =>
      data ? (
        <span className="fw-by-cell">
          <span className="fw-by-num">{data.quantity ? `${quantity(data.quantity.quantity, locale)} ${t(`uom.${data.quantity.uom}`)}` : t('list.lines', { count: data.lines })}</span>
          {data.kind === 'RETURN' && data.lines > 0 && <span className="fw-by-cell-sub">{t('list.returned', { returned: data.returned, count: data.lines })}</span>}
        </span>
      ) : null
    const RemedyCell = ({ data }: ICellRendererParams<ClaimRow>) => (data ? <span>{data.remedy ? t(`remedy.${data.remedy}`) : t('remedy.none')}</span> : null)
    const ValueCell = ({ data }: ICellRendererParams<ClaimRow>) =>
      data ? (
        <span className="fw-by-cell">
          <span className="fw-by-num">{money(data.value ?? null, data.currency, locale)}</span>
          {data.remedy === 'CREDIT' && data.expectedCreditAmount != null && data.expectedCreditAmount !== data.value && <span className="fw-by-cell-sub">{t('list.agreed', { amount: money(data.expectedCreditAmount, data.currency, locale) })}</span>}
        </span>
      ) : null
    const StatusCell = ({ data }: ICellRendererParams<ClaimRow>) => (data ? <Pill tone={STATUS_TONE[data.status]}>{t(`status.${data.status}`)}</Pill> : null)
    const AgeCell = ({ data }: ICellRendererParams<ClaimRow>) => (data ? <span className="fw-by-num">{t('list.age', { count: data.ageDays })}</span> : null)
    const MoreCell = ({ data }: ICellRendererParams<ClaimRow>) =>
      data ? (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('list.rowMenu', { number: data.number }) }}
          items={[
            { id: 'open', label: t('common.open'), href: href(data) },
            { id: 'tab', label: t('common.openNewTab'), href: href(data), target: '_blank' },
            { id: 'goods', label: t('tab.goods'), href: `${href(data)}?tab=goods` },
            { id: 'credit', label: t('tab.credit'), href: `${href(data)}?tab=credit` },
          ]}
        />
      ) : null
    return [
      { colId: 'number', headerName: t('col.number'), field: 'number', minWidth: 150, flex: 0.9, cellRenderer: NumberCell },
      { colId: 'kind', headerName: t('col.kind'), minWidth: 90, flex: 0.6, valueGetter: (params) => (params.data ? t(`kind.${params.data.kind}`) : ''), cellRenderer: KindCell },
      { colId: 'supplier', headerName: t('col.supplier'), minWidth: 150, flex: 1.3, valueGetter: (params) => params.data?.supplier.name ?? '', cellRenderer: SupplierCell },
      { colId: 'lot', headerName: t('col.lot'), minWidth: 110, flex: 0.9, cellRenderer: LotCell },
      { colId: 'material', headerName: t('col.material'), minWidth: 140, flex: 1.2, cellRenderer: MaterialCell },
      { colId: 'reason', headerName: t('col.reason'), minWidth: 140, flex: 1.2, cellRenderer: ReasonCell },
      { colId: 'quantity', headerName: t('col.quantity'), minWidth: 110, flex: 0.8, cellRenderer: QuantityCell },
      { colId: 'remedy', headerName: t('col.remedy'), minWidth: 110, flex: 0.7, cellRenderer: RemedyCell },
      ...(model.can.cost ? [{ colId: 'value', headerName: t('col.value'), minWidth: 110, flex: 0.7, type: 'rightAligned', cellRenderer: ValueCell } satisfies ColDef<ClaimRow>] : []),
      { colId: 'status', headerName: t('col.status'), minWidth: 120, flex: 0.8, cellRenderer: StatusCell },
      { colId: 'age', headerName: t('col.age'), minWidth: 70, flex: 0.5, type: 'rightAligned', cellRenderer: AgeCell },
      { colId: 'more', headerName: t('col.more'), minWidth: 64, maxWidth: 64, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
  }, [t, locale, model.prefix, model.can.cost, model.timeZone])

  if (!model.can.view) {
    return (
      <div className="fw-by">
        <Card padded>
          <EmptyState icon={<ShieldOff size={24} aria-hidden />} title={t('page.noAccess.title')} description={t('page.noAccess.body')} />
        </Card>
      </div>
    )
  }

  const ownKeys: ListKey[] = [
    { keys: ['c'], does: t('page.keyNewClaim') },
    { keys: ['r'], does: t('page.keyReturn') },
  ]
  const tileView = TILES.find((tile) => tile.view === model.view)?.view ?? null
  const filters = model.filters
  const chips = [
    ...(filters.receipt ? [{ id: 'receipt' as const, label: model.chips.receipt ? t('chip.receipt', { number: model.chips.receipt }) : t('chip.thisReceipt') }] : []),
    ...(filters.lot ? [{ id: 'lot' as const, label: model.chips.lot ? t('chip.lot', { code: model.chips.lot }) : t('chip.thisLot') }] : []),
  ]
  const narrowed = filters.q.trim() !== '' || filters.kind !== null || chips.length > 0 || model.view !== defaultView(filters)
  const clearAll = (
    <Button
      size="sm"
      onClick={() => {
        setQuery('')
        actions?.onClearFilter?.('all')
      }}
    >
      {t('common.clearFilters')}
    </Button>
  )
  const state = model.rows.problem ? (
    <EmptyState title={t('list.failed')} description={t(model.rows.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('common.retry')}</Button>} />
  ) : items && items.length === 0 ? (
    narrowed ? (
      <EmptyState title={t('list.noMatch.title')} description={t('list.noMatch.body')} action={clearAll} />
    ) : (
      <EmptyState
        title={t('list.empty.title')}
        description={t('list.empty.body')}
        action={
          <Button size="sm" heldReason={returnHeldWords} onClick={() => actions?.onReturn?.(true)}>
            <Undo2 size={14} aria-hidden /> {t('page.return')}
          </Button>
        }
      />
    )
  ) : undefined

  const more = [
    ...((items?.length ?? 0) > 0 ? [{ id: 'export', label: t('page.export'), onSelect: () => actions?.onExport?.((items ?? []).map((row) => row.id)) }] : []),
    { id: 'keys', label: t('page.shortcuts'), onSelect: () => setHelp(true) },
  ]

  return (
    <div className="fw-by">
      <div className="fw-by-head">
        <span className="fw-by-status" role="status">
          {model.asOf ? t('common.updated', { time: formatTime(model.asOf, place) }) : t('common.notYet')}
          {' · '}
          {t(`live.${model.live}`)}
        </span>
        <span className="fw-by-actions">
          <Button size="sm" variant="secondary" heldReason={returnHeldWords} onClick={() => actions?.onReturn?.(true)} aria-keyshortcuts="r">
            <Undo2 size={14} aria-hidden /> {t('page.return')}
          </Button>
          <Button size="sm" variant="primary" heldReason={newHeldWords} onClick={() => actions?.onNewClaim?.(true)} aria-keyshortcuts="c">
            <FilePlus2 size={14} aria-hidden /> {t('page.newClaim')}
          </Button>
          <Menu label={<MoreHorizontal size={16} aria-hidden />} align="right" triggerProps={{ 'aria-label': t('page.more') }} items={more} />
        </span>
      </div>

      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={say(t, model.notice.words)}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
              {t('common.dismiss')}
            </Button>
          }
        />
      )}

      <section aria-label={t('tiles.label')}>
        {model.countsProblem ? (
          <Banner tone="danger" title={t('tiles.failed')} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('common.retry')}</Button>}>
            {t(model.countsProblem)}
          </Banner>
        ) : (
          <MetricStrip
            metrics={TILES.map((tile) => ({
              label: t(`tile.${tile.id}`),
              value: model.counts ? String(tile.count(model.counts)) : '—',
              ...(tile.hint ? { hint: t(tile.hint) } : {}),
              onClick: () => actions?.onView?.(model.view === tile.view ? defaultView(filters) : tile.view),
              active: tileView === tile.view,
            }))}
          />
        )}
      </section>

      {(chips.length > 0 || filters.kind) && (
        <div className="fw-cl-chips" role="group" aria-label={t('chip.label')}>
          {chips.map((chip) => (
            <FilterChip key={chip.id} pressed onClick={() => actions?.onClearFilter?.(chip.id)} aria-label={t('chip.remove', { filter: chip.label })}>
              {chip.label} <X size={12} aria-hidden />
            </FilterChip>
          ))}
          {filters.kind && (
            <FilterChip pressed onClick={() => actions?.onKind?.(null)} aria-label={t('chip.remove', { filter: t(`kind.${filters.kind}`) })}>
              {t(`kindPlural.${filters.kind}`)} <X size={12} aria-hidden />
            </FilterChip>
          )}
          <Button size="sm" variant="quiet" onClick={() => actions?.onClearFilter?.('all')}>
            {t('chip.clearAll')}
          </Button>
        </div>
      )}

      <ListFrame<ClaimRow>
        label={t('list.tableLabel')}
        rows={state ? [] : items}
        rowId={(row) => row.id}
        columns={columns}
        count={items ? t(model.rows.more ? 'common.countMore' : 'common.count', { count: items.length }) : '—'}
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
          <span className="fw-by-inline">
            <Select size="sm" aria-label={t('list.viewLabel')} value={model.view} onChange={(event) => actions?.onView?.(event.target.value as ClaimView)}>
              {CLAIM_VIEWS.map((view) => (
                <option key={view} value={view}>
                  {t(`view.${view}`)}
                </option>
              ))}
            </Select>
            <Select size="sm" aria-label={t('list.kindLabel')} value={filters.kind ?? ''} onChange={(event) => actions?.onKind?.((event.target.value || null) as ClaimKind | null)}>
              <option value="">{t('list.everyKind')}</option>
              <option value="RETURN">{t('kindPlural.RETURN')}</option>
              <option value="CLAIM">{t('kindPlural.CLAIM')}</option>
            </Select>
          </span>
        }
        selection={{
          selected,
          onChange: setSelected,
          actions: (
            <Button size="sm" aria-label={t('bulk.export', { count: picked.length })} onClick={() => actions?.onExport?.(picked.map((row) => row.id))}>
              <Download size={13} aria-hidden /> <SelectionLabel>{t('bulk.export', { count: picked.length })}</SelectionLabel>
            </Button>
          ),
        }}
        updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
        more={model.rows.more && items && items.length > 0 ? { label: t('common.more'), onMore: () => actions?.onMore?.() } : null}
        keys={ownKeys}
        onHelp={() => setHelp(true)}
        onOpen={(row) => actions?.onOpen?.(row.id)}
        state={state}
        focusRow={model.focusRow}
      />
      {model.view !== defaultView(filters) && <p className="fw-by-hint">{t('list.viewing', { view: t(`view.${model.view}`) })}</p>}
      {model.view === 'closed' && <p className="fw-by-hint">{t('list.closedNote')}</p>}

      {model.ret && (
        <ReturnDialog
          model={model.ret}
          can={model.can}
          prefix={model.prefix}
          actions={{
            onClose: () => (model.ret?.mode === 'claim' ? actions?.onNewClaim?.(false) : actions?.onReturn?.(false)),
            onDraft: actions?.onReturnDraft,
            onSearch: actions?.onReturnSearch,
            onPick: actions?.onReturnPick,
            onContacts: actions?.onReturnContacts,
            onCreate: () => {
              if (model.ret && !model.ret.busy && !(model.ret.mode === 'claim' ? newClaimHeld(model.ret.draft, model.can) : returnHeld(model.ret.draft, model.can))) actions?.onReturnCreate?.()
            },
            onOpenDdt: actions?.onOpenDdt,
          }}
        />
      )}
      {help && (
        <Modal open onClose={() => setHelp(false)} title={t('common.shortcuts')} size="sm">
          <ul className="fw-by-list">
            {listKeys(ownKeys, true).map((entry) => (
              <li key={entry.does}>
                <b>{entry.keys.join(' ')}</b> — {entry.does.startsWith('keys.') ? lists(entry.does) : entry.does}
              </li>
            ))}
          </ul>
        </Modal>
      )}
    </div>
  )
}
