'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { isApiError } from '../../../../lib/api/errors'
import { formatDate } from '../../../../lib/i18n/format'
import { useLocale } from '../../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { RecordPanels } from '../../../../record-panels/RecordPanels'
import { useLive } from '../../../parties/_shared/hooks'
import { findCustomers, findStyles, getStyle } from '../../quotes/api'
import { activateVersion, compareVersions, getPriceList, getVersion, moveList, nextVersion, setCustomers, setPrices, type PriceEntry, type PriceListDetail, type PriceRow, type VersionAnswer } from '../api'
import { abilitiesOf, parseListPrice, raisePlan, romeToday, tabOf, versionToShow } from '../model'
import { PriceListsMessages, type Loaded } from '../parts'
import { readProblem, writeProblem } from '../problems'
import type { CellState, CompareView, CustomerPick, PriceListRecordModel, RecordDialog, StylePick } from './record-model'
import { PriceListRecordView } from './view/PriceListRecordView'

const NO_STYLE: StylePick = { query: '', results: null, problem: null, chosen: null, colourwayId: '', price: '' }
const NO_CUSTOMERS: CustomerPick = { query: '', results: null, problem: null, picked: [] }
const NO_COMPARE: CompareView = { beforeId: '', afterId: '', answer: null, problem: null, loading: false }

/**
 * `/w/<company>/sales/price-lists/<id>` (SCR-106 record; `?tab=prices|customers|versions|activity`, `?version=<id>` on
 * Prices): reads the list (pricelists.view; the API drops the money the person's grains do not reach), the version the
 * Prices tab shows, and — on Versions — how many rows each version changed against the one before. Writes are one at a
 * time, each with the version read (a 409 reads it again and says so, never overwrites): a price cell when it is left,
 * Raise by % and Remove N as ONE write of their rows, Add a price, customers given or taken, the next version, the
 * activation (ONE command: the version in force ends the day before), archive and reactivate. Live: the list's events
 * read it again; with a dialog open the page says it changed instead.
 */
export function PriceListRecord({ listId }: { listId: string }) {
  return (
    <PriceListsMessages>
      <PriceListRecordContainer listId={listId} />
    </PriceListsMessages>
  )
}

function PriceListRecordContainer({ listId }: { listId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const locale = useLocale()
  const fmt = (day: string | null | undefined) => (day ? formatDate(`${day}T12:00:00Z`, { locale }) : '')
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const tab = tabOf(params?.get('tab'))
  const askedVersion = params?.get('version') ?? null
  const prefix = pathname.replace(/\/sales\/price-lists\/[^/]+\/?$/, '')
  const can = useMemo(() => abilitiesOf(session.permissions), [session.permissions])
  const [list, setList] = useState<Loaded<PriceListDetail>>({ status: 'loading' })
  const listRef = useRef<PriceListDetail | null>(null)
  const [prices, setPricesState] = useState<PriceListRecordModel['prices']>({ answer: null, problem: null, loading: true })
  const answerRef = useRef<VersionAnswer | null>(null)
  const [changedRows, setChangedRows] = useState<Record<string, number | null>>({})
  const [asOf, setAsOf] = useState<string | null>(null)
  const [changedAt, setChangedAt] = useState<string | null>(null)
  const [notice, setNotice] = useState<PriceListRecordModel['notice']>(null)
  const [busy, setBusy] = useState(false)
  const [dialog, setDialogState] = useState<RecordDialog | null>(null)
  const [dialogProblem, setDialogProblem] = useState<PriceListRecordModel['dialogProblem']>(null)
  const [q, setQ] = useState('')
  const [selectedPrices, setSelectedPrices] = useState<readonly string[]>([])
  const [selectedCustomers, setSelectedCustomers] = useState<readonly string[]>([])
  const [cells, setCells] = useState<Record<string, CellState>>({})
  const [stylePick, setStylePick] = useState<StylePick>(NO_STYLE)
  const [customerPick, setCustomerPick] = useState<CustomerPick>(NO_CUSTOMERS)
  const [compare, setCompare] = useState<CompareView>(NO_COMPARE)
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  const inFlight = useRef(0)

  const value = list.status === 'ready' ? list.value : null
  const shown = value ? versionToShow(value, askedVersion) : null
  const companyId = value?.companyId ?? session.company?.id ?? null

  const loadList = useCallback(async () => {
    try {
      const next = await getPriceList(api, listId)
      listRef.current = next
      setList({ status: 'ready', value: next })
      setAsOf(new Date().toISOString())
      setChangedAt(null)
      setSelectedCustomers((current) => current.filter((id) => next.customers.some((customer) => customer.id === id)))
    } catch (error) {
      if (isApiError(error) && error.kind === 'not_found') setList({ status: 'not_found' })
      else if (isApiError(error) && error.kind === 'forbidden') setList({ status: 'forbidden' })
      else setList({ status: 'error', problem: readProblem(error) })
    }
  }, [api, listId])

  const loadPrices = useCallback(
    async (versionId: string) => {
      setPricesState((current) => ({ ...current, loading: true, problem: null }))
      try {
        const answer = await getVersion(api, listId, versionId)
        answerRef.current = answer
        setPricesState({ answer, problem: null, loading: false })
        setSelectedPrices((current) => current.filter((id) => answer.entries.some((entry) => entry.id === id)))
      } catch (error) {
        setPricesState((current) => ({ ...current, loading: false, problem: readProblem(error) }))
      }
    },
    [api, listId],
  )

  useEffect(() => {
    if (can.view) void loadList()
  }, [can.view, loadList])
  const shownKey = shown ? `${shown.id}:${shown.version}` : null
  useEffect(() => {
    if (shown) void loadPrices(shown.id)
    else setPricesState({ answer: null, problem: null, loading: false })
    // The shown version and its own version: a write elsewhere moves it.
  }, [shownKey, loadPrices])

  // Versions: how many rows each version changed against the one before (the API's compare).
  const versionsKey = value ? value.versions.map((version) => `${version.id}:${version.version}`).join(',') : ''
  useEffect(() => {
    if (tab !== 'versions' || !value) return
    const ordered = [...value.versions].sort((a, b) => a.revision - b.revision)
    let gone = false
    ordered.forEach((version, index) => {
      const before = ordered[index - 1]
      if (!before) return
      compareVersions(api, value.id, version.id, before.id)
        .then((answer) => !gone && setChangedRows((current) => ({ ...current, [version.id]: answer.changed })))
        .catch(() => !gone && setChangedRows((current) => ({ ...current, [version.id]: null })))
    })
    return () => {
      gone = true
    }
  }, [tab, versionsKey, api])

  const live = useLive(
    (change) => {
      if (!change.type.startsWith('price_list.') || change.fields.listId !== listId || inFlight.current > 0) return
      if (dialog) setChangedAt(new Date().toISOString())
      else {
        void loadList()
      }
    },
    () => {
      if (!dialog && inFlight.current === 0) void loadList()
    },
  )

  const setDialog = (next: RecordDialog | null) => {
    setDialogProblem(null)
    if (next?.kind === 'addPrice' && dialog?.kind !== 'addPrice') {
      setStylePick(NO_STYLE)
      searchStyles('')
    }
    if (next?.kind === 'addCustomers' && dialog?.kind !== 'addCustomers') {
      setCustomerPick(NO_CUSTOMERS)
      searchCustomers('')
    }
    if (next?.kind === 'compare' && dialog?.kind !== 'compare' && value) {
      const ordered = [...value.versions].sort((a, b) => b.revision - a.revision)
      const after = shown ?? ordered[0]
      const before = ordered.find((version) => after && version.revision < after.revision) ?? ordered[1] ?? after
      if (after && before) runCompare(before.id, after.id)
    }
    setDialogState(next)
  }

  // ---- writes ---------------------------------------------------------------------------------------------------------
  const enqueue = useCallback((work: () => Promise<unknown>) => {
    const next = queue.current.then(work, work)
    queue.current = next.catch(() => undefined)
    return next
  }, [])

  /** ONE write of a version's rows; true when the server took it. */
  const writePrices = useCallback(
    (rows: PriceRow[], done: PriceListRecordModel['notice'] | null, cellIds: readonly string[] = []) =>
      enqueue(async () => {
        const answer = answerRef.current
        if (!answer) return false
        inFlight.current++
        if (cellIds.length > 0) setCells((current) => ({ ...current, ...Object.fromEntries(cellIds.map((id) => [id, 'saving' as const])) }))
        try {
          const next = await setPrices(api, listId, answer.version, rows)
          answerRef.current = next
          setPricesState({ answer: next, problem: null, loading: false })
          setCells((current) => Object.fromEntries(Object.entries(current).filter(([id]) => !cellIds.includes(id))))
          if (done) setNotice(done)
          void loadList()
          return true
        } catch (error) {
          const problem = writeProblem(error, 'prices.refused')
          setCells((current) => ({ ...current, ...Object.fromEntries(cellIds.map((id) => [id, 'failed' as const])) }))
          if (dialog) setDialogProblem(problem.words)
          else setNotice({ tone: 'danger', words: problem.words })
          if (problem.reload && answerRef.current) void loadPrices(answerRef.current.version.id)
          return false
        } finally {
          inFlight.current--
        }
      }) as Promise<boolean>,
    [api, dialog, enqueue, listId, loadList, loadPrices],
  )

  const onPrice = (entry: PriceEntry, text: string) => {
    if (text.trim() === '') {
      setNotice({ tone: 'warning', words: { key: 'prices.emptyCell', params: { style: entry.style.code } } })
      return
    }
    const parsed = parseListPrice(text)
    if (parsed === null) {
      setCells((current) => ({ ...current, [entry.id]: 'failed' }))
      setNotice({ tone: 'warning', words: { key: 'prices.invalid', params: { style: entry.style.code } } })
      return
    }
    void writePrices([{ styleId: entry.styleId, colourwayId: entry.colourwayId, unitPrice: parsed }], null, [entry.id])
  }

  /** A list write (customers, archive): the record it answers replaces ours. */
  const listWrite = async (work: () => Promise<PriceListDetail>, done: PriceListRecordModel['notice'], refusedKey: string): Promise<boolean> => {
    setBusy(true)
    inFlight.current++
    setDialogProblem(null)
    try {
      const next = await work()
      listRef.current = next
      setList({ status: 'ready', value: next })
      setAsOf(new Date().toISOString())
      setNotice(done)
      setDialogState(null)
      return true
    } catch (error) {
      const problem = writeProblem(error, refusedKey)
      if (dialog) setDialogProblem(problem.words)
      else setNotice({ tone: 'danger', words: problem.words })
      if (problem.reload) void loadList()
      return false
    } finally {
      inFlight.current--
      setBusy(false)
    }
  }

  // ---- pickers --------------------------------------------------------------------------------------------------------
  const styleSeq = useRef(0)
  const searchStyles = (query: string) => {
    const mine = ++styleSeq.current
    setStylePick((current) => ({ ...current, query, results: null, problem: null }))
    findStyles(api, query, companyId)
      .then((results) => mine === styleSeq.current && setStylePick((current) => ({ ...current, results })))
      .catch((error: unknown) => mine === styleSeq.current && setStylePick((current) => ({ ...current, problem: readProblem(error) })))
  }
  const customerSeq = useRef(0)
  const searchCustomers = (query: string) => {
    const mine = ++customerSeq.current
    setCustomerPick((current) => ({ ...current, query, results: null, problem: null }))
    findCustomers(api, query, companyId)
      .then((results) => mine === customerSeq.current && setCustomerPick((current) => ({ ...current, results })))
      .catch((error: unknown) => mine === customerSeq.current && setCustomerPick((current) => ({ ...current, problem: readProblem(error) })))
  }
  const runCompare = (beforeId: string, afterId: string) => {
    setCompare({ beforeId, afterId, answer: null, problem: null, loading: beforeId !== afterId })
    if (beforeId === afterId) return
    compareVersions(api, listId, afterId, beforeId)
      .then((answer) => setCompare((current) => (current.beforeId === beforeId && current.afterId === afterId ? { ...current, answer, loading: false } : current)))
      .catch((error: unknown) => setCompare((current) => (current.beforeId === beforeId && current.afterId === afterId ? { ...current, problem: readProblem(error), loading: false } : current)))
  }

  const versionHref = (versionId: string, nextTab = 'prices') => `${prefix}/sales/price-lists/${encodeURIComponent(listId)}?tab=${nextTab}&version=${encodeURIComponent(versionId)}`

  const model: PriceListRecordModel = {
    prefix,
    tab,
    today: romeToday(),
    can,
    list: can.view ? list : { status: 'forbidden' },
    versionId: shown?.id ?? null,
    prices,
    changedRows,
    asOf,
    live,
    changedAt,
    notice,
    busy,
    dialog,
    dialogProblem,
    q,
    selectedPrices,
    selectedCustomers,
    cells,
    stylePick,
    customerPick,
    compare,
  }

  return (
    <PriceListRecordView
      model={model}
      panels={value && can.threads ? <RecordPanels record={{ type: 'PriceList', id: value.id, companyId: value.companyId, siteId: null }} title={`${value.code} · ${value.name}`} /> : null}
      actions={{
        onRetry: () => {
          setList({ status: 'loading' })
          void loadList()
        },
        onReload: () => {
          setDialogState(null)
          void loadList()
        },
        onRetryPrices: () => shown && void loadPrices(shown.id),
        onDismissNotice: () => setNotice(null),
        onDialog: setDialog,
        onVersion: (versionId) => router.replace(versionHref(versionId)),
        onSearch: setQ,
        onSelectPrices: setSelectedPrices,
        onSelectCustomers: setSelectedCustomers,
        onPrice,
        onRaise: (pct) => {
          const answer = answerRef.current
          if (!answer || !value) return
          const plan = raisePlan(answer.entries, selectedPrices, pct, value.currency)
          setBusy(true)
          void writePrices(
            plan.map((row) => ({ styleId: row.entry.styleId, colourwayId: row.entry.colourwayId, unitPrice: row.next })),
            { tone: 'success', words: { key: 'raise.done', params: { count: plan.length, pct } } },
          ).then((ok) => {
            setBusy(false)
            if (ok) {
              setDialogState(null)
              setSelectedPrices([])
            }
          })
        },
        onRemovePrices: () => {
          const answer = answerRef.current
          if (!answer) return
          const chosen = answer.entries.filter((entry) => selectedPrices.includes(entry.id))
          setBusy(true)
          void writePrices(
            chosen.map((entry) => ({ styleId: entry.styleId, colourwayId: entry.colourwayId, unitPrice: null })),
            { tone: 'success', words: { key: 'remove.done', params: { count: chosen.length } } },
          ).then((ok) => {
            setBusy(false)
            if (ok) {
              setDialogState(null)
              setSelectedPrices([])
            }
          })
        },
        onStyleQuery: searchStyles,
        onStylePick: (styleId) => {
          if (!styleId) {
            setStylePick((current) => ({ ...current, chosen: null, colourwayId: '', price: '' }))
            return
          }
          getStyle(api, styleId)
            .then((style) => setStylePick((current) => ({ ...current, chosen: style, colourwayId: '', price: '' })))
            .catch((error: unknown) => setStylePick((current) => ({ ...current, problem: readProblem(error) })))
        },
        onStyleField: (field, text) => setStylePick((current) => ({ ...current, [field]: text })),
        onAddPrice: () => {
          const chosen = stylePick.chosen
          const price = parseListPrice(stylePick.price)
          if (!chosen || price === null) return
          setBusy(true)
          void writePrices([{ styleId: chosen.id, colourwayId: stylePick.colourwayId || null, unitPrice: price }], { tone: 'success', words: { key: 'add.done', params: { style: chosen.code } } }).then((ok) => {
            setBusy(false)
            if (ok) setDialogState(null)
          })
        },
        onCustomerQuery: searchCustomers,
        onCustomerToggle: (partyId) => setCustomerPick((current) => ({ ...current, picked: current.picked.includes(partyId) ? current.picked.filter((id) => id !== partyId) : [...current.picked, partyId] })),
        onAddCustomers: () =>
          void listWrite(() => setCustomers(api, listId, customerPick.picked, 'add'), { tone: 'success', words: { key: 'customers.added', params: { count: customerPick.picked.length } } }, 'customers.refused'),
        onRemoveCustomers: () =>
          void listWrite(() => setCustomers(api, listId, selectedCustomers, 'remove'), { tone: 'success', words: { key: 'customers.removed', params: { count: selectedCustomers.length } } }, 'customers.refused').then((ok) => ok && setSelectedCustomers([])),
        onCompare: runCompare,
        onActivate: (days) => {
          const current = listRef.current
          const draft = current?.versions.find((version) => version.id === current.draftVersionId)
          if (!current || !draft) return
          setBusy(true)
          inFlight.current++
          activateVersion(api, listId, draft, { validFrom: days.validFrom, validTo: days.validTo || null })
            .then((answer) => {
              setDialogState(null)
              setNotice({
                tone: 'success',
                words: answer.ended
                  ? { key: 'activate.doneEnded', params: { revision: answer.version.revision, from: fmt(answer.version.validFrom), ended: answer.ended.revision, to: fmt(answer.ended.validTo) } }
                  : { key: 'activate.done', params: { revision: answer.version.revision, from: fmt(answer.version.validFrom) } },
              })
              void loadList()
              router.replace(versionHref(answer.version.id, tab))
            })
            .catch((error: unknown) => {
              const problem = writeProblem(error, 'activate.refused')
              setDialogProblem(problem.words)
              if (problem.reload) void loadList()
            })
            .finally(() => {
              inFlight.current--
              setBusy(false)
            })
        },
        onNextVersion: () => {
          const current = listRef.current
          if (!current) return
          const newest = [...current.versions].sort((a, b) => b.revision - a.revision)[0] ?? null
          setBusy(true)
          inFlight.current++
          nextVersion(api, listId, newest?.id ?? null)
            .then((answer) => {
              setNotice({ tone: 'success', words: { key: 'versions.made', params: { revision: answer.version.revision, count: answer.entries.length } } })
              void loadList()
              router.replace(versionHref(answer.version.id))
            })
            .catch((error: unknown) => {
              setNotice({ tone: 'danger', words: writeProblem(error, 'versions.refused').words })
              void loadList()
            })
            .finally(() => {
              inFlight.current--
              setBusy(false)
            })
        },
        onArchive: () => value && void listWrite(() => moveList(api, value, 'archive'), { tone: 'success', words: { key: 'archive.done', params: { code: value.code } } }, 'archive.refused'),
        onReactivate: () => value && void listWrite(() => moveList(api, value, 'reactivate'), { tone: 'success', words: { key: 'archive.reactivated', params: { code: value.code } } }, 'archive.refusedReactivate'),
        onCopyCode: () => {
          if (!value) return
          void navigator.clipboard?.writeText(value.code).then(
            () => setNotice({ tone: 'success', words: { key: 'record.copied', params: { code: value.code } } }),
            () => setNotice({ tone: 'warning', words: { key: 'record.copyFailed', params: { code: value.code } } }),
          )
        },
      }}
    />
  )
}
