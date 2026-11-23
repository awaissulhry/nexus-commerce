'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { Button } from '@nexus/ui/primitives'
import { WithMessages } from '../../../../record-panels/i18n'
import { useT } from '../../../../lib/i18n/provider'
import { useOfficeSession } from '../../../../lib/session/context'
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
import { bandOf, closedDoorsOf, doorCount, incomingCountsOf, kindDoorCount, INQUIRIES_LAYOUT_KEY, quoteCountsOf, QUOTES_LAYOUT_KEY, sectionCountOf, sectionStateOf, TAB_KINDS, type Band, type Door, type KindCounts, type SectionState } from './quotes-tab/band'
import { useQuotesTab, type QuotesTab } from './quotes-tab/use-quotes-tab'
import { BEFORE_ORDER_NS, BeforeOrderBand } from './quotes-tab/view/BeforeOrderBand'
import './quotes-tab/quotes-tab.css'

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
  const b = useT(BEFORE_ORDER_NS)
  const { tab, rootRef, onCloseDoor, onRetry } = useQuotesTab(party.id)
  const [ask, setAsk] = useState<Ask | null>(null)
  const band = bandOf(tab.counts, tab.rights, tab.door)
  // F-CQ-101 (10-design §3.6): a customer with nothing before an order — ONE card (the New buttons move into it, never twice).
  const empty = band !== null && band.total === 0 && tab.door === null
  const samplesHref = band?.samples ? `${tab.prefix}/products/samples?party=${encodeURIComponent(party.id)}` : null
  const newRequest = incoming && tab.rights.newRequest
  const newQuote = quotes && tab.rights.newQuote
  const sections = { party, onPick, onFocus, shown, tab, ask, hidden: empty, band }
  return (
    <div className="fw-qt" ref={rootRef}>
      <BeforeOrderBand
        model={{ customer: party.name, band, failed: tab.failed, door: tab.door, doorCount: tab.door ? doorCount(tab.counts, tab.door) : null, hrefs: tab.hrefs, everything: tab.everything, samplesHref, room: tab.room, newRequest: newRequest && !empty, newQuote: newQuote && !empty }}
        actions={{ onNewRequest: () => setAsk({ what: 'request', at: Date.now() }), onNewQuote: () => setAsk({ what: 'quote', at: Date.now() }), onCloseDoor, onRetry }}
      />
      {empty && (
        <div className="fw-qt-empty" role="status">
          <p className="fw-qt-empty-title">{b('empty.tab', { customer: party.name })}</p>
          <p className="fw-qt-quiet">{b('empty.tabBody', { customer: party.name })}</p>
          {(newRequest || newQuote) && (
            <span className="fw-qt-empty-actions">
              {newRequest && (
                <Button size="sm" onClick={() => setAsk({ what: 'request', at: Date.now() })}>
                  {b('band.newRequest', { customer: party.name })}
                </Button>
              )}
              {newQuote && (
                <Button size="sm" variant="primary" onClick={() => setAsk({ what: 'quote', at: Date.now() })}>
                  {b('band.newQuote', { customer: party.name })}
                </Button>
              )}
            </span>
          )}
        </div>
      )}
      {/* W1: the drafts' home is still Work › "Drafts of <customer>" (the section moves here in W2 / W3): an old `group=WRITING` link says where. */}
      {tab.door === 'WRITING' && (
        <Link className="fw-bo-quietdoor" href={tab.hrefs.WRITING}>
          {b('group.WRITING', { customer: party.name })} ›
        </Link>
      )}
      {/* F-CQ-101 (L3): what waits on us first — Requests & portal orders, then Quotes. A section the role does not read: one quiet line. */}
      {incoming ? <IncomingSection {...sections} /> : !empty && <p className="fw-qt-quiet">{b('note.noRequests')}</p>}
      {quotes ? <QuotesSection {...sections} /> : !empty && <p className="fw-qt-quiet">{b('note.noQuotes')}</p>}
    </div>
  )
}

/** F-CQ-101: a section's head — its title and the quiet count that never hides a record. */
function SectionHead({ title, kind, section, tab, customer }: { title: string; kind: KindCounts | null; section: 'quotes' | 'incoming'; tab: QuotesTab; customer: string }) {
  const b = useT(BEFORE_ORDER_NS)
  const count = sectionCountOf(kind, section, tab.door, tab.door ? kindDoorCount(tab.counts, section, tab.door) : null, tab.door ? b(`group.${tab.door}`, { customer }) : null)
  return (
    <div className="fw-qt-sechead">
      <h3 className="fw-qt-sectitle">{title}</h3>
      {count && <p className="fw-qt-quiet">{b(count.key, count.params)}</p>}
    </div>
  )
}

/** F-CQ-101: the closed groups of a kind, each a door ("Closed ones are left out (7): Won 2 · Moved to a quote 3 · Lost 2"). */
function ClosedDoors({ tab, kind, lead, customer }: { tab: QuotesTab; kind: 'quotes' | 'incoming'; lead: 'foot' | 'empty'; customer: string }) {
  const b = useT(BEFORE_ORDER_NS)
  const doors = closedDoorsOf(tab.counts, kind)
  if (doors.length === 0) return null
  const total = doors.reduce((sum, entry) => sum + entry.count, 0)
  return (
    <span className="fw-qt-doors">
      <span className="fw-qt-quiet">{b(lead === 'foot' ? 'foot.closedLeftOut' : 'empty.closedDoors', { count: total })}</span>
      {doors.map((entry) => (
        <Link key={entry.group} href={tab.hrefs[entry.group as Door]} replace scroll={false} className="fw-bo-quietdoor">
          {b('foot.door', { group: b(`group.${entry.group}`, { customer }), count: entry.count })}
        </Link>
      ))}
    </span>
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
  const kind = quoteCountsOf(tab.counts)
  const state: SectionState = sectionStateOf(kind, group === null, door)
  // While a line stands in for the list (no frame, no "N updates · Show"), a live change reads the list again at once.
  useReadAgainWhenEmpty(state !== 'list', model.updates, actions.onShowUpdates)
  // A line stands in for the list: the ONE New quote window still opens here (with the list's own words).
  const dialog = model.newQuote ? (
    <WithMessages namespaces={['sales', 'lists']}>
      <NewQuoteDialog model={model.newQuote} actions={actions} />
    </WithMessages>
  ) : null
  if (hidden) return dialog
  const title = t('customers.quotesTab.quotes')
  return (
    <section className="fw-qt-section" aria-label={title}>
      <SectionHead title={title} kind={kind} section="quotes" tab={tab} customer={party.name} />
      {state === 'folded' ? (
        <p className="fw-qt-quiet">{b('fold.quotes')}</p>
      ) : state === 'none' ? (
        <p className="fw-qt-quiet">{b('empty.quotesNone', { customer: party.name })}</p>
      ) : state === 'onlyClosed' ? (
        <p className="fw-qt-quiet">
          {t('customers.quotesTab.noQuotes', { customer: party.name })} <ClosedDoors tab={tab} kind="quotes" lead="empty" customer={party.name} />
        </p>
      ) : (
        <>
          <ScopedListTools listKey={QUOTES_LIST_KEY} layoutKey={QUOTES_LAYOUT_KEY} page={`${prefix}${QUOTES_PATH}`} scope={scope}>
            <QuotesListView
              // F-SA-279: the docked quote's row marked; the keys' row docks after the rest. F-CQ-104: a phone card's door to the thread.
              model={onFocus ? { ...model, active: { id: shown?.type === 'Quote' ? shown.id : null }, cardDoor: t('customers.work.dock.cardDoor') } : model}
              actions={onFocus ? { ...actions, onFocusRow: (row) => onFocus({ type: 'Quote', id: row.id, label: row.number, companyId: row.companyId }) } : actions}
            />
          </ScopedListTools>
          {door === null && <ClosedDoors tab={tab} kind="quotes" lead="foot" customer={party.name} />}
        </>
      )}
      {state !== 'list' && dialog}
    </section>
  )
}

/** Requests & portal orders: the customer's requests and portal orders (GET /sales/incoming?partyId&kinds), Incoming's own list. */
function IncomingSection({ party, onPick, onFocus, shown, tab, ask, hidden }: HostProps) {
  const t = useT('parties')
  const b = useT(BEFORE_ORDER_NS)
  const session = useOfficeSession()
  const prefix = companyPrefix(session.company?.code ?? '')
  const pick = useRef(onPick)
  pick.current = onPick
  const listed = useRef<ListAddress>({ ...HOME_ADDRESS, party: party.id })
  const door = tab.door
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
  const kind = incomingCountsOf(tab.counts)
  const state: SectionState = sectionStateOf(kind, tile === null, door)
  useReadAgainWhenEmpty(state !== 'list', model.updates, actions.onShowUpdates)
  // A line stands in for the list: the ONE New request window still opens here (with the list's own words).
  const dialog = model.newRequest ? (
    <InquiriesMessages>
      <NewRequestDialog model={model.newRequest} me={model.me} can={model.can} prefix={model.prefix} actions={actions.newRequest} />
    </InquiriesMessages>
  ) : null
  if (hidden) return dialog
  const title = b('sec.incoming')
  return (
    <section className="fw-qt-section" aria-label={title}>
      <SectionHead title={title} kind={kind} section="incoming" tab={tab} customer={party.name} />
      {state === 'folded' ? (
        <p className="fw-qt-quiet">{b('fold.incoming')}</p>
      ) : state === 'none' ? (
        <p className="fw-qt-quiet">{b('empty.incomingNone', { customer: party.name })}</p>
      ) : state === 'onlyClosed' ? (
        <p className="fw-qt-quiet">
          {b('empty.incomingNoLive', { customer: party.name })} <ClosedDoors tab={tab} kind="incoming" lead="empty" customer={party.name} />
        </p>
      ) : (
        <>
          <ScopedListTools listKey={INQUIRIES_LIST_KEY} layoutKey={INQUIRIES_LAYOUT_KEY} page={`${prefix}${PAGE_PATH}`} scope={scope}>
            <InquiriesView
              // F-SA-279: the docked request's row marked; the keys' row docks after the rest (a change request never: its talk is its order's).
              model={onFocus ? { ...model, active: { pick: shown ? { type: shown.type, id: shown.id } : null }, cardDoor: t('customers.work.dock.cardDoor') } : model}
              actions={onFocus ? { ...actions, onFocusRow: (row) => (row.kind === 'CHANGE_REQUEST' ? undefined : onFocus({ type: THREAD_TYPE[row.kind], id: row.id, label: row.number, companyId: row.companyId ?? null })) } : actions}
              slots={slots}
            />
          </ScopedListTools>
          {door === null && <ClosedDoors tab={tab} kind="incoming" lead="foot" customer={party.name} />}
        </>
      )}
      {state !== 'list' && dialog}
    </section>
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
