'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { FilePen, Inbox, MoreHorizontal, Plus, ShoppingCart, UserRound, X, XCircle } from 'lucide-react'
import { EmptyState, Menu, MetricStrip, type MenuItemDef } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, FilterChip, Input, Pill, Select, Tag } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../list-frame/model'
import type { LiveState } from '../../../../shell/live/use-live'
import { formatTime } from '../../../../lib/i18n/format'
// B-TH-216: the doors, the funnel and the peek card are the Orders sheet's own parts (one look for both lists).
import { DoorCell, FunnelButton, PeekCard, PeekLink } from '../../orders/list/sheet/parts'
import type { IncomingList, IncomingRow, InquiryRow, PartyOption, WaitingPage, WaitingRow } from '../api'
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
  type ListAddress,
  type Notice,
  type NoticeFacts,
  type RowVerb,
  // B-TH-233: every kind of row, Customer replies.
  CUSTOMER_REPLIES,
  INCOMING_KINDS,
  kindFacts,
  numberWithCompany,
  placeOf,
  replyHref,
  replyTypeKey,
  replyWaiting,
  rowHref,
  stateTone,
  type IncomingKind,
  type ListTile,
} from '../model'
import type { CatalogueActions, CatalogueModel } from '../catalogue-model'
import { CataloguePane } from './pane/catalogue/CataloguePane'
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
 * B-TH-233 (TH-3): Incoming over every door — requests, catalogue orders and change requests in ONE paged list (Incoming's one read,
 * each row with its kind mark, each opening in its own place: a request or a catalogue order beside the list with its thread, a change
 * request in Home › Approvals), the Kind filter, "Show more", and "Customer replies" (the one office inbox of conversations waiting
 * on us) as a saved row with its own frame.
 */
export interface InquiriesModel {
  prefix: string
  me: string
  companyId: string | null
  can: InquiriesCan
  address: ListAddress
  /** The read: null while it is read; `problem` when it failed (never drawn as an empty list). B-TH-233: Incoming's one read, every kind, the pages read so far. */
  list: IncomingList | null
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
  // ── B-TH-233 ──
  /** "Show more": another page waits (the last page's cursor), being read, or why it failed; `page` rows per read. */
  more?: { readonly next: boolean; readonly busy: boolean; readonly problem: string | null; readonly page: number }
  /** "Customer replies" (Rows ▾): the conversations waiting on us, read so far; null: not read (or no threads.read); absent: another view. */
  replies?: WaitingPage | null
  /** The built office pages (a Customer replies row opens its record's own page, else its panels). */
  built?: ReadonlySet<string> | readonly string[]
  /** The catalogue order beside the list (`?catalogue=`). */
  catalogue?: CatalogueModel | null
  // ── end B-TH-233 ──
  /** B-TH-221: New request (the portal's compose with the customer or the prospect), open on `?new=1` or `?mail=`. */
  newRequest: NewRequestModel | null
  bulk: BulkDialog | null
  /** The request open in the reading pane (`?open=`). */
  detail: InquiryRecordModel | null
  /** B-TH-217: the open request's pane — someone else handled it meanwhile, "Close thread…" open, the menu's rights. */
  pane?: { readonly handled: string | null; readonly closing: { readonly problem: string | null } | null; readonly rights: { readonly erase: boolean; readonly closeThread: boolean } } | null
  // ── B-TH-216 ──
  /** The companies the reader works in: the Company column and its funnel only from two on. B-TH-233: the code beside a number (list-F12). */
  companies?: ReadonlyArray<{ id: string; name: string; code?: string }>
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
  /** B-TH-216: a click on a row outside its doors opens it (⌘ / Ctrl: a new tab). B-TH-233: by its kind. */
  onOpenRow?: (row: IncomingRow, newTab: boolean) => void
  /** A request's verb: the request opens with that verb's dialog (Make quote, Assign, Decline) or runs it. */
  onRowVerb?: (row: IncomingRow, verb: RowVerb) => void
  /** B-TH-233: "Show more" (the next page by the cursor). */
  onMore?: () => void
  /** B-TH-233: go to an address of this office (a Customer replies row's record; ⌘: a new tab). */
  onGo?: (href: string, newTab: boolean) => void
  /** B-TH-233: the catalogue order's own acts (Accept as order / quote, Refuse). */
  catalogue?: CatalogueActions
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

/** B-TH-233: the request's slots and the catalogue order's thread. */
export type ListSlots = PaneSlots & { readonly catalogueThread?: ReactNode }

export function InquiriesView({ model, actions, slots }: { model: InquiriesModel; actions?: InquiriesActions; slots?: ListSlots }) {
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

function List({ model, actions, slots }: { model: InquiriesModel; actions?: InquiriesActions; slots?: ListSlots }) {
  const { t, say, locale, day, when } = useWords()
  const l = useT(LAST_MESSAGE_NS) // B-TH-230
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  const [search, setSearch] = useState(model.address.q)
  const [noticesOpen, setNoticesOpen] = useState(model.noticesOpen ?? false)
  const [viewer, setViewer] = useState<string | null>(model.viewer ?? null)
  const wide = useWide(model.wide)
  useEffect(() => setSearch(model.address.q), [model.address.q])
  // B-TH-233: rows of every kind; a row's key (`<kind>:<id>`) is its id in the grid and in the selection.
  const rows = model.list?.rows ?? null
  const rowsKey = rows?.map((row) => row.key).join(',') ?? ''
  useEffect(() => setSelected((current) => current.filter((key) => rowsKey.split(',').includes(key))), [rowsKey])
  const offline = model.live === 'offline'
  const latest = useRef({ model, actions })
  latest.current = { model, actions }
  const byKey = useMemo(() => new Map((rows ?? []).map((row) => [row.key, row])), [rows])
  const byId = useMemo(() => new Map((rows ?? []).map((row) => [row.id, row])), [rows])
  // B-TH-217: the open request's small preview for row 1 (the list already read it).
  const paneRow = model.address.open ? (byId.get(model.address.open)?.request ?? null) : null
  const paneSrc = useRequestPicture(paneRow ?? { id: '', picture: null }, actions?.loadPicture, paneRow ? model.demoPictures?.[paneRow.id] : undefined)
  const companies = model.companies ?? []
  const manyCompanies = companies.length > 1
  const companyName = (id: string | null) => (id ? (companies.find((entry) => entry.id === id)?.name ?? null) : null)
  const companyCode = (id: string | null) => (id ? (companies.find((entry) => entry.id === id)?.code ?? null) : null)
  const repliesView = model.address.tile === CUSTOMER_REPLIES
  // A pane is open beside the list: a request or a catalogue order (B-TH-233).
  const paneOpen = !!model.detail || !!model.catalogue

  // c: New request; q / d / a: the focused (or the one selected) request's verb — never while typing or in a dialog.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isPageKey(event) || model.newRequest || model.bulk || paneOpen) return
      if (event.key === 'c' && model.can.manage) {
        event.preventDefault()
        latest.current.actions?.onNew?.()
        return
      }
      const verb: RowVerb | null = event.key === 'q' ? 'quote' : event.key === 'd' ? 'decline' : event.key === 'a' ? 'assign' : null
      if (!verb) return
      const focused = (document.activeElement as HTMLElement | null)?.closest('[row-id]')?.getAttribute('row-id') ?? (selected.length === 1 ? selected[0] : null)
      const row = focused ? byKey.get(focused) : null
      if (row?.request && !verbHeld(row.request, verb, model.can, offline)) {
        event.preventDefault()
        latest.current.actions?.onRowVerb?.(row, verb)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [model.newRequest, model.bulk, paneOpen, model.can, offline, selected, byKey])

  const columns = useMemo<ColDef<IncomingRow>[]>(() => {
    const { model: m } = latest.current
    const act = () => latest.current.actions
    const openHref = (row: Pick<IncomingRow, 'id' | 'kind' | 'opens'>) => rowHref(m.prefix, m.address, row)
    // A door that opens the row by its kind: beside the list (the click stays on the page; ⌘-click a new tab), or Home › Approvals.
    const openLink = (row: IncomingRow, children: ReactNode, strong = false) => (
      <Link
        className={strong ? 'fw-sheet-door strong' : 'fw-sheet-door'}
        href={openHref(row)}
        title={t(placeOf(row) === 'approvals' ? 'door.approvals' : 'door.request', { number: row.number })}
        data-door=""
        onClick={(event) => {
          if (placeOf(row) === 'approvals' || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
          event.preventDefault()
          act()?.onOpen?.(row.id)
        }}
      >
        {children}
      </Link>
    )
    const verbItem = (row: IncomingRow, request: InquiryRow, verb: RowVerb, label: string): MenuItemDef => {
      const held = say(verbHeld(request, verb, m.can, offline))
      return { id: verb, label, disabled: !!held, description: held ?? undefined, onSelect: () => act()?.onRowVerb?.(row, verb) }
    }
    const customerName = (row: IncomingRow) => row.party?.name ?? row.fromWords
    const kindIcon = (kind: IncomingKind) => (kind === 'CATALOGUE_ORDER' ? <ShoppingCart size={14} aria-hidden /> : kind === 'CHANGE_REQUEST' ? <FilePen size={14} aria-hidden /> : <Inbox size={14} aria-hidden />)
    // The kind mark (list-F01): a catalogue order or a change request says its kind; a request needs none (most rows are requests).
    const kindMark = (row: IncomingRow) =>
      row.kind === 'REQUEST' ? null : (
        <Tag tone={row.kind === 'CATALOGUE_ORDER' ? 'info' : 'warning'} title={t(`kind.hint.${row.kind}`)}>
          {kindIcon(row.kind)} {t(`kind.${row.kind}`)}
        </Tag>
      )

    const PictureRender = ({ data }: ICellRendererParams<IncomingRow>) => {
      const request = data?.request ?? null
      const src = useRequestPicture(request ?? { id: '', picture: null }, latest.current.actions?.loadPicture, request ? latest.current.model.demoPictures?.[request.id] : undefined)
      if (!data) return null
      if (!request)
        return (
          <span className="fw-sheet-thumb fw-inq-thumb-none" role="img" aria-label={t(`kind.${data.kind}`)} title={t(`kind.${data.kind}`)}>
            {kindIcon(data.kind)}
          </span>
        )
      return <PictureCell row={request} src={src} t={t} filesHref={m.can.files ? recordHref(m.prefix, request.id, 'files') : null} onOpen={() => setViewer(request.id)} />
    }
    const CustomerCell = ({ data }: ICellRendererParams<IncomingRow>) => {
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
    const SubjectCell = ({ data }: ICellRendererParams<IncomingRow>) => {
      if (!data) return null
      const facts = say(kindFacts(data))
      return (
        <span className="fw-inq-subject">
          {kindMark(data)}
          {openLink(data, data.summary || t('peek.open'), true)}
          {facts && <span className="fw-inq-hint">{facts}</span>}
        </span>
      )
    }
    const FilesCell = ({ data }: ICellRendererParams<IncomingRow>) => {
      const request = data?.request
      if (!data) return null
      if (!request) return <span className="fw-inq-hint">—</span>
      const phrases = filesPhrases(request)
      if (!phrases) return <span className="fw-inq-hint">—</span>
      const words = joined(phrases, say)
      if (request.fileCounts && request.fileCounts.photos + request.fileCounts.documents === 0) return <span className="fw-inq-hint">{words}</span>
      return <DoorCell door={{ href: recordHref(m.prefix, request.id, 'files'), tip: { key: 'door.files', params: { number: request.number } } }} t={t}>{words}</DoorCell>
    }
    const QuantityCell = ({ data }: ICellRendererParams<IncomingRow>) => {
      if (!data) return null
      const sizes = data.request?.sizes ?? ''
      return (
        <span className="fw-inq-cell" title={sizes || undefined}>
          <span>{data.pieces !== null && data.pieces > 0 ? data.pieces : '—'}</span>
          {sizes && <span className="fw-inq-hint">{sizes}</span>}
        </span>
      )
    }
    const WaitingCell = ({ data }: ICellRendererParams<IncomingRow>) => (data ? <WaitingTag row={data} short /> : null)
    const StateCell = ({ data }: ICellRendererParams<IncomingRow>) => {
      if (!data) return null
      const request = data.request
      if (request) {
        const quote = request.quote
        return (
          <span className="fw-inq-row">
            <FunnelButton tip={t('funnel.state', { status: t(`status.${request.status}`) })} onClick={() => act()?.onAddress?.({ status: request.status, tile: 'ALL' })}>
              <StatusPill status={request.status} />
            </FunnelButton>
            {request.declineReason && <span className="fw-inq-hint">{t(`decline.${request.declineReason}`)}</span>}
            {quote && (m.can.quotesView ? <DoorCell door={{ href: `${m.prefix}/sales/quotes/${encodeURIComponent(quote.id)}`, tip: { key: 'door.quote', params: { number: quote.number } } }} t={t}>{quote.number}</DoorCell> : <DoorCell door={{ held: { key: 'door.quotes' } }} t={t}>{quote.number}</DoorCell>)}
          </span>
        )
      }
      // A catalogue order or a change request: its own state's words; the funnel narrows the list to its kind; what it became, or its order, a door.
      const made = data.catalogueOrder?.salesOrder ?? null
      const quote = data.catalogueOrder?.quote ?? null
      const order = data.changeRequest?.order ?? null
      return (
        <span className="fw-inq-row">
          <FunnelButton tip={t('funnel.kind', { kind: t(`kind.${data.kind}`) })} onClick={() => act()?.onAddress?.({ kind: data.kind })}>
            <Pill tone={stateTone(data)}>{data.stateWords[locale]}</Pill>
          </FunnelButton>
          {made && (m.can.ordersView ? <DoorCell door={{ href: `${m.prefix}/sales/orders/${encodeURIComponent(made.id)}`, tip: { key: 'door.order', params: { number: made.number } } }} t={t}>{made.number}</DoorCell> : <DoorCell door={{ held: { key: 'door.orders' } }} t={t}>{made.number}</DoorCell>)}
          {quote && (m.can.quotesView ? <DoorCell door={{ href: `${m.prefix}/sales/quotes/${encodeURIComponent(quote.id)}`, tip: { key: 'door.quote', params: { number: quote.number } } }} t={t}>{quote.number}</DoorCell> : <DoorCell door={{ held: { key: 'door.quotes' } }} t={t}>{quote.number}</DoorCell>)}
          {order && <DoorCell door={{ href: `${m.prefix}/sales/orders/${encodeURIComponent(order.id)}?tab=changes`, tip: { key: 'door.orderChanges', params: { number: order.number } } }} t={t}>{order.number}</DoorCell>}
        </span>
      )
    }
    const SourceCell = ({ data }: ICellRendererParams<IncomingRow>) => {
      if (!data) return null
      // A catalogue order and a change request come from the portal (the API's own words).
      const source: InquirySource = data.request?.source ?? 'PORTAL'
      return (
        <FunnelButton tip={t('funnel.source', { source: t(`source.${source}`) })} onClick={() => act()?.onAddress?.({ source })}>
          <SourceTag source={source} />
        </FunnelButton>
      )
    }
    const NumberCell = ({ data }: ICellRendererParams<IncomingRow>) => {
      if (!data) return null
      const href = openHref(data)
      // list-F12: numbers repeat per company — with more than one company the number carries its company's code (the name on hover).
      const label = numberWithCompany(data.number, companyCode(data.companyId), manyCompanies)
      return (
        <PeekLink
          href={href}
          className="fw-sheet-door fw-inq-code"
          label={t('peek.title', { number: label, customer: customerName(data) })}
          card={() => (
            <PeekCard
              title={t('peek.title', { number: label, customer: customerName(data) })}
              rows={[
                [t('peek.kind'), t(`kind.${data.kind}`)],
                [t('peek.received'), when(data.receivedAt)],
                [t('peek.source'), t(`source.${data.request?.source ?? 'PORTAL'}`)],
                [t('peek.state'), data.stateWords[locale]],
                [t('peek.quantity'), data.pieces !== null && data.pieces > 0 ? String(data.pieces) : '—'],
                [t('peek.wanted'), day(data.wantedDate)],
                ...(manyCompanies ? [[t('col.company'), companyName(data.companyId) ?? '—'] as [string, string]] : []),
              ]}
              note={data.summary || undefined}
              open={{ href, label: placeOf(data) === 'approvals' ? t('door.approvals', { number: data.number }) : t('peek.open') }}
            />
          )}
        >
          {label}
        </PeekLink>
      )
    }
    const CompanyCell = ({ data }: ICellRendererParams<IncomingRow>) => {
      if (!data) return null
      const name = companyName(data.companyId) ?? '—'
      return (
        <FunnelButton tip={t('funnel.company', { name })} onClick={() => act()?.onAddress?.({ company: data.companyId })}>
          {name}
        </FunnelButton>
      )
    }
    const MoreCell = ({ data }: ICellRendererParams<IncomingRow>) => {
      if (!data) return null
      const request = data.request
      const place = placeOf(data)
      return (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('row.menu', { number: data.number }) }}
          items={[
            place === 'approvals' ? { id: 'open', label: t('door.approvals', { number: data.number }), href: openHref(data) } : { id: 'open', label: t('row.open'), onSelect: () => act()?.onOpen?.(data.id) },
            ...(request ? [{ id: 'tab', label: t('row.openNewTab'), href: recordHref(m.prefix, request.id), target: '_blank' as const }] : []),
            ...(request && isOpen(request.status)
              ? [
                  verbItem(data, request, 'quote', t('verb.quoteKey')),
                  verbItem(data, request, 'assign', t('verb.assignKey')),
                  verbItem(data, request, 'askInfo', t('verb.askInfo')),
                  { ...verbItem(data, request, 'decline', t('verb.declineKey')), tone: 'danger' as const },
                ]
              : []),
            { id: 'copy', label: t('row.copy'), onSelect: () => act()?.onCopy?.([data.number]) },
          ]}
        />
      )
    }
    const unreadOf = (row: IncomingRow | undefined) => (row ? latest.current.model.unread?.[row.id] : undefined)
    // B-TH-217: beside the reading pane the list reads like e-mail — the picture, who and what (one cell), the state.
    if (m.detail || m.catalogue) {
      const openId = m.address.open ?? m.address.catalogue
      const RequestCell = ({ data }: ICellRendererParams<IncomingRow>) =>
        data ? (
          <span className={data.id === openId ? 'fw-inq-compact is-open' : 'fw-inq-compact'} aria-current={data.id === openId ? 'true' : undefined}>
            <span className="fw-inq-compact-who">
              {openLink(data, customerName(data), true)}
              {data.prospect && <Tag tone="info">{t('who.new')}</Tag>}
              {kindMark(data)}
            </span>
            <span className="fw-inq-hint fw-inq-compact-what">{data.summary || data.number}</span>
            {/* B-TH-230: the reader's own new messages, a door to the row with its thread at the first new one. */}
            {m.unread && (unreadOf(data)?.newCount ?? 0) > 0 && <LastMessageCell unread={unreadOf(data)} href={openHref(data)} record={data.number} />}
          </span>
        ) : null
      const CompactState = ({ data }: ICellRendererParams<IncomingRow>) =>
        data ? (
          <span className="fw-inq-cell">
            {data.request ? <StatusPill status={data.request.status} /> : <Pill tone={stateTone(data)}>{data.stateWords[locale]}</Pill>}
            {/* B-TH-230: amber by the one waiting rule (never the danger tone; the customer's wait never amber). */}
            {data.waiting.for && data.waiting.workingMinutes !== null && <span className={waitingOf(data)?.tone === 'warning' ? 'fw-inq-hint fw-inq-amber' : 'fw-inq-hint'}>{say(workingTime(data.waiting.workingMinutes))}</span>}
          </span>
        ) : null
      return [
        { colId: 'picture', headerName: t('col.picture'), minWidth: 84, maxWidth: 88, sortable: false, suppressHeaderMenuButton: true, valueGetter: (params) => params.data?.request?.picture?.styleCode ?? '', cellRenderer: PictureRender },
        { colId: 'subject', headerName: t('col.request'), minWidth: 180, flex: 1, valueGetter: (params) => (params.data ? `${customerName(params.data)} ${params.data.summary}` : ''), cellRenderer: RequestCell },
        { colId: 'status', headerName: t('col.state'), minWidth: 136, maxWidth: 170, valueGetter: (params) => params.data?.stateWords[locale] ?? '', cellRenderer: CompactState },
      ]
    }
    return [
      { colId: 'picture', headerName: t('col.picture'), minWidth: 88, maxWidth: 92, sortable: false, suppressHeaderMenuButton: true, valueGetter: (params) => params.data?.request?.picture?.styleCode ?? '', cellRenderer: PictureRender },
      { colId: 'customer', headerName: t('col.customer'), minWidth: 150, flex: 1, valueGetter: (params) => (params.data ? customerName(params.data) : ''), cellRenderer: CustomerCell },
      { colId: 'subject', headerName: t('col.subject'), minWidth: 220, flex: 1.8, valueGetter: (params) => params.data?.summary ?? '', cellRenderer: SubjectCell },
      { colId: 'files', headerName: t('col.files'), minWidth: 110, flex: 0.5, valueGetter: (params) => (params.data?.request ? joined(filesPhrases(params.data.request) ?? [], say) || '—' : '—'), cellRenderer: FilesCell },
      { colId: 'pieces', headerName: t('col.quantity'), minWidth: 100, flex: 0.5, hide: !wide, valueGetter: (params) => params.data?.pieces ?? null, cellRenderer: QuantityCell },
      { colId: 'wantedDate', headerName: t('col.wanted'), minWidth: 100, flex: 0.5, valueGetter: (params) => (params.data ? day(params.data.wantedDate) : '') },
      { colId: 'received', headerName: t('col.received'), minWidth: 150, flex: 0.6, hide: !wide, valueGetter: (params) => (params.data ? when(params.data.receivedAt) : '') },
      { colId: 'waitingHours', headerName: t('col.waiting'), minWidth: 185, flex: 0.8, valueGetter: (params) => params.data?.waiting.workingMinutes ?? null, cellRenderer: WaitingCell },
      { colId: 'owner', headerName: t('col.owner'), minWidth: 120, flex: 0.5, valueGetter: (params) => (params.data?.request ? (say(assigneePhrase(params.data.request)) ?? '') : '—') },
      { colId: 'status', headerName: t('col.state'), minWidth: 170, flex: 0.8, valueGetter: (params) => params.data?.stateWords[locale] ?? '', cellRenderer: StateCell },
      // B-TH-230 (list-F01): New messages — the reader's own, only for a reader of threads; a door to the row at the first new one.
      ...(m.unread
        ? [{ colId: 'newMessages', headerName: l('column'), headerTooltip: l('columnHint'), minWidth: 116, flex: 0.5, valueGetter: (params: { data?: IncomingRow }) => unreadValue(unreadOf(params.data)), cellRenderer: ({ data }: ICellRendererParams<IncomingRow>) => (data ? <LastMessageCell unread={unreadOf(data)} href={openHref(data)} record={data.number} /> : null) } satisfies ColDef<IncomingRow>]
        : []),
      { colId: 'source', headerName: t('col.source'), minWidth: 110, flex: 0.5, hide: !wide, valueGetter: (params) => (params.data ? t(`source.${params.data.request?.source ?? 'PORTAL'}`) : ''), cellRenderer: SourceCell },
      { colId: 'number', headerName: t('col.number'), minWidth: 150, flex: 0.6, hide: !wide, valueGetter: (params) => params.data?.number ?? '', cellRenderer: NumberCell },
      ...(manyCompanies ? [{ colId: 'company', headerName: t('col.company'), minWidth: 100, flex: 0.4, valueGetter: (params: { data?: IncomingRow }) => (params.data ? (companyName(params.data.companyId) ?? '') : ''), cellRenderer: CompanyCell } satisfies ColDef<IncomingRow>] : []),
      ...(m.can.price
        ? [
            {
              colId: 'targetPrice',
              headerName: t('col.targetPrice'),
              minWidth: 110,
              flex: 0.5,
              type: 'rightAligned',
              valueGetter: (params: { data?: IncomingRow }) => {
                const request = params.data?.request
                const price = request?.targetUnitPrice as string | null | undefined
                return request && price ? priceText(price, request.currency, INTL[locale]) : ''
              },
            } satisfies ColDef<IncomingRow>,
          ]
        : []),
      { colId: 'more', headerName: t('col.more'), minWidth: 72, maxWidth: 72, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
    // The cells read the latest model and actions through `latest`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, say, day, when, locale, model.prefix, model.can, model.address, offline, manyCompanies, companies, !!model.detail, !!model.catalogue, wide, l, model.unread /* B-TH-230 */])

  // ---- B-TH-233 (list-F14): "Customer replies" — the one office inbox of conversations waiting on us, each opening its record at the message ----
  const replyColumns = useMemo<ColDef<WaitingRow>[]>(() => {
    const built = new Set(latest.current.model.built ?? [])
    const prefix = latest.current.model.prefix
    const RecordCell = ({ data }: ICellRendererParams<WaitingRow>) => {
      if (!data) return null
      const type = replyTypeKey(data.recordType)
      return (
        <span className="fw-inq-subject">
          {type && <Tag tone="neutral">{t(type)}</Tag>}
          <Link className="fw-sheet-door strong" href={replyHref(prefix, data, built)} title={t('replies.open', { label: data.label })} data-door="">
            {data.label}
          </Link>
        </span>
      )
    }
    const MessageCell = ({ data }: ICellRendererParams<WaitingRow>) =>
      data ? (
        <span className="fw-inq-compact">
          <span className="fw-inq-compact-who">{data.lastMessage.authorName ?? data.party.name}</span>
          <span className="fw-inq-hint fw-inq-compact-what" title={data.lastMessage.excerpt}>
            {data.lastMessage.excerpt || '—'}
          </span>
        </span>
      ) : null
    const WaitCell = ({ data }: ICellRendererParams<WaitingRow>) => {
      if (!data) return null
      const wait = replyWaiting(data)
      return (
        <span title={t(wait.clock ? 'replies.waitClock' : 'replies.waitWorking', { since: when(data.waiting.since), days: data.waiting.thresholdDays })}>
          <Tag tone={wait.amber ? 'warning' : 'neutral'}>{say(wait.time)}</Tag>
        </span>
      )
    }
    return [
      { colId: 'record', headerName: t('replies.col.record'), minWidth: 180, flex: 1, valueGetter: (params) => params.data?.label ?? '', cellRenderer: RecordCell },
      { colId: 'customer', headerName: t('col.customer'), minWidth: 150, flex: 0.8, valueGetter: (params) => params.data?.party.name ?? '' },
      { colId: 'message', headerName: t('replies.col.message'), minWidth: 240, flex: 2, valueGetter: (params) => params.data?.lastMessage.excerpt ?? '', cellRenderer: MessageCell },
      { colId: 'at', headerName: t('replies.col.at'), minWidth: 150, flex: 0.6, valueGetter: (params) => (params.data ? when(params.data.lastMessage.at) : '') },
      { colId: 'waiting', headerName: t('col.waiting'), minWidth: 120, flex: 0.5, valueGetter: (params) => params.data?.waiting.workingMinutes ?? null, cellRenderer: WaitCell },
      ...(manyCompanies ? [{ colId: 'company', headerName: t('col.company'), minWidth: 100, flex: 0.4, valueGetter: (params: { data?: WaitingRow }) => (params.data ? (companyName(params.data.companyId) ?? '') : '') } satisfies ColDef<WaitingRow>] : []),
    ]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, say, when, model.prefix, model.built, manyCompanies, companies])
  // ---- end B-TH-233

  if (!model.can.view) return <NoAccess />

  const filtered = isFiltered(model.address)
  const reach = bulkReach(rows ?? [], selected)
  // B-TH-233: J / K walk the rows that open beside the list (a change request opens Home › Approvals).
  const navIds = (rows ?? []).filter((row) => placeOf(row) !== 'approvals').map((row) => row.id)
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
  ) : rows !== null && rows.length === 0 && !repliesView ? (
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
  const notices = pageNotices(model.list, new Set(model.dismissed), model.noticeFacts)
  const fromValue = model.address.prospect ? 'prospect' : (model.address.party ?? '')
  const exportWords = exportPhrases(model.address.tile, model.can)

  const tools = (
    <>
      <Select size="sm" aria-label={t('list.rows')} value={model.address.tile} onChange={(event) => actions?.onAddress?.({ tile: event.target.value as ListTile })}>
        {SAVED_ROWS.map((tile) => (
          <option key={tile} value={tile}>
            {t(`tile.${tile}`)}
          </option>
        ))}
      </Select>
      {/* B-TH-233 (list-F04): one kind of row — Requests, Catalogue orders, Change requests (a chip; kept in the address). */}
      {!repliesView && (
        <Select size="sm" aria-label={t('list.kindLabel')} value={model.address.kind ?? ''} onChange={(event) => actions?.onAddress?.({ kind: (event.target.value || null) as IncomingKind | null })}>
          <option value="">{t('list.allKinds')}</option>
          {INCOMING_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {t(`kind.plural.${kind}`)}
            </option>
          ))}
        </Select>
      )}
      {!repliesView && <Select size="sm" aria-label={t('list.sourceLabel')} value={model.address.source ?? ''} onChange={(event) => actions?.onAddress?.({ source: (event.target.value || null) as InquirySource | null })}>
        <option value="">{t('list.allSources')}</option>
        {INQUIRY_SOURCES.map((source) => (
          <option key={source} value={source}>
            {t(`source.${source}`)}
          </option>
        ))}
      </Select>}
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
  const viewerRow = viewer ? (byId.get(viewer)?.request ?? null) : null

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
          {paneOpen ? (
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
          {repliesView ? (
            // B-TH-233 (list-F14): Customer replies — conversations, not rows of Incoming's read: its own frame, each row a door to its record.
            <ListFrame<WaitingRow>
              label={t('replies.tableLabel')}
              rows={model.problem ? [] : (model.replies?.rows ?? (model.replies === null && !model.can.thread ? [] : null))}
              rowId={(row) => `${row.recordType}:${row.recordId}`}
              columns={replyColumns}
              count={model.replies ? (model.replies.complete ? t('replies.count', { count: model.replies.count }) : t('replies.countPartial', { count: model.replies.count })) : t('list.countReading')}
              tools={tools}
              // A list of conversations has no export source (the file would not be this list): no Columns ▾ / Export ▾ of its own.
              listKey={null}
              onRowClick={(row, event) => actions?.onGo?.(replyHref(model.prefix, row, new Set(model.built ?? [])), event.metaKey || event.ctrlKey)}
              onOpen={(row) => actions?.onGo?.(replyHref(model.prefix, row, new Set(model.built ?? [])), false)}
              updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
              more={model.more?.next ? { label: model.more.busy ? t('list.moreReading') : t('replies.more'), onMore: () => actions?.onMore?.(), held: model.more.busy ? t('list.moreReading') : model.more.problem ? t(model.more.problem) : offline ? t('held.offline') : null } : null}
              keys={[{ keys: ['Enter'], does: t('keys.replyOpen') }]}
              keysOpen={model.keysOpen}
              state={
                model.problem ? (
                  <EmptyState title={t('list.failed')} description={t(model.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('common.retry')}</Button>} />
                ) : !model.can.thread ? (
                  <EmptyState title={t('replies.noRight')} description={t('replies.noRightBody')} />
                ) : model.replies && model.replies.rows.length === 0 ? (
                  <EmptyState title={t('replies.empty')} description={t('replies.emptyBody')} />
                ) : undefined
              }
              cards={{ hrefOf: (row) => replyHref(model.prefix, row, new Set(model.built ?? [])) }}
            />
          ) : (
          <ListFrame<IncomingRow>
            label={t('list.tableLabel')}
            rows={state ? [] : rows}
            rowId={(row) => row.key}
            columns={columns}
            count={model.list ? (model.more?.next ? t('list.countMore', { count: rows?.length ?? 0 }) : t('list.count', { count: rows?.length ?? 0 })) : t('list.countReading')}
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
            onRowClick={(row, event) => actions?.onOpenRow?.(row, event.metaKey || event.ctrlKey)}
            // B-TH-233: "Show more" reads the next page (the list reads in pages of 200 by the API's cursor).
            more={model.more?.next ? { label: model.more.busy ? t('list.moreReading') : t('list.showMore', { count: model.more.page }), onMore: () => actions?.onMore?.(), held: model.more.busy ? t('list.moreReading') : model.more.problem ? t(model.more.problem) : offline ? t('held.offline') : null } : null}
            selection={{
              selected,
              onChange: setSelected,
              exportSelected: true,
              actions: (
                <>
                  {/* B-TH-233 (list-F11): Assign and Decline act on requests only; the other kinds of the selection are left out and said. */}
                  <span className="fw-inq-hint">{reach.others > 0 ? t('bulk.reachOthers', { open: reach.open.length, others: reach.others }) : reach.closed > 0 ? t('bulk.reachClosed', { open: reach.open.length, closed: reach.closed }) : t('bulk.reach', { count: reach.open.length })}</span>
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
            onOpen={(row) => actions?.onOpenRow?.(row, false)}
            state={state}
            withheld={model.can.price ? [] : [{ label: t('col.targetPrice'), reason: t('list.withheldPrice') }]}
            // On a phone a card opens the request's full page (B-TH-219), the list kept for Back; any other kind its own place.
            cards={{ fields: CARD_FIELDS, hrefOf: (row) => (placeOf(row) === 'request' ? fullPageHref(model.prefix, row.id, model.address) : rowHref(model.prefix, model.address, row)) }}
          />
          )}
          </div>
        }
        pane={
          model.detail ? (
            <div className="fw-inq-pane">
              <RequestPane
                model={model.detail}
                actions={actions?.record}
                slots={slots}
                nav={{ ids: navIds, onGo: (id) => actions?.onOpen?.(id) }}
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
          ) : model.catalogue ? (
            // B-TH-233 (B-TH-040, pane-actions-F13): a catalogue order beside the list, with its thread.
            <div className="fw-inq-pane">
              <CataloguePane
                model={model.catalogue}
                actions={actions?.catalogue}
                thread={slots?.catalogueThread}
                row={model.address.catalogue ? (byId.get(model.address.catalogue) ?? null) : null}
                nav={{ ids: navIds, onGo: (id) => actions?.onOpen?.(id) }}
                onClose={() => actions?.onOpen?.(null)}
                onNext={actions?.pane?.onNext}
                companyName={manyCompanies && model.address.catalogue ? companyName(byId.get(model.address.catalogue)?.companyId ?? null) : null}
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
