'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useLocale } from '../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { romeToday } from '../costing/model'
import { downloadText, useLive } from '../_shared/hooks'
import { getMargins, getOrderMargin, type Margins, type OrderMarginRow } from './api'
import { addressOf, liveTouches, marginsCanOf, marginsCsv, marginsHref, marginsQueryOf, readProblem, type MarginsAddress } from './model'
import { MarginsView, type MarginsModel, type OrderDetailState } from './view/MarginsView'

const SLOW_MS = 1000
const SEARCH_MS = 300

/**
 * `/w/<company>/finance/margins` (SCR-155): reads each order's margin with the tiles and the groups by customer and style
 * (one call: `GET /costing/margins` with the address's order dates, customer, style and search), 50 a page with Show
 * more; counts the live cost and order events behind "N updates · Show"; opens one order's profitability (`?open=`, J /
 * K over the list). Without costing.view it asks the API nothing (the view says why).
 */
export function MarginsPage() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const locale = useLocale()
  const prefix = pathname.replace(/\/finance\/margins\/?$/, '')
  const can = useMemo(() => marginsCanOf(session.permissions), [session.permissions])
  const address = useMemo(() => addressOf(params), [params])
  const companyId = session.company?.id ?? null
  const [margins, setMargins] = useState<{ value: Margins | null; problem: string | null; slow: boolean }>({ value: null, problem: null, slow: false })
  const [rows, setRows] = useState<OrderMarginRow[] | null>(null)
  const [cursor, setCursor] = useState<string | null>(null)
  const [readAt, setReadAt] = useState<number | null>(null)
  const [updates, setUpdates] = useState(0)
  const [detail, setDetail] = useState<OrderDetailState | null>(null)
  const [notice, setNotice] = useState<MarginsModel['notice']>(null)
  const asked = useRef(address)
  asked.current = address

  const load = useCallback(async () => {
    if (!can.view) return
    const target = asked.current
    const slow = setTimeout(() => setMargins((current) => (current.value || current.problem ? current : { ...current, slow: true })), SLOW_MS)
    try {
      const value = await getMargins(api, marginsQueryOf(target, companyId))
      if (asked.current !== target) return
      setMargins({ value, problem: null, slow: false })
      setRows(value.rows)
      setCursor(value.nextCursor)
      setReadAt(Date.now())
      setUpdates(0)
    } catch (error) {
      if (asked.current === target) {
        setMargins({ value: null, problem: readProblem(error), slow: false })
        setRows(null)
      }
    } finally {
      clearTimeout(slow)
    }
  }, [api, can.view, companyId])

  const filterKey = `${address.from}|${address.to}|${address.party}|${address.style}|${address.q}`
  useEffect(() => {
    setMargins({ value: null, problem: null, slow: false })
    setRows(null)
    void load()
  }, [load, filterKey])

  const readDetail = useCallback(
    (id: string) => {
      setDetail({ id, value: null, problem: null })
      getOrderMargin(api, id)
        .then((value) => setDetail((current) => (current?.id === id ? { id, value, problem: null } : current)))
        .catch((error: unknown) => setDetail((current) => (current?.id === id ? { id, value: null, problem: readProblem(error) } : current)))
    },
    [api],
  )
  useEffect(() => {
    if (!can.view) return
    if (!address.open) setDetail(null)
    else if (detail?.id !== address.open) readDetail(address.open)
  }, [address.open, can.view])

  const live = useLive(
    (change) => {
      if (liveTouches(change)) setUpdates((count) => count + 1)
    },
    () => void load(),
    can.view,
  )

  const go = (next: Partial<MarginsAddress>) => router.replace(marginsHref(prefix, { ...address, ...next }), { scroll: false })
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (searchTimer.current) clearTimeout(searchTimer.current)
    },
    [],
  )

  const more = async () => {
    if (!cursor) return
    try {
      const page = await getMargins(api, marginsQueryOf(address, companyId, cursor))
      setRows((current) => [...(current ?? []), ...page.rows.filter((row) => !current?.some((seen) => seen.order.id === row.order.id))])
      setCursor(page.nextCursor)
    } catch (error) {
      setNotice({ tone: 'danger', words: { key: readProblem(error) } })
    }
  }

  const model: MarginsModel = { prefix, can, today: romeToday(), address, margins, rows, more: cursor !== null, readAt, live, updates, detail, notice }
  return (
    <MarginsView
      model={model}
      actions={{
        onAddress: go,
        onSearch: (text) => {
          if (searchTimer.current) clearTimeout(searchTimer.current)
          searchTimer.current = setTimeout(() => go({ q: text.trim() || null }), SEARCH_MS)
        },
        onRetry: (part) => {
          if (part === 'margins') void load()
          if (part === 'detail' && address.open) readDetail(address.open)
        },
        onMore: () => void more(),
        onShowUpdates: () => {
          void load()
          if (address.open) readDetail(address.open)
        },
        onExport: (picked, words, fileName) => downloadText(fileName, marginsCsv(picked, can, words, locale)),
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}
