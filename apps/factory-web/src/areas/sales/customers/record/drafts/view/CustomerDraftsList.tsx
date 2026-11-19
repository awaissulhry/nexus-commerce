'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Banner, EmptyState, Menu } from '@nexus/ui/components'
import type { ColDef, ICellRendererParams } from '@nexus/ui/grid'
import { Button, Tag } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../../../list-frame/ListFrame'
import { builtInViewItems } from '../../../../../../list-frame/tools/ListToolsBar'
import { formatDate, formatNumber, formatTime } from '../../../../../../lib/i18n/format'
import { INTL_LOCALE } from '../../../../../../lib/i18n/locales'
import { priceText } from '../../../../inquiries/model'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../../record-panels/i18n'
import type { OrdersListActions, OrdersListModel } from '../../../../orders/list/list-model'
import { NAMESPACE as SHEET_NS } from '../../../../orders/list/sheet/model'
import { builtInActive, builtInViewsOf, pickBuiltIn } from '../../../../orders/list/view/OrdersListView'
import type { DraftRow } from '../api'
import { draftTitle, filesWords, linesWords, messagesWords, readyOf, showsValue, type DraftsRead, type Words } from '../model'

/**
 * F-CP-107 (customer page plan D10; 10-customer-page §6; picture 22's office list) — "Drafts of <customer>": the customer's portal drafts,
 * read only, in the Work tab's place of the Orders sheet (the strip stays above, the same Views ▾ to go back). A row: the draft (its
 * first style, else "Untitled draft"; started when and by whom) · its lines, pieces and people · its files (counts; a measurement sheet
 * is never named here) · how ready it is (and its problems) · its last change · the day wanted; from 1800 px its conversation and —
 * price holders only (the API drops it otherwise) — its value at the prices shown. A click shows the draft's own conversation in the
 * dock (↑ / ↓ follow); Enter or Open shows it in its read-only window. No selection, no export. States: reading, none, failed, live
 * changes behind "N updates · Show". Draws its model; fetches nothing.
 */

export interface CustomerDraftsListModel {
  readonly customer: string
  readonly read: DraftsRead
  readonly updates: number
  /** The draft whose conversation the dock shows (marked); null: none. */
  readonly activeId: string | null
  /** The Work tab's sheet model and actions: its Views ▾ (the same items, the Drafts view ticked) and their picks. */
  readonly views: { readonly model: OrdersListModel; readonly actions?: OrdersListActions }
  /** Design cases: the widths that show the wide columns. */
  readonly wide?: boolean
}

export interface CustomerDraftsListActions {
  readonly onRow?: (row: DraftRow) => void
  readonly onFocusRow?: (row: DraftRow) => void
  readonly onOpen?: (row: DraftRow) => void
  readonly onRetry?: () => void
  readonly onShowUpdates?: () => void
}

export const DRAFTS_NAMESPACES = ['parties', 'orders', SHEET_NS, 'lists'] as const

export function CustomerDraftsList(props: { model: CustomerDraftsListModel; actions?: CustomerDraftsListActions }) {
  return (
    <WithMessages namespaces={DRAFTS_NAMESPACES}>
      <DraftsList {...props} />
    </WithMessages>
  )
}

/** The wide columns (the conversation, the value) from 1800 px, as the Orders sheet's. */
function useWide(forced: boolean | undefined): boolean {
  const query = '(min-width: 1800px)'
  const [wide, setWide] = useState(() => forced ?? (typeof window !== 'undefined' && !!window.matchMedia?.(query).matches))
  useEffect(() => {
    if (forced !== undefined || typeof window === 'undefined' || !window.matchMedia) return
    const list = window.matchMedia(query)
    const on = () => setWide(list.matches)
    list.addEventListener('change', on)
    return () => list.removeEventListener('change', on)
  }, [forced])
  return wide
}

function DraftsList({ model, actions }: { model: CustomerDraftsListModel; actions?: CustomerDraftsListActions }) {
  const t = useT('parties')
  const o = useT('orders')
  const s = useT(SHEET_NS)
  const l = useT('lists')
  const locale = useLocale()
  const wide = useWide(model.wide)
  const latest = useRef(actions)
  latest.current = actions
  const say = (words: Words) => t(words.key, words.params)
  const joined = (list: readonly Words[]) => (list.length > 0 ? list.map(say).join(' · ') : '—')
  const untitled = t('customers.drafts.untitled')
  const today = new Date().toDateString()
  const moment = (iso: string) => (new Date(iso).toDateString() === today ? formatTime(iso, { locale }) : formatDate(iso, { locale }))
  const rows = model.read.status === 'ready' ? model.read.rows : null
  const price = showsValue(rows) // the money wall: no Value column without the price grain

  const columns = useMemo<ColDef<DraftRow>[]>(() => {
    const DraftCell = ({ data }: ICellRendererParams<DraftRow>) =>
      data ? (
        <span className="fw-cwd-cell">
          <strong className="fw-cwd-title">{draftTitle(data, untitled)}</strong>
          <span className="fw-cwd-sub">
            {data.draft?.startedBy ? t('customers.drafts.started', { date: formatDate(data.draft.startedAt, { locale }), name: data.draft.startedBy }) : data.draft ? t('customers.drafts.startedNoName', { date: formatDate(data.draft.startedAt, { locale }) }) : '—'}
          </span>
        </span>
      ) : null
    const ReadyCell = ({ data }: ICellRendererParams<DraftRow>) => {
      const ready = data ? readyOf(data) : null
      if (!ready) return <span>—</span>
      return (
        <span className="fw-cwd-inline">
          <span>{say(ready.words)}</span>
          {ready.problems > 0 && <Tag tone="warning">{t('customers.drafts.problems', { count: ready.problems })}</Tag>}
        </span>
      )
    }
    const OpenCell = ({ data }: ICellRendererParams<DraftRow>) =>
      data ? (
        <Button size="sm" variant="quiet" aria-label={t('customers.drafts.openOf', { draft: draftTitle(data, untitled) })} onClick={() => latest.current?.onOpen?.(data)}>
          {t('customers.drafts.open')}
        </Button>
      ) : null
    return [
      { colId: 'draft', headerName: t('customers.drafts.col.draft'), minWidth: 200, flex: 2, cellRenderer: DraftCell, valueGetter: (params) => (params.data ? draftTitle(params.data, untitled) : '') },
      { colId: 'lines', headerName: t('customers.drafts.col.lines'), minWidth: 130, flex: 1, valueGetter: (params) => (params.data ? joined(linesWords(params.data)) : '') },
      { colId: 'files', headerName: t('customers.drafts.col.files'), minWidth: 100, flex: 1, valueGetter: (params) => (params.data ? joined(filesWords(params.data)) : '') },
      { colId: 'ready', headerName: t('customers.drafts.col.ready'), minWidth: 90, cellRenderer: ReadyCell, valueGetter: (params) => params.data?.draft?.readiness.done ?? null },
      {
        colId: 'changed',
        headerName: t('customers.drafts.col.changed'),
        minWidth: 140,
        flex: 1,
        valueGetter: (params) => {
          const draft = params.data?.draft
          if (!draft) return '—'
          return draft.lastEditedBy ? t('customers.drafts.changed', { time: moment(draft.lastEditedAt), name: draft.lastEditedBy }) : moment(draft.lastEditedAt)
        },
      },
      { colId: 'wanted', headerName: t('customers.drafts.col.wanted'), minWidth: 100, valueGetter: (params) => (params.data?.requestedDate ? formatDate(`${params.data.requestedDate}T12:00:00Z`, { locale }) : '—') },
      {
        colId: 'messages',
        headerName: t('customers.drafts.col.messages'),
        minWidth: 120,
        hide: !wide,
        valueGetter: (params) => {
          const words = params.data ? messagesWords(params.data) : null
          return words ? say(words) : '—'
        },
      },
      // Money wall: the value only for a price holder (the API drops `netShown` for anyone else: no column at all then).
      ...(price
        ? [
            {
              colId: 'value',
              headerName: t('customers.drafts.col.value'),
              minWidth: 104,
              hide: !wide,
              type: 'rightAligned',
              valueGetter: (params) => (params.data?.netShown ? priceText(params.data.netShown, params.data.currency, INTL_LOCALE[locale]) : '—'),
            } satisfies ColDef<DraftRow>,
          ]
        : []),
      { colId: 'more', headerName: '', minWidth: 64, maxWidth: 88, sortable: false, cellRenderer: OpenCell },
    ]
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the cells read the latest actions through `latest`
  }, [t, locale, wide, price, untitled])

  // The Views ▾ of the Work tab: the same items as the sheet's, the Drafts view ticked; a pick goes through the sheet (which drops `list`).
  const views = model.views
  const builtIns = { items: builtInViewsOf(views.model, o, s, (value) => formatNumber(value, locale)), active: builtInActive(views.model), onPick: (id: string) => pickBuiltIn(id, views.model, views.actions) }
  const active = builtIns.items.find((view) => view.id === builtIns.active) ?? null
  const viewsMenu = <Menu label={active ? l('tools.viewsTrigger', { name: active.label }) : l('tools.builtIn')} items={[{ id: 'h-builtin', heading: true, label: l('tools.builtIn') }, ...builtInViewItems(builtIns)]} />

  const state =
    model.read.status === 'failed' ? (
      <Banner
        tone="danger"
        title={t('customers.drafts.failed')}
        action={
          <Button size="sm" onClick={() => actions?.onRetry?.()}>
            {t('customers.drafts.retry')}
          </Button>
        }
      />
    ) : rows && rows.length === 0 ? (
      <EmptyState title={t('customers.drafts.empty', { customer: model.customer })} />
    ) : undefined

  return (
    <ListFrame<DraftRow>
      label={t('customers.work.view.drafts', { customer: model.customer })}
      listKey={null}
      rows={state ? [] : rows}
      rowId={(row) => row.id}
      columns={columns}
      count={rows ? t('customers.drafts.count', { count: rows.length }) : '—'}
      tools={viewsMenu}
      state={state}
      updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
      onRowClick={(row) => actions?.onRow?.(row)}
      onOpen={(row) => actions?.onOpen?.(row)}
      active={{ id: model.activeId, onFocusRow: (row) => actions?.onFocusRow?.(row) }}
    />
  )
}
