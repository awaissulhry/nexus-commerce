'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { Download, ExternalLink, MoreHorizontal, Search, X } from 'lucide-react'
import { Banner, Card, EmptyState, Menu, MetricStrip, type Metric } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, FilterChip, Input, Pill, Tag } from '@nexus/ui/primitives'
import { DateField, DetailModal, Modal } from '../../../../lib/i18n/ds-parts'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { listKeys, type ListKey } from '../../../../list-frame/model'
import { formatDate, formatTime } from '../../../../lib/i18n/format'
import type { Locale } from '../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import type { Margins, OrderMargin, OrderMarginRow } from '../api'
import { barsOf, changeTone, MARGINS_NAMESPACE, moneyText, orderHref, orderMarginTabHref, pctText, pctTone, stagePhrase, type CsvWords, type MarginsAddress, type MarginsCan } from '../model'
import { BarList, MarginMeter, MarginStrip, ProfitBridge, Waterfall, WorkOrderShares, MarginLines } from './parts'
import '../margins.css'

export type LiveState = 'connecting' | 'live' | 'offline'

export interface OrderDetailState {
  readonly id: string
  readonly value: OrderMargin | null
  readonly problem: string | null
}

/** SCR-155 — Margins' view model (the view draws it and fetches nothing). */
export interface MarginsModel {
  readonly prefix: string
  readonly can: MarginsCan
  readonly today: string
  readonly address: MarginsAddress
  /** The first read of the address: rows, tiles, by customer and style (null while it reads). */
  readonly margins: { readonly value: Margins | null; readonly problem: string | null; readonly slow: boolean }
  /** Every row read so far (Show more appends). */
  readonly rows: readonly OrderMarginRow[] | null
  readonly more: boolean
  readonly readAt: number | null
  readonly live: LiveState
  readonly updates: number
  readonly detail: OrderDetailState | null
  readonly notice: { readonly tone: 'danger' | 'info'; readonly words: { key: string } } | null
  /** Design cases: the selected rows, the focused row, the keys panel open. */
  readonly selected?: readonly string[]
  readonly focusRow?: number
  readonly keysOpen?: boolean
}

export interface MarginsActions {
  onAddress?: (next: Partial<MarginsAddress>) => void
  onSearch?: (text: string) => void
  onRetry?: (part: 'margins' | 'detail') => void
  onMore?: () => void
  onShowUpdates?: () => void
  onExport?: (rows: readonly OrderMarginRow[], words: CsvWords, fileName: string) => void
  onDismissNotice?: () => void
}

/**
 * SCR-155 — Finance › Costing › Margins (design finance.margins; FIN-047): the band (scope: the order dates, read at,
 * live; ⋯ Export this view), the tiles (average margin %, orders below the floor — W2b —, margin lost since the quote),
 * Order margin, quote to actual (each order's value, cost at quote, as estimated now and so far, the margin quoted →
 * now; a row opens its profitability: the DetailModal with J / K), and By customer and style (BarList with margin %; a
 * bar filters the orders). Each figure only with its grain: the price grain the value, the cost grain the costs, the
 * margin grain the margin % — and a margin amount only with the margin AND the cost grain (sales see %, never cost
 * amounts). No wages and no person anywhere.
 */
export function MarginsView({ model, actions }: { model: MarginsModel; actions?: MarginsActions }) {
  return (
    <WithMessages namespaces={[MARGINS_NAMESPACE, 'lists']}>
      <MarginsPageView model={model} actions={actions} />
    </WithMessages>
  )
}

function MarginsPageView({ model, actions }: { model: MarginsModel; actions?: MarginsActions }) {
  const t = useT(MARGINS_NAMESPACE)
  const lists = useT('lists')
  const locale = useLocale()
  const [selectedOwn, setSelected] = useState<string[]>([])
  const [help, setHelp] = useState(false)
  const [typed, setTyped] = useState<string | null>(null)
  const selected = model.selected ? [...model.selected] : selectedOwn
  const can = model.can
  const rows = model.rows
  const margins = model.margins.value
  const amounts = can.margin && can.cost

  const columns = useMemo<ColDef<OrderMarginRow>[]>(() => {
    const OrderCell = ({ data }: ICellRendererParams<OrderMarginRow>) =>
      data ? (
        <span className="fw-fmg-cell">
          {can.orders ? (
            <Link
              className="fw-fmg-link"
              href={orderMarginTabHref(model.prefix, data.order.id)}
              onClick={(event) => {
                if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
                event.preventDefault()
                actions?.onAddress?.({ open: data.order.id })
              }}
            >
              {data.order.number}
            </Link>
          ) : (
            <span>{data.order.number}</span>
          )}
          <span className="fw-fmg-cell-sub">{formatDate(`${data.order.orderDate}T12:00:00Z`, { locale })}</span>
        </span>
      ) : null
    const CustomerCell = ({ data }: ICellRendererParams<OrderMarginRow>) =>
      data ? (
        <span className="fw-fmg-cell">
          <span className="fw-fmg-ellipsis">{data.order.party.name}</span>
          <span className="fw-fmg-cell-sub">{data.order.customerRef ?? t('row.noRef')}</span>
        </span>
      ) : null
    const money = (pick: (row: OrderMarginRow) => number | null | undefined) =>
      function MoneyCell({ data }: ICellRendererParams<OrderMarginRow>) {
        return data ? <span className="fw-fmg-num">{moneyText(pick(data) ?? null, data.currency, locale)}</span> : null
      }
    const ActualCell = ({ data }: ICellRendererParams<OrderMarginRow>) =>
      data ? (
        <span className="fw-fmg-cell">
          <span className="fw-fmg-num">{data.started ? moneyText(data.actualCost ?? null, data.currency, locale) : '—'}</span>
          <span className="fw-fmg-cell-sub">{t(stagePhrase(data).key)}</span>
        </span>
      ) : null
    const MarginCell = ({ data }: ICellRendererParams<OrderMarginRow>) =>
      data ? (
        <span className="fw-fmg-cell">
          <span className="fw-fmg-inline">
            <span className="fw-fmg-num">{pctText(data.quotedMarginPct ?? null, locale)}</span>
            <span aria-hidden>→</span>
            <Pill tone={pctTone(data.estimateMarginPct)}>{pctText(data.estimateMarginPct ?? null, locale)}</Pill>
          </span>
          {amounts && typeof data.marginChange === 'number' && <span className={`fw-fmg-cell-sub fw-fmg-tone is-${changeTone(data.marginChange)}`}>{t('row.change', { amount: signedMoney(data.marginChange, data.currency, locale) })}</span>}
        </span>
      ) : null
    const ActualPctCell = ({ data }: ICellRendererParams<OrderMarginRow>) => (data ? <span className="fw-fmg-num">{data.started ? pctText(data.actualMarginPct ?? null, locale) : '—'}</span> : null)
    const StateCell = ({ data }: ICellRendererParams<OrderMarginRow>) =>
      data ? (
        <span className="fw-fmg-inline">
          <Tag tone={data.final ? 'success' : 'info'}>{t(`status.${data.order.status}`)}</Tag>
          {data.provisional && <span className="fw-fmg-cell-sub">{t('row.provisional')}</span>}
        </span>
      ) : null
    return [
      { colId: 'order', headerName: t('col.order'), minWidth: 140, flex: 0.9, cellRenderer: OrderCell },
      { colId: 'customer', headerName: t('col.customer'), minWidth: 180, flex: 1.3, cellRenderer: CustomerCell },
      ...(can.price ? [{ colId: 'value', headerName: t('col.value'), minWidth: 120, flex: 0.8, type: 'rightAligned', cellRenderer: money((row) => row.value) } satisfies ColDef<OrderMarginRow>] : []),
      ...(can.cost
        ? [
            { colId: 'quotedCost', headerName: t('col.quotedCost'), minWidth: 150, flex: 0.8, type: 'rightAligned', cellRenderer: money((row) => row.quotedCost) } satisfies ColDef<OrderMarginRow>,
            { colId: 'estimateCost', headerName: t('col.estimateCost'), minWidth: 150, flex: 0.8, type: 'rightAligned', cellRenderer: money((row) => row.estimateCost) } satisfies ColDef<OrderMarginRow>,
            { colId: 'actualCost', headerName: t('col.actualCost'), minWidth: 170, flex: 0.9, type: 'rightAligned', cellRenderer: ActualCell } satisfies ColDef<OrderMarginRow>,
          ]
        : []),
      ...(can.margin
        ? [
            { colId: 'margin', headerName: t('col.margin'), minWidth: 210, flex: 1.1, cellRenderer: MarginCell } satisfies ColDef<OrderMarginRow>,
            { colId: 'actualPct', headerName: t('col.actualPct'), minWidth: 110, flex: 0.6, type: 'rightAligned', cellRenderer: ActualPctCell } satisfies ColDef<OrderMarginRow>,
          ]
        : []),
      { colId: 'state', headerName: t('col.state'), minWidth: 150, flex: 0.9, cellRenderer: StateCell },
    ]
  }, [t, locale, model.prefix, can, amounts, actions])

  if (!can.view) {
    return (
      <div className="fw-fmg">
        <EmptyState title={t('noAccess.title')} description={t('noAccess.body', { permission: 'costing.view' })} />
      </div>
    )
  }

  const tiles = margins?.tiles ?? null
  const picked = (rows ?? []).filter((row) => selected.includes(row.order.id))
  const filtered = Object.entries(model.address).some(([key, value]) => key !== 'open' && value !== null)
  const csvWords: CsvWords = { header: (column) => t(`csv.${column}`), status: (row) => t(`status.${row.order.status}`), stage: (row) => t(stagePhrase(row).key) }
  const fileName = `${t('csv.file', { day: model.today })}.csv`
  const ownKeys: ListKey[] = [{ keys: ['/'], does: t('keys.search') }, { keys: ['Enter'], does: t('keys.open') }]
  const partyName = model.address.party ? (margins?.byCustomer.find((group) => group.party.id === model.address.party)?.party.name ?? t('filter.customer')) : null
  const styleCode = model.address.style ? (margins?.byStyle.find((group) => group.style.id === model.address.style)?.style.code ?? t('filter.style')) : null

  const metrics: Metric[] = [
    { label: t('tiles.average'), value: tiles ? pctText(tiles.averageMarginPct ?? null, locale) : '—', hint: tiles && tiles.unknown > 0 ? t('tiles.unknown', { count: tiles.unknown }) : t('tiles.averageHint') },
    { label: t('tiles.floor'), value: '—', hint: t('tiles.floorLater') },
    ...(amounts
      ? [
          {
            label: t('tiles.lost'),
            value: tiles ? <span className={`fw-fmg-tone is-${changeTone(typeof tiles.marginLostSinceQuote === 'number' ? -tiles.marginLostSinceQuote : null)}`}>{moneyText(tiles.marginLostSinceQuote ?? null, tiles.currency, locale)}</span> : '—',
            hint: t('tiles.lostHint'),
          } satisfies Metric,
        ]
      : []),
    { label: t('tiles.orders'), value: tiles ? String(tiles.orders) : '—', hint: t('tiles.ordersHint') },
  ]

  const search = (
    <Input
      size="sm"
      type="search"
      leadingIcon={<Search size={13} aria-hidden />}
      aria-label={t('list.search')}
      placeholder={t('list.search')}
      value={typed ?? model.address.q ?? ''}
      onChange={(event) => {
        setTyped(event.target.value)
        actions?.onSearch?.(event.target.value)
      }}
    />
  )
  const chips =
    partyName || styleCode ? (
      <span className="fw-fmg-inline">
        {partyName && (
          <FilterChip pressed onClick={() => actions?.onAddress?.({ party: null })} aria-label={t('filter.clear', { name: partyName })}>
            {partyName} <X size={12} aria-hidden />
          </FilterChip>
        )}
        {styleCode && (
          <FilterChip pressed onClick={() => actions?.onAddress?.({ style: null })} aria-label={t('filter.clear', { name: styleCode })}>
            {styleCode} <X size={12} aria-hidden />
          </FilterChip>
        )}
      </span>
    ) : undefined
  const clear = (
    <Button
      size="sm"
      onClick={() => {
        setTyped(null)
        actions?.onAddress?.({ from: null, to: null, party: null, style: null, q: null })
      }}
    >
      {t('list.clearFilters')}
    </Button>
  )
  const state = model.margins.problem ? (
    <EmptyState title={t('list.failed')} description={t(model.margins.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.('margins')}>{t('common.retry')}</Button>} />
  ) : rows && rows.length === 0 ? (
    filtered ? <EmptyState title={t('list.noMatch.title')} description={t('list.noMatch.body')} action={clear} /> : <EmptyState title={t('list.empty.title')} description={t('list.empty.body')} />
  ) : undefined
  const ids = (rows ?? []).map((row) => row.order.id)

  return (
    <div className="fw-fmg">
      <div className="fw-fmg-band" role="group" aria-label={t('band.label')}>
        <span className="fw-fmg-inline">
          <span className="fw-fmg-muted">{t('scope.from')}</span>
          <span className="fw-fmg-date">
            <DateField value={model.address.from ?? ''} max={model.address.to ?? model.today} locale={locale === 'it' ? 'it-IT' : 'en-GB'} ariaLabel={t('scope.fromLabel')} placeholder={t('scope.any')} clearLabel={t('scope.clear')} onChange={(value) => actions?.onAddress?.({ from: value || null })} />
          </span>
          <span className="fw-fmg-muted">{t('scope.to')}</span>
          <span className="fw-fmg-date">
            <DateField value={model.address.to ?? ''} max={model.today} locale={locale === 'it' ? 'it-IT' : 'en-GB'} ariaLabel={t('scope.toLabel')} placeholder={t('scope.any')} clearLabel={t('scope.clear')} onChange={(value) => actions?.onAddress?.({ to: value || null })} />
          </span>
          {(model.address.from || model.address.to) && (
            <Button size="sm" onClick={() => actions?.onAddress?.({ from: null, to: null })}>
              {t('scope.every')}
            </Button>
          )}
          {model.readAt !== null ? <span className="fw-fmg-muted">{t('band.readAt', { time: formatTime(model.readAt, { locale }) })}</span> : <span className="fw-fmg-muted">{t('band.reading')}</span>}
          <Tag tone={model.live === 'live' ? 'success' : model.live === 'offline' ? 'warning' : 'neutral'}>{t(`live.${model.live}`)}</Tag>
        </span>
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('band.more') }}
          items={[{ id: 'export', label: t('band.export'), onSelect: () => rows && actions?.onExport?.(rows, csvWords, fileName), ...(rows && rows.length > 0 ? {} : { disabled: true, description: t('band.exportHeld') }) }]}
        />
      </div>

      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={t(model.notice.words.key)}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
              {t('common.dismiss')}
            </Button>
          }
        />
      )}
      {tiles?.words && <Banner tone="info" title={t('tiles.currencies')} />}

      <section className="fw-fmg-section" aria-labelledby="fw-fmg-tiles">
        <h2 id="fw-fmg-tiles" className="fw-fmg-h2">
          {t('tiles.title')}
        </h2>
        {!can.margin ? (
          <p className="fw-fmg-muted">{t('tiles.noGrain')}</p>
        ) : model.margins.problem && !tiles ? (
          <EmptyState title={t('tiles.failed')} description={t(model.margins.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.('margins')}>{t('common.retry')}</Button>} />
        ) : (
          <MetricStrip metrics={metrics} minTileWidth={190} />
        )}
        <p className="fw-fmg-muted">{t('tiles.provisional')}</p>
      </section>

      <section className="fw-fmg-section" aria-labelledby="fw-fmg-orders">
        <div className="fw-fmg-section-head">
          <h2 id="fw-fmg-orders" className="fw-fmg-h2">
            {t('list.title')}
          </h2>
          <span className="fw-fmg-muted">{t('list.hint')}</span>
        </div>
        {model.margins.slow && !rows && !model.margins.problem && (
          <p className="fw-fmg-muted" role="status">
            {t('list.slow')}
          </p>
        )}
        <ListFrame<OrderMarginRow>
          label={t('list.title')}
          title={t('list.fileTitle')}
          rows={state ? [] : rows}
          rowId={(row) => row.order.id}
          columns={columns}
          count={rows ? t('list.count', { count: rows.length }) : '—'}
          search={search}
          tools={chips}
          selection={{
            selected,
            onChange: setSelected,
            actions: (
              <Button size="sm" variant="primary" aria-label={t('bulk.export', { count: picked.length })} onClick={() => actions?.onExport?.(picked, csvWords, fileName)}>
                <Download size={13} aria-hidden /> <SelectionLabel>{t('bulk.export', { count: picked.length })}</SelectionLabel>
              </Button>
            ),
          }}
          updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
          more={model.more ? { label: t('list.more'), onMore: () => actions?.onMore?.() } : null}
          keys={ownKeys}
          onHelp={() => setHelp(true)}
          onOpen={(row) => actions?.onAddress?.({ open: row.order.id })}
          state={state}
          focusRow={model.focusRow}
          keysOpen={model.keysOpen}
        />
      </section>

      <section className="fw-fmg-section" aria-labelledby="fw-fmg-by">
        <div className="fw-fmg-section-head">
          <h2 id="fw-fmg-by" className="fw-fmg-h2">
            {t('by.title')}
          </h2>
          <span className="fw-fmg-muted">{t('by.hint')}</span>
        </div>
        {!can.margin ? (
          <p className="fw-fmg-muted">{t('by.noGrain')}</p>
        ) : model.margins.problem ? (
          <EmptyState title={t('by.failed')} description={t(model.margins.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.('margins')}>{t('common.retry')}</Button>} />
        ) : !margins ? (
          <Card padded aria-busy="true">
            <p className="fw-fmg-muted" role="status">
              {t('by.loading')}
            </p>
          </Card>
        ) : (
          <div className="fw-fmg-pair">
            <Card padded className="fw-fmg-card">
              <h3 className="fw-fmg-h3">{t('by.customer')}</h3>
              <BarList bars={barsOf(margins.byCustomer)} label={t('by.customer')} active={model.address.party} onPick={(id) => actions?.onAddress?.({ party: model.address.party === id ? null : id })} />
            </Card>
            <Card padded className="fw-fmg-card">
              <h3 className="fw-fmg-h3">{t('by.style')}</h3>
              <BarList bars={barsOf(margins.byStyle)} label={t('by.style')} active={model.address.style} onPick={(id) => actions?.onAddress?.({ style: model.address.style === id ? null : id })} />
            </Card>
          </div>
        )}
      </section>

      {model.detail && <OrderMarginDialog state={model.detail} ids={ids} can={can} prefix={model.prefix} onGo={(id) => actions?.onAddress?.({ open: id })} onClose={() => actions?.onAddress?.({ open: null })} onRetry={() => actions?.onRetry?.('detail')} />}

      {help && (
        <Modal open onClose={() => setHelp(false)} title={t('keys.title')} size="sm">
          <ul className="fw-fmg-muted">
            {listKeys(ownKeys, true).map((entry) => (
              <li key={`${entry.keys.join('+')}-${entry.does}`}>
                <b>{entry.keys.map((key) => (key === 'click' ? lists('keys.click') : key)).join(' ')}</b> — {entry.does.startsWith('keys.') ? lists(entry.does) : entry.does}
              </li>
            ))}
          </ul>
        </Modal>
      )}
    </div>
  )
}

/**
 * pop:order — one order's profitability (design "SO-1043 — profitability", a DetailModal: centred, a full-screen sheet on
 * a phone; J / K the next or previous order of the list): the strip quoted → now → so far, the bridge from price to
 * margin, where the margin went, by line, the work orders behind the cost (each a link to its cost), and "Open order"
 * (its Margin tab). The documents (invoices, credit notes, payments) come with W2b.
 */
export function OrderMarginDialog({ state, ids, can, prefix, onGo, onClose, onRetry }: { state: OrderDetailState; ids: readonly string[]; can: MarginsCan; prefix: string; onGo?: (id: string) => void; onClose?: () => void; onRetry?: () => void }) {
  const t = useT(MARGINS_NAMESPACE)
  const detail = state.value
  return (
    <DetailModal
      open
      onClose={() => onClose?.()}
      title={t('detail.title', { number: detail?.order.number ?? t('detail.thisOrder') })}
      subtitle={detail ? detail.order.party.name : undefined}
      meta={detail ? <Tag tone={detail.final ? 'success' : 'info'}>{t(stagePhrase(detail).key)}</Tag> : undefined}
      nav={ids.length > 1 && ids.includes(state.id) ? { ids, current: state.id, onGo: (id) => onGo?.(id), noun: t('detail.noun') } : undefined}
      loading={!detail && !state.problem}
      error={state.problem ? t(state.problem) : undefined}
      onRetry={state.problem ? onRetry : undefined}
      footer={
        detail ? (
          <>
            <span className="grow" />
            {can.orders ? (
              <Button size="sm" variant="primary" asChild>
                <Link href={orderMarginTabHref(prefix, detail.order.id)}>
                  <ExternalLink size={13} aria-hidden /> {t('detail.open')}
                </Link>
              </Button>
            ) : (
              <Button size="sm" variant="primary" heldReason={t('held.noOrders', { permission: 'orders.view' })}>
                {t('detail.open')}
              </Button>
            )}
          </>
        ) : undefined
      }
    >
      {detail && <ProfitabilityBody detail={detail} can={can} prefix={prefix} />}
    </DetailModal>
  )
}

/** The profitability of one order (the DetailModal's body; the sales order's Margin tab draws the same parts). */
export function ProfitabilityBody({ detail, can, prefix }: { detail: OrderMargin; can: MarginsCan; prefix: string }) {
  const t = useT(MARGINS_NAMESPACE)
  return (
    <div className="fw-fmg-detail">
      {can.margin && <MarginStrip detail={detail} can={can} />}
      {can.margin && <MarginMeter quoted={detail.quotedMarginPct} now={detail.estimateMarginPct} />}
      {!can.margin && <Banner tone="info" title={t('detail.noGrain')} />}
      <div className="fw-fmg-pair">
        <section className="fw-fmg-card" aria-label={t('bridge.title')}>
          <h3 className="fw-fmg-h3">{t('bridge.title')}</h3>
          <ProfitBridge detail={detail} can={can} />
        </section>
        <section className="fw-fmg-card" aria-label={t('waterfall.title')}>
          <h3 className="fw-fmg-h3">{t('waterfall.title')}</h3>
          <Waterfall detail={detail} can={can} prefix={prefix} />
        </section>
      </div>
      <section className="fw-fmg-card" aria-label={t('lines.title')}>
        <h3 className="fw-fmg-h3">{t('lines.title')}</h3>
        <MarginLines detail={detail} can={can} />
      </section>
      <section className="fw-fmg-card" aria-label={t('shares.title')}>
        <h3 className="fw-fmg-h3">{t('shares.title')}</h3>
        <WorkOrderShares detail={detail} can={can} prefix={prefix} />
      </section>
      <p className="fw-fmg-muted">{detail.provisional ? t('detail.provisional') : t('detail.method')}</p>
      <p className="fw-fmg-muted">{t('detail.documentsLater')}</p>
      <p className="fw-fmg-muted">
        <Link className="fw-fmg-link" href={orderHref(prefix, detail.order.id)}>
          {t('detail.orderLink', { number: detail.order.number })}
        </Link>
      </p>
    </div>
  )
}

function signedMoney(minor: number, currency: string, locale: Locale): string {
  const text = moneyText(Math.abs(minor), currency, locale)
  return minor > 0 ? `+${text}` : minor < 0 ? `−${text}` : text
}
