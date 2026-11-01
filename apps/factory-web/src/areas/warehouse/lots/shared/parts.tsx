'use client'

import { useMemo, type ReactNode } from 'react'
import Link from 'next/link'
import { FileX, MessageSquare, ShieldOff } from 'lucide-react'
import { Card, EmptyState, Tabs, type TabItem } from '@nexus/ui/components'
import type { ColDef, ICellRendererParams } from '@nexus/ui/grid'
import { DetailHeader } from '@nexus/ui/patterns'
import { Button, Kbd, Skeleton, Spinner } from '@nexus/ui/primitives'
import { Modal } from '../../../../lib/i18n/ds-parts'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { listKeys, type ListKey } from '../../../../list-frame/model'
import { formatDateTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import type { LedgerRow, MoveSide } from '../../../_shared/stock/api'
import { movesHref, quantity, signed, TIME_ZONE } from '../../../_shared/stock/model'
import { ReasonTag } from '../../../_shared/stock/parts'
import { areaParts, LOTS_NAMESPACES, runningBalances, share, type Loaded, type Part } from './model'
import '../../../_shared/stock/stock.css'
import './warehouse-lots.css'

/**
 * View parts Hides (SCR-200) and Lots & traceability (SCR-201) share: the catalogue wrapper, the record frame (band
 * with back link, title, pills, actions, tabs, the ⌘J thread button; loading / not found / no right / failed states),
 * the moves of one record (the ledger read for its stock key, with the running balance), the hide's area bar (a
 * stand-in for the design's AreaBalanceBar, missing from the DS) and the full keys list behind `?`.
 */

export function LotsMessages({ children }: { children?: ReactNode }) {
  return <WithMessages namespaces={LOTS_NAMESPACES}>{children}</WithMessages>
}

export type Words = (key: string, params?: Readonly<Record<string, string | number>>) => string

/** The pages' words: keys of `warehouse-lots`, and `stock:<key>` for the shared stock words (units, states, problems). */
export function useWords(): Words {
  const own = useT('warehouse-lots')
  const stock = useT('stock')
  return useMemo<Words>(() => (key, params) => (key.startsWith('stock:') ? stock(key.slice(6), params) : own(key, params)), [own, stock])
}

export interface RecordFrameProps {
  backHref: string
  backLabel: string
  loaded: Loaded<unknown>
  /** The words for the record when it is not there (`hd.record` / `lt.record`). */
  kind: 'hd' | 'lt'
  title?: ReactNode
  meta?: ReactNode
  actions?: ReactNode
  status?: ReactNode
  tabs?: TabItem[]
  tab?: string
  tabsLabel?: string
  onRetry?: () => void
  children?: ReactNode
}

/** A record page's band and its states (design R9): loading skeleton, not found, no right, a failed read with Try again. */
export function RecordFrame({ backHref, backLabel, loaded, kind, title, meta, actions, status, tabs, tab, tabsLabel, onRetry, children }: RecordFrameProps) {
  const t = useWords()
  const back = <Link href={backHref}>{backLabel}</Link>
  if (loaded.status !== 'ready') {
    return (
      <div className="fw-st">
        <div className="fw-wl-band">
          <DetailHeader backAsChild backLabel={back} title={loaded.status === 'loading' ? <Skeleton width={260} height={22} /> : t(`${kind}.record.name`)} />
        </div>
        {loaded.status === 'loading' ? (
          <Card padded aria-busy="true">
            <p className="fw-wl-hint" role="status">
              <Spinner size={14} /> {t('rec.loading')}
            </p>
            <div className="fw-wl-stack tight">
              {Array.from({ length: 6 }, (_, index) => (
                <Skeleton key={index} height={22} />
              ))}
            </div>
          </Card>
        ) : (
          <Card padded>
            <EmptyState
              icon={loaded.status === 'forbidden' ? <ShieldOff size={24} aria-hidden /> : <FileX size={24} aria-hidden />}
              title={t(loaded.status === 'error' ? 'rec.failed' : loaded.status === 'forbidden' ? 'rec.forbidden' : `${kind}.record.notFound`)}
              description={loaded.status === 'error' ? t(`stock:${loaded.problem}`) : loaded.status === 'forbidden' ? t('rec.forbiddenBody') : t(`${kind}.record.notFoundBody`)}
              action={
                loaded.status === 'error' ? (
                  <Button size="sm" onClick={onRetry}>
                    {t('rec.retry')}
                  </Button>
                ) : (
                  <Button size="sm" asChild>
                    <Link href={backHref}>{t(`${kind}.record.backToList`)}</Link>
                  </Button>
                )
              }
            />
          </Card>
        )}
      </div>
    )
  }
  return (
    <div className="fw-st">
      <div className="fw-wl-band">
        <DetailHeader backAsChild backLabel={back} title={title} actions={actions} />
        <div className="fw-wl-meta">
          <span className="fw-wl-chips">{meta}</span>
          {status && (
            <span className="fw-wl-status" role="status">
              {status}
            </span>
          )}
        </div>
        {tabs && tab && <Tabs ariaLabel={tabsLabel ?? ''} tabs={tabs} active={tab} size="sm" overflow="scroll" />}
      </div>
      {children}
    </div>
  )
}

/** The ⌘J thread button (Owner O1): the record's thread beside any tab on a wide screen. */
export function DockButton({ open, onDock }: { open: boolean; onDock?: () => void }) {
  const t = useWords()
  return (
    <Button size="sm" variant={open ? 'tonal' : 'secondary'} active={open} aria-pressed={open} onClick={onDock} title={t('rec.dockHint')}>
      <MessageSquare size={14} aria-hidden /> <span>{t('rec.dock')}</span>
      <span className="fw-st-inline" aria-hidden>
        <Kbd>⌘</Kbd>
        <Kbd>J</Kbd>
      </span>
    </Button>
  )
}

/** A failed or loading part inside a record (its tab), in words. */
export function PartState<T>({ value, label, onRetry, children }: { value: Part<T>; label: string; onRetry?: () => void; children: (value: T) => ReactNode }) {
  const t = useWords()
  if (value.value !== null) return <>{children(value.value)}</>
  return value.problem ? (
    <Card padded>
      <EmptyState
        title={t('rec.partFailed', { part: label })}
        description={t(`stock:${value.problem}`)}
        action={
          onRetry ? (
            <Button size="sm" onClick={onRetry}>
              {t('rec.retry')}
            </Button>
          ) : undefined
        }
      />
    </Card>
  ) : (
    <Card padded aria-busy="true">
      <p className="fw-wl-hint" role="status">
        <Spinner size={14} /> {t('rec.partLoading', { part: label })}
      </p>
    </Card>
  )
}

// ---- the moves of one record ------------------------------------------------------------------------------------------------

export interface MovesPart {
  rows: readonly LedgerRow[]
  closing: string | null
  more: boolean
}

/** Where a move came from or went: a place of the site, else the reason's words (supplier, work order …). */
export function sideWords(side: MoveSide, t: (key: string) => string): string {
  return side.location ? `${side.location.code} · ${side.location.name}` : t(`stock:side.${side.kind}`)
}

/**
 * The moves of a lot or a hide (design hd-moves / lt-moves: the Movements grid, filtered), newest first, with the
 * running balance in the base unit, the document behind each move and who posted it (an office user by name, a floor
 * move by its tablet: never a worker, Owner answer W1). Read only: a reversal is made on Movements.
 */
export function MovesTable({ moves, prefix, label, keyHref, onMore }: { moves: MovesPart; prefix: string; label: string; keyHref: string; onMore?: () => void }) {
  const t = useWords()
  const locale = useLocale()
  const place = { locale, timeZone: TIME_ZONE }
  const balances = useMemo(() => runningBalances(moves.rows, moves.closing), [moves.rows, moves.closing])
  const columns = useMemo<ColDef<LedgerRow>[]>(() => {
    const unit = (row: LedgerRow) => t(`stock:uom.${row.item.baseUom}`)
    const WhenCell = ({ data }: ICellRendererParams<LedgerRow>) =>
      data ? (
        <span className={data.reversedById ? 'fw-st-cell fw-st-struck' : 'fw-st-cell'}>
          <span className="fw-st-num">{formatDateTime(data.occurredAt, place)}</span>
          {data.reversalOfId && <span className="fw-st-sub">{t('mv.reverses')}</span>}
          {data.reversedById && <span className="fw-st-sub">{t('mv.reversed')}</span>}
        </span>
      ) : null
    const ReasonCell = ({ data }: ICellRendererParams<LedgerRow>) => (data ? <ReasonTag reason={data.reason} /> : null)
    const WayCell = ({ data }: ICellRendererParams<LedgerRow>) =>
      data ? (
        <span className="fw-st-cell">
          <span className="fw-st-ellipsis">{t('mv.from', { from: sideWords(data.from, t) })}</span>
          <span className="fw-st-sub">{t('mv.to', { to: sideWords(data.to, t) })}</span>
        </span>
      ) : null
    const QuantityCell = ({ data }: ICellRendererParams<LedgerRow>) =>
      data ? (
        <span className="fw-st-cell">
          <span className="fw-st-num strong">{`${signed(data.delta, locale)} ${unit(data)}`}</span>
          <span className="fw-st-sub">{data.uom !== data.item.baseUom ? `${quantity(data.quantity, locale)} ${t(`stock:uom.${data.uom}`)}` : data.delta === '0.0000' ? t('mv.inside') : ''}</span>
        </span>
      ) : null
    const BalanceCell = ({ data }: ICellRendererParams<LedgerRow>) => {
      if (!data) return null
      const balance = balances.get(data.id)
      return <span className="fw-st-num">{balance === undefined ? '—' : `${quantity(balance, locale)} ${unit(data)}`}</span>
    }
    const DocumentCell = ({ data }: ICellRendererParams<LedgerRow>) => {
      if (!data) return null
      if (data.document?.type === 'GoodsReceipt')
        return (
          <Link className="fw-st-link" href={`${prefix}/warehouse/receipts/${encodeURIComponent(data.document.id)}`}>
            {data.document.number}
          </Link>
        )
      if (data.document?.type === 'WorkOrder')
        return (
          <Link className="fw-st-link" href={`${prefix}/production/work-orders/${encodeURIComponent(data.document.id)}`}>
            {data.document.number}
          </Link>
        )
      return <span className="fw-st-ellipsis">{data.reference ?? '—'}</span>
    }
    const ByCell = ({ data }: ICellRendererParams<LedgerRow>) =>
      data ? (
        <span className="fw-st-ellipsis">
          {data.postedBy.audience === 'FLOOR'
            ? data.postedBy.device
              ? t('stock:postedBy.FLOOR', { device: data.postedBy.device.name })
              : t('stock:postedBy.floorNoDevice')
            : data.postedBy.audience === 'SYSTEM'
              ? t('stock:postedBy.SYSTEM')
              : (data.postedBy.name ?? t('stock:postedBy.officeNoName'))}
        </span>
      ) : null
    return [
      { colId: 'when', headerName: t('mv.col.when'), minWidth: 150, flex: 1, cellRenderer: WhenCell },
      { colId: 'reason', headerName: t('mv.col.reason'), minWidth: 150, flex: 1, cellRenderer: ReasonCell },
      { colId: 'way', headerName: t('mv.col.way'), minWidth: 200, flex: 1.5, cellRenderer: WayCell },
      { colId: 'quantity', headerName: t('mv.col.quantity'), minWidth: 130, flex: 0.9, type: 'rightAligned', cellRenderer: QuantityCell },
      { colId: 'balance', headerName: t('mv.col.balance'), minWidth: 120, flex: 0.8, type: 'rightAligned', cellRenderer: BalanceCell },
      { colId: 'document', headerName: t('mv.col.document'), minWidth: 130, flex: 0.9, cellRenderer: DocumentCell },
      { colId: 'note', headerName: t('mv.col.note'), field: 'note', minWidth: 140, flex: 1, tooltipField: 'note', valueFormatter: (params) => params.value ?? '—' },
      { colId: 'by', headerName: t('mv.col.by'), minWidth: 150, flex: 1, cellRenderer: ByCell },
    ]
  }, [t, locale, balances, prefix])

  return (
    <div className="fw-wl-stack tight">
      <div className="fw-wl-card-head">
        <p className="fw-wl-hint">{t('mv.intro')}</p>
        <Button size="sm" asChild>
          <Link href={keyHref}>{t('mv.openAll')}</Link>
        </Button>
      </div>
      <ListFrame<LedgerRow>
        label={label}
        rows={moves.rows}
        rowId={(row) => row.id}
        columns={columns}
        count={t(moves.more ? 'mv.countMore' : 'mv.count', { count: moves.rows.length })}
        more={moves.more && onMore ? { label: t('rec.showMore'), onMore } : null}
        state={moves.rows.length === 0 ? <EmptyState title={t('mv.none')} description={t('mv.noneBody')} /> : undefined}
      />
    </div>
  )
}

/** The Movements page for one stock key (company-free path + the prefix). */
export const movesOf = (prefix: string, key: Parameters<typeof movesHref>[1]) => movesHref(prefix, key)

// ---- the hide's area bar ----------------------------------------------------------------------------------------------------

/**
 * One bar for what happened to a hide's area (stand-in for the design's AreaBalanceBar, not in the DS): used by cuts,
 * in stock now, at the work order (not cut yet); each part with its area and share in words beside the bar (never colour
 * alone). A remnant back in stock is said in words. A figure that does not add up says so.
 */
export function AreaBar({ area, cuts }: { area: { measured: string; cut: string; remnant: string; onHand: string; uom: LedgerRow['uom'] }; cuts: number }) {
  const t = useWords()
  const locale = useLocale()
  const parts = areaParts(area)
  const unit = t(`stock:uom.${parts.uom}`)
  const words = (value: number) => `${quantity(value, locale)} ${unit}`
  const segments = [
    { id: 'cut', value: parts.cut, label: t('hd.area.cut', { area: words(parts.cut), share: share(parts.cut, parts.measured), count: cuts }) },
    { id: 'stock', value: parts.onHand, label: t('hd.area.stock', { area: words(parts.onHand), share: share(parts.onHand, parts.measured) }) },
    { id: 'elsewhere', value: parts.elsewhere, label: t('hd.area.elsewhere', { area: words(parts.elsewhere), share: share(parts.elsewhere, parts.measured) }) },
  ].filter((segment) => segment.value > 0)
  return (
    <div className="fw-wl-area">
      <p className="fw-wl-text">{t('hd.area.measured', { area: words(parts.measured) })}</p>
      <div className="fw-wl-area-bar" role="img" aria-label={segments.map((segment) => segment.label).join('; ') || t('hd.area.nothing')}>
        {segments.map((segment) => (
          <span key={segment.id} className={`fw-wl-area-seg ${segment.id}`} style={{ width: `${share(segment.value, Math.max(parts.measured, parts.cut + parts.onHand + parts.elsewhere))}%` }} />
        ))}
      </div>
      <ul className="fw-wl-area-legend">
        {segments.map((segment) => (
          <li key={segment.id}>
            <span className={`fw-wl-swatch ${segment.id}`} aria-hidden />
            {segment.label}
          </li>
        ))}
      </ul>
      {parts.remnant > 0 && <p className="fw-wl-hint">{t('hd.area.remnant', { area: words(parts.remnant) })}</p>}
      {!parts.addsUp && <p className="fw-wl-hint fw-st-warning">{t('hd.area.gap')}</p>}
    </div>
  )
}

// ---- the keys list ----------------------------------------------------------------------------------------------------------

/** `?` and the footer's "All shortcuts": every key of the list (its own first, then the frame's). */
export function KeysModal({ own, onClose }: { own: readonly ListKey[]; onClose: () => void }) {
  const t = useWords()
  const lists = useT('lists')
  return (
    <Modal open onClose={onClose} title={t('rec.shortcuts')} size="sm">
      <ul className="fw-wl-list">
        {listKeys(own, true).map((entry) => (
          <li key={entry.does}>
            <b>{entry.keys.join(' ')}</b> — {entry.does.startsWith('keys.') ? lists(entry.does) : entry.does}
          </li>
        ))}
      </ul>
    </Modal>
  )
}
