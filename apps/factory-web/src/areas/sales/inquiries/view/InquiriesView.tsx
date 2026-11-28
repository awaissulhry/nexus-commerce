'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { ChevronDown, FilePen, Inbox, MoreHorizontal, Plus, ShoppingCart, UserRound, X, XCircle } from 'lucide-react'
import { DetailPopover, EmptyState, Menu, MetricStrip, type MenuItemDef } from '@nexus/ui/components'
import { useCardList } from '@nexus/ui/grid/card-list/index' // cq fx5 W-09: the phone (the list's cards) folds Kind and How it came
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, FilterChip, Input, Pill, Select, Tag } from '@nexus/ui/primitives'
import { Banner } from '@nexus/ui/components' // owb-of4: what bulk Confirm did
import { factsWordsOf, offersConfirm, type CatalogueConfirmed, type CatalogueFacts } from '../catalogue-facts' // owb-of4
import { ListFrame } from '../../../../list-frame/ListFrame'
import { useListSearch } from '../../../../list-frame/search/use-list-search' // F-SA-223
// F-SA-224: the one customer filter of the Sales lists.
import { CustomerSwitcher } from '../../_shared/customer-switcher/view/CustomerSwitcher'
import { localSwitcherState } from '../../_shared/customer-switcher/model'

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
  type Phrase, // B-TH-285
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
// B-TH-285: ⋯ Inquiry addresses and the band's door line.
import type { AddressesModel } from '../addresses/model'
import { AddressesDialog, type AddressesActions } from '../addresses/view/AddressesDialog'
import { InquiriesMessages, isPageKey, NoAccess, NoticeLine, SourceTag, StatusPill, useWords } from '../parts'
// B-TH-230: the New messages column (LastMessageCell) and the one waiting rule.
import { LAST_MESSAGE_NS, LastMessageCell } from '../../../../lib/last-message-cell/view/LastMessageCell'
import { unreadValue, type UnreadMap } from '../../../../lib/last-message-cell/model'
import { useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { waitingOf } from '../model'
import { THREAD_TYPE } from '../model' // F-SA-279
import type { InquiryRecordActions, InquiryRecordModel } from '../record-model'
import { joined } from './cells'
// F-SA-212: the ONE picture part (the cell with the file-kinds fallback, the pane's row 1, the picture large).
import type { ReadPictures } from '../../../../lib/record-picture/cache'
import { useRecordPicture } from '../../../../lib/record-picture/use-record-picture'
import { RecordPicture } from '../../../../lib/record-picture/view/RecordPicture'
import { PictureViewer } from '../../../../lib/record-picture/view/PictureViewer'
import { AssignDialog, DeclineDialog, type AssignModel, type DeclineModel } from './Dialogs'
import { NewRequestDialog, type NewRequestActions, type NewRequestModel } from './NewRequestDialog'
// B-TH-217: the reading pane beside the list (the 1160 px modal with its four tabs went).
import { SplitPane } from '../../../../lib/split-pane/SplitPane'
import { CloseThreadConfirm } from '../../../../lib/record-thread/popups/view/Confirms'
import { RequestPane, type PaneSlots } from './pane/RequestPane'
// B-TH-290 (list-F10): the Production column — production's answer on each request.
import { companyToday, productionCell } from '../production-answer'
// ---- F-CQ-103 / F-CQ-104 (customer page › Quotes & incoming): the chips cell, the order, the host's kinds and columns by its room
import { bulkActs, DEFAULT_TILE, incomingWhereOf, INCOMING_RANKS, type IncomingRank, type WhereChipPhrase } from '../model'
import { byRoom, datesFold, hostTier, reaches, type RoomTier } from '../../_shared/list-room'
import { WhereChips, type WhereChipWords } from '../../_shared/where-cell/view/WhereChips'
// ---- F-CQ-201 / 203 / 204 (customer page › Quotes & incoming): the bar (3 + More ▾), the ONE many-acts window, Add task to N, the
// row's own windows in place (a request's RecordDialogs, a portal order's CatalogueDialogs) on a host whose dock is the pane
import { incomingBarOf, type IncomingActKind, type IncomingBarRights } from '../bar'
import type { BulkPreview } from '../model'
import { heldRowItem, ManyActDialog, ManyBar } from '../../_shared/many-acts/view/ManyActDialog'
import { MessagesHeader, MORE_CELL } from '../../_shared/list-heads/ListHeads' // cq fx2 W-05: narrow headers whole
import type { ManyActActions, ManyActModel } from '../../_shared/many-acts/use-many-act'
import type { TaskBatchModel } from '../../_shared/many-acts/use-task-batch'
import { TaskNewDialog } from '../../../../record-panels/tasks/view/TaskNewDialog'
import { ReplyManyDialog } from '../../orders/list/view/ReplyManyDialog' // F-CQ-304
import { replyPortalHeld, type PortalState, type ReplyManyActions, type ReplyManyModel } from '../../orders/list/reply-many' // F-CQ-304; cq fx5 W3-2
import type { BatchAnswer, BatchAssignee, TaskDraft } from '../../../../record-panels/tasks/model'
import { RecordDialogs } from './pane/sections'
import { CatalogueDialogs } from './pane/catalogue/CataloguePane'

/** F-SA-224: the From switcher's choice of the requests from prospects (no customer yet), `?prospect=1`. */
const PROSPECTS = 'prospect'

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
  /** B-TH-285: ⋯ Inquiry addresses (open or not) and the band's line while the orders@ door is not open (null: nothing to say). */
  addresses?: { readonly open: boolean; readonly model: AddressesModel; readonly door: Phrase | null }
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
  // ---- F-SA-277: the host (use-inquiries-list.ts) — the customer page's Quotes & incoming draws this list under its own title
  /** The host draws what sits above the list: no band (title, as of, ⋯, New request), no tiles, no page notices. */
  embedded?: boolean
  /** 'host': no SplitPane — the page's dock is the reading pane (a row's click is the host's; Enter and a link open the row's own page). */
  paneMode?: 'own' | 'host'
  /** The customer is the host's (in every read, never cleared): no From switcher, no customer chip, not counted as a filter. */
  locked?: boolean
  // ---- end F-SA-277
  // ---- F-SA-279: the record the host's dock shows (its row marked; null: none); absent: the list drives no dock.
  active?: { readonly pick: { readonly type: string; readonly id: string } | null } | null
  // ---- end F-SA-279
  // ---- F-CQ-103 / F-CQ-104 (customer page › Quotes & incoming, 13-backend §11 rows 5–6): the host's face
  /** Some kinds only (Kind ▾ offers those; a held line says why change requests are not here). */
  kinds?: readonly IncomingKind[] | null
  /** The host's own saved row (the band's door): not counted as a filter, no chip of its own. */
  homeTile?: ListTile | null
  /** The order drawn (When it came / Most urgent first) and why Most urgent first is held (more than one page). */
  rank?: IncomingRank
  rankHeld?: Phrase | null
  /** 'host': the host's columns (Number first, no Customer column; the set by `room`). */
  columns?: 'host'
  /** The list's own room in px (the host measured it); never the window on the host. */
  room?: number | null
  /** The customer's one name on this host (the chips say it). */
  customerName?: string | null
  /** cq fx5 W3-2: the customer reads no portal ('off'): Reply held before the click, in words. Absent: not known here. */
  replyPortal?: PortalState | null
  /** The phone card's door to the row's thread (its words; with `active`). */
  cardDoor?: string | null
  // ---- end F-CQ-103 / F-CQ-104
  // ---- F-CQ-201 / 203 / 204
  /** What the bar reads of the reader (each act its OWN right); absent: today's Assign / Decline (a design case without it). */
  barRights?: IncomingBarRights
  /** The many-acts window open now (Mark N lost, Ask <customer> about N requests), or null. */
  many?: ManyActModel | null
  /** "Add task to N…" open now, or null. */
  tasks?: TaskBatchModel | null
  /** A request's own window opened from its row on a host whose dock is the pane (the request read for it), or null. */
  verb?: InquiryRecordModel | null
  /** A portal order's own window opened from its row on such a host, or null. */
  catalogueVerb?: CatalogueModel | null
  /** F-CQ-304: the Reply-to-N window over the ticked requests and portal orders. */
  reply?: ReplyManyModel | null
  /** cq fx2 W-14: what the host left out, in the list's foot (the customer's tab: the closed groups as doors). */
  foot?: ReactNode
  // ---- end F-CQ-201 / 203 / 204
  // ---- owb-of4 step 1: the Sent orders' facts (the office sheet's read) and what bulk Confirm did
  catalogueFacts?: ReadonlyMap<string, CatalogueFacts>
  catalogueConfirmed?: CatalogueConfirmed | null
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
  /** B-TH-285: the inquiry addresses' dialog. */
  addresses?: AddressesActions & { onOpen?: () => void }
  onBulk?: (kind: 'assign' | 'decline', ids: readonly string[], preview?: BulkPreview) => void
  // ---- F-CQ-201 / 203 / 204: the bar's act over the ticked rows, a portal order's own verb from its row, the windows' own actions
  onBarAct?: (kind: IncomingActKind, picked: readonly IncomingRow[]) => void
  onCatalogueVerb?: (row: IncomingRow, verb: 'order' | 'quote' | 'refuse') => void
  /** F-CQ-304: Reply to <customer> on these rows (the Orders sheet's Reply-to-N window, each record's own conversation). */
  onReply?: (rows: readonly IncomingRow[]) => void
  reply?: ReplyManyActions
  many?: ManyActActions
  tasks?: { readonly onSend: (draft: TaskDraft, assignee: BatchAssignee) => Promise<BatchAnswer | null>; readonly onRetryPeople: () => void; readonly onClose: () => void }
  // ---- end F-CQ-201 / 203 / 204
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
  /** owb-of4: the receipt of bulk Confirm, dismissed. */
  onDismissConfirmed?: () => void
  onDismissPageNotice?: (key: string) => void
  /** F-SA-212: the page's pictures in ONE batch read (the container reads it; the view fetches nothing). */
  readPictures?: ReadPictures
  /** B-TH-217: the pane's own acts — the next request, an erasure request, closing the thread. */
  pane?: { onNext?: () => void; onErase?: () => void; onCloseThread?: () => void; onConfirmClose?: () => void; onCancelClose?: () => void }
  /** F-SA-279: the keys moved the focus to a row (the host's dock follows after its rest). */
  onFocusRow?: (row: IncomingRow) => void
}

/** B-TH-233: the request's slots and the catalogue order's thread. */
export type ListSlots = PaneSlots & { readonly catalogueThread?: ReactNode }

export function InquiriesView({ model, actions, slots }: { model: InquiriesModel; actions?: InquiriesActions; slots?: ListSlots }) {
  return (
    <InquiriesMessages>
      {/* B-TH-230: the New messages column's words */}
      <WithMessages namespaces={[LAST_MESSAGE_NS, 'orders-sheet' /* owb-of4 */]}>
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

/** F-CQ-104: the host's phone card — the number (+ the subject) names it, the picture and the new messages beside it, the chips under it. */
// ---- cq fx2 W-07 (P0-B10): words by kind — a list of portal orders never says "requests" ----
/** The list's count words for the rows it holds (one kind: its own noun; requests with portal orders; any mix with change requests). */
export function countKeyOf(rows: readonly Pick<IncomingRow, 'kind'>[]): string {
  const kinds = new Set(rows.map((row) => row.kind))
  if (kinds.size <= 1) return kinds.has('CATALOGUE_ORDER') ? 'list.countPortal' : kinds.has('CHANGE_REQUEST') ? 'list.countChange' : 'list.count'
  return kinds.has('CHANGE_REQUEST') ? 'list.countAny' : 'list.countMixed'
}
/** The task window's words for its records: requests, portal orders, or both. */
export function taskWordsOf(records: readonly { readonly type: string }[]): string {
  const types = new Set(records.map((record) => record.type))
  return types.size > 1 ? 'tasks.incoming' : types.has('PortalOrderRequest') ? 'tasks.portal' : 'tasks.request'
}
// ---- end cq fx2 W-07

const HOST_CARD_FIELDS = Object.freeze({
  number: { role: 'title' as const },
  picture: { role: 'aside' as const },
  newMessages: { role: 'aside' as const },
  status: { role: 'subtitle' as const },
})

/** The phone card (list-F09): picture, customer, subject, waiting, state — the same facts as the row, in its order. */
const CARD_FIELDS = Object.freeze({
  customer: { role: 'title' as const },
  subject: { role: 'subtitle' as const },
  picture: { role: 'aside' as const },
  waitingHours: { role: 'field' as const },
  status: { role: 'field' as const },
  // B-TH-290: production's answer on the card too (the production manager judges requests on a phone as well).
  production: { role: 'field' as const },
  ...Object.fromEntries(['files', 'pieces', 'wantedDate', 'received', 'owner', 'source', 'number', 'company', 'targetPrice'].map((id) => [id, { role: 'hidden' as const }])),
})

function List({ model, actions, slots }: { model: InquiriesModel; actions?: InquiriesActions; slots?: ListSlots }) {
  const { t, say, locale, day, when } = useWords()
  const phone = useCardList() // cq fx5 W-09
  const l = useT(LAST_MESSAGE_NS) // B-TH-230
  const so = useT('orders-sheet') // owb-of4: the Sent orders' words (incoming.*)
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  // F-SA-223: the one search rule of every list (300 ms after the last key, Enter at once, Esc clears, 100 at most, follows the address).
  const search = useListSearch(model.address.q, (q) => actions?.onAddress?.({ q }))
  const [fromQuery, setFromQuery] = useState('') // F-SA-224
  const [noticesOpen, setNoticesOpen] = useState(model.noticesOpen ?? false)
  const [viewer, setViewer] = useState<string | null>(model.viewer ?? null)
  const wide = useWide(model.wide)
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
  const paneSrc = useRecordPicture({ source: 'request', recordId: paneRow?.id ?? '', picture: paneRow?.picture ?? null, styleCount: paneRow?.styleCount, read: actions?.readPictures, demo: paneRow ? model.demoPictures?.[paneRow.id] : undefined }).src // F-SA-212
  const companies = model.companies ?? []
  // cq fx2 W-16: on the customer's tab the rows decide — "· SCA" on a number and the Company column only when the list holds rows of
  // two companies (every row of one company said it on each number, and quotes never did); Sales › Incoming keeps the reader's companies.
  const manyCompanies = model.columns === 'host' ? new Set((rows ?? []).map((row) => row.companyId)).size > 1 : companies.length > 1
  const companyName = (id: string | null) => (id ? (companies.find((entry) => entry.id === id)?.name ?? null) : null)
  const companyCode = (id: string | null) => (id ? (companies.find((entry) => entry.id === id)?.code ?? null) : null)
  const repliesView = model.address.tile === CUSTOMER_REPLIES
  // A pane is open beside the list: a request or a catalogue order (B-TH-233).
  const paneOpen = !!model.detail || !!model.catalogue
  // F-SA-277: the host's dock is the pane (no SplitPane, no pane keys: c / q / a / d / j k / Esc are the page's own).
  const hostPane = model.paneMode === 'host'
  // ---- F-CQ-103 / F-CQ-104: the host's columns by its own room (never the window), the wanted day folded under 840 px.
  const tier = hostTier(model.room)
  const hostFold = model.columns === 'host' && datesFold(tier)
  // ---- end F-CQ-103 / F-CQ-104

  // c: New request; q / d / a: the focused (or the one selected) request's verb — never while typing or in a dialog.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isPageKey(event) || model.newRequest || model.bulk || paneOpen || hostPane /* F-SA-277 */) return
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
  }, [model.newRequest, model.bulk, paneOpen, hostPane, model.can, offline, selected, byKey])

  const today = companyToday() // B-TH-290
  const columns = useMemo<ColDef<IncomingRow>[]>(() => {
    const { model: m } = latest.current
    const act = () => latest.current.actions
    // F-SA-277: with the host's dock as the pane a request's door is its full page (Incoming's ⌘ rule), any other kind its own place.
    const openHref = (row: Pick<IncomingRow, 'id' | 'kind' | 'opens'>) => (m.paneMode === 'host' && placeOf(row) === 'request' ? fullPageHref(m.prefix, row.id, m.address) : rowHref(m.prefix, m.address, row))
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

    // F-SA-212: the ONE picture part at its cell size, with Incoming's file-kinds fallback (a request that names no style); a
    // catalogue order or a change request says its kind in the part's placeholder square.
    // F-CP-107 (cp-fx14): the picture part's own class family `fw-rpic` (the reading pane keeps `fw-rp`).
    const PictureRender = ({ data }: ICellRendererParams<IncomingRow>) => {
      const request = data?.request ?? null
      if (!data) return null
      // F-CQ-103 (B-CQ-030): a portal order names a garment — its first style's picture (the batch read names it), never a cart icon.
      if (data.kind === 'CATALOGUE_ORDER')
        return (
          <RecordPicture
            source="portalOrder"
            recordId={data.id}
            number={data.number}
            size="cell"
            read={latest.current.actions?.readPictures}
            demo={latest.current.model.demoPictures?.[data.id]}
          />
        )
      if (!request)
        return (
          <span className="fw-rpic fw-rpic-cell fw-rpic-none" role="img" aria-label={t(`kind.${data.kind}`)} title={t(`kind.${data.kind}`)}>
            {kindIcon(data.kind)}
          </span>
        )
      const files = m.can.files && request.fileCounts ? { ...request.fileCounts, href: recordHref(m.prefix, request.id, 'files') } : null
      return (
        <RecordPicture
          source="request"
          recordId={request.id}
          number={request.number}
          picture={request.picture ?? null}
          styleCount={request.styleCount ?? 1}
          size="cell"
          fallback={files}
          read={latest.current.actions?.readPictures}
          demo={latest.current.model.demoPictures?.[request.id]}
          onOpen={() => setViewer(request.id)}
        />
      )
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
      // owb-of4 step 1: a Sent order's own facts (the office sheet's read) and its ONE door, Confirm the order… (today's Accept as order window).
      const sent = data.kind === 'CATALOGUE_ORDER' && data.catalogueOrder?.status === 'SENT' ? (m.catalogueFacts?.get(data.id) ?? null) : null
      const sentWords = sent ? factsWordsOf(sent, so) : null
      return (
        <span className="fw-inq-subject">
          {kindMark(data)}
          {openLink(data, data.summary || t('peek.open'), true)}
          {facts && <span className="fw-inq-hint">{facts}</span>}
          {sent && (
            <span className="fw-inq-sent">
              {sentWords && <span className={sent.sentAsText ? 'fw-inq-sent-text' : 'fw-inq-hint'}>{sentWords}</span>}
              {sent.customerOnHold && (
                <Tag tone="warning" title={so('incoming.onHoldHint')}>
                  {so('incoming.onHold')}
                </Tag>
              )}
              {offersConfirm(data, sent, m.can.orders) && (
                <Button size="sm" variant="primary" className="fw-inq-confirm" heldReason={offline ? t('held.offline') : null} onClick={() => act()?.onCatalogueVerb?.(data, 'order')}>
                  {so('incoming.confirm')}
                </Button>
              )}
            </span>
          )}
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
    // F-CQ-103 fix: the chips cell's facts the file writes as their own columns (the export source's `waitingHours`, `production`).
    const whereExport = [
      { key: 'waitingHours', label: t('col.waiting') },
      { key: 'production', label: t('production.col') },
    ]
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
    // ---- F-CQ-103 (10-design §4.3; C6, C29, C33): the ONE chips cell "Where it is" — the state and who it waits on with its working
    // time (amber past one working day), production's answer, what the customer reads in its portal; what it became opens (with that
    // record's right). Under 840 px of the host's room the wanted day folds here. No amount, no person.
    const WhereCell = ({ data }: ICellRendererParams<IncomingRow>) => {
      if (!data) return null
      const mm = latest.current.model
      const cell = incomingWhereOf(data, mm.customerName ?? customerName(data), data.request ? productionCell(data.request.production, today) : null)
      const chips: WhereChipWords[] = cell.chips.map((chip) => ({ words: chipWords(chip), tone: chip.tone, look: chip.look, href: doorOf(chip), title: chip.door ? t(chip.door.kind === 'quote' ? 'door.quote' : 'door.order', { number: chip.door.number }) : null }))
      const fold = hostFold && data.wantedDate ? t('where.foldWanted', { date: day(data.wantedDate) }) : null
      const quiet = [cell.styles > 0 ? t('where.styles', { count: cell.styles }) : '', cell.pieces !== null && cell.pieces > 0 ? t('where.pieces', { count: cell.pieces }) : ''].filter(Boolean).join(' · ')
      return <WhereChips chips={chips} fold={fold} quiet={quiet || null} />
    }
    const chipWords = (chip: WhereChipPhrase): string => {
      const nested = Object.fromEntries(Object.entries(chip.nested ?? {}).map(([name, phrase]) => [name, say(phrase) ?? '']))
      const own = Object.fromEntries(Object.entries(chip.own ?? {}).map(([name, words]) => [name, words[locale]]))
      // cq fx2 W-11: a change request's own state words already start with its kind ("Change request · Accepted"): said once, never
      // "Change request · Change request · Accepted".
      if (chip.key === 'where.kindState' && typeof chip.params?.kind === 'string' && own.state && own.state.toLowerCase().startsWith(t(chip.params.kind).toLowerCase())) return own.state
      return say({ key: chip.key, params: { ...chip.params, ...nested, ...own } }) ?? ''
    }
    const doorOf = (chip: WhereChipPhrase): string | null => {
      if (!chip.door) return null
      if (chip.door.kind === 'quote') return m.can.quotesView ? `${m.prefix}/sales/quotes/${encodeURIComponent(chip.door.id)}` : null
      return m.can.ordersView ? `${m.prefix}/sales/orders/${encodeURIComponent(chip.door.id)}` : null
    }
    // F-CQ-103 (Q2-B5): on the host the number comes first, the subject quiet under it (two lines at most; the whole on hover).
    const HostNumberCell = ({ data }: ICellRendererParams<IncomingRow>) => {
      if (!data) return null
      const label = numberWithCompany(data.number, companyCode(data.companyId), manyCompanies)
      return (
        <span className="fw-inq-subject">
          {openLink(data, label, true)}
          {data.summary && (
            <span className="fw-inq-hint fw-where-sub" title={data.summary}>
              {data.summary}
            </span>
          )}
        </span>
      )
    }
    // ---- end F-CQ-103
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
            // F-CQ-103 (P0-B7): the change request's door (that request, `&open=`) only for a reader who answers it (orders.manage).
            ...(place === 'approvals' ? (m.can.orders ? [{ id: 'open', label: t('door.approvals', { number: data.number }), href: openHref(data) }] : []) : [{ id: 'open', label: t('row.open'), onSelect: () => act()?.onOpen?.(data.id) }]),
            ...(request ? [{ id: 'tab', label: t('row.openNewTab'), href: recordHref(m.prefix, request.id), target: '_blank' as const }] : []),
            // F-CQ-204 (10-design §7): the request's next steps, each only with its right (never held for it), held by its state in words;
            // no key letter in a label (the keys live in the ⓘ).
            ...(request && isOpen(request.status) && m.can.manage
              ? [
                  ...(m.can.quotes ? [verbItem(data, request, 'quote', `${t('verb.quote')}…`)] : []),
                  ...(m.can.orders ? [verbItem(data, request, 'order', t('row.makeOrder'))] : []),
                  verbItem(data, request, 'assign', t('row.assign')),
                  ...(request.status !== 'NEED_INFO' ? [verbItem(data, request, 'askInfo', `${t('verb.askInfo')}…`)] : []),
                  { ...verbItem(data, request, 'decline', t('row.decline')), tone: 'danger' as const },
                  verbItem(data, request, 'lost', t('verb.lost')),
                ]
              : []),
            // F-CQ-204: a portal order sent: Accept as order / as quote, Refuse — its own window (orders.manage; as a quote + quotes.manage).
            ...(data.kind === 'CATALOGUE_ORDER' && data.catalogueOrder?.status === 'SENT' && m.can.orders
              ? [
                  { id: 'acceptOrder', label: `${t('catalogue.acceptOrder')}…`, onSelect: () => act()?.onCatalogueVerb?.(data, 'order') },
                  ...(m.can.quotes ? [{ id: 'acceptQuote', label: `${t('catalogue.acceptQuote')}…`, onSelect: () => act()?.onCatalogueVerb?.(data, 'quote') }] : []),
                  { id: 'refuse', label: `${t('catalogue.refuse')}…`, tone: 'danger' as const, onSelect: () => act()?.onCatalogueVerb?.(data, 'refuse') },
                ]
              : []),
            // F-CQ-304: Reply to <customer>… on this one request or portal order (threads.post; a prospect's row has no customer to reply to).
            ...(m.barRights?.threads && data.kind !== 'CHANGE_REQUEST' && data.party ? [heldRowItem('reply', t('row.reply', { customer: m.customerName ?? data.party.name }), replyPortalHeld(m.replyPortal, 'Inquiry', m.customerName ?? data.party.name) /* cq fx5 W3-2 */, () => act()?.onReply?.([data]))] : []),
            ...(m.barRights?.tasks && data.kind !== 'CHANGE_REQUEST' ? [{ id: 'addTask', label: t('row.addTask'), onSelect: () => act()?.onRowVerb?.(data, 'addTask') }] : []),
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
        { colId: 'picture', headerName: t('col.picture'), minWidth: 76, maxWidth: 76 /* F-SA-212: one width */, sortable: false, suppressHeaderMenuButton: true, valueGetter: (params) => params.data?.request?.picture?.styleCode ?? '', cellRenderer: PictureRender },
        { colId: 'subject', headerName: t('col.request'), minWidth: 180, flex: 1, valueGetter: (params) => (params.data ? `${customerName(params.data)} ${params.data.summary}` : ''), cellRenderer: RequestCell },
        { colId: 'status', headerName: t('col.state'), minWidth: 136, maxWidth: 170, valueGetter: (params) => params.data?.stateWords[locale] ?? '', cellRenderer: CompactState },
      ]
    }
    // ---- F-CQ-103 / F-CQ-104 (10-design §4.1; C27): the host's columns by the list's OWN room — Number first (+ the subject), no
    // Customer column; M− 720–839 the base row (the wanted day folds under the chips) · M + Wanted · L + Received, Owner, Pieces (+ Target
    // price with the price grain; Company from two companies) · XL + Source, Files. A column the room leaves out is hidden and an opt-in
    // choice in Customise ("… (from a wider list)"): "In view" counts only what is shown (P0-B5). The ⋯ column stays last.
    if (m.columns === 'host') {
      const wider = (column: ColDef<IncomingRow>, wanted: RoomTier) => byRoom(column, reaches(tier, wanted), t('col.wider', { label: String(column.headerName ?? '') }))
      return [
        { colId: 'picture', headerName: t('col.picture'), minWidth: 76, maxWidth: 76 /* F-SA-212: one width */, sortable: false, suppressHeaderMenuButton: true, valueGetter: (params) => params.data?.request?.picture?.styleCode ?? '', cellRenderer: PictureRender },
        { colId: 'number', headerName: t('col.number'), minWidth: 160, maxWidth: 220, flex: 0, valueGetter: (params) => params.data?.number ?? '', cellRenderer: HostNumberCell, autoHeight: true },
        { colId: 'status', headerName: t('col.where'), minWidth: 220, flex: 2, valueGetter: (params) => params.data?.stateWords[locale] ?? '', cellRenderer: WhereCell, autoHeight: true, context: { exportWith: whereExport } },
        wider({ colId: 'wantedDate', headerName: t('col.wanted'), minWidth: 110, maxWidth: 130, valueGetter: (params) => (params.data ? day(params.data.wantedDate) : '') }, 'M'),
        wider({ colId: 'received', headerName: t('col.received'), minWidth: 104, maxWidth: 150, valueGetter: (params) => (params.data ? when(params.data.receivedAt) : '') }, 'L'),
        wider({ colId: 'owner', headerName: t('col.owner'), minWidth: 120, maxWidth: 150, valueGetter: (params) => (params.data?.request ? (say(assigneePhrase(params.data.request)) ?? '') : '—') }, 'L'),
        wider({ colId: 'pieces', headerName: t('col.quantity'), minWidth: 96, maxWidth: 120, valueGetter: (params) => params.data?.pieces ?? null, cellRenderer: QuantityCell }, 'L'),
        ...(m.can.price ? [wider({ colId: 'targetPrice', headerName: t('col.targetPrice'), minWidth: 120, maxWidth: 140, type: 'rightAligned', valueGetter: (params: { data?: IncomingRow }) => { const request = params.data?.request; const price = request?.targetUnitPrice as string | null | undefined; return request && price ? priceText(price, request.currency, INTL[locale]) : '' } }, 'L')] : []),
        // cq fx2 W-17: Company from XL (at L it pushed the row 37 px past 1314: L fits 1200–1599 px whole).
        ...(manyCompanies ? [wider({ colId: 'company', headerName: t('col.company'), minWidth: 100, maxWidth: 140, valueGetter: (params: { data?: IncomingRow }) => (params.data ? (companyName(params.data.companyId) ?? '') : ''), cellRenderer: CompanyCell }, 'XL')] : []),
        wider({ colId: 'source', headerName: t('col.source'), minWidth: 110, maxWidth: 130, valueGetter: (params) => (params.data ? t(`source.${params.data.request?.source ?? 'PORTAL'}`) : ''), cellRenderer: SourceCell }, 'XL'),
        wider({ colId: 'files', headerName: t('col.files'), minWidth: 110, maxWidth: 140, valueGetter: (params) => (params.data?.request ? joined(filesPhrases(params.data.request) ?? [], say) || '—' : '—'), cellRenderer: FilesCell }, 'XL'),
        ...(m.unread
          ? [{ colId: 'newMessages', headerName: l('column'), headerTooltip: l('columnHint'), headerComponent: MessagesHeader /* cq fx2 W-05 */, minWidth: 52, maxWidth: 64, valueGetter: (params: { data?: IncomingRow }) => unreadValue(unreadOf(params.data)), cellRenderer: ({ data }: ICellRendererParams<IncomingRow>) => (data ? <LastMessageCell unread={unreadOf(data)} href={openHref(data)} record={data.number} /> : null) } satisfies ColDef<IncomingRow>]
          : []),
        { colId: 'more', headerName: t('col.more'), minWidth: 56, maxWidth: 56, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellClass: MORE_CELL, headerClass: MORE_CELL /* cq fx2 W-05 */, cellRenderer: MoreCell },
      ]
    }
    // ---- end F-CQ-103 / F-CQ-104
    return [
      { colId: 'picture', headerName: t('col.picture'), minWidth: 76, maxWidth: 76 /* F-SA-212: one width */, sortable: false, suppressHeaderMenuButton: true, valueGetter: (params) => params.data?.request?.picture?.styleCode ?? '', cellRenderer: PictureRender },
      // cq fx5 W-12: Sales › Incoming at 1440 — the customer and the subject wrap to at most two lines (the row grows) instead of cutting.
      { colId: 'customer', headerName: t('col.customer'), minWidth: 150, flex: 1, valueGetter: (params) => (params.data ? customerName(params.data) : ''), cellRenderer: CustomerCell, cellClass: 'fw-inq-wraps', autoHeight: true },
      { colId: 'subject', headerName: t('col.subject'), minWidth: 220, flex: 1.8, valueGetter: (params) => params.data?.summary ?? '', cellRenderer: SubjectCell, cellClass: 'fw-inq-wraps', autoHeight: true },
      { colId: 'files', headerName: t('col.files'), minWidth: 110, flex: 0.5, valueGetter: (params) => (params.data?.request ? joined(filesPhrases(params.data.request) ?? [], say) || '—' : '—'), cellRenderer: FilesCell },
      { colId: 'pieces', headerName: t('col.quantity'), minWidth: 100, flex: 0.5, hide: !wide, valueGetter: (params) => params.data?.pieces ?? null, cellRenderer: QuantityCell },
      { colId: 'wantedDate', headerName: t('col.wanted'), minWidth: 112 /* cq fx5 W-12: a whole date (100 cut one) */, flex: 0.5, valueGetter: (params) => (params.data ? day(params.data.wantedDate) : '') },
      { colId: 'received', headerName: t('col.received'), minWidth: 150, flex: 0.6, hide: !wide, valueGetter: (params) => (params.data ? when(params.data.receivedAt) : '') },
      { colId: 'owner', headerName: t('col.owner'), minWidth: 120, flex: 0.5, valueGetter: (params) => (params.data?.request ? (say(assigneePhrase(params.data.request)) ?? '') : '—') },
      // F-CQ-103: the ONE chips cell keeps the column's id (`status`: its file column and the saved layouts stay); the State column with
      // its funnel stays a Customise choice.
      // F-CQ-103 fix (lead decision on W1): Waiting and Production live inside the chips cell — and the file keeps both as their own
      // columns by default (screen = file: they ARE on screen, in the chips), never lost.
      { colId: 'status', headerName: t('col.where'), minWidth: 220, flex: 1.2, valueGetter: (params) => params.data?.stateWords[locale] ?? '', cellRenderer: WhereCell, autoHeight: true, context: { exportWith: whereExport } },
      byRoom({ colId: 'stateFunnel', headerName: t('col.state'), minWidth: 170, flex: 0.8, valueGetter: (params) => params.data?.stateWords[locale] ?? '', cellRenderer: StateCell }, false),
      // B-TH-230 (list-F01): New messages — the reader's own, only for a reader of threads; a door to the row at the first new one.
      ...(m.unread
        ? [{ colId: 'newMessages', headerName: l('column'), headerTooltip: l('columnHint'), headerComponent: MessagesHeader /* cq fx5 W-12: the icon header ("New mes…" was cut) */, minWidth: 52, maxWidth: 64, valueGetter: (params: { data?: IncomingRow }) => unreadValue(unreadOf(params.data)), cellRenderer: ({ data }: ICellRendererParams<IncomingRow>) => (data ? <LastMessageCell unread={unreadOf(data)} href={openHref(data)} record={data.number} /> : null) } satisfies ColDef<IncomingRow>]
        : []),
      { colId: 'source', headerName: t('col.source'), minWidth: 110, flex: 0.5, hide: !wide, valueGetter: (params) => (params.data ? t(`source.${params.data.request?.source ?? 'PORTAL'}`) : ''), cellRenderer: SourceCell },
      { colId: 'number', headerName: t('col.number'), minWidth: 150, flex: 0.6, hide: !wide, valueGetter: (params) => params.data?.number ?? '', cellRenderer: NumberCell },
      ...(manyCompanies ? [{ colId: 'company', headerName: t('col.company'), minWidth: 120 /* cq fx5 W-12: "Company" whole ("Comp…" at 100) */, flex: 0.4, valueGetter: (params: { data?: IncomingRow }) => (params.data ? (companyName(params.data.companyId) ?? '') : ''), cellRenderer: CompanyCell } satisfies ColDef<IncomingRow>] : []),
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
      // cq fx2 W-05 / W-12: the ⋯ whole in 56 px (no word over it), the page 16 px narrower (it scrolled 15 px at 1440).
      { colId: 'more', headerName: t('col.more'), minWidth: 56, maxWidth: 56, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellClass: MORE_CELL, headerClass: MORE_CELL, cellRenderer: MoreCell },
    ]
    // The cells read the latest model and actions through `latest`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, say, day, when, locale, model.prefix, model.can, model.address, offline, manyCompanies, companies, !!model.detail, !!model.catalogue, wide, l, model.unread /* B-TH-230 */, today /* B-TH-290 */, model.paneMode /* F-SA-277 */, model.columns, tier, hostFold, model.customerName /* F-CQ-103 */, model.catalogueFacts, so /* owb-of4 */])

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

  // F-SA-277: a locked customer is the host's — never a filter of the list (no chip, no "Clear filters" for it).
  const narrowing = model.locked ? { ...model.address, party: null } : model.address
  // F-CQ-103: the host's own saved row (the band's door) is the host's, never a filter of the list (no chip, no "Clear filters" for it).
  const narrowed = model.homeTile && narrowing.tile === model.homeTile ? { ...narrowing, tile: DEFAULT_TILE } : narrowing
  const filtered = isFiltered(narrowed)
  const reach = bulkReach(rows ?? [], selected)
  // B-TH-233: J / K walk the rows that open beside the list (a change request opens Home › Approvals).
  const navIds = (rows ?? []).filter((row) => placeOf(row) !== 'approvals').map((row) => row.id)
  // F-SA-277: with the host's dock as the pane, the keys are the frame's own (the pane's and New request's are not this page's).
  const ownKeys: ListKey[] = hostPane ? [] : [
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
    <Button size="sm" variant="primary" heldReason={offline ? t('held.offline') : null} onClick={() => actions?.onNew?.()} aria-keyshortcuts="c">
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
  const chips = chipsOf(narrowed /* F-SA-277; F-CQ-103 */, partyName, companyName(model.address.company))
  const notices: ReturnType<typeof pageNotices> = model.embedded ? [] : pageNotices(model.list, new Set(model.dismissed), model.noticeFacts) // F-SA-277: the page's notices are Incoming's own
  // F-SA-224: the From switcher's own search (in the customers read) and the chosen customer.
  const fromCustomer = model.address.party ? ((model.customers ?? []).find((party) => party.id === model.address.party) ?? null) : null
  const exportWords = exportPhrases(model.address.tile, model.can)

  // ---- cq fx5 W-09: Kind and How it came, drawn inline or (on a phone) in More ▾.
  const kindTool = (
    <Select size="sm" aria-label={t('list.kindLabel')} value={model.address.kind ?? ''} onChange={(event) => actions?.onAddress?.({ kind: (event.target.value || null) as IncomingKind | null })}>
      <option value="">{t('list.allKinds')}</option>
      {(model.kinds ?? INCOMING_KINDS).map((kind) => (
        <option key={kind} value={kind}>
          {t(`kind.plural.${kind}`)}
        </option>
      ))}
      {/* F-CQ-103 (L7): the customer's tab leaves change requests out — said in words, never silently. cq fx2 W-09: a short option
          (a native select is as wide as its longest option: the whole sentence took a toolbar line), the why in its title. */}
      {model.kinds && !model.kinds.includes('CHANGE_REQUEST') && (
        <option value="" disabled title={t('list.kindNotHereHint')}>
          {t('list.kindNotHere')}
        </option>
      )}
    </Select>
  )
  const sourceTool = (
    <Select size="sm" aria-label={t('list.sourceLabel')} value={model.address.source ?? ''} onChange={(event) => actions?.onAddress?.({ source: (event.target.value || null) as InquirySource | null })}>
      <option value="">{t('list.allSources')}</option>
      {INQUIRY_SOURCES.map((source) => (
        <option key={source} value={source}>
          {t(`source.${source}`)}
        </option>
      ))}
    </Select>
  )
  // ---- end cq fx5 W-09
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
      {/* F-CQ-103 (10-design §3.2): Sort ▾ — When it came (the server's order) or Most urgent first (one page ranked; held in words with more). */}
      {!repliesView && (
        <Select size="sm" aria-label={t('rank.label')} title={model.rank === 'urgent' ? t('rank.rule') : undefined} value={model.rank ?? 'arrival'} onChange={(event) => actions?.onAddress?.({ rank: event.target.value as IncomingRank })}>
          {INCOMING_RANKS.map((rank) => (
            <option key={rank} value={rank}>
              {t(`rank.${rank}`)}
            </option>
          ))}
        </Select>
      )}
      {/* cq fx5 W-09 (10-design §3.2): on a phone Kind and How it came fold into More ▾ (one tool line less); elsewhere inline. */}
      {!repliesView && (phone ? (
        <DetailPopover trigger={<>{t('list.more')} <ChevronDown size={13} aria-hidden /></>} triggerLabel={t('list.moreTools')} label={t('list.moreTools')} hoverDelay={0} triggerClassName="fw-inq-moretrigger">
          <span className="fw-inq-moretools">
            {kindTool}
            {sourceTool}
          </span>
        </DetailPopover>
      ) : (
        <>
          {kindTool}
          {sourceTool}
        </>
      ))}
      {/* F-SA-224: "From" is the Sales lists' one customer filter (`?party=`), with the prospects (no customer yet) as a choice.
          F-SA-277: none for a customer the host locks. */}
      {!model.locked && <CustomerSwitcher
        state={localSwitcherState((model.customers ?? []).map((party) => ({ id: party.id, code: party.code, name: party.tradeName ?? party.legalName })), fromQuery)}
        party={model.address.prospect ? null : model.address.party}
        partyName={model.address.party ? (fromCustomer?.tradeName ?? fromCustomer?.legalName ?? null) : undefined}
        query={fromQuery}
        searching={false}
        onQuery={setFromQuery}
        onPick={(value) => {
          setFromQuery('')
          actions?.onAddress?.(value === PROSPECTS ? { prospect: true, party: null } : { prospect: false, party: value })
        }}
        extra={[{ value: PROSPECTS, label: t('list.prospectsOnly') }]}
        extraValue={model.address.prospect ? PROSPECTS : null}
        allLabel={t('list.allFrom')}
        recent={0}
        subject="list"
      />}
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
  // F-SA-277: the list column — beside the reading pane (SplitPane), or alone when the host's dock is the pane.
  const listColumn = (
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
          {/* F-SA-277: an embedding host draws no tiles (it draws what sits above the list). */}
          {model.embedded ? null : paneOpen ? (
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
          {/* F-CQ-103 (C7): Most urgent first over more than one page is held — in words, the rows in the server's order. */}
          {!repliesView && model.rankHeld && <p className="fw-inq-hint">{say(model.rankHeld)}</p>}
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
            // cq fx2 W-07 (P0-B10): the count names what it counts — "1 portal order", "2 requests", "3 requests and portal orders".
            count={model.list ? (model.more?.next ? t('list.countMore', { count: rows?.length ?? 0 }) : t(countKeyOf(rows ?? []), { count: rows?.length ?? 0 })) : t('list.countReading')}
            search={
              <Input
                size="sm"
                type="search"
                className="fw-inq-search"
                aria-label={t('list.search')}
                placeholder={model.locked ? t('list.searchHost') : t('list.search') /* cq fx2 W-09: one customer's list names no customer */}
                {...search.field /* F-SA-223 */}
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
              // F-CQ-201 (10-design §6.2): the bar — 3 + More ▾ with words, each act only with its right; a portal order ticked: one line.
              actions: model.barRights ? (
                <ManyBar bar={incomingBarOf(model.barRights, (rows ?? []).filter((row) => selected.includes(row.key)), model.customerName ?? null, model.replyPortal /* cq fx5 W3-2 */, model.catalogueFacts /* owb-of4 */)} onAct={(id) => actions?.onBarAct?.(id as IncomingActKind, (rows ?? []).filter((row) => selected.includes(row.key)))} />
              ) : (
                <>
                  {/* B-TH-233 (list-F11): Assign and Decline act on requests only; the other kinds of the selection are left out and said.
                      F-CQ-103 (P0-B6): the words count only what an act runs on; with no open request ticked the words say why and no act is
                      drawn ("Assign 0" never). */}
                  <span className="fw-inq-hint">{!bulkActs(reach) ? say(reach.held) : reach.others > 0 ? t('bulk.reachOthers', { open: reach.open.length, others: reach.others }) : reach.closed > 0 ? t('bulk.reachClosed', { open: reach.open.length, closed: reach.closed }) : t('bulk.reach', { count: reach.open.length })}</span>
                  {bulkActs(reach) && (
                    <>
                      <Button size="sm" heldReason={!model.can.manage ? salesHeld : (say(reach.held) ?? (offline ? t('held.offline') : null))} aria-label={t('bulk.assign', { count: reach.open.length })} onClick={() => actions?.onBulk?.('assign', reach.open.map((row) => row.id))}>
                        <UserRound size={13} aria-hidden /> <SelectionLabel>{t('bulk.assign', { count: reach.open.length })}</SelectionLabel>
                      </Button>
                      <Button size="sm" variant="danger-outline" heldReason={!model.can.manage ? salesHeld : (say(reach.held) ?? (offline ? t('held.offline') : null))} aria-label={t('bulk.decline', { count: reach.open.length })} onClick={() => actions?.onBulk?.('decline', reach.open.map((row) => row.id))}>
                        <XCircle size={13} aria-hidden /> <SelectionLabel>{t('bulk.decline', { count: reach.open.length })}</SelectionLabel>
                      </Button>
                    </>
                  )}
                </>
              ),
            }}
            updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
            keys={ownKeys}
            keysOpen={model.keysOpen}
            // F-SA-277: with the host's dock as the pane, Enter opens the row's own page (the click is the dock's).
            onOpen={(row) => (hostPane ? actions?.onOpen?.(row.id) : actions?.onOpenRow?.(row, false))}
            state={state}
            withheld={model.can.price ? [] : [{ label: t('col.targetPrice'), reason: t('list.withheldPrice') }]}
            // On a phone a card opens the request's full page (B-TH-219), the list kept for Back; any other kind its own place.
            // F-CQ-104 (10-design §4.6): the host's ONE card — the number names it, the picture and the new messages beside it, the chips under it.
            // cq fx2 W-14 (10-design §3.4): a host's list says in its own foot the order's rule and what the host left out.
            foot={model.columns === 'host' ? <>{model.rank === 'urgent' && <span>{t('rank.rule')}</span>}{model.foot}</> : undefined}
            cards={{ fields: model.columns === 'host' ? HOST_CARD_FIELDS : CARD_FIELDS, hrefOf: (row) => (placeOf(row) === 'request' ? fullPageHref(model.prefix, row.id, model.address) : rowHref(model.prefix, model.address, row)) }}
            // F-SA-279: on the customer page a row drives the host's dock (its row marked by its key; the keys' row reported; ⌘↵ a new tab).
            active={
              model.active
                ? {
                    id: model.active.pick ? (rows ?? []).find((row) => THREAD_TYPE[row.kind] === model.active?.pick?.type && row.id === model.active?.pick?.id)?.key ?? null : null,
                    onFocusRow: (row) => actions?.onFocusRow?.(row),
                    onOpenNewTab: (row) => actions?.onOpenRow?.(row, true),
                    // F-CQ-104: the phone card's door to the row's thread (a change request has none: its talk is its order's).
                    cardDoor: model.cardDoor ? { column: model.columns === 'host' ? 'newMessages' /* cq fx2 W-01: never on the number (the card's title) */ : 'subject', label: model.cardDoor, onOpen: (row) => (row.kind === 'CHANGE_REQUEST' ? undefined : actions?.onOpenRow?.(row, false)) } : null,
                  }
                : null
            }
          />
          )}
          </div>
  )

  return (
    <div className="fw-inq">
      {/* B-TH-216 (band-F01): Incoming · 41 open · as of 10:42 — the count is the Rows ▾ choice's, in words.
          F-SA-277: an embedding host draws its own title and no band. */}
      {!model.embedded && (
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
          {/* B-TH-285 (band-F05): while the orders@ door is not open the band says so (the addresses wait for live mail receiving). */}
          {model.addresses?.door && (
            <span title={model.addresses.door.key === 'addresses.door.notLive' ? t('addresses.door.notLiveBody') : undefined}>
              <Tag tone="warning">{say(model.addresses.door)}</Tag>
            </span>
          )}
          <Menu
            label={<MoreHorizontal size={16} aria-hidden />}
            align="right"
            triggerProps={{ 'aria-label': t('list.more') }}
            items={[
              // B-TH-285 (band-F04): the addresses whose mail becomes a request by itself (read by every reader, changed with sales settings).
              ...(model.addresses ? [{ id: 'addresses', label: t('addresses.menu'), description: t('addresses.menuHint'), onSelect: () => actions?.addresses?.onOpen?.() }] : []),
              { id: 'rules', label: t('list.rulesLater'), disabled: true, description: t('list.rulesLaterHint') },
            ]}
          />
          {/* cq fx2 W-13 (plan §5.5): a button you may not use is hidden — no New request without sales.inquiries.manage. */}
          {model.can.manage && newButton}
        </span>
      </div>
      )}
      <NoticeLine notice={model.notice} onDismiss={actions?.onDismissNotice} />
      {model.catalogueConfirmed && <ConfirmedLine confirmed={model.catalogueConfirmed} say={so} onDismiss={actions?.onDismissConfirmed} />}
      {/* B-TH-217 (PL2): the list ~35 % and the request ~65 % beside it; nothing but the band sits above the pane.
          F-SA-277: pane 'host' — no SplitPane, the page's dock is the reading pane: the list alone. */}
      {hostPane ? listColumn : (
      <SplitPane
        labels={{ pane: t('pane.label'), close: t('pane.back') }}
        onClose={() => actions?.onOpen?.(null)}
        list={listColumn}
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
      )}
      {viewerRow && <ViewerFor row={viewerRow} model={model} actions={actions} onClose={() => setViewer(null)} />}
      {model.addresses?.open && <AddressesDialog model={model.addresses.model} prefix={model.prefix} actions={actions?.addresses} />}
      {model.newRequest && <NewRequestDialog model={model.newRequest} me={model.me} can={model.can} prefix={model.prefix} actions={actions?.newRequest} />}
      {/* ---- F-CQ-201 / 203 / 204: the ONE many-acts window, Add task to N, a row's own window in place (a host whose dock is the pane) */}
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
            today: today,
            onSend: (draft, assignee) => actions?.tasks?.onSend(draft, assignee) ?? Promise.resolve(null),
            words: { ns: 'before-order', prefix: taskWordsOf(model.tasks.records) /* cq fx2 W-07: the records' own kind */ },
            namesOther: null,
            hrefOf: (record) => (record.type === 'Inquiry' ? fullPageHref(model.prefix, record.id, model.address) : `${model.prefix}/sales/incoming?catalogue=${encodeURIComponent(record.id)}`),
            defaultAssignee: 'me',
          }}
        />
      )}
      {hostPane && model.verb && model.verb.loaded.status === 'ready' && <RecordDialogs model={model.verb} view={model.verb.loaded.value} actions={actions?.record} />}
      {hostPane && model.catalogueVerb && model.catalogueVerb.loaded.status === 'ready' && <CatalogueDialogs model={model.catalogueVerb} actions={actions?.catalogue} record={model.catalogueVerb.loaded.value} />}
      {/* F-CQ-304: the Orders sheet's ONE Reply-to-N window, given these records (their own conversations and words). */}
      {model.reply && <ReplyManyDialog model={model.reply} actions={actions?.reply} />}
      {model.bulk?.kind === 'assign' && <AssignDialog model={model.bulk.model} actions={{ onAssign: actions?.bulk?.onAssign, onRetry: actions?.bulk?.onRetryPeople, onClose: actions?.bulk?.onClose }} />}
      {model.bulk?.kind === 'decline' && <DeclineDialog model={model.bulk.model} actions={{ onDraft: actions?.bulk?.onDecline, onSubmit: actions?.bulk?.onSubmit, onClose: actions?.bulk?.onClose }} />}
      {model.detail && model.pane?.closing && model.detail.loaded.status === 'ready' && (
        <CloseThreadConfirm record={model.detail.loaded.value.number} party={model.detail.loaded.value.party?.name ?? null} problem={model.pane.closing.problem} onClose={() => actions?.pane?.onConfirmClose?.()} onCancel={() => actions?.pane?.onCancelClose?.()} />
      )}
    </div>
  )
}

/** The picture large of one row (F-SA-212: the one viewer; its small preview read again from the one cache). */
function ViewerFor({ row, model, actions, onClose }: { row: InquiryRow; model: InquiriesModel; actions?: InquiriesActions; onClose: () => void }) {
  return (
    <PictureViewer
      source="request"
      recordId={row.id}
      number={row.number}
      picture={row.picture ?? null}
      styleCount={row.styleCount ?? 1}
      read={actions?.readPictures}
      demo={model.demoPictures?.[row.id]}
      prefix={model.prefix}
      recordHref={recordHref(model.prefix, row.id)}
      onClose={onClose}
    />
  )
}

/** owb-of4 step 1: what bulk Confirm did — confirmed, and each skip counted (text orders, the ones that hold, the rest), the refused. */
export function confirmedWordsOf(confirmed: CatalogueConfirmed, say: (key: string, params?: Readonly<Record<string, string | number>>) => string): string {
  const parts = [say('incoming.confirmed', { count: confirmed.done })]
  if (confirmed.text > 0) parts.push(say('incoming.skippedText', { count: confirmed.text }))
  if (confirmed.held > 0) parts.push(say('incoming.skippedHeld', { count: confirmed.held }))
  if (confirmed.other > 0) parts.push(say('incoming.skippedOther', { count: confirmed.other }))
  if (confirmed.refused > 0) parts.push(say('incoming.refused', { count: confirmed.refused }))
  return parts.join(' · ')
}

function ConfirmedLine({ confirmed, say, onDismiss }: { confirmed: CatalogueConfirmed; say: (key: string, params?: Readonly<Record<string, string | number>>) => string; onDismiss?: () => void }) {
  return (
    <Banner
      tone={confirmed.refused > 0 || confirmed.done === 0 ? 'warning' : 'success'}
      title={confirmedWordsOf(confirmed, say)}
      action={
        onDismiss ? (
          <Button size="sm" variant="quiet" onClick={onDismiss}>
            {say('incoming.dismiss')}
          </Button>
        ) : undefined
      }
    />
  )
}
