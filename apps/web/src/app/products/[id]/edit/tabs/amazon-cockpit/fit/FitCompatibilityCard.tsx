'use client'

// CARD.3 — adaptive Fit & Compatibility card.
//
// Replaces the AC.1 "Compatibility" placeholder. The card is dynamic:
// it inspects the product type + attributes and renders whichever
// dimension actually applies, so it stays useful across catalogues:
//
//   • apparel / protective gear (OUTERWEAR, GLOVES, HELMET, …)  →
//     Size & Fit: sizes, department, fit type, material, CE protection.
//   • parts / accessories (…_PART, EXHAUST, BRAKE, …) OR anything
//     carrying vehicle-fitment attributes  →  Vehicle Compatibility:
//     compatible vehicles, make, model, year range.
//
// Read-only spec summary; each row shows its value or an "Add" chip,
// and edits happen in the classic field editor (jump button).

import { Ruler, Bike, Check, ExternalLink } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { useTranslations } from '@/lib/i18n/use-translations'

type Mode = 'sizeFit' | 'fitment'

interface Props {
  productType: string | null
  variationTheme: string | null
  variantCount: number
  /** listing.platformAttributes.attributes — Amazon flat-file values. */
  attributes: Record<string, unknown> | null | undefined
  onJumpToClassic?: () => void
}

function readAttr(attrs: Record<string, unknown> | null | undefined, ...keys: string[]): string | null {
  if (!attrs) return null
  for (const k of keys) {
    const v = attrs[k]
    if (Array.isArray(v)) {
      const first = (v[0] as { value?: unknown } | undefined)?.value
      if (first != null && String(first).trim() !== '') return String(first)
    } else if (typeof v === 'string' && v.trim() !== '') {
      return v
    }
  }
  return null
}

const FITMENT_HINTS = ['PART', 'EXHAUST', 'BRAKE', 'SPROCKET', 'CHAIN', 'FILTER', 'TIRE', 'TYRE', 'WINDSHIELD', 'MIRROR']

function detectMode(productType: string | null, attrs: Record<string, unknown> | null | undefined): Mode {
  if (readAttr(attrs, 'compatible_vehicle', 'fitment', 'make', 'model', 'vehicle_year', 'part_finder') != null) {
    return 'fitment'
  }
  const pt = (productType ?? '').toUpperCase()
  if (FITMENT_HINTS.some((h) => pt.includes(h))) return 'fitment'
  return 'sizeFit'
}

export default function FitCompatibilityCard({
  productType,
  variationTheme,
  variantCount,
  attributes,
  onJumpToClassic,
}: Props) {
  const { t } = useTranslations()
  const mode = detectMode(productType, attributes)

  const sizesFromVariations =
    (variationTheme ?? '').toLowerCase().includes('size') && variantCount > 0
      ? `${variantCount} ${t('products.edit.cockpit.amazon.fit.sizesUnit')}`
      : null

  const rows: Array<{ id: string; label: string; value: string | null }> =
    mode === 'fitment'
      ? [
          { id: 'vehicles', label: t('products.edit.cockpit.amazon.fit.vehicles'), value: readAttr(attributes, 'compatible_vehicle', 'fitment') },
          { id: 'make', label: t('products.edit.cockpit.amazon.fit.make'), value: readAttr(attributes, 'make', 'manufacturer') },
          { id: 'model', label: t('products.edit.cockpit.amazon.fit.model'), value: readAttr(attributes, 'model', 'part_number') },
          { id: 'year', label: t('products.edit.cockpit.amazon.fit.year'), value: readAttr(attributes, 'vehicle_year', 'year') },
        ]
      : [
          { id: 'sizes', label: t('products.edit.cockpit.amazon.fit.sizes'), value: sizesFromVariations ?? readAttr(attributes, 'size', 'apparel_size', 'size_name') },
          { id: 'department', label: t('products.edit.cockpit.amazon.fit.department'), value: readAttr(attributes, 'department_name', 'target_gender') },
          { id: 'fitType', label: t('products.edit.cockpit.amazon.fit.fitType'), value: readAttr(attributes, 'fit_type', 'apparel_fit_type') },
          { id: 'material', label: t('products.edit.cockpit.amazon.fit.material'), value: readAttr(attributes, 'outer_material_type', 'material', 'fabric_type') },
          { id: 'ce', label: t('products.edit.cockpit.amazon.fit.ceProtection'), value: readAttr(attributes, 'compliance_certification', 'ce_certification', 'safety_certification', 'protective_equipment_use') },
        ]

  const Icon = mode === 'fitment' ? Bike : Ruler
  const title =
    mode === 'fitment'
      ? t('products.edit.cockpit.amazon.cards.compatibility')
      : t('products.edit.cockpit.amazon.cards.sizeFit')

  return (
    <Card noPadding>
      <div
        data-jump-target="compatibility"
        className="px-4 py-2.5 border-b border-slate-100 dark:border-slate-800 flex items-center gap-2"
      >
        <Icon aria-hidden className="w-4 h-4 text-blue-500" />
        <div className="text-md font-medium text-slate-900 dark:text-slate-100">{title}</div>
      </div>

      <div className="p-4 space-y-1.5">
        {rows.map((row) => {
          const set = row.value != null
          return (
            <div key={row.id} className="flex items-center justify-between gap-3 text-xs">
              <span className="inline-flex items-center gap-1.5 min-w-0">
                {set ? (
                  <Check aria-hidden className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                ) : (
                  <span className="w-3.5 h-3.5 inline-flex items-center justify-center shrink-0">
                    <span className="w-1.5 h-1.5 rounded-full bg-slate-300 dark:bg-slate-600" />
                  </span>
                )}
                <span className="text-slate-700 dark:text-slate-300 truncate">{row.label}</span>
              </span>
              {set ? (
                <span className="text-slate-500 dark:text-slate-400 truncate max-w-[55%] text-right">
                  {row.value}
                </span>
              ) : (
                <span className="text-[10.5px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-400 dark:bg-slate-800 shrink-0">
                  {t('products.edit.cockpit.amazon.fit.add')}
                </span>
              )}
            </div>
          )
        })}

        {onJumpToClassic && (
          <button
            type="button"
            onClick={onJumpToClassic}
            className="inline-flex items-center gap-1 pt-1 text-[11px] font-medium text-blue-600 dark:text-blue-400 hover:underline"
          >
            {t('products.edit.cockpit.amazon.fit.edit')}
            <ExternalLink aria-hidden className="w-3 h-3" />
          </button>
        )}
      </div>
    </Card>
  )
}
