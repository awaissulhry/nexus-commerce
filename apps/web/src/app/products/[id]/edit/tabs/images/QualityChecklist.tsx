'use client'

// IM.3 — Per-channel completeness checklist shown alongside the master panel.

import { CheckCircle2, Circle, AlertTriangle } from 'lucide-react'
import type { ProductImage, ListingImage, WorkspaceProduct, VariantSummary } from './types'

interface Props {
  product: WorkspaceProduct
  masterImages: ProductImage[]
  listingImages: ListingImage[]
  variants: VariantSummary[]
}

interface CheckItem {
  label: string
  pass: boolean
  warn?: boolean  // true = amber (recommended), false = issue
}

function CheckRow({ item }: { item: CheckItem }) {
  return (
    <div className="flex items-start gap-2 py-1">
      {item.pass ? (
        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0 mt-0.5" />
      ) : item.warn ? (
        <AlertTriangle className="w-3.5 h-3.5 text-amber-500 flex-shrink-0 mt-0.5" />
      ) : (
        <Circle className="w-3.5 h-3.5 text-slate-300 dark:text-slate-600 flex-shrink-0 mt-0.5" />
      )}
      <span className={item.pass
        ? 'text-slate-500 dark:text-slate-400 line-through text-[11px]'
        : item.warn
          ? 'text-amber-700 dark:text-amber-300 text-[11px]'
          : 'text-slate-700 dark:text-slate-300 text-[11px]'
      }>
        {item.label}
      </span>
    </div>
  )
}

function score(items: CheckItem[]): number {
  const passed = items.filter((i) => i.pass).length
  return Math.round((passed / items.length) * 100)
}

function ScorePill({ pct }: { pct: number }) {
  const color = pct >= 80
    ? 'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-300'
    : pct >= 50
      ? 'bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-300'
      : 'bg-rose-50 dark:bg-rose-950/30 text-rose-700 dark:text-rose-300'
  return (
    <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${color}`}>{pct}%</span>
  )
}

export default function QualityChecklist({ masterImages, listingImages, variants }: Props) {
  const hasMain = masterImages.some((i) => i.type === 'MAIN')
  const mainImg = masterImages.find((i) => i.type === 'MAIN')

  // Amazon checks
  const amazonImages = listingImages.filter((i) => i.platform === 'AMAZON')
  const amazonHasMain = amazonImages.some((i) => i.amazonSlot === 'MAIN')
  const amazonMainWhiteBg = amazonImages.find((i) => i.amazonSlot === 'MAIN')?.hasWhiteBackground
  const amazonMainBig = amazonImages.find((i) => i.amazonSlot === 'MAIN')
  const amazonHasSwch = amazonImages.some((i) => i.amazonSlot === 'SWCH')
  const variantsWithAsin = variants.filter((v) => v.amazonAsin)

  const masterChecks: CheckItem[] = [
    { label: 'Has MAIN image', pass: hasMain },
    { label: '3+ images', pass: masterImages.length >= 3, warn: masterImages.length > 0 && masterImages.length < 3 },
    { label: 'Alt text on MAIN', pass: !!mainImg?.alt },
  ]

  const amazonChecks: CheckItem[] = [
    { label: 'MAIN slot assigned', pass: amazonHasMain || hasMain, warn: !amazonHasMain && hasMain },
    { label: 'MAIN has white background', pass: amazonMainWhiteBg === true, warn: amazonMainWhiteBg === false || amazonMainWhiteBg == null },
    { label: 'MAIN ≥ 1000 px', pass: (amazonMainBig?.width ?? 0) >= 1000, warn: true },
    { label: 'SWCH for colour variants', pass: amazonHasSwch || variants.length === 0, warn: !amazonHasSwch && variants.length > 0 },
    { label: 'All variants have ASINs', pass: variantsWithAsin.length === variants.length || variants.length === 0, warn: true },
  ]

  const ebayImages = listingImages.filter((i) => i.platform === 'EBAY')
  const ebayChecks: CheckItem[] = [
    { label: '3+ gallery images', pass: ebayImages.length >= 3 || masterImages.length >= 3, warn: true },
    { label: 'Images ≥ 500 px', pass: ebayImages.every((i) => (i.width ?? 0) >= 500), warn: true },
  ]

  const shopifyImages = listingImages.filter((i) => i.platform === 'SHOPIFY')
  const shopifyChecks: CheckItem[] = [
    { label: 'Featured image set', pass: shopifyImages.some((i) => i.position === 0) || masterImages.length > 0, warn: true },
    { label: 'Variant images assigned', pass: shopifyImages.length > 0 || variants.length === 0, warn: true },
  ]

  const sections = [
    { label: 'Master', checks: masterChecks },
    { label: 'Amazon', checks: amazonChecks },
    { label: 'eBay', checks: ebayChecks },
    { label: 'Shopify', checks: shopifyChecks },
  ]

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-100 dark:border-slate-800">
        <h3 className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">
          Readiness
        </h3>
      </div>
      <div className="px-4 py-3 space-y-4">
        {sections.map(({ label, checks }) => (
          <div key={label}>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-medium text-slate-700 dark:text-slate-300">{label}</span>
              <ScorePill pct={score(checks)} />
            </div>
            <div className="space-y-0">
              {checks.map((c) => <CheckRow key={c.label} item={c} />)}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
