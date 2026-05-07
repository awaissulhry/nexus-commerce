'use client'

// O.13 — Pack station client. Three columns on desktop:
//   1. Items (with scan-verify state)
//   2. Measurements (weight + dimensions)
//   3. Notes + actions
//
// On mobile/tablet stacks vertically. Optimized for scanner hardware:
// the BarcodeScanInput auto-focuses, and Enter on it scans an item.
// Items glow green when scanned; the "Mark packed" CTA enables once
// every item has at least one scan recorded.

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowLeft, Package, CheckCircle2, AlertTriangle, Loader2, Scale } from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { useToast } from '@/components/ui/Toast'
import { BarcodeScanInput } from '@/components/ui/BarcodeScanInput'
import { getBackendUrl } from '@/lib/backend-url'

interface ShipmentDetail {
  id: string
  orderId: string | null
  status: string
  carrierCode: string
  weightGrams: number | null
  lengthCm: number | null
  widthCm: number | null
  heightCm: number | null
  notes: string | null
  items: Array<{ id: string; sku: string; quantity: number; productId: string | null }>
  warehouse?: { code: string; name: string } | null
}

interface Props {
  shipmentId: string
}

export default function PackStationClient({ shipmentId }: Props) {
  const router = useRouter()
  const { toast } = useToast()
  const [shipment, setShipment] = useState<ShipmentDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  // Per-SKU scan counts. Initialized to 0; ticks up each time the
  // operator scans the SKU. Must reach the line's required quantity
  // before the line is marked verified.
  const [scanCounts, setScanCounts] = useState<Record<string, number>>({})

  // Operator-entered measurements. Empty string = "not entered yet";
  // numeric value persists through saves.
  const [weightGrams, setWeightGrams] = useState<string>('')
  const [lengthCm, setLengthCm] = useState<string>('')
  const [widthCm, setWidthCm] = useState<string>('')
  const [heightCm, setHeightCm] = useState<string>('')
  const [notes, setNotes] = useState<string>('')

  const fetchShipment = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/shipments/${shipmentId}`,
        { cache: 'no-store' },
      )
      if (!res.ok) {
        toast.error('Shipment not found')
        return
      }
      const s: ShipmentDetail = await res.json()
      setShipment(s)
      // Hydrate operator inputs from any prior pack state.
      if (s.weightGrams) setWeightGrams(String(s.weightGrams))
      if (s.lengthCm) setLengthCm(String(s.lengthCm))
      if (s.widthCm) setWidthCm(String(s.widthCm))
      if (s.heightCm) setHeightCm(String(s.heightCm))
      if (s.notes) setNotes(s.notes)
    } finally {
      setLoading(false)
    }
  }, [shipmentId, toast])

  useEffect(() => { fetchShipment() }, [fetchShipment])

  const onScan = useCallback(
    (raw: string) => {
      if (!shipment) return
      const trimmed = raw.trim().toUpperCase()
      // Match by SKU exact (case-insensitive). Future: also match by
      // barcode/GTIN once that's stored on the order item.
      const match = shipment.items.find((it) => it.sku.toUpperCase() === trimmed)
      if (!match) {
        toast.error(`SKU "${raw}" not in this shipment`)
        return
      }
      const current = scanCounts[match.sku] ?? 0
      if (current >= match.quantity) {
        toast.warning(`Already scanned ${match.quantity}× ${match.sku}`)
        return
      }
      setScanCounts((prev) => ({ ...prev, [match.sku]: current + 1 }))
    },
    [shipment, scanCounts, toast],
  )

  const allVerified = useMemo(() => {
    if (!shipment) return false
    return shipment.items.every((it) => (scanCounts[it.sku] ?? 0) >= it.quantity)
  }, [shipment, scanCounts])

  const measurementsComplete =
    weightGrams !== '' && Number(weightGrams) > 0

  const canPack = allVerified && measurementsComplete && !saving

  const submit = useCallback(async () => {
    if (!shipment) return
    setSaving(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/shipments/${shipment.id}/pack`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            weightGrams: Number(weightGrams) || undefined,
            lengthCm: Number(lengthCm) || undefined,
            widthCm: Number(widthCm) || undefined,
            heightCm: Number(heightCm) || undefined,
            notes: notes || undefined,
            verifiedSkus: shipment.items.map((it) => it.sku),
          }),
        },
      )
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        toast.error(err.error ?? 'Failed to mark packed')
        return
      }
      toast.success('Shipment packed — ready for label')
      // Return to outbound, opening the drawer for this order so the
      // operator can immediately print the label.
      const data = await res.json()
      const orderId = data?.orderId ?? shipment.orderId
      router.push(orderId ? `/fulfillment/outbound?drawer=${orderId}` : '/fulfillment/outbound')
    } catch {
      toast.error('Failed to mark packed')
    } finally {
      setSaving(false)
    }
  }, [shipment, weightGrams, lengthCm, widthCm, heightCm, notes, toast, router])

  if (loading) {
    return (
      <div className="space-y-5">
        <PageHeader
          title="Pack station"
          breadcrumbs={[
            { label: 'Fulfillment', href: '/fulfillment' },
            { label: 'Outbound', href: '/fulfillment/outbound' },
            { label: 'Pack' },
          ]}
        />
        <Card>
          <div className="text-md text-slate-500 py-8 text-center">
            <Loader2 size={20} className="inline animate-spin mr-2" />
            Loading shipment…
          </div>
        </Card>
      </div>
    )
  }

  if (!shipment) {
    return (
      <div className="space-y-5">
        <PageHeader title="Pack station" />
        <Card>
          <div className="text-md text-rose-700 py-8 text-center">
            Shipment not found.{' '}
            <Link href="/fulfillment/outbound" className="text-blue-600 hover:underline">
              Back to outbound
            </Link>
          </div>
        </Card>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Pack station"
        description={`Shipment ${shipment.id.slice(0, 8)}… · ${shipment.carrierCode}${shipment.warehouse ? ` · ${shipment.warehouse.code}` : ''}`}
        breadcrumbs={[
          { label: 'Fulfillment', href: '/fulfillment' },
          { label: 'Outbound', href: '/fulfillment/outbound' },
          { label: 'Pack' },
        ]}
        actions={
          <Link
            href={
              shipment.orderId
                ? `/fulfillment/outbound?drawer=${shipment.orderId}`
                : '/fulfillment/outbound'
            }
            className="h-8 px-3 text-base border border-slate-200 rounded-md hover:bg-slate-50 inline-flex items-center gap-1.5"
          >
            <ArrowLeft size={12} /> Back
          </Link>
        }
      />

      {/* ── Scan-to-verify ───────────────────────────────────────── */}
      <Card>
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-700 uppercase tracking-wider">
            <Package size={12} /> Scan each item
          </div>
          <BarcodeScanInput
            onScan={onScan}
            placeholder="Scan SKU or barcode…"
            disabled={saving}
            className="w-full"
          />
          <div className="space-y-1.5">
            {shipment.items.map((it) => {
              const count = scanCounts[it.sku] ?? 0
              const verified = count >= it.quantity
              const overscan = count > it.quantity
              return (
                <div
                  key={it.id}
                  className={`flex items-center gap-3 px-3 py-2 border rounded transition-colors ${
                    verified
                      ? 'bg-emerald-50 border-emerald-200'
                      : count > 0
                      ? 'bg-amber-50 border-amber-200'
                      : 'bg-white border-slate-200'
                  }`}
                >
                  {verified ? (
                    <CheckCircle2 size={14} className="text-emerald-600" />
                  ) : (
                    <Package size={14} className="text-slate-400" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="text-md font-mono text-slate-900">{it.sku}</div>
                  </div>
                  <div className="text-md tabular-nums">
                    <span
                      className={
                        overscan ? 'text-rose-700 font-semibold' : verified ? 'text-emerald-700' : 'text-slate-700'
                      }
                    >
                      {count}
                    </span>
                    <span className="text-slate-400"> / {it.quantity}</span>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </Card>

      {/* ── Measurements ─────────────────────────────────────────── */}
      <Card>
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-700 uppercase tracking-wider">
            <Scale size={12} /> Measurements
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <NumberField
              label="Weight (g)"
              value={weightGrams}
              onChange={setWeightGrams}
              required
              min={1}
            />
            <NumberField label="Length (cm)" value={lengthCm} onChange={setLengthCm} min={0} />
            <NumberField label="Width (cm)" value={widthCm} onChange={setWidthCm} min={0} />
            <NumberField label="Height (cm)" value={heightCm} onChange={setHeightCm} min={0} />
          </div>
          {!measurementsComplete && (
            <div className="flex items-start gap-2 text-sm text-amber-700">
              <AlertTriangle size={12} className="mt-0.5" />
              Weight is required. Dimensions improve carrier rate accuracy.
            </div>
          )}
        </div>
      </Card>

      {/* ── Notes ────────────────────────────────────────────────── */}
      <Card>
        <div className="space-y-2">
          <label className="text-sm font-semibold text-slate-700 uppercase tracking-wider">Notes (optional)</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            placeholder="Fragile · Customer note · Pack instruction…"
            className="w-full px-3 py-2 text-md border border-slate-300 rounded outline-none focus:border-blue-500"
          />
        </div>
      </Card>

      {/* ── Action bar ───────────────────────────────────────────── */}
      <div className="sticky bottom-2 z-10">
        <Card>
          <div className="flex items-center gap-3">
            {allVerified ? (
              <Badge variant="success" size="sm">All items verified</Badge>
            ) : (
              <Badge variant="warning" size="sm">
                {shipment.items.length - shipment.items.filter((it) => (scanCounts[it.sku] ?? 0) >= it.quantity).length} item(s) to scan
              </Badge>
            )}
            <button
              onClick={submit}
              disabled={!canPack}
              className="ml-auto h-9 px-4 text-md bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
            >
              {saving ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
              Mark packed
            </button>
          </div>
        </Card>
      </div>
    </div>
  )
}

function NumberField({
  label,
  value,
  onChange,
  required = false,
  min = 0,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  required?: boolean
  min?: number
}) {
  const isEmpty = value === ''
  const numeric = Number(value)
  const invalid = !isEmpty && (!Number.isFinite(numeric) || numeric < min)
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs uppercase tracking-wider text-slate-500">
        {label}
        {required && <span className="text-rose-500 ml-0.5">*</span>}
      </span>
      <input
        type="number"
        inputMode="decimal"
        min={min}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`px-3 h-10 text-md tabular-nums border rounded outline-none ${
          invalid ? 'border-rose-400' : 'border-slate-300 focus:border-blue-500'
        }`}
      />
    </label>
  )
}
