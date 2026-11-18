'use client'

import { useEffect, useMemo, useRef } from 'react'
import { WithMessages } from '../../../../../record-panels/i18n'
import { useT } from '../../../../../lib/i18n/provider'
import { useOfficeSession } from '../../../../../lib/session/context'
import { companyPrefix } from '../../../../../lib/session/session'
import { CardHead } from '../../../../parties/_shared/view/cards'
import { ScopedListTools } from '../../../_shared/scoped-list-tools/ScopedListTools'
import { activeFilterCount } from '../../../quotes/model'
import { QUOTES_LIST_KEY, QUOTES_PATH, useQuotesList, type QuotesListHost } from '../../../quotes/list/use-quotes-list'
import { QuotesListView } from '../../../quotes/list/view/QuotesListView'
import { INQUIRIES_LIST_KEY, rowPageHref, useInquiriesList, type InquiriesListHost } from '../../../inquiries/use-inquiries-list'
import { InquiriesView } from '../../../inquiries/view/InquiriesView'
import { CUSTOMER_REPLIES, HOME_ADDRESS, isFiltered, PAGE_PATH, THREAD_TYPE, type ListAddress } from '../../../inquiries/model'

/**
 * F-SA-277 (sales page plan R5, P18; 11-customer-page §3.6): the customer's Quotes & incoming tab — two lists stacked, each that
 * list's own component through its lifted container locked to the customer: Quotes (use-quotes-list.ts, `quotes.view`) and
 * Incoming requests (use-inquiries-list.ts with pane 'host', `sales.inquiries.view`), each only for a reader who may read it. Each
 * list's reads are its own walled reads with the page's customer (the API's `partyId`, never a filter in the browser); its terms
 * are its own, in memory (typing in one never narrows the other; the page's `tab` stays), and its frame's Export ▾ / Export N /
 * saved views take exactly that list's terms with the lock (ScopedListTools: the file is the screen). One search rule (each
 * list's own useListSearch), one row-click rule: a row's click docks its thread (`onPick`); Enter, ⌘↵ and the links open the
 * record's page as the lists do; a change request opens Home › Approvals' review window, as on Incoming.
 */

/** What a row's click hands the page's dock: the record whose thread it shows (the Work tab's one DockPick). */
import type { DockPick } from './WorkTab'

export function QuotesIncomingTab({ party, onPick }: { party: { id: string; name: string }; onPick?: (pick: DockPick) => void }) {
  return (
    <WithMessages namespaces={['parties']}>
      <Tab party={party} onPick={onPick} />
    </WithMessages>
  )
}

type SectionProps = { party: { id: string; name: string }; onPick?: ((pick: DockPick) => void) | undefined }

function Tab({ party, onPick }: SectionProps) {
  const session = useOfficeSession()
  const quotes = session.permissions.includes('quotes.view')
  const incoming = session.permissions.includes('sales.inquiries.view')
  if (!quotes && !incoming) return null
  return (
    <div className="fw-pty-stack">
      {quotes && <QuotesSection party={party} onPick={onPick} />}
      {incoming && <IncomingSection party={party} onPick={onPick} />}
    </div>
  )
}

/** Quotes: the customer's quotes (GET /sales/quotes?partyId), the Quotes page's own list. */
function QuotesSection({ party, onPick }: SectionProps) {
  const t = useT('parties')
  const session = useOfficeSession()
  const prefix = companyPrefix(session.company?.code ?? '')
  const pick = useRef(onPick)
  pick.current = onPick
  const host = useMemo<QuotesListHost>(
    () => ({
      basePath: QUOTES_PATH,
      locked: { party: party.id },
      embedded: true,
      terms: 'memory',
      onRowClick: (row, newTab) => (newTab ? void window.open(`${prefix}/sales/quotes/${encodeURIComponent(row.id)}`, '_blank', 'noopener') : pick.current?.({ type: 'Quote', id: row.id, label: row.number, companyId: row.companyId })),
    }),
    [party.id, prefix],
  )
  const { model, actions, scope } = useQuotesList(host)
  // The customer has no quote at all (the locked list read nothing and nothing narrows it): the line says so, not an empty frame.
  const empty = model.rows.items !== null && model.rows.items.length === 0 && !model.rows.problem && activeFilterCount(model.filters) === 0
  useReadAgainWhenEmpty(empty, model.updates, actions.onShowUpdates)
  const title = t('customers.quotesTab.quotes')
  return (
    <section className="fw-pty-stack" aria-label={title}>
      <CardHead title={title} />
      {empty ? (
        <p className="fw-pty-hint">{t('customers.quotesTab.noQuotes', { customer: party.name })}</p>
      ) : (
        <ScopedListTools listKey={QUOTES_LIST_KEY} page={`${prefix}${QUOTES_PATH}`} scope={scope}>
          <QuotesListView model={model} actions={actions} />
        </ScopedListTools>
      )}
    </section>
  )
}

/** Incoming requests: the customer's requests, catalogue orders and change requests (GET /sales/incoming?partyId), Incoming's own list. */
function IncomingSection({ party, onPick }: SectionProps) {
  const t = useT('parties')
  const session = useOfficeSession()
  const prefix = companyPrefix(session.company?.code ?? '')
  const pick = useRef(onPick)
  pick.current = onPick
  const listed = useRef<ListAddress>({ ...HOME_ADDRESS, party: party.id })
  const host = useMemo<InquiriesListHost>(
    () => ({
      basePath: PAGE_PATH,
      locked: { party: party.id },
      embedded: true,
      terms: 'memory',
      pane: 'host',
      // A change request never comes here: it opens Home › Approvals' review window (the list's own rule, as on Incoming).
      onRowClick: (row, newTab) => (newTab ? void window.open(rowPageHref(prefix, row, listed.current), '_blank', 'noopener') : pick.current?.({ type: THREAD_TYPE[row.kind], id: row.id, label: row.number, companyId: row.companyId ?? null })),
    }),
    [party.id, prefix],
  )
  const { model, actions, slots, scope } = useInquiriesList(host)
  listed.current = model.address
  // The customer has sent nothing (no row of any kind under the lock, nothing narrows the list): the line says so.
  const empty = !model.problem && model.list !== null && model.list.rows.length === 0 && model.address.tile !== CUSTOMER_REPLIES && !isFiltered({ ...model.address, party: null }) && model.list.counts.ALL === 0
  useReadAgainWhenEmpty(empty, model.updates, actions.onShowUpdates)
  const title = t('customers.quotesTab.incoming')
  return (
    <section className="fw-pty-stack" aria-label={title}>
      <CardHead title={title} />
      {empty ? (
        <p className="fw-pty-hint">{t('customers.quotesTab.noRequests', { customer: party.name })}</p>
      ) : (
        <ScopedListTools listKey={INQUIRIES_LIST_KEY} page={`${prefix}${PAGE_PATH}`} scope={scope}>
          <InquiriesView model={model} actions={actions} slots={slots} />
        </ScopedListTools>
      )}
    </section>
  )
}

/** While the line stands in for an empty list (no frame, no "N updates · Show"), a live change reads the list again at once. */
function useReadAgainWhenEmpty(empty: boolean, updates: number, readAgain: (() => void) | undefined) {
  const again = useRef(readAgain)
  again.current = readAgain
  useEffect(() => {
    if (empty && updates > 0) again.current?.()
  }, [empty, updates])
}
