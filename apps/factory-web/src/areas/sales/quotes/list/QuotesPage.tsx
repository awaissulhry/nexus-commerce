'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { useLiveChanges } from '../../../../record-panels/live'
import { createQuote, findCustomers, getParty, listQuotes, nextNumber, QUOTE_STATUSES, type QuoteListRow, type QuoteStatus } from '../api'
import { abilitiesOf, filtersOfTile, grainsOf, romeToday, tileCount, type ListFilters, type QuoteTile, type TileCount } from '../model'
import { readProblem, writeProblem } from '../problems'
import type { NewQuoteModel, QuotesListViewModel } from './list-model'
import { QuotesListView } from './view/QuotesListView'

const TILE_READS: Record<QuoteTile, { status: QuoteStatus; mine?: boolean }> = {
  myDrafts: { status: 'DRAFT', mine: true },
  waiting: { status: 'PENDING_APPROVAL' },
  sent: { status: 'SENT' },
  expiring: { status: 'SENT' },
  accepted: { status: 'ACCEPTED' },
}

const isQuoteChange = (type: string) => type.startsWith('quote.') || type === 'deposit_request.created'

/** The filters in the address (`?status=SENT&mine=1&expiring=1&q=…`), so a filtered list can be shared and Back works. */
function filtersOf(params: URLSearchParams | null): ListFilters {
  const status = params?.get('status') ?? ''
  return {
    status: (QUOTE_STATUSES as readonly string[]).includes(status) ? (status as QuoteStatus) : null,
    mine: params?.get('mine') === '1',
    expiring: params?.get('expiring') === '1' && status === 'SENT',
    q: params?.get('q') ?? '',
  }
}

function searchOf(filters: ListFilters): string {
  const search = new URLSearchParams()
  if (filters.status) search.set('status', filters.status)
  if (filters.mine) search.set('mine', '1')
  if (filters.expiring) search.set('expiring', '1')
  if (filters.q.trim()) search.set('q', filters.q.trim())
  const text = search.toString()
  return text ? `?${text}` : ''
}

/**
 * `/w/<company>/sales/quotes` (SCR-034): reads the quotes the person may see (quotes.view over companies and customers;
 * the API filters), the tiles' counts (one read per tile's status, so each number is the list's total under that
 * filter; "200+" past one page), and keeps live changes behind "n updates · Show". New quote: the customer (parties),
 * its contacts and defaults, the number it will get (`GET /sales/quote-numbers/next`), then Create opens the record.
 */
export function QuotesPage() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const filters = useMemo(() => filtersOf(params), [params])
  const prefix = pathname.replace(/\/sales\/quotes\/?$/, '')
  const grains = useMemo(() => grainsOf(session.permissions), [session.permissions])
  const can = useMemo(() => abilitiesOf(session.permissions), [session.permissions])
  const companyId = session.company?.id ?? session.companies[0]?.id ?? ''
  const [rows, setRows] = useState<QuotesListViewModel['rows']>({ items: null, more: false, problem: null })
  const [cursor, setCursor] = useState<string | null>(null)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [tiles, setTiles] = useState<Record<QuoteTile, TileCount>>(() => Object.fromEntries(Object.keys(TILE_READS).map((tile) => [tile, { count: null, more: false }])) as Record<QuoteTile, TileCount>)
  const [updates, setUpdates] = useState(0)
  const [notice, setNotice] = useState<QuotesListViewModel['notice']>(null)
  const [newQuote, setNewQuote] = useState<NewQuoteModel | null>(params?.get('new') === '1' && can.manage ? emptyNew(session.companies, companyId) : null)
  const filtersRef = useRef(filters)
  filtersRef.current = filters

  const load = useCallback(
    async (more = false, after: string | null = null) => {
      const wanted = filtersRef.current
      try {
        const page = await listQuotes(api, { status: wanted.status ?? undefined, mine: wanted.mine, q: wanted.q }, more ? after : null)
        if (wanted !== filtersRef.current) return
        setRows((current) => ({ items: more && current.items ? [...current.items, ...page.quotes] : page.quotes, more: page.nextCursor !== null, problem: null }))
        setCursor(page.nextCursor)
        if (!more) setAsOf(new Date().toISOString())
      } catch (error) {
        setRows((current) => ({ ...current, problem: readProblem(error) }))
      }
    },
    [api],
  )

  const loadTiles = useCallback(async () => {
    const today = romeToday()
    const entries = await Promise.all(
      (Object.entries(TILE_READS) as Array<[QuoteTile, (typeof TILE_READS)[QuoteTile]]>).map(async ([tile, read]): Promise<[QuoteTile, TileCount]> => {
        try {
          const all: QuoteListRow[] = []
          let next: string | null = null
          // At most 4 pages (200 rows) per tile: past that the tile says "200+".
          for (let page = 0; page < 4; page++) {
            const answer = await listQuotes(api, { status: read.status, mine: read.mine }, next)
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
  }, [api, session.user.id])

  useEffect(() => {
    setRows({ items: null, more: false, problem: null })
    void load()
  }, [filters, load])
  useEffect(() => {
    void loadTiles()
  }, [loadTiles])

  useLiveChanges({
    onChange: (change) => {
      if (isQuoteChange(change.type)) setUpdates((count) => count + 1)
    },
    onReconnect: () => setUpdates((count) => count + 1),
  })

  const go = (next: ListFilters) => router.replace(`${pathname}${searchOf(next)}`)

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
    if (!open) {
      setNewQuote(null)
      if (params?.get('new')) router.replace(`${pathname}${searchOf(filters)}`)
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
    if (!partyId) {
      setNewQuote((current) => (current ? { ...current, party: null, partyProblem: null, contactId: '' } : current))
      return
    }
    getParty(api, partyId)
      .then((party) => {
        const orders = party.contacts.find((contact) => contact.status === 'ACTIVE' && contact.roles.includes('ORDERS') && contact.email)
        setNewQuote((current) => (current ? { ...current, party, partyProblem: null, contactId: orders?.id ?? '' } : current))
      })
      .catch((error: unknown) => setNewQuote((current) => (current ? { ...current, partyProblem: readProblem(error), problem: readProblem(error) } : current)))
  }

  const create = () => {
    const draft = newQuote
    if (!draft?.party) return
    setNewQuote({ ...draft, busy: true, problem: null })
    createQuote(api, { companyId: draft.companyId, partyId: draft.party.id, contactId: draft.contactId || null, customerRef: draft.customerRef.trim() || null })
      .then((quote) => router.push(`${prefix}/sales/quotes/${quote.id}?tab=lines`))
      .catch((error: unknown) => setNewQuote((current) => (current ? { ...current, busy: false, problem: writeProblem(error).key } : current)))
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
    newQuote,
    notice,
  }

  return (
    <QuotesListView
      model={model}
      actions={{
        onFilters: go,
        onTile: (tile) => go(filtersOfTile(tile)),
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
      }}
    />
  )
}

function emptyNew(companies: NewQuoteModel['companies'], companyId: string): NewQuoteModel {
  return { companies, companyId, results: null, searchProblem: null, party: null, partyProblem: null, contactId: '', customerRef: '', number: undefined, busy: false, problem: null }
}

