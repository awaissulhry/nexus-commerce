'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { WithMessages } from '../../../../record-panels/i18n'
import { useT } from '../../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { companyPrefix } from '../../../../lib/session/session'
import { ScopedListTools } from '../../_shared/scoped-list-tools/ScopedListTools'
import { QUOTES_LIST_KEY, QUOTES_PATH, useQuotesList, type QuotesListHost } from '../../quotes/list/use-quotes-list'
import { NewQuoteDialog, QuotesListView } from '../../quotes/list/view/QuotesListView'
import { INQUIRIES_LIST_KEY, rowPageHref, useInquiriesList, type InquiriesListHost } from '../../inquiries/use-inquiries-list'
import { InquiriesView } from '../../inquiries/view/InquiriesView'
import { NewRequestDialog } from '../../inquiries/view/NewRequestDialog'
import { InquiriesMessages } from '../../inquiries/parts'
import { HOME_ADDRESS, PAGE_PATH, THREAD_TYPE, type ListAddress } from '../../inquiries/model'
// ---- F-CQ-101 / F-CQ-104 (customer page › Quotes & incoming): the band, its doors, the sections' states, the tab's own room
import { bandOf, emptyTab, INQUIRIES_LAYOUT_KEY, QUOTES_LAYOUT_KEY, sectionStateIn, TAB_KINDS, type Band } from './quotes-tab/band'
import { useQuotesTab, type QuotesTab } from './quotes-tab/use-quotes-tab'
import { BEFORE_ORDER_NS } from './quotes-tab/view/BeforeOrderBand'
// cq T: the tab's own parts, pure (the live tab and the design gallery draw the same ones)
import { DraftsFrame, QuotesTabFrame, TabSection } from './quotes-tab/view/QuotesTabParts'
import './quotes-tab/quotes-tab.css'
// ---- F-CQ-205: the section "Customer is writing" — the customer's portal drafts, read only (the Work tab's own parts, mounted here)
import { pictureReader } from '../../../../lib/record-picture/api'
import { useCustomerDrafts } from './drafts/use-customer-drafts'
import { CustomerDraftsList } from './drafts/view/CustomerDraftsList'
import { DraftWindow } from './drafts/view/DraftWindow'
import { draftPick, draftsNav, draftTitle } from './drafts/model'
import type { DraftRow } from './drafts/api'

/**
 * F-SA-277 (sales page plan R5, P18; 11-customer-page §3.6): the customer's Quotes & incoming tab — each list that list's own component
 * through its lifted container locked to the customer: Incoming (use-inquiries-list.ts with pane 'host', `sales.inquiries.view`) and
 * Quotes (use-quotes-list.ts, `quotes.view`), each only for a reader who may read it. Each list's reads are its own walled reads with
 * the page's customer (the API's `partyId`, never a filter in the browser); its terms are its own, in memory (typing in one never
 * narrows the other; the page's `tab` stays), and its frame's Export ▾ / Export N / saved views take exactly that list's terms with
 * the lock (ScopedListTools: the file is the screen). One search rule, one row-click rule: a row's click docks its thread (`onPick`);
 * Enter, ⌘↵ and the links open the record's page as the lists do.
 *
 * F-CQ-101 … 104 (customer page › Quotes & incoming, plan.md §2; 10-design §1–§5; settles C15, C25–C27, C34): the tab is the home of
 * everything before an order — the band "Before an order · <customer>" on top (one count read; each number a door `?group=` that
 * filters the lists below to exactly its rows), then Requests & portal orders (what waits on us first), then Quotes; each list opens
 * on its live rows, Most urgent first, says in its head how many it shows and how many closed ones it leaves out (one click away),
 * folds to one quiet line under a door that holds none of its kind, and tells the truth when the customer has none at all. The
 * columns follow the tab's OWN room (never the window); each list keeps its own layout on this tab; ONE card on a phone; New quote /
 * New request for <customer>… open the Sales pages' own windows with the customer set. Change requests are not here (they change a
 * confirmed order). W1 reads the counts on this tab only (W3 lifts the read to the page for the badge).
 */

/** What a row's click hands the page's dock: the record whose thread it shows (the Work tab's one DockPick). */
import type { DockPick } from './view/WorkTab'

export function QuotesIncomingTab({ party, onPick, onFocus, shown }: { party: { id: string; name: string }; onPick?: (pick: DockPick) => void; /* F-SA-279 */ onFocus?: (pick: DockPick) => void; shown?: DockPick | null }) {
  return (
    <WithMessages namespaces={['parties', BEFORE_ORDER_NS]}>
      <Tab party={party} onPick={onPick} onFocus={onFocus} shown={shown ?? null} />
    </WithMessages>
  )
}

// F-SA-279: `onFocus` — the keys moved the focus to a row (the page's dock follows after its rest); `shown` — the record docked (its row marked).
type SectionProps = { party: { id: string; name: string }; onPick?: ((pick: DockPick) => void) | undefined; onFocus?: ((pick: DockPick) => void) | undefined; shown?: DockPick | null }

/** F-CQ-104: what a section is asked by the band's head (a New window), counted so the same ask twice opens twice. */
type Ask = { readonly what: 'quote' | 'request'; readonly at: number }

/** F-CQ-101: what a section needs from the tab — the door's terms, its state, its head's count, the band's words for its door. */
type HostProps = SectionProps & { tab: QuotesTab; ask: Ask | null; hidden: boolean; band: Band | null }

function Tab({ party, onPick, onFocus, shown }: SectionProps) {
  const session = useOfficeSession()
  const quotes = session.permissions.includes('quotes.view')
  const incoming = session.permissions.includes('sales.inquiries.view')
  if (!quotes && !incoming) return null
  return <Body party={party} onPick={onPick} onFocus={onFocus} shown={shown} quotes={quotes} incoming={incoming} />
}

function Body({ party, onPick, onFocus, shown, quotes, incoming }: SectionProps & { quotes: boolean; incoming: boolean }) {
  const { tab, rootRef, onCloseDoor, onRetry } = useQuotesTab(party.id)
  const [ask, setAsk] = useState<Ask | null>(null)
  const band = bandOf(tab.counts, tab.rights, tab.door)
  const sections = { party, onPick, onFocus, shown, tab, ask, hidden: emptyTab(band, tab.door), band }
  return (
    <QuotesTabFrame
      rootRef={rootRef}
      model={{ partyId: party.id, customer: party.name, tab: { ...tab, rights: { ...tab.rights, quotes, requests: incoming } }, band }}
      actions={{ onNewRequest: () => setAsk({ what: 'request', at: Date.now() }), onNewQuote: () => setAsk({ what: 'quote', at: Date.now() }), onCloseDoor, onRetry }}
      incoming={<IncomingSection {...sections} />}
      quotes={<QuotesSection {...sections} />}
      drafts={tab.rights.drafts && <DraftsSection {...sections} />}
    />
  )
}

/** Quotes: the customer's quotes (GET /sales/quotes?partyId), the Quotes page's own list. */
function QuotesSection({ party, onPick, onFocus, shown, tab, ask, hidden }: HostProps) {
  const t = useT('parties')
  const b = useT(BEFORE_ORDER_NS)
  const session = useOfficeSession()
  const prefix = companyPrefix(session.company?.code ?? '')
  const pick = useRef(onPick)
  pick.current = onPick
  const door = tab.door
  const group = tab.terms.quotes
  const host = useMemo<QuotesListHost>(
    () => ({
      basePath: QUOTES_PATH,
      locked: { party: party.id },
      embedded: true,
      terms: 'memory',
      onRowClick: (row, newTab) => (newTab ? void window.open(`${prefix}/sales/quotes/${encodeURIComponent(row.id)}`, '_blank', 'noopener') : pick.current?.({ type: 'Quote', id: row.id, label: row.number, companyId: row.companyId })),
      // F-CQ-102 / F-CQ-104: the door's group (else "Not closed"), Most urgent first, the host's columns by the tab's room, no tile reads,
      // this customer's live changes only, the customer's one name, the door's words in State ▾.
      defaultGroup: group ?? 'LIVE',
      defaultSort: 'urgent',
      columns: 'host',
      room: tab.room,
      tiles: false,
      liveParty: party.id,
      customerName: party.name,
      groupLabel: door && group && group !== 'LIVE' ? b(`group.${door}`, { customer: party.name }) : null,
    }),
    [party.id, party.name, prefix, group, door, tab.room, b],
  )
  const { model, actions, scope } = useQuotesList(host)
  // F-CQ-104: the band's head asks for a New quote (the customer set: the list's own rule under a lock).
  useAsked(ask, 'quote', () => actions.onNewQuote?.(true))
  const state = sectionStateIn(tab, 'quotes')
  // While a line stands in for the list (no frame, no "N updates · Show"), a live change reads the list again at once.
  useReadAgainWhenEmpty(state !== 'list', model.updates, actions.onShowUpdates)
  // A line stands in for the list: the ONE New quote window still opens here (with the list's own words).
  const dialog = model.newQuote ? (
    <WithMessages namespaces={['sales', 'lists']}>
      <NewQuoteDialog model={model.newQuote} actions={actions} />
    </WithMessages>
  ) : null
  if (hidden) return dialog
  return (
    <TabSection kind="quotes" customer={party.name} tab={tab} aside={dialog}>
      <ScopedListTools listKey={QUOTES_LIST_KEY} layoutKey={QUOTES_LAYOUT_KEY} page={`${prefix}${QUOTES_PATH}`} scope={scope}>
        <QuotesListView
          // F-SA-279: the docked quote's row marked; the keys' row docks after the rest. F-CQ-104: a phone card's door to the thread.
          model={onFocus ? { ...model, active: { id: shown?.type === 'Quote' ? shown.id : null }, cardDoor: t('customers.work.dock.cardDoor') } : model}
          actions={onFocus ? { ...actions, onFocusRow: (row) => onFocus({ type: 'Quote', id: row.id, label: row.number, companyId: row.companyId }) } : actions}
        />
      </ScopedListTools>
    </TabSection>
  )
}

/** Requests & portal orders: the customer's requests and portal orders (GET /sales/incoming?partyId&kinds), Incoming's own list. */
function IncomingSection({ party, onPick, onFocus, shown, tab, ask, hidden }: HostProps) {
  const t = useT('parties')
  const session = useOfficeSession()
  const prefix = companyPrefix(session.company?.code ?? '')
  const pick = useRef(onPick)
  pick.current = onPick
  const listed = useRef<ListAddress>({ ...HOME_ADDRESS, party: party.id })
  const tile = tab.terms.incoming
  const host = useMemo<InquiriesListHost>(
    () => ({
      basePath: PAGE_PATH,
      locked: { party: party.id },
      embedded: true,
      terms: 'memory',
      pane: 'host',
      // A change request is not on this tab (F-CQ-103); on Sales › Incoming it opens Home › Approvals' review window (the list's own rule).
      onRowClick: (row, newTab) => (newTab ? void window.open(rowPageHref(prefix, row, listed.current), '_blank', 'noopener') : pick.current?.({ type: THREAD_TYPE[row.kind], id: row.id, label: row.number, companyId: row.companyId ?? null })),
      // F-CQ-103 / F-CQ-104: requests and portal orders only, the door's saved row (else Open), Most urgent first, the host's columns
      // by the tab's room, this customer's live changes only, the customer's one name.
      kinds: TAB_KINDS,
      defaultTile: tile ?? 'OPEN',
      defaultRank: 'urgent',
      columns: 'host',
      room: tab.room,
      liveParty: party.id,
      customerName: party.name,
    }),
    [party.id, party.name, prefix, tile, tab.room],
  )
  const { model, actions, slots, scope } = useInquiriesList(host)
  listed.current = model.address
  // F-CQ-104: the band's head asks for a New request (the customer set).
  useAsked(ask, 'request', () => actions.onNew?.())
  const state = sectionStateIn(tab, 'incoming')
  useReadAgainWhenEmpty(state !== 'list', model.updates, actions.onShowUpdates)
  // A line stands in for the list: the ONE New request window still opens here (with the list's own words).
  const dialog = model.newRequest ? (
    <InquiriesMessages>
      <NewRequestDialog model={model.newRequest} me={model.me} can={model.can} prefix={model.prefix} actions={actions.newRequest} />
    </InquiriesMessages>
  ) : null
  if (hidden) return dialog
  return (
    <TabSection kind="incoming" customer={party.name} tab={tab} aside={dialog}>
      <ScopedListTools listKey={INQUIRIES_LIST_KEY} layoutKey={INQUIRIES_LAYOUT_KEY} page={`${prefix}${PAGE_PATH}`} scope={scope}>
        <InquiriesView
          // F-SA-279: the docked request's row marked; the keys' row docks after the rest (a change request never: its talk is its order's).
          model={onFocus ? { ...model, active: { pick: shown ? { type: shown.type, id: shown.id } : null }, cardDoor: t('customers.work.dock.cardDoor') } : model}
          actions={onFocus ? { ...actions, onFocusRow: (row) => (row.kind === 'CHANGE_REQUEST' ? undefined : onFocus({ type: THREAD_TYPE[row.kind], id: row.id, label: row.number, companyId: row.companyId ?? null })) } : actions}
          slots={slots}
        />
      </ScopedListTools>
    </TabSection>
  )
}

/**
 * F-CQ-205 (10-design §3.5; settles C3, C14): "Customer is writing" — the customer's portal drafts, the Work tab's own parts mounted here
 * (one list, no copy): read only, no selection, no export; a row docks the draft's own thread, Open shows its read-only window. Read
 * only while the section shows (no door, or the WRITING door) and the counts say there is one; never counted but in WRITING.
 */
function DraftsSection({ party, onPick, onFocus, shown, tab, hidden }: HostProps) {
  const t = useT('parties')
  const b = useT(BEFORE_ORDER_NS)
  const api = useOfficeApi()
  const readPictures = useMemo(() => pictureReader(api), [api])
  const untitled = t('customers.drafts.untitled')
  const count = tab.counts?.byKind.drafts ?? null
  const showing = tab.terms.drafts && !hidden && count !== 0
  const drafts = useCustomerDrafts(party.id, showing, untitled)
  const draftRows = drafts.read.status === 'ready' ? drafts.read.rows : null
  if (hidden) return null
  return (
    <DraftsFrame
      customer={party.name}
      tab={tab}
      window={
        drafts.open &&
        drafts.window &&
        draftRows && (
          <DraftWindow
            model={{ customer: party.name, title: draftTitle(drafts.open, untitled), nav: draftsNav(draftRows, drafts.open.id), pane: drafts.window.model, thread: drafts.window.thread }}
            actions={{ pane: drafts.window.actions, onGo: drafts.onGo, onClose: drafts.onClose }}
          />
        )
      }
    >
      <CustomerDraftsList
        model={{ customer: party.name, read: drafts.read, updates: drafts.updates, activeId: shown?.type === 'PortalOrderRequest' ? shown.id : null, wide: (tab.room ?? 0) >= 1100, pictures: { read: readPictures, header: b('drafts.picture') } }}
        actions={{
          ...(onPick ? { onRow: (row: DraftRow) => onPick(draftPick(row, draftTitle(row, untitled))) } : {}),
          ...(onFocus ? { onFocusRow: (row: DraftRow) => onFocus(draftPick(row, draftTitle(row, untitled))) } : {}),
          onOpen: drafts.onOpen,
          onRetry: drafts.onRetry,
          onShowUpdates: drafts.onShowUpdates,
        }}
      />
    </DraftsFrame>
  )
}

/** F-CQ-104: serve an ask of the band's head once (the same ask twice: twice; never on arrival). */
function useAsked(ask: Ask | null, what: Ask['what'], open: () => void) {
  const served = useRef<number | null>(null)
  const latest = useRef(open)
  latest.current = open
  useEffect(() => {
    if (!ask || ask.what !== what || served.current === ask.at) return
    served.current = ask.at
    latest.current()
  }, [ask, what])
}

/** While the line stands in for an empty list (no frame, no "N updates · Show"), a live change reads the list again at once. */
function useReadAgainWhenEmpty(empty: boolean, updates: number, readAgain: (() => void) | undefined) {
  const again = useRef(readAgain)
  again.current = readAgain
  useEffect(() => {
    if (empty && updates > 0) again.current?.()
  }, [empty, updates])
}
