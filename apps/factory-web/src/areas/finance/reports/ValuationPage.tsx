'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useLocale } from '../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { downloadText, useLive } from '../_shared/hooks'
import { getLayers, getValuation, type Layers, type Valuation } from './api'
import { addressOf, layerKeyOf, liveTouches, readProblem, reportsCanOf, reportsHref, romeToday, rowId, valuationCsv, type ValuationAddress } from './model'
import { ValuationView, type HowValuedState, type ValuationActions, type ValuationModel } from './view/ValuationView'

/** The "Still loading…" note after about a second (design: GridSheetNote slow). */
const SLOW_MS = 1000
const SEARCH_MS = 300

/**
 * `/w/<company>/finance/reports` (SCR-239): reads the stock valuation of the company on the day in the address
 * (`?asOf=`, else today) with its filters (`?site=&category=&q=`), keeps the sites of the last read of every site for
 * the site choice, counts the live stock and cost events behind "N updates · Show", reads "How this lot is valued" when
 * a value cell opens it, and writes the CSV of the view or the rows chosen. Without inventory.stock.view it asks the API
 * nothing (the view says why).
 */
export function ValuationPage() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const locale = useLocale()
  const prefix = pathname.replace(/\/finance\/reports\/?$/, '')
  const can = useMemo(() => reportsCanOf(session.permissions), [session.permissions])
  const address = useMemo(() => addressOf(params), [params])
  const companyId = session.company?.id ?? null
  const [valuation, setValuation] = useState<{ value: Valuation | null; problem: string | null; slow: boolean }>({ value: null, problem: null, slow: false })
  const [readAt, setReadAt] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [sites, setSites] = useState<Array<{ id: string; code: string }>>([])
  const [updates, setUpdates] = useState(0)
  const [howValued, setHowValued] = useState<HowValuedState | null>(null)
  const asked = useRef(address)
  asked.current = address

  const load = useCallback(async () => {
    if (!can.view) return
    const target = asked.current
    const slow = setTimeout(() => setValuation((current) => (current.value || current.problem ? current : { ...current, slow: true })), SLOW_MS)
    try {
      const value = await getValuation(api, { asOf: target.asOf, companyId, siteId: target.site, category: target.category, q: target.q })
      if (asked.current !== target) return
      setValuation({ value, problem: null, slow: false })
      setReadAt(Date.now())
      setNow(Date.now())
      setUpdates(0)
      // The site choice: every site the person's stock is at, from a read of every site.
      if (!target.site && !target.category && !target.q) {
        const seen = new Map<string, { id: string; code: string }>()
        for (const row of value.rows) seen.set(row.site.id, row.site)
        setSites([...seen.values()].sort((a, b) => a.code.localeCompare(b.code)))
      }
    } catch (error) {
      if (asked.current === target) setValuation({ value: null, problem: readProblem(error), slow: false })
    } finally {
      clearTimeout(slow)
    }
  }, [api, can.view, companyId])

  useEffect(() => {
    setValuation({ value: null, problem: null, slow: false })
    setHowValued(null)
    void load()
  }, [load, address])

  // The site's code when the page opens on one site (no read of every site yet).
  useEffect(() => {
    const value = valuation.value
    if (!value || !address.site || sites.some((site) => site.id === address.site)) return
    const row = value.rows.find((entry) => entry.site.id === address.site)
    if (row) setSites((current) => [...current, row.site].sort((a, b) => a.code.localeCompare(b.code)))
  }, [valuation.value, address.site, sites])

  const live = useLive(
    (change) => {
      if (liveTouches(change)) setUpdates((count) => count + 1)
    },
    () => void load(),
    can.view,
  )

  const go = (next: Partial<ValuationAddress>) => router.replace(reportsHref(prefix, { ...address, ...next }), { scroll: false })
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (searchTimer.current) clearTimeout(searchTimer.current)
    },
    [],
  )

  const actions: ValuationActions = {
    onAsOf: (day) => go({ asOf: day }),
    onSite: (site) => go({ site }),
    onCategory: (category) => go({ category }),
    onGroup: (group) => go({ group }),
    onSearch: (text) => {
      if (searchTimer.current) clearTimeout(searchTimer.current)
      searchTimer.current = setTimeout(() => go({ q: text.trim() || null }), SEARCH_MS)
    },
    onRetry: () => void load(),
    onShowUpdates: () => void load(),
    onExport: (rows, words, fileName) => downloadText(fileName, valuationCsv(rows, can, words, locale)),
    onHowValued: (row) => {
      if (!row) {
        setHowValued(null)
        return
      }
      const key = layerKeyOf(row, address.asOf, can)
      if (!key) return
      const id = rowId(row)
      setHowValued({ key: id, value: null, problem: null })
      getLayers(api, key)
        .then((value: Layers) => setHowValued((current) => (current?.key === id ? { key: id, value, problem: null } : current)))
        .catch((error: unknown) => setHowValued((current) => (current?.key === id ? { key: id, value: null, problem: readProblem(error) } : current)))
    },
  }

  const model: ValuationModel = { prefix, can, today: romeToday(), address, sites, valuation, readAt, now, live, updates, howValued }
  return <ValuationView model={model} actions={actions} />
}
