'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { companyPrefix } from '../../../../lib/session/session' // F-SA-277
import { useLiveChanges } from '../../../../record-panels/live'
import { cancelQuote, createQuote, duplicateQuote, findCustomers, getParty, listQuotes, nextNumber, QUOTE_STATUSES, type ListFilter, type QuoteListRow, type QuoteStatus } from '../api'
// F-SA-212: the Picture cell is the ONE picture part (its batch read; #1649's browserAddress kept there).
import { pictureReader } from '../../../../lib/record-picture/api'
import { useDuplicate } from '../duplicate/use-duplicate'
import { abilitiesOf, filtersOfTile, grainsOf, NO_FILTERS, romeToday, tileCount, type ListFilters, type QuoteTile, type TileCount } from '../model'
// F-SA-224: the one customer filter of the Sales lists (`?party=`; names only: Quotes has no count read per customer).
import { partyOfAddress, type SwitcherState } from '../../_shared/customer-switcher/model'
import type { PartyRow } from '../api'
import { readProblem, writeProblem } from '../problems'
import type { NewQuoteModel, QuotesListActions, QuotesListViewModel } from './list-model'
// B-W2b-316: New quote › Start from Template / Inquiry.
import { useNewFrom } from '../new-from/use-new-from'
// ---- B-TH-257 (X-SAL-QUO-LIST.grid-F03): the New messages column, B-TH-230's one read per page ----
import { readUnreadWith } from '../../../../lib/last-message-cell/api'
import { useUnread } from '../../../../lib/last-message-cell/use-unread'
import type { ListScope } from '../../_shared/scoped-list-tools/ScopedListTools' // F-SA-277

/**
 * F-SA-277 (sales page plan R5, P18; 11-customer-page §3.6): the ONE Quotes list, for every page that shows it — Sales › Quotes and
 * the customer page's Quotes & incoming. The body of the Quotes page's container moved here as it was (SCR-034: the quotes the person
 * may see — quotes.view over companies and customers, the API filters —, the tiles' counts — one read per tile's status, so each
 * number is the list's total under that filter; "200+" past one page —, live changes behind "n updates · Show", the Customer
 * switcher, New quote with its customer, contacts, defaults and the number it will get, Duplicate, Cancel N). The host says:
 *
 *   basePath   its list's own path under /w/<company> ('/sales/quotes'): where the page writes its address and where Copy link of a
 *              saved view opens; the company prefix is the session's, never parsed from the path
 *   locked     `party`: one customer's quotes — in EVERY read (the rows, the tiles, the tools' query for Export ▾, Export N and saved
 *              views), never cleared (Clear all keeps it), and no Customer switcher and no customer chip (the view's filters never
 *              hold it)
 *   embedded   the host draws what sits above the list (its title; no Quote speed under it — the page's own part)
 *   terms      'address' (default: Sales › Quotes — `?status=&mine=1&expiring=1&q=&party=`, so a filtered list can be shared and
 *              Back works) or 'memory' (two lists on one page: typing in one never narrows the other, and the page's own terms
 *              stay; the list's tools read `scope`, areas/sales/_shared/scoped-list-tools)
 *   onRowClick a row's click (default: the quote opens; ⌘ / Ctrl: a new tab); the customer page docks the quote's thread instead.
 *              Enter and the number's link open the quote as before.
 */

/** F-SA-277: the Quotes list's one list key (its export source exports/sources/quotes.ts, its saved views), on every host. */
export const QUOTES_LIST_KEY = 'sales.quotes' as const
/** F-SA-277: Sales › Quotes, the list's own page. */
export const QUOTES_PATH = '/sales/quotes'

export interface QuotesListHost {
  /** The list's own path under /w/<company>. */
  readonly basePath: string
  /** Held for every read, never cleared. */
  readonly locked?: { readonly party?: string } | null
  /** The host draws what sits above the list. */
  readonly embedded?: boolean
  /** Where the list's terms live (default: the address). */
  readonly terms?: 'address' | 'memory'
  /** A row's click; default: open the quote. */
  readonly onRowClick?: (row: QuoteListRow, newTab: boolean) => void
}

type Lock = Pick<QuotesListHost, 'locked'>

const TILE_READS: Record<QuoteTile, { status: QuoteStatus; mine?: boolean }> = {
  myDrafts: { status: 'DRAFT', mine: true },
  waiting: { status: 'PENDING_APPROVAL' },
  sent: { status: 'SENT' },
  expiring: { status: 'SENT' },
  accepted: { status: 'ACCEPTED' },
}

const isQuoteChange = (type: string) => type.startsWith('quote.') || type === 'deposit_request.created'

/** The filters in the address (`?status=SENT&mine=1&expiring=1&q=…`), so a filtered list can be shared and Back works. */
export function filtersOf(params: { get(name: string): string | null } | null): ListFilters {
  const status = params?.get('status') ?? ''
  return {
    status: (QUOTE_STATUSES as readonly string[]).includes(status) ? (status as QuoteStatus) : null,
    mine: params?.get('mine') === '1',
    expiring: params?.get('expiring') === '1' && status === 'SENT',
    q: params?.get('q') ?? '',
    party: partyOfAddress(params), // F-SA-224
  }
}

export function searchOf(filters: ListFilters): string {
  const search = new URLSearchParams()
  if (filters.status) search.set('status', filters.status)
  if (filters.mine) search.set('mine', '1')
  if (filters.expiring) search.set('expiring', '1')
  if (filters.q.trim()) search.set('q', filters.q.trim())
  if (filters.party) search.set('party', filters.party) // F-SA-224
  const text = search.toString()
  return text ? `?${text}` : ''
}

// ---- F-SA-277: the host's lock and terms, pure (a test holds them without a DOM) ----
/** The customer every read narrows to: the host's lock, else the switcher's choice. */
export const quotesPartyOf = (host: Lock, filters: Pick<ListFilters, 'party'>): string | null => host.locked?.party ?? filters.party ?? null

/** The rows' read: the filters, the lock over the chosen customer. */
export function quotesReadOf(host: Lock, filters: ListFilters): ListFilter {
  const partyId = quotesPartyOf(host, filters)
  return { status: filters.status ?? undefined, mine: filters.mine, q: filters.q, ...(partyId ? { partyId } : {}) }
}

/** A tile's read (its own status, only mine), the lock over the chosen customer (a tile keeps the customer). */
export function quotesTileReadOf(host: Lock, filters: Pick<ListFilters, 'party'>, tile: QuoteTile): ListFilter {
  const partyId = quotesPartyOf(host, filters)
  return { status: TILE_READS[tile].status, mine: TILE_READS[tile].mine, ...(partyId ? { partyId } : {}) }
}

/** The filters the view draws and the list keeps: a locked customer is the host's (no switcher, no chip; Clear all keeps it). */
export const quotesFiltersFor = (host: Lock, filters: ListFilters): ListFilters => (host.locked?.party ? { ...filters, party: null } : filters)

/** The address Sales › Quotes writes: its own terms on its own path (as before the lift). */
export const quotesAddress = (base: string, filters: ListFilters): string => `${base}${searchOf(filters)}`

/** The list's terms as its tools read them on an embedding host (Export ▾, Export N, saved views): the lock in, so the file is the screen. */
export const quotesToolsQuery = (host: Lock, filters: ListFilters): string => searchOf({ ...filters, party: quotesPartyOf(host, filters) }).replace(/^\?/, '')

/** A saved view's terms back into the list's memory (a lock stays the host's). */
export const quotesFromQuery = (host: Lock, query: string): ListFilters => quotesFiltersFor(host, filtersOf(new URLSearchParams(query.replace(/^\?/, ''))))
// ---- end F-SA-277

/** The ONE Quotes list: the model QuotesListView draws and its actions, for the host. */
export function useQuotesList(host: QuotesListHost): { model: QuotesListViewModel; actions: QuotesListActions & { onOpenRow: (id: string, newTab: boolean) => void }; scope: ListScope; embedded: boolean } {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const params = useSearchParams()
  // ---- F-SA-277: the host — the session's company prefix, the list's path, its lock and where its terms live ----
  const prefix = companyPrefix(session.company?.code ?? '')
  const base = `${prefix}${host.basePath}`
  const memory = host.terms === 'memory'
  const lock = host.locked?.party ?? null
  const lockHost = useMemo<Lock>(() => ({ locked: lock ? { party: lock } : null }), [lock])
  const [kept, setKept] = useState<ListFilters>(NO_FILTERS)
  const fromAddress = useMemo(() => filtersOf(params), [params])
  const filters = useMemo(() => quotesFiltersFor(lockHost, memory ? kept : fromAddress), [lockHost, memory, kept, fromAddress])
  // ---- end F-SA-277
  const grains = useMemo(() => grainsOf(session.permissions), [session.permissions])
  const can = useMemo(() => abilitiesOf(session.permissions), [session.permissions])
  const companyId = session.company?.id ?? session.companies[0]?.id ?? ''
  const [rows, setRows] = useState<QuotesListViewModel['rows']>({ items: null, more: false, problem: null })
  const [cursor, setCursor] = useState<string | null>(null)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [tiles, setTiles] = useState<Record<QuoteTile, TileCount>>(() => Object.fromEntries(Object.keys(TILE_READS).map((tile) => [tile, { count: null, more: false }])) as Record<QuoteTile, TileCount>)
  const [updates, setUpdates] = useState(0)
  const [notice, setNotice] = useState<QuotesListViewModel['notice']>(null)
  const [busy, setBusy] = useState(false)
  // F-SA-277: `?new=1` (the palette's "New quote") is the page's own term; a list in memory never reads the address.
  const [newQuote, setNewQuote] = useState<NewQuoteModel | null>(!memory && params?.get('new') === '1' && can.manage ? emptyNew(session.companies, companyId) : null)
  const filtersRef = useRef(filters)
  filtersRef.current = filters
  const duplicate = useDuplicate(api, companyId || null, (id) => router.push(`${prefix}/sales/quotes/${id}?tab=lines`))
  const newFrom = useNewFrom(api, session.permissions)

  const load = useCallback(
    async (more = false, after: string | null = null) => {
      const wanted = filtersRef.current
      try {
        // F-SA-224: the chosen customer; F-SA-277: the host's lock wins.
        const page = await listQuotes(api, quotesReadOf(lockHost, wanted), more ? after : null)
        if (wanted !== filtersRef.current) return
        setRows((current) => ({ items: more && current.items ? [...current.items, ...page.quotes] : page.quotes, more: page.nextCursor !== null, problem: null }))
        setCursor(page.nextCursor)
        if (!more) setAsOf(new Date().toISOString())
      } catch (error) {
        setRows((current) => ({ ...current, problem: readProblem(error) }))
      }
    },
    [api, lockHost],
  )

  // F-SA-224: the tiles count the chosen customer's quotes as the rows do (F-SA-277: the host's lock wins).
  const tileParty = quotesPartyOf(lockHost, filters)
  const loadTiles = useCallback(async () => {
    const today = romeToday()
    const entries = await Promise.all(
      (Object.keys(TILE_READS) as QuoteTile[]).map(async (tile): Promise<[QuoteTile, TileCount]> => {
        try {
          const all: QuoteListRow[] = []
          let next: string | null = null
          // At most 4 pages (200 rows) per tile: past that the tile says "200+".
          for (let page = 0; page < 4; page++) {
            const answer = await listQuotes(api, quotesTileReadOf(lockHost, { party: tileParty }, tile), next)
            all.push(...answer.quotes)
            next = answer.nextCursor
            if (!next) break
          }
          return [tile, tileCount(tile, all, next !== null, today, session.user.id)]
        } catch {
          return [tile, { count: null, more: false }]
        }
      }),
    )
    setTiles(Object.fromEntries(entries) as Record<QuoteTile, TileCount>)
  }, [api, session.user.id, tileParty, lockHost])

  useEffect(() => {
    setRows({ items: null, more: false, problem: null })
    void load()
  }, [filters, load])
  useEffect(() => {
    void loadTiles()
  }, [loadTiles])

  // ---- B-TH-257: the reader's own new messages per quote on the page (threads.read; one POST /threads/unread of ≤ 200 rows), read
  // again on a thread's live change (the same one connection).
  const readsThreads = session.permissions.includes('threads.read')
  const [unreadTick, setUnreadTick] = useState(0)
  const unreadRows = useMemo(() => (rows.items ?? []).map((row) => ({ recordType: 'Quote', id: row.id })), [rows.items])
  const unread = useUnread(readsThreads ? readUnreadWith(api) : null, unreadRows, unreadTick)
  // ---- end B-TH-257

  useLiveChanges({
    onChange: (change) => {
      if (isQuoteChange(change.type)) setUpdates((count) => count + 1)
      if (change.type.startsWith('thread.')) setUnreadTick((tick) => tick + 1) // B-TH-257
    },
    onReconnect: () => {
      setUpdates((count) => count + 1)
      setUnreadTick((tick) => tick + 1) // B-TH-257
    },
  })

  // F-SA-277: the page writes its address; a list in memory keeps its terms (the lock stays the host's).
  const go = (next: ListFilters) => (memory ? setKept(quotesFiltersFor(lockHost, next)) : router.replace(quotesAddress(base, next)))

  // ── F-SA-224: the Customer switcher — the customers the reader may see (GET /parties?role=CUSTOMER, searched on the server after
  // 250 ms), the chosen one's name from the rows, else its record (a customer the reader may not open: named by no one). ──
  const [customerQuery, setCustomerQuery] = useState('')
  const [customerSearched, setCustomerSearched] = useState('')
  const [customers, setCustomers] = useState<{ rows: PartyRow[] | null; problem: string | null }>({ rows: null, problem: null })
  useEffect(() => {
    const timer = setTimeout(() => setCustomerSearched(customerQuery.trim()), 250)
    return () => clearTimeout(timer)
  }, [customerQuery])
  useEffect(() => {
    if (lock) return // F-SA-277: a locked customer has no switcher (nothing to read)
    const abort = new AbortController()
    findCustomers(api, customerSearched, companyId || null, abort.signal)
      .then((found) => !abort.signal.aborted && setCustomers({ rows: found, problem: null }))
      .catch((error: unknown) => !abort.signal.aborted && setCustomers({ rows: [], problem: readProblem(error) }))
    return () => abort.abort()
  }, [api, customerSearched, companyId, lock])
  const chosen = filters.party ?? null
  const [chosenName, setChosenName] = useState<{ id: string; name: string | null } | null>(null)
  const inRows = chosen ? ((rows.items ?? []).find((row) => row.partyId === chosen)?.partyName ?? customers.rows?.find((row) => row.id === chosen)?.legalName ?? null) : null
  useEffect(() => {
    if (!chosen || inRows || chosenName?.id === chosen) return
    let gone = false
    getParty(api, chosen)
      .then((found) => !gone && setChosenName({ id: chosen, name: found.legalName }))
      .catch(() => !gone && setChosenName({ id: chosen, name: null }))
    return () => {
      gone = true
    }
  }, [api, chosen, inRows, chosenName?.id])
  const switcherState: SwitcherState = { customers: customers.rows?.map((row) => ({ id: row.id, code: row.code, name: row.tradeName ?? row.legalName, archived: row.status === 'ARCHIVED' })) ?? null, total: customers.rows?.length ?? 0, limited: false, problem: customers.problem }
  // ── end F-SA-224 ──

  // ---- New quote ------------------------------------------------------------------------------------------------------
  const searchSeq = useRef(0)
  const search = useCallback(
    (query: string, company: string) => {
      const mine = ++searchSeq.current
      setNewQuote((current) => (current ? { ...current, results: null, searchProblem: null } : current))
      findCustomers(api, query, company || null)
        .then((results) => mine === searchSeq.current && setNewQuote((current) => (current ? { ...current, results } : current)))
        .catch((error: unknown) => mine === searchSeq.current && setNewQuote((current) => (current ? { ...current, searchProblem: readProblem(error) } : current)))
    },
    [api],
  )
  const readNumber = useCallback(
    (company: string) => {
      setNewQuote((current) => (current ? { ...current, number: undefined } : current))
      nextNumber(api, company)
        .then((number) => setNewQuote((current) => (current && current.companyId === company ? { ...current, number } : current)))
        .catch(() => setNewQuote((current) => (current && current.companyId === company ? { ...current, number: null } : current)))
    },
    [api],
  )
  const openNew = (open: boolean) => {
    newFrom.reset()
    if (!open) {
      setNewQuote(null)
      if (!memory && params?.get('new')) router.replace(quotesAddress(base, filters)) // F-SA-277: the page's own term
      return
    }
    setNewQuote(emptyNew(session.companies, companyId))
    search('', companyId)
    readNumber(companyId)
  }
  useEffect(() => {
    if (newQuote && newQuote.results === null && newQuote.number === undefined) {
      search('', newQuote.companyId)
      readNumber(newQuote.companyId)
    }
    // Only on arrival with ?new=1 (the palette's "New quote").
  }, [])

  const pick = (partyId: string | null) => {
    newFrom.reset()
    if (!partyId) {
      setNewQuote((current) => (current ? { ...current, party: null, partyProblem: null, contactId: '' } : current))
      return
    }
    getParty(api, partyId)
      .then((party) => {
        const orders = party.contacts.find((contact) => contact.status === 'ACTIVE' && contact.roles.includes('ORDERS') && contact.email)
        setNewQuote((current) => (current ? { ...current, party, partyProblem: null, contactId: orders?.id ?? '', startFrom: 'blank', past: undefined } : current))
      })
      .catch((error: unknown) => setNewQuote((current) => (current ? { ...current, partyProblem: readProblem(error), problem: readProblem(error) } : current)))
  }

  // B-W2a-49 New quote › Start from a past quote: this customer's quotes, or any quote found by its number.
  const pastSeq = useRef(0)
  const readPast = (query: string) => {
    const party = newQuote?.party
    if (!party) return
    const mine = ++pastSeq.current
    setNewQuote((current) => (current?.past ? { ...current, past: { ...current.past, query, results: null, problem: null } } : current))
    listQuotes(api, query.trim() ? { q: query } : { partyId: party.id })
      .then((page) => mine === pastSeq.current && setNewQuote((current) => (current?.past ? { ...current, past: { ...current.past, results: page.quotes } } : current)))
      .catch((error: unknown) => mine === pastSeq.current && setNewQuote((current) => (current?.past ? { ...current, past: { ...current.past, problem: readProblem(error) } } : current)))
  }

  const create = () => {
    const draft = newQuote
    if (!draft?.party) return
    setNewQuote({ ...draft, busy: true, problem: null })
    const open = (id: string) => router.push(`${prefix}/sales/quotes/${id}?tab=lines`)
    const failed = (error: unknown) => setNewQuote((current) => (current ? { ...current, busy: false, problem: writeProblem(error).key } : current))
    // B-W2b-316: a template or an inquiry makes the quote in one call (what it left out is said before it opens).
    if (newFrom.active) {
      void newFrom.create({ companyId: draft.companyId, partyId: draft.party.id, contactId: draft.contactId, customerRef: draft.customerRef }, open).then((problem) => setNewQuote((current) => (current ? { ...current, busy: false, problem } : current)))
      return
    }
    const source = draft.startFrom === 'past' ? (draft.past?.results?.find((row) => row.id === draft.past?.chosenId) ?? null) : null
    if (source) {
      duplicateQuote(api, source.id, { ...(source.partyId !== draft.party.id ? { partyId: draft.party.id } : {}), contactId: draft.contactId || null, customerRef: draft.customerRef.trim() || null })
        .then((answer) => {
          if (answer.dropped.length === 0 && answer.warnings.length === 0) return open(answer.quote.id)
          setNewQuote((current) => (current?.past ? { ...current, busy: false, past: { ...current.past, done: { quoteId: answer.quote.id, number: answer.quote.number, lines: answer.quote.lines.length, dropped: answer.dropped, warnings: answer.warnings } } } : current))
        })
        .catch(failed)
      return
    }
    createQuote(api, { companyId: draft.companyId, partyId: draft.party.id, contactId: draft.contactId || null, customerRef: draft.customerRef.trim() || null })
      .then((quote) => open(quote.id))
      .catch(failed)
  }

  const model: QuotesListViewModel = {
    prefix,
    me: session.user.id,
    grains,
    can,
    filters,
    rows,
    tiles,
    asOf,
    today: romeToday(),
    updates,
    newQuote: newQuote ? { ...newQuote, newFrom: newFrom.model, newFromHeld: newFrom.held } : null,
    notice,
    busy,
    duplicate: duplicate.model,
    pageLinks: { prefix, promiseDates: session.permissions.includes('planning.promise.view') },
    embedded: !!host.embedded, // F-SA-277: the host draws what sits above the list
    // ---- B-TH-257
    unread: readsThreads ? unread : null,
    readsRequests: session.permissions.includes('sales.inquiries.view'),
    readsOrders: session.permissions.includes('orders.view'),
    // F-SA-224; F-SA-277: a host that locks the customer draws no switcher.
    switcher: lock ? null : { state: switcherState, query: customerQuery, searching: customerQuery.trim() !== customerSearched, partyName: chosen ? (inRows ?? (chosenName?.id === chosen ? chosenName.name : undefined)) : undefined },
  }

  const cancelMany = async (ids: readonly string[], reason: string): Promise<boolean> => {
    const chosen = (rows.items ?? []).filter((row) => ids.includes(row.id))
    setBusy(true)
    setNotice(null)
    let done = 0
    for (const row of chosen) {
      try {
        // One by one, each with the version it was read with: a quote moved meanwhile is refused, never overwritten.
        await cancelQuote(api, { id: row.id, version: row.version }, reason)
        done++
      } catch {
        // Counted below; the list is read again.
      }
    }
    setBusy(false)
    const failed = chosen.length - done
    setNotice(failed === 0 ? { key: 'list.bulk.cancelled', tone: 'success', params: { count: done } } : { key: 'list.bulk.cancelPartly', tone: 'warning', params: { done, failed } })
    setUpdates(0)
    void load()
    void loadTiles()
    return failed === 0
  }

  // F-SA-212: a page's pictures in ONE call (never the original); none yet or out of reach: the placeholder.
  const readPictures = useMemo(() => pictureReader(api), [api])

  // F-SA-225: Export N is the list frame's (the export job with the picked ids, exports/sources/quotes.ts): no CSV is made here.

  // F-SA-277: the host's row click (the customer page docks the quote's thread), else the quote opens (⌘ / Ctrl: a new tab).
  const openRow = (id: string, newTab: boolean) => {
    const row = host.onRowClick ? (rows.items ?? []).find((entry) => entry.id === id) : undefined
    if (host.onRowClick && row) return host.onRowClick(row, newTab)
    const href = `${prefix}/sales/quotes/${encodeURIComponent(id)}`
    if (newTab) window.open(href, '_blank', 'noopener')
    else router.push(href)
  }

  const actions: QuotesListActions & { onOpenRow: (id: string, newTab: boolean) => void } = {
    onFilters: go,
    onTile: (tile) => go({ ...filtersOfTile(tile), party: filters.party ?? null /* F-SA-224: a tile keeps the customer */ }),
    onCustomerSearch: setCustomerQuery, // F-SA-224
    onMore: () => void load(true, cursor),
    onRetry: () => {
      setRows({ items: null, more: false, problem: null })
      void load()
    },
    onShowUpdates: () => {
      setUpdates(0)
      void load()
      void loadTiles()
    },
    onNewQuote: openNew,
    onNewCompany: (company) => {
      setNewQuote((current) => (current ? { ...current, companyId: company, party: null, contactId: '' } : current))
      search('', company)
      readNumber(company)
    },
    onNewSearch: (query) => newQuote && search(query, newQuote.companyId),
    onNewPick: pick,
    onNewField: (field, value) => setNewQuote((current) => (current ? { ...current, [field]: value } : current)),
    onCreate: create,
    onDismissNotice: () => setNotice(null),
    // Enter on a row (and the number's link): the quote.
    onOpen: (id) => router.push(`${prefix}/sales/quotes/${id}`),
    // F-SA-277: the rest of a row (the view's row click once it names this action; until then its click is onOpen's).
    onOpenRow: openRow,
    onCancelMany: cancelMany,
    readPictures, // F-SA-212
    ...duplicate.actions,
    onDuplicateStart: (row) => duplicate.open({ id: row.id, number: row.number, partyId: row.partyId, partyName: row.partyName, revision: row.revision, versions: [] }),
    ...newFrom.actions,
    onNewFrom: (kind) => newFrom.choose(kind, { companyId: newQuote?.companyId ?? companyId, partyId: newQuote?.party?.id ?? null }),
    onStartFrom: (startFrom) => {
      newFrom.choose(null, { companyId, partyId: null })
      setNewQuote((current) => (current ? { ...current, startFrom, past: startFrom === 'past' ? (current.past ?? { query: '', results: null, problem: null, chosenId: '', done: null }) : current.past } : current))
      if (startFrom === 'past' && !newQuote?.past) setTimeout(() => readPast(''), 0)
    },
    onPastSearch: readPast,
    onPastPick: (quoteId) => setNewQuote((current) => (current?.past ? { ...current, past: { ...current.past, chosenId: quoteId } } : current)),
    onPastOpen: (quoteId) => router.push(`${prefix}/sales/quotes/${quoteId}?tab=lines`),
  }

  // F-SA-277: an embedding host's list tools read the list's own terms (its lock in) and write a saved view's back into its memory.
  const scope: ListScope = { query: quotesToolsQuery(lockHost, filters), onGoTo: (query) => setKept(quotesFromQuery(lockHost, query)) }

  return { model, actions, scope, embedded: !!host.embedded }
}

function emptyNew(companies: NewQuoteModel['companies'], companyId: string): NewQuoteModel {
  return { companies, companyId, results: null, searchProblem: null, party: null, partyProblem: null, contactId: '', customerRef: '', number: undefined, busy: false, problem: null }
}
