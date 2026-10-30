'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { Download, MoreHorizontal, Search, SlidersHorizontal, Trash2, X } from 'lucide-react'
import { Banner, Card, EmptyState, Menu, MetricStrip, Modal, SummaryTable } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Select, Spinner } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { listKeys, type ListKey } from '../../../../list-frame/model'
import { formatDateTime, formatTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { recordAddress } from '../../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../../shell/nav/office-nav'
import { MOVE_REASONS, type LedgerRow, type MoveReason } from '../../../_shared/stock/api'
import { money, quantity, reverseHeldKey, signed } from '../../../_shared/stock/model'
import { NoAccess, Qty, ReadFailed, ReasonTag, StockMessages } from '../../../_shared/stock/parts'
import { AdjustDialog } from '../../stock/adjust/AdjustDialog'
import type { AdjustActions } from '../../stock/adjust/model'
import type { WriteOffActions } from '../../stock/daily/dialog-model'
import { DAILY_NAMESPACE, reasonLabel } from '../../stock/daily/model'
import { WriteOffDialog } from '../../stock/daily/WriteOffDialog'
import { explainsFigure, hasKey, MOVE_TILES, PERIODS, runningBalances, sideKey, tileActive, tileCount, tileFilter, writeOffHeldKey, type MovesAddress, type MovesPageActions, type MovesPageModel, type Period } from '../model'
import { MoveDetailModal, ReverseDialog } from './MoveDialogs'
import '../../../_shared/stock/stock.css'
import '../../stock/stock-pages.css'

export type { MovesPageActions, MovesPageModel } from '../model'

/**
 * SCR-064 — Movements (Warehouse › Main; design warehouse.moves, Owner answer W2 B): the append-only stock ledger as ONE
 * long fast grid that reads its next page as you scroll (no pages, no Show more). Opened from a stock figure it explains
 * the figure first ("why is it this number": the moves summed by reason, adds up ✓ or the gap in words), then the rows
 * with their running balance. Tiles are saved filters (adjustments, scraps, count differences, reversals; moves not
 * valued yet with the cost grain only). No edit anywhere: a move is reversed one at a time from its detail, with the
 * mirror shown first. A floor move names its tablet, never a worker (Owner answer W1); values with the cost grain only.
 * B-W2a-64: Write off… (the shared dialog: reason, photo, an NCR, the value leaving stock), the Write-offs tile and the
 * count differences tile (30 days), the text search across the whole ledger, the filter's whole count, and a write-off's
 * reason in words on its row.
 */
export function MovesView({ model, actions, adjustActions, writeOffActions }: { model: MovesPageModel; actions?: MovesPageActions; adjustActions?: AdjustActions; writeOffActions?: WriteOffActions }) {
  return (
    <StockMessages extra={['warehouse-stock', DAILY_NAMESPACE]}>
      <Moves model={model} actions={actions} adjustActions={adjustActions} writeOffActions={writeOffActions} />
    </StockMessages>
  )
}

const focusedRowId = (): string | null => (typeof document === 'undefined' ? null : ((document.activeElement as HTMLElement | null)?.closest('.ag-row')?.getAttribute('row-id') ?? null))

function Moves({ model, actions, adjustActions, writeOffActions }: { model: MovesPageModel; actions?: MovesPageActions; adjustActions?: AdjustActions; writeOffActions?: WriteOffActions }) {
  const t = useT('warehouse-stock')
  const s = useT('stock')
  const d = useT(DAILY_NAMESPACE)
  const lists = useT('lists')
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const { address, can } = model
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  const [help, setHelp] = useState(!!model.helpOpen)
  const rowIds = model.rows?.map((row) => row.id).join(',') ?? ''
  useEffect(() => setSelected((current) => current.filter((id) => rowIds.includes(id))), [rowIds])
  const balances = useMemo(() => (model.rows ? runningBalances(model.rows, model.closing) : null), [model.rows, model.closing])
  const rowOf = (id: string | null) => (id ? (model.rows?.find((row) => row.id === id) ?? null) : null)
  const latest = useRef(actions)
  latest.current = actions
  const [query, setQuery] = useState(address.q)
  useEffect(() => setQuery(address.q), [address.q])
  const typed = useRef(false)
  useEffect(() => {
    if (!typed.current) return
    const timer = setTimeout(() => latest.current?.onAddress?.({ q: query }), 300)
    return () => clearTimeout(timer)
  }, [query])
  const writeOffReasons = useMemo(() => model.writeOffReasons ?? [], [model.writeOffReasons])

  // r: reverse the focused move (its detail, where the reversal is shown first); a: adjust.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.metaKey || event.ctrlKey || event.altKey || help || model.detail || model.reverse || model.adjust || model.writeOff) return
      if (target && (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"]') || target.isContentEditable)) return
      if (event.key === 'r') {
        const row = rowOf(focusedRowId())
        if (!row || reverseHeldKey(row, can)) return
        event.preventDefault()
        latest.current?.onReverse?.(row)
      } else if (event.key === 'a' && can.adjust && explainsFigure(address)) {
        event.preventDefault()
        latest.current?.onAdjust?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const columns = useMemo<ColDef<LedgerRow>[]>(() => {
    const docHref = (row: LedgerRow) => (row.document ? `${model.prefix}${row.document.type === 'GoodsReceipt' ? `/warehouse/receipts/${encodeURIComponent(row.document.id)}` : recordAddress({ type: 'WorkOrder', id: row.document.id }, OFFICE_PAGES)}` : null)
    const sideWords = (side: LedgerRow['from']) => {
      const key = sideKey(side)
      return key ? { main: s(key), sub: '' } : { main: side.location?.code ?? '—', sub: side.location?.name ?? '' }
    }
    const WhenCell = ({ data }: ICellRendererParams<LedgerRow>) =>
      data ? (
        <span className="fw-st-cell" title={t('mv.clocks', { device: formatDateTime(data.occurredAt, place), server: formatDateTime(data.createdAt, place) })}>
          <span className="fw-st-num">{formatDateTime(data.occurredAt, place)}</span>
          <span className="fw-st-sub">{data.siteCode}</span>
        </span>
      ) : null
    const ReasonCell = ({ data }: ICellRendererParams<LedgerRow>) =>
      data ? (
        <span className="fw-st-cell">
          <span className={data.reversedById ? 'fw-st-struck' : undefined}>
            <ReasonTag reason={data.reason} />
          </span>
          <span className="fw-st-sub">
            {data.reversalOfId ? (
              <button type="button" className="fw-stk-reason-button" onClick={() => actions?.onOpen?.(data.reversalOfId)}>
                {t('mv.reversalOf')}
              </button>
            ) : data.reversedById ? (
              <button type="button" className="fw-stk-reason-button" onClick={() => actions?.onOpen?.(data.reversedById)}>
                {t('mv.reversedBy')}
              </button>
            ) : data.writeOff ? (
              t('mv.writeOff', { reason: reasonLabel(writeOffReasons, data.writeOff.reasonCode, locale) })
            ) : (
              ''
            )}
          </span>
        </span>
      ) : null
    const MaterialCell = ({ data }: ICellRendererParams<LedgerRow>) =>
      data ? (
        <span className="fw-st-cell">
          <span className="fw-st-ellipsis" title={`${data.item.code} · ${data.item.name}`}>
            {data.item.code} · {data.item.name}
          </span>
          <span className="fw-st-sub">{data.colour ? `${data.colour.code} ${data.colour.name}` : ''}</span>
        </span>
      ) : null
    const LotCell = ({ data }: ICellRendererParams<LedgerRow>) =>
      data ? (
        <span className="fw-st-cell">
          {data.lot ? (
            <Link className="fw-st-link" href={`${model.prefix}${recordAddress({ type: 'Lot', id: data.lot.id }, OFFICE_PAGES)}`}>
              {data.lot.code}
            </Link>
          ) : (
            <span className="fw-st-sub">—</span>
          )}
          {data.hide && (
            <Link className="fw-st-link fw-st-sub" href={`${model.prefix}${recordAddress({ type: 'Hide', id: data.hide.id }, OFFICE_PAGES)}`}>
              {data.hide.code}
            </Link>
          )}
        </span>
      ) : null
    const RouteCell = ({ data }: ICellRendererParams<LedgerRow>) => {
      if (!data) return null
      const from = sideWords(data.from)
      const to = sideWords(data.to)
      return (
        <span className="fw-st-cell" title={`${[from.main, from.sub].filter(Boolean).join(' · ')} → ${[to.main, to.sub].filter(Boolean).join(' · ')}`}>
          <span className="fw-st-ellipsis">{from.main}</span>
          <span className="fw-st-sub">→ {to.main}</span>
        </span>
      )
    }
    const QuantityCell = ({ data }: ICellRendererParams<LedgerRow>) => {
      if (!data) return null
      const keyed = hasKey(address)
      const unit = s(`uom.${data.item.baseUom}`)
      return (
        <span className="fw-st-cell">
          <span className={`fw-st-num${data.reversedById ? ' fw-st-struck' : ''}`}>{keyed ? `${signed(data.delta, locale)} ${unit}` : `${quantity(data.baseQuantity, locale)} ${unit}`}</span>
          {data.uom !== data.item.baseUom && <span className="fw-st-sub">{t('mv.asEntered', { quantity: quantity(data.quantity, locale), unit: s(`uom.${data.uom}`) })}</span>}
        </span>
      )
    }
    const BalanceCell = ({ data }: ICellRendererParams<LedgerRow>) => (data && balances ? <Qty value={balances.get(data.id) ?? null} uom={data.item.baseUom} /> : null)
    const DocumentCell = ({ data }: ICellRendererParams<LedgerRow>) => {
      if (!data) return null
      const href = docHref(data)
      // A write-off's note is kept as "<CODE>: <note>": its own note is shown (the reason is in the reason cell).
      const note = data.writeOff ? data.writeOff.note : data.note
      const extra = note ?? (href && data.reference && data.reference !== data.document?.number ? data.reference : null)
      return (
        <span className="fw-st-cell" title={[data.document?.number ?? data.reference, note].filter(Boolean).join(' · ') || undefined}>
          {href && data.document ? (
            <Link className="fw-st-link" href={href}>
              {data.document.number}
            </Link>
          ) : (
            <span className="fw-st-ellipsis">{data.reference ?? '—'}</span>
          )}
          {extra && <span className="fw-st-sub">{extra}</span>}
        </span>
      )
    }
    const PostedCell = ({ data }: ICellRendererParams<LedgerRow>) => {
      if (!data) return null
      const by = data.postedBy
      const main = by.audience === 'FLOOR' ? (by.device ? s('postedBy.FLOOR', { device: by.device.name }) : s('postedBy.floorNoDevice')) : by.audience === 'SYSTEM' ? s('postedBy.SYSTEM') : (by.name ?? s('postedBy.officeNoName'))
      return <span className="fw-st-ellipsis">{main}</span>
    }
    const ValueCell = ({ data }: ICellRendererParams<LedgerRow>) => (data ? <span className="fw-st-num">{data.valuation ? money(data.valuation.valueAmount, data.valuation.currency, locale) : '—'}</span> : null)
    const MoreCell = ({ data }: ICellRendererParams<LedgerRow>) => {
      if (!data) return null
      const held = reverseHeldKey(data, can)
      const href = docHref(data)
      const keyHref = `${model.prefix}/warehouse/moves?${new URLSearchParams({ site: data.siteId, item: data.item.id, ...(data.colour ? { colour: data.colour.id } : {}), ...(data.lot ? { lot: data.lot.id } : {}), ...(data.hide ? { hide: data.hide.id } : {}) }).toString()}`
      return (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('mv.rowMenu', { reason: s(`reason.${data.reason}`), material: data.item.code }) }}
          items={[
            { id: 'open', label: t('mv.openMove'), onSelect: () => actions?.onOpen?.(data.id) },
            { id: 'reverse', label: t('mv.reverse'), disabled: !!held, ...(held ? { description: s(held) } : {}), onSelect: () => !held && actions?.onReverse?.(data) },
            ...(href && data.document ? [{ id: 'doc', label: t('mv.openDocument', { number: data.document.number }), href }] : []),
            { id: 'key', label: t('mv.showKey'), href: keyHref },
          ]}
        />
      )
    }
    return [
      { colId: 'when', headerName: t('mv.col.when'), minWidth: 155, flex: 0.8, cellRenderer: WhenCell },
      { colId: 'reason', headerName: t('mv.col.reason'), minWidth: 140, flex: 0.9, cellRenderer: ReasonCell },
      { colId: 'material', headerName: t('mv.col.material'), minWidth: 160, flex: 1.3, cellRenderer: MaterialCell },
      { colId: 'lot', headerName: t('mv.col.lot'), minWidth: 125, flex: 0.8, cellRenderer: LotCell },
      { colId: 'route', headerName: t('mv.col.route'), minWidth: 140, flex: 1, cellRenderer: RouteCell },
      { colId: 'quantity', headerName: t('mv.col.quantity'), minWidth: 105, flex: 0.7, type: 'rightAligned', cellRenderer: QuantityCell },
      ...(balances ? ([{ colId: 'balance', headerName: t('mv.col.balance'), minWidth: 100, flex: 0.7, type: 'rightAligned', cellRenderer: BalanceCell }] satisfies ColDef<LedgerRow>[]) : []),
      { colId: 'document', headerName: t('mv.col.documentNote'), minWidth: 150, flex: 1.1, cellRenderer: DocumentCell },
      { colId: 'posted', headerName: t('mv.col.posted'), minWidth: 115, flex: 0.8, cellRenderer: PostedCell },
      ...(can.cost ? ([{ colId: 'value', headerName: s('money.value'), minWidth: 100, flex: 0.7, type: 'rightAligned', cellRenderer: ValueCell }] satisfies ColDef<LedgerRow>[]) : []),
      { colId: 'more', headerName: t('st.col.actions'), minWidth: 80, maxWidth: 80, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, s, locale, model.prefix, can, balances, address.item, address.lot, address.hide, address.location, writeOffReasons])

  if (!can.stockView) {
    return (
      <div className="fw-st">
        <NoAccess permission="inventory.stock.view" />
      </div>
    )
  }

  const explain = model.explain?.status === 'ready' ? model.explain.value : null
  const chips: { name: keyof MovesAddress; label: string; reason?: MoveReason }[] = []
  const firstRow = model.rows?.[0]
  if (address.item) chips.push({ name: 'item', label: t('mv.chip.item', { code: explain?.item.code ?? firstRow?.item.code ?? '…' }) })
  if (address.colour) chips.push({ name: 'colour', label: t('mv.chip.colour', { code: explain?.colour?.code ?? firstRow?.colour?.code ?? '…' }) })
  if (address.lot) chips.push({ name: 'lot', label: t('mv.chip.lot', { code: explain?.lot?.code ?? firstRow?.lot?.code ?? '…' }) })
  if (address.hide) chips.push({ name: 'hide', label: t('mv.chip.hide', { code: explain?.hide?.code ?? firstRow?.hide?.code ?? '…' }) })
  if (address.location) chips.push({ name: 'location', label: t('mv.chip.location', { code: explain?.location?.code ?? (firstRow?.to.location?.id === address.location ? firstRow.to.location.code : firstRow?.from.location?.code) ?? '…' }) })
  for (const reason of address.reasons) chips.push({ name: 'reasons', reason, label: t('mv.chip.reason', { reason: s(`reason.${reason}`) }) })

  const filtered = chips.length > 0 || address.note !== null || address.reversed !== null || address.writeOffs !== null || address.q.trim() !== '' || address.period !== (hasKey(address) ? 'all' : '30d')
  const clearFilters = (
    <Button
      size="sm"
      onClick={() => {
        setQuery('')
        actions?.onAddress?.({ item: null, colour: null, lot: null, hide: null, location: null, reasons: [], note: null, reversed: null, writeOffs: null, q: '', period: '30d' })
      }}
    >
      {s('common.clearFilters')}
    </Button>
  )
  const state = model.problem ? (
    <ReadFailed problem={model.problem} onRetry={() => actions?.onRetry?.()} />
  ) : model.rows && model.rows.length === 0 ? (
    filtered ? (
      <EmptyState title={s('common.noMatch')} action={clearFilters} />
    ) : (
      <EmptyState
        title={t('mv.empty.title')}
        description={t('mv.empty.body')}
        action={
          can.receive ? (
            <Button size="sm" variant="primary" asChild>
              <Link href={`${model.prefix}/warehouse/receipts`}>{t('st.empty.receive')}</Link>
            </Button>
          ) : undefined
        }
      />
    )
  ) : undefined

  const search = (
    <Input
      size="sm"
      type="search"
      leadingIcon={<Search size={13} aria-hidden />}
      aria-label={t('mv.search')}
      placeholder={t('mv.search')}
      value={query}
      onChange={(event) => {
        typed.current = true
        setQuery(event.target.value)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          typed.current = false
          latest.current?.onAddress?.({ q: query })
        }
      }}
    />
  )
  const tools = (
    <span className="fw-st-actions">
      <Select size="sm" aria-label={t('mv.period.label')} value={address.period} onChange={(event) => actions?.onAddress?.({ period: event.target.value as Period })}>
        {PERIODS.map((period) => (
          <option key={period} value={period}>
            {t(`mv.period.${period}`)}
          </option>
        ))}
      </Select>
      <Select size="sm" aria-label={t('mv.reasonLabel')} value={address.reasons.length === 1 ? address.reasons[0] : ''} onChange={(event) => actions?.onAddress?.({ reasons: event.target.value ? [event.target.value as MoveReason] : [] })}>
        <option value="">{t('mv.allReasons')}</option>
        {MOVE_REASONS.map((reason) => (
          <option key={reason} value={reason}>
            {s(`reason.${reason}`)}
          </option>
        ))}
      </Select>
      <Select size="sm" aria-label={t('mv.note.label')} value={address.note ?? ''} onChange={(event) => actions?.onAddress?.({ note: (event.target.value || null) as MovesAddress['note'] })}>
        <option value="">{t('mv.note.any')}</option>
        <option value="with">{t('mv.note.with')}</option>
        <option value="without">{t('mv.note.without')}</option>
      </Select>
      <Select size="sm" aria-label={t('mv.reversed.label')} value={address.reversed ?? ''} onChange={(event) => actions?.onAddress?.({ reversed: (event.target.value || null) as MovesAddress['reversed'] })}>
        <option value="">{t('mv.reversed.any')}</option>
        <option value="yes">{t('mv.reversed.yes')}</option>
        <option value="no">{t('mv.reversed.no')}</option>
      </Select>
    </span>
  )

  const tiles = MOVE_TILES.filter((tile) => tile !== 'unvalued' || can.cost)
  const pickedRows = (model.rows ?? []).filter((row) => selected.includes(row.id))
  const ownKeys: ListKey[] = [
    { keys: ['r'], does: t('mv.keyReverse') },
    ...(can.adjust ? [{ keys: ['a'], does: t('st.keyAdjust') }] : []),
  ]
  const adjustHeld = !can.adjust ? t('st.held.noAdjust') : !explainsFigure(address) ? t('mv.held.noKey') : null
  const writeOffHeld = writeOffHeldKey(address, can)
  const total = model.rowCount ?? null
  const count = model.rows
    ? model.done
      ? t('mv.countAll', { count: total ?? model.rows.length })
      : total !== null
        ? t('mv.countOf', { loaded: model.rows.length, count: total })
        : t('mv.countLoaded', { count: model.rows.length })
    : '—'

  return (
    <div className="fw-st">
      <div className="fw-st-head">
        <span className="fw-st-actions">
          <span className="fw-stk-status" role="status">
            {model.asOf ? s('live.updated', { time: formatTime(model.asOf, place) }) : t('st.notYet')}
            {' · '}
            {s(`live.${model.live}`)}
            {' · '}
            {t(`mv.period.${address.period}`)}
          </span>
          {model.sites.length > 1 && (
            <Select size="sm" aria-label={s('common.site')} value={address.site ?? ''} onChange={(event) => actions?.onAddress?.({ site: event.target.value || null })}>
              <option value="">{s('common.allSites')}</option>
              {model.sites.map((site) => (
                <option key={site.id} value={site.id}>
                  {site.code} · {site.name}
                </option>
              ))}
            </Select>
          )}
        </span>
        <span className="fw-st-actions">
          <Menu
            label={<MoreHorizontal size={16} aria-hidden />}
            align="right"
            triggerProps={{ 'aria-label': s('common.more') }}
            items={[
              { id: 'export', icon: <Download size={14} aria-hidden />, label: t('mv.exportLoaded'), disabled: !model.rows || model.rows.length === 0, onSelect: () => model.rows && actions?.onExport?.(model.rows) },
              { id: 'keys', label: t('st.shortcuts'), onSelect: () => setHelp(true) },
            ]}
          />
          <Button size="sm" heldReason={writeOffHeld ? d(writeOffHeld) : null} onClick={() => actions?.onWriteOff?.()}>
            <Trash2 size={14} aria-hidden /> {t('mv.writeOffOpen')}
          </Button>
          <Button size="sm" variant="primary" heldReason={adjustHeld} onClick={() => actions?.onAdjust?.()} aria-keyshortcuts="a">
            <SlidersHorizontal size={14} aria-hidden /> {t('st.adjust')}
          </Button>
        </span>
      </div>

      {model.notice && <Banner tone={model.notice.tone} title={t(model.notice.key, model.notice.params)} onDismiss={() => actions?.onNotice?.()} />}

      {explainsFigure(address) && <WhyPanel model={model} actions={actions} />}

      <MetricStrip
        metrics={tiles.map((tile) => {
          const value = tileCount(tile, model.counts)
          const filter = tileFilter(tile)
          return {
            label: t(`mv.tile.${tile}`),
            value: value === null ? '—' : String(value),
            hint: t(`mv.tileHint.${tile}`),
            ...(filter ? { active: tileActive(tile, address), onClick: () => actions?.onAddress?.(tileActive(tile, address) ? { reasons: [], reversed: null, writeOffs: null, period: hasKey(address) ? 'all' : '30d' } : filter) } : {}),
          }
        })}
      />

      {address.writeOffs && (
        <div className="fw-stk-chips">
          <Button size="sm" variant="tonal" aria-label={t('st.removeChip', { chip: t('mv.chip.writeOffs') })} onClick={() => actions?.onAddress?.({ writeOffs: null })}>
            {t('mv.chip.writeOffs')} <X size={12} aria-hidden />
          </Button>
        </div>
      )}

      {chips.length > 0 && (
        <div className="fw-stk-chips" aria-label={t('mv.chips')}>
          {chips.map((chip, index) => (
            <Button
              key={`${chip.name}-${index}`}
              size="sm"
              variant="tonal"
              aria-label={t('st.removeChip', { chip: chip.label })}
              onClick={() => actions?.onAddress?.(chip.name === 'reasons' ? { reasons: address.reasons.filter((reason) => reason !== chip.reason) } : chip.name === 'item' ? { item: null, colour: null } : { [chip.name]: null })}
            >
              {chip.label} <X size={12} aria-hidden />
            </Button>
          ))}
        </div>
      )}

      <ListFrame<LedgerRow>
        label={t('mv.tableLabel')}
        rows={state ? [] : model.rows}
        rowId={(row) => row.id}
        columns={columns}
        count={
          <span className="fw-st-inline">
            {count}
            {model.loadingMore && <Spinner size={12} />}
          </span>
        }
        search={search}
        tools={tools}
        selection={{
          selected,
          onChange: setSelected,
          actions: (
            <>
              <Button size="sm" aria-label={s('common.export', { count: pickedRows.length })} onClick={() => actions?.onExport?.(pickedRows)}>
                <Download size={13} aria-hidden /> <SelectionLabel>{s('common.export', { count: pickedRows.length })}</SelectionLabel>
              </Button>
              <span className="fw-stk-hint">{t('mv.oneAtATime')}</span>
            </>
          ),
        }}
        updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
        endless={{ onNearEnd: () => actions?.onMore?.(), loading: model.loadingMore, done: model.done }}
        keys={ownKeys}
        onHelp={() => setHelp(true)}
        onOpen={(row) => actions?.onOpen?.(row.id)}
        state={state}
        focusRow={model.focusRow}
      />

      {model.detail && <MoveDetailModal model={model} actions={actions} />}
      {model.reverse && <ReverseDialog model={model} actions={actions} />}
      {model.adjust && <AdjustDialog model={model.adjust} actions={adjustActions} />}
      {model.writeOff && <WriteOffDialog model={model.writeOff} actions={writeOffActions} />}

      {help && (
        <Modal open onClose={() => setHelp(false)} title={t('st.shortcuts')} size="sm">
          <ul className="fw-stk-keys">
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

/** "Why is it this number" (design mv-why): the figure, the moves summed by reason, adds up ✓ or the gap in words. */
function WhyPanel({ model, actions }: { model: MovesPageModel; actions?: MovesPageActions }) {
  const t = useT('warehouse-stock')
  const s = useT('stock')
  const locale = useLocale()
  const loaded = model.explain
  if (!loaded || loaded.status === 'loading') {
    return (
      <Card padded>
        <p className="fw-stk-hint" role="status">
          <Spinner size={14} /> {t('mv.why.loading')}
        </p>
      </Card>
    )
  }
  if (loaded.status === 'error') return <ReadFailed problem={loaded.problem} onRetry={() => actions?.onRetry?.()} />
  const explain = loaded.value
  const unit = s(`uom.${explain.item.baseUom}`)
  const what = [`${explain.item.code} · ${explain.item.name}`, explain.colour?.name, explain.lot ? t('adj.lot', { code: explain.lot.code }) : null, explain.hide ? t('adj.hide', { code: explain.hide.code }) : null, explain.location ? explain.location.code : t('mv.why.wholeSite')].filter(Boolean).join(' · ')
  const q = (value: string) => quantity(value, locale)
  const pickReason = (reason: MoveReason) => actions?.onAddress?.({ reasons: model.address.reasons.length === 1 && model.address.reasons[0] === reason ? [] : [reason] })
  return (
    <Card padded>
      <div className="fw-stk-why">
        <SummaryTable
          label={t('mv.why.tableLabel')}
          columns={[t('mv.why.col.reason'), t('mv.why.col.moves'), t('mv.why.col.in'), t('mv.why.col.out'), t('mv.why.col.net')]}
          align={['left', 'right', 'right', 'right', 'right']}
          widths={['34%', undefined, undefined, undefined, undefined]}
          stackOnPhone
          rows={[
            ...explain.byReason.map((row) => ({
              id: row.reason,
              cells: [
                <button key="r" type="button" className="fw-stk-reason-button" aria-pressed={model.address.reasons.includes(row.reason)} onClick={() => pickReason(row.reason)}>
                  {s(`reason.${row.reason}`)}
                </button>,
                String(row.moves),
                `${q(row.in)} ${unit}`,
                `${q(row.out)} ${unit}`,
                `${signed(row.net, locale)} ${unit}`,
              ],
            })),
            { id: 'sum', cells: [<b key="s">{t('mv.why.sum')}</b>, String(explain.moves), '', '', <b key="n">{`${signed(explain.sum, locale)} ${unit}`}</b>] },
          ]}
        />
        <div className="fw-stk-why-sum">
          <span className="fw-stk-hint">{t('mv.why.title')}</span>
          <p className="fw-stk-why-figure">{`${q(explain.onHand)} ${unit}`}</p>
          <span className="fw-st-sub" title={what}>
            {what}
          </span>
          {explain.addsUp ? (
            <Banner tone="success" title={t('mv.why.addsUp', { quantity: q(explain.onHand), unit })} />
          ) : (
            <Banner tone="danger" title={t('mv.why.gap', { gap: signed(explain.gap, locale), unit })} />
          )}
          <span className="fw-stk-hint">{t('mv.why.formula')}</span>
        </div>
      </div>
    </Card>
  )
}

