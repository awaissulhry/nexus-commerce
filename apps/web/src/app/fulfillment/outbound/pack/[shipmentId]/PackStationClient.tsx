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
import { ArrowLeft, Package, CheckCircle2, AlertTriangle, Loader2, Scale, Globe } from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { useToast } from '@/components/ui/Toast'
import { BarcodeScanInput } from '@/components/ui/BarcodeScanInput'
import { useTranslations } from '@/lib/i18n/use-translations'
import { emitInvalidation } from '@/lib/sync/invalidation-channel'
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

interface CustomsPreflight {
  shipmentId: string
  destinationCountry: string | null
  isInternational: boolean
  isIntraEU: boolean
  currency: string
  totalValue: number
  lines: Array<{
    sku: string
    quantity: number
    unitPrice: number
    totalValue: number
    hsCode: string | null
    originCountry: string | null
  }>
  issues: Array<{ sku: string; severity: 'error' | 'warning'; code: string; message: string }>
  ready: boolean
}

interface Props {
  shipmentId: string
}

export default function PackStationClient({ shipmentId }: Props) {
  const router = useRouter()
  const { toast } = useToast()
  const { t } = useTranslations()
  const [shipment, setShipment] = useState<ShipmentDetail | null>(null)
  const [customs, setCustoms] = useState<CustomsPreflight | null>(null)
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
      // O.18: parallel fetch — shipment + customs preflight. Customs
      // returns 200 with isInternational:false when destination is
      // intra-EU; the panel below renders only when isInternational.
      const [shipRes, customsRes] = await Promise.all([
        fetch(`${getBackendUrl()}/api/fulfillment/shipments/${shipmentId}`, { cache: 'no-store' }),
        fetch(`${getBackendUrl()}/api/fulfillment/shipments/${shipmentId}/customs-preflight`, { cache: 'no-store' }),
      ])
      if (!shipRes.ok) {
        toast.error(t('pack.notFound'))
        return
      }
      const s: ShipmentDetail = await shipRes.json()
      setShipment(s)
      // Hydrate operator inputs from any prior pack state.
      if (s.weightGrams) setWeightGrams(String(s.weightGrams))
      if (s.lengthCm) setLengthCm(String(s.lengthCm))
      if (s.widthCm) setWidthCm(String(s.widthCm))
      if (s.heightCm) setHeightCm(String(s.heightCm))
      if (s.notes) setNotes(s.notes)
      if (customsRes.ok) setCustoms(await customsRes.json())
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
        toast.error(t('pack.toast.notInShipment', { sku: raw }))
        return
      }
      const current = scanCounts[match.sku] ?? 0
      if (current >= match.quantity) {
        toast.warning(t('pack.toast.alreadyScanned', { n: match.quantity, sku: match.sku }))
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
        toast.error(err.error ?? t('pack.toast.packFailed'))
        return
      }
      toast.success(t('pack.toast.packed'))
      // O.26: tell other tabs (Pending/Shipments/drawer/sidebar) the
      // shipment transitioned so they refresh.
      emitInvalidation({ type: 'shipment.updated', id: shipment.id })
      // Return to outbound, opening the drawer for this order so the
      // operator can immediately print the label.
      const data = await res.json()
      const orderId = data?.orderId ?? shipment.orderId
      router.push(orderId ? `/fulfillment/outbound?drawer=${orderId}` : '/fulfillment/outbound')
    } catch {
      toast.error(t('pack.toast.packFailed'))
    } finally {
      setSaving(false)
    }
  }, [shipment, weightGrams, lengthCm, widthCm, heightCm, notes, toast, router])

  if (loading) {
    return (
      <div className="space-y-5">
        <PageHeader
          title={t('pack.title')}
          breadcrumbs={[
            { label: t('nav.fulfillment'), href: '/fulfillment' },
            { label: t('nav.outbound'), href: '/fulfillment/outbound' },
            { label: t('pack.title') },
          ]}
        />
        <Card>
          <div className="text-md text-slate-500 py-8 text-center">
            <Loader2 size={20} className="inline animate-spin mr-2" />
            {t('pack.loading')}
          </div>
        </Card>
      </div>
    )
  }

  if (!shipment) {
    return (
      <div className="space-y-5">
        <PageHeader title={t('pack.title')} />
        <Card>
          <div className="text-md text-rose-700 py-8 text-center">
            {t('pack.notFound')}{' '}
            <Link href="/fulfillment/outbound" className="text-blue-600 hover:underline">
              {t('pack.backToOutbound')}
            </Link>
          </div>
        </Card>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('pack.title')}
        description={`Shipment ${shipment.id.slice(0, 8)}… · ${shipment.carrierCode}${shipment.warehouse ? ` · ${shipment.warehouse.code}` : ''}`}
        breadcrumbs={[
          { label: t('nav.fulfillment'), href: '/fulfillment' },
          { label: t('nav.outbound'), href: '/fulfillment/outbound' },
          { label: t('pack.title') },
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
            <ArrowLeft size={12} /> {t('common.back')}
          </Link>
        }
      />

      {/* ── Scan-to-verify ───────────────────────────────────────── */}
      <Card>
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-700 uppercase tracking-wider">
            <Package size={12} /> {t('pack.scanItems')}
          </div>
          <BarcodeScanInput
            onScan={onScan}
            placeholder={t('pack.scanPlaceholder')}
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
            <Scale size={12} /> {t('pack.measurements')}
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <NumberField
              label={t('pack.weightGrams')}
              value={weightGrams}
              onChange={setWeightGrams}
              required
              min={1}
            />
            <NumberField label={t('pack.lengthCm')} value={lengthCm} onChange={setLengthCm} min={0} />
            <NumberField label={t('pack.widthCm')} value={widthCm} onChange={setWidthCm} min={0} />
            <NumberField label={t('pack.heightCm')} value={heightCm} onChange={setHeightCm} min={0} />
          </div>
          {!measurementsComplete && (
            <div className="flex items-start gap-2 text-sm text-amber-700">
              <AlertTriangle size={12} className="mt-0.5" />
              {t('pack.weightRequired')}
            </div>
          )}
        </div>
      </Card>

      {/* ── Customs review (international only) ─────────────────── */}
      {customs?.isInternational && (
        <Card>
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-700 uppercase tracking-wider">
              <Globe size={12} /> {t('pack.customs.title')}
              <Badge variant={customs.ready ? 'success' : 'warning'} size="sm">
                {customs.ready ? t('pack.customs.ready') : t('pack.customs.actionRequired')}
              </Badge>
              <span className="ml-auto text-xs text-slate-500 font-normal normal-case tabular-nums">
                {t('pack.customs.destination')} · {customs.destinationCountry ?? '—'} · {t('pack.customs.total')}{' '}
                {new Intl.NumberFormat('it-IT', {
                  style: 'currency',
                  currency: customs.currency || 'EUR',
                }).format(customs.totalValue)}
              </span>
            </div>
            <div className="space-y-1">
              {customs.lines.map((l) => {
                const hasIssue = customs.issues.some((i) => i.sku === l.sku && i.severity === 'error')
                return (
                  <div
                    key={l.sku}
                    className={`flex items-center gap-3 px-3 py-1.5 border rounded text-sm ${
                      hasIssue ? 'bg-rose-50 border-rose-200' : 'bg-white border-slate-200'
                    }`}
                  >
                    <span className="font-mono text-slate-900 min-w-[120px]">{l.sku}</span>
                    <span className={`tabular-nums ${l.hsCode ? 'text-slate-700' : 'text-rose-700 font-semibold'}`}>
                      HS: {l.hsCode ?? t('pack.customs.hsMissing')}
                    </span>
                    <span className={`text-slate-600 ${l.originCountry ? '' : 'text-amber-700'}`}>
                      Origin: {l.originCountry ?? '—'}
                    </span>
                    <span className="ml-auto tabular-nums text-slate-700">
                      ×{l.quantity} · {l.totalValue.toFixed(2)} {customs.currency}
                    </span>
                  </div>
                )
              })}
            </div>
            {customs.issues.length > 0 && (
              <div className="space-y-1">
                {customs.issues.map((iss, i) => (
                  <div
                    key={i}
                    className={`flex items-start gap-2 text-sm ${
                      iss.severity === 'error' ? 'text-rose-700' : 'text-amber-700'
                    }`}
                  >
                    <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />
                    <span>{iss.message}</span>
                  </div>
                ))}
              </div>
            )}
            {!customs.ready && (
              <div className="text-sm text-slate-600 bg-slate-50 px-3 py-2 rounded border border-slate-200">
                {t('pack.customs.hint')}
              </div>
            )}
          </div>
        </Card>
      )}

      {/* ── Notes ────────────────────────────────────────────────── */}
      <Card>
        <div className="space-y-2">
          <label className="text-sm font-semibold text-slate-700 uppercase tracking-wider">{t('pack.notes')}</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            placeholder={t('pack.notesPlaceholder')}
            className="w-full px-3 py-2 text-md border border-slate-300 rounded outline-none focus:border-blue-500"
          />
        </div>
      </Card>

      {/* ── Action bar ───────────────────────────────────────────── */}
      <div className="sticky bottom-2 z-10">
        <Card>
          <div className="flex items-center gap-3">
            {allVerified ? (
              <Badge variant="success" size="sm">{t('pack.allVerified')}</Badge>
            ) : (
              <Badge variant="warning" size="sm">
                {t('pack.itemsToScan', {
                  n: shipment.items.length - shipment.items.filter((it) => (scanCounts[it.sku] ?? 0) >= it.quantity).length,
                })}
              </Badge>
            )}
            <button
              onClick={submit}
              disabled={!canPack}
              className="ml-auto h-9 px-4 text-md bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
            >
              {saving ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
              {t('pack.markPacked')}
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
