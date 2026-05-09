'use client'

// H.7 — Mobile-first receive flow.
//
// Layout: full-viewport, single-column, touch-targets ≥44px. Three
// states:
//   1. List view — search bar + item cards (one tap to open).
//   2. Detail view — single item, ±qty + camera + photo strip + save.
//   3. Submitted — toast + return to list.
//
// SKU search filters the list as the operator types or a Bluetooth
// scanner types. BarcodeDetector API used as a "scan with camera"
// enhancement when supported (Chrome Android, Edge Mobile); falls
// back gracefully on iOS Safari where BarcodeDetector is unavailable.
//
// Photo capture uses native `<input type="file" capture="environment">`
// which opens the rear camera on mobile and the file picker on
// desktop. Server-mediated upload to Cloudinary via
// /api/fulfillment/inbound/:id/items/:itemId/upload-photo.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  ArrowLeft, Camera, Check, ChevronRight, Minus, Plus,
  RefreshCw, Scan, Search, X, AlertTriangle, Unlock,
  Package,
} from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { useConfirm } from '@/components/ui/ConfirmProvider'

type Item = {
  id: string
  sku: string
  productId: string | null
  quantityExpected: number
  quantityReceived: number
  qcStatus: string | null
  qcNotes: string | null
  photoUrls: string[]
  discrepancies?: Array<{ id: string; reasonCode: string; status: string }>
}

type Shipment = {
  id: string
  type: string
  status: string
  reference: string | null
  expectedAt: string | null
  carrierCode: string | null
  trackingNumber: string | null
  items: Item[]
}

type Toast = { kind: 'success' | 'error'; message: string }

export default function MobileReceiveClient({ id }: { id: string }) {
  const router = useRouter()
  const [shipment, setShipment] = useState<Shipment | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [activeItemId, setActiveItemId] = useState<string | null>(null)
  const [toast, setToast] = useState<Toast | null>(null)

  const fetchOne = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const r = await fetch(`${getBackendUrl()}/api/fulfillment/inbound/${id}`, { cache: 'no-store' })
      if (!r.ok) throw new Error(`load failed: ${r.status}`)
      setShipment(await r.json())
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load shipment')
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => { fetchOne() }, [fetchOne])

  // Auto-clear toast after 3s
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 3000)
    return () => clearTimeout(t)
  }, [toast])

  const filteredItems = useMemo(() => {
    if (!shipment) return []
    if (!search.trim()) return shipment.items
    const s = search.trim().toLowerCase()
    return shipment.items.filter((it) =>
      it.sku.toLowerCase().includes(s),
    )
  }, [shipment, search])

  const activeItem = useMemo(
    () => shipment?.items.find((it) => it.id === activeItemId) ?? null,
    [shipment, activeItemId],
  )

  // Auto-select on exact SKU match (BT scanner + Enter / camera scan)
  useEffect(() => {
    if (!shipment || !search.trim() || activeItemId) return
    const exact = shipment.items.find((it) => it.sku.toLowerCase() === search.trim().toLowerCase())
    if (exact) {
      setActiveItemId(exact.id)
      setSearch('')
    }
  }, [search, shipment, activeItemId])

  if (loading && !shipment) {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-slate-800 flex items-center justify-center">
        <div className="text-lg text-slate-500 dark:text-slate-400 inline-flex items-center gap-2">
          <RefreshCw size={14} className="animate-spin" /> Loading shipment…
        </div>
      </div>
    )
  }
  if (error || !shipment) {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-slate-800 p-6 flex flex-col items-center justify-center">
        <div className="text-lg text-rose-700 dark:text-rose-300 mb-3">Failed to load shipment</div>
        <div className="text-base text-slate-500 dark:text-slate-400 mb-4">{error}</div>
        <button onClick={() => router.push('/fulfillment/inbound')} className="h-11 px-4 bg-slate-900 dark:bg-slate-100 text-white rounded">
          Back to inbound
        </button>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-800 flex flex-col">
      {/* Sticky header */}
      <header className="sticky top-0 z-10 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-700 px-4 py-3">
        <div className="flex items-center gap-3">
          <button
            onClick={() => router.push('/fulfillment/inbound')}
            className="h-10 w-10 inline-flex items-center justify-center rounded hover:bg-slate-100 dark:hover:bg-slate-700"
            aria-label="Back to inbound list"
          >
            <ArrowLeft size={20} />
          </button>
          <div className="flex-1 min-w-0">
            <div className="text-lg font-semibold text-slate-900 dark:text-slate-100 truncate">
              {shipment.reference ?? `${shipment.type} shipment`}
            </div>
            <div className="text-sm text-slate-500 dark:text-slate-400 mt-0.5 truncate">
              <span className="font-mono uppercase">{shipment.status}</span>
              {shipment.expectedAt && <> · ETA {new Date(shipment.expectedAt).toLocaleDateString('en-GB')}</>}
            </div>
          </div>
          <button
            onClick={fetchOne}
            className="h-10 w-10 inline-flex items-center justify-center rounded hover:bg-slate-100 dark:hover:bg-slate-700"
            aria-label="Refresh"
          >
            <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </header>

      <main className="flex-1 px-4 py-4">
        {activeItem ? (
          <ItemReceiveDetail
            shipmentId={id}
            item={activeItem}
            onBack={() => setActiveItemId(null)}
            onSaved={(message) => {
              setActiveItemId(null)
              setToast({ kind: 'success', message })
              fetchOne()
            }}
            onError={(message) => setToast({ kind: 'error', message })}
          />
        ) : (
          <ItemList
            shipment={shipment}
            items={filteredItems}
            search={search}
            onSearchChange={setSearch}
            onSelect={setActiveItemId}
          />
        )}
      </main>

      {/* Toast */}
      {toast && (
        <div className={`fixed bottom-4 left-1/2 -translate-x-1/2 z-20 px-4 py-2.5 rounded-lg shadow-lg text-md font-medium inline-flex items-center gap-2 ${
          toast.kind === 'success'
            ? 'bg-emerald-600 dark:bg-emerald-700 text-white'
            : 'bg-rose-600 text-white'
        }`}>
          {toast.kind === 'success' ? <Check size={14} /> : <AlertTriangle size={14} />}
          {toast.message}
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────
// List view — SKU search + item cards
// ─────────────────────────────────────────────────────────────────────
function ItemList({
  shipment, items, search, onSearchChange, onSelect,
}: {
  shipment: Shipment
  items: Item[]
  search: string
  onSearchChange: (s: string) => void
  onSelect: (id: string) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [scanError, setScanError] = useState<string | null>(null)

  // Focus on mount so BT scanners can shoot directly into the input.
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const startCameraScan = async () => {
    setScanError(null)
    if (typeof window === 'undefined' || !('BarcodeDetector' in window)) {
      setScanError('Camera scan not supported on this browser. Use Bluetooth scanner or type the SKU.')
      return
    }
    try {
      // @ts-expect-error — BarcodeDetector typings are not in lib.dom yet
      const detector = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'code_128', 'code_39', 'qr_code', 'upc_a', 'upc_e'] })
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
      const video = document.createElement('video')
      video.srcObject = stream
      video.setAttribute('playsinline', 'true')
      await video.play()
      // Single-shot: scan once, stop.
      const tick = async () => {
        try {
          const codes = await detector.detect(video)
          if (codes && codes.length > 0) {
            onSearchChange(codes[0].rawValue ?? '')
            stream.getTracks().forEach((t) => t.stop())
            return
          }
        } catch { /* ignore frame errors */ }
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
      // Auto-timeout 15s — operator can re-tap.
      setTimeout(() => stream.getTracks().forEach((t) => t.stop()), 15000)
    } catch (e: any) {
      setScanError(e?.message ?? 'Camera unavailable')
    }
  }

  return (
    <div className="space-y-3">
      {/* Search + scan */}
      <div className="bg-white dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-700 p-3 space-y-2">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 dark:text-slate-500" />
          <input
            ref={inputRef}
            type="text"
            inputMode="search"
            autoComplete="off"
            autoCapitalize="characters"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Scan or type SKU…"
            className="w-full h-12 pl-9 pr-3 text-lg font-mono border-2 border-slate-300 dark:border-slate-600 rounded focus:border-blue-500 outline-none"
          />
          {search && (
            <button
              onClick={() => onSearchChange('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 h-8 w-8 inline-flex items-center justify-center text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
              aria-label="Clear search"
            >
              <X size={16} />
            </button>
          )}
        </div>
        <button
          onClick={startCameraScan}
          className="w-full h-11 inline-flex items-center justify-center gap-2 bg-blue-600 dark:bg-blue-700 text-white rounded font-medium text-lg hover:bg-blue-700 dark:hover:bg-blue-600"
        >
          <Scan size={16} /> Scan with camera
        </button>
        {scanError && (
          <div className="text-sm text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded p-2">
            {scanError}
          </div>
        )}
      </div>

      {/* Items */}
      <div className="space-y-2">
        {items.length === 0 ? (
          <div className="text-center text-md text-slate-500 dark:text-slate-400 py-8">
            {search ? `No items matching "${search}"` : 'No items on this shipment'}
          </div>
        ) : (
          items.map((it) => (
            <ItemCard key={it.id} item={it} onClick={() => onSelect(it.id)} />
          ))
        )}
      </div>

      {shipment.items.length > 0 && (
        <div className="text-sm text-slate-500 dark:text-slate-400 text-center py-3">
          {shipment.items.filter((it) => it.quantityReceived >= it.quantityExpected).length} of {shipment.items.length} fully received
        </div>
      )}
    </div>
  )
}

function ItemCard({ item, onClick }: { item: Item; onClick: () => void }) {
  const remaining = Math.max(0, item.quantityExpected - item.quantityReceived)
  const fullyReceived = remaining === 0 && item.quantityExpected > 0
  const pct = item.quantityExpected > 0 ? Math.round((item.quantityReceived / item.quantityExpected) * 100) : 0
  const onHold = item.qcStatus === 'HOLD' || item.qcStatus === 'FAIL'

  return (
    <button
      onClick={onClick}
      className={`w-full text-left bg-white dark:bg-slate-900 rounded-lg border-2 p-3 transition-colors ${
        fullyReceived ? 'border-emerald-200 dark:border-emerald-900 bg-emerald-50/30' :
        onHold        ? 'border-amber-300 bg-amber-50/30' :
        'border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-lg font-mono font-semibold text-slate-900 dark:text-slate-100 truncate">{item.sku}</div>
          <div className="text-sm text-slate-500 dark:text-slate-400 mt-0.5 inline-flex items-center gap-2 flex-wrap">
            <span className="tabular-nums">
              <span className="font-semibold">{item.quantityReceived}</span>
              /{item.quantityExpected}
            </span>
            {remaining > 0 && <span className="text-amber-700 dark:text-amber-300">{remaining} left</span>}
            {item.qcStatus && (
              <span className={`uppercase font-semibold tracking-wider px-1 rounded text-xs ${
                item.qcStatus === 'PASS' ? 'bg-emerald-100 dark:bg-emerald-900/60 text-emerald-700 dark:text-emerald-300' :
                item.qcStatus === 'HOLD' ? 'bg-amber-100 dark:bg-amber-900/60 text-amber-700 dark:text-amber-300' :
                item.qcStatus === 'FAIL' ? 'bg-rose-100 dark:bg-rose-900/60 text-rose-700 dark:text-rose-300' : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300'
              }`}>{item.qcStatus}</span>
            )}
            {item.photoUrls.length > 0 && (
              <span className="inline-flex items-center gap-0.5 text-slate-500 dark:text-slate-400"><Camera size={10} /> {item.photoUrls.length}</span>
            )}
          </div>
        </div>
        <div className="flex-shrink-0 inline-flex items-center gap-1 text-slate-400 dark:text-slate-500">
          {fullyReceived ? <Check size={18} className="text-emerald-600 dark:text-emerald-400" /> : <ChevronRight size={18} />}
        </div>
      </div>
      <div className="mt-2 h-2 bg-slate-200 dark:bg-slate-700 rounded overflow-hidden">
        <div className={`h-full transition-all ${fullyReceived ? 'bg-emerald-500' : 'bg-blue-500'}`} style={{ width: `${pct}%` }} />
      </div>
    </button>
  )
}

// ─────────────────────────────────────────────────────────────────────
// Item detail — large-tap-target receive controls
// ─────────────────────────────────────────────────────────────────────
function ItemReceiveDetail({
  shipmentId, item, onBack, onSaved, onError,
}: {
  shipmentId: string
  item: Item
  onBack: () => void
  onSaved: (message: string) => void
  onError: (message: string) => void
}) {
  const askConfirm = useConfirm()
  const [target, setTarget] = useState<number>(item.quantityReceived)
  const [qc, setQc] = useState<string>(item.qcStatus ?? '')
  const [busy, setBusy] = useState(false)
  const [uploadingPhoto, setUploadingPhoto] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  // L.11 — optional lot capture (collapsed by default; expand when
  // recording a lot-tracked SKU like motorcycle helmets).
  const [lotOpen, setLotOpen] = useState(false)
  const [lotNumber, setLotNumber] = useState('')
  const [lotExpiresAt, setLotExpiresAt] = useState('')
  const [lotSupplierRef, setLotSupplierRef] = useState('')
  // F1.13 — optional bin put-away. Pre-typed code is fine (warehouse
  // operators know their bins by heart); we round-trip the value
  // through the receive endpoint.
  const [binOpen, setBinOpen] = useState(false)
  const [binCode, setBinCode] = useState('')

  const remaining = Math.max(0, item.quantityExpected - item.quantityReceived)
  const onHold = item.qcStatus === 'HOLD' || item.qcStatus === 'FAIL'

  const submit = async () => {
    if (target === item.quantityReceived && qc === (item.qcStatus ?? '')) {
      onError('No changes to save')
      return
    }
    setBusy(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/fulfillment/inbound/${shipmentId}/receive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: [{
            itemId: item.id,
            quantityReceived: target,
            qcStatus: qc || undefined,
            // L.11 — only send lot fields when the operator opened
            // the panel and provided a lot number. Avoids creating
            // empty/garbage lot rows for non-tracked SKUs.
            ...(lotOpen && lotNumber.trim()
              ? {
                lotNumber: lotNumber.trim(),
                expiresAt: lotExpiresAt || undefined,
                supplierLotRef: lotSupplierRef.trim() || undefined,
              }
              : {}),
            // F1.13 — bin put-away on receive. Empty when the operator
            // didn't pick a bin; service handles the missing-bin case
            // (logged warning, receive itself still succeeds).
            ...(binOpen && binCode.trim()
              ? { binCode: binCode.trim() }
              : {}),
          }],
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error ?? 'Save failed')
      }
      const delta = target - item.quantityReceived
      onSaved(delta !== 0
        ? `Received ${delta > 0 ? '+' : ''}${delta} for ${item.sku}`
        : `Updated QC for ${item.sku}`)
    } catch (e: any) {
      onError(e.message)
    } finally { setBusy(false) }
  }

  const releaseHold = async () => {
    if (!(await askConfirm({ title: 'Release the held units to stock?', confirmLabel: 'Release', tone: 'warning' }))) return
    setBusy(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/fulfillment/inbound/${shipmentId}/items/${item.id}/release-hold`, { method: 'POST' })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error ?? 'Release failed')
      }
      onSaved(`Released ${item.quantityReceived} units for ${item.sku}`)
    } catch (e: any) {
      onError(e.message)
    } finally { setBusy(false) }
  }

  const onCapture = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (file.size > 10 * 1024 * 1024) {
      onError('Photo too large (max 10MB)')
      return
    }
    setUploadingPhoto(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const res = await fetch(`${getBackendUrl()}/api/fulfillment/inbound/${shipmentId}/items/${item.id}/upload-photo`, {
        method: 'POST',
        body: fd,
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error ?? 'Upload failed')
      }
      onSaved(`Photo uploaded for ${item.sku}`)
    } catch (e: any) {
      onError(e.message)
    } finally {
      setUploadingPhoto(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  return (
    <div className="space-y-3">
      <button onClick={onBack} className="text-md text-blue-700 dark:text-blue-300 hover:underline inline-flex items-center gap-1">
        <ArrowLeft size={14} /> Back to list
      </button>

      <div className="bg-white dark:bg-slate-900 rounded-lg border-2 border-slate-300 dark:border-slate-600 p-4">
        <div className="text-2xl font-mono font-bold text-slate-900 dark:text-slate-100 break-all">{item.sku}</div>
        <div className="text-base text-slate-500 dark:text-slate-400 mt-1">
          <span className="font-semibold tabular-nums">{item.quantityReceived}</span>
          <span className="text-slate-400 dark:text-slate-500">/{item.quantityExpected}</span>
          <span> received</span>
          {remaining > 0 && <span className="ml-2 text-amber-700 dark:text-amber-300">{remaining} remaining</span>}
        </div>

        {/* Receive ±buttons */}
        <div className="mt-4 grid grid-cols-5 gap-2">
          <button
            onClick={() => setTarget(Math.max(0, target - 10))}
            className="h-12 rounded bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 text-lg font-semibold text-slate-700 dark:text-slate-300"
            aria-label="-10"
          >−10</button>
          <button
            onClick={() => setTarget(Math.max(0, target - 1))}
            className="h-12 rounded bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 text-slate-700 dark:text-slate-300 inline-flex items-center justify-center"
            aria-label="-1"
          ><Minus size={18} /></button>
          <input
            type="number"
            inputMode="numeric"
            min="0"
            value={target}
            onChange={(e) => setTarget(Math.max(0, Number(e.target.value) || 0))}
            className="h-12 text-center text-2xl font-mono font-bold tabular-nums border-2 border-slate-300 dark:border-slate-600 rounded focus:border-blue-500 outline-none"
          />
          <button
            onClick={() => setTarget(target + 1)}
            className="h-12 rounded bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 text-slate-700 dark:text-slate-300 inline-flex items-center justify-center"
            aria-label="+1"
          ><Plus size={18} /></button>
          <button
            onClick={() => setTarget(target + 10)}
            className="h-12 rounded bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 text-lg font-semibold text-slate-700 dark:text-slate-300"
            aria-label="+10"
          >+10</button>
        </div>
        <div className="mt-2 flex items-center justify-between text-sm">
          <button
            onClick={() => setTarget(item.quantityExpected)}
            className="text-blue-700 dark:text-blue-300 hover:underline"
          >Set to expected ({item.quantityExpected})</button>
          {target !== item.quantityReceived && (
            <span className={`tabular-nums font-semibold ${target > item.quantityReceived ? 'text-emerald-700 dark:text-emerald-300' : 'text-rose-700 dark:text-rose-300'}`}>
              {target > item.quantityReceived ? '+' : ''}{target - item.quantityReceived}
            </span>
          )}
        </div>
      </div>

      {/* QC dropdown */}
      <div className="bg-white dark:bg-slate-900 rounded-lg border-2 border-slate-300 dark:border-slate-600 p-4">
        <div className="text-sm uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold mb-2">Quality check</div>
        <div className="grid grid-cols-3 gap-2">
          {[
            { v: 'PASS', label: 'PASS', cls: 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-300' },
            { v: 'HOLD', label: 'HOLD', cls: 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border-amber-300' },
            { v: 'FAIL', label: 'FAIL', cls: 'bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 border-rose-300' },
          ].map((opt) => (
            <button
              key={opt.v}
              onClick={() => setQc(qc === opt.v ? '' : opt.v)}
              className={`h-12 rounded-lg border-2 font-semibold text-md transition-colors ${
                qc === opt.v ? opt.cls : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* L.11 — Lot capture (collapsed by default) */}
      <div className="bg-white dark:bg-slate-900 rounded-lg border-2 border-slate-300 dark:border-slate-600 p-4">
        <button
          type="button"
          onClick={() => setLotOpen((o) => !o)}
          className="w-full flex items-center justify-between text-sm uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold"
          aria-expanded={lotOpen}
          aria-controls="lot-capture-panel"
        >
          <span className="inline-flex items-center gap-1.5">
            <Package size={11} aria-hidden="true" />
            Lot info {lotNumber.trim() && lotOpen && <span className="text-slate-700 dark:text-slate-300 normal-case font-mono">· {lotNumber}</span>}
          </span>
          <span className="text-xs text-slate-400 dark:text-slate-500">{lotOpen ? '▾' : '▸'}</span>
        </button>
        {lotOpen && (
          <div id="lot-capture-panel" className="mt-3 space-y-2">
            <div>
              <label htmlFor={`lot-number-${item.id}`} className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold block mb-1">
                Lot number
              </label>
              <input
                id={`lot-number-${item.id}`}
                type="text"
                value={lotNumber}
                onChange={(e) => setLotNumber(e.target.value)}
                placeholder="e.g. AGV-BATCH-2025-04-A"
                className="w-full h-12 px-3 text-md border-2 border-slate-200 dark:border-slate-700 rounded font-mono"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label htmlFor={`lot-expires-${item.id}`} className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold block mb-1">
                  Expires (optional)
                </label>
                <input
                  id={`lot-expires-${item.id}`}
                  type="date"
                  value={lotExpiresAt}
                  onChange={(e) => setLotExpiresAt(e.target.value)}
                  className="w-full h-12 px-3 text-md border-2 border-slate-200 dark:border-slate-700 rounded"
                />
              </div>
              <div>
                <label htmlFor={`lot-supplier-${item.id}`} className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold block mb-1">
                  Supplier ref
                </label>
                <input
                  id={`lot-supplier-${item.id}`}
                  type="text"
                  value={lotSupplierRef}
                  onChange={(e) => setLotSupplierRef(e.target.value)}
                  placeholder="optional"
                  className="w-full h-12 px-3 text-md border-2 border-slate-200 dark:border-slate-700 rounded font-mono"
                />
              </div>
            </div>
            <div className="text-xs text-slate-500 dark:text-slate-400 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 rounded p-2">
              Same lot received again? Use the same number — units accumulate, origin chain preserved.
            </div>
          </div>
        )}
      </div>

      {/* F1.13 — Bin put-away (collapsed by default; expand when the
          operator wants to record exactly which shelf received the
          stock). Bin must already exist at the location — see
          /fulfillment/stock/bins to manage bins. */}
      <div className="bg-white dark:bg-slate-900 rounded-lg border-2 border-slate-300 dark:border-slate-600 p-4">
        <button
          type="button"
          onClick={() => setBinOpen((o) => !o)}
          className="w-full flex items-center justify-between text-sm uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold"
          aria-expanded={binOpen}
          aria-controls={`bin-capture-panel-${item.id}`}
        >
          <span className="inline-flex items-center gap-1.5">
            <Package size={11} aria-hidden="true" />
            Bin put-away {binCode.trim() && binOpen && <span className="text-slate-700 dark:text-slate-300 normal-case font-mono">· {binCode}</span>}
          </span>
          <span className="text-xs text-slate-400 dark:text-slate-500">{binOpen ? '▾' : '▸'}</span>
        </button>
        {binOpen && (
          <div id={`bin-capture-panel-${item.id}`} className="mt-3 space-y-2">
            <div>
              <label htmlFor={`bin-code-${item.id}`} className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold block mb-1">
                Bin code
              </label>
              <input
                id={`bin-code-${item.id}`}
                type="text"
                value={binCode}
                onChange={(e) => setBinCode(e.target.value)}
                placeholder="e.g. A-12-03"
                autoCapitalize="characters"
                className="w-full h-12 px-3 text-md border-2 border-slate-200 dark:border-slate-700 rounded font-mono"
              />
            </div>
            <div className="text-xs text-slate-500 dark:text-slate-400 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded p-2">
              Bin must exist at this location. Receive stands even if put-away fails — fix the bin and retry from /fulfillment/stock/bins.
            </div>
          </div>
        )}
      </div>

      {/* Photos */}
      <div className="bg-white dark:bg-slate-900 rounded-lg border-2 border-slate-300 dark:border-slate-600 p-4">
        <div className="text-sm uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold mb-2 inline-flex items-center gap-1.5">
          <Camera size={11} /> Photos ({item.photoUrls.length})
        </div>
        {item.photoUrls.length > 0 && (
          <div className="grid grid-cols-3 gap-2 mb-3">
            {item.photoUrls.map((u, i) => (
              <a key={i} href={u} target="_blank" rel="noopener noreferrer" className="block aspect-square rounded overflow-hidden bg-slate-100 dark:bg-slate-800">
                <img src={u} alt="" className="w-full h-full object-cover" />
              </a>
            ))}
          </div>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          // capture is supported on mobile (rear camera by default with
          // 'environment'); React typings are loose enough to accept it.
          capture="environment"
          onChange={onCapture}
          className="hidden"
        />
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={uploadingPhoto}
          className="w-full h-12 inline-flex items-center justify-center gap-2 bg-blue-600 dark:bg-blue-700 text-white rounded font-semibold text-lg hover:bg-blue-700 dark:hover:bg-blue-600 disabled:opacity-60"
        >
          <Camera size={18} />
          {uploadingPhoto ? 'Uploading…' : 'Take photo'}
        </button>
      </div>

      {/* Discrepancies summary */}
      {(item.discrepancies?.length ?? 0) > 0 && (
        <div className="bg-rose-50 dark:bg-rose-950/40 rounded-lg border-2 border-rose-200 dark:border-rose-900 p-3 text-base">
          <div className="font-semibold text-rose-800 inline-flex items-center gap-1.5 mb-1">
            <AlertTriangle size={12} /> {item.discrepancies?.length} discrepancy
          </div>
          {item.discrepancies?.slice(0, 3).map((d) => (
            <div key={d.id} className="text-rose-700 dark:text-rose-300">
              <span className="font-mono">{d.reasonCode}</span> · {d.status}
            </div>
          ))}
        </div>
      )}

      {/* Actions */}
      <div className="space-y-2 pt-2">
        <button
          onClick={submit}
          disabled={busy}
          className="w-full h-14 inline-flex items-center justify-center gap-2 bg-emerald-600 dark:bg-emerald-700 text-white rounded-lg font-semibold text-xl hover:bg-emerald-700 disabled:opacity-60"
        >
          {busy ? 'Saving…' : <><Check size={18} /> Save receive</>}
        </button>
        {onHold && (
          <button
            onClick={releaseHold}
            disabled={busy}
            className="w-full h-12 inline-flex items-center justify-center gap-2 bg-amber-50 dark:bg-amber-950/40 text-amber-800 border-2 border-amber-300 rounded font-semibold text-lg hover:bg-amber-100 dark:hover:bg-amber-900/60"
          >
            <Unlock size={16} /> Release {item.qcStatus} hold ({item.quantityReceived})
          </button>
        )}
      </div>
    </div>
  )
}
