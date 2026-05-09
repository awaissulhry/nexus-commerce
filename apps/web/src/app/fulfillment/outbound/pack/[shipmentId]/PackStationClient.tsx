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
import { ArrowLeft, Package, CheckCircle2, AlertTriangle, Loader2, Scale, Globe, Boxes, Split, FileText } from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { useToast } from '@/components/ui/Toast'
import { BarcodeScanInput } from '@/components/ui/BarcodeScanInput'
import { useTranslations } from '@/lib/i18n/use-translations'
import { emitInvalidation } from '@/lib/sync/invalidation-channel'
import { getBackendUrl } from '@/lib/backend-url'

interface ShipmentItem { id: string; sku: string; quantity: number; productId: string | null }
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
  items: ShipmentItem[]
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
  // O.71 weight check (always present, regardless of international).
  // O.79 surfaces it inline at the pack station so the operator gets
  // a real-time sanity check while keying the scale reading.
  weightCheck?: {
    expectedGrams: number | null
    declaredGrams: number | null
    missingWeightMaster: boolean
    variancePct: number | null
    severity: 'ok' | 'warning' | 'error' | 'pending'
  }
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
  // O.29: multi-package — operator picks which items to move into a
  // new sibling shipment. Quantity per source line; default 0 = no move.
  const [splitMode, setSplitMode] = useState(false)
  const [splitQty, setSplitQty] = useState<Record<string, number>>({})

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

  const splitTotal = useMemo(
    () => Object.values(splitQty).reduce((n, v) => n + (v || 0), 0),
    [splitQty],
  )

  const submitSplit = async () => {
    if (!shipment || splitTotal === 0) return
    const items = Object.entries(splitQty)
      .filter(([, qty]) => qty > 0)
      .map(([shipmentItemId, quantity]) => ({ shipmentItemId, quantity }))
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/shipments/${shipment.id}/split`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items }),
        },
      )
      const out = await res.json()
      if (!res.ok) {
        toast.error(out.error ?? t('common.error'))
        return
      }
      toast.success(t('pack.split.toast.created'))
      emitInvalidation({ type: 'shipment.created', id: out.created?.id })
      // Reset split state + refetch source shipment items.
      setSplitMode(false)
      setSplitQty({})
      // Reset scan counts since item quantities changed.
      setScanCounts({})
      fetchShipment()
    } catch {
      toast.error(t('common.error'))
    }
  }

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
          <div className="text-md text-slate-500 dark:text-slate-400 py-8 text-center">
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
          <div className="text-md text-rose-700 dark:text-rose-300 py-8 text-center">
            {t('pack.notFound')}{' '}
            <Link href="/fulfillment/outbound" className="text-blue-600 dark:text-blue-400 hover:underline">
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
          <div className="flex items-center gap-2">
            <button
              onClick={() => window.open(`${getBackendUrl()}/api/fulfillment/shipments/${shipment.id}/pack-slip.html`, '_blank')}
              className="h-8 px-3 text-base border border-slate-200 dark:border-slate-700 rounded-md hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1.5"
            >
              <FileText size={12} /> {t('pack.printPackSlip')}
            </button>
            <Link
              href={
                shipment.orderId
                  ? `/fulfillment/outbound?drawer=${shipment.orderId}`
                  : '/fulfillment/outbound'
              }
              className="h-8 px-3 text-base border border-slate-200 dark:border-slate-700 rounded-md hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1.5"
            >
              <ArrowLeft size={12} /> {t('common.back')}
            </Link>
          </div>
        }
      />

      {/* ── Scan-to-verify ───────────────────────────────────────── */}
      <Card>
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wider">
            <Package size={12} /> {t('pack.scanItems')}
            <button
              onClick={() => {
                setSplitMode((v) => !v)
                setSplitQty({})
              }}
              className="ml-auto h-6 px-2 text-xs text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700 rounded hover:bg-white inline-flex items-center gap-1 normal-case font-normal tracking-normal"
            >
              <Split size={11} />
              {splitMode ? t('common.cancel') : t('pack.split.cta')}
            </button>
          </div>
          {!splitMode && (
            <BarcodeScanInput
              onScan={onScan}
              placeholder={t('pack.scanPlaceholder')}
              disabled={saving}
              className="w-full"
            />
          )}
          {splitMode && (
            <div className="text-sm text-slate-600 dark:text-slate-400 bg-blue-50 dark:bg-blue-950/40 px-3 py-2 rounded border border-blue-200 dark:border-blue-900">
              {t('pack.split.hint')}
            </div>
          )}
          <div className="space-y-1.5">
            {shipment.items.map((it) => {
              const count = scanCounts[it.sku] ?? 0
              const verified = count >= it.quantity
              const overscan = count > it.quantity
              const splitVal = splitQty[it.id] ?? 0
              return (
                <div
                  key={it.id}
                  className={`flex items-center gap-3 px-3 py-2 border rounded transition-colors ${
                    splitMode
                      ? splitVal > 0
                        ? 'bg-blue-50 dark:bg-blue-950/40 border-blue-200 dark:border-blue-900'
                        : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700'
                      : verified
                      ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-900'
                      : count > 0
                      ? 'bg-amber-50 dark:bg-amber-950/40 border-amber-200 dark:border-amber-900'
                      : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700'
                  }`}
                >
                  {splitMode ? (
                    <Boxes size={14} className="text-blue-600 dark:text-blue-400" />
                  ) : verified ? (
                    <CheckCircle2 size={14} className="text-emerald-600 dark:text-emerald-400" />
                  ) : (
                    <Package size={14} className="text-slate-400 dark:text-slate-500" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="text-md font-mono text-slate-900 dark:text-slate-100">{it.sku}</div>
                  </div>
                  {splitMode ? (
                    <div className="flex items-center gap-2 text-sm">
                      <span className="text-slate-500 dark:text-slate-400">{t('pack.split.move')}</span>
                      <input
                        type="number"
                        min={0}
                        max={it.quantity}
                        value={splitVal}
                        onChange={(e) =>
                          setSplitQty((prev) => ({
                            ...prev,
                            [it.id]: Math.min(Math.max(0, Number(e.target.value) || 0), it.quantity),
                          }))
                        }
                        className="w-16 h-7 px-2 text-md tabular-nums border border-slate-300 dark:border-slate-600 rounded outline-none focus:border-blue-500 text-right"
                      />
                      <span className="text-slate-400 dark:text-slate-500">/ {it.quantity}</span>
                    </div>
                  ) : (
                    <div className="text-md tabular-nums">
                      <span
                        className={
                          overscan ? 'text-rose-700 dark:text-rose-300 font-semibold' : verified ? 'text-emerald-700 dark:text-emerald-300' : 'text-slate-700 dark:text-slate-300'
                        }
                      >
                        {count}
                      </span>
                      <span className="text-slate-400 dark:text-slate-500"> / {it.quantity}</span>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
          {splitMode && (
            <div className="flex items-center gap-2 pt-2">
              <button
                onClick={submitSplit}
                disabled={splitTotal === 0}
                className="h-11 md:h-8 px-4 md:px-3 text-md bg-blue-600 dark:bg-blue-700 text-white rounded hover:bg-blue-700 dark:hover:bg-blue-600 disabled:opacity-50 inline-flex items-center gap-1.5"
              >
                <Boxes size={12} /> {t('pack.split.confirm', { n: splitTotal })}
              </button>
              <span className="text-sm text-slate-500 dark:text-slate-400">
                {t('pack.split.willCreate')}
              </span>
            </div>
          )}
        </div>
      </Card>

      {/* ── Measurements ─────────────────────────────────────────── */}
      <Card>
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wider">
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
          {/* O.79: real-time weight sanity check. The customs-preflight
              endpoint computes expectedGrams from product master; we
              recompute variance live as the operator types so they
              can spot a wrong-tare or wrong-items situation before
              committing. Only surfaces when expected is known. */}
          {(() => {
            const expected = customs?.weightCheck?.expectedGrams
            if (!expected || expected <= 0) return null
            const declared = Number(weightGrams)
            if (!Number.isFinite(declared) || declared <= 0) {
              return (
                <div className="text-sm text-slate-500 dark:text-slate-400 inline-flex items-center gap-1.5">
                  <Scale size={11} />
                  {t('pack.weightCheck.expected', {
                    expected: (expected / 1000).toFixed(2),
                  })}
                </div>
              )
            }
            const variance = Math.abs(declared - expected) / expected
            const pct = Math.round(variance * 1000) / 10
            const tone =
              variance > 0.2
                ? 'text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-950/40 border-rose-200 dark:border-rose-900'
                : variance > 0.1
                ? 'text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40 border-amber-200 dark:border-amber-900'
                : 'text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-900'
            const tKey =
              variance > 0.2
                ? 'pack.weightCheck.error'
                : variance > 0.1
                ? 'pack.weightCheck.warning'
                : 'pack.weightCheck.ok'
            return (
              <div className={`text-sm inline-flex items-center gap-1.5 px-2 py-1 border rounded ${tone}`}>
                <Scale size={11} />
                {t(tKey, {
                  declared: (declared / 1000).toFixed(2),
                  expected: (expected / 1000).toFixed(2),
                  pct,
                })}
              </div>
            )
          })()}
          {!measurementsComplete && (
            <div className="flex items-start gap-2 text-sm text-amber-700 dark:text-amber-300">
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
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wider">
              <Globe size={12} /> {t('pack.customs.title')}
              <Badge variant={customs.ready ? 'success' : 'warning'} size="sm">
                {customs.ready ? t('pack.customs.ready') : t('pack.customs.actionRequired')}
              </Badge>
              <span className="ml-auto text-xs text-slate-500 dark:text-slate-400 font-normal normal-case tabular-nums">
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
                      hasIssue ? 'bg-rose-50 dark:bg-rose-950/40 border-rose-200 dark:border-rose-900' : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700'
                    }`}
                  >
                    <span className="font-mono text-slate-900 dark:text-slate-100 min-w-[120px]">{l.sku}</span>
                    <span className={`tabular-nums ${l.hsCode ? 'text-slate-700 dark:text-slate-300' : 'text-rose-700 dark:text-rose-300 font-semibold'}`}>
                      HS: {l.hsCode ?? t('pack.customs.hsMissing')}
                    </span>
                    <span className={`text-slate-600 dark:text-slate-400 ${l.originCountry ? '' : 'text-amber-700 dark:text-amber-300'}`}>
                      Origin: {l.originCountry ?? '—'}
                    </span>
                    <span className="ml-auto tabular-nums text-slate-700 dark:text-slate-300">
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
                      iss.severity === 'error' ? 'text-rose-700 dark:text-rose-300' : 'text-amber-700 dark:text-amber-300'
                    }`}
                  >
                    <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />
                    <span>{iss.message}</span>
                  </div>
                ))}
              </div>
            )}
            {!customs.ready && (
              <div className="text-sm text-slate-600 dark:text-slate-400 bg-slate-50 dark:bg-slate-800 px-3 py-2 rounded border border-slate-200 dark:border-slate-700">
                {t('pack.customs.hint')}
              </div>
            )}
          </div>
        </Card>
      )}

      {/* ── Notes ────────────────────────────────────────────────── */}
      <Card>
        <div className="space-y-2">
          <label className="text-sm font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wider">{t('pack.notes')}</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            placeholder={t('pack.notesPlaceholder')}
            className="w-full px-3 py-2 text-md border border-slate-300 dark:border-slate-600 rounded outline-none focus:border-blue-500"
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
              className="ml-auto h-11 md:h-9 px-5 md:px-4 text-md bg-blue-600 dark:bg-blue-700 text-white rounded hover:bg-blue-700 dark:hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
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
      <span className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">
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
          invalid ? 'border-rose-400' : 'border-slate-300 dark:border-slate-600 focus:border-blue-500'
        }`}
      />
    </label>
  )
}
