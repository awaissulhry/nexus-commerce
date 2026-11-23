'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { Copy, FileText, MoreHorizontal, Plus, Search } from 'lucide-react'
import { Banner, EmptyState, Field, KeyValue, Menu, MetricStrip } from '@nexus/ui/components'
import type { ColDef, ICellRendererParams } from '@nexus/ui/grid'
import { Button, FilterChip, Input, Pill, RadioCard, Select, Spinner, Tag, TokenChip } from '@nexus/ui/primitives'
import { Modal } from '../../../../../lib/i18n/ds-parts'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { useListSearch } from '../../../../../list-frame/search/use-list-search' // F-SA-223
import { CustomerSwitcher } from '../../../_shared/customer-switcher/view/CustomerSwitcher' // F-SA-224
import { listKeys, type ListKey } from '../../../../../list-frame/model'
import { formatDate, formatTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { previewHref, QUOTE_STATUSES, type QuoteListRow, type QuoteStatus } from '../../api'
import { activeFilterCount, APPROVAL_TONE, droppedWords, isExpiring, money, NO_FILTERS, percent, QUOTE_TILES, START_FROM, STATUS_TONE, tileOfFilters, warningWords } from '../../model'
// ---- F-CQ-102 / F-CQ-104 (customer page › Quotes & incoming): the chips cell, the date cell, the order, the host's columns by its room
import { customerSeesWords, isQuoteGroupTerm, quoteDateOf, quoteWhereOf, sortedQuotes, URGENT_TOO_MANY, type ListFilters, type ListWords, type QuoteListSort } from '../../model'
import { byRoom, datesFold, hostTier, reaches } from '../../../_shared/list-room'
import { WhereChips, type WhereChipWords } from '../../../_shared/where-cell/view/WhereChips'
// ---- F-CQ-201 / 202 / 204 (customer page › Quotes & incoming): the bar (3 + More ▾), the ONE many-acts window, Add task to N, the
// quote's own windows on a row (in place)
import { CANCELLABLE_QUOTES, orderMakeable, quoteBarOf, type QuoteActKind } from '../bar'
import { heldRowItem, ManyActDialog, ManyBar } from '../../../_shared/many-acts/view/ManyActDialog'
import { replyPortalHeld } from '../../../orders/list/reply-many' // cq fx5 W3-2
import { MessagesHeader, MORE_CELL } from '../../../_shared/list-heads/ListHeads' // cq fx2 W-05: narrow headers whole
import { TaskNewDialog } from '../../../../../record-panels/tasks/view/TaskNewDialog'
import { QuoteDialogs } from '../../record/view/Dialogs'
import { ReplyManyDialog } from '../../../orders/list/view/ReplyManyDialog' // F-CQ-304
import { DuplicateDialog } from '../../duplicate/view/DuplicateDialog'
import type { NewQuoteModel, QuotesListActions, QuotesListViewModel } from '../list-model'
import '../../quotes.css'
// B-W2b-316: New quote › Start from Template / Inquiry, the page's ⋯ links.
import { NewFromBody, NewFromDone, StartFromOption, useHeldWords } from '../../new-from/view/NewFrom'
import { QuotesPageLinks } from '../../new-from/view/PageLinks'
// ---- B-TH-257: the New messages column (B-TH-230's LastMessageCell) ----
import { LAST_MESSAGE_NS, LastMessageCell } from '../../../../../lib/last-message-cell/view/LastMessageCell'
import { unreadValue } from '../../../../../lib/last-message-cell/model'
// ---- TH-6 part B (B-TH-257 follow-up; grid-F01): the Picture column, as the Orders sheet's ----
// F-SA-212: the ONE picture part (the cell and the picture large).
import { RecordPicture } from '../../../../../lib/record-picture/view/RecordPicture'
import { PictureViewer } from '../../../../../lib/record-picture/view/PictureViewer'

export type { QuotesListViewModel, QuotesListActions } from '../list-model'

/**
 * SCR-034 — Quotes (Sales; design sales.quotes, 00 §2.1 list frame): the saved-filter tiles (each puts its chips in the
 * filter row: one filter model you can see), the toolbar (search by number or customer reference, status, only mine;
 * the time it was read; live changes wait behind "n updates · Show" so rows never move under the cursor), the list
 * (a stacked card list on a phone) with each number a real link, and the New quote dialog (customer, contact, the
 * number it will get). Money follows the person's grains. Keys: c new quote, / search. It fetches nothing.
 */
export function QuotesListView({ model, actions }: { model: QuotesListViewModel; actions?: QuotesListActions }) {
  return (
    <WithMessages namespaces={['sales', 'lists', LAST_MESSAGE_NS /* B-TH-257 */, 'orders-sheet' /* F-CQ-102: "Newest first", the money note (read only) */]}>
      <QuotesList model={model} actions={actions} />
    </WithMessages>
  )
}

function QuotesList({ model, actions }: { model: QuotesListViewModel; actions?: QuotesListActions }) {
  const t = useT('sales')
  const lists = useT('lists')
  const l = useT(LAST_MESSAGE_NS) // B-TH-257
  const os = useT('orders-sheet') // F-CQ-102: one word for one thing ("Newest first", the money columns' note)
  const locale = useLocale()
  const latest = useRef({ model, actions })
  latest.current = { model, actions }
  // F-SA-223: the one search rule of every list (300 ms after the last key, Enter at once, Esc clears, 100 at most, follows the address).
  const search = useListSearch(model.filters.q, (q) => latest.current.actions?.onFilters?.({ ...latest.current.model.filters, q }))
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  const [dialog, setDialog] = useState<'help' | null>(null)
  const [viewer, setViewer] = useState<string | null>(null) // TH-6 part B: the row whose picture is open large
  // A new read (filters, Show updates) starts with nothing selected; the design cases set their own.
  const rowsKey = model.rows.items?.map((row) => row.id).join(',') ?? ''
  useEffect(() => setSelected((current) => current.filter((id) => rowsKey.includes(id))), [rowsKey])
  useEffect(() => setSelected(model.selected ?? []), [model.selected])

  // c: a new quote (00 §3.17) — never while typing or inside a dialog. The list frame keeps / j k x Enter ?.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.metaKey || event.ctrlKey || event.altKey || model.newQuote || dialog) return
      if (target && (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]') || target.isContentEditable)) return
      if (event.key === 'c' && model.can.manage) {
        event.preventDefault()
        actions?.onNewQuote?.(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const pressed = tileOfFilters(model.filters)
  const items = model.rows.items
  // F-CQ-102: "Valid until, soonest first" sorts the loaded rows; every other order is the server's.
  const shown = useMemo(() => (items ? sortedQuotes(items.filter((row) => !model.filters.expiring || isExpiring(row, model.today)), model.filters.sort) : null), [items, model.filters.expiring, model.today, model.filters.sort])
  const filtered = activeFilterCount(model.filters) > 0
  const recordHref = useCallback((row: QuoteListRow) => `${model.prefix}/sales/quotes/${row.id}`, [model.prefix])
  const picked = (shown ?? []).filter((row) => selected.includes(row.id))
  const ownKeys: ListKey[] = [{ keys: ['c'], does: t('list.keyNew') }]

  const live = useRef({ actions, manage: model.can.manage, rights: model.barRights ?? null })
  live.current = { actions, manage: model.can.manage, rights: model.barRights ?? null }
  // ---- F-CQ-102 / F-CQ-104: the host's face — its columns by the list's own room (never the window), its customer's one name.
  const host = model.columns === 'host'
  const tier = hostTier(model.room)
  const fold = host && datesFold(tier)
  const say = useCallback((words: ListWords | null | undefined): string => (words ? t(words.key, words.params) : ''), [t])
  // ---- end F-CQ-102 / F-CQ-104
  const columns = useMemo<ColDef<QuoteListRow>[]>(() => {
    // TH-6 part B (grid-F01): the first style's small preview ("+2"), opening the picture large; the placeholder without a file.
    const PictureCell = ({ data }: ICellRendererParams<QuoteListRow>) =>
      data ? (
        <RecordPicture
          source="quote"
          recordId={data.id}
          number={data.number}
          picture={data.picture ?? null}
          styleCount={data.styleCount ?? 1}
          size="cell"
          read={latest.current.actions?.readPictures}
          demo={latest.current.model.demoPictures?.[data.id]}
          onOpen={() => setViewer(data.id)}
        />
      ) : null
    const NumberCell = ({ data }: ICellRendererParams<QuoteListRow>) =>
      data ? (
        <span className="fw-ql-cell">
          <Link className="fw-ql-link" href={recordHref(data)}>
            {data.number}
          </Link>
          {/* F-CQ-102 (L18): the revision only from r2 — "r1" is never drawn. */}
          {data.revision >= 2 && <span className="fw-ql-row-sub">{t('record.versionChip', { revision: data.revision })}</span>}
          {/* B-TH-257 (grid-F08): "from INQ-…" — the request the quote was made from (a door with the requests right). */}
          {data.madeFrom &&
            (latest.current.model.readsRequests ? (
              <Link className="fw-ql-row-sub" href={`${model.prefix}/sales/incoming/${encodeURIComponent(data.madeFrom.inquiryId)}`}>
                {t('list.madeFrom', { number: data.madeFrom.number })}
              </Link>
            ) : (
              <span className="fw-ql-row-sub">{t('list.madeFrom', { number: data.madeFrom.number })}</span>
            ))}
          {/* F-CQ-102 (Q3-B9): a quote made from a PORTAL order says so (the number only: the API names it only with orders.view). */}
          {!data.madeFrom && data.fromPortalOrder && <span className="fw-ql-row-sub">{t('list.madeFrom', { number: data.fromPortalOrder.number })}</span>}
          {/* F-CQ-102: on the host (no Customer column) the customer's reference sits here when no source does. */}
          {host && !data.madeFrom && !data.fromPortalOrder && data.customerRef && <span className="fw-ql-row-sub">{t('list.ref', { ref: data.customerRef })}</span>}
        </span>
      ) : null
    const CustomerCell = ({ data }: ICellRendererParams<QuoteListRow>) =>
      data ? (
        <span className="fw-ql-cell">
          <span className="fw-ql-ellipsis" title={data.partyName /* cq fx5 W-12: whole on hover when two lines are not enough */}>
            {data.partyName}
          </span>
          {data.customerRef && <span className="fw-ql-row-sub">{t('list.ref', { ref: data.customerRef })}</span>}
        </span>
      ) : null
    // B-TH-257 (grid-F07): an accepted row names its order ("SO-…", "SO-… cancelled") or says the order waits.
    // F-CQ-102 (10-design §4.3; C32, C33): the ONE chips cell "Where it is" — the state and who it waits on, the one fact that matters
    // now (approval rejected, ends in N days, why the order waits — t('list.orderWaits') is its title), what the customer sees; the date
    // folds here under 840 px of list room. The order opens with orders.view. No amount in any chip.
    const StatusCell = ({ data }: ICellRendererParams<QuoteListRow>) => {
      if (!data) return null
      const m = latest.current.model
      const cell = quoteWhereOf(data, m.today, m.customerName ?? data.partyName)
      const chips: WhereChipWords[] = cell.chips.map((chip) => ({
        words: chip.portal ? t(chip.key, { state: customerSeesWords(chip.portal, locale) }) : chip.at ? t(chip.key, { ...chip.params, date: formatDate(chip.at, { locale }) }) : t(chip.key, chip.params),
        tone: chip.tone,
        look: chip.look,
        href: chip.order && m.readsOrders ? `${m.prefix}/sales/orders/${encodeURIComponent(chip.order.id)}` : null,
        title: chip.key === 'list.where.acceptedWaits' ? t('list.orderWaits') : chip.order ? t('list.order', { number: chip.order.number }) : null,
      }))
      const date = quoteDateOf(data, m.today)
      const folded = fold && date.day ? [t('list.where.foldValid', { date: formatDate(`${date.day}T12:00:00Z`, { locale }) }), say(date.note)].filter(Boolean).join(' · ') : null
      const quiet = [cell.styles > 0 ? t('list.where.styles', { count: cell.styles }) : '', t('list.where.pieces', { count: cell.pieces })].filter(Boolean).join(' · ')
      return <WhereChips chips={chips} fold={folded} foldTone={date.tone} quiet={quiet} />
    }
    // B-TH-257 (grid-F03): the reader's own new messages — a door to the quote's thread at the first new one.
    const NewMessagesCell = ({ data }: ICellRendererParams<QuoteListRow>) => (data ? <LastMessageCell unread={latest.current.model.unread?.[data.id]} href={`${recordHref(data)}?thread=new`} record={data.number} /> : null)
    const MarginCell = ({ data }: ICellRendererParams<QuoteListRow>) =>
      data ? (
        <span className="fw-q-inline">
          {percent(data.marginPct, locale)}
          {data.marginFloorBreached ? <Tag tone="warning">{t('lines.belowFloor')}</Tag> : null}
        </span>
      ) : null
    const ApprovalCell = ({ data }: ICellRendererParams<QuoteListRow>) => (data?.approval ? <Pill tone={APPROVAL_TONE[data.approval]}>{t(`approvalStatus.${data.approval}`)}</Pill> : <span>—</span>)
    // F-CQ-102 (10-design §4.4): Valid until — a sent quote's day with how long it stands (amber within 7 days), an expired one's with
    // "Offer ended", a declined one's day; "—" for a quote not sent yet.
    const ValidCell = ({ data }: ICellRendererParams<QuoteListRow>) => {
      if (!data) return null
      const date = quoteDateOf(data, latest.current.model.today)
      if (!date.day) return <span>—</span>
      return (
        <span className="fw-ql-cell">
          <span>{formatDate(`${date.day}T12:00:00Z`, { locale })}</span>
          {date.note && (date.tone === 'warning' ? <Tag tone="warning">{say(date.note)}</Tag> : <span className="fw-ql-row-sub">{say(date.note)}</span>)}
        </span>
      )
    }
    // F-CQ-204: a row's next steps (the quote's own windows: Ask for approval, Approve / Reject — the asker never decides, said inside —,
    // Make revision N also from Expired / Declined, Make the order now, Add task), Send on the quote page as a door; never for a missing right.
    const rowActs = (data: QuoteListRow) => {
      const { manage, rights, actions: acts } = live.current
      const can = latest.current.model.can
      const act = (id: Parameters<NonNullable<QuotesListActions['onRowAct']>>[1]) => () => acts?.onRowAct?.(data, id)
      return [
        ...(manage && data.status === 'DRAFT' ? [{ id: 'ask', label: `${t('action.ask')}…`, onSelect: act('ask') }] : []),
        ...(can.approve && data.status === 'PENDING_APPROVAL' ? [{ id: 'approve', label: `${t('action.approve')}…`, onSelect: act('approve') }, { id: 'reject', label: `${t('action.reject')}…`, onSelect: act('reject') }] : []),
        ...(can.send && latest.current.model.grains.price && data.status === 'APPROVED' ? [{ id: 'send', label: t('list.row.sendOnPage'), href: `${recordHref(data)}?tab=approval` }] : []),
        ...(manage && ['SENT', 'EXPIRED', 'DECLINED'].includes(data.status) ? [{ id: 'revise', label: `${t('action.revise', { next: data.revision + 1 })}…`, onSelect: act('revise') }] : []),
        ...(rights?.orders && orderMakeable(data) ? [{ id: 'makeOrder', label: `${t('record.makeOrder')}…`, onSelect: act('makeOrders') }] : []),
        // F-CQ-304: Reply to <customer>… on this one quote (threads.post): the Reply-to-N window with one record, the tick OFF.
        // cq fx5 W3-2: held with the window's words when the host knows the customer reads no portal.
        ...(rights?.threads ? [heldRowItem('reply', t('list.row.reply', { customer: latest.current.model.customerName ?? data.partyName }), replyPortalHeld(latest.current.model.replyPortal, 'Quote', latest.current.model.customerName ?? data.partyName), act('reply'))] : []),
        ...(rights?.tasks ? [{ id: 'addTask', label: t('list.row.addTask'), onSelect: act('addTask') }] : []),
      ]
    }
    const MoreCell = ({ data }: ICellRendererParams<QuoteListRow>) =>
      data ? (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('list.rowMenu', { number: data.number }) }}
          items={[
            { id: 'open', label: t('list.open'), href: recordHref(data) },
            { id: 'tab', label: t('list.openNewTab'), href: recordHref(data), target: '_blank' },
            // ---- F-CQ-204 (10-design §7; C1, C28): the quote's next steps in its OWN windows, here — each only with its right, by its state.
            ...rowActs(data),
            // F-CQ-102 (Q1-B1, Q1-B7): the priced PDF only for a reader who sees prices (the API refuses the others), in the quote's own language.
            ...(latest.current.model.grains.price ? [{ id: 'pdf', label: t('action.previewPdf'), icon: <FileText size={14} aria-hidden />, href: previewHref(data.id, data.language ?? 'it'), target: '_blank' as const }] : []),
            // B-W2a-49 (SAL-155): a new draft copied from this quote, for this customer or another.
            // F-CQ-102 (Q1-B9): not drawn without the right (never a held act for a missing right).
            ...(live.current.manage
              ? [
                  {
                    id: 'duplicate',
                    label: t('action.duplicate'),
                    icon: <Copy size={14} aria-hidden />,
                    onSelect: () => live.current.actions?.onDuplicateStart?.(data),
                  },
                ]
              : []),
            { id: 'copy', label: t('action.copyNumber'), onSelect: () => void navigator.clipboard?.writeText(data.number).catch(() => undefined) },
            ...(live.current.manage && CANCELLABLE_QUOTES.includes(data.status) ? [{ id: 'cancel', label: t('action.cancel'), tone: 'danger' as const, onSelect: () => live.current.actions?.onRowAct?.(data, 'cancel') }] : []),
          ]}
        />
      ) : null
    // ---- F-CQ-102 / F-CQ-104 (10-design §4.1; C27): the host's columns by the list's OWN room — no Customer column (one customer's
    // tab); M− 720–839 the base row (the date folds under the chips) · M + Valid until · L + Updated, Pieces (+ Net, Total with the price
    // grain) · XL + Approval; Margin % a Customise choice. A column the room leaves out is hidden and an opt-in choice in Customise
    // (its words "… (from a wider list)"), so "In view" counts only what is shown (P0-B5). The ⋯ column stays last.
    if (host) {
      const wider = (column: ColDef<QuoteListRow>, wanted: Parameters<typeof reaches>[1]) => byRoom(column, reaches(tier, wanted), t('list.col.wider', { label: String(column.headerName ?? '') }))
      const marginLabel = t('list.col.margin')
      return [
        { colId: 'picture', headerName: t('list.col.picture'), minWidth: 76, maxWidth: 76, sortable: false, suppressHeaderMenuButton: true, cellRenderer: PictureCell },
        { colId: 'number', headerName: t('list.col.number'), field: 'number', minWidth: 150, maxWidth: 190, flex: 0, cellRenderer: NumberCell, autoHeight: true },
        { colId: 'status', headerName: t('list.col.where'), field: 'status', minWidth: 220, flex: 2, cellRenderer: StatusCell, autoHeight: true },
        wider({ colId: 'valid', headerName: t('list.col.validUntil'), field: 'validUntil', minWidth: 132, maxWidth: 150, cellRenderer: ValidCell }, 'M'),
        wider({ colId: 'updated', headerName: t('list.col.updated'), field: 'updatedAt', minWidth: 104, maxWidth: 120, valueFormatter: (params) => (params.value ? formatDate(params.value as string, { locale }) : '—') }, 'L'),
        wider({ colId: 'units', headerName: t('list.col.units'), field: 'units', minWidth: 116, maxWidth: 140, valueFormatter: (params) => (params.data ? t('list.units', { units: params.data.units, lines: params.data.lineCount }) : '') }, 'L'),
        ...(model.grains.price
          ? [
              wider({ colId: 'net', headerName: t('list.col.net'), field: 'netAmount', minWidth: 112, maxWidth: 130, type: 'rightAligned', valueFormatter: (params) => (params.data ? money(params.data.netAmount, params.data.currency, locale) : '') }, 'L'),
              wider({ colId: 'gross', headerName: t('list.col.gross'), field: 'grossAmount', minWidth: 112, maxWidth: 130, type: 'rightAligned', valueFormatter: (params) => (params.data ? money(params.data.grossAmount, params.data.currency, locale) : '') }, 'L'),
            ]
          : []),
        ...(model.grains.margin ? [{ colId: 'margin', headerName: marginLabel, field: 'marginPct', minWidth: 150, flex: 0, cellRenderer: MarginCell, hide: true, context: { optIn: true } } satisfies ColDef<QuoteListRow>] : []),
        wider({ colId: 'approval', headerName: t('list.col.approval'), field: 'approval', minWidth: 120, maxWidth: 140, cellRenderer: ApprovalCell }, 'XL'),
        ...(model.unread ? ([{ colId: 'newMessages', headerName: l('column'), headerTooltip: l('columnHint'), headerComponent: MessagesHeader /* cq fx2 W-05 */, minWidth: 52, maxWidth: 64, sortable: false, valueGetter: ({ data }: { data?: QuoteListRow }) => unreadValue(data ? latest.current.model.unread?.[data.id] : undefined), cellRenderer: NewMessagesCell }] satisfies ColDef<QuoteListRow>[]) : []),
        { colId: 'more', headerName: t('list.col.more'), minWidth: 56, maxWidth: 56, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellClass: MORE_CELL, headerClass: MORE_CELL /* cq fx2 W-05 */, cellRenderer: MoreCell },
      ]
    }
    // ---- end F-CQ-102 / F-CQ-104
    return [
      { colId: 'picture', headerName: t('list.col.picture'), minWidth: 76, maxWidth: 76, sortable: false, suppressHeaderMenuButton: true, cellRenderer: PictureCell }, // TH-6 part B
      { colId: 'number', headerName: t('list.col.number'), field: 'number', minWidth: 130, flex: 1, cellRenderer: NumberCell, cellClass: 'fw-ql-wraps', autoHeight: true /* cq fx5 W-12 */ },
      { colId: 'customer', headerName: t('list.col.customer'), field: 'partyName', minWidth: 180, flex: 2, cellRenderer: CustomerCell, cellClass: 'fw-ql-wraps', autoHeight: true /* cq fx5 W-12 */ },
      // F-CQ-102: the chips cell keeps the column's id (`status`: its file column and the saved layouts stay); its heading says what it holds.
      { colId: 'status', headerName: t('list.col.where'), field: 'status', minWidth: 220, flex: 1.4, cellRenderer: StatusCell, autoHeight: true },
      // B-TH-257: not drawn without threads.read (no count is ever made up).
      // cq fx5 W-12: the icon header and 52–64 px, as on the customer page (W-05) — "New mes…" was cut at 116 px and its room goes to the
      // customer and the number, which wrap to a second line rather than cutting ("Seed Customer One S…", "from SEED-INQ-00…").
      ...(model.unread ? ([{ colId: 'newMessages', headerName: l('column'), headerTooltip: l('columnHint'), headerComponent: MessagesHeader, minWidth: 52, maxWidth: 64, sortable: false, valueGetter: ({ data }: { data?: QuoteListRow }) => unreadValue(data ? latest.current.model.unread?.[data.id] : undefined), cellRenderer: NewMessagesCell }] satisfies ColDef<QuoteListRow>[]) : []),
      { colId: 'units', headerName: t('list.col.units'), field: 'units', minWidth: 110, flex: 1, valueFormatter: (params) => (params.data ? t('list.units', { units: params.data.units, lines: params.data.lineCount }) : '') },
      ...(model.grains.price
        ? ([
            { colId: 'net', headerName: t('list.col.net'), field: 'netAmount', minWidth: 125, flex: 1, type: 'rightAligned', valueFormatter: (params) => (params.data ? money(params.data.netAmount, params.data.currency, locale) : '') },
            { colId: 'gross', headerName: t('list.col.gross'), field: 'grossAmount', minWidth: 110, flex: 1, type: 'rightAligned', valueFormatter: (params) => (params.data ? money(params.data.grossAmount, params.data.currency, locale) : '') },
          ] satisfies ColDef<QuoteListRow>[])
        : []),
      ...(model.grains.margin ? ([{ colId: 'margin', headerName: t('list.col.margin'), field: 'marginPct', minWidth: 150, flex: 1, cellRenderer: MarginCell }] satisfies ColDef<QuoteListRow>[]) : []),
      { colId: 'approval', headerName: t('list.col.approval'), field: 'approval', minWidth: 125, flex: 1, cellRenderer: ApprovalCell },
      { colId: 'valid', headerName: t('list.col.validUntil'), field: 'validUntil', minWidth: 130, flex: 1, cellRenderer: ValidCell },
      { colId: 'updated', headerName: t('list.col.updated'), field: 'updatedAt', minWidth: 125, flex: 1, valueFormatter: (params) => (params.value ? formatDate(params.value as string, { locale }) : '—') },
      // cq fx2 W-05 / W-12: the ⋯ whole in 56 px (no word over it), the page 32 px narrower (it scrolled 51 px at 1440).
      { colId: 'more', headerName: t('list.col.more'), minWidth: 56, maxWidth: 56, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellClass: MORE_CELL, headerClass: MORE_CELL, cellRenderer: MoreCell },
    ]
    // The cells read the words, the language and the person's grains through the closure: a change rebuilds them.
  }, [t, l, locale, model.grains.price, model.grains.margin, model.today, recordHref, model.prefix, model.unread /* B-TH-257 */, model.readsRequests, model.readsOrders, host, tier, fold, say, model.customerName /* F-CQ-102 */])

  const state = model.rows.problem === URGENT_TOO_MANY ? (
    // F-CQ-102 (B-CQ-011): more than 2,000 quotes cannot be put in urgency order: said in words, Newest first one click away.
    <EmptyState title={t('list.sort.tooManyTitle')} description={t(URGENT_TOO_MANY)} action={<Button size="sm" onClick={() => actions?.onFilters?.({ ...model.filters, sort: 'newest' })}>{os('sort.newest')}</Button>} />
  ) : model.rows.problem ? (
    <EmptyState title={t('list.failed')} description={t(model.rows.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('common.retry')}</Button>} />
  ) : shown && shown.length === 0 ? (
    filtered ? (
      <EmptyState title={t('list.noMatch.title')} description={t('list.noMatch.body')} action={<Button size="sm" onClick={() => actions?.onFilters?.(NO_FILTERS)}>{t('list.clearAll')}</Button>} />
    ) : (
      <EmptyState
        title={t('list.empty.title')}
        description={t(model.can.manage ? 'list.empty.body' : 'list.empty.bodyView')}
        action={
          model.can.manage ? (
            <Button size="sm" variant="primary" onClick={() => actions?.onNewQuote?.(true)}>
              {t('list.new')}
            </Button>
          ) : undefined
        }
      />
    )
  ) : undefined

  return (
    <div className="fw-ql">
      {/* F-SA-277: an embedding host (the customer's Quotes & incoming) draws its own title; no head, no tiles here. */}
      {!model.embedded && (
      <div className="fw-ql-head">
        <div className="fw-ql-head-text">
          <p className="fw-q-hint">{t('list.intro')}</p>
          <span className="fw-ql-count" role="status">
            {model.asOf ? t('list.updated', { time: formatTime(model.asOf, { locale }) }) : t('list.notYet')}
          </span>
        </div>
        <span className="fw-q-actions">
          {/* cq fx2 W-13 (plan §5.5): a button you may not use is hidden — no New quote without quotes.manage. */}
          {model.can.manage && (
            <Button size="sm" variant="primary" onClick={() => actions?.onNewQuote?.(true)} aria-keyshortcuts="c">
              <Plus size={14} aria-hidden /> {t('list.new')}
            </Button>
          )}
          {model.pageLinks && <QuotesPageLinks model={model.pageLinks} />}
        </span>
      </div>
      )}

      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={t(model.notice.key, model.notice.params)}
          action={
            actions?.onDismissNotice ? (
              <Button size="sm" variant="quiet" onClick={actions.onDismissNotice}>
                {t('common.dismiss')}
              </Button>
            ) : undefined
          }
        />
      )}

      {!model.embedded && (
      <MetricStrip
        metrics={QUOTE_TILES.map((tile) => {
          const count = model.tiles[tile]
          const value = count.count === null ? '—' : count.more ? t('list.tileMore', { count: count.count }) : String(count.count)
          return {
            label: t(`list.tile.${tile}`),
            value,
            hint: tile === 'accepted' && model.grains.price && count.value !== undefined && count.value !== null ? money(count.value, 'EUR', locale) : undefined,
            onClick: () => actions?.onTile?.(tile),
            active: pressed === tile,
          }
        })}
      />
      )}

      {filtered && (
        <div className="fw-ql-chips" aria-label={t('list.activeFilters')}>
          {model.filters.status && (
            <TokenChip removeLabel={t('list.removeFilter')} onRemove={() => actions?.onFilters?.({ ...model.filters, status: null, expiring: false })}>
              {t('list.chip.status', { status: t(`status.${model.filters.status}`) })}
            </TokenChip>
          )}
          {model.filters.mine && (
            <TokenChip removeLabel={t('list.removeFilter')} onRemove={() => actions?.onFilters?.({ ...model.filters, mine: false })}>
              {t('list.onlyMine')}
            </TokenChip>
          )}
          {model.filters.expiring && (
            <TokenChip removeLabel={t('list.removeFilter')} onRemove={() => actions?.onFilters?.({ ...model.filters, expiring: false })}>
              {t('list.chip.expiring')}
            </TokenChip>
          )}
          {model.filters.q.trim() && (
            <TokenChip removeLabel={t('list.removeFilter')} onRemove={() => actions?.onFilters?.({ ...model.filters, q: '' })}>
              {t('list.chip.search', { q: model.filters.q.trim() })}
            </TokenChip>
          )}
          <Button size="sm" variant="quiet" onClick={() => actions?.onFilters?.(NO_FILTERS)}>
            {t('list.clearAll')}
          </Button>
        </div>
      )}

      <ListFrame<QuoteListRow>
        listKey="sales.quotes" /* F-SA-277: its own key on any page (its export source, its saved views), never the page's guess */
        label={t('list.tableLabel')}
        rows={state ? [] : shown}
        rowId={(row) => row.id}
        columns={columns}
        count={shown ? t(model.rows.more ? 'list.countMore' : 'list.count', { count: shown.length }) : '—'}
        search={
          <Input
            size="sm"
            type="search"
            leadingIcon={<Search size={13} aria-hidden />}
            aria-label={t('list.search')}
            placeholder={t('list.search')}
            {...search.field /* F-SA-223 */}
          />
        }
        tools={
          <>
            {/* F-CQ-102 (10-design §3.3): Sort ▾ — Most urgent first (the server's order), Newest first, Valid until soonest (the loaded rows). */}
            <Select size="sm" aria-label={os('sort.label')} title={model.filters.sort === 'urgent' ? t('list.sort.ruleUrgent') : undefined} value={model.filters.sort ?? 'newest'} onChange={(event) => actions?.onFilters?.({ ...model.filters, sort: event.target.value as QuoteListSort })}>
              <option value="urgent">{t('list.sort.urgent')}</option>
              <option value="newest">{os('sort.newest')}</option>
              <option value="valid">{t('list.sort.valid')}</option>
            </Select>
            {/* F-CQ-102 (C34): State ▾ gains "Not closed" (group LIVE; the customer's tab opens on it) and, under a band door, that door's group. */}
            <Select size="sm" aria-label={t('list.statusFilter')} value={stateValue(model.filters)} onChange={(event) => actions?.onFilters?.(stateFilters(model.filters, event.target.value))}>
              {model.filters.group && model.filters.group !== 'LIVE' && model.groupLabel && <option value={`group:${model.filters.group}`}>{model.groupLabel}</option>}
              <option value="group:LIVE">{t('list.state.notClosed')}</option>
              <option value="">{t('list.allStatuses')}</option>
              {QUOTE_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {t(`status.${status}`)}
                </option>
              ))}
            </Select>
            <FilterChip pressed={model.filters.mine} onClick={() => actions?.onFilters?.({ ...model.filters, mine: !model.filters.mine })}>
              {t('list.onlyMine')}
            </FilterChip>
            {/* F-SA-224: the one customer filter of the Sales lists (`?party=`; names only). */}
            {model.switcher && (
              <CustomerSwitcher
                state={model.switcher.state}
                party={model.filters.party ?? null}
                partyName={model.switcher.partyName}
                query={model.switcher.query}
                searching={model.switcher.searching}
                onQuery={actions?.onCustomerSearch}
                onPick={(party) => actions?.onFilters?.({ ...model.filters, party })}
                recent={0}
                subject="list"
              />
            )}
          </>
        }
        selection={{
          selected,
          onChange: setSelected,
          // F-SA-225: Export N through the export job (the same writer as Export ▾, the screen's columns and the picked ids).
          exportSelected: true,
          // F-CQ-201 (10-design §6.1): the bar — 3 + More ▾, each act only with its right, held with words only by the ticked rows' state.
          actions: model.barRights ? <ManyBar bar={quoteBarOf(model.barRights, picked, model.customerName ?? (picked.length > 0 && picked.every((row) => row.partyId === picked[0]!.partyId) ? picked[0]!.partyName : null), model.replyPortal /* cq fx5 W3-2 */)} onAct={(id) => actions?.onBarAct?.(id as QuoteActKind, picked)} /> : null,
        }}
        updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
        more={model.rows.more && shown && shown.length > 0 ? { label: t('list.more'), onMore: () => actions?.onMore?.() } : null}
        keys={ownKeys}
        onHelp={() => setDialog('help')}
        onOpen={(row) => actions?.onOpen?.(row.id)}
        // F-SA-225: the rest of a row opens the quote (⌘ / Ctrl: a new tab), as on every Sales list.
        // F-SA-277: a host's row click (the customer page docks the quote's thread) when it gives one.
        onRowClick={(row, event) => (actions?.onOpenRow ? actions.onOpenRow(row.id, event.metaKey || event.ctrlKey) : event.metaKey || event.ctrlKey ? window.open(`${model.prefix}/sales/quotes/${encodeURIComponent(row.id)}`, '_blank', 'noopener') : actions?.onOpen?.(row.id))}
        state={state}
        focusRow={model.focusRow}
        // F-SA-279: on the customer page a row drives the host's dock (marked; the keys' row reported; ⌘↵ a new tab).
        active={model.active ? { id: model.active.id, onFocusRow: (row) => actions?.onFocusRow?.(row), onOpenNewTab: (row) => (actions?.onOpenRow ? actions.onOpenRow(row.id, true) : window.open(`${model.prefix}/sales/quotes/${encodeURIComponent(row.id)}`, '_blank', 'noopener')), cardDoor: model.cardDoor ? { column: 'newMessages' /* cq fx2 W-01: never on the number (the card's title) */, label: model.cardDoor, onOpen: (row) => actions?.onOpenRow?.(row.id, false) } : null /* F-CQ-104: the phone card's door to the thread */ } : null}
        // F-CQ-104 (10-design §4.6): ONE card on a phone — the picture, the number, the chips cell, the new messages, ⋯ (the room hides the rest).
        cards={host ? { fields: HOST_CARD_FIELDS } : undefined}
        // cq fx2 W-14 (10-design §3.4): a host's list says in its own foot the order's rule, the money note and what the host left out.
        foot={
          host ? (
            <>
              {model.filters.sort === 'urgent' && <span>{t('list.sort.ruleUrgent')}</span>}
              {!model.grains.price ? <span>{os('export.noteNoPrice')}</span> : !model.grains.margin && <span>{t('list.noMarginNote')}</span>}
              {model.foot}
            </>
          ) : undefined
        }
      />
      {/* F-CQ-102 (Q1-B8): without prices the money columns are left out (the words say why, never "margin" alone); without the margin, the margin. */}
      {!host && (!model.grains.price ? <p className="fw-q-hint">{os('export.noteNoPrice')}</p> : !model.grains.margin && <p className="fw-q-hint">{t('list.noMarginNote')}</p>)}

      {model.newQuote && <NewQuoteDialog model={model.newQuote} actions={actions} />}
      {model.duplicate && <DuplicateDialog model={model.duplicate} canManage={model.can.manage} actions={actions} />}
      {/* TH-6 part B (grid-F01): the picture large of the row whose Picture was opened (Esc closes it). */}
      {(() => {
        const row = viewer ? (shown ?? []).find((item) => item.id === viewer) : undefined
        return row ? (
          <PictureViewer
            source="quote"
            recordId={row.id}
            number={row.number}
            picture={row.picture ?? null}
            styleCount={row.styleCount ?? 1}
            read={actions?.readPictures}
            demo={model.demoPictures?.[row.id]}
            prefix={model.prefix}
            recordHref={recordHref(row)}
            onClose={() => setViewer(null)}
          />
        ) : null
      })()}
      {/* ---- F-CQ-201 / 202 / 204: the ONE many-acts window, Add task to N, the quote's own window on a row */}
      <ManyActDialog model={model.many ?? null} actions={actions?.many} />
      {model.tasks && (
        <TaskNewDialog
          recordLabel={null}
          people={model.tasks.people}
          me={model.me}
          onRetryPeople={() => actions?.tasks?.onRetryPeople()}
          onClose={() => actions?.tasks?.onClose()}
          batch={{
            records: model.tasks.records,
            today: model.today,
            onSend: (draft, assignee) => actions?.tasks?.onSend(draft, assignee) ?? Promise.resolve(null),
            words: { ns: 'before-order', prefix: 'tasks.quote' },
            namesOther: null,
            hrefOf: (record) => `${model.prefix}/sales/quotes/${encodeURIComponent(record.id)}?thread=open`,
            defaultAssignee: 'me',
          }}
        />
      )}
      {model.quoteDialog && <QuoteDialogs quote={model.quoteDialog.quote} model={model.quoteDialog.model} actions={actions?.quoteDialog} />}
      {/* F-CQ-304: the Orders sheet's ONE Reply-to-N window, given the quotes (their own conversations and words). */}
      {model.reply && <ReplyManyDialog model={model.reply} actions={actions?.reply} />}
      {dialog === 'help' && (
        <Modal open onClose={() => setDialog(null)} title={t('list.keysTitle')} size="sm">
          <ul className="fw-q-list">
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


/** F-CQ-104: the host's phone card — the number names it, the picture and the new messages beside it, the chips under it. */
const HOST_CARD_FIELDS = Object.freeze({ picture: { role: 'aside' as const }, number: { role: 'title' as const }, status: { role: 'subtitle' as const }, newMessages: { role: 'aside' as const } })

// ---- F-CQ-102 (C34): State ▾ — a group ("Not closed" = LIVE, a band door's group) or one state; "Every state" says null on purpose.
/** The State ▾ value of the filters: `group:<term>`, a status, or '' (every state). */
export function stateValue(filters: Pick<ListFilters, 'status' | 'group'>): string {
  if (filters.status) return filters.status
  return filters.group ? `group:${filters.group}` : ''
}

/** The filters a State ▾ choice makes: a group clears the state; a state or "Every state" clears the group (null: no host default). */
export function stateFilters(filters: ListFilters, value: string): ListFilters {
  const group = value.startsWith('group:') ? value.slice('group:'.length) : null
  if (group !== null && isQuoteGroupTerm(group)) return { ...filters, status: null, expiring: false, group }
  const status = (QUOTE_STATUSES as readonly string[]).includes(value) ? (value as QuoteStatus) : null
  return { ...filters, status, group: null, expiring: status === 'SENT' ? filters.expiring : false }
}
// ---- end F-CQ-102

/** New quote (F-CQ-104: exported, so a host whose list is folded still opens the ONE dialog — "New quote for <customer>…"). */
export function NewQuoteDialog({ model, actions }: { model: NewQuoteModel; actions?: QuotesListActions }) {
  const t = useT('sales')
  const [query, setQuery] = useState('')
  const typed = useRef(false)
  const search = useRef(actions?.onNewSearch)
  search.current = actions?.onNewSearch
  useEffect(() => {
    if (!typed.current) return
    const timer = setTimeout(() => search.current?.(query), 250)
    return () => clearTimeout(timer)
  }, [query])
  const party = model.party
  const contacts = party?.contacts.filter((contact) => contact.status === 'ACTIVE') ?? []
  const blocked = party && party.status !== 'ACTIVE' ? t('newQuote.held.party', { status: t(`partyStatus.${party.status}`) }) : null
  const noIdentity = party && !party.taxIdentities.some((identity) => identity.current) ? t('newQuote.held.identity') : null
  const fromWords = useHeldWords()
  const newFrom = model.newFrom ?? null
  const startFrom = model.startFrom ?? 'blank'
  const past = model.past ?? null
  const chosenPast = past?.results?.find((row) => row.id === past.chosenId) ?? null
  const pastHeld = newFrom?.active ? fromWords(model.newFromHeld ?? null) : startFrom === 'past' && !chosenPast ? t('newQuote.held.past') : null
  const held = !party ? t('newQuote.held.customer') : (blocked ?? noIdentity ?? pastHeld ?? (model.busy ? t('held.busy') : null))
  const create = () => {
    if (!held) actions?.onCreate?.()
  }
  // B-W2b-316: a template or inquiry start that left something out says it before the quote opens.
  if (newFrom?.done) return <NewFromDone done={newFrom.done} onOpen={(quoteId) => actions?.onPastOpen?.(quoteId)} onClose={() => actions?.onNewQuote?.(false)} />
  // B-W2a-49: a copy said what it left out — shown before the new quote opens.
  const done = past?.done ?? null
  if (done) {
    return (
      <Modal
        open
        onClose={() => actions?.onNewQuote?.(false)}
        title={t('dup.doneTitle', { number: done.number })}
        size="md"
        footer={
          <Button variant="primary" onClick={() => actions?.onPastOpen?.(done.quoteId)}>
            {t('dup.open', { number: done.number })}
          </Button>
        }
      >
        <div className="fw-q-dialog">
          <p className="fw-q-hint" role="status">
            {t('dup.doneBody', { number: done.number, source: chosenPast?.number ?? '', count: done.lines })}
          </p>
          {done.dropped.length > 0 && (
            <Banner tone="warning" title={t('dup.droppedTitle', { count: done.dropped.length })}>
              <ul className="fw-q-list">
                {done.dropped.map((item) => {
                  const words = droppedWords(item)
                  return <li key={`${item.seq}-${item.size ?? ''}`}>{t(words.key, words.params)}</li>
                })}
              </ul>
            </Banner>
          )}
          {done.warnings.map((warning) => (
            <Banner key={warning} tone="info" title={t(warningWords(warning).key)} />
          ))}
        </div>
      </Modal>
    )
  }
  return (
    <Modal
      open
      onClose={() => actions?.onNewQuote?.(false)}
      title={t('newQuote.title')}
      size="md"
      footer={
        <>
          <Button onClick={() => actions?.onNewQuote?.(false)}>{t('common.back')}</Button>
          <Button variant="primary" heldReason={held} onClick={create} aria-keyshortcuts="Meta+Enter Control+Enter">
            {startFrom === 'past' && chosenPast && !newFrom?.active ? t('newQuote.createFrom', { number: chosenPast.number }) : t('newQuote.create')}
          </Button>
        </>
      }
    >
      <div
        className="fw-q-dialog"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            create()
          }
        }}
      >
        {model.companies.length > 1 && (
          <Field label={t('newQuote.company')}>
            <Select value={model.companyId} onChange={(event) => actions?.onNewCompany?.(event.target.value)}>
              {model.companies.map((company) => (
                <option key={company.id} value={company.id}>
                  {company.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {!party ? (
          <>
            <Field label={t('newQuote.customer')} hint={t('newQuote.customerHint')}>
              <Input
                value={query}
                type="search"
                autoComplete="off"
                placeholder={t('newQuote.customerPlaceholder')}
                onChange={(event) => {
                  typed.current = true
                  setQuery(event.target.value)
                }}
              />
            </Field>
            {model.searchProblem ? (
              <Banner tone="danger" title={t(model.searchProblem)} />
            ) : (
              <fieldset className="fw-q-choices">
                <legend className="fw-q-legend" aria-live="polite">
                  {model.results === null ? t('newQuote.searching') : model.results.length === 0 ? t('newQuote.none') : t('newQuote.found', { count: model.results.length })}
                </legend>
                {model.results === null && <Spinner size={14} />}
                {(model.results ?? []).map((row) => (
                  <RadioCard
                    key={row.id}
                    variant="row"
                    name="fw-q-customer"
                    value={row.id}
                    checked={false}
                    onChange={() => actions?.onNewPick?.(row.id)}
                    title={row.legalName}
                    description={
                      <span className="fw-q-tags">
                        <span className="fw-q-hint">{[row.tradeName, row.code, row.vatNumber, row.city].filter(Boolean).join(' · ')}</span>
                        {row.status !== 'ACTIVE' && <Tag tone="danger">{t(`partyStatus.${row.status}`)}</Tag>}
                        {row.vies.state !== 'VALID' && row.taxMode === 'EU_B2B' && <Tag tone="warning">{t('newQuote.viesWarning')}</Tag>}
                      </span>
                    }
                  />
                ))}
              </fieldset>
            )}
          </>
        ) : (
          <>
            <div className="fw-q-chosen-head">
              <strong>{party.legalName}</strong>
              <Button size="sm" variant="quiet" onClick={() => actions?.onNewPick?.(null)}>
                {t('newQuote.change')}
              </Button>
            </div>
            <KeyValue
              dense
              labelCase="sentence"
              items={[
                { label: t('newQuote.code'), value: party.code },
                { label: t('newQuote.taxMode'), value: party.taxMode ? t(`taxMode.${party.taxMode}`) : '—' },
                { label: t('newQuote.vies'), value: t(`vies.${party.vies.state}`) },
              ]}
            />
            {blocked && <Banner tone="danger" title={blocked} />}
            {noIdentity && <Banner tone="danger" title={noIdentity} />}
            {party.warnings.length > 0 && <Banner tone="warning" title={t('newQuote.warnings', { count: party.warnings.length })} />}
            <Field label={t('newQuote.contact')} hint={t('newQuote.contactHint')}>
              {/* The customer list is gone once one is picked: the focus moves on to the contact, not to the page. */}
              <Select autoFocus value={model.contactId} onChange={(event) => actions?.onNewField?.('contactId', event.target.value)}>
                <option value="">{t('newQuote.contactDefault')}</option>
                {contacts.map((contact) => (
                  <option key={contact.id} value={contact.id}>
                    {contact.name}
                    {contact.email ? ` · ${contact.email}` : ` · ${t('terms.noEmail')}`}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('terms.customerRef')} hint={t('terms.customerRefHint')}>
              <Input value={model.customerRef} onChange={(event) => actions?.onNewField?.('customerRef', event.target.value)} maxLength={100} />
            </Field>
            <fieldset className="fw-q-radios">
              <legend className="fw-q-legend">{t('newQuote.startFrom')}</legend>
              {START_FROM.map((from) => (
                <RadioCard key={from} name="fw-q-start-from" value={from} checked={startFrom === from && !newFrom?.active} selected={startFrom === from && !newFrom?.active} onChange={() => actions?.onStartFrom?.(from)} title={t(`newQuote.from.${from}`)} description={t(`newQuote.fromBody.${from}`)} />
              ))}
              {newFrom && <StartFromOption kind="template" model={newFrom} onChoose={(kind) => actions?.onNewFrom?.(kind)} />}
              {newFrom && <StartFromOption kind="inquiry" model={newFrom} onChoose={(kind) => actions?.onNewFrom?.(kind)} />}
            </fieldset>
            {startFrom === 'past' && past && !newFrom?.active && <PastQuotes past={past} partyId={party.id} actions={actions} />}
            {newFrom?.active && <NewFromBody model={newFrom} companyId={model.companyId} actions={actions} />}
          </>
        )}
        <p className="fw-q-hint" role="status">
          {model.number === undefined ? t('newQuote.numberLoading') : model.number === null ? t('newQuote.numberUnknown') : t('newQuote.number', { number: model.number })}
        </p>
        {model.problem && party && <Banner tone="danger" title={t(model.problem)} />}
      </div>
    </Modal>
  )
}

/** New quote › Start from a past quote (B-W2a-49): this customer's quotes first; a number finds any quote of the company. */
function PastQuotes({ past, partyId, actions }: { past: NonNullable<NewQuoteModel['past']>; partyId: string; actions?: QuotesListActions }) {
  const t = useT('sales')
  const [query, setQuery] = useState(past.query)
  const typed = useRef(false)
  const search = useRef(actions?.onPastSearch)
  search.current = actions?.onPastSearch
  useEffect(() => {
    if (!typed.current) return
    const timer = setTimeout(() => search.current?.(query), 250)
    return () => clearTimeout(timer)
  }, [query])
  return (
    <>
      <Field label={t('newQuote.pastSearch')} hint={t('newQuote.pastHint')}>
        <Input
          value={query}
          type="search"
          autoComplete="off"
          placeholder={t('newQuote.pastPlaceholder')}
          onChange={(event) => {
            typed.current = true
            setQuery(event.target.value)
          }}
        />
      </Field>
      {past.problem ? (
        <Banner tone="danger" title={t(past.problem)} />
      ) : (
        <fieldset className="fw-q-choices">
          <legend className="fw-q-legend" aria-live="polite">
            {past.results === null ? t('newQuote.searching') : past.results.length === 0 ? t('newQuote.pastNone') : t('newQuote.pastFound', { count: past.results.length })}
          </legend>
          {past.results === null && <Spinner size={14} />}
          {(past.results ?? []).map((row) => (
            <RadioCard
              key={row.id}
              variant="row"
              name="fw-q-past"
              value={row.id}
              checked={past.chosenId === row.id}
              selected={past.chosenId === row.id}
              onChange={() => actions?.onPastPick?.(row.id)}
              title={`${row.number} · ${row.partyName}`}
              description={
                <span className="fw-q-tags">
                  <span className="fw-q-hint">{t('newQuote.pastLine', { revision: row.revision, lines: row.lineCount, units: row.units })}</span>
                  <Tag tone={STATUS_TONE[row.status]}>{t(`status.${row.status}`)}</Tag>
                  {row.partyId !== partyId && <Tag tone="info">{t('newQuote.pastOther')}</Tag>}
                </span>
              }
            />
          ))}
        </fieldset>
      )}
    </>
  )
}
