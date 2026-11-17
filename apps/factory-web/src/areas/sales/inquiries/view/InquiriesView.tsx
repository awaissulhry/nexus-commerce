'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { MoreHorizontal, Plus, UserRound, X, XCircle } from 'lucide-react'
import { EmptyState, Menu, MetricStrip, type MenuItemDef } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, FilterChip, Input, Select, Tag } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../list-frame/model'
import type { LiveState } from '../../../../shell/live/use-live'
import { formatTime } from '../../../../lib/i18n/format'
// B-TH-216: the doors, the funnel and the peek card are the Orders sheet's own parts (one look for both lists).
import { DoorCell, FunnelButton, PeekCard, PeekLink } from '../../orders/list/sheet/parts'
import type { InquiryList, InquiryRow, PartyOption } from '../api'
import {
  assigneePhrase,
  bandCount,
  workingTime,
  bulkReach,
  chipsOf,
  DESIGN_TILES,
  exportPhrases,
  filesPhrases,
  fullPageHref,
  HOME_ADDRESS,
  INQUIRY_SOURCES,
  isFiltered,
  isOpen,
  listHref,
  noticeKey,
  noticeLink,
  pageNotices,
  priceText,
  recordHref,
  SAVED_ROWS,
  tilePartial,
  tileValue,
  verbHeld,
  type InquiriesCan,
  type InquirySource,
  type InquiryTile,
  type ListAddress,
  type Notice,
  type NoticeFacts,
  type RowVerb,
} from '../model'
import { InquiriesMessages, isPageKey, NoAccess, NoticeLine, SourceTag, StatusPill, useWords, WaitingTag } from '../parts'
// B-TH-230: the New messages column (LastMessageCell) and the one waiting rule.
import { LAST_MESSAGE_NS, LastMessageCell } from '../../../../lib/last-message-cell/view/LastMessageCell'
import { unreadValue, type UnreadMap } from '../../../../lib/last-message-cell/model'
import { useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { waitingOf } from '../model'
import type { InquiryRecordActions, InquiryRecordModel } from '../record-model'
import { joined, PictureCell, PictureViewer, useRequestPicture, type PictureLoader } from './cells'
import { AssignDialog, DeclineDialog, type AssignModel, type DeclineModel } from './Dialogs'
import { NewRequestDialog, type NewRequestActions, type NewRequestModel } from './NewRequestDialog'
// B-TH-217: the reading pane beside the list (the 1160 px modal with its four tabs went).
import { SplitPane } from '../../../../lib/split-pane/SplitPane'
import { CloseThreadConfirm } from '../../../../lib/record-thread/popups/view/Confirms'
import { RequestPane, type PaneSlots } from './pane/RequestPane'

/** Assign to… or Decline N over a selection (all or none: the API's bulk routes). */
export type BulkDialog = { readonly kind: 'assign'; readonly ids: readonly string[]; readonly model: AssignModel } | { readonly kind: 'decline'; readonly ids: readonly string[]; readonly model: DeclineModel }

/**
 * SCR-105 — Sales › Incoming (B-TH-216, threads plan TH-1b; was Sales › Inquiries): every request of every customer on one page —
 * the band (title, the count of the Rows ▾ choice in words, as of, New request), five tiles that are saved filters, one notice at
 * most, the chips, the list in the one list frame where every cell is a door (as on the Orders sheet), bulk Assign and Decline
 * (nothing is sent), the keys in the footer's information icon, the phone cards; the request in its DetailModal, New request.
 */
export interface InquiriesModel {
  prefix: string
  me: string
  companyId: string | null
  can: InquiriesCan
  address: ListAddress
  /** The read: null while it is read; `problem` when it failed (never drawn as an empty list). */
  list: InquiryList | null
  problem: string | null
  /** The customers of the From filter (null without parties.view or not read). */
  customers: readonly PartyOption[] | null
  asOf: string | null
  live: LiveState
  /** Changes that arrived while the list was on screen ("N updates · Show"). */
  updates: number
  notice: Notice | null
  /** The notices dismissed on this device (by value). */
  dismissed: readonly string[]
  /** The rows a read brings at most (the API's limit). */
  limit: number
  /** B-TH-221: New request (the portal's compose with the customer or the prospect), open on `?new=1` or `?mail=`. */
  newRequest: NewRequestModel | null
  bulk: BulkDialog | null
  /** The request open in the reading pane (`?open=`). */
  detail: InquiryRecordModel | null
  /** B-TH-217: the open request's pane — someone else handled it meanwhile, "Close thread…" open, the menu's rights. */
  pane?: { readonly handled: string | null; readonly closing: { readonly problem: string | null } | null; readonly rights: { readonly erase: boolean; readonly closeThread: boolean } } | null
  // ── B-TH-216 ──
  /** The companies the reader works in: the Company column and its funnel only from two on. */
  companies?: ReadonlyArray<{ id: string; name: string }>
  /** What the one notice may also say: a company without request numbering, mails to sort (each read only for who may act). */
  noticeFacts?: NoticeFacts
  /** Design cases: each row's small preview by row id (no API). */
  demoPictures?: Readonly<Record<string, string>>
  /** B-TH-230: the reader's own new messages per request on the page (one read); null/absent: no threads.read, no column. */
  unread?: UnreadMap | null
  /** Design cases: the wide columns forced on (1920) or off. */
  wide?: boolean
  /** Design cases: the rows selected, the keys panel open, every notice listed, the picture of a row open. */
  selected?: readonly string[]
  keysOpen?: boolean
  noticesOpen?: boolean
  viewer?: string | null
}

export interface InquiriesActions {
  onAddress?: (patch: Partial<ListAddress>) => void
  onClearFilters?: () => void
  onRetry?: () => void
  onShowUpdates?: () => void
  onOpen?: (inquiryId: string | null) => void
  /** B-TH-216: a click on a row outside its doors opens the request (⌘ / Ctrl: its full page in a new tab). */
  onOpenRow?: (inquiryId: string, newTab: boolean) => void
  /** A row's verb: the request opens with that verb's dialog (Make quote, Assign, Decline) or runs it. */
  onRowVerb?: (row: InquiryRow, verb: RowVerb) => void
  onBulk?: (kind: 'assign' | 'decline', ids: readonly string[]) => void
  bulk?: {
    onAssign?: (assigneeId: string | null) => void
    onRetryPeople?: () => void
    onDecline?: (patch: Partial<DeclineModel['draft']>) => void
    onSubmit?: () => void
    onClose?: () => void
  }
  onNew?: () => void
  newRequest?: NewRequestActions
  record?: InquiryRecordActions
  onCopy?: (numbers: readonly string[]) => void
  onDismissNotice?: () => void
  onDismissPageNotice?: (key: string) => void
  /** B-TH-216: the Picture cell's small preview (the container reads it; the view fetches nothing). */
  loadPicture?: PictureLoader
  /** B-TH-217: the pane's own acts — the next request, an erasure request, closing the thread. */
  pane?: { onNext?: () => void; onErase?: () => void; onCloseThread?: () => void; onConfirmClose?: () => void; onCancelClose?: () => void }
}

export function InquiriesView({ model, actions, slots }: { model: InquiriesModel; actions?: InquiriesActions; slots?: PaneSlots }) {
  return (
    <InquiriesMessages>
      {/* B-TH-230: the New messages column's words */}
      <WithMessages namespaces={[LAST_MESSAGE_NS]}>
        <List model={model} actions={actions} slots={slots} />
      </WithMessages>
    </InquiriesMessages>
  )
}

const INTL = { it: 'it-IT', en: 'en-GB' } as const

/** B-TH-216: Quantity, Received, Source and Number show from 1800 px (the 1920 screen); Columns ▾ shows them anywhere. */
function useWide(forced: boolean | undefined): boolean {
  const query = '(min-width: 1800px)'
  const [wide, setWide] = useState(() => forced ?? (typeof window !== 'undefined' && !!window.matchMedia?.(query).matches))
  useEffect(() => {
    if (forced !== undefined) return setWide(forced)
    const media = window.matchMedia?.(query)
    if (!media) return
    const follow = () => setWide(media.matches)
    follow()
    media.addEventListener('change', follow)
    return () => media.removeEventListener('change', follow)
  }, [forced])
  return wide
}

/** The phone card (list-F09): picture, customer, subject, waiting, state — the same facts as the row, in its order. */
const CARD_FIELDS = Object.freeze({
  customer: { role: 'title' as const },
  subject: { role: 'subtitle' as const },
  picture: { role: 'aside' as const },
  waitingHours: { role: 'field' as const },
  status: { role: 'field' as const },
  ...Object.fromEntries(['files', 'pieces', 'wantedDate', 'received', 'owner', 'source', 'number', 'company', 'targetPrice'].map((id) => [id, { role: 'hidden' as const }])),
})

function List({ model, actions, slots }: { model: InquiriesModel; actions?: InquiriesActions; slots?: PaneSlots }) {
  const { t, say, locale, day, when } = useWords()
  const l = useT(LAST_MESSAGE_NS) // B-TH-230
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  const [search, setSearch] = useState(model.address.q)
  const [noticesOpen, setNoticesOpen] = useState(model.noticesOpen ?? false)
  const [viewer, setViewer] = useState<string | null>(model.viewer ?? null)
  const wide = useWide(model.wide)
  useEffect(() => setSearch(model.address.q), [model.address.q])
  const rows = model.list?.rows ?? null
  const rowsKey = rows?.map((row) => row.id).join(',') ?? ''
  useEffect(() => setSelected((current) => current.filter((id) => rowsKey.includes(id))), [rowsKey])
  const offline = model.live === 'offline'
  const latest = useRef({ model, actions })
  latest.current = { model, actions }
  const byId = useMemo(() => new Map((rows ?? []).map((row) => [row.id, row])), [rows])
  // B-TH-217: the open request's small preview for row 1 (the list already read it).
  const paneRow = model.address.open ? (byId.get(model.address.open) ?? null) : null
  const paneSrc = useRequestPicture(paneRow ?? { id: '', picture: null }, actions?.loadPicture, paneRow ? model.demoPictures?.[paneRow.id] : undefined)
  const companies = model.companies ?? []
  const manyCompanies = companies.length > 1
  const companyName = (id: string | null) => (id ? (companies.find((entry) => entry.id === id)?.name ?? null) : null)

  // c: New request; q / d / a: the focused (or the one selected) row's verb — never while typing or in a dialog.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isPageKey(event) || model.newRequest || model.bulk || model.detail) return
      if (event.key === 'c' && model.can.manage) {
        event.preventDefault()
        latest.current.actions?.onNew?.()
        return
      }
      const verb: RowVerb | null = event.key === 'q' ? 'quote' : event.key === 'd' ? 'decline' : event.key === 'a' ? 'assign' : null
      if (!verb) return
      const focused = (document.activeElement as HTMLElement | null)?.closest('[row-id]')?.getAttribute('row-id') ?? (selected.length === 1 ? selected[0] : null)
      const row = focused ? byId.get(focused) : null
      if (row && !verbHeld(row, verb, model.can, offline)) {
        event.preventDefault()
        latest.current.actions?.onRowVerb?.(row, verb)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [model.newRequest, model.bulk, model.detail, model.can, offline, selected, byId])

  const columns = useMemo<ColDef<InquiryRow>[]>(() => {
    const { model: m } = latest.current
    const act = () => latest.current.actions
    const openHref = (row: Pick<InquiryRow, 'id'>) => listHref(m.prefix, { ...m.address, isNew: false, mail: null, open: row.id, tab: 'request' })
    const openLink = (row: InquiryRow, children: ReactNode, strong = false) => (
      <Link
        className={strong ? 'fw-sheet-door strong' : 'fw-sheet-door'}
        href={openHref(row)}
        title={t('door.request', { number: row.number })}
        data-door=""
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
          event.preventDefault()
          act()?.onOpen?.(row.id)
        }}
      >
        {children}
      </Link>
    )
    const verbItem = (row: InquiryRow, verb: RowVerb, label: string): MenuItemDef => {
      const held = say(verbHeld(row, verb, m.can, offline))
      return { id: verb, label, disabled: !!held, description: held ?? undefined, onSelect: () => act()?.onRowVerb?.(row, verb) }
    }
    const customerName = (row: InquiryRow) => row.party?.name ?? row.fromWords

    const PictureRender = ({ data }: ICellRendererParams<InquiryRow>) => {
      const src = useRequestPicture(data ?? { id: '', picture: null }, latest.current.actions?.loadPicture, data ? latest.current.model.demoPictures?.[data.id] : undefined)
      if (!data) return null
      return <PictureCell row={data} src={src} t={t} filesHref={m.can.files ? recordHref(m.prefix, data.id, 'files') : null} onOpen={() => setViewer(data.id)} />
    }
    const CustomerCell = ({ data }: ICellRendererParams<InquiryRow>) => {
      if (!data) return null
      if (!data.party)
        return (
          <span className="fw-inq-who">
            <span className="fw-sheet-plain">{data.fromWords}</span>
            <Tag tone="info" title={t('who.newHint')}>
              {t('who.new')}
            </Tag>
          </span>
        )
      const party = data.party
      if (!m.can.parties) return <DoorCell door={{ held: { key: 'door.parties' } }} t={t}>{party.name}</DoorCell>
      const href = `${m.prefix}/sales/customers/${encodeURIComponent(party.id)}`
      return (
        <PeekLink
          href={href}
          className="fw-sheet-door"
          label={t('peek.customerTitle', { name: party.name })}
          card={() => (
            <PeekCard title={party.name} rows={[[t('peek.code'), party.code]]} note={t('peek.customerNote')} open={{ href, label: t('peek.openCustomer') }} />
          )}
        >
          {party.name}
        </PeekLink>
      )
    }
    const SubjectCell = ({ data }: ICellRendererParams<InquiryRow>) => (data ? <span className="fw-inq-subject">{openLink(data, data.summary || t('peek.open'), true)}</span> : null)
    const FilesCell = ({ data }: ICellRendererParams<InquiryRow>) => {
      if (!data) return null
      const phrases = filesPhrases(data)
      if (!phrases) return <span className="fw-inq-hint">—</span>
      const words = joined(phrases, say)
      if (data.fileCounts && data.fileCounts.photos + data.fileCounts.documents === 0) return <span className="fw-inq-hint">{words}</span>
      return <DoorCell door={{ href: recordHref(m.prefix, data.id, 'files'), tip: { key: 'door.files', params: { number: data.number } } }} t={t}>{words}</DoorCell>
    }
    const QuantityCell = ({ data }: ICellRendererParams<InquiryRow>) =>
      data ? (
        <span className="fw-inq-cell" title={data.sizes || undefined}>
          <span>{data.pieces > 0 ? data.pieces : '—'}</span>
          {data.sizes && <span className="fw-inq-hint">{data.sizes}</span>}
        </span>
      ) : null
    const WaitingCell = ({ data }: ICellRendererParams<InquiryRow>) => (data ? <WaitingTag row={data} short /> : null)
    const StateCell = ({ data }: ICellRendererParams<InquiryRow>) => {
      if (!data) return null
      const quote = data.quote
      return (
        <span className="fw-inq-row">
          <FunnelButton tip={t('funnel.state', { status: t(`status.${data.status}`) })} onClick={() => act()?.onAddress?.({ status: data.status, tile: 'ALL' })}>
            <StatusPill status={data.status} />
          </FunnelButton>
          {data.declineReason && <span className="fw-inq-hint">{t(`decline.${data.declineReason}`)}</span>}
          {quote && (m.can.quotesView ? <DoorCell door={{ href: `${m.prefix}/sales/quotes/${encodeURIComponent(quote.id)}`, tip: { key: 'door.quote', params: { number: quote.number } } }} t={t}>{quote.number}</DoorCell> : <DoorCell door={{ held: { key: 'door.quotes' } }} t={t}>{quote.number}</DoorCell>)}
        </span>
      )
    }
    const SourceCell = ({ data }: ICellRendererParams<InquiryRow>) =>
      data ? (
        <FunnelButton tip={t('funnel.source', { source: t(`source.${data.source}`) })} onClick={() => act()?.onAddress?.({ source: data.source })}>
          <SourceTag source={data.source} />
        </FunnelButton>
      ) : null
    const NumberCell = ({ data }: ICellRendererParams<InquiryRow>) => {
      if (!data) return null
      const href = openHref(data)
      return (
        <PeekLink
          href={href}
          className="fw-sheet-door fw-inq-code"
          label={t('peek.title', { number: data.number, customer: customerName(data) })}
          card={() => (
            <PeekCard
              title={t('peek.title', { number: data.number, customer: customerName(data) })}
              rows={[
                [t('peek.received'), when(data.receivedAt)],
                [t('peek.source'), t(`source.${data.source}`)],
                [t('peek.state'), t(`status.${data.status}`)],
                [t('peek.quantity'), data.pieces > 0 ? String(data.pieces) : '—'],
                [t('peek.wanted'), day(data.wantedDate)],
              ]}
              note={data.summary || undefined}
              open={{ href, label: t('peek.open') }}
            />
          )}
        >
          {data.number}
        </PeekLink>
      )
    }
    const CompanyCell = ({ data }: ICellRendererParams<InquiryRow>) => {
      if (!data) return null
      const name = companyName(data.companyId) ?? '—'
      return (
        <FunnelButton tip={t('funnel.company', { name })} onClick={() => act()?.onAddress?.({ company: data.companyId })}>
          {name}
        </FunnelButton>
      )
    }
    const MoreCell = ({ data }: ICellRendererParams<InquiryRow>) => {
      if (!data) return null
      return (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('row.menu', { number: data.number }) }}
          items={[
            { id: 'open', label: t('row.open'), onSelect: () => act()?.onOpen?.(data.id) },
            { id: 'tab', label: t('row.openNewTab'), href: recordHref(m.prefix, data.id), target: '_blank' },
            ...(isOpen(data.status)
              ? [
                  verbItem(data, 'quote', t('verb.quoteKey')),
                  verbItem(data, 'assign', t('verb.assignKey')),
                  verbItem(data, 'askInfo', t('verb.askInfo')),
                  { ...verbItem(data, 'decline', t('verb.declineKey')), tone: 'danger' as const },
                ]
              : []),
            { id: 'copy', label: t('row.copy'), onSelect: () => act()?.onCopy?.([data.number]) },
          ]}
        />
      )
    }
    // B-TH-217: beside the reading pane the list reads like e-mail — the picture, who and what (one cell), the state.
    if (m.detail) {
      const RequestCell = ({ data }: ICellRendererParams<InquiryRow>) =>
        data ? (
          <span className={data.id === m.address.open ? 'fw-inq-compact is-open' : 'fw-inq-compact'} aria-current={data.id === m.address.open ? 'true' : undefined}>
            <span className="fw-inq-compact-who">
              {openLink(data, customerName(data), true)}
              {data.prospect && <Tag tone="info">{t('who.new')}</Tag>}
            </span>
            <span className="fw-inq-hint fw-inq-compact-what">{data.summary || data.number}</span>
            {/* B-TH-230: the reader's own new messages, a door to the request with its thread at the first new one. */}
            {m.unread && (m.unread[data.id]?.newCount ?? 0) > 0 && <LastMessageCell unread={m.unread[data.id]} href={openHref(data)} record={data.number} />}
          </span>
        ) : null
      const CompactState = ({ data }: ICellRendererParams<InquiryRow>) =>
        data ? (
          <span className="fw-inq-cell">
            <StatusPill status={data.status} />
            {/* B-TH-230: amber by the one waiting rule (never the danger tone; the customer's wait never amber). */}
            {data.waiting.for && data.waiting.workingMinutes !== null && <span className={waitingOf(data)?.tone === 'warning' ? 'fw-inq-hint fw-inq-amber' : 'fw-inq-hint'}>{say(workingTime(data.waiting.workingMinutes))}</span>}
          </span>
        ) : null
      return [
        { colId: 'picture', headerName: t('col.picture'), minWidth: 84, maxWidth: 88, sortable: false, suppressHeaderMenuButton: true, valueGetter: (params) => (params.data?.picture ? params.data.picture.styleCode : ''), cellRenderer: PictureRender },
        { colId: 'subject', headerName: t('col.request'), minWidth: 180, flex: 1, valueGetter: (params) => (params.data ? `${customerName(params.data)} ${params.data.summary}` : ''), cellRenderer: RequestCell },
        { colId: 'status', headerName: t('col.state'), minWidth: 136, maxWidth: 170, valueGetter: (params) => (params.data ? t(`status.${params.data.status}`) : ''), cellRenderer: CompactState },
      ]
    }
    return [
      { colId: 'picture', headerName: t('col.picture'), minWidth: 88, maxWidth: 92, sortable: false, suppressHeaderMenuButton: true, valueGetter: (params) => (params.data?.picture ? `${params.data.picture.styleCode}` : ''), cellRenderer: PictureRender },
      { colId: 'customer', headerName: t('col.customer'), minWidth: 150, flex: 1, valueGetter: (params) => (params.data ? customerName(params.data) : ''), cellRenderer: CustomerCell },
      { colId: 'subject', headerName: t('col.subject'), minWidth: 200, flex: 1.8, valueGetter: (params) => params.data?.summary ?? '', cellRenderer: SubjectCell },
      { colId: 'files', headerName: t('col.files'), minWidth: 110, flex: 0.5, valueGetter: (params) => (params.data ? joined(filesPhrases(params.data) ?? [], say) || '—' : ''), cellRenderer: FilesCell },
      { colId: 'pieces', headerName: t('col.quantity'), minWidth: 100, flex: 0.5, hide: !wide, valueGetter: (params) => params.data?.pieces ?? null, cellRenderer: QuantityCell },
      { colId: 'wantedDate', headerName: t('col.wanted'), minWidth: 100, flex: 0.5, valueGetter: (params) => (params.data ? day(params.data.wantedDate) : '') },
      { colId: 'received', headerName: t('col.received'), minWidth: 150, flex: 0.6, hide: !wide, valueGetter: (params) => (params.data ? when(params.data.receivedAt) : '') },
      { colId: 'waitingHours', headerName: t('col.waiting'), minWidth: 185, flex: 0.8, valueGetter: (params) => params.data?.waiting.workingMinutes ?? null, cellRenderer: WaitingCell },
      { colId: 'owner', headerName: t('col.owner'), minWidth: 120, flex: 0.5, valueGetter: (params) => (params.data ? (say(assigneePhrase(params.data)) ?? '') : '') },
      { colId: 'status', headerName: t('col.state'), minWidth: 150, flex: 0.7, valueGetter: (params) => (params.data ? t(`status.${params.data.status}`) : ''), cellRenderer: StateCell },
      // B-TH-230 (list-F01): New messages — the reader's own, only for a reader of threads; a door to the request at the first new one.
      ...(m.unread
        ? [{ colId: 'newMessages', headerName: l('column'), headerTooltip: l('columnHint'), minWidth: 116, flex: 0.5, valueGetter: (params: { data?: InquiryRow }) => unreadValue(params.data ? latest.current.model.unread?.[params.data.id] : undefined), cellRenderer: ({ data }: ICellRendererParams<InquiryRow>) => (data ? <LastMessageCell unread={latest.current.model.unread?.[data.id]} href={openHref(data)} record={data.number} /> : null) } satisfies ColDef<InquiryRow>]
        : []),
      { colId: 'source', headerName: t('col.source'), minWidth: 110, flex: 0.5, hide: !wide, valueGetter: (params) => (params.data ? t(`source.${params.data.source}`) : ''), cellRenderer: SourceCell },
      { colId: 'number', headerName: t('col.number'), minWidth: 140, flex: 0.6, hide: !wide, valueGetter: (params) => params.data?.number ?? '', cellRenderer: NumberCell },
      ...(manyCompanies ? [{ colId: 'company', headerName: t('col.company'), minWidth: 100, flex: 0.4, valueGetter: (params: { data?: InquiryRow }) => (params.data ? (companyName(params.data.companyId) ?? '') : ''), cellRenderer: CompanyCell } satisfies ColDef<InquiryRow>] : []),
      ...(m.can.price
        ? [
            {
              colId: 'targetPrice',
              headerName: t('col.targetPrice'),
              minWidth: 110,
              flex: 0.5,
              type: 'rightAligned',
              valueGetter: (params: { data?: InquiryRow }) => {
                const price = params.data?.targetUnitPrice as string | null | undefined
                return params.data && price ? priceText(price, params.data.currency, INTL[locale]) : ''
              },
            } satisfies ColDef<InquiryRow>,
          ]
        : []),
      { colId: 'more', headerName: t('col.more'), minWidth: 72, maxWidth: 72, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
    // The cells read the latest model and actions through `latest`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, say, day, when, locale, model.prefix, model.can, model.address, offline, manyCompanies, companies, !!model.detail, wide, l, model.unread /* B-TH-230 */])

  if (!model.can.view) return <NoAccess />

  const filtered = isFiltered(model.address)
  const reach = bulkReach(rows ?? [], selected)
  const ownKeys: ListKey[] = [
    { keys: ['c'], does: t('keys.new') },
    { keys: ['q'], does: t('keys.quote') },
    { keys: ['a'], does: t('keys.assign') },
    { keys: ['d'], does: t('keys.decline') },
    // PR-14: the record's keys live here too (never in the request itself).
    { keys: ['j', 'k'], does: t('keys.recordWalk') },
    { keys: ['Esc'], does: t('keys.recordClose') },
  ]
  const salesHeld = say({ key: 'held.right', params: { right: 'right.sales.inquiries.manage' } })
  const newButton = (
    <Button size="sm" variant="primary" heldReason={model.can.manage ? (offline ? t('held.offline') : null) : salesHeld} onClick={() => actions?.onNew?.()} aria-keyshortcuts="c">
      <Plus size={14} aria-hidden /> {t('list.new')}
    </Button>
  )
  const state: ReactNode = model.problem ? (
    <EmptyState
      title={t('list.failed')}
      description={t(model.problem)}
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

  const partyName = model.address.party ? (model.customers?.find((party) => party.id === model.address.party)?.tradeName ?? model.customers?.find((party) => party.id === model.address.party)?.legalName ?? rows?.find((row) => row.party?.id === model.address.party)?.party?.name ?? null) : null
  const chips = chipsOf(model.address, partyName, companyName(model.address.company))
  const notices = pageNotices(model.list, model.limit, new Set(model.dismissed), model.noticeFacts)
  const fromValue = model.address.prospect ? 'prospect' : (model.address.party ?? '')
  const exportWords = exportPhrases(model.address.tile, model.limit, model.can)

  const tools = (
    <>
      <Select size="sm" aria-label={t('list.rows')} value={model.address.tile} onChange={(event) => actions?.onAddress?.({ tile: event.target.value as InquiryTile })}>
        {SAVED_ROWS.map((tile) => (
          <option key={tile} value={tile}>
            {t(`tile.${tile}`)}
          </option>
        ))}
      </Select>
      <Select size="sm" aria-label={t('list.sourceLabel')} value={model.address.source ?? ''} onChange={(event) => actions?.onAddress?.({ source: (event.target.value || null) as InquirySource | null })}>
        <option value="">{t('list.allSources')}</option>
        {INQUIRY_SOURCES.map((source) => (
          <option key={source} value={source}>
            {t(`source.${source}`)}
          </option>
        ))}
      </Select>
      <Select
        size="sm"
        aria-label={t('list.fromLabel')}
        value={fromValue}
        onChange={(event) => {
          const value = event.target.value
          actions?.onAddress?.(value === 'prospect' ? { prospect: true, party: null } : { prospect: false, party: value || null })
        }}
      >
        <option value="">{t('list.allFrom')}</option>
        <option value="prospect">{t('list.prospectsOnly')}</option>
        {(model.customers ?? []).map((party) => (
          <option key={party.id} value={party.id}>
            {party.code} · {party.tradeName ?? party.legalName}
          </option>
        ))}
      </Select>
    </>
  )

  const tile = (id: (typeof DESIGN_TILES)[number]) => ({
    label: t(`tile.${id}`),
    value: tileValue(model.list, id, !!model.problem),
    hint: model.problem ? t('tile.failed') : tilePartial(model.list, id) ? t('tile.partial') : t(`tile.hint.${id}`),
    onClick: () => actions?.onAddress?.({ tile: model.address.tile === id ? HOME_ADDRESS.tile : id }),
    active: model.address.tile === id,
  })
  const viewerRow = viewer ? (byId.get(viewer) ?? null) : null

  return (
    <div className="fw-inq">
      {/* B-TH-216 (band-F01): Incoming · 41 open · as of 10:42 — the count is the Rows ▾ choice's, in words. */}
      <div className="fw-inq-listband">
        <div className="fw-sheet-band">
          <h2 className="fw-sheet-title">{t('page.title')}</h2>
          <span className="fw-sheet-count">{say(bandCount(model.list, model.address.tile, !!model.problem))}</span>
          <span className="fw-inq-asof" role="status">
            {model.asOf ? t('band.asOf', { time: formatTime(model.asOf, { locale }) }) : t('common.notYet')}
            {' · '}
            {t(`live.${model.live}`)}
          </span>
        </div>
        <span className="fw-inq-actions">
          <Menu label={<MoreHorizontal size={16} aria-hidden />} align="right" triggerProps={{ 'aria-label': t('list.more') }} items={[{ id: 'rules', label: t('list.rulesLater'), disabled: true, description: t('list.rulesLaterHint') }]} />
          {newButton}
        </span>
      </div>
      <NoticeLine notice={model.notice} onDismiss={actions?.onDismissNotice} />
      {/* B-TH-217 (PL2): the list ~35 % and the request ~65 % beside it; nothing but the band sits above the pane. */}
      <SplitPane
        labels={{ pane: t('pane.label'), close: t('pane.back') }}
        onClose={() => actions?.onOpen?.(null)}
        list={
          <div className="fw-inq-listcol">
          {/* One notice at most (notice-F01), the most serious first; the rest behind "N more notices". */}
          {notices.length > 0 && (
            <div className="fw-inq-notices" aria-label={t('notice.label')}>
              {(noticesOpen ? notices : notices.slice(0, 1)).map((notice) => (
                <NoticeLine key={noticeKey(notice)} notice={{ ...notice, link: noticeLink(notice, model.prefix) }} onDismiss={() => actions?.onDismissPageNotice?.(noticeKey(notice))} />
              ))}
              {notices.length > 1 && (
                <Button size="sm" variant="quiet" aria-expanded={noticesOpen} onClick={() => setNoticesOpen((now) => !now)}>
                  {noticesOpen ? t('notice.fewer') : t('notice.more', { count: notices.length - 1 })}
                </Button>
              )}
            </div>
          )}
          {model.detail ? (
        // Beside the reading pane the tiles are counting chips (the same saved filters; nothing but the band sits above the pane).
        <div className="fw-inq-tilechips" role="group" aria-label={t('tile.label')}>
          {DESIGN_TILES.map((id) => (
            <FilterChip key={id} pressed={model.address.tile === id} title={t(`tile.hint.${id}`)} onClick={() => actions?.onAddress?.({ tile: model.address.tile === id ? HOME_ADDRESS.tile : id })}>
              {t(`tile.${id}`)} · {tileValue(model.list, id, !!model.problem)}
            </FilterChip>
          ))}
        </div>
      ) : (
        <MetricStrip metrics={DESIGN_TILES.map(tile)} />
      )}
          {chips.length > 0 && (
            <div className="fw-inq-chips" aria-label={t('chip.label')}>
              {chips.map((chip) => (
                <FilterChip key={chip.id} pressed onClick={() => actions?.onAddress?.(chip.clear)} aria-label={t('chip.clear', { what: say(chip.label) ?? '' })}>
                  {say(chip.label)} <X size={12} aria-hidden />
                </FilterChip>
              ))}
              {chips.length > 1 && (
                <Button size="sm" variant="quiet" onClick={() => actions?.onClearFilters?.()}>
                  {t('chip.clearAll')}
                </Button>
              )}
            </div>
          )}
          <ListFrame<InquiryRow>
            label={t('list.tableLabel')}
            rows={state ? [] : rows}
            rowId={(row) => row.id}
            columns={columns}
            count={model.list ? (rows !== null && rows.length >= model.limit ? t('list.countCapped', { count: rows.length }) : t('list.count', { count: rows?.length ?? 0 })) : t('list.countReading')}
            search={
              <Input
                size="sm"
                type="search"
                className="fw-inq-search"
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
            // PR-11: the list keeps its key after the rename (Export, saved views and Pin to Today keep working).
            listKey="sales.inquiries"
            title={t('page.title')}
            exportAbout={{ heading: say(exportWords.heading) ?? '', note: say(exportWords.note) ?? undefined }}
            onRowClick={(row, event) => actions?.onOpenRow?.(row.id, event.metaKey || event.ctrlKey)}
            selection={{
              selected,
              onChange: setSelected,
              exportSelected: true,
              actions: (
                <>
                  <span className="fw-inq-hint">{reach.closed > 0 ? t('bulk.reachClosed', { open: reach.open.length, closed: reach.closed }) : t('bulk.reach', { count: reach.open.length })}</span>
                  <Button size="sm" heldReason={!model.can.manage ? salesHeld : (say(reach.held) ?? (offline ? t('held.offline') : null))} aria-label={t('bulk.assign', { count: reach.open.length })} onClick={() => actions?.onBulk?.('assign', reach.open.map((row) => row.id))}>
                    <UserRound size={13} aria-hidden /> <SelectionLabel>{t('bulk.assign', { count: reach.open.length })}</SelectionLabel>
                  </Button>
                  <Button size="sm" variant="danger-outline" heldReason={!model.can.manage ? salesHeld : (say(reach.held) ?? (offline ? t('held.offline') : null))} aria-label={t('bulk.decline', { count: reach.open.length })} onClick={() => actions?.onBulk?.('decline', reach.open.map((row) => row.id))}>
                    <XCircle size={13} aria-hidden /> <SelectionLabel>{t('bulk.decline', { count: reach.open.length })}</SelectionLabel>
                  </Button>
                </>
              ),
            }}
            updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
            keys={ownKeys}
            keysOpen={model.keysOpen}
            onOpen={(row) => actions?.onOpen?.(row.id)}
            state={state}
            withheld={model.can.price ? [] : [{ label: t('col.targetPrice'), reason: t('list.withheldPrice') }]}
            // On a phone a card opens the request's full page (B-TH-219), the list kept for Back.
        cards={{ fields: CARD_FIELDS, hrefOf: (row) => fullPageHref(model.prefix, row.id, model.address) }}
          />
          </div>
        }
        pane={
          model.detail ? (
            <div className="fw-inq-pane">
              <RequestPane
                model={model.detail}
                actions={actions?.record}
                slots={slots}
                nav={{ ids: (rows ?? []).map((row) => row.id), onGo: (id) => actions?.onOpen?.(id) }}
                onClose={() => actions?.onOpen?.(null)}
                picture={paneRow ? (paneSrc ?? null) : null}
                companyName={manyCompanies && model.detail.loaded.status === 'ready' ? companyName(model.detail.loaded.value.companyId) : null}
                handled={model.pane?.handled ?? null}
                onNext={actions?.pane?.onNext}
                rights={model.pane?.rights}
                onErase={actions?.pane?.onErase}
                onCloseThread={actions?.pane?.onCloseThread}
                fullHref={model.address.open ? fullPageHref(model.prefix, model.address.open, model.address) : undefined}
              />
            </div>
          ) : null
        }
      />
      {viewerRow && <ViewerFor row={viewerRow} model={model} actions={actions} onClose={() => setViewer(null)} />}
      {model.newRequest && <NewRequestDialog model={model.newRequest} me={model.me} can={model.can} prefix={model.prefix} actions={actions?.newRequest} />}
      {model.bulk?.kind === 'assign' && <AssignDialog model={model.bulk.model} actions={{ onAssign: actions?.bulk?.onAssign, onRetry: actions?.bulk?.onRetryPeople, onClose: actions?.bulk?.onClose }} />}
      {model.bulk?.kind === 'decline' && <DeclineDialog model={model.bulk.model} actions={{ onDraft: actions?.bulk?.onDecline, onSubmit: actions?.bulk?.onSubmit, onClose: actions?.bulk?.onClose }} />}
      {model.detail && model.pane?.closing && model.detail.loaded.status === 'ready' && (
        <CloseThreadConfirm record={model.detail.loaded.value.number} party={model.detail.loaded.value.party?.name ?? null} problem={model.pane.closing.problem} onClose={() => actions?.pane?.onConfirmClose?.()} onCancel={() => actions?.pane?.onCancelClose?.()} />
      )}
    </div>
  )
}

/** The picture large of one row (its small preview read again from the cache). */
function ViewerFor({ row, model, actions, onClose }: { row: InquiryRow; model: InquiriesModel; actions?: InquiriesActions; onClose: () => void }) {
  const { t } = useWords()
  const src = useRequestPicture(row, actions?.loadPicture, model.demoPictures?.[row.id])
  return <PictureViewer row={row} src={src} prefix={model.prefix} requestHref={recordHref(model.prefix, row.id)} t={t} onClose={onClose} />
}
