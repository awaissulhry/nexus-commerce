'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { WithMessages } from '../../../../record-panels/i18n'
import { storeUrl } from '../../../../record-panels/store'
import { downloadText, useCoalesced, useLive } from '../../../_shared/buying/hooks'
import { csvOf } from '../../../_shared/buying/model'
import { claimCounts, claimReasons, ddtPdfLink, findLots, listClaims, lotHides, lotStock, receiptNumber, returnToSupplier, supplierContacts, type ClaimCounts, type ClaimKind, type LotRow } from '../api'
import {
  claimQuery,
  claimsAddress,
  claimsCan,
  filtersOf,
  isHideLot,
  LOADING,
  NO_RETURN,
  pickedLot,
  readWords,
  ready,
  reasonWords,
  returnBody,
  returnHeld,
  returnRefusal,
  viewFromAddress,
  withHides,
  withStock,
  words,
  type ClaimFilters,
  type ClaimsListModel,
  type ClaimView,
  type ReturnDialogModel,
  type ReturnDraft,
} from '../model'
import { ClaimsListView } from './view/ClaimsListView'

const TIME_ZONE = 'Europe/Rome'

/**
 * `/w/<company>/purchasing/claims` (SCR-131): the saved view (`?view=`, or the API's own `?status=`), the kind
 * (`?kind=RETURN|CLAIM`), one receipt's or one lot's claims (`?receipt=`, `?lot=`: every state unless a view says
 * otherwise), the search (`?q=`), 50 a page with "Show more", the tiles (GET /purchasing/claims/counts), and live
 * supplier_claim.* events behind "N updates · Show". `?return=1` opens Return to supplier (`&lot=` picks that lot): ONE
 * POST /purchasing/claims/returns with one Idempotency-Key per dialog.
 */
export function ClaimsPage() {
  return (
    <WithMessages namespaces={['purchasing-claims', 'lists']}>
      <Container />
    </WithMessages>
  )
}

function Container() {
  const t = useT('purchasing-claims')
  const locale = useLocale()
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const prefix = pathname.replace(/\/purchasing\/claims\/?$/, '')
  const can = useMemo(() => claimsCan(session.permissions), [session.permissions])
  const view = viewFromAddress(params)
  const filters = filtersOf(params)
  const filterKey = `${filters.q}|${filters.kind ?? ''}|${filters.receipt ?? ''}|${filters.lot ?? ''}`
  const returnAsked = params?.get('return') === '1'

  const [rows, setRows] = useState<ClaimsListModel['rows']>({ items: null, more: false, problem: null })
  const [cursor, setCursor] = useState<string | null>(null)
  const [counts, setCounts] = useState<ClaimCounts | null>(null)
  const [countsProblem, setCountsProblem] = useState<string | null>(null)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [updates, setUpdates] = useState(0)
  const [notice, setNotice] = useState<ClaimsListModel['notice']>(null)
  const [receiptLabel, setReceiptLabel] = useState<string | null>(null)
  const [lotLabel, setLotLabel] = useState<string | null>(null)
  const [ret, setRet] = useState<ReturnDialogModel | null>(null)
  const retRef = useRef(ret)
  retRef.current = ret
  const returnKey = useRef(newIdempotencyKey())
  const readId = useRef(0)

  const go = useCallback((nextView: ClaimView, nextFilters: ClaimFilters, returnOpen = false) => router.replace(claimsAddress(pathname, nextView, nextFilters, { returnOpen })), [router, pathname])

  const loadCounts = useCallback(() => {
    claimCounts(api)
      .then((value) => {
        setCounts(value)
        setCountsProblem(null)
      })
      .catch((error: unknown) => {
        setCounts(null)
        setCountsProblem(readWords(error))
      })
  }, [api])

  const load = useCallback(async () => {
    if (!can.view) return
    const id = ++readId.current
    loadCounts()
    try {
      const page = await listClaims(api, claimQuery(view, filtersOf(params)))
      if (id !== readId.current) return
      setRows({ items: page.items, more: page.nextCursor !== null, problem: null })
      setCursor(page.nextCursor)
      setAsOf(new Date().toISOString())
      setUpdates(0)
    } catch (error) {
      if (id !== readId.current) return
      setRows({ items: null, more: false, problem: readWords(error) })
    }
    // The address terms are read through `filterKey` and `view`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, can.view, view, filterKey, loadCounts])

  useEffect(() => {
    setRows({ items: null, more: false, problem: null })
    void load()
  }, [load])

  // The chips' words: the receipt's number (inventory.stock.view), the lot's code (from the rows, else its record).
  useEffect(() => {
    setReceiptLabel(null)
    if (!filters.receipt || !can.stock) return
    const controller = new AbortController()
    receiptNumber(api, filters.receipt, controller.signal)
      .then(setReceiptLabel)
      .catch(() => setReceiptLabel(null))
    return () => controller.abort()
  }, [api, filters.receipt, can.stock])
  useEffect(() => {
    if (!filters.lot) return setLotLabel(null)
    const fromRows = rows.items?.flatMap((row) => row.lots).find((lot) => lot.id === filters.lot)
    if (fromRows) return setLotLabel(fromRows.code)
    if (!can.stock) return
    const controller = new AbortController()
    lotStock(api, filters.lot, controller.signal)
      .then((record) => setLotLabel(record.lot.code))
      .catch(() => undefined)
    return () => controller.abort()
  }, [api, filters.lot, rows.items, can.stock])

  const more = useCallback(async () => {
    if (!cursor) return
    try {
      const page = await listClaims(api, claimQuery(view, filtersOf(params), cursor))
      setRows((current) => ({ items: [...(current.items ?? []), ...page.items.filter((row) => !current.items?.some((seen) => seen.id === row.id))], more: page.nextCursor !== null, problem: null }))
      setCursor(page.nextCursor)
    } catch (error) {
      setNotice({ tone: 'danger', words: words(readWords(error)) })
    }
  }, [api, cursor, view, params])

  // Live: a claim made, sent, answered, returned, closed: the tiles follow at once, the rows wait behind "N updates · Show".
  const refresh = useCoalesced(loadCounts, 800)
  const live = useLive(
    (change) => {
      if (!change.type.startsWith('supplier_claim.')) return
      setUpdates((count) => count + 1)
      refresh()
    },
    () => void load(),
    can.view,
  )

  // ---- Return to supplier -------------------------------------------------------------------------------------------------------

  const patchRet = (next: (draft: ReturnDraft) => ReturnDraft) => setRet((current) => (current ? { ...current, draft: next(current.draft), problem: null } : current))

  const loadLot = useCallback(
    (lot: LotRow) => {
      lotStock(api, lot.id)
        .then((record) => patchRet((draft) => (draft.lot?.id === lot.id ? withStock(draft, ready(record.stock)) : draft)))
        .catch((error: unknown) => patchRet((draft) => (draft.lot?.id === lot.id ? withStock(draft, { value: null, problem: readWords(error) }) : draft)))
      if (isHideLot(lot)) {
        lotHides(api, lot.id)
          .then((hides) => patchRet((draft) => (draft.lot?.id === lot.id ? withHides(draft, ready(hides)) : draft)))
          .catch((error: unknown) => patchRet((draft) => (draft.lot?.id === lot.id ? withHides(draft, { value: null, problem: readWords(error) }) : draft)))
      }
    },
    [api],
  )

  const loadContacts = useCallback(() => {
    const lot = retRef.current?.draft.lot
    if (!lot?.supplier || !can.parties) return
    patchRet((draft) => ({ ...draft, contacts: LOADING }))
    supplierContacts(api, lot.supplier.id)
      .then((contacts) => patchRet((draft) => (draft.lot?.id === lot.id ? { ...draft, contacts: ready(contacts), contactIds: contacts.filter((contact) => contact.roles.includes('QUALITY')).map((contact) => contact.id).slice(0, 1) } : draft)))
      .catch((error: unknown) => patchRet((draft) => ({ ...draft, contacts: { value: null, problem: readWords(error) } })))
  }, [api, can.parties])

  const pick = useCallback(
    (lot: LotRow | null) => {
      patchRet((draft) => pickedLot(draft, lot))
      if (lot) {
        loadLot(lot)
        if (retRef.current?.draft.mail) setTimeout(loadContacts, 0)
      }
    },
    [loadLot, loadContacts],
  )

  // `?return=1` opens the dialog (once per opening), with its reasons and the lot the address names.
  useEffect(() => {
    if (!returnAsked) {
      setRet(null)
      return
    }
    if (retRef.current) return
    returnKey.current = newIdempotencyKey()
    setRet({ draft: NO_RETURN, busy: false, problem: null, result: null })
    claimReasons(api)
      .then((reasons) => patchRet((draft) => ({ ...draft, reasons: ready(reasons) })))
      .catch((error: unknown) => patchRet((draft) => ({ ...draft, reasons: { value: null, problem: readWords(error) } })))
    const lotId = filters.lot
    if (lotId && can.stock) {
      lotStock(api, lotId)
        .then((record) => {
          patchRet((draft) => withStock(pickedLot(draft, record.lot), ready(record.stock)))
          if (isHideLot(record.lot)) {
            lotHides(api, lotId)
              .then((hides) => patchRet((draft) => (draft.lot?.id === lotId ? withHides(draft, ready(hides)) : draft)))
              .catch((error: unknown) => patchRet((draft) => withHides(draft, { value: null, problem: readWords(error) })))
          }
        })
        .catch(() => undefined)
    }
    // Opened by the address only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [returnAsked])

  const search = useCallback(
    (q: string) => {
      patchRet((draft) => ({ ...draft, q, found: q.trim().length < 2 ? null : LOADING }))
      if (q.trim().length < 2) return
      findLots(api, q.trim())
        .then((lots) => patchRet((draft) => (draft.q === q ? { ...draft, found: ready(lots) } : draft)))
        .catch((error: unknown) => patchRet((draft) => (draft.q === q ? { ...draft, found: { value: null, problem: readWords(error) } } : draft)))
    },
    [api],
  )

  const create = useCallback(async () => {
    const current = retRef.current
    if (!current || current.busy || returnHeld(current.draft, can)) return
    setRet({ ...current, busy: true, problem: null })
    try {
      const result = await returnToSupplier(api, returnBody(current.draft), returnKey.current)
      setRet((latest) => (latest ? { ...latest, busy: false, result } : latest))
      void load()
    } catch (error) {
      returnKey.current = newIdempotencyKey()
      setRet((latest) => (latest ? { ...latest, busy: false, problem: returnRefusal(error) } : latest))
    }
  }, [api, can, load])

  const openDdt = useCallback(
    async (ddtId: string) => {
      try {
        const link = await ddtPdfLink(api, ddtId)
        const anchor = document.createElement('a')
        anchor.href = storeUrl(link.url)
        anchor.target = '_blank'
        anchor.rel = 'noopener'
        document.body.append(anchor)
        anchor.click()
        anchor.remove()
      } catch (error) {
        setNotice({ tone: 'danger', words: words(readWords(error)) })
      }
    },
    [api],
  )

  const exportRows = useCallback(
    (ids: string[]) => {
      const picked = (rows.items ?? []).filter((row) => ids.includes(row.id))
      const header = ['number', 'kind', 'status', 'supplier', 'lots', 'materials', 'reason', 'note', 'quantity', 'unit', 'lines', 'returned', 'remedy', ...(can.cost ? ['value', 'credit', 'currency'] : []), 'created', 'age'].map((column) => t(`csv.${column}`))
      const lines = picked.map((row) => {
        const reason = reasonWords(row.reason, locale)
        return [
          row.number,
          t(`kind.${row.kind}`),
          t(`status.${row.status}`),
          row.supplier.name,
          row.lots.map((lot) => lot.code).join(', '),
          row.materials.map((item) => item.code).join(', '),
          reason.label ?? '',
          reason.note ?? '',
          row.quantity?.quantity ?? '',
          row.quantity?.uom ?? '',
          row.lines,
          row.returned,
          row.remedy ? t(`remedy.${row.remedy}`) : '',
          ...(can.cost ? [row.value != null ? (row.value / 100).toFixed(2) : '', row.expectedCreditAmount != null ? (row.expectedCreditAmount / 100).toFixed(2) : '', row.currency] : []),
          row.createdAt.slice(0, 10),
          row.ageDays,
        ]
      })
      downloadText(`claims-${new Date().toISOString().slice(0, 10)}.csv`, csvOf(header, lines))
    },
    [rows.items, can.cost, t, locale],
  )

  const model: ClaimsListModel = { prefix, can, view, filters, chips: { receipt: receiptLabel, lot: lotLabel }, rows, counts, countsProblem, asOf, live, updates, notice, ret, timeZone: TIME_ZONE }

  return (
    <ClaimsListView
      model={model}
      actions={{
        onView: (next) => go(next, filters),
        onSearch: (q) => go(view, { ...filters, q }),
        onKind: (kind: ClaimKind | null) => go(view, { ...filters, kind }),
        onClearFilter: (which) => {
          if (which === 'all') return go('open', { q: '', kind: null, receipt: null, lot: null })
          const next = { ...filters, [which]: null }
          go(view === 'all' && !next.receipt && !next.lot ? 'open' : view, next)
        },
        onMore: () => void more(),
        onRetry: () => void load(),
        onShowUpdates: () => void load(),
        onOpen: (id) => router.push(`${prefix}/purchasing/claims/${id}`),
        onExport: exportRows,
        onDismissNotice: () => setNotice(null),
        onReturn: (open) => go(view, filters, open),
        onReturnDraft: (draft) => setRet((current) => (current ? { ...current, draft, problem: null } : current)),
        onReturnSearch: search,
        onReturnPick: pick,
        onReturnContacts: loadContacts,
        onReturnCreate: () => void create(),
        onOpenDdt: (ddtId) => void openDdt(ddtId),
      }}
    />
  )
}
