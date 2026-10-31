'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../lib/api/client'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { romeToday } from '../costing/model'
import { useCoalesced, useLive } from '../_shared/hooks'
import {
  approveMany,
  createForeign,
  findSuppliers,
  getCounts,
  getSdiStatus,
  listInvoices,
  pickUpNow,
  uploadInvoicePdf,
  type InvoiceCounts,
  type InvoiceRow,
  type PickupAnswer,
  type SdiStatus,
} from './api'
import {
  addressOf,
  amountOf,
  EMPTY_FOREIGN,
  foreignProblems,
  invoiceHref,
  liveTouches,
  payablesCanOf,
  payablesHref,
  queryOf,
  readProblem,
  refusalPhrase,
  writeProblem,
  type PayablesAddress,
} from './model'
import { PayablesListView, type BulkAnswer, type ForeignModel, type PayablesListModel, type Part } from './view/PayablesListView'

const SLOW_MS = 1000
const SEARCH_MS = 300

/**
 * `/w/<company>/finance/payables` (SCR-153): reads the tiles (`GET /payables/invoices/counts`), the SDI pickup state
 * (`GET /payables/sdi`) and the invoices of the address (`?tile=&q=`, 50 a page with Show more); counts the live
 * supplier-invoice events behind "N updates · Show" (the tiles are read again at once). Writes: the bulk approval (each
 * invoice its own command; the answer per row in words), Pick up now, and "Add foreign invoice" (the PDF put on the
 * supplier, then ONE registration that copies it onto the invoice; the new record opens). Without payables.view it asks
 * the API nothing (the view says why).
 */
export function PayablesPage() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const prefix = pathname.replace(/\/finance\/payables\/?$/, '')
  const can = useMemo(() => payablesCanOf(session.permissions), [session.permissions])
  const address = useMemo(() => addressOf(params), [params])
  const companyId = session.company?.id ?? null
  const today = romeToday()

  const [counts, setCounts] = useState<Part<InvoiceCounts>>({ value: null, problem: null })
  const [sdi, setSdi] = useState<Part<SdiStatus>>({ value: null, problem: null })
  const [list, setList] = useState<{ problem: string | null; slow: boolean }>({ problem: null, slow: false })
  const [rows, setRows] = useState<InvoiceRow[] | null>(null)
  const [count, setCount] = useState<number | null>(null)
  const [cursor, setCursor] = useState<string | null>(null)
  const [readAt, setReadAt] = useState<number | null>(null)
  const [updates, setUpdates] = useState(0)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<PayablesListModel['notice']>(null)
  const [bulk, setBulk] = useState<BulkAnswer | null>(null)
  const [pickup, setPickup] = useState<PickupAnswer | null>(null)
  const [foreign, setForeign] = useState<ForeignModel>({ draft: EMPTY_FOREIGN, suppliers: null, problems: null, busy: false })
  const pdf = useRef<File | null>(null)
  const foreignKey = useRef(newIdempotencyKey())
  const asked = useRef(address)
  asked.current = address

  const loadTiles = useCallback(async () => {
    if (!can.view) return
    try {
      setCounts({ value: await getCounts(api, companyId), problem: null })
    } catch (error) {
      setCounts((current) => ({ value: current.value, problem: readProblem(error) }))
    }
    try {
      setSdi({ value: await getSdiStatus(api, companyId), problem: null })
    } catch (error) {
      setSdi({ value: null, problem: readProblem(error) })
    }
  }, [api, can.view, companyId])

  const loadList = useCallback(async () => {
    if (!can.view) return
    const target = asked.current
    const slow = setTimeout(() => setList((current) => ({ ...current, slow: true })), SLOW_MS)
    try {
      const page = await listInvoices(api, queryOf(target, companyId))
      if (asked.current !== target) return
      setRows(page.items)
      setCount(page.count)
      setCursor(page.nextCursor)
      setList({ problem: null, slow: false })
      setReadAt(Date.now())
      setUpdates(0)
    } catch (error) {
      if (asked.current === target) {
        setRows(null)
        setList({ problem: readProblem(error), slow: false })
      }
    } finally {
      clearTimeout(slow)
    }
  }, [api, can.view, companyId])

  const filterKey = `${address.tile}|${address.q}`
  useEffect(() => {
    setRows(null)
    setList({ problem: null, slow: false })
    void loadList()
  }, [loadList, filterKey])
  useEffect(() => {
    void loadTiles()
  }, [loadTiles])

  // "Add foreign invoice" opened: the suppliers and workshops are listed at once (the search narrows them).
  useEffect(() => {
    if (!address.adding || !can.manage || foreign.suppliers !== null) return
    findSuppliers(api, '')
      .then((found) => setForeign((current) => ({ ...current, suppliers: found })))
      .catch(() => setForeign((current) => ({ ...current, suppliers: [] })))
  }, [address.adding, can.manage, api])

  const tilesAgain = useCoalesced(() => void loadTiles(), 800)
  const live = useLive(
    (change) => {
      if (!liveTouches(change)) return
      setUpdates((current) => current + 1)
      tilesAgain()
    },
    () => {
      void loadTiles()
      void loadList()
    },
    can.view,
  )

  const go = (next: Partial<PayablesAddress>) => router.replace(payablesHref(prefix, { ...address, ...next }), { scroll: false })
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const supplierTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (searchTimer.current) clearTimeout(searchTimer.current)
      if (supplierTimer.current) clearTimeout(supplierTimer.current)
    },
    [],
  )

  const more = async () => {
    if (!cursor) return
    try {
      const page = await listInvoices(api, queryOf(address, companyId, cursor))
      setRows((current) => [...(current ?? []), ...page.items.filter((row) => !current?.some((seen) => seen.id === row.id))])
      setCursor(page.nextCursor)
    } catch (error) {
      setNotice({ tone: 'danger', phrases: writeProblem(error).phrases })
    }
  }

  const closeForeign = () => {
    pdf.current = null
    foreignKey.current = newIdempotencyKey()
    setForeign({ draft: EMPTY_FOREIGN, suppliers: null, problems: null, busy: false })
    go({ adding: false })
  }

  const submitForeign = async () => {
    const draft = foreign.draft
    if (!companyId || !draft.partyId || !pdf.current || foreignProblems(draft, today).length > 0) return
    setForeign((current) => ({ ...current, busy: true, problems: null }))
    try {
      const fileId = await uploadInvoicePdf(api, { companyId, partyId: draft.partyId }, pdf.current)
      const net = amountOf(draft.net)!
      const vat = amountOf(draft.vat, true)!
      const rate = draft.vatRate.trim().replace(',', '.')
      const zero = Number(rate) === 0
      const created = await createForeign(
        api,
        {
          companyId,
          partyId: draft.partyId,
          kind: draft.kind,
          number: draft.number.trim(),
          issueDate: draft.issueDate,
          currency: draft.currency,
          dueDate: draft.dueDate || null,
          netTotal: net,
          vatTotal: vat,
          grossTotal: net + vat,
          fileId,
          internalNote: draft.note.trim() || null,
          lines: [
            {
              kind: 'SERVICE',
              description: draft.description.trim(),
              itemCode: null,
              quantity: null,
              uom: null,
              unitPrice: null,
              netAmount: net,
              vatRatePct: rate,
              vatNature: zero ? draft.vatNature.trim() : null,
            },
          ],
        },
        foreignKey.current,
      )
      pdf.current = null
      foreignKey.current = newIdempotencyKey()
      setForeign({ draft: EMPTY_FOREIGN, suppliers: null, problems: null, busy: false })
      router.push(invoiceHref(prefix, created.id, 'lines'))
    } catch (error) {
      setForeign((current) => ({ ...current, busy: false, problems: writeProblem(error).phrases }))
    }
  }

  const model: PayablesListModel = {
    prefix,
    can,
    today,
    address,
    counts,
    sdi,
    list,
    rows,
    count,
    more: cursor !== null,
    readAt,
    live,
    updates,
    busy,
    notice,
    bulk,
    pickup,
    foreign: address.adding && can.manage ? foreign : null,
  }

  return (
    <PayablesListView
      model={model}
      actions={{
        onAddress: go,
        onSearch: (text) => {
          if (searchTimer.current) clearTimeout(searchTimer.current)
          searchTimer.current = setTimeout(() => go({ q: text.trim() || null }), SEARCH_MS)
        },
        onRetry: (part) => {
          if (part === 'list') void loadList()
          else void loadTiles()
        },
        onMore: () => void more(),
        onShowUpdates: () => {
          void loadList()
          void loadTiles()
        },
        onOpen: (row) => router.push(invoiceHref(prefix, row.id)),
        onApprove: (picked, clear) => {
          if (busy || picked.length === 0) return
          setBusy(true)
          setNotice(null)
          setBulk(null)
          void (async () => {
            try {
              const answer = await approveMany(
                api,
                picked.map((row) => ({ id: row.id, version: row.version })),
              )
              const numbers = new Map(picked.map((row) => [row.id, row.number]))
              setBulk({
                approved: answer.approved,
                refused: answer.results
                  .filter((result) => !result.approved)
                  .map((result) => ({
                    id: result.id,
                    number: numbers.get(result.id) ?? result.id,
                    phrases: result.refusals.length > 0 ? result.refusals.map((entry) => refusalPhrase(entry.code)) : [{ key: 'refusal.other' }],
                  })),
              })
              clear()
              await Promise.all([loadList(), loadTiles()])
            } catch (error) {
              setNotice({ tone: 'danger', phrases: writeProblem(error).phrases })
            } finally {
              setBusy(false)
            }
          })()
        },
        onPickUp: () => {
          if (busy || !companyId) return
          setBusy(true)
          setNotice(null)
          setPickup(null)
          void (async () => {
            try {
              setPickup(await pickUpNow(api, companyId))
              await Promise.all([loadList(), loadTiles()])
            } catch (error) {
              setNotice({ tone: 'danger', phrases: writeProblem(error).phrases })
            } finally {
              setBusy(false)
            }
          })()
        },
        onDismissNotice: () => setNotice(null),
        onDismissBulk: () => setBulk(null),
        onDismissPickup: () => setPickup(null),
        foreign: {
          onChange: (draft) => setForeign((current) => ({ ...current, draft, problems: null })),
          onSupplierQuery: (text) => {
            if (supplierTimer.current) clearTimeout(supplierTimer.current)
            supplierTimer.current = setTimeout(() => {
              findSuppliers(api, text)
                .then((found) => setForeign((current) => ({ ...current, suppliers: found })))
                .catch((error: unknown) => setForeign((current) => ({ ...current, suppliers: [], problems: [{ key: readProblem(error) }] })))
            }, SEARCH_MS)
          },
          onFile: (file) => {
            pdf.current = file
            setForeign((current) => ({ ...current, draft: { ...current.draft, fileName: file ? file.name : null } }))
          },
          onSubmit: () => void submitForeign(),
          onClose: closeForeign,
        },
      }}
    />
  )
}
