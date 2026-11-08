'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../lib/api/client'
import { isApiError } from '../../../lib/api/errors'
import { WithMessages } from '../../../record-panels/i18n'
import { usePortalApi, usePortalBand, usePortalFrame, usePortalLive } from '../../shell/frame'
import { NotInAccessHere, saveText, useOffline } from '../orders/parts'
import { cancelNotice, fetchNotices, isNoticeState, type NoticeRow, type NoticeState, type NoticesRead } from './api'
import { listBandOf } from './band'
import { cancelHeld, listQuery, noticesCsv, NS, problemOf, rowHref, writeHeld } from './model'
import { DeliveriesListView } from './view/DeliveriesListView'
import type { CancelModel } from './view/Dialogs'
import { useDeliveryWords } from './words'

/**
 * `/p/<party>/deliveries` for a supplier (B-W2b-186; design portal.supplier.asn): reads GET /portal/ship-notices with the state
 * and the search of the address, fills the band (Announce delivery, ⋯ the packing list template), keeps the selection
 * (Export N), cancels a notice before receipt from its ⋯ (one command, its Idempotency-Key and version), and tells of
 * changes on the live channel (a receipt posted by our warehouse) without moving the rows.
 */
export function SupplierDeliveriesPage() {
  return (
    <WithMessages namespaces={[NS, 'ds-words']}>
      <DeliveriesContainer />
    </WithMessages>
  )
}

function DeliveriesContainer() {
  const frame = usePortalFrame()
  const api = usePortalApi()
  const router = useRouter()
  const pathname = usePathname() ?? ''
  const search = useSearchParams()
  const words = useDeliveryWords()
  const { t, locale } = words
  const offline = useOffline()
  const stateParam = search?.get('state') ?? null
  const chip: NoticeState | null = isNoticeState(stateParam) ? stateParam : null
  const q = search?.get('q') ?? ''
  const allowed = frame.me.permissions.includes('portal.shipNotices.view')

  const [read, setRead] = useState<NoticesRead | null>(null)
  const [state, setState] = useState<'loading' | 'error' | 'ready' | 'forbidden'>('loading')
  const [selected, setSelected] = useState<string[]>([])
  const [updates, setUpdates] = useState(0)
  const [dialog, setDialog] = useState<Omit<CancelModel, 'heldReason'> | null>(null)
  const reading = useRef<AbortController | null>(null)
  const cancelKey = useRef<string | null>(null)

  const load = useCallback(async () => {
    reading.current?.abort()
    const control = new AbortController()
    reading.current = control
    try {
      const next = await fetchNotices(api, { state: chip, q }, control.signal)
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

  const facts = { mayWrite: read?.mayWrite ?? true, preview: frame.me.preview, offline, busy: dialog?.busy ?? false }
  usePortalBand(allowed && state !== 'forbidden' ? listBandOf({ t, locale, asOf: read?.asOf ?? null, prefix: frame.prefix, announceHeld: (() => { const held = writeHeld({ ...facts, busy: false }); return held ? t(held) : null })() }) : { title: t('list.title') })

  if (!allowed || state === 'forbidden') return <NotInAccessHere />

  const go = (nextState: NoticeState | null, nextQ: string) => router.replace(`${pathname}${listQuery(nextState, nextQ)}`, { scroll: false })
  const rows = read?.items ?? []

  const openCancel = (row: NoticeRow) => {
    cancelKey.current = null
    setDialog({ target: { id: row.id, number: row.number, status: row.status, version: row.version, orderNumber: row.purchaseOrder.number }, reason: '', busy: false, problem: null })
  }

  const confirmCancel = async () => {
    if (!dialog || dialog.busy) return
    if (cancelHeld(dialog.target, dialog.reason, facts)) return
    const body = { version: dialog.target.version, reason: dialog.reason.trim() === '' ? null : dialog.reason.trim() }
    cancelKey.current ??= newIdempotencyKey()
    setDialog({ ...dialog, busy: true, problem: null })
    try {
      await cancelNotice(api, dialog.target.id, body, cancelKey.current)
      cancelKey.current = null
      setDialog(null)
      void load()
    } catch (error) {
      setDialog((current) => (current ? { ...current, busy: false, problem: problemOf(isApiError(error) ? error.kind : null) } : current))
    }
  }

  const exportRows = (ids: readonly string[] | null) => {
    const shown = ids ? rows.filter((row) => ids.includes(row.id)) : rows
    saveText(`${t('list.fileName')}.csv`, noticesCsv(shown, t))
  }

  return (
    <DeliveriesListView
      model={{
        state: state === 'loading' && !read ? 'loading' : state === 'error' ? 'error' : 'ready',
        read,
        chip,
        q,
        prefix: frame.prefix,
        selected,
        facts: { preview: frame.me.preview, offline },
        busy: dialog?.busy ?? false,
        dialog: dialog ? { ...dialog, heldReason: cancelHeld(dialog.target, dialog.reason, facts) } : null,
        updates,
      }}
      actions={{
        onChip: (next) => go(next, q),
        onSearch: (next) => go(chip, next),
        onSelect: setSelected,
        onOpen: (row) => router.push(rowHref(frame.prefix, row)),
        onRetry: () => {
          setState('loading')
          void load()
        },
        onShowUpdates: () => void load(),
        onCancel: openCancel,
        onExport: exportRows,
        dialog: {
          onReason: (reason) => setDialog((current) => (current ? { ...current, reason, problem: null } : current)),
          onConfirm: () => void confirmCancel(),
          onClose: () => setDialog((current) => (current?.busy ? current : null)),
        },
      }}
    />
  )
}
