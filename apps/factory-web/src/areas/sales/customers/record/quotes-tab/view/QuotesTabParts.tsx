'use client'

import type { ReactNode, RefObject } from 'react'
import Link from 'next/link'
import { Button } from '@nexus/ui/primitives'
import { useT } from '../../../../../../lib/i18n/provider'
import { closedDoorsOf, doorCount, emptyTab, incomingCountsOf, kindDoorCount, quoteCountsOf, sectionCountOf, sectionStateIn, type Band, type Door, type TabFacts } from '../band'
import { BEFORE_ORDER_NS, BeforeOrderBand, type BeforeOrderBandActions } from './BeforeOrderBand'

/**
 * F-CQ-101 / F-CQ-205 (customer page › Quotes & incoming, 10-design §1–§5): the tab's own parts, pure — the band on top, the ONE card
 * of a customer with nothing yet, then each section with its head (its title and the quiet count that never hides a record), its
 * state under the door (the list, one quiet line when folded, the truth when there is none or only closed ones) and the closed
 * groups as doors; the drafts section "Customer is writing" last. They fetch nothing: the live tab (QuotesIncomingTab.tsx) hands
 * them its state and each list (its own container's), the design gallery its cases (quotes-tab/fixtures.ts).
 */

export interface QuotesTabFrameModel {
  readonly partyId: string
  /** The customer's one name on the page (P0-B9). */
  readonly customer: string
  readonly tab: TabFacts
  readonly band: Band | null
}

export type QuotesTabFrameActions = BeforeOrderBandActions

/** The band, the empty card, then the sections in their order (what waits on us first; a section the role does not read: one quiet line). */
export function QuotesTabFrame({ model, actions, rootRef, incoming, quotes, drafts }: { model: QuotesTabFrameModel; actions?: QuotesTabFrameActions; rootRef?: RefObject<HTMLDivElement | null>; incoming: ReactNode; quotes: ReactNode; drafts: ReactNode }) {
  const b = useT(BEFORE_ORDER_NS)
  const { tab, band, customer } = model
  // F-CQ-101 (10-design §3.6): a customer with nothing before an order — ONE card (the New buttons move into it, never twice).
  const empty = emptyTab(band, tab.door)
  const samplesHref = band?.samples ? `${tab.prefix}/products/samples?party=${encodeURIComponent(model.partyId)}` : null
  const newRequest = tab.rights.requests && tab.rights.newRequest
  const newQuote = tab.rights.quotes && tab.rights.newQuote
  return (
    <div className="fw-qt" ref={rootRef}>
      <BeforeOrderBand
        model={{ customer, band, failed: tab.failed, door: tab.door, doorCount: tab.door ? doorCount(tab.counts, tab.door) : null, samplesHref, room: tab.room, newRequest: newRequest && !empty, newQuote: newQuote && !empty /* F-CQ-B: the doors are buttons (the host's onDoor), no hrefs */ }}
        actions={actions}
      />
      {empty && (
        <div className="fw-qt-empty" role="status">
          <p className="fw-qt-empty-title">{b('empty.tab', { customer })}</p>
          <p className="fw-qt-quiet">{b('empty.tabBody', { customer })}</p>
          {(newRequest || newQuote) && (
            <span className="fw-qt-empty-actions">
              {newRequest && (
                <Button size="sm" onClick={() => actions?.onNewRequest?.()}>
                  {b('band.newRequest', { customer })}
                </Button>
              )}
              {newQuote && (
                <Button size="sm" variant="primary" onClick={() => actions?.onNewQuote?.()}>
                  {b('band.newQuote', { customer })}
                </Button>
              )}
            </span>
          )}
        </div>
      )}
      {/* F-CQ-101 (L3): what waits on us first — Requests & portal orders, then Quotes. A section the role does not read: one quiet line. */}
      {tab.rights.requests ? incoming : !empty && <p className="fw-qt-quiet">{b('note.noRequests')}</p>}
      {tab.rights.quotes ? quotes : !empty && <p className="fw-qt-quiet">{b('note.noQuotes')}</p>}
      {/* F-CQ-205 (10-design §3.5): the customer's portal drafts last — read only, never counted as waiting on us (orders.view). */}
      {tab.rights.drafts && drafts}
    </div>
  )
}

/**
 * One list's section: its head, its state under the door, the list (the host's own container renders it), the closed groups as doors
 * under it when no door is open. `aside`: what still opens while a line stands in for the list (the section's New window).
 */
export function TabSection({ kind, customer, tab, children, aside, every = false }: { kind: 'quotes' | 'incoming'; customer: string; tab: TabFacts; children?: ReactNode; aside?: ReactNode; /** cq fx2 W-08: the list shows every state now (Rows: All) — nothing is left out. */ every?: boolean }) {
  const t = useT('parties')
  const b = useT(BEFORE_ORDER_NS)
  const counts = kind === 'quotes' ? quoteCountsOf(tab.counts) : incomingCountsOf(tab.counts)
  const state = sectionStateIn(tab, kind)
  const title = kind === 'quotes' ? t('customers.quotesTab.quotes') : b('sec.incoming')
  const all = every && tab.door === null ? counts : null
  const count = all ? { key: 'sec.countAll', params: { count: all.open + all.closed } } : sectionCountOf(counts, kind, tab.door, tab.door ? kindDoorCount(tab.counts, kind, tab.door) : null, tab.door ? b(`group.${tab.door}`, { customer }) : null)
  return (
    <section className="fw-qt-section" aria-label={title}>
      <div className="fw-qt-sechead">
        <h3 className="fw-qt-sectitle">{title}</h3>
        {count && <p className="fw-qt-quiet">{b(count.key, count.params)}</p>}
      </div>
      {state === 'folded' ? (
        <p className="fw-qt-quiet">{b(kind === 'quotes' ? 'fold.quotes' : 'fold.incoming')}</p>
      ) : state === 'none' ? (
        <p className="fw-qt-quiet">{b(kind === 'quotes' ? 'empty.quotesNone' : 'empty.incomingNone', { customer })}</p>
      ) : state === 'onlyClosed' ? (
        <p className="fw-qt-quiet">
          {/* F-CQ-305: the tab's own words (parties' `customers.quotesTab.noQuotes / noRequests` were removed). */}
          {b(kind === 'quotes' ? 'empty.quotesNoLive' : 'empty.incomingNoLive', { customer })} <ClosedDoors tab={tab} kind={kind} lead="empty" customer={customer} />
        </p>
      ) : (
        <>
          {/* cq fx2 W-14: the closed ones' doors are in the list's own foot (SectionFoot, beside the order's rule), not a loose line here. */}
          {children}
        </>
      )}
      {state !== 'list' && aside}
    </section>
  )
}

/**
 * cq fx2 W-14 (10-design §3.4): what a list's foot says the tab left out — the closed groups as doors, when no door is open and the
 * list does not show every state (W-08: under Rows: All nothing is left out). The host hands it to its list (the list's `foot`).
 */
export function SectionFoot({ kind, customer, tab, every = false }: { kind: 'quotes' | 'incoming'; customer: string; tab: TabFacts; every?: boolean }) {
  if (tab.door !== null || every) return null
  return <ClosedDoors tab={tab} kind={kind} lead="foot" customer={customer} />
}

/** F-CQ-101: the closed groups of a kind, each a door ("Closed ones are left out (7): Won 2 · Moved to a quote 3 · Lost 2"). */
function ClosedDoors({ tab, kind, lead, customer }: { tab: TabFacts; kind: 'quotes' | 'incoming'; lead: 'foot' | 'empty'; customer: string }) {
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

/**
 * F-CQ-205 (10-design §3.5; settles C3, C14): "Customer is writing" — the section's head, folded under a door that is not WRITING, the
 * truth when the customer writes none; the drafts' list is the Work tab's own part (the host hands it; od-w2.3: a row opens the office
 * draft page, editable — the read-only window went).
 */
export function DraftsFrame({ customer, tab, children }: { customer: string; tab: TabFacts; children?: ReactNode }) {
  const t = useT('parties')
  const b = useT(BEFORE_ORDER_NS)
  const count = tab.counts?.byKind.drafts ?? null
  const title = b('group.WRITING', { customer })
  return (
    <section className="fw-qt-section" aria-label={title}>
      <div className="fw-qt-sechead">
        <h3 className="fw-qt-sectitle">{title}</h3>
        <p className="fw-qt-quiet">{b('sec.writingSub', { customer })}</p>
      </div>
      {!tab.terms.drafts ? <p className="fw-qt-quiet">{b('fold.drafts')}</p> : count === 0 ? <p className="fw-qt-quiet">{t('customers.drafts.empty', { customer })}</p> : children}
    </section>
  )
}
