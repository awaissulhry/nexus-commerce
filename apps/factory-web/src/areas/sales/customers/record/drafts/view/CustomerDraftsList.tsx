'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Banner, EmptyState } from '@nexus/ui/components'
import type { ColDef, ICellRendererParams } from '@nexus/ui/grid'
import { Button } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../../../list-frame/ListFrame'
import { formatDate, formatTime } from '../../../../../../lib/i18n/format'
import { INTL_LOCALE } from '../../../../../../lib/i18n/locales'
import { priceText } from '../../../../inquiries/model'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../../record-panels/i18n'
import { NAMESPACE as SHEET_NS } from '../../../../orders/list/sheet/model'
import type { DraftRow } from '../api'
import { draftTitle, filesWords, linesWords, messagesWords, readyOf, showsValue, untitledOf, type DraftsRead, type Words } from '../model'
import { DRAFT_NS } from '../../../../../../lib/order-draft/words'
import { draftValueOf } from '../model' // F-CP-141 (follow-up 6): the draft's own value when the API sends it
import { money } from '../../../../quotes/model' // F-CP-141: minor units
// ---- F-CQ-205 (customer page › Quotes & incoming): the section "Customer is writing" mounts this list too — no Views ▾ there, each
// draft's garment picture (the one picture part, `portalOrder` source)
import type { ReadPictures } from '../../../../../../lib/record-picture/cache'
import { RecordPicture } from '../../../../../../lib/record-picture/view/RecordPicture'

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
  // F-CQ-303: no Views ▾ any more (it was the Work tab's, over its Drafts view; that view left with the drafts).
  /** F-CQ-205: each draft's first style as its picture (the host's batch read and its header's words); absent: no Picture column. */
  readonly pictures?: { readonly read: ReadPictures; readonly header: string } | null
  /** Design cases: the widths that show the wide columns. */
  readonly wide?: boolean
  /** cq fx2 W-04: the host's own room in px (Quotes & incoming's): Files and Wanted by from 1000 px; under it the list fits whole. */
  readonly room?: number | null
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
// F-CW-104 (10-design §3.8; S28: the sideways scroll only): the Work tab hands its own room (`forced`, followed live: the thread
// closed or opened); without a host's word the window decides as before.
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
  return forced ?? wide
}

function DraftsList({ model, actions }: { model: CustomerDraftsListModel; actions?: CustomerDraftsListActions }) {
  const t = useT('parties')
  const dt = useT(DRAFT_NS) // od-w2.3: the ONE draft order's words (one key, one place)
  const locale = useLocale()
  const wide = useWide(model.wide)
  const latest = useRef(actions)
  const picturesNow = useRef(model.pictures ?? null) // F-CQ-205: the cells read the host's batch read through it
  picturesNow.current = model.pictures ?? null
  latest.current = actions
  const say = (words: Words) => t(words.key, words.params)
  const joined = (list: readonly Words[]) => (list.length > 0 ? list.map(say).join(' · ') : '—')
  const untitled = (row: DraftRow) => untitledOf(row, dt, (iso) => formatDate(iso, { locale }))
  const today = new Date().toDateString()
  const moment = (iso: string) => (new Date(iso).toDateString() === today ? formatTime(iso, { locale }) : formatDate(iso, { locale }))
  const rows = model.read.status === 'ready' ? model.read.rows : null
  const price = showsValue(rows) // the money wall: no Value column without the price grain
  // cq fx2 W-04 (walk: 173 px sideways at 779, cut cells at every width): under 1000 px of the host's room the list leaves out Files and
  // Wanted by; "by <name>" goes on a second line (the rows grow) — no cell is cut, nothing scrolls sideways.
  const roomy = model.room === undefined || model.room === null || model.room >= 1000

  const columns = useMemo<ColDef<DraftRow>[]>(() => {
    const DraftCell = ({ data }: ICellRendererParams<DraftRow>) =>
      data ? (
        <span className="fw-cwd-cell is-wrap">
          <strong className="fw-cwd-title">{draftTitle(data, untitled(data))}</strong>
          <span className="fw-cwd-sub">
            {data.draft?.startedBy ? t('customers.drafts.started', { date: formatDate(data.draft.startedAt, { locale }), name: data.draft.startedBy }) : data.draft ? t('customers.drafts.startedNoName', { date: formatDate(data.draft.startedAt, { locale }) }) : '—'}
          </span>
        </span>
      ) : null
    const ReadyCell = ({ data }: ICellRendererParams<DraftRow>) => {
      const ready = data ? readyOf(data) : null
      if (!ready) return <span>—</span>
      // od-w2.3 (R1): "N still open" in the draft part's own words (information, never a hold); nothing open: "Nothing is open."
      return <span className="fw-cwd-inline is-wrap">{ready.open === 0 ? dt('still.none') : ready.open === 1 ? dt('still.count_one', { n: 1 }) : dt('still.count_other', { n: ready.open })}</span>
    }
    const OpenCell = ({ data }: ICellRendererParams<DraftRow>) =>
      data ? (
        <Button size="sm" variant="quiet" aria-label={t('customers.drafts.openOf', { draft: draftTitle(data, untitled(data)) })} onClick={() => latest.current?.onOpen?.(data)}>
          {t('customers.drafts.open')}
        </Button>
      ) : null
    // F-CQ-205: the draft's garment (the one picture part; the batch read names its first style) — only when the host hands its read.
    const pictures = picturesNow.current
    const PictureCell = ({ data }: ICellRendererParams<DraftRow>) => (data ? <RecordPicture source="portalOrder" recordId={data.id} number={draftTitle(data, untitled(data))} size="cell" read={picturesNow.current?.read ?? null} /> : null)
    return [
      ...(pictures ? [{ colId: 'picture', headerName: pictures.header, minWidth: 76, maxWidth: 76, sortable: false, suppressHeaderMenuButton: true, cellRenderer: PictureCell } satisfies ColDef<DraftRow>] : []),
      // cq fx2 W-04: the two-fact cells wrap (autoHeight) instead of cutting; least widths 180 · 110 · 120 · 120 · 64 (+ Files 88, Wanted by
      // 110 from 1000 px): 670 px beside the dock at 779 with the Picture, 868 from 1000.
      { colId: 'draft', headerName: t('customers.drafts.col.draft'), minWidth: 180, flex: 2, autoHeight: true, cellRenderer: DraftCell, valueGetter: (params) => (params.data ? draftTitle(params.data, untitled(params.data)) : '') },
      { colId: 'lines', headerName: t('customers.drafts.col.lines'), minWidth: 110, flex: 1, autoHeight: true, wrapText: true, valueGetter: (params) => (params.data ? joined(linesWords(params.data)) : '') },
      { colId: 'files', headerName: t('customers.drafts.col.files'), minWidth: 88, flex: 1, hide: !roomy, autoHeight: true, wrapText: true, valueGetter: (params) => (params.data ? joined(filesWords(params.data)) : '') },
      // F-CW-102 (lead settle S28: only the Drafts view's sideways scroll): Ready and Wanted by had no share of the room, so the grid
      // gave each its 200 px default — 1058 px of columns in the 863 px beside the dock, the Open button off-screen. Each now takes
      // its share from its own least width ("5 of 6" beside "1 problem" whole): 200 + 130 + 88 + 136 + 140 + 92 + 64 = 850 px.
      { colId: 'ready', headerName: t('customers.drafts.col.ready'), minWidth: 120, flex: 0.8, autoHeight: true, cellRenderer: ReadyCell, valueGetter: (params) => params.data?.draft?.openCount ?? null },
      {
        colId: 'changed',
        headerName: t('customers.drafts.col.changed'),
        minWidth: 120,
        flex: 1,
        autoHeight: true,
        wrapText: true, // cq fx2 W-04: "02/11/2026 by <name>" wraps instead of "02/11/2026 by S…"
        valueGetter: (params) => {
          const draft = params.data?.draft
          if (!draft) return '—'
          return draft.lastEditedBy ? t('customers.drafts.changed', { time: moment(draft.lastEditedAt), name: draft.lastEditedBy }) : moment(draft.lastEditedAt)
        },
      },
      // cq fx5 W-04: 132 px — the header "Wanted by" whole beside its sort mark (110 cut it to "Wanted …" at 1185 and 1314).
      { colId: 'wanted', headerName: t('customers.drafts.col.wanted'), minWidth: 132, flex: 0.6, hide: !roomy, valueGetter: (params) => (params.data?.requestedDate ? formatDate(`${params.data.requestedDate}T12:00:00Z`, { locale }) : '—') },
      {
        colId: 'messages',
        headerName: t('customers.drafts.col.messages'),
        minWidth: 120,
        flex: 1, // F-CW-104: its share of the room (without one the grid gave it 200 px: a sideways scroll at 1183)
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
              flex: 0.6, // F-CW-104
              hide: !wide,
              type: 'rightAligned',
              // F-CP-141 (follow-up 6): B-CP-076's draft value (minor units) when present, else the net at the prices shown.
              valueGetter: (params) => {
                const value = params.data ? draftValueOf(params.data) : null
                if (!value || !params.data) return '—'
                return 'minor' in value ? money(value.minor, params.data.currency, locale) : priceText(value.decimal, params.data.currency, INTL_LOCALE[locale])
              },
            } satisfies ColDef<DraftRow>,
          ]
        : []),
      { colId: 'more', headerName: '', minWidth: 64, maxWidth: 88, sortable: false, cellRenderer: OpenCell },
    ]
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the cells read the latest actions through `latest`
  }, [t, dt, locale, wide, price, !!model.pictures /* F-CQ-205 */, roomy /* cq fx2 W-04 */]) // od-fx8: `untitled` reads dt and locale

  // F-CQ-303: the Work tab's Views ▾ over the drafts is gone with its Drafts view (Quotes & incoming draws this list with no Views ▾).

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
      state={state}
      updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
      onRowClick={(row) => actions?.onRow?.(row)}
      onOpen={(row) => actions?.onOpen?.(row)}
      active={{ id: model.activeId, onFocusRow: (row) => actions?.onFocusRow?.(row) }}
    />
  )
}
