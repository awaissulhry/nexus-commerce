'use client'

// EC.9 — useHealthScore
//
// Pure-function scorer that turns the cockpit's known state into a
// 0–100 pre-publish score + a per-check breakdown the rail can
// render. Fetches the category schema on demand (same endpoint as
// AspectsCard — 24h API cache makes the round-trip free) so it can
// gate on REQUIRED aspects authoritatively.
//
// Hard fails (any of which forces publish-disabled, regardless of
// numeric score):
//   • No category picked
//   • No price set on the listing
//   • Any REQUIRED aspect is empty
//
// Soft warnings (drag the score down but don't block publish):
//   • Title too short / too long
//   • Description < 200 chars
//   • Fewer than 4 images
//   • Missing brand / GTIN / MPN
//   • Recommended aspect coverage < 80%
//   • Category-specific gate misses (per category-gates.ts)
//   • No fulfillment / payment / return policy picked
//
// Score weighting (sum = 100):
//   • Content        30  (title 10 / desc 10 / brand 5 / GTIN/MPN 5)
//   • Images         15  (≥1: 5 / ≥4: 5 / ≥8: 5)
//   • Cat & Aspects  30  (category 10 / required 15 / recommended % 5)
//   • Pricing/policy 15  (price 5 / 3 policies × 3 / location 1)
//   • Category gates 10  (per gate, capped at 10)

import { useEffect, useMemo, useState } from 'react'
import { getBackendUrl } from '@/lib/backend-url'
import { applicableGates, gateSatisfied } from './category-gates'

export type CheckStatus = 'pass' | 'warn' | 'fail'

export interface Check {
  id: string
  group: 'content' | 'images' | 'aspects' | 'pricing' | 'gates'
  label: string
  status: CheckStatus
  /** Short hint surfaced as a tooltip. */
  hint?: string
  /** Points awarded (≤ weight when partial). */
  earned: number
  /** Max points this check contributes. */
  weight: number
  /** True when failure should block publish (categories, required aspects, no price). */
  hard?: boolean
}

export interface HealthResult {
  score: number              // 0–100, rounded
  scorable: boolean          // false when we couldn't compute anything
  hardFails: Check[]
  checks: Check[]
  canPublish: boolean
  loading: boolean
}

interface SchemaAspect {
  id: string
  label: string
  required: boolean
  recommended: boolean
  guidance: 'REQUIRED' | 'RECOMMENDED' | 'OPTIONAL'
  variantEligible: boolean
}

interface Args {
  marketplace: string
  categoryId: string | null
  categoryName: string | null
  categoryPath: string | null
  title: string
  description: string
  brand: string | null
  gtin: string | null
  mpn: string | null
  priceValue: number | null
  imageCount: number
  itemSpecifics: Record<string, unknown>
  policies: {
    fulfillmentPolicyId: string | null
    paymentPolicyId: string | null
    returnPolicyId: string | null
    merchantLocationKey: string | null
  }
}

export function useHealthScore(args: Args): HealthResult {
  const [schema, setSchema] = useState<SchemaAspect[] | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!args.categoryId) {
      setSchema(null)
      return
    }
    let aborted = false
    setLoading(true)
    ;(async () => {
      try {
        const u = new URL(`${getBackendUrl()}/api/ebay/flat-file/category-schema`)
        u.searchParams.set('categoryId', args.categoryId!)
        u.searchParams.set('marketplace', `EBAY_${args.marketplace.toUpperCase()}`)
        const res = await fetch(u.toString())
        const json = await res.json()
        if (aborted) return
        if (res.ok && Array.isArray(json.aspects)) setSchema(json.aspects as SchemaAspect[])
        else setSchema([])
      } catch {
        if (!aborted) setSchema([])
      } finally {
        if (!aborted) setLoading(false)
      }
    })()
    return () => { aborted = true }
  }, [args.categoryId, args.marketplace])

  return useMemo(() => buildResult(args, schema, loading), [args, schema, loading])
}

function buildResult(args: Args, schema: SchemaAspect[] | null, loading: boolean): HealthResult {
  const checks: Check[] = []

  // ── Content (30) ────────────────────────────────────────────────
  const titleLen = args.title.length
  const titleStatus: CheckStatus = titleLen === 0 ? 'fail' : titleLen < 30 ? 'warn' : titleLen <= 80 ? 'pass' : 'warn'
  checks.push({
    id: 'title',
    group: 'content',
    label: `Title length (${titleLen}/80)`,
    status: titleStatus,
    hint: titleLen === 0 ? 'No title set' : titleLen < 30 ? 'Short titles rank lower on eBay search' : titleLen > 80 ? 'eBay will truncate' : 'In the sweet spot',
    earned: titleStatus === 'pass' ? 10 : titleStatus === 'warn' ? 5 : 0,
    weight: 10,
  })

  const descLen = args.description.length
  const descStatus: CheckStatus = descLen === 0 ? 'fail' : descLen < 200 ? 'warn' : 'pass'
  checks.push({
    id: 'description',
    group: 'content',
    label: `Description (${descLen} chars)`,
    status: descStatus,
    hint: descLen < 200 ? 'Sparse descriptions hurt conversion; aim for 200+' : 'Adequate',
    earned: descStatus === 'pass' ? 10 : descStatus === 'warn' ? 5 : 0,
    weight: 10,
  })

  const brandStatus: CheckStatus = args.brand && args.brand.trim().length > 0 ? 'pass' : 'warn'
  checks.push({
    id: 'brand',
    group: 'content',
    label: 'Brand set',
    status: brandStatus,
    hint: brandStatus === 'pass' ? args.brand! : 'eBay search filters by brand — leaving it empty drops visibility',
    earned: brandStatus === 'pass' ? 5 : 0,
    weight: 5,
  })

  const hasGtinOrMpn = (args.gtin && args.gtin.trim().length > 0) || (args.mpn && args.mpn.trim().length > 0)
  checks.push({
    id: 'gtin-mpn',
    group: 'content',
    label: 'GTIN or MPN',
    status: hasGtinOrMpn ? 'pass' : 'warn',
    hint: hasGtinOrMpn ? 'Product identifier present' : 'Many eBay categories require GTIN OR MPN for new items',
    earned: hasGtinOrMpn ? 5 : 0,
    weight: 5,
  })

  // ── Images (15) ─────────────────────────────────────────────────
  checks.push({
    id: 'image-min',
    group: 'images',
    label: 'At least 1 image',
    status: args.imageCount >= 1 ? 'pass' : 'fail',
    earned: args.imageCount >= 1 ? 5 : 0,
    weight: 5,
  })
  checks.push({
    id: 'image-4',
    group: 'images',
    label: '4+ images',
    status: args.imageCount >= 4 ? 'pass' : args.imageCount >= 1 ? 'warn' : 'fail',
    hint: args.imageCount < 4 ? 'Listings with 4+ images convert ~30% better on eBay' : 'Good',
    earned: args.imageCount >= 4 ? 5 : args.imageCount >= 2 ? 2 : 0,
    weight: 5,
  })
  checks.push({
    id: 'image-8',
    group: 'images',
    label: '8+ images (best practice)',
    status: args.imageCount >= 8 ? 'pass' : 'warn',
    earned: args.imageCount >= 8 ? 5 : args.imageCount >= 6 ? 3 : 0,
    weight: 5,
  })

  // ── Category & Aspects (30) ─────────────────────────────────────
  const hasCategory = !!args.categoryId
  checks.push({
    id: 'category',
    group: 'aspects',
    label: 'Category picked',
    status: hasCategory ? 'pass' : 'fail',
    hint: hasCategory ? args.categoryName ?? args.categoryId! : 'eBay rejects listings without a category',
    earned: hasCategory ? 10 : 0,
    weight: 10,
    hard: true,
  })

  // Required-aspects gate uses the schema. If the schema fetch is in
  // flight we mark it as "warn" pending so the rail doesn't flash
  // false-fail. Hard fail is reserved for when schema confirms an
  // empty required aspect.
  if (schema && schema.length > 0) {
    const requiredAspects = schema.filter((a) => a.required || a.guidance === 'REQUIRED')
    const recommendedAspects = schema.filter((a) => !a.required && (a.recommended || a.guidance === 'RECOMMENDED'))
    const missingRequired = requiredAspects.filter((a) => {
      const v = (args.itemSpecifics as Record<string, unknown>)[a.id]
      if (Array.isArray(v)) return v.length === 0 || String(v[0] ?? '').trim().length === 0
      if (typeof v === 'string') return v.trim().length === 0
      return v == null
    })
    const recommendedFilled = recommendedAspects.filter((a) => {
      const v = (args.itemSpecifics as Record<string, unknown>)[a.id]
      if (Array.isArray(v)) return v.length > 0 && String(v[0] ?? '').trim().length > 0
      if (typeof v === 'string') return v.trim().length > 0
      return false
    })
    const recommendedPct = recommendedAspects.length === 0
      ? 1
      : recommendedFilled.length / recommendedAspects.length

    checks.push({
      id: 'required-aspects',
      group: 'aspects',
      label: requiredAspects.length === 0
        ? 'No required aspects for this category'
        : `Required aspects (${requiredAspects.length - missingRequired.length}/${requiredAspects.length})`,
      status: missingRequired.length === 0 ? 'pass' : 'fail',
      hint: missingRequired.length === 0
        ? 'All required aspects filled'
        : `Missing: ${missingRequired.slice(0, 3).map((a) => a.label.split(' (')[0]).join(', ')}${missingRequired.length > 3 ? '…' : ''}`,
      earned: missingRequired.length === 0 ? 15 : 0,
      weight: 15,
      hard: requiredAspects.length > 0,
    })
    checks.push({
      id: 'recommended-aspects',
      group: 'aspects',
      label: recommendedAspects.length === 0
        ? 'No recommended aspects'
        : `Recommended (${recommendedFilled.length}/${recommendedAspects.length} · ${Math.round(recommendedPct * 100)}%)`,
      status: recommendedPct >= 0.8 ? 'pass' : recommendedPct >= 0.5 ? 'warn' : recommendedAspects.length === 0 ? 'pass' : 'warn',
      hint: 'Listings with all recommended aspects rank ~12% higher',
      earned: Math.round(5 * recommendedPct),
      weight: 5,
    })
  } else if (hasCategory) {
    checks.push({
      id: 'required-aspects',
      group: 'aspects',
      label: loading ? 'Required aspects (loading schema…)' : 'Required aspects',
      status: loading ? 'warn' : 'warn',
      hint: 'Schema fetch in progress — score may shift when complete',
      earned: 0,
      weight: 15,
    })
    checks.push({
      id: 'recommended-aspects',
      group: 'aspects',
      label: 'Recommended aspects',
      status: 'warn',
      hint: 'Pending schema fetch',
      earned: 0,
      weight: 5,
    })
  }

  // ── Pricing & Policies (15) ─────────────────────────────────────
  const hasPrice = args.priceValue != null && args.priceValue > 0
  checks.push({
    id: 'price',
    group: 'pricing',
    label: 'Price set',
    status: hasPrice ? 'pass' : 'fail',
    hint: hasPrice ? `${args.priceValue}` : 'eBay rejects FixedPrice listings without a price',
    earned: hasPrice ? 5 : 0,
    weight: 5,
    hard: true,
  })
  checks.push({
    id: 'fulfillment-policy',
    group: 'pricing',
    label: 'Fulfillment policy',
    status: args.policies.fulfillmentPolicyId ? 'pass' : 'warn',
    earned: args.policies.fulfillmentPolicyId ? 3 : 0,
    weight: 3,
  })
  checks.push({
    id: 'payment-policy',
    group: 'pricing',
    label: 'Payment policy',
    status: args.policies.paymentPolicyId ? 'pass' : 'warn',
    earned: args.policies.paymentPolicyId ? 3 : 0,
    weight: 3,
  })
  checks.push({
    id: 'return-policy',
    group: 'pricing',
    label: 'Return policy',
    status: args.policies.returnPolicyId ? 'pass' : 'warn',
    earned: args.policies.returnPolicyId ? 3 : 0,
    weight: 3,
  })
  checks.push({
    id: 'inventory-location',
    group: 'pricing',
    label: 'Inventory location',
    status: args.policies.merchantLocationKey ? 'pass' : 'warn',
    earned: args.policies.merchantLocationKey ? 1 : 0,
    weight: 1,
  })

  // ── Category-specific gates (10) ────────────────────────────────
  if (hasCategory) {
    const gates = applicableGates(args.categoryName, args.categoryPath)
    if (gates.length > 0) {
      const cap = 10
      let earnedSoFar = 0
      for (const gate of gates) {
        const ok = gateSatisfied(args.itemSpecifics, gate.needsAnyOf)
        const slotWeight = Math.min(gate.weight, cap - earnedSoFar)
        const earned = ok ? slotWeight : 0
        earnedSoFar += earned
        checks.push({
          id: `gate:${gate.label}`,
          group: 'gates',
          label: gate.label,
          status: ok ? 'pass' : 'warn',
          hint: ok
            ? 'Gate satisfied'
            : `Needs one of: ${gate.needsAnyOf.slice(0, 3).join(', ')}`,
          earned,
          weight: slotWeight,
        })
        if (earnedSoFar >= cap) break
      }
    }
  }

  const earned = checks.reduce((acc, c) => acc + c.earned, 0)
  const weight = checks.reduce((acc, c) => acc + c.weight, 0)
  const score = weight === 0 ? 0 : Math.round((earned / weight) * 100)
  const hardFails = checks.filter((c) => c.hard && c.status === 'fail')
  return {
    score,
    scorable: weight > 0,
    hardFails,
    checks,
    canPublish: hardFails.length === 0 && hasCategory && hasPrice,
    loading,
  }
}
