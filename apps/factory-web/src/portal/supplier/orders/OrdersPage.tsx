'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../lib/api/client'
import { isApiError } from '../../../lib/api/errors'
import { WithMessages } from '../../../record-panels/i18n'
import { usePortalApi, usePortalBand, usePortalFrame, usePortalLive } from '../../shell/frame'
import { listBandOf } from './band'
import { confirmOrder, fetchOrders, isOrderChip, type OrderChip, type OrderRow, type OrdersRead } from './api'
import { confirmAllBody, listQuery, NS, ordersCsv, recordHref } from './model'
import { mayApprove, NotInAccessHere, saveText, useOffline } from './parts'
import { OrdersListView } from './view/OrdersListView'
import type { ConfirmAllModel } from './view/Dialogs'
import { useOrderWords } from './words'

/**
 * `/p/<party>/orders` for a supplier (B-W2b-179; design portal.supplier.orders): reads GET /portal/purchase-orders with the
 * chip and the search of the address, fills the band (Confirm waiting orders, Export this view), keeps the selection, runs
 * "Confirm as asked" for the selected orders (one command per order, each its own Idempotency-Key and version), and tells
 * of changes on the live channel without moving the rows.
 */
export function SupplierOrdersPage() {
  return (
    <WithMessages namespaces={[NS, 'ds-words']}>
      <OrdersContainer />
    </WithMessages>
  )
}

function OrdersContainer() {
  const frame = usePortalFrame()
  const api = usePortalApi()
  const router = useRouter()
  const pathname = usePathname() ?? ''
  const search = useSearchParams()
  const words = useOrderWords()
  const { t, locale } = words
  const offline = useOffline()
  const chipParam = search?.get('chip') ?? null
  const chip: OrderChip | null = isOrderChip(chipParam) ? chipParam : null
  const q = search?.get('q') ?? ''
  const allowed = frame.me.permissions.includes('portal.purchaseOrders.view')
  // The approve capability (B-W2b-162): known once the frame read My access; the API refuses in words anyway.
  const mayAnswer = mayApprove(frame)

  const [read, setRead] = useState<OrdersRead | null>(null)
  const [state, setState] = useState<'loading' | 'error' | 'ready' | 'forbidden'>('loading')
  const [selected, setSelected] = useState<string[]>([])
  const [updates, setUpdates] = useState(0)
  const [busy, setBusy] = useState(false)
  const [dialog, setDialog] = useState<ConfirmAllModel | null>(null)
  const dialogIds = useRef<string[]>([])
  const reading = useRef<AbortController | null>(null)

  const load = useCallback(async () => {
    reading.current?.abort()
    const control = new AbortController()
    reading.current = control
    try {
      const next = await fetchOrders(api, { chip, q }, control.signal)
      if (control.signal.aborted) return
      setRead(next)
      setState('ready')
      setUpdates(0)
      setSelected((current) => current.filter((id) => next.items.some((row) => row.id === id)))
    } catch (error) {
      if (control.signal.aborted) return
      setState(isApiError(error) && error.kind === 'forbidden' ? 'forbidden' : 'error')
    }
  }, [api, chip, q])

  useEffect(() => {
    if (!allowed) return
    setState((current) => (current === 'ready' ? current : 'loading'))
    void load()
    return () => reading.current?.abort()
  }, [load, allowed])

  usePortalLive({ onChange: (change) => (read?.live.events.includes(change.type) ? setUpdates((count) => count + 1) : undefined), onReconnect: () => setUpdates((count) => count + 1) }, allowed)

  const go = (nextChip: OrderChip | null, nextQ: string) => router.replace(`${pathname}${listQuery(nextChip, nextQ)}`, { scroll: false })
  const rows = read?.items ?? []
  const waiting = read?.counts.toConfirm ?? 0

  const openConfirm = useCallback(
    (ids: readonly string[]) => {
      const picked = (read?.items ?? []).filter((row) => ids.includes(row.id) && row.canAnswer)
      if (picked.length === 0) return
      dialogIds.current = picked.map((row) => row.id)
      setDialog({ orders: picked.map((row) => ({ id: row.id, documentNumber: row.documentNumber, lines: null, lineCount: row.lines })), supplierRef: '', person: frame.me.user.displayName, busy: false, heldReason: null, problem: null, result: null })
    },
    [read, frame.me.user.displayName],
  )

  const confirmGo = async () => {
    const ids = dialogIds.current
    const picked = (read?.items ?? []).filter((row) => ids.includes(row.id))
    if (picked.length === 0 || busy) return
    setBusy(true)
    setDialog((current) => (current ? { ...current, busy: true, heldReason: t('held.busy') } : current))
    let confirmed = 0
    let refused = 0
    let problem: string | null = null
    for (const row of picked) {
      try {
        await confirmOrder(api, row.id, confirmAllBody(row.version), newIdempotencyKey())
        confirmed++
      } catch (error) {
        refused++
        problem = isApiError(error) ? error.kind : 'internal'
      }
    }
    setBusy(false)
    if (picked.length === 1 && refused === 1) {
      setDialog((current) => (current ? { ...current, busy: false, heldReason: null, problem: problem === 'conflict' ? 'changed' : problem === 'forbidden' ? 'forbidden' : 'internal' } : current))
    } else {
      setDialog((current) => (current ? { ...current, busy: false, heldReason: null, result: { confirmed, refused } } : current))
      if (picked.length === 1) setDialog(null)
    }
    setSelected([])
    frame.refreshTasks()
    void load()
  }

  // `c` on a focused order: confirm it as asked (asks first).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'c' || event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.closest('[role="dialog"], [role="menu"]'))) return
      const id = (document.activeElement?.closest('[row-id]') as HTMLElement | null)?.getAttribute('row-id') ?? (selected.length === 1 ? selected[0] : null)
      if (!id) return
      event.preventDefault()
      openConfirm([id])
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openConfirm, selected])

  const exportRows = (ids: readonly string[] | null) => {
    const shown = ids ? rows.filter((row) => ids.includes(row.id)) : rows
    saveText(`${t('list.fileName')}.csv`, ordersCsv(shown, t, locale))
  }

  const onWaitingChip = chip === 'TO_CONFIRM' || (chip === null && read?.chip === 'TO_CONFIRM')
  usePortalBand(
    allowed && state !== 'forbidden'
      ? listBandOf({
          t,
          locale,
          asOf: read?.asOf ?? null,
          waiting,
          onWaitingChip,
          confirmHeld: frame.me.preview ? t('held.preview') : !mayAnswer ? t('held.mayAnswer') : offline ? t('held.offline') : null,
          rows: rows.length,
          onConfirm: () => openConfirm(rows.filter((row) => row.canAnswer).map((row) => row.id)),
          onChip: (next) => go(next, ''),
          onExport: () => exportRows(null),
        })
      : { title: t('list.title') },
  )

  if (!allowed || state === 'forbidden') return <NotInAccessHere />

  const open = (row: OrderRow) => router.push(recordHref(frame.prefix, row.id, row.canAnswer ? 'confirm' : 'lines'))

  return (
    <OrdersListView
      model={{
        state: state === 'loading' && !read ? 'loading' : state === 'error' ? 'error' : 'ready',
        read,
        chip,
        q,
        prefix: frame.prefix,
        selected,
        facts: { mayAnswer, preview: frame.me.preview, offline },
        busy,
        dialog,
        updates,
      }}
      actions={{
        onChip: (next) => go(next, q),
        onSearch: (next) => go(chip, next),
        onSelect: setSelected,
        onOpen: open,
        onRetry: () => {
          setState('loading')
          void load()
        },
        onShowUpdates: () => void load(),
        onConfirm: openConfirm,
        onConfirmGo: () => void confirmGo(),
        onCloseDialog: () => (busy ? undefined : setDialog(null)),
        onExport: exportRows,
      }}
    />
  )
}
