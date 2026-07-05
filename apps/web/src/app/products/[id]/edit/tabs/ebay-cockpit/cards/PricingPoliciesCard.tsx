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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/components.css'
import { useRouter } from 'next/navigation'
import { DollarSign, ShieldCheck, Sparkles, Save, Loader2, ExternalLink } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { useTranslations } from '@/lib/i18n/use-translations'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { cn } from '@/lib/utils'
import FieldSourceRow from '../field-source/FieldSourceRow'
import { Listbox } from '@/design-system/components/Listbox'

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
  const { t } = useTranslations()
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
  // Track the FieldSourceRow's current price value via ref — no state
  // needed since the value is only read on save, not rendered directly.
  const priceBufferRef = useRef<string>(
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
        pricingBody.priceOverride = priceBufferRef.current !== '' ? parseFloat(priceBufferRef.current) : null
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
  }, [saving, rule, adj, boEnabled, boAccept, boMin, fulfillmentId, paymentId, returnId, locationKey, productId, marketplace, router])

  return (
    <Card noPadding>
      <div className="px-4 py-2.5 border-b border-subtle dark:border-slate-800 flex items-center gap-2">
        <DollarSign className="w-4 h-4 text-blue-500" />
        <div className="text-md font-medium text-slate-900 dark:text-slate-100">
          {t('products.edit.cockpit.ebay.pricingPolicies.cardTitle')}
        </div>
        <Badge variant="info">EC.8</Badge>
      </div>

      <div className="p-4 space-y-5">
        {/* ── Section 1: Pricing ───────────────────────────────────── */}
        <section className="space-y-3">
          <SectionHeader icon={<DollarSign className="w-3.5 h-3.5" />} title={t('products.edit.cockpit.ebay.pricingPolicies.pricingSection')} />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <FieldSourceRow
              fieldKey={`${marketplace}.price-override`}
              label={`${t('products.edit.cockpit.ebay.pricingPolicies.priceOverride')} (${currency})`}
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
                // Sync the FieldSourceRow's current value into the ref so
                // handleSaveAll can read it without triggering a re-render.
                priceBufferRef.current = value
                return (
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={value}
                    onChange={(e) => onChange(e.target.value)}
                    placeholder="0.00"
                    disabled={rule === 'PERCENT_OF_MASTER'}
                    className="w-full text-sm border border-default dark:border-slate-700 rounded px-2 py-1 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 disabled:opacity-50"
                  />
                )
              }}
            </FieldSourceRow>

            <div className="space-y-1.5">
              <label className="text-[11px] font-medium text-slate-700 dark:text-slate-300">{t('products.edit.cockpit.ebay.pricingPolicies.pricingRule')}</label>
              <Listbox
                value={rule}
                onChange={(v) => setRule(v as PricingRule)}
                ariaLabel={t('products.edit.cockpit.ebay.pricingPolicies.pricingRule')}
                className="w-full"
                options={[
                  { value: 'FIXED', label: t('products.edit.cockpit.ebay.pricingPolicies.ruleFixed') },
                  { value: 'MATCH_AMAZON', label: t('products.edit.cockpit.ebay.pricingPolicies.ruleMatchAmazon') },
                  { value: 'PERCENT_OF_MASTER', label: t('products.edit.cockpit.ebay.pricingPolicies.rulePercentOfMaster') },
                ]}
              />
              {rule === 'PERCENT_OF_MASTER' && (
                <div className="pt-1">
                  <label className="text-[11px] font-medium text-slate-700 dark:text-slate-300">{t('products.edit.cockpit.ebay.pricingPolicies.adjustmentPercent')}</label>
                  <input
                    type="number"
                    step="0.1"
                    value={adj}
                    onChange={(e) => setAdj(e.target.value)}
                    placeholder="0"
                    className="w-full text-sm border border-default dark:border-slate-700 rounded px-2 py-1 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 mt-1"
                  />
                  <p className="text-[10.5px] text-tertiary mt-0.5">{t('products.edit.cockpit.ebay.pricingPolicies.adjustmentHint')}</p>
                </div>
              )}
            </div>
          </div>
        </section>

        {/* ── Section 2: Best Offer ────────────────────────────────── */}
        <section className="space-y-3 border-t border-subtle dark:border-slate-800 pt-4">
          <SectionHeader icon={<Sparkles className="w-3.5 h-3.5" />} title={t('products.edit.cockpit.ebay.pricingPolicies.bestOfferSection')} />
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
            <label className="inline-flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={boEnabled}
                onChange={(e) => setBoEnabled(e.target.checked)}
                className="w-3.5 h-3.5"
              />
              <span className="text-slate-700 dark:text-slate-300 font-medium">{t('products.edit.cockpit.ebay.pricingPolicies.enableBestOffer')}</span>
            </label>
            <div className={cn('space-y-1', !boEnabled && 'opacity-50')}>
              <label className="text-[11px] font-medium text-slate-700 dark:text-slate-300">
                {t('products.edit.cockpit.ebay.pricingPolicies.autoAcceptAt')} ({currency})
              </label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={boAccept}
                onChange={(e) => setBoAccept(e.target.value)}
                disabled={!boEnabled}
                placeholder="—"
                className="w-full text-sm border border-default dark:border-slate-700 rounded px-2 py-1 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 disabled:opacity-50"
              />
            </div>
            <div className={cn('space-y-1', !boEnabled && 'opacity-50')}>
              <label className="text-[11px] font-medium text-slate-700 dark:text-slate-300">
                {t('products.edit.cockpit.ebay.pricingPolicies.autoDeclineBelow')} ({currency})
              </label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={boMin}
                onChange={(e) => setBoMin(e.target.value)}
                disabled={!boEnabled}
                placeholder="—"
                className="w-full text-sm border border-default dark:border-slate-700 rounded px-2 py-1 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 disabled:opacity-50"
              />
            </div>
          </div>
          <p className="text-[10.5px] text-tertiary">
            {t('products.edit.cockpit.ebay.pricingPolicies.bestOfferHint')}
          </p>
        </section>

        {/* ── Section 3: Policies ──────────────────────────────────── */}
        <section className="space-y-3 border-t border-subtle dark:border-slate-800 pt-4">
          <SectionHeader icon={<ShieldCheck className="w-3.5 h-3.5" />} title={t('products.edit.cockpit.ebay.pricingPolicies.policiesSection')} />
          {policyLoading && (
            <div className="text-xs text-slate-500 flex items-center gap-2">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> {t('products.edit.cockpit.ebay.pricingPolicies.loadingPolicies')} {marketplace}…
            </div>
          )}
          {policyError && (
            <div className="text-xs px-3 py-2 rounded bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 flex items-center justify-between gap-2">
              <span>{policyError}</span>
              <a
                href="https://www.ebay.com/seller-policy" target="_blank" rel="noreferrer"
                className="inline-flex items-center gap-0.5 text-rose-700 dark:text-rose-300 hover:underline"
              >
                {t('products.edit.cockpit.ebay.pricingPolicies.setInSellerHub')} <ExternalLink className="w-3 h-3" />
              </a>
            </div>
          )}
          {snapshot && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <PolicySelect
                label={t('products.edit.cockpit.ebay.pricingPolicies.fulfillmentLabel')}
                hint={t('products.edit.cockpit.ebay.pricingPolicies.fulfillmentHint')}
                value={fulfillmentId}
                options={snapshot.fulfillmentPolicies}
                onChange={setFulfillmentId}
              />
              <PolicySelect
                label={t('products.edit.cockpit.ebay.pricingPolicies.paymentLabel')}
                hint={t('products.edit.cockpit.ebay.pricingPolicies.paymentHint')}
                value={paymentId}
                options={snapshot.paymentPolicies}
                onChange={setPaymentId}
              />
              <PolicySelect
                label={t('products.edit.cockpit.ebay.pricingPolicies.returnLabel')}
                hint={t('products.edit.cockpit.ebay.pricingPolicies.returnHint')}
                value={returnId}
                options={snapshot.returnPolicies}
                onChange={setReturnId}
              />
              {(snapshot.inventoryLocations ?? []).length > 0 && (
                <PolicySelect
                  label={t('products.edit.cockpit.ebay.pricingPolicies.inventoryLocationLabel')}
                  hint={t('products.edit.cockpit.ebay.pricingPolicies.inventoryLocationHint')}
                  value={locationKey}
                  options={(snapshot.inventoryLocations ?? []).map((l) => ({ id: l.merchantLocationKey, name: l.name }))}
                  onChange={setLocationKey}
                />
              )}
            </div>
          )}
        </section>
      </div>

      <div className="px-4 py-2.5 border-t border-subtle dark:border-slate-800 flex items-center gap-2">
        <span className="text-xs text-slate-500 dark:text-slate-400">
          {isDirty ? t('products.edit.cockpit.ebay.pricingPolicies.unsavedChanges') : t('products.edit.cockpit.ebay.pricingPolicies.allSaved')}
        </span>
        {savedFlash && (
          <span className="text-xs text-emerald-700 dark:text-emerald-300">{t('products.edit.cockpit.ebay.pricingPolicies.savedFlash')} ✓</span>
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
          {saving ? t('products.edit.cockpit.ebay.pricingPolicies.saving') : t('products.edit.cockpit.ebay.pricingPolicies.saveButton')}
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
  const { t } = useTranslations()
  return (
    <div className="space-y-1">
      <label className="text-[11px] font-medium text-slate-700 dark:text-slate-300 flex items-center gap-2">
        {label}
        <span className="text-[10px] text-tertiary font-normal">{hint}</span>
      </label>
      <Listbox
        value={value ?? ''}
        onChange={(v) => onChange(v || null)}
        ariaLabel={label}
        className="w-full"
        options={[
          { value: '', label: t('products.edit.cockpit.ebay.pricingPolicies.pickPolicy') },
          ...options.map((o) => ({ value: o.id, label: o.name })),
        ]}
      />
    </div>
  )
}
