'use client'

// CARD.2 — Policies & Compliance card.
//
// Replaces the AC.1 "Soon" placeholder. A compliance checklist read
// from the listing's platformAttributes.attributes (Amazon flat-file
// shape: { key: [{ value }] }). For an EU seller (Xavia → Amazon IT/
// DE/FR/ES) the headline gap is GPSR — the General Product Safety
// Regulation responsible-person record, mandatory since Dec 2024 — so
// country-of-origin + GPSR are treated as required; battery / hazmat
// are optional (N/A for apparel but kept for catalogue breadth).
//
// Read-only: each item shows Set / Missing and the gaps are filled in
// the classic field editor (jump button), not inline.

import { ShieldCheck, Check, AlertTriangle, ExternalLink } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { cn } from '@/lib/utils'
import { useTranslations } from '@/lib/i18n/use-translations'

interface Props {
  /** listing.platformAttributes.attributes — Amazon flat-file values. */
  attributes: Record<string, unknown> | null | undefined
  onJumpToClassic?: () => void
}

/** First non-empty flat-file value across candidate keys. */
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

export default function ComplianceCard({ attributes, onJumpToClassic }: Props) {
  const { t } = useTranslations()

  const items = [
    {
      id: 'countryOfOrigin',
      label: t('products.edit.cockpit.amazon.compliance.countryOfOrigin'),
      required: true,
      value: readAttr(attributes, 'country_of_origin', 'country_of_origin_or_region'),
    },
    {
      id: 'gpsr',
      label: t('products.edit.cockpit.amazon.compliance.gpsr'),
      required: true,
      value: readAttr(
        attributes,
        'gpsr_safety_attestation',
        'eu_responsible_person',
        'responsible_person_address',
        'manufacturer_contact_information',
      ),
    },
    {
      id: 'manufacturer',
      label: t('products.edit.cockpit.amazon.compliance.manufacturer'),
      required: false,
      value: readAttr(attributes, 'manufacturer'),
    },
    {
      id: 'battery',
      label: t('products.edit.cockpit.amazon.compliance.battery'),
      required: false,
      value: readAttr(attributes, 'batteries_required', 'battery', 'lithium_battery_packaging'),
    },
    {
      id: 'hazmat',
      label: t('products.edit.cockpit.amazon.compliance.hazmat'),
      required: false,
      value: readAttr(attributes, 'dangerous_goods_regulations', 'hazmat', 'ghs_classification_class'),
    },
  ]

  const requiredItems = items.filter((i) => i.required)
  const requiredDone = requiredItems.filter((i) => i.value != null).length
  const allRequiredSet = requiredDone === requiredItems.length

  return (
    <Card noPadding>
      <div
        data-jump-target="compliance"
        className="px-4 py-2.5 border-b border-slate-100 dark:border-slate-800 flex items-center gap-2"
      >
        <ShieldCheck className="w-4 h-4 text-blue-500" />
        <div className="text-md font-medium text-slate-900 dark:text-slate-100">
          {t('products.edit.cockpit.amazon.cards.compliance')}
        </div>
        <span
          className={cn(
            'ml-auto text-[10px] px-1.5 py-0.5 rounded font-medium tabular-nums',
            allRequiredSet
              ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
              : 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300',
          )}
        >
          {requiredDone}/{requiredItems.length} {t('products.edit.cockpit.amazon.compliance.required')}
        </span>
      </div>

      <div className="p-4 space-y-1.5">
        {items.map((item) => {
          const set = item.value != null
          return (
            <div key={item.id} className="flex items-center justify-between gap-3 text-xs">
              <span className="inline-flex items-center gap-1.5 min-w-0">
                {set ? (
                  <Check className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                ) : item.required ? (
                  <AlertTriangle className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                ) : (
                  <span className="w-3.5 h-3.5 inline-flex items-center justify-center shrink-0">
                    <span className="w-1.5 h-1.5 rounded-full bg-slate-300 dark:bg-slate-600" />
                  </span>
                )}
                <span className="text-slate-700 dark:text-slate-300 truncate">{item.label}</span>
              </span>
              {set ? (
                <span className="text-slate-500 dark:text-slate-400 truncate max-w-[45%] text-right">
                  {item.value}
                </span>
              ) : (
                <span
                  className={cn(
                    'text-[10.5px] px-1.5 py-0.5 rounded shrink-0',
                    item.required
                      ? 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300'
                      : 'bg-slate-100 text-slate-400 dark:bg-slate-800',
                  )}
                >
                  {item.required
                    ? t('products.edit.cockpit.amazon.compliance.missing')
                    : t('products.edit.cockpit.amazon.compliance.optional')}
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
            {allRequiredSet
              ? t('products.edit.cockpit.amazon.compliance.review')
              : t('products.edit.cockpit.amazon.compliance.fixGaps')}
            <ExternalLink className="w-3 h-3" />
          </button>
        )}
      </div>
    </Card>
  )
}
