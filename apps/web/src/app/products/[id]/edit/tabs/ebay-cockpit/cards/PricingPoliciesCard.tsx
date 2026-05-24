'use client'

// EC.8 — PricingPoliciesCard
//
// One card, three sections:
//   • Pricing & Rule  — per-marketplace priceOverride + pricingRule
//                       (FIXED / MATCH_AMAZON / PERCENT_OF_MASTER).
//                       Reuses the existing
//                       POST /api/products/:id/listings/:ch/:mp/pricing
//                       endpoint that ChannelListingTab's PricingPanel
//                       already writes to — no new pricing API needed.
//   • Best Offer      — enable toggle + auto-accept + auto-decline
//                       thresholds. Persisted on
//                       ChannelListing.platformAttributes via the new
//                       PATCH /api/ebay/cockpit/offer-policies.
//   • Policies        — payment / return / fulfillment dropdowns
//                       populated from /api/ebay/policies which already
//                       wraps the GG.2 Account API snapshot.
//
// Field Source aware on the pricing input only (master vs manual).
// Best Offer + policies stay direct inputs — sources beyond Manual
// don't make sense (they're operational settings, not content).

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { DollarSign, ShieldCheck, Sparkles, Save, Loader2, ExternalLink } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { cn } from '@/lib/utils'
import FieldSourceRow from '../field-source/FieldSourceRow'

type PricingRule = 'FIXED' | 'MATCH_AMAZON' | 'PERCENT_OF_MASTER'

interface PolicySummary {
  id: string
  name: string
}

interface PolicySnapshot {
  fulfillmentPolicies: PolicySummary[]
  paymentPolicies: PolicySummary[]
  returnPolicies: PolicySummary[]
  inventoryLocations?: Array<{ merchantLocationKey: string; name: string }>
}

interface Props {
  productId: string
  marketplace: string
  currency: string
  /** Listing read on mount — used to seed all three sections. */
  initial: {
    priceOverride: number | null
    pricingRule: PricingRule
    priceAdjustmentPercent: number | null
    bestOfferEnabled: boolean
    bestOfferAutoAcceptPrice: number | null
    bestOfferMinAcceptPrice: number | null
    fulfillmentPolicyId: string | null
    paymentPolicyId: string | null
    returnPolicyId: string | null
    merchantLocationKey: string | null
  }
  /** Master price for the Field Source "From Master" resolver. */
  masterPrice: number | null
}

export default function PricingPoliciesCard(props: Props) {
  const router = useRouter()
  const { productId, marketplace, currency, initial, masterPrice } = props

  // ── Pricing local state ─────────────────────────────────────────
  const [rule, setRule] = useState<PricingRule>(initial.pricingRule)
  const [adj, setAdj] = useState<string>(
    initial.priceAdjustmentPercent != null ? String(initial.priceAdjustmentPercent) : '',
  )

  // ── Best offer local state ──────────────────────────────────────
  const [boEnabled, setBoEnabled] = useState(initial.bestOfferEnabled)
  const [boAccept, setBoAccept] = useState<string>(
    initial.bestOfferAutoAcceptPrice != null ? String(initial.bestOfferAutoAcceptPrice) : '',
  )
  const [boMin, setBoMin] = useState<string>(
    initial.bestOfferMinAcceptPrice != null ? String(initial.bestOfferMinAcceptPrice) : '',
  )

  // ── Policies state ──────────────────────────────────────────────
  const [snapshot, setSnapshot] = useState<PolicySnapshot | null>(null)
  const [policyLoading, setPolicyLoading] = useState(false)
  const [policyError, setPolicyError] = useState<string | null>(null)
  const [fulfillmentId, setFulfillmentId] = useState<string | null>(initial.fulfillmentPolicyId)
  const [paymentId, setPaymentId] = useState<string | null>(initial.paymentPolicyId)
  const [returnId, setReturnId] = useState<string | null>(initial.returnPolicyId)
  const [locationKey, setLocationKey] = useState<string | null>(initial.merchantLocationKey)

  // ── Save state ──────────────────────────────────────────────────
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedFlash, setSavedFlash] = useState(false)

  // Fetch policies snapshot on mount + on marketplace change.
  useEffect(() => {
    let aborted = false
    setPolicyLoading(true)
    setPolicyError(null)
    ;(async () => {
      try {
        const u = new URL(`${getBackendUrl()}/api/ebay/policies`)
        u.searchParams.set('marketplaceId', `EBAY_${marketplace.toUpperCase()}`)
        const res = await fetch(u.toString())
        const json = await res.json()
        if (aborted) return
        if (!res.ok || !json.success) {
          setPolicyError(json?.error ?? `HTTP ${res.status}`)
        } else {
          setSnapshot({
            fulfillmentPolicies: json.fulfillmentPolicies ?? [],
            paymentPolicies: json.paymentPolicies ?? [],
            returnPolicies: json.returnPolicies ?? [],
            inventoryLocations: json.inventoryLocations ?? [],
          })
        }
      } catch (err) {
        if (!aborted) setPolicyError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!aborted) setPolicyLoading(false)
      }
    })()
    return () => { aborted = true }
  }, [marketplace])

  // Dirty trackers — surface "unsaved" status on the footer.
  const initialJson = useMemo(() => JSON.stringify({
    rule: initial.pricingRule,
    adj: initial.priceAdjustmentPercent,
    boEnabled: initial.bestOfferEnabled,
    boAccept: initial.bestOfferAutoAcceptPrice,
    boMin: initial.bestOfferMinAcceptPrice,
    fulfillmentId: initial.fulfillmentPolicyId,
    paymentId: initial.paymentPolicyId,
    returnId: initial.returnPolicyId,
    locationKey: initial.merchantLocationKey,
  }), [initial])
  const currentJson = useMemo(() => JSON.stringify({
    rule,
    adj: adj === '' ? null : parseFloat(adj),
    boEnabled,
    boAccept: boAccept === '' ? null : parseFloat(boAccept),
    boMin: boMin === '' ? null : parseFloat(boMin),
    fulfillmentId,
    paymentId,
    returnId,
    locationKey,
  }), [rule, adj, boEnabled, boAccept, boMin, fulfillmentId, paymentId, returnId, locationKey])
  const isDirty = initialJson !== currentJson

  // Price input — Field-Source-aware row that goes through the
  // pricing endpoint instead of the offer-policies one. The
  // FieldSourceRow handles its own value buffer; we read it back on
  // save via a ref-style closure.
  const [priceBuffer, setPriceBuffer] = useState<string>(
    initial.priceOverride != null ? String(initial.priceOverride) : '',
  )

  const handleSaveAll = useCallback(async () => {
    if (saving) return
    setSaving(true)
    setError(null)
    try {
      // 1. Save pricing via existing endpoint.
      const pricingBody: Record<string, unknown> = { pricingRule: rule }
      if (rule === 'FIXED' || rule === 'MATCH_AMAZON') {
        pricingBody.priceOverride = priceBuffer !== '' ? parseFloat(priceBuffer) : null
      }
      if (rule === 'PERCENT_OF_MASTER') {
        pricingBody.priceAdjustmentPercent = adj !== '' ? parseFloat(adj) : null
      }
      const pricingRes = await fetch(
        `${getBackendUrl()}/api/products/${productId}/listings/EBAY/${marketplace}/pricing`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(pricingBody),
        },
      )
      if (!pricingRes.ok) {
        const j = await pricingRes.json().catch(() => ({}))
        throw new Error(j?.error ?? `pricing HTTP ${pricingRes.status}`)
      }

      // 2. Save offer + policies via the new cockpit endpoint.
      const opRes = await fetch(`${getBackendUrl()}/api/ebay/cockpit/offer-policies`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productId,
          marketplace,
          bestOfferEnabled: boEnabled,
          bestOfferAutoAcceptPrice: boAccept === '' ? null : parseFloat(boAccept),
          bestOfferMinAcceptPrice: boMin === '' ? null : parseFloat(boMin),
          fulfillmentPolicyId: fulfillmentId,
          paymentPolicyId: paymentId,
          returnPolicyId: returnId,
          merchantLocationKey: locationKey,
        }),
      })
      if (!opRes.ok) {
        const j = await opRes.json().catch(() => ({}))
        throw new Error(j?.error ?? `offer-policies HTTP ${opRes.status}`)
      }

      setSavedFlash(true)
      window.setTimeout(() => setSavedFlash(false), 1500)
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }, [saving, rule, priceBuffer, adj, boEnabled, boAccept, boMin, fulfillmentId, paymentId, returnId, locationKey, productId, marketplace, router])

  return (
    <Card noPadding>
      <div className="px-4 py-2.5 border-b border-slate-100 dark:border-slate-800 flex items-center gap-2">
        <DollarSign className="w-4 h-4 text-blue-500" />
        <div className="text-md font-medium text-slate-900 dark:text-slate-100">
          Pricing · Best Offer · Policies
        </div>
        <Badge variant="info">EC.8</Badge>
      </div>

      <div className="p-4 space-y-5">
        {/* ── Section 1: Pricing ───────────────────────────────────── */}
        <section className="space-y-3">
          <SectionHeader icon={<DollarSign className="w-3.5 h-3.5" />} title="Pricing" />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <FieldSourceRow
              fieldKey={`${marketplace}.price-override`}
              label={`Price override (${currency})`}
              initial={{
                source: initial.priceOverride != null ? 'manual' : 'default',
                value: initial.priceOverride != null ? String(initial.priceOverride) : '',
              }}
              availableSources={['manual', 'master', 'default']}
              resolveValue={(src) => {
                if (src === 'master')  return masterPrice != null ? String(masterPrice) : null
                if (src === 'default') return ''
                return null
              }}
              preview={(src) => {
                if (src === 'master') return masterPrice != null ? `${currency} ${masterPrice.toFixed(2)}` : null
                return null
              }}
            >
              {({ value, onChange }) => {
                // Bridge the FieldSourceRow buffer to the card's local
                // state so Save All can read it.
                if (value !== priceBuffer) {
                  // queueMicrotask avoids the "setState during render" warning
                  queueMicrotask(() => setPriceBuffer(value))
                }
                return (
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={value}
                    onChange={(e) => onChange(e.target.value)}
                    placeholder="0.00"
                    disabled={rule === 'PERCENT_OF_MASTER'}
                    className="w-full text-sm border border-slate-200 dark:border-slate-700 rounded px-2 py-1 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 disabled:opacity-50"
                  />
                )
              }}
            </FieldSourceRow>

            <div className="space-y-1.5">
              <label className="text-[11px] font-medium text-slate-700 dark:text-slate-300">Pricing rule</label>
              <select
                value={rule}
                onChange={(e) => setRule(e.target.value as PricingRule)}
                className="w-full text-sm border border-slate-200 dark:border-slate-700 rounded px-2 py-1 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
              >
                <option value="FIXED">Fixed price</option>
                <option value="MATCH_AMAZON">Match Amazon</option>
                <option value="PERCENT_OF_MASTER">% of master price</option>
              </select>
              {rule === 'PERCENT_OF_MASTER' && (
                <div className="pt-1">
                  <label className="text-[11px] font-medium text-slate-700 dark:text-slate-300">Adjustment %</label>
                  <input
                    type="number"
                    step="0.1"
                    value={adj}
                    onChange={(e) => setAdj(e.target.value)}
                    placeholder="0"
                    className="w-full text-sm border border-slate-200 dark:border-slate-700 rounded px-2 py-1 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 mt-1"
                  />
                  <p className="text-[10.5px] text-slate-400 mt-0.5">e.g. 10 = master + 10%. Negative = discount.</p>
                </div>
              )}
            </div>
          </div>
        </section>

        {/* ── Section 2: Best Offer ────────────────────────────────── */}
        <section className="space-y-3 border-t border-slate-100 dark:border-slate-800 pt-4">
          <SectionHeader icon={<Sparkles className="w-3.5 h-3.5" />} title="Best Offer" />
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
            <label className="inline-flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={boEnabled}
                onChange={(e) => setBoEnabled(e.target.checked)}
                className="w-3.5 h-3.5"
              />
              <span className="text-slate-700 dark:text-slate-300 font-medium">Enable Best Offer</span>
            </label>
            <div className={cn('space-y-1', !boEnabled && 'opacity-50')}>
              <label className="text-[11px] font-medium text-slate-700 dark:text-slate-300">
                Auto-accept at ({currency})
              </label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={boAccept}
                onChange={(e) => setBoAccept(e.target.value)}
                disabled={!boEnabled}
                placeholder="—"
                className="w-full text-sm border border-slate-200 dark:border-slate-700 rounded px-2 py-1 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 disabled:opacity-50"
              />
            </div>
            <div className={cn('space-y-1', !boEnabled && 'opacity-50')}>
              <label className="text-[11px] font-medium text-slate-700 dark:text-slate-300">
                Auto-decline below ({currency})
              </label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={boMin}
                onChange={(e) => setBoMin(e.target.value)}
                disabled={!boEnabled}
                placeholder="—"
                className="w-full text-sm border border-slate-200 dark:border-slate-700 rounded px-2 py-1 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 disabled:opacity-50"
              />
            </div>
          </div>
          <p className="text-[10.5px] text-slate-400">
            Buyers can submit offers below your listing price.
            Auto-accept locks in fast deals; auto-decline filters lowballs
            so you don&apos;t have to manually reject every one.
          </p>
        </section>

        {/* ── Section 3: Policies ──────────────────────────────────── */}
        <section className="space-y-3 border-t border-slate-100 dark:border-slate-800 pt-4">
          <SectionHeader icon={<ShieldCheck className="w-3.5 h-3.5" />} title="Policies" />
          {policyLoading && (
            <div className="text-xs text-slate-500 flex items-center gap-2">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading {marketplace} seller policies…
            </div>
          )}
          {policyError && (
            <div className="text-xs px-3 py-2 rounded bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 flex items-center justify-between gap-2">
              <span>{policyError}</span>
              <a
                href="https://www.ebay.com/seller-policy" target="_blank" rel="noreferrer"
                className="inline-flex items-center gap-0.5 text-rose-700 dark:text-rose-300 hover:underline"
              >
                Set in eBay Seller Hub <ExternalLink className="w-3 h-3" />
              </a>
            </div>
          )}
          {snapshot && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <PolicySelect
                label="Fulfillment"
                hint="Shipping carriers + handling time"
                value={fulfillmentId}
                options={snapshot.fulfillmentPolicies}
                onChange={setFulfillmentId}
              />
              <PolicySelect
                label="Payment"
                hint="eBay managed payments handles most of this"
                value={paymentId}
                options={snapshot.paymentPolicies}
                onChange={setPaymentId}
              />
              <PolicySelect
                label="Return"
                hint="Return window + responsibility"
                value={returnId}
                options={snapshot.returnPolicies}
                onChange={setReturnId}
              />
              {(snapshot.inventoryLocations ?? []).length > 0 && (
                <PolicySelect
                  label="Inventory location"
                  hint="Warehouse the listing ships from"
                  value={locationKey}
                  options={(snapshot.inventoryLocations ?? []).map((l) => ({ id: l.merchantLocationKey, name: l.name }))}
                  onChange={setLocationKey}
                />
              )}
            </div>
          )}
        </section>
      </div>

      <div className="px-4 py-2.5 border-t border-slate-100 dark:border-slate-800 flex items-center gap-2">
        <span className="text-xs text-slate-500 dark:text-slate-400">
          {isDirty ? 'Unsaved changes' : 'All saved'}
        </span>
        {savedFlash && (
          <span className="text-xs text-emerald-700 dark:text-emerald-300">Saved ✓</span>
        )}
        {error && (
          <span className="text-xs text-rose-700 dark:text-rose-300" title={error}>{error}</span>
        )}
        <button
          type="button"
          onClick={handleSaveAll}
          disabled={saving || !isDirty}
          className="ml-auto px-3 py-1 text-xs font-medium rounded bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50 inline-flex items-center gap-1.5"
        >
          {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
          {saving ? 'Saving…' : 'Save pricing & policies'}
        </button>
      </div>
    </Card>
  )
}

// ── Inner bits ─────────────────────────────────────────────────────────
function SectionHeader({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <div className="text-xs font-semibold text-slate-800 dark:text-slate-200 inline-flex items-center gap-1.5">
      <span className="text-blue-500">{icon}</span> {title}
    </div>
  )
}

function PolicySelect({
  label, hint, value, options, onChange,
}: {
  label: string
  hint: string
  value: string | null
  options: PolicySummary[]
  onChange: (next: string | null) => void
}) {
  return (
    <div className="space-y-1">
      <label className="text-[11px] font-medium text-slate-700 dark:text-slate-300 flex items-center gap-2">
        {label}
        <span className="text-[10px] text-slate-400 font-normal">{hint}</span>
      </label>
      <select
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || null)}
        className="w-full text-sm border border-slate-200 dark:border-slate-700 rounded px-2 py-1 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
      >
        <option value="">— pick a policy —</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>{o.name}</option>
        ))}
      </select>
    </div>
  )
}
