'use client'

/**
 * F.6.4 (TECH_DEBT #50) — transport-options picker for the v2024-03-20
 * FBA inbound wizard.
 *
 * Most operationally critical step in the migration: transport booking
 * is what got broken under v0 (PUT /shipments/{id}/transport returns
 * 400 since the deprecation). The wizard's reason-for-being is to
 * route bookings here instead of Seller Central.
 *
 * Two F.6.4 improvements over the F.5 v1 / F.6.0 audit baseline:
 *   1. Multi-shipment loop. Placement step emits N shipmentIds; v1
 *      only handled shipmentIds[0], silently dropping the rest. The
 *      picker now fetches transport options per shipment, lets the
 *      operator pick one per shipment, and submits a single
 *      confirmation call with the full selections[] array.
 *   2. Contact info form. SP-API's TransportationConfirmation includes
 *      an optional contactInformation block. We default to the operator
 *      contact and let them override per submission.
 *
 * Also surfaces the audit-flagged retry-on-FAIL pattern: each step's
 * picker handles its own load + confirm + retry without bouncing
 * back to the legacy "Run next step" button.
 */

import { useEffect, useMemo, useState } from 'react'
import {
  Loader2,
  CheckCircle2,
  ChevronRight,
  AlertTriangle,
  Truck,
  Package,
} from 'lucide-react'
import { useToast } from '@/components/ui/Toast'
import { getBackendUrl } from '@/lib/backend-url'

interface TransportationOption {
  transportationOptionId: string
  carrier: { alphaCode?: string; name?: string }
  shippingMode?: 'SMALL_PARCEL' | 'LTL' | 'PARTNERED_LTL' | 'PARTNERED_SMALL_PARCEL'
  shippingSolution?: string
  preconditions?: string[]
  quote?: { cost: { amount: number; currencyCode: string }; expiration?: string }
}

interface ListResponse {
  transportationOptions: TransportationOption[]
  nextToken?: string
}

interface PerShipmentState {
  shipmentId: string
  loading: boolean
  options: TransportationOption[] | null
  error: string | null
  selectedTransportationOptionId: string | null
}

interface TransportOptionsPickerProps {
  planRowId: string
  /** Plan's shipmentIds[] — set when placement was confirmed. */
  shipmentIds: string[]
  /** Called after the multi-shipment confirm succeeds. */
  onConfirmed: () => void
}

const DEFAULT_CONTACT = {
  name: 'Xavia',
  email: '',
  phoneNumber: '',
}

function currencyLabel(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat('it-IT', {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    }).format(value)
  } catch {
    return `${value.toFixed(2)} ${currency}`
  }
}

function expirationLabel(iso?: string): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const mins = Math.round((d.getTime() - Date.now()) / 60_000)
  if (mins < 0) return 'EXPIRED'
  if (mins < 60) return `expires in ${mins}m`
  if (mins < 60 * 24) return `expires in ${Math.round(mins / 60)}h`
  return `expires ${d.toLocaleDateString('it-IT')}`
}

function modeLabel(mode?: string): string {
  if (!mode) return ''
  return mode
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

export function TransportOptionsPicker({
  planRowId,
  shipmentIds,
  onConfirmed,
}: TransportOptionsPickerProps) {
  const { toast } = useToast()
  const [byShipment, setByShipment] = useState<Record<string, PerShipmentState>>({})
  const [contact, setContact] = useState(DEFAULT_CONTACT)
  const [confirming, setConfirming] = useState(false)

  // Load transport options for a single shipment. Auto-selects cheapest.
  const loadShipment = async (shipmentId: string) => {
    setByShipment((prev) => ({
      ...prev,
      [shipmentId]: {
        shipmentId,
        loading: true,
        options: prev[shipmentId]?.options ?? null,
        error: null,
        selectedTransportationOptionId: prev[shipmentId]?.selectedTransportationOptionId ?? null,
      },
    }))
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fba/inbound/v2/${planRowId}/shipments/${encodeURIComponent(shipmentId)}/transport-options`,
        { credentials: 'include' },
      )
      const j = (await res.json().catch(() => ({}))) as ListResponse & { error?: string }
      if (!res.ok) throw new Error(j?.error ?? `HTTP ${res.status}`)
      const opts = j.transportationOptions ?? []
      // Auto-select cheapest
      const sorted = [...opts].sort((a, b) => {
        const ca = a.quote?.cost.amount ?? Infinity
        const cb = b.quote?.cost.amount ?? Infinity
        return ca - cb
      })
      setByShipment((prev) => ({
        ...prev,
        [shipmentId]: {
          shipmentId,
          loading: false,
          options: opts,
          error: null,
          selectedTransportationOptionId:
            sorted[0]?.transportationOptionId ?? null,
        },
      }))
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setByShipment((prev) => ({
        ...prev,
        [shipmentId]: {
          shipmentId,
          loading: false,
          options: null,
          error: msg,
          selectedTransportationOptionId: null,
        },
      }))
      toast.error(`Shipment ${shipmentId}: ${msg}`)
    }
  }

  // Auto-load all shipments on mount.
  useEffect(() => {
    for (const sid of shipmentIds) {
      if (!byShipment[sid]) {
        loadShipment(sid)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shipmentIds.join(',')])

  const pickFor = (shipmentId: string, optId: string) => {
    setByShipment((prev) => ({
      ...prev,
      [shipmentId]: {
        ...prev[shipmentId]!,
        selectedTransportationOptionId: optId,
      },
    }))
  }

  // Totals across all shipments for the confirm-button summary.
  const grandTotal = useMemo(() => {
    let total = 0
    let currency = ''
    let allSelected = shipmentIds.length > 0
    for (const sid of shipmentIds) {
      const state = byShipment[sid]
      if (!state?.selectedTransportationOptionId || !state.options) {
        allSelected = false
        continue
      }
      const opt = state.options.find(
        (o) => o.transportationOptionId === state.selectedTransportationOptionId,
      )
      const q = opt?.quote?.cost
      if (q) {
        if (!currency) currency = q.currencyCode
        if (currency === q.currencyCode) total += q.amount
      }
    }
    return { total, currency, allSelected }
  }, [shipmentIds, byShipment])

  const handleConfirm = async () => {
    if (!grandTotal.allSelected) return
    const selections = shipmentIds.map((shipmentId) => {
      const state = byShipment[shipmentId]!
      const sel: {
        shipmentId: string
        transportationOptionId: string
        contactInformation?: { name: string; email: string; phoneNumber: string }
      } = {
        shipmentId,
        transportationOptionId: state.selectedTransportationOptionId!,
      }
      if (contact.name && contact.email && contact.phoneNumber) {
        sel.contactInformation = {
          name: contact.name,
          email: contact.email,
          phoneNumber: contact.phoneNumber,
        }
      }
      return sel
    })

    setConfirming(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fba/inbound/v2/${planRowId}/transport-options/confirm`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ selections }),
        },
      )
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j?.error ?? `HTTP ${res.status}`)
      toast.success(
        `Transport confirmed for ${selections.length} shipment${selections.length === 1 ? '' : 's'} — fetching labels next`,
      )
      onConfirmed()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setConfirming(false)
    }
  }

  if (shipmentIds.length === 0) {
    return (
      <div className="border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 rounded p-3 text-sm text-amber-700 dark:text-amber-300">
        <div className="inline-flex items-center gap-1.5">
          <AlertTriangle size={12} /> No shipment IDs on this plan
        </div>
        <div className="text-xs mt-1">
          Placement must be confirmed before transport options can be requested.
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">
        Pick transport per shipment ({shipmentIds.length})
      </div>

      {/* Per-shipment cards */}
      <div className="space-y-2">
        {shipmentIds.map((sid, idx) => (
          <ShipmentCard
            key={sid}
            index={idx}
            state={byShipment[sid]}
            shipmentId={sid}
            onPick={(optId) => pickFor(sid, optId)}
            onRetry={() => loadShipment(sid)}
            disabled={confirming}
          />
        ))}
      </div>

      {/* Contact info */}
      <div className="border border-slate-200 dark:border-slate-700 rounded p-3 bg-slate-50/40 dark:bg-slate-900/30 space-y-2">
        <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">
          Contact information (optional — required by some carriers)
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <ContactField
            label="Name"
            value={contact.name}
            onChange={(v) => setContact({ ...contact, name: v })}
            disabled={confirming}
            placeholder="Operator name"
          />
          <ContactField
            label="Email"
            value={contact.email}
            onChange={(v) => setContact({ ...contact, email: v })}
            disabled={confirming}
            placeholder="operator@xavia.it"
          />
          <ContactField
            label="Phone"
            value={contact.phoneNumber}
            onChange={(v) => setContact({ ...contact, phoneNumber: v })}
            disabled={confirming}
            placeholder="+39 …"
          />
        </div>
        <div className="text-[11px] text-slate-500 dark:text-slate-400">
          Contact attached to every shipment selection. Fill all three to send;
          partial inputs are dropped.
        </div>
      </div>

      {/* Confirm row */}
      <div className="flex items-center justify-between gap-3 pt-1">
        <div className="text-sm">
          {grandTotal.allSelected && grandTotal.currency ? (
            <>
              <span className="text-slate-500 dark:text-slate-400">Total estimated transport cost: </span>
              <span className="font-semibold text-slate-900 dark:text-slate-100 tabular-nums">
                {currencyLabel(grandTotal.total, grandTotal.currency)}
              </span>
            </>
          ) : (
            <span className="text-xs text-slate-500 dark:text-slate-400">
              Pick a transport option for every shipment to enable confirm.
            </span>
          )}
        </div>
        <button
          onClick={handleConfirm}
          disabled={!grandTotal.allSelected || confirming}
          className="h-9 px-3 text-sm bg-blue-600 dark:bg-blue-700 text-white rounded hover:bg-blue-700 dark:hover:bg-blue-600 disabled:opacity-50 inline-flex items-center gap-1.5"
        >
          {confirming ? <Loader2 size={12} className="animate-spin" /> : <ChevronRight size={12} />}
          {confirming ? 'Booking transport…' : 'Confirm transport'}
        </button>
      </div>
    </div>
  )
}

// ── Per-shipment card ──────────────────────────────────────────────────

function ShipmentCard({
  index,
  shipmentId,
  state,
  onPick,
  onRetry,
  disabled,
}: {
  index: number
  shipmentId: string
  state: PerShipmentState | undefined
  onPick: (optId: string) => void
  onRetry: () => void
  disabled?: boolean
}) {
  const loading = state?.loading ?? false
  const options = state?.options ?? null
  const error = state?.error ?? null
  const selectedId = state?.selectedTransportationOptionId ?? null

  const cheapest = useMemo(() => {
    if (!options || options.length === 0) return null
    let best: { id: string; total: number } | null = null
    for (const o of options) {
      const amt = o.quote?.cost.amount ?? Infinity
      if (!best || amt < best.total) best = { id: o.transportationOptionId, total: amt }
    }
    return best
  }, [options])

  return (
    <div className="border border-slate-200 dark:border-slate-700 rounded">
      {/* Shipment header */}
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/50">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[11px] tabular-nums text-slate-500 dark:text-slate-400">
            Shipment {index + 1} of
          </span>
          <Package size={12} className="text-slate-400 dark:text-slate-500" />
          <span className="font-mono text-xs text-slate-700 dark:text-slate-300 truncate">
            {shipmentId}
          </span>
          {selectedId && options && (
            <CheckCircle2 size={12} className="text-emerald-600 dark:text-emerald-400 shrink-0" />
          )}
        </div>
        {!loading && (
          <button
            onClick={onRetry}
            disabled={disabled}
            className="h-6 px-2 text-[11px] border border-slate-300 dark:border-slate-700 rounded hover:border-blue-400 disabled:opacity-50"
          >
            Refresh
          </button>
        )}
      </div>

      {/* Body */}
      <div className="p-2">
        {loading && !options && (
          <div className="inline-flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300 px-1 py-2">
            <Loader2 size={11} className="animate-spin" />
            Loading transport options for this shipment…
          </div>
        )}

        {error && (
          <div className="border border-rose-200 dark:border-rose-900 bg-rose-50 dark:bg-rose-950/40 rounded p-2 text-xs text-rose-700 dark:text-rose-300">
            <div className="inline-flex items-center gap-1 mb-1">
              <AlertTriangle size={11} /> Could not load options
            </div>
            <div className="font-mono text-[11px] mb-1">{error}</div>
            <button
              onClick={onRetry}
              disabled={disabled}
              className="h-6 px-2 text-[11px] border border-rose-300 dark:border-rose-700 rounded hover:bg-rose-100/50 dark:hover:bg-rose-900/40 disabled:opacity-50"
            >
              Retry
            </button>
          </div>
        )}

        {options && options.length === 0 && (
          <div className="text-xs text-slate-500 dark:text-slate-400 px-1 py-2">
            No transport options returned for this shipment.
          </div>
        )}

        {options && options.length > 0 && (
          <div className="space-y-1">
            {options.map((opt) => {
              const isSelected = selectedId === opt.transportationOptionId
              const isCheapest =
                cheapest?.id === opt.transportationOptionId && options.length > 1
              const expLabel = expirationLabel(opt.quote?.expiration)
              const expired = expLabel === 'EXPIRED'
              const cost = opt.quote?.cost
              const carrierLine = opt.carrier?.name ?? opt.carrier?.alphaCode ?? 'Unknown carrier'
              return (
                <button
                  key={opt.transportationOptionId}
                  onClick={() => !expired && onPick(opt.transportationOptionId)}
                  disabled={expired || disabled}
                  className={`w-full text-left border rounded p-2 transition-colors ${
                    isSelected
                      ? 'border-blue-400 bg-blue-50/40 dark:bg-blue-950/30 ring-1 ring-blue-400'
                      : expired
                        ? 'border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/30 opacity-60 cursor-not-allowed'
                        : 'border-slate-200 dark:border-slate-700 hover:border-blue-300 dark:hover:border-blue-600 bg-white dark:bg-slate-900'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <div className="flex items-center gap-2 flex-wrap">
                        {isSelected && <CheckCircle2 size={11} className="text-blue-600 dark:text-blue-400 shrink-0" />}
                        <Truck size={11} className="text-slate-400 dark:text-slate-500 shrink-0" />
                        <span className="text-sm font-medium text-slate-900 dark:text-slate-100">
                          {carrierLine}
                        </span>
                        {opt.shippingMode && (
                          <span className="text-[11px] text-slate-500 dark:text-slate-400">
                            {modeLabel(opt.shippingMode)}
                          </span>
                        )}
                        {isCheapest && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded border bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-300 dark:border-emerald-800">
                            Cheapest
                          </span>
                        )}
                        {expLabel && (
                          <span
                            className={`text-[11px] ${
                              expired
                                ? 'text-rose-600 dark:text-rose-400 font-medium'
                                : 'text-slate-500 dark:text-slate-400'
                            }`}
                          >
                            {expLabel}
                          </span>
                        )}
                      </div>
                      {opt.shippingSolution && (
                        <div className="text-[11px] text-slate-500 dark:text-slate-400">
                          {opt.shippingSolution}
                        </div>
                      )}
                      <div className="font-mono text-[10px] text-slate-400 dark:text-slate-500 truncate">
                        {opt.transportationOptionId}
                      </div>
                      {opt.preconditions && opt.preconditions.length > 0 && (
                        <div className="flex flex-wrap gap-1 pt-0.5">
                          {opt.preconditions.map((p) => (
                            <span
                              key={p}
                              className="text-[10px] px-1.5 py-0.5 rounded border bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border-amber-300 dark:border-amber-800"
                            >
                              {p.replace(/_/g, ' ').toLowerCase()}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="text-right shrink-0">
                      {cost ? (
                        <div className="text-sm font-semibold text-slate-900 dark:text-slate-100 tabular-nums">
                          {currencyLabel(cost.amount, cost.currencyCode)}
                        </div>
                      ) : (
                        <div className="text-xs text-slate-500 dark:text-slate-400 italic">no quote</div>
                      )}
                    </div>
                  </div>
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

function ContactField({
  label,
  value,
  onChange,
  disabled,
  placeholder,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  disabled?: boolean
  placeholder?: string
}) {
  return (
    <label className="space-y-0.5 block">
      <span className="text-[11px] uppercase tracking-wider text-slate-500 dark:text-slate-400 font-medium">
        {label}
      </span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        placeholder={placeholder}
        className="h-8 w-full px-2 text-sm border border-slate-300 dark:border-slate-700 rounded bg-white dark:bg-slate-900 disabled:opacity-60"
      />
    </label>
  )
}
